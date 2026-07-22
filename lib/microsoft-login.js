import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBrowser, resolveEngine } from './browser.js';
import { loadProfile, saveProfile, hasValidSession, CANONICAL_TARGET } from './profile.js';
import { resolveAccountFingerprint } from './anti-detect.js';
import { captureOutlookTokens, isTokenValid, isLiveProfileCardToken } from './token-extract.js';
import { isProxyEnabled } from './settings.js';
import { closeLocalProxy, getPlaywrightProxyConfig } from './proxy-local.js';
import {
  isAddBackupEmailSetupScreen,
  isBackupEmailScreen,
  isInterruptUrl,
  clickSkipBackupEmail,
  dismissSecurityPrompts,
  dismissOutlookBlockingPrompts,
  STAY_SIGNED_IN_RE,
} from './security-prompts.js';
import { resolveBackupPrompt, recordBackupRequired, createBackupTrace, backupPromptCallbacks, finalizeBackupMarking } from './backup-email.js';

const NAV_TIMEOUT_MS = Number(process.env.PROXY_NAV_TIMEOUT_MS || 45_000);
function navTimeoutMs() {
  return isProxyEnabled() ? NAV_TIMEOUT_MS : 45_000;
}
function domContentLoadedTimeoutMs() {
  return isProxyEnabled() ? 30_000 : 30_000;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots');
const SESSIONS_DIR = path.join(ROOT, 'sessions');

const TARGETS = {
  outlook: {
    name: 'Outlook',
    url: 'https://outlook.live.com/mail/',
    // Prefer plain login URL — ?mkt=en-US on a MENA mobile exit mismatches geoip locale/TZ
    // and is a strong Microsoft risk signal. Button clicks already support AR/EN labels.
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
  regenerateFingerprint = false,
  mimicPhone,
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
      email, password, target, config, engine: useEngine, saved, jobId, log, forceFresh, regenerateFingerprint, mimicPhone, skipBackupEmail, backupEmailMode, onEmailRetry,
    });
  }

  return runLoginAttempt({
    email, password, target, config, engine: useEngine, saved, jobId, log, forceFresh, regenerateFingerprint, mimicPhone, skipBackupEmail, backupEmailMode, onEmailRetry,
  });
}

