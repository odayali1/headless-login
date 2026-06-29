import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBrowser, resolveEngine } from './browser.js';
import { loadProfile, saveProfile, hasValidSession, CANONICAL_TARGET } from './profile.js';
import { getAccountFingerprint } from './anti-detect.js';
import { captureOutlookTokens, isTokenValid, isLiveProfileCardToken } from './token-extract.js';
import {
  isBackupEmailScreen,
  dismissSecurityPrompts,
  dismissOutlookBlockingPrompts,
} from './security-prompts.js';
import { resolveBackupPrompt, recordBackupRequired, createBackupTrace, backupPromptCallbacks, finalizeBackupMarking } from './backup-email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots');
const SESSIONS_DIR = path.join(ROOT, 'sessions');

const TARGETS = {
  outlook: {
    name: 'Outlook',
    url: 'https://outlook.live.com/mail/',
    loginUrl: 'https://login.live.com/',
    successPatterns: [/outlook\.live\.com/i, /outlook\.office\.com/i, /outlook\.office365\.com/i],
  },
  teams: {
    name: 'Microsoft Teams',
    url: 'https://teams.microsoft.com/',
    loginUrl: 'https://login.live.com/',
    successPatterns: [/teams\.microsoft\.com/i, /teams\.live\.com/i],
  },
};

export async function loginMicrosoft({
  email,
  password,
  target = 'outlook',
  engine = 'camoufox',
  headless = true,
  onProgress,
  jobId,
  forceFresh = false,
  skipBackupEmail = true,
  backupEmailMode = 'skip',
  onEmailRetry,
}) {
  const config = TARGETS[target];
  if (!config) throw new Error(`Unknown target: ${target}`);

  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
  await fs.mkdir(SESSIONS_DIR, { recursive: true });

  const log = (step, message, extra = {}) => {
    onProgress?.({ step, message, ...extra, timestamp: new Date().toISOString() });
  };

  const saved = await loadProfile(email);
  const needsFreshLogin = forceFresh || !saved?.state || !hasValidSession(saved.state);
  const useEngine = resolveEngine(engine);

  if (needsFreshLogin && password) {
    log('engine', 'Camoufox — stable Firefox profile + per-account stealth fingerprint (this email keeps the same device every session).');
    return runLoginAttempt({
      email, password, target, config, engine: useEngine, saved, jobId, log, forceFresh, skipBackupEmail, backupEmailMode, onEmailRetry,
    });
  }

  return runLoginAttempt({
    email, password, target, config, engine: useEngine, saved, jobId, log, forceFresh, skipBackupEmail, backupEmailMode, onEmailRetry,
  });
}

