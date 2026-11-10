# OwO Blackjack Mechanics Research

**Status:** Source-level investigation complete; live OwO behavior not tested.

**Published source:** [`ChristopherBThai/Discord-OwO-Bot`](https://github.com/ChristopherBThai/Discord-OwO-Bot) at commit `9aec92b274bae64ea078fc04540398713e7f7928` (2024-11-03).

**Files inspected:** `src/commands/commandList/gamble/blackjack.js`, `src/commands/commandList/gamble/blackjackUtil.js`, `secret/CREATE-OWO-TABLES.sql`.

**Method:** fresh clone of the pinned public commit, line-by-line review, and independent offline calculations. No live OwO account, server, Discord message, or production database was used.

> **Evidence boundary:** “Confirmed” below means confirmed in the published source. It does not mean confirmed against the live OwO service. The pinned OwO source has no `bj-helper.js`; the repository's `bj-helper.js` is a separate offline wrapper added later and is not part of the audited OwO source.

## 1. Confirmed findings

| # | Finding | Evidence |
|---|---|---|
| 1 | The deck is a module-level 51-card array. | `blackjack.js:11-14` |
| 2 | A new game copies that array with `deck.slice(0)`; the original is never mutated. | `blackjack.js:159-161` |
| 3 | Cards are drawn by random index and removed with `splice`; there is no Fisher–Yates shuffle. | `blackjackUtil.js:124-127` |
| 4 | Cards are dealt without replacement within a hand. | `blackjackUtil.js:124-127`, `blackjack.js:183-185`, `blackjack.js:223-228` |
| 5 | Every non-resumed game starts from the full 51-card array; depletion is not carried between games. | `blackjack.js:159-161`; the module-level `deck` is not mutated |
| 6 | The deck is not shared between simultaneous games; each game creates its own copy. | `blackjack.js:159-161`, `blackjack.js:183`, `blackjack.js:223` |
| 7 | The composition is A=4, 2–6=4 each, 7=3, 8–9=4 each, ten-value cards=16. | `blackjack.js:11-14`, `blackjackUtil.js:210-253` |
| 8 | The missing identity is the 7 of hearts (source card 33). | `blackjack.js:12-13`; `cards[33]` at `blackjackUtil.js:42` |
| 9 | Ten/J/Q/K are separate identities but all have value 10. | `blackjackUtil.js:8-61`, `blackjackUtil.js:217-228` |
| 10 | Duplicate identities cannot normally occur within one hand. | `randCard` removes the card; `blackjack_card` has `PRIMARY KEY (bjid, card)` at `secret/CREATE-OWO-TABLES.sql:306-313` |
| 11 | Aces are initially valued at 1, then upgraded one at a time to 11 while the total would not exceed 21. | `blackjackUtil.js:229-246` |
| 12 | The dealer receives one face-up card and one `type = 'b'` hole card. | `blackjack.js:160-161`; hidden display at `blackjackUtil.js:181, 194-195` |
| 13 | The hole card is revealed only when the hand stops (stand, or player bust). | `blackjack.js:214-219`, `blackjack.js:225-228` |
| 14 | The dealer stands on every total of 17 or more, including soft 17. | `blackjack.js:225` (`while (dpoints < 17)`) |
| 15 | Both player and dealer busting is recorded as `tb` and pays the wager back. | `blackjack.js:232-235`, `blackjack.js:253-254` |
| 16 | Only hit and stand are exposed; there is no double-down or split branch. | `blackjack.js:113-114`, `blackjack.js:133-139`; no double/split code in the command |
| 17 | A win credits `bet * 2`; a tie or both-bust credits `bet`; a loss credits nothing. | `blackjack.js:250-254` |
| 18 | A natural two-card 21 has no 3:2 or other special payout. | `blackjack.js:250-254`; no natural-blackjack branch before settlement |
| 19 | A push returns the initial wager: gross `bet`, net 0. | `blackjack.js:253-254` |
| 20 | The player is not automatically settled at 21; the reaction collector remains active until hit/stand. | `blackjack.js:111-140` |

## 2. Deck lifecycle

### 2.1 Initialization and shuffle

`blackjack.js:11-14` defines:

```js
const deck = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
];
```

The only omitted value is `33`. In `blackjackUtil.js`, index 33 is the heart seven:

```js
const cards = [
  '<:cardback:...>', '<:as:...>', ... '<:6h:...>', '<:7h:...>', ...
];
```

`randCard` does not shuffle. It selects a random index and removes that card:

```js
// blackjackUtil.js:124-127
async function randCard(deck, type) {
  let card = deck.splice(await random(0, deck.length - 1), 1)[0];
  return { card: card, type: type };
}
```

There is no persistent shoe and no shuffle step. The random draw and removal are the complete mechanism.

### 2.2 Where cards are removed

- Initial deal: `deck.slice(0)` then four `randCard` calls (`blackjack.js:159-161`).
- Player hit: a fresh copy of the 51-card array, `initDeck` removes every known player and dealer card, then one card is drawn (`blackjack.js:183-185`).
- Dealer play: a fresh copy, `initDeck` removes every known card, then the dealer draws while below 17 (`blackjack.js:223-228`).

`initDeck` is:

```js
// blackjackUtil.js:156-161
function initDeck(deck, player, dealer) {
  for (let i = 0; i < player.length; i++) deck.splice(deck.indexOf(player[i].card), 1);
  for (let i = 0; i < dealer.length; i++) deck.splice(deck.indexOf(dealer[i].card), 1);
  return deck;
}
```

This means a hit is drawn without replacement with respect to all known player cards, the dealer upcard, and the hole card. The solver does not know the hole and therefore keeps it in the unknown count; the source removes it because the server knows it.

### 2.3 Reset between games

Every new game enters the `else` branch at `blackjack.js:158` and executes `let tdeck = deck.slice(0)`. The module-level `deck` is a constant-like array that is never mutated: all mutations happen on `tdeck` or on a later `deck.slice(0)`.

A new game after a completed hand therefore starts with all 51 cards. The next game cannot inherit the previous game's removed cards.

**Important exception:** if the player already has an active game, the command resumes it from `blackjack_card` rows (`blackjack.js:91-92`, `:148-157`). It does not deal a fresh deck for a resumed hand.

### 2.4 Simultaneous games and shards

Each game has its own copied array. Different users playing at the same time do not mutate a shared deck. The `blackjack` table is keyed by user ID (`PRIMARY KEY (id)` at `secret/CREATE-OWO-TABLES.sql:287-296`), and the cards are keyed by `(bjid, card)`.

The source has no cross-process deck state. A shard or process that loads this module gets its own `deck` array; there is no Redis or database card counter. Different shards therefore use independent copies of the same 51-card composition.

## 3. Card mechanics

### 3.1 Composition

| Rank | Count | Notes |
|---|---:|---|
| A | 4 | `card % 13 == 1` |
| 2–6 | 4 each | 20 total |
| 7 | 3 | 7♠, 7♣, 7♦; 7♥ is identity 33 and absent |
| 8–9 | 4 each | 8 total |
| 10/J/Q/K | 16 | 4 identities × 4 suits; all value 10 |
| **Total** | **51** | |

The independent regression test reconstructs the 51 identities directly and asserts these counts. It also asserts that `card 33` is absent and that exactly three sevens remain.

### 3.2 Duplicate cards

The source deck contains unique identities. `randCard` removes an identity after drawing it. The database additionally enforces `PRIMARY KEY (bjid, card)`, so a normal game cannot contain the same physical card twice.

There is a source robustness edge case in `initDeck`: if a known card is not present, `deck.indexOf(card)` returns `-1`, and `splice(-1, 1)` removes the last array element. This is not reachable through a normal game because every stored card came from the 51-card array, and the parser rejects the absent 7♥. It would matter only if malformed or legacy data supplied a card outside the published deck.

### 3.3 Aces and totals

`cardValue` counts each ace as 1 first, then tries to add 10 to each ace while the total remains at or below 21 (`blackjackUtil.js:229-246`). The `ace` flag is true when at least one ace is still counted as 11.

Examples:

- A + 6 = soft 17.
- A + 6 + 10 = hard 17; the ace is demoted to 1.
- A + A + A + A = soft 14; one ace is 11 and three are 1.
- A + A + 9 = soft 21; both aces can be 11 without exceeding 21.

`addRank` in `finite-deck-solver.js` implements the same total/soft transition. The new tests cover soft 17 versus hard 17 and the four-ace case.

### 3.4 Natural blackjack

There is no natural-blackjack branch. A two-card 21 is simply 21. If the player wins, the payout is the ordinary `bet * 2`; there is no 3:2 premium. The source also does not auto-settle an initial 21; the player still has to stand (or may hit).

## 4. Dealer mechanics

### 4.1 Hole card

The initial deal is:

```js
// blackjack.js:160-161
let player = [randCard(tdeck, 'f'), randCard(tdeck, 'f')];
let dealer = [randCard(tdeck, 'f'), randCard(tdeck, 'b')];
```

`type = 'b'` is the hole. `cardValue` includes its points internally, but `shownPoints` excludes it, and `generateEmbed` replaces the in-progress dealer total with `shownPoints + '+?'` (`blackjackUtil.js:181, 194-195`). That is why the displayed dealer label does not reveal the hole.

### 4.2 Reveal timing

`stop` changes the hole from `'b'` to `'f'` and all other dealer cards to `'c'` (`blackjack.js:214-219`). It is called when the player stands (`blackjack.js:136-139`) or when a hit takes the player over 21 (`blackjack.js:188-190`).

The hole is not revealed on a normal hit, and a reaction timeout does not reveal it; the game is left resumable.

### 4.3 Drawing and soft 17

```js
// blackjack.js:225-228
while (dpoints < 17) {
  dealer.push(await bjUtil.randCard(tdeck, 'f'));
  dpoints = bjUtil.cardValue(dealer).points;
}
```

The dealer stands on hard 17 and soft 17, and draws on all totals below 17. There is no separate soft-17 rule.

### 4.4 Settlement order

```js
// blackjack.js:232-243
if (ppoints > 21 && dpoints > 21) winner = 'tb';
else if (ppoints == dpoints) winner = 't';
else if (ppoints > 21) winner = 'l';
else if (dpoints > 21) winner = 'w';
else if (ppoints > dpoints) winner = 'w';
else winner = 'l';
```

Both-bust is checked first. A player bust against a non-bust dealer is a loss. A dealer bust against a non-bust player is a win. Equal totals tie.

## 5. Payout mechanics

| Result | Gross credit | Net against the staked bet |
|---|---:|---:|
| Player win | `bet * 2` | `+bet` |
| Tie | `bet` | `0` |
| Both bust (`tb`) | `bet` | `0` |
| Player loss | `0` | `-bet` |

The stake is deducted before the hand (`blackjack.js:80-86`), so these are gross credits after the stake. A push returns the initial wager; it is not a profit. A natural 21 does not change the win credit.

## 6. Solver methodology and assessment

### 6.1 What the solver does

`finite-deck-solver.js` uses memoized exact dynamic programming over:

- the remaining rank-count vector;
- the player total and soft/hard state;
- the dealer upcard;
- the dealer's unknown hole, enumerated as part of the dealer distribution.

For a player decision it computes:

- **Stand EV:** exact dealer final-total distribution from the upcard, unknown hole, and all legal draws.
- **Hit EV:** weighted average over every remaining rank, with recursive optimal play after a non-bust draw.
- **Both-bust EV:** if the variant is `51-push`, a player bust ties when the dealer also busts; the loss value is `-1 + P(dealer bust)`.

The solver is composition-dependent after every hit. It is not a single total/soft lookup table.

### 6.2 Does it calculate composition-dependent EV correctly?

No EV defect was found in the published-rule path. The existing Phase 7 audit checks 100,000 reachable visible states against an independent exact implementation. The new tests add independent checks for:

- the 51-card identity composition;
- fresh-deck reset and within-hand depletion;
- the dealer-hole distribution, computed by a separate identity-level enumerator;
- soft versus hard totals;
- both-bust settlement;
- 51-card versus 52-card differences;
- no cross-game count contamination.

### 6.3 Identity-level limitation

The solver tracks **rank counts**, not physical suit identities. That is mathematically sufficient for this rule set because suits have no effect on totals, settlement, or payouts; the only identity-specific fact is that one seven (7♥) is absent, which is represented by the rank-7 count of 3. The independent tests reconstruct the physical identities to prove the rank vector is derived correctly.

If live OwO ever uses a different suit-specific deck, the rank-count model would need the corresponding rank counts; it would not need per-suit state unless a future rule made suits relevant.

### 6.4 `bj-helper.js`

There is no `bj-helper.js` in the pinned OwO source. OwO's relevant implementation is split between `blackjack.js` and `blackjackUtil.js`. The repository separately includes an offline `bj-helper.js` CLI added after this research; it calls `createVisibleEvaluator('51-push')` from `finite-deck-solver.js` and is not evidence of live OwO behavior.

## 7. Tests added

`test/blackjack-mechanics.test.js` covers:

| Test | What it establishes |
|---|---|
| Published deck composition | 51 unique identities; A=4, 7=3, ten-values=16; matches `BASE_51` |
| Fresh deck after depletion | Removing cards from a game copy does not mutate the base deck; the next copy is complete |
| Within-hand depletion | Visible cards reduce the remaining count by one; a fourth seven is rejected |
| Dealer hole distribution | Independent identity-level enumeration matches the solver and sums to 1 |
| Soft versus hard 17 | Same total, different state and EV |
| Both-bust settlement | Push EV is exactly dealer-bust probability better than loss EV |
| 51 versus 52 cards | Removing a seven changes remaining counts and EV |
| Cross-game reset | A second game with the same three sevens receives the same advice; no prior depletion is retained |

Run with:

```bash
npm test
node phase7-audit.js --states 100000
```

## 8. Playtest data

The manually recorded results are:

- **5 wins**
- **13 losses**
- **3 pushes**
- **1 unclear double-bust**
- **22 recorded hands**

These are preliminary observations recorded primarily as totals, not full card identities. They are not a statistically valid estimate of the solver's edge, and they must not be used to claim profitability. The sample is small, the hands are not an unbiased random sample, and the unclear result is unresolved.

## 9. Permission and scope

The user has confirmed that OwO permits third-party bots. That removes **general third-party bot permission** as an unresolved blocker.

It does not authorize automated gambling actions. This companion is intentionally read-only:

- it never places a bet;
- it never sends an OwO command;
- it never reacts or clicks a component;
- it only reads the visible embed and posts its own advice.

Any future feature that acts on OwO would require a separate authorization and risk review; it is out of scope here. Live tracking still requires a format/intent check, not a general permission re-investigation.

## 10. Remaining uncertainties and live verification

These are **not** confirmed:

1. **Live deck equality.** The live service may not run commit `9aec92b` or may have a private deck change. A live test is required to establish that the live deck is the same 51-card composition.
2. **Live embed format.** The parser is built from the published formatting code and synthetic fixtures; a real hand may use different field names, emoji names, totals, or footer text.
3. **Message Content Intent.** The bot cannot receive embed content without this Discord intent; this is an application setting, not an OwO rule.
4. **Live reaction/action surface.** The source exposes only hit/stand, but the live bot could have additional components or changed aliases. The companion must remain read-only regardless.
5. **Live settlement.** The source's `bet * 2` / `bet` / `0` payout logic is confirmed in source, but no live Cowoncy balance was observed.
6. **Live concurrent-game behavior.** The source gives each process a copied deck and keys games by user ID; live sharding and session behavior were not exercised.

### Minimum live verification

Use a private test server and a synthetic/low-stakes hand:

1. Confirm the embed has exactly the expected dealer/player fields, card emoji names, footer, and totals.
2. Confirm the dealer shows one face-down card during play and reveals it only on stop/bust.
3. Confirm a soft-17 dealer stand and a both-bust result.
4. Confirm win/tie/loss credit behavior from the displayed result, without attempting to exploit anything.
5. Keep the companion read-only; do not add reactions, commands, or automated play.

Until those checks are done, live recommendations remain an assumption about live OwO, not a verified live fact.

## 11. Source references

| Item | Reference |
|---|---|
| Deck array | `src/commands/commandList/gamble/blackjack.js:11-14` |
| New-game copy and initial deal | `src/commands/commandList/gamble/blackjack.js:148-174` |
| Existing-game resume | `src/commands/commandList/gamble/blackjack.js:91-92`, `:148-157` |
| Hit copy/removal | `src/commands/commandList/gamble/blackjack.js:177-212` |
| Dealer reveal and draw | `src/commands/commandList/gamble/blackjack.js:214-228` |
| Winner branches | `src/commands/commandList/gamble/blackjack.js:230-243` |
| Payout SQL | `src/commands/commandList/gamble/blackjack.js:245-254` |
| Random draw/removal | `src/commands/commandList/gamble/blackjackUtil.js:123-127` |
| Known-card removal | `src/commands/commandList/gamble/blackjackUtil.js:156-161` |
| Hidden dealer display | `src/commands/commandList/gamble/blackjackUtil.js:164-208` |
| Card value/ace logic | `src/commands/commandList/gamble/blackjackUtil.js:210-253` |
| Card identity names | `src/commands/commandList/gamble/blackjackUtil.js:8-117` |
| Table keys | `secret/CREATE-OWO-TABLES.sql:287-296`, `:306-313` |

All line numbers refer to the pinned public commit, not to the live service.
