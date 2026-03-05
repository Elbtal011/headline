require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const { ensureCsrfToken } = require('./middleware/csrf');
const { publicRouter } = require('./routes/public');

const legacyBackendEnabled = String(process.env.LEGACY_BACKEND_ENABLED || '0') === '1';
const accountEnabled = String(process.env.HEADLINE_ACCOUNT_ENABLED || '1') === '1';

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change_me')) {
  throw new Error('SESSION_SECRET must be set to a strong value in production.');
}

if (legacyBackendEnabled && isProd && (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD)) {
  throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be configured in production when LEGACY_BACKEND_ENABLED=1.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.locals.magicvicsChatUrl = process.env.MAGICVICS_CHAT_URL || 'https://magicvics-production.up.railway.app/support';
app.locals.magicvicsApiBase = process.env.MAGICVICS_API_BASE || 'https://backend-production-4c3c.up.railway.app';

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(compression());
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.json({ limit: '25mb' }));
app.use(
  session({
    name: 'ha.sid',
    secret: process.env.SESSION_SECRET || 'change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);
app.use(ensureCsrfToken);
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    etag: true,
    lastModified: true,
    maxAge: '7d',
  })
);
const staticUploadsDir = path.join(__dirname, '..', 'uploads');
const cwdUploadsDir = path.join(process.cwd(), 'uploads');
app.use('/uploads', express.static(staticUploadsDir));
if (cwdUploadsDir !== staticUploadsDir) {
  app.use('/uploads', express.static(cwdUploadsDir));
}

app.use((req, res, next) => {
  res.locals.query = req.query;
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/', publicRouter);

if (accountEnabled) {
  const { accountRouter } = require('./routes/account');
  app.use('/', accountRouter);
}

if (legacyBackendEnabled) {
  const { adminRouter } = require('./routes/admin');
  const { chatRouter } = require('./routes/chat');

  app.use('/api', chatRouter);
  app.use('/admin666', adminRouter);
  app.get('/admin', (_req, res) => {
    res.redirect('/admin666/login');
  });
}

app.use((req, res) => {
  res.status(404).render('pages/404', { pageData: { currentPath: req.path } });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send('Ein Fehler ist aufgetreten.');
});

async function start() {
  if (legacyBackendEnabled || accountEnabled) {
    const { initDb } = require('./initDb');
    await initDb();
    console.log(`[startup] legacy backend ${legacyBackendEnabled ? 'enabled' : 'disabled'} | account ${accountEnabled ? 'enabled' : 'disabled'}`);
  } else {
    console.log('[startup] legacy backend disabled (public-site mode), account disabled');
  }

  app.listen(PORT, () => {
    console.log(`Server läuft auf http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Startup fehlgeschlagen:', err);
  process.exit(1);
});
