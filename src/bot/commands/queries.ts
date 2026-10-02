import type Database from 'better-sqlite3';
import type { Clock } from '../../clock.js';
import { firstMinters, firstRecipients, overlap } from '../../db/repositories/analytics.js';
import { getCollection } from '../../db/repositories/collections.js';
import { countUnclassified } from '../../db/repositories/enrichment.js';
import { EnrichmentLevelError } from '../../errors.js';
import { describeError } from '../../report.js';
import { parseQueryCommand, type QueryArgs } from '../args.js';
import { respond } from '../render.js';
import type { Replier } from '../replier.js';
import { nextCommand } from './index.js';
import type { Address } from '../../types.js';

export interface QueryDeps {
  text: string;
  replier: Replier;
  db: Database.Database;
  /** Stamps the CSV filename. Injected so output is deterministic under test. */
  clock: Clock;
  defaultChainId: number | undefined;
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
async function parseOrReply(d: QueryDeps, usage: string): Promise<QueryArgs | undefined> {
  try {
    return parseQueryCommand(d.text, d.defaultChainId);
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
 * Collections in the request that have never been indexed.
 *
 * Reported BY NAME rather than folded into an empty result. `firstMinters` on an unknown
 * collection returns `[]`, which renders identically to a collection that genuinely has
 * no mints, so an unindexed collection would look like a real answer of "nobody".
 */
function notIndexed(db: Database.Database, chainId: number, contracts: Address[]): Address[] {
  return contracts.filter((c) => getCollection(db, chainId, c).state === 'not_indexed');
}

function notIndexedReply(contract: string, chainId: number, what: string): string {
  return (
    `${contract} on chain ${chainId} is not indexed, so there is nothing to report. ` +
    `This is different from having no ${what}.\n  /index ${contract} --chain ${chainId}`
  );
}

export async function handleFirstMinters(d: QueryDeps): Promise<void> {
  const parsed = await parseOrReply(d, USAGE.firstminters);
  if (parsed === undefined) return;
  const contract = parsed.contracts[0];
  // Unreachable today (the parser throws first); kept so the type checker is not what
  // vouches for `contracts[0]`.
  if (contract === undefined) {
    await d.replier.reply(`Send an address: ${USAGE.firstminters}`);
    return;
  }
  if (notIndexed(d.db, parsed.chainId, [contract]).length > 0) {
    await d.replier.reply(notIndexedReply(contract, parsed.chainId, 'minters'));
    return;
  }

  try {
    const rows = firstMinters(d.db, { chainId: parsed.chainId, contract, limit: parsed.limit });
    await respond(d.replier, {
      title: `First minters of ${contract} (chain ${parsed.chainId}), ` +
        `indexed through block ${indexedThrough(d.db, parsed.chainId, contract)}`,
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
  const parsed = await parseOrReply(d, USAGE.firstrecipients);
  if (parsed === undefined) return;
  const contract = parsed.contracts[0];
  if (contract === undefined) {
    await d.replier.reply(`Send an address: ${USAGE.firstrecipients}`);
    return;
  }
  if (notIndexed(d.db, parsed.chainId, [contract]).length > 0) {
    await d.replier.reply(notIndexedReply(contract, parsed.chainId, 'recipients'));
    return;
  }

  try {
    const rows = firstRecipients(d.db, { chainId: parsed.chainId, contract, limit: parsed.limit });
    await respond(d.replier, {
      title: `First mint recipients of ${contract} (chain ${parsed.chainId}), ` +
        `indexed through block ${indexedThrough(d.db, parsed.chainId, contract)}`,
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
  const parsed = await parseOrReply(d, USAGE.overlap);
  if (parsed === undefined) return;
  const first = parsed.contracts[0];
  // parseQueryCommand already deduped, so a repeated address cannot inflate this count.
  if (first === undefined || parsed.contracts.length < 2) {
    await d.replier.reply(`Send at least two different collections: ${USAGE.overlap}`);
    return;
  }

  const missing = notIndexed(d.db, parsed.chainId, parsed.contracts);
  if (missing.length > 0) {
    await d.replier.reply(
      'These are not indexed, so they cannot be counted:\n' +
      missing.map((c) => `  ${c} — not indexed`).join('\n') +
      `\n\nIndex them first: ${missing.map((c) => `/index ${c} --chain ${parsed.chainId}`).join('  ')}`,
    );
    return;
  }

  try {
    // Throws EnrichmentLevelError on an index that cannot tell a buy from a transfer. It is
    // surfaced below rather than caught here: an empty table would be a wrong answer.
    const rows = overlap(d.db, {
      chainId: parsed.chainId, contracts: parsed.contracts, minCollections: parsed.min,
    });
    await respond(d.replier, {
      title: `Wallets in ${parsed.min}+ of ${parsed.contracts.length} collections ` +
        `(chain ${parsed.chainId})\n` +
        'indexed through block: ' +
        parsed.contracts
          .map((c) => `${c} ${indexedThrough(d.db, parsed.chainId, c)}`).join(', '),
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
