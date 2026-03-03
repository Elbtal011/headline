const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { stringify } = require('csv-stringify/sync');
const { pool } = require('../db');
const { appState } = require('../state');
const { requireAdmin } = require('../middleware/auth');
const { validateCsrf } = require('../middleware/csrf');
const { getJobs, getJobBySlug, upsertJob, deleteJob } = require('../jobs');
const { docTypeLabel } = require('./account');

const router = express.Router();
const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'chat');
fs.mkdirSync(uploadDir, { recursive: true });
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: 'Zu viele Login-Versuche. Bitte später erneut versuchen.',
});

const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.doc', '.docx', '.txt']);
const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = allowedExtensions.has(ext) ? ext : '';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExt}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    if (!allowedExtensions.has(ext) || !allowedMimeTypes.has(mime)) {
      return cb(new Error('Dateityp nicht erlaubt.'));
    }
    return cb(null, true);
  },
});

const formFieldOrder = {
  application: ['name', 'email', 'password1', 'password2', 'address', 'zip', 'city', 'country', 'mobile', 'dob', 'source_page'],
  contact: ['name', 'email', 'phone', 'subject', 'message', 'source_page'],
};

function getOrderedFormEntries(type, payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const entries = Object.entries(payload);
  const order = formFieldOrder[type] || [];
  const used = new Set();
  const ordered = [];

  for (const key of order) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      ordered.push([key, payload[key]]);
      used.add(key);
    }
  }

  for (const [key, value] of entries) {
    if (!used.has(key)) {
      ordered.push([key, value]);
    }
  }

  return ordered;
}

function formatDateOnly(value) {
  if (!value) {
    return '-';
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const str = String(value);
  return str.length >= 10 ? str.slice(0, 10) : str;
}

function parseLinesFromTextarea(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function requireDb(_req, res, next) {
  if (!appState.dbAvailable) {
    return res.status(503).send('Datenbank aktuell nicht verfügbar. Admin-Funktionen sind deaktiviert.');
  }
  return next();
}

function parseSelectedIds(input) {
  const raw = Array.isArray(input) ? input : input ? [input] : [];
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return raw.map((v) => String(v).trim()).filter((v) => uuidRe.test(v));
}

async function fetchChatMessagesForAdmin(chatId) {
  const messagesResult = await pool.query(
    `SELECT id, sender_type, sender_label, message, created_at
     FROM chat_messages
     WHERE chat_id = $1
     ORDER BY created_at ASC`,
    [chatId]
  );

  const attachmentsResult = await pool.query(
    `SELECT id, chat_message_id, original_name, mime_type, size_bytes
     FROM chat_attachments
     WHERE chat_message_id IN (
       SELECT id FROM chat_messages WHERE chat_id = $1
     )
     ORDER BY created_at ASC`,
    [chatId]
  );

  const byMessage = new Map();
  for (const file of attachmentsResult.rows) {
    if (!byMessage.has(file.chat_message_id)) {
      byMessage.set(file.chat_message_id, []);
    }
    byMessage.get(file.chat_message_id).push({
      id: file.id,
      original_name: file.original_name,
      mime_type: file.mime_type,
      size_bytes: Number(file.size_bytes),
      file_url: `/api/chat/files/${file.id}`,
    });
  }

  return messagesResult.rows.map((message) => ({
    ...message,
    attachments: byMessage.get(message.id) || [],
  }));
}

router.get('/', (_req, res) => {
  return res.redirect('/admin666/login');
});

router.get('/login', (req, res) => {
  if (req.session.adminUser) {
    return res.redirect('/admin666/leads');
  }
  return res.render('admin/login', { submittedUsername: '', rememberLogin: true });
});

router.post('/login', adminLoginLimiter, validateCsrf, (req, res) => {
  const { username, password } = req.body;
  const rememberLogin = req.body.rememberLogin === '1';
  const adminUsername = String(process.env.ADMIN_USERNAME || '').trim();
  const adminPassword = String(process.env.ADMIN_PASSWORD || '');

  if (!adminUsername || !adminPassword) {
    return res.status(503).render('admin/login', {
      error: 'Admin Login ist nicht konfiguriert.',
      submittedUsername: (username || '').trim(),
      rememberLogin,
    });
  }

  if ((username || '').trim() !== adminUsername || (password || '') !== adminPassword) {
    return res.status(401).render('admin/login', {
      error: 'Ungültige Zugangsdaten.',
      submittedUsername: (username || '').trim(),
      rememberLogin,
    });
  }

  req.session.adminUser = {
    id: 'static-admin',
    username: adminUsername,
    role: 'admin',
  };
  req.session.cookie.maxAge = rememberLogin ? 1000 * 60 * 60 * 24 * 30 : 1000 * 60 * 60 * 8;

  return res.redirect('/admin666/leads');
});

router.post('/logout', requireAdmin, validateCsrf, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin666/login');
  });
});