async function runLoginAttempt({
  email, password, target, config, engine, saved, jobId, log, forceFresh = false, regenerateFingerprint = false, mimicPhone, skipBackupEmail = true, backupEmailMode = 'skip', onEmailRetry,
}) {
  let session;
  let context;
  let page;
  const usedEngine = engine;
  const backupTrace = createBackupTrace();
  const backupCb = backupPromptCallbacks(email, backupTrace, log);
  const backupOpts = () => ({ ...backupCb, trace: backupTrace });

  try {
    const fingerprint = resolveAccountFingerprint(
      email,
      saved?.state?.fingerprint,
      typeof mimicPhone === 'boolean' ? mimicPhone : undefined
    );
    const modeChanged =
      typeof mimicPhone === 'boolean' &&
      !!mimicPhone !== !!(saved?.state?.mimicPhone ?? saved?.state?.fingerprint?.mimicPhone);
    if (modeChanged) regenerateFingerprint = true;
    if (fingerprint.mimicPhone) {
      log(
        'engine',
        `Phone mimic ON — Camoufox mobile-sized window ${fingerprint.viewport.width}x${fingerprint.viewport.height} (unique per account; desktop Firefox OS, touch enabled).`
      );
    }
    const browserState = { session: null, context: null, page: null };

    if (!forceFresh && saved?.state && hasValidSession(saved.state) && isTokenValid(saved.state.tokens)) {
      log('profile', `Session and token already valid for ${email} — skipping login`);
      browserState.session = await connectBrowser({
        email,
        target: CANONICAL_TARGET,
        fingerprint,
        saved,
        forceFresh: false,
        mimicPhone: fingerprint.mimicPhone,
      });
      browserState.context = browserState.session.context;
      browserState.page = browserState.session.page || (await browserState.context.newPage());
      session = browserState.session;
      context = browserState.context;
      page = browserState.page;
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

    const reopenBrowser = async (reason) => {
      if (browserState.session) await browserState.session.close().catch(() => {});
      browserState.session = await connectBrowser({
        email,
        target: CANONICAL_TARGET,
        fingerprint,
        saved,
        forceFresh: true,
        regenerateFingerprint,
        mimicPhone: fingerprint.mimicPhone,
        // No Playwright route() during password login — reduces GetCredentialType soft-flags.
        saveBandwidth: false,
      });
      browserState.context = browserState.session.context;
      browserState.page = browserState.session.page || (await browserState.context.newPage());
      session = browserState.session;
      context = browserState.context;
      page = browserState.page;
      log('connect', reason || 'Reconnected Camoufox (fresh proxy relay)…');
      const rebuilt = browserState.session.reusedLaunchOptions === false;
      log(
        'fingerprint',
        rebuilt
          ? `New Camoufox launch-options for ${email} (BrowserForge rebuilt; seed ${fingerprint.seed.slice(0, 8)}… is email-hash only)`
          : `Stable Camoufox launch-options for ${email} (seed ${fingerprint.seed.slice(0, 8)}… is email-hash, not the device)`
      );
      // Do NOT goto login here — a double-load before email makes Next a no-op
      // ("Still on email screen"). runLoginAttempt navigates once.
    };

    await reopenBrowser(
      forceFresh
        ? 'Connected via Camoufox (ephemeral context — no saved cookies injected)'
        : 'Connected via Camoufox (may reuse saved cookies if profile valid)'
    );

    const interact = chromiumInteract;

    if (!forceFresh && saved?.state && hasValidSession(saved.state)) {
      log('profile', `Reusing saved session for ${email} (cookies + Firefox profile)`);
      const needsToken = !isTokenValid(saved.state.tokens);
      if (!needsToken) {
        await page.goto(config.url, { waitUntil: 'commit', timeout: navTimeoutMs() }).catch(() => {});
        await page.waitForLoadState('domcontentloaded', { timeout: domContentLoadedTimeoutMs() }).catch(() => {});
        await page.waitForTimeout(3000);
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
        await page.goto(config.url, { waitUntil: 'commit', timeout: navTimeoutMs() }).catch(() => {});
        await page.waitForLoadState('domcontentloaded', { timeout: domContentLoadedTimeoutMs() }).catch(() => {});
        await page.waitForTimeout(3000);
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
    // Jul 13: no clearCookies; forceFresh already skips injecting saved cookies.
    await page.goto(config.loginUrl || config.url, { waitUntil: 'commit', timeout: navTimeoutMs() });
    await page.waitForLoadState('domcontentloaded', { timeout: domContentLoadedTimeoutMs() }).catch(() => {});
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
        // Same IP only — changeip mid-login causes "issue looking up your account".
        await onEmailRetry?.(attempt);
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
    // Jul 13 path: locator fill + Sign-in (kept waitAfterPassword so we never fake Success).
    const pwdInput = page.locator(PASSWORD_FIELD).first();
    await pwdInput.waitFor({ state: 'visible', timeout: 15_000 });
    await pwdInput.fill(password);
    await interact.clickSignIn(page);

    // Keep post-password cookie/block wait (anti fake-success) — not in Jul 13, but required.
    const afterPwd = await waitAfterPasswordSubmit(page, context, log);
    if (afterPwd.block) {
      log('error', afterPwd.block);
      const shot = await captureScreenshot(page, jobId, 'error', usedEngine);
      return {
        status: 'failed',
        code: afterPwd.code || softBlockCodeFromText('', afterPwd.block) || undefined,
        message: afterPwd.block,
        email,
        target,
        engine: usedEngine,
        url: page.url(),
        screenshot: shot ? `screenshots/${jobId}-error.png` : null,
      };
    }

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
    if (postLogin === 'password_blocked') {
      const shot = await captureScreenshot(page, jobId, 'error', usedEngine);
      return {
        status: 'failed',
        code: 'PASSWORD_BLOCKED',
        message:
          'Microsoft blocked password sign-in on this IP ("Password sign-in isn\'t available"). Rotate IP / retry — same account often works on a clean residential exit.',
        email,
        target,
        engine: usedEngine,
        url: page.url(),
        screenshot: shot ? `screenshots/${jobId}-error.png` : null,
      };
    }
    if (postLogin === 'rate_limited') {
      const shot = await captureScreenshot(page, jobId, 'error', usedEngine);
      return {
        status: 'failed',
        code: 'RATE_LIMITED',
        message: 'Microsoft rate-limited this IP after password (Too Many Requests). Rotate to a settled IP and retry.',
        email,
        target,
        engine: usedEngine,
        url: page.url(),
        screenshot: shot ? `screenshots/${jobId}-error.png` : null,
      };
    }

    // Dynamic: if skip prompt appeared (or we're on proofs), open EN proofs and click Skip.
    // Accounts with no skip prompt → skip this and go straight to Outlook.
    if (skipBackupEmail) {
      await openProofsAndClickSkip(page, log, backupCb, {
        force: !!(backupTrace?.promptSeen || isInterruptUrl(page.url())),
      });
    }

    if (postLogin === 'done' || postLogin === 'pending') {
      const cookies = await context.cookies();
      if (hasMicrosoftSessionCookies(cookies)) {
        log('success', `Microsoft session established (${cookies.length} cookies)`);
        log('token', 'Opening Outlook mail to capture LiveProfileCard token…');
        await page.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: navTimeoutMs() }).catch(() => {});
        await page.waitForTimeout(2500);
        await dismissSecurityPrompts(page, log, { skipBackupEmail, ...backupCb });
        return await buildResult({
          page, context, email, target, jobId, status: 'success', engine: usedEngine, fingerprint, log, skipBackupEmail, backupEmailMode, backupTrace, ...backupCb,
        });
      }
    }

    // No auth cookies — never open Outlook (that created false "Signed in" + login_required).
    if (postLogin === 'pending') {
      const shot = await captureScreenshot(page, jobId, 'error', usedEngine);
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const blockMsg = detectPostPasswordBlockFromText(bodyText);
      const softCode = softBlockCodeFromText(bodyText, blockMsg);
      log(
        'error',
        blockMsg ||
          `Password submitted but no MSA auth cookies (url=${page.url().slice(0, 90)} body="${bodyText.slice(0, 160).replace(/\s+/g, ' ')}")`
      );
      return {
        status: 'failed',
        ...(softCode ? { code: softCode } : { code: 'NO_AUTH_COOKIES' }),
        message:
          blockMsg ||
          'Password submitted but Microsoft did not issue auth cookies (ESTSAUTH/MSPAuth). Not logged in — often IP soft-block or automation challenge. Rotate IP and retry.',
        email,
        target,
        engine: usedEngine,
        url: page.url(),
        screenshot: shot ? `screenshots/${jobId}-error.png` : null,
      };
    }

    log('verify', `Opening ${config.name}…`);
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs() }).catch(() => {});
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    const success = await isLoggedIn(page, context, config);
    const cookiesAfter = await context.cookies();
    const hasStrongAuth = hasMicrosoftSessionCookies(cookiesAfter);

    // Never claim success without real MSA auth cookies. Marketing redirects
    // (microsoft.com/…/outlook) used to slip through when URL left login.live.com.
    if (!success || !hasStrongAuth) {
      const shot = await captureScreenshot(page, jobId, 'error', usedEngine);
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const blockMsg = detectPostPasswordBlockFromText(bodyText);
      const onLogin = /login\.microsoftonline\.com|login\.live\.com/i.test(finalUrl);
      const onMarketing =
        /microsoft\.com\/.*outlook|office\.com\/.*signin|teams\.live\.com\/gather/i.test(finalUrl);
      const softCode = softBlockCodeFromText(bodyText, blockMsg);
      return {
        status: 'failed',
        ...(softCode ? { code: softCode } : {}),
        message:
          blockMsg ||
          detectErrorMessage(bodyText) ||
          (onLogin
            ? 'Login did not complete — still on Microsoft sign-in page.'
            : onMarketing
              ? 'Login did not complete — Outlook redirected to a public/marketing page (no session cookies). Usually IP throttle or password blocked on this exit.'
              : 'Login did not complete — no Microsoft auth cookies (ESTSAUTH/MSPAuth). Not actually signed in.'),
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
  if (isLiveProfileCardToken(captured)) {
    return {
      ...captured,
      refresh_token: captured.refresh_token || existingTokens?.refresh_token || null,
    };
  }
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
    // Always sweep skip-7-days / security overlays before token (Outlook can show them late).
    const lateSkip = await dismissOutlookBlockingPrompts(page, log, {
      skipBackupEmail: skipPrompts,
      maxRounds: 8,
      ...promptArgs,
    });
    if (lateSkip === 'clicked' || backupTrace?.promptSeen || backupTrace?.skipped) {
      log?.('token', 'Settling 5s after backup/security skip before token capture…');
      await page.waitForTimeout(5_000);
    }
    log?.('token', 'Requesting LiveProfileCard.Access token…');
    // One more aggressive skip sweep — interrupt often appears only after Outlook land.
    for (let sweep = 0; sweep < 4; sweep++) {
      if (!(await isBackupEmailScreen(page)) && !isInterruptUrl(page.url())) break;
      log?.('prompt', 'Backup/interrupt still on screen before token — clicking skip…');
      const skipped = skipPrompts ? await clickSkipBackupEmail(page) : null;
      if (skipped) {
        log?.('prompt', `Skipped before token: "${skipped}"`);
        if (onBackupSkipped) await onBackupSkipped(skipped);
        await page.waitForTimeout(2500);
        continue;
      }
      await dismissOutlookBlockingPrompts(page, log, {
        skipBackupEmail: skipPrompts,
        maxRounds: 2,
        ...promptArgs,
      });
      await page.waitForTimeout(1500);
    }
    if (target === 'teams' && !/outlook\.live\.com/i.test(page.url())) {
      log?.('token', 'Teams session ready — opening Outlook mail for LiveProfileCard token…');
      await page.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: navTimeoutMs() }).catch(() => {});
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
    mimicPhone: !!fingerprint?.mimicPhone,
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
  // Locator wait only — do NOT page.evaluate-poll (that broke GetCredentialType / Next).
  log('wait', 'Waiting for sign-in form…');
  await page
    .locator('#usernameEntry, #i0116, input[name="loginfmt"], input[type="email"]')
    .first()
    .waitFor({ state: 'visible', timeout: 35_000 });
  await page
    .locator('button[data-testid="primaryButton"], input[type="submit"], #idSIButton9')
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => {});
  // Give Fluent/React time to bind GetCredentialType handlers before fill/Next.
  await page.waitForTimeout(2500);
}

