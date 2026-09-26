# Milestone 1 — Historical Indexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a contract address on any configured EVM chain, build a complete, resumable, idempotent local index of its NFT transfers, each classified as `mint`, `buy`, `transfer`, or `burn`.

**Architecture:** A streaming chunk pipeline. Per chunk: adaptive `getLogs` → pure decode → tx enrichment (block-fetch when a block has ≥3 needed txs, else batched per-tx) → pure classify → one SQLite transaction that inserts rows, advances the watermark, and refreshes the job lock together. Multi-chain is configuration only — no per-chain adapters. Reorg safety is a confirmation lag, never indexing to head.

**Tech Stack:** TypeScript (`strict: true`, ESM, NodeNext), Node 20+ (dev machine is v24.8.0), viem (public client only), better-sqlite3, zod, pino, vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-09-23-milestone-1-historical-indexer-design.md`

## Global Constraints

- **No private keys anywhere in this repo or its config.** No signing, minting, buying, selling, or marketplace code. Read-only chain access only.
- `strict: true` in tsconfig. No `any` in committed code; use `unknown` plus narrowing.
- All addresses stored **lowercase**. All inserts idempotent (`INSERT OR IGNORE`).
- `token_id`, `amount`, `tx_value_wei` are **TEXT** in SQLite — they are `uint256` and exceed `Number.MAX_SAFE_INTEGER`. Convert via `bigint`, never `Number()`.
- `PRAGMA foreign_keys = ON` belongs in the connection factory, never a migration: SQLite defaults it OFF per connection.
- Timestamps are INTEGER epoch ms from the injected `Clock`. SQLite's `datetime()`/`unixepoch()` are used nowhere.
- Migration `.sql` files live at repo-root `db/migrations/`. `src/db/` holds connection, runner, repositories. The runner resolves the repo root by walking up for `package.json`, **never** from `__dirname`.
- RPC URLs contain API keys in the path. **Nothing may log an RPC URL or the explorer key unredacted.**
- `npm test` and `npm run typecheck` must both pass before the milestone is called done.
- Commit after every task. Keep the repo local — no remote, no push, until M1 tests pass.
- Never index to head: `safeHead = head - confirmations[chainId]`.
- Every read path filters on `standard IS NOT NULL`.

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | tooling |
| `.env.example` | documented env placeholders, no real values |
| `config/chains.json` | per-chain tuning, committed, no secrets |
| `src/types.ts` | shared domain types |
| `src/errors.ts` | typed error classes |
| `src/config.ts` | zod-validated env + chains.json — the only reader of `process.env` |
| `src/secrets.ts` | token derivation + scrubbing (pure, no deps; shared with scripts) |
| `src/logger.ts` | pino wired to scrub every serialized line |
| `src/clock.ts` | injectable epoch-ms clock (one time source, no SQLite datetime()) |
| `src/jobId.ts` | per-run lock-owner identity |
| `src/db/paths.ts` | repo-root and migrations-dir resolution |
| `src/db/connection.ts` | better-sqlite3 handle, WAL, busy_timeout, foreign_keys ON |
| `src/db/migrate.ts` | migration runner, checksum-verified, one txn per file |
| `db/migrations/001_init.sql` | schema |
| `src/db/chunked.ts` | bound-variable chunking helper |
| `src/db/repositories/collections.ts` | claim, release, cleanup, bootstrap, guarded reads |
| `src/db/repositories/transfers.ts` | idempotent insert, known-tx lookup, counts |
| `src/indexer/decode.ts` | raw log → `DecodedTransfer[]` (pure) |
| `src/indexer/classify.ts` | transfer + tx → `Kind` (pure) |
| `src/chain/rateLimit.ts` | token bucket |
| `src/chain/client.ts` | memoized viem public client per chain |
| `src/indexer/logs.ts` | `isRangeError`, adaptive chunked `getLogs` generator |
| `src/chain/standard.ts` | ERC-165 detection + Enumerable support |
| `src/chain/deployBlock.ts` | override → explorer → guarded binary search |
| `src/chain/tx.ts` | tx enrichment heuristic |
| `src/indexer/backfill.ts` | orchestration, lock lifecycle, persistence |
| `src/cli/index.ts` | arg parsing → `backfill()` |
| `test/fixtures/` | captured real logs and txs |
| `scripts/capture-fixtures.ts` | fixture capture |
| `test/unit/`, `test/integration/` | tests |

---

### Task 1: Project scaffold and configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.env.example`, `config/chains.json`, `src/types.ts`, `src/errors.ts`, `src/config.ts`, `src/chain/probeErrors.ts`, `scripts/verify-archive-probes.ts`, `test/setup.ts`
- Test: `test/unit/config.test.ts`, `test/unit/probeErrors.test.ts`

**Scope added during execution** (recorded so the plan matches what shipped):
`.env` loading was missing entirely — `loadConfig()` defaults to `process.env` and
nothing populated it, so every entrypoint threw `ConfigError`. Fixed with Node's
`--env-file-if-exists` in the npm scripts plus a vitest `setupFiles` hook.
`src/chain/probeErrors.ts` was added here rather than in Task 11 because the
verification gate needs it: a pruned node throws rather than returning empty
bytes, and a transient timeout throws too — conflating them would report a healthy
archive endpoint as non-archive. Task 11 consumes it.

**Interfaces:**
- Consumes: nothing
- Produces: `Standard`, `Kind`, `DecodedTransfer`, `TxInfo`, `TransferRow` (from `src/types.ts`); `ConfigError`, `UnsupportedStandardError`, `DeployBlockUnavailableError`, `RangeExhaustedError`, `CollectionLockedError` (from `src/errors.ts`); `ChainConfig`, `Config`, `loadConfig(env, chainsJson)` (from `src/config.ts`)

- [ ] **Step 1: Initialize the package and install dependencies**

```bash
npm init -y
npm pkg set type=module
npm install viem better-sqlite3 zod pino pino-pretty
npm install -D typescript tsx vitest @types/node @types/better-sqlite3
```

If `better-sqlite3` fails to build (it is a native module), report the error rather than switching libraries — the spec names it. Node v24 has prebuilds available.

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write `vitest.config.ts` and package scripts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
```

```bash
npm pkg set scripts.typecheck="tsc --noEmit"
npm pkg set scripts.build="tsc -p tsconfig.json"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.index="tsx src/cli/index.ts"
npm pkg set scripts.migrate="tsx src/db/migrate.ts"
```

- [ ] **Step 4: Write `.env.example`**

Placeholders only. This file is committed; `.env` is not.

```
# One RPC_URL_<chainId> per chain you want to index.
RPC_URL_1=
RPC_URL_8453=
RPC_URL_42161=

# Used when --chain is omitted.
DEFAULT_CHAIN_ID=1

# Optional. Enables the Etherscan V2 deploy-block fallback (one key, all chains).
ETHERSCAN_API_KEY=

DB_PATH=./data/byakugan.db

# Parsed but unused until Milestone 2.
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=
```

- [ ] **Step 5: Write `config/chains.json`**

`archiveProbe` addresses are long-lived contracts on each chain. Every value below is provisional until Step 12 verifies it with a real `getCode` call — **all three chains, mainnet included**. Do not copy an address between chains, and do not mark this task done on unverified values: a wrong probe block makes the probe fail on a genuine archive node and needlessly disables deploy-block search.

```json
{
  "1": {
    "name": "ethereum",
    "initialChunk": 2000,
    "maxChunk": 10000,
    "requestsPerSecond": 25,
    "confirmations": 12,
    "blockFetchThreshold": 3,
    "archiveProbe": { "address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "block": 4719569 }
  },
  "8453": {
    "name": "base",
    "initialChunk": 5000,
    "maxChunk": 20000,
    "requestsPerSecond": 25,
    "confirmations": 30,
    "blockFetchThreshold": 3,
    "archiveProbe": { "address": "0x4200000000000000000000000000000000000006", "block": 100000 }
  },
  "42161": {
    "name": "arbitrum",
    "initialChunk": 5000,
    "maxChunk": 20000,
    "requestsPerSecond": 25,
    "confirmations": 30,
    "blockFetchThreshold": 3,
    "archiveProbe": { "address": "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", "block": 100000 }
  }
}
```

- [ ] **Step 6: Write `src/types.ts`**

```ts
export type Standard = '721' | '1155';
export type Kind = 'mint' | 'buy' | 'transfer' | 'burn';
export type DeployBlockSource = 'override' | 'explorer' | 'binary_search';

export type Address = `0x${string}`;
export type Hash = `0x${string}`;

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** One token movement. An ERC-1155 TransferBatch decodes to several of these. */
export interface DecodedTransfer {
  tokenId: bigint;
  amount: bigint;
  from: Address;
  to: Address;
  txHash: Hash;
  blockNumber: bigint;
  logIndex: number;
  /** 0 for ERC-721 and TransferSingle; array position for TransferBatch. */
  batchIndex: number;
}

export interface TxInfo {
  from: Address;
  value: bigint;
}

/** A row as stored. Every bigint is already a decimal string. */
export interface TransferRow {
  chainId: number;
  contract: string;
  tokenId: string;
  amount: string;
  fromAddr: string;
  toAddr: string;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  batchIndex: number;
  txFrom: string;
  txValueWei: string;
  kind: Kind;
}
```

- [ ] **Step 7: Write `src/errors.ts`**

```ts
export class ByakuganError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigError extends ByakuganError {}
export class UnsupportedStandardError extends ByakuganError {}
export class DeployBlockUnavailableError extends ByakuganError {}
export class RangeExhaustedError extends ByakuganError {}
export class CollectionLockedError extends ByakuganError {}
```

- [ ] **Step 8: Write the failing config tests**

`test/unit/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ConfigError } from '../../src/errors.js';

const CHAINS = {
  '1': {
    name: 'ethereum', initialChunk: 2000, maxChunk: 10000,
    requestsPerSecond: 25, confirmations: 12, blockFetchThreshold: 3,
    archiveProbe: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', block: 4719569 },
  },
  '8453': {
    name: 'base', initialChunk: 5000, maxChunk: 20000,
    requestsPerSecond: 25, confirmations: 30, blockFetchThreshold: 3,
    archiveProbe: { address: '0x4200000000000000000000000000000000000006', block: 100000 },
  },
};

describe('loadConfig', () => {
  it('discovers every RPC_URL_<chainId> key', () => {
    const cfg = loadConfig(
      { RPC_URL_1: 'https://a.example/k', RPC_URL_8453: 'https://b.example/k', DB_PATH: './x.db' },
      CHAINS,
    );
    expect([...cfg.chains.keys()].sort((a, b) => a - b)).toEqual([1, 8453]);
    expect(cfg.chains.get(1)?.rpcUrl).toBe('https://a.example/k');
    expect(cfg.chains.get(8453)?.confirmations).toBe(30);
  });

  it('throws when no RPC_URL_<chainId> is set', () => {
    expect(() => loadConfig({ DB_PATH: './x.db' }, CHAINS)).toThrow(ConfigError);
  });

  it('throws on a malformed RPC URL', () => {
    expect(() => loadConfig({ RPC_URL_1: 'not-a-url', DB_PATH: './x.db' }, CHAINS))
      .toThrow(ConfigError);
  });

  it('ignores an RPC_URL for a chain absent from chains.json', () => {
    const cfg = loadConfig(
      { RPC_URL_1: 'https://a.example/k', RPC_URL_999: 'https://c.example/k', DB_PATH: './x.db' },
      CHAINS,
    );
    expect(cfg.chains.has(999)).toBe(false);
  });

  it('leaves a chain in chains.json without an env var unavailable, not an error', () => {
    const cfg = loadConfig({ RPC_URL_1: 'https://a.example/k', DB_PATH: './x.db' }, CHAINS);
    expect(cfg.chains.has(8453)).toBe(false);
  });

  it('collects every secret for log scrubbing', () => {
    const cfg = loadConfig(
      { RPC_URL_1: 'https://a.example/SECRETKEY', ETHERSCAN_API_KEY: 'ESKEY', DB_PATH: './x.db' },
      CHAINS,
    );
    expect(cfg.secrets).toContain('https://a.example/SECRETKEY');
    expect(cfg.secrets).toContain('ESKEY');
  });

  // Scope bar: this project must never hold a private key.
  it('has no private-key field in the schema', () => {
    const cfg = loadConfig(
      { RPC_URL_1: 'https://a.example/k', PRIVATE_KEY: '0xdeadbeef', DB_PATH: './x.db' },
      CHAINS,
    );
    expect(JSON.stringify(cfg)).not.toContain('0xdeadbeef');
    expect(Object.keys(cfg)).not.toContain('privateKey');
  });
});
```

- [ ] **Step 9: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — cannot resolve `../../src/config.js`.

- [ ] **Step 10: Write `src/config.ts`**

```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from './errors.js';
import type { Address } from './types.js';

const chainSchema = z.object({
  name: z.string().min(1),
  initialChunk: z.number().int().positive(),
  maxChunk: z.number().int().positive(),
  requestsPerSecond: z.number().positive(),
  confirmations: z.number().int().nonnegative(),
  blockFetchThreshold: z.number().int().positive(),
  archiveProbe: z.object({
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    block: z.number().int().nonnegative(),
  }),
});

export interface ChainConfig extends z.infer<typeof chainSchema> {
  chainId: number;
  rpcUrl: string;
  archiveProbe: { address: Address; block: number };
}

export interface Config {
  chains: Map<number, ChainConfig>;
  defaultChainId: number | undefined;
  dbPath: string;
  etherscanApiKey: string | undefined;
  /** Substrings that must never appear in logs. */
  secrets: string[];
}

const RPC_KEY = /^RPC_URL_(\d+)$/;

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  chainsJson?: unknown,
): Config {
  const raw = chainsJson ?? readChainsFile();
  const parsedChains = z.record(z.string(), chainSchema).safeParse(raw);
  if (!parsedChains.success) {
    throw new ConfigError(`config/chains.json is invalid: ${parsedChains.error.message}`);
  }

  const chains = new Map<number, ChainConfig>();
  const secrets: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    const match = RPC_KEY.exec(key);
    if (!match || !value) continue;
    const chainId = Number(match[1]);
    const entry = parsedChains.data[String(chainId)];
    if (!entry) continue; // configured but unknown chain: ignored, not an error
    if (!isHttpUrl(value)) {
      throw new ConfigError(`${key} is not a valid http(s) URL`);
    }
    chains.set(chainId, {
      ...entry,
      chainId,
      rpcUrl: value,
      archiveProbe: {
        address: entry.archiveProbe.address.toLowerCase() as Address,
        block: entry.archiveProbe.block,
      },
    });
    secrets.push(value);
  }

  if (chains.size === 0) {
    throw new ConfigError(
      'No usable RPC endpoint. Set at least one RPC_URL_<chainId> matching config/chains.json.',
    );
  }

  const etherscanApiKey = env.ETHERSCAN_API_KEY || undefined;
  if (etherscanApiKey) secrets.push(etherscanApiKey);

  const defaultChainId = env.DEFAULT_CHAIN_ID ? Number(env.DEFAULT_CHAIN_ID) : undefined;
  if (defaultChainId !== undefined && !Number.isInteger(defaultChainId)) {
    throw new ConfigError('DEFAULT_CHAIN_ID must be an integer');
  }

  return {
    chains,
    defaultChainId,
    dbPath: env.DB_PATH ?? './data/byakugan.db',
    etherscanApiKey,
    secrets,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function readChainsFile(): unknown {
  try {
    return JSON.parse(readFileSync(new URL('../config/chains.json', import.meta.url), 'utf8'));
  } catch (err) {
    throw new ConfigError(`could not read config/chains.json: ${String(err)}`);
  }
}
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts && npm run typecheck`
Expected: PASS, 7 tests. Typecheck clean.

- [ ] **Step 12: Verify every archiveProbe against its real chain**

This gate blocks the task. Requires RPC URLs in `.env` for all three chains.

`scripts/verify-archive-probes.ts`:

```ts
/** Confirms each chains.json archiveProbe really has code at its block. */
import { createPublicClient, http } from 'viem';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
let failures = 0;

for (const [chainId, chain] of config.chains) {
  const client = createPublicClient({ transport: http(chain.rpcUrl) });
  const { address, block } = chain.archiveProbe;
  try {
    const code = await client.getCode({ address, blockNumber: BigInt(block) });
    const ok = Boolean(code) && code !== '0x';
    process.stdout.write(
      `${ok ? 'PASS' : 'FAIL'}  chain ${chainId} (${chain.name})  ${address} @ ${block}\n`,
    );
    if (!ok) failures += 1;
  } catch (err) {
    process.stdout.write(
      `FAIL  chain ${chainId} (${chain.name})  ${address} @ ${block}  ` +
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    failures += 1;
  }
}

process.exitCode = failures > 0 ? 1 : 0;
```

Run: `npx tsx scripts/verify-archive-probes.ts`
Expected: `PASS` for every configured chain, exit code 0.

A `FAIL` means either the probe block predates that contract's deployment (fix the block in `chains.json` and re-run) or the RPC is not an archive node (a real finding — report it, since deploy-block search will be unavailable on that chain). **Do not proceed to Task 2 until every configured chain prints PASS, and report any chain that could not be checked at all.**

- [ ] **Step 13: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example config/ src/ test/ scripts/
git commit -m "feat: project scaffold, shared types, typed errors, and zod config

Multi-chain via per-chain RPC_URL_<chainId> discovery. A chain in
chains.json without an env var is unavailable rather than an error.
Config collects every secret substring so the logger can scrub them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Secret scrubbing and the logger

**Files:**
- Create: `src/secrets.ts`, `src/logger.ts`
- Modify: `scripts/verify-archive-probes.ts` — delete its local `scrub()`/`scrubUnknown()` and import the shared ones
- Test: `test/unit/secrets.test.ts`, `test/unit/logger.test.ts`

**Interfaces:**
- Consumes: `Config.secrets` (Task 1)
- Produces, from `src/secrets.ts` (pure, no dependencies — which is why it is separate from `logger.ts`, so scripts can scrub without pulling in pino):
  - `deriveSecretTokens(rawSecrets: string[]): string[]`
  - `scrubSecrets(value: string, tokens: string[]): string`
  - `scrubUnknown(value: unknown, tokens: string[]): string`
- Produces, from `src/logger.ts`:
  - `createLogger(rawSecrets: string[], stream?: NodeJS.WritableStream): Logger`

**Design — three decisions, each because the obvious alternative fails:**

**1. Scrub at serialization, not by path.** Pino's `redact` masks named object
paths. It cannot reach a secret inside `err.message`, inside a stack trace,
inside an `err.cause` nested several levels down, inside an array element, or
inside an object *key* name — and those are exactly where viem puts the RPC
URL. Scrubbing the serialized line is the only point every shape must pass
through, so nothing can bypass it whatever form it arrives in.

**2. Match the key value, not the whole URL.** A secret stored as
`https://eth-mainnet.g.alchemy.com/v2/<KEY>` will not match a log line that
contains the key alone, or the URL with a different path, or the URL
percent-encoded (`encodeURIComponent` leaves the alphanumeric key intact while
encoding the separators, so whole-URL matching misses it entirely). So derive
tokens: the raw secret, every long path segment, every query-parameter value,
and the percent-encoded form of each. Replace longest-first so a shorter token
cannot leave a fragment of a longer one behind.

**3. A generic fallback pattern, so an endpoint added later is still covered.**
Token matching only protects secrets that reached `Config.secrets`. A URL
constructed at runtime, or a chain configured after the logger was built, would
leak. A conservative pattern — a long opaque segment after `/v2/` or `/v3/`, or
an `apikey=`/`api_key=` query value — catches Alchemy- and Infura-shaped keys
that no token knows about. It only ever fires inside a URL-ish context, so it
cannot redact ordinary prose.

- [ ] **Step 1: Write the failing tests for `src/secrets.ts`**

`test/unit/secrets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveSecretTokens, scrubSecrets, scrubUnknown } from '../../src/secrets.js';

const KEY = 'aBcD1234efGh5678ijKl9012mnOp3456';
const RPC_URL = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
const ES_KEY = 'ESKEY9876543210ABCDEF';

describe('deriveSecretTokens', () => {
  it('includes the raw secret', () => {
    expect(deriveSecretTokens([RPC_URL])).toContain(RPC_URL);
  });

  it('extracts the key segment from the URL path', () => {
    expect(deriveSecretTokens([RPC_URL])).toContain(KEY);
  });

  it('includes the percent-encoded raw secret', () => {
    expect(deriveSecretTokens([RPC_URL])).toContain(encodeURIComponent(RPC_URL));
  });

  it('extracts a query-parameter value', () => {
    const tokens = deriveSecretTokens([`https://api.example.com/v2/api?apikey=${ES_KEY}`]);
    expect(tokens).toContain(ES_KEY);
  });

  it('keeps a bare non-URL secret', () => {
    expect(deriveSecretTokens([ES_KEY])).toContain(ES_KEY);
  });

  // Redacting "v2" or "eth-mainnet" would mangle every log line in the project.
  it('does not treat short or structural path segments as secrets', () => {
    const tokens = deriveSecretTokens([RPC_URL]);
    expect(tokens).not.toContain('v2');
    expect(tokens).not.toContain('eth-mainnet.g.alchemy.com');
  });

  it('ignores empty and whitespace-only secrets', () => {
    expect(deriveSecretTokens(['', '   '])).toEqual([]);
  });

  it('orders tokens longest first so a short token cannot fragment a longer one', () => {
    const tokens = deriveSecretTokens([RPC_URL]);
    const lengths = tokens.map((t) => t.length);
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
  });
});

