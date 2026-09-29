import { ClassifyError } from '../errors.js';
import { ZERO_ADDRESS, type DecodedTransfer, type Kind, type TxInfo } from '../types.js';

/**
 * Classifies one transfer.
 *
 * RULE ORDER IS LOAD-BEARING. A paid mint satisfies both the mint rule and the
 * buy rule, so checking buy first would relabel every paid mint as a buy —
 * which is most of them. mint, then burn, then buy, then transfer.
 *
 * CASE IS LOAD-BEARING TOO. This runs PRE-INSERT, on viem's output, and viem
 * returns CHECKSUMMED addresses. The database's `CHECK (col = lower(col))`
 * constraints are downstream and guarantee nothing here. Comparing a
 * checksummed `tx.from` against a lowercased recipient never matches, so every
 * buy would silently become a transfer — no error, no missing row, just a
 * systematically wrong `kind`. Both sides are lowercased.
 *
 * Known limitations, each pinned by a test:
 * - A sale paid in WETH or another ERC-20 carries `tx.value === 0n` and
 *   classifies as `transfer`.
 * - A purchase routed through a contract, where `tx.from` is the router rather
 *   than the recipient, classifies as `transfer`.
 * - `burn` detects the zero address only. A transfer to `0x…dEaD` is a burn in
 *   practice and is classified `transfer`.
 */
export function classify(
  transfer: Pick<DecodedTransfer, 'from' | 'to'>,
  tx: TxInfo,
): Kind {
  // TxInfo.value is typed bigint, but the repository stores tx_value_wei as
  // TEXT. A caller handing over a raw database row would pass a string, and a
  // coercing comparison would misclassify silently instead of failing — '0' is
  // a non-empty string. Fail loudly at the boundary instead.
  if (typeof tx.value !== 'bigint') {
    throw new ClassifyError(
      `tx.value must be a bigint, received ${typeof tx.value}. ` +
      'Convert with BigInt() before classifying; a string comparison misclassifies silently.',
    );
  }

  const from = transfer.from.toLowerCase();
  const to = transfer.to.toLowerCase();

  if (from === ZERO_ADDRESS) return 'mint';
  if (to === ZERO_ADDRESS) return 'burn';
  if (tx.value > 0n && tx.from.toLowerCase() === to) return 'buy';
  return 'transfer';
}
