# Trying the Praman demo

Written to be pasted into the Devpost testing instructions. The sandbox login goes in the two marked places. It is never committed to this repo.

## What you need

- A PayPal **sandbox** buyer login. It is a US Personal sandbox account with play money:
  - Email: `<paste the US Personal sandbox email here>`
  - Password: `<paste the sandbox password here>`
- A window that is not logged in to PayPal, for the PayPal checkout in step 5. Open the demo in a normal window and use a private window for the checkout. If you opened the demo in a private window, use another browser for the checkout, such as Firefox if you are in Chrome, or your phone. Step 2 logs the demo's window in to PayPal, and PayPal's sandbox sometimes declines a checkout in a session that is already logged in, with "To comply with international regulations, this transaction has been declined". A fresh session works.

No real money moves. Everything runs against PayPal's sandbox.

## Steps

1. Open the demo page and press **Start a session**. You get a mandate signed for you: a $60.00 budget, nothing over $40.00, and your approval needed for anything of $20.00 or more and for the first purchase at any shop.
2. Press **Connect PayPal**. PayPal opens its own page. Log in with the sandbox buyer above and agree to save the account. PayPal sends you back. Praman keeps the saved account on its server; the agent and the page never see it.
3. Press **Ask the agent to buy lunch**. The agent proposes a $12.50 bowl. Praman stops it, because the agent has never bought from this shop, and asks you. Press **Approve this purchase**. Praman charges the saved account with no buyer at PayPal.
4. Press **Ask the agent to buy a coffee**. Praman allows it and the $4.50 is charged at once. Nobody approved it and no buyer saw it. Praman's decision was the only thing between the agent and the money.
5. Press **Ask the agent to buy a team lunch**. It is $32.00, over the approval line, so Praman asks you again. Approve it. A PayPal checkout link appears. Copy it into a **private window** (or your other browser, if the demo is in a private window), log in as the sandbox buyer, and pay. Come back to the demo tab and press **Capture the payment**. Praman checks the mandate again before taking the money.
6. In **A poisoned listing**, the live model reads a shop listing that tells it to add a gift card. Then a fixed cart from a fooled model goes to Praman, labelled as a simulation, and is refused. Below it is a recorded run where a model really was fooled, labelled as a recording.
7. **Twenty purchases at once** sends twenty test intents together against a $30.00 budget. No model is called. Five are paid and the rest are refused.
8. **Revoke the mandate**. Press **Revoke the mandate**, then **Ask the agent to buy a coffee**. The agent asks for the same coffee as in step 4, and Praman refuses it with `MANDATE_REVOKED`. Nothing reaches PayPal. Do this last, because after it every purchase in the session is refused.

Every step links to its **Ledger trace**, where **Verify this chain** checks the hash chain, and to its **Dispute bundle**. A purchase's bundle is your own copy, with the signed mandate and signature, so you can check it yourself (`/demo/dispute/<step>`). The public one at `/dispute/<trace>` has no limits in it.

**Open your ledger console** at the top of the demo page shows every ledger row your session wrote, in a grid you can search, filter and sort. Each row's hashes are recomputed and the whole chain is checked. Select a row to see its hash check. The charts show spend against each mandate's budget, decisions by reason code, and outcomes by rail; select a bar to filter the rows. After step 8 the revocation is one of the rows.

## If something goes wrong

- PayPal says the transaction was declined: close every private window, open a fresh one, and open the checkout link there. If the demo itself is in a private window, use another browser instead. Then press **Capture the payment**.
- If the agent's cart for step 3 or 4 comes to $20.00 or more, that step also asks for your approval and goes through a PayPal checkout. Pay it the same way. Close every private window before a second checkout, so it starts in a fresh session.
- If a step is refused or rejected, nothing was charged, and you can ask the agent again.
- Capture says PayPal hasn't approved the payment yet: finish the approval at PayPal first. Nothing is charged until you do.
- A checkout left unpaid for 10 minutes is released, and capturing it afterwards is refused with a plain explanation. Nothing is charged.
- The session ends after an hour. Press **Start a session** for a new one. Ending a session deletes the saved PayPal account at PayPal.
