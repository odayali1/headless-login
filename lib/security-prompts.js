/** Microsoft backup-email / security setup prompts (login + Outlook mail). */

/** Skip / defer buttons — English + Arabic (proxy geo often serves ar-SA UI). */
const SKIP_TEXT_RE =
  /skip for now\s*\(\s*\d+\s*days until this is required\s*\)|skip for (7|\d+) days|skip for now|days until (this is |it'?s )?required|remind me later|not now|skip this step|do this later|ask later|i.?ll do this later|\bskip\b|omitir|ignorer|überspringen|pular|تخطي لمدة\s*\d+\s*أيام|تخطي لمدة|تخطي الآن|تخطى الآن|ليس الآن|ذكرني لاحقا|سأفعل ذلك لاحقا|تخطي هذه الخطوة|لاحقاً|لاحقا/i;

const BACKUP_BODY_RE =
  /alternate email|backup email|recovery email|add a way to verify|help us protect your account|security info|add security info|keep your account secure|verify your email|let.?s protect your account|add another way to sign in|confirm your identity|we need more information|add your email|protect your account|more about your account|add an email|add email address|email address to (protect|verify|recover)|keep your account safe|update your security|more information is required|your organization needs more information|بريد إلكتروني|بريد بديل|حماية حسابك|معلومات الأمان|أضف بريدا|أضف طريقة|حماية حساب|تحقق من بريد|معلومات إضافية|مطلوب مزيد من المعلومات/i;

const INTERRUPT_URL_RE =
  /proofup|account\.live\.com\/proofs|account\.live\.com\/interrupt|account\.live\.com\/identity|privacynotice|accountrisks|\/reminders?\//i;

const STAY_SIGNED_IN_RE =
  /stay signed in|keep me signed in|هل تريد البقاء قيد تسجيل الدخول|البقاء قيد تسجيل الدخول|البقاء في حالة تسجيل الدخول/i;

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
          if (hasSkip && (bodyRe.test(body) || /email|protect|verify|security|backup|بريد|حماية|أمان/i.test(body))) {
            return true;
          }

          return bodyRe.test(body);
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

async function tryClickLocator(page, loc, labelHint = '') {
  const count = await loc.count().catch(() => 0);
  if (!count) return null;
  const el = loc.first();
  const label = ((await el.innerText().catch(() => '')) || labelHint || 'skip').replace(/\s+/g, ' ').trim();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  // force: proofs/Add skip is often a low-contrast link Playwright marks not-stable
  const clicked =
    (await el.click({ noWaitAfter: true, force: true, timeout: 3_000 }).then(() => true).catch(() => false)) ||
    (await el.evaluate((node) => {
      node.scrollIntoView?.({ block: 'center' });
      if (typeof node.click === 'function') node.click();
      else node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }).catch(() => false));
  if (!clicked) return null;
  await afterSkipClick(page);
  return label || 'skip';
}

/** List visible controls — helps debug when skip text is new / localized. */
export async function listVisiblePromptControls(page) {
  const frames = [page, ...page.frames()];
  const out = [];
  for (const frame of frames) {
    try {
      const rows = await frame.evaluate(() => {
        const nodes = [
          ...document.querySelectorAll(
            'a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"], #iShowSkip, [data-testid], span, div'
          ),
        ];
        return nodes
          .map((el) => {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
            const text = (el.textContent || el.value || el.getAttribute('aria-label') || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 100);
            if (!text || text.length > 90) return null;
            if (!/skip|next|cancel|remind|later|تخطي|ليس|أيام|day/i.test(text) && !el.id) return null;
            return `${el.tagName.toLowerCase()}#${el.id || ''}[${el.getAttribute('data-testid') || ''}] "${text}"`;
          })
          .filter(Boolean)
          .slice(0, 30);
      });
      out.push(...rows);
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * Click Microsoft "Skip for now (7 days…)" on account.live.com/proofs/Add.
 * Uses getByText + force click — role/visibility checks alone often miss this link.
 */
export async function clickSkipBackupEmail(page, { waitMs = 8_000 } = {}) {
  const deadline = Date.now() + Math.max(1_000, Number(waitMs) || 8_000);

  const textPatterns = [
    /Skip for now\s*\(\s*\d+\s*days until this is required\s*\)/i,
    /Skip for now/i,
    /Skip for \d+ days/i,
    /\d+\s*days until this is required/i,
    /Remind me later/i,
    /Not now/i,
    /Skip this step/i,
    /Do this later/i,
    /I'll do this later/i,
    /تخطي لمدة/i,
    /تخطي الآن/i,
    /تخطى الآن/i,
    /ليس الآن/i,
  ];

  while (Date.now() < deadline) {
    // Exact consumer proof-up IDs
    for (const sel of ['#iShowSkip', '#idBtn_Skip', 'a#iShowSkip', 'input#iShowSkip']) {
      const hit = await tryClickLocator(page, page.locator(sel), sel);
      if (hit) return hit;
    }

    // Plain text match — matches the laptop UI: "Skip for now (7 days until this is required)"
    for (const pattern of textPatterns) {
      const hit = await tryClickLocator(page, page.getByText(pattern), pattern.source);
      if (hit) return hit;
    }

    for (const pattern of textPatterns) {
      for (const role of ['link', 'button']) {
        const hit = await tryClickLocator(page, page.getByRole(role, { name: pattern }), pattern.source);
        if (hit) return hit;
      }
    }

    for (const sel of [
      '[data-testid="secondaryButton"]',
      'button[data-testid="secondaryButton"]',
      'a[href*="skip" i]',
      'a[id*="Skip" i]',
      'button[id*="Skip" i]',
      '#iCancel',
      'a#iCancel',
    ]) {
      const hit = await tryClickLocator(page, page.locator(sel), sel);
      if (hit) return hit;
    }

    const filtered = page
      .locator('a, button, [role="button"], [role="link"], span.fui-Link, div[role="button"]')
      .filter({ hasText: /skip for now|days until this is required|#iShowSkip|تخطي|ليس الآن/i });
    const hitFiltered = await tryClickLocator(page, filtered, 'filtered skip');
    if (hitFiltered) return hitFiltered;

    // Deep DOM walk including nested spans / Fluent markup / all frames
    const frames = [page, ...page.frames()];
    for (const frame of frames) {
      try {
        const clicked = await frame.evaluate((skipSource) => {
          const pattern = new RegExp(skipSource, 'i');
          const loose = /skip for now|days until this is required|remind me later|not now|\bskip\b|تخطي|ليس الآن/i;
          const nodes = [
            ...document.querySelectorAll(
              'a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"], span, div, #iShowSkip, #idBtn_Skip, [data-testid="secondaryButton"]'
            ),
          ];
          for (const el of nodes) {
            const text = (el.textContent || el.value || el.getAttribute?.('aria-label') || '')
              .replace(/\s+/g, ' ')
              .trim();
            const id = (el.id || '').toLowerCase();
            const href = String(el.getAttribute?.('href') || el.getAttribute?.('data-href') || '').toLowerCase();
            const testid = String(el.getAttribute?.('data-testid') || '').toLowerCase();
            const match =
              id === 'ishowskip' ||
              id.includes('skip') ||
              href.includes('skip') ||
              testid === 'secondarybutton' ||
              (text && text.length <= 160 && (pattern.test(text) || loose.test(text)));
            if (!match) continue;
            // Prefer the smallest clickable that still contains the skip phrase (avoid clicking the whole card)
            if (text.length > 160) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            el.scrollIntoView?.({ block: 'center' });
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            if (typeof el.click === 'function') el.click();
            return text || id || testid || 'skip';
          }
          return null;
        }, SKIP_TEXT_RE.source);
        if (clicked) {
          await afterSkipClick(page);
          return clicked;
        }
      } catch {
        // ignore
      }
    }

    await page.waitForTimeout(500);
  }

  return null;
}

/** Dismiss optional Microsoft setup / backup-email prompts. Returns clicked | backup_email_required | none */
export async function dismissSecurityPrompts(page, log, { skipBackupEmail = true, onBackupPromptSeen, onBackupSkipped } = {}) {
  // Always try known skip controls when URL is an interrupt — body text may be localized.
  if (isInterruptUrl(page.url()) && skipBackupEmail) {
    onBackupPromptSeen?.();
    const skipped = await clickSkipBackupEmail(page, { waitMs: 10_000 });
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
    const skipped = await clickSkipBackupEmail(page, { waitMs: 10_000 });
    if (skipped) {
      log?.('prompt', `Skipped backup email prompt: "${skipped}"`);
      if (onBackupSkipped) await onBackupSkipped(skipped);
      return 'clicked';
    }
    log?.('prompt', 'Backup email screen detected — could not find skip button.');
    const blind = await clickSkipBackupEmail(page, { waitMs: 5_000 });
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
          if ((text && text.length < 160 && pattern.test(text)) || el.id === 'iShowSkip') {
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