async function renderLeadsList(req, res, fixedType = '') {
  const { type, status, source, q } = req.query;
  const effectiveType = fixedType || type || '';
  const where = [];
  const params = [];

  if (effectiveType) {
    params.push(effectiveType);
    where.push(`type = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (source) {
    params.push(source);
    where.push(`source_page = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length})`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const query = `SELECT id, type, full_name, email, phone, status, COALESCE(verification_level, 1) AS verification_level, source_page, created_at
                 FROM leads
                 ${whereSql}
                 ORDER BY created_at DESC`;

  const result = await pool.query(query, params);

  const section = fixedType || 'all';
  const sectionTitle = section === 'contact' ? 'Kontakt Leads' : section === 'application' ? 'Bewerbung Leads' : 'Lead Verwaltung';
  const listPath = section === 'contact' ? '/admin666/leads/contact' : section === 'application' ? '/admin666/leads/application' : '/admin666/leads';

  return res.render('admin/leads', {
    leads: result.rows,
    filters: { type: effectiveType, status: status || '', source: source || '', q: q || '' },
    section,
    sectionTitle,
    listPath,
  });
}

router.get('/leads', requireDb, requireAdmin, async (req, res) => {
  return renderLeadsList(req, res, '');
});

router.get('/leads/contact', requireDb, requireAdmin, async (req, res) => {
  return renderLeadsList(req, res, 'contact');
});

router.get('/leads/application', requireDb, requireAdmin, async (req, res) => {
  return renderLeadsList(req, res, 'application');
});

router.post('/leads/delete-selected', requireDb, requireAdmin, validateCsrf, async (req, res) => {
  const ids = parseSelectedIds(req.body.ids);
  if (ids.length > 0) {
    await pool.query('DELETE FROM leads WHERE id = ANY($1::uuid[])', [ids]);
  }
  return res.redirect(req.get('referer') || '/admin666/leads');
});

router.get('/leads/:id', requireDb, requireAdmin, async (req, res) => {
  const leadResult = await pool.query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
  if (leadResult.rowCount === 0) {
    return res.status(404).send('Lead nicht gefunden');
  }
  const lead = leadResult.rows[0];

  const notesResult = await pool.query(
    'SELECT id, note, created_by, created_at FROM lead_notes WHERE lead_id = $1 ORDER BY created_at DESC',
    [req.params.id]
  );

  return res.render('admin/lead-detail', {
    lead,
    notes: notesResult.rows,
    section: lead.type,
    backPath: lead.type === 'application' ? '/admin666/leads/application' : '/admin666/leads/contact',
    orderedFormEntries: getOrderedFormEntries(lead.type, lead.form_payload),
    birthDateDisplay: formatDateOnly(lead.birth_date),
  });
});

router.post('/leads/:id/status', requireDb, requireAdmin, validateCsrf, async (req, res) => {
  const allowed = ['new', 'contacted', 'in_review', 'closed'];
  const { status } = req.body;
  let verificationLevel = Number.parseInt(String(req.body.verification_level || ''), 10);

  if (!allowed.includes(status)) {
    return res.status(400).send('Ungültiger Status');
  }

  if (![1, 2, 3].includes(verificationLevel)) {
    const existing = await pool.query('SELECT COALESCE(verification_level, 1) AS verification_level FROM leads WHERE id = $1', [req.params.id]);
    if (existing.rowCount === 0) {
      return res.status(404).send('Lead nicht gefunden');
    }
    verificationLevel = Number(existing.rows[0].verification_level) || 1;
  }

  await pool.query('UPDATE leads SET status = $1, verification_level = $2, updated_at = NOW() WHERE id = $3', [
    status,
    verificationLevel,
    req.params.id,
  ]);
  return res.redirect(`/admin666/leads/${req.params.id}`);
});

router.post('/leads/:id/notes', requireDb, requireAdmin, validateCsrf, async (req, res) => {
  const { note } = req.body;
  if (!note || note.trim().length < 2) {
    return res.status(400).send('Notiz zu kurz');
  }

  await pool.query('INSERT INTO lead_notes (lead_id, note, created_by) VALUES ($1, $2, $3)', [
    req.params.id,
    note.trim(),
    req.session.adminUser.username,
  ]);

  return res.redirect(`/admin666/leads/${req.params.id}`);
});

router.get('/leads-export.csv', requireDb, requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT id, type, full_name, email, phone, message, birth_date, status, verification_level, source_page, created_at
     FROM leads
     ORDER BY created_at DESC`
  );

  const csv = stringify(result.rows, { header: true });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="admin-leads.csv"');
  res.send(csv);
});

