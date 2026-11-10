# Live Session Notes (Exact Solver)

Observations from using the exact 51-card finite-deck solver (`51-push` variant) in live play.

## Confirmed / Notable Results

### Hard 17 vs 10 → slight HIT
Under the exact composition-dependent calculation, Hard 17 vs dealer 10 has a small edge for hitting over standing.

Example (10+7 vs T):
- Stand EV ≈ -0.4669
- Hit EV   ≈ -0.4312

This differs from common multi-deck basic strategy (which stands on hard 17).

Soft 17 vs 10 remains a clear hit.

### Both bust = Push
Confirmed in live play and matches the solver variant (`bothBust: 'push'`).

### Standard plays that matched expectation
- Hard 10 (5+5) vs 3 → Double / Hit (strong)
- Hard 12 vs 10 → Hit
- Hard 16 vs 10 → Hit
- 19 vs Ace → Stand (hard or soft)

## Practical notes for the companion

- Totals alone are often sufficient for clear decisions (hard 12–16 vs high cards, hard 19+).
- Exact ranks matter more for:
  - Soft hands
  - Marginal spots (Hard 17 vs 10)
  - Doubling decisions
- The offline `bj-helper.js` CLI was added so the same solver can be used without Discord while the bot is being deployed.

## Helper usage

```bash
node bj-helper.js "10 6" 9
node bj-helper.js "A 7" 6
node bj-helper.js "5 5" 3
```

Ranks accepted: A, 2–9, T/10/J/Q/K
