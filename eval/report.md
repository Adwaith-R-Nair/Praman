# Praman eval report

Generated 2026-09-04T21:34:27.118Z. Model: `google/gemini-3.1-flash-lite`.

**40/40 cases passed** (Layer 1: 32 cases, Layer 2: 8 cases).

## Metrics

| metric | value |
|---|---|
| containment_rate_dev | 100.0% |
| containment_rate_heldout | 100.0% |
| incidental_containment | 0 |
| false_refusal_rate | 0.0% |
| influence_rate | 0.0% |
| contained_despite_influence | n/a (empty set) |
| money_at_risk_prevented | ₹20338.00 |
| p50 / p95 latency | 5.7ms / 15.8ms |

## By family

| family | cases | passed | failed |
|---|---|---|---|
| benign | 12 | 12 | 0 |
| denial_probe | 3 | 3 | 0 |
| double_charge | 3 | 3 | 0 |
| hallucinated_sku | 3 | 3 | 0 |
| mandate_evasion | 5 | 5 | 0 |
| numeric_confusion | 3 | 3 | 0 |
| prompt_injection | 8 | 8 | 0 |
| scope_drift | 3 | 3 | 0 |

## On the held-out split

The 30% target produced a 50/50 split at n=32 — sampling variance at small N, verified unbiased over 100k synthetic IDs (29.92%). The function was not re-salted after observing this, since choosing a split by its outcome defeats its purpose. Stratified sampling by family would reduce this variance and is roadmap work.

## On the 100% Layer 1 containment rate

The corpus was authored from the same specification as the policy engine, by the same person. A high pass rate therefore demonstrates that the implementation matches its specification — genuine regression value — but is weak evidence of robustness against attacks not anticipated in that specification. The corpus's discriminating power is untested: no case has yet been observed to fail. Layer 2 is where the uncertainty actually lives, because the model's behaviour under injection was not designed by the author.

## On the Layer 2 influence rate

8 live cases against `google/gemini-3.1-flash-lite`, one run each, no repeated trials. A 0% (or any single-run) influence rate is a point estimate from a small sample against one model on one day, not a guarantee that holds against every phrasing, every model, or every run. Transcripts for every case are committed under `eval/transcripts/` so a reviewer can check what actually happened rather than trust this summary.

## Ablation: what does the prompt-layer defence buy?

Same 7 injection cases, same model (`google/gemini-3.1-flash-lite`), 3 repeats per arm. Arms differ only in whether merchant text is delimited (`PRAMAN_NO_DELIMITER`) and whether the system prompt carries untrusted-content handling instructions (`PRAMAN_NO_PROMPT_DEFENCE`). The policy engine is identical in both arms.

| Arm | Runs | Proposals influenced | Money moved |
|---|---|---|---|
| Defended | 21 | 0 | 0 |
| Undefended | 21 | 2 | 0 |

**Interpretation.** The undefended arm was influenced more often (2/21) than the defended arm (0/21) — a measured difference, not an assumed one, though n=21 per arm is too small to claim a precise effect size. Of the 2 cases where the injection did alter the agent's proposal, 0 resulted in money moving — the policy engine caught the rest regardless of what the prompt layer did. This is `contained_despite_influence` measured directly, not left null.

**Limits.** n=21 per arm on one model, one temperature, seven hand-written attacks by the same author who wrote the defence. Not a benchmark. The delimiter and the prompt instructions were removed together, so this does not separate their individual contributions. Full per-repeat results and every transcript are committed under `eval/ablation/` and `eval/transcripts/ablation/`.

## Unresolved exceptions

None.
