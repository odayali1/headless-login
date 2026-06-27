const API_KEY = process.env.API_KEY?.trim() || '';

export function isApiKeyConfigured() {
  return API_KEY.length >= 16;
}

export function requireApiKey(req, res, next) {
  if (!isApiKeyConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'API_KEY is not configured on the server (min 16 characters).',
    });
  }

  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const keyHeader = String(req.headers['x-api-key'] || '').trim();
  const provided = bearer || keyHeader;

  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing API key.' });
  }

  next();
}
