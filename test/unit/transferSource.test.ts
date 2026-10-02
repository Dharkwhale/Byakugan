import { describe, expect, it, vi } from 'vitest';
import {
  entryToTransfers, mapAssetTransfers, parseLogIndex, type AssetTransferEntry,
} from '../../src/indexer/assetTransfers.js';
import {
  makeAssetTransfersSource, makeLogsSource, supportsAssetTransfers, withFallback,
  type TransferChunk, type TransferSource,
} from '../../src/indexer/transferSource.js';
import { DecodeError } from '../../src/errors.js';
import { TRANSFER_TOPICS, type RawLog } from '../../src/indexer/decode.js';
import { ZERO_ADDRESS, type DecodedTransfer, type Hash } from '../../src/types.js';

const TX = '0x1111111111111111111111111111111111111111111111111111111111111111';
const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BUYER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function entry721(over: Partial<AssetTransferEntry> = {}): AssetTransferEntry {
  return {
    blockNum: '0x64', uniqueId: `${TX}:log:7`, hash: TX,
    from: OWNER, to: BUYER, category: 'erc721',
    erc721TokenId: '0x98', tokenId: '0x98', erc1155Metadata: [],
    rawContract: { address: '0xcccccccccccccccccccccccccccccccccccccccc' },
    ...over,
  };
}

function entry1155(ids: Array<[string, string]>, over: Partial<AssetTransferEntry> = {}): AssetTransferEntry {
  return {
    blockNum: '0x64', uniqueId: `${TX}:log:7`, hash: TX,
    from: ZERO_ADDRESS, to: BUYER, category: 'erc1155',
    erc1155Metadata: ids.map(([tokenId, value]) => ({ tokenId, value })),
    ...over,
  };
}

describe('parseLogIndex', () => {
  it('reads the index out of uniqueId', () => {
    expect(parseLogIndex(`${TX}:log:0`)).toBe(0);
    expect(parseLogIndex(`${TX}:log:477`)).toBe(477);
  });

  it('THROWS rather than synthesising an order it cannot know', () => {
    // The single most important behaviour in this module. firstMinters orders by
    // (block_number, log_index), so a fabricated index silently reorders the product's
    // headline answer — and any order looks like an order. There is no array position to
    // fall back on either: pages arrive in request order, not log order.
    for (const bad of [undefined, null, '', TX, `${TX}:log:`, `${TX}:log:x`,
                       'nope:log:1', `${TX}-log-1`]) {
      expect(() => parseLogIndex(bad as string)).toThrow(DecodeError);
    }
  });

  it('says what to do instead of guessing', () => {
    expect(() => parseLogIndex('garbage')).toThrow(/fall back to eth_getLogs/);
  });
});

describe('entryToTransfers — ERC-721', () => {
  it('produces one row with batchIndex 0 and amount 1', () => {
    expect(entryToTransfers(entry721(), '721')).toEqual([{
      from: OWNER, to: BUYER, txHash: TX, blockNumber: 100n, logIndex: 7,
      tokenId: 152n, amount: 1n, batchIndex: 0,
    }]);
  });

  it('lowercases addresses at this boundary', () => {
    const rows = entryToTransfers(entry721({
      from: OWNER.toUpperCase().replace('0X', '0x'),
      to: BUYER.toUpperCase().replace('0X', '0x'),
    }), '721');
    expect(rows[0]!.from).toBe(OWNER);
    expect(rows[0]!.to).toBe(BUYER);
  });

  it('preserves a uint256 token id exactly', () => {
    const huge = (2n ** 256n - 1n);
    const rows = entryToTransfers(entry721({ erc721TokenId: `0x${huge.toString(16)}` }), '721');
    expect(rows[0]!.tokenId).toBe(huge);
  });

  it('falls back to tokenId when erc721TokenId is absent', () => {
    expect(entryToTransfers(entry721({ erc721TokenId: null }), '721')[0]!.tokenId).toBe(152n);
  });

  it('refuses a missing token id rather than defaulting it', () => {
    expect(() => entryToTransfers(entry721({ erc721TokenId: null, tokenId: null }), '721'))
      .toThrow(DecodeError);
  });
});

