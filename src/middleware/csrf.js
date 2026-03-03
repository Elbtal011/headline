const crypto = require('crypto');

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.adminUser = req.session.adminUser || null;
  res.locals.user = req.session.user || null;
  next();
}

function validateCsrf(req, res, next) {
  const token = String(req.body?._csrf || req.get('x-csrf-token') || req.query?._csrf || '').trim();
  const expected = String(req.session?.csrfToken || '').trim();
  if (!token || !expected || token !== expected) {
    return res.status(403).send('Ungültiger CSRF Token. Bitte Seite neu laden.');
  }
  return next();
}

module.exports = { ensureCsrfToken, validateCsrf };