describe('scrubSecrets', () => {
  const tokens = deriveSecretTokens([RPC_URL, ES_KEY]);

  it('removes a bare key', () => {
    expect(scrubSecrets(`calling with ${KEY} now`, tokens)).not.toContain(KEY);
  });

  it('removes a full URL', () => {
    const out = scrubSecrets(`GET ${RPC_URL} failed`, tokens);
    expect(out).not.toContain(KEY);
    expect(out).toContain('GET');
    expect(out).toContain('failed');
  });

  it('removes the percent-encoded form', () => {
    expect(scrubSecrets(encodeURIComponent(RPC_URL), tokens)).not.toContain(KEY);
  });

  it('removes every occurrence, not just the first', () => {
    expect(scrubSecrets(`${KEY} and ${KEY} and ${KEY}`, tokens)).not.toContain(KEY);
  });

  // The fallback: this key was never in Config.secrets.
  it('redacts an Alchemy-shaped key that no token knows about', () => {
    const unknownKey = 'zZyYxXwW1122334455667788990011223';
    const out = scrubSecrets(`https://base-mainnet.g.alchemy.com/v2/${unknownKey}`, tokens);
    expect(out).not.toContain(unknownKey);
  });

  it('redacts an apikey query value that no token knows about', () => {
    const unknownKey = 'QRSTUV1234567890abcdef';
    const out = scrubSecrets(`https://api.etherscan.io/v2/api?apikey=${unknownKey}&x=1`, tokens);
    expect(out).not.toContain(unknownKey);
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'indexed 1200 transfers for chain 8453 in 4.2s';
    expect(scrubSecrets(prose, tokens)).toBe(prose);
  });

  it('is a no-op with no tokens and no fallback match', () => {
    expect(scrubSecrets('plain text', [])).toBe('plain text');
  });
});

