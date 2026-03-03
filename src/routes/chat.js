const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { pool } = require('../db');
const { appState } = require('../state');
const { validateCsrf } = require('../middleware/csrf');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const promptGreeting = 'Willkommen beim Kundenservice der Headline Agentur. Wie können wir Sie heute unterstützen?';
const promptAskName = 'Vielen Dank. Bitte nennen Sie uns Ihren Vor- und Nachnamen.';
const promptAskEmail = 'Danke. Bitte nennen Sie nun Ihre E-Mail-Adresse.';
const promptAskPhone = 'Danke. Bitte nennen Sie abschließend Ihre Telefonnummer.';
const promptInvalidEmail = 'Bitte geben Sie eine gueltige E-Mail-Adresse an.';
const promptInvalidPhone = 'Bitte geben Sie eine gueltige Telefonnummer an.';
const promptDone = 'Vielen Dank. Ein Ansprechpartner aus unserem Team wird sich in Kürze bei Ihnen melden.';

const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'chat');
fs.mkdirSync(uploadDir, { recursive: true });

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

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = allowedExtensions.has(ext) ? ext : '';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
  },
});

const upload = multer({
  storage,
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

const chatStartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  message: 'Zu viele Chat-Starts. Bitte spaeter erneut versuchen.',
});

const chatMessageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  message: 'Zu viele Chat-Nachrichten. Bitte spaeter erneut versuchen.',
});

function requireDb(_req, res, next) {
  if (!appState.dbAvailable) {
    return res.status(503).json({ error: 'Datenbank aktuell nicht verfuegbar.' });
  }
  return next();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getChatToken(req) {
  return req.get('x-chat-token') || req.body?.chat_token || req.query?.chat_token || '';
}

function removeUploadedFiles(files = []) {
  for (const file of files) {
    try {
      fs.unlinkSync(file.path);
    } catch (_err) {
      // no-op
    }
  }
}

function isValidEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(phone) {
  const value = String(phone || '').trim();
  if (!value) return false;
  const normalized = value.replace(/[^\d+]/g, '');
  const digitCount = normalized.replace(/[^\d]/g, '').length;
  return digitCount >= 6 && /^[+\d][\d\s\-()./]{5,}$/.test(value);
}

async function resolveVisitorChat(req, chatId) {
  const token = getChatToken(req);
  if (!token) return null;

  const result = await pool.query(
    'SELECT id, chat_token_hash, onboarding_step, visitor_name, visitor_email FROM chats WHERE id = $1',
    [chatId]
  );
  if (result.rowCount === 0) return null;

  const chat = result.rows[0];
  if (hashToken(token) !== chat.chat_token_hash) return null;

  return chat;
}

async function fetchMessages(chatId) {
  const messagesResult = await pool.query(
    `SELECT id, sender_type, sender_label, message, created_at
     FROM chat_messages
     WHERE chat_id = $1
     ORDER BY created_at ASC`,
    [chatId]
  );

  const attachmentsResult = await pool.query(
    `SELECT id, chat_message_id, original_name, mime_type, size_bytes, created_at
     FROM chat_attachments
     WHERE chat_message_id IN (
       SELECT id FROM chat_messages WHERE chat_id = $1
     )
     ORDER BY created_at ASC`,
    [chatId]
  );

  const byMessage = new Map();
  for (const row of attachmentsResult.rows) {
    if (!byMessage.has(row.chat_message_id)) byMessage.set(row.chat_message_id, []);
    byMessage.get(row.chat_message_id).push({
      id: row.id,
      original_name: row.original_name,
      mime_type: row.mime_type,
      size_bytes: Number(row.size_bytes),
      created_at: row.created_at,
      file_url: `/api/chat/files/${row.id}`,
    });
  }

  return messagesResult.rows.map((m) => ({ ...m, attachments: byMessage.get(m.id) || [] }));
}

router.post('/chat/start', requireDb, chatStartLimiter, validateCsrf, async (req, res) => {
  const { source_page } = req.body;
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);

  const result = await pool.query(
    `INSERT INTO chats (visitor_name, visitor_email, visitor_phone, chat_token_hash, source_page, onboarding_step, status, last_message_at)
     VALUES (NULL, NULL, $1, $2, $3, 'intro', 'open', NOW())
     RETURNING id, visitor_name, visitor_email, visitor_phone, source_page, onboarding_step, status, created_at`,
    [null, tokenHash, (source_page || '').trim() || null]
  );

  await pool.query(
    `INSERT INTO chat_messages (chat_id, sender_type, sender_label, message)
     VALUES ($1, 'admin', 'Support', $2)`,
    [result.rows[0].id, promptGreeting]
  );

  return res.status(201).json({
    chat_id: result.rows[0].id,
    chat_token: token,
    chat: result.rows[0],
  });
});

