import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  listSyncWebhooks,
  addSyncWebhook,
  deleteSyncWebhook,
  getSyncWebhook,
} from './db.js';
import { getTokenRecord } from './account-tokens.js';
import { CANONICAL_TARGET } from './profile.js';

const EVENT_TOKEN_UPDATED = 'account.token_updated';

function envInt(name, fallback, { min = 1, max = 10_000 } = {}) {
  const raw = Number.parseInt(String(process.env[name] ?? ''), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

/** Same payload shape as before — receiver does not need changes. */
const DELIVERY_TIMEOUT_MS = envInt('SYNC_WEBHOOK_TIMEOUT_MS', 15_000, { min: 3_000, max: 120_000 });
/** Cap parallel POSTs so a refresh burst cannot flood the other app. */
const DELIVERY_CONCURRENCY = envInt('SYNC_WEBHOOK_CONCURRENCY', 3, { min: 1, max: 16 });
/** While bulk login runs, cap webhook POSTs (still delivers — does not stop sync). */
const DELIVERY_CONCURRENCY_LOGIN = envInt('SYNC_WEBHOOK_CONCURRENCY_LOGIN', 2, { min: 0, max: 8 });
const MAX_RETRIES = envInt('SYNC_WEBHOOK_MAX_RETRIES', 2, { min: 0, max: 8 });
const MAX_QUEUE = envInt('SYNC_WEBHOOK_MAX_QUEUE', 25_000, { min: 100, max: 100_000 });
const RETRY_BASE_MS = envInt('SYNC_WEBHOOK_RETRY_BASE_MS', 1_000, { min: 200, max: 30_000 });

let envWebhookRegistered = false;
/** Optional: () => boolean — true when login/Camoufox queue is busy. */
let isLoginBusyFn = () => false;
let resumeTimer = null;

/** @type {Map<string, { hook: object, payload: object, attempts: number }>} */
const pendingByKey = new Map();
/** FIFO of pending keys (unique; coalesce updates in place). */
const pendingOrder = [];
let inFlight = 0;
let pumpScheduled = false;
let lastDepthLogAt = 0;
let droppedForCap = 0;
let lastPauseLogAt = 0;

/** Wire from server so webhooks slow/pause during bulk login (protects the other app). */
export function setWebhookLoginBusyCheck(fn) {
  isLoginBusyFn = typeof fn === 'function' ? fn : () => false;
}

export function ensureEnvWebhook() {
  if (envWebhookRegistered) return;
  envWebhookRegistered = true;

  const url = process.env.SYNC_WEBHOOK_URL?.trim();
  if (!url) return;

  const existing = listSyncWebhooks().some((w) => w.url === url);
  if (existing) return;

  addSyncWebhook({
    id: 'env-default',
    url,
    events: [EVENT_TOKEN_UPDATED],
    secret: process.env.SYNC_WEBHOOK_SECRET?.trim() || null,
    label: 'SYNC_WEBHOOK_URL',
  });
}

export function registerWebhook({ url, events = [EVENT_TOKEN_UPDATED], secret = null, label = null }) {
  if (!url?.trim()) throw new Error('url is required');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Webhook url must be http or https');
  }

  const normalizedEvents = normalizeEvents(events);
  const id = uuidv4();
  addSyncWebhook({
    id,
    url: url.trim(),
    events: normalizedEvents,
    secret: secret?.trim() || null,
    label: label?.trim() || null,
  });
  return getSyncWebhook(id);
}

export function removeWebhook(id) {
  return deleteSyncWebhook(id);
}

export function listWebhooks() {
  return listSyncWebhooks();
}

/** Snapshot for diagnostics / health (optional). */
export function getWebhookQueueStats() {
  const loginBusy = !!isLoginBusyFn();
  return {
    pending: pendingByKey.size,
    in_flight: inFlight,
    concurrency: DELIVERY_CONCURRENCY,
    concurrency_active: effectiveConcurrency(),
    login_busy: loginBusy,
    timeout_ms: DELIVERY_TIMEOUT_MS,
    max_retries: MAX_RETRIES,
    max_queue: MAX_QUEUE,
    dropped_for_cap: droppedForCap,
  };
}

function effectiveConcurrency() {
  if (!isLoginBusyFn()) return DELIVERY_CONCURRENCY;
  return DELIVERY_CONCURRENCY_LOGIN;
}

function scheduleResumePump() {
  if (resumeTimer) return;
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    schedulePump();
  }, 5_000);
}

function normalizeEvents(events) {
  const list = Array.isArray(events) ? events : [events];
  const out = [...new Set(list.map((e) => String(e || '').trim()).filter(Boolean))];
  if (!out.length) return [EVENT_TOKEN_UPDATED];
  return out;
}

/**
 * Fire account.token_updated to registered webhooks (non-blocking).
 * Deliveries are queued, coalesced per email+hook, and concurrency-limited.
 */
