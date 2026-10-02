import { mapAssetTransfers, type AssetTransferEntry } from './assetTransfers.js';
import { decodeLogs } from './decode.js';
import { iterateLogs, type LogFetcher } from './logs.js';
import type { DecodedTransfer, Standard } from '../types.js';

export interface TransferChunk {
  /** Inclusive range this chunk FULLY covers. The watermark may advance to `toBlock`. */
  fromBlock: bigint;
  toBlock: bigint;
  transfers: DecodedTransfer[];
}

/**
 * A source of decoded transfers for a block range.
 *
 * WHY THE SEAM IS HERE AND NOT AT `fetchLogs`. The obvious place for a second fetch path
 * was behind the `LogFetcher` interface, which returns `RawLog[]`. It cannot go there:
 * `alchemy_getAssetTransfers` returns decoded transfers, and a faithful `RawLog` cannot be
 * rebuilt from them. ERC-721 `Transfer` happens to be reconstructable since all three
 * parameters are indexed, but `TransferSingle` needs `operator`, which the API does not
 * return, and `TransferBatch` cannot be rebuilt at all. Synthesising logs in order to
 * decode them again would also be encode-then-decode busywork around data already in the
 * shape the caller wants.
 *
 * Each implementation owns its own iteration, because the two chunk for different reasons:
 * `eth_getLogs` is capped by the provider at a measured 10 blocks and shrinks adaptively,
 * while `getAssetTransfers` has no range cap and pages by result count instead.
 */
export interface TransferSource {
  readonly name: 'getLogs' | 'getAssetTransfers';
  /** Chunks covering [fromBlock, toBlock], ascending, each fully covering its own range. */
  iterate(a: { fromBlock: bigint; toBlock: bigint }): AsyncGenerator<TransferChunk>;
}

/** The `eth_getLogs` path: adaptive chunking, then decode. */
export function makeLogsSource(a: {
  fetchLogs: LogFetcher;
  standard: Standard;
  initialChunk: number;
  maxChunk: number;
}): TransferSource {
  return {
    name: 'getLogs',
    async *iterate({ fromBlock, toBlock }) {
      for await (const chunk of iterateLogs({
        fetch: a.fetchLogs, fromBlock, toBlock,
        initialChunk: a.initialChunk, maxChunk: a.maxChunk,
      })) {
        yield {
          fromBlock: chunk.fromBlock,
          toBlock: chunk.toBlock,
          transfers: decodeLogs(chunk.logs, a.standard),
        };
      }
    },
  };
}

/** What `makeAssetTransfersSource` needs to call. Injected so the source is testable. */
export interface AssetTransfersFetcher {
  (a: {
    fromBlock: bigint;
    toBlock: bigint;
    pageKey?: string;
  }): Promise<{ transfers: AssetTransferEntry[]; pageKey?: string }>;
}

/**
 * The `alchemy_getAssetTransfers` path.
 *
 * MEASURED AT 698x CHEAPER than `eth_getLogs` over the same span: one page of up to 1000
 * transfers against the free tier's flat 10-block cap, which turned 1,005,000 CU into
 * 1,440 for the same history. That ratio is the whole reason this exists — without it a
 * `/index` on any real collection runs for hours.
 *
 * THE WATERMARK DISCIPLINE IS THE DELICATE PART. A page can end in the MIDDLE of a block,
 * so a chunk must never claim to cover a block whose transfers are still arriving. Each
 * page therefore yields only up to `lastSeenBlock - 1`, holding the final block's rows
 * back until the next page confirms they are complete; the last page yields everything
 * remaining up to the requested bound. Without that, the watermark would advance past a
 * partially written block and a rerun would start after the gap — permanent loss, and
 * exactly what the per-chunk transaction is otherwise built to prevent.
 *
 * A block with more rows than fit in one page therefore yields nothing until it is
 * finished, which is correct rather than merely cautious: there is no safe boundary inside
 * it.
 */
