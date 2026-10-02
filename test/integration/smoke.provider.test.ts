/**
 * The real provider, once, bounded.
 *
 * WHAT THIS IS FOR, and it is a short list. Everything about the pipeline that can be
 * tested locally already is — `backfill.anvil.test.ts` runs the whole thing end to end
 * against a chain we control, with expectations derived from the spec. This file exists
 * only for the three things a local chain STRUCTURALLY CANNOT HAVE:
 *
 *   1. A RANGE CAP. anvil has none, so `iterateLogs`' shrink-and-remember path only ever
 *      meets errors a test wrote. The measured free-tier cap is 10 blocks, and it was a
 *      surprise when it was found.
 *   2. A CREDENTIAL IN THE URL. anvil's has no key, so end-to-end scrubbing is otherwise
 *      covered only against a fake one. A real key inside a real viem dump is the exact
 *      shape that leaked in this project and cost a rotation.
 *   3. A RATE LIMIT. The token bucket never meets a genuine 429 locally.
 *
 * EXPECTATIONS CANNOT BE SPEC-DERIVED HERE, because the chain is the authority rather
 * than a fixture we authored. So this asserts INVARIANTS — relationships that must hold
 * whatever the chain says — and cross-checks against the contract's own accounting
 * rather than against numbers anyone wrote down.
 *
 * Skips cleanly without credentials. CI and a fresh clone must not fail for want of an
 * API key.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbi, type Address as ViemAddress } from 'viem';
import type Database from 'better-sqlite3';
import { getChainClient } from '../../src/chain/client.js';
import { binarySearchDeployBlock } from '../../src/chain/deployBlock.js';
import { probeEffectiveChunk } from '../../src/indexer/logs.js';
import { makeSupportsInterface, supportsEnumerable } from '../../src/chain/standard.js';
import { makeTxSource } from '../../src/chain/tx.js';
import { systemClock } from '../../src/clock.js';
import { loadConfig, type Config } from '../../src/config.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { firstMinters } from '../../src/db/repositories/analytics.js';
import { countByKind } from '../../src/db/repositories/transfers.js';
import { backfill, type BackfillPorts } from '../../src/indexer/backfill.js';
import { makeLogsSource } from '../../src/indexer/transferSource.js';
import { deriveSecretTokens } from '../../src/secrets.js';
import type { Address, Hash } from '../../src/types.js';

const CHAIN_ID = 8453;
/**
 * "TAGGED CREW" (Ta) on Base, chosen by the inverse query in
 * scripts/find-smoke-collection.ts. See the plan for the full reasoning; the short
 * version is that it was deployed 217 blocks before its first mint, so a bounded run
 * reaches its whole history in about 70 chunks at the measured cap.
 */
const CONTRACT = '0xec04bedeec2f23307bba10468822d5b76a4284f5' as Address;
/** Its entire history sits below this. Bounded so the run does not depend on next week. */
const TO_BLOCK = 51_905_900n;
/** Asserted, never supplied — so the binary search is what is under test. */
const EXPECTED_DEPLOY_BLOCK = 51_905_209;

let config: Config | undefined;
let skipReason: string | undefined;
try {
  config = loadConfig();
  if (!config.chains.get(CHAIN_ID)) {
    skipReason = `chain ${CHAIN_ID} is not configured (RPC_URL_${CHAIN_ID} unset)`;
  }
} catch (err) {
  skipReason = `configuration could not be loaded: ${(err as Error).message}`;
}
if (skipReason) {
  // process.stderr.write, NOT console.warn. Measured: vitest DISCARDS console output
  // from a file whose every test is skipped, so a console.warn notice is invisible and
  // the skip is silent — which is close to a deleted test.
  process.stderr.write(
    `\n[smoke.provider] SKIPPED — ${skipReason}.\n` +
    `  This suite needs a real endpoint for the three things a local chain cannot have:\n` +
    '  a range cap, a credential in the URL, and a rate limit. Everything else is\n' +
    '  covered by the anvil suites, so skipping costs little.\n\n',
  );
}

