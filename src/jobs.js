const fs = require('fs');
const path = require('path');
let pool = null;
try {
  ({ pool } = require('./db'));
} catch (_err) {
  pool = null;
}

const { appState } = require('./state');
const legacyBackendEnabled = String(process.env.LEGACY_BACKEND_ENABLED || '0') === '1';

const JOBS_KEY = 'application_jobs_v1';
const localJobsPath = path.join(__dirname, '..', '.local', 'jobs.json');

const defaultJobs = [
  {
    slug: 'daten-app-tests-remote',
    title: 'Mitarbeiter*in (m/w/d) für digitale Daten- und App-Tests - Remote / Homeoffice',
    summary: 'Pruefung digitaler Anwendungen auf Funktion, Usability und Darstellungsqualitaet.',
    tasks: [
      'Sie testen digitale Anwendungen systematisch und pruefen, ob Funktionen ordnungsgemaess und nutzerfreundlich umgesetzt sind.',
      'Sie fuehren Tests auf verschiedenen Geraeten, Bildschirmgroessen und Betriebssystemen durch.',
      'Sie dokumentieren Auffaelligkeiten strukturiert fuer Entwicklungs- und Beratungsteams.',
    ],
    profile: [
      'Sorgfaeltige und strukturierte Arbeitsweise, auch bei wiederkehrenden Ablaeufen.',
      'Klare, praezise und sachliche schriftliche Rueckmeldungen.',
      'Zuverlaessige Arbeitsweise im Homeoffice und stabile technische Grundausstattung.',
    ],
    offer: [
      'Vollstaendig remote mit flexibler Arbeitsgestaltung.',
      'Strukturierte Einarbeitung in Prozesse und Testverfahren.',
      'Transparente und respektvolle Zusammenarbeit im Team.',
    ],
    facts: {
      date: '18.11.2025',
      salary: '603EUR p.M.',
      employment: 'Minijob',
      experience: 'keine noetig',
      deadline: '01.04.2026',
    },
  },
  {
    slug: 'kundenservice-digital-projekte',
    title: 'Mitarbeiter*in (m/w/d) Kundenservice fuer digitale Projekte',
    summary: 'Kommunikation mit Interessenten und Bestandskunden, Ticketbearbeitung und Qualitaetssicherung.',
    tasks: [
      'Bearbeitung von Kundenanfragen per E-Mail und Telefon.',
      'Dokumentation von Anliegen und Weiterleitung an zuständige Teams.',
      'Nachverfolgung offener Faelle bis zur Loesung.',
    ],
    profile: [
      'Freundliches, verbindliches Auftreten in der Kundenkommunikation.',
      'Sehr gute Deutschkenntnisse in Wort und Schrift.',
      'Selbststaendige, zuverlaessige Arbeitsweise.',
    ],
    offer: [
      'Flexible Arbeitszeiten mit Remote-Anteil.',
      'Klare Prozesse und feste Ansprechpartner.',
      'Entwicklungsperspektiven in einem wachsenden Umfeld.',
    ],
    facts: {
      date: '05.12.2025',
      salary: 'ab 15EUR / Stunde',
      employment: 'Teilzeit',
      experience: 'erste Erfahrung von Vorteil',
      deadline: '31.03.2026',
    },
  },
  {
    slug: 'junior-content-marketing',
    title: 'Junior Content & Marketing Assistenz (m/w/d)',
    summary: 'Unterstuetzung bei Content-Erstellung, Kampagnen-Umsetzung und Auswertung.',
    tasks: [
      'Erstellung und Pflege von Website- und Social-Media-Inhalten.',
      'Unterstuetzung bei Kampagnenplanung und Umsetzung.',
      'Auswertung einfacher KPIs und Reporting fuer das Team.',
    ],
    profile: [
      'Interesse an digitalem Marketing und redaktioneller Arbeit.',
      'Sicherer Umgang mit deutscher Rechtschreibung.',
      'Strukturierte Arbeitsweise und Teamfaehigkeit.',
    ],
    offer: [
      'Praxisnahe Einarbeitung und Mentoring.',
      'Flexible Arbeitsmodelle.',
      'Direkte Zusammenarbeit mit Beratung und Projektmanagement.',
    ],
    facts: {
      date: '10.01.2026',
      salary: 'nach Vereinbarung',
      employment: 'Teilzeit / Werkstudent',
      experience: 'nicht erforderlich',
      deadline: '30.04.2026',
    },
  },
];

function cloneDefaults() {
  return JSON.parse(JSON.stringify(defaultJobs));
}

function readLocalJobs() {
  try {
    if (!fs.existsSync(localJobsPath)) {
      return cloneDefaults();
    }
    const raw = fs.readFileSync(localJobsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const jobs = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.jobs) ? parsed.jobs : [];
    const normalized = normalizeJobs(jobs);
    return normalized.length > 0 ? normalized : cloneDefaults();
  } catch (_err) {
    return cloneDefaults();
  }
}