async function runLoginAttempt({
  email, password, target, config, engine, saved, jobId, log, forceFresh = false, skipBackupEmail = true, backupEmailMode = 'skip', onEmailRetry,
}) {
  let session;
  let context;
  let page;
  const usedEngine = engine;
  const backupTrace = createBackupTrace();
  const backupCb = backupPromptCallbacks(email, backupTrace, log);
  const backupOpts = () => ({ ...backupCb, trace: backupTrace });

  try {
    const fingerprint = saved?.state?.fingerprint || getAccountFingerprint(email);
    const browserState = { session: null, context: null, page: null };

    const reopenBrowser = async (reason) => {
      if (browserState.session) await browserState.session.close().catch(() => {});
      browserState.session = await connectBrowser({ email, target: CANONICAL_TARGET, fingerprint, saved, forceFresh: true });
      browserState.context = browserState.session.context;
      browserState.page = browserState.session.page || (await browserState.context.newPage());
      session = browserState.session;
      context = browserState.context;
      page = browserState.page;
      log('connect', reason || 'Reconnected Camoufox (fresh proxy relay)…');
      await page.goto(config.loginUrl || config.url, { waitUntil: 'load', timeout: 60_000 });
      await waitForLoginForm(page, log);
    };

    await reopenBrowser(`Connected via Camoufox (persistent profile)`);
    log('fingerprint', `Stable device profile for ${email} (seed ${fingerprint.seed.slice(0, 8)}…)`);

    const interact = chromiumInteract;

    if (!forceFresh && saved?.state && hasValidSession(saved.state)) {
      log('profile', `Reusing saved session for ${email} (cookies + Firefox profile)`);
      const needsToken = !isTokenValid(saved.state.tokens);
      if (!needsToken) {
        await page.goto(config.url, { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(4000);
        if (await isLoggedIn(page, context, config)) {
          log('success', `Reused saved profile — already signed in to ${config.name}`);
          return await buildResult({
            page,
            context,
            email,
            target,
            jobId,
            status: 'success',
            engine: usedEngine,
            reusedProfile: true,
            fingerprint,
            existingTokens: saved.state.tokens,
            log,
            skipBackupEmail,
            backupEmailMode,
            backupTrace,
            ...backupCb,
          });
        }
      } else {
        log('token', 'Session valid but token missing/expired — refreshing token…');
        await page.goto(config.url, { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(4000);
        if (await isLoggedIn(page, context, config)) {
          return await buildResult({
            page,
            context,
            email,
            target,
            jobId,
            status: 'success',
            engine: usedEngine,
            reusedProfile: true,
            fingerprint,
            existingTokens: saved.state.tokens,
            log,
            skipBackupEmail,
            backupEmailMode,
            backupTrace,
            ...backupCb,
          });
        }
      }
      log('profile', 'Saved profile expired — performing fresh login…');
    }

    log('navigate', `Opening ${config.name} sign-in…`);
    await page.goto(config.loginUrl || config.url, { waitUntil: 'load', timeout: 60_000 });
    await waitForLoginForm(page, log);

    const currentUrl = page.url();
    if (!/login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com/i.test(currentUrl)) {
      if (await isLoggedIn(page, context, config)) {
        log('success', `Already signed in to ${config.name}`);
        return await buildResult({
          page, context, email, target, jobId, status: 'success', engine: usedEngine, fingerprint, log, skipBackupEmail, backupEmailMode, backupTrace, ...backupCb,
        });
      }
    }

    await submitEmailWithRetry(() => browserState.page, email, interact, log, {
      onEmailRetry: async (attempt) => {
        await onEmailRetry?.(attempt);
        if (attempt >= 2) await reopenBrowser('Reconnected after proxy rotation…');
      },
    });
    page = browserState.page;
    context = browserState.context;

    try {
      await prepareForPasswordEntry(page, log, { email, skipBackupEmail, backupEmailMode, jobId, engine: usedEngine, backupTrace, ...backupCb });
    } catch (err) {
      if (err.code === 'BACKUP_EMAIL_REQUIRED') {
        await recordBackupRequired(email);
        const shot = await captureScreenshot(page, jobId, 'backup-email', usedEngine);
        return {
          status: 'backup_email_required',
          message:
            'Microsoft is asking for backup email verification. Enable "Skip backup email for 7 days" on batch upload, or complete it manually.',
          email,
          target,
          engine: usedEngine,
          url: page.url(),
          screenshot: shot ? `screenshots/${jobId}-backup-email.png` : null,
        };
      }
      throw err;
    }

    log('password', 'Entering password…');
    const pwdInput = page.locator(PASSWORD_FIELD).first();
    await pwdInput.waitFor({ state: 'visible', timeout: 15_000 });
    await pwdInput.fill(password);
    await interact.clickSignIn(page);
    await page.waitForTimeout(3000);

    const postLogin = await handlePostLogin(page, log, interact, context, { email, skipBackupEmail, backupEmailMode, backupTrace, ...backupCb });
    if (postLogin === 'backup_email_required') {
      await recordBackupRequired(email);
      const shot = await captureScreenshot(page, jobId, 'backup-email', usedEngine);
      return {
        status: 'backup_email_required',
        message:
          'Microsoft is asking for backup email verification. Enable "Skip backup email for 7 days" on batch upload, or complete it manually.',
        email,
        target,
        engine: usedEngine,
        url: page.url(),
        screenshot: shot ? `screenshots/${jobId}-backup-email.png` : null,
      };
    }
    if (postLogin === 'mfa_required') {
      const shot = await captureScreenshot(page, jobId, 'mfa', usedEngine);
      return {
        status: 'mfa_required',
        message: 'Multi-factor authentication required. Complete MFA manually or use an app password.',
        email,
        target,
        engine: usedEngine,
        url: page.url(),
        screenshot: shot ? `screenshots/${jobId}-mfa.png` : null,
      };
    }

    if (postLogin === 'wrong_password') {
      const shot = await captureScreenshot(page, jobId, 'error', usedEngine);
      return {
        status: 'failed',
        message: 'Incorrect password or account error.',
        email,
        target,
        engine: usedEngine,
        url: page.url(),
        screenshot: shot ? `screenshots/${jobId}-error.png` : null,
      };
    }

    if (postLogin === 'done' || postLogin === 'pending') {
      const cookies = await context.cookies();
      if (hasMicrosoftSessionCookies(cookies)) {
        log('success', `Microsoft session established (${cookies.length} cookies)`);
        log('token', 'Opening Outlook mail to capture LiveProfileCard token…');
        await page.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await dismissSecurityPrompts(page, log, { skipBackupEmail, ...backupCb });
        return await buildResult({
          page, context, email, target, jobId, status: 'success', engine: usedEngine, fingerprint, log, skipBackupEmail, backupEmailMode, backupTrace, ...backupCb,
        });
      }
    }

    if (postLogin === 'pending') {
      log('verify', 'Sign-in submitted — opening app…');
    }

    log('verify', `Opening ${config.name}…`);
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    const success = await isLoggedIn(page, context, config);

    if (!success && /login\.microsoftonline\.com|login\.live\.com/i.test(finalUrl)) {
      const shot = await captureScreenshot(page, jobId, 'error', usedEngine);
      const bodyText = await page.locator('body').innerText().catch(() => '');
      return {
        status: 'failed',
        message: detectErrorMessage(bodyText) || 'Login did not complete — still on Microsoft sign-in page.',
        email,
        target,
        engine: usedEngine,
        url: finalUrl,
        screenshot: shot ? `screenshots/${jobId}-error.png` : null,
      };
    }

    log('success', `Signed in to ${config.name}`);
    await dismissSecurityPrompts(page, log, { skipBackupEmail, ...backupCb });
    return await buildResult({
      page, context, email, target, jobId, status: 'success', engine: usedEngine, fingerprint, log, skipBackupEmail, backupEmailMode, backupTrace, ...backupCb,
    });
  } catch (err) {
    if (page) await captureScreenshot(page, jobId, 'error', usedEngine).catch(() => {});
    throw err;
  } finally {
    if (session) await session.close().catch(() => {});
  }
}

function resolveTokensForSave(captured, existingTokens, reusedProfile) {
  if (isLiveProfileCardToken(captured)) return captured;
  if (isTokenValid(captured)) return captured;
  if (reusedProfile && isTokenValid(existingTokens)) return existingTokens;
  return null;
}

async function buildResult({
  page,
  context,
  email,
  target,
  jobId,
  status,
  engine,
  reusedProfile = false,
  fingerprint,
  existingTokens,
  log,
  skipBackupEmail = true,
  backupEmailMode = 'skip',
  backupTrace,
  onBackupPromptSeen,
  onBackupSkipped,
}) {
  const promptArgs = { onBackupPromptSeen, onBackupSkipped, trace: backupTrace };
  const skipPrompts = skipBackupEmail;

  let tokens = existingTokens;
  if (!isTokenValid(tokens)) {
    await dismissSecurityPrompts(page, log, { skipBackupEmail: skipPrompts, ...promptArgs });
    log?.('token', 'Requesting LiveProfileCard.Access token…');
    if (target === 'teams' && !/outlook\.live\.com/i.test(page.url())) {
      log?.('token', 'Teams session ready — opening Outlook mail for LiveProfileCard token…');
      await page.goto('https://outlook.live.com/mail/', { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await dismissOutlookBlockingPrompts(page, log, { skipBackupEmail: skipPrompts, maxRounds: 3, ...promptArgs });
    }
    tokens = await captureOutlookTokens(page, {
      log,
      context,
      engine,
      existingTokens: reusedProfile ? existingTokens : null,
      dismissPrompts: async (p) =>
        dismissOutlookBlockingPrompts(p, log, { skipBackupEmail: skipPrompts, maxRounds: 3, ...promptArgs }),
    });
    if (!isLiveProfileCardToken(tokens)) {
      log?.('token', 'Token not captured — session saved; use Refresh token or retry Re-login.');
    } else {
      log?.('token', 'LiveProfileCard token captured');
    }
  }

  const profileFile = await saveProfile(context, email, {
    engine,
    staySignedIn: true,
    jobId,
    lastStatus: status,
    fingerprint,
    loginVia: target,
    tokens: resolveTokensForSave(tokens, existingTokens, reusedProfile),
  });

  if (status === 'success') {
    const marked = await finalizeBackupMarking(email, backupTrace, { reusedSession: reusedProfile });
    log?.('backup-mark', `Backup prompt tracking: ${marked}`);
  }

  const cookies = await context.cookies();

  return {
    status,
    message: reusedProfile
      ? `Reused saved profile for ${email}`
      : isLiveProfileCardToken(tokens)
        ? `Login successful for ${email} — profile + token saved (Stay signed in: Yes)`
        : `Login successful for ${email} — session saved (token not captured; retry Re-login)`,
    email,
    target,
    engine,
    reusedProfile,
    url: page.url(),
    title: String((await page.title().catch(() => '')) || ''),
    profileFile: path.relative(ROOT, profileFile),
    cookieCount: cookies.length,
    originCount: (await context.storageState()).origins?.length ?? 0,
    accessToken: tokens?.access_token || null,
    tokenExpiresAt: tokens?.expires_at || null,
    hasToken: isLiveProfileCardToken(tokens),
    tokenScope: tokens?.scope || null,
  };
}

async function waitForLoginForm(page, log) {
  const timeout = 35_000;
  log('wait', 'Waiting for sign-in form…');
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
      try {
        const ready = await page.evaluate(() => {
          const sels = ['#usernameEntry', '#i0116', 'input[name="loginfmt"]', 'input[type="email"]'];
          return sels.some((s) => {
            const el = document.querySelector(s);
            return el && el.offsetParent !== null;
          });
        });
        if (ready) return;
      } catch {
        // navigation in progress
      }
      await page.waitForTimeout(500);
  }

  throw new Error('Microsoft sign-in form did not render in time.');
}

async function isLoggedIn(page, context, config) {
  const url = page.url();
  const cookies = await context.cookies();
  const hasAuthCookies = hasMicrosoftSessionCookies(cookies);

  if (config.successPatterns.some((p) => p.test(url)) && hasAuthCookies) return true;
  if (hasAuthCookies) return true;

  const title = (await page.title()).toLowerCase();
  if (title.includes('sign in') || title.includes('account')) return false;
  return config.successPatterns.some((p) => p.test(url)) && cookies.length > 3;
}

const chromiumInteract = {
  async fillEmail(page, email) {
    await fillEmailReliable(page, email);
  },
  async fillPassword(page, password) {
    await preferPasswordSignIn(page);
    const input = page.locator('#passwordEntry, #i0118, input[name="passwd"], input[type="password"]').first();
    await input.waitFor({ state: 'visible', timeout: 25_000 });
    await input.fill(password);
  },
  async clickNext(page) {
    await page.locator('button[data-testid="primaryButton"], input[type="submit"], #idSIButton9').first().click({ noWaitAfter: true });
    await page.waitForTimeout(2500);
  },
  async clickSignIn(page) {
    await page.locator('button[data-testid="primaryButton"], input[type="submit"][value="Sign in"], #idSIButton9').first().click({ noWaitAfter: true });
    await page.waitForTimeout(2500);
  },
  async clickStaySignedIn(page, accept = true) {
    const label = accept ? 'Yes' : 'No';
    const btn = page.locator(`input[type="submit"][value="${label}"], button:has-text("${label}")`).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click({ noWaitAfter: true });
      await page.waitForTimeout(2500);
      return true;
    }
    return false;
  },
  async clickSkip(page) {
    const link = page.getByRole('link', { name: /skip for now/i });
    if (await link.isVisible({ timeout: 1000 }).catch(() => false)) {
      await link.click();
      return true;
    }
    return false;
  },
};

const obscuraInteract = {
  fillEmail: (page, email) => typeIntoInput(page, ['#usernameEntry', '#i0116', 'input[name="loginfmt"]', 'input[type="email"]'], email),
  fillPassword: (page, password) => typeIntoInput(page, ['#passwordEntry', '#i0118', 'input[name="passwd"]', 'input[type="password"]'], password),
  clickNext: async (page) => {
    await clickByEvaluate(page, ['Next']);
    await waitForPasswordOrRedirect(page);
  },
  clickSignIn: (page) => clickByEvaluate(page, ['Sign in']),
  clickStaySignedIn: async (page, accept = true) => {
    const clicked = await page.evaluate((yes) => {
      const buttons = [...document.querySelectorAll('button, input[type="submit"]')];
      const want = yes ? 'yes' : 'no';
      const btn = buttons.find((b) => (b.textContent || b.value || '').trim().toLowerCase() === want);
      if (btn) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        btn.click();
        return true;
      }
      const primary = document.querySelector('button[data-testid="primaryButton"]');
      if (primary && yes) {
        primary.click();
        return true;
      }
      return false;
    }, accept);
    if (clicked) await page.waitForTimeout(4000);
    return clicked;
  },
  clickSkip: (page) =>
    page.evaluate(() => {
      const link = [...document.querySelectorAll('a, button')].find((el) => /skip for now/i.test(el.textContent || ''));
      if (link) {
        link.click();
        return true;
      }
      return false;
    }),
};

async function typeIntoInput(page, selectors, value) {
  const ok = await page.evaluate(({ sels, text }) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const el = sels.map((s) => document.querySelector(s)).find(Boolean);
    if (!el || !setter) return false;

    el.focus();
    setter.call(el, '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));

    for (const char of text) {
      setter.call(el, el.value + char);
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char, bubbles: true })
      );
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === text;
  }, { sels: selectors, text: value });

  if (!ok) {
    await setInputValue(page, selectors, value);
  }
  await page.waitForTimeout(600);
  return ok;
}

async function setInputValue(page, selectors, value) {
  const ok = await page.evaluate(({ sels, val }) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) continue;
      el.focus();
      if (setter) setter.call(el, val);
      else el.value = val;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: val }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }, { sels: selectors, val: value });
  return ok;
}

