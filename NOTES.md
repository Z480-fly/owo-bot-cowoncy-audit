# Additional Research Notes

## Files examined

- `secret/CREATE-OWO-TABLES.sql` — full schema dump
- `src/commands/commandList/economy/give.js`
- `src/commands/commandList/economy/utils/cowoncyUtils.js`
- `src/commands/commandList/gamble/coinflip.js`
- `src/commands/commandList/gamble/slots.js`
- `src/commands/commandList/gamble/lottery.js`
- `src/utils/cooldown.js`
- `src/utils/mysql.js`
- `src/utils/redis.js` (partial)
- `src/commands/CommandInterface.js`

## Gambling directory contents
```
blackjack.js
blackjackUtil.js
coinflip.js
drop.js
lottery.js
slots.js
```

## Key code patterns

### give.js transaction pattern
- `this.startTransaction()` → connection with explicit commit/rollback
- `FOR UPDATE` when `isTransaction: true`
- Conditional debit + `changedRows` guard
- In-memory `ongoingTransactions` object

### coinflip.js pattern
- Plain `SELECT money`
- Later unguarded `UPDATE money = money ± bet`
- No transaction, no row lock, no result inspection

### slots.js pattern
- Adds `AND money >= amount` on the UPDATE
- Still no transaction / no changedRows check

## Open questions (not answerable from public source)

1. Exact production `sql_mode`
2. Whether any closed-source middleware wraps `p.query`
3. Production Redis configuration / possible additional locks
4. Exact isolation level used by the live MariaDB instance

## Distinction reminder

Race conditions on the gambling paths can produce:
- Over-debit / balance corruption
- Silently failed updates

They do **not**, by themselves, create new currency out of nothing.
