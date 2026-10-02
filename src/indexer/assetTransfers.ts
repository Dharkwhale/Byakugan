import { DecodeError } from '../errors.js';
import type { Address, DecodedTransfer, Hash, Standard } from '../types.js';

/**
 * One entry as `alchemy_getAssetTransfers` returns it.
 *
 * Fields are optional because this is someone else's wire format and a missing one must
 * be a handled case rather than a crash on `undefined`. The shapes below were captured
 * from live responses on Base, not read from documentation.
 */
export interface AssetTransferEntry {
  blockNum?: string | null;
  /** `<txHash>:log:<index>` — the only place the log index appears. */
  uniqueId?: string | null;
  hash?: string | null;
  from?: string | null;
  to?: string | null;
  category?: string | null;
  erc721TokenId?: string | null;
  tokenId?: string | null;
  /** ERC-1155 only. ONE entry per log, carrying every id that log moved. */
  erc1155Metadata?: Array<{ tokenId?: string | null; value?: string | null }> | null;
  rawContract?: { address?: string | null } | null;
}

/** `<txHash>:log:<index>`, as measured. Nothing else is accepted. */
const UNIQUE_ID = /^(0x[0-9a-fA-F]{64}):log:(\d+)$/;

/**
 * The log index, from `uniqueId`.
 *
 * THROWS RATHER THAN GUESSING, and this is the single most important line in the file.
 * `firstMinters` orders by `(block_number, log_index)`, so a fabricated index would
 * reorder the product's headline query — and it would do so invisibly, since any order
 * looks like an order. There is no position in the response array to fall back on,
 * because pages arrive in request order rather than log order, and no "close enough"
 * substitute exists for a number that decides who was first.
 *
 * Measured: the format held for 84/84 entries over one window and for every entry across
 * the 721 and 1155 samples. If it ever stops holding, this throws and the caller falls
 * back to `eth_getLogs`, which is the correct response — not a synthesised order.
 */
export function parseLogIndex(uniqueId: string | null | undefined): number {
  const match = UNIQUE_ID.exec(uniqueId ?? '');
  if (!match) {
    throw new DecodeError(
      `cannot read a log index from uniqueId ${JSON.stringify(uniqueId)}. Expected ` +
      '"<txHash>:log:<index>". The log index is NOT reconstructable from anything else ' +
      'in the response, and firstMinters orders by it, so no order is synthesised here — ' +
      'fall back to eth_getLogs for this range instead.',
    );
  }
  return Number(match[2]);
}

function requireAddress(value: string | null | undefined, field: string, id: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new DecodeError(`${field} on ${id} is not an address: ${JSON.stringify(value)}`);
  }
  return value.toLowerCase() as Address;
}

function requireUint(value: string | null | undefined, field: string, id: string): bigint {
  if (typeof value !== 'string' || value === '') {
    throw new DecodeError(`${field} on ${id} is missing`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new DecodeError(`${field} on ${id} is not a number: ${JSON.stringify(value)}`);
  }
}

/**
 * Converts one entry into the rows `eth_getLogs` + `decodeLogs` would have produced.
 *
 * THE 1155 SHAPE IS THE INTERESTING PART. A `TransferBatch` is ONE log carrying `ids[]`,
 * and this API returns it as ONE entry carrying `erc1155Metadata[]` — so `batch_index`
 * comes from the ARRAY POSITION. That is only legitimate if the array order matches the
 * log's `ids[]` order, which is not documented anywhere, so it was measured: decoding the
 * same logs with `decodeLogs` and comparing gave identical id and value sequences for
 * every multi-id entry sampled. `scripts/compare-fetch-paths.ts` re-checks it on demand,
 * and it is the gate on this source being used at all.
 *
 * An empty `erc1155Metadata` yields ZERO rows, matching `decodeLogs` on an empty
 * `TransferBatch` — a valid log carrying no movements.
 */
export function entryToTransfers(
  entry: AssetTransferEntry,
  standard: Standard,
): DecodedTransfer[] {
  const logIndex = parseLogIndex(entry.uniqueId);
  const id = String(entry.uniqueId);

  const expected = standard === '721' ? 'erc721' : 'erc1155';
  if (entry.category !== expected) {
    // A 721 entry inside a 1155 index would decode to plausible-looking rows with the
    // wrong amount semantics, so the mismatch is refused rather than coerced.
    throw new DecodeError(
      `entry ${id} has category ${JSON.stringify(entry.category)} but this collection is ` +
      `ERC-${standard}. Refusing to coerce one standard into the other.`,
    );
  }

  const txHash = /^0x[0-9a-fA-F]{64}$/.test(entry.hash ?? '')
    ? (entry.hash as string).toLowerCase() as Hash
    : (() => { throw new DecodeError(`hash on ${id} is not a transaction hash`); })();
  const blockNumber = requireUint(entry.blockNum, 'blockNum', id);
  const from = requireAddress(entry.from, 'from', id);
  const to = requireAddress(entry.to, 'to', id);
  const base = { from, to, txHash, blockNumber, logIndex };

  if (standard === '721') {
    return [{
      ...base,
      tokenId: requireUint(entry.erc721TokenId ?? entry.tokenId, 'erc721TokenId', id),
      // ERC-721 moves exactly one token per log; decodeLogs hardcodes this too.
      amount: 1n,
      batchIndex: 0,
    }];
  }

  const metadata = entry.erc1155Metadata ?? [];
  return metadata.map((item, index) => ({
    ...base,
    tokenId: requireUint(item.tokenId, `erc1155Metadata[${index}].tokenId`, id),
    amount: requireUint(item.value, `erc1155Metadata[${index}].value`, id),
    batchIndex: index,
  }));
}

/**
 * Converts a page of entries, in log order.
 *
 * SORTED BY (blockNumber, logIndex, batchIndex) before returning. Entries arrive in the
 * API's own order, which is ascending by block but not guaranteed within one — and every
 * consumer downstream assumes log order, from the ordering of `firstMinters` to the
 * chunk-boundary reasoning in the backfill. Sorting on a key read from the response is
 * not synthesising an order; it is putting a known order back in sequence.
 */
export function mapAssetTransfers(
  entries: AssetTransferEntry[],
  standard: Standard,
): DecodedTransfer[] {
  const rows = entries.flatMap((entry) => entryToTransfers(entry, standard));
  return rows.sort((a, b) =>
    (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0)
    || a.logIndex - b.logIndex
    || a.batchIndex - b.batchIndex);
}
