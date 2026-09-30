import type { PublicClient } from 'viem';
import { TxEnrichmentError } from '../errors.js';
import {
  ZERO_ADDRESS,
  type Address, type DecodedTransfer, type EnrichmentLevel, type Hash, type TxInfo,
} from '../types.js';
import type { ChainClient } from './client.js';
import {
  chooseFetchStrategy, measureDensity, type FetchCosts, type FetchStrategy,
} from './fetchStrategy.js';

/** One transaction's enrichment data, however it was obtained. */
interface FetchedTx {
  hash: Hash;
  from: Address;
  value: bigint;
}

/**
 * The two ways to read transaction data. Injected so `enrichTxs` is testable
 * without a chain, and so the rate limiter lives in exactly one place.
 */
export interface TxSource {
  getTransaction(hash: Hash): Promise<{ from: Address; value: bigint }>;
  /** Every transaction in one block, which is what makes block-fetch cheaper when dense. */
  getBlockWithTransactions(blockNumber: bigint): Promise<FetchedTx[]>;
}

export interface NeededTx {
  txHash: Hash;
  blockNumber: bigint;
}

/**
 * Which transfers need their transaction fetched, at a given enrichment level.
 *
 * Pure and separate from the fetching so the level policy is one readable
 * function rather than a branch buried in an async loop.
 *
 *   logs_only   nothing. `tx_from` stays null and `firstMinters` refuses the index.
 *   mints_only  the MINT rows. Not zero — `tx_from` on a mint is the acting wallet,
 *               and without it one bot minting to 200 fresh addresses is
 *               indistinguishable from 200 collectors.
 *   full        everything, including mints, so a 'full' index carries mint price
 *               rather than NULLs with no explanation.
 *
 * Deduplicated by transaction hash: a `TransferBatch` decodes to many transfers
 * sharing one transaction, and an airdrop puts hundreds of mints in one. That is
 * the cheap case and it must cost one fetch, not hundreds.
 *
 * A note on `mints_only` and mixed transactions: a transaction holding both a mint
 * and a sale is selected here for its mint, and enriching it classifies the sale
 * too, free, because the data is already in hand. So a `mints_only` run can leave
 * fewer unclassified rows than its name implies — harmless, since the query gates
 * read the rows rather than the level.
 */
export function selectNeeded(
  transfers: Array<Pick<DecodedTransfer, 'from' | 'txHash' | 'blockNumber'>>,
  level: EnrichmentLevel,
): NeededTx[] {
  if (level === 'logs_only') return [];
  // The Map is what deduplicates — keyed by hash, so a repeat simply overwrites an
  // identical entry. An explicit `if (seen.has(...)) continue;` guard was here and
  // was removed after a mutation check showed it could not change the result: a
  // transaction belongs to exactly one block, so first-wins and last-wins agree.
  // One mechanism doing the work, rather than a second that looks load-bearing.
  const seen = new Map<string, NeededTx>();
  for (const transfer of transfers) {
    if (level === 'mints_only' && transfer.from !== ZERO_ADDRESS) continue;
    seen.set(transfer.txHash, {
      txHash: transfer.txHash,
      blockNumber: transfer.blockNumber,
    });
  }
  return [...seen.values()];
}

/**
 * Fetches `(from, value)` for the transactions a window needs.
 *
 * STRATEGY IS CHOSEN PER CALL from the density of what is actually needed, not from
 * a configured constant — see `chooseFetchStrategy`. The measured extremes are more
 * than an order of magnitude apart (1.04 tx/block on a sparse collection against
 * tens during a drop), so a single fixed choice is wrong for one of them. Note the
 * density that matters is of the NEEDED set after deduplication and after removing
 * what the database already had: an airdrop of 200 mints is one transaction, not
 * two hundred, and picking block-fetch for it would pay for a whole block to read
 * one transaction out of it.
 *
 * `known` is the database pre-check. Anything already stored is neither fetched nor
 * re-counted in the density, so a resumed or overlapping backfill pays nothing for
 * ground it has covered.
 *
 * EVERY ADDRESS IS LOWERCASED HERE, at this boundary. `classify` asserts its inputs
 * are already lowercase and throws `ClassifyError` otherwise, deliberately, so that
 * an omission here fails loudly instead of being quietly compensated for
 * downstream. This function is the "here" that guard refers to.
 *
 * @returns a map covering exactly the requested hashes — no more, so a caller
 *   cannot accidentally depend on the remainder of a block that block-fetch
 *   happened to return.
 */
