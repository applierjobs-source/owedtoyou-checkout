// ===================================================
// URL Shortener v3 — stateless, survives redeploys
// Encodes only the claim data payload (not the full URL)
// Server reconstructs full claim URL on redirect
// ===================================================

const CLAIM_BASE = 'https://www.owedtoyou.net/claim.html';

module.exports = function registerShortener(app) {

  // POST /shorten { url: "https://www.owedtoyou.net/claim.html?d=BASE64" }
  // Extracts the ?d= param and stores only that as the code
  app.post('/shorten', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    try {
      const d = new URL(url).searchParams.get('d');
      if (!d) return res.status(400).json({ error: 'no d param' });
      // Strip padding = signs for cleaner URL
      const code = d.replace(/=+$/, '');
      const short = `https://www.owedtoyou.net/c/${code}`;
      res.json({ code, short });
    } catch(e) {
      res.status(400).json({ error: 'invalid url' });
    }
  });

  // GET /c/:code → reconstruct full claim URL and redirect
  app.get('/c/:code', (req, res) => {
    try {
      const code = req.params.code;
      // Validate it decodes to valid JSON
      const padded = code + '=='.slice(0, (4 - code.length % 4) % 4);
      const json = Buffer.from(padded, 'base64').toString('utf8');
      JSON.parse(json); // throws if invalid
      const fullUrl = `${CLAIM_BASE}?d=${code}`;
      res.redirect(301, fullUrl);
    } catch(e) {
      res.status(404).send('Link not found');
    }
  });

};
