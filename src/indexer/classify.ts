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
  // TEXT, so a caller handing over a raw row passes a string.
  //
  // Measured: a NUMERIC string compares correctly ('10' > 0n is true, '0' is
  // false), so that is not the risk. The risk is that `undefined`, `null`, ''
  // and any non-numeric string ALL compare as false against 0n WITHOUT
  // throwing — so a missing or malformed value reads as unpaid and silently
  // downgrades a genuine buy to a transfer. Numeric strings happening to work
  // is precisely why trusting the comparison rather than the type is fragile.
  if (typeof tx.value !== 'bigint') {
    throw new ClassifyError(
      `tx.value must be a bigint, received ${typeof tx.value}. A non-bigint ` +
      'value cannot be compared reliably, and a missing or malformed one ' +
      "(undefined, null, '', or a non-numeric string) would silently read as " +
      'unpaid and downgrade a genuine buy to a transfer. Convert with BigInt() ' +
      'before classifying.',
    );
  }

  // Both sides are normalised as a habit — lowercasing costs nothing — but
  // only `to` is load-bearing. `from` is compared only against ZERO_ADDRESS,
  // which has no letters, so no case variation of `from` changes the result;
  // there is no test behind that half, and none is possible (see the deleted
  // "checksummed zero address" test). `to` is compared against `tx.from` in
  // the buy rule below, where case genuinely matters — that pairing is the
  // one Mutant B (dropping toLowerCase on tx.from) demonstrates breaks.
  const from = transfer.from.toLowerCase();
  const to = transfer.to.toLowerCase();

  if (from === ZERO_ADDRESS) return 'mint';
  if (to === ZERO_ADDRESS) return 'burn';
  if (tx.value > 0n && tx.from.toLowerCase() === to) return 'buy';
  return 'transfer';
}
