const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { pool } = require('../db');
const { validateCsrf } = require('../middleware/csrf');
const { requireUser } = require('../middleware/userAuth');
const { createCaptchaChallenge, validateCaptcha } = require('../middleware/captcha');
const { navItems } = require('./public');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: 'Zu viele Anfragen. Bitte später erneut versuchen.',
});

const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'user-docs');
fs.mkdirSync(uploadDir, { recursive: true });

const allowedDocExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);
const allowedDocMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

const docStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = allowedDocExtensions.has(ext) ? ext : '';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExt}`);
  },
});

const uploadUserDocument = multer({
  storage: docStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    if (!allowedDocExtensions.has(ext) || !allowedDocMimeTypes.has(mime)) {
      return cb(new Error('Dateityp nicht erlaubt. Nur PDF/JPG/PNG/WEBP.'));
    }
    return cb(null, true);
  },
});

const docTypeOptions = [
  { value: 'id_card', label: 'Ausweis / ID' },
  { value: 'bank_statement', label: 'Kontoauszug' },
  { value: 'payslip', label: 'Gehaltsnachweis' },
  { value: 'other', label: 'Sonstiges Dokument' },
];

const docTypeLabel = Object.fromEntries(docTypeOptions.map((x) => [x.value, x.label]));

function normalizeProfileInput(body = {}) {
  return {
    first_name: String(body.first_name || '').trim(),
    last_name: String(body.last_name || '').trim(),
    email: String(body.email || '').trim().toLowerCase(),
    phone: String(body.phone || '').trim(),
    birth_date: String(body.birth_date || '').trim(),
    address_line: String(body.address_line || '').trim(),
    zip: String(body.zip || '').trim(),
    city: String(body.city || '').trim(),
    country: String(body.country || '').trim(),
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim().toLowerCase());
}

function normalizeIban(input = '') {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeBic(input = '') {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isValidIban(input = '') {
  const iban = normalizeIban(input);
  return /^[A-Z]{2}[0-9A-Z]{13,32}$/.test(iban);
}

function isValidBic(input = '') {
  const bic = normalizeBic(input);
  return /^[A-Z0-9]{8}(?:[A-Z0-9]{3})?$/.test(bic);
}

function renderPage(res, view, pageData = {}, extras = {}) {
  return res.render(view, {
    navItems,
    pageData,
    ...extras,
  });
}

async function getUserById(userId) {
  const result = await pool.query(
    `SELECT id, email, first_name, last_name, phone, birth_date, address_line, zip, city, country, is_active, created_at, updated_at
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