const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));

describe.skipIf(skipReason !== undefined)('the real provider, bounded', () => {
  let db: Database.Database;
  let dbDir: string;
  /** Every range the walker asked for, in order. The cap assertion reads this. */
  const requested: Array<{ from: bigint; to: bigint; width: bigint }> = [];
  let rateLimited = 0;
  let measuredCap = 0;
  let enumerableDeclared = false;
  let totalSupplyAtBound: bigint | undefined;
  let result: Awaited<ReturnType<typeof backfill>>;

  beforeAll(async () => {
    const chain = config!.chains.get(CHAIN_ID)!;
    const { client, limit } = getChainClient(CHAIN_ID, config!);
    const chainClient = { chainId: CHAIN_ID, client, limit };

    const supports = makeSupportsInterface(client, CONTRACT);
    enumerableDeclared = await supportsEnumerable(supports);

    /**
     * `totalSupply()` is ERC-721 **Enumerable**, not base, so it is not assumed.
     *
     * But note which signal is trusted: this contract answers `false` to the Enumerable
     * interface id and nevertheless implements the function. Gating on the ERC-165
     * declaration would have discarded a working cross-check on the strength of a
     * contract's own incorrect self-description. So the CALL is attempted and its
     * success is what counts — assert behaviour, not configuration — with a documented
     * fallback when it genuinely is not there.
     */
    try {
      totalSupplyAtBound = await client.readContract({
        address: CONTRACT as ViemAddress,
        abi: parseAbi(['function totalSupply() view returns (uint256)']),
        functionName: 'totalSupply',
        blockNumber: TO_BLOCK,
      });
    } catch {
      totalSupplyAtBound = undefined;
    }

    // The probe only cares whether a range is ACCEPTED, so the decoded shape is
    // irrelevant and an empty array is the honest return.
    const capProbe = await probeEffectiveChunk({
      fetch: async ({ fromBlock, toBlock }) => {
        await client.getLogs({ address: CONTRACT as ViemAddress, fromBlock, toBlock });
        return [];
      },
      nearBlock: TO_BLOCK,
      requested: chain.maxChunk,
    });
    measuredCap = capProbe.blocks;

    dbDir = mkdtempSync(join(tmpdir(), 'byakugan-smoke-'));
    db = openDb(join(dbDir, 'smoke.db'));
    runMigrations(db);

    const fetchLogs = async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        requested.push({ from: fromBlock, to: toBlock, width: toBlock - fromBlock + 1n });
        try {
          const logs = await limit(() => client.getLogs({
            address: CONTRACT as ViemAddress, fromBlock, toBlock,
          }));
          return logs.map((l) => ({
            topics: l.topics as Hash[],
            data: l.data as Hash,
            transactionHash: l.transactionHash as Hash,
            blockNumber: l.blockNumber!,
            logIndex: l.logIndex!,
          }));
        } catch (err) {
          if (/429|rate limit|too many requests/i.test(String(err))) rateLimited += 1;
          throw err;
        }
    };

    const ports: BackfillPorts = {
      // getLogs DELIBERATELY, not the cheaper path: this suite exists to exercise the
      // provider's range cap and the chunker's response to it, and getAssetTransfers has
      // no range cap to hit. The cheap path's equivalence is gated separately by
      // scripts/compare-fetch-paths.ts.
      makeTransferSource: (standard) => makeLogsSource({
        fetchLogs, standard,
        initialChunk: chain.initialChunk, maxChunk: chain.maxChunk,
      }),
      txSource: makeTxSource(chainClient),
      supports,
      resolveDeployBlock: async ({ safeHead }) => ({
        block: Number(await binarySearchDeployBlock(
          async ({ address, blockNumber }) =>
            (await limit(() => client.getBytecode({
              address: address as ViemAddress, blockNumber,
            }))) ?? '0x',
          CONTRACT,
          safeHead,
        )),
        source: 'binary_search',
        validated: true,
      }),
      safeHead: async () => {
        const head = await limit(() => client.getBlockNumber());
        return head - BigInt(chain.confirmations);
      },
    };

    result = await backfill(db, {
      clock: systemClock,
      jobId: 'smoke-1',
      ports,
      options: {
        chainId: CHAIN_ID,
        contract: CONTRACT,
        level: 'full',
        toBlock: TO_BLOCK,
        costs: null, // prices unmeasured; per-tx, which cannot over-fetch
        staleLockMs: 5 * 60_000,
      },
    });
  }, 600_000);

  afterAll(() => {
    db?.close();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- 1. the range cap
  describe('the provider range cap, which anvil has none of', () => {
    it('capped the range below what was asked for', () => {
      // config.maxChunk is 20,000 on Base; the measured free-tier cap is 10. If this
      // ever stops being true the estimate in --dry-run changes by three orders of
      // magnitude, so it is worth failing loudly.
      const chain = config!.chains.get(CHAIN_ID)!;
      expect(measuredCap).toBeLessThan(chain.maxChunk);
      expect(measuredCap).toBeGreaterThanOrEqual(1);
    });

    it('the chunker SHRANK in response, rather than merely surviving', () => {
      // The assertion that separates an adaptive walker from a lucky one: the first
      // range asked for must be wider than the narrowest one eventually used. A test
      // that only checked "the run completed" would pass against a chunker that never
      // adapted at all, because a chunker stuck at 10 blocks also completes.
      expect(requested.length).toBeGreaterThan(1);
      const widths = requested.map((r) => r.width);
      const first = widths[0]!;
      const narrowest = widths.reduce((a, b) => (b < a ? b : a));
      expect(first).toBeGreaterThan(narrowest);
      expect(Number(narrowest)).toBeLessThanOrEqual(measuredCap);
    });

    it('needed many chunks, so the walk was really chunked', () => {
      const span = TO_BLOCK - BigInt(EXPECTED_DEPLOY_BLOCK) + 1n;
      expect(requested.length).toBeGreaterThanOrEqual(Number(span) / measuredCap / 2);
    });

    it('never requested a range beyond the bound', () => {
      for (const r of requested) expect(r.to).toBeLessThanOrEqual(TO_BLOCK);
    });
  });

  // ---------------------------------------------------------------- 2. no credential
  describe('no credential reaches output, with a real key in the URL', () => {
    it('runs the shipped CLI and leaks nothing', () => {
      // A CHILD PROCESS, deliberately. The path that leaked a key in this project was
      // Node's own uncaught-exception printer, which no in-process assertion reaches —
      // and the guard being tested installs itself as an import side effect of the real
      // entry point, so only running that entry point tests it.
      const tokens = deriveSecretTokens(config!.secrets);
      expect(tokens.length).toBeGreaterThan(0);

      const dir = mkdtempSync(join(tmpdir(), 'byakugan-cli-'));
      let out: string;
      let status = 0;
      try {
        out = execFileSync(
          process.execPath,
          ['--import', 'tsx', CLI, '--contract', CONTRACT, '--chain', String(CHAIN_ID),
            '--to-block', String(TO_BLOCK), '--progress-ms', '250'],
          {
            cwd: REPO, encoding: 'utf8', timeout: 600_000,
            env: { ...process.env, DB_PATH: join(dir, 'cli.db') },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
      } catch (thrown) {
        const e = thrown as SpawnSyncReturns<string>;
        status = e.status ?? -1;
        out = (e.stdout ?? '') + (e.stderr ?? '');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      expect(out.length).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(token.length).toBeGreaterThanOrEqual(8);
        expect(out).not.toContain(token);
      }
      // And it should have succeeded, so this is not passing because nothing happened.
      expect(status).toBe(0);
      expect(out).toContain('done');
    }, 900_000);
  });

  // ---------------------------------------------------------------- 3. the rate limit
  describe('the rate limiter', () => {
    it('reports honestly whether a 429 was ever observed', () => {
      if (rateLimited === 0) {
        // SAID OUT LOUD rather than implied. A bounded run of roughly 70 chunks is far
        // under the free-tier ceiling, so no 429 is the expected outcome — and no 429
        // is manufactured against a real provider to force the path. The token bucket's
        // backoff-and-recover behaviour is therefore covered ONLY by its unit tests,
        // against an injected clock, and remains unexercised against a real endpoint.
        process.stderr.write(
          '\n[smoke.provider] NOTE: no 429 occurred during this run, so the rate ' +
          'limiter was NOT exercised against a real provider. Its backoff and recovery ' +
          'are covered by unit tests only. This is recorded rather than glossed.\n\n',
        );
      }
      expect(rateLimited).toBeGreaterThanOrEqual(0);
    });

    it('completed regardless', () => {
      expect(result.status).toBe('indexed');
    });
  });

  // ---------------------------------------------------------------- invariants
  describe('invariants, since the chain is the authority here', () => {
    it('resolved the deploy block by binary search', () => {
      if (result.status !== 'indexed') throw new Error('expected indexed');
      expect(result.deployBlock).toBe(EXPECTED_DEPLOY_BLOCK);
    });

    it('landed the watermark exactly on the bound', () => {
      if (result.status !== 'indexed') throw new Error('expected indexed');
      expect(result.lastIndexedBlock).toBe(Number(TO_BLOCK));
      const row = db.prepare(
        'SELECT last_indexed_block AS b FROM collections WHERE chain_id = ? AND contract = ?',
      ).get(CHAIN_ID, CONTRACT) as { b: number };
      expect(row.b).toBe(Number(TO_BLOCK));
    });

    it('holds no row beyond the watermark', () => {
      const beyond = db.prepare(
        'SELECT COUNT(*) AS n FROM transfers WHERE block_number > ?',
      ).get(Number(TO_BLOCK)) as { n: number };
      expect(beyond.n).toBe(0);
    });

    it('cross-checks mint and burn counts against the contract own accounting', () => {
      // CHAIN-DERIVED, not a number anyone wrote down: supply is what remains after
      // mints minus burns, so this catches a whole class of decode and dedupe faults
      // that a row count on its own cannot.
      const kinds = countByKind(db, CHAIN_ID, CONTRACT);
      expect(kinds.mint).toBeGreaterThan(0);
      if (totalSupplyAtBound === undefined) {
        // The documented fallback. Worth noting this contract does NOT declare
        // Enumerable and implements totalSupply anyway, so reaching this branch would
        // mean the function genuinely vanished.
        process.stderr.write(
          '\n[smoke.provider] NOTE: totalSupply() could not be read, so the supply ' +
          'cross-check fell back to a recorded count. Enumerable declared: ' +
          `${enumerableDeclared}.\n\n`,
        );
        // 152, not the 153 this once said. That figure came from counting raw logs whose
        // topics[1] was zero, which also catches non-Transfer events; the fetch-path
        // comparison indexed the range both ways and got 152 mints and no burns.
        expect(kinds.mint).toBe(152);
        return;
      }
      expect(BigInt(kinds.mint - kinds.burn)).toBe(totalSupplyAtBound);
    });

    it('records the Enumerable declaration disagreeing with reality', () => {
      // Kept as an assertion because it is a finding, not a detail: a real contract
      // answers `false` to the Enumerable interface id while implementing
      // totalSupply(). Gating the cross-check on ERC-165 would have discarded a working
      // call on the strength of the contract's own incorrect self-description.
      expect(enumerableDeclared).toBe(false);
      expect(totalSupplyAtBound).not.toBeUndefined();
    });

    it('stored every address lowercase', () => {
      const bad = db.prepare(`
        SELECT COUNT(*) AS n FROM transfers
         WHERE from_addr <> lower(from_addr) OR to_addr <> lower(to_addr)
            OR contract <> lower(contract)
            OR (tx_from IS NOT NULL AND tx_from <> lower(tx_from))
      `).get() as { n: number };
      expect(bad.n).toBe(0);
    });

    it('classified every row, since this ran at full', () => {
      expect(countByKind(db, CHAIN_ID, CONTRACT).unclassified).toBe(0);
      const nulls = db.prepare(
        'SELECT COUNT(*) AS n FROM transfers WHERE tx_from IS NULL',
      ).get() as { n: number };
      expect(nulls.n).toBe(0);
    });

    it('inserts ZERO rows on an identical second run', async () => {
      // Idempotence against real data rather than a fixture. Re-running is the most
      // likely thing an operator does, and a duplicate row would corrupt every count.
      // This RUNS THE BACKFILL AGAIN — an earlier version of this test compared the row
      // count to itself and would have passed against anything at all.
      const before = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
      const chain = config!.chains.get(CHAIN_ID)!;
      const { client, limit } = getChainClient(CHAIN_ID, config!);
      const second = await backfill(db, {
        clock: systemClock,
        jobId: 'smoke-2',
        ports: {
          makeTransferSource: (standard) => {
            const inner = async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
            const logs = await limit(() => client.getLogs({
              address: CONTRACT as ViemAddress, fromBlock, toBlock,
            }));
            return logs.map((l) => ({
              topics: l.topics as Hash[], data: l.data as Hash,
              transactionHash: l.transactionHash as Hash,
              blockNumber: l.blockNumber!, logIndex: l.logIndex!,
            }));
          };
          const chainCfg = config!.chains.get(CHAIN_ID)!;
          return makeLogsSource({
            fetchLogs: inner, standard,
            initialChunk: chainCfg.initialChunk, maxChunk: chainCfg.maxChunk,
          });
        },
          txSource: makeTxSource({ chainId: CHAIN_ID, client, limit }),
          supports: makeSupportsInterface(client, CONTRACT),
          resolveDeployBlock: async () => {
            throw new Error('bootstrap must not run again on a second pass');
          },
          safeHead: async () => (await limit(() => client.getBlockNumber()))
            - BigInt(chain.confirmations),
        },
        options: {
          chainId: CHAIN_ID, contract: CONTRACT, level: 'full', toBlock: TO_BLOCK,
          costs: null, staleLockMs: 5 * 60_000,
        },
      });

      // The bound equals the watermark, so there is nothing left to do and the run says
      // so instead of re-walking the range.
      expect(second.status).toBe('up_to_date');
      const after = db.prepare('SELECT COUNT(*) AS n FROM transfers').get() as { n: number };
      expect(after.n).toBe(before.n);
    }, 600_000);

    it('orders firstMinters consistently by (block_number, log_index, batch_index)', () => {
      const rows = firstMinters(db, { chainId: CHAIN_ID, contract: CONTRACT, limit: 500 });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.minter).not.toBeNull();
      const keys = rows.map((r) => [r.blockNumber, r.logIndex, r.batchIndex] as const);
      const sorted = [...keys].sort((a, b) =>
        a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      expect(keys).toEqual(sorted);
    });

    it('states how thin the same-block ordering coverage actually is here', () => {
      // MEASURED, and reported rather than implied: 12 of 121 mint-bearing blocks hold
      // more than one mint, with a maximum of 7. So ties EXIST and the ordering
      // assertion above is not vacuous — but this is nowhere near the coverage of
      // anvil's twenty-in-one-block, which is what genuinely exercises tiebreaking.
      // Saying so is the point; a reader should not take this file as that evidence.
      const multi = db.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT block_number FROM transfers
           WHERE kind = 'mint' GROUP BY block_number HAVING COUNT(*) > 1
        )
      `).get() as { n: number };
      const maxPerBlock = db.prepare(`
        SELECT MAX(c) AS m FROM (
          SELECT COUNT(*) AS c FROM transfers WHERE kind = 'mint' GROUP BY block_number
        )
      `).get() as { m: number };
      process.stderr.write(
        `\n[smoke.provider] NOTE: same-block mint ties here are thin — ${multi.n} blocks ` +
        `with more than one mint, max ${maxPerBlock.m} per block. Ordering is really ` +
        'covered by density.anvil.test.ts (20 mints in one block, mined order asserted).\n\n',
      );
      expect(multi.n).toBeGreaterThan(0);
    });
  });
});
