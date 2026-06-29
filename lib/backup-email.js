import fs from 'node:fs/promises';
import { profilePath } from './profile.js';
import { isBackupEmailScreen, clickSkipBackupEmail } from './security-prompts.js';
import { pickHubForLeaf, saveBackupHub } from './backup-hubs.js';
import { waitForMicrosoftSecurityCode } from './imap-oauth.js';

/** @typedef {'unknown'|'not_prompted'|'skipped'|'verified'|'required'} BackupEmailStatus */

export const BACKUP_STATUS_LABELS = {
  unknown: 'Not checked yet',
  not_prompted: 'No backup prompt',
  skipped: 'Backup prompt — skipped',
  verified: 'Backup email verified',
  required: 'Backup prompt — add email',
};

export function createBackupTrace() {
  return { promptSeen: false };
}

export function backupPromptCallbacks(email, trace, log) {
  return {
    onBackupPromptSeen() {
      if (!trace || trace.promptSeen) return;
      trace.promptSeen = true;
      log?.('backup-mark', 'Microsoft backup-email prompt detected');
    },
    async onBackupSkipped(label) {
      await recordBackupSkipped(email, label);
      log?.('backup-mark', `Backup prompt skipped: "${label}"`);
    },
  };
}

/**
 * After login finishes: mark from what actually happened (not UI checkbox).
 * Skipped/required/verified are set when the prompt was handled; otherwise not_prompted.
 */
export async function finalizeBackupMarking(email, trace, { reusedSession = false } = {}) {
  const cur = await readProfileBackupFields(email);
  if (['skipped', 'required', 'verified'].includes(cur.backupEmailStatus)) {
    return cur.backupEmailStatus;
  }
  if (reusedSession && !trace?.promptSeen) {
    return cur.backupEmailStatus;
  }
  const now = new Date().toISOString();
  if (trace?.promptSeen) {
    await patchProfileBackupFields(email, {
      backupEmailStatus: 'required',
      backupEmailCheckedAt: now,
      backupPromptSeenAt: cur.backupPromptSeenAt || now,
    });
    return 'required';
  }
  await patchProfileBackupFields(email, {
    backupEmailStatus: 'not_prompted',
    backupEmailCheckedAt: now,
  });
  return 'not_prompted';
}

export async function readProfileBackupFields(email) {
  try {
    const raw = await fs.readFile(profilePath(email), 'utf8');
    const data = JSON.parse(raw);
    return {
      backupEmailStatus: data.backupEmailStatus || 'unknown',
      backupEmail: data.backupEmail || null,
      backupHubEmail: data.backupHubEmail || null,
      backupEmailSkippedAt: data.backupEmailSkippedAt || null,
      backupEmailVerifiedAt: data.backupEmailVerifiedAt || null,
      backupEmailCheckedAt: data.backupEmailCheckedAt || null,
      backupPromptSeenAt: data.backupPromptSeenAt || null,
      backupSkipLabel: data.backupSkipLabel || null,
    };
  } catch {
    return {
      backupEmailStatus: 'unknown',
      backupEmail: null,
      backupHubEmail: null,
      backupEmailSkippedAt: null,
      backupEmailVerifiedAt: null,
      backupEmailCheckedAt: null,
      backupPromptSeenAt: null,
      backupSkipLabel: null,
    };
  }
}

export async function patchProfileBackupFields(email, patch) {
  const file = profilePath(email);
  let data = {};
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    data = { email, cookies: [], origins: [] };
  }
  Object.assign(data, patch);
  await fs.writeFile(file, JSON.stringify(data, null, 2));
  return data;
}

export async function recordBackupSkipped(email, skipLabel = '') {
  const now = new Date().toISOString();
  return patchProfileBackupFields(email, {
    backupEmailStatus: 'skipped',
    backupEmailSkippedAt: now,
    backupEmailCheckedAt: now,
    backupPromptSeenAt: now,
    backupSkipLabel: skipLabel || null,
  });
}

