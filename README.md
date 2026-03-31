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
