/**
 * Camoufox/Playwright can throw ProtocolError(type=closed) on Page.dispatchMouseEvent
 * after the page closes. Without guards, Node exits and Coolify restarts — wiping in-memory jobs.
 *
 * Import this first from server.js so handlers are registered before any browser work.
 */

function isBenignBrowserCrash(err) {
  if (!err) return false;
  if (err.type === 'closed') return true;
  if (err.name === 'ProtocolError') return true;
  if (typeof err.method === 'string' && /^(Page|Runtime|Browser|Target|Input)\./.test(err.method)) {
    return true;
  }
  const blob = `${err.message || ''}\n${err.stack || ''}\n${err}`;
  return /ProtocolError|Protocol error|Target closed|browser has been closed|Connection closed|Session closed|Page\.dispatchMouseEvent|ffConnection\.js|ffInput\.js|playwright-core/i.test(
    blob
  );
}

function logKeepAlive(kind, err) {
  const detail = err?.method
    ? `${err.name || 'Error'} type=${err.type || '?'} method=${err.method}`
    : err?.stack || err?.message || String(err);
  console.error(`[process] Ignored ${kind} (keep jobs alive):`, detail);
}

process.on('unhandledRejection', (reason) => {
  if (isBenignBrowserCrash(reason)) {
    logKeepAlive('closed-browser rejection', reason);
    return;
  }
  console.error('[process] unhandledRejection:', reason?.stack || reason);
});

process.on('uncaughtException', (err) => {
  if (isBenignBrowserCrash(err)) {
    logKeepAlive('closed-browser exception', err);
    return;
  }
  console.error('[process] uncaughtException:', err?.stack || err);
  process.exit(1);
});

// Always observe (does not prevent default); helps confirm guards are loaded in Coolify logs.
process.on('uncaughtExceptionMonitor', (err) => {
  if (isBenignBrowserCrash(err)) {
    console.error('[process] Monitor: benign browser crash — process will stay up');
  }
});

console.log('[process] Crash guards active (ProtocolError/closed browser will not kill Node)');

export { isBenignBrowserCrash };
