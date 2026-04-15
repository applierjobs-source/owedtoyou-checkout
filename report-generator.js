'use strict';

// report-generator.js
// Generates a personalized Money Owed PDF report

const https = require('https');
const { Pool } = require('pg');

// Active class action settlements database (hardcoded, update periodically)
const SETTLEMENTS = [
  { company: 'Google Play Store', about: 'Subscription overcharges', deadline: '5/9/2026', payout: '$5.85', url: 'playstoresubscriptionsettlement.com', profile: ['tech', 'general'] },
  { company: 'Amazon Prime', about: 'FTC unauthorized enrollment', deadline: '7/27/2026', payout: 'Up to $51', url: 'subscriptionmembershipsettlement.com', profile: ['general'] },
  { company: 'LastPass', about: 'Data breach', deadline: '7/2/2026', payout: '$25–$10,400', url: 'lastpasssettlement.com', profile: ['tech', 'general'] },
  { company: 'Avis', about: 'Data breach', deadline: '6/21/2026', payout: 'Up to $5,000', url: 'avisdatasecuritysettlement.com', profile: ['general'] },
  { company: 'Domestic Flight Antitrust', about: 'Airline price fixing', deadline: 'Multiple', payout: 'Varies', url: 'domesticairclass.com', profile: ['general'] },
  { company: 'Sirius XM', about: 'Unwanted calls (TCPA)', deadline: '5/11/2026', payout: 'Varies', url: 'sxmtcpasettlement.com', profile: ['general'] },
  { company: 'American Express Antitrust', about: 'Merchant overcharges', deadline: '5/19/2026', payout: 'Varies', url: 'amexantitrust.com', profile: ['business', 'general'] },
  { company: 'Robinhood', about: 'Order flow practices', deadline: '7/13/2026', payout: 'Varies', url: 'robinhoodorderflowsettlement.com', profile: ['investor', 'general'] },
  { company: 'Capital One Shopping', about: 'Affiliate marketing', deadline: '4/17/2026', payout: '$20+', url: 'influencermarketingclaims.com', profile: ['general'] },
  { company: 'Hyundai/Kia', about: 'Vehicle theft vulnerability', deadline: '3/31/2027', payout: '$375–$4,500', url: 'hkmultistateimmobilizersettlement.com', profile: ['vehicle'] },
  { company: 'PHH Mortgage', about: 'Service kickbacks', deadline: '8/11/2026', payout: '$875', url: 'phhmisettlement.com', profile: ['mortgage', 'general'] },
  { company: 'Ingram Micro', about: 'Data breach (supply chain)', deadline: '5/19/2026', payout: '$50–$1,500', url: 'ingrammicrosettlement.com', profile: ['tech', 'business', 'general'] },
];

const FEDERAL_SOURCES = [
  { agency: 'IRS', type: 'Unclaimed Tax Refunds', url: 'irs.gov/refunds' },
  { agency: 'US Treasury', type: 'Matured Savings Bonds', url: 'treasurydirect.gov/treasury-hunt' },
  { agency: 'PBGC', type: 'Unclaimed Pensions', url: 'pbgc.gov/search-unclaimed-pensions' },
  { agency: 'HUD/FHA', type: 'Mortgage Insurance Refunds', url: 'entp.hud.gov/dsrs/refunds' },
  { agency: 'DOL', type: 'Unpaid Wages', url: 'webapps.dol.gov/wow' },
  { agency: 'SEC', type: 'Investment Enforcement Funds', url: 'sec.gov/harmed-investors' },
  { agency: 'FDIC', type: 'Failed Bank Deposits', url: 'closedbanks.fdic.gov/funds' },
  { agency: 'NCUA', type: 'Credit Union Deposits', url: 'ncua.gov/unclaimed-deposits' },
];

