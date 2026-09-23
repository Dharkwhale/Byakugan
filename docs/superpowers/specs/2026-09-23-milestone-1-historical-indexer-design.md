# Milestone 1 — Historical Indexer

Date: 2026-09-23
Status: approved in brainstorming, pending implementation plan

## Purpose

Given a contract address on any configured EVM chain, build a complete,
resumable, idempotent local index of its NFT transfers, with each transfer
classified as `mint`, `buy`, `transfer`, or `burn`.

Milestone 1 ships no Telegram bot. Its entrypoint is a CLI; the backfill is a
plain async function that Milestone 2's bot will call unchanged.

## Non-goals

Explicitly out of scope, per the project scope bar:

- transaction signing, private keys, wallets holding funds
- minting, listing, buying, selling, copy trading
- marketplace adapters
- live/head tracking (Milestone 3)
- analysis queries and Telegram commands (Milestone 2)

No private key may exist anywhere in this repo or its config.

## Decisions taken during brainstorming

Two documented decisions in CLAUDE.md were changed deliberately, not silently:

1. **Single `RPC_URL` / `CHAIN_ID` replaced by per-chain env vars.** The project
   targets all EVM mainnets (Ethereum, Arbitrum, Base, and others), which a
   single pair cannot express.
2. **`transfers` primary key gains `batch_index`.** The documented PK
   `(chain_id, tx_hash, log_index)` is not unique for ERC-1155 `TransferBatch`,
   which emits one log carrying `ids[]` and `values[]`. Under the original key,
   `INSERT OR IGNORE` would keep the first token of a batch and drop the rest,
   undercounting batch mints and corrupting `firstMinters` in Milestone 2.

A third reading was ambiguous and is resolved here: migration `.sql` files live
at repo-root `db/migrations/`, while `src/db/` holds the connection, the
migration runner, and repositories. The runner resolves the migrations directory
by walking up for `package.json` (cached), never from `__dirname`, which moves
between `src/` and `dist/`. `MIGRATIONS_DIR` overrides it for tests.

Multi-chain support is **configuration only**. There are no per-chain adapters,
strategy objects, or interfaces; everything that varies by chain is a number or
string in `config/chains.json`.

## Configuration

`src/config.ts` is the only module that reads `process.env`. Zod validates at
startup and fails loudly with the offending field names.

```
# .env  (never committed)
RPC_URL_1=https://eth-mainnet.example/v2/KEY
RPC_URL_8453=https://base-mainnet.example/v2/KEY
RPC_URL_42161=https://arb-mainnet.example/v2/KEY
DEFAULT_CHAIN_ID=1
ETHERSCAN_API_KEY=            # optional; enables deploy-block fallback
DB_PATH=./data/byakugan.db
TELEGRAM_BOT_TOKEN=           # parsed but unused in M1
TELEGRAM_ALLOWED_USER_IDS=    # parsed but unused in M1
```

Zod discovers every `RPC_URL_<chainId>` key and builds a validated
`Map<number, string>`. An empty map is a startup error.

`config/chains.json` is committed and contains no secrets:

```json
{
  "1": {
    "name": "ethereum",
    "initialChunk": 2000,
    "maxChunk": 10000,
    "requestsPerSecond": 25,
    "confirmations": 12,
    "blockFetchThreshold": 3,
    "archiveProbe": { "address": "<long-lived contract>", "block": 4719569 }
  }
}
```

The `archiveProbe` address and block are filled in per chain at implementation
time and each verified against that chain before being committed; they are not
carried over from another chain or guessed.

A chain listed in `chains.json` with no matching env var is unavailable rather
than an error, so the file can ship with more chains than any one deployment
configures.

## Data model

Addresses are stored lowercase everywhere. All inserts are idempotent.

```sql
CREATE TABLE collections (
  chain_id            INTEGER NOT NULL,
  contract            TEXT    NOT NULL,
  standard            TEXT    CHECK (standard IN ('721','1155')),
  name                TEXT,
  deploy_block        INTEGER,
  deploy_block_source TEXT    CHECK (deploy_block_source IN
                                     ('override','explorer','binary_search')),
  last_indexed_block  INTEGER,
  indexed_at          TEXT,
  locked_by           TEXT,
  locked_at           TEXT,
  PRIMARY KEY (chain_id, contract)
);

CREATE TABLE transfers (
  chain_id     INTEGER NOT NULL,
  contract     TEXT    NOT NULL,
  token_id     TEXT    NOT NULL,
  amount       TEXT    NOT NULL DEFAULT '1',
  from_addr    TEXT    NOT NULL,
  to_addr      TEXT    NOT NULL,
  tx_hash      TEXT    NOT NULL,
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  batch_index  INTEGER NOT NULL DEFAULT 0,
  tx_from      TEXT    NOT NULL,
  tx_value_wei TEXT    NOT NULL,
  kind         TEXT    NOT NULL
                 CHECK (kind IN ('mint','buy','transfer','burn')),
  PRIMARY KEY (chain_id, tx_hash, log_index, batch_index)
);

CREATE INDEX transfers_contract_kind_pos
  ON transfers (contract, kind, block_number, log_index);
CREATE INDEX transfers_to_addr ON transfers (to_addr);
```

