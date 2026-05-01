'use strict';
/**
 * auto_fulfill.js
 *
 * Spawned by server.js after a customer submits their intake form.
 * Files the actual claim on the state portal on the customer's behalf.
 *
 * Strategy:
 *   1. States CA / FL / TX / PA → try direct state portal first (ZenRows)
 *   2. All states (including fallback for above) → missingmoney.com (ZenRows)
 *
 * Usage:  node auto_fulfill.js <claim_id>
 */

const { Pool }        = require('pg');
const { decrypt, isEncrypted } = require('./crypto-utils');
const { sendClaimConfirmedEmail } = require('./fulfillment');

// ── Config ───────────────────────────────────────────────────────────────────

const DB_URL      = process.env.DATABASE_URL
                 || 'postgresql://postgres:rtzSUNwiBgsFSBEfaRxxqXUofflNVtbB@switchback.proxy.rlwy.net:46081/railway';
const ZENROWS_KEY = process.env.ZENROWS_API_KEY  || '637d20b8c4d518bb5ccd2138db3709422b776b43';
const CAPSOLVER   = process.env.CAPSOLVER_KEY    || 'CAP-4EB76FB8E726068C6DF58985722B82E3C2DE39C815F7EE5139BBEE67FC1430CC';
const WSS         = `wss://browser.zenrows.com?apikey=${ZENROWS_KEY}`;

const pool = new Pool({ connectionString: DB_URL });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getClaimById(claimId) {
  const { rows } = await pool.query(
    `SELECT claim_id, first_name, last_name, dob, ssn, address, city, state, zip, email, phone
     FROM claims WHERE claim_id = $1`, [claimId]
  );
  return rows[0] || null;
}

async function upsertLog(claimId, fields) {
  const keys  = Object.keys(fields);
  const vals  = Object.values(fields);
  const setCols = keys.map((k, i) => `${k}=$${i + 2}`).concat('updated_at=NOW()').join(', ');
  const insCols = keys.join(', ');
  const insVals = vals.map((_, i) => `$${i + 2}`).join(', ');
  await pool.query(
    `INSERT INTO fulfillment_log (claim_id, ${insCols})
     VALUES ($1, ${insVals})
     ON CONFLICT (claim_id) DO UPDATE SET ${setCols}`,
    [claimId, ...vals]
  );
}

async function markClaimFulfilled(claimId) {
  await pool.query(`UPDATE claims SET status='fulfilled' WHERE claim_id=$1`, [claimId]);
}

// ── Capsolver reCAPTCHA v2 ────────────────────────────────────────────────────

async function solveRecaptcha(websiteURL, websiteKey) {
  const https = require('https');
  const post = (path, body) => new Promise((res, rej) => {
    const b = JSON.stringify(body);
    const req = https.request(
      { hostname: 'api.capsolver.com', path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }
    );
    req.on('error', rej); req.write(b); req.end();
  });

  const { taskId, errorId, errorDescription } = await post('/createTask', {
    clientKey: CAPSOLVER,
    task: { type: 'ReCaptchaV2Task', websiteURL, websiteKey, isInvisible: false }
  });
  if (errorId) throw new Error(`Capsolver createTask: ${errorDescription}`);

  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    const r = await post('/getTaskResult', { clientKey: CAPSOLVER, taskId });
    if (r.status === 'ready')  return r.solution.gRecaptchaResponse;
    if (r.status === 'failed') throw new Error(`Capsolver failed: ${r.errorDescription}`);
  }
  throw new Error('Capsolver timed out');
}

// ── Playwright helpers ────────────────────────────────────────────────────────

async function fillControlled(page, nameFragment, value) {
  // Fills React/Angular controlled inputs properly via keyboard + events
  const el = await page.$(`input[name*="${nameFragment}"]`);
  if (!el) return false;
  await el.click();
  await el.fill('');
  await el.type(value, { delay: 35 });
  await page.evaluate(el => {
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, el);
  return true;
}

async function clickBtn(page, label, timeout = 10000) {
  // Native Playwright click (triggers real pointer events React can intercept)
  const sel = `button:has-text("${label}")`;
  try {
    await page.waitForSelector(sel, { state: 'visible', timeout });
    await page.click(sel, { force: true });
    return true;
  } catch {
    // Fallback: dispatch MouseEvent
    return await page.evaluate(lbl => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => b.textContent.trim().toUpperCase().includes(lbl.toUpperCase()));
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    }, label);
  }
}

