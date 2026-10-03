import type Database from 'better-sqlite3';
import type { Clock } from '../../clock.js';
import { firstMinters, firstRecipients, overlap } from '../../db/repositories/analytics.js';
import { getCollection } from '../../db/repositories/collections.js';
import { countUnclassified } from '../../db/repositories/enrichment.js';
import { EnrichmentLevelError } from '../../errors.js';
import { describeError } from '../../report.js';
import {
  parseQueryCommand, type AddressArity, type QueryArgs, type QueryOption,
} from '../args.js';
import { respond } from '../render.js';
import type { Replier } from '../replier.js';
import type { JobRegistry } from '../jobs.js';
import { nextCommand } from './index.js';
import type { Address } from '../../types.js';

export interface QueryDeps {
  text: string;
  replier: Replier;
  db: Database.Database;
  /** Stamps the CSV filename. Injected so output is deterministic under test. */
  clock: Clock;
  defaultChainId: number | undefined;
  /**
   * Which collections have a job running in THIS process. A query answered while one is
   * running is answered from a partial index, and has to say so.
   */
  registry: JobRegistry;
}

const USAGE = {
  firstminters: '/firstminters 0x… [--chain N] [--limit N]',
  firstrecipients: '/firstrecipients 0x… [--chain N] [--limit N]',
  overlap: '/overlap 0x… 0x… [--chain N] [--min N]',
} as const;

/**
 * Parses the command, or replies with the reason and the usage line and returns undefined.
 *
 * `parseQueryCommand` already throws on an empty address list, so `contracts[0]` exists
 * whenever this returns a result. The usage line is appended to every parse failure so the
 * user sees the shape of the command they got wrong, not only the fault.
 */
async function parseOrReply(
  d: QueryDeps, usage: string, arity: AddressArity, accepts: readonly QueryOption[],
): Promise<QueryArgs | undefined> {
  try {
    return parseQueryCommand(d.text, d.defaultChainId, arity, accepts);
  } catch (err) {
    const r = describeError(err);
    await d.replier.reply(`${r.headline}\n\n  ${r.detail}\n\n  usage: ${usage}`);
    return undefined;
  }
}

/** The one failure reply: prose from `describeError`, plus the tappable next action. */
async function replyError(
  d: QueryDeps, err: unknown, a: { contract: string; chainId: number },
  /** Replaces the single command `nextCommand` would offer, for a multi-collection query. */
  nextOverride?: string,
): Promise<void> {
  const r = describeError(err);
  const next = nextOverride ?? nextCommand(err, a);
  await d.replier.reply(
    `${r.headline}\n\n  ${r.detail}` +
    (r.hint ? `\n\n  ${r.hint}` : '') + (next ? `\n\n  next: ${next}` : ''),
  );
}

/**
 * The extent of the snapshot a reply was answered from.
 *
 * "Complete" has no fixed meaning against a live chain: every index trails the head by the
 * configured confirmations, and one may trail further. So each reply states the block it was
 * answered THROUGH instead of implying it covers everything. Callers have already checked the
 * collection is indexed; the fallback says "unknown" rather than printing an invented block.
 */
function indexedThrough(db: Database.Database, chainId: number, contract: string): number | string {
  const c = getCollection(db, chainId, contract);
  return c.state === 'indexed' ? c.lastIndexedBlock : 'unknown';
}

/**
 * The extent of the WEAKEST collection in a multi-collection answer.
 *
 * `overlap` counts a wallet once per collection it acquired in, so a wallet whose purchase
 * sits above one collection's watermark is undercounted — and the lowest watermark is
 * therefore the limit on the whole answer, not an average of them. Reporting the minimum
 * states that limit; reporting each one leaves the reader to find it.
 *
 * Returns 'unknown' if any collection's watermark is unavailable, because the minimum of a
 * set containing an unknown is unknown — not the smallest of the ones that happened to be
 * readable. Returning the smallest readable one would overstate the answer's reach using
 * precisely the collection we know least about.
 *
 * EXPORTED to be tested directly. Every caller pre-checks `notIndexed` and returns early,
 * so the unknown branch cannot be reached through a handler — a mutant that ignored an
 * unknown survived the whole bot suite. The rule is worth pinning anyway: it holds the
 * moment someone drops that pre-check, and a surviving mutant on a stated rule is what this
 * project treats as a test that advertises a guarantee it does not have.
 */
