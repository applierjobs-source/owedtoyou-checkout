// ===================================================
// URL Shortener v2 — no storage needed, survives redeploys
// Encodes the full claim URL in a short base62 path
// ===================================================

module.exports = function registerShortener(app) {

  // POST /shorten { url: "https://..." } → { short: "https://www.owedtoyou.net/c/XXXXX" }
  app.post('/shorten', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    // Base64-encode the full URL and use it directly as the code
    const code = Buffer.from(url).toString('base64url'); // URL-safe base64
    res.json({ code, short: `https://www.owedtoyou.net/c/${code}` });
  });

  // GET /c/:code → decode and redirect directly to claim URL
  app.get('/c/:code', (req, res) => {
    try {
      const url = Buffer.from(req.params.code, 'base64url').toString('utf8');
      if (!url.startsWith('https://www.owedtoyou.net/claim.html')) {
        return res.status(400).send('Invalid link');
      }
      res.redirect(301, url);
    } catch (e) {
      res.status(404).send('Link not found');
    }
  });

};
