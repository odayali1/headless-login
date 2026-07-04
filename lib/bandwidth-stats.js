/** Running totals of proxied browser traffic (estimated from response bodies). */

const stats = {
  bytesIn: 0,
  bytesOut: 0,
  requests: 0,
  blocked: 0,
  since: new Date().toISOString(),
};

export function recordBandwidth(bytesIn = 0, bytesOut = 0) {
  stats.bytesIn += bytesIn;
  stats.bytesOut += bytesOut;
  stats.requests += 1;
}

export function recordBlockedRequest() {
  stats.blocked += 1;
}

export function getBandwidthStats() {
  const total = stats.bytesIn + stats.bytesOut;
  return {
    ...stats,
    mbIn: +(stats.bytesIn / 1024 / 1024).toFixed(2),
    mbOut: +(stats.bytesOut / 1024 / 1024).toFixed(2),
    mbTotal: +(total / 1024 / 1024).toFixed(2),
  };
}

export function resetBandwidthStats() {
  stats.bytesIn = 0;
  stats.bytesOut = 0;
  stats.requests = 0;
  stats.blocked = 0;
  stats.since = new Date().toISOString();
}