async function tryFill(page, sel, value) {
  try {
    const el = await page.$(sel);
    if (el && await el.isVisible()) { await el.fill(value); return true; }
  } catch { /* skip */ }
  return false;
}

// ── State portal filers ───────────────────────────────────────────────────────

async function fileCalifornia(c, page) {
  console.log(`  [CA] ${c.first} ${c.last}`);
  await page.goto('https://claimit.ca.gov', { timeout: 60000, waitUntil: 'domcontentloaded' });
  await sleep(4000);

  await page.fill('input[placeholder*="Last"]',  c.last);
  await page.fill('input[placeholder*="First"]', c.first);
  await page.click('button:has-text("SEARCH")');
  await sleep(12000);

  const body = await page.content();
  if (!body.toUpperCase().includes(c.last.toUpperCase())) return [false, 'No match'];

  const claimBtn = await page.$('a:has-text("CLAIM"), button:has-text("CLAIM")');
  if (!claimBtn) return [false, 'INFO only — property not yet transferred to state'];

  await claimBtn.click();
  await sleep(5000);

  const dobParts = c.dob.split('/');
  for (const [sel, val] of [
    ['input[name*="ssn"],input[id*="ssn"]',       c.ssn.replace(/-/g,'')],
    ['input[name*="dob"],input[id*="dob"]',        c.dob],
    ['input[name*="email"],input[id*="email"]',    c.email],
    ['input[name*="phone"],input[id*="phone"]',    c.phone],
    ['input[name*="address"],input[id*="address"]',c.address],
    ['input[name*="city"],input[id*="city"]',      c.city],
    ['input[name*="zip"],input[id*="zip"]',        c.zip],
  ]) await tryFill(page, sel, val);

  try {
    await page.selectOption('select[name*="month"],select[id*="month"]', dobParts[0]);
    await page.selectOption('select[name*="day"],select[id*="day"]',     dobParts[1]);
    await page.selectOption('select[name*="year"],select[id*="year"]',   dobParts[2]);
  } catch { /* dropdowns optional */ }

  await page.click('button:has-text("CONTINUE"),button:has-text("NEXT"),button[type=submit]');
  await sleep(5000);

  const body2 = await page.content();
  const m = body2.match(/\b\d{8,10}\b/);
  if (m || /confirmation|claim number|submitted|thank/i.test(body2)) return [true, m ? m[0] : 'Filed'];

  await page.screenshot({ path: `/tmp/zr_ca_${c.last}_unclear.png` });
  return [false, 'Unclear'];
}

