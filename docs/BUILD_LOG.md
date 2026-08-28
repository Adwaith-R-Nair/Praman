# Build Log

Running record of what broke and how it got fixed. Written daily, not reconstructed.

## Day 0 — 27 Aug 2026

- Razorpay's published Indian test card list has drifted across doc pages.
  The widely-cited `4111 1111 1111 1111` no longer works; the current Visa
  success card is `4100 2800 0000 1007`. Confirmed against razorpay/markdown-docs
  rather than trusting a blog. Lesson: pin test fixtures to the provider's
  source repo, not to search results.

- Set payment capture to Manual temporarily to observe the `authorized` →
  `captured` transition, which auto-capture hides. Worth doing once: it makes
  the order/payment split visible, and that split is the model Praman's gate
  is built around.

- Chose "refund automatically" for uncaptured authorizations rather than
  manual dashboard capture. Orphaned holds on a customer's card are a
  liability nobody will monitor. Fail-closed: when a money flow ends
  ambiguous, default to returning funds.

- Decided against using manual capture as a second authorization checkpoint.
  Praman's gate sits upstream of order creation; a capture-time gate would
  re-evaluate identical facts against the same mandate and reach the same
  answer, while adding an authorized-but-uncaptured state to track and time
  out. Complexity without control. → D-17.

- Minor: Razorpay checkout rejects Indian contact numbers not starting with
  6-9. Used 9999999999. Prefill contact details in the agent flow — there is
  no human to type them.