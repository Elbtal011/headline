const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const { validateCsrf } = require('../middleware/csrf');
const { getJobs, getJobBySlug, debugJobsSource } = require('../jobs');
const { pool } = require('../db');

const router = express.Router();

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: 'Zu viele Anfragen. Bitte später erneut versuchen.',
});

const navItems = [
  { href: '/index.php', label: 'Startseite' },
  { href: '/Unternehmen', label: 'Unternehmen' },
  { href: '/Fachgebiete', label: 'Fachgebiete' },
  { href: '/Bewerbung', label: 'Karriere & Stellen' },
  { href: '/Kontakt', label: 'Kontakt / Kundendienst' },
];

const WEBID_PROVIDER = String(process.env.WEBID_PROVIDER || 'simulated').trim().toLowerCase();
const WEBID_OFFICIAL_ENABLED = WEBID_PROVIDER === 'signicat';
const SIGNICAT_BASE_URL = String(process.env.SIGNICAT_BASE_URL || '').trim().replace(/\/$/, '');
const SIGNICAT_CLIENT_ID = String(process.env.SIGNICAT_CLIENT_ID || '').trim();
const SIGNICAT_CLIENT_SECRET = String(process.env.SIGNICAT_CLIENT_SECRET || '').trim();
const SIGNICAT_SCOPE = String(process.env.SIGNICAT_SCOPE || 'assure.api').trim();
const SIGNICAT_DEFAULT_PROCESS_TYPE = String(process.env.SIGNICAT_WEBID_PROCESS_TYPE || 'accountid').trim().toLowerCase();
const WEBID_EVENTS_SECRET = String(process.env.WEBID_EVENTS_SECRET || '').trim();

let signicatTokenCache = { token: null, expiresAt: 0 };
let webIdProviderStoreReady = false;

function hasOfficialWebIdConfig() {
  return !!(WEBID_OFFICIAL_ENABLED && SIGNICAT_BASE_URL && SIGNICAT_CLIENT_ID && SIGNICAT_CLIENT_SECRET);
}

function getPublicBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