async function fillEmail(page, email) {
  const selectors = ['#usernameEntry', '#i0116', 'input[name="loginfmt"]', 'input[type="email"]'];
  if (!(await setInputValue(page, selectors, email))) {
    const input = await waitForAny(page, selectors, 15_000);
    await input.fill(email, { force: true });
  }
  await page.waitForTimeout(500);
}

async function fillPassword(page, password) {
  await preferPasswordSignIn(page);
  const selectors = ['#passwordEntry', '#i0118', 'input[name="passwd"]', 'input[type="password"]'];
  if (!(await setInputValue(page, selectors, password))) {
    const input = await waitForAny(page, selectors, 25_000);
    await input.fill(password, { force: true });
  }
  await page.waitForTimeout(500);
}

async function clickNext(page) {
  await clickByEvaluate(page, ['Next'], 'button[data-testid="primaryButton"], #idSIButton9, input[type="submit"]');
  await waitForPasswordOrRedirect(page);
}

async function waitForPasswordOrRedirect(page, log, { skipBackupEmail = true } = {}) {
  try {
    await prepareForPasswordEntry(page, log, { skipBackupEmail, timeoutMs: 35_000 });
  } catch {
    // obscura path — fall through if password still not visible
  }
}

const PASSWORD_FIELD = '#passwordEntry, #i0118, input[name="passwd"], input[type="password"]';