export async function recordBackupRequired(email) {
  const now = new Date().toISOString();
  return patchProfileBackupFields(email, {
    backupEmailStatus: 'required',
    backupEmailCheckedAt: now,
    backupPromptSeenAt: now,
  });
}

export async function recordBackupVerified(email, hubEmail) {
  const now = new Date().toISOString();
  return patchProfileBackupFields(email, {
    backupEmailStatus: 'verified',
    backupEmail: hubEmail,
    backupHubEmail: hubEmail,
    backupEmailVerifiedAt: now,
  });
}

/**
 * On backup-email / proofup screen: enter hub email, wait for IMAP code, submit.
 * @returns {'completed'|'not_screen'|'failed'}
 */
export async function completeBackupEmailOnPage(page, { hub, log }) {
  await ensureBackupEmailForm(page, log);

  if (!(await isBackupEmailEntryScreen(page)) && !(await isBackupEmailScreen(page))) {
    return 'not_screen';
  }

  log?.('backup', `Setting backup email → ${hub.email}`);
  const filled = await fillBackupEmailAddress(page, hub.email);
  if (!filled) {
    log?.('backup', 'Could not find backup email input');
    return 'failed';
  }

  await clickBackupNextOrSend(page);
  await page.waitForTimeout(2500);

  const codeReady = await waitForCodeInput(page, 45_000);
  if (!codeReady) {
    log?.('backup', 'Code input did not appear after sending backup email');
    return 'failed';
  }

  const since = new Date();
  const { code, refreshToken } = await waitForMicrosoftSecurityCode({
    hubEmail: hub.email,
    refreshToken: hub.refreshToken,
    clientId: hub.oauthClientId,
    since,
    log,
  });

  if (refreshToken && refreshToken !== hub.refreshToken) {
    hub.refreshToken = refreshToken;
  }

  log?.('backup', `Entering verification code (${code.length} digits)`);
  const entered = await fillVerificationCode(page, code);
  if (!entered) return 'failed';

  await clickBackupVerify(page);
  await page.waitForTimeout(3000);

  if (await isBackupEmailEntryScreen(page)) {
    log?.('backup', 'Still on backup screen after code submit');
    return 'failed';
  }

  return 'completed';
}

export async function isBackupEmailEntryScreen(page) {
  const frames = [page, ...page.frames()];
  for (const frame of frames) {
    try {
      const hit = await frame.evaluate(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        const hasPassword = !!document.querySelector(
          '#passwordEntry, #i0118, input[name="passwd"], input[type="password"]:not([hidden])'
        );
        if (hasPassword) return false;
        const hasEmailInput = !!document.querySelector(
          'input[type="email"], input[name="EmailAddress"], input[name="email"], input[id*="email" i]'
        );
        const backupText =
          /alternate email|backup email|recovery email|add a way to verify|help us protect|security info|add another way|verify your email|protect your account|add an email|add email address|email address to/i.test(
            body
          );
        return backupText && hasEmailInput;
      });
      if (hit) return true;
    } catch {
      // cross-origin
    }
  }
  return false;
}

async function fillBackupEmailAddress(page, email) {
  const selectors = [
    'input[type="email"]',
    'input[name="EmailAddress"]',
    'input[name="email"]',
    'input[id*="Email" i]',
    'input[aria-label*="email" i]',
  ];
  for (const frame of [page, ...page.frames()]) {
    for (const sel of selectors) {
      const loc = frame.locator(sel).first();
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        await loc.click({ timeout: 3000 }).catch(() => {});
        await loc.fill(email, { timeout: 5000 });
        return true;
      }
    }
  }
  return false;
}

async function fillVerificationCode(page, code) {
  const selectors = [
    'input[type="tel"]',
    'input[name="otc"]',
    'input[id*="otc" i]',
    'input[id*="code" i]',
    'input[aria-label*="code" i]',
    'input[inputmode="numeric"]',
  ];
  for (const frame of [page, ...page.frames()]) {
    for (const sel of selectors) {
      const loc = frame.locator(sel).first();
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        await loc.fill(code, { timeout: 5000 });
        return true;
      }
    }
  }
  return false;
}