async function ensureWebIdProviderStore() {
  if (webIdProviderStoreReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webid_provider_processes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL,
      case_id TEXT NOT NULL,
      dossier_id TEXT,
      process_id TEXT UNIQUE,
      process_type TEXT,
      status TEXT,
      redirect_url TEXT,
      raw_create_response JSONB,
      raw_event JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_webid_provider_case_id ON webid_provider_processes(case_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_webid_provider_process_id ON webid_provider_processes(process_id)');
  webIdProviderStoreReady = true;
}

async function upsertWebIdProviderProcess(data = {}) {
  await ensureWebIdProviderStore();
  const {
    provider = 'signicat',
    caseId,
    dossierId = null,
    processId = null,
    processType = null,
    status = null,
    redirectUrl = null,
    rawCreateResponse = null,
    rawEvent = null,
  } = data;

  if (!caseId && !processId) return;

  await pool.query(
    `INSERT INTO webid_provider_processes
      (provider, case_id, dossier_id, process_id, process_type, status, redirect_url, raw_create_response, raw_event)
     VALUES ($1, COALESCE($2, ''), $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (process_id)
     DO UPDATE SET
      case_id = COALESCE(NULLIF(EXCLUDED.case_id, ''), webid_provider_processes.case_id),
      dossier_id = COALESCE(EXCLUDED.dossier_id, webid_provider_processes.dossier_id),
      process_type = COALESCE(EXCLUDED.process_type, webid_provider_processes.process_type),
      status = COALESCE(EXCLUDED.status, webid_provider_processes.status),
      redirect_url = COALESCE(EXCLUDED.redirect_url, webid_provider_processes.redirect_url),
      raw_create_response = COALESCE(EXCLUDED.raw_create_response, webid_provider_processes.raw_create_response),
      raw_event = COALESCE(EXCLUDED.raw_event, webid_provider_processes.raw_event),
      updated_at = NOW()`,
    [provider, caseId || '', dossierId, processId, processType, status, redirectUrl, rawCreateResponse, rawEvent]
  );
}

async function getSignicatAccessToken() {
  const now = Date.now();
  if (signicatTokenCache.token && signicatTokenCache.expiresAt > now + 15_000) {
    return signicatTokenCache.token;
  }

  const tokenUrl = `${SIGNICAT_BASE_URL}/auth/open/connect/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: SIGNICAT_SCOPE,
  });

  const auth = Buffer.from(`${SIGNICAT_CLIENT_ID}:${SIGNICAT_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json?.access_token) {
    const msg = json?.error_description || json?.error || `Token request failed (${resp.status})`;
    throw new Error(msg);
  }

  const expiresIn = Number(json.expires_in || 300);
  signicatTokenCache = {
    token: String(json.access_token),
    expiresAt: now + Math.max(30, expiresIn - 30) * 1000,
  };

  return signicatTokenCache.token;
}

async function signicatAssureRequest(method, endpointPath, payload) {
  const token = await getSignicatAccessToken();
  const url = `${SIGNICAT_BASE_URL}${endpointPath}`;
  const resp = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json?.detail || json?.message || json?.error || `Signicat API error (${resp.status})`;
    throw new Error(msg);
  }
  return json;
}

function renderPage(res, view, pageData = {}) {
  res.render(view, {
    navItems,
    pageData,
  });
}

function normalizeRedirect(pathValue, fallback) {
  if (typeof pathValue === 'string' && pathValue.startsWith('/')) return pathValue.trim();
  return fallback;
}

router.get('/', (req, res) => {
  renderPage(res, 'pages/home', { currentPath: '/index.php' });
});

router.get('/index.php', (req, res) => {
  renderPage(res, 'pages/home', { currentPath: '/index.php' });
});

router.get('/Unternehmen', (req, res) => {
  renderPage(res, 'pages/unternehmen', { currentPath: '/Unternehmen' });
});

router.get('/Fachgebiete', (req, res) => {
  renderPage(res, 'pages/fachgebiete', { currentPath: '/Fachgebiete' });
});

router.get('/Bewerbung', async (req, res) => {
  const jobs = await getJobs();
  renderPage(res, 'pages/bewerbung', { currentPath: '/Bewerbung', jobs });
});

router.get('/Bewerbung/:slug', async (req, res) => {
  const job = await getJobBySlug(req.params.slug);
  if (!job) {
    return res.status(404).render('pages/404', { pageData: { currentPath: req.path } });
  }
  return renderPage(res, 'pages/bewerbung-detail', { currentPath: '/Bewerbung', job });
});

router.get('/__debug/jobs-source', async (_req, res) => {
  const meta = await debugJobsSource();
  res.json(meta);
});

router.get('/Kontakt', (req, res) => {
  renderPage(res, 'pages/kontakt', { currentPath: '/Kontakt' });
});

router.get('/Datenschutz', (req, res) => {
  renderPage(res, 'pages/datenschutz', { currentPath: '/Datenschutz' });
});

router.get('/Impressum', (req, res) => {
  renderPage(res, 'pages/impressum', { currentPath: '/Impressum' });
});

function normalizeWebIdCaseId(input) {
  return String(input || '').trim().replace(/[^0-9-]/g, '').slice(0, 40) || '152-187-906';
}

function generateWebIdCaseId() {
  const a = String(Math.floor(100 + Math.random() * 900));
  const b = String(Math.floor(100 + Math.random() * 900));
  const c = String(Math.floor(100 + Math.random() * 900));
  return `${a}-${b}-${c}`;
}

function decodeBase64Image(b64) {
  const clean = String(b64 || '').trim();
  if (!clean) return null;
  try {
    return Buffer.from(clean, 'base64');
  } catch {
    return null;
  }
}

let webIdBlobStoreReady = false;
async function ensureWebIdBlobStore() {
  if (webIdBlobStoreReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webid_kyc_files (
      path TEXT PRIMARY KEY,
      content_type TEXT NOT NULL DEFAULT 'image/jpeg',
      file_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  webIdBlobStoreReady = true;
}

async function saveWebIdImage(caseId, kind, buffer) {
  const safeCase = normalizeWebIdCaseId(caseId).replace(/[^0-9-]/g, '');
  const dir = path.join(__dirname, '..', '..', 'uploads', 'webid', safeCase);
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${kind}-${Date.now()}.jpg`;
  const absPath = path.join(dir, fileName);
  await fs.writeFile(absPath, buffer);
  const relPath = path.join('uploads', 'webid', safeCase, fileName).replace(/\\/g, '/');

  try {
    await ensureWebIdBlobStore();
    await pool.query(
      `INSERT INTO webid_kyc_files (path, content_type, file_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (path)
       DO UPDATE SET content_type = EXCLUDED.content_type, file_data = EXCLUDED.file_data`,
      [relPath, 'image/jpeg', buffer]
    );
  } catch (err) {
    console.error('[webid] blob-store save failed', err);
  }

  return relPath;
}

function splitName(fullName) {
  const v = String(fullName || '').trim();
  if (!v) return { first_name: 'WebID', last_name: 'Submission' };
  const parts = v.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

router.get('/webid', (req, res) => {
  const generated = generateWebIdCaseId();
  return res.redirect(`/webid/${encodeURIComponent(generated)}`);
});

router.get('/webid/:caseId', (req, res) => {
  const caseId = normalizeWebIdCaseId(req.params.caseId);
  const actionId = caseId.replace(/[^0-9]/g, '');

  return res.render('pages/webid-sim', {
    caseId,
    actionId,
    officialMode: hasOfficialWebIdConfig(),
    processType: SIGNICAT_DEFAULT_PROCESS_TYPE,
    callbackResult: null,
  });
});

router.post('/api/webid/start', submitLimiter, async (req, res) => {
  if (!hasOfficialWebIdConfig()) {
    return res.status(503).json({ ok: false, error: 'Official WebID ist nicht konfiguriert.' });
  }

  try {
    const caseId = normalizeWebIdCaseId(req.body?.caseId);
    const processType = String(req.body?.processType || SIGNICAT_DEFAULT_PROCESS_TYPE || 'accountid').toLowerCase();

    if (!['accountid', 'videoid'].includes(processType)) {
      return res.status(400).json({ ok: false, error: 'Ungültiger processType (accountid|videoid).' });
    }

    const firstName = String(req.body?.firstName || 'Max').trim() || 'Max';
    const lastName = String(req.body?.lastName || 'Mustermann').trim() || 'Mustermann';
    const dateOfBirth = String(req.body?.dateOfBirth || '1990-01-01').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const mobile = String(req.body?.mobile || '').trim();

    const publicBase = getPublicBaseUrl(req);
    const redirectUrl = `${publicBase}/webid/callback/success?caseId=${encodeURIComponent(caseId)}`;
    const redirectCancelUrl = `${publicBase}/webid/callback/cancel?caseId=${encodeURIComponent(caseId)}`;
    const redirectMismatchUrl = `${publicBase}/webid/callback/mismatch?caseId=${encodeURIComponent(caseId)}`;
    const redirectDeclineUrl = `${publicBase}/webid/callback/decline?caseId=${encodeURIComponent(caseId)}`;

    const dossier = await signicatAssureRequest('POST', '/assure/dossiers', {});
    const dossierId = dossier?.dossierId || dossier?.id;

    if (!dossierId) {
      throw new Error('Dossier konnte nicht erstellt werden.');
    }

    const processBody = {
      provider: 'webid',
      processType,
      processParameters: {
        webid: {
          user: {
            firstName,
            lastName,
            dateOfBirth,
            contact: {
              ...(email ? { email } : {}),
              ...(mobile ? { mobile } : {}),
            },
          },
          userActionParameters: {
            productType: 'employment',
            clientName: 'Headline',
            redirectUrl,
            redirectCancelUrl,
            redirectMismatchUrl,
            redirectDeclineUrl,
          },
          ...(processType === 'accountid' ? { idDocument: { nationality: 'DEU' } } : {}),
        },
      },
    };

    const process = await signicatAssureRequest('POST', `/assure/dossiers/${encodeURIComponent(dossierId)}/processes`, processBody);

    await upsertWebIdProviderProcess({
      provider: 'signicat',
      caseId,
      dossierId,
      processId: process?.processId || null,
      processType: process?.processType || processType,
      status: process?.status || 'pending',
      redirectUrl: process?.redirectUrl || null,
      rawCreateResponse: process,
    });

    return res.json({
      ok: true,
      caseId,
      dossierId,
      processId: process?.processId || null,
      status: process?.status || 'pending',
      redirectUrl: process?.redirectUrl || null,
      provider: 'signicat/webid',
    });
  } catch (err) {
    console.error('[webid] official start failed', err);
    return res.status(500).json({ ok: false, error: err?.message || 'WebID Prozess konnte nicht gestartet werden.' });
  }
});

router.get('/api/webid/process/:processId', async (req, res) => {
  if (!hasOfficialWebIdConfig()) {
    return res.status(503).json({ ok: false, error: 'Official WebID ist nicht konfiguriert.' });
  }

  try {
    const processId = String(req.params?.processId || '').trim();
    if (!processId) return res.status(400).json({ ok: false, error: 'processId fehlt.' });

    const process = await signicatAssureRequest('GET', `/assure/processes/${encodeURIComponent(processId)}`);

    await upsertWebIdProviderProcess({
      provider: 'signicat',
      caseId: String(req.query?.caseId || '').trim() || null,
      processId,
      processType: process?.processType || null,
      status: process?.status || null,
      redirectUrl: process?.redirectUrl || null,
      rawCreateResponse: process,
    });

    return res.json({ ok: true, process });
  } catch (err) {
    console.error('[webid] get process failed', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Status konnte nicht geladen werden.' });
  }
});

router.post('/api/webid/events', async (req, res) => {
  try {
    if (WEBID_EVENTS_SECRET) {
      const given = String(req.headers['x-webid-events-secret'] || '').trim();
      if (!given || given !== WEBID_EVENTS_SECRET) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
    }

    const event = req.body || {};
    const processId = String(
      event?.processId || event?.data?.processId || event?.resourceId || event?.id || ''
    ).trim();
    const status = String(event?.status || event?.data?.status || '').trim() || null;
    const caseId = normalizeWebIdCaseId(event?.caseId || event?.data?.caseId || '');

    if (processId) {
      await upsertWebIdProviderProcess({
        provider: 'signicat',
        caseId: caseId || null,
        processId,
        status,
        rawEvent: event,
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[webid] events handler failed', err);
    return res.status(500).json({ ok: false, error: 'event handling failed' });
  }
});

router.get('/webid/callback/:result', (req, res) => {
  const caseId = normalizeWebIdCaseId(req.query?.caseId || req.params?.caseId || '');
  const result = String(req.params?.result || 'unknown').trim().toLowerCase();
  return res.render('pages/webid-sim', {
    caseId,
    actionId: caseId.replace(/[^0-9]/g, ''),
    processType: SIGNICAT_DEFAULT_PROCESS_TYPE,
    officialMode: hasOfficialWebIdConfig(),
    callbackResult: result,
  });
});

router.post('/api/webid/submit', submitLimiter, async (req, res) => {
  try {
    const caseId = normalizeWebIdCaseId(req.body?.caseId);
    const frontImageBase64 = req.body?.frontImageBase64;
    const backImageBase64 = req.body?.backImageBase64;
    const selfieImageBase64 = req.body?.selfieImageBase64;

    const front = decodeBase64Image(frontImageBase64);
    const back = decodeBase64Image(backImageBase64);
    const selfie = decodeBase64Image(selfieImageBase64);

    if (!front || !back || !selfie) {
      return res.status(400).json({ ok: false, error: 'Bitte Vorderseite, Rückseite und Selfie vollständig hochladen.' });
    }

    if (front.byteLength < 1000 || back.byteLength < 1000 || selfie.byteLength < 1000) {
      return res.status(400).json({ ok: false, error: 'Mindestens ein Bild ist ungültig oder zu klein.' });
    }

    const [frontPath, backPath, selfiePath] = await Promise.all([
      saveWebIdImage(caseId, 'front', front),
      saveWebIdImage(caseId, 'back', back),
      saveWebIdImage(caseId, 'selfie', selfie),
    ]);

    const db = await pool.query(
      `INSERT INTO webid_kyc_submissions (case_id, front_image_path, back_image_path, selfie_image_path, status)
       VALUES ($1, $2, $3, $4, 'in_review')
       RETURNING id, case_id, created_at`,
      [caseId, frontPath, backPath, selfiePath]
    );

    return res.json({ ok: true, submission: db.rows[0] });
  } catch (err) {
    console.error('[webid] submit failed', err);
    return res.status(500).json({ ok: false, error: 'Upload fehlgeschlagen. Bitte erneut versuchen.' });
  }
});

router.get('/api/admin/kyc-submissions', async (_req, res) => {
  try {
    const q = await pool.query(
      `SELECT id, case_id, front_image_path, back_image_path, selfie_image_path, ocr_full_name, ocr_document_number, ocr_confidence, status, created_at, updated_at
       FROM webid_kyc_submissions
       ORDER BY created_at DESC`
    );

    const rows = q.rows.map((r) => {
      const name = splitName(r.ocr_full_name || `WebID ${r.case_id}`);
      return {
        id: r.case_id,
        submission_id: r.id,
        role: 'user',
        first_name: name.first_name,
        last_name: name.last_name,
        email: `${r.case_id.replace(/[^0-9]/g, '')}@webid.local`,
        phone: null,
        kyc_status: r.status || 'in_review',
        kyc_verified_at: null,
        created_at: r.created_at,
        updated_at: r.updated_at,
        kyc_documents: {
          identity_card_front: r.front_image_path,
          identity_card_back: r.back_image_path,
          selfie: r.selfie_image_path,
          detected_name: r.ocr_full_name || null,
          detected_id_number: r.ocr_document_number || null,
          detected_confidence: r.ocr_confidence || null,
        },
      };
    });

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[webid] list submissions failed', err);
    return res.status(500).json({ success: false, error: 'KYC submissions konnten nicht geladen werden.' });
  }
});

router.get('/api/admin/kyc-document', async (req, res) => {
  try {
    let rawPath = String(req.query?.path || '').trim();
    for (let i = 0; i < 2; i += 1) {
      try {
        const dec = decodeURIComponent(rawPath);
        if (dec === rawPath) break;
        rawPath = dec;
      } catch {
        break;
      }
    }
    rawPath = rawPath.replace(/%2F/gi, '/').replace(/^\/+/, '');
    if (!rawPath || !rawPath.startsWith('uploads/webid/')) {
      return res.status(400).json({ success: false, error: 'Invalid document path' });
    }

    const candidates = [
      path.join(__dirname, '..', '..', rawPath),
      path.join(process.cwd(), rawPath),
      path.join('/data', rawPath),
      path.join('/data', 'uploads', rawPath.replace(/^uploads\//, '')),
    ];

    let found = null;
    for (const p of candidates) {
      try {
        const b = await fs.readFile(p);
        found = { p, b };
        break;
      } catch {
        // try next
      }
    }

    if (!found) {
      try {
        await ensureWebIdBlobStore();
        const q = await pool.query(
          'SELECT content_type, file_data FROM webid_kyc_files WHERE path = $1 LIMIT 1',
          [rawPath]
        );
        if (q.rows[0] && q.rows[0].file_data) {
          const ct = q.rows[0].content_type || 'application/octet-stream';
          res.setHeader('content-type', ct);
          return res.status(200).send(q.rows[0].file_data);
        }
      } catch (err) {
        console.error('[webid] blob-store fetch failed', err);
      }
      return res.status(404).send('Document not found');
    }

    const lower = rawPath.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) res.setHeader('content-type', 'image/jpeg');
    else if (lower.endsWith('.png')) res.setHeader('content-type', 'image/png');
    else if (lower.endsWith('.webp')) res.setHeader('content-type', 'image/webp');
    else if (lower.endsWith('.pdf')) res.setHeader('content-type', 'application/pdf');
    else res.setHeader('content-type', 'application/octet-stream');

    return res.status(200).send(found.b);
  } catch (err) {
    console.error('[webid] kyc document fetch failed', err);
    return res.status(500).json({ success: false, error: 'KYC-Dokument konnte nicht geladen werden.' });
  }
});

// Decoupled mode: accept submissions, keep UX success flow, persistence is moved out
// in the next step (MagicVics backend wiring).
router.post('/api/leads/contact', submitLimiter, validateCsrf, async (req, res) => {
  const { full_name, name, email, message, source_page, website } = req.body || {};

  if (website) return res.redirect('/Kontakt?ok=1');

  const contactName = String(full_name || name || '').trim();
  const contactEmail = String(email || '').trim().toLowerCase();
  const contactMessage = String(message || '').trim();

  if (!contactName || !contactEmail || !contactMessage) {
    return res.status(400).send('Bitte alle Pflichtfelder ausfüllen.');
  }

  console.log('[decoupled] contact form accepted', { contactEmail, source_page: source_page || '/Kontakt' });
  return res.redirect('/Kontakt?ok=1');
});

router.post('/api/leads/application', submitLimiter, validateCsrf, async (req, res) => {
  const {
    full_name,
    name,
    first_name,
    last_name,
    email,
    email_address,
    birth_date,
    dob,
    address,
    zip,
    city,
    country,
    mobile,
    job_title,
    source_page,
    website,
  } = req.body || {};

  const redirectTarget = normalizeRedirect(source_page, '/Bewerbung');
  if (website) return res.redirect(`${redirectTarget}${redirectTarget.includes('?') ? '&' : '?'}ok=1`);

  const applicantName =
    (String(full_name || '').trim()) ||
    (String(name || '').trim()) ||
    [first_name, last_name].filter(Boolean).join(' ').trim();
  const applicantEmail = String(email || email_address || '').trim().toLowerCase();
  const applicantBirthDate = String(birth_date || dob || '').trim();

  if (!applicantName || !applicantEmail || !applicantBirthDate) {
    return res.status(400).send('Bitte alle Pflichtfelder ausfüllen.');
  }

  const [fn, ...rest] = applicantName.split(' ');
  const ln = rest.join(' ').trim();
  const jobSlug = redirectTarget.startsWith('/Bewerbung/') ? redirectTarget.replace('/Bewerbung/', '').split('?')[0] : null;

  const apiBase = String(req.app?.locals?.magicvicsApiBase || process.env.MAGICVICS_API_BASE || '').trim().replace(/\/$/, '');
  if (!apiBase) {
    return res.status(500).send('Bewerbung konnte nicht gespeichert werden (API nicht konfiguriert).');
  }



  try {
    const payload = {
      first_name: fn || applicantName,
      last_name: ln || '-',
      full_name: applicantName,
      email: applicantEmail,
      phone: String(mobile || '').trim(),
      mobile: String(mobile || '').trim(),
      birth_date: applicantBirthDate,
      dob: applicantBirthDate,
      address: String(address || '').trim(),
      street: String(address || '').trim(),
      zip: String(zip || '').trim(),
      postal_code: String(zip || '').trim(),
      city: String(city || '').trim(),
      country: String(country || '').trim(),
      nationality: String(country || '').trim(),
      full_address: [String(address || '').trim(), [String(zip || '').trim(), String(city || '').trim()].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      source_page: redirectTarget,
      job_slug: jobSlug,
      job_title: String(job_title || '').trim(),
      application_type: String(job_title || '').trim(),
      status: 'pending',
    };

    const resp = await fetch(`${apiBase}/api/public/job-applications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error('[decoupled] application forward failed', resp.status, txt);
      return res.status(502).send('Bewerbung konnte aktuell nicht übermittelt werden. Bitte erneut versuchen.');
    }
  } catch (err) {
    console.error('[decoupled] application forward error', err);
    return res.status(502).send('Bewerbung konnte aktuell nicht übermittelt werden. Bitte erneut versuchen.');
  }

  console.log('[decoupled] application form accepted+forwarded', { applicantEmail, source_page: redirectTarget });
  return res.redirect(`${redirectTarget}${redirectTarget.includes('?') ? '&' : '?'}ok=1`);
});

router.post('/api/leads/newsletter', submitLimiter, validateCsrf, async (req, res) => {
  const { newsletter_mail, source_page, website } = req.body || {};
  const redirectTarget = normalizeRedirect(source_page, '/index.php');

  if (website) return res.redirect(`${redirectTarget}${redirectTarget.includes('?') ? '&' : '?'}ok=1`);

  const newsletterEmail = String(newsletter_mail || '').trim().toLowerCase();
  if (!newsletterEmail) {
    return res.status(400).send('Bitte E-Mail-Adresse angeben.');
  }

  console.log('[decoupled] newsletter form accepted', { newsletterEmail, source_page: redirectTarget });
  return res.redirect(`${redirectTarget}${redirectTarget.includes('?') ? '&' : '?'}ok=1`);
});

module.exports = { publicRouter: router, navItems };