async function isPasswordFieldVisible(page) {
  return page.locator(PASSWORD_FIELD).first().isVisible({ timeout: 400 }).catch(() => false);
}

/** After email+Next: skip backup-email prompts and switch from code screen to password. */
async function prepareForPasswordEntry(page, log, { email, skipBackupEmail = true, backupEmailMode = 'skip', timeoutMs = 50_000, jobId, engine, backupTrace, onBackupPromptSeen, onBackupSkipped } = {}) {
  const promptArgs = { onBackupPromptSeen, onBackupSkipped, trace: backupTrace };
  const skipPrompts = skipBackupEmail;
  const deadline = Date.now() + timeoutMs;
  let rounds = 0;

  while (Date.now() < deadline) {
    if (await isPasswordFieldVisible(page)) return;

    const url = page.url();
    const onLoginHost = /login\.(live|microsoftonline|microsoft)\.com/i.test(url);

    if (onLoginHost) {
      if (await isBackupEmailScreen(page)) {
        const r = await resolveBackupPrompt(page, { leafEmail: email, skipBackupEmail, log, ...promptArgs });
        if (r === 'backup_email_required') {
          const err = new Error('Backup email verification required.');
          err.code = 'BACKUP_EMAIL_REQUIRED';
          throw err;
        }
        if (r === 'completed' || r === 'skipped') {
          await page.waitForTimeout(3000);
          continue;
        }
        if (r === 'none') {
          log?.('backup', 'Backup screen still visible — not using password bypass');
          await page.waitForTimeout(2000);
          continue;
        }
      }

      const dismissed = await dismissSecurityPrompts(page, log, {
        skipBackupEmail: skipPrompts,
        ...promptArgs,
      });
      if (dismissed === 'backup_email_required') {
        const err = new Error('Backup email verification required.');
        err.code = 'BACKUP_EMAIL_REQUIRED';
        throw err;
      }
      if (dismissed === 'clicked') {
        await page.waitForTimeout(2500);
        continue;
      }

      if (await isBackupEmailScreen(page)) {
        await page.waitForTimeout(2000);
        continue;
      }

      const switched = await preferPasswordSignIn(page, log, { force: true });
      if (switched && (await isPasswordFieldVisible(page))) return;
    }

    rounds++;
    if (rounds % 4 === 0) {
      log?.('auth', 'Still waiting for password field — retrying skip / use-password…');
    }
    await page.waitForTimeout(1500);
  }

  if (jobId) await captureScreenshot(page, jobId, 'password-blocked', engine).catch(() => {});
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const hint = detectPasswordBlocker(bodyText);
  const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 220);
  if (snippet) log?.('auth', `Sign-in page: ${snippet}`);
  throw new Error(
    hint || `Password field did not appear within ${Math.round(timeoutMs / 1000)}s — backup email or verification may be blocking sign-in.`
  );
}