`batch_index` is `0` for ERC-721 and ERC-1155 `TransferSingle`, and the array
position for `TransferBatch`. `token_id`, `amount`, and `tx_value_wei` are TEXT
because they are `uint256` and exceed JavaScript's safe integer range.

`standard`, `deploy_block`, `deploy_block_source`, and `last_indexed_block` are
nullable, which the locking design requires: a job must be able to claim a
collection *before* bootstrap has determined those values. A row with
`standard IS NULL` means "claimed, not yet bootstrapped". Every read path treats
such a row as un-indexed.

SQLite runs in WAL mode with a `busy_timeout`.

## Module layout

Each module has one job and is testable without the others.

| Module | Responsibility | Depends on |
|---|---|---|
| `src/config.ts` | zod-validated env + `chains.json` | — |
| `src/errors.ts` | typed error classes | — |
| `src/chain/client.ts` | memoized viem public client per chain, retry, rate limit | config |
| `src/chain/standard.ts` | ERC-165 detection | client |
| `src/chain/deployBlock.ts` | override → explorer → guarded binary search | client, config |
| `src/chain/tx.ts` | `hashes[] → Map<hash, {from, value}>` | client |
| `src/indexer/logs.ts` | adaptive chunked `getLogs`, async generator | client |
| `src/indexer/decode.ts` | raw log → `DecodedTransfer[]` (pure) | — |
| `src/indexer/classify.ts` | transfer + tx → `kind` (pure) | — |
| `src/indexer/backfill.ts` | orchestration, locking, persistence | all |
| `src/db/*` | connection, migration runner, repositories | — |
| `src/cli/index.ts` | arg parsing → `backfill()` | backfill, config |

`decode.ts` and `classify.ts` are pure functions over plain data, which is what
makes fixture-driven unit tests cheap. `logs.ts` yields
`{ fromBlock, toBlock, logs }`, so adaptive-range behaviour is testable against
a mocked provider with no indexing involved.

## Pipeline

### Reorg safety

`safeHead = head - confirmations[chainId]`, with `confirmations` per chain in
`chains.json`. That is the backfill target; `last_indexed_block` never advances
past it. If `last_indexed_block >= safeHead` the job is a no-op and logs so.

`safeHead` goes stale during a long backfill. When the loop reaches the target
it recomputes the head and continues if it moved, bounded by
`maxHeadExtensions` (default 3) so a fast L2 cannot be chased indefinitely. The
bound is logged when reached.

### Concurrency guard

Two backfills on the same collection must not run concurrently; Milestone 2
runs these as background jobs, so this is a live risk rather than a theoretical
one.

A job claims the collection before starting — including before bootstrap, since
two concurrent first-runs on a never-seen collection would otherwise both detect
the standard and both binary-search the deploy block. The claim is therefore a
single atomic upsert rather than an `UPDATE`, because on a first run there is no
row to update yet:

```sql
INSERT INTO collections (chain_id, contract, locked_by, locked_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (chain_id, contract) DO UPDATE
   SET locked_by = excluded.locked_by,
       locked_at = excluded.locked_at
 WHERE collections.locked_by IS NULL
    OR collections.locked_at < ?                -- stale cutoff
```

`changes === 1` means the lock was acquired; `0` means another job holds it and
this one exits with a clear error. `locked_by` is a job identity (uuid, pid,
hostname). The lock is refreshed on each chunk commit, so the stale cutoff
(default 5 minutes) only expires locks whose owner actually died. Release
happens in a `finally`, so a thrown job does not leave the collection wedged.

### Bootstrap

Runs after the lock is held and after `safeHead` has been computed, since the
deploy-block search bounds itself by `safeHead`.

