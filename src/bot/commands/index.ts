import type Database from 'better-sqlite3';
import type { Clock } from '../../clock.js';
import {
  CollectionLockedError, DeployBlockUnavailableError, EnrichmentLevelError, UsageError,
} from '../../errors.js';
import { humanizeSeconds } from '../../cli/estimate.js';
import type { ParsedArgs } from '../../cli/args.js';
import { describeError } from '../../report.js';
import { parseIndexCommand } from '../args.js';
import type { JobRegistry } from '../jobs.js';
import { createJobProgress } from '../progress.js';
import type { Replier } from '../replier.js';
import type { BackfillResult } from '../../indexer/backfill.js';

/**
 * A tappable command that would help, where one exists.
 *
 * Deliberately a table of COMMANDS rather than a second message mapping: the prose comes
 * from `describeError`, which both front ends share. "Re-index at full" reads worse in a
 * chat than the command itself, and chat affordances have no business in a shared module.
 */
export function nextCommand(
  err: unknown,
  a: { contract: string; chainId: number },
): string | undefined {
  if (err instanceof EnrichmentLevelError) return `/index ${a.contract} --chain ${a.chainId}`;
  if (err instanceof DeployBlockUnavailableError) {
    return `/index ${a.contract} --chain ${a.chainId} --deploy-block <block>`;
  }
  if (err instanceof CollectionLockedError) return `/status ${a.contract}`;
  if (err instanceof UsageError) return '/help';
  return undefined;
}

export interface HandleIndexDeps {
  text: string;
  replier: Replier;
  db: Database.Database;
  clock: Clock;
  registry: JobRegistry;
  defaultChainId: number | undefined;
  chainConfig: { name: string };
  /**
   * Which source the run will use, for the registry and the progress line.
   *
   * Passed in rather than read off the result, because the result only exists when the
   * job ENDS and the progress line has to name it from the first edit. Naming it is the
   * whole point: a capability probe wired into the dry-run path only meant every real CLI
   * run silently used getLogs, finishing correctly in seventy chunks where one page would
   * have done, and nothing in the output said so.
   */
  fetchPath: string;
  runBackfill(a: {
    chainId: number; contract: string; level: ParsedArgs['level'];
    toBlock?: bigint; deployBlock?: number;
    onProgress(ctx: { fromBlock: bigint; toBlock: bigint; inserted: number }): void;
  }): Promise<BackfillResult>;
  /**
   * Expected duration, plus the full dry-run report for `--dry-run`. Injected so the
   * handler needs no chain.
   *
   * `summary` is built by the caller from the CLI's `formatEstimate`, so the bot reports a
   * dry run in the same format the CLI does rather than growing a thinner one of its own.
   */
  estimate(a: { chainId: number; contract: string; toBlock?: bigint; deployBlock?: number }):
    Promise<{ seconds: number; summary: string }>;
  confirmThresholdSeconds: number;
}