function detectPasswordBlocker(bodyText) {
  const body = (bodyText || '').toLowerCase();
  if (/issue looking up your account|couldn.?t find.*account|account doesn.?t exist/i.test(body)) {
    return 'Microsoft could not look up this account (often proxy/rate-limit) — retry or rotate IP.';
  }
  if (/too many|try again later|temporarily blocked/i.test(body)) {
    return 'Microsoft rate-limited this IP — wait or rotate proxy, then retry.';
  }
  if (/backup email|alternate email|add a way to verify|help us protect|security info|let.?s protect/i.test(body)) {
    return 'Blocked on backup-email screen — enable "Skip backup email for 7 days" or complete manually.';
  }
  if (/enter code|verification code|send a code|check your .*email/i.test(body) && !/use password/i.test(body)) {
    return 'Blocked on verification-code screen — could not switch to password sign-in.';
  }
  if (/approve sign in|authenticator app/i.test(body)) {
    return 'Multi-factor authentication required.';
  }
  return null;
}

async function fillEmailReliable(page, email) {
  const input = page.locator('#usernameEntry, #i0116, input[name="loginfmt"], input[type="email"]').first();
  await input.waitFor({ state: 'visible', timeout: 20_000 });
  await input.click();
  await input.fill('');
  await page.waitForTimeout(250);
  await input.pressSequentially(email, { delay: 30 });
  const val = await input.inputValue();
  if (val.trim().toLowerCase() !== email.trim().toLowerCase()) {
    await input.fill(email);
  }
}

