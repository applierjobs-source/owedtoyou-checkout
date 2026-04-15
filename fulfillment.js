'use strict';

const https = require('https');

const SENDGRID_API_KEY = () => process.env.SENDGRID_API_KEY || process.env.EMAIL_PASS;
const FROM = () => process.env.EMAIL_FROM || 'contact@owedtoyou.net';

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

function emailWrapper(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#0D1B2A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  .outer{background:#0D1B2A;padding:40px 16px}
  .logo-row{text-align:center;margin-bottom:28px}
  .logo-row a{text-decoration:none;color:#fff;font-size:18px;font-weight:700}
  .card{max-width:520px;margin:0 auto;background:#0f172a;border:1px solid #1e293b;border-radius:20px;overflow:hidden}
  .card-header{background:#059669;padding:24px 28px}
  .card-header p{color:#a7f3d0;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px}
  .card-header h1{color:#fff;font-size:22px;font-weight:700;line-height:1.35;margin:0}
  .card-body{padding:28px}
  .card-body p{color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 16px}
  .cta-btn{display:block;background:#10b981;color:#fff;text-decoration:none;text-align:center;padding:16px 24px;border-radius:12px;font-size:16px;font-weight:700;margin:24px 0}
  .divider{border:none;border-top:1px solid #1e293b;margin:20px 0}
  .data-box{background:#1e293b;border-radius:12px;padding:18px 20px;margin:16px 0;text-align:center}
  .footer-text{font-size:12px;color:#475569;text-align:center;margin-top:20px}
</style>
</head>
<body>
<div class="outer">
  <div class="logo-row"><a href="https://www.owedtoyou.net">OwedToYou.net</a></div>
  <div class="card">${bodyHtml}</div>
  <p class="footer-text">OwedToYou.net · <a href="https://www.owedtoyou.net" style="color:#475569">www.owedtoyou.net</a></p>
</div>
</body>
</html>`;
}

/**
 * Email 1: Sent after payment — asks customer to complete their claim info
 * Includes link to the intake form
 */
async function sendIntakeEmail(customerEmail, token, claimData = {}) {
  const name = claimData.name || 'there';
  const holder = claimData.holder || 'the state';
  const amount = claimData.amount ? `$${parseFloat(claimData.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'your funds';
  const intakeUrl = `https://www.owedtoyou.net/claim-info.html?token=${encodeURIComponent(token)}`;

  const bodyHtml = `
    <div class="card-header">
      <p>Action Required</p>
      <h1>Complete your info so we can file your claim</h1>
    </div>
    <div class="card-body">
      <p>Hi ${name},</p>
      <p>Your payment was received. We found <strong style="color:#fff">${amount}</strong> held by <strong style="color:#fff">${holder}</strong> in your name.</p>
      <p>To file your claim on your behalf, we need a few details from you. It takes about 2 minutes.</p>
      <a href="${intakeUrl}" class="cta-btn">Complete My Claim Info →</a>
      <hr class="divider"/>
      <p style="font-size:13px;color:#475569">Once you submit your info, we handle everything — paperwork, submission, and follow-up. You'll receive a confirmation when your claim is filed.</p>
    </div>
  `;

  try {
    await sendEmail(customerEmail, 'Action required: complete your info to file your claim', emailWrapper(bodyHtml));
  } catch (err) {
    console.error(`[fulfillment] Failed to send intake email to ${customerEmail}:`, err.message);
  }
}

/**
 * Email 2: Sent after customer submits their info — confirms we're filing on their behalf
 */
async function sendReceiptEmail(customerEmail, claimId, firstName) {
  const name = firstName || 'there';

  const bodyHtml = `
    <div class="card-header">
      <p>Info Received</p>
      <h1>We're on it — your claim is being filed.</h1>
    </div>
    <div class="card-body">
      <p>Hi ${name},</p>
      <p>We've received your information and are filing your unclaimed property claim with the state on your behalf. <strong style="color:#fff">No further action is needed from you.</strong></p>
      <div class="data-box">
        <div style="font-size:11px;color:#64748b;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">Your Reference ID</div>
        <div style="font-size:24px;font-weight:800;color:#34d399;letter-spacing:2px;font-family:monospace">${claimId}</div>
      </div>
      <p>We'll send you an update once your claim has been confirmed by the state. Funds are typically issued within <strong style="color:#fff">6–8 weeks</strong> of filing.</p>
      <hr class="divider"/>
      <p style="font-size:13px;color:#475569">Questions? Reply to this email and we'll get back to you.</p>
    </div>
  `;

  try {
    await sendEmail(customerEmail, 'We received your info — your claim is being filed', emailWrapper(bodyHtml));
  } catch (err) {
    console.error(`[fulfillment] Failed to send receipt email to ${customerEmail}:`, err.message);
  }
}

/**
 * Reminder email: Sent if customer hasn't completed their info yet
 */
async function sendReminderEmail(customerEmail, token, claimData = {}, reminderNum = 1) {
  const name = claimData.name || 'there';
  const amount = claimData.amount ? `$${parseFloat(claimData.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'your funds';
  const intakeUrl = `https://www.owedtoyou.net/claim-info.html?token=${encodeURIComponent(token)}`;
  const urgency = reminderNum >= 2 ? 'This is your final reminder.' : 'This only takes 2 minutes.';

  const bodyHtml = `
    <div class="card-header">
      <p>Reminder</p>
      <h1>Your ${amount} is still waiting to be claimed</h1>
    </div>
    <div class="card-body">
      <p>Hi ${name},</p>
      <p>We still need your information to file your unclaimed property claim. ${urgency}</p>
      <a href="${intakeUrl}" class="cta-btn">Complete My Claim Info →</a>
      <hr class="divider"/>
      <p style="font-size:13px;color:#475569">Your payment is secured. We just need your details to proceed.</p>
    </div>
  `;

  try {
    await sendEmail(customerEmail, `Reminder: complete your info to claim your ${amount}`, emailWrapper(bodyHtml));
  } catch (err) {
    console.error(`[fulfillment] Failed to send reminder email to ${customerEmail}:`, err.message);
  }
}

/**
 * Email 3: Sent when claim is actually confirmed filed with the state
 */
async function sendClaimConfirmedEmail(customerEmail, claimId, firstName) {
  const name = firstName || 'there';

  const bodyHtml = `
    <div class="card-header">
      <p>Claim Filed</p>
      <h1>Your claim has been filed with the state.</h1>
    </div>
    <div class="card-body">
      <p>Hi ${name},</p>
      <p>Your unclaimed property claim has been successfully filed. The state will review your claim and mail your check to the address on file.</p>
      <div class="data-box">
        <div style="font-size:11px;color:#64748b;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">Claim ID</div>
        <div style="font-size:24px;font-weight:800;color:#34d399;letter-spacing:2px;font-family:monospace">${claimId}</div>
      </div>
      <p>Estimated processing time: <strong style="color:#fff">6–8 weeks</strong>. You'll receive a check by mail when approved.</p>
      <hr class="divider"/>
      <p style="font-size:13px;color:#475569">Keep your Claim ID for your records. Questions? Reply to this email.</p>
    </div>
  `;

  try {
    await sendEmail(customerEmail, 'Your claim has been filed — check on the way', emailWrapper(bodyHtml));
  } catch (err) {
    console.error(`[fulfillment] Failed to send claim confirmed email to ${customerEmail}:`, err.message);
  }
}

// Keep sendClaimIdEmail as alias for sendReceiptEmail for backwards compatibility
const sendClaimIdEmail = sendReceiptEmail;

/**
 * Email: Sends the generated Money Owed PDF report as an attachment
 */
async function sendReportEmail(email, firstName, pdfBuffer) {
  const apiKey = SENDGRID_API_KEY();
  if (!apiKey) {
    console.warn('[fulfillment] No EMAIL_PASS (SendGrid API key) configured — skipping report email');
    return;
  }

  const pdfBase64 = pdfBuffer.toString('base64');

  const payload = JSON.stringify({
    personalizations: [{ to: [{ email }] }],
    from: { email: FROM(), name: 'OwedToYou.net' },
    subject: `Your Money Owed Report is Ready, ${firstName}`,
    content: [{
      type: 'text/html',
      value: emailWrapper(`
        <div class="card-header">
          <p>Report Ready</p>
          <h1>Your Money Owed report is attached.</h1>
        </div>
        <div class="card-body">
          <p>Hi ${firstName},</p>
          <p>Your personalized Money Owed report is attached to this email as a PDF. It includes:</p>
          <div style="margin:16px 0">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><span style="color:#10b981;font-weight:700">✓</span><span>Confirmed unclaimed property in your name</span></div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><span style="color:#10b981;font-weight:700">✓</span><span>Matched class action settlements</span></div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><span style="color:#10b981;font-weight:700">✓</span><span>Federal unclaimed money sources</span></div>
          </div>
          <p>To have us file every claim on your behalf:</p>
          <a href="https://www.owedtoyou.net/report-ready.html?name=${encodeURIComponent(firstName)}&email=${encodeURIComponent(email)}" class="cta-btn" style="display:block;background:#10b981;color:#fff;text-decoration:none;text-align:center;padding:16px;border-radius:12px;font-size:16px;font-weight:700;margin:20px 0">File All Claims for $95.99 →</a>
          <p style="font-size:13px;color:#475569">Full refund if we don't recover anything. One-time charge, no subscription.</p>
        </div>
      `)
    }],
    attachments: [{
      content: pdfBase64,
      filename: `Money-Owed-Report-${firstName}.pdf`,
      type: 'application/pdf',
      disposition: 'attachment'
    }]
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
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[fulfillment] Report email sent to ${email} (${res.statusCode})`);
          resolve();
        } else {
          console.error(`[fulfillment] SendGrid report email error ${res.statusCode}: ${body}`);
          reject(new Error(`SendGrid ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Email: Sent after user submits the free report request form on the homepage
 * Tells them their report is being generated and includes a pay CTA
 */
async function sendReportRequestEmail(customerEmail, firstName, checkoutUrl) {
  const name = firstName || 'there';
  const payUrl = checkoutUrl || 'https://www.owedtoyou.net/report-ready.html';

  const bodyHtml = `
    <div class="card-header">
      <p>Report In Progress</p>
      <h1>Your Money Owed report is being prepared</h1>
    </div>
    <div class="card-body">
      <p>Hi ${name},</p>
      <p>We're now searching unclaimed property databases across all 50 states, federal agencies, and 100+ active class action settlements for your name and address.</p>
      <p>Your personalized <strong style="color:#fff">Money Owed report</strong> will be emailed to you within minutes.</p>
      <hr class="divider"/>
      <p><strong style="color:#fff">Want us to file everything the moment your report is ready?</strong></p>
      <p>Pay our flat fee of <strong style="color:#fff">$95.99</strong> now and we'll file every unclaimed property claim and settlement on your behalf — no extra steps needed. Full refund if we recover nothing.</p>
      <a href="${payUrl}" class="cta-btn">File All Claims for $95.99 →</a>
      <hr class="divider"/>
      <p style="font-size:13px;color:#475569">Questions? Reply to this email and we'll get back to you. This is a legitimate unclaimed property recovery service.</p>
    </div>
  `;

  try {
    await sendEmail(customerEmail, 'Your Money Owed report is being prepared — OwedToYou.net', emailWrapper(bodyHtml));
  } catch (err) {
    console.error(`[fulfillment] Failed to send report request email to ${customerEmail}:`, err.message);
  }
}

module.exports = { sendIntakeEmail, sendReceiptEmail, sendClaimIdEmail, sendReminderEmail, sendClaimConfirmedEmail, sendReportRequestEmail, sendReportEmail };
