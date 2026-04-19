// ===================================================
// URL Shortener v4 — Redis-backed, truly short codes
// Uses Upstash Redis REST API for persistent storage
// Codes are 6 random chars e.g. owedtoyou.net/c/a1b2c3
// Also logs clicks to Postgres for follow-up retargeting
// ===================================================

const crypto = require('crypto');
const https  = require('https');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function redisRequest(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, REDIS_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function redisSet(key, value) {
  const encoded = encodeURIComponent(value);
  const data = await redisRequest(`/set/${encodeURIComponent(key)}/${encoded}`);
  return data && data.result === 'OK';
}

async function redisGet(key) {
  const data = await redisRequest(`/get/${encodeURIComponent(key)}`);
  return data ? data.result : null;
}

function generateCode() {
  return crypto.randomBytes(3).toString('hex'); // 6-char e.g. "a1b2c3"
}

module.exports = function registerShortener(app, pool) {

  // Initialize click_log table
  if (pool) {
    pool.query(`
      CREATE TABLE IF NOT EXISTS click_log (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL,
        phone TEXT,
        name TEXT,
        holder TEXT,
        amount REAL,
        city TEXT,
        state TEXT,
        clicked_at TIMESTAMPTZ DEFAULT NOW(),
        follow_up_sent BOOLEAN DEFAULT FALSE,
        converted BOOLEAN DEFAULT FALSE
      )
    `).catch(err => console.error('[shortener] click_log init error:', err.message));
  }

  // POST /shorten { url, phone, name, holder, amount, city, state }
  // Stores contact metadata alongside the link for follow-up targeting
  app.post('/shorten', async (req, res) => {
    const { url, phone, name, holder, amount, city, state } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    try {
      const code = generateCode();
      // Store URL in Redis
      await redisSet(`link:${code}`, url);
      // Store contact metadata in Redis for click logging + OG image
      const { imageUrl } = req.body;
      await redisSet(`meta:${code}`, JSON.stringify({ phone, name, holder, amount, city, state, imageUrl: imageUrl || '' }));
      res.json({ code, short: `https://www.owedtoyou.net/c/${code}` });
    } catch (e) {
      console.error('Shorten error:', e);
      res.status(500).json({ error: 'Failed to shorten URL' });
    }
  });

  // GET /c/:code → log click, redirect
  app.get('/c/:code', async (req, res) => {
    try {
      const code = req.params.code;
      const url = await redisGet(`link:${code}`);
      if (!url) return res.status(404).send('Link not found');

      // Log click async (don't block redirect)
      if (pool) {
        redisGet(`meta:${code}`).then(metaStr => {
          if (!metaStr) return;
          try {
            const meta = JSON.parse(metaStr);
            pool.query(
              `INSERT INTO click_log (code, phone, name, holder, amount, city, state)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT DO NOTHING`,
              [code, meta.phone||null, meta.name||null, meta.holder||null,
               meta.amount||null, meta.city||null, meta.state||null]
            ).catch(() => {});
          } catch(e) {}
        }).catch(() => {});
      }

      // Fetch metadata from Redis for OG image URL
      let metaObj = {};
      try {
        const metaStr = await redisGet(`meta:${code}`);
        if (metaStr) metaObj = JSON.parse(metaStr);
      } catch(e) {}

      // Decode the claim data from the URL for OG tags
      let ogName = 'You', ogHolder = 'the state', ogAmount = '', ogImage = metaObj.imageUrl || '';
      try {
        const parsedUrl = new URL(url);
        const d = parsedUrl.searchParams.get('d');
        if (d) {
          const padded = d + '=='.slice(0, (4 - d.length % 4) % 4);
          const data = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
          ogName   = data.n || data.name || 'You';
          ogHolder = data.h || data.holder || 'the state';
          const amt = data.v || data.amount || data.t || 0;
          ogAmount = amt ? `$${parseFloat(amt).toLocaleString('en-US', {minimumFractionDigits:2})}` : '';
          // Use pre-generated image if available, otherwise skip
          // meta is fetched below - placeholder, will be overwritten
          ogImage = '';
        }
      } catch(e) {}

      const title = ogAmount
        ? `${ogName}, you're owed ${ogAmount} — OwedToYou.net`
        : `${ogName}, you have unclaimed funds — OwedToYou.net`;
      const desc = ogHolder && ogHolder !== 'the state'
        ? `${ogHolder} is holding ${ogAmount || 'funds'} in your name. Claim it for $12.95.`
        : `You have unclaimed funds waiting. Claim them for $12.95 — full refund if nothing recovered.`;

      // Serve OG page — crawlers read meta tags, humans get JS redirect
      res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta property="og:title" content="${title.replace(/"/g, '&quot;')}">
<meta property="og:description" content="${desc.replace(/"/g, '&quot;')}">
<meta property="og:url" content="https://www.owedtoyou.net/c/${code}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="OwedToYou.net">
${ogImage ? `<meta property="og:image" content="${ogImage}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title.replace(/"/g, '&quot;')}">
<meta name="twitter:description" content="${desc.replace(/"/g, '&quot;')}">
${ogImage ? `<meta name="twitter:image" content="${ogImage}">` : ''}
<meta http-equiv="refresh" content="0;url=${url}">
<script>window.location.replace(${JSON.stringify(url)});</script>
</head>
<body></body>
</html>`);
    } catch (e) {
      res.status(500).send('Error looking up link');
    }
  });

  // Mark a phone as converted (called when Stripe webhook fires)
  app.post('/mark-converted', async (req, res) => {
    const { phone } = req.body;
    if (!phone || !pool) return res.json({ ok: true });
    await pool.query(
      `UPDATE click_log SET converted=TRUE WHERE phone=$1`, [phone]
    ).catch(() => {});
    res.json({ ok: true });
  });

};
