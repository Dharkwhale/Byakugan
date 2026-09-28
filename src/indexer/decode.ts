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
 * ERC-721 `Transfer` has three indexed arguments, so a compliant log carries
 * topic0 plus three — four in total.
 */
const ERC721_TOPIC_COUNT = 4;

/** topic0 filters to pass to getLogs, per standard. */
export const TRANSFER_TOPICS: Record<Standard, Hash[]> = {
  '721': [TOPIC_721_TRANSFER],
  '1155': [TOPIC_1155_SINGLE, TOPIC_1155_BATCH],
};

const lower = (a: string): Address => a.toLowerCase() as Address;

export function decodeTransferLog(log: RawLog, standard: Standard): DecodedTransfer[] {
  const topic0 = log.topics[0];
  // An unrelated event from the same address is normal, not exceptional.
  if (!topic0 || !TRANSFER_TOPICS[standard].includes(topic0)) return [];

  const common = {
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  };

  if (standard === '721') {
    // ERC-20's Transfer(address,address,uint256) hashes to the SAME topic0, but
    // indexes only two arguments, so its logs carry three topics. Skipping on
    // topic count is what keeps an ERC-20 log out of the index — and, with a
    // three-indexed ABI, what stops viem throwing DecodeLogTopicsMismatch and
    // killing the backfill on the first one it meets.
    //
    // KNOWN LIMITATION: a non-compliant early ERC-721 that emits a NON-indexed
    // tokenId also has three topics and is therefore skipped. Accepting it would
    // require an ABI indistinguishable from ERC-20, so those collections index
    // as zero transfers. Recorded in the README.
    if (log.topics.length !== ERC721_TOPIC_COUNT) return [];

    const { args } = decodeEventLog({ abi: ERC721_ABI, topics: log.topics as [Hash, ...Hash[]], data: log.data });
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
    const { args } = decodeEventLog({ abi: ERC1155_ABI, topics: log.topics as [Hash, ...Hash[]], data: log.data });
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

  const { args } = decodeEventLog({ abi: ERC1155_ABI, topics: log.topics as [Hash, ...Hash[]], data: log.data });
  if (!('ids' in args)) return [];

  // viem decodes the two arrays independently and does NOT object when their
  // lengths differ (measured). Zipping to the shorter one silently drops a
  // transfer; padding with 0n silently invents one. Neither is acceptable for an
  // index, so a malformed batch is a hard error.
  if (args.ids.length !== args.values.length) {
    throw new DecodeError(
      `ERC-1155 TransferBatch in ${log.transactionHash} log ${log.logIndex} carries ` +
      `${args.ids.length} ids and ${args.values.length} values. Refusing to decode: ` +
      'zipping to the shorter array would drop transfers and padding would invent them.',
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
