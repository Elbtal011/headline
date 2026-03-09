const crypto = require('crypto');

function parseCookieToken(req) {
  const raw = String(req.headers?.cookie || '');
  if (!raw) return '';
  const parts = raw.split(';').map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith('ha.csrf=')) {
      return decodeURIComponent(part.slice('ha.csrf='.length));
    }
  }
  return '';
}

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  const token = req.session.csrfToken;
  res.locals.csrfToken = token;
  res.locals.adminUser = req.session.adminUser || null;
  res.locals.user = req.session.user || null;

  // Double-submit cookie fallback for multi-instance/session drift behind proxy/load balancer.
  res.cookie('ha.csrf', token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: req.secure || String(process.env.NODE_ENV) === 'production',
    path: '/',
    maxAge: 1000 * 60 * 60 * 8,
  });

  next();
}

function validateCsrf(req, res, next) {
  const token = String(req.body?._csrf || req.get('x-csrf-token') || req.query?._csrf || '').trim();
  const expectedSession = String(req.session?.csrfToken || '').trim();
  const expectedCookie = String(parseCookieToken(req) || '').trim();
  const valid = !!token && ((expectedSession && token === expectedSession) || (expectedCookie && token === expectedCookie));

  if (!valid) {
    return res.status(403).send('Ungültiger CSRF Token. Bitte Seite neu laden.');
  }
  return next();
}

module.exports = { ensureCsrfToken, validateCsrf };