async function readSignInStep(page) {
  return page.evaluate(() => {
    const body = document.body?.innerText || '';
    const lower = body.toLowerCase();
    const hasPassword = !!document.querySelector(
      '#passwordEntry, #i0118, input[name="passwd"], input[type="password"]:not([hidden])'
    );
    const emailVisible = !!document.querySelector('#usernameEntry, #i0116, input[name="loginfmt"], input[type="email"]');
    let emailError = null;
    if (/issue looking up your account/i.test(body)) emailError = 'There was an issue looking up your account';
    else if (/couldn.?t find.*account|account doesn.?t exist/i.test(lower)) emailError = 'Account not found';
    else if (/enter a valid email/i.test(lower)) emailError = 'Invalid email';
    else if (/too many|try again later/i.test(lower)) emailError = 'Too many requests — try again later';
    return { hasPassword, emailVisible, emailError };
  });
}

async function submitEmailWithRetry(getPage, email, interact, log, { onEmailRetry, maxAttempts = 4 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const page = typeof getPage === 'function' ? await getPage() : getPage;
    if (attempt > 1) {
      log('email', `Retrying email step (${attempt}/${maxAttempts})…`);
      await onEmailRetry?.(attempt);
      await page.waitForTimeout(1200 * attempt);
    } else {
      log('email', 'Entering email address…');
    }

    await interact.fillEmail(page, email);
    await interact.clickNext(page);
    await page.waitForTimeout(3000);

    const state = await readSignInStep(page);
    if (state.hasPassword) return;

    if (state.emailError) {
      log('email', `Microsoft: ${state.emailError}`);
      continue;
    }

    if (!state.emailVisible) return;
    log('email', 'Still on email screen after Next — retrying…');
  }

  const page = typeof getPage === 'function' ? await getPage() : getPage;
  const state = await readSignInStep(page);
  if (state.emailError) {
    throw new Error(`${state.emailError}. Try again or rotate proxy IP.`);
  }
  if (!state.hasPassword && state.emailVisible) {
    throw new Error('Could not advance past email screen — Microsoft may be blocking this IP.');
  }
}