describe('entryToTransfers — ERC-1155', () => {
  it('expands the metadata array into one row per id, batchIndex by POSITION', () => {
    // MEASURED against decodeLogs on the same logs: the array order matches the log's
    // ids[] order, which is undocumented and is the only reason positional batchIndex is
    // legitimate rather than invented. scripts/compare-fetch-paths.ts re-checks it.
    expect(entryToTransfers(entry1155([['0x7', '0x1'], ['0x7', '0x2'], ['0x9', '0x3']]), '1155'))
      .toEqual([
        { from: ZERO_ADDRESS, to: BUYER, txHash: TX, blockNumber: 100n, logIndex: 7,
          tokenId: 7n, amount: 1n, batchIndex: 0 },
        { from: ZERO_ADDRESS, to: BUYER, txHash: TX, blockNumber: 100n, logIndex: 7,
          tokenId: 7n, amount: 2n, batchIndex: 1 },
        { from: ZERO_ADDRESS, to: BUYER, txHash: TX, blockNumber: 100n, logIndex: 7,
          tokenId: 9n, amount: 3n, batchIndex: 2 },
      ]);
  });

  it('keeps a repeated token id distinguishable only by batchIndex', () => {
    // The collision the composite primary key exists for: without batchIndex these two
    // rows are identical and one is silently dropped.
    const rows = entryToTransfers(entry1155([['0x7', '0x1'], ['0x7', '0x2']]), '1155');
    expect(rows.map((r) => r.batchIndex)).toEqual([0, 1]);
    expect(new Set(rows.map((r) => `${r.txHash}:${r.logIndex}:${r.batchIndex}`)).size).toBe(2);
  });

  it('yields ZERO rows for an empty batch, matching decodeLogs', () => {
    expect(entryToTransfers(entry1155([]), '1155')).toEqual([]);
  });

  it('refuses a metadata entry missing its value', () => {
    expect(() => entryToTransfers(
      entry1155([['0x7', '0x1']], { erc1155Metadata: [{ tokenId: '0x7', value: null }] }),
      '1155',
    )).toThrow(/erc1155Metadata\[0\]\.value/);
  });
});

describe('entryToTransfers — refusals', () => {
  it('refuses to coerce one standard into the other', () => {
    // A 721 entry read as 1155 would produce plausible rows with wrong amount semantics.
    expect(() => entryToTransfers(entry721(), '1155')).toThrow(/Refusing to coerce/);
    expect(() => entryToTransfers(entry1155([['0x1', '0x1']]), '721')).toThrow(/Refusing to coerce/);
  });

  it('refuses a malformed hash, address or block number', () => {
    expect(() => entryToTransfers(entry721({ hash: '0x12' }), '721')).toThrow(/transaction hash/);
    expect(() => entryToTransfers(entry721({ from: 'nope' }), '721')).toThrow(/is not an address/);
    expect(() => entryToTransfers(entry721({ blockNum: 'later' }), '721')).toThrow(/not a number/);
  });
});

describe('mapAssetTransfers', () => {
  it('sorts into log order across entries', () => {
    const rows = mapAssetTransfers([
      entry721({ blockNum: '0x65', uniqueId: `${TX}:log:2` }),
      entry721({ blockNum: '0x64', uniqueId: `${TX}:log:9` }),
      entry721({ blockNum: '0x64', uniqueId: `${TX}:log:1` }),
    ], '721');
    expect(rows.map((r) => [Number(r.blockNumber), r.logIndex]))
      .toEqual([[100, 1], [100, 9], [101, 2]]);
  });

  it('keeps batch rows adjacent and in position order', () => {
    const rows = mapAssetTransfers([entry1155([['0x1', '0x1'], ['0x2', '0x1']])], '1155');
    expect(rows.map((r) => r.batchIndex)).toEqual([0, 1]);
  });
});

/** A 721 Transfer log, for the getLogs source. */
function mintLog(block: number, tokenId: number, logIndex = 0): RawLog {
  const topic = (v: string): Hash => `0x${v.replace(/^0x/, '').padStart(64, '0')}` as Hash;
  return {
    topics: [TRANSFER_TOPICS['721'][0]!, topic(ZERO_ADDRESS), topic(OWNER), topic(tokenId.toString(16))],
    data: '0x',
    transactionHash: `0x${tokenId.toString(16).padStart(64, '0')}` as Hash,
    blockNumber: BigInt(block),
    logIndex,
  };
}

async function drain(source: TransferSource, fromBlock: bigint, toBlock: bigint) {
  const chunks: TransferChunk[] = [];
  for await (const chunk of source.iterate({ fromBlock, toBlock })) chunks.push(chunk);
  return chunks;
}

describe('makeLogsSource', () => {
  it('decodes each chunk and reports the range it covered', async () => {
    const logs = [mintLog(3, 1), mintLog(12, 2)];
    const source = makeLogsSource({
      standard: '721', initialChunk: 10, maxChunk: 10,
      fetchLogs: async ({ fromBlock, toBlock }) =>
        logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
    });
    const chunks = await drain(source, 1n, 20n);
    expect(chunks.map((c) => [Number(c.fromBlock), Number(c.toBlock), c.transfers.length]))
      .toEqual([[1, 10, 1], [11, 20, 1]]);
  });
});

