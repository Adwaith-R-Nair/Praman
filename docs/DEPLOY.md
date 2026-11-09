# Deploying the hosted demo

This puts the demo at a public address: one free Render web service in Virginia, a free Neon Postgres database in AWS us-east-1, and an outside ping every 10 minutes so the service doesn't sleep. Everything it talks to is a sandbox: PayPal's sandbox, and Razorpay test mode if you add those keys at all.

It takes about 30 minutes. You need the GitHub repo, your PayPal sandbox app's client id and secret, a Gemini API key, and the demo key pair in `private/demo-mandate-keys.env`.

Nothing in this file is a secret. Every secret goes into Render's dashboard and nowhere else.

## What you end up with

| Piece | Where | Free limit that matters |
|---|---|---|
| Web service `praman-demo` | Render, region Virginia, plan Free | Sleeps after 15 minutes with no requests. 750 instance hours a month, which covers one service running all month. The disk is wiped on every restart, and nothing here writes to it. |
| Database | Neon Free, AWS us-east-1 (N. Virginia) | 100 compute hours a month. Suspends after 5 minutes idle and wakes on the next query. |
| Ping | cron-job.org, every 10 minutes, `GET /healthz` | `/healthz` answers from memory, so the ping keeps Render awake without waking Neon. |

The server only queries the database when someone uses the site, when PayPal sends a webhook, once at start, and every minute for 30 minutes after someone last used the demo (the sweeps that release unpaid checkouts and settle pending payments). So Neon sleeps most of the day.

## 1. The demo key pair

The hosted server signs a mandate for each visitor with its own key. It must never be your local `MANDATE_PRIVATE_KEY`, nor the `DEMO_MANDATE_*` pair in your `.env`. The server refuses to start in production with either.

A fresh pair was made with `pnpm keygen` and saved in `private/demo-mandate-keys.env`. `private/` is in `.gitignore`. Open that file in an editor when step 4 asks for the two values. Don't paste them into a chat, an issue, or a commit.

If you ever need a new pair: run `mkdir -p private && pnpm --silent keygen > private/demo-mandate-keys.env`, so the private key is never printed on screen, then open the file, delete the lines that aren't keys, and rename the two key names to `DEMO_MANDATE_PRIVATE_KEY` and `DEMO_MANDATE_PUBLIC_KEY`.

## 2. Neon: the database and its two addresses

1. Go to <https://console.neon.tech> and sign up or log in.
2. **Create project.** Name: `praman`. Postgres version: 17. Cloud provider: **AWS**. Region: **US East (N. Virginia), aws-us-east-1**, the closest to Render's Virginia region. Press **Create project**.
3. Optional but worth it: open **Branches**, then the `main` branch, then its compute, then **Edit**. Set the compute size to **0.25 CU** (both ends of autoscaling, if it shows a range) and leave scale to zero on. At 0.25 CU the 100 compute hours last 400 awake hours a month. The demo needs far less than that.
4. On the project dashboard press **Connect**. Leave the database as `neondb` and the role as the default owner.
5. With **Connection pooling** switched **on**, copy the connection string. Its host has `-pooler` in it. This is `DATABASE_URL`. The running server uses it.
6. Switch **Connection pooling** **off** and copy the string again. Its host has no `-pooler`. This is `DIRECT_DATABASE_URL`. Only the migrations in the build use it: they take a lock that a pooled connection can't hold.
7. Both strings end in `?sslmode=require`, sometimes with `&channel_binding=require` too. Keep them exactly as copied.

You don't create any tables. The Render build runs the migrations.

## 3. Render: the service from the Blueprint

The repo has a Blueprint, `render.yaml`. It defines the service, its build and start commands, the migration step, the fixed settings, and which secrets to ask you for.

1. Go to <https://dashboard.render.com> and sign up or log in. Connect your GitHub account when it asks, and give it access to the Praman repository.
2. Press **New**, then **Blueprint**.
3. Pick the Praman repository. For **Branch**, choose **paypal-hackathon**. Render finds `render.yaml` at the root.
4. **Blueprint name:** `praman`. Render lists one service, `praman-demo`, web service, Free, Virginia.
5. Render now asks for every value marked `sync: false`. Fill them in as in step 4 below, then press **Apply** (or **Deploy Blueprint**).

The first build takes a few minutes. It installs packages, generates the Prisma client, and runs `prisma migrate deploy` against `DIRECT_DATABASE_URL`. Render's pre-deploy command isn't on the free plan, so the migration runs in the build. A failed migration fails the build, and the old version keeps running.

## 4. The environment values

These are set by `render.yaml` and you don't touch them:

