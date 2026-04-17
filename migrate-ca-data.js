// migrate-ca-data.js
// Loads CA unclaimed property CSV into Postgres for fast name lookups
// Runs on server startup, skips if already loaded
'use strict';
const { Pool } = require('pg');
const fs = require('fs');
const readline = require('readline');
const path = require('path');

async function migrate() {
  if (!process.env.DATABASE_URL) return;
  
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    // Create table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ca_unclaimed (
        id SERIAL PRIMARY KEY,
        full_name TEXT,
        first_name TEXT,
        last_name TEXT,
        address TEXT,
        city TEXT,
        state TEXT,
        zip TEXT,
        holder TEXT,
        amount NUMERIC
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ca_first_name ON ca_unclaimed(UPPER(first_name))');

    // Check if already loaded
    const count = await pool.query('SELECT COUNT(*) FROM ca_unclaimed');
    if (parseInt(count.rows[0].count) > 100000) {
      console.log('[migrate] CA data already loaded:', count.rows[0].count, 'records');
      return;
    }

    // Find CSV — check multiple locations
    const candidates = [
      '/home/user/workspace/ca_unclaimed_clean.csv',
      path.join(__dirname, '..', 'ca_unclaimed_clean.csv'),
      path.join(__dirname, 'ca_unclaimed_clean.csv'),
    ];
    const csvPath = candidates.find(p => fs.existsSync(p));
    if (!csvPath) {
      console.log('[migrate] CA CSV not found, skipping migration');
      return;
    }

    console.log('[migrate] Loading CA data from', csvPath, '...');
    const rl = readline.createInterface({ input: fs.createReadStream(csvPath) });
    let header = null;
    let batch = [];
    let total = 0;

    for await (const line of rl) {
      if (!header) { header = line.split(','); continue; }
      const cols = line.split(',');
      if (cols.length < 6) continue;

      const fullName = (cols[0] || '').replace(/"/g,'').trim();
      const address  = (cols[1] || '').replace(/"/g,'').trim();
      const city     = (cols[2] || '').replace(/"/g,'').trim();
      const state    = (cols[3] || '').replace(/"/g,'').trim();
      const zip      = (cols[4] || '').replace(/"/g,'').trim();
      const holder   = (cols[5] || '').replace(/"/g,'').trim();
      const amount   = parseFloat((cols[6] || '0').replace(/"/g,'')) || 0;

      if (!fullName || !address || amount < 500) continue;

      const parts = fullName.split(' ');
      const lastName  = parts[0] || '';
      const firstName = parts[1] || '';

      batch.push([fullName, firstName, lastName, address, city, state, zip, holder, amount]);

      if (batch.length >= 500) {
        const ph = batch.map((_, i) =>
          `($${i*9+1},$${i*9+2},$${i*9+3},$${i*9+4},$${i*9+5},$${i*9+6},$${i*9+7},$${i*9+8},$${i*9+9})`
        ).join(',');
        await pool.query(
          `INSERT INTO ca_unclaimed (full_name,first_name,last_name,address,city,state,zip,holder,amount) VALUES ${ph}`,
          batch.flat()
        );
        total += batch.length;
        batch = [];
        if (total % 100000 === 0) console.log('[migrate] Loaded', total, 'records...');
      }
    }

    if (batch.length > 0) {
      const ph = batch.map((_, i) =>
        `($${i*9+1},$${i*9+2},$${i*9+3},$${i*9+4},$${i*9+5},$${i*9+6},$${i*9+7},$${i*9+8},$${i*9+9})`
      ).join(',');
      await pool.query(
        `INSERT INTO ca_unclaimed (full_name,first_name,last_name,address,city,state,zip,holder,amount) VALUES ${ph}`,
        batch.flat()
      );
      total += batch.length;
    }

    console.log('[migrate] Complete!', total, 'records loaded into ca_unclaimed');
  } finally {
    await pool.end().catch(() => {});
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate().catch(e => { console.error(e); process.exit(1); });
}