export function makeAssetTransfersSource(a: {
  fetch: AssetTransfersFetcher;
  standard: Standard;
}): TransferSource {
  return {
    name: 'getAssetTransfers',
    async *iterate({ fromBlock, toBlock }) {
      let cursor = fromBlock;
      let pending: DecodedTransfer[] = [];
      let pageKey: string | undefined;

      for (;;) {
        const page = await a.fetch({ fromBlock: cursor, toBlock, ...(pageKey ? { pageKey } : {}) });
        pending = pending.concat(mapAssetTransfers(page.transfers, a.standard));
        pageKey = page.pageKey;

        if (pageKey === undefined) {
          // Last page: everything up to the requested bound is now accounted for.
          yield { fromBlock: cursor, toBlock, transfers: pending };
          return;
        }

        // More pages coming. Only blocks strictly below the last one seen are complete.
        const lastSeen = pending.length > 0
          ? pending[pending.length - 1]!.blockNumber
          : undefined;
        if (lastSeen === undefined) continue;
        const safeTo = lastSeen - 1n;
        if (safeTo < cursor) continue; // one block spans the page boundary; keep going

        const ready = pending.filter((t) => t.blockNumber <= safeTo);
        pending = pending.filter((t) => t.blockNumber > safeTo);
        yield { fromBlock: cursor, toBlock: safeTo, transfers: ready };
        cursor = safeTo + 1n;
      }
    },
  };
}

export interface FallbackNotice {
  from: 'getAssetTransfers';
  to: 'getLogs';
  /** The first block the secondary source had to cover. */
  resumedAt: bigint;
  reason: string;
}

/**
 * Runs `primary`, and on any failure finishes the range with `secondary`.
 *
 * WHY FALLING BACK MID-RANGE IS SAFE HERE, when mixing enrichment levels was refused in
 * both directions: the two levels produce genuinely DIFFERENT data, so one collection
 * holding both is a state no query can interpret. These two sources must produce
 * IDENTICAL rows — that is the gate on `getAssetTransfers` being used at all, checked by
 * `scripts/compare-fetch-paths.ts` over a real range. Given equivalence, a range covered
 * half by one and half by the other is indistinguishable from either alone, so there is
 * nothing for a query to disambiguate and no reason to throw away committed work.
 *
 * If equivalence ever fails, the response is to stop defaulting to `getAssetTransfers` —
 * not to patch around the divergence here.
 *
 * RESUMES FROM THE LAST FULLY YIELDED CHUNK, never from the start: the consumer has
 * already committed those chunks and its watermark reflects them. Re-fetching them would
 * be wasted work, and the inserts are idempotent anyway, but restarting the range would
 * also mean a failure late in a long run discards all of it.
 */
export function withFallback(a: {
  primary: TransferSource;
  secondary: TransferSource;
  onFallback?: (notice: FallbackNotice) => void;
}): TransferSource {
  return {
    name: a.primary.name,
    async *iterate({ fromBlock, toBlock }) {
      let resumeAt = fromBlock;
      try {
        for await (const chunk of a.primary.iterate({ fromBlock, toBlock })) {
          yield chunk;
          resumeAt = chunk.toBlock + 1n;
        }
        return;
      } catch (err) {
        a.onFallback?.({
          from: 'getAssetTransfers',
          to: 'getLogs',
          resumedAt: resumeAt,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      if (resumeAt > toBlock) return;
      yield* a.secondary.iterate({ fromBlock: resumeAt, toBlock });
    },
  };
}

/**
 * Whether this endpoint can serve `getAssetTransfers` at all.
 *
 * Decided ONCE per run with one cheap call, before any indexing, because the answer is a
 * property of the endpoint rather than of the range: a non-Alchemy RPC, or a chain Alchemy
 * does not index, fails every time and should not be retried per chunk. Any failure means
 * no — this is a capability probe, not a diagnosis, and treating an ambiguous error as
 * "supported" would turn one upfront failure into one per chunk.
 */
export async function supportsAssetTransfers(
  fetch: AssetTransfersFetcher,
  nearBlock: bigint,
): Promise<{ supported: boolean; reason?: string }> {
  try {
    await fetch({ fromBlock: nearBlock, toBlock: nearBlock });
    return { supported: true };
  } catch (err) {
    return {
      supported: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
