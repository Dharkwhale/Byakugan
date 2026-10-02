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

Milestone 1 (the historical indexer) is complete. The Telegram bot is Milestone 2 — see
[Querying, today](#querying-today).

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

## Querying, today

**The Telegram bot is Milestone 2 and does not exist yet.** There is no `/firstminters`
command to run. What exists is the indexer and the query functions it fills, so today you
query the database directly:

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

Addresses must be lowercase — these functions reject a checksummed one rather than
silently matching nothing.

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

Two integration suites need things not everyone has, and **skip with a printed reason**
rather than failing:

| suite | needs | what only it can cover |
|---|---|---|
| `*.anvil.test.ts` | Foundry (`anvil`, `forge`) pinned 1.5.1 | exact block composition — 20 transactions in one block, which no contract and no public testnet can arrange |
| `smoke.provider.test.ts` | `RPC_URL_8453` | a real range cap, a real credential in the URL, a real rate limit |

```bash
npm run build:fixtures       # forge build, for the anvil suites
BYAKUGAN_NO_DOTENV=1 npm test # simulate a machine with no credentials
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
better-sqlite3 · zod · pino · vitest · Foundry for fixtures · grammY, from Milestone 2.
