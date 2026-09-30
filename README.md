# Brytely Threads storefront

*A little brighter, thread by thread.*

A custom storefront for Brytely Threads. There's no Shopify, WooCommerce or other hosted shop platform behind it.

| Piece | What it does |
|---|---|
| **Next.js 15 (App Router) + TypeScript + Tailwind v4** | The storefront and admin. |
| **Cloudflare Workers (via OpenNext)** | Hosts the site, API routes, webhooks and the hourly cron. |
| **Cloudflare D1** | Holds the product catalog, orders, tags and the audit log. |
| **Cloudflare KV** | Caches the catalog index so pages don't hit D1 or Printify on every view. |
| **Cloudflare R2** | Stores mirrored product mockups (optional). |
| **Printify API** | Syncs the catalog, creates orders and sends status/tracking webhooks. |
| **Stripe Checkout** | Hosted payment page. Card data never touches this app. |
| **Resend** (optional) | Sends order confirmations, shipped emails and admin alerts. |

> **Pages vs Workers:** the spec asked for Cloudflare Pages. Cloudflare's supported way to run a full Next.js app now is Workers with static assets through the OpenNext adapter; the old `next-on-pages` adapter is deprecated. You get the same CDN-served assets and git-connected deploys, plus cron triggers in the same project.

---

## How an order flows

```
Cart (browser) ──POST /api/checkout──► server re-prices every line from D1
                                        creates order (pending_payment) + Stripe Checkout Session
Customer pays on Stripe ──webhook──► /api/webhooks/stripe  (signature verified)
                                        order → paid → submitting → Printify POST /orders.json → submitted
                                        (optional) send_to_production
Printify ──webhooks──► /api/webhooks/printify  (token + HMAC verified)
                                        re-fetches the order → in_production / shipped / delivered
                                        saves tracking, emails customer once
Customer ──► /orders  (order number + email) shows the status "thread" and tracking links
```

### Why a paid order can't be dropped silently

The spec said a failed silent order is worse than a plain page, so Printify submission has several layers of protection:

1. **Retries with backoff** on network errors, timeouts, 429 and 5xx. A 4xx such as a bad address is never retried blindly. It is recorded and surfaced.
2. **Duplicate protection.** Before any retry, the app checks Printify for an order with our `external_id`. If a POST went through but its response was lost, the order isn't created twice.
3. **Atomic claim in D1.** Concurrent webhook deliveries can't double-submit.
4. **Stripe redelivery.** If submission fails, the webhook returns 500 and Stripe retries for up to 3 days.
5. **Hourly cron sweep.** It retries `submit_failed` or stuck orders, retries failed send-to-production calls, and polls open orders in case a Printify webhook was missed.
6. **Success-page fallback.** If the customer lands on the confirmation page before the webhook (or the webhook is misconfigured), the page confirms payment with Stripe directly and submits.
7. **Admin alert email** plus a **Needs attention** panel at the top of `/admin` with a **Retry** button and a per-order event log.

`tests/order-flow.test.ts` exercises all of this against the real schema: lost responses, outages, 400s, concurrency, forged webhooks, duplicate deliveries and out-of-order status updates.

---

## First-time setup

Prerequisites: Node 22+, a Cloudflare account, a Printify account with a **Custom integration (API)** store, and a Stripe account.

```bash
npm install

# 1. Cloudflare resources
npx wrangler login
npx wrangler d1 create brytely-threads            # copy database_id → wrangler.jsonc
npx wrangler kv namespace create CATALOG_CACHE    # copy id → wrangler.jsonc
npx wrangler r2 bucket create brytely-media

# 2. Local secrets
cp .env.example .dev.vars                          # fill in values (see comments inside)
npm run printify:shops                             # prints your shop id → PRINTIFY_SHOP_ID

# 3. Database
npm run db:migrate:local
npm run db:migrate                                 # remote D1

# 4. Production secrets (one at a time; each prompts for the value)
for s in PRINTIFY_API_TOKEN PRINTIFY_SHOP_ID PRINTIFY_WEBHOOK_SECRET STRIPE_SECRET_KEY \
         STRIPE_WEBHOOK_SECRET ADMIN_USERNAME ADMIN_PASSWORD RESEND_API_KEY; do
  npx wrangler secret put $s
done

# 5. Set SITE_URL etc. in wrangler.jsonc → "vars", and NEXT_PUBLIC_* in .env.production

# 6. Deploy
npm run deploy
```

