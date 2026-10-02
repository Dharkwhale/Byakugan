import type Database from 'better-sqlite3';
import { makeBackfillPorts as realMakeBackfillPorts } from '../chain/ports.js';
import { callsPerSecond, VERIFIED as CU_VERIFIED } from '../chain/cuCosts.js';
import { detectStandard } from '../chain/standard.js';
import { estimateBackfill, formatEstimate } from '../cli/estimate.js';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import { backfill as realBackfill } from '../indexer/backfill.js';
import { probeEffectiveChunk } from '../indexer/logs.js';
import { newJobId } from '../jobId.js';
import type { Address, EnrichmentLevel } from '../types.js';
import type { HandleIndexDeps, IndexRun } from './commands/index.js';

/**
 * UNVERIFIED. A stated approximation, not a measurement.
 *
 * `alchemy_getAssetTransfers` has no range cap and pages by transfer count, so how many
 * calls a run takes is unknowable before the logs are read. Dividing the getLogs figure by
 * this is a guess at the ratio, used only so the confirmation gate does not demand a
 * `--yes` for a run that the cheap path will finish in minutes. It belongs in the
 * milestone report beside the compute-unit prices, which are unverified in the same way.
 * Never present the result as measured: the reply says "estimated".
 */
export const ASSET_TRANSFERS_SPEEDUP_UNVERIFIED = 50;

/**
 * The bot's chain-facing half of `/index`: builds the ports ONCE per command and returns the
 * label, the estimate and the run, all closed over that one build.
 *
 * There is deliberately no way to read `fetchPath` from anywhere but the build the run uses.
 * A label taken from a second probe can disagree with the first (the endpoint answers
 * differently, or a retry lands differently) and the progress line would then name a path
 * the run did not take.
 */
export function makePrepare(a: {
  config: Config;
  db: Database.Database;
  clock: Clock;
  staleLockMs: number;
  /** Injectable so a test can count builds. Production uses the real factory. */
  makePorts?: typeof realMakeBackfillPorts;
  /** Injectable so a test can see which ports the run was handed. */
  runBackfill?: typeof realBackfill;
  onWarn?(message: string): void;
}): HandleIndexDeps['prepare'] {
  const makePorts = a.makePorts ?? realMakeBackfillPorts;
  const runBackfill = a.runBackfill ?? realBackfill;
  const warn = a.onWarn ?? ((m: string) => { process.stderr.write(`warning: ${m}\n`); });

  return async ({ chainId, contract, deployBlock }): Promise<IndexRun> => {
    const chain = a.config.chains.get(chainId);
    if (!chain) {
      throw new Error(`chain ${chainId} is not configured on this bot`);
    }
    const built = await makePorts({
      config: a.config, chainId, contract: contract as Address, fetchPath: 'auto',
      ...(deployBlock === undefined ? {} : { deployBlockOverride: deployBlock }),
      onWarn: warn,
      onFallback: (n) => warn(
        `${n.from} failed, continuing with ${n.to} from block ${n.resumedAt}: ${n.reason}`,
      ),
    });

    return {
      fetchPath: built.fetchPath,

      estimate: async ({ toBlock, level }) => {
        const head = built.safeHead;
        const standard = await detectStandard(built.ports.supports, contract as Address);
        const resolved = await built.ports.resolveDeployBlock({ safeHead: head });
        const bound = toBlock !== undefined && toBlock < head ? toBlock : head;
        const from = BigInt(resolved.block);
        if (bound < from) {
          return {
            seconds: 0,
            summary: `dry run — nothing to index: the deploy block (${from}) is above the ` +
              `safe head (${head}).`,
          };
        }
        // MEASURED, not read from config: config.maxChunk can be orders of magnitude above
        // what the account's endpoint accepts.
        const probed = await probeEffectiveChunk({
          fetch: built.fetchLogs, nearBlock: head, requested: chain.maxChunk,
        });
        const requestsPerSecond = callsPerSecond('eth_getLogs', a.config.computeUnitsPerSecond);
        const estimate = estimateBackfill({
          fromBlock: from, toBlock: bound, chunkBlocks: probed.blocks, requestsPerSecond,
        });
        const viaAssetTransfers = built.fetchPath === 'getAssetTransfers';
        const pathNote = viaAssetTransfers
          ? '  fetch path        alchemy_getAssetTransfers, with eth_getLogs as fallback.\n' +
            '                    The getLogs figures below are therefore a CEILING.\n'
          : '  fetch path        eth_getLogs only — getAssetTransfers is unavailable here\n' +
            `                    (${built.fetchPathReason ?? 'no reason given'})\n`;
        return {
          // getAssetTransfers has no range cap, so the getLogs-derived figure is a ceiling
          // on that path; the divisor is UNVERIFIED (see its declaration).
          seconds: viaAssetTransfers
            ? estimate.logsSeconds / ASSET_TRANSFERS_SPEEDUP_UNVERIFIED
            : estimate.logsSeconds,
          summary: pathNote + formatEstimate({
            estimate,
            chunkNote: probed.note, chunkMeasured: probed.measured,
            chainId, chainName: chain.name, contract, standard,
            deployBlock: resolved.block, deployBlockSource: resolved.source,
            deployBlockValidated: resolved.validated,
            level, safeHead: head, requestsPerSecond, ratesVerified: CU_VERIFIED,
          }),
        };
      },

      runBackfill: async ({ level, toBlock, onProgress }) => runBackfill(a.db, {
        clock: a.clock, jobId: newJobId(), ports: built.ports,
        options: {
          chainId, contract: contract as Address, level: level as EnrichmentLevel,
          ...(toBlock === undefined ? {} : { toBlock }),
          // null, not a plausible default: without measured prices the per-tx path runs,
          // which cannot over-fetch. Same reasoning as the CLI.
          costs: null, staleLockMs: a.staleLockMs, onProgress,
        },
      }),
    };
  };
}
