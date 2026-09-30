export type Standard = '721' | '1155';

/**
 * `'unclassified'` is not a classification — it is the absence of one, for a row
 * whose transaction was never fetched.
 *
 * It exists because `'transfer'` is what you get by failing to look. `mint` and
 * `burn` follow from the log alone, but telling a `buy` from a `transfer`
 * requires `tx.value` and `tx.from`, so an unenriched row recorded as
 * `'transfer'` is indistinguishable from a real one and every buy in that range
 * is silently lost. `overlap` scores wallets on [mint, buy], so a wallet that
 * bought seven of fifteen collections would come back as zero — a wrong answer
 * wearing the shape of a right one.
 *
 * Nothing may map `'unclassified'` onto a real kind, and no query may count it
 * as one. See `requireFullEnrichment`.
 */
export type Kind = 'mint' | 'buy' | 'transfer' | 'burn' | 'unclassified';

/** The kinds that follow from the log alone, with no transaction fetched. */
export type LogDecidableKind = Extract<Kind, 'mint' | 'burn'>;

/**
 * How much transaction data an index was asked to carry.
 *
 * - `'logs_only'` fetches nothing. Every `kind` that needs a transaction is
 *   `'unclassified'`, and mint rows carry a null `tx_from`. Cheapest and LEAST
 *   USEFUL: it can name who received a mint but not who sent it. Never a default.
 * - `'mints_only'` fetches the transaction for every MINT row, leaving non-mints
 *   `'unclassified'`. This is the cheap-but-useful level: `firstMinters` works,
 *   including the acting wallet.
 * - `'full'` fetches the transaction for every row. Required by `overlap`.
 *
 * WHY `'mints_only'` STILL FETCHES, though `mint` is decidable from the log
 * alone: `tx_from` on a mint is the ACTING wallet, and the acting wallet is the
 * product. One bot minting 200 tokens to 200 fresh addresses and 200 separate
 * collectors produce identical rows once `tx_from` is null — the index can only
 * report recipients, so the single most important pattern it exists to surface
 * becomes invisible. Classification is not the only thing a transaction is for.
 */
export type EnrichmentLevel = 'logs_only' | 'mints_only' | 'full';

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

/**
 * A row as stored. Every bigint is already a decimal string.
 *
 * `txFrom` and `txValueWei` are null together or set together — never one of
 * each — and null means "the transaction was not fetched", never "the sender is
 * unknown". A table CHECK enforces both halves of that, and also that a null
 * transaction forbids `kind` `'buy'` or `'transfer'`.
 */
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
  txFrom: string | null;
  txValueWei: string | null;
  kind: Kind;
}
