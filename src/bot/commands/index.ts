import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
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

export interface IndexRun {
  /**
   * Which source the run will use, for the registry and the progress line. Named from the
   * first edit, so it is known before the job ends rather than read off the result.
   */
  fetchPath: string;
  runBackfill(a: {
    chainId: number; contract: string; level: ParsedArgs['level'];
    toBlock?: bigint; deployBlock?: number;
    onProgress(ctx: { fromBlock: bigint; toBlock: bigint; inserted: number }): void;
  }): Promise<BackfillResult>;
  /**
   * Expected duration, plus the full dry-run report for `--dry-run`. `summary` is built
   * from the CLI's `formatEstimate`, so the bot reports a dry run in the same format.
   */
  estimate(a: {
    chainId: number; contract: string; level: ParsedArgs['level'];
    toBlock?: bigint; deployBlock?: number;
  }):
    Promise<{ seconds: number; summary: string }>;
}

export interface HandleIndexDeps {
  text: string;
  replier: Replier;
  db: Database.Database;
  clock: Clock;
  registry: JobRegistry;
  /**
   * Where a swallowed progress failure goes. Passed in rather than formatted here: the
   * project scrubs secrets at serialization, inside the logger, so an error object handed to
   * it is scrubbed however deeply the secret is nested, where a string built at this call
   * site would have to remember to be.
   */
  logger: Logger;
  defaultChainId: number | undefined;
  /**
   * The display name of a chain, looked up with the chain the command ACTUALLY parsed.
   *
   * A function rather than a fixed `{ name }` resolved by the caller: the caller does not
   * know the chain until `parseIndexCommand` has run, and resolving the default's name up
   * front labels `/index 0x… --chain 8453` with the default chain's name while indexing
   * 8453, on the one line telling the user what is happening.
   */
  chainName(chainId: number): string;
  /**
   * Builds everything chain-facing for ONE command, once, and returns the label, the
   * estimate and the run from that single build.
   *
   * This is one call rather than three separate dependencies because the real fetch path is
   * only knowable after probing a SPECIFIC contract on a specific chain, and the command's
   * chain and contract are not known until it has been parsed. A label supplied separately
   * from the run can come from a different probe than the one the run uses, and then the
   * progress line names a path the run did not take: the dry-run-only capability probe
   * defect, shipped once already, wearing a new hat. Nothing here can read the label from
   * anywhere but the same `IndexRun` that runs the job.
   *
   * A throw is reported to the user with its next action, like an estimate failure.
   */
  prepare(a: { chainId: number; contract: string; deployBlock?: number }):
    Promise<IndexRun>;
  confirmThresholdSeconds: number;
}