describe('scrubUnknown', () => {
  const tokens = deriveSecretTokens([RPC_URL]);

  it('scrubs an Error message', () => {
    expect(scrubUnknown(new Error(`boom ${KEY}`), tokens)).not.toContain(KEY);
  });

  it('scrubs a non-Error value without throwing', () => {
    expect(scrubUnknown(KEY, tokens)).not.toContain(KEY);
    expect(scrubUnknown(null, tokens)).toBe('null');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/secrets.test.ts`
Expected: FAIL — cannot resolve `../../src/secrets.js`.

- [ ] **Step 3: Write `src/secrets.ts`**

```ts
/** Minimum length for a path segment or query value to be treated as a key. */
const MIN_TOKEN_LENGTH = 16;

const REDACTED = '[REDACTED]';

/**
 * Patterns for secrets no token knows about — a URL built at runtime, or a
 * chain configured after the logger was constructed. Deliberately narrow: each
 * only fires inside a URL-ish context, so ordinary prose is never touched.
 */
const FALLBACK_PATTERNS: Array<[RegExp, string]> = [
  [/(\/v[23]\/)[A-Za-z0-9_-]{16,}/g, `$1${REDACTED}`],
  [/((?:api[-_]?key|apikey|access[-_]?token)=)[A-Za-z0-9_.-]{8,}/gi, `$1${REDACTED}`],
];

/**
 * Expands raw secrets into every form they might appear in.
 *
 * A secret stored as a full URL will not match a log line carrying only its key
 * segment, or the same URL percent-encoded — `encodeURIComponent` leaves the
 * alphanumeric key intact while encoding the separators around it. So the key
 * itself becomes a token in its own right.
 *
 * Sorted longest-first: replacing a short token first could consume part of a
 * longer one and leave the remainder in the output.
 */
export function deriveSecretTokens(rawSecrets: string[]): string[] {
  const tokens = new Set<string>();

  for (const raw of rawSecrets) {
    const secret = raw?.trim();
    if (!secret) continue;
    tokens.add(secret);

    let url: URL | undefined;
    try {
      url = new URL(secret);
    } catch {
      url = undefined;
    }

    if (url) {
      for (const segment of url.pathname.split('/')) {
        if (segment.length >= MIN_TOKEN_LENGTH) tokens.add(segment);
      }
      for (const value of url.searchParams.values()) {
        if (value.length >= 8) tokens.add(value);
      }
    }
  }

  // Encoded forms, added after the loop so encoding is applied to every token.
  for (const token of [...tokens]) {
    const encoded = encodeURIComponent(token);
    if (encoded !== token) tokens.add(encoded);
  }

  return [...tokens].sort((a, b) => b.length - a.length);
}

export function scrubSecrets(value: string, tokens: string[]): string {
  let out = value;
  for (const token of tokens) {
    if (!token) continue;
    out = out.split(token).join(REDACTED);
  }
  for (const [pattern, replacement] of FALLBACK_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function scrubUnknown(value: unknown, tokens: string[]): string {
  const text = value instanceof Error ? (value.stack ?? value.message) : String(value);
  return scrubSecrets(text, tokens);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/secrets.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for `src/logger.ts`**

Every shape test comes in a pair. The first asserts the secret is absent from
the **whole output string** — not that a named field equals a placeholder,
because a path-based assertion passes while the same secret sits in a stack
trace two levels down. The second is a **control**: the same shape logged with
no secrets configured, asserting the raw key *is* present.

The control is what makes the pair meaningful. Without it, a shape test passes
just as happily when pino never serialized that shape at all — a nested `cause`
that is silently dropped produces output with no secret in it and no scrubbing
whatsoever. The control fails loudly in that case.

`test/unit/logger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { Logger } from 'pino';
import { createLogger } from '../../src/logger.js';

// A bare token, not a URL: the fallback patterns must not match it, or the
// control assertions below could pass for the wrong reason.
const SECRET = 'ESKEY9876543210ABCDEF';

function capture(): { stream: Writable; output: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) { buf += String(chunk); cb(); },
  });
  return { stream, output: () => buf };
}

interface Shape {
  name: string;
  marker: string;
  emit(log: Logger): void;
}

const shapes: Shape[] = [
  {
    name: 'top-level field',
    marker: 'marker-toplevel',
    emit: (log) => log.info({ endpoint: SECRET, note: 'marker-toplevel' }, 'call'),
  },
  {
    name: 'error message',
    marker: 'marker-errmsg',
    emit: (log) => log.error(new Error(`request failed for ${SECRET} marker-errmsg`)),
  },
  {
    name: 'stack trace',
    marker: 'marker-stack',
    emit: (log) => {
      const err = new Error('boom');
      err.stack = `Error: boom\n    at post (${SECRET}:1:1)\n    at marker-stack (x.ts:2:2)`;
      log.error(err);
    },
  },
  {
    name: 'nested cause, three levels deep',
    marker: 'marker-cause',
    emit: (log) => {
      const deepest = new Error(`deepest ${SECRET} marker-cause`);
      const middle = new Error('middle', { cause: deepest });
      log.error(new Error('outer', { cause: middle }));
    },
  },
  {
    name: 'array element',
    marker: 'marker-array',
    emit: (log) => log.info({ endpoints: ['first', SECRET, 'marker-array'] }, 'call'),
  },
  {
    name: 'object key name',
    marker: 'marker-keyname',
    emit: (log) => log.info({ [SECRET]: 'marker-keyname' }, 'call'),
  },
  {
    name: 'percent-encoded form',
    marker: 'marker-encoded',
    emit: (log) =>
      log.info(
        { encoded: encodeURIComponent(`https://x.example/v2/${SECRET}`), note: 'marker-encoded' },
        'call',
      ),
  },
];

describe.each(shapes)('secret in $name', ({ marker, emit }) => {
  it('is absent from the serialized output', () => {
    const { stream, output } = capture();
    emit(createLogger([SECRET], stream));
    expect(output()).not.toContain(SECRET);
    // Proves the shape actually reached the output, so the assertion above is
    // about scrubbing rather than about pino dropping the field.
    expect(output()).toContain(marker);
  });

  it('control: appears unredacted when no secret is configured', () => {
    const { stream, output } = capture();
    emit(createLogger([], stream));
    expect(output()).toContain(SECRET);
    expect(output()).toContain(marker);
  });
});

describe('createLogger', () => {
  it('derives tokens from a raw URL, so the bare key is scrubbed too', () => {
    const key = 'aBcD1234efGh5678ijKl9012mnOp3456';
    const { stream, output } = capture();
    const log = createLogger([`https://eth-mainnet.g.alchemy.com/v2/${key}`], stream);
    log.info({ note: `bare key ${key} here` }, 'call');
    expect(output()).not.toContain(key);
  });

  it('still logs the message and level', () => {
    const { stream, output } = capture();
    createLogger([SECRET], stream).info('hello world');
    expect(output()).toContain('hello world');
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run test/unit/logger.test.ts`
Expected: FAIL — cannot resolve `../../src/logger.js`.

- [ ] **Step 7: Write `src/logger.ts`**

`errWithCause` matters: the default error serializer does not walk the `cause`
chain, so a secret nested inside one would never reach the output — and the
control test in the pair above is what catches that.

```ts
import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import { deriveSecretTokens, scrubSecrets } from './secrets.js';

/**
 * A pino logger whose every serialized line is scrubbed.
 *
 * The scrub sits on the stream rather than in `redact` paths, because a secret
 * can arrive inside an error message, a stack trace, a cause several levels
 * down, an array element, or an object key name — none of which a path can
 * name. The stream is the one place they all pass through.
 */
export function createLogger(
  rawSecrets: string[],
  stream?: NodeJS.WritableStream,
): Logger {
  const tokens = deriveSecretTokens(rawSecrets);
  const target = stream ?? process.stdout;

  const scrubbing = new Writable({
    write(chunk, _enc, cb) {
      target.write(scrubSecrets(String(chunk), tokens));
      cb();
    },
  });

  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      base: undefined,
      // The default err serializer stops at the top-level error.
      serializers: { err: pino.stdSerializers.errWithCause },
    },
    scrubbing,
  );
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/unit/logger.test.ts && npm run typecheck`
Expected: PASS — 7 shape pairs (14 tests) plus 2.

If a control test fails, the shape is not reaching pino's output at all; fix the
serializer configuration rather than deleting the shape.

- [ ] **Step 9: Retrofit the probe script to the shared implementation**

`scripts/verify-archive-probes.ts` currently carries its own local `scrub()` and
`scrubUnknown()`. Delete both and import from `src/secrets.js`, deriving tokens
once from `config.secrets`:

```ts
import { deriveSecretTokens, scrubUnknown } from '../src/secrets.js';

const tokens = deriveSecretTokens(config.secrets);
// ... and at the single call site:
detail = scrubUnknown(err, tokens);
```

One implementation, not two. Verify no local scrub helper remains:

Run: `grep -n "function scrub" scripts/verify-archive-probes.ts`
Expected: no output.

- [ ] **Step 10: Verify the gate still passes**

Run: `npm run verify:probes`
Expected: `3 PASS, 0 FAIL, 0 INCONCLUSIVE`, exit 0. Report the exact output.

- [ ] **Step 11: Run the full suite and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/secrets.ts src/logger.ts scripts/verify-archive-probes.ts test/unit/secrets.test.ts test/unit/logger.test.ts
git commit -m "feat: secret scrubbing at serialization, shared by logger and scripts

Pino redact paths cannot reach a secret inside err.message, a stack
trace, a cause nested several levels down, an array element, or an
object key name — which is where viem actually puts the RPC URL. The
scrub sits on the stream instead, the one point every shape passes
through.

Tokens are derived from the key value rather than the whole URL:
encodeURIComponent leaves an alphanumeric key intact while encoding the
separators, so whole-URL matching misses the encoded form entirely. A
narrow fallback pattern covers keys that never reached Config.secrets.

Each shape test is paired with a control asserting the secret appears
when no secret is configured, so a shape pino silently drops cannot
masquerade as a shape successfully scrubbed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Database connection, migration runner, and schema

**Files:**
- Create: `src/clock.ts`, `src/db/paths.ts`, `src/db/connection.ts`, `src/db/migrate.ts`, `db/migrations/001_init.sql`
- Modify: `src/errors.ts` — add `MigrationError`
- Test: `test/unit/clock.test.ts`, `test/unit/connection.test.ts`, `test/unit/migrate.test.ts`

**Interfaces:**
- Consumes: `ConfigError` (Task 1)
- Produces:
  - `interface Clock { now(): number }` — epoch milliseconds
  - `systemClock: Clock`, `manualClock(startMs?: number): Clock & { advance(ms: number): void; set(ms: number): void }`
  - `repoRoot(): string`, `migrationsDir(): string`
  - `openDb(path: string): Database.Database`
  - `interface AppliedMigration { filename: string; checksum: string }`
  - `runMigrations(db: Database.Database): AppliedMigration[]`
  - `MigrationError` (from `src/errors.ts`)

**Four requirements driving this task's design:**

**1. `PRAGMA foreign_keys = ON` per connection, and a foreign key that makes it matter.**
SQLite defaults foreign-key enforcement OFF on *every new connection*, so setting it
in a migration would silently stop applying the moment anything reopens the database.
It belongs in the connection factory beside WAL and `busy_timeout`.

There is currently **no foreign key in the schema at all**, so the pragma guards
nothing. This task adds one: `transfers` references `collections (chain_id, contract)`
with `ON DELETE CASCADE`. That is the real data model — a transfer cannot belong to a
collection that does not exist — and it means dropping a collection cleans up its rows
instead of orphaning them. The parent key is `collections`' primary key, so the
required unique index already exists.

**The test must prove enforcement, not configuration.** Asserting `PRAGMA foreign_keys`
returns `1` only proves a pragma was set. Assert that inserting a transfer for a
non-existent collection is **rejected** — that is the behaviour anyone cares about, and
it fails if either the pragma or the constraint goes missing.

**2. A `schema_migrations` ledger with a content checksum, one transaction per file.**
Filename and applied-at are not enough. If an already-applied migration's content
changes, the runner skips it by filename and the database silently diverges from the
repo — a drift bug that surfaces months later as an inexplicable missing column. So
store a SHA-256 of each file's content and fail loudly when a recorded checksum no
longer matches. Also fail when a recorded migration has vanished from disk, which is
the same drift in the other direction. Each migration applies inside its own
transaction, so a file that fails halfway leaves no partial schema and no ledger row.

**3. One injectable clock, epoch milliseconds, INTEGER columns.**
Mixing SQLite's `datetime()` with JS time gives two clocks that disagree, and makes
lock tests depend on sleeping. `locked_at` and `indexed_at` become `INTEGER` epoch
milliseconds, and a single `Clock` is passed in and used for both writing a timestamp
and computing a staleness cutoff. Contended- and stale-lock tests then set the time
explicitly instead of waiting.

**4. TEXT numeric columns sort lexicographically — say so in the schema.**
`token_id`, `amount`, and `tx_value_wei` are TEXT because they are `uint256` and
exceed `Number.MAX_SAFE_INTEGER`. That means `ORDER BY token_id` gives `'10'` before
`'9'`. Milestone 1 never orders by them (ordering is by `block_number, log_index,
batch_index`), but it is a trap for anyone adding a query later, so the schema
comments must warn about it explicitly.

- [ ] **Step 1: Write the failing clock test**

`test/unit/clock.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { manualClock, systemClock } from '../../src/clock.js';

describe('systemClock', () => {
  it('returns epoch milliseconds', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(Number.isInteger(now)).toBe(true);
  });
});

describe('manualClock', () => {
  it('starts at the given time and does not move on its own', () => {
    const clock = manualClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_000);
  });

  it('advances by an explicit amount', () => {
    const clock = manualClock(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
  });

  it('can be set to an absolute time', () => {
    const clock = manualClock(1_000);
    clock.set(9_999);
    expect(clock.now()).toBe(9_999);
  });

  it('defaults to 0 so tests are reproducible without passing a start', () => {
    expect(manualClock().now()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/clock.test.ts`
Expected: FAIL — cannot resolve `../../src/clock.js`.

- [ ] **Step 3: Write `src/clock.ts`**

```ts
/**
 * A source of epoch milliseconds.
 *
 * Everything that records or compares a timestamp takes one of these, so the
 * lock lifecycle can be tested by setting the time rather than sleeping. Note
 * that nothing in this project uses SQLite's own `datetime()`/`unixepoch()`:
 * two clocks that can disagree is exactly the bug this avoids.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

/** A clock that only moves when a test moves it. */
export function manualClock(startMs = 0): ManualClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
    set: (ms) => { current = ms; },
  };
}
```

- [ ] **Step 4: Add `MigrationError` to `src/errors.ts`**

Append to the existing file, leaving the other classes untouched:

```ts
export class MigrationError extends ByakuganError {}
```

- [ ] **Step 5: Write `src/db/paths.ts`**

`__dirname` moves between `src/` and `dist/`, so walk up to the `package.json`.

```ts
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | undefined;

export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('repo root not found: no package.json in any parent directory');
    }
    dir = parent;
  }
}

/** `MIGRATIONS_DIR` exists so tests can point the runner at a fixture directory. */
export function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? join(repoRoot(), 'db', 'migrations');
}
```

- [ ] **Step 6: Write `db/migrations/001_init.sql`**

```sql
-- Byakugan initial schema.
--
-- NUMERIC VALUES STORED AS TEXT: token_id, amount and tx_value_wei are uint256
-- and exceed Number.MAX_SAFE_INTEGER, so they are TEXT to avoid precision loss.
-- CONSEQUENCE: they sort LEXICOGRAPHICALLY, not numerically — '10' orders before
-- '9', and '100' before '2'. Milestone 1 never orders by them (ordering is always
-- block_number, log_index, batch_index). Anyone adding an ORDER BY or a range
-- comparison on these columns must zero-pad or CAST, or the results will be wrong
-- in a way that looks plausible.
--
-- TIMESTAMPS: locked_at and indexed_at are INTEGER epoch milliseconds, written
-- from the injected Clock. SQLite's own datetime()/unixepoch() are deliberately
-- not used anywhere — one clock, not two.

CREATE TABLE IF NOT EXISTS collections (
  chain_id            INTEGER NOT NULL,
  contract            TEXT    NOT NULL,
  -- NULL until bootstrap completes. `standard IS NULL` means "claimed, not yet
  -- bootstrapped"; every read path must filter it out, or an unbootstrapped row
  -- surfaces as an indexed collection holding zero transfers.
  standard            TEXT    CHECK (standard IN ('721','1155')),
  name                TEXT,
  deploy_block        INTEGER,
  deploy_block_source TEXT    CHECK (deploy_block_source IN
                                     ('override','explorer','binary_search')),
  last_indexed_block  INTEGER,
  indexed_at          INTEGER,   -- epoch ms
  locked_by           TEXT,
  locked_at           INTEGER,   -- epoch ms
  PRIMARY KEY (chain_id, contract)
);

CREATE TABLE IF NOT EXISTS transfers (
  chain_id     INTEGER NOT NULL,
  contract     TEXT    NOT NULL,
  token_id     TEXT    NOT NULL,   -- uint256 as TEXT: sorts lexicographically
  amount       TEXT    NOT NULL DEFAULT '1',
  from_addr    TEXT    NOT NULL,
  to_addr      TEXT    NOT NULL,
  tx_hash      TEXT    NOT NULL,
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  -- 0 for ERC-721 and TransferSingle; array position for TransferBatch. An
  -- ERC-1155 TransferBatch is ONE log carrying ids[], so without this column
  -- every token after the first collides on the primary key and is dropped.
  batch_index  INTEGER NOT NULL DEFAULT 0,
  tx_from      TEXT    NOT NULL,
  tx_value_wei TEXT    NOT NULL,   -- uint256 as TEXT: sorts lexicographically
  kind         TEXT    NOT NULL CHECK (kind IN ('mint','buy','transfer','burn')),
  PRIMARY KEY (chain_id, tx_hash, log_index, batch_index),
  -- Enforced only while PRAGMA foreign_keys = ON, which SQLite defaults OFF per
  -- connection — see src/db/connection.ts.
  FOREIGN KEY (chain_id, contract)
    REFERENCES collections (chain_id, contract)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS transfers_contract_kind_pos
  ON transfers (contract, kind, block_number, log_index);

CREATE INDEX IF NOT EXISTS transfers_to_addr
  ON transfers (to_addr);
```

- [ ] **Step 7: Write the failing connection test**

`test/unit/connection.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';

const temps: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'byakugan-'));
  temps.push(dir);
  return join(dir, 'test.db');
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('openDb', () => {
  it('enables WAL on a file database', () => {
    const db = openDb(tempDbPath());
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
    db.close();
  });

  it('sets a busy timeout', () => {
    const db = openDb(':memory:');
    const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(timeout.timeout).toBeGreaterThan(0);
  });

  it('turns foreign key enforcement on', () => {
    const db = openDb(':memory:');
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });

  // The assertion that matters. A pragma reading 1 only proves a pragma was set;
  // this proves the constraint is actually enforced, and fails if either the
  // pragma or the FOREIGN KEY clause disappears.
  it('rejects a transfer whose collection does not exist', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(() =>
      db.prepare(`
        INSERT INTO transfers
          (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
           block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
        VALUES (1, '0xdoesnotexist', '1', '1', '0x0', '0xaaa', '0xtx',
                1, 0, 0, '0xaaa', '0', 'mint')
      `).run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('accepts a transfer once its collection exists', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO collections (chain_id, contract) VALUES (1, ?)').run('0xabc');
    expect(() =>
      db.prepare(`
        INSERT INTO transfers
          (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
           block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
        VALUES (1, '0xabc', '1', '1', '0x0', '0xaaa', '0xtx',
                1, 0, 0, '0xaaa', '0', 'mint')
      `).run(),
    ).not.toThrow();
  });

  it('cascades a collection delete to its transfers', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO collections (chain_id, contract) VALUES (1, ?)').run('0xabc');
    db.prepare(`
      INSERT INTO transfers
        (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
         block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
      VALUES (1, '0xabc', '1', '1', '0x0', '0xaaa', '0xtx', 1, 0, 0, '0xaaa', '0', 'mint')
    `).run();
    db.prepare('DELETE FROM collections WHERE chain_id = 1 AND contract = ?').run('0xabc');
    const left = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
    expect(left.n).toBe(0);
  });

  it('creates the parent directory for a nested path', () => {
    const nested = join(mkdtempSync(join(tmpdir(), 'byakugan-')), 'a', 'b', 'test.db');
    temps.push(nested);
    expect(() => openDb(nested).close()).not.toThrow();
  });
});
```

- [ ] **Step 8: Write `src/db/connection.ts`**

```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Opens the database with the pragmas this project depends on.
 *
 * `foreign_keys` is set HERE and not in a migration because SQLite defaults it
 * OFF on every new connection: a migration would set it once and every later
 * process would run unenforced. WAL and busy_timeout are likewise per-connection.
 */
export function openDb(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}
```

- [ ] **Step 9: Run the connection tests to verify they fail, then pass**

Run: `npx vitest run test/unit/connection.test.ts`
Expected first: FAIL (modules missing). After Steps 8 and 11: PASS, 7 tests.

- [ ] **Step 10: Write the failing migration test**

`test/unit/migrate.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/connection.js';
import { migrationsDir, repoRoot } from '../../src/db/paths.js';
import { runMigrations } from '../../src/db/migrate.js';
import { MigrationError } from '../../src/errors.js';

const dirs: string[] = [];
function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'byakugan-mig-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}
afterEach(() => {
  delete process.env.MIGRATIONS_DIR;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('paths', () => {
  it('resolves a repo root containing package.json', () => {
    expect(existsSync(join(repoRoot(), 'package.json'))).toBe(true);
  });

  it('points migrationsDir at repo-root db/migrations by default', () => {
    expect(migrationsDir()).toBe(join(repoRoot(), 'db', 'migrations'));
    expect(existsSync(migrationsDir())).toBe(true);
  });

  it('honours MIGRATIONS_DIR', () => {
    process.env.MIGRATIONS_DIR = '/tmp/elsewhere';
    expect(migrationsDir()).toBe('/tmp/elsewhere');
  });
});

describe('runMigrations — real schema', () => {
  it('creates both tables and reports what it applied', () => {
    const db = openDb(':memory:');
    const applied = runMigrations(db);
    expect(applied.map((a) => a.filename)).toContain('001_init.sql');
    expect(applied[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);

    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('collections');
    expect(names).toContain('transfers');
    expect(names).toContain('schema_migrations');
  });

  it('is idempotent — a second run applies nothing', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(runMigrations(db)).toEqual([]);
  });

  it('gives transfers a primary key including batch_index', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const pk = (db.prepare('PRAGMA table_info(transfers)').all() as Array<{
      name: string; pk: number;
    }>)
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(['chain_id', 'tx_hash', 'log_index', 'batch_index']);
  });

  it('accepts two rows differing only by batch_index', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO collections (chain_id, contract) VALUES (1, ?)').run('0xabc');
    const insert = db.prepare(`
      INSERT OR IGNORE INTO transfers
        (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
         block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
      VALUES (1, '0xabc', @tokenId, '1', '0x0', '0xaaa', '0xbatch',
              1, 4, @batchIndex, '0xaaa', '0', 'mint')
    `);
    insert.run({ tokenId: '10', batchIndex: 0 });
    insert.run({ tokenId: '11', batchIndex: 1 });
    const n = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('declares the timestamp columns as INTEGER epoch ms', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const cols = (db.prepare('PRAGMA table_info(collections)').all() as Array<{
      name: string; type: string;
    }>);
    expect(cols.find((c) => c.name === 'locked_at')?.type).toBe('INTEGER');
    expect(cols.find((c) => c.name === 'indexed_at')?.type).toBe('INTEGER');
  });
});

describe('runMigrations — checksum ledger', () => {
  it('records a checksum per applied file', () => {
    process.env.MIGRATIONS_DIR = fixtureDir({ '001_a.sql': 'CREATE TABLE a (x);' });
    const db = openDb(':memory:');
    runMigrations(db);
    const row = db.prepare(
      'SELECT filename, checksum, applied_at FROM schema_migrations',
    ).get() as { filename: string; checksum: string; applied_at: number };
    expect(row.filename).toBe('001_a.sql');
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(row.applied_at)).toBe(true);
  });

  // The drift bug this exists to prevent: skipping by filename lets an edited
  // migration diverge the database from the repo, invisibly, for months.
  it('fails loudly when an applied migration has been edited', () => {
    const dir = fixtureDir({ '001_a.sql': 'CREATE TABLE a (x);' });
    process.env.MIGRATIONS_DIR = dir;
    const db = openDb(':memory:');
    runMigrations(db);
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x, y);');
    expect(() => runMigrations(db)).toThrow(MigrationError);
    expect(() => runMigrations(db)).toThrow(/001_a\.sql/);
  });

  it('fails loudly when an applied migration has vanished from disk', () => {
    const dir = fixtureDir({ '001_a.sql': 'CREATE TABLE a (x);' });
    process.env.MIGRATIONS_DIR = dir;
    const db = openDb(':memory:');
    runMigrations(db);
    rmSync(join(dir, '001_a.sql'));
    expect(() => runMigrations(db)).toThrow(MigrationError);
  });

  it('does not flag an unchanged file on re-run', () => {
    process.env.MIGRATIONS_DIR = fixtureDir({ '001_a.sql': 'CREATE TABLE a (x);' });
    const db = openDb(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});

describe('runMigrations — one transaction per file', () => {
  it('applies files in sorted order', () => {
    process.env.MIGRATIONS_DIR = fixtureDir({
      '002_b.sql': 'CREATE TABLE b (x);',
      '001_a.sql': 'CREATE TABLE a (x);',
    });
    const db = openDb(':memory:');
    expect(runMigrations(db).map((a) => a.filename)).toEqual(['001_a.sql', '002_b.sql']);
  });

  // A failure inside one file must leave no partial schema and no ledger row for
  // it, while earlier files stay applied.
  it('rolls back a failing file completely, keeping earlier files', () => {
    process.env.MIGRATIONS_DIR = fixtureDir({
      '001_a.sql': 'CREATE TABLE a (x);',
      '002_bad.sql': 'CREATE TABLE b (x); THIS IS NOT SQL;',
    });
    const db = openDb(':memory:');
    expect(() => runMigrations(db)).toThrow(MigrationError);

    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('a');
    expect(names).not.toContain('b');

    const recorded = (db.prepare(
      'SELECT filename FROM schema_migrations',
    ).all() as Array<{ filename: string }>).map((r) => r.filename);
    expect(recorded).toEqual(['001_a.sql']);
  });

  it('resumes from where a failure stopped once the file is fixed', () => {
    const dir = fixtureDir({
      '001_a.sql': 'CREATE TABLE a (x);',
      '002_bad.sql': 'THIS IS NOT SQL;',
    });
    process.env.MIGRATIONS_DIR = dir;
    const db = openDb(':memory:');
    expect(() => runMigrations(db)).toThrow(MigrationError);
    writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE b (x);');
    expect(runMigrations(db).map((a) => a.filename)).toEqual(['002_bad.sql']);
  });

  it('ignores non-sql files', () => {
    process.env.MIGRATIONS_DIR = fixtureDir({
      '001_a.sql': 'CREATE TABLE a (x);',
      'README.md': 'not a migration',
    });
    const db = openDb(':memory:');
    expect(runMigrations(db).map((a) => a.filename)).toEqual(['001_a.sql']);
  });
});
```

- [ ] **Step 11: Write `src/db/migrate.ts`**

```ts
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { MigrationError } from '../errors.js';
import { systemClock, type Clock } from '../clock.js';
import { migrationsDir } from './paths.js';

export interface AppliedMigration {
  filename: string;
  checksum: string;
}

const checksum = (sql: string): string =>
  createHash('sha256').update(sql, 'utf8').digest('hex');

/**
 * Applies pending migrations, each in its own transaction.
 *
 * The ledger stores a content checksum, not just a filename, because skipping
 * by filename alone lets an edited migration silently diverge the database from
 * the repo — a drift bug that surfaces much later as an inexplicably missing
 * column. A changed or missing file is therefore a hard failure, never a skip.
 */
export function runMigrations(
  db: Database.Database,
  clock: Clock = systemClock,
): AppliedMigration[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT    PRIMARY KEY,
      checksum   TEXT    NOT NULL,
      applied_at INTEGER NOT NULL   -- epoch ms, from the injected Clock
    )
  `);

  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const onDisk = new Map(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

  const recorded = new Map(
    (db.prepare('SELECT filename, checksum FROM schema_migrations').all() as Array<{
      filename: string; checksum: string;
    }>).map((r) => [r.filename, r.checksum]),
  );

  // Verify every already-applied migration before applying anything new, so a
  // drifted repo fails before it can layer more schema on top.
  for (const [filename, recordedChecksum] of recorded) {
    const sql = onDisk.get(filename);
    if (sql === undefined) {
      throw new MigrationError(
        `migration ${filename} is recorded as applied but is missing from ${dir}. ` +
        'The database and the repo have diverged; restore the file or reset the database.',
      );
    }
    const actual = checksum(sql);
    if (actual !== recordedChecksum) {
      throw new MigrationError(
        `migration ${filename} has changed since it was applied ` +
        `(recorded ${recordedChecksum.slice(0, 12)}…, found ${actual.slice(0, 12)}…). ` +
        'Applied migrations are immutable: add a new migration instead of editing this one.',
      );
    }
  }

  const record = db.prepare(
    'INSERT INTO schema_migrations (filename, checksum, applied_at) VALUES (?, ?, ?)',
  );

  const applied: AppliedMigration[] = [];
  for (const filename of files) {
    if (recorded.has(filename)) continue;
    const sql = onDisk.get(filename);
    if (sql === undefined) continue;
    const sum = checksum(sql);

    try {
      // One transaction per file: a failure halfway leaves no partial schema
      // and no ledger row, so a fixed file applies cleanly on the next run.
      db.transaction(() => {
        db.exec(sql);
        record.run(filename, sum, clock.now());
      })();
    } catch (err) {
      throw new MigrationError(
        `migration ${filename} failed and was rolled back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    applied.push({ filename, checksum: sum });
  }

  return applied;
}
```

- [ ] **Step 12: Run every test and typecheck**

Run: `npx vitest run test/unit/clock.test.ts test/unit/connection.test.ts test/unit/migrate.test.ts && npm run typecheck`
Expected: PASS — 4 clock, 7 connection, 16 migration. Then `npm test` for the whole suite.

- [ ] **Step 13: Commit**

```bash
git add src/clock.ts src/db/ src/errors.ts db/migrations/ test/unit/clock.test.ts test/unit/connection.test.ts test/unit/migrate.test.ts
git commit -m "feat: SQLite connection, checksummed migration runner, and schema

foreign_keys is set per connection, not in a migration: SQLite defaults
it OFF on every new connection, so a migration would set it once and
every later process would run unenforced. transfers now actually has a
composite FK to collections with ON DELETE CASCADE, so the pragma guards
something — and the test asserts an orphan insert is REJECTED rather than
asserting the pragma reads 1.

schema_migrations stores a SHA-256 of each file. Skipping by filename
alone lets an edited migration silently diverge the database from the
repo; a changed or vanished file is now a hard failure. Each file applies
in its own transaction, so a partial failure leaves no schema and no
ledger row.

Timestamps are INTEGER epoch ms from an injected Clock. SQLite's
datetime() is used nowhere — two clocks that can disagree is the bug.

The schema comments record that token_id, amount and tx_value_wei are
TEXT and therefore sort lexicographically, which is a trap for anyone
adding an ORDER BY later.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Collections repository — locking, cleanup, guarded reads

**Files:**
- Create: `src/jobId.ts`, `src/db/repositories/collections.ts`
- Test: `test/unit/jobId.test.ts`, `test/unit/collections.repo.test.ts`

**Interfaces:**
- Consumes: `openDb`, `runMigrations`, `Clock`, `manualClock` (Task 3); `Standard`, `DeployBlockSource` (Task 1)
- Produces:
  - `type CollectionState = { state: 'not_indexed' } | { state: 'indexed'; standard: Standard; deployBlock: number; lastIndexedBlock: number; name: string | null }`
  - `claimCollection(db, a: { chainId, contract, jobId, clock: Clock, staleMs: number }): boolean`
  - `releaseCollection(db, a: { chainId, contract, jobId }): void`
  - `deleteUnbootstrapped(db, a: { chainId, contract, jobId }): void`
  - `finishBootstrap(db, a: { chainId, contract, standard, deployBlock, deployBlockSource, name }): void`
  - `newJobId(): string` (from `src/jobId.ts`)
  - `getCollection(db, chainId: number, contract: string): CollectionState`
  - `advanceWatermark(db, a: { chainId, contract, jobId, toBlock: number, clock: Clock }): void`

**Three properties this task must prove, not merely implement:**

**Stale-lock stealing is atomic.** The staleness condition lives inside the claim
statement's `ON CONFLICT ... DO UPDATE ... WHERE`, so testing staleness and taking the
lock are one statement and `changes` decides the winner. A `SELECT` to check staleness
followed by an `UPDATE` would let two jobs both observe the same stale lock and both
steal it. The property needs a test with two racing steals, not just one successful steal.

**Release is identity-checked.** `WHERE ... AND locked_by = @jobId`. If job A's lock goes
stale and job B steals it, A finishing later must not clear B's lock — otherwise the
collection is silently unlocked while B is still writing to it. Needs its own test.

**`locked_by` is unique per RUN.** Not per collection, not a process name, not a bare pid:
a restarted process could then steal or release its own predecessor's lock by accident.
`newJobId()` combines hostname and pid (for diagnosability in logs) with a uuid (for
uniqueness).

**On the guarded read returning two states, not three.** `getCollection` returns
`indexed | not_indexed`, and a claimed-but-unbootstrapped row — lock held or not — reads
as `not_indexed`. No "in progress" state reaches callers from this function. Milestone 2's
analysis paths (`firstMinters`, `overlap`) must treat such a row as un-indexed, and a
two-state union makes that impossible to get wrong.

Milestone 2's `/status` command *does* genuinely want the distinction — replying
"not indexed" to someone who just ran `/index` is misleading. That is served by a separate,
explicitly named `getCollectionStatus()` returning
`not_indexed | bootstrapping | indexed`, added in Milestone 2 where the caller exists. Two
functions, so the state that matters for correctness cannot arrive through the one used for
analysis. It is not built now: M1 has no status surface, and inventing the caller-free
version first is how unused third states end up mishandled.

This repository deliberately exposes **no** raw "get row by address". `getCollection` returns a tagged union, so a caller cannot forget the `standard IS NOT NULL` filter — an unbootstrapped row must never surface as an indexed collection with zero transfers.

- [ ] **Step 1: Write the failing job-id test**

`test/unit/jobId.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { newJobId } from '../../src/jobId.js';

describe('newJobId', () => {
  it('is unique per call', () => {
    expect(newJobId()).not.toBe(newJobId());
  });

  it('stays unique across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newJobId()));
    expect(ids.size).toBe(1000);
  });

  // hostname and pid are for reading logs; the uuid is what makes it unique.
  it('carries the hostname and pid for diagnosability', () => {
    const id = newJobId();
    expect(id).toContain(hostname());
    expect(id).toContain(String(process.pid));
  });

  // A bare pid or process name would let a restarted process steal or release
  // its own predecessor's lock.
  it('ends in a uuid, so it is per-run rather than per-process', () => {
    const segments = newJobId().split(':');
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(segments.at(-1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write `src/jobId.ts`**

Run: `npx vitest run test/unit/jobId.test.ts` — FAIL, module missing.

```ts
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/**
 * A lock-owner identity, unique per RUN.
 *
 * Deliberately not derived from the collection, the process name, or a bare pid:
 * pids are reused, so a restarted process could steal or release its own
 * predecessor's lock by accident. The hostname and pid are there to make a held
 * lock diagnosable from logs; the uuid is what guarantees uniqueness.
 */
export function newJobId(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}
```

Re-run: PASS, 4 tests.

- [ ] **Step 3: Write the failing collections test**

`test/unit/collections.repo.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { manualClock } from '../../src/clock.js';
import {
  advanceWatermark, claimCollection, deleteUnbootstrapped,
  finishBootstrap, getCollection, releaseCollection,
} from '../../src/db/repositories/collections.js';

const CHAIN = 1;
const CONTRACT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const STALE_MS = 300_000;
const T0 = 1_774_000_000_000;   // fixed epoch ms; no wall clock in these tests

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
});
// Push the mkdtemp ROOT, never a nested path: pushing the leaf leaked an empty
// tree per run in Task 3.
const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

// One injected clock drives both the timestamp written and the staleness cutoff,
// so these tests set the time instead of sleeping.
const claim = (jobId: string, atMs = T0) =>
  claimCollection(db, {
    chainId: CHAIN, contract: CONTRACT, jobId,
    clock: manualClock(atMs), staleMs: STALE_MS,
  });

describe('claimCollection', () => {
  it('creates the row and acquires the lock when no row exists', () => {
    expect(claim('job-a')).toBe(true);
  });

  it('resolves two claims on a never-seen collection to exactly one winner', () => {
    const results = [claim('job-a'), claim('job-b')];
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a claim while another job holds a fresh lock', () => {
    claim('job-a');
    expect(claim('job-b')).toBe(false);
  });

  it('grants a claim over a stale lock', () => {
    claim('job-a', T0);
    expect(claim('job-b', T0 + 600_000)).toBe(true);   // 10 min later: stale
  });

  // Two sequential steal attempts against one stale lock leave exactly one
  // holder, because the winning claim writes locked_at in the same statement
  // that tests it, so the second attempt sees a fresh lock.
  //
  // This does NOT prove atomicity. It was mutation-tested and passes
  // identically against a check-then-claim implementation: better-sqlite3 is
  // synchronous and single-process, so the first attempt's write always
  // commits before the second attempt's read, and the interleaving that
  // breaks check-then-claim is unreachable on one connection. The
  // cross-connection test below is the one that pins the property.
  it('leaves exactly one holder after two sequential steal attempts', () => {
    claim('job-a', T0);
    const steals = [claim('job-b', T0 + 600_000), claim('job-c', T0 + 600_000)];
    expect(steals.filter(Boolean)).toHaveLength(1);
    const row = db.prepare('SELECT locked_by FROM collections').get() as { locked_by: string };
    expect(['job-b', 'job-c']).toContain(row.locked_by);
  });

  it('lets a new job claim after release', () => {
    claim('job-a');
    releaseCollection(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'job-a' });
    expect(claim('job-b')).toBe(true);
  });
});

// Cross-connection behaviour.
//
// HONEST SCOPE: this does NOT distinguish a single-statement claim from a
// check-then-claim either, and that was verified rather than assumed. Swapping a
// check-then-claim in as the implementation still yields one winner, because its
// own SELECT runs AFTER B's commit and therefore sees the fresh lock. The only
// way to make it steal is to decompose it by hand so its read straddles B's
// commit — which is the test author constructing the interleaving, not the test
// detecting it. Genuine detection needs real concurrency (two OS threads inside
// one call), which a synchronous single-process driver cannot produce.
//
// What this test DOES prove: a claim is immediately visible across connections,
// and a stale pre-read does not authorise a steal in the real implementation.
// The single-statement property itself is pinned by the statement-count test
// below, which is deterministic and does discriminate.
//
// JOURNAL MODE: WAL, which `openDb` sets for any file path. That matters and is
// not incidental — under WAL a reader does not block a writer, so a read issued
// while another connection holds an open write transaction sees the last
// COMMITTED snapshot rather than blocking. That is what makes a stale read
// reachable, and therefore what makes the check-then-claim bug demonstrable.
// Under `journal_mode = DELETE` the reader would block instead, and the test
// would pass for a reason unrelated to atomicity.
//
// `:memory:` cannot be used here: separate connections cannot share it.
describe('claimCollection — cross-connection atomicity', () => {
  let connB: Database.Database;
  let connC: Database.Database;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'byakugan-lock-'));
    tempRoots.push(root);
    const dbPath = join(root, 'lock.db');

    const setup = openDb(dbPath);
    runMigrations(setup);
    setup.close();

    connB = openDb(dbPath);
    connC = openDb(dbPath);
    // Generous and explicit: a blocked statement must wait for the other
    // connection rather than returning SQLITE_BUSY, or the result becomes a
    // timing coin-flip instead of a verdict.
    for (const conn of [connB, connC]) conn.pragma('busy_timeout = 30000');

    expect((connB.prepare('PRAGMA journal_mode').get() as { journal_mode: string })
      .journal_mode).toBe('wal');
  });

  afterEach(() => {
    connB.close();
    connC.close();
  });

  const claimOn = (conn: Database.Database, jobId: string, atMs: number) =>
    claimCollection(conn, {
      chainId: CHAIN, contract: CONTRACT, jobId,
      clock: manualClock(atMs), staleMs: STALE_MS,
    });

  it('does not steal on the strength of a stale pre-read', () => {
    // job-a holds a lock that will go stale.
    expect(claimOn(connB, 'job-a', T0)).toBe(true);
    const stale = T0 + 600_000;

    // C reads the world at `stale`: the lock IS stale here, so a
    // check-then-claim implementation would decide to steal from this read.
    const seenByC = connC
      .prepare('SELECT locked_by, locked_at FROM collections WHERE chain_id = ? AND contract = ?')
      .get(CHAIN, CONTRACT) as { locked_by: string; locked_at: number };
    expect(seenByC.locked_by).toBe('job-a');
    expect(seenByC.locked_at).toBeLessThan(stale - STALE_MS);

    // B steals it first and commits.
    expect(claimOn(connB, 'job-b', stale)).toBe(true);

    // C now acts on the decision implied by its earlier read. The real claim
    // re-evaluates staleness inside the same statement that writes, so it sees
    // job-b's fresh lock and loses. A check-then-claim would blindly UPDATE and
    // steal from job-b.
    expect(claimOn(connC, 'job-c', stale)).toBe(false);

    const holder = connB
      .prepare('SELECT locked_by FROM collections WHERE chain_id = ? AND contract = ?')
      .get(CHAIN, CONTRACT) as { locked_by: string };
    expect(holder.locked_by).toBe('job-b');
  });

  it('makes a claim on one connection immediately visible to the other', () => {
    expect(claimOn(connB, 'job-a', T0)).toBe(true);
    expect(claimOn(connC, 'job-b', T0 + 1)).toBe(false);
  });
});

