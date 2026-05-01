'use strict';
/**
 * auto_fulfill.js
 *
 * Spawned by server.js after a customer submits their intake form.
 * Files the actual claim on the customer's behalf — every state, no PDF.
 *
 * Filing order per customer:
 *   1. MissingMoney.com  — covers ~42 states in one consistent UI
 *   2. Direct state portal — fallback if MM fails or returns no match
 *
 * States with dedicated direct portal filers:
 *   CA, FL, TX, PA, OH, CT, VA, OR, MN, MO, DE, NC, GA, IN, IL, UT, WA, CO, AZ
 *
 * For any other state not listed: MissingMoney only.
 *
 * Usage:  node auto_fulfill.js <claim_id>
 */

const { Pool }              = require('pg');
const { decrypt, isEncrypted } = require('./crypto-utils');
const { sendClaimConfirmedEmail } = require('./fulfillment');

// ── Config ────────────────────────────────────────────────────────────────────

const DB_URL    = process.env.DATABASE_URL
               || 'postgresql://postgres:rtzSUNwiBgsFSBEfaRxxqXUofflNVtbB@switchback.proxy.rlwy.net:46081/railway';
const ZR_KEY    = process.env.ZENROWS_API_KEY || '637d20b8c4d518bb5ccd2138db3709422b776b43';
const CAP_KEY   = process.env.CAPSOLVER_KEY   || 'CAP-4EB76FB8E726068C6DF58985722B82E3C2DE39C815F7EE5139BBEE67FC1430CC';
const WSS       = `wss://browser.zenrows.com?apikey=${ZR_KEY}`;

const pool  = new Pool({ connectionString: DB_URL });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getClaimById(id) {
  const { rows } = await pool.query(
    `SELECT claim_id, first_name, last_name, dob, ssn, address, city, state, zip, email, phone
     FROM claims WHERE claim_id = $1`, [id]
  );
  return rows[0] || null;
}

async function upsertLog(claimId, fields) {
  const keys  = Object.keys(fields);
  const vals  = Object.values(fields);
  const ins   = keys.map((k, i) => `$${i+2}`).join(', ');
  const upd   = keys.map((k, i) => `${k}=$${i+2}`).concat('updated_at=NOW()').join(', ');
  await pool.query(
    `INSERT INTO fulfillment_log (claim_id,${keys.join(',')}) VALUES ($1,${ins})
     ON CONFLICT (claim_id) DO UPDATE SET ${upd}`,
    [claimId, ...vals]
  );
}

async function markFulfilled(claimId) {
  await pool.query(`UPDATE claims SET status='fulfilled' WHERE claim_id=$1`, [claimId]);
}

// ── Capsolver reCAPTCHA v2 ────────────────────────────────────────────────────

async function solveRecaptcha(websiteURL, websiteKey) {
  const https = require('https');
  const post  = (path, body) => new Promise((res, rej) => {
    const b = JSON.stringify(body);
    const req = https.request(
      { hostname:'api.capsolver.com', path, method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)} },
      r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }
    );
    req.on('error',rej); req.write(b); req.end();
  });
  const { taskId, errorId, errorDescription } = await post('/createTask', {
    clientKey: CAP_KEY,
    task: { type:'ReCaptchaV2Task', websiteURL, websiteKey, isInvisible:false }
  });
  if (errorId) throw new Error(`Capsolver: ${errorDescription}`);
  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    const r = await post('/getTaskResult', { clientKey:CAP_KEY, taskId });
    if (r.status==='ready')  return r.solution.gRecaptchaResponse;
    if (r.status==='failed') throw new Error(`Capsolver failed: ${r.errorDescription}`);
  }
  throw new Error('Capsolver timed out');
}

// ── Playwright helpers ────────────────────────────────────────────────────────