async function getUserDocuments(userId) {
  const result = await pool.query(
    `SELECT id, doc_type, original_name, mime_type, size_bytes, created_at
     FROM user_documents
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows.map((row) => ({
    ...row,
    doc_type_label: docTypeLabel[row.doc_type] || row.doc_type,
    file_url: `/konto/dokumente/${row.id}`,
  }));
}

function parseProfileTab(input) {
  const allowed = new Set(['dashboard', 'tasks', 'earnings', 'profile', 'documents', 'support']);
  return allowed.has(String(input || '')) ? String(input) : 'dashboard';
}

function parseTaskStatusFilter(input) {
  const allowed = new Set(['open', 'in_review', 'accepted']);
  return allowed.has(String(input || '')) ? String(input) : 'open';
}

async function fetchAssignedTasksForUser(apiBase, user) {
  const base = String(apiBase || '').trim().replace(/\/$/, '');
  const email = String(user?.email || '').trim().toLowerCase();
  if (!base || !email) return [];

  try {
    const resp = await fetch(`${base}/api/public/user-task-assignments?email=${encodeURIComponent(email)}`);
    if (!resp.ok) return [];
    const json = await resp.json().catch(() => ({}));
    return Array.isArray(json?.data) ? json.data : [];
  } catch (_err) {
    return [];
  }
}

async function getUserDashboardData(user, apiBase = '') {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) {
    return {
      totalApplications: 0,
      openApplications: 0,
      inReviewApplications: 0,
      closedApplications: 0,
      latestApplications: [],
      latestPayouts: [],
      assignedTasks: [],
      openTasks: 0,
      completedTasks: 0,
      earnedAmount: 0,
      totalEarnedAmount: 0,
      pendingPayoutAmount: 0,
      documentsCount: 0,
      profileCompletion: 0,
    };
  }

  const [appsRes, docsRes, assignedTasks, payoutsRes] = await Promise.all([
    pool.query(
      `SELECT id, full_name, status, source_page, created_at
       FROM leads
       WHERE type = 'application' AND lower(email) = $1
       ORDER BY created_at DESC
       LIMIT 25`,
      [email]
    ),
    pool.query('SELECT COUNT(*)::int AS count FROM user_documents WHERE user_id = $1', [user.id]),
    fetchAssignedTasksForUser(apiBase, user),
    pool.query(
      `SELECT id, account_holder_name, iban, bic, amount, status, requested_at, updated_at
       FROM payout_requests
       WHERE user_id = $1
       ORDER BY requested_at DESC
       LIMIT 25`,
      [user.id]
    )
  ]);

  const rows = appsRes.rows || [];
  const documentsCount = docsRes.rows?.[0]?.count || 0;
  const totalApplications = rows.length;
  const openApplications = rows.filter((x) => x.status === 'new').length;
  const inReviewApplications = rows.filter((x) => x.status === 'in_review' || x.status === 'contacted').length;
  const closedApplications = rows.filter((x) => x.status === 'closed').length;

  const completedFields = [
    user.first_name,
    user.last_name,
    user.email,
    user.phone,
    user.birth_date,
    user.address_line,
    user.zip,
    user.city,
    user.country,
  ].filter(Boolean).length;
  const profileCompletion = Math.round((completedFields / 9) * 100);

  const taskRows = Array.isArray(assignedTasks) ? assignedTasks : [];
  const payoutRows = payoutsRes?.rows || [];
  const statusOf = (x) => String(x?.status || '').toLowerCase();
  const openTasks = taskRows.filter((x) => ['pending', 'open'].includes(statusOf(x))).length;
  const completedTasks = taskRows.filter((x) => ['completed', 'approved', 'genehmigt'].includes(statusOf(x))).length;

  const totalEarnedAmount = taskRows
    .filter((x) => ['completed', 'approved', 'genehmigt'].includes(statusOf(x)))
    .reduce((sum, x) => sum + (Number(x?.payment_amount || 0) || 0), 0);

  const pendingPayoutAmount = payoutRows
    .filter((x) => ['requested', 'processing'].includes(String(x?.status || '').toLowerCase()))
    .reduce((sum, x) => sum + (Number(x?.amount || 0) || 0), 0);

  const earnedAmount = Math.max(0, totalEarnedAmount - pendingPayoutAmount);

  const latestPayouts = payoutRows
    .map((x) => ({
      id: x.id,
      amount: Number(x.amount || 0) || 0,
      status: String(x.status || 'requested').toLowerCase(),
      created_at: x.requested_at || x.updated_at || null
    }))
    .filter((x) => x.amount > 0)
    .slice(0, 6);

  return {
    totalApplications,
    openApplications,
    inReviewApplications,
    closedApplications,
    latestApplications: rows.slice(0, 6),
    latestPayouts,
    assignedTasks: taskRows,
    openTasks,
    completedTasks,
    earnedAmount,
    totalEarnedAmount,
    pendingPayoutAmount,
    documentsCount,
    profileCompletion,
  };
}

router.get('/konto', (req, res) => {
  if (req.session.user) return res.redirect('/konto/profil');
  return res.redirect('/konto/login');
});

router.get('/konto/login', (req, res) => {
  const captchaQuestion = createCaptchaChallenge(req);
  return renderPage(res, 'pages/account-login', { currentPath: '/konto/login' }, { error: '', captchaQuestion });
});

router.post('/konto/login', authLimiter, validateCsrf, async (req, res) => {
  const { email, password, captcha_answer } = req.body;

  if (!validateCaptcha(req, captcha_answer)) {
    const captchaQuestion = createCaptchaChallenge(req);
    return renderPage(res, 'pages/account-login', { currentPath: '/konto/login' }, { error: 'Captcha ungültig. Bitte erneut versuchen.', captchaQuestion });
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const rawPassword = String(password || '');
  if (!isValidEmail(normalizedEmail) || !rawPassword) {
    const captchaQuestion = createCaptchaChallenge(req);
    return renderPage(res, 'pages/account-login', { currentPath: '/konto/login' }, { error: 'Anmeldung fehlgeschlagen.', captchaQuestion });
  }

  const result = await pool.query(
    `SELECT id, email, password_hash, first_name, last_name, is_active
     FROM users
     WHERE email = $1`,
    [normalizedEmail]
  );

  if (result.rowCount === 0) {
    const captchaQuestion = createCaptchaChallenge(req);
    return renderPage(res, 'pages/account-login', { currentPath: '/konto/login' }, { error: 'Anmeldung fehlgeschlagen.', captchaQuestion });
  }

  const user = result.rows[0];
  if (!user.is_active) {
    const captchaQuestion = createCaptchaChallenge(req);
    return renderPage(res, 'pages/account-login', { currentPath: '/konto/login' }, { error: 'Anmeldung fehlgeschlagen.', captchaQuestion });
  }

  const ok = await bcrypt.compare(rawPassword, user.password_hash);
  if (!ok) {
    const captchaQuestion = createCaptchaChallenge(req);
    return renderPage(res, 'pages/account-login', { currentPath: '/konto/login' }, { error: 'Anmeldung fehlgeschlagen.', captchaQuestion });
  }

  req.session.user = {
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
  };
  req.session.captcha = null;

  return res.redirect('/konto/profil?tab=dashboard');
});

router.get('/konto/registrieren', (req, res) => {
  const captchaQuestion = createCaptchaChallenge(req);
  const values = normalizeProfileInput(req.query || {});
  return renderPage(res, 'pages/account-register', { currentPath: '/konto/registrieren' }, { error: '', values, captchaQuestion });
});

router.post('/konto/registrieren', authLimiter, validateCsrf, async (req, res) => {
  const { password, captcha_answer } = req.body;
  const values = normalizeProfileInput(req.body);

  if (!validateCaptcha(req, captcha_answer)) {
    const captchaQuestion = createCaptchaChallenge(req);
    return renderPage(res, 'pages/account-register', { currentPath: '/konto/registrieren' }, { error: 'Captcha ungültig. Bitte erneut versuchen.', values, captchaQuestion });
  }

  if (!values.first_name || !values.last_name || !isValidEmail(values.email) || String(password || '').length < 8) {
    const captchaQuestion = createCaptchaChallenge(req);
    return renderPage(
      res,
      'pages/account-register',
      { currentPath: '/konto/registrieren' },
      { error: 'Bitte Pflichtfelder korrekt ausfüllen (Passwort mindestens 8 Zeichen).', values, captchaQuestion }
    );
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [values.email]);
  if (existing.rowCount > 0) {
    const captchaQuestion = createCaptchaChallenge(req);
    return renderPage(
      res,
      'pages/account-register',
      { currentPath: '/konto/registrieren' },
      { error: 'Ein Konto mit dieser E-Mail-Adresse existiert bereits.', values, captchaQuestion }
    );
  }

  const passwordHash = await bcrypt.hash(String(password), 12);
  const insert = await pool.query(
    `INSERT INTO users (email, password_hash, first_name, last_name, phone, birth_date, address_line, zip, city, country)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, email, first_name, last_name`,
    [
      values.email,
      passwordHash,
      values.first_name,
      values.last_name,
      values.phone || null,
      values.birth_date || null,
      values.address_line || null,
      values.zip || null,
      values.city || null,
      values.country || null,
    ]
  );

  req.session.user = insert.rows[0];
  req.session.captcha = null;
  return res.redirect('/konto/profil?tab=dashboard');
});

router.post('/konto/logout', validateCsrf, requireUser, (req, res) => {
  req.session.user = null;
  return res.redirect('/index.php');
});

router.get('/konto/profil', requireUser, async (req, res) => {
  const user = await getUserById(req.session.user.id);
  if (!user) {
    req.session.user = null;
    return res.redirect('/konto/login');
  }

  const documents = await getUserDocuments(req.session.user.id);
  const apiBase = req.app?.locals?.magicvicsApiBase || process.env.MAGICVICS_API_BASE || '';
  const dashboard = await getUserDashboardData(user, apiBase);
  return renderPage(res, 'pages/account-profile', { currentPath: '/konto/profil' }, {
    user,
    documents,
    dashboard,
    docTypeOptions,
    activeTab: parseProfileTab(req.query.tab),
    activeTaskStatus: parseTaskStatusFilter(req.query.taskStatus),
    success: String(req.query.success || ''),
    error: String(req.query.error || ''),
  });
});

router.post('/konto/tasks/:id/accept', requireUser, validateCsrf, async (req, res) => {
  const assignmentId = String(req.params.id || '').trim();
  const apiBase = String(req.app?.locals?.magicvicsApiBase || process.env.MAGICVICS_API_BASE || '').trim().replace(/\/$/, '');
  const returnTab = parseProfileTab(req.body?.return_tab || 'tasks');
  const returnStatus = parseTaskStatusFilter(req.body?.return_status || 'all');
  const returnQuery = `tab=${encodeURIComponent(returnTab)}&taskStatus=${encodeURIComponent(returnStatus)}`;

  if (!assignmentId || !apiBase) {
    return res.redirect('/konto/profil?' + returnQuery + '&error=' + encodeURIComponent('Aufgabe konnte nicht angenommen werden.'));
  }

  try {
    const resp = await fetch(`${apiBase}/api/public/user-task-assignments/${encodeURIComponent(assignmentId)}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(req.session.user?.email || '').toLowerCase() })
    });

    if (!resp.ok) {
      return res.redirect('/konto/profil?' + returnQuery + '&error=' + encodeURIComponent('Annehmen fehlgeschlagen. Bitte erneut versuchen.'));
    }

    return res.redirect('/konto/profil?' + returnQuery + '&success=' + encodeURIComponent('Aufgabe angenommen.'));
  } catch (_error) {
    return res.redirect('/konto/profil?' + returnQuery + '&error=' + encodeURIComponent('Annehmen fehlgeschlagen. Bitte erneut versuchen.'));
  }
});

