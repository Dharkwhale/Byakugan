/**
 * `npm run index -- --contract 0x…`
 *
 * THE SCRUBBING IMPORT IS FIRST, and must stay first. It wraps `process.stdout.write`
 * and `process.stderr.write` and installs handlers for uncaught exceptions and
 * unhandled rejections, so no print site below — and no error escaping this file —
 * can put an RPC URL with an API key into output. A key reached a conversation
 * transcript that way once in this project and had to be rotated; the probe that
 * leaked it scrubbed per call site, in its happy path only. Scrubbing at the boundary
 * is the fix, and an import that must be first is the cheapest way to make it
 * unforgettable.
 */
import '../outputScrubbing.js';

import { detectStandard } from '../chain/standard.js';
import { makeBackfillPorts } from '../chain/ports.js';
import { VERIFIED as CU_VERIFIED, callsPerSecond } from '../chain/cuCosts.js';
import { systemClock } from '../clock.js';
import { loadConfig, type ChainConfig, type Config } from '../config.js';
import { openDb } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { backfill } from '../indexer/backfill.js';
import { probeEffectiveChunk } from '../indexer/logs.js';
import { newJobId } from '../jobId.js';
import { ConfigError } from '../errors.js';
import { parseArgs, USAGE, wantsHelp, type ParsedArgs } from './args.js';
import { estimateBackfill, formatEstimate, type CuPrices } from './estimate.js';
import { EXIT, formatError, describeError } from '../report.js';
import { createProgressReporter } from './progress.js';

const out = (s: string): void => { process.stdout.write(s); };
const err = (s: string): void => { process.stderr.write(s); };

/**
 * Compute-unit prices, read from the environment and ABSENT BY DEFAULT.
 *
 * Deliberately not given fallback values. These are measured provider facts, and a
 * plausible-looking default would be reported as a cost estimate — the one output
 * whose whole purpose is to be trusted before committing to an eleven-hour run. A
 * missing price produces "not computed" and says why, which is honest; an invented one
 * would produce a number that is wrong in the optimistic direction.
 */
function readCuPrices(env: Record<string, string | undefined>): CuPrices | undefined {
  const logs = env.CU_PER_GETLOGS;
  const tx = env.CU_PER_GETTRANSACTION;
  const block = env.CU_PER_GETBLOCK;
  if (!logs || !tx || !block) return undefined;
  const parsed = { perLogsCall: Number(logs), perTx: Number(tx), perBlock: Number(block) };
  for (const [name, v] of Object.entries(parsed)) {
    if (!Number.isFinite(v) || v <= 0) {
      throw new ConfigError(
        `compute-unit price ${name} is "${v}", which is not a positive number. Set ` +
        'CU_PER_GETLOGS, CU_PER_GETTRANSACTION and CU_PER_GETBLOCK to the measured ' +
        'values, or leave all three unset to skip cost estimation.',
      );
    }
  }
  return parsed;
}

function requireChain(config: Config, chainId: number): ChainConfig {
  const chain = config.chains.get(chainId);
  if (!chain) {
    const known = [...config.chains.keys()].join(', ') || 'none';
    throw new ConfigError(
      `chain ${chainId} is not configured (configured: ${known}). Set RPC_URL_${chainId} ` +
      'and add an entry to config/chains.json.',
    );
  }
  return chain;
}

