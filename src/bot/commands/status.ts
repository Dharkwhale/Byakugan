import type Database from 'better-sqlite3';
import type { Clock } from '../../clock.js';
import { getCollection } from '../../db/repositories/collections.js';
import { getEnrichmentLevel } from '../../db/repositories/enrichment.js';
import { countByKind } from '../../db/repositories/transfers.js';
import { describeError } from '../../report.js';
import { parseQueryCommand } from '../args.js';
import type { JobRegistry, JobState } from '../jobs.js';
import { sanitizeOnChainText } from '../render.js';
import type { Replier } from '../replier.js';

/** How many collections the list shows. The total is reported alongside it, always. */
const LIST_LIMIT = 20;

/**
 * Whether the user supplied an address, decided the way `parseQueryCommand` reads tokens:
 * a `--flag` consumes the token after it as its value, and anything else is an address.
 *
 * Counting tokens instead would call `/status --chain 1` an address query (two tokens),
 * and the parser would then reject it for having no address. What matters is whether an
 * address is present, not how many words there were.
 */
function suppliedAddress(text: string): boolean {
  const parts = text.trim().split(/\s+/).slice(1).filter((t) => t.length > 0);
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]!.startsWith('--')) return true;
    i++; // the flag's value
  }
  return false;
}

/**
 * Describes a job this process is running.
 *
 * Shared by both branches below. It exists because a first index is live for a long time
 * before the collection row appears, and the two places that report it must not drift.
 */
function runningLine(job: Extract<JobState, { kind: 'running' }>, now: number): string {
  return `indexing now, started ${Math.round((now - job.startedAt) / 60_000)} minutes ago, ` +
    `via ${job.source}`;
}

/**
 * Describes a lock nothing in this process is working on.
 *
 * `inspectLock` has no age predicate, so an EXPIRED lock still comes back as orphaned,
 * and only `claimCollection` (inside backfill) ever steals it. Reporting "expires in 0
 * minutes" for it would be wrong forever. The boundary matches `/index`: the lock is live
 * while `now <= expiresAt`, because the steal is strict (`locked_at < now - staleMs`) and
 * at `now == expiresAt` the claim still refuses.
 */
function orphanLine(job: Extract<JobState, { kind: 'orphaned' }>, now: number): string {
  if (now <= job.expiresAt) {
    const minutes = Math.max(0, Math.round((job.expiresAt - now) / 60_000));
    return `a previous run left a lock and did not release it; nothing is indexing it. ` +
      `The lock expires in ${minutes} minutes and clears itself`;
  }
  return 'a previous run left a lock, and the lock has expired; the next /index will clear it';
}

export async function handleStatus(a: {
  text: string;
  replier: Replier;
  db: Database.Database;
  clock: Clock;
  registry: JobRegistry;
  defaultChainId: number | undefined;
  staleMs: number;
}): Promise<void> {
  if (!suppliedAddress(a.text)) {
    // Options are not read in this branch, so the heading says the list spans every chain
    // rather than letting a `--chain` the user typed look as though it filtered anything.
    const rows = a.db.prepare(`
      SELECT chain_id AS chainId, contract, enrichment_level AS level,
             last_indexed_block AS watermark
        FROM collections
       WHERE standard IS NOT NULL
       ORDER BY indexed_at DESC NULLS LAST
       LIMIT ${LIST_LIMIT}
    `).all() as Array<{ chainId: number; contract: string; level: string; watermark: number }>;
    if (rows.length === 0) {
      await a.replier.reply('Nothing indexed yet. Start with /index 0x…');
      return;
    }
    // The TOTAL is counted and shown, never left implied by the number of rows printed. A
    // capped list under a heading that reads as the whole set is a subset wearing the shape
    // of a complete answer, which is the one thing a status command must not do.
    const total = (a.db.prepare(
      'SELECT COUNT(*) AS n FROM collections WHERE standard IS NOT NULL',
    ).get() as { n: number }).n;
    const heading = total > rows.length
      ? `Indexed collections (all chains) — most recent ${rows.length} of ${total}`
      : `Indexed collections (all chains) — ${total}`;
    await a.replier.reply(
      [heading, '', ...rows.map((r) =>
        `chain ${r.chainId}  ${r.contract}  recorded level ${r.level}  through ${r.watermark}`)]
        .join('\n'),
    );
    return;
  }

  let parsed: ReturnType<typeof parseQueryCommand>;
  try {
    parsed = parseQueryCommand(a.text, a.defaultChainId);
  } catch (err) {
    const reported = describeError(err);
    await a.replier.reply(`${reported.headline}\n\n  ${reported.detail}`);
    return;
  }
  const contract = parsed.contracts[0];
  if (contract === undefined || parsed.contracts.length > 1) {
    await a.replier.reply('/status takes one address: /status 0x… [--chain N]');
    return;
  }
  const chainId = parsed.chainId;

  const state = getCollection(a.db, chainId, contract);
  const job = a.registry.inspect(a.db, { chainId, contract });
  const now = a.clock.now();

  if (state.state === 'not_indexed') {
    // A FIRST index can be live while this still reads not_indexed: the deploy-block search
    // runs before `standard` is set and is the longest part of a first index, so
    // `getCollection` says not_indexed for the whole of it. Replying only that would hide a
    // running job and invite a second `/index` for work already under way — a visibility
    // feature concealing the one thing it exists to show.
    if (job.kind === 'running') {
      await a.replier.reply(
        `${contract} on chain ${chainId} is being indexed for the first time and has not ` +
        'finished bootstrapping yet.\n' +
        `  ${runningLine(job, now)}\n` +
        '  Nothing is recorded for it yet. Wait for it rather than starting another.',
      );
      return;
    }
    const extra = job.kind === 'orphaned' ? `\n  ${orphanLine(job, now)}.` : '';
    await a.replier.reply(
      `${contract} on chain ${chainId} is not indexed.${extra}\n  /index ${contract} --chain ${chainId}`,
    );
    return;
  }

  // `getCollection` supplies the name; only the deploy-block provenance is read here.
  const provenance = a.db.prepare(`
    SELECT deploy_block_source AS source, deploy_block_validated AS validated
      FROM collections WHERE chain_id = ? AND contract = ?
  `).get(chainId, contract) as { source: string; validated: number };
  const counts = countByKind(a.db, chainId, contract);
  const level = getEnrichmentLevel(a.db, chainId, contract);

  const jobLine = job.kind === 'running'
    ? `  ${runningLine(job, now)}`
    : job.kind === 'orphaned'
      ? `  ${orphanLine(job, now)}`
      : '  no job running';

  // The recorded level is what the collection was ASKED to produce, not a statement of
  // completeness. Completeness comes from the rows: unclassified ones are counted, and a
  // note appears only when some exist.
  const lines = [
    `${sanitizeOnChainText(state.name)}  ${contract}`,
    `  chain ${chainId}, ERC-${state.standard}`,
    `  deploy block ${state.deployBlock} (${provenance.source}` +
      `${provenance.validated === 1 ? ', validated' : ', NOT validated'})`,
    `  indexed through ${state.lastIndexedBlock}, recorded level ${level ?? 'unknown'}`,
    `  mint ${counts.mint}  buy ${counts.buy}  transfer ${counts.transfer}  ` +
      `burn ${counts.burn}  unclassified ${counts.unclassified}`,
  ];
  if (counts.unclassified > 0) {
    lines.push(
      `  ${counts.unclassified} transfers are not yet classified, so buy and transfer counts are incomplete`,
    );
  }
  lines.push(jobLine);
  await a.replier.reply(lines.join('\n'));
}