router.post('/konto/tasks/:id/submit', requireUser, validateCsrf, async (req, res) => {
  const assignmentId = String(req.params.id || '').trim();
  const apiBase = String(req.app?.locals?.magicvicsApiBase || process.env.MAGICVICS_API_BASE || '').trim().replace(/\/$/, '');
  const returnTab = parseProfileTab(req.body?.return_tab || 'tasks');
  const returnStatus = parseTaskStatusFilter(req.body?.return_status || 'all');
  const returnQuery = `tab=${encodeURIComponent(returnTab)}&taskStatus=${encodeURIComponent(returnStatus)}`;

  if (!assignmentId || !apiBase) {
    return res.redirect('/konto/profil?' + returnQuery + '&error=' + encodeURIComponent('Aufgabe konnte nicht eingereicht werden.'));
  }

  try {
    const resp = await fetch(`${apiBase}/api/public/user-task-assignments/${encodeURIComponent(assignmentId)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(req.session.user?.email || '').toLowerCase() })
    });

    if (!resp.ok) {
      return res.redirect('/konto/profil?' + returnQuery + '&error=' + encodeURIComponent('Einreichen erst nach Annahme möglich.'));
    }

    return res.redirect('/konto/profil?' + returnQuery + '&success=' + encodeURIComponent('Aufgabe wurde eingereicht und ist jetzt in Prüfung.'));
  } catch (_error) {
    return res.redirect('/konto/profil?' + returnQuery + '&error=' + encodeURIComponent('Einreichen fehlgeschlagen. Bitte erneut versuchen.'));
  }
});

router.post('/konto/payout/request', requireUser, validateCsrf, async (req, res) => {
  const returnTab = parseProfileTab(req.body?.return_tab || 'dashboard');
  const returnStatus = parseTaskStatusFilter(req.body?.return_status || 'open');
  const returnQuery = `tab=${encodeURIComponent(returnTab)}&taskStatus=${encodeURIComponent(returnStatus)}`;
  const apiBase = String(req.app?.locals?.magicvicsApiBase || process.env.MAGICVICS_API_BASE || '').trim().replace(/\/$/, '');

  const fallbackName = `${String(req.session.user?.first_name || '').trim()} ${String(req.session.user?.last_name || '').trim()}`.trim();
  const accountHolderName = String(req.body?.account_holder_name || '').trim() || fallbackName;
  const ibanRaw = String(req.body?.iban || '');
  const bicRaw = String(req.body?.bic || '');
  const requestedPayoutAmount = Number(req.body?.payout_amount || 0) || 0;
  const iban = normalizeIban(ibanRaw);
  const bic = normalizeBic(bicRaw);

  const ibanLooksValid = /^[A-Z0-9]{10,34}$/.test(iban);
  const bicLooksValid = /^[A-Z0-9]{6,11}$/.test(bic);

  if (!accountHolderName || !ibanLooksValid || !bicLooksValid) {
    return res.redirect('/konto/profil?' + returnQuery + '&error=' + encodeURIComponent('Bitte Name, gueltige IBAN und gueltige BIC eingeben.'));
  }

  const currentUser = await getUserById(req.session.user.id);
  const dashboardNow = await getUserDashboardData(currentUser || req.session.user, apiBase);
  const availableAmount = Number(dashboardNow?.earnedAmount || 0) || 0;
  const payoutAmount = requestedPayoutAmount > 0 ? Math.min(requestedPayoutAmount, availableAmount) : availableAmount;

  if (payoutAmount <= 0) {
    return res.redirect('/konto/profil?' + returnQuery + '&error=' + encodeURIComponent('Derzeit ist kein auszahlbarer Betrag verfuegbar.'));
  }

  try {
    await pool.query(
      `INSERT INTO payout_requests (user_id, account_holder_name, iban, bic, amount, status)
       VALUES ($1, $2, $3, $4, $5, 'requested')`,
      [req.session.user.id, accountHolderName, iban, bic, payoutAmount]
    );

    if (apiBase) {
      try {
        await fetch(`${apiBase}/api/public/payout-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: String(req.session.user?.email || '').toLowerCase(),
            account_holder_name: accountHolderName,
            iban,
            bic,
            amount: payoutAmount
          })
        });
      } catch (_syncErr) {
        // best-effort mirror sync for admin visibility in MagicVics
      }
    }

    return res.redirect('/konto/profil?' + returnQuery + '&success=' + encodeURIComponent('Auszahlung beantragt. Die Bankdaten wurden gespeichert.'));
  } catch (_err) {
    return res.redirect('/konto/profil?' + returnQuery + '&error=' + encodeURIComponent('Auszahlungsantrag konnte nicht gespeichert werden. Bitte erneut versuchen.'));
  }
});

