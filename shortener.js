// ===================================================
// URL Shortener v4 — Redis-backed, truly short codes
// Uses Upstash Redis REST API for persistent storage
// Codes are 6 random chars e.g. owedtoyou.net/c/a1b2c3
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

module.exports = function registerShortener(app) {

  // POST /shorten { url: "https://..." } → { short: "https://www.owedtoyou.net/c/a1b2c3" }
  app.post('/shorten', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    try {
      const code = generateCode();
      await redisSet(`link:${code}`, url);
      res.json({ code, short: `https://www.owedtoyou.net/c/${code}` });
    } catch (e) {
      console.error('Shorten error:', e);
      res.status(500).json({ error: 'Failed to shorten URL' });
    }
  });

  // GET /c/:code → look up in Redis and redirect
  app.get('/c/:code', async (req, res) => {
    try {
      const url = await redisGet(`link:${req.params.code}`);
      if (!url) return res.status(404).send('Link not found');
      res.redirect(301, url);
    } catch (e) {
      res.status(500).send('Error looking up link');
    }
  });

};
