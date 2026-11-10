# Discord Blackjack Companion Bot

**Phase 8 — local MVP with /owo.** This is a read-only Discord companion that follows the publicly visible OwO blackjack embed, applies the existing exact finite-deck solver, and edits one advice message as the hand changes. It does **not** play for you, react, bet, or send anything to OwO.

> **Deployment gate:** do not use this with live OwO or a public server until the actual embed format is verified and Message Content Intent is enabled. OwO permits third-party bots (user-confirmed); this companion remains strictly read-only and does not automate gambling actions. The bot enforces an explicit `ALLOW_LIVE_OWO=true` acknowledgement for the remaining live-format check.

**Phase 8 files:** `bot.js`, `discord-commands.js`, `owo-blackjack-parser.js`, `blackjack-session.js`, `blackjack-advisor.js`, `env.example`, and the tests under `test/`.

**Mechanics evidence:** [`BLACKJACK-MECHANICS-RESEARCH.md`](BLACKJACK-MECHANICS-RESEARCH.md) independently verifies the published deck, dealer, payout, and solver assumptions with exact source line references.

## Individual hand advisor

`blackjack-advisor.js` now has two entry points over the same exact finite-deck solver: a one-shot CLI/JSON interface for manual hands, and the existing Discord formatter. It does not use a separate basic-strategy table.

### Quick use

```bash
node blackjack-advisor.js --dealer 8 --cards 10,6
node blackjack-advisor.js --dealer 8 --cards 10,6 --json
node blackjack-advisor.js --dealer 8 --cards 10,6 --observed 2,3
```

The text response includes the total, hard/soft type, recommendation, real HIT/STAND EVs, bust probability, dealer final-outcome probabilities, remaining composition, and the reason for the recommendation. `--json` returns the same values machine-readably.

### Rules are explicit

The API does not silently fill in unknown rules. At minimum, callers must supply the two core rule decisions:

```js
rules: { dealerHitsSoft17: false, deckCount: 1 }
```

Omitted optional fields use the published, source-verified OwO values and are echoed in the result: `deckSize: 51`, `bothBust: 'push'`, `blackjackPays: '1:1'`, `doubleAllowed: false`, `splitAllowed: false`, plus the source commit. The result also lists which fields were defaulted in `rules.defaulted`, so nothing is hidden. Passing any of those fields explicitly as `null` makes the result pending. A differing value makes it unsupported. The full verified constant is also available:

```js
const { VERIFIED_RULES } = require('./blackjack-advisor');
```

If a core rule is missing or explicitly unknown, the result is `confidence: "pending"`, `recommendation: null`, and both EVs are `null`. If a rule differs from the solver's implemented rules, the result is `confidence: "unsupported"`; no guessed EV is returned. The CLI defaults to the verified rules because this is an OwO-specific tool, and it prints that choice in the output.

### JSON and programmatic use

```js
const { analyzeHand, VERIFIED_RULES } = require('./blackjack-advisor');

const result = analyzeHand({
  dealer: '8',
  playerCards: ['10', '6'],
  observedCards: [],
  rules: VERIFIED_RULES,
});

console.log(result.recommendation);
console.log(result.expectedValues);
```

Cards may be `A`, `2`-`9`, `10`, `T`, `J`, `Q`, or `K`, optionally followed by a suit (`s`, `c`, `d`, `h`). The published deck omits `7h`, so that card is rejected. Include suits when you want exact physical-duplicate detection; rank-only input still enforces the deck's rank limits (for example, four aces or three sevens).

`observedCards` means **additional known cards removed during the current hand**. OwO creates a fresh 51-card deck for every game, so cards from a previous hand must not be carried into a new analysis. The tracker resets them automatically.

### Manual session tracker and statistics

```js
const { BlackjackTableTracker } = require('./blackjack-session');
const { VERIFIED_RULES } = require('./blackjack-advisor');

const tracker = new BlackjackTableTracker({ rules: VERIFIED_RULES });
tracker.beginHand({ dealer: '8', playerCards: ['10s', '6h'] });
tracker.addPlayerCard('2c');
tracker.correctCard({ zone: 'player', index: 2, card: '3c' });
tracker.recordResult({ outcome: 'win', recommendationCorrect: true });
console.log(tracker.getStats());
console.log(tracker.getHistory());
```

The tracker stores individual visible cards, rejects duplicate physical registration, supports corrected recognitions, keeps prior hands in memory, and never adds a hidden dealer hole. `getStats()` reports wins/losses/pushes, win rate, HIT/STAND recommendation counts, results by dealer upcard, results by hard/soft hand type, follow rate, and recommendation accuracy.

Win rate and recommendation accuracy are intentionally separate. Accuracy is populated only when the caller explicitly supplies `recommendationCorrect`; a winning hand is not automatically treated as a correct decision. Discord sessions record outcomes automatically but leave accuracy unscored.

`/owo stats` shows the same aggregate statistics for the running process.

The pre-existing audit report follows below this section.

---

## 1. What the bot does

- Registers a `/owo` slash command in every server it joins.
- `/owo` activates tracking in the current channel; `/owo stop`, `/owo status`, and `/owo stats` control or inspect it.
- Detects one OwO blackjack embed in a dedicated source channel.
- Parses visible player cards and the dealer's visible upcard.
- Recalculates exact composition-dependent HIT/STAND expected values after each OwO message edit.
- Edits one advice message instead of sending a new message for every card.
- Displays `HIT` or `STAND`, both EV values, the hand total, and a link to the OwO message.
- Stops tracking ended hands, deleted messages, idle games, unsupported formats, and ambiguous games.
- Keeps current sessions, completed-hand history, and statistics in memory only; there is no persistent store.

It never reads a dealer hole card, never guesses an owner, and never sends a command, reaction, button click, or bet to OwO.

## 2. Requirements

- Node.js **20.6 or newer** (the installed and tested version is Node 22).
- A Discord application with a bot user.
- **Message Content Intent** enabled in the Discord Developer Portal.
- One dedicated text channel for OwO blackjack. The first version supports **one active game per channel**.
- A host that stays online while you play. A sleeping laptop stops the bot.
- The bot must be invited with the `applications.commands` scope so `/owo` can register.

## 3. Discord application setup

Do this once; iPhone/iPad Safari works, and a desktop browser is optional.

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Open **Bot** and add a bot user. Copy the bot token into your private environment file. Never put a token in source code, a screenshot, or a commit.
3. Still under **Bot → Privileged Gateway Intents**, enable **Message Content Intent** and save. Without it Discord sends empty embed data and automatic advice cannot work.
4. Under **OAuth2 → URL Generator**, select:
   - Scopes: `bot` and `applications.commands`
   - Permissions: **View Channel**, **Read Message History**, **Send Messages**

   The resulting permission integer should be **`68608`**. Do not add Administrator, Manage Messages, Add Reactions, or Embed Links. If you use a separate `ADVICE_CHANNEL_ID`, grant the same three permissions there so the bot can fetch and edit its own advice message.
5. Use the generated URL to invite the bot to a **private test server**. You need permission to manage that server or create an invite.
6. Create a dedicated channel such as `#blackjack-lab`. Give the bot role access to that channel. The bot reads the OwO game there and posts its advice there.
7. Add OwO to the same server and run your normal `owo bj <bet>` command in that channel.

`/owo` is registered automatically in every server the bot joins. No manual command deployment is required. You can use `/owo` before setting `ALLOW_LIVE_OWO=true`; it will report that live tracking is gated.

