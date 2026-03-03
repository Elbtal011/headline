const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { validateCsrf } = require('../middleware/csrf');
const { getJobs, getJobBySlug } = require('../jobs');

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

  console.log('[decoupled] application form accepted', { applicantEmail, source_page: redirectTarget });
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