router.get('/users', requireDb, requireAdmin, async (req, res) => {
  const { q, status } = req.query;
  const where = [];
  const params = [];

  if (q) {
    params.push(`%${q}%`);
    where.push(
      `(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`
    );
  }

  if (status === 'active') {
    where.push('is_active = TRUE');
  } else if (status === 'inactive') {
    where.push('is_active = FALSE');
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT u.id,
            u.first_name,
            u.last_name,
            u.email,
            u.phone,
            u.is_active,
            u.created_at,
            u.updated_at,
            COUNT(d.id)::int AS doc_count
     FROM users u
     LEFT JOIN user_documents d ON d.user_id = u.id
     ${whereSql}
     GROUP BY u.id
     ORDER BY u.created_at DESC`,
    params
  );

  return res.render('admin/users', {
    section: 'users',
    users: result.rows,
    filters: { q: q || '', status: status || '' },
  });
});

router.post('/users/delete-selected', requireDb, requireAdmin, validateCsrf, async (req, res) => {
  const ids = parseSelectedIds(req.body.ids);
  if (ids.length > 0) {
    const docsResult = await pool.query(
      `SELECT storage_path
       FROM user_documents
       WHERE user_id = ANY($1::uuid[])`,
      [ids]
    );

    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);

    for (const row of docsResult.rows) {
      if (!row.storage_path) continue;
      const absolutePath = path.join(__dirname, '..', '..', 'uploads', row.storage_path);
      try {
        if (fs.existsSync(absolutePath)) {
          fs.unlinkSync(absolutePath);
        }
      } catch (_err) {
        // Best-effort cleanup; DB rows are already removed.
      }
    }
  }
  return res.redirect('/admin666/users?deleted=1');
});

router.get('/users/delete-selected', requireAdmin, (_req, res) => {
  return res.redirect('/admin666/users');
});

router.get('/users/:id', requireDb, requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT id, first_name, last_name, email, phone, birth_date, address_line, zip, city, country, is_active, created_at, updated_at
     FROM users
     WHERE id = $1`,
    [req.params.id]
  );
  if (result.rowCount === 0) {
    return res.status(404).send('User nicht gefunden');
  }

  const docsResult = await pool.query(
    `SELECT id, doc_type, original_name, mime_type, size_bytes, created_at
     FROM user_documents
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [req.params.id]
  );

  const documents = docsResult.rows.map((doc) => ({
    ...doc,
    doc_type_label: docTypeLabel[doc.doc_type] || doc.doc_type,
    file_url: `/konto/dokumente/${doc.id}`,
  }));

  return res.render('admin/user-detail', {
    section: 'users',
    userDetail: result.rows[0],
    documents,
  });
});

router.get('/chats', requireDb, requireAdmin, async (req, res) => {
  const { status, q } = req.query;
  const where = [];
  const params = [];

  if (status) {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(c.visitor_name ILIKE $${params.length} OR c.visitor_email ILIKE $${params.length} OR c.visitor_phone ILIKE $${params.length})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT c.id,
            c.visitor_name,
            c.visitor_email,
            c.visitor_phone,
            c.source_page,
            c.status,
            c.last_message_at,
            c.updated_at,
            (
              SELECT m.message
              FROM chat_messages m
              WHERE m.chat_id = c.id
              ORDER BY m.created_at DESC
              LIMIT 1
            ) AS last_message
     FROM chats c
     ${whereSql}
     ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC`,
    params
  );

  return res.render('admin/chats', {
    chats: result.rows,
    filters: { status: status || '', q: q || '' },
    section: 'chats',
  });
});

