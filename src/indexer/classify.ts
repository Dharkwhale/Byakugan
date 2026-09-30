import { ClassifyError } from '../errors.js';
import { ZERO_ADDRESS, type DecodedTransfer, type Kind, type TxInfo } from '../types.js';

/**
 * Throws if `value` is not already lowercase.
 *
 * `classify` ASSERTS its address inputs are normalised rather than
 * normalising them itself. Addresses are supposed to arrive lowercase already
 * — `decode.ts` lowercases `transfer.from`/`transfer.to` before this function
 * ever sees them, and `chain/tx.ts` (Task 12) is specified to lowercase
 * `tx.from` the same way. Defensively re-lowercasing here would let an
 * omission in either of those places pass through unnoticed: classify would
 * just quietly compensate and nobody would learn the upstream contract was
 * broken. Asserting instead makes that dependency unskippable — the first
 * real value that violates it throws here, by name, instead of being masked.
 */
function assertLowercase(label: string, value: string): void {
  if (value !== value.toLowerCase()) {
    throw new ClassifyError(
      `${label} must already be lowercase, received "${value}". Addresses are ` +
      'normalised at the boundary — decode.ts for transfer.from/to, chain/tx.ts for ' +
      'tx.from. classify asserts rather than normalises, so an upstream omission fails ' +
      'here loudly instead of being silently masked.',
    );
  }
}

/**
 * Classifies one transfer.
 *
 * RULE ORDER IS LOAD-BEARING. A paid mint satisfies both the mint rule and the
 * buy rule, so checking buy first would relabel every paid mint as a buy —
 * which is most of them. mint, then burn, then buy, then transfer.
 *
 * CASE IS ASSERTED, NOT NORMALISED. Addresses are expected to arrive already
 * lowercase: `decode.ts` lowercases `transfer.from`/`transfer.to`, and
 * `chain/tx.ts` is specified to lowercase `tx.from` the same way before this
 * function runs. `classify` checks that invariant with `assertLowercase`
 * rather than defensively re-lowercasing, because normalising here would mask
 * a broken upstream contract instead of surfacing it — a checksummed value
 * reaching this function is itself the bug, and the loudest, most specific
 * place to catch it is right here, by field name, rather than downstream as
 * an opaque SQLite CHECK failure (or, worse, not at all).
 *
 * A NULL `tx` IS A REAL INPUT, not an error. Under the `mints_only` enrichment
 * level no transaction is fetched at all, because `mint` and `burn` follow from
 * the log alone. Telling `buy` from `transfer` does not, so with no transaction
 * this returns `'unclassified'` — deliberately NOT `'transfer'`. Returning
 * `'transfer'` would be the cheap, natural, wrong answer: it is what you get by
 * failing to look, it is indistinguishable from a genuine transfer once stored,
 * and it would lose every buy in the range while `overlap` reported plausible
 * zeroes. The database refuses that row outright (see `db/migrations/001_init.sql`),
 * and `requireFullEnrichment` refuses to answer `overlap` from any index still
 * holding unclassified rows.
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
  tx: TxInfo | null,
): Kind {
  // Validated BEFORE the log-decidable shortcut below, on purpose. A caller
  // passing raw rows is broken for every row, not just its non-mints; checking
  // after the `mint`/`burn` returns would let a whole mint-heavy backfill pass
  // and surface the fault only on the first sale.
  if (tx !== null) {
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
        'before classifying. To classify without a transaction, pass null ' +
        'explicitly — that yields "unclassified", not a guess.',
      );
    }
    assertLowercase('tx.from', tx.from);
  }

  assertLowercase('transfer.from', transfer.from);
  assertLowercase('transfer.to', transfer.to);

  const from = transfer.from;
  const to = transfer.to;

  // Decidable from the log alone, at either enrichment level.
  if (from === ZERO_ADDRESS) return 'mint';
  if (to === ZERO_ADDRESS) return 'burn';

  // Everything below needs the transaction. Without it, say so.
  if (tx === null) return 'unclassified';

  if (tx.value > 0n && tx.from === to) return 'buy';
  return 'transfer';
}