1. Validate and lowercase the address.
2. ERC-165 `supportsInterface`: `0x80ac58cd` → 721, `0xd9b67a26` → 1155.
   Anything matching neither is rejected. A contract answering `true` to both is
   treated as invalid rather than guessed at. `--standard` overrides for
   pre-ERC-165 collections.
3. Resolve the deploy block (below).
4. Insert the collection row with `last_indexed_block = deploy_block - 1`.

Bootstrap runs once per collection and is persisted, so resumes never repeat it.

### Deploy block resolution

`getCode` at historical blocks requires archive state. Most non-archive RPCs
prune it and return empty rather than erroring, which makes a naive binary
search converge on the pruning horizon and silently report a wrong deploy
block. Resolution therefore runs in precedence order:

1. **Explicit override** — `--deploy-block`, or a per-collection entry in
   config. Recorded as `deploy_block_source = 'override'`.
2. **Explorer API** — Etherscan V2 is a single multichain endpoint taking a
   `chainid` parameter, so `getcontractcreation` needs one `ETHERSCAN_API_KEY`
   rather than a per-chain integration. Source `'explorer'`.
3. **Binary search, only if the archive probe passes.** Source
   `'binary_search'`.
4. **Otherwise throw** `DeployBlockUnavailableError`, naming both escape
   hatches.

The archive probe must distinguish "empty because pruned" from "empty because
not yet deployed", which a call at an arbitrary old block cannot. Each chain in
`chains.json` therefore carries `archiveProbe: { address, block }` — a contract
known to have existed since early in that chain's life. If
`getCode(address, block)` returns empty, the node is pruned and binary search is
disabled for that chain.

The search itself is the standard bisect for the lowest block with non-empty
code, `lo = 0`, `hi = safeHead`, erroring early if code at `safeHead` is empty.
That is roughly 25 calls on Ethereum mainnet.

### Adaptive chunking

```
range = initialChunk                            // from chains.json
on success:    range = min(range * 1.25, maxChunk)
on range error: range = max(floor(range / 2), 1)
```

A single exported `isRangeError(err)` predicate owns all provider-message
matching (`"more than 10000 results"`, `"block range is too wide"`,
response-size errors, the `-32005` / `-32602` variants), so supporting a new
provider means editing one function.

Two hard caps prevent unbounded looping: a maximum number of consecutive
halvings per chunk, and failure at `range === 1` throws `RangeExhaustedError`
rather than spinning.

### Decoding

- ERC-721 `Transfer(address,address,uint256)` — indexed `tokenId`
- ERC-1155 `TransferSingle(address,address,address,uint256,uint256)`
- ERC-1155 `TransferBatch(address,address,address,uint256[],uint256[])` — one
  log to N rows, `batch_index` carrying the array position

Only the standard declared on the collection is decoded, so an ERC-721 contract
emitting an unrelated same-signature event is not mis-ingested.

### Tx enrichment

After decoding a chunk, needed tx hashes are grouped by block. Per block, with
`u` = count of distinct hashes needed in that block:

```
u >= blockFetchThreshold  → getBlock({ includeTransactions: true }),
                            cache every tx it returns
u <  blockFetchThreshold  → add hashes to the per-tx pool
```

The pool is drained with concurrent `getTransaction` calls; viem's HTTP
transport runs with `batch: { batchSize, wait }`, so those coalesce into
JSON-RPC batch requests without manual chunking.

`blockFetchThreshold` defaults to **3**, per chain. A block fetch is one round
trip but downloads every transaction in the block — on mainnet roughly 150 txs
of payload to extract perhaps one. At `u = 1` or `2` that trade is clearly bad;
at `u >= 3` saved round trips start to dominate, and during a hot mint window
`u` is frequently 20 or more.

Two lookups precede any fetch:

- a per-chunk `Map` cache (a tx cannot span chunks, so clearing it per chunk
  keeps memory bounded regardless of collection size)
- `SELECT DISTINCT tx_hash, tx_from, tx_value_wei FROM transfers WHERE
  chain_id = ? AND tx_hash IN (…)`, so resumed or overlapping backfills re-pay
  nothing

The `IN` list is split by a `chunkedIn` helper at 500 bound variables, well
under SQLite's limit, and the results unioned.

### Classification

Applied in order, so a paid mint stays `mint`:

1. `from == 0x0` → `mint`
2. `to == 0x0` → `burn`
3. `tx.value > 0 && tx.from == to_addr` → `buy`
4. otherwise → `transfer`

### Persistence

