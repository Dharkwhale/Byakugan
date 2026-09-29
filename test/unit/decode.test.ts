import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, type Hex } from 'viem';
import { decodeLogs, decodeTransferLog, TRANSFER_TOPICS, type RawLog } from '../../src/indexer/decode.js';
import { DecodeError } from '../../src/errors.js';

function load(name: string): RawLog[] {
  const raw = JSON.parse(
    readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as Array<Record<string, unknown>>;
  return raw.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber as string) })) as RawLog[];
}

const TOPIC_1155_SINGLE =
  '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62' as Hex;
const TOPIC_1155_BATCH =
  '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb' as Hex;
const OPERATOR = '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const ZERO_TOPIC = `0x${'0'.repeat(64)}` as Hex;
const TO = '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
// Shared with the "diagnosable" error-message test below, so the fixture's
// hash and the assertion on it cannot drift apart.
const BATCH_TX_HASH = `0x${'7'.repeat(64)}` as Hex;

/** A TransferBatch log with arbitrary ids/values — including invalid pairings. */
function batchLog(ids: bigint[], values: bigint[]): RawLog {
  return {
    topics: [TOPIC_1155_BATCH, OPERATOR, ZERO_TOPIC, TO],
    data: encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [ids, values]),
    transactionHash: BATCH_TX_HASH,
    blockNumber: 700n,
    logIndex: 11,
  };
}

describe('decodeLogs — ERC-721', () => {
  it('decodes a mint', () => {
    const [t] = decodeLogs(load('logs-721'), '721');
    expect(t).toEqual({
      tokenId: 1n,
      amount: 1n,
      from: '0x0000000000000000000000000000000000000000',
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      blockNumber: 100n,
      logIndex: 0,
      batchIndex: 0,
    });
  });

  // viem returns CHECKSUMMED addresses, so these calls are load-bearing.
  it('lowercases addresses', () => {
    const [t] = decodeLogs(load('logs-721'), '721');
    expect(t?.to).toBe(t?.to.toLowerCase());
    expect(t?.from).toBe(t?.from.toLowerCase());
  });
});

// ERC-721 and ERC-20 Transfer share topic0 byte-for-byte. ERC-721 indexes tokenId
// (4 topics); ERC-20 puts value in data (3 topics). Without the topic-count guard
// viem THROWS DecodeLogTopicsMismatch on the ERC-20 log — measured — so the
// indexer would die on the first one rather than mis-decode it. The guard makes
// it skip quietly.
describe('decodeLogs — ERC-20 Transfer must be skipped, not decoded or thrown on', () => {
  it('decodes an ERC-20 Transfer to zero rows', () => {
    expect(decodeLogs(load('logs-erc20-transfer'), '721')).toEqual([]);
  });

  it('does not throw on it', () => {
    expect(() => decodeLogs(load('logs-erc20-transfer'), '721')).not.toThrow();
  });

  it('skips it while still decoding a real 721 log in the same batch', () => {
    const mixed = [...load('logs-erc20-transfer'), ...load('logs-721')];
    const out = decodeLogs(mixed, '721');
    expect(out).toHaveLength(1);
    expect(out[0]?.tokenId).toBe(1n);
  });
});