router.get('/chat/:chatId/messages', requireDb, async (req, res) => {
  const chat = await resolveVisitorChat(req, req.params.chatId);
  if (!chat) return res.status(401).json({ error: 'Ungueltiger Chat-Zugriff.' });

  const messages = await fetchMessages(req.params.chatId);
  return res.json({ chat_id: req.params.chatId, messages });
});

router.post('/chat/:chatId/messages', requireDb, chatMessageLimiter, upload.array('files', 3), validateCsrf, async (req, res) => {
  const files = req.files || [];
  try {
    const chat = await resolveVisitorChat(req, req.params.chatId);
    if (!chat) {
      removeUploadedFiles(files);
      return res.status(401).json({ error: 'Ungueltiger Chat-Zugriff.' });
    }

    const messageText = (req.body.message || '').trim();
    if (!messageText && files.length === 0) {
      removeUploadedFiles(files);
      return res.status(400).json({ error: 'Nachricht oder Datei erforderlich.' });
    }

    if (chat.onboarding_step !== 'done' && !messageText) {
      removeUploadedFiles(files);
      return res.status(400).json({ error: 'Bitte zuerst die abgefragten Angaben als Text senden.' });
    }

    const messageResult = await pool.query(
      `INSERT INTO chat_messages (chat_id, sender_type, sender_label, message)
       VALUES ($1, 'visitor', 'Besucher', $2)
       RETURNING id`,
      [req.params.chatId, messageText || null]
    );

    for (const file of files) {
      const relativePath = path.join('chat', path.basename(file.path)).replace(/\\/g, '/');
      await pool.query(
        `INSERT INTO chat_attachments (chat_message_id, original_name, mime_type, size_bytes, storage_path)
         VALUES ($1, $2, $3, $4, $5)`,
        [messageResult.rows[0].id, file.originalname, file.mimetype, file.size, relativePath]
      );
    }

    if (chat.onboarding_step === 'intro') {
      await pool.query(`UPDATE chats SET onboarding_step = 'ask_name', last_message_at = NOW(), updated_at = NOW(), status = 'open' WHERE id = $1`, [
        req.params.chatId,
      ]);
      await pool.query(
        `INSERT INTO chat_messages (chat_id, sender_type, sender_label, message)
         VALUES ($1, 'admin', 'Support', $2)`,
        [req.params.chatId, promptAskName]
      );
    } else if (chat.onboarding_step === 'ask_name') {
      await pool.query(
        `UPDATE chats
         SET visitor_name = $1, onboarding_step = 'ask_email', last_message_at = NOW(), updated_at = NOW(), status = 'open'
         WHERE id = $2`,
        [messageText, req.params.chatId]
      );
      await pool.query(
        `INSERT INTO chat_messages (chat_id, sender_type, sender_label, message)
          VALUES ($1, 'admin', 'Support', $2)`,
        [req.params.chatId, promptAskEmail]
      );
    } else if (chat.onboarding_step === 'ask_email') {
      if (isValidEmail(messageText)) {
        await pool.query(
          `UPDATE chats
           SET visitor_email = $1, onboarding_step = 'ask_phone', last_message_at = NOW(), updated_at = NOW(), status = 'open'
           WHERE id = $2`,
          [messageText.toLowerCase(), req.params.chatId]
        );
        await pool.query(
          `INSERT INTO chat_messages (chat_id, sender_type, sender_label, message)
           VALUES ($1, 'admin', 'Support', $2)`,
          [req.params.chatId, promptAskPhone]
        );
      } else {
        await pool.query(`UPDATE chats SET last_message_at = NOW(), updated_at = NOW(), status = 'open' WHERE id = $1`, [
          req.params.chatId,
        ]);
        await pool.query(
          `INSERT INTO chat_messages (chat_id, sender_type, sender_label, message)
           VALUES ($1, 'admin', 'Support', $2)`,
          [req.params.chatId, promptInvalidEmail]
        );
      }
    } else if (chat.onboarding_step === 'ask_phone') {
      if (isValidPhone(messageText)) {
        await pool.query(
          `UPDATE chats
           SET visitor_phone = $1, onboarding_step = 'done', last_message_at = NOW(), updated_at = NOW(), status = 'open'
           WHERE id = $2`,
          [messageText, req.params.chatId]
        );
        await pool.query(
          `INSERT INTO chat_messages (chat_id, sender_type, sender_label, message)
           VALUES ($1, 'admin', 'Support', $2)`,
          [req.params.chatId, promptDone]
        );
      } else {
        await pool.query(`UPDATE chats SET last_message_at = NOW(), updated_at = NOW(), status = 'open' WHERE id = $1`, [
          req.params.chatId,
        ]);
        await pool.query(
          `INSERT INTO chat_messages (chat_id, sender_type, sender_label, message)
           VALUES ($1, 'admin', 'Support', $2)`,
          [req.params.chatId, promptInvalidPhone]
        );
      }
    } else {
      await pool.query(`UPDATE chats SET last_message_at = NOW(), updated_at = NOW(), status = 'open' WHERE id = $1`, [
        req.params.chatId,
      ]);
    }

    const messages = await fetchMessages(req.params.chatId);
    return res.status(201).json({ chat_id: req.params.chatId, messages });
  } catch (err) {
    removeUploadedFiles(files);
    throw err;
  }
});