If you prefer to build the invite link directly, replace `YOUR_APPLICATION_ID` with the application's **General Information → Application ID**:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=68608&scope=bot%20applications.commands
```

## 4. Local installation

```bash
npm install
cp env.example .env
```

> The host's sensitive-file guard prevents this workspace from writing a literal `.env.example` file. `env.example` is the identical placeholder template; copy it to `.env`. The same content is shown below if you prefer to create `.env.example` yourself.

Edit `.env` and set the token and source channel IDs. Do not commit `.env`; it is ignored by `.gitignore`.

```dotenv
DISCORD_TOKEN=replace_with_your_bot_token
OWO_BOT_ID=408785106942164992
TRACK_CHANNEL_IDS=
ADVICE_CHANNEL_ID=
SESSION_IDLE_MS=90000
ALLOW_LIVE_OWO=false
```

`TRACK_CHANNEL_IDS` can be left blank when you plan to use `/owo` to activate a channel. Preconfigured IDs are optional and allow tracking to begin without a slash command.

Run the local checks:

```bash
npm test
npm run start:local
```

`npm run start:local` uses `node --env-file=.env bot.js`. For a hosted process, set the variables in the host's environment/secret settings and use `npm start`; it reads `process.env` directly. The bot starts in **setup mode** when `ALLOW_LIVE_OWO` is not exactly `true`: it connects to Discord, registers `/owo`, and refuses to activate tracking. It does not exit.

### Configuration

| Variable | Required | Meaning |
|---|---:|---|
| `DISCORD_TOKEN` | Yes | Bot token from the Developer Portal. Never commit it. |
| `OWO_BOT_ID` | No | OwO application ID; defaults to `408785106942164992`. Verify it in your server. |
| `TRACK_CHANNEL_IDS` | No | Optional comma-separated source channel IDs. Leave blank and use `/owo` in the channel. The MVP supports one active game per channel. |
| `ADVICE_CHANNEL_ID` | No | Optional separate output channel. Blank means the source channel. |
| `SESSION_IDLE_MS` | No | Idle expiry; defaults to 90 seconds, matching OwO's short reaction window. |
| `ALLOW_LIVE_OWO` | Yes | Must be `true` only after the deployment gate below is satisfied. When false, the bot runs in setup mode and `/owo` refuses activation. |

To get channel IDs on iPhone, enable Discord **Settings → Advanced → Developer Mode**, then long-press the channel and choose **Copy Channel ID**.

### Hosted secrets

Do not upload or commit a `.env` file to a host. Add `DISCORD_TOKEN` as a secret in the host's environment settings, then add the remaining values above as normal environment variables. On Freebuff, use **Settings → Environment** (the Keys/API keys panel); the workspace and hosted process receive those variables automatically. The start command is `npm start`.

### On-demand hosting from iPhone/iPad

If you only need the bot while playing, do not pay for 24/7 hosting and do not leave a server running. Use a free Oracle Cloud Always Free Ubuntu VM and start/stop the **VM** from the Oracle Cloud mobile console:

- **Start instance** before you open Discord to play.
- **Stop instance** when you finish. Stopping the VM stops the bot; the boot volume remains free.

The included `deploy/owo-bot.service` starts the bot automatically on boot and shuts it down cleanly with the VM. First save and push this repository from Freebuff's **Changes** panel; the VM clones GitHub, not the local workspace.

#### One-command install

On the Ubuntu/Debian VM or LXC, download and run the installer. It prompts for the token with input hidden, installs Node 22, clones the repository, creates a dedicated `owobot` user, writes a root-owned env file, installs the systemd service, and starts the bot in setup mode:

```bash
curl -fsSL https://raw.githubusercontent.com/Z480-fly/owo-bot-cowoncy-audit/main/deploy/install.sh -o /tmp/owo-install.sh
sudo bash /tmp/owo-install.sh
```

The installer never prints or stores the token in shell history, and it does not open the live gate. Use it on a **dedicated** host, not the host running Zora. If `/opt/owo-blackjack-companion` already exists, it refuses to overwrite it.

After it starts, the bot's startup log prints the exact invite URL (with the correct application ID and both scopes):

```bash
journalctl -u owo-bot.service -n 50 --no-pager | grep 'Invite URL'
```

#### Manual setup

From a browser-based SSH session or Termius on the iPad:

```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo git clone https://github.com/Z480-fly/owo-bot-cowoncy-audit.git /opt/owo-blackjack-companion
cd /opt/owo-blackjack-companion
sudo npm ci --omit=dev
sudo useradd --system --user-group --home /opt/owo-blackjack-companion --shell /usr/sbin/nologin owobot
sudo chown -R owobot:owobot /opt/owo-blackjack-companion
sudo cp env.example /etc/owo-blackjack-companion.env
sudo chmod 600 /etc/owo-blackjack-companion.env
sudo nano /etc/owo-blackjack-companion.env
sudo cp deploy/owo-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable owo-bot.service
sudo systemctl start owo-bot.service
```

Set `ALLOW_LIVE_OWO=true` in `/etc/owo-blackjack-companion.env` only after the deployment gate is satisfied. With it false, the service still starts and registers `/owo`, but refuses live tracking. Check status with `systemctl status owo-bot.service` and logs with `journalctl -u owo-bot.service -n 50`. After changing the gate, run `sudo systemctl restart owo-bot.service`.

## 5. Playing on iPhone

1. Open the private server in the Discord iPhone app.
2. Go to the dedicated channel and type `/owo`. Press send; the default action is **start**. You can also use `/owo status`, `/owo stats`, or `/owo stop`.
3. Start a hand normally with `owo bj <bet>`.
4. The companion posts one advice message beside the OwO embed. You can tap **Open the OwO hand** to jump to the game.
5. React manually with OwO's **👊 hit** or **🛑 stand** reaction on OwO's message. The companion never reacts for you.
6. When OwO edits the embed, the companion edits the same advice message with the new HIT/STAND and EV values.
7. Finish or abandon the hand before starting another game in that channel. A second simultaneous OwO game causes the bot to pause rather than guess.
8. When finished, use `/owo stop` or stop the bot host.

There is no separate iPhone app and no card-entry screen. The advice is a normal Discord message, so it works with Discord's mobile text sizing and accessibility settings.

## 6. Safety behavior

- **No hidden card:** the parser ignores `cardback` and never converts it to a rank. The solver receives only visible player cards and the visible dealer upcard; it averages over the unknown hole.
- **No ownership guess:** the bot tracks the source message in a channel, not a username. One active game per channel is the safety boundary.
- **Fail closed:** unknown emoji, changed fields, extra text, multiple embeds, mismatched totals, missing hole cards, multiple visible dealer cards, or a 7♥ appearing all produce an unsupported/paused result instead of advice.
- **Duplicate-safe:** repeated create/update events are ignored; each OwO edit is treated as a full replacement state.
- **Missed-edit-safe:** a later edit carries the complete visible hand, so the next observed update can recover; older edits are ignored.
- **No OwO writes:** there is no code path that sends a bet, a game command, a reaction, or a component interaction to OwO. `/owo` only controls the companion's own tracking in the current channel.
- **Setup mode:** with the live gate closed, the bot still registers `/owo` but refuses activation; it never parses or acts on OwO messages.

## 7. Deployment gate

Do not set `ALLOW_LIVE_OWO=true`, and do not invite this bot to a public server, until both are true:

1. You have captured a real OwO hand in the test channel and confirmed its embed matches the parser's expected fields and card emoji names. If it differs, stop and update the parser; do not let it guess.
2. Message Content Intent is enabled for the application and the bot can read OwO embeds in the source channel.

Third-party bot permission is **not** an open general blocker: you confirmed OwO permits third-party bots. That is separate from permission for automated gambling actions. This companion never places a bet, sends an OwO command, reacts, or clicks a component; keep it that way. If you later add any action that affects OwO, stop and obtain separate authorization before deploying it.

## 8. Tests

```bash
npm test
```

The suite uses Node's built-in test runner and the installed `discord.js` package; it does not need a token or a live Discord connection. It covers:

- exact-known `10,6 vs 9` EV values;
- hard 16 vs 8, hard 15 vs 10, soft 17 vs 8, ace valuation, and multiple-card hands through the manual interface;
- observed-card depletion, duplicate-card rejection, corrected card recognition, and tracker reset between hands;
- pending/unsupported rules with no fabricated EV, invalid cards, missing cards, and impossible compositions;
- CLI text/JSON output and non-zero error statuses;
- independent 51-card identity composition, fresh-deck reset, within-hand depletion, and no cross-game contamination;
- independent hidden-dealer-hole distribution, soft/hard totals, four aces, three sevens, and busts;
- both-bust settlement and 51-card versus 52-card EV differences;
- hidden player cards and hidden dealer holes;
- unknown emoji, format drift, total mismatches, multiple embeds, and 7♥ rules mismatch;
- duplicate events, missed edits, stale edits, ended hands, ambiguity, deletion, expiry, statistics, and session history;
- one-advice-message upsert behavior;
- `/owo` command shape, gate refusal, permission checks, runtime channel activation, stop/status, and stats behavior.

The existing Phase 7 audit remains a separate exact-solver regression:

```bash
node phase7-audit.js --states 100000
```

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| Bot exits immediately | `DISCORD_TOKEN` is missing or invalid. |
| Login fails with privileged-intent error | Enable **Message Content Intent** in the Developer Portal. |
| `/owo` does not appear | Invite the bot with the `applications.commands` scope; restart it and check the startup log for registration errors. |
| `/owo` reports live tracking disabled | Set `ALLOW_LIVE_OWO=true` only after the deployment gate is satisfied, then restart the bot. |
| No advice appears | Run `/owo` in the channel, confirm the gate is open, and check the bot has View Channel/Read Message History/Send Messages. |
| `ADVICE PAUSED: Unsupported OwO format` | The live embed differs from the audited format. Capture the message and fix the parser; do not force advice. |
| `ADVICE PAUSED: another active game` | Finish or stop the first game. This version intentionally refuses to guess owners. |
| Advice stops after a restart | Sessions are memory-only; run `/owo` again and start a fresh hand after restarting the bot. |
| EV looks wrong | Check that OwO is showing the published rules; the bot refuses 7♥ and malformed totals rather than silently changing the model. |

## 10. Limitations

- The live OwO format was not verified in this workspace. The parser is based on the published source at commit `9aec92b…` and synthetic regression fixtures.
- Third-party bot permission is user-confirmed and is not a general blocker. Automated gambling actions are explicitly out of scope; the companion remains read-only.
- The model assumes the published 51-card deck, both-bust push, no 3:2 natural, dealer stands on soft 17, and hit/stand only. If live OwO differs, the recommendation may be wrong and the parser should reject the hand. See [`BLACKJACK-MECHANICS-RESEARCH.md`](BLACKJACK-MECHANICS-RESEARCH.md) for confirmed versus unconfirmed mechanics.
- EV is an expected value, not a guarantee. A hand can lose the full stake.
- The manual tracker, Discord history, and statistics are memory-only and are lost when the process exits.
- Recommendation accuracy is only available when a caller explicitly scores the decision. The automatic Discord path records wins/losses/pushes but cannot know whether an alternative action would have won.
- The one-shot CLI does not persist a session between commands. Use `BlackjackTableTracker` for remembered hands and statistics.
- The bot does not see ephemeral messages or DMs between you and OwO.

---

# OwO Bot — Cowoncy Economy Security Audit

**Target:** [`ChristopherBThai/Discord-OwO-Bot`](https://github.com/ChristopherBThai/Discord-OwO-Bot)  
**Commit analysed:** `9aec92b274bae64ea078fc04540398713e7f7928` (2024-11-03)  
**Audit date:** November 2026  
**Scope:** server-side Cowoncy accounting, transaction handling, concurrency and payout integrity.  
**Method:** line-level source review of the public repository plus an isolated MariaDB 10.6.23 reproduction using fictional accounts. No live OwO account, server, or production database was touched.

> The public repository is a snapshot. Anything controlled by the live deployment — the exact MariaDB version and `sql_mode`, Redis topology, the sharder's guild-to-shard assignment, the lottery draw job, and any private middleware — is not in the tree and is marked as an assumption or an open question wherever it matters.

> **Phase 2 correction (2026-11-09): see [`VERIFICATION.md`](VERIFICATION.md).** Two Phase 1 statements were too broad. T2b's burn variant proves an unbacked **user** credit but leaves total supply flat; the clean net-creation proof is P1-transfer (+100). T5b's +150 is net supply, but only +100 is excess over the funded 50-stake game's legitimate 150; the other +50 is the small game's win profit. Blackjack **ties** also pay `bet`. Lottery F3 is a confirmed unpaid ticket; Cowoncy creation depends on the absent draw. No newer public commit exists.

---

## 1. Executive summary

**Yes — the published implementation contains code paths that can record a Cowoncy balance that is not backed by the user's legitimate transactions.** That conclusion rests on source-level defects and isolated SQL reproduction, not on a live exploit.

The strongest confirmed defects are:

1. **Coinflip credits a win without requiring the stake to be present.** The command reads `money` once, validates it, then later runs `UPDATE cowoncy SET money = money + bet WHERE id = ?` with no transaction, no row lock, and no `money >= bet` predicate. If another command debits the balance between the read and the update, a winning flip still pays. Reproduction T2b (burn): balance 100 → loss of the first stake takes it to 0 → a later win pays +100 → final 100, where a legitimate sequence ends at 0. This is an unbacked credit; total supply is flat because the other command destroyed the 100. P1-transfer (the stake moves to another user) ends at 100 + 100 = 200, which is net creation (+100).
2. **Blackjack starts a game even when its stake debit affected 0 rows.** The entry query is a multi-statement `SELECT money; SELECT blackjack...; UPDATE cowoncy ... WHERE money >= bet`. Only the two SELECT results are inspected; the UPDATE result (`result[2]`) is never read. The game is created with the stale pre-debit balance. A win credits `2 * bet`; a tie credits `bet`. Reproduction T5: a concurrent 100 Cowoncy spend left the debit at 0 rows, yet the game started and paid 200; total supply went from 100 to 300. A second variant (T5b): two simultaneous entries with bets 50 and 100 from a 100 balance leave only the 50 debit funded; the game row is overwritten, but the 100-bet collector still settles the shared hand and is paid 200, leaving 250 from 100 — 150 net, of which 100 is excess over the funded 50 game's legitimate 150.
3. **Lottery records the ticket before the debit, with no transaction and no debit predicate.** The multi-statement is `INSERT/UPDATE lottery; SELECT SUM; UPDATE cowoncy SET money = money - amount`. Under autocommit, the ticket is committed even if the debit raises `ER_DATA_OUT_OF_RANGE`. Reproduction T6: two 100-Cowoncy bets from a 100 balance recorded a 200 ticket while only 100 was paid.
4. **The first-ever daily claim has no compare-and-swap predicate.** When the `cowoncy` row is absent at read time, `daily.js` omits `AND daily_streak = <old>` entirely. Two concurrent first claims both credit. Reproduction T7: 500 became 1,000.

Two important corrections to older notes in this repository:

- **Unsigned underflow does not wrap to a huge positive balance on MariaDB.** `money = money - 150` with `money = 100` raises `ERROR 1690 (22003): BIGINT UNSIGNED value is out of range`, in both `STRICT_TRANS_TABLES` and empty `sql_mode` (T1). The row is unchanged. The consequence is a rejected statement and an unhandled promise rejection, not a corrupted large balance.
- **Two simultaneous winning flips ending at 300 is not proof of minting.** Two funded 100-stake wins also end at 300 (T2). Slots is likewise protected by its `money >= amount` predicate: two wins end at 300 legitimately, and a loss followed by a win is refused (T4). The real coinflip failure is the **loss-then-win** sequence.

`give` is the best-implemented money path in the repository: an explicit transaction, a conditional debit, a `changedRows` check, an audit row, and rollback on failure (`give.js:122-176`). `drop` and `trade` follow a similar pattern. The gambling commands do not.

Severity is stated per finding below. The short version:

| ID | Finding | Impact | Severity | Evidence |
|----|---------|--------|----------|----------|
| F1 | Coinflip win has no funded-stake guard | Unbacked credit; net +100 when the stake is transferred | High (timing-dependent) | Source + SQL reproduction |
| F2 | Blackjack ignores 0-row stake debit | Game, 2× win / 1× tie without wager | High (narrow timing) | Source + SQL reproduction |
| F3 | Lottery ticket committed before debit | Free lottery stake | Medium–High | Source + SQL reproduction; draw unavailable |
| F4 | New-user daily has no CAS predicate | Duplicate daily credit | Low–Medium | Source + SQL reproduction |
| F5 | Slots 0-row settlement still displayed/logged | Ledger/UI mismatch | Low | Source + SQL reproduction |
| F6 | Underflow rejects with no handler | Shard availability | Medium (availability) | Source + SQL reproduction |
| F7 | `startTransaction` error/lifetime handling | Crash or failed transaction | Low | Source only |
| F8 | Give/trade/drop guarded debit pattern | No confirmed overdraw | Informational | Source + SQL reproduction |
| F9 | Redis cooldown is not a lock | Enables cross-process races | Medium (enabler) | Source only |

---

## 2. Confirmed architecture

### 2.1 Runtime and process model

The bot is a Node.js application using Eris through `eris-sharder`. `index.js` creates a master and worker clusters, with `clusters = 60` in the non-debug path (`index.js:31,55-61`). Each cluster hosts shards; each shard is a separate OS process with its own module state, its own in-memory objects, and its own MySQL pool. `src/owo.js:29` explicitly describes Redis pub/sub as communication “with all the other shards/processes.”

This matters because every in-process lock in the economy code — notably `ongoingTransactions` in `give.js` and `lock` in `cooldown.js` — is **per process**, not global.

### 2.2 Database layer

`src/utils/mysql.js:8-19`:

```js
const mysql = require('mysql');