describe('makeAssetTransfersSource — the watermark discipline', () => {
  it('covers the whole range in one chunk when a single page suffices', async () => {
    const fetch = vi.fn(async () => ({ transfers: [entry721()] }));
    const chunks = await drain(makeAssetTransfersSource({ fetch, standard: '721' }), 1n, 200n);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.toBlock).toBe(200n);
    expect(chunks[0]!.transfers).toHaveLength(1);
  });

  it('never claims a block whose transfers are still arriving', async () => {
    // THE failure this guards: a page ending mid-block. If a chunk claimed to cover block
    // 100 while more of block 100 was still coming, the watermark would advance past a
    // partially written block and a rerun would start after the gap — permanent loss.
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          transfers: [
            entry721({ blockNum: '0x63', uniqueId: `${TX}:log:1` }), // block 99
            entry721({ blockNum: '0x64', uniqueId: `${TX}:log:2` }), // block 100, partial
          ],
          pageKey: 'next',
        };
      }
      return { transfers: [entry721({ blockNum: '0x64', uniqueId: `${TX}:log:3` })] };
    });

    const chunks = await drain(makeAssetTransfersSource({ fetch, standard: '721' }), 90n, 110n);
    // First chunk stops at 99, NOT 100.
    expect(chunks[0]!.toBlock).toBe(99n);
    expect(chunks[0]!.transfers.map((t) => t.logIndex)).toEqual([1]);
    // Block 100's rows arrive together in the final chunk.
    expect(chunks[1]!.fromBlock).toBe(100n);
    expect(chunks[1]!.toBlock).toBe(110n);
    expect(chunks[1]!.transfers.map((t) => t.logIndex)).toEqual([2, 3]);
  });

  it('yields nothing until a block that spans several pages is finished', async () => {
    // A block with more rows than fit in a page has NO safe boundary inside it, so the
    // only correct answer is to keep reading.
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call < 3) {
        return {
          transfers: [entry721({ blockNum: '0x64', uniqueId: `${TX}:log:${call}` })],
          pageKey: `p${call}`,
        };
      }
      return { transfers: [entry721({ blockNum: '0x64', uniqueId: `${TX}:log:3` })] };
    });
    const chunks = await drain(makeAssetTransfersSource({ fetch, standard: '721' }), 100n, 100n);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.transfers).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('leaves no gap between consecutive chunks', async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          transfers: [
            entry721({ blockNum: '0x5', uniqueId: `${TX}:log:1` }),
            entry721({ blockNum: '0xa', uniqueId: `${TX}:log:2` }),
          ],
          pageKey: 'n',
        };
      }
      return { transfers: [entry721({ blockNum: '0x14', uniqueId: `${TX}:log:3` })] };
    });
    const chunks = await drain(makeAssetTransfersSource({ fetch, standard: '721' }), 1n, 30n);
    let expected = 1n;
    for (const chunk of chunks) {
      expect(chunk.fromBlock).toBe(expected);
      expected = chunk.toBlock + 1n;
    }
    expect(expected).toBe(31n);
  });

  it('covers the range even when it holds no transfers at all', async () => {
    const fetch = vi.fn(async () => ({ transfers: [] }));
    const chunks = await drain(makeAssetTransfersSource({ fetch, standard: '721' }), 1n, 50n);
    expect(chunks).toEqual([{ fromBlock: 1n, toBlock: 50n, transfers: [] }]);
  });
});