| Name | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Turns on the production start-up checks below. |
| `NODE_VERSION` | `24` | The Node version the repo is tested on. |
| `PAYPAL_BASE_URL` | `https://api-m.sandbox.paypal.com` | Any other value stops the server at start. |
| `DEMO_DAILY_MODEL_CALLS` | `400` | Model calls per UTC day for all visitors together. After that, steps replay a recorded model answer, labelled as one. |
| `TRUST_PROXY` | `3` | How many proxies in front of the server add the visitor's address to the right of `X-Forwarded-For`. The per-address limits read the entry that many places from the right, never the leftmost, which a visitor can write themselves. |

These Render asks you for:

| Name | What to paste | Required |
|---|---|---|
| `DATABASE_URL` | Neon's **pooled** string, from step 2.5 | Yes |
| `DIRECT_DATABASE_URL` | Neon's **direct** string, from step 2.6 | Yes |
| `DEMO_BASE_URL` | `https://praman-demo.onrender.com`. If Render gives the service a different address, change this to that address in step 5. No trailing slash. | Yes |
| `DEMO_MANDATE_PRIVATE_KEY` | The `DEMO_MANDATE_PRIVATE_KEY` value from `private/demo-mandate-keys.env`, one long line | Yes |
| `DEMO_MANDATE_PUBLIC_KEY` | The `DEMO_MANDATE_PUBLIC_KEY` value from the same file | Yes |
| `PAYPAL_CLIENT_ID` | Your **sandbox** app's client id, from developer.paypal.com, Apps & Credentials, Sandbox tab | Yes, for PayPal |
| `PAYPAL_CLIENT_SECRET` | The same app's sandbox secret | Yes, for PayPal |
| `PAYPAL_WEBHOOK_ID` | Leave empty for now. Step 6 fills it in. | After step 6 |
| `GEMINI_API_KEY` | Your Gemini API key | Yes, for the live model |
| `RAZORPAY_KEY_ID` | Leave empty. The demo doesn't use Razorpay; its shops use PayPal and a simulated rail. If you set it, it must start with `rzp_test_`. | No |
| `RAZORPAY_KEY_SECRET` | Leave empty, or the matching test-mode secret | No |

Leave out `MANDATE_PRIVATE_KEY`, `MANDATE_PUBLIC_KEY` and every `LANGFUSE_*` name. Don't add them later.

**The server checks these before it listens, and refuses to start** if any of these is true. Each reason is printed in the Render log as `receipt-ui: refusing to start: ...`, naming the variable and never its value.

- `PAYPAL_BASE_URL` isn't PayPal's sandbox, or PayPal's sandbox refuses the client id and secret (live credentials are refused there).
- `RAZORPAY_KEY_ID` doesn't start with `rzp_test_`, only one of the two Razorpay values is set, or `RAZORPAY_BASE_URL` is set.
- The demo key is missing, isn't a key pair, is the local mandate key, or is one of the developer keys from a `.env`.
- `MANDATE_PRIVATE_KEY` is set at all.
- `DEMO_BASE_URL` doesn't start with `https://`.

## 5. Check the address

1. When the deploy says **Live**, open the service in Render. The address is at the top, under the service name.
2. If it isn't `https://praman-demo.onrender.com`, open **Environment**, set `DEMO_BASE_URL` to the real address, and press **Save, rebuild, and deploy**. Pressing a demo button checks that the request came from this address, and PayPal sends visitors back to it, so it has to be exact.
3. Open `https://<your address>/healthz`. It should say `ok`.

## 6. The PayPal webhook

PayPal tells the server when a capture completes or is declined. Without the webhook, the sweep still settles those payments; the webhook makes it quicker.

1. Go to <https://developer.paypal.com/dashboard/applications/sandbox>. Make sure the **Sandbox** toggle is on.
2. Open the app whose client id you used in step 4.
3. Scroll to **Sandbox Webhooks** and press **Add Webhook**.
4. **Webhook URL:** `https://<your address>/webhooks/paypal`
5. Under event types, tick **Payment capture completed** (`PAYMENT.CAPTURE.COMPLETED`) and **Payment capture declined** (`PAYMENT.CAPTURE.DECLINED`). Nothing else.
6. Press **Save**. The webhook now shows in the list with a **Webhook ID**. Copy it.
7. Back in Render, open the service, then **Environment**. Set `PAYPAL_WEBHOOK_ID` to that id and press **Save, rebuild, and deploy**.

The server checks every delivery's signature with PayPal against this id before it reads it. A delivery that doesn't verify gets a 400 and changes nothing.

## 7. The ping, on cron-job.org