/** Fill a React/Angular controlled input with real keyboard events */
async function typeInto(page, selector, value) {
  const el = typeof selector === 'string' ? await page.$(selector) : selector;
  if (!el) return false;
  await el.click();
  await el.fill('');
  await el.type(value, { delay: 35 });
  await page.evaluate(el => {
    el.dispatchEvent(new Event('input',  { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
  }, el);
  return true;
}

/** Fill via name fragment — for React portals */
async function fillNamed(page, fragment, value) {
  return typeInto(page, await page.$(`input[name*="${fragment}"]`), value);
}

/** Fill a selector quietly — skip if not found/visible */
async function tryFill(page, sel, value) {
  try {
    const el = await page.$(sel);
    if (el && await el.isVisible()) { await el.fill(value); return true; }
  } catch { /* */ }
  return false;
}

/** Click a button by visible text, native Playwright + MouseEvent fallback */
async function clickBtn(page, label, timeout=10000) {
  const sel = `button:has-text("${label}")`;
  try {
    await page.waitForSelector(sel, { state:'visible', timeout });
    await page.click(sel, { force:true });
    return true;
  } catch {
    return await page.evaluate(lbl => {
      const b = [...document.querySelectorAll('button')]
        .find(b => b.textContent.trim().toUpperCase().includes(lbl.toUpperCase()));
      if (!b) return false;
      b.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true }));
      return true;
    }, label);
  }
}

// ── Generic NAUPA-standard portal filer ──────────────────────────────────────
// Most state portals share the same pattern: search → CLAIM → contact form → submit
// This handles ~15 states with only the URL varying.

async function fileGenericNAUPA(c, page, searchUrl, opts = {}) {
  const {
    lastSel  = 'input[name*="lastName"],input[id*="lastName"],input[placeholder*="Last"]',
    firstSel = 'input[name*="firstName"],input[id*="firstName"],input[placeholder*="First"]',
    citySel  = 'input[name*="city"],input[id*="city"]',
    searchBtn = 'Search',
    claimBtn  = 'Claim',
    useReactFill = false,        // set true for Angular/React portals needing typeInto
    recaptchaKey = null,         // site reCAPTCHA key if applicable
  } = opts;

  await page.goto(searchUrl, { timeout: 60000, waitUntil: 'domcontentloaded' });
  await sleep(4000);

  if (useReactFill) {
    await fillNamed(page, 'lastName',  c.last);
    await fillNamed(page, 'firstName', c.first);
    if (citySel) await fillNamed(page, 'city', c.city);
    await sleep(5000);
    await clickBtn(page, searchBtn.toUpperCase());
  } else {
    await tryFill(page, lastSel,  c.last);
    await tryFill(page, firstSel, c.first);
    await tryFill(page, citySel,  c.city);
    await sleep(2000);
    try {
      await page.click(`button:has-text("${searchBtn}"),input[value*="${searchBtn}"],button[type=submit]`);
    } catch {
      await page.keyboard.press('Enter');
    }
  }

  // Handle reCAPTCHA if present
  if (recaptchaKey) {
    try {
      const body0 = await page.content();
      if (/g-recaptcha|recaptcha/i.test(body0)) {
        console.log(`  Solving reCAPTCHA for ${searchUrl}...`);
        const token = await solveRecaptcha(searchUrl, recaptchaKey);
        await page.evaluate(t => {
          const el = document.getElementById('g-recaptcha-response');
          if (el) el.value = t;
          const cfg = window.___grecaptcha_cfg?.clients?.[0]?.l?.l;
          if (typeof cfg?.callback === 'function') cfg.callback(t);
        }, token);
        await sleep(2000);
      }
    } catch (err) { console.warn('  reCAPTCHA solve failed:', err.message); }
  }

  try {
    await page.waitForSelector(`button:has-text("${claimBtn}"),a:has-text("${claimBtn}")`, { timeout: 15000 });
  } catch { /* check content anyway */ }
  await sleep(2000);

  const body = await page.content();
  if (!body.toUpperCase().includes(c.last.toUpperCase())) return [false, 'No match'];

  // Click CLAIM on first result using reliable clickBtn (not elementHandle)
  const clicked = await clickBtn(page, claimBtn, 8000);
  if (!clicked) return [false, 'No claim button found'];
  await sleep(4000);

  // Fill contact info
  const ssn = c.ssn.replace(/-/g,'');
  for (const [sel, val] of [
    ['input[name*="lastName"],input[id*="lastName"]',   c.last],
    ['input[name*="firstName"],input[id*="firstName"]', c.first],
    ['input[name*="email"],input[id*="email"]',         c.email],
    ['input[name*="phone"],input[id*="phone"]',         c.phone],
    ['input[name*="ssn"],input[id*="ssn"]',             ssn],
    ['input[name*="dob"],input[id*="dob"]',             c.dob],
    ['input[name*="address"],input[id*="address"]',     c.address],
    ['input[name*="city"],input[id*="city"]',           c.city],
    ['input[name*="zip"],input[id*="zip"]',             c.zip],
  ]) await tryFill(page, sel, val);

  // DOB dropdowns
  const [dobM, dobD, dobY] = (c.dob || '').split('/');
  if (dobM) {
    try { await page.selectOption('select[name*="month"],select[id*="month"]', dobM); } catch { /* */ }
    try { await page.selectOption('select[name*="day"],select[id*="day"]',     dobD); } catch { /* */ }
    try { await page.selectOption('select[name*="year"],select[id*="year"]',   dobY); } catch { /* */ }
  }

  // Confirm email if present
  try {
    const conf = await page.$('input[name*="confirm"],input[name*="Confirm"],input[name*="emailConfirm"]');
    if (conf) await conf.fill(c.email);
  } catch { /* */ }

  // Submit
  for (const s of ['button:has-text("NEXT")','button:has-text("Submit")','button[type=submit]','input[type=submit]']) {
    try { await page.click(s, { timeout:4000 }); break; } catch { /* */ }
  }
  await sleep(5000);

  // Second NEXT/submit step (preview page)
  for (const s of ['button:has-text("SUBMIT")','button:has-text("NEXT")','button[type=submit]']) {
    try { await page.click(s, { timeout:3000 }); break; } catch { /* */ }
  }
  await sleep(4000);

  const body2 = await page.content();
  const m = body2.match(/\b[A-Z0-9-]{6,14}\b/);
  if (/confirm|submitted|success|claim number|thank/i.test(body2)) {
    return [true, m ? m[0] : 'Filed'];
  }
  await page.screenshot({ path: `/tmp/zr_${c.state}_${c.last}_unclear.png` });
  return [false, 'Unclear'];
}

