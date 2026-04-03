'use strict';

const nodemailer = require('nodemailer');

/**
 * Create a nodemailer transporter from environment variables.
 * Returns null and logs a warning if required env vars are missing.
 */
function createTransporter() {
  const host = process.env.EMAIL_HOST;
  const port = parseInt(process.env.EMAIL_PORT || '587', 10);
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!host || !user || !pass) {
    console.warn('[fulfillment] Email not configured — missing EMAIL_HOST, EMAIL_USER, or EMAIL_PASS');
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });
}

const FROM = () => process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@owedtoyou.net';

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
  const transporter = createTransporter();
  if (!transporter) return;

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

  const mailOptions = {
    from: `"OwedToYou.net" <${FROM()}>`,
    to: customerEmail,
    subject: 'Action Required: Complete your OwedToYou.net claim',
    html: emailWrapper(bodyHtml),
    text: [
      `Hi ${name},`,
      '',
      `Your payment was received. To file your claim for ${amount} held by ${holder}, please complete your claim information here:`,
      '',
      intakeUrl,
      '',
      'It takes about 2 minutes. Your information is encrypted and secure.',
      '',
      '— OwedToYou.net'
    ].join('\n')
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[fulfillment] Intake email sent to ${customerEmail} (messageId: ${info.messageId})`);
  } catch (err) {
    console.error(`[fulfillment] Failed to send intake email to ${customerEmail}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// sendClaimIdEmail
// ---------------------------------------------------------------------------

/**
 * Sends the claim ID and next steps to the customer.
 *
 * @param {string} customerEmail
 * @param {string} claimId
 * @param {string} firstName
 */
async function sendClaimIdEmail(customerEmail, claimId, firstName) {
  const transporter = createTransporter();
  if (!transporter) return;

  const uploadUrl = 'https://claimit.ca.gov/app/claim-doc-upload';

  const bodyHtml = `
    <div class="card-header">
      <p>Claim Filed</p>
      <h1>Your claim has been filed — one step left.</h1>
    </div>
    <div class="card-body">
      <p>Hi ${firstName || 'there'},</p>
      <p>Great news — your claim has been filed with the state. Here is your unique Claim ID:</p>
      <div class="data-box" style="text-align:center">
        <div style="font-size:11px;color:#64748b;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">Your Claim ID</div>
        <div style="font-size:26px;font-weight:800;color:#34d399;letter-spacing:3px;font-family:monospace">${claimId}</div>
      </div>
      <p>To complete your claim, upload a photo of your driver's license or state ID. Log in using your email and the Claim ID above.</p>
      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-text">Visit <a href="${uploadUrl}" style="color:#10b981">${uploadUrl}</a></div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-text">Log in with your email and Claim ID: <strong>${claimId}</strong></div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div class="step-text">Upload a clear photo of your driver's license or state-issued ID</div>
        </div>
        <div class="step">
          <div class="step-num">4</div>
          <div class="step-text"><strong>Done.</strong> The state will process your claim and send funds directly — typically within 6–8 weeks</div>
        </div>
      </div>
      <a href="${uploadUrl}" class="cta-btn">Upload My ID Now →</a>
      <hr class="divider"/>
      <p style="font-size:13px;color:#475569">Keep this email for your records. Your Claim ID is <strong style="color:#e2e8f0">${claimId}</strong>.</p>
    </div>
  `;

  const mailOptions = {
    from: `"OwedToYou.net" <${FROM()}>`,
    to: customerEmail,
    subject: 'Your claim has been filed — next step inside',
    html: emailWrapper(bodyHtml),
    text: [
      `Hi ${firstName || 'there'},`,
      '',
      `Your claim has been filed. Your Claim ID is: ${claimId}`,
      '',
      'Next step: Upload your driver\'s license or state ID at:',
      uploadUrl,
      '',
      `Log in with your email and Claim ID: ${claimId}`,
      '',
      'Funds are typically sent within 6–8 weeks of ID verification.',
      '',
      '— OwedToYou.net'
    ].join('\n')
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[fulfillment] Claim ID email sent to ${customerEmail} (claimId: ${claimId}, messageId: ${info.messageId})`);
  } catch (err) {
    console.error(`[fulfillment] Failed to send claim ID email to ${customerEmail}:`, err.message);
  }
}

module.exports = { sendIntakeEmail, sendClaimIdEmail };
