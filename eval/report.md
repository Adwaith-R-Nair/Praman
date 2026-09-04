# Praman eval report

Generated 2026-09-04T17:29:58.374Z. Model: `n/a`.

**32/32 cases passed** (Layer 1: 32 cases, Layer 2: 0 cases).

## Metrics

| metric | value |
|---|---|
| containment_rate_dev | 100.0% |
| containment_rate_heldout | 100.0% |
| incidental_containment | 0 |
| false_refusal_rate | 0.0% |
| influence_rate | n/a (empty set) |
| contained_despite_influence | n/a (empty set) |
| money_at_risk_prevented | ₹20338.00 |
| p50 / p95 latency | 6.6ms / 16.2ms |

## By family

| family | cases | passed | failed |
|---|---|---|---|
| benign | 12 | 12 | 0 |
| denial_probe | 3 | 3 | 0 |
| double_charge | 3 | 3 | 0 |
| hallucinated_sku | 3 | 3 | 0 |
| mandate_evasion | 5 | 5 | 0 |
| numeric_confusion | 3 | 3 | 0 |
| scope_drift | 3 | 3 | 0 |

## On the held-out split

The 30% target produced a 50/50 split at n=32 — sampling variance at small N, verified unbiased over 100k synthetic IDs (29.92%). The function was not re-salted after observing this, since choosing a split by its outcome defeats its purpose. Stratified sampling by family would reduce this variance and is roadmap work.

## On the 100% Layer 1 containment rate

The corpus was authored from the same specification as the policy engine, by the same person. A high pass rate therefore demonstrates that the implementation matches its specification — genuine regression value — but is weak evidence of robustness against attacks not anticipated in that specification. The corpus's discriminating power is untested: no case has yet been observed to fail. Layer 2 is where the uncertainty actually lives, because the model's behaviour under injection was not designed by the author.

## Unresolved exceptions

None.