// ── State portal URLs & options ───────────────────────────────────────────────

const STATE_PORTALS = {
  // Already had dedicated filers — kept below as individual functions
  CA: null,   // handled separately
  FL: null,   // handled separately
  TX: null,   // handled separately
  PA: null,   // handled separately

  // NAUPA-standard portals — use fileGenericNAUPA
  OH: { url: 'https://unclaimedfunds.ohio.gov/app/claim-search',      opts: {} },
  CT: { url: 'https://ctbiglist.gov/app/claim-search',                opts: {} },
  OR: { url: 'https://unclaimed.oregon.gov/app/claim-search',         opts: {} },
  MN: { url: 'https://minnesota.findyourunclaimedproperty.com/app/claim-search', opts: {} },
  DE: { url: 'https://unclaimedproperty.delaware.gov/app/claim-search', opts: {} },
  NC: { url: 'https://www.nccash.gov/app/claim-search',               opts: {} },
  IN: { url: 'https://www.indianaunclaimed.gov/app/claim-search',     opts: {} },
  IL: { url: 'https://icash.illinoistreasurer.gov/app/claim-search',  opts: {} },
  UT: { url: 'https://unclaimedproperty.utah.gov/app/claim-search',   opts: {} },
  WA: { url: 'https://ucp.dor.wa.gov/app/claim-search',               opts: {} },
  CO: { url: 'https://colorado.findyourunclaimedproperty.com/app/claim-search', opts: {} },
  AZ: { url: 'https://azdor.gov/unclaimed-property/search-unclaimed-property', opts: {} },
  GA: { url: 'https://georgia.findyourunclaimedproperty.com/app/claim-search', opts: {} },
  MO: { url: 'https://missouriunclaimed.com/app/claim-search',        opts: {} },
  VA: { url: 'https://vamoneysearch.gov/app/claim-search',            opts: {} },
  // Add more as needed — most states use the same NAUPA app structure
};

// ── Dedicated filers for CA / FL / TX / PA ────────────────────────────────────

