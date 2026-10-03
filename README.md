# Byakugan

Tracks who mints and who buys NFTs, across EVM chains, so you can spot the same wallets
turning up early in collection after collection.

It indexes a collection's transfer history from the chain into local SQLite, classifies
every movement as a mint, buy, transfer or burn, and answers questions about the wallets
behind them — who minted first, who received the first mints, and which wallets acquired
across several collections at once.

**Read-only, by design and by test.** Byakugan holds no keys, signs nothing, and has no
wallet client anywhere in it. A test asserts the config schema contains no private-key
field. It reads chains; it cannot touch them.

Milestones 1 (the historical indexer) and 2 (the Telegram bot) are complete. To use it from a
chat, go to [The Telegram bot](#the-telegram-bot).

---

## Quick start

Node 20 or newer.

```bash
git clone https://github.com/Dharkwhale/Byakugan.git
cd Byakugan
npm install
cp .env.example .env          # then edit it, see below
npm run migrate               # creates ./data/byakugan.db
```

`.env` needs one RPC endpoint per chain you want, named by chain id:

```
RPC_URL_1=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_URL_8453=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
DEFAULT_CHAIN_ID=8453
ETHERSCAN_API_KEY=optional, speeds up deploy-block lookup on some chains
```

Chains are configured in [`config/chains.json`](config/chains.json) — 1 (Ethereum), 8453
(Base), 42161 (Arbitrum) and 84532 (Base Sepolia) ship with it. A chain needs both an
entry there and an `RPC_URL_<id>`.

**Always dry-run first.** It resolves the deploy block, measures the provider's real
range cap, and tells you how long the run will take — before you start one:

```bash
npm run index -- --contract 0xec04bedeec2f23307bba10468822d5b76a4284f5 --chain 8453 --dry-run
```

```
  deploy block      51905209  (binary_search, validated)
  blocks to index   51905209 to 52005946  (100738 blocks)
  chunk size        10 blocks  (measured against the endpoint)
                    measured by probing: 10 blocks accepted after 2 attempts
  getLogs calls     10,074
  estimated time    6.7 minutes  for log fetching alone
                    at 5.0 getLogs/s, derived from the compute-unit ceiling
                    rather than from a flat configured rate
```

The chunk size is measured against your endpoint and the rate is derived from the
compute-unit ceiling, so both figures are grounded — but the CU prices behind the
rate are published rather than measured, and the report says so while that holds.

Then index for real, bounding it while you find your feet:

```bash
npm run index -- --contract 0xec04… --chain 8453 --to-block 51905900
```

It resumes from where it stopped, so an interrupted run costs nothing and a second run
over the same range inserts nothing.

---

## Enrichment levels

This is the one thing worth understanding before you start, because it decides both what
you can ask and what the run costs. A collection's level is chosen when it is **first**
indexed.

Classifying a movement needs different amounts of data depending on the answer. `mint`
and `burn` are visible in the log itself. Telling a `buy` from a plain `transfer` needs
the *transaction* — its value, and who sent it. And on a mint, the transaction's sender
is the **acting wallet**, which is the whole point: one bot minting 200 tokens to 200
fresh addresses looks exactly like 200 separate collectors unless you know who sent it.

| level | fetches | `firstRecipients` | `firstMinters` | `overlap` |
|---|---|---|---|---|
| `logs_only` | nothing | ✅ | ❌ refuses | ❌ refuses |
| `mints_only` | each mint's transaction | ✅ | ✅ | ❌ refuses |
| `full` *(default)* | every transaction | ✅ | ✅ | ✅ |

```bash
npm run index -- --contract 0x… --level mints_only
```

**Refuses, rather than answering approximately.** A query that cannot be answered
completely throws and tells you what is missing. An unenriched row is stored as
`unclassified` — never as `transfer` — because a wrong answer that looks right is worse
than an error: `overlap` scores wallets on mints *and* buys, so a wallet that bought
seven of fifteen collections would silently score zero.

**The level cannot change on a resume**, in either direction. Re-running at a different
level is refused, because a collection holding two levels in different block ranges is
something no query can interpret. To move a collection up, upgrade it explicitly — that
fetches only the transactions that are missing, not the logs again.

---

## What a run actually costs

There are two fetch paths, and which one you get changes the answer by orders of
magnitude.

**`alchemy_getAssetTransfers` is the default where the endpoint serves it.** It has no
block-range cap and returns up to 1000 transfers per page, so one call can cover a span
that `eth_getLogs` needs thousands for. Measured over one real collection's entire
history: **70 `getLogs` calls (4,200 CU) against 1 page (120 CU)**.

**`eth_getLogs` is the fallback, and it is capped at 10 blocks on the free tier.**
Measured, flat, not density-derived — a query against an address that never emitted
anything caps at 10 too. It is a plan-tier limit, so `--dry-run` measures it against your
endpoint rather than trusting a config value.

| span | via `getLogs` | time | via `getAssetTransfers` |
|---|---|---|---|
| 100,000 blocks | 10,000 calls | ~33 min | a handful of pages |
| 1,000,000 blocks | 100,000 calls | ~5.6 hours | pages scale with TRANSFERS, not blocks |

The rate comes from the compute-unit ceiling rather than a request count: the free tier
allows 300 CU/second, `eth_getLogs` costs 60, so 5 calls/second is the real allowance.
There is no `requestsPerSecond` setting to get wrong — the limiter charges each call its
method's price out of one account-wide budget, so cheap methods run faster than expensive
ones instead of sharing a flat guess.

**The two paths are required to produce identical rows**, and that is enforced rather than
assumed:

```bash
npm run compare:paths -- --chain 8453 --contract 0x… --standard 721 --from N --to M
```

It runs both over the same range and asserts the row sets match exactly — count, every
`(tx_hash, log_index, batch_index)` tuple, token ids, amounts, addresses, and order —
exiting non-zero on any divergence. Two things it is really checking, because both would
be silent if wrong: `log_index` exists only inside `uniqueId`, and `firstMinters` orders by
it; and for ERC-1155 `batch_index` comes from the position in `erc1155Metadata`, which is
only valid because that array's order was measured to match the log's `ids[]`.

If the response ever lacks a parseable log index, the code **refuses and falls back to
`eth_getLogs`** rather than synthesising an order. A fabricated ordering would land
directly on the product's headline query and look exactly like a real answer.

Force a path with `--fetch-path logs` — useful for indexing a range both ways and diffing
the databases, which is how the equivalence above was confirmed end to end.

**Enrichment is separate from all of this, and it dominates.** Measured on a real
collection, fetching the transactions cost roughly 142× the cost of fetching the logs.
That is what the enrichment levels are for.

## The Telegram bot

The bot is how you normally use Byakugan: you send it a collection's address in a chat, it
indexes that collection, and you then ask it who minted first. It runs on your own machine
(or server) and talks to Telegram over long polling, so nothing needs to be exposed to the
internet.

This section takes you from a fresh clone to a working `/firstminters` reply, assuming you
have never made a Telegram bot. Do the steps in order. Each says what it is **for**, because
when something does not work, knowing why a step exists is how you find which one you missed.

### What you need before you start

- Everything from [Quick start](#quick-start): Node 20+, `npm install`, and a `.env` with an
  RPC URL for the chain you want (for example `RPC_URL_8453`). The bot indexes through that
  same endpoint, so it spends that account's compute units.
- A Telegram account, in the Telegram app or at web.telegram.org.

### Step 1: Create the bot and get its token

A Telegram bot is an account that a program controls. Telegram has one official bot,
**@BotFather**, whose only job is to make other bots.

1. In Telegram, search for **@BotFather** and open it. Check it has the blue verified tick;
   there are impostors.
2. Send `/newbot`.
3. It asks for a **name** (shown in chats, anything you like) and then a **username**, which
   must be unique across Telegram and must end in `bot` (for example `my_byakugan_bot`).
4. BotFather replies with a **token**: a long string of the form
   `<numbers>:<letters and digits>`. This is the bot's password. Whoever holds it can run
   your bot.

**Treat the token as a secret.** Put it in `.env` and nowhere else: not in the code, not in a
commit, not in a screenshot, not in a chat message. If it leaks, send `/revoke` to
@BotFather to issue a new one. Byakugan scrubs it from its own logs and error output, but it
cannot protect a token you paste somewhere yourself.

### Step 2: Find your own numeric user id

Anyone on Telegram can message your bot once they know its username. The bot therefore
answers **only the user ids you list**, and silently ignores everyone else. That list is the
only access control there is, so you need your own id to be on it.

The id is a plain number (for example `123456789`), not your `@username`; usernames are
rejected. One way to get it is to message **@userinfobot** in Telegram, which replies with
your id. (That bot is a third-party service and not part of this project. Your user id is
not a secret.)

### Step 3: Fill in `.env`

Add these two lines to the `.env` you created in the quick start:

```
TELEGRAM_BOT_TOKEN=<the token from BotFather, in place of this text>
TELEGRAM_ALLOWED_USER_IDS=123456789
```

For more than one person, comma separate: `TELEGRAM_ALLOWED_USER_IDS=123456789,987654321`.

**The allowlist is required.** If `TELEGRAM_ALLOWED_USER_IDS` is empty, or contains something
that is not a number, the bot **refuses to start** and says why. It does not guess, because an
empty list could mean "nobody" (a bot that looks dead) or "everybody" (a private bot that is
not private), and the two are indistinguishable until someone is harmed by the wrong guess.

### Step 4: Create the database

```bash
npm run migrate
```

This creates `./data/byakugan.db` (or wherever `DB_PATH` points) and its tables. The bot also
applies any pending migrations when it starts, but running this once yourself means a
problem with the database shows up now, with nothing else in play.

### Step 5: Start the bot

```bash
npm run bot
```

It prints `byakugan bot starting, pid <number>` and then stays running; leave this terminal
open. Stop it with Ctrl+C. If it exits straight away, read the last line it printed: a missing
token, an empty allowlist, or a token Telegram rejected each says so by name.

Run **one** copy only. See [Single instance](#single-instance).

### Step 6: Open the chat and send `/start`

In Telegram, search for the **username** you gave BotFather, open it and press **Start** (or
send `/start`). A bot cannot open a conversation with you; the chat has to exist first, and
this creates it. The bot replies `Ready. /help for commands.`

If you get **no reply at all**, the cause is almost always that your user id is not in
`TELEGRAM_ALLOWED_USER_IDS`: the bot drops messages from anyone not on the list without
answering, and writes a line to the terminal naming the id it dropped. Compare that id with
your list, fix `.env`, and restart the bot. (The allowlist is read at startup, so editing
`.env` while it runs changes nothing.)

### Step 7: Index a collection

Indexing reads a collection's whole transfer history from the chain into your database. The
queries in step 8 read only that database, so nothing can be answered for a collection that
has not been indexed.

Always preview first. This costs almost nothing and starts no job:

```
/index 0xec04bedeec2f23307bba10468822d5b76a4284f5 --chain 8453 --dry-run
```

It replies with the deploy block, how many blocks must be read, and an **estimate** of how
long that will take. Then start it for real:

```
/index 0xec04bedeec2f23307bba10468822d5b76a4284f5 --chain 8453
```

- If the estimate is over five minutes, the bot does **not** start. It replies with the
  estimate and the same command with `--yes` on the end. Send that to confirm. This is
  deliberate: a started job cannot be cancelled and holds that collection's lock until it
  finishes.
- Once started, the bot posts a progress message and edits it as blocks complete. When it
  finishes it edits the message to the result.
- To try it on a bounded range first, add `--to-block <number>`.
- Leaving out `--chain` uses `DEFAULT_CHAIN_ID` from `.env`.

**The enrichment level is fixed the first time a collection is indexed.** The default is
`full`, which can answer every question and costs the most. `--mints-only` is cheaper and
answers `/firstminters` but not `/overlap`; `--logs-only` is cheapest and answers neither of
those. See [Enrichment levels](#enrichment-levels) for what each means and costs. Re-indexing
at a different level is refused, so choose before the first run.

An interrupted run costs nothing: send the same `/index` again and it resumes from where it
stopped. If the bot was restarted mid-job, `/index` may reply that a previous run left a lock;
the lock expires by itself after 15 minutes, and `/status` shows how long is left.

### Step 8: Ask a question

```
/firstminters 0xec04bedeec2f23307bba10468822d5b76a4284f5 --chain 8453
```

This is the wallets that minted earliest, one row per **acting** wallet, with how many
recipients each minted to. Use `/status` to see whether the collection is finished first; a
query answered while a job is still running says so and covers only the blocks indexed so
far.

### Commands

| command | what it does |
|---|---|
| `/index 0x… [--chain N] [--mints-only] [--logs-only] [--to-block N] [--deploy-block N] [--dry-run] [--yes]` | Index a collection. `--dry-run` only reports the estimate. `--yes` confirms a long run. `--deploy-block` supplies the deploy block when the bot says it cannot resolve it. `--level <level>` also works in place of the two shorthands; give one level option at most. |
| `/status` | List every indexed collection (up to 20, with the total), and any job running. |
| `/status 0x… [--chain N]` | One collection: its level, deploy block, how far it has been indexed, row counts by kind, and whether a job is running or a lock is left behind. |
| `/firstminters 0x… [--chain N] [--limit N]` | Earliest minting wallets. `--limit` defaults to 20. Needs level `mints_only` or `full`. |
| `/firstrecipients 0x… [--chain N] [--limit N]` | Addresses that received the first mints. Works at every level. |
| `/overlap 0x… 0x… [0x…] [--chain N] [--min N]` | Wallets that acquired in at least `--min` (default 2) of the listed collections. Needs at least two addresses, all at level `full`. |
| `/help` | The command list. |
| `/start` | Replies `Ready.` and opens the chat. |

Addresses may be checksummed or lowercase; they are normalised. A query for a collection
that has never been indexed says **not indexed** and offers the `/index` command. That is a
different answer from an empty result, and the bot keeps them apart. A query the index cannot
answer completely, such as `/overlap` on a collection indexed at `mints_only`, is refused
with the command that fixes it, rather than answered approximately.

**Long answers arrive as a CSV file.** Output over 3,500 characters (Telegram's limit is
4,096; the bot stays well under it) is sent as a `.csv` document instead of a message. Text
that comes from the chain, such as a collection's name, is cleaned of control and bidi
characters before it is shown, and spreadsheet-formula prefixes in the CSV are neutralised.

### Exit codes

For a process supervisor (systemd, pm2, Docker) deciding whether to restart the bot.

| code | meaning | what to do |
|---|---|---|
| 0 | clean stop | — |
| 1 | internal defect | report it |
| 2 | bad configuration, including a missing token, an empty allowlist, or a token Telegram rejected | fix `.env`; restarting will not help |
| 3 | provider or chain unavailable | retry later |
| 4 | another instance took over polling | find and stop the other process before restarting |
| 5 | local database state needs attention | look at the migrations |

### Single instance

Run exactly one bot per token. Telegram gives updates to whichever process polled most
recently and ends the other's request with a 409 conflict, so a second copy does not split the
work: it displaces the first. The displaced process exits with code 4 and its in-flight
`/index` jobs die with it. If you restart a supervised process that exited 4 without finding
the other one, the two will displace each other in turn. Each start prints its pid, which is
how to tell afterwards.

### Known limitations of the bot

- **No job queue.** Two concurrent jobs share the account-wide compute-unit budget and both
  run slower.
- **No persistence of jobs across a restart.** A restart loses the running job and its
  progress message goes stale. The rows already written are kept, and the same `/index`
  resumes from the watermark. Until the lock expires, `/index` reports the leftover lock.
- **No `/cancel`.** A started job runs to completion or failure. The confirmation gate on long
  runs is the only protection against starting the wrong one.
- **One instance, enforced by exiting on a 409**, not by coordination. See above.
- **Group chats are untested.** The allowlist is per user, so in a group an allowed user
  could drive the bot while everyone in the group reads the answers.
- **Time and compute-unit estimates are estimates.** They rest on published prices and one
  approximation that nobody has measured; see the Milestone 2 report. The bot says
  "estimated" and nothing stronger.
- **A failed progress-message edit never stops an index.** The edit is cosmetic and the
  indexing is the expensive part, so a rejected edit is logged and the job continues. The
  consequence is that a stale progress message does not mean a stalled job; check `/status`.

The milestone report, with the measured and unmeasured claims set out separately, is
[`docs/superpowers/reports/2026-10-03-milestone-2-report.md`](docs/superpowers/reports/2026-10-03-milestone-2-report.md).

## Querying from code

The bot is a front end for these functions, which you can also call directly from a script:

```ts
import { openDb } from './src/db/connection.js';
import { firstMinters, firstRecipients, overlap } from './src/db/repositories/analytics.js';

const db = openDb('./data/byakugan.db');

// Who minted earliest — one row per ACTING wallet, not per recipient.
firstMinters(db, { chainId: 8453, contract: '0xec04…', limit: 10 });
// → [{ minter, firstRecipient, recipients, minted, mintedToOthers, blockNumber, … }]

// Which addresses received the first mints. Works at any level.
firstRecipients(db, { chainId: 8453, contract: '0xec04…', limit: 10 });

// Wallets that acquired across several collections. Needs `full`.
overlap(db, { chainId: 8453, contracts: ['0xec04…', '0xd77b…'], minCollections: 2 });
```

Addresses must be lowercase here — these functions reject a checksummed one rather than
silently matching nothing. (The bot lowercases for you.)

`firstMinters` groups by the acting wallet and reports `recipients`, `minted` and
`mintedToOthers`, so a bot minting to many fresh addresses shows up as one wallet with
many recipients instead of as many unrelated minters.

---

## Layout

```
src/chain/      RPC: clients, rate limiting, ERC-165 detection, deploy blocks,
                transaction enrichment, and the per-window fetch-strategy decision
src/indexer/    logs → decode → classify → backfill orchestration → level upgrades
src/db/         connection, migrations, repositories (collections, transfers,
                enrichment, analytics)
src/cli/        argument parsing, exit codes, progress, cost estimation
src/bot/        the Telegram bot: commands, allowlist, job registry, progress, rendering
src/telegram/   classification of Telegram API failures
db/migrations/  .sql, applied in order, immutable once applied
config/         chains.json
scripts/        operational probes; each imports the output scrubber FIRST
test/           unit, plus integration suites that skip without their prerequisites
```

Two things in here are load-bearing and easy to undo by accident:

- **`src/outputScrubbing.ts`** wraps `stdout`/`stderr` and catches uncaught errors, so an
  RPC URL — which carries your API key — cannot reach output from any print site, error
  message, or stack trace. It installs as an import side effect and must be imported
  first. It exists because a key once reached a transcript and had to be rotated.
- **Applied migrations are immutable.** The runner stores a SHA-256 of each file; a
  changed or missing one is a hard failure. Add a new migration instead of editing one.

## Tests

```bash
npm test          # everything
npm run typecheck
```

**Run routine tests with `BYAKUGAN_NO_DOTENV=1`.** `test/setup.ts` loads `.env` on purpose, so
that the real-provider smoke suite can run. The consequence is that a plain `npm test` or
`npx vitest run` makes real calls to your RPC endpoint and **spends your compute units**.
That is wanted when you are checking the provider; it is not wanted every time you change a
bot message. During Milestone 2 it was being spent incidentally, well over a dozen full
runs, before this was noticed. Set the variable for everyday runs and run the credentialed suite
deliberately:

```bash
BYAKUGAN_NO_DOTENV=1 npm test     # no credentials loaded; the smoke suite skips itself
npm test                          # loads .env; spends real quota
```

In PowerShell the first is `$env:BYAKUGAN_NO_DOTENV=1; npm test`.

Four suites need things not everyone has (three anvil suites and the smoke suite), and
**skip with a printed reason** rather than failing:

| suite | needs | what only it can cover |
|---|---|---|
| `*.anvil.test.ts` | Foundry (`anvil`, `forge`) pinned 1.5.1 | exact block composition — 20 transactions in one block, which no contract and no public testnet can arrange |
| `smoke.provider.test.ts` | `RPC_URL_8453` | a real range cap, a real credential in the URL, a real rate limit |

```bash
npm run build:fixtures       # forge build, for the anvil suites
```

A test that pins a concurrency, security, idempotency or atomicity property is expected
to be **mutation-verified** — run against the wrong implementation to confirm it fails.
See [CLAUDE.md](CLAUDE.md), which records why: several tests here once passed against the
bug they were written to catch.

---

## Known limitations

Every one of these is pinned by a test, so they are choices rather than surprises.

**Classification**

- A sale paid in WETH or any other ERC-20 carries `tx.value == 0` and classifies as
  `transfer`, not `buy`. Only native-value sales are detected.
- A purchase routed through a contract, where `tx.from` is the router rather than the
  recipient, classifies as `transfer`.
- `burn` detects the zero address only. A transfer to `0x…dEaD` is a burn in practice and
  is recorded as `transfer`.

**Deploy-block resolution**

- The binary search assumes code presence is monotonic — that a contract, once deployed,
  keeps its code. A `SELFDESTRUCT` and redeploy would break that assumption.
- **The Etherscan lookup does not work on Base.** Measured: *"Free API access is not
  supported for this chain."* Base falls entirely to the archive-guarded binary search,
  which is slower but does not need a key.
- Arbitrum pre-Nitro state (below block 22207817) is not served, so a deploy block there
  is recorded as *unvalidated* rather than wrong — the answer is unchecked, not false.

**Storage**

- `token_id`, `amount` and `tx_value_wei` are TEXT, because a uint256 exceeds
  `Number.MAX_SAFE_INTEGER`. They therefore sort **lexicographically**: `'10'` before
  `'9'`. Any `ORDER BY` or range comparison on them must zero-pad or `CAST`.
- Deleting a row from `collections` cascades to its transfers. An unscoped
  `DELETE FROM collections` destroys transfer history.

**Estimation and limits**

- **The compute-unit prices are Alchemy's published figures and have not been confirmed
  against a dashboard reading.** They live in one file,
  [`src/chain/cuCosts.ts`](src/chain/cuCosts.ts), with a `VERIFIED` flag; `--dry-run`
  prints the caveat while it is false. The only one cross-checked by arithmetic is
  `eth_getLogs` at 60 CU, which gives the 5 calls/second this project plans around. A
  method absent from that table is charged the most expensive known price, so a gap makes
  a run slower rather than rate-limited.
- Setting `CU_PER_GETLOGS`, `CU_PER_GETTRANSACTION` and `CU_PER_GETBLOCK` makes
  `--dry-run` print cost columns; leaving them unset prints "not computed" rather than a
  guess, and enrichment then takes the per-tx path, which cannot over-fetch.
- **The bot's time estimate also divides by a number nobody has measured**: 50, the assumed
  speed-up of `alchemy_getAssetTransfers` over `eth_getLogs`. See the Milestone 2 report.
- `COMPUTE_UNITS_PER_SECOND` overrides the 300 CU/s free-tier ceiling if you are on a
  paid tier.

**Coverage**

- The rate limiter's backoff and recovery are covered by unit tests against an injected
  clock. A bounded smoke run does not trigger a real 429, and none is manufactured
  against a live provider, so that path is unexercised against a real endpoint.

## Exit codes

For scripting. The distinction that matters is user error versus infrastructure: the
first needs a human, the second wants a retry.

| code | meaning | what to do |
|---|---|---|
| 0 | success | — |
| 1 | internal defect | report it |
| 2 | bad command or configuration | fix the input |
| 3 | provider or chain unavailable | retry later |
| 4 | another job holds the collection lock | retry later |
| 5 | local database state needs attention | look at the migrations |

```bash
npm run index -- --help
```

## Stack

TypeScript (strict, ESM, NodeNext) · [viem](https://viem.sh) (public client only) ·
better-sqlite3 · zod · pino · vitest · Foundry for fixtures · [grammY](https://grammy.dev).
