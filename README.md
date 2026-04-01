# Owed To You Checkout Page

Single-page checkout landing page with a Stripe Checkout button, marketing section, Terms and Conditions, and Privacy Policy.

## Stack

- Node.js + Express
- Stripe Checkout API
- Static HTML/CSS/JS frontend

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your environment file:

   ```bash
   cp .env.example .env
   ```

3. Fill these values in `.env`:

- `STRIPE_SECRET_KEY` from Stripe Dashboard.
- `STRIPE_PRICE_ID` from Stripe (recommended), or use fallback amount vars below.
- `STRIPE_AMOUNT_CENTS` (fallback when no `STRIPE_PRICE_ID`, default: `1295`)
- `STRIPE_CURRENCY` (fallback currency, default: `usd`)
- `PUBLIC_BASE_URL` (for local testing: `http://localhost:3000`).

4. Run the server:

   ```bash
   npm start
   ```

5. Open:

- `http://localhost:3000`

## Stripe notes

- The button calls `POST /create-checkout-session`.
- The server creates a Stripe Checkout session and returns a hosted checkout URL.
- If `STRIPE_PRICE_ID` is missing, server uses a fallback one-time amount (`STRIPE_AMOUNT_CENTS`/`STRIPE_CURRENCY`).
- Success and cancel states redirect back to `/?checkout=success` or `/?checkout=cancelled`.

### If you see “Stripe configuration error” or checkout fails

1. **`STRIPE_PRICE_ID` must be a Price ID** — starts with `price_`, from **Product catalog → your product → Pricing**. Do **not** use a Product ID (`prod_...`) or the dollar amount.
2. **Test vs live must match** — `sk_test_...` keys only work with prices created in **Test mode** in the Dashboard. `sk_live_...` only with **Live mode** prices. Toggle “Test mode” in Stripe (top right) and copy the price from the same mode as your secret key.
3. **No stray spaces** — re-paste `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID` in Railway (whitespace is trimmed in code, but wrong characters still break).
4. **Fallback without a Price ID** — remove `STRIPE_PRICE_ID` from Railway and set `STRIPE_AMOUNT_CENTS=1295` and `STRIPE_CURRENCY=usd` so Checkout uses an inline amount (still needs a valid `STRIPE_SECRET_KEY`).
5. **See Stripe’s exact error** — set `STRIPE_DEBUG=true` in Railway, redeploy, click checkout again; the JSON response may include a `detail` field. Check **Deployments → View logs** for `Failed to create Stripe Checkout session:`.

## Deploy on GitHub + Railway

1. Push this folder to a GitHub repo.
2. In Railway, create a new project from that GitHub repo.
3. Set Railway environment variables:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_PRICE_ID` (or use fallback amount vars below)
   - `STRIPE_AMOUNT_CENTS` (optional fallback, e.g. `1295`)
   - `STRIPE_CURRENCY` (optional fallback, e.g. `usd`)
   - `PUBLIC_BASE_URL` (your Railway app URL, e.g. `https://your-app.up.railway.app`)
4. Railway will auto-detect Node and run `npm start`.

## Customization points

- Edit hero, card, marketing, and legal text in `public/index.html`.
- Update styling in `public/styles.css`.
- Change checkout behavior in `server.js`.