async function isLoggedIn(page, context, config) {
  const url = page.url();
  // Auth cookies often exist while still on proof-up / "skip 7 days" — that is NOT logged in.
  if (isInterruptUrl(url) || (await isBackupEmailScreen(page))) return false;

  const cookies = await context.cookies();
  const hasAuthCookies = hasMicrosoftSessionCookies(cookies);
  // Require real MSA session cookies — never treat cookie-count / Outlook URL alone as signed-in.
  if (!hasAuthCookies) return false;

  if (config.successPatterns.some((p) => p.test(url))) return true;
  if (!/login\.(live|microsoftonline)\.com|account\.live\.com/i.test(url)) {
    return true;
  }

  const title = (await page.title()).toLowerCase();
  if (title.includes('sign in') || title.includes('account') || /تسجيل الدخول|الحساب/.test(title)) {
    return false;
  }
  return false;
}

/** Always prefer Yes on KMSI / Stay signed in (EN + AR + Fluent primary). */
async function clickStaySignedInYes(page, accept = true) {
  if (!accept) {
    const noLabels = ['No', 'لا', 'Non', 'Nein'];
    for (const label of noLabels) {
      const btn = page
        .locator(
          `input[type="submit"][value="${label}"], button:has-text("${label}"), [role="button"]:has-text("${label}")`
        )
        .first();
      if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
        await btn.click({ noWaitAfter: true, delay: 30 });
        await page.waitForTimeout(2000);
        return true;
      }
    }
    return false;
  }

  // Classic MSA: #idSIButton9 is Yes on Stay signed in.
  const classicYes = page.locator('#idSIButton9').first();
  if (await classicYes.isVisible({ timeout: 800 }).catch(() => false)) {
    await classicYes.click({ noWaitAfter: true, delay: 30 });
    await page.waitForTimeout(2500);
    return true;
  }

  const labels = ['Yes', 'نعم', 'Oui', 'Ja', 'Sí', 'OK'];
  for (const label of labels) {
    const btn = page
      .locator(
        `input[type="submit"][value="${label}"], button:has-text("${label}"), [role="button"]:has-text("${label}")`
      )
      .first();
    if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
      await btn.click({ noWaitAfter: true, delay: 30 });
      await page.waitForTimeout(2500);
      return true;
    }
  }

  // Fluent primary button on KMSI page (usually Yes).
  const primary = page.locator('button[data-testid="primaryButton"]').first();
  if (await primary.isVisible({ timeout: 800 }).catch(() => false)) {
    const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    if (STAY_SIGNED_IN_RE.test(body)) {
      await primary.click({ noWaitAfter: true, delay: 30 });
      await page.waitForTimeout(2500);
      return true;
    }
  }

  const clicked = await page
    .evaluate(() => {
      const want = [/^\s*yes\s*$/i, /^\s*نعم\s*$/i, /^\s*oui\s*$/i, /^\s*ja\s*$/i, /^\s*sí\s*$/i, /^\s*ok\s*$/i];
      const buttons = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')];
      for (const b of buttons) {
        const t = (b.textContent || b.value || '').replace(/\s+/g, ' ').trim();
        if (want.some((re) => re.test(t))) {
          b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          b.click();
          return true;
        }
      }
      const idBtn = document.querySelector('#idSIButton9');
      if (idBtn) {
        idBtn.click();
        return true;
      }
      return false;
    })
    .catch(() => false);

  if (clicked) await page.waitForTimeout(2500);
  return !!clicked;
}