router.get('/chat/files/:fileId', requireDb, async (req, res) => {
  const fileResult = await pool.query(
    `SELECT a.id, a.original_name, a.mime_type, a.storage_path, m.chat_id
     FROM chat_attachments a
     JOIN chat_messages m ON m.id = a.chat_message_id
     WHERE a.id = $1`,
    [req.params.fileId]
  );

  if (fileResult.rowCount === 0) return res.status(404).send('Datei nicht gefunden.');

  const file = fileResult.rows[0];
  const isAdmin = Boolean(req.session?.adminUser);
  let visitorAllowed = false;

  if (!isAdmin) {
    const visitorChat = await resolveVisitorChat(req, file.chat_id);
    visitorAllowed = Boolean(visitorChat);
  }

  if (!isAdmin && !visitorAllowed) return res.status(401).send('Nicht autorisiert.');

  const absolutePath = path.join(__dirname, '..', '..', 'uploads', file.storage_path);
  if (!fs.existsSync(absolutePath)) return res.status(404).send('Datei nicht gefunden.');

  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.original_name)}"`);
  return res.sendFile(absolutePath);
});

router.get('/admin/chats', requireDb, requireAdmin, async (req, res) => {
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
    `SELECT c.id, c.visitor_name, c.visitor_email, c.visitor_phone, c.status, c.source_page, c.last_message_at, c.updated_at,
            (
              SELECT m.message FROM chat_messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message
     FROM chats c
     ${whereSql}
     ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC`,
    params
  );

  return res.json({ chats: result.rows });
});

router.get('/admin/chats/:chatId', requireDb, requireAdmin, async (req, res) => {
  const chatResult = await pool.query(
    `SELECT id, visitor_name, visitor_email, visitor_phone, status, source_page, onboarding_step, last_message_at, created_at, updated_at
     FROM chats WHERE id = $1`,
    [req.params.chatId]
  );
  if (chatResult.rowCount === 0) return res.status(404).json({ error: 'Chat nicht gefunden.' });

  const messages = await fetchMessages(req.params.chatId);
  return res.json({ chat: chatResult.rows[0], messages });
});

router.post('/admin/chats/:chatId/messages', requireDb, requireAdmin, upload.array('files', 3), validateCsrf, async (req, res) => {
  const files = req.files || [];
  try {
    const chatResult = await pool.query('SELECT id FROM chats WHERE id = $1', [req.params.chatId]);
    if (chatResult.rowCount === 0) {
      removeUploadedFiles(files);
      return res.status(404).json({ error: 'Chat nicht gefunden.' });
    }

    const messageText = (req.body.message || '').trim();
    if (!messageText && files.length === 0) {
      removeUploadedFiles(files);
      return res.status(400).json({ error: 'Nachricht oder Datei erforderlich.' });
    }

    const senderLabel = req.session.adminUser?.username || 'admin';
    const messageResult = await pool.query(
      `INSERT INTO chat_messages (chat_id, sender_type, sender_label, message)
       VALUES ($1, 'admin', $2, $3)
       RETURNING id`,
      [req.params.chatId, senderLabel, messageText || null]
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
      req.params.chatId,
    ]);

    const messages = await fetchMessages(req.params.chatId);
    return res.status(201).json({ chat_id: req.params.chatId, messages });
  } catch (err) {
    removeUploadedFiles(files);
    throw err;
  }
});

router.patch('/admin/chats/:chatId', requireDb, requireAdmin, validateCsrf, async (req, res) => {
  const allowed = new Set(['open', 'pending', 'closed']);
  const status = (req.body.status || '').trim();
  if (!allowed.has(status)) {
    return res.status(400).json({ error: 'Ungueltiger Status.' });
  }

  const result = await pool.query(
    `UPDATE chats
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, status, updated_at`,
    [status, req.params.chatId]
  );

  if (result.rowCount === 0) return res.status(404).json({ error: 'Chat nicht gefunden.' });

  return res.json({ chat: result.rows[0] });
});

module.exports = { chatRouter: router };