Per chunk, one `better-sqlite3` transaction performs the `INSERT OR IGNORE` of
all rows, the `last_indexed_block` update, and the lock heartbeat together. The
watermark cannot outrun the data, so a crash costs at most the current chunk and
a rerun inserts zero rows.

## Entrypoint

```
npm run index -- --chain 1 --contract 0x… [--deploy-block N] [--standard 721]
```

`--chain` falls back to `DEFAULT_CHAIN_ID` when omitted, and errors if neither is
set. A thin wrapper over `backfill()`, with progress to pino. `backfill()` takes an
`onProgress` callback, which Milestone 2's bot uses to drive its edited-in-place
progress message.

## Errors

Typed classes in `src/errors.ts`: `ConfigError`, `UnsupportedStandardError`,
`DeployBlockUnavailableError`, `RangeExhaustedError`, `CollectionLockedError`.
Milestone 2's bot maps these to readable Telegram replies instead of stack
traces.

Transient RPC failures exhaust viem's capped retries, then fail the chunk and
the job, leaving the watermark untouched so a rerun resumes cleanly.

## Security

- `.env`, `data/`, `dist/` gitignored before the first commit; `.env.example`
  ships with placeholders only.
- **Pino redacts RPC URLs and the explorer key.** Endpoints carry API keys in
  the path, so an unredacted error log leaks credentials.
- A test asserts the config schema contains no private-key field, so a later
  milestone cannot quietly introduce one.
- No secret is ever logged or committed.

## Testing

### Unit

Required by the milestone:

- decode fixtures: 721, 1155 single, 1155 batch (asserting `batch_index`
  sequencing)
- chunker halves and grows correctly against mocked provider errors
- classifier covers every branch
- deploy-block binary search against a mocked `getCode`

Added by the design gaps above:

- `isRangeError` as a table test over real provider message strings
- archive-probe failure path, override path, explorer path
- `chunkedIn` boundaries: 0, 1, 500, 501, 1000
- config zod: `RPC_URL_<id>` discovery, malformed URL, empty map
- address validation and lowercasing
- `maxHeadExtensions` bound
- lock contention: a second claim against a held lock fails; a claim against a
  stale lock succeeds; two claims on a collection with no row yet resolve to
  exactly one winner
- migration runner resolves the repo root correctly

Fixtures are real logs and txs captured to `test/fixtures/` by a small committed
script, so unit tests are offline and deterministic.

### Integration

Skipped unless RPC env is configured.

- Index the chosen collection. `totalSupply()` is ERC-721 **Enumerable**
  (`0x780e9d63`), not base ERC-721, so support is detected first: when present,
  assert `mints - burns == totalSupply()`; when absent, assert against a
  hardcoded expected mint count for that collection.
- First mint tx hash equals a hardcoded value verified on a block explorer.
- Re-running the backfill leaves the row count unchanged.
- **Interrupt and resume**, driven by deterministic fault injection: `backfill()`
  accepts an `afterChunkCommit` hook, and the test throws from it after chunk N.
  Process killing would be flaky and eventually deleted. The test then resumes
  and asserts both the watermark and zero duplicates.

The test collection is chosen once RPC keys are present: a small, non-burnable,
fully minted ERC-721, preferably on Base or Arbitrum so the backfill is fast.
Its deploy block, first-mint tx hash, and supply are printed with explorer links
for confirmation before anything is hardcoded.

## Known limitations

Recorded in the README, not left implicit:

- ERC-20 / WETH-paid sales classify as `transfer`. Acknowledged in the project
  spec; fixed when a sale decoder lands.
- `burn` detects `0x0` only, not `0x…dEaD` and other burn sinks.
- `buy` misses purchases where `tx.from != to_addr` — routers, or a token bought
  for another wallet.
- Reorgs are handled by confirmation lag only. Already-indexed rows are never
  rewritten.
- `mints - burns == totalSupply()` holds only for collections implementing
  ERC-721 Enumerable; others fall back to a hardcoded expected count.
- Pre-ERC-165 collections (CryptoPunks and other early ERC-721s) are rejected
  unless `--standard` is passed.
- **The deploy-block binary search assumes code presence is monotonic in block
  height.** That breaks for self-destructed contracts and for CREATE2 addresses
  that were destroyed and redeployed, where code can be present, absent, and
  present again. For those, use `--deploy-block` or the explorer fallback.

## Acceptance

Milestone 1 is done when `npm test` and `npm run typecheck` both pass, every
test above is green, and the limitations are written into the README. Work stops
there for confirmation before Milestone 2 begins.
