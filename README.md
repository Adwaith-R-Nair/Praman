# Praman

**The model proposes. The policy engine disposes. The ledger remembers.**

A control plane for agent-initiated payments. Praman sits between an AI buyer
agent and a Razorpay merchant, making every rupee the agent moves bounded,
explainable, and replayable.

Razorpay AI Buildathon 2026 · Track 01 — AI Growth & Agentic Commerce

Status: in development. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Setup

```bash
pnpm install
docker compose up -d              # Postgres on 5432 — port taken? point DATABASE_URL at your own instance instead
cp .env.example .env              # fill in RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, ANTHROPIC_API_KEY, MANDATE_SIGNING_KEY
pnpm --filter @praman/db migrate
pnpm test
```

## Merchant MCP server

`apps/merchant-mcp` exposes one merchant's catalog (`list_catalog`,
`get_sku`, `check_stock`, `get_refund_policy`) as a real [MCP](https://modelcontextprotocol.io)
server over stdio — any MCP-speaking client can browse and query it, not
just Praman's own buyer agent. It does not sanitise its own output;
untrusted-content delimiting happens once, at the buyer agent's own
boundary (D-07), not inside the merchant's server.

Point Claude Desktop (or any other MCP client) at it via
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "praman-merchant": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/praman", "exec", "tsx", "apps/merchant-mcp/src/server.ts"],
      "env": { "MERCHANT_MCP_MERCHANT_ID": "MERCH_001" }
    }
  }
}
```

Praman's own buyer agent talks to this same server, over the same
protocol, when run with `PRAMAN_MCP=1`:

```bash
PRAMAN_MCP=1 pnpm demo
```

Unset (the default), the agent calls the catalog in-process instead — the
eval harness always uses that direct path, since spawning a subprocess
per one of 40 corpus cases would be slow and flaky. The demo and any
recorded walkthrough use MCP.

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

## Built with
Praman was designed and built with Claude as a pair-programming partner.
Every architectural decision in [docs/DECISIONS.md](docs/DECISIONS.md) is
mine, made deliberately and defended there. The policy engine's `evaluate()`
is hand-written. Claude generated much of the surrounding scaffolding —
types, serialisation, test cases — from specifications I wrote, and I
reviewed and understand every line. The commit history shows the sequence:
specification, then core, then plumbing, then measurement.

MIT licensed.