export function leastIndexedThrough(
  db: Database.Database,
  chainId: number,
  contracts: readonly string[],
): number | string {
  let least = Number.POSITIVE_INFINITY;
  for (const contract of contracts) {
    const through = indexedThrough(db, chainId, contract);
    if (typeof through !== 'number') return 'unknown';
    least = Math.min(least, through);
  }
  return Number.isFinite(least) ? least : 'unknown';
}

/**
 * Collections in the request that have never been indexed.
 *
 * Reported BY NAME rather than folded into an empty result. `firstMinters` on an unknown
 * collection returns `[]`, which renders identically to a collection that genuinely has
 * no mints, so an unindexed collection would look like a real answer of "nobody".
 */
function notIndexed(db: Database.Database, chainId: number, contracts: Address[]): Address[] {
  return contracts.filter((c) => getCollection(db, chainId, c).state === 'not_indexed');
}

/**
 * The jobs running right now for the given collections, with what the registry knows of them.
 *
 * The registry is asked rather than the lock table, because a lock row can outlive its
 * process: an ORPHANED lock means nothing is indexing, and a notice claiming otherwise would
 * be false in the other direction. Only a job in this process's map counts as running.
 */
function runningJobs(
  d: QueryDeps, chainId: number, contracts: readonly string[],
): Array<{ contract: string; source: string; lastBlock?: number }> {
  const out: Array<{ contract: string; source: string; lastBlock?: number }> = [];
  for (const contract of contracts) {
    const state = d.registry.inspect(d.db, { chainId, contract });
    if (state.kind === 'running') {
      out.push({
        contract, source: state.source,
        ...(state.lastBlock === undefined ? {} : { lastBlock: state.lastBlock }),
      });
    }
  }
  return out;
}

/**
 * The line that accompanies an answer given from a partial index.
 *
 * It ACCOMPANIES the answer and never replaces it: partial data labelled as partial is more
 * use than a refusal, and the same honesty as the least-indexed-block title. What it must not
 * do is let the rows pass for complete. `through` is the watermark — the block the committed
 * rows actually reach — not the registry's `lastBlock`, which is progress and only
 * describes the job. It is bounded in length by construction (counts, not a list of
 * collections), because the title becomes a document caption.
 */
function inProgressNotice(
  jobs: ReadonlyArray<{ source: string; lastBlock?: number }>,
  total: number,
  through: number | string,
): string {
  const head = total === 1
    ? 'INDEXING IN PROGRESS'
    : `INDEXING IN PROGRESS on ${jobs.length} of ${total} collections`;
  // One collection has one job to describe. With several, naming one job's source would
  // misdescribe the others.
  const job = total === 1 ? jobs[0] : undefined;
  const detail = job === undefined
    ? ''
    : ` (via ${job.source}${job.lastBlock === undefined ? '' : `, now at block ${job.lastBlock}`})`;
  return `${head}${detail}: this answer covers blocks up to ${through} only and may change.`;
}

/** The notice on its own line, or nothing when no job is running. */
function noticeLine(
  jobs: ReadonlyArray<{ source: string; lastBlock?: number }>,
  total: number,
  through: number | string,
): string {
  return jobs.length === 0 ? '' : `\n${inProgressNotice(jobs, total, through)}`;
}

function notIndexedReply(
  contract: string, chainId: number, what: string, indexing: boolean,
): string {
  // A job is running but has committed nothing yet (still resolving the deploy block), so
  // there is no watermark to answer from. That is a different fact from "never indexed" and
  // tapping /index would only be refused as a duplicate.
  if (indexing) {
    return (
      `${contract} on chain ${chainId} is being indexed, but no blocks are indexed yet, so ` +
      `there is nothing to report. This is different from having no ${what}. ` +
      'Try again shortly.'
    );
  }
  return (
    `${contract} on chain ${chainId} is not indexed, so there is nothing to report. ` +
    `This is different from having no ${what}.\n  /index ${contract} --chain ${chainId}`
  );
}

