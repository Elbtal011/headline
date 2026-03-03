const { pool } = require('./db');
const { appState } = require('./state');

const JOB_FACTS_KEY = 'application_job_facts';

const defaultJobFacts = {
  date: '18.11.2025',
  salary: '603EUR p.M.',
  employment: 'Minijob',
  experience: 'keine nötig',
  deadline: '01.04.2026',
};

function normalizeJobFacts(input = {}) {
  return {
    date: String(input.date || '').trim() || defaultJobFacts.date,
    salary: String(input.salary || '').trim() || defaultJobFacts.salary,
    employment: String(input.employment || '').trim() || defaultJobFacts.employment,
    experience: String(input.experience || '').trim() || defaultJobFacts.experience,
    deadline: String(input.deadline || '').trim() || defaultJobFacts.deadline,
  };
}

async function getJobFacts() {
  if (!appState.dbAvailable) {
    return { ...defaultJobFacts };
  }

  try {
    const result = await pool.query('SELECT value FROM app_settings WHERE key = $1', [JOB_FACTS_KEY]);
    if (result.rowCount === 0 || typeof result.rows[0].value !== 'object') {
      return { ...defaultJobFacts };
    }
    return normalizeJobFacts(result.rows[0].value);
  } catch (_err) {
    return { ...defaultJobFacts };
  }
}

async function saveJobFacts(input = {}) {
  const facts = normalizeJobFacts(input);

  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JOB_FACTS_KEY, JSON.stringify(facts)]
  );

  return facts;
}

module.exports = {
  defaultJobFacts,
  getJobFacts,
  saveJobFacts,
};