router.get('/chats/:id', requireDb, requireAdmin, async (req, res) => {
  const chatResult = await pool.query(
    `SELECT id, visitor_name, visitor_email, visitor_phone, source_page, status, last_message_at, created_at
     FROM chats
     WHERE id = $1`,
    [req.params.id]
  );
  if (chatResult.rowCount === 0) {
    return res.status(404).send('Chat nicht gefunden');
  }

  const messages = await fetchChatMessagesForAdmin(req.params.id);
  return res.render('admin/chat-detail', {
    chat: chatResult.rows[0],
    messages,
    section: 'chats',
  });
});

router.get('/jobs', requireAdmin, async (req, res) => {
  const jobs = await getJobs();
  const success =
    req.query.ok === '1'
      ? 'Stelle wurde gespeichert.'
      : req.query.deleted === '1'
        ? 'Stelle wurde geloescht.'
        : req.query.bulkDeleted === '1'
          ? 'Ausgewaehlte Stellen wurden geloescht.'
          : '';
  const error = req.query.error === '1' ? 'Speichern fehlgeschlagen. Bitte erneut versuchen.' : '';
  return res.render('admin/jobs', {
    section: 'jobs',
    jobs,
    success,
    error,
  });
});

router.get('/jobs/new', requireAdmin, (_req, res) => {
  return res.render('admin/job-form', {
    section: 'jobs',
    isEdit: false,
    formAction: '/admin666/jobs',
    submitLabel: 'Stelle erstellen',
    title: '',
    slug: '',
    summary: '',
    tasks: '',
    profile: '',
    offer: '',
    date: '',
    salary: '',
    employment: '',
    experience: '',
    deadline: '',
  });
});

router.get('/jobs/:slug/edit', requireAdmin, async (req, res) => {
  const job = await getJobBySlug(req.params.slug);
  if (!job) {
    return res.status(404).send('Stelle nicht gefunden');
  }

  return res.render('admin/job-form', {
    section: 'jobs',
    isEdit: true,
    formAction: '/admin666/jobs',
    submitLabel: 'Aenderungen speichern',
    originalSlug: job.slug,
    title: job.title || '',
    slug: job.slug || '',
    summary: job.summary || '',
    tasks: (job.tasks || []).join('\n'),
    profile: (job.profile || []).join('\n'),
    offer: (job.offer || []).join('\n'),
    date: (job.facts && job.facts.date) || '',
    salary: (job.facts && job.facts.salary) || '',
    employment: (job.facts && job.facts.employment) || '',
    experience: (job.facts && job.facts.experience) || '',
    deadline: (job.facts && job.facts.deadline) || '',
  });
});