export async function handleIndex(d: HandleIndexDeps): Promise<void> {
  let args: ReturnType<typeof parseIndexCommand>;
  try {
    args = parseIndexCommand(d.text, d.defaultChainId);
  } catch (err) {
    const reported = describeError(err);
    // `nextCommand` needs a contract and chain, which a failed parse does not have, so the
    // pointer out of a first mistake is written here.
    await d.replier.reply(`${reported.headline}\n\n  ${reported.detail}\n\n  next: /help`);
    return;
  }

  const { contract, chainId, level, toBlock, deployBlock, confirmed, dryRun } = args;

  const state = d.registry.inspect(d.db, { chainId, contract });
  if (state.kind === 'running') {
    const minutes = Math.round((d.clock.now() - state.startedAt) / 60_000);
    await d.replier.reply(
      `Already indexing ${contract} on chain ${chainId}.\n` +
      `  started ${minutes} minutes ago, via ${state.source}` +
      (state.lastBlock === undefined ? '' : `, at block ${state.lastBlock}`) + '\n' +
      '  Wait for it to finish — /status for detail.',
    );
    return;
  }
  // An orphan whose lock has ALREADY expired falls through and starts. `inspect` reports it
  // as orphaned (accurately: a lock row exists), but only `claimCollection` ever steals a
  // stale lock, and that runs only inside `backfill`. Refusing here would mean backfill
  // never runs, the lock is never stolen, and the collection is wedged for good.
  if (state.kind === 'orphaned' && d.clock.now() < state.expiresAt) {
    // NOT the same as running. A previous process died holding the lock; nothing is
    // working on this collection and the lock clears itself.
    const minutes = Math.max(0, Math.round((state.expiresAt - d.clock.now()) / 60_000));
    await d.replier.reply(
      `A previous run left a lock on ${contract} (chain ${chainId}) and did not release it.\n` +
      `  Nothing is indexing it now. The lock expires in ${minutes} minutes and clears itself.\n` +
      '  Try again after that.',
    );
    return;
  }

  let estimated: { seconds: number; summary: string };
  try {
    estimated = await d.estimate({
      chainId, contract,
      ...(toBlock === undefined ? {} : { toBlock }),
      ...(deployBlock === undefined ? {} : { deployBlock }),
    });
  } catch (err) {
    // The likeliest failure of the command: an unresolvable deploy block is raised here, not
    // in the job. It must reply with its next action rather than reject into silence.
    const reported = describeError(err);
    const next = nextCommand(err, { contract, chainId });
    await d.replier.reply(
      `${reported.headline}\n\n  ${reported.detail}` +
      (reported.hint ? `\n\n  ${reported.hint}` : '') +
      (next ? `\n\n  next: ${next}` : ''),
    );
    return;
  }
  const { seconds, summary } = estimated;

  // A DRY RUN ENDS HERE, before the confirmation gate and before anything that starts a
  // job. It sits ahead of the gate so a dry run on a long collection shows the estimate
  // rather than a prompt asking the user to confirm a run they asked not to make, and so
  // no later edit to the gate can route a dry run into indexing. `--yes` cannot reach
  // past it: the only way to start a job is below this return.
  if (dryRun) {
    await d.replier.reply(summary);
    return;
  }

  if (!confirmed && seconds > d.confirmThresholdSeconds) {
    await d.replier.reply(
      `Indexing ${contract} on chain ${chainId} at level ${level} is estimated at ` +
      `${humanizeSeconds(seconds)}.\n` +
      '  A started job cannot be cancelled and holds the collection lock.\n' +
      `  To go ahead: /index ${contract} --chain ${chainId} --yes`,
    );
    return;
  }

  const sent = await d.replier.reply(
    `Indexing ${contract} on chain ${chainId} (${d.chainConfig.name}) at level ${level}.\n` +
    `  estimated ${humanizeSeconds(seconds)}; progress follows in this message.`,
  );

  const progress = createJobProgress({
    replier: d.replier, messageId: sent.messageId, clock: d.clock,
    header: `Indexing ${contract} on chain ${chainId} at level ${level}`,
  });

  d.registry.start({
    chainId, contract, source: d.fetchPath,
    onError: (err) => {
      // Swallowed: `fail` rejects only when its final edit could not be delivered, which
      // means the reply channel itself is failing and there is nowhere left to report to.
      // The registry's try/catch around onError catches a SYNCHRONOUS throw only, so an
      // unhandled rejection would otherwise escape this detached job. What is lost: the
      // user is never told the job failed, and nothing is logged here.
      progress.fail(describeError(err), nextCommand(err, { contract, chainId }))
        .catch(() => undefined);
    },
    run: async () => {
      let rows = 0;
      const result = await d.runBackfill({
        chainId, contract, level,
        ...(toBlock === undefined ? {} : { toBlock }),
        ...(deployBlock === undefined ? {} : { deployBlock }),
        onProgress: (ctx) => {
          rows += ctx.inserted;
          d.registry.note({ chainId, contract, lastBlock: Number(ctx.toBlock) });
          // Swallowed: the index is the valuable work and a cosmetic progress edit failing
          // must not abort it. What is lost: a transport failure on a progress edit becomes
          // invisible, and the message may stop updating while the job carries on.
          progress.onChunk({
            fromBlock: ctx.fromBlock, toBlock: ctx.toBlock, rows, source: d.fetchPath,
          }).catch(() => undefined);
        },
      });
      await progress.finish(
        result.status === 'indexed'
          ? `Indexed ${contract} on chain ${chainId} at level ${level}.\n` +
            `  ERC-${result.standard}, deploy block ${result.deployBlock}\n` +
            `  ${result.rowsInserted} rows in ${result.chunks} chunk(s), via ${result.source}\n` +
            `  indexed through block ${result.lastIndexedBlock}`
          : `Nothing to do for ${contract}: ${result.reason}`,
      );
    },
  });
}
