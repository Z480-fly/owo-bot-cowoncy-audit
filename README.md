# OwO Bot — Cowoncy Economy Source Audit

**Scope:** Legitimate security research based exclusively on publicly available source from [ChristopherBThai/Discord-OwO-Bot](https://github.com/ChristopherBThai/Discord-OwO-Bot).

**Date of analysis:** November 2026  
**Goal:** Understand transaction handling, concurrency, and balance integrity for the Cowoncy economy.

> This repository documents observable behavior from the open-source code. It does **not** contain exploit instructions, payloads, or live-bot attack guidance.

---

## 1. Key Source Files

| File | Role |
|------|------|
| `secret/CREATE-OWO-TABLES.sql` | Schema (cowoncy, cowoncy_limit, transaction tables) |
| `src/commands/commandList/economy/give.js` | Currency transfer |
| `src/commands/commandList/economy/utils/cowoncyUtils.js` | Limit checks + `FOR UPDATE` |
| `src/commands/commandList/gamble/coinflip.js` | Coinflip gambling |
| `src/commands/commandList/gamble/slots.js` | Slots gambling |
| `src/commands/commandList/gamble/lottery.js` | Lottery entry |
| `src/utils/cooldown.js` | Redis-backed command cooldowns |
| `src/utils/mysql.js` | Connection pool |

---

## 2. Schema Facts (Confirmed)

### `cowoncy` table
```sql
CREATE TABLE `cowoncy` (
  `id` bigint(20) unsigned NOT NULL,
  `money` bigint(20) unsigned NOT NULL DEFAULT '0',
  ...
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_cowoncy_user` FOREIGN KEY (`id`) REFERENCES `user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
```

- **Storage engine:** InnoDB (supports transactions + row locks)
- **Money column:** `bigint(20) unsigned` → cannot store negative values
- Related table `cowoncy_limit` is also InnoDB

### SQL mode
The schema dump only sets:
```sql
SQL_MODE='NO_AUTO_VALUE_ON_ZERO'
```
No application code forces `STRICT_TRANS_TABLES`, `STRICT_ALL_TABLES`, or `NO_UNSIGNED_SUBTRACTION`. Production behavior of unsigned underflow depends on the live server's `sql_mode`.

---

## 3. Transaction Handling Comparison

### `give.js` — Strong design

```js
const con = await this.startTransaction();
// ...
const canGive = await cowoncyUtils.canGive(..., con, {
  skipCowoncyCheck: true,
  isTransaction: true,   // enables FOR UPDATE
});

let sql = `UPDATE cowoncy SET money = money - ${amount} 
           WHERE id = ${sender} AND money >= ${amount};`;
sql += `INSERT INTO cowoncy ... ON DUPLICATE KEY UPDATE money = money + ${amount};`;
// + transaction audit row + limit updates

let result = await con.query(sql);
if (!result[0].changedRows) {
  await con.rollback();
  // insufficient funds
}
await con.commit();
```

When `isTransaction: true`, `cowoncyUtils.js` issues:
```sql
SELECT ... FROM cowoncy ... WHERE id = ? AND money >= ? FOR UPDATE;
```

**Also present:**
- In-memory `ongoingTransactions` map (prevents concurrent gives involving the same users)
- Explicit commit / rollback
- Audit insert into a `transaction` table

### `coinflip.js` — Classic TOCTOU

```js
// 1. Read
let sql = 'SELECT money FROM cowoncy WHERE id = ' + msg.author.id + ';';
let result = await p.query(sql);
// validate balance

// 2. Later (after random outcome)
sql = 'UPDATE cowoncy SET money = money ' + (win ? '+' : '-') + ' ' + bet +
      ' WHERE id = ' + msg.author.id + ';';
result = await p.query(sql);
// NO inspection of affectedRows / changedRows
// NO transaction, NO FOR UPDATE, NO AND money >= bet
```

The SELECT and UPDATE are **not atomic**. No result metadata is checked after the UPDATE.

### `slots.js` — Intermediate

```js
sql = 'UPDATE cowoncy SET money = money + ' + (win - amount) +
      ' WHERE id = ' + msg.author.id + ' AND money >= ' + amount + ';';
```

Adds a conditional predicate but still lacks a transaction and does not inspect `changedRows`.

### `lottery.js`
Same unguarded pattern as coinflip (SELECT then later UPDATE without `AND money >= amount` or result checking).

---

## 4. Surrounding Protections

| Layer | What exists |
|-------|-------------|
| Command cooldown | Redis-backed (`cd_<command>_<userid>`). Coinflip/slots = 15 s. Short in-process lock around the cooldown check itself. |
| Application mutex | Only on `give` (`ongoingTransactions`) |
| Database transaction | Only on `give` path |
| Row lock (`FOR UPDATE`) | Only when `isTransaction: true` in cowoncyUtils |
| Redis distributed lock around balance | Not present in published code |
| Idempotency keys | Not present |

`src/utils/mysql.js` is a plain connection pool (`connectionLimit: 10`, `multipleStatements: true`). No isolation-level configuration is set by the application.

---

## 5. Unsigned Subtraction Outcomes

Because `money` is `UNSIGNED`:

- Negative balances **cannot** be stored.
- An UPDATE that would underflow either:
  - Fails with an out-of-range error (under strict SQL mode), or
  - Wraps to a very large positive value (non-strict / certain configurations).

The published application code does **not** handle either case for coinflip/lottery. `give.js` avoids the problem by using `WHERE money >= amount` + `changedRows` check.

---

## 6. Distinguishing Effects (Important)

| Effect | Possible from published gambling paths? |
|--------|-----------------------------------------|
| Balance corruption / underflow | Yes (race + unguarded UPDATE) |
| Silently ignored failed UPDATE | Yes (no `changedRows` check) |
| Negative balance stored | No (unsigned column) |
| Unauthorized **creation** of new currency | Not produced by a simple concurrent race on these paths |
| Double-credit of a win without debit | Would require a different bug class |

A race on coinflip/lottery can cause **over-debit or a rejected mutation**, not free money. Free currency would need a separate logic error (e.g., crediting a win while failing to debit the stake).

---

## 7. Maintainer Acknowledgments (Public)

Commit history shows:
- “Only allow one cowoncy transactions at a time”
- “Fixed issue where give would not work sometimes”
- “Fixed issues giving cowoncy to new users”

These indicate past concurrency/reliability problems on the transfer path that were addressed. No public documentation of successful persistent currency-duplication exploits was found.

---

## 8. Summary Table

| Operation | Transaction | `FOR UPDATE` | Conditional debit | Result check | App mutex |
|-----------|-------------|--------------|-------------------|--------------|-----------|
| **give** | Yes | Yes | `WHERE money >= amount` | `changedRows` | Yes |
| **coinflip** | No | No | No | No | No |
| **slots** | No | No | `AND money >= amount` | No | No |
| **lottery** | No | No | No | No | No |

---

## 9. Research Notes

- All findings above are derived from the public repository as of the analysis date.
- Production Redis configuration, exact live `sql_mode`, and any closed-source wrappers are not visible.
- For private testing, the published code can be self-hosted against a local MariaDB instance (some secret/token files are intentionally omitted from the public tree).

**This document is for defensive understanding and private reproduction in controlled environments only.**
