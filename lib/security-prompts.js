/** Microsoft backup-email / security setup prompts (login + Outlook mail). */

/** Skip / defer buttons — English + Arabic (proxy geo often serves ar-SA UI). */
const SKIP_TEXT_RE =
  /skip for (7|\d+) days|skip for now|days until|remind me later|not now|skip this step|do this later|ask later|i.?ll do this later|^skip$|تخطي لمدة\s*\d+\s*أيام|تخطي لمدة|تخطي الآن|تخطى الآن|ليس الآن|ذكرني لاحقا|سأفعل ذلك لاحقا|تخطي هذه الخطوة|لاحقاً|لاحقا/i;

const BACKUP_BODY_RE =
  /alternate email|backup email|recovery email|add a way to verify|help us protect your account|security info|add security info|keep your account secure|verify your email|let.?s protect your account|add another way to sign in|confirm your identity|we need more information|add your email|protect your account|more about your account|add an email|add email address|email address to (protect|verify|recover)|keep your account safe|update your security|more information is required|your organization needs more information|بريد إلكتروني|بريد بديل|حماية حسابك|معلومات الأمان|أضف بريدا|أضف طريقة|حماية حساب|تحقق من بريد|معلومات إضافية|مطلوب مزيد من المعلومات/i;

const INTERRUPT_URL_RE =
  /proofup|account\.live\.com\/proofs|account\.live\.com\/interrupt|account\.live\.com\/identity|privacynotice|accountrisks|\/reminders?\//i;

const STAY_SIGNED_IN_RE =
  /stay signed in|keep me signed in|don'?t show this again|هل تريد البقاء قيد تسجيل الدخول|البقاء قيد تسجيل الدخول|البقاء في حالة تسجيل الدخول|هل تريد البقاء|بقاء تسجيل الدخول/i;

/** Sign-in screen: code sent to existing backup email, with "Use password instead". */
export async function canUsePasswordInstead(page) {
  const frames = [page, ...page.frames()];
  for (const frame of frames) {
    try {
      const hit = await frame.evaluate(() => {
        const nodes = [
          ...document.querySelectorAll(
            'a, button, [role="button"], [role="link"], span.fui-Link, #idA_PWD_SwitchToPassword'
          ),
        ];
        return nodes.some((el) => {
          const text = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
          return /use (your )?password|password instead|sign in with (?:a )?password|use my password|استخدام كلمة المرور|استخدم كلمة المرور/i.test(
            text
          );
        });
      });
      if (hit) return true;
    } catch {
      // cross-origin frame
    }
  }
  return false;
}

export function isInterruptUrl(url = '') {
  return INTERRUPT_URL_RE.test(String(url || ''));
}

/** Add-backup / protect-account setup — not the code-to-backup sign-in step. */
export async function isAddBackupEmailSetupScreen(page) {
  if (await canUsePasswordInstead(page)) return false;
  return isBackupEmailScreen(page);
}

export async function isBackupEmailScreen(page) {
  if (isInterruptUrl(page.url())) return true;

  const frames = [page, ...page.frames()];
  for (const frame of frames) {
    try {
      const hit = await frame.evaluate(
        ({ backupBodyRe, skipTextRe, interruptUrlRe }) => {
          const body = (document.body?.innerText || '').toLowerCase();
          const href = location.href.toLowerCase();
          const hasPassword = !!document.querySelector(
            '#passwordEntry, #i0118, input[name="passwd"], input[type="password"]:not([hidden])'
          );
          if (hasPassword) return false;

          const skipRe = new RegExp(skipTextRe, 'i');
          const bodyRe = new RegExp(backupBodyRe, 'i');
          const urlRe = new RegExp(interruptUrlRe, 'i');

          if (urlRe.test(href)) return true;

          const hasSkip = [...document.querySelectorAll('a, button, [role="button"], span, div[role="button"], #iShowSkip')].some(
            (el) => skipRe.test(el.textContent || el.value || '')
          );
          const hasAddEmailInput = !!document.querySelector(
            'input[type="email"], input[name*="email" i], input[placeholder*="@"], input[placeholder*="example.com" i]'
          );
          // Need Skip link and/or add-email field — body text alone false-positives other MS pages.
          if (hasSkip && (bodyRe.test(body) || /email|protect|verify|security|backup|بريد|حماية|أمان/i.test(body))) {
            return true;
          }
          if (hasAddEmailInput && bodyRe.test(body)) return true;

          return false;
        },
        {
          backupBodyRe: BACKUP_BODY_RE.source,
          skipTextRe: SKIP_TEXT_RE.source,
          interruptUrlRe: INTERRUPT_URL_RE.source,
        }
      );
      if (hit) return true;
    } catch {
      // cross-origin frame
    }
  }
  return false;
}

async function afterSkipClick(page) {
  await page.waitForTimeout(2500);
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
}

