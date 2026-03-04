const express = require('express');
const bcrypt = require('bcrypt');
const { rateLimit } = require('express-rate-limit');
const { validateCsrf } = require('../middleware/csrf');
const { getJobs, getJobBySlug } = require('../jobs');
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

router.get('/Kontakt', (req, res) => {
  renderPage(res, 'pages/kontakt', { currentPath: '/Kontakt' });
});

router.get('/Datenschutz', (req, res) => {
  renderPage(res, 'pages/datenschutz', { currentPath: '/Datenschutz' });
});

router.get('/Impressum', (req, res) => {
  renderPage(res, 'pages/impressum', { currentPath: '/Impressum' });
});

router.get('/webid/:caseId', (req, res) => {
  const raw = String(req.params.caseId || '').trim();
  const caseId = raw.replace(/[^0-9-]/g, '').slice(0, 40) || '000000-000-000';
  return res.render('pages/webid-sim', { caseId });
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
    password1,
    password2,
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

  // Optional auto-account creation on Headline (same credentials as application form)
  const pw1 = String(password1 || '');
  const pw2 = String(password2 || '');
  if (pw1 || pw2) {
    if (pw1 !== pw2) return res.status(400).send('Passwörter stimmen nicht überein.');
    if (pw1.length < 8) return res.status(400).send('Passwort muss mindestens 8 Zeichen lang sein.');

    try {
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [applicantEmail]);
      if (existing.rowCount === 0) {
        const hash = await bcrypt.hash(pw1, 12);
        await pool.query(
          `INSERT INTO users (email, password_hash, first_name, last_name, phone, birth_date, address_line, zip, city, country)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            applicantEmail,
            hash,
            fn || applicantName,
            ln || '-',
            String(mobile || '').trim() || null,
            applicantBirthDate || null,
            String(address || '').trim() || null,
            String(zip || '').trim() || null,
            String(city || '').trim() || null,
            String(country || '').trim() || null,
          ]
        );
      }
    } catch (err) {
      console.error('[decoupled] auto-account create failed', err);
      return res.status(502).send('Bewerbung gespeichert, aber Konto konnte nicht erstellt werden. Bitte über /konto/registrieren anlegen.');
    }
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
