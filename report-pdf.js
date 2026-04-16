'use strict';

// report-pdf.js — Fast PDF generation using PDFKit (no browser launch)
// Generates a full Money Owed report in ~100ms

const PDFDocument = require('pdfkit');

// Colors
const DARK_NAVY = '#0f2744';
const TEAL = '#0d9488';
const EMERALD = '#10b981';
const WHITE = '#ffffff';
const LIGHT_GRAY = '#f9fafb';
const MID_GRAY = '#6b7280';
const DARK_TEXT = '#1a1a1a';
const BORDER = '#e5e7eb';

function money(val) {
  const n = parseFloat(String(val).replace(/[$,]/g, ''));
  return isNaN(n) ? String(val) : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

async function htmlToPdf(html, data) {
  // data contains the structured report data — use that instead of parsing HTML
  return generatePdfFromData(data || {});
}

async function generatePdfFromData(data) {
  const {
    firstName = 'there', lastName = '', city = '', state = '',
    unclaimedRecords = [], settlements = [], federalSources = [],
    reportDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  } = data;

  const fullName = `${firstName} ${lastName}`.trim();
  const confirmedTotal = unclaimedRecords.reduce((sum, r) => {
    const n = parseFloat(String(r.amount).replace(/[$,]/g, ''));
    return sum + (isNaN(n) ? 0 : n);
  }, 0);

  const doc = new PDFDocument({ margin: 0, size: 'LETTER', info: {
    Title: `Money Owed Report — ${fullName}`,
    Author: 'OwedToYou.net'
  }});

  const chunks = [];
  doc.on('data', c => chunks.push(c));

  await new Promise((resolve) => {
    doc.on('end', resolve);

    const W = 612; // Letter width in points
    const MARGIN = 48;
    const CONTENT_W = W - MARGIN * 2;

    // ── COVER HEADER ──────────────────────────────────────────────
    doc.rect(0, 0, W, 140).fill(DARK_NAVY);
    doc.fontSize(9).fillColor('#94a3b8').font('Helvetica')
       .text('MONEY OWED REPORT — CONFIDENTIAL', MARGIN, 28, { characterSpacing: 1.5 });
    doc.fontSize(22).fillColor(WHITE).font('Helvetica-Bold')
       .text(`Money Owed to ${fullName}`, MARGIN, 46);
    doc.fontSize(10).fillColor('#94a3b8').font('Helvetica')
       .text(`Report Date: ${reportDate}  |  ${city}, ${state}`, MARGIN, 78);

    // Stat boxes
    const stats = [
      { val: confirmedTotal > 0 ? money(confirmedTotal) : 'Records Found', label: 'Confirmed Unclaimed' },
      { val: settlements.length > 0 ? `$${(settlements.length * 500).toLocaleString()}+` : '$0', label: 'Settlement Potential' },
      { val: String(settlements.length), label: 'Active Settlements' },
    ];
    stats.forEach((s, i) => {
      const bx = MARGIN + i * 180;
      doc.roundedRect(bx, 96, 160, 36, 6).fillAndStroke('rgba(255,255,255,0.08)', 'rgba(255,255,255,0.15)');
      doc.fontSize(14).fillColor(EMERALD).font('Helvetica-Bold').text(s.val, bx + 10, 100, { width: 140 });
      doc.fontSize(8).fillColor('#94a3b8').font('Helvetica').text(s.label, bx + 10, 117, { width: 140 });
    });

    let y = 155;

    function sectionHeader(title) {
      doc.rect(MARGIN, y, CONTENT_W, 22).fill(DARK_NAVY);
      doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold')
         .text(title.toUpperCase(), MARGIN + 10, y + 7, { characterSpacing: 0.5 });
      y += 30;
    }

    function tableHeader(cols) {
      let x = MARGIN;
      doc.rect(MARGIN, y, CONTENT_W, 18).fill('#1e3a5f');
      cols.forEach(col => {
        doc.fontSize(7.5).fillColor(WHITE).font('Helvetica-Bold')
           .text(col.label, x + 4, y + 5, { width: col.w - 8 });
        x += col.w;
      });
      y += 18;
    }

    function tableRow(cols, values, shade) {
      if (shade) doc.rect(MARGIN, y, CONTENT_W, 16).fill(LIGHT_GRAY);
      let x = MARGIN;
      cols.forEach((col, i) => {
        doc.fontSize(8).fillColor(DARK_TEXT).font('Helvetica')
           .text(String(values[i] || '—'), x + 4, y + 4, { width: col.w - 8, lineBreak: false });
        x += col.w;
      });
      // Bottom border
      doc.moveTo(MARGIN, y + 16).lineTo(MARGIN + CONTENT_W, y + 16).strokeColor(BORDER).lineWidth(0.5).stroke();
      y += 16;
    }

    function highlightBox(text, color = '#f0fdf4', border = EMERALD) {
      doc.rect(MARGIN, y, CONTENT_W, 28).fillAndStroke(color, border);
      doc.fontSize(8.5).fillColor('#065f46').font('Helvetica').text(text, MARGIN + 10, y + 9, { width: CONTENT_W - 20 });
      y += 36;
    }

    function pageBreakIfNeeded(needed = 120) {
      if (y + needed > 740) {
        doc.addPage({ margin: 0, size: 'LETTER' });
        y = 40;
      }
    }

    // ── SECTION 1: UNCLAIMED PROPERTY ────────────────────────────
    sectionHeader('Section 1: Confirmed Unclaimed Property');

    doc.fontSize(9).fillColor(MID_GRAY).font('Helvetica')
       .text(`Unclaimed property records found for ${fullName} from ${city}, ${state}.`, MARGIN, y, { width: CONTENT_W });
    y += 20;

    const upCols = [
      { label: 'Held By', w: 180 },
      { label: 'Address on File', w: 160 },
      { label: 'Amount', w: 70 },
      { label: 'Year', w: 50 },
      { label: 'Property Type', w: 56 },
    ];
    tableHeader(upCols);

    if (unclaimedRecords.length > 0) {
      unclaimedRecords.forEach((r, i) => {
        pageBreakIfNeeded(20);
        tableRow(upCols, [
          r.holder, `${r.address || ''}${r.city ? ', ' + r.city : ''}, ${r.state}`,
          typeof r.amount === 'number' ? money(r.amount) : r.amount,
          r.year || '—', r.propertyType || '—'
        ], i % 2 === 0);
      });

      if (confirmedTotal > 0) {
        doc.rect(MARGIN, y, CONTENT_W, 18).fill('#ecfdf5');
        doc.fontSize(9).fillColor('#065f46').font('Helvetica-Bold')
           .text('Total Confirmed', MARGIN + 10, y + 5)
           .text(money(confirmedTotal), MARGIN + 340, y + 5, { width: 60 });
        y += 22;
      }
    } else {
      doc.rect(MARGIN, y, CONTENT_W, 30).fill(LIGHT_GRAY);
      doc.fontSize(8.5).fillColor(MID_GRAY).font('Helvetica')
         .text(`No exact matches found in our database for ${fullName}. Check your state's unclaimed property site at unclaimed.org`, MARGIN + 10, y + 10, { width: CONTENT_W - 20 });
      y += 38;
    }

    y += 8;
    highlightBox('Also check all 50 states at once: unclaimed.org — search your name and any previous addresses.');

    // ── SECTION 2: CLASS ACTION SETTLEMENTS ──────────────────────
    pageBreakIfNeeded(60);
    sectionHeader('Section 2: Class Action Settlements (Profile-Matched)');

    doc.fontSize(9).fillColor(MID_GRAY).font('Helvetica')
       .text(`Active settlements where ${firstName} may qualify. Sorted by deadline.`, MARGIN, y, { width: CONTENT_W });
    y += 20;

    const sCols = [
      { label: '#', w: 22 },
      { label: 'Company', w: 110 },
      { label: 'What It\'s About', w: 145 },
      { label: 'Deadline', w: 65 },
      { label: 'Payout', w: 75 },
      { label: 'Claim URL', w: 99 },
    ];
    tableHeader(sCols);

    settlements.forEach((s, i) => {
      pageBreakIfNeeded(20);
      tableRow(sCols, [
        String(i + 1), s.company, s.about, s.deadline, s.payout, s.url
      ], i % 2 === 0);
    });

    y += 8;
    pageBreakIfNeeded(40);
    doc.rect(MARGIN, y, CONTENT_W, 28).fillAndStroke('#fff7ed', '#f59e0b');
    doc.fontSize(8.5).fillColor('#92400e').font('Helvetica')
       .text('Note: Check each settlement\'s eligibility. Most require you were a customer or had data exposed during the relevant period.', MARGIN + 10, y + 9, { width: CONTENT_W - 20 });
    y += 36;

    // ── SECTION 3: FEDERAL SOURCES ────────────────────────────────
    pageBreakIfNeeded(60);
    doc.addPage({ margin: 0, size: 'LETTER' });
    y = 40;
    sectionHeader('Section 3: Federal Unclaimed Money');

    doc.fontSize(9).fillColor(MID_GRAY).font('Helvetica')
       .text('Federal agencies hold billions in unclaimed funds. Search each using your full name.', MARGIN, y, { width: CONTENT_W });
    y += 20;

    const fCols = [
      { label: 'Agency', w: 80 },
      { label: 'Fund Type', w: 200 },
      { label: 'Search URL', w: 236 },
    ];
    tableHeader(fCols);

    (federalSources || []).forEach((f, i) => {
      tableRow(fCols, [f.agency, f.type, f.url], i % 2 === 0);
    });

    y += 20;

    // ── FOOTER ────────────────────────────────────────────────────
    doc.rect(MARGIN, y, CONTENT_W, 56).fillAndStroke(LIGHT_GRAY, BORDER);
    doc.fontSize(9).fillColor(DARK_TEXT).font('Helvetica-Bold')
       .text('Report prepared by OwedToYou.net', MARGIN + 12, y + 10);
    doc.fontSize(8).fillColor(MID_GRAY).font('Helvetica')
       .text('We file unclaimed property claims on your behalf for a flat fee of $95.99. Full refund if we recover nothing.', MARGIN + 12, y + 24, { width: CONTENT_W - 24 })
       .text('www.owedtoyou.net  |  This report is for informational purposes only. OwedToYou.net is not a law firm.', MARGIN + 12, y + 36, { width: CONTENT_W - 24 });

    doc.end();
  });

  return Buffer.concat(chunks);
}

module.exports = { htmlToPdf, generatePdfFromData };