router.post('/jobs', requireAdmin, validateCsrf, async (req, res) => {
  try {
    await upsertJob(
      {
        slug: req.body.slug,
        title: req.body.title,
        summary: req.body.summary,
        tasks: parseLinesFromTextarea(req.body.tasks),
        profile: parseLinesFromTextarea(req.body.profile),
        offer: parseLinesFromTextarea(req.body.offer),
        facts: {
          date: req.body.date,
          salary: req.body.salary,
          employment: req.body.employment,
          experience: req.body.experience,
          deadline: req.body.deadline,
        },
      },
      req.body.original_slug
    );
    return res.redirect('/admin666/jobs?ok=1');
  } catch (_err) {
    return res.redirect('/admin666/jobs?error=1');
  }
});

router.post('/jobs/:slug/delete', requireAdmin, validateCsrf, async (req, res) => {
  await deleteJob(req.params.slug);
  return res.redirect('/admin666/jobs?deleted=1');
});

router.post('/jobs/delete-selected', requireAdmin, validateCsrf, async (req, res) => {
  const raw = Array.isArray(req.body.slugs) ? req.body.slugs : req.body.slugs ? [req.body.slugs] : [];
  for (const slug of raw) {
    if (slug && String(slug).trim()) {
      await deleteJob(String(slug).trim());
    }
  }
  return res.redirect('/admin666/jobs?bulkDeleted=1');
});

router.get('/job-facts', requireAdmin, (_req, res) => {
  return res.redirect('/admin666/jobs');
});

router.post('/chats/delete-selected', requireDb, requireAdmin, validateCsrf, async (req, res) => {
  const ids = parseSelectedIds(req.body.ids);
  if (ids.length > 0) {
    await pool.query('DELETE FROM chats WHERE id = ANY($1::uuid[])', [ids]);
  }
  return res.redirect(req.get('referer') || '/admin666/chats');
});

router.post('/chats/:id/status', requireDb, requireAdmin, validateCsrf, async (req, res) => {
  const allowed = ['open', 'pending', 'closed'];
  const status = (req.body.status || '').trim();
  if (!allowed.includes(status)) {
    return res.status(400).send('Ungültiger Status');
  }

  await pool.query('UPDATE chats SET status = $1, updated_at = NOW() WHERE id = $2', [status, req.params.id]);
  return res.redirect(`/admin666/chats/${req.params.id}`);
});

router.post('/chats/:id/messages', requireDb, requireAdmin, upload.array('files', 3), validateCsrf, async (req, res) => {
  const messageText = (req.body.message || '').trim();
  const files = req.files || [];
  if (!messageText && files.length === 0) {
    return res.status(400).send('Nachricht oder Datei erforderlich.');
  }

  const chatResult = await pool.query('SELECT id FROM chats WHERE id = $1', [req.params.id]);
  if (chatResult.rowCount === 0) {
    return res.status(404).send('Chat nicht gefunden');
  }

  const messageResult = await pool.query(
    `INSERT INTO chat_messages (chat_id, sender_type, sender_label, message)
     VALUES ($1, 'admin', $2, $3)
     RETURNING id`,
    [req.params.id, req.session.adminUser.username, messageText || null]
  );

  for (const file of files) {
    const relativePath = path.join('chat', path.basename(file.path)).replace(/\\/g, '/');
    await pool.query(
      `INSERT INTO chat_attachments (chat_message_id, original_name, mime_type, size_bytes, storage_path)
       VALUES ($1, $2, $3, $4, $5)`,
      [messageResult.rows[0].id, file.originalname, file.mimetype, file.size, relativePath]
    );
  }

  await pool.query(`UPDATE chats SET last_message_at = NOW(), updated_at = NOW(), status = 'pending' WHERE id = $1`, [
    req.params.id,
  ]);

  return res.redirect(`/admin666/chats/${req.params.id}`);
});

module.exports = { adminRouter: router };