async function main(argv: string[]): Promise<number> {
  if (wantsHelp(argv)) {
    out(USAGE);
    return EXIT.OK;
  }

  const config = loadConfig();
  const args: ParsedArgs = parseArgs(argv, config.defaultChainId);
  const chain = requireChain(config, args.chainId);
  const prices = readCuPrices(process.env);

  // ONE build: the ports, the capability probe and the label all come from it. The probe
  // runs inside `makeBackfillPorts`, before any indexing, which is what the real run needs
  // (the cheap path is silently never used otherwise) and what the dry run reports.
  const built = await makeBackfillPorts({
    config, chainId: args.chainId, contract: args.contract, fetchPath: args.fetchPath,
    ...(args.deployBlock === undefined ? {} : { deployBlockOverride: args.deployBlock }),
    onWarn: (message) => err(`warning: ${message}
`),
    onFallback: (notice) => {
      err(
        `warning: ${notice.from} failed, continuing with ${notice.to} from block ` +
        `${notice.resumedAt}. The two paths are verified to produce identical rows ` +
        `(scripts/compare-fetch-paths.ts), so the index is unaffected — only slower.
` +
        `  reason: ${notice.reason}
`,
      );
    },
  });
  const { ports, fetchLogs } = built;
  const supports = ports.supports;
  const assetSupported = built.fetchPath === 'getAssetTransfers';
  const safeHead = ports.safeHead;

  // ---------------------------------------------------------------- dry run
  if (args.dryRun) {
    // Resolves everything a real run would resolve and writes NOTHING — no database
    // is even opened. The guard this exists to be is only useful if it is cheaper
    // than the thing it guards against.
    const standard = await detectStandard(supports, args.contract);
    const head = await safeHead();
    const resolved = await ports.resolveDeployBlock({ safeHead: head });
    const bound = args.toBlock !== undefined && args.toBlock < head ? args.toBlock : head;
    const from = BigInt(resolved.block);

    if (bound < from) {
      out(
        `\ndry run — nothing to index: the deploy block (${from}) is above the safe ` +
        `head (${head}).\n\n`,
      );
      return EXIT.OK;
    }

    // MEASURE the chunk size rather than reading it from config. config.maxChunk is
    // 20,000 on Base while the measured cap on this account is 10, which made a
    // 38-million-block span report as "76 seconds" instead of days. One extra call
    // buys an estimate that is worth believing.
    out(
      assetSupported
        ? [
            '',
            '  fetch path        alchemy_getAssetTransfers — no range cap, roughly one',
            '                    page per 1000 transfers, with eth_getLogs as fallback.',
            '                    The getLogs figures below are therefore a CEILING.',
            '',
          ].join('\n')
        : [
            '',
            '  fetch path        eth_getLogs only — getAssetTransfers is unavailable here',
            `                    (${built.fetchPathReason ?? 'no reason given'})`,
            '',
          ].join('\n'),
    );
    const probed = await probeEffectiveChunk({
      fetch: fetchLogs, nearBlock: head, requested: chain.maxChunk,
    });

    out(formatEstimate({
      estimate: estimateBackfill({
        fromBlock: from,
        toBlock: bound,
        chunkBlocks: probed.blocks,
        requestsPerSecond: callsPerSecond('eth_getLogs', config.computeUnitsPerSecond),
        prices,
      }),
      chunkNote: probed.note,
      chunkMeasured: probed.measured,
      chainId: args.chainId,
      chainName: chain.name,
      contract: args.contract,
      standard,
      deployBlock: resolved.block,
      deployBlockSource: resolved.source,
      deployBlockValidated: resolved.validated,
      level: args.level,
      safeHead: head,
      requestsPerSecond: callsPerSecond('eth_getLogs', config.computeUnitsPerSecond),
      ratesVerified: CU_VERIFIED,
    }));
    return EXIT.OK;
  }

  // ---------------------------------------------------------------- real run
  const db = openDb(config.dbPath);
  try {
    runMigrations(db);
    const head = await safeHead();
    const bound = args.toBlock !== undefined && args.toBlock < head ? args.toBlock : head;

    out(
      `indexing ${args.contract} on chain ${args.chainId} (${chain.name}) at level ${args.level}\n` +
      (assetSupported
        ? '  via alchemy_getAssetTransfers, falling back to eth_getLogs on failure\n'
        : `  via eth_getLogs (${built.fetchPathReason ?? 'getAssetTransfers unavailable'})\n`),
    );

    const reporter = createProgressReporter({
      clock: systemClock,
      write: out,
      intervalMs: args.progressMs,
      contract: args.contract,
      chainId: args.chainId,
      fromBlock: 0n,
      toBlock: bound,
    });

    const result = await backfill(db, {
      clock: systemClock,
      jobId: newJobId(),
      ports,
      options: {
        chainId: args.chainId,
        contract: args.contract,
        level: args.level,
        toBlock: args.toBlock,
        // null, NOT a plausible default. Without measured prices the run takes
        // the per-tx path, which cannot over-fetch, rather than choosing on
        // invented evidence. Same reasoning as the dry run refusing to print a
        // cost it cannot compute.
        costs: prices ?? null,
        staleLockMs: 15 * 60_000,
        onProgress: (ctx) => reporter.onChunk(ctx),
      },
    });

    if (result.status === 'up_to_date') {
      out(`nothing to do: ${result.reason}\n`);
      return EXIT.OK;
    }
    reporter.finish({
      chunks: result.chunks,
      rows: result.rowsInserted,
      lastIndexedBlock: result.lastIndexedBlock,
    });
    return EXIT.OK;
  } finally {
    db.close();
  }
}

const argv = process.argv.slice(2);
try {
  process.exitCode = await main(argv);
} catch (error) {
  const reported = describeError(error);
  err(formatError(reported, { verbose: argv.includes('--verbose'), err: error }));
  process.exitCode = reported.exitCode;
}