export async function clickSkipBackupEmail(page) {
  // Hard IDs Microsoft still uses on consumer proof-up.
  for (const sel of ['#iShowSkip', '#idBtn_Skip', 'a#iCancel', '#iCancel', '[data-testid="secondaryButton"]']) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
      const label = ((await loc.innerText().catch(() => '')) || sel).trim();
      await loc.click({ noWaitAfter: true, force: true }).catch(() => {});
      await afterSkipClick(page);
      return label || 'legacy skip';
    }
  }

  const patterns = [
    /skip for 7 days/i,
    /skip for \d+ days/i,
    /skip for now\s*\(/i,
    /skip for now/i,
    /days until (this is |it'?s )?required/i,
    /remind me later/i,
    /not now/i,
    /skip this step/i,
    /do this later/i,
    /ask later/i,
    /i.?ll do this later/i,
    /^skip$/i,
    /تخطي لمدة\s*\d+\s*أيام/i,
    /تخطي لمدة/i,
    /تخطي الآن/i,
    /تخطى الآن/i,
    /ليس الآن/i,
    /ذكرني لاحقا/i,
    /سأفعل ذلك لاحقا/i,
    /تخطي هذه الخطوة/i,
    /^تخطي$/i,
  ];

  for (const pattern of patterns) {
    for (const role of ['button', 'link']) {
      const loc = page.getByRole(role, { name: pattern }).first();
      if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
        const label = ((await loc.innerText().catch(() => '')) || pattern.source).trim();
        await loc.click({ noWaitAfter: true, force: true }).catch(() => {});
        await afterSkipClick(page);
        return label;
      }
    }
  }

  // proofs/Add link is often plain text (not a role=link) — match exact UI string.
  for (const pattern of [
    /Skip for now\s*\(\s*\d+\s*days until this is required\s*\)/i,
    /Skip for now/i,
    /تخطي لمدة/i,
  ]) {
    const loc = page.getByText(pattern).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      const label = ((await loc.innerText().catch(() => '')) || 'Skip for now').replace(/\s+/g, ' ').trim();
      const ok = await loc.click({ noWaitAfter: true, force: true, timeout: 3_000 }).then(() => true).catch(() => false);
      if (ok) {
        await afterSkipClick(page);
        return label;
      }
    }
  }

  // Fluent UI often uses span/div with role, not semantic button text alone.
  const textBtn = page
    .locator('button, a, [role="button"], [role="link"], span.fui-Link, div[role="button"], input[type="button"], input[type="submit"]')
    .filter({ hasText: SKIP_TEXT_RE })
    .first();
  if (await textBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    const label = ((await textBtn.innerText().catch(() => '')) || 'skip').trim();
    await textBtn.click({ noWaitAfter: true, force: true });
    await afterSkipClick(page);
    return label;
  }

  const frames = [page, ...page.frames()];
  for (const frame of frames) {
    try {
      const clicked = await frame.evaluate((skipSource) => {
        const patterns = [new RegExp(skipSource, 'i')];
        const nodes = [
          ...document.querySelectorAll(
            'a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"], span.fui-Link, div[role="button"], #iShowSkip, #idBtn_Skip'
          ),
        ];
        for (const pattern of patterns) {
          for (const el of nodes) {
            const text = (el.textContent || el.value || el.getAttribute?.('aria-label') || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (!text || text.length > 120) continue;
            if (pattern.test(text) || el.id === 'iShowSkip' || el.id === 'idBtn_Skip') {
              el.scrollIntoView?.({ block: 'center' });
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              el.click();
              return text || el.id || 'skip';
            }
          }
        }
        return null;
      }, SKIP_TEXT_RE.source);
      if (clicked) {
        await page.waitForTimeout(2500);
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
        return clicked;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/** Dismiss optional Microsoft setup / backup-email prompts. Returns clicked | backup_email_required | none */
export async function dismissSecurityPrompts(page, log, { skipBackupEmail = true, onBackupPromptSeen, onBackupSkipped } = {}) {
  // Always try known skip controls when URL is an interrupt — body text may be localized.
  if (isInterruptUrl(page.url()) && skipBackupEmail) {
    onBackupPromptSeen?.();
    const skipped = await clickSkipBackupEmail(page);
    if (skipped) {
      log?.('prompt', `Skipped interrupt prompt: "${skipped}"`);
      if (onBackupSkipped) await onBackupSkipped(skipped);
      return 'clicked';
    }
  }

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
    // Still try a blind skip pass (Arabic / Fluent markup).
    const blind = await clickSkipBackupEmail(page);
    if (blind) {
      log?.('prompt', `Skipped backup email prompt (retry): "${blind}"`);
      if (onBackupSkipped) await onBackupSkipped(blind);
      return 'clicked';
    }
    return 'none';
  }

  const frames = [page, ...page.frames()];
  for (const frame of frames) {
    try {
      const generic = await frame.evaluate((skipSource) => {
        const pattern = new RegExp(skipSource, 'i');
        const nodes = [
          ...document.querySelectorAll('a, button, [role="button"], [role="link"], #iShowSkip, span.fui-Link'),
        ];
        for (const el of nodes) {
          const text = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
          if ((text && text.length < 100 && pattern.test(text)) || el.id === 'iShowSkip') {
            el.click();
            return text || el.id || 'skip';
          }
        }
        return null;
      }, SKIP_TEXT_RE.source);
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
export async function dismissOutlookBlockingPrompts(
  page,
  log,
  { skipBackupEmail = true, maxRounds = 6, onBackupPromptSeen, onBackupSkipped } = {}
) {
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

export { STAY_SIGNED_IN_RE };