/** Backup-email / verify screens show a code field first — switch to password. */
async function preferPasswordSignIn(page, log, { force = false } = {}) {
  const state = await page.evaluate(() => {
    const hasPassword = !!document.querySelector(
      '#passwordEntry, #i0118, input[name="passwd"], input[type="password"]:not([hidden])'
    );
    const body = (document.body?.innerText || '').toLowerCase();
    const codeInput = document.querySelector(
      'input#iOttText, input[name="otc"], input[autocomplete="one-time-code"], input[inputmode="numeric"]'
    );
    const onCodeScreen =
      !hasPassword &&
      (codeInput ||
        /enter code|verification code|send a code|we.?ll send|where should we send|verify your identity|we need to verify|help us protect|prove it.?s you|check your .*email|choose how to sign in|pick an option/i.test(
          body
        ));
    return { hasPassword, onCodeScreen, body: body.slice(0, 300) };
  });

  if (state.hasPassword) return false;
  if (!force && !state.onCodeScreen) return false;

  log?.('auth', 'No password field yet — trying "Use password" / other sign-in options…');

  const clicked = await clickUsePasswordLink(page);
  if (clicked) {
    log?.('auth', `Clicked: ${clicked}`);
    await page.waitForTimeout(2500);
    return true;
  }

  const secondTry = await clickOtherWaysThenPassword(page);
  if (secondTry) {
    log?.('auth', `Via other sign-in options: ${secondTry}`);
    await page.waitForTimeout(2500);
    return true;
  }

  if (force) {
    log?.('auth', 'Could not find "Use password" link yet…');
  } else {
    log?.('auth', 'Could not find "Use password" link — waiting for password field…');
  }
  return false;
}

async function clickUsePasswordLink(page) {
  const legacy = page.locator('#idA_PWD_SwitchToPassword').first();
  if (await legacy.isVisible({ timeout: 800 }).catch(() => false)) {
    await legacy.click({ noWaitAfter: true });
    return 'Use your password (legacy)';
  }

  return page.evaluate(() => {
    const patterns = [
      /use your password/i,
      /use password instead/i,
      /^use password$/i,
      /sign in with (?:a )?password/i,
      /password instead/i,
      /use my password/i,
    ];
    const nodes = [
      ...document.querySelectorAll('a, button, [role="button"], [role="link"], span.fui-Link'),
    ];
    for (const el of nodes) {
      const text = (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 80) continue;
      if (patterns.some((p) => p.test(text))) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        el.click();
        return text;
      }
    }
    return null;
  });
}

async function clickOtherWaysThenPassword(page) {
  const opened = await page.evaluate(() => {
    const patterns = [/other ways to sign in/i, /sign-?in options/i, /more options/i, /can.?t use/i];
    const nodes = [...document.querySelectorAll('a, button, [role="button"], [role="link"]')];
    for (const el of nodes) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (patterns.some((p) => p.test(text))) {
        el.click();
        return text;
      }
    }
    return null;
  });

  if (!opened) return null;
  await page.waitForTimeout(1500);

  const picked = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('a, button, [role="button"], [role="menuitem"], li, div[tabindex]')];
    for (const el of nodes) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^password$/i.test(text) || /^use password$/i.test(text)) {
        el.click();
        return text;
      }
    }
    return null;
  });

  return picked ? `${opened} → ${picked}` : opened;
}

async function clickSignIn(page) {
  await clickByEvaluate(page, ['Sign in', 'sign in'], 'button[data-testid="primaryButton"], #idSIButton9, input[type="submit"]');
}

async function clickByEvaluate(page, labels, fallbackSelector) {
  const clicked = await page.evaluate((labelList) => {
    const buttons = [...document.querySelectorAll('button, input[type="submit"]')];
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').trim().toLowerCase();
      if (labelList.some((l) => text === l.toLowerCase() || text.includes(l.toLowerCase()))) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        btn.click();
        return true;
      }
    }
    const primary = document.querySelector('button[data-testid="primaryButton"]');
    if (primary && !primary.disabled) {
      primary.click();
      return true;
    }
    const form = document.querySelector('form');
    if (form) {
      form.requestSubmit?.();
      return true;
    }
    return false;
  }, labels);

  if (!clicked) {
    await page.keyboard.press('Enter').catch(() => {});
  }
  await page.waitForTimeout(1500);
}