function writeLocalJobs(jobs) {
  const dir = path.dirname(localJobsPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(localJobsPath, JSON.stringify({ jobs }, null, 2), 'utf8');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function toLines(input) {
  if (Array.isArray(input)) {
    return input.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 20);
  }
  return String(input || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeFacts(input = {}, fallback = {}) {
  return {
    date: String(input.date || '').trim() || String(fallback.date || '').trim() || '-',
    salary: String(input.salary || '').trim() || String(fallback.salary || '').trim() || '-',
    employment: String(input.employment || '').trim() || String(fallback.employment || '').trim() || '-',
    experience: String(input.experience || '').trim() || String(fallback.experience || '').trim() || '-',
    deadline: String(input.deadline || '').trim() || String(fallback.deadline || '').trim() || '-',
  };
}

function ensureUniqueSlug(baseSlug, usedSlugs) {
  let candidate = baseSlug || 'stelle';
  let suffix = 2;
  while (usedSlugs.has(candidate)) {
    candidate = `${baseSlug || 'stelle'}-${suffix}`;
    suffix += 1;
  }
  usedSlugs.add(candidate);
  return candidate;
}

function normalizeJobs(input) {
  const source = Array.isArray(input) && input.length > 0 ? input : cloneDefaults();
  const usedSlugs = new Set();

  const normalized = source
    .map((job) => {
      const title = String(job && job.title ? job.title : '').trim();
      if (!title) return null;

      const baseSlug = slugify(job.slug || title) || 'stelle';
      const slug = ensureUniqueSlug(baseSlug, usedSlugs);

      const employmentType = job.type_of_employment || job.employment_type || job.employmentType || '';
      const workModel = job.working_model || job.workingModel || job.work_model || job.workModel || '';
      const location = job.location || '';
      const salaryDisplay = job.ad_text || job.adText || job.salary_display || job.salaryDisplay || '';
      const minSalary = job.min_salary ?? job.minSalary ?? 0;
      const maxSalary = job.max_salary ?? job.maxSalary ?? 0;

      const facts = normalizeFacts(job.facts, {
        employment: employmentType || undefined,
        salary: salaryDisplay || undefined,
      });
      if (location) facts.location = location;

      return {
        id: job.id,
        slug,
        title,
        summary: String(job.summary || job.short_description || '').trim(),
        short_description: String(job.short_description || '').trim(),
        description: String(job.description || '').trim(),
        tasks: toLines(job.tasks || job.responsibilities),
        responsibilities: toLines(job.responsibilities || job.tasks),
        profile: toLines(job.profile || job.requirements),
        requirements: toLines(job.requirements || job.profile),
        offer: toLines(job.offer || job.benefits),
        benefits: toLines(job.benefits || job.offer),
        type_of_employment: employmentType,
        employment_type: employmentType,
        work_model: workModel,
        working_model: workModel,
        location,
        salary_display: salaryDisplay,
        ad_text: salaryDisplay,
        min_salary: Number(minSalary) || 0,
        max_salary: Number(maxSalary) || 0,
        facts,
        created_at: job.created_at || null,
        display_order: Number(job.display_order || 0),
        is_featured: !!job.is_featured,
      };
    })
    .filter(Boolean);

  // Newest first by default (and keep featured/order signals when available)
  return normalized.sort((a, b) => {
    if ((a.display_order || 0) !== (b.display_order || 0)) return (a.display_order || 0) - (b.display_order || 0);
    if (a.is_featured !== b.is_featured) return a.is_featured ? -1 : 1;
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });
}

async function getJobs() {
  const magicvicsBase = String(process.env.MAGICVICS_API_BASE || '').trim().replace(/\/$/, '');
  if (magicvicsBase) {
    try {
      const resp = await fetch(`${magicvicsBase}/api/public/job-listings`);
      if (resp.ok) {
        const payload = await resp.json();
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        const normalized = normalizeJobs(rows);
        if (normalized.length > 0) return normalized;
      }
    } catch (_err) {
      // Fall through to local/legacy sources.
    }
  }

  if (!legacyBackendEnabled || !appState.dbAvailable || !pool) {
    return readLocalJobs();
  }

  try {
    const result = await pool.query('SELECT value FROM app_settings WHERE key = $1', [JOBS_KEY]);
    if (result.rowCount === 0) {
      return cloneDefaults();
    }

    const value = result.rows[0].value;
    const jobs = Array.isArray(value) ? value : value && Array.isArray(value.jobs) ? value.jobs : [];
    const normalized = normalizeJobs(jobs);
    return normalized.length > 0 ? normalized : cloneDefaults();
  } catch (_err) {
    return readLocalJobs();
  }
}

async function saveJobs(jobs) {
  const normalized = normalizeJobs(jobs);
  if (!legacyBackendEnabled || !appState.dbAvailable || !pool) {
    writeLocalJobs(normalized);
    return normalized;
  }

  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JOBS_KEY, JSON.stringify({ jobs: normalized })]
  );
  return normalized;
}

async function getJobBySlug(slug) {
  const jobs = await getJobs();
  const normalizedSlug = slugify(slug);
  return jobs.find((job) => job.slug === normalizedSlug) || null;
}

async function upsertJob(jobInput, originalSlug = '') {
  const jobs = await getJobs();
  const normalizedOriginalSlug = slugify(originalSlug);
  const filtered = normalizedOriginalSlug ? jobs.filter((job) => job.slug !== normalizedOriginalSlug) : [...jobs];
  const normalizedNew = normalizeJobs([jobInput]);
  if (normalizedNew.length === 0) {
    throw new Error('INVALID_JOB');
  }

  const usedSlugs = new Set(filtered.map((job) => job.slug));
  const newJob = normalizedNew[0];
  if (usedSlugs.has(newJob.slug)) {
    newJob.slug = ensureUniqueSlug(newJob.slug, usedSlugs);
  }

  filtered.push(newJob);
  const saved = await saveJobs(filtered);
  return saved.find((job) => job.slug === newJob.slug) || newJob;
}

async function deleteJob(slug) {
  const normalizedSlug = slugify(slug);
  const jobs = await getJobs();
  const filtered = jobs.filter((job) => job.slug !== normalizedSlug);
  await saveJobs(filtered);
  return filtered;
}

module.exports = {
  defaultJobs,
  getJobs,
  getJobBySlug,
  upsertJob,
  deleteJob,
};
