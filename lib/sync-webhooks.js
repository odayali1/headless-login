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
const DELIVERY_TIMEOUT_MS = 15_000;

let envWebhookRegistered = false;

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

function normalizeEvents(events) {
  const list = Array.isArray(events) ? events : [events];
  const out = [...new Set(list.map((e) => String(e || '').trim()).filter(Boolean))];
  if (!out.length) return [EVENT_TOKEN_UPDATED];
  return out;
}

/**
 * Fire account.token_updated to registered webhooks (non-blocking).
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

  deliverWebhooks(EVENT_TOKEN_UPDATED, payload).catch(() => {});
}

async function deliverWebhooks(event, payload) {
  const hooks = listSyncWebhooks().filter((w) => w.enabled && w.events.includes(event));
  if (!hooks.length) return;

  const body = JSON.stringify(payload);
  await Promise.allSettled(hooks.map((hook) => deliverOne(hook, body)));
}

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
    if (!res.ok) {
      console.warn(`[sync-webhook] ${hook.id} → ${res.status} ${hook.url}`);
    }
  } catch (err) {
    console.warn(`[sync-webhook] ${hook.id} failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function signBody(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export { EVENT_TOKEN_UPDATED };