async function fileCalifornia(c, page) {
  console.log(`  [CA] ${c.first} ${c.last}`);
  await page.goto('https://claimit.ca.gov', { timeout:60000, waitUntil:'domcontentloaded' });
  await sleep(4000);
  await page.fill('input[placeholder*="Last"]',  c.last);
  await page.fill('input[placeholder*="First"]', c.first);
  await page.click('button:has-text("SEARCH")');
  await sleep(12000);
  const body = await page.content();
  if (!body.toUpperCase().includes(c.last.toUpperCase())) return [false,'No match'];
  const claimBtn = await page.$('a:has-text("CLAIM"),button:has-text("CLAIM")');
  if (!claimBtn) return [false,'INFO only — not yet claimable'];
  await claimBtn.click();
  await sleep(5000);
  const [dobM,dobD,dobY] = (c.dob||'').split('/');
  for (const [sel,val] of [
    ['input[name*="ssn"],input[id*="ssn"]',        c.ssn.replace(/-/g,'')],
    ['input[name*="dob"],input[id*="dob"]',         c.dob],
    ['input[name*="email"],input[id*="email"]',     c.email],
    ['input[name*="phone"],input[id*="phone"]',     c.phone],
    ['input[name*="address"],input[id*="address"]', c.address],
    ['input[name*="city"],input[id*="city"]',       c.city],
    ['input[name*="zip"],input[id*="zip"]',         c.zip],
  ]) await tryFill(page, sel, val);
  try {
    await page.selectOption('select[name*="month"],select[id*="month"]', dobM);
    await page.selectOption('select[name*="day"],select[id*="day"]',     dobD);
    await page.selectOption('select[name*="year"],select[id*="year"]',   dobY);
  } catch { /* */ }
  await page.click('button:has-text("CONTINUE"),button:has-text("NEXT"),button[type=submit]');
  await sleep(5000);
  const body2 = await page.content();
  const m = body2.match(/\b\d{8,10}\b/);
  if (m || /confirmation|claim number|submitted|thank/i.test(body2)) return [true, m?m[0]:'Filed'];
  return [false,'Unclear'];
}