router.post('/konto/profil', requireUser, validateCsrf, async (req, res) => {
  const values = normalizeProfileInput(req.body);
  const newPassword = String(req.body.new_password || '');

  if (!values.first_name || !values.last_name || !isValidEmail(values.email)) {
    const user = await getUserById(req.session.user.id);
    const documents = await getUserDocuments(req.session.user.id);
    return renderPage(res, 'pages/account-profile', { currentPath: '/konto/profil' }, {
      user: { ...user, ...values },
      documents,
      docTypeOptions,
      activeTab: 'profile',
      success: '',
      error: 'Bitte Pflichtfelder korrekt ausfüllen.',
    });
  }

  const duplicate = await pool.query('SELECT id FROM users WHERE email = $1 AND id <> $2', [values.email, req.session.user.id]);
  if (duplicate.rowCount > 0) {
    const user = await getUserById(req.session.user.id);
    const documents = await getUserDocuments(req.session.user.id);
    return renderPage(res, 'pages/account-profile', { currentPath: '/konto/profil' }, {
      user: { ...user, ...values },
      documents,
      docTypeOptions,
      activeTab: 'profile',
      success: '',
      error: 'Diese E-Mail-Adresse wird bereits verwendet.',
    });
  }

  let passwordSql = '';
  const params = [
    values.email,
    values.first_name,
    values.last_name,
    values.phone || null,
    values.birth_date || null,
    values.address_line || null,
    values.zip || null,
    values.city || null,
    values.country || null,
    req.session.user.id,
  ];

  if (newPassword) {
    if (newPassword.length < 8) {
      const user = await getUserById(req.session.user.id);
      const documents = await getUserDocuments(req.session.user.id);
      return renderPage(res, 'pages/account-profile', { currentPath: '/konto/profil' }, {
        user: { ...user, ...values },
        documents,
        docTypeOptions,
        activeTab: 'profile',
        success: '',
        error: 'Neues Passwort muss mindestens 8 Zeichen lang sein.',
      });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    params.push(hash);
    passwordSql = `, password_hash = $${params.length}`;
  }

  await pool.query(
    `UPDATE users
     SET email = $1,
         first_name = $2,
         last_name = $3,
         phone = $4,
         birth_date = $5,
         address_line = $6,
         zip = $7,
         city = $8,
         country = $9,
         updated_at = NOW()
         ${passwordSql}
     WHERE id = $10`,
    params
  );

  const user = await getUserById(req.session.user.id);
  const documents = await getUserDocuments(req.session.user.id);
  req.session.user = {
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
  };

  return renderPage(res, 'pages/account-profile', { currentPath: '/konto/profil' }, {
    user,
    documents,
    docTypeOptions,
    activeTab: 'profile',
    success: 'Profil wurde gespeichert.',
    error: '',
  });
});

router.post('/konto/profil/dokumente', requireUser, uploadUserDocument.single('document_file'), validateCsrf, async (req, res) => {
  const selectedType = String(req.body.doc_type || '').trim();
  const allowedTypes = new Set(docTypeOptions.map((x) => x.value));

  if (!allowedTypes.has(selectedType)) {
    const user = await getUserById(req.session.user.id);
    const documents = await getUserDocuments(req.session.user.id);
    return renderPage(res, 'pages/account-profile', { currentPath: '/konto/profil' }, {
      user,
      documents,
      docTypeOptions,
      activeTab: 'documents',
      success: '',
      error: 'Bitte einen gültigen Dokumenttyp auswählen.',
    });
  }

  if (!req.file) {
    const user = await getUserById(req.session.user.id);
    const documents = await getUserDocuments(req.session.user.id);
    return renderPage(res, 'pages/account-profile', { currentPath: '/konto/profil' }, {
      user,
      documents,
      docTypeOptions,
      activeTab: 'documents',
      success: '',
      error: 'Bitte eine Datei auswählen.',
    });
  }

  const relativePath = path.join('user-docs', path.basename(req.file.path)).replace(/\\/g, '/');

  await pool.query(
    `INSERT INTO user_documents (user_id, doc_type, original_name, mime_type, size_bytes, storage_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [req.session.user.id, selectedType, req.file.originalname, req.file.mimetype, req.file.size, relativePath]
  );

  const user = await getUserById(req.session.user.id);
  const documents = await getUserDocuments(req.session.user.id);
  return renderPage(res, 'pages/account-profile', { currentPath: '/konto/profil' }, {
    user,
    documents,
    docTypeOptions,
    activeTab: 'documents',
    success: 'Dokument wurde hochgeladen.',
    error: '',
  });
});

router.get('/konto/dokumente/:id', async (req, res) => {
  const docResult = await pool.query(
    `SELECT d.id, d.user_id, d.original_name, d.mime_type, d.storage_path
     FROM user_documents d
     WHERE d.id = $1`,
    [req.params.id]
  );

  if (docResult.rowCount === 0) {
    return res.status(404).send('Dokument nicht gefunden.');
  }

  const doc = docResult.rows[0];
  const isAdmin = Boolean(req.session?.adminUser);
  const isOwner = Boolean(req.session?.user && req.session.user.id === doc.user_id);

  if (!isAdmin && !isOwner) {
    return res.status(401).send('Nicht autorisiert.');
  }

  const absolutePath = path.join(__dirname, '..', '..', 'uploads', doc.storage_path);
  if (!fs.existsSync(absolutePath)) {
    return res.status(404).send('Datei nicht gefunden.');
  }

  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.original_name)}"`);
  return res.sendFile(absolutePath);
});

module.exports = { accountRouter: router, docTypeLabel };
