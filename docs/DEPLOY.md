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
| `DEMO_HOUSE_BUYER_TOKEN` | Leave empty for now. Step 9 fills it in, if you want visitors to be able to skip the PayPal login. | No |
| `SAMPLE_MANDATE_IDS` | Leave empty for now. Step 10 fills it in, if you want a public sample run at `/sample`. Not a secret. | No |
| `RAZORPAY_KEY_ID` | Leave empty. The demo doesn't use Razorpay; its shops use PayPal and a simulated rail. If you set it, it must start with `rzp_test_`. | No |
| `RAZORPAY_KEY_SECRET` | Leave empty, or the matching test-mode secret | No |

One more name is read if you add it in the dashboard: `DEMO_DAILY_HOUSE_SESSIONS`, how many sessions per UTC day may use the house buyer from step 9. Unset, it is 50. Set to `0`, the house buyer is off even with its token in place, and the server still refuses to delete that token at PayPal.

Leave out `MANDATE_PRIVATE_KEY`, `MANDATE_PUBLIC_KEY` and every `LANGFUSE_*` name. Don't add them later.

**The server checks these before it listens, and refuses to start** if any of these is true. Each reason is printed in the Render log as `receipt-ui: refusing to start: ...`, naming the variable and never its value.

- `PAYPAL_BASE_URL` isn't PayPal's sandbox, or PayPal's sandbox refuses the client id and secret (live credentials are refused there).
- `RAZORPAY_KEY_ID` doesn't start with `rzp_test_`, only one of the two Razorpay values is set, or `RAZORPAY_BASE_URL` is set.
- The demo key is missing, isn't a key pair, is the local mandate key, or is one of the developer keys from a `.env`.
- `MANDATE_PRIVATE_KEY` is set at all.
- `DEMO_BASE_URL` doesn't start with `https://`.
- `DEMO_HOUSE_BUYER_TOKEN` isn't a PayPal token id, or is set without `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.

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

## 9. Optional: the house buyer, so visitors can skip the PayPal login

Without this step a visitor connects PayPal by logging in as a sandbox buyer. With it, step 3 of the demo also offers **Use the demo's sandbox buyer**: the session's purchases below the mandate's approval line are charged to one sandbox account you approved saving, under that visitor's own signed mandate. Purchases at or above the line still go to PayPal's checkout, where a buyer has to log in. D-85 has the reasons and the limits. The main one: strangers charge that sandbox account, within each session's mandate ($60.00), and it is sandbox money.

**Use a sandbox buyer account kept for this alone.** Make a second Personal sandbox account (developer.paypal.com, Testing Tools, Sandbox Accounts) and use it for nothing else. It must not be the account whose login goes in the Devpost testing instructions, and you shouldn't connect it on the demo by logging in yourself. The reason is where the delete guard lives:

- A server refuses to delete this token only if it was started with `DEMO_HOUSE_BUYER_TOKEN` set. It can't guard a token it was never told.
- Any other server using the same PayPal app deletes the token a PayPal login gives it when that session ends, expires, or the server stops. That is `pnpm receipt-ui` on your machine, and the hosted server once the secret is removed.
- If someone connects there by logging in as the house buyer's account, and PayPal answers with the same token, the house token is deleted. Every house session is then refused, charging nothing, until you consent again.
- Whether PayPal answers a second approval by the same account with the same token or a new one has not been checked against the sandbox. With an account nobody else logs in to, it doesn't matter.

You consent once, as that sandbox buyer, on your own machine:

1. Your local `.env` must have the same `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` as Render. Only the app that saved a buyer can charge it.
2. Run `pnpm house-buyer`. It asks PayPal's sandbox for an approval page and prints its address.
3. Open that address in a private window. Log in as the sandbox **buyer** you made for this and agree. PayPal then sends the browser to the address the script named: your local `DEMO_BASE_URL`, or `http://localhost:4100/` if that is unset. Nothing there needs doing. If no server is running there the browser shows a connection error, and that is fine: the approval is already given.
4. Back in the terminal, press Enter. The script asks PayPal for the payment token and writes it to `~/.praman/house-buyer-token`, a file outside the repo that only you can read. It never prints the token. If PayPal gives no answer, press Enter to ask again: it repeats the same request. If you stop there instead, the script says a token may exist at PayPal that it didn't write down, and you run it again from step 2. To put the file somewhere else, pass a path: `pnpm house-buyer /some/path/outside/the/repo`. It refuses a path inside the repo and never overwrites a file.
5. Open the file in an editor and copy its one line. In Render, open the service, **Environment**, set `DEMO_HOUSE_BUYER_TOKEN` to it, and press **Save, rebuild, and deploy**. Don't paste it into a chat, an issue or a commit.
6. The Render log now says `receipt-ui: house buyer on`. Start a session in a fresh private window: step 3 shows **Use the demo's sandbox buyer** beside **Connect PayPal**. Press it, run step 4 and approve. The step says it was paid from the demo's sandbox buyer account, with no buyer present.
7. In the sandbox dashboard, check that buyer account has a balance or a funding source that will last. The story charges it $17.00 a session, and the cap is 50 sessions a day.
8. If you run the demo on your own machine with the same PayPal app, add the token to your local `.env` as `DEMO_HOUSE_BUYER_TOKEN` with `DEMO_DAILY_HOUSE_SESSIONS=0`. The local server then offers nothing and still refuses to delete that token. `.env` is gitignored.