const chromiumInteract = {
  // Jul 13 (5789d41) interaction path.
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
    await page
      .locator('button[data-testid="primaryButton"], input[type="submit"], #idSIButton9')
      .first()
      .click({ noWaitAfter: true });
    await page.waitForTimeout(2500);
  },
  async clickSignIn(page) {
    await page
      .locator(
        'button[data-testid="primaryButton"], input[type="submit"][value="Sign in"], #idSIButton9, input[type="submit"]'
      )
      .first()
      .click({ noWaitAfter: true });
    await page.waitForTimeout(2500);
  },
  async clickStaySignedIn(page, accept = true) {
    return clickStaySignedInYes(page, accept);
  },
  async clickSkip(page) {
    const skipped = await clickSkipBackupEmail(page);
    return !!skipped;
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
  clickStaySignedIn: async (page, accept = true) => clickStaySignedInYes(page, accept),
  clickSkip: async (page) => !!(await clickSkipBackupEmail(page)),
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
      const switched = await preferPasswordSignIn(page, log, { force: true });
      if (switched && (await isPasswordFieldVisible(page))) return;

      if (await isAddBackupEmailSetupScreen(page)) {
        const r = await resolveBackupPrompt(page, { leafEmail: email, skipBackupEmail, log, ...promptArgs });
        if (r === 'backup_email_required') {
          const err = new Error('Backup email verification required.');
          err.code = 'BACKUP_EMAIL_REQUIRED';
          throw err;
        }
        if (r === 'skipped') {
          await page.waitForTimeout(3000);
          continue;
        }
        // r === 'retry' | 'none' — keep looking for password field
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

      const switchedAgain = await preferPasswordSignIn(page, log, { force: true });
      if (switchedAgain && (await isPasswordFieldVisible(page))) return;
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
  await input.pressSequentially(email, { delay: 30 });
  const val = await input.inputValue();
  if (val.trim().toLowerCase() !== email.trim().toLowerCase()) {
    await input.fill(email);
  }
  await page.waitForTimeout(300);
}

async function fillPasswordReliable(page, password) {
  await preferPasswordSignIn(page);
  const input = page.locator('#passwordEntry, #i0118, input[name="passwd"], input[type="password"]').first();
  await input.waitFor({ state: 'visible', timeout: 25_000 });
  await input.click();
  await input.fill('');
  // Human-like typing (Jul 16 proven path) — MSA Fluent binds better than instant fill().
  await input.pressSequentially(password, { delay: 25 + Math.floor(Math.random() * 35) });
  const val = await input.inputValue();
  if (val !== password) {
    await fillPassword(page, password);
  }
  await page.waitForTimeout(400);
}

/** Real locator click first (Arabic/English Next); evaluate only as last resort. */
async function clickPrimaryHuman(page, labels = ['Next']) {
  const primary = page.locator('button[data-testid="primaryButton"], #idSIButton9, input[type="submit"]').first();
  if (await primary.isVisible({ timeout: 2500 }).catch(() => false)) {
    await primary.click({ delay: 30 });
    await page.waitForTimeout(1500);
    return;
  }
  for (const label of labels) {
    const byRole = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') });
    if (await byRole.first().isVisible({ timeout: 800 }).catch(() => false)) {
      await byRole.first().click({ delay: 30 });
      await page.waitForTimeout(1500);
      return;
    }
  }
  await clickByEvaluate(page, labels, 'button[data-testid="primaryButton"], #idSIButton9, input[type="submit"]');
}

async function readSignInStep(page) {
  return page.evaluate(() => {
    const body = document.body?.innerText || '';
    const lower = body.toLowerCase();
    const title = (document.title || '').toLowerCase();
    const hasPassword = !!document.querySelector(
      '#passwordEntry, #i0118, input[name="passwd"], input[type="password"]'
    );
    // Password page keeps a loginfmt display field — detect password even if email input still in DOM.
    const onPasswordPage =
      hasPassword ||
      /enter your password/i.test(title) ||
      /enter your password/i.test(lower);
    const emailEntry = document.querySelector('#usernameEntry, #i0116, input[type="email"]');
    const emailVisible = !onPasswordPage && !!emailEntry;
    let emailError = null;
    if (!onPasswordPage) {
      if (/issue looking up your account/i.test(body)) emailError = 'There was an issue looking up your account';
      else if (/couldn.?t find.*account|account doesn.?t exist|we couldn.?t find an account/i.test(lower)) {
        emailError = 'Account not found';
      } else if (/enter a valid email/i.test(lower)) emailError = 'Invalid email';
      else if (/too many|try again later/i.test(lower)) emailError = 'Too many requests — try again later';
    }
    return { hasPassword: onPasswordPage || hasPassword, emailVisible, emailError };
  });
}

async function submitEmailWithRetry(getPage, email, interact, log, { onEmailRetry, maxAttempts = 4 } = {}) {
  // Jul 13 (5789d41) simple path — fill → Next → wait. No GCT probe / live-shield / Enter thrash.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      log('email', `Retrying email step (${attempt}/${maxAttempts})…`);
      await onEmailRetry?.(attempt);
    } else {
      log('email', 'Entering email address…');
    }

    const page = typeof getPage === 'function' ? await getPage() : getPage;
    if (attempt > 1) {
      await page.waitForTimeout(1200 * attempt);
    }

    await interact.fillEmail(page, email);
    await interact.clickNext(page);
    await page.waitForTimeout(3000);

    const state = await readSignInStep(page);
    {
      const title = await page.title().catch(() => '');
      log(
        'email',
        `After Next: title="${title.slice(0, 60)}" hasPassword=${state.hasPassword} err=${state.emailError || 'none'} url=${page.url().slice(0, 70)}`
      );
    }
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
  // Fluent password step often labels the primary button "Next" (EN) / "التالي" (AR).
  await clickPrimaryHuman(page, ['Sign in', 'Next', 'التالي', 'تسجيل الدخول', 'Anmelden', 'Se connecter']);
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

/**
 * Dynamic Skip handling:
 * - If Skip is already on screen → click it
 * - If force (prompt was seen) → open EN proofs/Add and click Skip if present
 * - If this account has no skip prompt → do nothing, continue to Outlook
 */
async function openProofsAndClickSkip(page, log, backupCb = {}, { force = false } = {}) {
  const skipOnScreen =
    (await page.getByText(/Skip for now|days until this is required|تخطي لمدة/i).count().catch(() => 0)) > 0 ||
    (await page.locator('#iShowSkip').count().catch(() => 0)) > 0;

  if (skipOnScreen || /account\.live\.com\/proofs/i.test(page.url())) {
    const ok = await clickSkipOnCurrentPage(page, log, backupCb);
    if (ok) return true;
  }

  if (!force && !skipOnScreen) {
    log?.('prompt', 'No Skip-for-7-days prompt — continuing to Outlook');
    return false;
  }

  log?.('prompt', 'Opening proofs/Add?mkt=EN-US to click Skip…');
  await page
    .goto('https://account.live.com/proofs/Add?mkt=EN-US', {
      waitUntil: 'domcontentloaded',
      timeout: navTimeoutMs(),
    })
    .catch(() => {});
  await page.waitForTimeout(3000);

  // After navigate: only click if Skip link is really there (not every proofs page has it).
  const hasSkip =
    (await page.getByText(/Skip for now|days until this is required/i).count().catch(() => 0)) > 0 ||
    (await page.locator('#iShowSkip').count().catch(() => 0)) > 0;

  if (!hasSkip) {
    log?.('prompt', `No Skip button on proofs/Add (url=${page.url().slice(0, 100)}) — continuing to Outlook`);
    return false;
  }

  return clickSkipOnCurrentPage(page, log, backupCb);
}

async function clickSkipOnCurrentPage(page, log, backupCb = {}) {
  const url = page.url();
  log?.('prompt', `Skip-for-7-days — clicking Skip… (${url.slice(0, 100)})`);

  let skipped = await clickSkipBackupEmail(page);
  if (!skipped) {
    const link = page.getByText(/Skip for now/i).first();
    if ((await link.count().catch(() => 0)) > 0) {
      await link.click({ force: true, noWaitAfter: true }).catch(() => {});
      skipped = ((await link.innerText().catch(() => '')) || 'Skip for now').replace(/\s+/g, ' ').trim();
    }
  }
  if (!skipped) {
    skipped = await page
      .evaluate(() => {
        const re = /skip for now|days until this is required/i;
        for (const el of document.querySelectorAll('a, button, [role="button"], [role="link"], span, #iShowSkip')) {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (el.id === 'iShowSkip' || (t && re.test(t) && t.length < 80)) {
            el.click();
            return t || 'skip';
          }
        }
        return null;
      })
      .catch(() => null);
  }

  if (skipped) {
    log?.('prompt', `Clicked Skip: "${skipped}"`);
    if (backupCb.onBackupSkipped) await backupCb.onBackupSkipped(skipped);
    await page.waitForTimeout(2500);
    return true;
  }

  log?.('prompt', 'Skip click failed — continuing');
  return false;
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
    if (PASSWORD_SIGNIN_BLOCKED_RE.test(body)) {
      return 'password_blocked';
    }
    if (
      /^too many requests$/i.test(body.trim()) ||
      /\btoo many requests\b/i.test(body) ||
      /طلبات كثيرة جدا|عدد الطلبات كبير/i.test(body)
    ) {
      return 'rate_limited';
    }

    if (await isAddBackupEmailSetupScreen(page) || isInterruptUrl(url)) {
      const r = await resolveBackupPrompt(page, { leafEmail: email, skipBackupEmail, backupEmailMode, log, ...promptArgs });
      // Only hard-stop when skip checkbox is OFF.
      if (r === 'backup_email_required') return 'backup_email_required';
      if (r === 'completed' || r === 'skipped') {
        skipCount++;
        await page.waitForTimeout(2500);
        continue;
      }
      if (skipPrompts) {
        const forceSkip = await clickSkipBackupEmail(page);
        if (forceSkip) {
          log('prompt', `Force-skipped interrupt: "${forceSkip}"`);
          skipCount++;
          await page.waitForTimeout(2500);
          continue;
        }
        // Skip ON but button missing — leave loop; openProofsAndClickSkip (EN) runs next.
        log('prompt', 'Backup/interrupt seen — will retry Skip on EN proofs/Add after post-login');
        return 'pending';
      }
      log('prompt', 'Backup/interrupt screen detected — could not resolve skip button.');
    }

    // Don't treat proof-up / skip-for-7-days as MFA — those are handled above.
    if (
      !(await isAddBackupEmailSetupScreen(page)) &&
      !isInterruptUrl(url) &&
      (/approve sign in request|authenticator app/i.test(body) ||
        (/enter code|verification code/i.test(body) &&
          !/use your password|use password|استخدام كلمة المرور/i.test(body)))
    ) {
      return 'mfa_required';
    }

    if (STAY_SIGNED_IN_RE.test(body)) {
      log('prompt', 'Clicking Yes on "Stay signed in" to save persistent profile…');
      const clicked = await interact.clickStaySignedIn(page, true);
      if (clicked) {
        handledStaySignedIn = true;
        log('prompt', 'Stay signed in — Yes clicked');
        await page.waitForTimeout(5000);
        continue;
      }
      log('prompt', 'Stay signed in Yes click missed — retrying…');
      await page.waitForTimeout(1500);
      continue;
    }

    if (skipCount < 8) {
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
    const hasSession = hasMicrosoftSessionCookies(cookies);

    // Never mark done while still on interrupt / backup-email.
    if (isInterruptUrl(url) || (await isBackupEmailScreen(page))) {
      await page.waitForTimeout(1500);
      continue;
    }

    // Only "done" with real MSA auth cookies — and never while Stay signed in is still up.
    if (hasSession && !stillOnLogin && !STAY_SIGNED_IN_RE.test(body)) {
      if (!(await isAddBackupEmailSetupScreen(page))) return 'done';
    }

    if (
      hasSession &&
      !stillOnLogin &&
      !STAY_SIGNED_IN_RE.test(body) &&
      /outlook\.live\.com|outlook\.office/i.test(url)
    ) {
      await dismissOutlookBlockingPrompts(page, log, {
        skipBackupEmail: skipPrompts,
        maxRounds: 3,
        ...promptArgs,
      });
      if (!(await isAddBackupEmailSetupScreen(page))) return 'done';
    }

    if (/loading/i.test(body) || url.includes('post.srf')) {
      await page.waitForTimeout(2000);
      continue;
    }

    await page.waitForTimeout(1500);
  }

  const cookies = await context.cookies();
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (PASSWORD_SIGNIN_BLOCKED_RE.test(body)) {
    return 'password_blocked';
  }
  if (/\btoo many requests\b|طلبات كثيرة جدا|عدد الطلبات كبير/i.test(body)) return 'rate_limited';
  // Still on KMSI — try one last Yes before giving up.
  if (STAY_SIGNED_IN_RE.test(body)) {
    log('prompt', 'Stay signed in still showing at end of post-login — clicking Yes…');
    const clicked = await interact.clickStaySignedIn(page, true);
    if (clicked) {
      await page.waitForTimeout(4000);
      const cookies2 = await context.cookies();
      if (hasMicrosoftSessionCookies(cookies2)) return 'done';
    }
    return 'pending';
  }
  if (isInterruptUrl(page.url()) || (await isBackupEmailScreen(page))) return 'pending';
  return hasMicrosoftSessionCookies(cookies) ? 'done' : 'pending';
}

/** Real signed-in MSA cookies only — ANON/NAP appear on anonymous marketing pages. */
function hasMicrosoftSessionCookies(cookies) {
  const names = new Set(cookies.map((c) => c.name));
  return ['ESTSAUTH', 'ESTSAUTHPERSISTENT', 'MSPAuth', '__Host-MSAAUTH'].some((n) => names.has(n));
}

function summarizeAuthCookies(cookies = []) {
  const names = new Set(cookies.map((c) => c.name));
  return ['ESTSAUTH', 'ESTSAUTHPERSISTENT', 'MSPAuth', '__Host-MSAAUTH', 'WLSSC']
    .filter((n) => names.has(n))
    .join(',') || 'none';
}

/**
 * After password submit: wait for real MSA cookies or a hard Microsoft error.
 * Do not navigate away while OAuth redirects are still settling.
 */
async function waitAfterPasswordSubmit(page, context, log, { timeoutMs = 28_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = '';
  while (Date.now() < deadline) {
    const block = await detectPostPasswordBlock(page);
    if (block) {
      return { ok: false, block, code: softBlockCodeFromText('', block) || undefined };
    }

    const cookies = await context.cookies().catch(() => []);
    if (hasMicrosoftSessionCookies(cookies)) {
      log?.(
        'password',
        `Auth cookies present (${summarizeAuthCookies(cookies)}) — waiting for post-login prompts…`
      );
      return { ok: true };
    }

    const url = page.url();
    if (url !== lastUrl) {
      lastUrl = url;
      log?.('password', `Post-password navigate: ${url.slice(0, 100)}`);
    }

    // Stay signed in — click Yes immediately so ESTSAUTHPERSISTENT can settle.
    const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    if (STAY_SIGNED_IN_RE.test(body)) {
      log?.('password', 'Stay-signed-in prompt visible — clicking Yes now…');
      const clicked = await clickStaySignedInYes(page, true);
      if (clicked) log?.('prompt', 'Stay signed in — Yes clicked (post-password wait)');
      return { ok: true, kmsi: true };
    }

    await page.waitForTimeout(1500);
  }

  const block = await detectPostPasswordBlock(page);
  if (block) {
    return { ok: false, block, code: softBlockCodeFromText('', block) || undefined };
  }
  const cookies = await context.cookies().catch(() => []);
  if (hasMicrosoftSessionCookies(cookies)) return { ok: true };

  const body = (await page.locator('body').innerText().catch(() => ''))
    .slice(0, 180)
    .replace(/\s+/g, ' ');
  log?.(
    'password',
    `No auth cookies after ${Math.round(timeoutMs / 1000)}s — url=${page.url().slice(0, 90)} body="${body}"`
  );
  return { ok: false, block: null };
}

/** EN + AR: "Password sign-in isn't available. Try another method." */
const PASSWORD_SIGNIN_BLOCKED_RE =
  /password sign-in isn.?t available|sign-in isn.?t available\.?\s*try another method|تسجيل الدخول باستخدام كلمة المرور غير متوف|كلمة المرور غير متوف|جر.?ب طريقة أخرى/i;

function detectPostPasswordBlockFromText(bodyText = '') {
  const body = String(bodyText || '');
  if (PASSWORD_SIGNIN_BLOCKED_RE.test(body)) {
    return 'Microsoft blocked password sign-in on this IP ("Password sign-in isn\'t available"). Rotate IP / retry.';
  }
  if (
    /^too many requests$/i.test(body.trim()) ||
    /\btoo many requests\b/i.test(body) ||
    /طلبات كثيرة جدا|عدد الطلبات كبير/i.test(body)
  ) {
    return 'Microsoft rate-limited this IP after password (Too Many Requests). Rotate to a settled IP and retry.';
  }
  return null;
}

/** Machine-readable soft-block for proxy rotate-on-fail. */
function softBlockCodeFromText(bodyText = '', blockMsg = null) {
  const body = String(bodyText || '');
  const msg = String(blockMsg || '');
  if (PASSWORD_SIGNIN_BLOCKED_RE.test(body) || /Password sign-in isn.?t available/i.test(msg)) {
    return 'PASSWORD_BLOCKED';
  }
  if (
    /\btoo many requests\b/i.test(body) ||
    /Too Many Requests/i.test(msg) ||
    /طلبات كثيرة جدا|عدد الطلبات كبير/i.test(body)
  ) {
    return 'RATE_LIMITED';
  }
  if (msg && /Rotate IP/i.test(msg)) return 'IP_SOFT_BLOCK';
  return null;
}

async function detectPostPasswordBlock(page) {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return detectPostPasswordBlockFromText(bodyText);
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
  const blocked = detectPostPasswordBlockFromText(bodyText);
  if (blocked) return blocked;
  const patterns = [
    /incorrect password/i,
    /account doesn't exist/i,
    /account is locked/i,
    /too many attempts/i,
    /too many requests/i,
    /verify your identity/i,
  ];
  for (const p of patterns) {
    const m = bodyText.match(p);
    if (m) return m[0];
  }
  return null;
}

async function captureScreenshot(page, jobId, tag, engine) {
  if (engine === 'obscura' || isProxyEnabled()) return null;
  const file = path.join(SCREENSHOTS_DIR, `${jobId}-${tag}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

export { TARGETS };
