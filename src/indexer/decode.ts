import { decodeEventLog, parseAbi } from 'viem';
import { DecodeError } from '../errors.js';
import type { Address, DecodedTransfer, Hash, Standard } from '../types.js';

export interface RawLog {
  topics: Hash[];
  data: Hash;
  transactionHash: Hash;
  blockNumber: bigint;
  logIndex: number;
}

const ERC721_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);
const ERC1155_ABI = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
]);

const TOPIC_721_TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
const TOPIC_1155_SINGLE =
  '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62' as const;
const TOPIC_1155_BATCH =
  '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb' as const;

/**
 * Every event this decoder handles — ERC-721 `Transfer`, ERC-1155
 * `TransferSingle` and `TransferBatch` — declares exactly three indexed
 * parameters, so a compliant log carries topic0 plus three: four in total.
 *
 * Two distinct bugs are stopped by one check, and they fail differently —
 * measured, not assumed. For ERC-721 it is the ERC-20 collision:
 * `Transfer(address,address,uint256)` hashes identically, but ERC-20 indexes
 * only two arguments, so its logs carry three topics and viem THROWS
 * `DecodeLogTopicsMismatch`; unguarded, that kills a backfill on the first
 * ERC-20 log it meets. For ERC-1155 it is plain malformedness, and a
 * too-few-topics log throws the same way — but a too-many-topics log does
 * NOT throw: viem silently decodes using only the leading topics it expects
 * and discards the rest, so an unguarded log with extra topics would be
 * accepted as a normal-looking transfer rather than rejected. This guard is
 * therefore doing two different jobs: it turns a crash into a skip (too few
 * topics) AND it turns a silent misdecode into a skip (too many topics).
 *
 * KNOWN LIMITATION: a non-compliant early ERC-721 that emits a NON-indexed
 * `tokenId` also has three topics and is therefore skipped. Accepting it
 * would require an ABI indistinguishable from ERC-20, so those collections
 * index as zero transfers. Recorded in the README.
 */
const TOPIC_COUNT_WITH_THREE_INDEXED = 4;

/** topic0 filters to pass to getLogs, per standard. */
export const TRANSFER_TOPICS: Record<Standard, Hash[]> = {
  '721': [TOPIC_721_TRANSFER],
  '1155': [TOPIC_1155_SINGLE, TOPIC_1155_BATCH],
};

const lower = (a: string): Address => a.toLowerCase() as Address;

/**
 * Narrows `topics` to a non-empty tuple so `decodeEventLog` — which types its
 * `topics` parameter as `[signature: Hex, ...args: Hex[]] | []` — can be
 * called without a cast. A proven narrowing rather than an assertion: if a
 * future edit moves a decode call above this guard, typecheck fails instead
 * of silently trusting an assertion.
 */
function hasTopic0(topics: Hash[]): topics is [Hash, ...Hash[]] {
  return topics.length > 0;
}

export function decodeTransferLog(log: RawLog, standard: Standard): DecodedTransfer[] {
  const { topics } = log;
  // A log with no topics at all cannot match topic0; narrows `topics` to a
  // non-empty tuple for every decodeEventLog call below.
  if (!hasTopic0(topics)) return [];
  const topic0 = topics[0];

  // An unrelated event from the same address is normal, not exceptional.
  if (!TRANSFER_TOPICS[standard].includes(topic0)) return [];

  // See TOPIC_COUNT_WITH_THREE_INDEXED: one check for all three supported
  // events, since all three declare exactly three indexed parameters.
  if (topics.length !== TOPIC_COUNT_WITH_THREE_INDEXED) return [];

  const common = {
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  };

  if (standard === '721') {
    const { args } = decodeEventLog({ abi: ERC721_ABI, topics, data: log.data });
    return [{
      ...common,
      tokenId: args.tokenId,
      amount: 1n,
      from: lower(args.from),
      to: lower(args.to),
      batchIndex: 0,
    }];
  }

  if (topic0 === TOPIC_1155_SINGLE) {
    const { args } = decodeEventLog({ abi: ERC1155_ABI, topics, data: log.data });
    if (!('id' in args)) return [];
    return [{
      ...common,
      tokenId: args.id,
      amount: args.value,
      from: lower(args.from),
      to: lower(args.to),
      batchIndex: 0,
    }];
  }

  const { args } = decodeEventLog({ abi: ERC1155_ABI, topics, data: log.data });
  if (!('ids' in args)) return [];

  // viem decodes the two arrays independently and does NOT object when their
  // lengths differ (measured). In THIS implementation, removing this check
  // would not zip to the shorter array: the loop below iterates ids.length,
  // so a short values[] would invent a fabricated 0n-amount transfer for
  // every missing entry rather than dropping the extra id (mutation-verified
  // — see decode.test.ts). A differently-shaped loop could instead drop a
  // transfer by stopping at the shorter length. Both are silent corruption,
  // so a malformed batch is a hard error regardless of which failure mode a
  // future refactor would produce.
  if (args.ids.length !== args.values.length) {
    throw new DecodeError(
      `ERC-1155 TransferBatch in ${log.transactionHash} log ${log.logIndex} carries ` +
      `${args.ids.length} ids and ${args.values.length} values. Refusing to decode: ` +
      'this would fabricate a zero-amount transfer for every id past the shorter ' +
      'array (or drop one, in a differently-shaped implementation) — neither is safe.',
    );
  }

  // One log, many tokens. batchIndex disambiguates rows that otherwise share
  // (chain_id, tx_hash, log_index) — including two slots carrying the same id,
  // where it is the only thing keeping them distinct.
  const out: DecodedTransfer[] = [];
  for (const [i, tokenId] of args.ids.entries()) {
    const amount = args.values[i];
    if (amount === undefined) {
      // Unreachable after the length check above; present because
      // noUncheckedIndexedAccess makes the possibility visible, and a silent
      // fallback here is exactly the bug the length check exists to prevent.
      throw new DecodeError(
        `ERC-1155 TransferBatch in ${log.transactionHash} log ${log.logIndex} has no ` +
        `value at index ${i} despite matching array lengths.`,
      );
    }
    out.push({
      ...common,
      tokenId,
      amount,
      from: lower(args.from),
      to: lower(args.to),
      batchIndex: i,
    });
  }
  return out;
}

export function decodeLogs(logs: RawLog[], standard: Standard): DecodedTransfer[] {
  return logs.flatMap((log) => decodeTransferLog(log, standard));
}