function alreadyIndexing(
  d: Pick<HandleIndexDeps, 'clock'>, a: { contract: string; chainId: number },
  state: { startedAt: number; source: string; lastBlock?: number },
): string {
  const minutes = Math.round((d.clock.now() - state.startedAt) / 60_000);
  return (
    `Already indexing ${a.contract} on chain ${a.chainId}.\n` +
    `  started ${minutes} minutes ago, via ${state.source}` +
    (state.lastBlock === undefined ? '' : `, at block ${state.lastBlock}`) + '\n' +
    '  Wait for it to finish — /status for detail.'
  );
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
    await d.replier.reply(alreadyIndexing(d, { contract, chainId }, state));
    return;
  }
  // An orphan whose lock has ALREADY expired falls through and starts. `inspect` reports it
  // as orphaned (accurately: a lock row exists), but only `claimCollection` ever steals a
  // stale lock, and that runs only inside `backfill`. Refusing here would mean backfill
  // never runs, the lock is never stolen, and the collection is wedged for good.
  //
  // `<=`, not `<`, so the two predicates agree on the exact boundary. `claimCollection`
  // steals only when `locked_at < now - staleMs`, which is STRICT: at `now == expiresAt`
  // it still refuses. Falling through on that millisecond would start a job whose claim
  // then fails, so the user gets an error where "try again after that" is the true answer.
  if (state.kind === 'orphaned' && d.clock.now() <= state.expiresAt) {
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

  let run: IndexRun;
  let estimated: { seconds: number; summary: string };
  try {
    run = await d.prepare({
      chainId, contract,
      ...(deployBlock === undefined ? {} : { deployBlock }),
    });
    estimated = await run.estimate({
      chainId, contract, level,
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

  // CLAIM HERE: after every gate that starts nothing (dry run, confirmation), and BEFORE
  // the reply that promises progress. `inspect` above and this claim are separated by
  // `await run.estimate` — a window in which a second `/index` for the same collection also
  // passed `inspect`. Gating only on `inspect` let both reach the "progress follows" reply,
  // and the loser then hit `start`'s throw having already told its user a job was running.
  // Claiming is synchronous insert-if-absent, so exactly one of them wins and the loser
  // is told before it says anything it cannot honour.
  const claim = d.registry.claim({ chainId, contract, source: run.fetchPath });
  if (claim === null) {
    const other = d.registry.inspect(d.db, { chainId, contract });
    await d.replier.reply(
      other.kind === 'running'
        ? alreadyIndexing(d, { contract, chainId }, other)
        : `Another job is already indexing ${contract} on chain ${chainId}.\n` +
          '  Wait for it to finish — /status for detail.',
    );
    return;
  }

  // A CLAIM THAT IS NEVER RUN MUST BE RELEASED. The reply below can throw (Telegram is
  // down, the chat is gone), and the map has no expiry: a leaked slot would answer
  // "already indexing" for this collection until the process restarted. `release` after
  // `run` is a no-op, so the `finally` is correct on both paths.
  try {
    const sent = await d.replier.reply(
      `Indexing ${contract} on chain ${chainId} (${d.chainName(chainId)}) at level ${level}.\n` +
      `  estimated ${humanizeSeconds(seconds)}; progress follows in this message.`,
    );
    const progress = createJobProgress({
      replier: d.replier, messageId: sent.messageId, clock: d.clock,
      header: `Indexing ${contract} on chain ${chainId} at level ${level}`,
      onPermanentFailure: (err) => {
        d.logger.warn(
          { err, chainId, contract },
          'progress edits can no longer be delivered; the job continues without them',
        );
      },
    });
    claim.run({
      onError: (err) => {
        // Swallowed, but LOGGED: `fail` rejects only when its final edit could not be
        // delivered (a permanent failure never rejects; it silences the reporter instead),
        // which means the reply channel itself is failing and there is nowhere left to report
        // to. The registry's try/catch around onError catches a SYNCHRONOUS throw only, so an
        // unhandled rejection would otherwise escape this detached job. The user is never
        // told the job failed, so the log is the only record that they were not.
        progress.fail(describeError(err), nextCommand(err, { contract, chainId }))
          .catch((failErr: unknown) => {
            d.logger.error(
              { err: failErr, chainId, contract },
              'could not deliver the job failure report',
            );
          });
      },
      run: async () => {
        let rows = 0;
        const result = await run.runBackfill({
          chainId, contract, level,
          ...(toBlock === undefined ? {} : { toBlock }),
          ...(deployBlock === undefined ? {} : { deployBlock }),
          onProgress: (ctx) => {
            rows += ctx.inserted;
            d.registry.note({ chainId, contract, lastBlock: Number(ctx.toBlock) });
            // Swallowed, but LOGGED: the index is the valuable work and a cosmetic progress
            // edit failing must not abort it. A permanent failure never reaches here (the
            // reporter goes quiet and logs it once); what does is a transient one, and the
            // next tick tries again, so this logs at warn rather than error.
            progress.onChunk({
              fromBlock: ctx.fromBlock, toBlock: ctx.toBlock, rows, source: run.fetchPath,
            }).catch((editErr: unknown) => {
              d.logger.warn(
                { err: editErr, chainId, contract },
                'progress edit failed; the job continues',
              );
            });
          },
        });
        // A FAILED DELIVERY IS NOT A FAILED JOB, and the two must not share a log line.
        // `finish` rejects when its final edit could not be delivered — by which point the
        // rows are committed and the watermark is advanced. Letting that reject `run` sends
        // it to `onError`, which would report "could not deliver the job failure report"
        // for a collection that is fully indexed, and an operator reading logs would go
        // looking for a failure that never happened. Caught here and named for what it is.
        await progress.finish(
          result.status === 'indexed'
            ? `Indexed ${contract} on chain ${chainId} at level ${level}.\n` +
              `  ERC-${result.standard}, deploy block ${result.deployBlock}\n` +
              `  ${result.rowsInserted} rows in ${result.chunks} chunk(s), via ${result.source}\n` +
              `  indexed through block ${result.lastIndexedBlock}`
            : `Nothing to do for ${contract}: ${result.reason}`,
        ).catch((deliverErr: unknown) => {
          d.logger.error(
            { err: deliverErr, chainId, contract, status: result.status },
            'the index COMPLETED but its result message could not be delivered',
          );
        });
      },
    });
  } finally {
    claim.release();
  }
}
