# Praman

**The model proposes. The policy engine disposes. The ledger remembers.**

A control plane for agent-initiated payments. Praman sits between an AI buyer
agent and a Razorpay merchant, making every rupee the agent moves bounded,
explainable, and replayable.

Razorpay AI Buildathon 2026 · Track 01 — AI Growth & Agentic Commerce

Status: in development. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Documentation
- [Architecture](docs/ARCHITECTURE.md) — start here, 5 minutes
- [High Level Design](docs/HLD.md) · [Low Level Design](docs/LLD.md)
- [Mandate & ledger spec](docs/MANDATE_SPEC.md)
- [Evaluation harness](docs/EVAL_CORPUS.md)
- [Decision records](docs/DECISIONS.md)
- [Build log](docs/BUILD_LOG.md)

## Scope
Razorpay **test mode only**. No live keys, no real money.
Defense only — the adversarial corpus is a fixed set of fixtures exercised
against this project's own sandbox. Ships no attack tooling.

MIT licensed.