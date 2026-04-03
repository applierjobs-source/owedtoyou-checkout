'use strict';
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS claims (
      id SERIAL PRIMARY KEY,
      claim_id TEXT UNIQUE NOT NULL,
      token TEXT,
      first_name TEXT,
      last_name TEXT,
      dob TEXT,
      ssn TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      email TEXT,
      phone TEXT,
      id_image BYTEA,
      id_mime TEXT,
      status TEXT DEFAULT 'pending',
      ca_claim_id TEXT,
      submitted_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('[db] Claims table ready');
}

async function saveClaim(data) {
  const { claimId, token, firstName, lastName, dob, ssn, address, city, state, zip, email, phone, idImage, idMime } = data;
  const result = await pool.query(
    `INSERT INTO claims (claim_id, token, first_name, last_name, dob, ssn, address, city, state, zip, email, phone, id_image, id_mime)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [claimId, token, firstName, lastName, dob, ssn, address, city, state, zip, email, phone, idImage, idMime]
  );
  return result.rows[0];
}

async function getClaims() {
  const result = await pool.query('SELECT id, claim_id, first_name, last_name, email, phone, status, submitted_at FROM claims ORDER BY submitted_at DESC');
  return result.rows;
}

async function updateClaimStatus(claimId, status, caClaim) {
  await pool.query('UPDATE claims SET status=$1, ca_claim_id=$2 WHERE claim_id=$3', [status, caClaim, claimId]);
}

module.exports = { initDb, saveClaim, getClaims, updateClaimStatus, pool };
