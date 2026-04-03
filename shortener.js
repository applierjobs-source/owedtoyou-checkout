// ===================================================
// URL Shortener — add this to your Express server
// ===================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LINKS_FILE = path.join(__dirname, 'short_links.json');

function loadLinks() {
  if (!fs.existsSync(LINKS_FILE)) fs.writeFileSync(LINKS_FILE, '{}');
  return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
}

function saveLinks(links) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
}

function generateCode() {
  return crypto.randomBytes(3).toString('hex'); // 6-char code e.g. "a1b2c3"
}

module.exports = function registerShortener(app) {

  // POST /shorten  { url: "https://..." }  → { code: "a1b2c3", short: "https://www.owedtoyou.net/c/a1b2c3" }
  app.post('/shorten', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const links = loadLinks();
    const code = generateCode();
    links[code] = url;
    saveLinks(links);
    res.json({ code, short: `https://www.owedtoyou.net/c/${code}` });
  });

  // GET /c/:code  → redirect to full URL
  app.get('/c/:code', (req, res) => {
    const links = loadLinks();
    const url = links[req.params.code];
    if (!url) return res.status(404).send('Link not found');
    res.redirect(301, url);
  });

};
