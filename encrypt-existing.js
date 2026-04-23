'use strict';
/**
 * One-time migration: encrypt plain-text SSN, DOB, and ID images already in DB
 * Run: ENCRYPTION_KEY=<key> node encrypt-existing.js
 */
process.env.ENCRYPTION_KEY = 'e30878e1c89dec924f03dd010a080c9124c4b9beb639ab7947278671c2e2db8b';

const { Pool } = require('pg');
const { encrypt, isEncrypted } = require('./crypto-utils');

const pool = new Pool({ connectionString: 'postgresql://postgres:rtzSUNwiBgsFSBEfaRxxqXUofflNVtbB@switchback.proxy.rlwy.net:46081/railway' });

async function main() {
  const rows = await pool.query('SELECT id, ssn, dob, id_image FROM claims ORDER BY id');
  console.log(`Found ${rows.rows.length} claims to check`);

  let updated = 0;
  for (const row of rows.rows) {
    const updates = {};

    // Encrypt SSN if plain text
    if (row.ssn && !isEncrypted(row.ssn)) {
      updates.ssn = encrypt(row.ssn);
    }

    // Encrypt DOB if plain text
    if (row.dob && !isEncrypted(row.dob)) {
      updates.dob = encrypt(row.dob);
    }

    // Encrypt ID image if raw binary (not already encrypted string)
    if (row.id_image) {
      const raw = row.id_image.toString('utf8');
      if (!isEncrypted(raw)) {
        // It's raw binary — encrypt it
        updates.id_image = Buffer.from(encrypt(row.id_image));
      }
    }

    if (Object.keys(updates).length > 0) {
      const setClauses = Object.keys(updates).map((k, i) => `${k}=$${i + 2}`).join(', ');
      const values = [row.id, ...Object.values(updates)];
      await pool.query(`UPDATE claims SET ${setClauses} WHERE id=$1`, values);
      console.log(`  [${row.id}] Encrypted: ${Object.keys(updates).join(', ')}`);
      updated++;
    } else {
      console.log(`  [${row.id}] Already encrypted — skipping`);
    }
  }

  console.log(`\nDone. ${updated}/${rows.rows.length} claims encrypted.`);
  pool.end();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
