import fs from 'node:fs/promises';
import { profilePath } from './profile.js';
import { isAddBackupEmailSetupScreen, clickSkipBackupEmail } from './security-prompts.js';

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

/** Handle backup-email prompt during login (skip or mark only). */
export async function resolveBackupPrompt(page, { leafEmail, skipBackupEmail = true, log, trace, onBackupPromptSeen, onBackupSkipped } = {}) {
  if (!(await isAddBackupEmailSetupScreen(page))) return 'none';

  if (trace) trace.promptSeen = true;
  onBackupPromptSeen?.();
  log?.('backup-mark', 'Microsoft backup-email prompt on screen');

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

  if (await isAddBackupEmailSetupScreen(page)) {
    log?.('backup', 'Backup prompt visible (add-email / no skip button)');
    await recordBackupRequired(leafEmail);
    return 'backup_email_required';
  }

  return 'none';
}
