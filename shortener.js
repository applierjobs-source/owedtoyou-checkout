// ===================================================
// URL Shortener v4 — Redis-backed, truly short codes
// Uses Upstash Redis REST API for persistent storage
// Codes are 6 random chars e.g. owedtoyou.net/c/a1b2c3
// ===================================================

const crypto = require('crypto');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisSet(key, value) {
  const res = await fetch(`${REDIS_URL}/set/${key}/${encodeURIComponent(value)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  return res.ok;
}

async function redisGet(key) {
  const res = await fetch(`${REDIS_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.result || null;
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