// The topic-count guard is hoisted above the standard branch, so it must
// reject a malformed ERC-1155 log too, not just the ERC-20/ERC-721 collision.
// Measured (coordinator review): before this guard was hoisted, a
// TransferSingle- or TransferBatch-shaped log with too few topics THREW
// DecodeLogTopicsMismatch instead of skipping — the exact failure mode the
// ERC-721 guard already existed to prevent, just not extended to ERC-1155.
describe('decodeLogs — ERC-1155 topic-count guard (structural, not just the ERC-20 collision)', () => {
  it('a TransferSingle-shaped log with 2 topics decodes to zero rows and does not throw', () => {
    const log: RawLog = {
      topics: [TOPIC_1155_SINGLE, OPERATOR],
      data: load('logs-1155-single')[0]!.data,
      transactionHash: `0x${'9'.repeat(64)}` as Hex,
      blockNumber: 900n,
      logIndex: 0,
    };
    expect(() => decodeTransferLog(log, '1155')).not.toThrow();
    expect(decodeTransferLog(log, '1155')).toEqual([]);
  });

  it('a TransferBatch-shaped log with 2 topics decodes to zero rows and does not throw', () => {
    const log: RawLog = {
      topics: [TOPIC_1155_BATCH, OPERATOR],
      data: load('logs-1155-batch')[0]!.data,
      transactionHash: `0x${'9'.repeat(64)}` as Hex,
      blockNumber: 900n,
      logIndex: 1,
    };
    expect(() => decodeTransferLog(log, '1155')).not.toThrow();
    expect(decodeTransferLog(log, '1155')).toEqual([]);
  });

  it('a TransferSingle-shaped log with 5 topics (too many) decodes to zero rows and does not throw', () => {
    const log: RawLog = {
      topics: [TOPIC_1155_SINGLE, OPERATOR, ZERO_TOPIC, TO, ZERO_TOPIC],
      data: load('logs-1155-single')[0]!.data,
      transactionHash: `0x${'9'.repeat(64)}` as Hex,
      blockNumber: 900n,
      logIndex: 2,
    };
    expect(() => decodeTransferLog(log, '1155')).not.toThrow();
    expect(decodeTransferLog(log, '1155')).toEqual([]);
  });
});

describe('decodeLogs — unrelated topic0', () => {
  it('skips it rather than throwing', () => {
    expect(decodeLogs(load('logs-unrelated-topic'), '721')).toEqual([]);
    expect(decodeLogs(load('logs-unrelated-topic'), '1155')).toEqual([]);
  });

  it('skips a log with no topics at all', () => {
    const empty: RawLog = {
      topics: [], data: '0x', transactionHash: `0x${'8'.repeat(64)}` as Hex,
      blockNumber: 1n, logIndex: 0,
    };
    expect(decodeTransferLog(empty, '721')).toEqual([]);
  });
});

// Precision loss here is silent and produces rows that look entirely plausible.
describe('decodeLogs — uint256 precision', () => {
  it('round-trips a max-uint256 tokenId exactly', () => {
    const max = 2n ** 256n - 1n;
    const [t] = decodeLogs(load('logs-721-max-uint256'), '721');
    expect(t?.tokenId).toBe(max);
    expect(t?.tokenId.toString()).toBe(
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    );
  });

  it('keeps a tokenId above Number.MAX_SAFE_INTEGER exact as a string', () => {
    const [t] = decodeLogs(load('logs-721-max-uint256'), '721');
    const asString = t!.tokenId.toString();
    // Routing through a JS number would silently round this.
    expect(asString).not.toBe(String(Number(asString)));
    expect(BigInt(asString)).toBe(t?.tokenId);
  });

  it('keeps a max-uint256 amount exact in a batch', () => {
    const max = 2n ** 256n - 1n;
    const out = decodeTransferLog(batchLog([max], [max]), '1155');
    expect(out[0]?.tokenId).toBe(max);
    expect(out[0]?.amount).toBe(max);
  });

  it('types tokenId and amount as bigint, never number', () => {
    const [t] = decodeLogs(load('logs-1155-single'), '1155');
    expect(typeof t?.tokenId).toBe('bigint');
    expect(typeof t?.amount).toBe('bigint');
  });
});

