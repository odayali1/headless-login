/** Microsoft backup-email / security setup prompts (login + Outlook mail). */

/** Sign-in screen: code sent to existing backup email, with "Use password instead". */
export async function canUsePasswordInstead(page) {
  const frames = [page, ...page.frames()];
  for (const frame of frames) {
    try {
      const hit = await frame.evaluate(() => {
        const nodes = [
          ...document.querySelectorAll('a, button, [role="button"], [role="link"], span.fui-Link, #idA_PWD_SwitchToPassword'),
        ];
        return nodes.some((el) => {
          const text = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
          return /use (your )?password|password instead|sign in with (?:a )?password|use my password/i.test(text);
        });
      });
      if (hit) return true;
    } catch {
      // cross-origin frame
    }
  }
  return false;
}

/** Add-backup / protect-account setup — not the code-to-backup sign-in step. */
export async function isAddBackupEmailSetupScreen(page) {
  if (await canUsePasswordInstead(page)) return false;
  return isBackupEmailScreen(page);
}

export async function isBackupEmailScreen(page) {
  const frames = [page, ...page.frames()];
  for (const frame of frames) {
    try {
      const hit = await frame.evaluate(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        const href = location.href.toLowerCase();
        const hasPassword = !!document.querySelector(
          '#passwordEntry, #i0118, input[name="passwd"], input[type="password"]:not([hidden])'
        );
        if (hasPassword) return false;

        const hasSkip7 = [...document.querySelectorAll('a, button, [role="button"], span')].some((el) =>
          /skip for 7 days/i.test(el.textContent || '')
        );
        if (hasSkip7 && /email|protect|verify|security|backup|alternate/i.test(body)) return true;

        return (
          /alternate email|backup email|recovery email|add a way to verify|help us protect your account|security info|add security info|keep your account secure|verify your email|let.?s protect your account|add another way to sign in|confirm your identity|we need more information|add your email|protect your account|more about your account|add an email|add email address|email address to (protect|verify|recover)|keep your account safe|update your security/i.test(
            body
          ) ||
          /proofup|account\.live\.com\/proofs|account\.live\.com\/interrupt/i.test(href)
        );
      });
      if (hit) return true;
    } catch {
      // cross-origin frame
    }
  }
  return false;
}

export async function clickSkipBackupEmail(page) {
  const patterns = [
    /skip for 7 days/i,
    /skip for now/i,
    /remind me later/i,
    /not now/i,
    /skip this step/i,
    /do this later/i,
    /ask later/i,
    /i.?ll do this later/i,
    /^skip$/i,
  ];

  for (const pattern of patterns) {
    for (const role of ['button', 'link']) {
      const loc = page.getByRole(role, { name: pattern }).first();
      if (await loc.isVisible({ timeout: 350 }).catch(() => false)) {
        const label = ((await loc.innerText().catch(() => '')) || pattern.source).trim();
        await loc.click({ noWaitAfter: true });
        return label;
      }
    }
  }

  const legacy = page.locator('#iShowSkip, #idBtn_Back, a#iCancel').first();
  if (await legacy.isVisible({ timeout: 350 }).catch(() => false)) {
    await legacy.click({ noWaitAfter: true });
    return 'legacy skip';
  }

  const frames = [page, ...page.frames()];
  for (const frame of frames) {
    try {
      const clicked = await frame.evaluate(() => {
        const patterns = [
          /skip for 7 days/i,
          /skip for now/i,
          /remind me later/i,
          /not now/i,
          /skip this step/i,
          /do this later/i,
          /ask later/i,
          /i.?ll do this later/i,
          /^skip$/i,
        ];
        const nodes = [
          ...document.querySelectorAll('a, button, [role="button"], [role="link"], input[type="submit"], span.fui-Link'),
        ];
        for (const pattern of patterns) {
          for (const el of nodes) {
            const text = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length > 80) continue;
            if (pattern.test(text)) {
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              el.click();
              return text;
            }
          }
        }
        return null;
      });
      if (clicked) return clicked;
    } catch {
      // ignore
    }
  }

  return null;
}

/** Dismiss optional Microsoft setup / backup-email prompts. Returns clicked | backup_email_required | none */
export async function dismissSecurityPrompts(page, log, { skipBackupEmail = true, onBackupPromptSeen, onBackupSkipped } = {}) {
  if (await isAddBackupEmailSetupScreen(page)) {
    onBackupPromptSeen?.();
    if (!skipBackupEmail) {
      log?.('prompt', 'Backup email verification required — auto-skip disabled.');
      return 'backup_email_required';
    }
    const skipped = await clickSkipBackupEmail(page);
    if (skipped) {
      log?.('prompt', `Skipped backup email prompt: "${skipped}"`);
      if (onBackupSkipped) await onBackupSkipped(skipped);
      return 'clicked';
    }
    log?.('prompt', 'Backup email screen detected — could not find skip button.');
    return 'none';
  }

  const frames = [page, ...page.frames()];
  for (const frame of frames) {
    try {
      const generic = await frame.evaluate(() => {
        const patterns = [/skip for 7 days/i, /skip for now/i, /not now/i, /remind me later/i];
        const nodes = [...document.querySelectorAll('a, button, [role="button"], [role="link"]')];
        for (const pattern of patterns) {
          for (const el of nodes) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (text && text.length < 80 && pattern.test(text)) {
              el.click();
              return text;
            }
          }
        }
        return null;
      });
      if (generic) {
        log?.('prompt', `Skipping optional setup: "${generic}"`);
        return 'clicked';
      }
    } catch {
      // ignore
    }
  }

  return 'none';
}

/** Keep dismissing until no more prompts (Outlook mail overlays after login). */
export async function dismissOutlookBlockingPrompts(page, log, { skipBackupEmail = true, maxRounds = 6, onBackupPromptSeen, onBackupSkipped } = {}) {
  let last = 'none';
  for (let i = 0; i < maxRounds; i++) {
    const r = await dismissSecurityPrompts(page, log, { skipBackupEmail, onBackupPromptSeen, onBackupSkipped });
    last = r;
    if (r === 'backup_email_required') return r;
    if (r !== 'clicked') break;
    await page.waitForTimeout(2500);
  }
  return last;
}
