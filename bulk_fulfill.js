'use strict';
/**
 * Bulk fulfillment script — sends PDF reports to all pending claims
 * Run: node bulk_fulfill.js
 */
const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:rtzSUNwiBgsFSBEfaRxxqXUofflNVtbB@switchback.proxy.rlwy.net:46081/railway' });

// Load report generator + PDF + email
const { generateReportHTML, searchUnclaimedProperty, SETTLEMENTS, FEDERAL_SOURCES } = require('./report-generator');
const { htmlToPdf } = require('./report-pdf');
const { sendReportEmail } = require('./fulfillment');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fulfillClaim(claim) {
  const { id, claim_id, first_name, last_name, email, city, state } = claim;
  const claimCity = city || '';
  const claimState = state || 'CA'; // default CA if not set

  console.log(`\n[${id}] Fulfilling: ${first_name} ${last_name} <${email}>`);

  try {
    const reportDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // Search unclaimed property for this person
    const unclaimedRecords = await searchUnclaimedProperty(first_name, last_name, claimState);
    console.log(`  Found ${unclaimedRecords.length} unclaimed records for ${first_name} ${last_name}`);

    const matchedSettlements = SETTLEMENTS;

    // Generate HTML report
    const html = generateReportHTML({
      firstName: first_name, lastName: last_name,
      city: claimCity, state: claimState,
      unclaimedRecords, settlements: matchedSettlements, reportDate
    });

    // Convert to PDF
    const pdfData = {
      firstName: first_name, lastName: last_name,
      city: claimCity, state: claimState,
      unclaimedRecords, settlements: matchedSettlements,
      federalSources: FEDERAL_SOURCES, reportDate
    };
    const pdfBuffer = await htmlToPdf(html, pdfData);
    console.log(`  PDF generated: ${Math.round(pdfBuffer.length / 1024)}KB`);

    // Send report email
    await sendReportEmail(email.trim(), first_name.trim(), pdfBuffer);
    console.log(`  ✓ Report emailed to ${email}`);

    // Mark claim as fulfilled in DB
    await pool.query(
      `UPDATE claims SET status='fulfilled' WHERE id=$1`,
      [id]
    );
    console.log(`  ✓ Claim ${claim_id} marked as fulfilled`);

    return true;
  } catch (err) {
    console.error(`  ✗ Error fulfilling claim ${claim_id}:`, err.message);
    return false;
  }
}

async function main() {
  // Get all pending claims (skip test accounts)
  const result = await pool.query(`
    SELECT id, claim_id, first_name, last_name, email, city, state, submitted_at
    FROM claims
    WHERE status = 'pending'
    AND email NOT IN ('zacharrow3@gmail.com')
    ORDER BY submitted_at ASC
  `);

  // Deduplicate by email (some people submitted twice)
  const seen = new Set();
  const claims = result.rows.filter(r => {
    if (seen.has(r.email)) return false;
    seen.add(r.email);
    return true;
  });

  console.log(`\nFulfilling ${claims.length} unique claims (${result.rows.length} total, ${result.rows.length - claims.length} duplicates skipped)\n`);

  let success = 0, failed = 0;

  for (const claim of claims) {
    const ok = await fulfillClaim(claim);
    if (ok) success++;
    else failed++;
    // Rate limit: don't hammer SendGrid
    await sleep(500);
  }

  // Also mark duplicate submissions as fulfilled
  await pool.query(`
    UPDATE claims SET status='fulfilled'
    WHERE status='pending' AND email NOT IN ('zacharrow3@gmail.com')
  `);

  console.log(`\n=== DONE ===`);
  console.log(`Fulfilled: ${success} | Failed: ${failed}`);
  console.log(`Total pending → fulfilled`);

  pool.end();
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