describe('decodeLogs — ERC-1155 TransferSingle', () => {
  it('decodes id and amount from data', () => {
    const [t] = decodeLogs(load('logs-1155-single'), '1155');
    expect(t).toMatchObject({ tokenId: 7n, amount: 3n, logIndex: 5, batchIndex: 0 });
    expect(t?.from).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('decodeLogs — ERC-1155 TransferBatch', () => {
  it('expands one log into one transfer per id', () => {
    expect(decodeLogs(load('logs-1155-batch'), '1155')).toHaveLength(2);
  });

  // The whole reason batch_index exists: these rows share tx_hash and log_index.
  it('numbers batchIndex by array position while sharing tx hash and log index', () => {
    const out = decodeLogs(load('logs-1155-batch'), '1155');
    expect(out.map((t) => t.batchIndex)).toEqual([0, 1]);
    expect(out.map((t) => t.tokenId)).toEqual([10n, 11n]);
    expect(out.map((t) => t.amount)).toEqual([1n, 2n]);
    expect(new Set(out.map((t) => t.logIndex)).size).toBe(1);
    expect(new Set(out.map((t) => t.txHash)).size).toBe(1);
  });

  it('numbers batchIndex sequentially across a longer batch', () => {
    const out = decodeTransferLog(batchLog([1n, 2n, 3n, 4n, 5n], [1n, 1n, 1n, 1n, 1n]), '1155');
    expect(out.map((t) => t.batchIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  // A batch may legally carry the same id twice. batch_index is then the ONLY
  // thing keeping the rows distinct under the composite primary key, so a
  // decoder emitting a constant batchIndex would collapse them at insert time.
  it('distinguishes two slots carrying the same tokenId', () => {
    const out = decodeTransferLog(batchLog([100n, 100n, 100n], [1n, 2n, 3n]), '1155');
    expect(out.map((t) => t.tokenId)).toEqual([100n, 100n, 100n]);
    expect(out.map((t) => t.batchIndex)).toEqual([0, 1, 2]);
    expect(out.map((t) => t.amount)).toEqual([1n, 2n, 3n]);
    // The composite-key tuple must be unique across the three rows.
    const keys = out.map((t) => `${t.txHash}:${t.logIndex}:${t.batchIndex}`);
    expect(new Set(keys).size).toBe(3);
  });

  it('emits zero rows for an empty batch without crashing', () => {
    expect(decodeTransferLog(batchLog([], []), '1155')).toEqual([]);
  });

  it('does not emit a row with undefined fields for an empty batch', () => {
    const out = decodeTransferLog(batchLog([], []), '1155');
    expect(out).toHaveLength(0);
    expect(out.some((t) => t === undefined || t.tokenId === undefined)).toBe(false);
  });
});

// Malformed-but-decodable is the silent-corruption shape. Measured: viem decodes a
// mismatched TransferBatch WITHOUT complaint, so this guard is ours alone. In THIS
// implementation removing it would fabricate a zero-amount transfer for every id
// past the shorter values[] (mutation-verified), not drop the extra id — a
// differently-shaped loop could drop instead. Both are silent corruption.
describe('decodeLogs — malformed TransferBatch throws rather than fabricating rows', () => {
  it('throws when there are more ids than values', () => {
    expect(() => decodeTransferLog(batchLog([1n, 2n, 3n], [1n, 2n]), '1155'))
      .toThrow(DecodeError);
  });

  it('throws when there are more values than ids', () => {
    expect(() => decodeTransferLog(batchLog([1n, 2n], [1n, 2n, 3n]), '1155'))
      .toThrow(DecodeError);
  });

  it('names both lengths and the log in the error, so it is diagnosable', () => {
    expect(() => decodeTransferLog(batchLog([1n, 2n, 3n], [1n]), '1155'))
      .toThrow(/3 ids.*1 value|1 value.*3 ids/i);
    // Exact hash, not a coincidental digit run: BATCH_TX_HASH is the same
    // constant batchLog() uses, so this and the fixture cannot drift apart.
    expect(() => decodeTransferLog(batchLog([1n, 2n, 3n], [1n]), '1155'))
      .toThrow(BATCH_TX_HASH);
  });

  it('throws rather than silently fabricating a zero-amount row for the shorter array', () => {
    let out: unknown = 'not-called';
    try { out = decodeTransferLog(batchLog([1n, 2n, 3n], [1n, 2n]), '1155'); } catch { /* expected */ }
    expect(out).toBe('not-called');
  });
});

describe('decodeLogs — standard isolation', () => {
  it('ignores a 1155 log when decoding as 721', () => {
    expect(decodeLogs(load('logs-1155-batch'), '721')).toEqual([]);
  });

  it('ignores a 721 log when decoding as 1155', () => {
    expect(decodeLogs(load('logs-721'), '1155')).toEqual([]);
  });
});

describe('TRANSFER_TOPICS', () => {
  it('lists one topic for 721 and two for 1155', () => {
    expect(TRANSFER_TOPICS['721']).toHaveLength(1);
    expect(TRANSFER_TOPICS['1155']).toHaveLength(2);
  });

  it('gives 721 and 1155 no topic in common', () => {
    const overlap = TRANSFER_TOPICS['721'].filter((t) => TRANSFER_TOPICS['1155'].includes(t));
    expect(overlap).toEqual([]);
  });
});