After the first deploy:

1. **Stripe webhook.** In Stripe, go to Developers → Webhooks → Add endpoint.
   - URL: `https://YOUR-DOMAIN/api/webhooks/stripe`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET`, then redeploy.
2. **Printify webhooks.** Open `https://YOUR-DOMAIN/admin` and click **Register webhooks**. It's safe to click again.
3. **Load the catalog.** In `/admin`, click **Sync from Printify now**.
4. **Custom domain.** In Cloudflare, go to Workers → brytely-threads → Settings → Domains & Routes.
5. *(Optional)* **Image resizing.** In Cloudflare, go to your zone → Images → Transformations and enable it for the zone. Allow resizing from `images-api.printify.com` (or keep `MIRROR_IMAGES=true` so images come from your own R2). Then set `NEXT_PUBLIC_CF_IMAGE_RESIZING=true` in `.env.production` and redeploy.
6. *(Recommended)* **Cloudflare Access.** In Zero Trust, go to Access → Applications and protect `/admin*` and `/api/admin*` with your email, on top of the built-in basic auth.

### Local development

```bash
npm run dev                 # next dev with D1/KV/R2 emulated via wrangler
npm run preview             # full Workers runtime locally (port 8787)
npm run stripe:listen       # Stripe CLI forwards test webhooks to the preview
npm test                    # order-flow tests (Node's built-in SQLite, no network)
```

---

## How to add a new product

You never touch code for this.

1. **Design it in Printify** as usual: pick the blank, upload artwork, enable the colors and sizes you want, and set **retail prices**. The site uses Printify's retail price as the selling price.
2. **Add tags in Printify.** The tags *are* your collections. A tag like `Golf`, `Coffee`, `Hiking` or `Dog People` becomes a filter on the shop page and a woven label on the home page. A brand-new niche is just a new tag. No schema or code change is needed.
   - Printify's auto-added generic tags (T-shirts, DTG, Crew neck and so on) are stored but hidden from the filter bar. Toggle any tag on or off in `/admin → Collections`.
3. **Click "Publish" in Printify.** The store gets a webhook, imports the product immediately, and tells Printify the publish succeeded. The product page goes live at `/products/<title-slug>`.
   - Without publishing, the hourly sync still picks up any visible product within the hour. Click **Sync from Printify now** in `/admin` if you're impatient.
   - Set `CATALOG_MODE=published_only` if you only want products that went through **Publish** to appear.
4. *(Optional)* In `/admin → Products`, mark it **Featured** so it shows on the home page, or hide it without deleting it in Printify.

Editing a title, description, price or mockup in Printify flows through on the next sync. The URL stays the same even if the title changes. Deleting a product in Printify hides it on the site but keeps it in order history.

---

## How to rotate API keys

Every credential lives in Worker secrets, so rotating one never needs a code change.

| Secret | Rotate by |
|---|---|
| `PRINTIFY_API_TOKEN` | Printify → Account → Connections → generate a new token with the same scopes → `npx wrangler secret put PRINTIFY_API_TOKEN` → delete the old token in Printify. |
| `PRINTIFY_WEBHOOK_SECRET` | `openssl rand -hex 32` → `wrangler secret put PRINTIFY_WEBHOOK_SECRET` → `/admin` → **Register webhooks**. This replaces the old subscriptions. |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → **Roll key**. Pick an expiry for the old key so there's no downtime. Then `wrangler secret put STRIPE_SECRET_KEY`. |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → your endpoint → **Roll secret** → `wrangler secret put STRIPE_WEBHOOK_SECRET`. |
| `ADMIN_PASSWORD` | `wrangler secret put ADMIN_PASSWORD`. Use 12 or more characters. |
| `RESEND_API_KEY` | Resend → API Keys → create new → `wrangler secret put` → revoke old. |

`wrangler secret put` takes effect immediately and doesn't need a redeploy. If a key was ever pasted into a chat, doc, email or git commit, rotate it.

---

## How to redeploy