describe('withFallback', () => {
  const okSource = (name: TransferSource['name'], chunks: TransferChunk[]): TransferSource => ({
    name,
    async *iterate() { for (const c of chunks) yield c; },
  });

  const failingAfter = (n: number, chunks: TransferChunk[]): TransferSource => ({
    name: 'getAssetTransfers',
    async *iterate() {
      for (let i = 0; i < chunks.length; i++) {
        if (i === n) throw new Error('page fetch exploded');
        yield chunks[i]!;
      }
    },
  });

  const row = (block: number): DecodedTransfer => ({
    tokenId: 1n, amount: 1n, from: ZERO_ADDRESS, to: OWNER as `0x${string}`,
    txHash: TX, blockNumber: BigInt(block), logIndex: 0, batchIndex: 0,
  });

  it('passes the primary through untouched when it succeeds', async () => {
    const primary = okSource('getAssetTransfers', [
      { fromBlock: 1n, toBlock: 10n, transfers: [row(3)] },
    ]);
    const secondary = okSource('getLogs', []);
    const onFallback = vi.fn();
    const chunks = await drain(withFallback({ primary, secondary, onFallback }), 1n, 10n);
    expect(chunks).toHaveLength(1);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('RESUMES at the next block, never restarting the range', async () => {
    // Restarting would discard work the consumer has already committed, and a failure late
    // in a long run would throw away all of it. Inserts are idempotent, so a restart would
    // be merely wasteful rather than wrong — but on a multi-hour backfill that distinction
    // stops mattering.
    const primary = failingAfter(2, [
      { fromBlock: 1n, toBlock: 10n, transfers: [row(3)] },
      { fromBlock: 11n, toBlock: 20n, transfers: [row(12)] },
      { fromBlock: 21n, toBlock: 30n, transfers: [] },
    ]);
    const asked: Array<[bigint, bigint]> = [];
    const secondary: TransferSource = {
      name: 'getLogs',
      async *iterate({ fromBlock, toBlock }) {
        asked.push([fromBlock, toBlock]);
        yield { fromBlock, toBlock, transfers: [row(25)] };
      },
    };
    const onFallback = vi.fn();
    const chunks = await drain(withFallback({ primary, secondary, onFallback }), 1n, 30n);

    expect(asked).toEqual([[21n, 30n]]);
    expect(chunks.map((c) => [Number(c.fromBlock), Number(c.toBlock)]))
      .toEqual([[1, 10], [11, 20], [21, 30]]);
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
      from: 'getAssetTransfers', to: 'getLogs', resumedAt: 21n,
    }));
  });

  it('falls back from the START when the primary fails immediately', async () => {
    const primary = failingAfter(0, [{ fromBlock: 1n, toBlock: 10n, transfers: [] }]);
    const asked: Array<[bigint, bigint]> = [];
    const secondary: TransferSource = {
      name: 'getLogs',
      async *iterate({ fromBlock, toBlock }) {
        asked.push([fromBlock, toBlock]);
        yield { fromBlock, toBlock, transfers: [] };
      },
    };
    await drain(withFallback({ primary, secondary }), 1n, 10n);
    expect(asked).toEqual([[1n, 10n]]);
  });

  it('does not call the secondary when the primary finished the range before failing', async () => {
    // Nothing is left to cover, so invoking the secondary would re-fetch ground already
    // committed for no reason.
    const primary: TransferSource = {
      name: 'getAssetTransfers',
      async *iterate() {
        yield { fromBlock: 1n, toBlock: 10n, transfers: [] };
        throw new Error('failed on the way out');
      },
    };
    const secondary = vi.fn();
    const chunks = await drain(withFallback({
      primary,
      secondary: { name: 'getLogs', iterate: secondary as never },
    }), 1n, 10n);
    expect(chunks).toHaveLength(1);
    expect(secondary).not.toHaveBeenCalled();
  });

  it('falls back on a DecodeError, which is how an unparseable log index arrives', async () => {
    // The two failure shapes that matter are an API error and a response this code refuses
    // to interpret. Both must route to getLogs rather than to a synthesised order.
    const primary: TransferSource = {
      name: 'getAssetTransfers',
      async *iterate() { throw new DecodeError('cannot read a log index from uniqueId'); },
    };
    const asked: Array<[bigint, bigint]> = [];
    const secondary: TransferSource = {
      name: 'getLogs',
      async *iterate({ fromBlock, toBlock }) {
        asked.push([fromBlock, toBlock]);
        yield { fromBlock, toBlock, transfers: [] };
      },
    };
    const onFallback = vi.fn();
    await drain(withFallback({ primary, secondary, onFallback }), 5n, 15n);
    expect(asked).toEqual([[5n, 15n]]);
    expect(onFallback.mock.calls[0]![0].reason).toMatch(/log index/);
  });
});

describe('supportsAssetTransfers', () => {
  it('is true when the endpoint answers', async () => {
    expect(await supportsAssetTransfers(async () => ({ transfers: [] }), 100n))
      .toEqual({ supported: true });
  });

  it('is false, with the reason, on any failure', async () => {
    const result = await supportsAssetTransfers(async () => {
      throw new Error('Unsupported method: alchemy_getAssetTransfers');
    }, 100n);
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/Unsupported method/);
  });

  it('asks exactly once, since the answer is a property of the endpoint', async () => {
    // Probing per chunk would turn one upfront failure into one per chunk — thousands of
    // doomed calls on a non-Alchemy endpoint.
    const fetch = vi.fn(async () => ({ transfers: [] }));
    await supportsAssetTransfers(fetch, 100n);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