export async function handleFirstMinters(d: QueryDeps): Promise<void> {
  const parsed = await parseOrReply(d, USAGE.firstminters, 'one', ['limit']);
  if (parsed === undefined) return;
  const contract = parsed.contracts[0];
  // Unreachable today (the parser throws first); kept so the type checker is not what
  // vouches for `contracts[0]`.
  if (contract === undefined) {
    await d.replier.reply(`Send an address: ${USAGE.firstminters}`);
    return;
  }
  const jobs = runningJobs(d, parsed.chainId, [contract]);
  if (notIndexed(d.db, parsed.chainId, [contract]).length > 0) {
    await d.replier.reply(notIndexedReply(contract, parsed.chainId, 'minters', jobs.length > 0));
    return;
  }

  try {
    // INSIDE the try: this reads the database, so a throw here has to reach
    // `replyError` like every other failure in this handler rather than rejecting the
    // handler and leaving the user with nothing.
    const through = indexedThrough(d.db, parsed.chainId, contract);
    const rows = firstMinters(d.db, { chainId: parsed.chainId, contract, limit: parsed.limit });
    await respond(d.replier, {
      title: `First minters of ${contract} (chain ${parsed.chainId}), ` +
        `indexed through block ${through}` + noticeLine(jobs, 1, through),
      // `first recipient` is shown so a mint sent to someone other than its acting wallet is
      // visible as such, and to whom; a yes/no column would only say that it happened.
      headers: ['minter', 'first recipient', 'minted', 'recipients', 'to others', 'block', 'log'],
      rows: rows.map((r) => [
        r.minter, r.firstRecipient, String(r.minted), String(r.recipients),
        r.mintedToOthers ? 'yes' : 'no', String(r.blockNumber), String(r.logIndex),
      ]),
      filename: `firstminters-${parsed.chainId}-${contract}-${d.clock.now()}.csv`,
    });
  } catch (err) {
    await replyError(d, err, { contract, chainId: parsed.chainId });
  }
}

/**
 * The companion query, and the ONLY one with no enrichment gate.
 *
 * `to_addr` comes from the log, so this answers completely at every level including
 * `logs_only`, which is the whole reason `logs_only` exists as something other than dead
 * configuration. `minter` is nullable here and is rendered as "unknown (not enriched)"
 * rather than left blank: a blank column reads as an address that nobody noticed was
 * missing, and the difference between "not fetched" and "no sender" is exactly the
 * distinction this project keeps having to defend.
 */
export async function handleFirstRecipients(d: QueryDeps): Promise<void> {
  const parsed = await parseOrReply(d, USAGE.firstrecipients, 'one', ['limit']);
  if (parsed === undefined) return;
  const contract = parsed.contracts[0];
  if (contract === undefined) {
    await d.replier.reply(`Send an address: ${USAGE.firstrecipients}`);
    return;
  }
  const jobs = runningJobs(d, parsed.chainId, [contract]);
  if (notIndexed(d.db, parsed.chainId, [contract]).length > 0) {
    await d.replier.reply(notIndexedReply(contract, parsed.chainId, 'recipients', jobs.length > 0));
    return;
  }

  try {
    // INSIDE the try: this reads the database, so a throw here has to reach
    // `replyError` like every other failure in this handler rather than rejecting the
    // handler and leaving the user with nothing.
    const through = indexedThrough(d.db, parsed.chainId, contract);
    const rows = firstRecipients(d.db, { chainId: parsed.chainId, contract, limit: parsed.limit });
    await respond(d.replier, {
      title: `First mint recipients of ${contract} (chain ${parsed.chainId}), ` +
        `indexed through block ${through}` + noticeLine(jobs, 1, through),
      headers: ['recipient', 'minter', 'received', 'block', 'log'],
      rows: rows.map((r) => [
        r.recipient,
        r.minter ?? 'unknown (not enriched)',
        String(r.received), String(r.blockNumber), String(r.logIndex),
      ]),
      filename: `firstrecipients-${parsed.chainId}-${contract}-${d.clock.now()}.csv`,
    });
  } catch (err) {
    await replyError(d, err, { contract, chainId: parsed.chainId });
  }
}

