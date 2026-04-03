'use strict';

const https = require('https');

const SENDGRID_API_KEY = () => process.env.EMAIL_PASS;
const FROM = () => process.env.EMAIL_FROM || 'contact@owedtoyou.net';

/**
 * Send email via SendGrid HTTP API — more reliable than SMTP on cloud servers.
 */
async function sendEmail(to, subject, htmlBody) {
  const apiKey = SENDGRID_API_KEY();
  if (!apiKey) {
    console.warn('[fulfillment] No EMAIL_PASS (SendGrid API key) configured');
    return;
  }

  const payload = JSON.stringify({
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM(), name: 'OwedToYou.net' },
    subject,
    content: [{ type: 'text/html', value: htmlBody }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[fulfillment] Email sent to ${to} (${res.statusCode})`);
          resolve();
        } else {
          console.error(`[fulfillment] SendGrid error ${res.statusCode}: ${body}`);
          reject(new Error(`SendGrid ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Shared email chrome
// ---------------------------------------------------------------------------

function emailWrapper(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body { margin:0; padding:0; background:#0D1B2A; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  .outer { background:#0D1B2A; padding:40px 16px; }
  .logo-row { text-align:center; margin-bottom:28px; }
  .logo-row a { text-decoration:none; color:#fff; font-size:18px; font-weight:700; letter-spacing:-0.3px; }
  .logo-row span { color:#10b981; }
  .card { max-width:520px; margin:0 auto; background:#0f172a; border:1px solid #1e293b; border-radius:20px; overflow:hidden; }
  .card-header { background:#059669; padding:24px 28px; }
  .card-header p { color:#a7f3d0; font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase; margin-bottom:6px; }
  .card-header h1 { color:#fff; font-size:22px; font-weight:700; line-height:1.35; margin:0; }
  .card-body { padding:28px; }
  .card-body p { color:#94a3b8; font-size:15px; line-height:1.65; margin-bottom:16px; }
  .card-body p:last-child { margin-bottom:0; }
  .data-box { background:#1e293b; border-radius:12px; padding:16px 18px; margin:20px 0; }
  .data-row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #2d3f55; }
  .data-row:last-child { border-bottom:none; }
  .data-label { color:#64748b; font-size:12px; text-transform:uppercase; letter-spacing:1px; }
  .data-value { color:#e2e8f0; font-size:14px; font-weight:600; }
  .cta-btn { display:block; width:100%; max-width:360px; margin:24px auto 0; background:#10b981; color:#fff; text-align:center; text-decoration:none; border-radius:14px; padding:16px; font-size:16px; font-weight:700; letter-spacing:-0.2px; }
  .cta-btn:hover { background:#34d399; }
  .steps { margin:20px 0; }
  .step { display:flex; gap:12px; margin-bottom:14px; }
  .step-num { width:26px; height:26px; min-width:26px; background:#10b981; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; color:#fff; }
  .step-text { color:#94a3b8; font-size:14px; line-height:1.5; padding-top:3px; }
  .step-text strong { color:#e2e8f0; }
  .badge { display:inline-flex; align-items:center; gap:6px; background:#052e16; border:1px solid #166534; border-radius:8px; padding:8px 12px; font-size:12px; color:#4ade80; margin:16px 0; }
  .divider { border:none; border-top:1px solid #1e293b; margin:20px 0; }
  .footer { text-align:center; margin-top:28px; font-size:11px; color:#334155; max-width:520px; margin-left:auto; margin-right:auto; line-height:1.6; }
</style>
</head>
<body>
<div class="outer">
  <div class="logo-row"><a href="https://www.owedtoyou.net">Owed<span>ToYou</span>.net</a></div>
  <div class="card">
    ${bodyHtml}
  </div>
  <p class="footer">OwedToYou.net &mdash; Unclaimed Property Recovery Service<br/>Questions? Reply to this email and we'll help.</p>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// sendIntakeEmail
// ---------------------------------------------------------------------------

/**
 * Sends the intake form link to the customer after payment.
 *
 * @param {string} customerEmail
 * @param {string} token         - Stripe checkout session ID
 * @param {object} claimData     - { name, holder, amount } from Stripe metadata
 */
async function sendIntakeEmail(customerEmail, token, claimData = {}) {
  
  

  const intakeUrl = `https://www.owedtoyou.net/claim-info.html?token=${encodeURIComponent(token)}`;
  const name = claimData.name || 'Valued Customer';
  const holder = claimData.holder || 'the state';
  const amount = claimData.amount ? `$${parseFloat(claimData.amount).toFixed(2)}` : 'your unclaimed funds';

  const bodyHtml = `
    <div class="card-header">
      <p>Action Required</p>
      <h1>Complete your claim — one quick form to go.</h1>
    </div>
    <div class="card-body">
      <p>Hi ${name},</p>
      <p>Your payment was received. To file your claim for <strong style="color:#34d399">${amount}</strong> held by <strong style="color:#e2e8f0">${holder}</strong>, we need a few details to submit the paperwork on your behalf.</p>
      <p>It takes about 2 minutes to complete. Click below to get started:</p>
      <a href="${intakeUrl}" class="cta-btn">Complete My Claim Info →</a>
      <div class="data-box">
        <div class="data-row"><span class="data-label">Funds held by</span><span class="data-value">${holder}</span></div>
        <div class="data-row"><span class="data-label">Amount owed</span><span class="data-value">${amount}</span></div>
      </div>
      <div class="badge">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        256-bit SSL encrypted
      </div>
      <hr class="divider"/>
      <p style="font-size:13px;color:#475569">If you didn't initiate this purchase, please reply to this email immediately.</p>
    </div>
  `;

  try {
    await sendEmail(customerEmail, 'Action Required: Complete your OwedToYou.net claim', emailWrapper(bodyHtml));
  } catch (err) {
    console.error(`[fulfillment] Failed to send intake email to ${customerEmail}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// sendClaimIdEmail
// ---------------------------------------------------------------------------

/**
 * Sends the claim confirmation to the customer — no further action required.
 *
 * @param {string} customerEmail
 * @param {string} claimId
 * @param {string} firstName
 */
async function sendClaimIdEmail(customerEmail, claimId, firstName) {
  const bodyHtml = `
    <div class="card-header">
      <p>Claim Confirmation</p>
      <h1>Your claim is being filed — here's your confirmation.</h1>
    </div>
    <div class="card-body">
      <p>Hi ${firstName || 'there'},</p>
      <p>We've received everything we need and are filing your unclaimed property claim with the state. Your Claim ID is:</p>
      <div class="data-box" style="text-align:center">
        <div style="font-size:11px;color:#64748b;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">Your Claim ID</div>
        <div style="font-size:26px;font-weight:800;color:#34d399;letter-spacing:3px;font-family:monospace">${claimId}</div>
      </div>
      <p>We'll update you when your check is on the way. <strong style="color:#e2e8f0">No further action is needed from you.</strong></p>
      <div class="data-box">
        <div class="data-row"><span class="data-label">Estimated processing time</span><span class="data-value">6–8 weeks</span></div>
        <div class="data-row"><span class="data-label">Status</span><span class="data-value" style="color:#34d399">Being Filed</span></div>
      </div>
      <hr class="divider"/>
      <p style="font-size:13px;color:#475569">Keep this email for your records. Your Claim ID is <strong style="color:#e2e8f0">${claimId}</strong>. Questions? Reply to this email.</p>
    </div>
  `;

  try {
    await sendEmail(customerEmail, 'Your claim is being filed — here\'s your confirmation', emailWrapper(bodyHtml));
    console.log(`[fulfillment] Claim ID email sent to ${customerEmail} (claimId: ${claimId})`);
  } catch (err) {
    console.error(`[fulfillment] Failed to send claim ID email to ${customerEmail}:`, err.message);
  }
}

module.exports = { sendIntakeEmail, sendClaimIdEmail };