async function fileFlorida(c, page) {
  console.log(`  [FL] ${c.first} ${c.last}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto('https://www.fltreasurehunt.gov/ClaimSearch', { timeout: 90000, waitUntil: 'networkidle' });
      await sleep(4000);

      await clickBtn(page, 'Person');
      await sleep(3000);
      await page.waitForSelector('input[name*="lastName"]', { state: 'visible', timeout: 15000 });

      await fillControlled(page, 'lastName',  c.last);
      await fillControlled(page, 'firstName', c.first);
      await fillControlled(page, 'city',      c.city);
      await sleep(5000); // Turnstile resolve time

      await clickBtn(page, 'SEARCH');

      try {
        await page.waitForSelector(
          '.search-results,[class*="result"],td,.no-records,[class*="noRecord"]',
          { timeout: 20000 }
        );
      } catch { /* ok */ }
      await sleep(3000);

      const body = await page.content();
      if (/No records found|no records/i.test(body) || !body.toUpperCase().includes(c.last.toUpperCase())) {
        return [false, 'No match'];
      }

      const cbs = await page.$$('input[type=checkbox]');
      for (const cb of cbs) {
        if (!await cb.getAttribute('checked')) await cb.click({ force: true }).catch(() => {});
      }
      await sleep(1000);

      await clickBtn(page, 'CONTINUE');
      await sleep(5000);

      for (const [frag, val] of [
        ['email', c.email], ['phone', c.phone],
        ['dob', c.dob], ['dateOfBirth', c.dob],
        ['ssn', c.ssn.replace(/-/g,'')],
        ['address', c.address], ['city', c.city], ['zip', c.zip],
      ]) await fillControlled(page, frag, val).catch(() => {});
      await sleep(1000);

      for (const lbl of ['SAVE','CONTINUE','SUBMIT']) {
        if (await clickBtn(page, lbl, 3000)) break;
      }
      await sleep(5000);

      const body2 = await page.content();
      const m = body2.match(/C\d{8,10}/);
      if (m || /one step away|claim form|emailed|confirmation/i.test(body2)) return [true, m ? m[0] : 'Filed'];

      await page.screenshot({ path: `/tmp/zr_fl_${c.last}_unclear.png` });
      return [false, 'Unclear'];

    } catch (err) {
      console.log(`  [FL] Attempt ${attempt} failed: ${err.message.slice(0,80)}`);
      if (attempt < 3) await sleep(8000);
      else return [false, `Failed after 3 attempts: ${err.message.slice(0,80)}`];
    }
  }
}

async function fileTexas(c, page) {
  console.log(`  [TX] ${c.first} ${c.last}`);
  await page.goto('https://www.claimittexas.gov', { timeout: 60000, waitUntil: 'domcontentloaded' });
  await sleep(3000);
  try {
    await page.click('a:has-text("CLAIMING PROPERTY"),button:has-text("GET STARTED")', { timeout: 5000 });
    await sleep(3000);
  } catch { /* already on search */ }

  await page.fill('#lastName,input[name*="lastName"]', c.last);
  await page.fill('#firstName,input[name*="firstName"]', c.first);
  await page.click('button[type=submit],input[type=submit]');
  await sleep(5000);

  const body = await page.content();
  if (!body.toUpperCase().includes(c.last.toUpperCase())) return [false, 'No match'];

  await page.evaluate(() =>
    document.querySelectorAll('input[type=checkbox]').forEach(cb => { if (!cb.checked) cb.click(); })
  );
  await sleep(1000);

  for (const txt of ['Add to Claim Cart','Continue']) {
    const btn = await page.$(`input[value*="${txt}"],button:has-text("${txt}"),a:has-text("${txt}")`);
    if (btn) { await btn.click(); break; }
  }
  await sleep(3000);

  for (const [sel, val] of [
    ['#email,input[name*="email"]', c.email],
    ['#phone,input[name*="phone"]', c.phone],
    ['#dateOfBirth,input[name*="dateOfBirth"]', c.dob],
    ['#ssn,input[name*="ssn"]', c.ssn.replace(/-/g,'')],
    ['#address,input[name*="address"]', c.address],
    ['#city,input[name*="city"]', c.city],
    ['#zip,input[name*="zip"]', c.zip],
  ]) await tryFill(page, sel, val);

  await page.click('input[type=submit],button[type=submit]');
  await sleep(4000);

  const body2 = await page.content();
  const m = body2.match(/\b\d{7,10}\b/);
  if (m || /confirmation|submitted/i.test(body2)) return [true, m ? m[0] : 'Filed'];

  await page.screenshot({ path: `/tmp/zr_tx_${c.last}_unclear.png` });
  return [false, 'Unclear'];
}

async function filePennsylvania(c, page) {
  console.log(`  [PA] ${c.first} ${c.last}`);
  await page.goto('https://unclaimedproperty.patreasury.gov/en/Property/SearchIndex', { timeout: 60000, waitUntil: 'domcontentloaded' });
  await sleep(3000);

  await page.fill('input[name*="lastName"],#lastName', c.last);
  await page.fill('input[name*="firstName"],#firstName', c.first);
  await page.click('button[type=submit],input[type=submit],button:has-text("Search")');
  await sleep(8000);

  const body = await page.content();
  if (!body.toUpperCase().includes(c.last.toUpperCase())) return [false, 'No match'];

  if (/g-recaptcha|recaptcha/i.test(body)) {
    try {
      console.log('  [PA] Solving reCAPTCHA...');
      const token = await solveRecaptcha(
        'https://unclaimedproperty.patreasury.gov/en/Property/SearchIndex',
        '6Lfldx0TAAAAADWOGNUBVxBpsGcELIH3AoiEnWxY'
      );
      await page.evaluate(t => {
        const el = document.getElementById('g-recaptcha-response');
        if (el) el.value = t;
        const cfg = window.___grecaptcha_cfg?.clients?.[0]?.l?.l;
        if (typeof cfg?.callback === 'function') cfg.callback(t);
      }, token);
      await sleep(2000);
    } catch (err) { console.warn('  [PA] Capsolver failed:', err.message); }
  }

  const claimBtn = await page.$('a:has-text("Claim"),button:has-text("Claim")');
  if (!claimBtn) return [false, 'No claim button'];
  await claimBtn.click();
  await sleep(4000);

  for (const [sel, val] of [
    ['input[name*="email"],input[id*="email"]', c.email],
    ['input[name*="phone"],input[id*="phone"]', c.phone],
    ['input[name*="ssn"],input[id*="ssn"]', c.ssn.replace(/-/g,'')],
  ]) await tryFill(page, sel, val);

  await page.click('button[type=submit],button:has-text("Submit")');
  await sleep(4000);

  const body2 = await page.content();
  const m = body2.match(/\b\d{7,12}\b/);
  if (m || /confirm|submitted/i.test(body2)) return [true, m ? m[0] : 'Filed'];
  return [false, 'Unclear'];
}

// ── MissingMoney.com — universal fallback for ALL states ──────────────────────

async function fileMissingMoney(c, page) {
  console.log(`  [MM] ${c.first} ${c.last} (${c.state})`);

  // Parse DOB into parts
  const dobParts = c.dob ? c.dob.split('/') : ['','',''];
  const [dobM, dobD, dobY] = dobParts.length === 3 ? dobParts : ['','',''];

  await page.goto('https://missingmoney.com', { timeout: 60000, waitUntil: 'networkidle' });
  await sleep(3000);

  // Fill search form
  await tryFill(page, '#lastNameTop,input[name*="lastName"]',  c.last)  ||
    await page.fill('input[placeholder*="Last"]', c.last).catch(() => {});
  await tryFill(page, '#firstNameTop,input[name*="firstName"]', c.first) ||
    await page.fill('input[placeholder*="First"]', c.first).catch(() => {});

  // Select the customer's state if dropdown exists
  try {
    await page.selectOption('select[name*="state"],select[id*="state"],#stateTop', c.state);
  } catch { /* search all states */ }

  await page.keyboard.press('Enter');
  await sleep(5000);

  const body = await page.content();
  if (!body.toUpperCase().includes(c.last.toUpperCase())) return [false, 'No match on MissingMoney'];

  console.log(`  [MM] Match found — adding to cart`);

  // Click CLAIM on all matching results (up to 10)
  const claimBtns = await page.$$('button:has-text("CLAIM"),a:has-text("CLAIM"),button:has-text("Claim")');
  let added = 0;
  for (const btn of claimBtns.slice(0, 10)) {
    try {
      const txt = (await btn.innerText()).trim().toUpperCase();
      if (txt.includes('CLAIM') && !txt.includes('REMOVE')) {
        await btn.click();
        await sleep(600);
        added++;
      }
    } catch { /* skip */ }
  }

  if (added === 0) return [false, 'No claimable properties on MissingMoney'];

  // Navigate to cart
  try {
    await page.click('a:has-text("VIEW CLAIMED"),button:has-text("VIEW CLAIMED"),a[href*="claim-cart"]', { timeout: 5000 });
  } catch {
    await page.goto('https://missingmoney.com/app/claim-cart', { timeout: 30000, waitUntil: 'networkidle' });
  }
  await sleep(3000);

  // Relationship dropdown
  try { await page.selectOption('select[name*="relationship"],select[name*="claimant"]', { label: 'Myself' }); } catch { /* */ }

  // Click FILE CLAIM
  await page.click('button:has-text("FILE CLAIM"),a:has-text("FILE CLAIM"),button:has-text("File Claim")').catch(() => {});
  await sleep(3000);

  // Fill contact info
  await tryFill(page, '#lastName,input[name*="lastName"]', c.last);
  await tryFill(page, '#firstName,input[name*="firstName"]', c.first);

  // DOB dropdowns
  if (dobM) {
    try { await page.selectOption('select[name*="month"],select[id*="month"]', dobM); } catch { /* */ }
    try { await page.selectOption('select[name*="day"],select[id*="day"]', dobD); }   catch { /* */ }
    try { await page.selectOption('select[name*="year"],select[id*="year"]', dobY); } catch { /* */ }
  }

  await tryFill(page, 'input[name*="email"],input[id*="email"]', c.email);
  // Confirm email field if present
  try {
    const conf = await page.$('input[name*="confirm"],input[name*="Confirm"]');
    if (conf) await conf.fill(c.email);
  } catch { /* */ }

  await tryFill(page, 'input[name*="phone"],input[id*="phone"]', c.phone);

  await page.screenshot({ path: `/tmp/mm_${c.last}_filled.png` });

  // NEXT → preview → submit
  for (const lbl of ['NEXT','Next']) {
    if (await clickBtn(page, lbl, 5000)) break;
  }
  await sleep(3000);

  for (const lbl of ['NEXT','Submit','SUBMIT']) {
    try { await page.click(`button:has-text("${lbl}"),button[type=submit]`, { timeout: 4000 }); break; } catch { /* */ }
  }
  await sleep(3000);

  const body2 = await page.content();
  await page.screenshot({ path: `/tmp/mm_${c.last}_result.png` });

  if (/summary|submitted|confirmation|claim number|successfully/i.test(body2)) {
    const m = body2.match(/\b[A-Z0-9]{6,12}\b/);
    return [true, m ? m[0] : 'Filed-MM'];
  }
  return [false, 'MissingMoney — unclear result'];
}

// ── Direct portal map ─────────────────────────────────────────────────────────

const DIRECT_FILERS = {
  CA: fileCalifornia,
  FL: fileFlorida,
  TX: fileTexas,
  PA: filePennsylvania,
};

// ── Orchestrator ──────────────────────────────────────────────────────────────

async function fulfill(claimId) {
  console.log(`[auto_fulfill] Claim ${claimId}`);

  const row = await getClaimById(claimId);
  if (!row) { console.error('[auto_fulfill] Claim not found'); process.exit(1); }

  const c = {
    first:   row.first_name,
    last:    row.last_name,
    email:   row.email,
    state:   (row.state || '').trim().toUpperCase(),
    ssn:     row.ssn ? (isEncrypted(row.ssn) ? decrypt(row.ssn) : row.ssn) : '',
    dob:     row.dob ? (isEncrypted(row.dob) ? decrypt(row.dob) : row.dob) : '',
    phone:   row.phone   || '',
    address: row.address || '',
    city:    row.city    || '',
    zip:     row.zip     || '',
  };

  console.log(`[auto_fulfill] ${c.first} ${c.last} | ${c.state} | ${c.email}`);

  await upsertLog(claimId, {
    email: c.email, first_name: c.first, last_name: c.last,
    state: c.state, status: 'running', attempts: 1
  });

  let filed = false, detail = '';
  const { chromium } = require('playwright');

  let browser;
  try {
    browser = await chromium.connectOverCDP(WSS);
    const context = browser.contexts[0] || await browser.newContext();

    // 1. Try direct state portal if supported
    if (DIRECT_FILERS[c.state]) {
      console.log(`[auto_fulfill] Trying direct portal for ${c.state}...`);
      const page = await context.newPage();
      try {
        [filed, detail] = await DIRECT_FILERS[c.state](c, page);
      } catch (err) {
        detail = err.message.slice(0, 120);
        console.log(`[auto_fulfill] Direct portal error: ${detail}`);
      }
      await page.close();
    }

    // 2. If direct portal failed or state not supported, try MissingMoney
    if (!filed) {
      const reason = detail || 'no direct portal';
      console.log(`[auto_fulfill] Direct portal: ${reason} — falling back to MissingMoney.com`);
      const page = await context.newPage();
      try {
        [filed, detail] = await fileMissingMoney(c, page);
      } catch (err) {
        detail = err.message.slice(0, 120);
        console.log(`[auto_fulfill] MissingMoney error: ${detail}`);
      }
      await page.close();
    }

    await browser.close();
  } catch (err) {
    console.error('[auto_fulfill] Browser error:', err.message);
    try { if (browser) await browser.close(); } catch { /* */ }
    detail = err.message.slice(0, 200);
  }

  // ── Persist result ────────────────────────────────────────────────────────
  if (filed) {
    console.log(`[auto_fulfill] FILED: ${c.first} ${c.last} (${c.state}) — ${detail}`);
    await upsertLog(claimId, { status: 'filed', portal_claim_id: detail });
    await markClaimFulfilled(claimId);
    await sendClaimConfirmedEmail(c.email, detail, c.first);
  } else {
    console.log(`[auto_fulfill] NOT FILED: ${c.first} ${c.last} (${c.state}) — ${detail}`);
    const isNoMatch = /no match|no record/i.test(detail);
    await upsertLog(claimId, {
      status:     isNoMatch ? 'no_match' : 'error',
      last_error: detail
    });
    // Leave claim status unchanged — admin reviews errors and no-matches
  }

  await pool.end();
}

// ── Entry ─────────────────────────────────────────────────────────────────────
const claimId = process.argv[2];
if (!claimId) { console.error('Usage: node auto_fulfill.js <claim_id>'); process.exit(1); }
fulfill(claimId).catch(err => { console.error('[auto_fulfill] Fatal:', err); process.exit(1); });
