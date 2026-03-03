const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGDATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const explicitDisableSsl = String(process.env.DATABASE_SSL || '').toLowerCase() === 'false';
const isLocalDb = /localhost|127\.0\.0\.1/i.test(connectionString);
const ssl = explicitDisableSsl || isLocalDb ? false : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString,
  ssl,
});

module.exports = { pool };