async function waitForCodeInput(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = [page, ...page.frames()];
    for (const frame of frames) {
      const visible = await frame
        .locator('input[type="tel"], input[name="otc"], input[inputmode="numeric"]')
        .first()
        .isVisible({ timeout: 300 })
        .catch(() => false);
      if (visible) return true;
    }
    await page.waitForTimeout(800);
  }
  return false;
}

async function clickBackupNextOrSend(page) {
  const patterns = [/^next$/i, /send code/i, /send/i, /continue/i, /verify/i];
  for (const pattern of patterns) {
    for (const role of ['button', 'link']) {
      const loc = page.getByRole(role, { name: pattern }).first();
      if (await loc.isVisible({ timeout: 350 }).catch(() => false)) {
        await loc.click({ noWaitAfter: true });
        return true;
      }
    }
  }
  await page.keyboard.press('Enter').catch(() => {});
  return true;
}

/**
 * Handle backup-email prompt: hub IMAP verify, skip 7 days, or block.
 * @returns {'completed'|'skipped'|'backup_email_required'|'none'}
 */
export async function resolveBackupPrompt(page, { leafEmail, skipBackupEmail = true, backupEmailMode = 'skip', log, trace, onBackupPromptSeen, onBackupSkipped } = {}) {
  if (!(await isBackupEmailScreen(page))) return 'none';

  trace && (trace.promptSeen = true);
  onBackupPromptSeen?.();
  log?.('backup-mark', 'Microsoft backup-email prompt on screen');

  if (backupEmailMode === 'hub') {
    const hub = pickHubForLeaf(leafEmail);
    if (!hub) {
      log?.('backup', 'No backup hub with IMAP token — register one in /api/backup-hubs');
      await recordBackupRequired(leafEmail);
      return 'backup_email_required';
    }
    const result = await completeBackupEmailOnPage(page, { hub, log });
    if (result === 'completed') {
      await recordBackupVerified(leafEmail, hub.email);
      saveBackupHub(hub.email, hub.refreshToken, hub.oauthClientId);
      log?.('backup', `Backup email verified using hub ${hub.email}`);
      return 'completed';
    }
    await recordBackupRequired(leafEmail);
    return 'backup_email_required';
  }

  if (!skipBackupEmail) {
    await recordBackupRequired(leafEmail);
    return 'backup_email_required';
  }

  const skipped = await clickSkipBackupEmail(page);
  if (skipped) {
    if (onBackupSkipped) await onBackupSkipped(skipped);
    else await recordBackupSkipped(leafEmail, skipped);
    log?.('prompt', `Skipped backup email prompt: "${skipped}"`);
    return 'skipped';
  }

  if (await isBackupEmailScreen(page)) {
    log?.('backup', 'Backup prompt visible (add-email / no skip button)');
    await recordBackupRequired(leafEmail);
    return 'backup_email_required';
  }

  return 'none';
}

async function ensureBackupEmailForm(page, log) {
  if (await isBackupEmailEntryScreen(page)) return true;

  const patterns = [
    /add (an? )?(alternate|backup|another) email/i,
    /add email/i,
    /use (an? )?email/i,
    /email address/i,
  ];
  for (const pattern of patterns) {
    for (const role of ['link', 'button']) {
      const loc = page.getByRole(role, { name: pattern }).first();
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        log?.('backup', `Opening backup email form: "${pattern.source}"`);
        await loc.click({ noWaitAfter: true });
        await page.waitForTimeout(2000);
        if (await isBackupEmailEntryScreen(page)) return true;
      }
    }
  }
  return false;
}

async function clickBackupVerify(page) {
  const patterns = [/^next$/i, /verify/i, /submit/i, /continue/i, /^done$/i];
  for (const pattern of patterns) {
    for (const role of ['button', 'link']) {
      const loc = page.getByRole(role, { name: pattern }).first();
      if (await loc.isVisible({ timeout: 350 }).catch(() => false)) {
        await loc.click({ noWaitAfter: true });
        return true;
      }
    }
  }
  await page.keyboard.press('Enter').catch(() => {});
  return true;
}
