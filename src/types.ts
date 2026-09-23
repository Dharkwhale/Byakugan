export type Standard = '721' | '1155';
export type Kind = 'mint' | 'buy' | 'transfer' | 'burn';
export type DeployBlockSource = 'override' | 'explorer' | 'binary_search';

export type Address = `0x${string}`;
export type Hash = `0x${string}`;

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** One token movement. An ERC-1155 TransferBatch decodes to several of these. */
export interface DecodedTransfer {
  tokenId: bigint;
  amount: bigint;
  from: Address;
  to: Address;
  txHash: Hash;
  blockNumber: bigint;
  logIndex: number;
  /** 0 for ERC-721 and TransferSingle; array position for TransferBatch. */
  batchIndex: number;
}

export interface TxInfo {
  from: Address;
  value: bigint;
}

/** A row as stored. Every bigint is already a decimal string. */
export interface TransferRow {
  chainId: number;
  contract: string;
  tokenId: string;
  amount: string;
  fromAddr: string;
  toAddr: string;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  batchIndex: number;
  txFrom: string;
  txValueWei: string;
  kind: Kind;
}