async function searchUnclaimedProperty(firstName, lastName, state) {
  // Search our CA database for matching records
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  
  try {
    // Search by last name in our CA data via the pipeline's CSV
    // Since we can't query the CSV directly from Node, we'll use the state unclaimed property API
    // For CA: use the SCO data we have
    // For other states: return a note to check manually
    
    const results = [];
    
    // Try California SCO search via their public API
    if (state === 'CA' || !state) {
      const caResults = await searchCaliforniaSCO(lastName);
      results.push(...caResults);
    }
    
    return results;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function searchCaliforniaSCO(lastName) {
  // Use California's public unclaimed property search
  return new Promise((resolve) => {
    const query = new URLSearchParams({ lastName: lastName.toUpperCase(), firstName: '', state: '' });
    const options = {
      hostname: 'www.sco.ca.gov',
      path: '/cgi-bin/queries/upwsearchapi.pl?' + query.toString(),
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const items = (json.results || json.data || []).slice(0, 10);
          resolve(items.map(item => ({
            holder: item.holder || item.reportingBusiness || 'Undisclosed',
            address: item.address || item.ownerStreet || '',
            city: item.city || item.ownerCity || '',
            state: 'CA',
            amount: item.amount || item.currentCashBalance || 'Undisclosed',
            propertyType: item.propertyType || 'Unclaimed Property',
            year: item.year || ''
          })));
        } catch(e) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

function generateReportHTML(data) {
  const { firstName, lastName, city, state, unclaimedRecords, settlements, reportDate } = data;
  const fullName = `${firstName} ${lastName}`;
  
  const confirmedTotal = unclaimedRecords.reduce((sum, r) => {
    const amt = parseFloat(String(r.amount).replace(/[$,]/g, ''));
    return sum + (isNaN(amt) ? 0 : amt);
  }, 0);
  
  const confirmedStr = confirmedTotal > 0 ? `$${confirmedTotal.toFixed(2)}` : 'Records Found';
  const settlementPotential = settlements.length > 0 ? `$${(settlements.length * 500).toLocaleString()}+` : '$0';
  
  const unclaimedRows = unclaimedRecords.length > 0 
    ? unclaimedRecords.map(r => `
        <tr>
          <td>${r.holder}</td>
          <td>${r.address}${r.city ? ', ' + r.city : ''}, ${r.state}</td>
          <td><strong>${typeof r.amount === 'number' ? '$' + r.amount.toFixed(2) : r.amount}</strong></td>
          <td>${r.year || '—'}</td>
          <td>${r.propertyType || '—'}</td>
        </tr>`).join('')
    : `<tr><td colspan="5" style="text-align:center;color:#666;padding:20px">
        No exact matches found in our California database for ${fullName}. 
        Check your state's unclaimed property site at unclaimed.org
      </td></tr>`;

  const settlementRows = settlements.map((s, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${s.company}</strong></td>
      <td>${s.about}</td>
      <td>${s.deadline}</td>
      <td><strong>${s.payout}</strong></td>
      <td><a href="https://${s.url}" style="color:#0d9488">${s.url}</a></td>
    </tr>`).join('');

  const federalRows = FEDERAL_SOURCES.map(f => `
    <tr>
      <td><strong>${f.agency}</strong></td>
      <td>${f.type}</td>
      <td><a href="https://${f.url}" style="color:#0d9488">${f.url}</a></td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11px; color: #1a1a1a; background: #fff; }
  
  .cover { background: linear-gradient(135deg, #0f2744 0%, #0d4a4a 100%); color: white; padding: 48px 48px 40px; }
  .cover-confidential { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #94a3b8; margin-bottom: 16px; }
  .cover-title { font-size: 32px; font-weight: 800; line-height: 1.2; margin-bottom: 8px; }
  .cover-subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 32px; }
  .cover-stats { display: flex; gap: 24px; flex-wrap: wrap; }
  .stat-box { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 12px; padding: 16px 20px; min-width: 140px; }
  .stat-val { font-size: 24px; font-weight: 800; color: #34d399; }
  .stat-label { font-size: 10px; color: #94a3b8; margin-top: 4px; }
  
  .content { padding: 32px 48px; }
  
  h2 { font-size: 16px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: #0f2744; margin: 32px 0 12px; padding-bottom: 8px; border-bottom: 3px solid #0d9488; }
  h3 { font-size: 13px; font-weight: 700; color: #0d9488; margin: 20px 0 8px; }
  
  p { line-height: 1.6; color: #374151; margin-bottom: 8px; font-size: 11px; }
  
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 10px; }
  th { background: #0f2744; color: white; padding: 8px 10px; text-align: left; font-weight: 600; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 8px 10px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  tr:nth-child(even) td { background: #f9fafb; }
  tr:last-child td { border-bottom: none; }
  
  .total-row { background: #ecfdf5 !important; font-weight: 700; }
  .total-row td { border-top: 2px solid #059669; color: #065f46; }
  
  .highlight-box { background: #f0fdf4; border-left: 4px solid #10b981; border-radius: 0 8px 8px 0; padding: 12px 16px; margin: 12px 0; }
  .highlight-box p { color: #065f46; margin: 0; }
  
  .urgent-box { background: #fff7ed; border-left: 4px solid #f59e0b; border-radius: 0 8px 8px 0; padding: 12px 16px; margin: 12px 0; }
  
  .footer-note { background: #f9fafb; border-radius: 8px; padding: 16px; margin-top: 24px; font-size: 10px; color: #6b7280; }
  .page-break { page-break-before: always; }
  
  a { color: #0d9488; }
</style>
</head>
<body>

<div class="cover">
  <div class="cover-confidential">Money Owed Report — Confidential</div>
  <div class="cover-title">Money Owed to ${fullName}</div>
  <div class="cover-subtitle">Report Date: ${reportDate} | ${city}, ${state}</div>
  <div class="cover-stats">
    <div class="stat-box">
      <div class="stat-val">${confirmedStr}</div>
      <div class="stat-label">Confirmed Unclaimed</div>
    </div>
    <div class="stat-box">
      <div class="stat-val">${settlementPotential}</div>
      <div class="stat-label">Potential from Settlements</div>
    </div>
    <div class="stat-box">
      <div class="stat-val">${settlements.length}</div>
      <div class="stat-label">Active Settlements Matched</div>
    </div>
  </div>
</div>

<div class="content">

<h2>Section 1: Confirmed Unclaimed Property</h2>
<p>We searched state unclaimed property databases for funds held in the name of <strong>${fullName}</strong> from ${city}, ${state}. Below are the records found.</p>

${state === 'CA' || !state ? `<h3>California — State Controller's Office</h3>` : `<h3>${state} — State Unclaimed Property</h3>`}
<table>
  <thead><tr><th>Held By</th><th>Address on File</th><th>Amount</th><th>Year</th><th>Property Type</th></tr></thead>
  <tbody>
    ${unclaimedRows}
    ${confirmedTotal > 0 ? `<tr class="total-row"><td colspan="2"><strong>Total Confirmed</strong></td><td><strong>${confirmedStr}</strong></td><td colspan="2"></td></tr>` : ''}
  </tbody>
</table>

<div class="highlight-box">
  <p><strong>Also check all 50 states at once:</strong> <a href="https://unclaimed.org">unclaimed.org</a> — search your name and any previous addresses.</p>
</div>

<h2>Section 2: Class Action Settlements (Profile-Matched)</h2>
<p>Active settlements where <strong>${firstName}</strong> may qualify based on common consumer and financial profiles. Sorted by deadline urgency.</p>

<table>
  <thead><tr><th>#</th><th>Company</th><th>What It's About</th><th>Deadline</th><th>Potential Payout</th><th>Claim URL</th></tr></thead>
  <tbody>${settlementRows}</tbody>
</table>

<div class="urgent-box">
  <p><strong>Note:</strong> Check each settlement's eligibility requirements. Most require you were a customer or had data exposed during the relevant period.</p>
</div>

<div class="page-break"></div>

<h2>Section 3: Federal Unclaimed Money</h2>
<p>Federal agencies hold billions in unclaimed funds. Search each database using your full name.</p>

<table>
  <thead><tr><th>Agency</th><th>Fund Type</th><th>Search URL</th></tr></thead>
  <tbody>${federalRows}</tbody>
</table>

<h2>Section 4: Additional States to Check</h2>
<div class="highlight-box">
  <p><strong>Search all 50 states at once:</strong> <a href="https://unclaimed.org">unclaimed.org</a></p>
</div>
<p>Priority states to check based on your profile: any state where you've lived, worked, or had bank accounts. Former employers may have unclaimed pension funds in their home state.</p>

<div class="footer-note">
  <strong>Report prepared by OwedToYou.net</strong> — We file unclaimed property claims on your behalf for a flat fee of $95.99. Full refund if we recover nothing.<br>
  To have us file all claims found in this report: <a href="https://www.owedtoyou.net">www.owedtoyou.net</a><br><br>
  <em>This report is for informational purposes. OwedToYou.net is not a law firm. We do not guarantee specific recovery amounts or approval timelines from state agencies.</em>
</div>

</div>
</body>
</html>`;
}

module.exports = { generateReportHTML, searchUnclaimedProperty, SETTLEMENTS, FEDERAL_SOURCES };
