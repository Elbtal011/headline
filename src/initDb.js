const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { pool } = require('./db');
const { appState } = require('./state');

async function initDb() {
  try {
    const sqlPath = path.join(__dirname, '..', 'db', 'init.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sql);
    appState.dbAvailable = true;
  } catch (err) {
    appState.dbAvailable = false;
    console.warn('DB nicht verfügbar. App läuft im Read-only Vorschau-Modus.');
    console.warn(err && err.message ? err.message : err);
    return;
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    return;
  }

  const existing = await pool.query('SELECT id FROM admin_users WHERE email = $1', [adminEmail]);
  if (existing.rowCount > 0) {
    return;
  }

  const hash = await bcrypt.hash(adminPassword, 12);
  await pool.query(
    'INSERT INTO admin_users (email, password_hash, role) VALUES ($1, $2, $3)',
    [adminEmail, hash, 'admin']
  );

  console.log(`Seeded admin user: ${adminEmail}`);
}

module.exports = { initDb };
