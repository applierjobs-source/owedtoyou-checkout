'use strict';
const puppeteer = require('puppeteer');

async function htmlToPdf(html) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'Letter',
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: true
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

module.exports = { htmlToPdf };