export async function handleOverlap(d: QueryDeps): Promise<void> {
  const parsed = await parseOrReply(d, USAGE.overlap, 'many', ['min']);
  if (parsed === undefined) return;
  const first = parsed.contracts[0];
  // parseQueryCommand already deduped, so a repeated address cannot inflate this count.
  if (first === undefined || parsed.contracts.length < 2) {
    await d.replier.reply(`Send at least two different collections: ${USAGE.overlap}`);
    return;
  }

  const jobs = runningJobs(d, parsed.chainId, parsed.contracts);
  const indexing = new Set(jobs.map((j) => j.contract));
  const missing = notIndexed(d.db, parsed.chainId, parsed.contracts);
  if (missing.length > 0) {
    const toIndex = missing.filter((c) => !indexing.has(c));
    await d.replier.reply(
      'These are not indexed, so they cannot be counted:\n' +
      missing.map((c) => `  ${c} — ${indexing.has(c) ? 'indexing, no blocks indexed yet' : 'not indexed'}`)
        .join('\n') +
      (toIndex.length > 0
        ? `\n\nIndex them first: ${toIndex.map((c) => `/index ${c} --chain ${parsed.chainId}`).join('  ')}`
        : '\n\nTry again shortly.'),
    );
    return;
  }

  try {
    // INSIDE the try, for the same reason as the other two handlers: it reads the
    // database and a throw must be reported, not escape the handler.
    const through = leastIndexedThrough(d.db, parsed.chainId, parsed.contracts);
    // Throws EnrichmentLevelError on an index that cannot tell a buy from a transfer. It is
    // surfaced below rather than caught here: an empty table would be a wrong answer.
    // No `--limit` here, and not because it was forgotten: the parse path now REFUSES it for
    // this command rather than accepting and ignoring it, and `overlap` deliberately returns
    // every wallet that qualifies. Capping it by default would silently change the answer —
    // "wallets in 3+ of these collections" is not a top-N question — so the missing ROW BOUND
    // stays an honest gap in the milestone report instead of being closed with a cap nobody
    // asked for.
    const rows = overlap(d.db, {
      chainId: parsed.chainId, contracts: parsed.contracts, minCollections: parsed.min,
    });
    await respond(d.replier, {
      // The LEAST-indexed collection, not a list of all of them. Two reasons, and the
      // second is why the list was wrong rather than merely long.
      //
      // It is the honest number: an overlap answer is only as complete as its weakest
      // member, because a wallet missing from one collection's range is missing from the
      // count. The minimum names the binding constraint; a list makes the reader find it.
      //
      // And it is BOUNDED BY CONSTRUCTION. The title becomes the document caption in
      // `respond`, and a per-collection list grew about 52 characters per collection — so a
      // wide `/overlap` would have built a caption Telegram rejects, turning a long answer
      // into no answer. Per-collection watermarks live in `/status`, which reports one
      // collection at a time and has room for them.
      title: `Wallets in ${parsed.min}+ of ${parsed.contracts.length} collections ` +
        `(chain ${parsed.chainId}), indexed through block ` +
        `${through} at the least (/status for each)` +
        // ANY named collection with a running job makes the whole answer partial: a wallet
        // missing from one collection's range is missing from the count.
        noticeLine(jobs, parsed.contracts.length, through),
      headers: ['wallet', 'collections'],
      rows: rows.map((r) => [r.address, String(r.collections)]),
      filename: `overlap-${parsed.chainId}-${parsed.contracts.length}-${d.clock.now()}.csv`,
    });
  } catch (err) {
    // One re-index per collection that is actually short of data, recomputed from the rows.
    // Offering the first requested collection would be a tappable action that re-indexes a
    // collection that was never the problem.
    const offenders = err instanceof EnrichmentLevelError
      ? parsed.contracts.filter((c) => countUnclassified(d.db, parsed.chainId, c) > 0)
      : [];
    const next = offenders.length > 0
      ? offenders.map((c) => `/index ${c} --chain ${parsed.chainId}`).join('  ')
      : undefined;
    await replyError(d, err, { contract: first, chainId: parsed.chainId }, next);
  }
}
