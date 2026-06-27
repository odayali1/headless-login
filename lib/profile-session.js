/** Session cookie checks (split to avoid circular imports with token-extract). */

export function hasValidSession(state) {
  if (!state?.cookies?.length) return false;
  const names = new Set(state.cookies.map((c) => c.name));
  const authNames = [
    'ESTSAUTH', 'ESTSAUTHPERSISTENT', 'WLSSC', 'NAP', 'ANON',
    'MSPAuth', 'MSPProf', '__Host-MSAAUTH', 'ESTSAUTHLIGHT', 'JSHP', 'JSH',
  ];
  const hasAuth = authNames.some((n) => names.has(n));
  if (hasAuth) {
    const now = Date.now() / 1000;
    const sessionCookies = state.cookies.filter((c) => authNames.includes(c.name));
    if (sessionCookies.length === 0) return true;
    return sessionCookies.some((c) => !c.expires || c.expires === -1 || c.expires > now);
  }
  if (state.lastStatus === 'success' && state.lastLoginAt && state.cookies.length >= 5) {
    const age = Date.now() - new Date(state.lastLoginAt).getTime();
    if (age < 7 * 24 * 60 * 60 * 1000) {
      return state.cookies.some((c) => /live\.com|microsoftonline|outlook/i.test(c.domain));
    }
  }
  return false;
}