export async function notifyAccountTokenUpdated(email, target = CANONICAL_TARGET, { reason = 'token_refresh' } = {}) {
  ensureEnvWebhook();

  const account = await getTokenRecord(email, target);
  if (!account) return;

  const payload = {
    event: EVENT_TOKEN_UPDATED,
    at: new Date().toISOString(),
    reason,
    email: account.email,
    target: account.target,
    account,
  };

  enqueueWebhooks(EVENT_TOKEN_UPDATED, payload);
}

function enqueueWebhooks(event, payload) {
  const hooks = listSyncWebhooks().filter((w) => w.enabled && w.events.includes(event));
  if (!hooks.length) return;

  for (const hook of hooks) {
    enqueueOne(hook, payload);
  }
  schedulePump();
}

function queueKey(hookId, email, target) {
  return `${hookId}\0${String(email || '').toLowerCase()}\0${target || ''}`;
}

function enqueueOne(hook, payload) {
  const key = queueKey(hook.id, payload.email, payload.target);
  const existing = pendingByKey.get(key);
  if (existing) {
    // Latest token wins; keep place in FIFO so we don't starve others.
    existing.payload = payload;
    existing.hook = hook;
    return;
  }

  if (pendingByKey.size >= MAX_QUEUE) {
    // Drop oldest pending item to bound memory under extreme backlog.
    const oldest = pendingOrder.shift();
    if (oldest) {
      pendingByKey.delete(oldest);
      droppedForCap += 1;
      if (droppedForCap === 1 || droppedForCap % 100 === 0) {
        console.warn(
          `[sync-webhook] queue full (max ${MAX_QUEUE}) — dropped ${droppedForCap} oldest pending (delta sync can catch up)`,
        );
      }
    }
  }

  pendingByKey.set(key, { hook, payload, attempts: 0 });
  pendingOrder.push(key);
}

function schedulePump() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  setImmediate(() => {
    pumpScheduled = false;
    pump();
  });
}

function pump() {
  maybeLogDepth();

  const maxParallel = effectiveConcurrency();
  if (maxParallel <= 0) {
    const now = Date.now();
    if (now - lastPauseLogAt > 60_000 && pendingByKey.size) {
      lastPauseLogAt = now;
      console.log(
        `[sync-webhook] delivery capped to 0 during login — queue pending=${pendingByKey.size} (set SYNC_WEBHOOK_CONCURRENCY_LOGIN>0 to keep draining)`,
      );
    }
    scheduleResumePump();
    return;
  }

  if (isLoginBusyFn() && maxParallel < DELIVERY_CONCURRENCY) {
    const now = Date.now();
    if (now - lastPauseLogAt > 60_000) {
      lastPauseLogAt = now;
      console.log(
        `[sync-webhook] login busy — draining queue at ${maxParallel}/${DELIVERY_CONCURRENCY} concurrent (pending=${pendingByKey.size})`,
      );
    }
  }

  while (inFlight < maxParallel && pendingOrder.length) {
    const key = pendingOrder.shift();
    const job = pendingByKey.get(key);
    if (!job) continue;
    pendingByKey.delete(key);

    inFlight += 1;
    deliverOne(job.hook, JSON.stringify(job.payload))
      .then((ok) => {
        if (ok) return;
        requeueAfterFailure(key, job);
      })
      .catch(() => {
        requeueAfterFailure(key, job);
      })
      .finally(() => {
        inFlight -= 1;
        schedulePump();
      });
  }

  if (pendingOrder.length && isLoginBusyFn()) {
    scheduleResumePump();
  }
}

function requeueAfterFailure(key, job) {
  job.attempts += 1;
  if (job.attempts > MAX_RETRIES) return;

  const delay = RETRY_BASE_MS * 2 ** (job.attempts - 1);
  setTimeout(() => {
    const current = pendingByKey.get(key);
    if (current) {
      // A newer payload already queued — keep its attempts reset path via coalesce.
      return;
    }
    pendingByKey.set(key, job);
    pendingOrder.push(key);
    schedulePump();
  }, delay);
}

function maybeLogDepth() {
  const depth = pendingByKey.size;
  if (depth < 20 && inFlight === 0) return;
  const now = Date.now();
  if (now - lastDepthLogAt < 30_000) return;
  lastDepthLogAt = now;
  console.log(
    `[sync-webhook] queue pending=${depth} in_flight=${inFlight}/${DELIVERY_CONCURRENCY}`,
  );
}

/**
 * @returns {Promise<boolean>} true if delivered (2xx) or non-retryable HTTP; false if should retry
 */
async function deliverOne(hook, body) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'headless-login-sync/1.0',
    'X-Sync-Event': EVENT_TOKEN_UPDATED,
  };

  if (hook.secret) {
    headers['X-Sync-Signature'] = signBody(body, hook.secret);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (res.ok) return true;

    const retryable = res.status === 429 || res.status >= 500;
    console.warn(`[sync-webhook] ${hook.id} → ${res.status} ${hook.url}`);
    return !retryable;
  } catch (err) {
    console.warn(`[sync-webhook] ${hook.id} failed: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function signBody(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export { EVENT_TOKEN_UPDATED };
