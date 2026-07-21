/** Session cookie checks (split to avoid circular imports with token-extract). */

/** Cookies that prove a real MSA sign-in (not ANON/NAP marketing crumbs). */
const STRONG_AUTH_COOKIE_NAMES = [
  'ESTSAUTH',
  'ESTSAUTHPERSISTENT',
  'MSPAuth',
  '__Host-MSAAUTH',
];

export function hasValidSession(state) {
  if (!state?.cookies?.length) return false;
  const names = new Set(state.cookies.map((c) => c.name));
  const hasAuth = STRONG_AUTH_COOKIE_NAMES.some((n) => names.has(n));
  if (!hasAuth) return false;
  const now = Date.now() / 1000;
  const sessionCookies = state.cookies.filter((c) => STRONG_AUTH_COOKIE_NAMES.includes(c.name));
  return sessionCookies.some((c) => !c.expires || c.expires === -1 || c.expires > now);
}
