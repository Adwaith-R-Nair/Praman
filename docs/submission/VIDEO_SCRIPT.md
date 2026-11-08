# Video script and shot list

Target length is 2:50. The rule is under 3 minutes, public on YouTube, showing the project working. The narration below is about 370 words, which fits at a steady pace.

## Rules to keep

- **Music:** none, or a track you hold the rights to. No copyrighted music.
- **Trademarks:** no third-party logos or brand names on screen without permission, beyond what the working product shows. Close other tabs, hide bookmarks, and don't show other companies' products.
- **Secrets:** the sandbox password must never be on screen. Pause the recording or cut while you type it. Never show the Render environment page or `.env`.

## Before recording

1. Open <https://praman-demo.onrender.com> a couple of minutes ahead, so the free host is awake.
2. Do one full rehearsal, then wait: each address gets 5 new sessions per 10 minutes.
3. Have a private window ready and logged out of PayPal for step 5.
4. Do the refund before the revoke step, in the order below.
5. Browser zoom at about 110%, 1080p, notifications off.

## Who does what

**[YOU]** marks a step only you can do, on the live PayPal sandbox: logging in, approving, and pressing capture and refund. Everything else on screen is also you pressing demo buttons. Nothing here is automated.

## Shot list

| Time | On screen | Action | Narration |
|---|---|---|---|
| 0:00 to 0:14 | Front page, the poisoned listing | Slow scroll | "This line is hidden in a shop listing. It tells an AI shopping agent to add a gift card to every order. If that agent holds a payment method, one sentence from a stranger can spend your money." |
| 0:14 to 0:30 | Front page, Who it is for | Scroll | "Praman is for merchants and platforms that let agents pay, and for people who hand an agent a budget. The agent can only propose. A policy engine with no model inside it decides. A ledger records all of it." |
| 0:30 to 0:42 | `/demo`, step 1 | Press **Start a session** | "I start with a signed mandate. Sixty dollars in total, nothing over forty, ask me at twenty or more, and ask me the first time at any shop." |
| 0:42 to 0:54 | Step 2, PayPal page | **[YOU]** Press **Connect PayPal**, log in and agree. Cut the password typing | "I connect PayPal once. The saved account stays on the server. The agent never sees it." |
| 0:54 to 1:10 | Step 3 | **[YOU]** Press buy lunch, then **Approve this purchase** | "A live model proposes a bowl, as a product code and a quantity. It has no way to state a price. It's a new shop, so Praman asks me. I approve, and twelve fifty is charged." |
| 1:10 to 1:20 | Step 4 | Press buy a coffee | "Same shop, four fifty. Nobody approved this. Praman's decision was the only thing between the agent and the money." |
| 1:20 to 1:42 | Step 5, then private window | **[YOU]** Approve, open the link in the private window, log in, pay, return and press **Capture the payment** | "Thirty-two dollars is over my line, so I approve, and then I pay at PayPal as the buyer. Before taking the money, Praman checks the mandate again, because it could have been revoked while I was at PayPal." |
| 1:42 to 2:02 | Step 6, listing, then Refused | Press the step's buttons and show the labels | "Here's that listing again. This live model ignored it. So here's the cart from a run where a model really was fooled, sent as a labelled simulation. Gift cards aren't in my mandate. Refused, nothing charged. It doesn't matter what the model believed." |
| 2:02 to 2:14 | Step 7 | Press the twenty-at-once button | "Twenty purchases at the same instant against a thirty dollar budget. Five are paid. Fifteen are refused. It stops at exactly thirty." |
| 2:14 to 2:24 | Step 3 on the demo page, then its trace | **[YOU]** Press **Refund $12.50** on the paid step, then open its trace to show the refund | "I can refund a purchase through PayPal. The money goes back, and the budget doesn't, so a refund can't be used to raise an agent's limit." |
| 2:24 to 2:30 | Step 8 | Press **Revoke the mandate**, then buy a coffee | "I revoke the mandate. The agent asks for the same coffee. Refused." |
| 2:30 to 2:44 | `/demo/console`: chain banner, chart, select a row | Select a row, select a bar | "Every row of this session is here in AG Grid. The server rehashes each one and walks the whole chain. The budget line is the same number the policy reads, replayed from the ledger." |
| 2:44 to 2:50 | Architecture diagram or front page | Hold | "The model proposes. The policy disposes. The ledger remembers. Praman, running on PayPal and Render." |

## Accuracy notes

- The 5 paid, 15 refused and $30 result is from the recorded hosted run. If your take shows anything else, say what the screen shows.
- If the live model is fooled in step 6, or proposes a different cart, change the line. The demo labels each part.
- Step 7 uses test intents and a simulated rail, with no model call. Don't describe those as PayPal payments.
- If a model cap is reached, a step replays a recorded answer and labels it. Don't present that as live.
- Don't claim the 11-minute release of an unpaid checkout or an MCP checkout paid by a real buyer. Neither has been run on the hosted site.
