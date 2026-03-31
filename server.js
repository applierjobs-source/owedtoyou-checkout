const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const Stripe = require("stripe");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripePriceId = process.env.STRIPE_PRICE_ID;
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;

if (!stripeSecretKey) {
  console.warn("Missing STRIPE_SECRET_KEY. Checkout endpoint will fail until it is set.");
}

if (!stripePriceId) {
  console.warn("Missing STRIPE_PRICE_ID. Checkout endpoint will fail until it is set.");
}

const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!stripe || !stripePriceId) {
      return res.status(500).json({
        error: "Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID."
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price: stripePriceId,
          quantity: 1
        }
      ],
      success_url: `${publicBaseUrl}/?checkout=success`,
      cancel_url: `${publicBaseUrl}/?checkout=cancelled`,
      billing_address_collection: "auto",
      allow_promotion_codes: true
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error("Failed to create Stripe Checkout session:", error);
    return res.status(500).json({
      error: "Unable to start secure checkout right now. Please try again."
    });
  }
});

app.listen(port, () => {
  console.log(`Checkout page running on ${publicBaseUrl}`);
});