export async function enrichTxs(a: {
  source: TxSource;
  needed: NeededTx[];
  costs: FetchCosts;
  known?: Map<string, TxInfo>;
}): Promise<Map<string, TxInfo>> {
  const out = new Map<string, TxInfo>();

  // Deduplicate and drop what the database already holds, before measuring density.
  const toFetch = new Map<string, NeededTx>();
  for (const item of a.needed) {
    const cached = a.known?.get(item.txHash);
    if (cached) {
      out.set(item.txHash, cached);
      continue;
    }
    if (!toFetch.has(item.txHash)) toFetch.set(item.txHash, item);
  }
  if (toFetch.size === 0) return out;

  const pending = [...toFetch.values()];
  const density = measureDensity(
    pending.map((p) => ({ txHash: p.txHash, blockNumber: p.blockNumber })),
  );
  const strategy: FetchStrategy = chooseFetchStrategy({
    uniqueTxs: density.uniqueTxs,
    uniqueBlocks: density.uniqueBlocks,
    costs: a.costs,
  });

  const fetched = strategy === 'block-fetch'
    ? await fetchByBlock(a.source, pending)
    : await fetchByTx(a.source, pending);

  // THE narrowing point: the result carries exactly the requested hashes, never the
  // remainder of a block that block-fetch happened to return, so a caller cannot come
  // to depend on data that only appears under one of the two strategies.
  for (const item of pending) {
    const tx = fetched.get(item.txHash);
    if (!tx) {
      // A transaction decoded out of a log must exist in its own block. Missing
      // means the chain moved underneath us — a reorg reaching below the
      // confirmations depth, or a hash from somewhere it should not have come
      // from. Loud, because silently omitting it would leave the row unenriched
      // under an index about to be recorded as complete.
      throw new TxEnrichmentError(
        `transaction ${item.txHash} was not returned for block ${item.blockNumber} ` +
        `via ${strategy}. A transaction decoded from a log must be present in its ` +
        'own block, so this indicates a reorg below the confirmations depth rather ' +
        'than a transient failure. Re-index this range.',
      );
    }
    out.set(item.txHash, tx);
  }
  return out;
}

/**
 * One request per block.
 *
 * Returns everything the blocks held, including transactions nobody asked for. That
 * is deliberate: narrowing to the requested hashes happens in ONE place, where
 * `enrichTxs` builds its result from `pending`, and that narrowing is what the tests
 * pin. A filter here as well was removed after a mutation check showed it could not
 * change any caller-visible outcome — a redundant guard that reads as load-bearing is
 * worse than none, because it invites trusting an untested one.
 */
async function fetchByBlock(
  source: TxSource,
  pending: NeededTx[],
): Promise<Map<string, TxInfo>> {
  const blocks = [...new Set(pending.map((p) => p.blockNumber))];
  const out = new Map<string, TxInfo>();
  const results = await Promise.all(blocks.map((b) => source.getBlockWithTransactions(b)));
  for (const transactions of results) {
    for (const tx of transactions) {
      out.set(tx.hash, toTxInfo(tx.hash, tx.from, tx.value));
    }
  }
  return out;
}

/**
 * One request per transaction.
 *
 * Issued together rather than sequentially: the http transport coalesces
 * concurrent calls into JSON-RPC batches of 50, so this is already batched at the
 * wire level, and the per-chain rate limiter inside the source is what bounds the
 * actual concurrency.
 */
async function fetchByTx(
  source: TxSource,
  pending: NeededTx[],
): Promise<Map<string, TxInfo>> {
  const results = await Promise.all(
    pending.map(async (p) => {
      const tx = await source.getTransaction(p.txHash);
      return [p.txHash, toTxInfo(p.txHash, tx.from, tx.value)] as const;
    }),
  );
  return new Map(results);
}

/**
 * The single normalisation point: lowercase the sender, and insist the value really
 * is a bigint.
 *
 * The `value` check mirrors `classify`'s and exists for the same measured reason: a
 * numeric string compares correctly against `0n`, but `undefined`, `null`, `''` and
 * any non-numeric string all compare as false WITHOUT throwing, so a malformed
 * value would read as unpaid and downgrade a genuine buy to a transfer. Catching it
 * here names the transaction; catching it in `classify` does not.
 */
function toTxInfo(hash: Hash, from: unknown, value: unknown): TxInfo {
  if (typeof from !== 'string' || !from.startsWith('0x')) {
    throw new TxEnrichmentError(
      `transaction ${hash} returned a sender that is not an address: ${String(from)}`,
    );
  }
  if (typeof value !== 'bigint') {
    throw new TxEnrichmentError(
      `transaction ${hash} returned a non-bigint value (${typeof value}). A missing ` +
      'or stringified value would compare as unpaid without throwing and silently ' +
      'downgrade a buy to a transfer.',
    );
  }
  return { from: from.toLowerCase() as Address, value };
}

/**
 * The real source, rate-limited per chain.
 *
 * Both calls go through `chain.limit`, so enrichment draws on the same bucket as
 * every other request for that chain instead of competing with it.
 */
export function makeTxSource(chain: ChainClient): TxSource {
  const client = chain.client as PublicClient;
  return {
    async getTransaction(hash) {
      const tx = await chain.limit(() => client.getTransaction({ hash }));
      return { from: tx.from as Address, value: tx.value };
    },
    async getBlockWithTransactions(blockNumber) {
      const block = await chain.limit(() =>
        client.getBlock({ blockNumber, includeTransactions: true }),
      );
      return block.transactions.map((tx) => ({
        hash: tx.hash as Hash,
        from: tx.from as Address,
        value: tx.value,
      }));
    },
  };
}