async function fileFlorida(c, page) {
  console.log(`  [FL] ${c.first} ${c.last}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto('https://www.fltreasurehunt.gov/ClaimSearch', { timeout:90000, waitUntil:'networkidle' });
      await sleep(4000);
      await clickBtn(page, 'Person');
      await sleep(3000);
      await page.waitForSelector('input[name*="lastName"]', { state:'visible', timeout:15000 });
      await fillNamed(page, 'lastName',  c.last);
      await fillNamed(page, 'firstName', c.first);
      await fillNamed(page, 'city',      c.city);
      await sleep(5000);
      await clickBtn(page, 'SEARCH');
      try { await page.waitForSelector('.search-results,[class*="result"],td,.no-records', { timeout:20000 }); } catch { /* */ }
      await sleep(3000);
      const body = await page.content();
      if (/No records found|no records/i.test(body) || !body.toUpperCase().includes(c.last.toUpperCase())) return [false,'No match'];
      const cbs = await page.$$('input[type=checkbox]');
      for (const cb of cbs) { if (!await cb.getAttribute('checked')) await cb.click({ force:true }).catch(()=>{}); }
      await sleep(1000);
      await clickBtn(page, 'CONTINUE');
      await sleep(5000);
      for (const [f,v] of [['email',c.email],['phone',c.phone],['dob',c.dob],['dateOfBirth',c.dob],['ssn',c.ssn.replace(/-/g,'')],['address',c.address],['city',c.city],['zip',c.zip]]) {
        await fillNamed(page, f, v).catch(()=>{});
      }
      await sleep(1000);
      for (const lbl of ['SAVE','CONTINUE','SUBMIT']) { if (await clickBtn(page,lbl,3000)) break; }
      await sleep(5000);
      const body2 = await page.content();
      const m = body2.match(/C\d{8,10}/);
      if (m || /one step away|claim form|emailed|confirmation/i.test(body2)) return [true, m?m[0]:'Filed'];
      return [false,'Unclear'];
    } catch(err) {
      console.log(`  [FL] Attempt ${attempt}: ${err.message.slice(0,80)}`);
      if (attempt < 3) await sleep(8000);
      else return [false,`Failed after 3 attempts: ${err.message.slice(0,60)}`];
    }
  }
}

async function fileTexas(c, page) {
  console.log(`  [TX] ${c.first} ${c.last}`);
  await page.goto('https://www.claimittexas.gov', { timeout:60000, waitUntil:'domcontentloaded' });
  await sleep(3000);
  try { await page.click('a:has-text("CLAIMING PROPERTY"),button:has-text("GET STARTED")',{timeout:5000}); await sleep(3000); } catch { /* */ }
  await page.fill('#lastName,input[name*="lastName"]', c.last);
  await page.fill('#firstName,input[name*="firstName"]', c.first);
  await page.click('button[type=submit],input[type=submit]');
  await sleep(5000);
  const body = await page.content();
  if (!body.toUpperCase().includes(c.last.toUpperCase())) return [false,'No match'];
  await page.evaluate(()=>document.querySelectorAll('input[type=checkbox]').forEach(cb=>{if(!cb.checked)cb.click();}));
  await sleep(1000);
  for (const txt of ['Add to Claim Cart','Continue']) {
    const btn = await page.$(`input[value*="${txt}"],button:has-text("${txt}"),a:has-text("${txt}")`);
    if (btn) { await btn.click(); break; }
  }
  await sleep(3000);
  for (const [sel,val] of [
    ['#email,input[name*="email"]',c.email],['#phone,input[name*="phone"]',c.phone],
    ['#dateOfBirth,input[name*="dateOfBirth"]',c.dob],['#ssn,input[name*="ssn"]',c.ssn.replace(/-/g,'')],
    ['#address,input[name*="address"]',c.address],['#city,input[name*="city"]',c.city],
    ['#zip,input[name*="zip"]',c.zip],
  ]) await tryFill(page, sel, val);
  await page.click('input[type=submit],button[type=submit]');
  await sleep(4000);
  const body2 = await page.content();
  const m = body2.match(/\b\d{7,10}\b/);
  if (m || /confirmation|submitted/i.test(body2)) return [true, m?m[0]:'Filed'];
  return [false,'Unclear'];
}

async function filePennsylvania(c, page) {
  console.log(`  [PA] ${c.first} ${c.last}`);
  await page.goto('https://unclaimedproperty.patreasury.gov/en/Property/SearchIndex', { timeout:60000, waitUntil:'domcontentloaded' });
  await sleep(3000);
  await page.fill('input[name*="lastName"],#lastName', c.last);
  await page.fill('input[name*="firstName"],#firstName', c.first);
  await page.click('button[type=submit],input[type=submit],button:has-text("Search")');
  await sleep(8000);
  const body = await page.content();
  if (!body.toUpperCase().includes(c.last.toUpperCase())) return [false,'No match'];
  if (/g-recaptcha|recaptcha/i.test(body)) {
    try {
      const token = await solveRecaptcha('https://unclaimedproperty.patreasury.gov/en/Property/SearchIndex','6Lfldx0TAAAAADWOGNUBVxBpsGcELIH3AoiEnWxY');
      await page.evaluate(t=>{
        const el=document.getElementById('g-recaptcha-response'); if(el) el.value=t;
        const cfg=window.___grecaptcha_cfg?.clients?.[0]?.l?.l; if(typeof cfg?.callback==='function') cfg.callback(t);
      }, token);
      await sleep(2000);
    } catch(err) { console.warn('  [PA] Capsolver failed:', err.message); }
  }
  const claimBtn = await page.$('a:has-text("Claim"),button:has-text("Claim")');
  if (!claimBtn) return [false,'No claim button'];
  await claimBtn.click();
  await sleep(4000);
  for (const [sel,val] of [
    ['input[name*="email"],input[id*="email"]',c.email],
    ['input[name*="phone"],input[id*="phone"]',c.phone],
    ['input[name*="ssn"],input[id*="ssn"]',c.ssn.replace(/-/g,'')],
  ]) await tryFill(page, sel, val);
  await page.click('button[type=submit],button:has-text("Submit")');
  await sleep(4000);
  const body2 = await page.content();
  const m = body2.match(/\b\d{7,12}\b/);
  if (m || /confirm|submitted/i.test(body2)) return [true, m?m[0]:'Filed'];
  return [false,'Unclear'];
}

// ── MissingMoney.com — primary filer for all non-CA/FL/TX/PA states ──────────

async function fileMissingMoney(c, page) {
  console.log(`  [MM] ${c.first} ${c.last} (${c.state})`);
  const [dobM, dobD, dobY] = (c.dob||'').split('/');

  await page.goto('https://missingmoney.com', { timeout:90000, waitUntil:'domcontentloaded' });
  await sleep(5000);

  // Search
  await tryFill(page, '#lastNameTop,input[name*="lastName"]', c.last) ||
    await page.fill('input[placeholder*="Last"]', c.last).catch(()=>{});
  await tryFill(page, '#firstNameTop,input[name*="firstName"]', c.first) ||
    await page.fill('input[placeholder*="First"]', c.first).catch(()=>{});
  try { await page.selectOption('select[name*="state"],select[id*="state"],#stateTop', c.state); } catch { /* search all */ }
  await page.keyboard.press('Enter');
  await sleep(6000);

  const body = await page.content();
  if (!body.toUpperCase().includes(c.last.toUpperCase())) return [false,'No match on MissingMoney'];

  // Add all claimable results to cart
  const claimBtns = await page.$$('button:has-text("CLAIM"),a:has-text("CLAIM"),button:has-text("Claim")');
  let added = 0;
  for (const btn of claimBtns.slice(0,10)) {
    try {
      const txt = (await btn.innerText()).trim().toUpperCase();
      if (txt.includes('CLAIM') && !txt.includes('REMOVE')) { await btn.click(); await sleep(600); added++; }
    } catch { /* */ }
  }
  if (added === 0) return [false,'No claimable properties on MissingMoney'];

  // Go to cart
  try {
    await page.click('a:has-text("VIEW CLAIMED"),button:has-text("VIEW CLAIMED"),a[href*="claim-cart"]',{timeout:5000});
  } catch {
    await page.goto('https://missingmoney.com/app/claim-cart',{timeout:30000,waitUntil:'networkidle'});
  }
  await sleep(3000);

  try { await page.selectOption('select[name*="relationship"],select[name*="claimant"]',{label:'Myself'}); } catch { /* */ }
  await page.click('button:has-text("FILE CLAIM"),a:has-text("FILE CLAIM"),button:has-text("File Claim")').catch(()=>{});
  await sleep(3000);

  // Fill contact info
  await tryFill(page, '#lastName,input[name*="lastName"]',   c.last);
  await tryFill(page, '#firstName,input[name*="firstName"]', c.first);
  if (dobM) {
    try { await page.selectOption('select[name*="month"],select[id*="month"]', dobM); } catch { /* */ }
    try { await page.selectOption('select[name*="day"],select[id*="day"]',     dobD); } catch { /* */ }
    try { await page.selectOption('select[name*="year"],select[id*="year"]',   dobY); } catch { /* */ }
  }
  await tryFill(page, 'input[name*="email"],input[id*="email"]', c.email);
  try { const conf=await page.$('input[name*="confirm"],input[name*="Confirm"]'); if(conf) await conf.fill(c.email); } catch { /* */ }
  await tryFill(page, 'input[name*="phone"],input[id*="phone"]', c.phone);

  // NEXT
  for (const lbl of ['NEXT','Next']) { if (await clickBtn(page,lbl,5000)) break; }
  await sleep(3000);

  // Submit on preview page
  for (const s of ['button:has-text("SUBMIT")','button:has-text("NEXT")','button[type=submit]']) {
    try { await page.click(s,{timeout:4000}); break; } catch { /* */ }
  }
  await sleep(4000);

  const body2 = await page.content();
  if (/summary|submitted|confirmation|claim number|successfully/i.test(body2)) {
    const m = body2.match(/\b[A-Z0-9]{6,12}\b/);
    return [true, m?m[0]:'Filed-MM'];
  }
  return [false,'MissingMoney — unclear result'];
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

async function fulfill(claimId) {
  console.log(`[auto_fulfill] ${claimId}`);

  const row = await getClaimById(claimId);
  if (!row) { console.error('[auto_fulfill] Claim not found'); process.exit(1); }

  const c = {
    first:   row.first_name,
    last:    row.last_name,
    email:   row.email,
    state:   (row.state||'').trim().toUpperCase(),
    ssn:     row.ssn ? (isEncrypted(row.ssn) ? decrypt(row.ssn) : row.ssn) : '',
    dob:     row.dob ? (isEncrypted(row.dob) ? decrypt(row.dob) : row.dob) : '',
    phone:   row.phone   || '',
    address: row.address || '',
    city:    row.city    || '',
    zip:     row.zip     || '',
  };

  console.log(`[auto_fulfill] ${c.first} ${c.last} | ${c.state} | ${c.email}`);
  // Increment attempt counter each time we run
  await pool.query(`
    INSERT INTO fulfillment_log (claim_id, email, first_name, last_name, state, status, attempts)
    VALUES ($1,$2,$3,$4,$5,'running',1)
    ON CONFLICT (claim_id) DO UPDATE SET status='running', attempts=fulfillment_log.attempts+1, updated_at=NOW()
  `, [claimId, c.email, c.first, c.last, c.state]);

  const { chromium } = require('playwright');
  let browser, filed = false, detail = '';

  try {
    browser = await chromium.connectOverCDP(WSS);
    const context = browser.contexts[0] || await browser.newContext();

    // ── Step 1: MissingMoney (primary for non CA/FL/TX/PA; skip for those) ──
    const useMMFirst = !['CA','FL','TX','PA'].includes(c.state);
    if (useMMFirst) {
      const page = await context.newPage();
      try { [filed, detail] = await fileMissingMoney(c, page); }
      catch (err) { detail = err.message.slice(0,120); }
      await page.close();
    }

    // ── Step 2: Direct state portal ──────────────────────────────────────────
    if (!filed) {
      const page = await context.newPage();
      try {
        if      (c.state === 'CA') [filed,detail] = await fileCalifornia(c, page);
        else if (c.state === 'FL') [filed,detail] = await fileFlorida(c, page);
        else if (c.state === 'TX') [filed,detail] = await fileTexas(c, page);
        else if (c.state === 'PA') [filed,detail] = await filePennsylvania(c, page);
        else if (STATE_PORTALS[c.state]) {
          const { url, opts } = STATE_PORTALS[c.state];
          [filed,detail] = await fileGenericNAUPA(c, page, url, opts);
        } else {
          detail = `No direct portal for ${c.state}`;
        }
      } catch (err) { detail = err.message.slice(0,120); }
      await page.close();
    }

    // ── Step 3: MissingMoney as final fallback for CA/FL/TX/PA if direct failed ──
    if (!filed && ['CA','FL','TX','PA'].includes(c.state)) {
      console.log(`[auto_fulfill] Direct portal failed (${detail}) — trying MissingMoney fallback`);
      const page = await context.newPage();
      try { [filed,detail] = await fileMissingMoney(c, page); }
      catch (err) { detail = err.message.slice(0,120); }
      await page.close();
    }

    await browser.close();
  } catch (err) {
    console.error('[auto_fulfill] Browser error:', err.message);
    try { if (browser) await browser.close(); } catch { /* */ }
    detail = err.message.slice(0,200);
  }

  // ── Persist result ────────────────────────────────────────────────────────
  if (filed) {
    console.log(`[auto_fulfill] FILED: ${c.first} ${c.last} (${c.state}) — ${detail}`);
    await upsertLog(claimId, { status:'filed', portal_claim_id:detail });
    await markFulfilled(claimId);
    await sendClaimConfirmedEmail(c.email, detail, c.first);
  } else {
    console.log(`[auto_fulfill] NOT FILED: ${c.first} ${c.last} (${c.state}) — ${detail}`);
    await upsertLog(claimId, {
      status:     /no match|no record/i.test(detail) ? 'no_match' : 'error',
      last_error: detail,
    });
  }

  await pool.end();
}

const claimId = process.argv[2];
if (!claimId) { console.error('Usage: node auto_fulfill.js <claim_id>'); process.exit(1); }
fulfill(claimId).catch(err => { console.error('[auto_fulfill] Fatal:', err); process.exit(1); });