async function handlePostLogin(page, log, interact, context, { email, skipBackupEmail = true, backupEmailMode = 'skip', backupTrace, onBackupPromptSeen, onBackupSkipped } = {}) {
  const promptArgs = { onBackupPromptSeen, onBackupSkipped, trace: backupTrace };
  const skipPrompts = skipBackupEmail;
  let handledStaySignedIn = false;
  let skipCount = 0;

  for (let i = 0; i < 15; i++) {
    const url = page.url();
    const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    const cookies = await context.cookies();

    if (/incorrect password|wrong password|account or password is incorrect/i.test(body)) {
      return 'wrong_password';
    }

    if (await isBackupEmailScreen(page)) {
      const r = await resolveBackupPrompt(page, { leafEmail: email, skipBackupEmail, backupEmailMode, log, ...promptArgs });
      if (r === 'backup_email_required') return 'backup_email_required';
      if (r === 'completed' || r === 'skipped') {
        skipCount++;
        await page.waitForTimeout(2500);
        continue;
      }
      log('prompt', 'Backup email screen detected — could not resolve prompt.');
    }

    if (
      /approve sign in request|authenticator app/i.test(body) ||
      (/enter code|verification code/i.test(body) && !/use your password|use password/i.test(body)) ||
      (/proofup|mfa/i.test(url) && !/skip for/i.test(body))
    ) {
      return 'mfa_required';
    }

    if (/stay signed in/i.test(body) && !handledStaySignedIn) {
      log('prompt', 'Clicking Yes on "Stay signed in" to save persistent profile…');
      await interact.clickStaySignedIn(page, true);
      handledStaySignedIn = true;
      await page.waitForTimeout(5000);
      continue;
    }

    if (skipCount < 6) {
      const dismissed = await dismissSecurityPrompts(page, log, {
        skipBackupEmail: skipPrompts,
        ...promptArgs,
      });
      if (dismissed === 'clicked') {
        skipCount++;
        await page.waitForTimeout(2000);
        continue;
      }
      if (dismissed === 'backup_email_required') {
        return 'backup_email_required';
      }
    }

    const stillOnLogin = /login\.microsoftonline\.com|login\.live\.com|account\.live\.com/i.test(url);
    const hasSession = hasMicrosoftSessionCookies(cookies) || cookies.length >= 12;

    if (hasSession && !stillOnLogin) {
      if (!(await isBackupEmailScreen(page))) return 'done';
    }

    if (!stillOnLogin && /outlook\.live\.com|outlook\.office/i.test(url)) {
      await dismissOutlookBlockingPrompts(page, log, {
        skipBackupEmail: skipPrompts,
        maxRounds: 3,
        ...promptArgs,
      });
      if (!(await isBackupEmailScreen(page))) return 'done';
    }

    if (/loading/i.test(body) || url.includes('post.srf')) {
      await page.waitForTimeout(2000);
      continue;
    }

    await page.waitForTimeout(1500);
  }

  const cookies = await context.cookies();
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (/stay signed in/i.test(body)) return 'pending';
  return hasMicrosoftSessionCookies(cookies) || cookies.length >= 12 ? 'done' : 'pending';
}

function hasMicrosoftSessionCookies(cookies) {
  const names = new Set(cookies.map((c) => c.name));
  return ['ESTSAUTH', 'ESTSAUTHPERSISTENT', 'WLSSC', 'NAP', 'ANON'].some((n) => names.has(n));
}

async function waitForAny(page, selectors, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 500 }).catch(() => false)) return loc;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`Could not find element: ${selectors.join(', ')}`);
}

async function clickFirst(page, selectors) {
  const btn = await waitForAny(page, selectors, 15_000);
  await btn.click();
}

function detectErrorMessage(bodyText) {
  const patterns = [
    /incorrect password/i,
    /account doesn't exist/i,
    /account is locked/i,
    /too many attempts/i,
    /verify your identity/i,
  ];
  for (const p of patterns) {
    const m = bodyText.match(p);
    if (m) return m[0];
  }
  return null;
}

async function captureScreenshot(page, jobId, tag, engine) {
  if (engine === 'obscura') return null;
  const file = path.join(SCREENSHOTS_DIR, `${jobId}-${tag}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

export { TARGETS };