1. Go to <https://cron-job.org> and sign up or log in. It's free.
2. Press **Create cronjob**.
3. **Title:** `praman-demo healthz`. **URL:** `https://<your address>/healthz`.
4. **Execution schedule:** every **10** minutes.
5. Under **Advanced**, leave the method as GET. Set the timeout to 30 seconds; a service waking from sleep can take that long.
6. Press **Create**. After 10 minutes, its history should show `200`.

Ping only `/healthz`. Any other path reads the database and would keep Neon awake all month.

## 8. Smoke test

Do this in a normal browser window, with a private window or a second browser ready for the PayPal checkout, the way `docs/DEMO_INSTRUCTIONS.md` describes.

1. `https://<your address>/healthz` says `ok`.
2. `https://<your address>/` shows the front page. **Try the live demo** opens `/demo`, and the start page loads with no "isn't configured" notes beside the buttons.
3. **Start a session**. Step 2, the poisoned listing, runs with no PayPal login: the live model answers, the fooled cart is refused with `CATEGORY_OUT_OF_SCOPE`, and the panel beside the refusal says $109.00, labelled as arithmetic, with nothing charged.
4. Step 3: **Connect PayPal** with the sandbox buyer, and come back connected.
5. Step 4: approve. The money box says the saved PayPal account was charged with no buyer present.
6. Step 5: charged at once, nobody approved it.
7. Step 6: approve, open the PayPal link in the private window, pay, come back and **Capture the payment**. It shows captured.
8. Open step 6's **Ledger trace** and press **Verify this chain**. It says verified. Within a minute or two the trace should also show a **Settlement** box, from PayPal's `PAYMENT.CAPTURE.COMPLETED` webhook. If it doesn't, check the webhook's delivery history in PayPal's dashboard (Webhooks events) and the Render log.
9. Step 7 runs, and its traces open.
10. In the Render log, look for `receipt-ui listening`, and no `refusing to start` lines. No secret should appear anywhere in the log.
11. Leave a checkout unpaid: on a fresh session, get step 6 to its PayPal link and don't pay. After 11 minutes, reload the demo and press **Capture the payment**. It says the order wasn't approved in time, `ORDER_RELEASED`, and nothing is charged.

Check the per-address limit, from a terminal. This also checks that `TRUST_PROXY` is right for Render:

```sh
for i in 1 2 3 4 5 6 7 8; do curl -s -o /dev/null -w "%{http_code} " -X POST -H "X-Forwarded-For: 198.51.100.$i" https://<your address>/demo/start; done
```

The first five answer `303` and the rest `429`, even though each request claims a different address. Then, within ten minutes, open the demo on your phone over mobile data (not your Wi-Fi) and press **Start a session**. It must start.

- If all eight answer `303`, or the refusals come and go, the limit is reading an entry that changes between requests. On Render the header is the visitor, then a Cloudflare edge address, then Render's proxy, and the two proxy entries vary, so `TRUST_PROXY` must be `3` (D-78). Check that it is.
- If the phone also gets "Too many new demo sessions", the entry being read is shared by other visitors. Check `TRUST_PROXY` is `3` in Render's Environment.

## When something goes wrong

- **The build fails at `corepack enable`.** Change the start of the build command in the Render dashboard (Settings, Build Command) to `npm install -g pnpm@11.24.0 &&` instead of `corepack enable pnpm &&`, and deploy again.
- **The build fails at `migrate deploy`.** `DIRECT_DATABASE_URL` is probably the pooled string. Use the one without `-pooler`.
- **The service won't start.** Read the `refusing to start` lines in the log. Each one names the variable to fix.
- **Every demo button shows "That step didn't finish".** If the Render log has no matching `demo: ... failed` line, the request was refused because `DEMO_BASE_URL` doesn't match the address in the browser. Fix it as in step 5.
- **The first page is slow.** Render was asleep, or Neon was. The first request after a sleep can take 30 to 60 seconds. Check the cron job is running.
- **Steps say they replayed a recorded answer.** The day's 400 model calls are used up. It resets at 00:00 UTC. Raising `DEMO_DAILY_MODEL_CALLS` in `render.yaml` raises the Gemini bill too.
- **Start a session goes to a page headed "Recorded run, not live".** The day's new sessions are used up: 200 by default, for everyone together. It resets at 00:00 UTC. Set `DEMO_DAILY_SESSIONS` in Render's Environment to change it. You can open that page any time at `/demo/recorded` to see what visitors get.
- **A restart.** Render can restart a free service at any time. Visitors' sessions are in memory, so they end and visitors start again. The ledger, the daily counts and every trace are in Neon and stay.