// THE DISCRIMINATOR for the atomicity property.
//
// The property is "the staleness predicate is evaluated in the same statement
// that writes the lock". That is a statement-count property, so test it directly
// instead of trying to manufacture an interleaving a synchronous driver cannot
// produce. A counting Proxy over the Database records every prepared statement:
// the real claim prepares exactly ONE, a check-then-claim prepares two.
//
// Mutation-verified: real implementation 1 statement, check-then-claim 2.
describe('claimCollection — single-statement atomicity', () => {
  function countingDb(target: Database.Database): {
    proxy: Database.Database; statements: string[];
  } {
    const statements: string[] = [];
    const proxy = new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (prop === 'prepare') {
          return (sql: string) => {
            statements.push(sql);
            return (value as Database.Database['prepare']).call(obj, sql);
          };
        }
        return typeof value === 'function' ? value.bind(obj) : value;
      },
    }) as Database.Database;
    return { proxy, statements };
  }

  it('prepares exactly one statement, so staleness cannot be tested separately', () => {
    const { proxy, statements } = countingDb(db);
    claimCollection(proxy, {
      chainId: CHAIN, contract: CONTRACT, jobId: 'job-a',
      clock: manualClock(T0), staleMs: STALE_MS,
    });
    // Two or more means the staleness check and the write are separable, which
    // is exactly the check-then-claim bug.
    expect(statements).toHaveLength(1);
  });

  it('that one statement both tests staleness and writes the lock', () => {
    const { proxy, statements } = countingDb(db);
    claimCollection(proxy, {
      chainId: CHAIN, contract: CONTRACT, jobId: 'job-a',
      clock: manualClock(T0), staleMs: STALE_MS,
    });
    const sql = statements[0] ?? '';
    expect(sql).toMatch(/ON CONFLICT/i);       // creates or takes over in one go
    expect(sql).toMatch(/locked_by IS NULL/i); // the staleness predicate...
    expect(sql).toMatch(/locked_at\s*</i);     // ...lives in the same statement
    expect(sql).toMatch(/SET\s+locked_by/i);   // and so does the write
  });

  it('still prepares one statement when stealing a stale lock', () => {
    claim('job-a', T0);
    const { proxy, statements } = countingDb(db);
    const won = claimCollection(proxy, {
      chainId: CHAIN, contract: CONTRACT, jobId: 'job-b',
      clock: manualClock(T0 + 600_000), staleMs: STALE_MS,
    });
    expect(won).toBe(true);
    expect(statements).toHaveLength(1);
  });
});

describe('releaseCollection', () => {
  // If A's lock went stale and B stole it, A finishing late must not unlock the
  // collection underneath B — which would leave B writing to an unlocked row.
  it('does not let a job whose lock was stolen release the new holder', () => {
    claim('job-a', T0);
    expect(claim('job-b', T0 + 600_000)).toBe(true);

    releaseCollection(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'job-a' });

    const row = db.prepare('SELECT locked_by FROM collections').get() as { locked_by: string | null };
    expect(row.locked_by).toBe('job-b');
    // B's lock is still effective against a newcomer.
    expect(claim('job-c', T0 + 600_001)).toBe(false);
  });

  it('is a no-op for a job that never held the lock', () => {
    claim('job-a', T0);
    releaseCollection(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'never-held' });
    const row = db.prepare('SELECT locked_by FROM collections').get() as { locked_by: string };
    expect(row.locked_by).toBe('job-a');
  });
});

describe('getCollection', () => {
  it('reports not_indexed when no row exists', () => {
    expect(getCollection(db, CHAIN, CONTRACT)).toEqual({ state: 'not_indexed' });
  });

  // The core guard: a claimed-but-unbootstrapped row must not read as indexed,
  // or callers get silently empty results instead of an error.
  it('reports not_indexed for a claimed but unbootstrapped row', () => {
    claim('job-a');
    expect(getCollection(db, CHAIN, CONTRACT)).toEqual({ state: 'not_indexed' });
  });

  // Deliberate: no third "in progress" state reaches callers. M2's analysis
  // paths must see an unbootstrapped row as un-indexed whether or not a job
  // currently holds the lock.
  it('still reports not_indexed while the lock is actively held', () => {
    expect(claim('job-a', T0)).toBe(true);
    const held = db.prepare('SELECT locked_by FROM collections').get() as { locked_by: string };
    expect(held.locked_by).toBe('job-a');
    expect(getCollection(db, CHAIN, CONTRACT)).toEqual({ state: 'not_indexed' });
  });

  it('reports indexed once bootstrap has completed', () => {
    claim('job-a');
    finishBootstrap(db, {
      chainId: CHAIN, contract: CONTRACT, standard: '721',
      deployBlock: 12287507, deployBlockSource: 'binary_search', name: 'BAYC',
    });
    expect(getCollection(db, CHAIN, CONTRACT)).toEqual({
      state: 'indexed', standard: '721', deployBlock: 12287507,
      lastIndexedBlock: 12287506, name: 'BAYC',
    });
  });
});

describe('deleteUnbootstrapped', () => {
  // transfers has ON DELETE CASCADE to collections, so an unguarded
  // DELETE FROM collections silently destroys every transfer for that
  // collection with no recovery path. These two tests pin the guards.
  it('does not cascade away transfers of a bootstrapped collection', () => {
    claim('job-a');
    finishBootstrap(db, {
      chainId: CHAIN, contract: CONTRACT, standard: '721',
      deployBlock: 100, deployBlockSource: 'override', name: null,
    });
    db.prepare(`
      INSERT INTO transfers
        (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
         block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
      VALUES (@chainId, @contract, '1', '1', '0x0', '0xaaa', '0xtx',
              1, 0, 0, '0xaaa', '0', 'mint')
    `).run({ chainId: CHAIN, contract: CONTRACT });

    deleteUnbootstrapped(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'job-a' });

    const n = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('removes the row a failed bootstrap created', () => {
    claim('job-a');
    deleteUnbootstrapped(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'job-a' });
    expect(getCollection(db, CHAIN, CONTRACT)).toEqual({ state: 'not_indexed' });
    expect(claim('job-b')).toBe(true);
  });

  it('never removes a bootstrapped collection', () => {
    claim('job-a');
    finishBootstrap(db, {
      chainId: CHAIN, contract: CONTRACT, standard: '721',
      deployBlock: 100, deployBlockSource: 'override', name: null,
    });
    deleteUnbootstrapped(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'job-a' });
    expect(getCollection(db, CHAIN, CONTRACT).state).toBe('indexed');
  });

  it('never removes a row another job holds', () => {
    claim('job-a');
    deleteUnbootstrapped(db, { chainId: CHAIN, contract: CONTRACT, jobId: 'job-b' });
    const row = db.prepare('SELECT locked_by FROM collections').get() as { locked_by: string };
    expect(row.locked_by).toBe('job-a');
  });
});