const config = {
	host: process.env.MYSQL_HOST,
	user: process.env.MYSQL_USER,
	password: process.env.MYSQL_PASS,
	database: 'owo',
	supportBigNumbers: true,
	multipleStatements: true,
	charset: 'utf8mb4',
	connectionLimit: 10,
};

const pool = mysql.createPool(config);
```

- Raw `mysql` (not `mysql2`, no ORM), version `^2.18.1` in `package.json`.
- A single pool of **10 connections**.
- `multipleStatements: true` globally, which is what makes the `give`, blackjack and lottery multi-statement queries possible.
- No isolation level, no `sql_mode`, no `SET` session configuration, and no query retry.
- `mysqlHandler.query` (`src/botHandlers/mysqlHandler.js:12-19`) rejects the promise on any driver error. There is no error translation, no retry, and no circuit breaker.

The README states the bot uses **MariaDB**. The schema dump is MySQL-flavoured but InnoDB/MariaDB-compatible. The production version is unknown; the isolated reproduction used MariaDB 10.6.23, the current Ubuntu 22.04 package.

### 2.3 Redis layer

`src/utils/redis.js` wraps the old `redis@2.8.0` callback client in promises. It is used for cooldowns, prefixes, pub/sub and counters. It is **not** used as a distributed lock around balances.

### 2.4 Command execution

`src/eventHandlers/messageCreate.js:44-46`:

```js
} else {
	this.command.execute(msg, raw);
	levels.giveXP(msg);
}
```

The call is deliberately **not awaited and not caught**. `Command.execute` (`src/commands/command.js:29-70`) runs ban check → cooldown check → `commands[p.command].execute(p)` via `executeCommand` (`:154-164`). Each of those stages has `await`s, so two Discord messages can be in flight at the same time even on one shard. The handler returning a rejected promise is an unhandled rejection.

`CommandInterface.execute` (`src/commands/CommandInterface.js:44`) simply awaits the command function:

```js
await this.executeCommand.bind(params)(params);
```

There is no per-user command queue and no per-user database lock.

### 2.5 Transaction utility

`src/botHandlers/mysqlHandler.js:21-27`:

```js
exports.startTransaction = () => {
	return new Promise((res, rej) => {
		con.getConnection((err, acon) => {
			if (err) return rej(err);
			acon.beginTransaction((err) => {
				if (err) throw err;
			});
```

The `BEGIN` error is thrown inside a driver callback rather than rejecting the promise. The function also resolves before the `BEGIN` callback fires; the `mysql` driver queues later queries on the same connection, so statement ordering still works, but the error path does not. A 10-second timer (`acquireTimeLimit = 10000`, `:68-71`) later auto-rolls back and deletes the `query`/`commit`/`rollback` methods; callers that outlive it get a `TypeError` in their `catch`. This is a lifecycle defect, not an accounting vulnerability by itself.

### 2.6 Transaction map

| Path | Explicit transaction | Row lock | Conditional debit | Checks result | Idempotency |
|------|----------------------|----------|-------------------|---------------|-------------|
| `give` | Yes (`give.js:122`) | `FOR UPDATE` on `cowoncy_limit`; `UPDATE` locks `cowoncy` | `AND money >= amount` | `changedRows` | In-process map only |
| `drop` pickup | Yes (`drop.js:167`) | `UPDATE` locks rows | `AND amount >= amount` | `changedRows` | No |
| `trade` | Yes (`trade.js:224`) | `FOR UPDATE` on `user_item` | `AND money >= totalPrice` | `changedRows` | No |
| `blackjack` entry | No | `UPDATE` locks `cowoncy` | `AND money >= amount AND (active...)` | **No** (`result[2]` ignored) | `active` flag on resume |
| `blackjack` settlement | No | `UPDATE` locks `blackjack` | `AND active > 0` | `changedRows` | Yes (settlement claim) |
| `coinflip` | No | No | **No** | **No** | No |
| `slots` | No | `UPDATE` locks `cowoncy` | `AND money >= amount` | **No** | No |
| `lottery` | No | No | **No** | **No** | No |
| `daily` | No | `UPDATE` locks `cowoncy` | `AND daily_streak = old` (existing users only) | `changedRows` | Partial |
| `claim` | No | `INSERT IGNORE` locks key | N/A | `affectedRows` | Yes per reward |
| `quest` | No | `DELETE` locks row | N/A | `affectedRows` | Yes |
| `levelRewards` | No | `UPDATE ... WHERE rewardLvl = old` | N/A | `changedRows` | Yes |

### 2.7 Background jobs and queues

There is no economy job queue in the public tree. Quest increments are fire-and-forget (`command.js:304`), level rewards run inline (`levelRewards.js:105`), and Redis pub/sub is used for cross-shard messages, not for balance serialisation (`src/owo.js:29`). The lottery draw is not public: no cron entry, no `valid = 0` reset, and no jackpot payout code exist in the repository. The only background work that touches the economy is therefore outside the auditable source. This matters for F3: the ticket is written by the command, but the draw that consumes it cannot be checked here.

---

## 3. Database findings

### 3.1 Schema

`secret/CREATE-OWO-TABLES.sql:432-443`:

```sql
CREATE TABLE `cowoncy` (
  `id` bigint(20) unsigned NOT NULL,
  `money` bigint(20) unsigned NOT NULL DEFAULT '0',
  `daily` timestamp NOT NULL DEFAULT '2017-01-01 18:10:10',
  `daily_streak` int(20) NOT NULL DEFAULT '0',
  `battle` timestamp NOT NULL DEFAULT '2017-01-01 18:10:10',
  `pet` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `cowoncy__daily_streak` (`daily_streak`),
  KEY `cowoncy__money` (`money`),
  CONSTRAINT `fk_cowoncy_user` FOREIGN KEY (`id`) REFERENCES `user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
```

Related tables:

- `cowoncy_limit` also InnoDB, `send`/`receive` `int unsigned`, PK `id` (`:453-459`).
- `lottery` InnoDB, PK `id`, `amount int unsigned`, `valid tinyint` (`:691-698`).
- `blackjack` InnoDB, PK `id`, auto-increment `bjid`, `bet int unsigned`, `active tinyint` (`:287-296`).
- `transaction` InnoDB, PK `(sender, reciever, time)` at **second resolution**, FK `sender → cowoncy(id)` (`:1160-1169`).

### 3.2 Balance retrieval

Every gambling command uses a plain, non-locking read:

```js
// coinflip.js:83
let sql = 'SELECT money FROM cowoncy WHERE id = ' + msg.author.id + ';';
let result = await p.query(sql);
```

The same pattern appears at `slots.js:70`, `lottery.js:56`, and `blackjack.js:57`. None use `FOR UPDATE`; none run inside a transaction. `FOR UPDATE` exists only in `cowoncyUtils.js` when `isTransaction: true`, and that path is used by `give` (on `cowoncy_limit`, not `cowoncy`) and a few trade/survey paths.

### 3.3 Balance modification

All balance writes are raw arithmetic with string interpolation. Examples:

```js
// give.js:149
UPDATE cowoncy SET money = money - ${amount} WHERE id = ${sender} AND money >= ${amount};

// coinflip.js:107
UPDATE cowoncy SET money = money ${win ? '+' : '-'} ${bet} WHERE id = ${author};

// slots.js:133
UPDATE cowoncy SET money = money + ${win - amount} WHERE id = ${author} AND money >= ${amount};

// lottery.js:86
UPDATE cowoncy SET money = money - ${amount} WHERE id = ${author};

// blackjack.js:80
UPDATE cowoncy LEFT JOIN blackjack ON cowoncy.id = blackjack.id
SET money = money - ${amount}
WHERE cowoncy.id = ${author} AND money >= ${amount} AND (active = 0 OR active IS NULL);
```

There is no shared “credit” or “debit” function. Each command owns its SQL. Any invariant has to be enforced in every call site, and the call sites disagree.

### 3.4 Atomicity, transactions, locks

- **Coinflip:** two independent autocommit statements (SELECT, then UPDATE). No transaction, no lock.
- **Slots:** same, but the UPDATE has a predicate. The predicate is evaluated at update time against the current row, so it is atomic for that one statement.
- **Lottery:** a three-statement multi-statement query. Each statement autocommits. If the third fails, the first two remain committed.
- **Blackjack entry:** three statements in one multi-statement query. The first two are reads; the third is the debit. No transaction.
- **Blackjack settlement:** claim (`UPDATE blackjack SET active=0`) followed by a separate multi-statement `DELETE blackjack_card; UPDATE cowoncy`. No transaction. The claim is an idempotency gate; the payout is not atomic with it.
- **Give:** the only strict money transaction in the gambling-adjacent set. It locks the limit row, conditionally debits `cowoncy`, credits the receiver, inserts an audit row, and commits. `changedRows` is checked before commit.

### 3.5 Isolation level

The application never sets one. There is no `SET TRANSACTION ISOLATION LEVEL`, no pool `initSql`, and no `sql_mode` in `mysql.js`. Production therefore inherits the server default (InnoDB's default is REPEATABLE READ, and MariaDB's default is also REPEATABLE READ). Because the gambling commands are not in explicit transactions, each statement is its own autocommit transaction and each SELECT gets a fresh read view. The stale read is a TOCTOU across statements, not a REPEATABLE READ artifact.

### 3.6 Unsigned arithmetic — verified

`money` is `BIGINT UNSIGNED`. The schema dump sets only `SQL_MODE='NO_AUTO_VALUE_ON_ZERO'` for the dump session; it does not configure the server. The application does not set `STRICT_TRANS_TABLES`, `NO_UNSIGNED_SUBTRACTION`, or anything else.

T1 executed the exact loss statement from coinflip against MariaDB 10.6.23:

```sql
UPDATE cowoncy SET money = money - 150 WHERE id = 1;  -- money = 100
```

Result in both `STRICT_TRANS_TABLES` and empty `sql_mode`:

```
ERROR 1690 (22003): BIGINT UNSIGNED value is out of range
in '`audit`.`cowoncy`.`money` - 150'
```

Final balance: **100** (unchanged). The hypothesis that underflow wraps to `18446744073709551615` is **false for this engine and statement**. MariaDB evaluates the unsigned expression and raises; it does not clip the result to 0 and does not wrap. MySQL 8 uses the same `ER_DATA_OUT_OF_RANGE` (1690) for unsigned subtraction, but that was not run here; the production version is unknown.

The practical result of underflow is a rejected statement, not a corrupted balance. In coinflip and lottery there is no `catch`, so the rejection becomes an unhandled promise rejection (F6).

### 3.7 Result inspection

| Statement | `affectedRows` checked? | `changedRows` checked? |
|-----------|--------------------------|------------------------|
| `give` debit | No | Yes (`give.js:155`) |
| `drop` pickup debit | No | Yes (`drop.js:171`) |
| `trade` debit/credit/item | No | Yes (`trade.js:283-320`) |
| `blackjack` entry debit | **No** | **No** |
| `blackjack` settlement claim | No | Yes (`blackjack.js:261`) |
| `coinflip` update | **No** | **No** |
| `slots` update | **No** | **No** |
| `lottery` debit | **No** | **No** |
| `daily` update | No | Yes (`daily.js:174`) |
| `ring` sell decrement | No | Yes (`ringUtil.js:83`) |
| `weapon` sell delete | `affectedRows` (`weaponUtil.js:906, 1007`) | No |

`changedRows` counts rows whose values actually changed, not rows matched. That distinction matters for no-op updates (a 1× slots payout is `money + 0`), but none of the unchecked commands rely on it.

### 3.8 Concurrent stale reads

The pattern is explicit:

```js
// 1. read
let result = await p.query('SELECT money FROM cowoncy WHERE id = ' + id + ';');
// 2. validate against result[0].money
// 3. later, after at least one await, write
await p.query('UPDATE cowoncy SET money = ... WHERE id = ' + id + ';');
```

Between (1) and (3) the command may await a CSPRNG (`coinflip.js:99`), a random slot roll (`slots.js:79`), several embedded awaits, or simply the network round trip. Another command can commit in that window on a different pooled connection. Nothing prevents it.

---

## 4. Coinflip audit

**File:** `src/commands/commandList/gamble/coinflip.js`  
**Entry:** `module.exports = new CommandInterface({ ..., execute: async function (p) { ... } })`  
**Cooldown:** 15 s (`:33`)

### A. Initial balance retrieval

`:83-84`:

```js
let sql = 'SELECT money FROM cowoncy WHERE id = ' + msg.author.id + ';';
let result = await p.query(sql);
```

Plain SELECT, autocommit, no lock.

### B. Wager validation

`:85-97`:

```js
if (result[0] == undefined || result[0].money == 0 || (bet != 'all' && result[0].money < bet)) {
	p.send('**🚫 | ' + p.getName() + "**, You don't have enough cowoncy!", 3000);
	return;
} else {
	if (bet == 'all') bet = result[0].money;
	if (maxBet && bet > maxBet) bet = maxBet;
	else if (bet <= 0) { ... return; }
```

The validation is against the stale `result[0].money`. `maxBet` is 250,000 (`:10`). `all` is clamped after the read. Negative and zero bets are rejected.

### C. Currency deduction

**There is no deduction at wager time.** The stake is folded into the net result at settlement: a loss is `-bet`, a win is `+bet`. The win branch therefore never requires the stake to be present; it only adds.

### D. Game-result processing

`:99-104`:

```js
let rand = await random(0, 1);
let win = false;
if (rand == 0 && choice == 't') win = true;
else if (rand == 1 && choice == 'h') win = true;
```

`random-number-csprng` (CSPRNG) is used. The `await` widens the read→write window.

### E. Payout calculation

A win is `+bet`; a loss is `-bet`. The display says the user won `bet * 2` (`:130`), which is the gross payout (stake returned plus winnings). The net ledger change is `+bet`. This is internally consistent for a funded game.

### F. Currency crediting

`:106-114`:

```js
sql =
	'UPDATE cowoncy SET money = money ' +
	(win ? '+' : '-') +
	' ' +
	bet +
	' WHERE id = ' +
	msg.author.id +
	';';
result = await p.query(sql);
```

No `AND money >= bet`, no transaction, no `changedRows` check, no `try/catch`. The same statement serves both debit and credit.

### G. Commit / failure handling

Autocommit. There is no commit or rollback to perform. A driver error rejects `p.query`; the rejection propagates through `CommandInterface.execute` and `Command.execute`; `messageCreate.js:45` does not await or catch. No user-facing error is sent for the SQL failure.

### H. Can a game settle more than once?

Within one invocation, no: the UPDATE is a single statement and runs once. There is no game ID, no idempotency key, and no settlement record. A duplicate delivery of the same Discord message (gateway replay, shard resume, process retry) would be treated as a new game and could settle a second time. This is a potential duplicate-settlement vector, not demonstrated.

### I. Can simultaneous requests produce inconsistent accounting?

Yes. The two-command sequence that matters is **loss then win**:

1. Both commands read `money = 100` (or command B's debit lands between A's read and write).
2. A settles a loss: `UPDATE ... money - 100` → 0.
3. B settles a win: `UPDATE ... money + 100` → 100.

A legitimate system would reject B's wager once the balance is 0. Here B's win is paid with no stake. T2b reproduces the ledger result exactly.

The reverse sequence (win then loss) is funded by the win and is not a bug. Two wins also end at 300, which is the same as two funded sequential wins (T2) — this is the false positive that older notes mistook for minting.

### J. Can a failed deduction still be followed by a payout?

Yes, across commands. If the loss statement underflows it errors and the row is unchanged; a later winning flip still credits. Within a single flip the loss and win branches are exclusive, so this is a cross-command (concurrent game) condition.

### Finding F1 — Coinflip pays unfunded wins

**Severity:** High (unbacked credit; net creation when the concurrent debit transfers funds), conditional on a concurrent debit landing between the read and the write.  
**Evidence level:** Confirmed source defect; confirmed SQL consequence (T2b burn, P1-transfer, T2c); live command timing not demonstrated.  
**Affected code:** `coinflip.js:83-114`.

The write has no funded-stake predicate. The read-time check is not a reservation. Any other balance-reducing command that commits in the window — a lottery bet, a slots loss, a shop purchase, a give — can make the win unbacked. The win is still credited because `money + bet` has no condition to fail.

**What would confirm live exploitability:** a staging deployment with the real sharder and Redis, two commands issued in the same guild, and an instrumented query log showing the interleaving plus a total-supply increase. That was not possible from the public source alone.

---

## 5. Slots audit

**File:** `src/commands/commandList/gamble/slots.js`  
**Entry:** `execute: async function (p)`  
**Cooldown:** 15 s (`:38`)

### A. Initial balance retrieval

`:70-71`:

```js
let sql = 'SELECT money FROM cowoncy WHERE id = ' + msg.author.id + ';';
let result = await p.query(sql);
```

Plain SELECT, autocommit.

### B. Wager validation

`:72-75`:

```js
if (all && result[0] != undefined) amount = result[0].money;
if (maxBet && amount > maxBet) amount = maxBet;
if (result[0] == undefined || result[0].money < amount || result[0].money <= 0) { ... }
```

Same stale-read validation. `maxBet` is 250,000.

### C. Currency deduction

The stake and payout are combined into one net delta at settlement. Unlike coinflip, the UPDATE has `AND money >= amount`, so the net delta only applies if the stake is present **at settlement time**.

### D. Game-result processing

`:79-128` draws `rand = random(1, 1000) / 10` and maps it to 1×, 2×, 3×, 4×, 10× or a loss. Winning symbols use the CSPRNG-selected branch; the losing display uses `Math.random()` for the decoy symbols, which is cosmetic only.

### E. Payout calculation

`:82-116` sets `win = amount * multiplier`; the ledger delta is `win - amount` (`:133-139`). A 1× result is a net 0 (stake returned). A loss is `-amount`.

### F. Currency crediting

`:132-140`:

```js
sql =
	'UPDATE cowoncy SET money = money + ' +
	(win - amount) +
	' WHERE id = ' +
	msg.author.id +
	' AND money >= ' +
	amount +
	';';
result = await p.query(sql);
```

The predicate makes the statement atomic: the server re-checks the current balance when it acquires the row lock. If the balance has been spent, the statement matches 0 rows and no credit or debit is applied.

### G. Commit / failure handling

Autocommit. The result is **not inspected**. A 0-row settlement is indistinguishable from a successful one in the code.

### H. Can a game settle more than once?

Within one invocation, no. No idempotency key; duplicate message delivery would create a new spin.

### I. Can simultaneous requests produce inconsistent accounting?

Two wins from one observed balance end at 300 (T4). That is **not** minting: two funded 100-stake wins also end at 300, and the second win is funded by the first win's proceeds. The guard ensures each settlement's net delta is applied only if the stake exists at that moment.

A loss followed by a win is refused at the second statement (`changedRows = 0`), final balance 0 (T4). The ledger is correct.

The real defect is presentation: the command still displays the spin result and logs the cowoncy/gamble delta even when the UPDATE matched 0 rows. A user can see “you won X” while receiving nothing, or see a loss while keeping the money. That is a UI/metrics inconsistency, not currency creation.

### J. Can a failed deduction still be followed by a payout?

No for the ledger. The same statement carries both the debit and the credit; if it cannot apply the stake, it applies neither. This is the design coinflip lacks.

### Finding F5 — Slots reports settlements it did not apply

**Severity:** Low.  
**Evidence level:** Confirmed source + SQL (T4).  
**Affected code:** `slots.js:132-142`.

`result` is assigned but never checked. A 0-row update still runs `p.logger.incr('cowoncy', win - amount, ...)` and still renders the final machine with the win/loss text. The ledger is safe; the user-visible result and the metrics are not.

---

## 6. Lottery audit

**File:** `src/commands/commandList/gamble/lottery.js`  
**Entry:** `execute` calls `bet(p.con, p.msg, p.args, p.global, p)` **without awaiting it** (`:31-34`).  
**Cooldown:** 5 s (`:27`)

### A. Initial balance retrieval

`:56-58`:

```js
let sql = 'SELECT money FROM cowoncy WHERE id = ' + msg.author.id + ';';
sql += 'SELECT * FROM lottery WHERE id = ' + msg.author.id + ' AND valid = 1;';
let result = await p.query(sql);
```

Two SELECTs in one multi-statement query, no lock.

### B. Wager validation

`:59-72`:

```js
if (!result[0][0] || result[0][0].money < amount) { ... return; }
else {
	if (all) amount = parseInt(result[0][0].money);
	let prevBet = 0;
	if (result[1][0]) prevBet = result[1][0].amount;
	if (prevBet >= maxBet) { ... return; }
	if (amount > maxBet - prevBet) amount = maxBet - prevBet;
```

`maxBet` is 250,000. The cap is computed from the stale `prevBet` read, so two concurrent submissions can both pass and exceed the per-user cap. The `all` + zero-balance edge (`0 < 0` is false) can create a zero-amount `valid=1` ticket; whether that matters depends on the private draw.

### C. Currency deduction

`:73-90` builds:

```sql
INSERT INTO lottery (id,channel,amount,valid) VALUES (:id, :channel, :amount, 1)
  ON DUPLICATE KEY UPDATE amount = amount + :amount, valid = 1, channel = :channel;
SELECT SUM(amount) AS sum, COUNT(id) AS count FROM lottery WHERE valid = 1;
UPDATE cowoncy SET money = money - :amount WHERE id = :id;
```

The ticket write is first; the debit is last. There is no `AND money >= amount` on the debit and no transaction around the three statements.

### D. Game-result processing

The actual draw is **not in the public repository**. There is no cron job, no `valid = 0` reset, and no jackpot payout code in the tree. `grep -rn "lottery"` finds only the command, help text, and `admin/deleteUser.js`. The draw is therefore a closed-source/private component and cannot be audited here.

### E. Payout calculation

Not available. The command displays `SUM(amount) + 500` as the jackpot (`:117`) and computes the user's chance as `bet / sum` (`:96-97`). The payout code is absent.

### F. Currency crediting

Only the ticket write. Any later jackpot credit is outside the public source.

### G. Commit / failure handling

Autocommit. If the third statement fails (for example, unsigned underflow), the driver returns an error; the first two statements are already committed. `execute` does not await `bet`, so the rejection is unhandled.

### H. Can a game settle more than once?

The entry can be repeated (each call adds to the existing ticket). Settlement/idempotency of the draw is not visible.

### I. Can simultaneous requests produce inconsistent accounting?

Yes, in two ways:

1. **Ticket before debit.** Two 100-Cowoncy submissions from a 100 balance both insert/update the ticket to 200; the first debit takes the balance to 0; the second debit raises 1690. The ticket remains 200 and only 100 was paid (T6). The extra 100 is an unbacked stake in the draw.
2. **Cap bypass.** Both submissions read `prevBet = 0` and both pass the 250,000 cap check; the combined ticket can exceed the cap.

### J. Can a failed deduction still be followed by a payout?

Yes in principle: the ticket is committed before the debit. Whether the draw pays the extra stake depends on the private draw. The ledger inconsistency is confirmed; the currency impact is not.

### Finding F3 — Lottery ticket is committed before the debit

**Severity:** Medium–High. The free stake is confirmed; whether it converts to minted Cowoncy depends on the private draw.  
**Evidence level:** Confirmed source + SQL (T6); draw unavailable.  
**Affected code:** `lottery.js:73-91`.

The missing `AND money >= amount` and the missing transaction are the defect. The fix is to put the ticket write and the debit in one transaction, debit first with a predicate, check `changedRows`, and only then commit the ticket.

---

## 7. Blackjack audit

**File:** `src/commands/commandList/gamble/blackjack.js`  
**Entry:** `execute: async function (p)`  
**Cooldown:** 15 s (`:34`)

### A. Initial balance retrieval

`:57-61`:

```js
let sql = 'SELECT money FROM cowoncy WHERE id = ' + msg.author.id + ';';
sql +=
	'SELECT * FROM blackjack LEFT JOIN blackjack_card ON blackjack.bjid = blackjack_card.bjid WHERE id = ' +
	msg.author.id +
	' AND active = 1 ORDER BY sort ASC, dealer DESC;';
```

The balance read and the active-game read are in one multi-statement query.

### B. Wager validation

`:62-86` appends the debit as the **third statement**:

```js
if (amount == 'all')
	if (maxBet)
		sql +=
			'UPDATE cowoncy LEFT JOIN blackjack ON cowoncy.id = blackjack.id SET money = (IF(money >' +
			maxBet + ',money - ' + maxBet + ',0)) WHERE cowoncy.id = ' + msg.author.id +
			' AND money > 0 AND (active = 0 OR active IS NULL);';
	else
		sql += 'UPDATE cowoncy LEFT JOIN blackjack ON cowoncy.id = blackjack.id SET money = 0 WHERE ...';
else {
	if (maxBet && amount > maxBet) amount = maxBet;
	sql +=
		'UPDATE cowoncy LEFT JOIN blackjack ON cowoncy.id = blackjack.id SET money = money - ' + amount +
		' WHERE cowoncy.id = ' + msg.author.id + ' AND money >= ' + amount +
		' AND (active = 0 OR active IS NULL);';
}
let result = await p.query(sql);
```

`result[0]` is the balance SELECT, `result[1]` is the active-game SELECT, `result[2]` is the debit UPDATE. Only `result[0]` and `result[1]` are used.

### C. Currency deduction

The debit is conditional, but its result is ignored. The code then decides whether to start a game from `result[0][0].money` — the pre-debit balance — not from the post-debit balance and not from `result[2].affectedRows`.

### D. Game-result processing

If `result[1][0]` exists, the existing game is resumed (`initBlackjack(p, 1, result[1])`), and the debit did not run. Otherwise, if the stale balance is non-zero and covers `amount`, the code calls `initBlackjack(p, amount)` (or `initBlackjack(p, money)` for `all`) at `:93-107`, which inserts a new `blackjack` row with `active = 1` and deals cards (`:148-173`).

### E. Payout calculation

`stop()` computes the winner (`:230-243`) and builds:

```js
if (winner == 'w')
	sql2 += 'UPDATE cowoncy SET money = money + ' + bet * 2 + ' WHERE id = ' + p.msg.author.id + ';';
else if (winner == 't' || winner == 'tb')
	sql2 += 'UPDATE cowoncy SET money = money + ' + bet + ' WHERE id = ' + p.msg.author.id + ';';
```

A win pays `2 * bet` because the stake was supposed to have been deducted at entry. A tie/both-bust refunds `bet`. A loss pays nothing.

### F. Currency crediting

`:245-262`:

```js
let sql = 'UPDATE blackjack SET active = 0 WHERE id = ' + p.msg.author.id + ' AND active > 0;';
let sql2 = 'DELETE FROM blackjack_card WHERE bjid = (SELECT bjid FROM blackjack WHERE id = ' + p.msg.author.id + ');';
if (winner == 'w') sql2 += 'UPDATE cowoncy SET money = money + ' + bet * 2 + ' WHERE id = ' + p.msg.author.id + ';';
...
p.con.query(sql, function (err, result) {
	if (err) { ... return; }
	if (result.changedRows > 0) {
		p.con.query(sql2, function (err, _result) {
```

The claim is idempotent: `active = 0 WHERE active > 0` changes the row exactly once; a second settlement sees `changedRows = 0` and skips the payout. T8 confirms `[1, 0]`.

### G. Commit / failure handling

No transaction. The claim commits; then a separate query deletes the cards and pays. If the payout query fails after the claim, the game is inactive and the player is not paid. That is player harm, not inflation. If the process dies between the claim and the payout, the same.

### H. Can a game settle more than once?

The settlement claim prevents it. A concurrent second stop sees `changedRows = 0`. A late stop after a new game is started is theoretically possible, but the claim and the payout are issued in the same callback with no user-controlled await between them; no practical double-pay was found.

### I. Can simultaneous requests produce inconsistent accounting?

**Yes, at entry.** The debit is statement 3 in a multi-statement query, but it is still autocommit and can be interleaved with another connection between statements. If the balance drops after the `SELECT money` and before the `UPDATE`, the UPDATE matches 0 rows. The code does not check `result[2]`; it uses the stale `result[0][0].money` and starts the game anyway.

T5:

1. `SELECT money` → 100.
2. A concurrent legitimate spend moves 100 to another user.
3. The blackjack debit matches **0 rows**.
4. The code inserts `blackjack` with `bet = 100, active = 1`.
5. A win pays `+200`.
6. Final balances: player 200, other user 100; total 300 from an initial 100 → **200 created**.

The window is narrow (no app-level await between the SELECT and UPDATE; they are in one packet), but it is nonzero because each statement autocommits and another connection can commit between them. A concurrent `give` transaction holding the `cowoncy` row lock can also delay the UPDATE and make the predicate re-evaluate against the new balance.

**Also at entry:** two simultaneous blackjack commands can both read a stale balance. The first debits and inserts an active game; the second's debit matches 0 rows (active = 1), but the second still calls `initBlackjack`, which does `INSERT ... ON DUPLICATE KEY UPDATE bet = ..., active = 1` and overwrites the game row. The collectors read the shared row on each reaction, so both see the same DB state, but each closure keeps its own `bet` (`:148-173`, `:126-139`). If the bets differ (50 and 100 from a 100 balance), only the 50 debit succeeds; the row may end at 50, yet the 100-bet collector can settle the shared hand and be paid 200. T5b: final 250 from 100 — 150 net, of which 100 is excess over the funded 50 game's legitimate 150. The card set can also be a union of both games because `generateSQL` does not clear old cards; the embeds show each command's initial hand, so the “choose after seeing” path is conditional, not guaranteed. This is state corruption and excess payout; the same-bet variant is player harm, not net creation.

### J. Can a failed deduction still be followed by a payout?

**Yes — this is F2.** The debit failure is silent, the game starts, and a win pays 2× the never-debited stake. That is the clearest "failed deduction followed by payout" in the public code.

### Finding F2 — Blackjack ignores the stake debit result

**Severity:** High.  
**Evidence level:** Confirmed source defect + confirmed SQL consequence (T5); live timing not demonstrated.  
**Affected code:** `blackjack.js:57-100`, `148-173`, `245-262`.

The missing check is one line: `result[2].affectedRows` (or `changedRows`). If it is 0, the command must abort before `initBlackjack`. The game insert should be in the same transaction as the debit so a failed insert cannot leave a paid stake with no game or a game with no stake.

---

## 8. Payout and credit audit

### 8.1 Every Cowoncy credit site in the public tree

`grep -rn "UPDATE cowoncy.*money = money +\|INSERT INTO cowoncy"` finds the following. This table covers every place a balance can increase.

| Credit site | File:line | Gate before credit | Atomic with source of funds? | Notes |
|-------------|-----------|--------------------|------------------------------|-------|
| Give receiver | `give.js:150` | Sender debit `changedRows` in same transaction | Yes | Best pattern in the tree |
| Drop pickup | `drop.js:175` | `cowoncydrop` debit `changedRows` in same transaction | Yes | Correct |
| Trade seller | `trade.js:279` | Buyer debit and item debit checked in same transaction (`:284-313`) | Yes | Correct |
| Blackjack win/tie | `blackjack.js:252-254` | Settlement claim `changedRows` | No (claim separate from payout) | Idempotent claim; payout failure loses player funds |
| Slots | `slots.js:133` | `money >= amount` in the same UPDATE | Yes | 0-row result not inspected (F5) |
| Coinflip win | `coinflip.js:107` | None at settlement | **No** | F1 |
| Lottery ticket | `lottery.js:74-84` | None before ticket; debit after | **No** | F3 |
| Daily | `daily.js:75-79` | `daily_streak = old` (existing users only) | N/A | New-user path has no CAS (F4) |
| Daily marriage bonus | `daily.js:300, 445` | Partner's daily state; `dailies = old` only in `doubleCheckMarriage` | No | The apparent race is a false positive; see §13 |
| Claim reward | `claim.js:75` | `INSERT IGNORE user_compensation` `affectedRows` | No (credit after gate) | Duplicate-safe; failure loses reward |
| Quest reward | `questHandler.js:93` | `DELETE FROM quest ...` `affectedRows` | No | Duplicate-safe; failure loses reward |
| Level reward | `levelRewards.js:105` | `user_level_rewards` CAS `changedRows` | No | Duplicate-safe |
| Zoo animal sale | `zoo/sell.js:135, 156` | `count >= count` in same UPDATE | Yes | Correct |
| Zoo rank sale | `zoo/sell.js:236` | `changedRows != rows` check + transaction | Yes | Correct |
| Ring sale | `ringUtil.js:89` | `rcount > 0` decrement `changedRows` | No (credit separate) | Duplicate-safe; failure loses ring |
| Weapon sale | `battle/util/weaponUtil.js:912, 1016` | `affectedRows` on DELETE (`:906, 1007`) | No (credit separate) | Duplicate-safe; failure loses weapon |
| Checklist | `checklist.js:102` | Date read, then `UPDATE timers` with no CAS | No | Same pattern as new-user daily; not audited in depth |
| Admin reset | `admin/resetCowoncy.js:28` | Admin-only | N/A | Out of scope |

### 8.2 Shared utilities

There is no shared ledger module. `cowoncyUtils.js` only checks give limits; `rewardUtil.js` returns SQL strings for other flows. Every credit is inline SQL, so the invariants are re-implemented per command. This is the root design reason the commands disagree: `give` reserves and checks, `blackjack` checks the read but not the write, `coinflip` checks the read and neither the write nor the predicate, and `lottery` writes the credit before the debit.

### 8.3 Idempotency

- **Blackjack settlement:** yes, via `active = 0 WHERE active > 0` + `changedRows`.
- **Claim/quest/level:** yes, via `INSERT IGNORE`/`DELETE`/CAS `affectedRows`/`changedRows`.
- **Daily:** partial; the existing-user CAS works because the streak always increments, but the new-user path omits it.
- **Coinflip/slots/lottery:** no game ID, no settlement record, no idempotency key. A duplicate message delivery creates a new game.
- **Give:** the `transaction` table has a `(sender, reciever, time)` primary key at second resolution; two same-pair transfers in the same second collide and roll back (availability, not inflation).

### 8.4 Debit vs credit asymmetry

The general rule in the broken paths is: **debits are guarded at read time; credits are not guarded at all.**

- Coinflip: the loss branch subtracts, the win branch adds. The read check assumes the loss branch is the only way the balance can fall. A concurrent command invalidates that assumption; the win branch has no guard.
- Blackjack: the debit is conditional, but the game starts from the read balance, so a failed debit is treated as success.
- Lottery: the ticket is a credit-like write that happens before the debit; the debit is unguarded.

This is why the answer to “can a failed debit still be followed by a payout?” is yes, and why it is not the same as “a race condition creates money automatically.”

---

## 9. Concurrency findings

### 9.1 The actual interleavings

The code has three distinct read→write patterns:

1. **Separate autocommit statements** (coinflip, slots, lottery read; blackjack entry read/update):
   - `SELECT` on pooled connection A.
   - `await` (CSPRNG, random roll, embedded awaits, or network).
   - `UPDATE` on pooled connection B (or the same one; the pool does not pin).
   - No lock spans the two. Any other command can commit between them.

2. **One multi-statement query** (lottery, blackjack entry): the statements are sent in one packet and executed sequentially on one connection, but each statement autocommits. Another connection can commit between statements. The window is much smaller than pattern 1, but not zero.

3. **Explicit transaction** (give, trade, drop): `START TRANSACTION`, conditional updates, `changedRows`, `COMMIT`/`ROLLBACK`. The row lock is held until commit. This is the only pattern that is safe by construction.

### 9.2 Redis cooldowns are not locks

`src/utils/cooldown.js:24-30`:

```js
// lock key
if (lock[key]) return;
else lock[key] = true;
try {
	// Fetch last used time
	let ccd = await redis.hgetall(key);
	...
```

and later `await redis.hmset(key, ccd)` (`:63-66`). This is a read-then-write on Redis, not `SET NX PX`. The `lock` object is module-local, so it only serialises the check inside one process. With 60 clusters and shards in separate processes, two commands can both read the old `lasttime` and both pass. Even without a cross-shard setup, two different commands have different keys (`cd_coinflip_<id>` vs `cd_lottery_<id>`), so they do not block each other at all.

This is not a database lock and cannot be used as one. It is a rate limiter, and it is racy at its own boundary.

### 9.3 Multiple connections

`connectionLimit: 10`; each `p.query` borrows a connection, runs one statement or one multi-statement packet, and returns it. There is no session affinity between a command's SELECT and UPDATE. A transaction is the only way to pin a connection and hold locks; the gambling commands do not use one.

### 9.4 Operations that continue after a failed write

- **Blackjack:** continues after a 0-row debit (F2).
- **Slots:** continues to display/log after a 0-row settlement (F5).
- **Lottery:** continues to keep the committed ticket after a failed debit (F3).
- **Coinflip:** does not continue after an error; the promise rejects and the command produces no message (F6).

### 9.5 Which conditions can cause incorrect accounting

| Condition | Affected path | Result |
|-----------|---------------|--------|
| Concurrent debit between coinflip read and write, flip wins | Coinflip | Unbacked credit; net +100 if the debit transfers funds (F1) |
| Concurrent balance drop between blackjack SELECT and UPDATE | Blackjack | Game starts with no stake; win pays 2× (F2) |
| Concurrent debit between lottery ticket write and debit | Lottery | Ticket larger than amount paid (F3) |
| Two first-ever daily claims concurrently | Daily | Double credit (F4) |
| Concurrent settlement of the same blackjack game | Blackjack | Prevented by the `active` claim (T8) |
| Concurrent slots settlements | Slots | Ledger safe; UI/metrics mismatch (F5) |
| Concurrent gives from the same sender | Give | Debit predicate + transaction prevent overdraw; one may deadlock and roll back |
| Concurrent gives that create the daily limit row | Give | The `INSERT ... ON DUPLICATE KEY UPDATE send = amount` uses assignment, not `send + amount`; concurrent first-of-day gives may undercount the limit or deadlock/roll back. Needs a two-connection test; not confirmed |

**Do not generalise:** concurrency alone does not create currency. It creates the *opportunity* for a write that was already missing a predicate to apply a credit without its corresponding debit. Slots has the predicate and is safe; coinflip and blackjack do not.

---

## 10. Error-handling findings

### 10.1 Unhandled rejections

`mysqlHandler.query` rejects on driver errors. The gambling commands do not catch:

- `coinflip.js:114` — `result = await p.query(sql);` with no `try/catch`.
- `slots.js:140` — same.
- `lottery.js:91` — same, and `execute` does not await `bet`.
- `blackjack.js:88` — same, though the later callbacks do check their own errors.

`messageCreate.js:45` does not await `this.command.execute(...)`. On Node 15+, an unhandled rejection terminates the process by default. Depending on the production Node version and whether `eris-sharder` attaches a handler, an underflow error (T1) or any transient DB error can take down a shard. That is an availability issue, not a balance-corruption issue. It is also how the coinflip loss branch fails silently: the user gets no message, the row is unchanged, and the command's cooldown has already been consumed.

### 10.2 `startTransaction` defects

`mysqlHandler.js:21-27`:

```js
acon.beginTransaction((err) => {
	if (err) throw err;
});
```

- The `throw` is inside a callback, not a promise executor; it becomes an uncaught exception.
- The promise resolves `result` before the `BEGIN` callback. The `mysql` driver queues subsequent queries on the same connection, so ordering is usually preserved, but an error in `BEGIN` is not propagated to the caller.
- The 10-second timer (`:68-71`) calls `result.rollback()` and releases the connection, deleting `query`/`commit`/`rollback`. A caller that outlives the timer gets `TypeError: con.rollback is not a function` inside its `catch`, masking the original error. The connection has already been released, so there is no cross-request commit, but the transaction's outcome is undefined from the caller's point of view.

None of these create currency directly; they turn transaction failures into crashes or confusing errors. They matter because `give` is the safe path, and its safety depends on this utility working.

### 10.3 Fire-and-forget quests

`command.js:304` calls `main.questHandler.increment(...).catch(console.error)`. Quest credit is gated by a `DELETE` with `affectedRows`, so a failure loses a reward but does not duplicate it.

### 10.4 Blackjack payout after claim

`blackjack.js:255-267`: the claim commits, then a separate query deletes cards and pays. If the second query fails, the game is inactive and the player is not paid. The error is logged and the message says “Something went wrong...”. This is a player-harm path; it cannot pay twice.

### 10.5 `transaction` primary-key collisions

`transaction` PK `(sender, reciever, time)` with `time TIMESTAMP` (second precision). Two `give`s between the same pair in the same second collide. The insert is the third statement in the `give` transaction; the collision rejects, `give.js:179-183` catches and rolls back. The transfer fails; no balance changes. A retry a second later succeeds. This is a reliability bug, not inflation.

---

## 11. Confirmed vulnerabilities

These are confirmed **in the published source** and, where noted, reproduced at the SQL layer against a real InnoDB table. “Confirmed” here means the code path and its database consequence are demonstrated; it does not mean the live bot was exploited.

### F1 — Coinflip credits unfunded wins

- **File/function:** `src/commands/commandList/gamble/coinflip.js`, `execute`.
- **Excerpt:** `:83-114` (SELECT + validate + `UPDATE ... money ± bet` with no predicate, transaction, or result check).
- **Programming error:** the read-time balance check is treated as a reservation. The win branch is a pure credit; it does not require the stake to be present when it runs.
- **Database behaviour:** the UPDATE is a separate autocommit statement. A concurrent debit can commit between the SELECT and the UPDATE. The win UPDATE then adds `bet` to a balance that no longer contains the stake.
- **Conditions:** two commands in flight for the same user; the debit commits inside the read→write window; the flip wins. A second command with a different cooldown key (lottery, shop purchase, slots loss, give) is enough; the two-flip version additionally needs a cooldown race.
- **Reproduction:** T2b burn (100 → loss → 0 → win → 100; legitimate 0; net supply flat), P1-transfer (stake moved to another user; total 200; net +100), T2c (with `AND money >= bet`, 0).
- **Affects:** credits (unbacked win; net supply grows when the concurrent debit transfers funds); the loss branch can also fail to collect an unfunded loss (error 1690), but that is bounded by the zero balance.
- **Severity:** High.
- **Evidence level:** Confirmed source + confirmed SQL. Live command timing not demonstrated.
- **To confirm live:** staging bot, instrumented query log, two commands in one guild, total-supply increase.

### F2 — Blackjack starts and pays after a 0-row stake debit

- **File/function:** `src/commands/commandList/gamble/blackjack.js`, `execute`, `initBlackjack`, `stop`.
- **Excerpt:** `:57-100` (three statements; `result[2]` ignored), `:148-173` (game inserted), `:245-262` (2× win / 1× tie payout).
- **Programming error:** the code checks the pre-debit SELECT (`result[0][0].money`) but not the debit UPDATE (`result[2].affectedRows`). A 0-row debit is treated as success.
- **Database behaviour:** the debit is conditional (`money >= amount AND (active...)`). A concurrent spend can make it match 0 rows; the game is still created. A win pays `2 * bet`; a tie pays `bet`.
- **Conditions:** a concurrent balance-reducing operation between the SELECT and the UPDATE (or a lock wait that lets the balance change), followed by a win.
- **Reproduction:** T5 (100; concurrent transfer; debit 0 rows; game starts; win +200; total 300 from 100); T5b (two entries of 50 and 100; only the 50 debit is funded; the 100-bet collector settles the shared hand; final 250; 100 excess over the funded game's legitimate 150; 150 net).
- **Affects:** credits (2× payout on a win, 1× on a tie, without a stake); also a duplicate-start overwrite of an active game and same-bet double debit.
- **Severity:** High.
- **Evidence level:** Confirmed source + confirmed SQL. Narrow timing window; live not demonstrated.
- **To confirm live:** same as F1, with a lock-wait or concurrent-spend trace.

### F3 — Lottery ticket committed before an unguarded debit

- **File/function:** `src/commands/commandList/gamble/lottery.js`, `bet`.
- **Excerpt:** `:73-91` (ticket INSERT/UPDATE, then SELECT SUM, then unguarded `UPDATE cowoncy SET money = money - amount`).
- **Programming error:** no transaction, no `AND money >= amount`, no `changedRows` check. The ticket is a committed write before the debit.
- **Database behaviour:** autocommit; the ticket survives a failed debit. Underflow raises 1690.
- **Conditions:** a concurrent debit between the ticket write and the debit, or a stale balance from the initial SELECT; a second submission in the same window.
- **Reproduction:** T6 (two 100 bets from 100; ticket 200; paid 100; balance 0).
- **Affects:** the lottery stake (free ticket); whether it mints Cowoncy depends on the private draw.
- **Severity:** Medium–High.
- **Evidence level:** Confirmed source + confirmed SQL; draw unavailable.
- **To confirm currency impact:** the draw/payout code, jackpot funding source, and whether `valid` is reset idempotently.

### F4 — First-ever daily claim has no CAS

- **File/function:** `src/commands/commandList/economy/daily.js`, `execute`/`executeQuery`.
- **Excerpt:** `:75-79`:

  ```js
  } ${cowoncy ? ` AND daily_streak = ${cowoncy.daily_streak}` : ''} ;`;
  ```
- **Programming error:** when the `cowoncy` row is absent at read time, the compare-and-swap predicate is omitted. The `INSERT IGNORE` creates the row, then the unconditional `UPDATE` credits.
- **Database behaviour:** two concurrent first claims both match the UPDATE and both add the reward.
- **Conditions:** a user's first-ever daily, processed twice concurrently (same-command cooldown race or cross-shard duplicate delivery).
- **Reproduction:** T7 (500 → 1,000).
- **Affects:** credits (one-time duplicate daily, plus any marriage bonus that depends on it).
- **Severity:** Low–Medium.
- **Evidence level:** Confirmed source + confirmed SQL; live path not demonstrated.
- **To confirm live:** a new account, duplicate delivery, and ledger diff.

### F5 — Slots displays a refused settlement as played

- **File/function:** `src/commands/commandList/gamble/slots.js`, `execute`, `:128-140`.
- **Excerpt:** the loss/win `UPDATE cowoncy SET money = money + (${payout} - ${amount}) WHERE id = ... AND money >= ${amount}`; `changedRows` is not checked, and `p.replyMsg` / `p.logger.incr` follow unconditionally.
- **Behaviour:** after a concurrent debit leaves less than the stake, the settlement matches 0 rows; the embed still shows a result and the metric still increments. T4 confirms changedRows `[1,0]` and final 0.
- **Impact:** the player sees a result (including a “winnings” message) that was never credited; the ledger is not inflated.
- **Severity:** Low (correctness/UX).
- **Evidence level:** Confirmed source + SQL; live timing not demonstrated.

### F6 — Underflow rejection with no handler

- **File/function:** `coinflip.js:114`, `slots.js:140`, `lottery.js:91`, `messageCreate.js:45`.
- **Excerpt:** unguarded `await p.query(...)`; fire-and-forget `execute`.
- **Programming error:** no `try/catch`; no awaited handler.
- **Database behaviour:** 1690 on unsigned subtraction; the row is unchanged.
- **Conditions:** a race that makes the loss/debit exceed the balance.
- **Reproduction:** T1.
- **Affects:** availability (shard crash on Node 15+); no balance corruption.
- **Severity:** Medium (availability) / Low (accounting).
- **Evidence level:** Confirmed SQL; Node/eris runtime behavior not tested.

### F7 — `startTransaction` error and lifecycle handling is broken

- **File/function:** `src/botHandlers/mysqlHandler.js`, `startTransaction`, `:21-76`.
- **Excerpt:** `if (err) throw err;` inside the `beginTransaction` callback; `setTimeout` deletes `query` / `commit` / `rollback` after 10 s (`:63-73`).
- **Behaviour:** a `BEGIN` failure is thrown in a driver callback rather than rejecting the promise; a caller slower than 10 s gets a `TypeError` instead of a clean rollback. The `give` path can surface this as a generic failure; it does not create a balance.
- **Severity:** Low–Medium (reliability).
- **Evidence level:** Source only; not reproduced.

### F8 — Guarded debit pattern (informational)

- **Files/functions:** `give.js:122-183`, `drop.js:167-185`, `trade.js:224-321`.
- **Behaviour:** each opens a transaction, uses a conditional debit (`money >= amount` or the equivalent), checks `changedRows`, and commits or rolls back. No overdraw path was found. This is the model the gambling commands do not follow.
- **Severity:** Informational (safe pattern).
- **Evidence level:** Source review; T9/T10 confirm the guarded/CAS pattern rejects the second debit.

### F9 — Redis cooldown is not a distributed lock

- **File/function:** `src/utils/cooldown.js`, `check` / `lock`, `:18-74`.
- **Excerpt:** the check reads `checkGuildCooldown`, then writes it; `lock` is a module-level object (`const lock = {};`, `:5`).
- **Behaviour:** each shard process has its own map; Redis is a read-then-write rate limiter, not a mutex. Two processes can pass the same cooldown, which is the enabler for the F1/F2/F4 races. It does not itself change a balance.
- **Severity:** Medium (enabler).
- **Evidence level:** Source only; cross-process timing not reproduced.

---

## 12. Potential vulnerabilities

These are plausible from the source but need production information or a live/staging reproduction.

1. **F1/F2 live timing.** The SQL consequence is confirmed. Whether the production sharder, Redis latency, and CSPRNG timing let a normal user hit the window reliably is unknown. The source shows no per-user queue and no DB lock, so the window exists; its width is a deployment property.
2. **Lottery draw impact.** The ticket-before-debit defect is confirmed, but the draw is not public. If the draw pays proportionally to `amount` from the sum of stakes, an unbacked 100 stake dilutes or exceeds the jackpot. If it pays a fixed prize, the impact is smaller. Needs the draw code.
3. **Lottery cap bypass.** Two concurrent submissions both read `prevBet = 0` and can exceed the 250,000 per-user cap. This is a rules/limit bypass, not a balance corruption; it increases the user's share of the draw.
4. **Give daily-limit bypass.** `cowoncyUtils.js:62` uses `INSERT ... ON DUPLICATE KEY UPDATE send = ${amount}` (assignment, not `send + amount`). Two concurrent first-of-day gives may both see no row and the second may overwrite the counter, or the gap locks may deadlock one of them and roll it back. The balance debit is still guarded; only the daily send limit could be undercounted. This needs a two-connection test and is not confirmed.
5. **Unhandled rejections as a DoS.** A user who can reliably trigger an underflow (via the F1/F3 race) can crash a shard on Node 15+. The error path is confirmed; the crash depends on the runtime and `eris-sharder`'s error handling.
6. **Duplicate Discord delivery.** No gambling command has an idempotency key. If the gateway replays a message after a resume, the command can settle twice. Discord's delivery semantics and Eris's resume behavior need to be verified; no evidence of a replay was found in the source.
7. **Blackjack duplicate start.** Two simultaneous entries can both pass the read check; the second's debit matches 0 rows, then `INSERT ... ON DUPLICATE KEY UPDATE` overwrites the active game. When the bets differ, only the smaller debit succeeds but the larger-bet collector can settle the shared hand and be paid 2× the larger bet (T5b): +100 excess over the funded 50 game's legitimate 150. This needs cross-shard/cooldown timing; the same-bet variant is player harm, not net creation.
8. **`startTransaction` lifecycle.** A `BEGIN` failure throws in a callback; a >10 s transaction is auto-rolled back and its methods deleted. The `give` path could surface a `TypeError` and a confusing failure. Not confirmed in practice.
9. **MariaDB/MySQL version differences.** The underflow test was MariaDB 10.6.23. MySQL 8 uses the same error code for unsigned subtraction, but a production server with `NO_UNSIGNED_SUBTRACTION` or a nonstandard engine could behave differently. The application does not pin `sql_mode`, so this is a deployment assumption.
10. **BIGINT precision in JavaScript.** `supportBigNumbers: true` without `bigNumberStrings` returns JS Numbers. Above 2^53, `result[0].money` loses precision; `bet = 'all'` could be rounded. This requires an account above ~9 quadrillion Cowoncy, which is not realistic in the current economy, but the schema allows it.

---

## 13. False positives and misconceptions

### 13.1 “Two concurrent coinflip wins mint money”

**False.** Two winning 100-stake flips from a 100 balance end at 300. Two *funded* sequential wins also end at 300: 100 → 200 → 300. The second win is funded by the first win's proceeds. The ledger is consistent. T2 shows both paths at 300. The vulnerability is the **loss-then-win** sequence, not two wins (T2b).

### 13.2 “Slots double-credits because the guard sees the first win's balance”

**False for the ledger.** The guard `AND money >= amount` is evaluated atomically at settlement. Two wins end at 300, which is correct for two funded wins; a loss then a win is refused (T4). The real slots defect is that a 0-row settlement is still displayed and logged (F5), not that it mints.

### 13.3 “Unsigned underflow wraps to a huge balance”

**False on MariaDB 10.6.** `money - 150` with `money = 100` raises 1690 and leaves the row unchanged, in strict and empty `sql_mode` (T1). The “wrap to 18446744073709551615” claim would require a different engine/expression configuration; it is not what the published code does on the documented MariaDB stack. The practical outcome is an error/no-op, not a jackpot.

### 13.4 “A negative balance can be stored”

**False.** The column is `BIGINT UNSIGNED`; a negative assignment is either an error or (on a different configuration) clipped, never stored as negative. The code cannot create a negative ledger balance.

### 13.5 “The Redis cooldown prevents concurrent commands”

**False as a lock.** It is a read-then-write rate limiter with a per-process mutex around the check. Different commands use different keys; cross-process checks are racy. It does not serialise balance operations.

### 13.6 “Simultaneous marriage dailies double the marriage bonus”

**Not supported.** `checkMarriage` grants the bonus only when the partner's daily is **already claimed today** (`daily.js:438-441`). Two partners claiming simultaneously both see the other's daily as claimable and both return without a bonus; they do not both credit. A duplicate bonus requires a duplicate individual daily (F4), not merely simultaneous marriage claims. The `doubleCheckMarriage` path has a `dailies = old` CAS and does not double-credit.

### 13.7 “A modified Discord client can change the balance”

**Irrelevant to this audit.** Everything here is server-side SQL reached through ordinary commands. Client-side display changes do not touch `cowoncy`; the findings are about the backend's own transaction handling.

### 13.8 “A failed SQL update means the payout also failed”

**Not necessarily.** Blackjack (F2) and lottery (F3) both continue after a failed or 0-row debit. That asymmetry is the point: a failed debit is not a failed command, and a later credit can still run.

---

## 14. Private reproduction results

**Environment:** Ubuntu 22.04, MariaDB 10.6.23, InnoDB, Node 22.23.3. The database was a throwaway datadir under the scratch directory; the accounts are fictional IDs `1` and `2`; no production data, bot token, or live server was used.

**Harness:** `poc/audit-poc.mjs` starts `mariadbd`, creates `audit.cowoncy` / `blackjack` / `blackjack_card` / `lottery` / `transaction` with the schema from `secret/CREATE-OWO-TABLES.sql`, and replays the balance-affecting SQL statements from the source. It does not run the Discord command layer, and unrelated `user`/inventory inserts are omitted where they do not change the ledger. For the TOCTOU cases (T2b, T5, T5b) the interleaving is forced by executing the statements in the chosen order; that demonstrates the ledger consequence, not the network timing.

**Raw output:** `poc/output.txt`.

| Test | What it replays | Observed |
|------|-----------------|----------|
| T1 | Coinflip loss `money - 150` from 100 | 1690 in strict and empty `sql_mode`; balance stays 100 |
| T2 | Two wins from one observed 100 | 300, identical to two funded sequential wins → false positive |
| T2b | Loss then win from one observed 100 (burn) | 0 after loss, then 100 after win; legitimate outcome 0; total supply flat |
| T2c | Loss then guarded win (`AND money >= 100`) | 0 rows on the win; final 0 |
| T4 | Slots win/win and loss/win | 300 for two wins; loss-then-win second update 0 rows; final 0 |
| T5 | Blackjack 0-row debit, game insert, win payout | Debit 0 rows; final player 200, other 100; total 300 from 100 |
| T5b | Two entries (50 and 100) from one 100 balance | 50 debit succeeds, 100 debit 0 rows; row bet 50; 200 paid; final 250; 100 excess over the funded game's legitimate 150 |
| T6 | Two lottery tickets from 100 | Ticket 200; paid 100; second debit 1690; balance 0 |
| T7 | Two first-ever daily claims | Both changed 1; final 1,000 vs single 500 |
| T8 | Two blackjack settlement claims | changedRows 1, then 0 |
| T9 | Two guarded debits (`give`/`drop` pattern) | changedRows 1, then 0; final 0 |
| T10 | Two CAS credits on the observed balance | changedRows 0, 1; final 200 |

**Representative output (T2b, T5, T6):**

```text
### T2b CONFIRMED: loss then win pays an unfunded stake
{
  "first_loss_changedRows": 1,
  "balance_after_loss": 0,
  "second_win_ok": true,
  "final_balance": 100,
  "legitimate_outcome_after_losing_the_only_stake": 0
}

### T5 Blackjack starts after a 0-row stake debit, then pays the win
{
  "observed_balance_before": 100,
  "debit_affectedRows": 0,
  "debit_changedRows": 0,
  "final_balances": [{"id": 1, "money": 200}, {"id": 2, "money": 100}],
  "initial_total": 100,
  "final_total": 300,
  "created": 200
}

### T5b Two blackjack entries, one funded small stake, larger bet settles
{
  "small_debit_changedRows": 1,
  "large_debit_changedRows": 0,
  "row_after_both_inserts": [{"bet": 50, "active": 1}],
  "claim_changedRows": 1,
  "final_balance": 250,
  "initial_total": 100,
  "created": 150
}

### T6 Lottery ticket committed while the debit fails
{
  "first": "ok",
  "second": {"errno": 1690, "code": "ER_DATA_OUT_OF_RANGE", "message": "BIGINT UNSIGNED value is out of range ..."},
  "lottery_row": [{"id": 1, "amount": 200, "valid": 1}],
  "final_balance": 0,
  "paid_cowoncy": 100,
  "stake_recorded": 200
}
```

**What the reproduction does prove:** the SQL sequences in the published source produce those ledger states on InnoDB with the documented schema.  
**What it does not prove:** that a live user can win the timing race on the production sharder, that the private lottery draw pays the unbacked stake, or that production uses exactly this MariaDB version/`sql_mode`.

---

## 15. Recommended security fixes

### 15.1 Make every balance change go through one ledger function

A single module should own debit, credit and game settlement. At minimum:

```js
// Debit: must match exactly one row.
async function debit(con, id, amount, reason, idempotencyKey) {
  const [r] = await con.query(
    'UPDATE cowoncy SET money = money - ? WHERE id = ? AND money >= ?',
    [amount, id, amount]
  );
  if (r.affectedRows !== 1) throw new InsufficientFunds();
  // insert ledger row with idempotencyKey in the same transaction
}
```

Every call site should use it. This removes the per-command SQL drift that produced F1-F3.

### 15.2 Coinflip: reserve the stake before the outcome

Either:

- **Debit-first transaction:** `START TRANSACTION; SELECT money ... FOR UPDATE; UPDATE cowoncy SET money = money - bet WHERE id=? AND money >= bet;` check `affectedRows`; resolve the flip; on win `UPDATE ... money + 2*bet`; `COMMIT`. If the debit fails, reject the wager before generating an outcome.
- **Single guarded CAS:** `UPDATE cowoncy SET money = money - bet WHERE id=? AND money >= bet` then a second, idempotent payout update keyed by a game ID. The first update is the reservation; the second is the credit.

A `money >= bet` predicate on the *credit* statement alone is not sufficient; it would prevent the unfunded win but still allows two funded games to settle from one read. The stake must be reserved before the outcome is generated, or the settlement must be a single transaction with a game ID.

### 15.3 Blackjack: check the debit, and make entry atomic

- Read `result[2].affectedRows` and abort if it is not 1.
- Put the debit and the `blackjack`/`blackjack_card` inserts in one transaction.
- Add a game ID to the settlement and carry it through the collector; do not re-query the current `bjid` in the payout.
- Make the payout and the `active = 0` claim one transaction (`UPDATE ... WHERE active > 0` + payout), or keep the claim and retry the payout idempotently.

### 15.4 Lottery: debit before the ticket, in one transaction

```sql
START TRANSACTION;
UPDATE cowoncy SET money = money - :amount WHERE id = :id AND money >= :amount;
-- check affectedRows = 1, else ROLLBACK
INSERT INTO lottery (...) VALUES (...) ON DUPLICATE KEY UPDATE amount = amount + :amount, valid = 1, ...;
COMMIT;
```

Lock the lottery row (`SELECT ... FOR UPDATE`) when enforcing the per-user cap. Make the draw idempotent: a unique draw ID, a `paid` flag, and a transaction that marks the winner and credits the jackpot together.

### 15.5 Daily: CAS on a value that always changes

Use the `daily` timestamp or a unique claim nonce, not only `daily_streak`:

```sql
UPDATE cowoncy
SET money = money + :gain, daily = :now, daily_streak = :streak
WHERE id = :id AND daily < :midnight;
```

For a brand-new user, insert the row first and then run the same guarded update; never omit the predicate.

### 15.6 Slots: inspect the settlement result

If `result.affectedRows === 0`, do not display a win/loss as if it happened. Either re-read and render the actual state, or abort with “the spin could not be settled.” Only log the cowoncy/gamble delta when the update matched a row.

### 15.7 Give: close the limit-row gap and the audit-key collision

- Use `INSERT ... ON DUPLICATE KEY UPDATE send = send + VALUES(send)` or lock the row with `SELECT ... FOR UPDATE` before deciding, so concurrent first-of-day gives cannot overwrite the counter.
- Give the `transaction` table a surrogate id and a non-unique `(sender, receiver, time)` index, or use microsecond timestamps, so two transfers in the same second do not collide.
- Keep the current transaction/conditional-debit/`changedRows` structure; it is the model.

### 15.8 Cooldown: use an atomic Redis operation

Replace `HGETALL` + `HMSET` with `SET key value NX PX <ttl>` (or a Lua script that checks and sets atomically). Treat it as a rate limiter, not a lock. For per-user balance safety, use a database transaction or a distributed lock with a fencing token; do not rely on the cooldown.

### 15.9 Error handling

- Wrap every `p.query` in a `try/catch` that sends a user-facing error and does not leave a cooldown consumed for a failed command.
- Await or `.catch()` `this.command.execute(...)` in `messageCreate.js`, and add a process-level `unhandledRejection` logger.
- Fix `startTransaction`: `await` the `BEGIN` and reject on error; never `throw` inside the driver callback. Make the 10-second timer reject the transaction explicitly rather than deleting its methods under the caller.
- Make the blackjack payout failure path retryable or refundable; do not leave a claimed game unpaid.

### 15.10 Detection and verification

- Add a `scripts/verify-economy.mjs` that runs the SQL suite in `poc/audit-poc.mjs` against an in-process/test database and fails on any of T2b/T5/T6/T7 regressions.
- Log every balance mutation with `before`, `after`, `delta`, `reason`, and a game/transaction id, and reconcile the sum of deltas against `SUM(cowoncy.money)` daily.
- Alert on a negative delta on a credit-only path, on `affectedRows = 0` for a debit, and on any `ER_DATA_OUT_OF_RANGE`.
- Add a per-user serialization test with two real connections, not a single-threaded mock.

---

## Appendix A — Source map

| Concern | File | Lines |
|---------|------|-------|
| Pool config | `src/utils/mysql.js` | 8-19 |
| Promise query | `src/botHandlers/mysqlHandler.js` | 12-19 |
| Transaction utility | `src/botHandlers/mysqlHandler.js` | 21-76 |
| Command dispatch | `src/commands/command.js` | 29-70, 154-164 |
| Message handler (no await) | `src/eventHandlers/messageCreate.js` | 44-46 |
| Cooldown check | `src/utils/cooldown.js` | 18-74 |
| Give limit + `FOR UPDATE` | `src/commands/commandList/economy/utils/cowoncyUtils.js` | 31-40, 96-100, 149-151 |
| Give transaction | `src/commands/commandList/economy/give.js` | 122-183 |
| Coinflip | `src/commands/commandList/gamble/coinflip.js` | 83-114 |
| Slots | `src/commands/commandList/gamble/slots.js` | 70-142 |
| Lottery | `src/commands/commandList/gamble/lottery.js` | 56-91 |
| Blackjack entry | `src/commands/commandList/gamble/blackjack.js` | 57-100, 148-173 |
| Blackjack settlement | `src/commands/commandList/gamble/blackjack.js` | 245-267 |
| Daily | `src/commands/commandList/economy/daily.js` | 75-79, 168-176 |
| Claim | `src/commands/commandList/economy/claim.js` | 63-75 |
| Quest credit | `src/botHandlers/questHandler.js` | 85-100 |
| Level credit | `src/utils/levelRewards.js` | 95-105 |
| Drop pickup | `src/commands/commandList/gamble/drop.js` | 167-185 |
| Trade | `src/commands/commandList/shop/trade.js` | 224-321 |
| Schema | `secret/CREATE-OWO-TABLES.sql` | 432-443, 453-459, 691-698, 287-296, 1160-1169 |

## Appendix B — Limitations

1. **Public snapshot only.** The clone is pinned to `9aec92b` (2024-11-03). The live OwO code may differ; private middleware, a different sharder, or a later fix could change any finding.
2. **No production configuration.** The exact MariaDB version, `sql_mode`, isolation level, Redis latency, shard count, and guild-to-shard mapping are not in the repository. The reproduction used MariaDB 10.6.23 with the documented schema and default settings.
3. **No live bot.** The harness replays SQL, not Discord events. The command-level timing races are inferred from the source (`messageCreate.js` does not await, the pool does not pin connections, the cooldown is not a lock) but were not executed against a running bot.
4. **Lottery draw missing.** The draw, jackpot funding, and `valid` reset are not in the public tree. The free-ticket consequence is confirmed; the currency impact is not.
5. **No exploit attempts.** No live OwO accounts, servers, balances, or production databases were touched. The reproduction uses fictional IDs and a throwaway datadir.
6. **Shallow history.** The clone has one commit, so the commit history referenced in older notes (e.g., “Only allow one cowoncy transactions at a time”) could not be independently reviewed.
7. **Node runtime.** The unhandled-rejection crash depends on the Node version and `eris-sharder`'s error handling, neither of which is pinned in `package.json`.

---

*This report is for defensive review and isolated reproduction. It does not contain a live exploit, and it should not be used to interact with production OwO accounts or servers.*