To switch it off, set `DEMO_DAILY_HOUSE_SESSIONS` to `0` in Render and deploy. Leave `DEMO_HOUSE_BUYER_TOKEN` in place. Visitors then see the demo exactly as it was before this step: the choice is gone and a POST to its address is a 404. The server still knows the token, so it still won't delete it, and the log says `receipt-ui: house buyer off`.

Deleting `DEMO_HOUSE_BUYER_TOKEN` also switches it off, and removes the guard with it, as above. Do that only when the token no longer matters.

A server with `DEMO_HOUSE_BUYER_TOKEN` set never deletes this token at PayPal, whatever ends a session. If the token itself should go, delete it with PayPal's vault API (`DELETE /v3/vault/payment-tokens/<id>`) using the same app. Nothing in this repo does that for you.

## 10. Optional: pin a sample run at /sample

`/sample` shows one past demo session to anyone, read-only: its ledger rows in the console, with a link to each trace's public page and public dispute bundle. It carries no budgets and no step-up reasons (D-88). Until you name a session, `/sample` is a 404 and nothing links to it.

1. On the hosted site, run one whole session, all eight steps, paying the checkout in step 6. This is the run strangers will read, so let each step finish.
2. Before ending that session, open **Open your ledger console**. The tiles at the top name its two mandates: `mnd_demo_<ref>` for the story and `mnd_demo_<ref>_h` for the twenty-at-once step. Copy both ids. They are also in the grid's Mandate column.
3. In Render, open the service, **Environment**, and set `SAMPLE_MANDATE_IDS` to the two ids with a comma between them and nothing else, for example `mnd_demo_ab12cd34ef56,mnd_demo_ab12cd34ef56_h`. Press **Save, rebuild, and deploy**. The ledger rows are in Neon, so the restart doesn't lose them.
4. Open `https://<your address>/sample` in a private window. It should say **Chain verified** and list that session's rows. The front page now has a **See a sample run** line under the demo button, and `/traces` links to it too.
5. From your machine, run `pnpm e2e:hosted`. `e2e/hosted/sample.spec.ts` makes GET requests only and should print a line starting `sample: populated`. If it prints `sample: none is set on this server`, the variable didn't take.

The sample shows that session's sandbox order and capture ids, which its public trace pages already show. To take the sample down, empty the variable and deploy.

## When something goes wrong

- **`/sample` says "No sample run on this server" after step 10.** The value is empty or malformed, and a malformed value is treated as none. It takes at most four ids, comma-separated, each made only of letters, digits, `_` and `-`. No quotes and no spaces inside an id.

- **The build fails at `corepack enable`.** Change the start of the build command in the Render dashboard (Settings, Build Command) to `npm install -g pnpm@11.24.0 &&` instead of `corepack enable pnpm &&`, and deploy again.
- **The build fails at `migrate deploy`.** `DIRECT_DATABASE_URL` is probably the pooled string. Use the one without `-pooler`.
- **The service won't start.** Read the `refusing to start` lines in the log. Each one names the variable to fix.
- **Every demo button shows "That step didn't finish".** If the Render log has no matching `demo: ... failed` line, the request was refused because `DEMO_BASE_URL` doesn't match the address in the browser. Fix it as in step 5.
- **The first page is slow.** Render was asleep, or Neon was. The first request after a sleep can take 30 to 60 seconds. Check the cron job is running.
- **Steps say they replayed a recorded answer.** The day's 400 model calls are used up. It resets at 00:00 UTC. Raising `DEMO_DAILY_MODEL_CALLS` in `render.yaml` raises the Gemini bill too.
- **Start a session goes to a page headed "Recorded run, not live".** The day's new sessions are used up: 200 by default, for everyone together. It resets at 00:00 UTC. Set `DEMO_DAILY_SESSIONS` in Render's Environment to change it. You can open that page any time at `/demo/recorded` to see what visitors get.
- **Step 3 no longer offers the demo's sandbox buyer.** Either the day's house-buyer sessions are used up (50 by default, resets at 00:00 UTC, `DEMO_DAILY_HOUSE_SESSIONS` changes it), or PayPal refused a charge to it. A refusal is in the log as `demo: PayPal refused the house buyer: <code>`. Nothing was charged, and the choice comes back after 30 minutes, then an hour, doubling up to a day while PayPal keeps refusing. Refusals that arrive together count once. Check the sandbox buyer's balance and that the token is still saved. The PayPal login keeps working throughout.
- **A visitor is told the demo's sandbox buyer "has been used from your address as often as it allows in a day".** One address may put 15 sessions a day on the house buyer, so one address can't use up the day's 50. The count is in memory: it clears after 24 hours or on a restart. The PayPal login still works for that visitor.
- **A restart.** Render can restart a free service at any time. Visitors' sessions are in memory, so they end and visitors start again. The ledger, the daily counts and every trace are in Neon and stay.