describe('advanceWatermark', () => {
  it('moves the watermark and refreshes the lock together', () => {
    claim('job-a', T0);
    finishBootstrap(db, {
      chainId: CHAIN, contract: CONTRACT, standard: '721',
      deployBlock: 100, deployBlockSource: 'override', name: null,
    });
    advanceWatermark(db, {
      chainId: CHAIN, contract: CONTRACT, jobId: 'job-a',
      toBlock: 500, clock: manualClock(T0 + 240_000),   // 4 min later
    });
    const state = getCollection(db, CHAIN, CONTRACT);
    expect(state).toMatchObject({ state: 'indexed', lastIndexedBlock: 500 });
    // The refreshed lock means a competing claim still fails at 12:06.
    expect(claim('job-b', T0 + 360_000)).toBe(false);   // 6 min: heartbeat kept it fresh
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run test/unit/collections.repo.test.ts`
Expected: FAIL — cannot resolve `../../src/db/repositories/collections.js`.

- [ ] **Step 5: Write `src/db/repositories/collections.ts`**

```ts
import type Database from 'better-sqlite3';
import type { Clock } from '../../clock.js';
import type { DeployBlockSource, Standard } from '../../types.js';

export type CollectionState =
  | { state: 'not_indexed' }
  | {
      state: 'indexed';
      standard: Standard;
      deployBlock: number;
      lastIndexedBlock: number;
      name: string | null;
    };

/**
 * Claims a collection, creating the row if this is its first sighting.
 *
 * An UPDATE would be a no-op when no row exists yet, which would let two
 * concurrent first-runs both bootstrap and both binary-search the deploy
 * block. The upsert makes creation and claiming one atomic statement.
 *
 * @returns true when this job now holds the lock.
 */
export function claimCollection(
  db: Database.Database,
  a: { chainId: number; contract: string; jobId: string; clock: Clock; staleMs: number },
): boolean {
  // Both values come from ONE clock read, so the write and the cutoff cannot
  // disagree. Epoch ms INTEGER throughout — SQLite's datetime() is never used.
  const nowMs = a.clock.now();
  const staleCutoff = nowMs - a.staleMs;
  const result = db
    .prepare(`
      INSERT INTO collections (chain_id, contract, locked_by, locked_at)
      VALUES (@chainId, @contract, @jobId, @nowMs)
      ON CONFLICT (chain_id, contract) DO UPDATE
         SET locked_by = excluded.locked_by,
             locked_at = excluded.locked_at
       WHERE collections.locked_by IS NULL
          OR collections.locked_at < @staleCutoff
    `)
    .run({ chainId: a.chainId, contract: a.contract, jobId: a.jobId, nowMs, staleCutoff });
  return result.changes === 1;
}

export function releaseCollection(
  db: Database.Database,
  a: { chainId: number; contract: string; jobId: string },
): void {
  db.prepare(`
    UPDATE collections SET locked_by = NULL, locked_at = NULL
     WHERE chain_id = @chainId AND contract = @contract AND locked_by = @jobId
  `).run(a);
}

/**
 * Removes the row a failed bootstrap created.
 *
 * Both guards matter: `standard IS NULL` means a retry racing a now-succeeding
 * job can never delete a real collection, and `locked_by = @jobId` means a job
 * cannot delete a row another job owns.
 */
export function deleteUnbootstrapped(
  db: Database.Database,
  a: { chainId: number; contract: string; jobId: string },
): void {
  db.prepare(`
    DELETE FROM collections
     WHERE chain_id = @chainId AND contract = @contract
       AND standard IS NULL
       AND locked_by = @jobId
  `).run(a);
}

export function finishBootstrap(
  db: Database.Database,
  a: {
    chainId: number; contract: string; standard: Standard;
    deployBlock: number; deployBlockSource: DeployBlockSource; name: string | null;
  },
): void {
  db.prepare(`
    UPDATE collections
       SET standard = @standard,
           name = @name,
           deploy_block = @deployBlock,
           deploy_block_source = @deployBlockSource,
           last_indexed_block = COALESCE(last_indexed_block, @deployBlock - 1)
     WHERE chain_id = @chainId AND contract = @contract
  `).run(a);
}

/**
 * The only collection lookup. Returns a tagged union rather than a raw row so
 * callers cannot forget the `standard IS NOT NULL` filter — an unbootstrapped
 * row surfacing as "indexed" would produce silently empty results instead of
 * an error.
 */
export function getCollection(
  db: Database.Database,
  chainId: number,
  contract: string,
): CollectionState {
  const row = db
    .prepare(`
      SELECT standard, name, deploy_block, last_indexed_block
        FROM collections
       WHERE chain_id = ? AND contract = ? AND standard IS NOT NULL
    `)
    .get(chainId, contract) as
    | { standard: Standard; name: string | null; deploy_block: number; last_indexed_block: number }
    | undefined;

  if (!row) return { state: 'not_indexed' };
  return {
    state: 'indexed',
    standard: row.standard,
    deployBlock: row.deploy_block,
    lastIndexedBlock: row.last_indexed_block,
    name: row.name,
  };
}

export function advanceWatermark(
  db: Database.Database,
  a: { chainId: number; contract: string; jobId: string; toBlock: number; clock: Clock },
): void {
  const nowMs = a.clock.now();
  db.prepare(`
    UPDATE collections
       SET last_indexed_block = @toBlock,
           indexed_at = @nowMs,
           locked_at = @nowMs
     WHERE chain_id = @chainId AND contract = @contract AND locked_by = @jobId
  `).run({ chainId: a.chainId, contract: a.contract, jobId: a.jobId, toBlock: a.toBlock, nowMs });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/jobId.test.ts test/unit/collections.repo.test.ts && npm run typecheck`
Expected: PASS — 4 job-id tests and 22 collections tests.

**Then mutation-verify the statement-count test, which is not optional** (see
CLAUDE.md, "Mutation verification is mandatory for property tests"). In a scratch
file OUTSIDE `src/`, write a check-then-claim shaped like the real bug:

```ts
// The mutant must be a BARE SELECT then a BARE UPDATE, each in its own implicit
// transaction. Wrapping both in one explicit transaction makes the mutant
// accidentally correct under WAL — the write would fail with SQLITE_BUSY_SNAPSHOT
// because the transaction read an older snapshot — and the test would then pass
// against a "bug" that cannot actually occur.
function badClaim(db: Database.Database, jobId: string, atMs: number): boolean {
  const row = db.prepare(
    'SELECT locked_by, locked_at FROM collections WHERE chain_id = ? AND contract = ?',
  ).get(CHAIN, CONTRACT) as { locked_by: string | null; locked_at: number | null } | undefined;
  if (!row) { /* insert and return true */ }
  const stale = row.locked_by === null || (row.locked_at ?? 0) < atMs - STALE_MS;
  if (!stale) return false;
  db.prepare(
    'UPDATE collections SET locked_by = ?, locked_at = ? WHERE chain_id = ? AND contract = ?',
  ).run(jobId, atMs, CHAIN, CONTRACT);
  return true;
}
```

Run it through the counting Proxy and report both statement counts: the real
`claimCollection` must prepare exactly 1, and `badClaim` must prepare 2. That is
the comparison that settles the property. Do NOT use the cross-connection
scenario as the mutation check — it was verified not to discriminate. **If the mutant also produces the correct result, the test
does not pin the property — say so plainly and record it as a gap rather than
shipping a test that cannot fail.** Delete the scratch file afterwards.

- [ ] **Step 7: Commit**

```bash
git add src/jobId.ts src/db/repositories/collections.ts test/unit/jobId.test.ts test/unit/collections.repo.test.ts
git commit -m "feat: collections repository with lock lifecycle and guarded reads

Claim is an atomic upsert so two concurrent first-runs on a never-seen
collection resolve to one winner. Failed bootstrap deletes its own row,
guarded on standard IS NULL and locked_by. getCollection returns
indexed | not_indexed so no caller can forget the standard IS NOT NULL
filter and report an unbootstrapped collection as empty.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Transfers repository and bound-variable chunking

**Files:**
- Create: `src/db/chunked.ts`, `src/db/repositories/transfers.ts`
- Test: `test/unit/chunked.test.ts`, `test/unit/transfers.repo.test.ts`

**Interfaces:**
- Consumes: `TransferRow`, `TxInfo` (Task 1); `openDb`, `runMigrations` (Task 3)

**Note on the foreign key:** `transfers` references `collections (chain_id, contract)` and
`foreign_keys` enforcement is ON, so every test in this file must insert a parent
`collections` row first. The repository itself needs no change — in production, bootstrap
always creates the collection before any transfer is inserted.
- Produces:
  - `chunked<T>(items: T[], size?: number): T[][]` (default size 500)
  - `insertTransfers(db, rows: TransferRow[]): number` (rows actually inserted)
  - `findKnownTxs(db, chainId: number, hashes: string[]): Map<string, TxInfo>`
  - `countByKind(db, chainId: number, contract: string): Record<Kind, number>`

- [ ] **Step 1: Write the failing tests**

`test/unit/chunked.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chunked } from '../../src/db/chunked.js';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('chunked', () => {
  it('returns nothing for an empty list', () => {
    expect(chunked([])).toEqual([]);
  });

  it('returns one group for a single item', () => {
    expect(chunked([1])).toEqual([[1]]);
  });

  it('returns one group at exactly the default size', () => {
    expect(chunked(range(500))).toHaveLength(1);
  });

  it('splits one past the default size', () => {
    const groups = chunked(range(501));
    expect(groups).toHaveLength(2);
    expect(groups[1]).toHaveLength(1);
  });

  it('splits 1000 into two full groups', () => {
    expect(chunked(range(1000)).map((g) => g.length)).toEqual([500, 500]);
  });

  it('honours an explicit size', () => {
    expect(chunked(range(5), 2).map((g) => g.length)).toEqual([2, 2, 1]);
  });
});
```

`test/unit/transfers.repo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  countByKind, findKnownTxs, insertTransfers,
} from '../../src/db/repositories/transfers.js';
import type { TransferRow } from '../../src/types.js';

const CONTRACT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';

function row(over: Partial<TransferRow> = {}): TransferRow {
  return {
    chainId: 1, contract: CONTRACT, tokenId: '1', amount: '1',
    fromAddr: '0x0000000000000000000000000000000000000000',
    toAddr: '0xaaa', txHash: '0xtx1', blockNumber: 100,
    logIndex: 0, batchIndex: 0, txFrom: '0xaaa',
    txValueWei: '0', kind: 'mint', ...over,
  };
}

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
  // transfers has a composite FK to collections (chain_id, contract) with
  // foreign_keys enforcement ON, so a parent row must exist before any insert.
  // Without this every test here fails on FOREIGN KEY constraint.
  db.prepare('INSERT INTO collections (chain_id, contract) VALUES (1, ?)').run(CONTRACT);
});

describe('insertTransfers', () => {
  it('inserts rows and reports the count', () => {
    expect(insertTransfers(db, [row(), row({ txHash: '0xtx2', tokenId: '2' })])).toBe(2);
  });

  it('is idempotent — re-inserting the same rows changes nothing', () => {
    const rows = [row(), row({ txHash: '0xtx2', tokenId: '2' })];
    insertTransfers(db, rows);
    expect(insertTransfers(db, rows)).toBe(0);
    const n = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('keeps every token of an ERC-1155 batch', () => {
    const batch = [0, 1, 2].map((i) =>
      row({ tokenId: String(i + 10), batchIndex: i, txHash: '0xbatch', logIndex: 4 }),
    );
    expect(insertTransfers(db, batch)).toBe(3);
  });

  it('stores a uint256 token id without precision loss', () => {
    const big = (2n ** 255n).toString();
    insertTransfers(db, [row({ tokenId: big, txHash: '0xbig' })]);
    const got = db.prepare('SELECT token_id FROM transfers WHERE tx_hash = ?')
      .get('0xbig') as { token_id: string };
    expect(got.token_id).toBe(big);
  });
});

describe('findKnownTxs', () => {
  it('returns tx info already stored, so a resume re-fetches nothing', () => {
    insertTransfers(db, [row({ txHash: '0xknown', txFrom: '0xbbb', txValueWei: '1000' })]);
    const found = findKnownTxs(db, 1, ['0xknown', '0xmissing']);
    expect(found.get('0xknown')).toEqual({ from: '0xbbb', value: 1000n });
    expect(found.has('0xmissing')).toBe(false);
  });

  it('handles more hashes than the bound-variable chunk size', () => {
    const rows = Array.from({ length: 600 }, (_, i) =>
      row({ txHash: `0x${i}`, tokenId: String(i) }),
    );
    insertTransfers(db, rows);
    const found = findKnownTxs(db, 1, rows.map((r) => r.txHash));
    expect(found.size).toBe(600);
  });

  it('returns an empty map for no hashes', () => {
    expect(findKnownTxs(db, 1, []).size).toBe(0);
  });
});

describe('countByKind', () => {
  it('counts each kind, defaulting missing kinds to zero', () => {
    insertTransfers(db, [
      row({ txHash: '0x1', kind: 'mint' }),
      row({ txHash: '0x2', kind: 'mint' }),
      row({ txHash: '0x3', kind: 'burn' }),
    ]);
    expect(countByKind(db, 1, CONTRACT)).toEqual({ mint: 2, buy: 0, transfer: 0, burn: 1 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/chunked.test.ts test/unit/transfers.repo.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/db/chunked.ts`**

```ts
/**
 * Splits a list so an `IN (...)` clause stays under SQLite's bound-variable
 * limit. 500 is well below the 32766 of modern SQLite and safe on older builds.
 */
export function chunked<T>(items: T[], size = 500): T[][] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
```

- [ ] **Step 4: Write `src/db/repositories/transfers.ts`**

```ts
import type Database from 'better-sqlite3';
import type { Kind, TransferRow, TxInfo } from '../../types.js';
import { chunked } from '../chunked.js';

const INSERT_SQL = `
  INSERT OR IGNORE INTO transfers
    (chain_id, contract, token_id, amount, from_addr, to_addr, tx_hash,
     block_number, log_index, batch_index, tx_from, tx_value_wei, kind)
  VALUES
    (@chainId, @contract, @tokenId, @amount, @fromAddr, @toAddr, @txHash,
     @blockNumber, @logIndex, @batchIndex, @txFrom, @txValueWei, @kind)
`;

/** @returns how many rows were actually inserted (duplicates are ignored). */
export function insertTransfers(db: Database.Database, rows: TransferRow[]): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(INSERT_SQL);
  let inserted = 0;
  for (const row of rows) {
    inserted += stmt.run(row).changes;
  }
  return inserted;
}

/**
 * Tx data already stored, so a resumed or overlapping backfill re-fetches
 * nothing. The IN list is chunked to stay under the bound-variable limit.
 */
export function findKnownTxs(
  db: Database.Database,
  chainId: number,
  hashes: string[],
): Map<string, TxInfo> {
  const out = new Map<string, TxInfo>();
  for (const group of chunked(hashes)) {
    const placeholders = group.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT DISTINCT tx_hash, tx_from, tx_value_wei
          FROM transfers
         WHERE chain_id = ? AND tx_hash IN (${placeholders})
      `)
      .all(chainId, ...group) as Array<{
        tx_hash: string; tx_from: string; tx_value_wei: string;
      }>;
    for (const row of rows) {
      out.set(row.tx_hash, {
        from: row.tx_from as TxInfo['from'],
        value: BigInt(row.tx_value_wei),
      });
    }
  }
  return out;
}

export function countByKind(
  db: Database.Database,
  chainId: number,
  contract: string,
): Record<Kind, number> {
  const counts: Record<Kind, number> = { mint: 0, buy: 0, transfer: 0, burn: 0 };
  const rows = db
    .prepare(`
      SELECT kind, COUNT(*) AS n FROM transfers
       WHERE chain_id = ? AND contract = ? GROUP BY kind
    `)
    .all(chainId, contract) as Array<{ kind: Kind; n: number }>;
  for (const row of rows) counts[row.kind] = row.n;
  return counts;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/chunked.test.ts test/unit/transfers.repo.test.ts && npm run typecheck`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/db/chunked.ts src/db/repositories/transfers.ts test/unit/chunked.test.ts test/unit/transfers.repo.test.ts
git commit -m "feat: transfers repository with idempotent insert and chunked IN lookup

findKnownTxs chunks its IN list at 500 bound variables; a large chunk of
unique tx hashes would otherwise exceed SQLite's limit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Log decoding for ERC-721 and ERC-1155

**Files:**
- Create: `src/indexer/decode.ts`, `test/fixtures/logs-721.json`, `test/fixtures/logs-1155-single.json`, `test/fixtures/logs-1155-batch.json`
- Test: `test/unit/decode.test.ts`

**Interfaces:**
- Consumes: `DecodedTransfer`, `Standard`, `Address`, `Hash` (Task 1)
- Produces:
  - `TRANSFER_TOPICS: Record<Standard, Hash[]>` — topic0 filters to pass to `getLogs`
  - `decodeTransferLog(log: RawLog, standard: Standard): DecodedTransfer[]`
  - `decodeLogs(logs: RawLog[], standard: Standard): DecodedTransfer[]`
  - `interface RawLog { topics: Hash[]; data: Hash; transactionHash: Hash; blockNumber: bigint; logIndex: number }`

Fixtures in this task are hand-written from the event ABIs so decoding can be tested before any RPC access exists. Task 14 adds fixtures captured from a real chain and asserts the decoder agrees with them.

- [ ] **Step 1: Write the fixtures**

`test/fixtures/logs-721.json` — one ERC-721 `Transfer`, a mint of token 1 to `0xaaa…aaa`. All three arguments are indexed, so `data` is empty.

```json
[
  {
    "topics": [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0x0000000000000000000000000000000000000000000000000000000000000001"
    ],
    "data": "0x",
    "transactionHash": "0x1111111111111111111111111111111111111111111111111111111111111111",
    "blockNumber": "100",
    "logIndex": 0
  }
]
```

`test/fixtures/logs-1155-single.json` — `TransferSingle`, id 7, amount 3. `operator`, `from`, `to` are indexed; `id` and `value` are in `data`.

```json
[
  {
    "topics": [
      "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
      "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ],
    "data": "0x00000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000003",
    "transactionHash": "0x2222222222222222222222222222222222222222222222222222222222222222",
    "blockNumber": "200",
    "logIndex": 5
  }
]
```

`test/fixtures/logs-1155-batch.json` — `TransferBatch`, ids `[10, 11]`, values `[1, 2]`. `data` holds two dynamic arrays: offsets `0x40` and `0xa0`, then each array's length followed by its elements.

```json
[
  {
    "topics": [
      "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb",
      "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ],
    "data": "0x000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000b00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000002",
    "transactionHash": "0x3333333333333333333333333333333333333333333333333333333333333333",
    "blockNumber": "300",
    "logIndex": 9
  }
]
```

- [ ] **Step 2: Write the failing test**

`test/unit/decode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeLogs, type RawLog } from '../../src/indexer/decode.js';

function load(name: string): RawLog[] {
  const raw = JSON.parse(
    readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as Array<Record<string, unknown>>;
  return raw.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber as string) })) as RawLog[];
}

describe('decodeLogs — ERC-721', () => {
  it('decodes a mint', () => {
    const [t] = decodeLogs(load('logs-721'), '721');
    expect(t).toEqual({
      tokenId: 1n,
      amount: 1n,
      from: '0x0000000000000000000000000000000000000000',
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      blockNumber: 100n,
      logIndex: 0,
      batchIndex: 0,
    });
  });

  it('lowercases addresses', () => {
    const [t] = decodeLogs(load('logs-721'), '721');
    expect(t?.to).toBe(t?.to.toLowerCase());
  });
});

describe('decodeLogs — ERC-1155 TransferSingle', () => {
  it('decodes id and amount from data', () => {
    const [t] = decodeLogs(load('logs-1155-single'), '1155');
    expect(t).toMatchObject({ tokenId: 7n, amount: 3n, logIndex: 5, batchIndex: 0 });
    expect(t?.from).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('decodeLogs — ERC-1155 TransferBatch', () => {
  it('expands one log into one transfer per id', () => {
    const out = decodeLogs(load('logs-1155-batch'), '1155');
    expect(out).toHaveLength(2);
  });

  // The whole reason batch_index exists: these rows share tx_hash and log_index.
  it('numbers batch_index by array position while sharing tx hash and log index', () => {
    const out = decodeLogs(load('logs-1155-batch'), '1155');
    expect(out.map((t) => t.batchIndex)).toEqual([0, 1]);
    expect(out.map((t) => t.tokenId)).toEqual([10n, 11n]);
    expect(out.map((t) => t.amount)).toEqual([1n, 2n]);
    expect(new Set(out.map((t) => t.logIndex)).size).toBe(1);
    expect(new Set(out.map((t) => t.txHash)).size).toBe(1);
  });
});

describe('decodeLogs — standard isolation', () => {
  it('ignores a 1155 log when decoding as 721', () => {
    expect(decodeLogs(load('logs-1155-batch'), '721')).toEqual([]);
  });

  it('ignores a 721 log when decoding as 1155', () => {
    expect(decodeLogs(load('logs-721'), '1155')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/unit/decode.test.ts`
Expected: FAIL — cannot resolve `../../src/indexer/decode.js`.

- [ ] **Step 4: Write `src/indexer/decode.ts`**

```ts
import { decodeEventLog, parseAbi } from 'viem';
import type { Address, DecodedTransfer, Hash, Standard } from '../types.js';

export interface RawLog {
  topics: Hash[];
  data: Hash;
  transactionHash: Hash;
  blockNumber: bigint;
  logIndex: number;
}

const ERC721_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);
const ERC1155_ABI = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
]);

const TOPIC_721_TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
const TOPIC_1155_SINGLE =
  '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62' as const;
const TOPIC_1155_BATCH =
  '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb' as const;

/** topic0 filters to pass to getLogs, per standard. */
export const TRANSFER_TOPICS: Record<Standard, Hash[]> = {
  '721': [TOPIC_721_TRANSFER],
  '1155': [TOPIC_1155_SINGLE, TOPIC_1155_BATCH],
};

const lower = (a: string): Address => a.toLowerCase() as Address;

export function decodeTransferLog(log: RawLog, standard: Standard): DecodedTransfer[] {
  const topic0 = log.topics[0];
  if (!topic0 || !TRANSFER_TOPICS[standard].includes(topic0)) return [];

  const common = {
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  };

  if (standard === '721') {
    // An ERC-721 Transfer has three indexed args, so topics.length is 4. An
    // ERC-20 Transfer shares topic0 but indexes only two, so this rejects it.
    if (log.topics.length !== 4) return [];
    const { args } = decodeEventLog({ abi: ERC721_ABI, topics: log.topics, data: log.data });
    return [{
      ...common,
      tokenId: args.tokenId,
      amount: 1n,
      from: lower(args.from),
      to: lower(args.to),
      batchIndex: 0,
    }];
  }

  if (topic0 === TOPIC_1155_SINGLE) {
    const { args } = decodeEventLog({ abi: ERC1155_ABI, topics: log.topics, data: log.data });
    if (!('id' in args)) return [];
    return [{
      ...common,
      tokenId: args.id,
      amount: args.value,
      from: lower(args.from),
      to: lower(args.to),
      batchIndex: 0,
    }];
  }

  const { args } = decodeEventLog({ abi: ERC1155_ABI, topics: log.topics, data: log.data });
  if (!('ids' in args)) return [];
  // One log, many tokens. batchIndex disambiguates rows that otherwise share
  // (chain_id, tx_hash, log_index) and would collide on the primary key.
  return args.ids.map((tokenId, i) => ({
    ...common,
    tokenId,
    amount: args.values[i] ?? 0n,
    from: lower(args.from),
    to: lower(args.to),
    batchIndex: i,
  }));
}

export function decodeLogs(logs: RawLog[], standard: Standard): DecodedTransfer[] {
  return logs.flatMap((log) => decodeTransferLog(log, standard));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/unit/decode.test.ts && npm run typecheck`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/decode.ts test/fixtures/ test/unit/decode.test.ts
git commit -m "feat: decode ERC-721 Transfer and ERC-1155 TransferSingle/Batch

TransferBatch expands one log into one transfer per id, numbered by
batchIndex, since those rows share tx_hash and log_index.

721 decoding requires four topics, which rejects ERC-20 Transfer events
that share the same topic0 but index only two arguments.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Transfer classification

**Files:**
- Create: `src/indexer/classify.ts`
- Test: `test/unit/classify.test.ts`

**Interfaces:**
- Consumes: `DecodedTransfer`, `TxInfo`, `Kind`, `ZERO_ADDRESS` (Task 1)
- Produces: `classify(transfer: Pick<DecodedTransfer, 'from' | 'to'>, tx: TxInfo): Kind`

- [ ] **Step 1: Write the failing test**

`test/unit/classify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classify } from '../../src/indexer/classify.js';
import { ZERO_ADDRESS, type Address } from '../../src/types.js';

const BUYER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const SELLER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const ROUTER = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;

describe('classify', () => {
  it('calls a transfer from the zero address a mint', () => {
    expect(classify({ from: ZERO_ADDRESS, to: BUYER }, { from: BUYER, value: 0n })).toBe('mint');
  });

  it('still calls a paid mint a mint, not a buy', () => {
    expect(classify({ from: ZERO_ADDRESS, to: BUYER }, { from: BUYER, value: 10n })).toBe('mint');
  });

  it('calls a transfer to the zero address a burn', () => {
    expect(classify({ from: SELLER, to: ZERO_ADDRESS }, { from: SELLER, value: 0n })).toBe('burn');
  });

  it('calls a paid transfer to the tx sender a buy', () => {
    expect(classify({ from: SELLER, to: BUYER }, { from: BUYER, value: 10n })).toBe('buy');
  });

  it('calls an unpaid transfer a transfer', () => {
    expect(classify({ from: SELLER, to: BUYER }, { from: BUYER, value: 0n })).toBe('transfer');
  });

  // Known limitation, asserted so it is a decision rather than an accident.
  it('calls a paid transfer to someone other than the tx sender a transfer', () => {
    expect(classify({ from: SELLER, to: BUYER }, { from: ROUTER, value: 10n })).toBe('transfer');
  });

  it('compares addresses case-insensitively', () => {
    expect(classify(
      { from: SELLER, to: BUYER.toUpperCase() as Address },
      { from: BUYER, value: 10n },
    )).toBe('buy');
  });

  it('treats a zero-to-zero transfer as a mint, matching rule order', () => {
    expect(classify(
      { from: ZERO_ADDRESS, to: ZERO_ADDRESS },
      { from: BUYER, value: 0n },
    )).toBe('mint');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/classify.test.ts`
Expected: FAIL — cannot resolve `../../src/indexer/classify.js`.

- [ ] **Step 3: Write `src/indexer/classify.ts`**

```ts
import { ZERO_ADDRESS, type DecodedTransfer, type Kind, type TxInfo } from '../types.js';

/**
 * Rules are applied in order, so a paid mint stays a mint.
 *
 * Known limitation: a sale paid in WETH or another ERC-20 carries tx.value 0
 * and classifies as `transfer`. So does a purchase routed through a contract,
 * where tx.from is the router rather than the recipient.
 */
export function classify(
  transfer: Pick<DecodedTransfer, 'from' | 'to'>,
  tx: TxInfo,
): Kind {
  const from = transfer.from.toLowerCase();
  const to = transfer.to.toLowerCase();

  if (from === ZERO_ADDRESS) return 'mint';
  if (to === ZERO_ADDRESS) return 'burn';
  if (tx.value > 0n && tx.from.toLowerCase() === to) return 'buy';
  return 'transfer';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/classify.test.ts && npm run typecheck`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/classify.ts test/unit/classify.test.ts
git commit -m "feat: classify transfers as mint, burn, buy, or transfer

Rules apply in order so a paid mint stays a mint. ERC-20-paid sales and
router-mediated purchases classify as transfer; both are asserted as
known limitations rather than left to chance.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Rate limiter and chain client registry

**Files:**
- Create: `src/chain/rateLimit.ts`, `src/chain/client.ts`
- Test: `test/unit/rateLimit.test.ts`

**Interfaces:**
- Consumes: `ChainConfig`, `Config` (Task 1)
- Produces:
  - `createRateLimiter(requestsPerSecond: number, now?: () => number): <T>(fn: () => Promise<T>) => Promise<T>`
  - `getClient(chainId: number, config: Config): PublicClient`
  - `resetClients(): void`

- [ ] **Step 1: Write the failing test**

`test/unit/rateLimit.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../../src/chain/rateLimit.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('createRateLimiter', () => {
  it('runs calls within the budget immediately', async () => {
    const limit = createRateLimiter(10);
    const results = await Promise.all([limit(async () => 1), limit(async () => 2)]);
    expect(results).toEqual([1, 2]);
  });

  it('delays a call that exceeds the per-second budget', async () => {
    const limit = createRateLimiter(2);
    const done: number[] = [];
    const pending = Promise.all([
      limit(async () => { done.push(1); }),
      limit(async () => { done.push(2); }),
      limit(async () => { done.push(3); }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(done).toEqual([1, 2, 3]);
  });

  it('propagates the rejection of a limited call', async () => {
    const limit = createRateLimiter(10);
    await expect(limit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  it('releases its slot after a failure so later calls still run', async () => {
    const limit = createRateLimiter(1);
    await expect(limit(async () => { throw new Error('boom'); })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(limit(async () => 'ok')).resolves.toBe('ok');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/rateLimit.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/rateLimit.js`.

- [ ] **Step 3: Write `src/chain/rateLimit.ts`**

```ts
/**
 * Token bucket. Returns a wrapper that delays a call until a token is free,
 * so a long backfill cannot trip provider rate limits.
 */
export function createRateLimiter(
  requestsPerSecond: number,
): <T>(fn: () => Promise<T>) => Promise<T> {
  const intervalMs = 1000 / requestsPerSecond;
  let nextSlot = 0;

  return async function limited<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + intervalMs;
    const wait = slot - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    // The slot is consumed whether or not fn succeeds, so a failure cannot
    // starve later calls.
    return fn();
  };
}
```

- [ ] **Step 4: Write `src/chain/client.ts`**

```ts
import { createPublicClient, http, type PublicClient } from 'viem';
import type { Config } from '../config.js';
import { ConfigError } from '../errors.js';

const clients = new Map<number, PublicClient>();

/**
 * Memoized public client per chain. Read-only: this project never signs, so no
 * wallet client exists anywhere in the codebase.
 */
export function getClient(chainId: number, config: Config): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;

  const chain = config.chains.get(chainId);
  if (!chain) {
    throw new ConfigError(
      `chain ${chainId} is not configured. Set RPC_URL_${chainId} and add it to config/chains.json.`,
    );
  }

  const client = createPublicClient({
    transport: http(chain.rpcUrl, {
      retryCount: 3,
      retryDelay: 250,
      // Coalesces concurrent calls into JSON-RPC batch requests, which is what
      // makes per-tx enrichment affordable without manual batching.
      batch: { batchSize: 50, wait: 10 },
    }),
  });
  clients.set(chainId, client);
  return client;
}

export function resetClients(): void {
  clients.clear();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/rateLimit.test.ts && npm run typecheck`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/chain/rateLimit.ts src/chain/client.ts test/unit/rateLimit.test.ts
git commit -m "feat: token-bucket rate limiter and memoized public client per chain

Public clients only; no wallet client exists in this codebase. The HTTP
transport batches concurrent calls, which is what makes per-tx enrichment
affordable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Adaptive chunked getLogs

**Files:**
- Create: `src/indexer/logs.ts`
- Test: `test/unit/logs.test.ts`

**Interfaces:**
- Consumes: `RawLog` (Task 6); `RangeExhaustedError` (Task 1)
- Produces:
  - `isRangeError(err: unknown): boolean`
  - `interface LogFetcher { (a: { fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]> }`
  - `iterateLogs(a: { fetch: LogFetcher; fromBlock: bigint; toBlock: bigint; initialChunk: number; maxChunk: number; maxHalvings?: number }): AsyncGenerator<{ fromBlock: bigint; toBlock: bigint; logs: RawLog[] }>`

The generator takes a `fetch` function rather than a viem client, so the adaptive-range behaviour is testable without mocking a whole client.

- [ ] **Step 1: Write the failing test**

`test/unit/logs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isRangeError, iterateLogs } from '../../src/indexer/logs.js';
import { RangeExhaustedError } from '../../src/errors.js';
import type { RawLog } from '../../src/indexer/decode.js';

const rangeMessages = [
  'query returned more than 10000 results',
  'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range',
  'block range is too wide',
  'exceed maximum block range: 5000',
  'query exceeds max results 10000',
];

describe('isRangeError', () => {
  it.each(rangeMessages)('recognises %s', (message) => {
    expect(isRangeError(new Error(message))).toBe(true);
  });

  it('recognises the -32005 limit-exceeded code', () => {
    expect(isRangeError(Object.assign(new Error('limit exceeded'), { code: -32005 }))).toBe(true);
  });

  it('recognises a nested cause', () => {
    const outer = new Error('request failed');
    (outer as Error & { cause?: unknown }).cause = new Error('block range is too wide');
    expect(isRangeError(outer)).toBe(true);
  });

  it('does not treat an unrelated error as a range error', () => {
    expect(isRangeError(new Error('ECONNRESET'))).toBe(false);
  });

  it('does not treat a non-error as a range error', () => {
    expect(isRangeError(null)).toBe(false);
  });
});

describe('iterateLogs', () => {
  const emptyFetch = async () => [];

  it('covers the whole span with inclusive, non-overlapping chunks', async () => {
    const seen: Array<[bigint, bigint]> = [];
    for await (const chunk of iterateLogs({
      fetch: async ({ fromBlock, toBlock }) => { seen.push([fromBlock, toBlock]); return []; },
      fromBlock: 0n, toBlock: 250n, initialChunk: 100, maxChunk: 100,
    })) {
      expect(chunk.logs).toEqual([]);
    }
    expect(seen).toEqual([[0n, 99n], [100n, 199n], [200n, 250n]]);
  });

  it('grows the range by 1.25x on success, capped at maxChunk', async () => {
    const sizes: number[] = [];
    for await (const _ of iterateLogs({
      fetch: async ({ fromBlock, toBlock }) => {
        sizes.push(Number(toBlock - fromBlock) + 1);
        return [];
      },
      fromBlock: 0n, toBlock: 10_000n, initialChunk: 100, maxChunk: 160,
    })) { /* drain */ }
    expect(sizes[0]).toBe(100);
    expect(sizes[1]).toBe(125);
    expect(sizes[2]).toBe(156);
    expect(sizes[3]).toBe(160); // capped
    expect(Math.max(...sizes)).toBe(160);
  });

  it('halves the range on a provider range error and retries the same start', async () => {
    const attempts: Array<[bigint, bigint]> = [];
    let failures = 2;
    for await (const _ of iterateLogs({
      fetch: async ({ fromBlock, toBlock }) => {
        attempts.push([fromBlock, toBlock]);
        if (failures-- > 0) throw new Error('query returned more than 10000 results');
        return [];
      },
      fromBlock: 0n, toBlock: 99n, initialChunk: 100, maxChunk: 100,
    })) { /* drain */ }
    expect(attempts[0]).toEqual([0n, 99n]);
    expect(attempts[1]).toEqual([0n, 49n]);
    expect(attempts[2]).toEqual([0n, 24n]);
  });

  it('never halves below a single block', async () => {
    let calls = 0;
    const gen = iterateLogs({
      fetch: async () => {
        calls += 1;
        throw new Error('query returned more than 10000 results');
      },
      fromBlock: 0n, toBlock: 10n, initialChunk: 4, maxChunk: 4, maxHalvings: 10,
    });
    await expect(gen.next()).rejects.toThrow(RangeExhaustedError);
    expect(calls).toBeLessThanOrEqual(11);
  });

  it('gives up after maxHalvings rather than looping unbounded', async () => {
    const gen = iterateLogs({
      fetch: async () => { throw new Error('block range is too wide'); },
      fromBlock: 0n, toBlock: 10_000n, initialChunk: 1000, maxChunk: 1000, maxHalvings: 2,
    });
    await expect(gen.next()).rejects.toThrow(RangeExhaustedError);
  });

  it('rethrows an error that is not a range error', async () => {
    const gen = iterateLogs({
      fetch: async () => { throw new Error('ECONNRESET'); },
      fromBlock: 0n, toBlock: 10n, initialChunk: 10, maxChunk: 10,
    });
    await expect(gen.next()).rejects.toThrow('ECONNRESET');
  });

  it('yields nothing when the span is empty', async () => {
    const chunks = [];
    for await (const c of iterateLogs({
      fetch: emptyFetch, fromBlock: 100n, toBlock: 99n, initialChunk: 10, maxChunk: 10,
    })) chunks.push(c);
    expect(chunks).toEqual([]);
  });

  it('passes logs through', async () => {
    const log = { logIndex: 0 } as RawLog;
    const chunks = [];
    for await (const c of iterateLogs({
      fetch: async () => [log], fromBlock: 0n, toBlock: 5n, initialChunk: 10, maxChunk: 10,
    })) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.logs).toEqual([log]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/logs.test.ts`
Expected: FAIL — cannot resolve `../../src/indexer/logs.js`.

- [ ] **Step 3: Write `src/indexer/logs.ts`**

```ts
import { RangeExhaustedError } from '../errors.js';
import type { RawLog } from './decode.js';

const RANGE_PATTERNS = [
  'more than 10000 results',
  'max results',
  'block range is too wide',
  'block range too large',
  'exceed maximum block range',
  'response size exceeded',
  'query timeout exceeded',
  'log response size exceeded',
];

const RANGE_CODES = new Set([-32005, -32602]);

/**
 * True when a provider refused a getLogs call because the range or result set
 * was too large. Every provider phrases this differently, so all matching
 * lives here: adding a provider means editing one function.
 */
export function isRangeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number' && RANGE_CODES.has(code)) return true;

  const message = String((err as { message?: unknown }).message ?? '').toLowerCase();
  if (RANGE_PATTERNS.some((p) => message.includes(p))) return true;

  const cause = (err as { cause?: unknown }).cause;
  return cause ? isRangeError(cause) : false;
}

export interface LogFetcher {
  (a: { fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]>;
}

/**
 * Walks [fromBlock, toBlock] in inclusive, non-overlapping chunks, shrinking
 * the range when the provider complains and growing it when it does not.
 *
 * Two caps prevent an unbounded loop: the range never falls below one block,
 * and a chunk that still fails after `maxHalvings` attempts throws.
 */
export async function* iterateLogs(a: {
  fetch: LogFetcher;
  fromBlock: bigint;
  toBlock: bigint;
  initialChunk: number;
  maxChunk: number;
  maxHalvings?: number;
}): AsyncGenerator<{ fromBlock: bigint; toBlock: bigint; logs: RawLog[] }> {
  const maxHalvings = a.maxHalvings ?? 12;
  let range = BigInt(Math.max(1, a.initialChunk));
  const maxChunk = BigInt(Math.max(1, a.maxChunk));
  let cursor = a.fromBlock;

  while (cursor <= a.toBlock) {
    let halvings = 0;

    for (;;) {
      const end = min(cursor + range - 1n, a.toBlock);
      try {
        const logs = await a.fetch({ fromBlock: cursor, toBlock: end });
        yield { fromBlock: cursor, toBlock: end, logs };
        cursor = end + 1n;
        range = min((range * 5n) / 4n, maxChunk);
        break;
      } catch (err) {
        if (!isRangeError(err)) throw err;
        if (range === 1n || halvings >= maxHalvings) {
          throw new RangeExhaustedError(
            `getLogs still failing at range ${range} block(s) from ${cursor} after ` +
            `${halvings} halving(s): ${String((err as Error).message)}`,
          );
        }
        range = max(range / 2n, 1n);
        halvings += 1;
      }
    }
  }
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/logs.test.ts && npm run typecheck`
Expected: PASS, 14 tests.

Note on the growth assertion: `100 → 125 → 156 → 195` capped to `160`. If the observed sequence differs, fix the *test* to match integer `(range * 5n) / 4n` truncation rather than changing the implementation to chase the numbers.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/logs.ts test/unit/logs.test.ts
git commit -m "feat: adaptive chunked getLogs with provider range-error detection

Halves on a range error, grows 1.25x on success, capped at maxChunk.
Never halves below one block and gives up after maxHalvings, so a
provider that always refuses cannot spin forever.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: ERC-165 standard detection

**Files:**
- Create: `src/chain/standard.ts`
- Test: `test/unit/standard.test.ts`

**Interfaces:**
- Consumes: `Standard`, `Address` (Task 1); `UnsupportedStandardError` (Task 1)
- Produces:
  - `INTERFACE_IDS = { erc721: '0x80ac58cd', erc1155: '0xd9b67a26', erc721Enumerable: '0x780e9d63' }`
  - `interface SupportsInterface { (interfaceId: `0x${string}`): Promise<boolean> }`
  - `detectStandard(supports: SupportsInterface, address: Address): Promise<Standard>`
  - `supportsEnumerable(supports: SupportsInterface): Promise<boolean>`
  - `makeSupportsInterface(client: PublicClient, address: Address): SupportsInterface`

Detection takes a `supports` function rather than a client so the branch logic is testable without a chain.

- [ ] **Step 1: Write the failing test**

`test/unit/standard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { INTERFACE_IDS, detectStandard, supportsEnumerable } from '../../src/chain/standard.js';
import { UnsupportedStandardError } from '../../src/errors.js';
import type { Address } from '../../src/types.js';

const ADDRESS = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d' as Address;
const answering = (ids: string[]) => async (id: `0x${string}`) => ids.includes(id);

describe('detectStandard', () => {
  it('detects ERC-721', async () => {
    expect(await detectStandard(answering([INTERFACE_IDS.erc721]), ADDRESS)).toBe('721');
  });

  it('detects ERC-1155', async () => {
    expect(await detectStandard(answering([INTERFACE_IDS.erc1155]), ADDRESS)).toBe('1155');
  });

  it('rejects a contract supporting neither', async () => {
    await expect(detectStandard(answering([]), ADDRESS)).rejects.toThrow(UnsupportedStandardError);
  });

  // Claiming both is a broken or hostile contract; guessing would silently
  // decode the wrong events.
  it('rejects a contract claiming both', async () => {
    const both = answering([INTERFACE_IDS.erc721, INTERFACE_IDS.erc1155]);
    await expect(detectStandard(both, ADDRESS)).rejects.toThrow(UnsupportedStandardError);
  });

  it('treats a reverting supportsInterface as unsupported, not a crash', async () => {
    const reverting = async () => { throw new Error('execution reverted'); };
    await expect(detectStandard(reverting, ADDRESS)).rejects.toThrow(UnsupportedStandardError);
  });

  it('names the address in the error so the message is actionable', async () => {
    await expect(detectStandard(answering([]), ADDRESS)).rejects.toThrow(ADDRESS);
  });
});

describe('supportsEnumerable', () => {
  it('is true when the Enumerable interface id is supported', async () => {
    expect(await supportsEnumerable(answering([INTERFACE_IDS.erc721Enumerable]))).toBe(true);
  });

  // totalSupply() is Enumerable, not base ERC-721 — asserting against it
  // unconditionally would fail on most collections.
  it('is false for a base ERC-721', async () => {
    expect(await supportsEnumerable(answering([INTERFACE_IDS.erc721]))).toBe(false);
  });

  it('is false when the call reverts', async () => {
    expect(await supportsEnumerable(async () => { throw new Error('reverted'); })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/standard.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/standard.js`.

- [ ] **Step 3: Write `src/chain/standard.ts`**

```ts
import { parseAbi, type PublicClient } from 'viem';
import { UnsupportedStandardError } from '../errors.js';
import type { Address, Standard } from '../types.js';

export const INTERFACE_IDS = {
  erc721: '0x80ac58cd',
  erc1155: '0xd9b67a26',
  /** totalSupply() lives here, not in base ERC-721. */
  erc721Enumerable: '0x780e9d63',
} as const;

const ERC165_ABI = parseAbi([
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
]);

export interface SupportsInterface {
  (interfaceId: `0x${string}`): Promise<boolean>;
}

export function makeSupportsInterface(
  client: PublicClient,
  address: Address,
): SupportsInterface {
  return async (interfaceId) => {
    const result = await client.readContract({
      address,
      abi: ERC165_ABI,
      functionName: 'supportsInterface',
      args: [interfaceId],
    });
    return Boolean(result);
  };
}

export async function detectStandard(
  supports: SupportsInterface,
  address: Address,
): Promise<Standard> {
  const [is721, is1155] = await Promise.all([
    safeSupports(supports, INTERFACE_IDS.erc721),
    safeSupports(supports, INTERFACE_IDS.erc1155),
  ]);

  if (is721 && is1155) {
    throw new UnsupportedStandardError(
      `${address} claims both ERC-721 and ERC-1155; refusing to guess. ` +
      'Pass --standard to override.',
    );
  }
  if (is721) return '721';
  if (is1155) return '1155';

  throw new UnsupportedStandardError(
    `${address} supports neither ERC-721 (0x80ac58cd) nor ERC-1155 (0xd9b67a26). ` +
    'Pre-ERC-165 collections need --standard.',
  );
}

export async function supportsEnumerable(supports: SupportsInterface): Promise<boolean> {
  return safeSupports(supports, INTERFACE_IDS.erc721Enumerable);
}

/** A contract without ERC-165 reverts rather than returning false. */
async function safeSupports(
  supports: SupportsInterface,
  interfaceId: `0x${string}`,
): Promise<boolean> {
  try {
    return await supports(interfaceId);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/standard.test.ts && npm run typecheck`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chain/standard.ts test/unit/standard.test.ts
git commit -m "feat: ERC-165 standard detection plus Enumerable support check

A contract claiming both standards is rejected rather than guessed at.
supportsEnumerable exists because totalSupply() is ERC-721 Enumerable,
not base ERC-721, so the integration assertion must detect it first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Deploy-block resolution with archive guard

**Files:**
- Create: `src/chain/deployBlock.ts`
- Test: `test/unit/deployBlock.test.ts`

**Interfaces:**
- Consumes: `DeployBlockUnavailableError` (Task 1); `ChainConfig` (Task 1); `Address` (Task 1); `classifyProbeError`, `ProbeOutcome` from `src/chain/probeErrors.ts` (built in Task 1's fix round, already tested there — do not rewrite it)
- Produces:
  - `interface CodeReader { (a: { address: Address; blockNumber: bigint }): Promise<string> }`
  - `probeArchive(getCode: CodeReader, probe: { address: Address; block: number }, opts?: { attempts?: number }): Promise<boolean>`
  - `binarySearchDeployBlock(getCode: CodeReader, address: Address, safeHead: bigint): Promise<bigint>`
  - `fetchCreationBlockFromExplorer(a: { chainId, address, apiKey, fetchFn? }): Promise<number | undefined>`
  - `resolveDeployBlock(a: { getCode, chainId, address, safeHead, archiveProbe, override?, etherscanApiKey?, fetchFn? }): Promise<{ block: number; source: DeployBlockSource }>`

- [ ] **Step 1: Write the failing test**

`test/unit/deployBlock.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  binarySearchDeployBlock, probeArchive, resolveDeployBlock,
} from '../../src/chain/deployBlock.js';
import { DeployBlockUnavailableError } from '../../src/errors.js';
import type { Address } from '../../src/types.js';

const ADDRESS = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d' as Address;
const PROBE = { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as Address, block: 4719569 };

/** An archive node: code exists at and after `deployedAt`. */
const archiveNode = (deployedAt: bigint) =>
  async ({ blockNumber }: { blockNumber: bigint }) =>
    (blockNumber >= deployedAt ? '0xdeadbeef' : '0x');

/** A pruned node: only recent state is available, older calls return empty. */
const prunedNode = (horizon: bigint) =>
  async ({ blockNumber }: { blockNumber: bigint }) =>
    (blockNumber >= horizon ? '0xdeadbeef' : '0x');

describe('binarySearchDeployBlock', () => {
  it('finds the exact deploy block', async () => {
    expect(await binarySearchDeployBlock(archiveNode(12287507n), ADDRESS, 21000000n))
      .toBe(12287507n);
  });

  it('finds a deploy at block zero', async () => {
    expect(await binarySearchDeployBlock(archiveNode(0n), ADDRESS, 1000n)).toBe(0n);
  });

  it('finds a deploy at the head itself', async () => {
    expect(await binarySearchDeployBlock(archiveNode(1000n), ADDRESS, 1000n)).toBe(1000n);
  });

  it('errors when there is no code at safeHead', async () => {
    await expect(binarySearchDeployBlock(archiveNode(5000n), ADDRESS, 1000n))
      .rejects.toThrow(DeployBlockUnavailableError);
  });

  it('uses a logarithmic number of calls', async () => {
    const getCode = vi.fn(archiveNode(12287507n));
    await binarySearchDeployBlock(getCode, ADDRESS, 21000000n);
    expect(getCode.mock.calls.length).toBeLessThan(40);
  });
});

describe('probeArchive', () => {
  it('passes when the probe contract has code at its historical block', async () => {
    expect(await probeArchive(archiveNode(4000000n), PROBE)).toBe(true);
  });

  // The failure this guard exists for: a pruned node returns empty for old
  // blocks, which a naive binary search reads as "not deployed yet" and
  // converges on the pruning horizon instead of the real deploy block.
  it('fails on a pruned node', async () => {
    expect(await probeArchive(prunedNode(20000000n), PROBE)).toBe(false);
  });

  // A pruned node usually THROWS rather than returning empty bytes, and the
  // wording varies by client. Both shapes must mean the same thing: probe
  // fails, binary search is disabled, the run continues.
  it.each([
    'missing trie node 0xabc (path )',
    'state not available for block 100000',
    'Requested resource not found.',
    'header not found',
  ])('treats a thrown state-unavailable error as a failed probe: %s', async (message) => {
    const throwing = async () => { throw new Error(message); };
    expect(await probeArchive(throwing, PROBE)).toBe(false);
  });

  it('does not throw out of probeArchive on any error', async () => {
    const throwing = async () => { throw new Error('missing trie node'); };
    await expect(probeArchive(throwing, PROBE)).resolves.toBe(false);
  });

  // A timeout is not evidence about archive capability, so it is retried
  // before the probe gives up — otherwise one slow cold read would wrongly
  // disable deploy-block search for the whole chain.
  it('retries a transient error, then succeeds', async () => {
    let calls = 0;
    const flaky = async ({ blockNumber }: { blockNumber: bigint }) => {
      calls += 1;
      if (calls === 1) throw new Error('The request took too long to respond.');
      return blockNumber >= 4000000n ? '0xdeadbeef' : '0x';
    };
    expect(await probeArchive(flaky, PROBE, { attempts: 3 })).toBe(true);
    expect(calls).toBe(2);
  });

  it('gives up after the attempt cap on a persistently transient error', async () => {
    let calls = 0;
    const timingOut = async () => {
      calls += 1;
      throw new Error('ETIMEDOUT');
    };
    expect(await probeArchive(timingOut, PROBE, { attempts: 3 })).toBe(false);
    expect(calls).toBe(3);
  });

  it('does not retry a state-unavailable error — it is a verdict, not a blip', async () => {
    let calls = 0;
    const pruned = async () => {
      calls += 1;
      throw new Error('missing trie node');
    };
    expect(await probeArchive(pruned, PROBE, { attempts: 3 })).toBe(false);
    expect(calls).toBe(1);
  });
});

describe('resolveDeployBlock', () => {
  const base = {
    getCode: archiveNode(12287507n),
    chainId: 1,
    address: ADDRESS,
    safeHead: 21000000n,
    archiveProbe: PROBE,
  };

  it('prefers an explicit override and makes no chain call', async () => {
    const getCode = vi.fn(archiveNode(12287507n));
    const result = await resolveDeployBlock({ ...base, getCode, override: 999 });
    expect(result).toEqual({ block: 999, source: 'override' });
    expect(getCode).not.toHaveBeenCalled();
  });

  it('falls back to the explorer when no override is given', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      status: '1', result: [{ blockNumber: '12287507' }],
    })));
    const result = await resolveDeployBlock({
      ...base, etherscanApiKey: 'KEY', fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ block: 12287507, source: 'explorer' });
  });

  it('falls through to binary search when the explorer has no answer', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ status: '0', result: [] }));
    const result = await resolveDeployBlock({
      ...base, etherscanApiKey: 'KEY', fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ block: 12287507, source: 'binary_search' });
  });

  it('binary searches when the archive probe passes and no explorer key is set', async () => {
    expect(await resolveDeployBlock(base)).toEqual({
      block: 12287507, source: 'binary_search',
    });
  });

  it('refuses to binary search against a pruned node', async () => {
    await expect(resolveDeployBlock({ ...base, getCode: prunedNode(20000000n) }))
      .rejects.toThrow(DeployBlockUnavailableError);
  });

  it('names both escape hatches when nothing can resolve the block', async () => {
    await expect(resolveDeployBlock({ ...base, getCode: prunedNode(20000000n) }))
      .rejects.toThrow(/--deploy-block|ETHERSCAN_API_KEY/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/deployBlock.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/deployBlock.js`.

- [ ] **Step 3: Write `src/chain/deployBlock.ts`**

```ts
import { DeployBlockUnavailableError } from '../errors.js';
import { classifyProbeError } from './probeErrors.js';
import type { Address, DeployBlockSource } from '../types.js';

export interface CodeReader {
  (a: { address: Address; blockNumber: bigint }): Promise<string>;
}

const hasCode = (code: string): boolean => code !== '0x' && code.length > 2;

/**
 * Confirms the node serves historical state.
 *
 * Most non-archive RPCs prune old state and return empty rather than erroring,
 * so a binary search against them converges on the pruning horizon and reports
 * a confidently wrong deploy block. The probe is a contract known to have
 * existed at `probe.block` on this chain: empty code there means pruned.
 */
export async function probeArchive(
  getCode: CodeReader,
  probe: { address: Address; block: number },
  opts: { attempts?: number } = {},
): Promise<boolean> {
  const attempts = Math.max(1, opts.attempts ?? 3);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const code = await getCode({ address: probe.address, blockNumber: BigInt(probe.block) });
      return hasCode(code);
    } catch (err) {
      // A pruned node throws rather than returning empty bytes, with wording
      // that varies by client. That is a verdict — stop and report failure.
      if (classifyProbeError(err) === 'state_unavailable') return false;
      // A timeout says nothing about archive capability, so retry rather than
      // wrongly disabling deploy-block search for the whole chain.
      if (attempt === attempts) return false;
    }
  }
  return false;
}

/** Lowest block at which the address has code. Assumes archive state. */
export async function binarySearchDeployBlock(
  getCode: CodeReader,
  address: Address,
  safeHead: bigint,
): Promise<bigint> {
  if (!hasCode(await getCode({ address, blockNumber: safeHead }))) {
    throw new DeployBlockUnavailableError(
      `${address} has no code at block ${safeHead}; it is not deployed, or was self-destructed.`,
    );
  }

  let lo = 0n;
  let hi = safeHead;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (hasCode(await getCode({ address, blockNumber: mid }))) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** Etherscan V2 is one multichain endpoint taking a chainid parameter. */
export async function fetchCreationBlockFromExplorer(a: {
  chainId: number;
  address: Address;
  apiKey: string;
  fetchFn?: typeof fetch;
}): Promise<number | undefined> {
  const doFetch = a.fetchFn ?? fetch;
  const url =
    `https://api.etherscan.io/v2/api?chainid=${a.chainId}` +
    `&module=contract&action=getcontractcreation&contractaddresses=${a.address}` +
    `&apikey=${a.apiKey}`;
  try {
    const response = await doFetch(url);
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      status?: string;
      result?: Array<{ blockNumber?: string }>;
    };
    const blockNumber = body.result?.[0]?.blockNumber;
    if (body.status !== '1' || !blockNumber) return undefined;
    const parsed = Number(blockNumber);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveDeployBlock(a: {
  getCode: CodeReader;
  chainId: number;
  address: Address;
  safeHead: bigint;
  archiveProbe: { address: Address; block: number };
  override?: number;
  etherscanApiKey?: string;
  fetchFn?: typeof fetch;
}): Promise<{ block: number; source: DeployBlockSource }> {
  if (a.override !== undefined) {
    return { block: a.override, source: 'override' };
  }

  if (a.etherscanApiKey) {
    const fromExplorer = await fetchCreationBlockFromExplorer({
      chainId: a.chainId,
      address: a.address,
      apiKey: a.etherscanApiKey,
      fetchFn: a.fetchFn,
    });
    if (fromExplorer !== undefined) {
      return { block: fromExplorer, source: 'explorer' };
    }
  }

  if (!(await probeArchive(a.getCode, a.archiveProbe))) {
    throw new DeployBlockUnavailableError(
      `RPC for chain ${a.chainId} does not serve archive state, so the deploy block for ` +
      `${a.address} cannot be found by binary search (it would converge on the pruning ` +
      'horizon and report a wrong block). Pass --deploy-block, or set ETHERSCAN_API_KEY.',
    );
  }

  const block = await binarySearchDeployBlock(a.getCode, a.address, a.safeHead);
  return { block: Number(block), source: 'binary_search' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/deployBlock.test.ts && npm run typecheck`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chain/deployBlock.ts test/unit/deployBlock.test.ts
git commit -m "feat: deploy-block resolution guarded by an archive-state probe

Precedence: explicit override, Etherscan V2 creation block, then binary
search only when the archive probe passes. A pruned node returns empty
code for old blocks, which a naive search reads as 'not yet deployed'
and converges on the pruning horizon; the probe makes that fail loudly
instead, naming both escape hatches.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Transaction enrichment

**Files:**
- Create: `src/chain/tx.ts`
- Test: `test/unit/tx.test.ts`

**Interfaces:**
- Consumes: `TxInfo`, `Hash`, `Address` (Task 1)
- Produces:
  - `interface TxSource { getTransaction(hash: Hash): Promise<{ from: Address; value: bigint }>; getBlockWithTransactions(blockNumber: bigint): Promise<Array<{ hash: Hash; from: Address; value: bigint }>> }`
  - `enrichTxs(a: { source: TxSource; needed: Array<{ txHash: Hash; blockNumber: bigint }>; blockFetchThreshold: number; known?: Map<string, TxInfo> }): Promise<Map<string, TxInfo>>`
  - `makeTxSource(client: PublicClient): TxSource`

- [ ] **Step 1: Write the failing test**

`test/unit/tx.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { enrichTxs, type TxSource } from '../../src/chain/tx.js';
import type { Address, Hash, TxInfo } from '../../src/types.js';

const SENDER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const hash = (n: number) => `0x${String(n).padStart(64, '0')}` as Hash;

function makeSource(overrides: Partial<TxSource> = {}) {
  const getTransaction = vi.fn(async (h: Hash) => ({ from: SENDER, value: 1n }));
  const getBlockWithTransactions = vi.fn(async (blockNumber: bigint) =>
    [1, 2, 3, 4].map((i) => ({ hash: hash(i), from: SENDER, value: BigInt(i) })),
  );
  return {
    source: { getTransaction, getBlockWithTransactions, ...overrides } as TxSource,
    getTransaction,
    getBlockWithTransactions,
  };
}

describe('enrichTxs', () => {
  it('returns an empty map for no input', async () => {
    const { source } = makeSource();
    expect((await enrichTxs({ source, needed: [], blockFetchThreshold: 3 })).size).toBe(0);
  });

  it('fetches per tx when a block holds fewer than the threshold', async () => {
    const { source, getTransaction, getBlockWithTransactions } = makeSource();
    const out = await enrichTxs({
      source,
      needed: [
        { txHash: hash(1), blockNumber: 100n },
        { txHash: hash(2), blockNumber: 100n },
      ],
      blockFetchThreshold: 3,
    });
    expect(getTransaction).toHaveBeenCalledTimes(2);
    expect(getBlockWithTransactions).not.toHaveBeenCalled();
    expect(out.size).toBe(2);
  });

  it('fetches the whole block at or above the threshold', async () => {
    const { source, getTransaction, getBlockWithTransactions } = makeSource();
    const out = await enrichTxs({
      source,
      needed: [1, 2, 3].map((i) => ({ txHash: hash(i), blockNumber: 100n })),
      blockFetchThreshold: 3,
    });
    expect(getBlockWithTransactions).toHaveBeenCalledTimes(1);
    expect(getTransaction).not.toHaveBeenCalled();
    expect(out.get(hash(2))).toEqual({ from: SENDER, value: 2n });
  });

  it('caches every tx a block fetch returned, including ones not asked for', async () => {
    const { source } = makeSource();
    const out = await enrichTxs({
      source,
      needed: [1, 2, 3].map((i) => ({ txHash: hash(i), blockNumber: 100n })),
      blockFetchThreshold: 3,
    });
    expect(out.has(hash(4))).toBe(true);
  });

  it('mixes strategies across blocks in one call', async () => {
    const { source, getTransaction, getBlockWithTransactions } = makeSource();
    await enrichTxs({
      source,
      needed: [
        ...[1, 2, 3].map((i) => ({ txHash: hash(i), blockNumber: 100n })),
        { txHash: hash(9), blockNumber: 200n },
      ],
      blockFetchThreshold: 3,
    });
    expect(getBlockWithTransactions).toHaveBeenCalledTimes(1);
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated hashes', async () => {
    const { source, getTransaction } = makeSource();
    await enrichTxs({
      source,
      needed: [
        { txHash: hash(1), blockNumber: 100n },
        { txHash: hash(1), blockNumber: 100n },
      ],
      blockFetchThreshold: 3,
    });
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });

  // A resumed backfill must not re-pay for data already stored.
  it('fetches nothing already supplied in `known`', async () => {
    const { source, getTransaction, getBlockWithTransactions } = makeSource();
    const known = new Map<string, TxInfo>([[hash(1), { from: SENDER, value: 5n }]]);
    const out = await enrichTxs({
      source,
      needed: [{ txHash: hash(1), blockNumber: 100n }],
      blockFetchThreshold: 3,
      known,
    });
    expect(getTransaction).not.toHaveBeenCalled();
    expect(getBlockWithTransactions).not.toHaveBeenCalled();
    expect(out.get(hash(1))).toEqual({ from: SENDER, value: 5n });
  });

  it('counts only unknown hashes toward the threshold', async () => {
    const { source, getTransaction, getBlockWithTransactions } = makeSource();
    const known = new Map<string, TxInfo>([
      [hash(1), { from: SENDER, value: 1n }],
      [hash(2), { from: SENDER, value: 2n }],
    ]);
    await enrichTxs({
      source,
      needed: [1, 2, 3].map((i) => ({ txHash: hash(i), blockNumber: 100n })),
      blockFetchThreshold: 3,
      known,
    });
    expect(getBlockWithTransactions).not.toHaveBeenCalled();
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/tx.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/tx.js`.

- [ ] **Step 3: Write `src/chain/tx.ts`**

```ts
import type { PublicClient } from 'viem';
import type { Address, Hash, TxInfo } from '../types.js';

export interface TxSource {
  getTransaction(hash: Hash): Promise<{ from: Address; value: bigint }>;
  getBlockWithTransactions(
    blockNumber: bigint,
  ): Promise<Array<{ hash: Hash; from: Address; value: bigint }>>;
}

export function makeTxSource(client: PublicClient): TxSource {
  return {
    async getTransaction(hash) {
      const tx = await client.getTransaction({ hash });
      return { from: tx.from.toLowerCase() as Address, value: tx.value };
    },
    async getBlockWithTransactions(blockNumber) {
      const block = await client.getBlock({ blockNumber, includeTransactions: true });
      return block.transactions.map((tx) => ({
        hash: tx.hash,
        from: tx.from.toLowerCase() as Address,
        value: tx.value,
      }));
    },
  };
}

/**
 * Resolves tx.from and tx.value for every needed hash.
 *
 * Per block, with `u` unknown hashes needed in it: at `u >= threshold` one
 * block fetch beats `u` round trips, and every other tx it returns is cached
 * for free. Below the threshold a block fetch would download the whole block
 * — around 150 txs on mainnet — to extract one or two, so those go per-tx.
 */
export async function enrichTxs(a: {
  source: TxSource;
  needed: Array<{ txHash: Hash; blockNumber: bigint }>;
  blockFetchThreshold: number;
  known?: Map<string, TxInfo>;
}): Promise<Map<string, TxInfo>> {
  const out = new Map<string, TxInfo>(a.known ?? []);

  const byBlock = new Map<bigint, Set<Hash>>();
  for (const { txHash, blockNumber } of a.needed) {
    if (out.has(txHash)) continue;
    let set = byBlock.get(blockNumber);
    if (!set) {
      set = new Set();
      byBlock.set(blockNumber, set);
    }
    set.add(txHash);
  }

  const perTx: Hash[] = [];
  const blockFetches: Array<Promise<void>> = [];

  for (const [blockNumber, hashes] of byBlock) {
    if (hashes.size >= a.blockFetchThreshold) {
      blockFetches.push(
        a.source.getBlockWithTransactions(blockNumber).then((txs) => {
          for (const tx of txs) out.set(tx.hash, { from: tx.from, value: tx.value });
        }),
      );
    } else {
      perTx.push(...hashes);
    }
  }

  await Promise.all(blockFetches);

  // Issued concurrently; the HTTP transport coalesces them into JSON-RPC
  // batch requests, so no manual batching is needed here.
  const fetched = await Promise.all(
    perTx.filter((h) => !out.has(h)).map(async (h) => [h, await a.source.getTransaction(h)] as const),
  );
  for (const [h, info] of fetched) out.set(h, info);

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/tx.test.ts && npm run typecheck`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chain/tx.ts test/unit/tx.test.ts
git commit -m "feat: tx enrichment with a per-block fetch heuristic

Fetch the whole block when it holds >= blockFetchThreshold (default 3)
unknown txs we need, otherwise fetch per tx. Mints cluster in blocks, so
the block path wins during a hot mint; below the threshold it would
download ~150 mainnet txs to extract one. Hashes already known from the
DB are never re-fetched and do not count toward the threshold.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Backfill orchestration

**Files:**
- Create: `src/indexer/backfill.ts`
- Test: `test/unit/backfill.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–12
- Produces:
  - `interface BackfillDeps { db; getCode: CodeReader; supports: SupportsInterface; makeFetchLogs(standard: Standard): LogFetcher; txSource: TxSource; getHead(): Promise<bigint>; now(): Date }`

**Why `makeFetchLogs(standard)` and not a plain `fetchLogs`:** the `getLogs`
topic filter depends on the standard, which is not known until bootstrap has
run inside `backfill()`. A caller therefore cannot build the fetcher up front —
it has to be constructed once the standard is resolved.
  - `interface BackfillOptions { chainId: number; contract: string; chain: Pick<ChainConfig,'initialChunk'|'maxChunk'|'confirmations'|'blockFetchThreshold'|'archiveProbe'>; deployBlockOverride?: number; standardOverride?: Standard; etherscanApiKey?: string; maxHeadExtensions?: number; staleLockMs?: number; jobId?: string; onProgress?(p: Progress): void; hooks?: { afterChunkCommit?(ctx: { chunkIndex: number; toBlock: bigint }): void | Promise<void> } }`
  - `interface Progress { fromBlock: bigint; toBlock: bigint; target: bigint; rowsInserted: number; totalRows: number }`
  - `interface BackfillResult { standard: Standard; deployBlock: number; lastIndexedBlock: number; rowsInserted: number; headExtensions: number }`
  - `backfill(deps: BackfillDeps, options: BackfillOptions): Promise<BackfillResult>`

Dependencies are injected as plain functions so the whole orchestration — locking, bootstrap cleanup, head extension, fault injection — is unit-testable against an in-memory SQLite database with no RPC.

- [ ] **Step 1: Write the failing test**

`test/unit/backfill.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { backfill, type BackfillDeps } from '../../src/indexer/backfill.js';
import { getCollection, claimCollection } from '../../src/db/repositories/collections.js';
import {
  CollectionLockedError, DeployBlockUnavailableError, UnsupportedStandardError,
} from '../../src/errors.js';
import { INTERFACE_IDS } from '../../src/chain/standard.js';
import type { Address, Hash } from '../../src/types.js';

const CONTRACT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const MINTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEPLOY = 100n;

const CHAIN = {
  initialChunk: 50,
  maxChunk: 100,
  confirmations: 10,
  blockFetchThreshold: 3,
  archiveProbe: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as Address, block: 1 },
};

function mintLog(n: number, block: bigint) {
  return {
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      `0x000000000000000000000000${MINTER.slice(2)}`,
      `0x${n.toString(16).padStart(64, '0')}`,
    ],
    data: '0x',
    transactionHash: `0x${String(n).padStart(64, '0')}` as Hash,
    blockNumber: block,
    logIndex: n,
  };
}

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
});

function makeDeps(over: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    db,
    getCode: async ({ blockNumber }) => (blockNumber >= DEPLOY ? '0xcode' : '0x'),
    supports: async (id) => id === INTERFACE_IDS.erc721,
    makeFetchLogs: () => async ({ fromBlock, toBlock }) =>
      [1, 2, 3].filter((n) => BigInt(100 + n) >= fromBlock && BigInt(100 + n) <= toBlock)
        .map((n) => mintLog(n, BigInt(100 + n))),
    txSource: {
      getTransaction: async () => ({ from: MINTER as Address, value: 0n }),
      getBlockWithTransactions: async () => [],
    },
    getHead: async () => 200n,
    now: () => new Date('2026-09-23T12:00:00Z'),
    ...over,
  };
}

const opts = { chainId: 1, contract: CONTRACT, chain: CHAIN };

describe('backfill', () => {
  it('indexes a collection end to end', async () => {
    const result = await backfill(makeDeps(), opts);
    expect(result.standard).toBe('721');
    expect(result.deployBlock).toBe(100);
    expect(result.rowsInserted).toBe(3);
    // Never indexes to head: 200 - 10 confirmations.
    expect(result.lastIndexedBlock).toBe(190);
  });

  it('stops at head minus confirmations', async () => {
    const result = await backfill(makeDeps({ getHead: async () => 1000n }), opts);
    expect(result.lastIndexedBlock).toBe(990);
  });

  it('is idempotent — a second run inserts nothing new', async () => {
    await backfill(makeDeps(), opts);
    const second = await backfill(makeDeps(), opts);
    expect(second.rowsInserted).toBe(0);
    const n = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
    expect(n.n).toBe(3);
  });

  it('classifies zero-address senders as mints', async () => {
    await backfill(makeDeps(), opts);
    const kinds = db.prepare('SELECT DISTINCT kind FROM transfers').all() as Array<{ kind: string }>;
    expect(kinds).toEqual([{ kind: 'mint' }]);
  });

  it('releases the lock on success', async () => {
    await backfill(makeDeps(), opts);
    const row = db.prepare('SELECT locked_by FROM collections').get() as { locked_by: string | null };
    expect(row.locked_by).toBeNull();
  });

  it('refuses to run while another job holds the lock', async () => {
    claimCollection(db, {
      chainId: 1, contract: CONTRACT, jobId: 'other',
      now: new Date('2026-09-23T12:00:00Z'), staleMs: 300_000,
    });
    await expect(backfill(makeDeps(), opts)).rejects.toThrow(CollectionLockedError);
  });
});

describe('backfill — bootstrap failure', () => {
  it('leaves no row behind when the standard is unsupported', async () => {
    const deps = makeDeps({ supports: async () => false });
    await expect(backfill(deps, opts)).rejects.toThrow(UnsupportedStandardError);
    const n = db.prepare('SELECT COUNT(*) AS n FROM collections').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('leaves no row behind when the deploy block cannot be resolved', async () => {
    // Pruned node: the archive probe finds no code at its historical block.
    const deps = makeDeps({ getCode: async ({ blockNumber }) => (blockNumber >= 180n ? '0xcode' : '0x') });
    await expect(backfill(deps, opts)).rejects.toThrow(DeployBlockUnavailableError);
    const n = db.prepare('SELECT COUNT(*) AS n FROM collections').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('lets a later run succeed after a failed bootstrap', async () => {
    await expect(backfill(makeDeps({ supports: async () => false }), opts)).rejects.toThrow();
    await expect(backfill(makeDeps(), opts)).resolves.toMatchObject({ standard: '721' });
  });
});

describe('backfill — head extension', () => {
  it('extends when the head moves during the run', async () => {
    let head = 200n;
    const deps = makeDeps({ getHead: async () => { const h = head; head = 300n; return h; } });
    const result = await backfill(deps, opts);
    expect(result.lastIndexedBlock).toBe(290);
    expect(result.headExtensions).toBe(1);
  });

  it('stops extending at maxHeadExtensions rather than chasing a fast chain', async () => {
    let head = 200n;
    const deps = makeDeps({ getHead: async () => { head += 100n; return head; } });
    const result = await backfill(deps, { ...opts, maxHeadExtensions: 2 });
    expect(result.headExtensions).toBe(2);
  });
});

describe('backfill — resumability', () => {
  it('resumes from the watermark after a deterministic mid-run fault', async () => {
    const boom = new Error('injected fault');
    await expect(backfill(makeDeps(), {
      ...opts,
      hooks: { afterChunkCommit: ({ chunkIndex }) => { if (chunkIndex === 0) throw boom; } },
    })).rejects.toThrow('injected fault');

    const partial = getCollection(db, 1, CONTRACT);
    expect(partial.state).toBe('indexed');
    const afterCrash = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };

    const resumed = await backfill(makeDeps(), opts);
    const total = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
    expect(total.n).toBe(3);
    expect(total.n).toBeGreaterThanOrEqual(afterCrash.n);
    expect(resumed.lastIndexedBlock).toBe(190);
  });

  it('releases the lock even when a chunk throws', async () => {
    await expect(backfill(makeDeps(), {
      ...opts,
      hooks: { afterChunkCommit: () => { throw new Error('injected fault'); } },
    })).rejects.toThrow();
    const row = db.prepare('SELECT locked_by FROM collections').get() as { locked_by: string | null };
    expect(row.locked_by).toBeNull();
  });

  it('reports progress per chunk', async () => {
    const onProgress = vi.fn();
    await backfill(makeDeps(), { ...opts, onProgress });
    expect(onProgress).toHaveBeenCalled();
    const last = onProgress.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ target: 190n });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/backfill.test.ts`
Expected: FAIL — cannot resolve `../../src/indexer/backfill.js`.

- [ ] **Step 3: Write `src/indexer/backfill.ts`**

```ts
import type Database from 'better-sqlite3';
import { newJobId } from '../jobId.js';
import type { ChainConfig } from '../config.js';
import { CollectionLockedError } from '../errors.js';
import type { Address, Standard, TransferRow, TxInfo } from '../types.js';
import { resolveDeployBlock, type CodeReader } from '../chain/deployBlock.js';
import { detectStandard, type SupportsInterface } from '../chain/standard.js';
import { enrichTxs, type TxSource } from '../chain/tx.js';
import { decodeLogs } from './decode.js';
import { classify } from './classify.js';
import { iterateLogs, type LogFetcher } from './logs.js';
import {
  advanceWatermark, claimCollection, deleteUnbootstrapped,
  finishBootstrap, getCollection, releaseCollection,
} from '../db/repositories/collections.js';
import { findKnownTxs, insertTransfers } from '../db/repositories/transfers.js';

export interface BackfillDeps {
  db: Database.Database;
  getCode: CodeReader;
  supports: SupportsInterface;
  /**
   * Built per run, not passed in ready-made: the getLogs topic filter depends
   * on the standard, which bootstrap only resolves once this function is
   * already running.
   */
  makeFetchLogs(standard: Standard): LogFetcher;
  txSource: TxSource;
  getHead(): Promise<bigint>;
  now(): Date;
}

export interface Progress {
  fromBlock: bigint;
  toBlock: bigint;
  target: bigint;
  rowsInserted: number;
  totalRows: number;
}

export interface BackfillOptions {
  chainId: number;
  contract: string;
  chain: Pick<
    ChainConfig,
    'initialChunk' | 'maxChunk' | 'confirmations' | 'blockFetchThreshold' | 'archiveProbe'
  >;
  deployBlockOverride?: number;
  standardOverride?: Standard;
  etherscanApiKey?: string;
  maxHeadExtensions?: number;
  staleLockMs?: number;
  jobId?: string;
  onProgress?(p: Progress): void;
  /** Test seam: deterministic fault injection beats killing a process. */
  hooks?: {
    afterChunkCommit?(ctx: { chunkIndex: number; toBlock: bigint }): void | Promise<void>;
  };
}

export interface BackfillResult {
  standard: Standard;
  deployBlock: number;
  lastIndexedBlock: number;
  rowsInserted: number;
  headExtensions: number;
}

export async function backfill(
  deps: BackfillDeps,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const contract = options.contract.toLowerCase();
  const address = contract as Address;
  const jobId = options.jobId ?? newJobId();
  const staleMs = options.staleLockMs ?? 300_000;
  const maxHeadExtensions = options.maxHeadExtensions ?? 3;
  const { chainId, chain } = options;

  const acquired = claimCollection(deps.db, {
    chainId, contract, jobId, now: deps.now(), staleMs,
  });
  if (!acquired) {
    throw new CollectionLockedError(
      `another job is already indexing ${contract} on chain ${chainId}`,
    );
  }

  let bootstrapped = false;
  try {
    let target = (await deps.getHead()) - BigInt(chain.confirmations);

    // --- bootstrap -------------------------------------------------------
    let existing = getCollection(deps.db, chainId, contract);
    if (existing.state === 'not_indexed') {
      const standard =
        options.standardOverride ?? (await detectStandard(deps.supports, address));
      const deploy = await resolveDeployBlock({
        getCode: deps.getCode,
        chainId,
        address,
        safeHead: target,
        archiveProbe: chain.archiveProbe,
        override: options.deployBlockOverride,
        etherscanApiKey: options.etherscanApiKey,
      });
      finishBootstrap(deps.db, {
        chainId, contract, standard,
        deployBlock: deploy.block,
        deployBlockSource: deploy.source,
        name: null,
      });
      existing = getCollection(deps.db, chainId, contract);
    }
    bootstrapped = true;

    if (existing.state !== 'indexed') {
      throw new Error(`bootstrap did not produce an indexed collection for ${contract}`);
    }
    const { standard, deployBlock } = existing;

    // --- chunk loop ------------------------------------------------------
    const fetchLogs = deps.makeFetchLogs(standard);

    let cursor = BigInt(existing.lastIndexedBlock) + 1n;
    let rowsInserted = 0;
    let chunkIndex = 0;
    let headExtensions = 0;

    for (;;) {
      while (cursor <= target) {
        for await (const chunk of iterateLogs({
          fetch: fetchLogs,
          fromBlock: cursor,
          toBlock: target,
          initialChunk: chain.initialChunk,
          maxChunk: chain.maxChunk,
        })) {
          const decoded = decodeLogs(chunk.logs, standard);

          const needed = decoded.map((d) => ({ txHash: d.txHash, blockNumber: d.blockNumber }));
          const known: Map<string, TxInfo> = findKnownTxs(
            deps.db, chainId, [...new Set(needed.map((n) => n.txHash))],
          );
          const txs = await enrichTxs({
            source: deps.txSource,
            needed,
            blockFetchThreshold: chain.blockFetchThreshold,
            known,
          });

          const rows: TransferRow[] = decoded.map((d) => {
            const tx = txs.get(d.txHash);
            if (!tx) throw new Error(`missing tx data for ${d.txHash}`);
            return {
              chainId,
              contract,
              tokenId: d.tokenId.toString(),
              amount: d.amount.toString(),
              fromAddr: d.from,
              toAddr: d.to,
              txHash: d.txHash,
              blockNumber: Number(d.blockNumber),
              logIndex: d.logIndex,
              batchIndex: d.batchIndex,
              txFrom: tx.from,
              txValueWei: tx.value.toString(),
              kind: classify(d, tx),
            };
          });

          // One transaction: rows, watermark, and lock heartbeat move together,
          // so the watermark can never outrun the data it claims to cover.
          const insertedHere = deps.db.transaction(() => {
            const n = insertTransfers(deps.db, rows);
            advanceWatermark(deps.db, {
              chainId, contract, jobId, toBlock: Number(chunk.toBlock), now: deps.now(),
            });
            return n;
          })();

          rowsInserted += insertedHere;
          cursor = chunk.toBlock + 1n;

          options.onProgress?.({
            fromBlock: chunk.fromBlock,
            toBlock: chunk.toBlock,
            target,
            rowsInserted: insertedHere,
            totalRows: rowsInserted,
          });

          await options.hooks?.afterChunkCommit?.({ chunkIndex, toBlock: chunk.toBlock });
          chunkIndex += 1;
        }
      }

      // The head moves during a long backfill. Extend, but bounded, so a fast
      // L2 cannot be chased indefinitely.
      if (headExtensions >= maxHeadExtensions) break;
      const newTarget = (await deps.getHead()) - BigInt(chain.confirmations);
      if (newTarget <= target) break;
      target = newTarget;
      headExtensions += 1;
    }

    const final = getCollection(deps.db, chainId, contract);
    return {
      standard,
      deployBlock,
      lastIndexedBlock: final.state === 'indexed' ? final.lastIndexedBlock : deployBlock - 1,
      rowsInserted,
      headExtensions,
    };
  } finally {
    // A bootstrap that threw must not leave a permanent unbootstrapped orphan.
    if (!bootstrapped) {
      deleteUnbootstrapped(deps.db, { chainId, contract, jobId });
    }
    releaseCollection(deps.db, { chainId, contract, jobId });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/backfill.test.ts && npm run typecheck`
Expected: PASS, 14 tests.

If the head-extension tests disagree on exact counts, verify the behaviour by hand before adjusting either side: the invariant that matters is that `lastIndexedBlock <= head - confirmations` always holds and extension stops at the bound.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/backfill.ts test/unit/backfill.test.ts
git commit -m "feat: resumable backfill orchestration

Rows, watermark, and lock heartbeat commit in one SQLite transaction, so
the watermark can never outrun its data and a crash costs at most one
chunk. Bootstrap failure deletes its own row and the lock is released in
a finally on every path. Head extension is bounded. An afterChunkCommit
hook gives tests deterministic fault injection instead of process kills.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: CLI entrypoint

**Files:**
- Create: `src/cli/index.ts`, `src/cli/args.ts`
- Test: `test/unit/args.test.ts`

**Interfaces:**
- Consumes: `backfill` (Task 13), `loadConfig` (Task 1), `createLogger` (Task 2), `getClient` (Task 8)
- Produces: `parseArgs(argv: string[], defaultChainId?: number): { chainId: number; contract: string; deployBlock?: number; standard?: Standard }`

- [ ] **Step 1: Write the failing test**

`test/unit/args.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';

const CONTRACT = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';

describe('parseArgs', () => {
  it('parses chain and contract', () => {
    expect(parseArgs(['--chain', '8453', '--contract', CONTRACT]))
      .toEqual({ chainId: 8453, contract: CONTRACT.toLowerCase() });
  });

  it('lowercases the contract', () => {
    expect(parseArgs(['--chain', '1', '--contract', CONTRACT]).contract)
      .toBe(CONTRACT.toLowerCase());
  });

  it('falls back to the default chain id', () => {
    expect(parseArgs(['--contract', CONTRACT], 1).chainId).toBe(1);
  });

  it('errors when no chain is given and there is no default', () => {
    expect(() => parseArgs(['--contract', CONTRACT]))
      .toThrow(/--chain|DEFAULT_CHAIN_ID/);
  });

  it('errors on a missing contract', () => {
    expect(() => parseArgs(['--chain', '1'])).toThrow(/--contract/);
  });

  it('rejects a malformed address rather than crashing later', () => {
    expect(() => parseArgs(['--chain', '1', '--contract', '0xnope'])).toThrow(/address/i);
  });

  it('rejects a non-numeric chain', () => {
    expect(() => parseArgs(['--chain', 'base', '--contract', CONTRACT])).toThrow(/--chain/);
  });

  it('parses the optional deploy-block override', () => {
    expect(parseArgs(['--chain', '1', '--contract', CONTRACT, '--deploy-block', '12287507'])
      .deployBlock).toBe(12287507);
  });

  it('parses the optional standard override', () => {
    expect(parseArgs(['--chain', '1', '--contract', CONTRACT, '--standard', '1155'])
      .standard).toBe('1155');
  });

  it('rejects an unknown standard', () => {
    expect(() => parseArgs(['--chain', '1', '--contract', CONTRACT, '--standard', '20']))
      .toThrow(/--standard/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/args.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/args.js`.

- [ ] **Step 3: Write `src/cli/args.ts`**

```ts
import { ConfigError } from '../errors.js';
import type { Standard } from '../types.js';

export interface ParsedArgs {
  chainId: number;
  contract: string;
  deployBlock?: number;
  standard?: Standard;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function parseArgs(argv: string[], defaultChainId?: number): ParsedArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new ConfigError(`malformed argument near "${key ?? ''}"`);
    }
    flags.set(key.slice(2), value);
  }

  const rawChain = flags.get('chain');
  const chainId = rawChain !== undefined ? Number(rawChain) : defaultChainId;
  if (rawChain !== undefined && !Number.isInteger(Number(rawChain))) {
    throw new ConfigError('--chain must be a numeric chain id, for example --chain 8453');
  }
  if (chainId === undefined) {
    throw new ConfigError('no chain given: pass --chain <id> or set DEFAULT_CHAIN_ID');
  }

  const contract = flags.get('contract');
  if (!contract) throw new ConfigError('--contract <address> is required');
  if (!ADDRESS_RE.test(contract)) {
    throw new ConfigError(`--contract is not a valid EVM address: ${contract}`);
  }

  const rawDeployBlock = flags.get('deploy-block');
  let deployBlock: number | undefined;
  if (rawDeployBlock !== undefined) {
    deployBlock = Number(rawDeployBlock);
    if (!Number.isInteger(deployBlock) || deployBlock < 0) {
      throw new ConfigError('--deploy-block must be a non-negative integer');
    }
  }

  const rawStandard = flags.get('standard');
  if (rawStandard !== undefined && rawStandard !== '721' && rawStandard !== '1155') {
    throw new ConfigError('--standard must be 721 or 1155');
  }

  return {
    chainId,
    contract: contract.toLowerCase(),
    ...(deployBlock !== undefined ? { deployBlock } : {}),
    ...(rawStandard !== undefined ? { standard: rawStandard as Standard } : {}),
  };
}
```

- [ ] **Step 4: Write `src/cli/index.ts`**

```ts
import { createRateLimiter } from '../chain/rateLimit.js';
import { getClient } from '../chain/client.js';
import { makeSupportsInterface } from '../chain/standard.js';
import { makeTxSource } from '../chain/tx.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { backfill } from '../indexer/backfill.js';
import { TRANSFER_TOPICS } from '../indexer/decode.js';
import { createLogger } from '../logger.js';
import { ByakuganError } from '../errors.js';
import type { Address } from '../types.js';
import { parseArgs } from './args.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.secrets);

  const args = parseArgs(process.argv.slice(2), config.defaultChainId);
  const chain = config.chains.get(args.chainId);
  if (!chain) {
    throw new ByakuganError(
      `chain ${args.chainId} is not configured. Set RPC_URL_${args.chainId}.`,
    );
  }

  const db = openDb(config.dbPath);
  runMigrations(db);

  const client = getClient(args.chainId, config);
  const limit = createRateLimiter(chain.requestsPerSecond);
  const address = args.contract as Address;
  const standard = args.standard;

  log.info({ chain: chain.name, contract: args.contract }, 'backfill starting');

  const result = await backfill(
    {
      db,
      getCode: (a) =>
        limit(async () => (await client.getCode({ address: a.address, blockNumber: a.blockNumber })) ?? '0x'),
      supports: (id) => limit(() => makeSupportsInterface(client, address)(id)),
      // Built with the standard backfill resolved during bootstrap, so topic
      // filtering is correct for 721 and 1155 alike.
      makeFetchLogs: (resolvedStandard) => ({ fromBlock, toBlock }) =>
        limit(async () =>
          (await client.getLogs({
            address,
            fromBlock,
            toBlock,
            topics: [TRANSFER_TOPICS[resolvedStandard]],
          })) as never,
        ),
      txSource: {
        getTransaction: (hash) => limit(() => makeTxSource(client).getTransaction(hash)),
        getBlockWithTransactions: (blockNumber) =>
          limit(() => makeTxSource(client).getBlockWithTransactions(blockNumber)),
      },
      getHead: () => limit(() => client.getBlockNumber()),
      now: () => new Date(),
    },
    {
      chainId: args.chainId,
      contract: args.contract,
      chain,
      ...(args.deployBlock !== undefined ? { deployBlockOverride: args.deployBlock } : {}),
      ...(standard !== undefined ? { standardOverride: standard } : {}),
      ...(config.etherscanApiKey ? { etherscanApiKey: config.etherscanApiKey } : {}),
      onProgress: (p) =>
        log.info(
          {
            from: Number(p.fromBlock),
            to: Number(p.toBlock),
            target: Number(p.target),
            rows: p.totalRows,
          },
          'chunk indexed',
        ),
    },
  );

  log.info(result, 'backfill complete');
  db.close();
}

main().catch((err: unknown) => {
  // The logger needs config, which may itself be what failed, so fall back to
  // a bare message rather than risking an unredacted stack on stdout.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, all suites.

- [ ] **Step 6: Commit**

```bash
git add src/cli/ test/unit/args.test.ts
git commit -m "feat: CLI entrypoint with validated arguments

Bad input returns a helpful message and a non-zero exit, never a stack
trace.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: Real-chain fixtures, integration tests, and README

**Files:**
- Create: `scripts/capture-fixtures.ts`, `test/integration/backfill.integration.test.ts`, `README.md`
- Create: `test/fixtures/real-<chain>-<contract>.json` (captured)

**Interfaces:**
- Consumes: everything above
- Produces: no new exports — this task proves the milestone

This task needs RPC keys in `.env`. Do not hardcode any collection value until it has been printed and confirmed against a block explorer.

- [ ] **Step 1: Write the fixture capture script**

`scripts/capture-fixtures.ts`:

```ts
/**
 * Captures real logs and txs so unit tests stay offline and deterministic.
 * Usage: npx tsx scripts/capture-fixtures.ts --chain 8453 --contract 0x… --blocks 5
 */
import { writeFileSync } from 'node:fs';
import { getClient } from '../src/chain/client.js';
import { loadConfig } from '../src/config.js';
import { parseArgs } from '../src/cli/args.js';
import { TRANSFER_TOPICS } from '../src/indexer/decode.js';
import type { Address } from '../src/types.js';

const config = loadConfig();
const args = parseArgs(process.argv.slice(2).filter((_, i, a) => {
  const prev = a[i - 1];
  return prev !== '--blocks' && a[i] !== '--blocks';
}), config.defaultChainId);

const client = getClient(args.chainId, config);
const address = args.contract as Address;

const deployBlock = BigInt(args.deployBlock ?? 0);
const logs = await client.getLogs({
  address,
  fromBlock: deployBlock,
  toBlock: deployBlock + 200n,
  topics: [TRANSFER_TOPICS[args.standard ?? '721']],
});

const serialized = JSON.stringify(
  logs,
  (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
  2,
);
const out = `test/fixtures/real-${args.chainId}-${args.contract}.json`;
writeFileSync(out, serialized);
process.stdout.write(`wrote ${logs.length} logs to ${out}\n`);
```

- [ ] **Step 2: Choose and verify the test collection**

Run a discovery pass and **print, do not hardcode**:

```bash
npx tsx scripts/capture-fixtures.ts --chain 8453 --contract <candidate> --standard 721
npm run index -- --chain 8453 --contract <candidate>
```

Then print, for the candidate: deploy block, deploy-block source, first mint tx hash, mint count, burn count, and whether ERC-721 Enumerable is supported. Pick a small, non-burnable, fully minted ERC-721 on Base or Arbitrum so the backfill is fast.

**Stop here and give the user the explorer links** for the deploy block and the first mint tx hash. Only after they confirm, hardcode the values into the integration test constants below. Do not proceed on your own verification alone — the milestone's acceptance criteria say the user verifies this.

- [ ] **Step 3: Write the integration test**

`test/integration/backfill.integration.test.ts`. Replace each `REPLACE_ME` with a user-confirmed value from Step 2.

```ts
import { describe, expect, it } from 'vitest';
import { parseAbi } from 'viem';
import { getClient } from '../../src/chain/client.js';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { backfill } from '../../src/indexer/backfill.js';
import { makeSupportsInterface, supportsEnumerable } from '../../src/chain/standard.js';
import { makeTxSource } from '../../src/chain/tx.js';
import { TRANSFER_TOPICS } from '../../src/indexer/decode.js';
import { countByKind } from '../../src/db/repositories/transfers.js';
import type { Address, Standard } from '../../src/types.js';

const CHAIN_ID = 8453;
const CONTRACT = 'REPLACE_ME';                 // user-confirmed
const FIRST_MINT_TX = 'REPLACE_ME';            // user-confirmed on the explorer
const EXPECTED_MINTS = 0;                      // user-confirmed; used when Enumerable is absent

const configured = Boolean(process.env[`RPC_URL_${CHAIN_ID}`]);

describe.skipIf(!configured)('backfill against a real collection', () => {
  function run() {
    const config = loadConfig();
    const db = openDb(':memory:');
    runMigrations(db);
    const client = getClient(CHAIN_ID, config);
    const address = CONTRACT as Address;
    const chain = config.chains.get(CHAIN_ID);
    if (!chain) throw new Error(`chain ${CHAIN_ID} not configured`);

    return {
      db,
      client,
      address,
      chain,
      promise: backfill(
        {
          db,
          getCode: async (a) =>
            (await client.getCode({ address: a.address, blockNumber: a.blockNumber })) ?? '0x',
          supports: makeSupportsInterface(client, address),
          makeFetchLogs: (standard) => async ({ fromBlock, toBlock }) =>
            (await client.getLogs({
              address, fromBlock, toBlock, topics: [TRANSFER_TOPICS[standard]],
            })) as never,
          txSource: makeTxSource(client),
          getHead: () => client.getBlockNumber(),
          now: () => new Date(),
        },
        {
          chainId: CHAIN_ID,
          contract: CONTRACT,
          chain,
          ...(config.etherscanApiKey ? { etherscanApiKey: config.etherscanApiKey } : {}),
        },
      ),
    };
  }

  it('matches on-chain supply and the known first mint', async () => {
    const { db, client, address, promise } = run();
    await promise;

    const counts = countByKind(db, CHAIN_ID, CONTRACT);
    const enumerable = await supportsEnumerable(makeSupportsInterface(client, address));

    if (enumerable) {
      // totalSupply() is Enumerable, not base ERC-721.
      const totalSupply = await client.readContract({
        address,
        abi: parseAbi(['function totalSupply() view returns (uint256)']),
        functionName: 'totalSupply',
      });
      expect(counts.mint - counts.burn).toBe(Number(totalSupply));
    } else {
      expect(counts.mint).toBe(EXPECTED_MINTS);
    }

    const firstMint = db
      .prepare(`
        SELECT tx_hash FROM transfers
         WHERE chain_id = ? AND contract = ? AND kind = 'mint'
         ORDER BY block_number, log_index, batch_index LIMIT 1
      `)
      .get(CHAIN_ID, CONTRACT) as { tx_hash: string };
    expect(firstMint.tx_hash).toBe(FIRST_MINT_TX);
  }, 300_000);

  it('re-running leaves the row count unchanged', async () => {
    const first = run();
    await first.promise;
    const before = first.db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };

    const second = run();
    await second.promise;
    const after = second.db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };

    expect(after.n).toBe(before.n);
  }, 600_000);
});
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: every unit suite passes. Integration tests run if `RPC_URL_8453` is set, skip otherwise. **Report the actual output — if anything fails or skips, say so plainly rather than describing the milestone as done.**

- [ ] **Step 5: Write the README**

`README.md` must contain: what the project is, the Milestone 1 scope, setup (`.env` from `.env.example`, `npm install`, `npm run migrate`), usage (`npm run index -- --chain 8453 --contract 0x…`), how to run tests, and a **Known limitations** section reproducing verbatim the seven limitations from the spec's "Known limitations" section — including that ERC-20/WETH sales read as `transfer`, that `burn` detects only `0x0`, that reorgs are handled by confirmation lag with no rewrite of indexed rows, and that the deploy-block binary search assumes code presence is monotonic and therefore breaks for self-destructed or CREATE2-redeployed addresses.

- [ ] **Step 6: Commit**

```bash
git add scripts/ test/integration/ test/fixtures/ README.md
git commit -m "test: real-chain integration tests and README

Enumerable support is detected before asserting against totalSupply(),
falling back to a confirmed mint count when it is absent. Known
limitations are documented rather than left implicit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Stop and summarize**

Per the project working rules, Milestone 1 ends here. Report: what was built, the actual `npm test` and `npm run typecheck` output, which integration tests ran versus skipped, and the known limitations. **Wait for the user's confirmation before any Milestone 2 work.** Do not add a git remote or push — the user has said the repo stays local until M1 tests pass.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: config → 1; logger/security → 2; data model and migrations → 3; locking, cleanup, read guard → 4; idempotent writes and chunked IN → 5; decoding incl. `batch_index` → 6; classification → 7; client and rate limit → 8; adaptive chunking and `isRangeError` → 9; ERC-165 and Enumerable → 10; deploy-block precedence and archive probe → 11; enrichment heuristic → 12; reorg safety, head extension, orchestration, fault-injection hook → 13; CLI → 14; integration tests, fixtures, README limitations → 15.

**Type consistency.** `BackfillDeps.makeFetchLogs(standard)` is defined that way in Task 13 and used unchanged by Tasks 14 and 15. An earlier draft had Task 13 declare a plain `fetchLogs` and Task 14 rewrite it — a signature known to be wrong when written, which would have left Task 13's tests drifting from the shipped shape.

**Placeholders.** The only `REPLACE_ME` values are the three integration-test constants, which cannot be known before Step 2 and which the spec requires the user to verify. The `archiveProbe` entries in Task 1 are real addresses but are explicitly marked as requiring per-chain verification before commit.