```bash
git pull
npm install
npm run db:migrate      # only if migrations/ changed; safe to run anyway
npm test
npm run deploy
```

To deploy on every push instead, connect the repo in Cloudflare (Workers → brytely-threads → Settings → Builds). Set the build command to `npx opennextjs-cloudflare build` and the deploy command to `npx opennextjs-cloudflare deploy`.

To roll back, use Cloudflare dashboard → Workers → brytely-threads → Deployments → pick a previous version → **Rollback**.

To watch logs live, run `npx wrangler tail`. Every Printify and Stripe call logs structured JSON, and the key lines are prefixed `PRINTIFY SUBMISSION FAILED` and `ADMIN ALERT`.

---

## Test the order flow before going live

Printify has no true sandbox. The safe equivalent is to create real Printify orders that are **never sent to production**, and then cancel them.

1. Keep `PRINTIFY_SEND_TO_PRODUCTION = "false"` and use Stripe **test** keys (`sk_test_…`). `/admin` shows **Stripe: TEST** and **Auto-send to production: OFF**.
2. Add a product to the cart and check out with card `4242 4242 4242 4242`, any future date and any CVC. Use a real-format US address.
3. Confirm each step:
   - The success page shows the order ticket with its `BT-…` number.
   - `/admin → Recent orders` shows it as **submitted** with a Printify order id.
   - Printify → Orders shows it **On hold**, with the right variant, quantity and address.
   - You receive the confirmation email if Resend is configured.
4. Test the failure path. Temporarily set a wrong `PRINTIFY_API_TOKEN` secret and place another test order. You should see the order under **Needs attention** in `/admin`, an alert email, and Stripe showing the webhook as failing and retrying. Restore the token and click **Retry**. The order should submit exactly once.
5. **Cancel the test orders in Printify** (Orders → select → Cancel) so they're never printed or charged.
6. To test shipping updates without shipping anything, run `npm test`, which simulates Printify shipment webhooks end to end. After launch, your first real order exercises the live path.

**Going live:** switch to `sk_live_…` and create a live-mode webhook with its own `whsec_…`. Set `PRINTIFY_SEND_TO_PRODUCTION = "true"` and make sure your Printify account has a payment method. Place one real order for yourself.

---

## Project map

```
custom-worker.ts            Worker entry: Next.js handler + hourly cron (order sweep, catalog sync)
wrangler.jsonc              Bindings (D1, KV, R2), cron, non-secret vars
migrations/0001_init.sql    Schema: products, variants, tags (generic), orders, events, sync runs
src/lib/printify.ts         Printify client (retries, duplicate-safe order creation, webhooks)
src/lib/stripe.ts           Stripe REST client + webhook signature verification (WebCrypto)
src/lib/catalog.ts          Sync Printify → D1, KV-cached catalog reads
src/lib/orders.ts           Checkout, payment, Printify submission state machine, status mapping, sweep
src/lib/webhooks.ts         Stripe + Printify webhook handlers, webhook registration
src/lib/notify.ts           Emails (Resend)
src/app/…                   Pages: home, shop, product, cart, checkout/success, orders, admin
src/app/api/…               checkout, webhooks, order lookup, admin actions
src/app/brand.css           Design system (tokens, woven labels, hang tags, order ticket)
tests/                      End-to-end order-flow tests on SQLite
```

### Design notes

The UI stays neutral (cool paper and ink) so product photos carry the color. There's one loud accent, "Brytely yellow", used like a highlighter. The visual language comes from the garment trade: collections are **woven labels**, prices sit on **hang tags**, the header has a **stitched seam** that sews itself in on load, and order status is a **ticket** with progress drawn as a thread with knots. It's mobile-first, supports dark mode, and respects reduced motion. Typefaces are Bricolage Grotesque, Hanken Grotesk and Martian Mono.

### Known limits

- Shipping is charged as a flat rate you set (`SHIPPING_RATES`), because the address isn't known until the customer is on Stripe's page. Set it at or slightly above your typical Printify shipping cost.
- Refunds are issued in Stripe. Cancel the matching Printify order by hand if it hasn't gone to production yet.
- Sales tax: set `STRIPE_AUTOMATIC_TAX=true` after enabling Stripe Tax.
