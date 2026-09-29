import { describe, expect, it } from 'vitest';
import { classify } from '../../src/indexer/classify.js';
import { ClassifyError } from '../../src/errors.js';
import { ZERO_ADDRESS, type Address, type TxInfo } from '../../src/types.js';

const BUYER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const SELLER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const ROUTER = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;
/** The conventional burn sink. Note the mixed case — that is how it is written. */
const DEAD = '0x000000000000000000000000000000000000dEaD' as Address;

/** A genuinely checksummed address: viem returns this shape, not lowercase. */
const BUYER_CHECKSUMMED = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Address;

const tx = (over: Partial<TxInfo> = {}): TxInfo => ({ from: BUYER, value: 0n, ...over });

describe('classify — rule order', () => {
  it('calls a transfer from the zero address a mint', () => {
    expect(classify({ from: ZERO_ADDRESS, to: BUYER }, tx())).toBe('mint');
  });

  // The discriminating case: this log satisfies BOTH the mint rule and the buy
  // rule, so it is the only input that tells the two orderings apart. A mutant
  // checking buy first returns 'buy' here.
  it('still calls a paid mint a mint, not a buy', () => {
    expect(classify({ from: ZERO_ADDRESS, to: BUYER }, tx({ from: BUYER, value: 10n })))
      .toBe('mint');
  });

  it('calls a transfer to the zero address a burn', () => {
    expect(classify({ from: SELLER, to: ZERO_ADDRESS }, tx({ from: SELLER }))).toBe('burn');
  });

  // Decided explicitly rather than left to fall out: rule order gives 'mint'.
  // Neither answer is meaningful — no compliant contract emits this — so the
  // point is that the behaviour is pinned, and that it discriminates
  // mint-before-burn from burn-before-mint.
  it('calls a zero-to-zero transfer a mint, by rule order', () => {
    expect(classify({ from: ZERO_ADDRESS, to: ZERO_ADDRESS }, tx())).toBe('mint');
  });

  it('calls a paid burn a burn, not a buy', () => {
    expect(classify({ from: SELLER, to: ZERO_ADDRESS }, tx({ from: ZERO_ADDRESS, value: 5n })))
      .toBe('burn');
  });
});

describe('classify — buy and transfer', () => {
  it('calls a paid transfer to the tx sender a buy', () => {
    expect(classify({ from: SELLER, to: BUYER }, tx({ from: BUYER, value: 10n }))).toBe('buy');
  });

  it('calls an unpaid transfer a transfer', () => {
    expect(classify({ from: SELLER, to: BUYER }, tx({ from: BUYER, value: 0n })))
      .toBe('transfer');
  });

  // Documented limitation, asserted so it is a decision rather than an accident.
  it('calls a paid transfer to someone other than the tx sender a transfer', () => {
    expect(classify({ from: SELLER, to: BUYER }, tx({ from: ROUTER, value: 10n })))
      .toBe('transfer');
  });
});

// REVERSED FROM THE ORIGINAL DESIGN, DELIBERATELY. classify used to
// defensively lowercase its address inputs so a checksummed value would still
// classify correctly. That masked a broken upstream contract: decode.ts and
// chain/tx.ts are responsible for normalising addresses before classify ever
// sees them, and if either omits it, defensive lowercasing here would quietly
// compensate and nobody would learn. classify now ASSERTS its inputs are
// already lowercase and throws, naming the field, instead of normalising.
describe('classify — asserts addresses are already lowercase', () => {
  it('throws on a checksummed tx.from', () => {
    expect(() => classify(
      { from: SELLER, to: BUYER },
      tx({ from: BUYER_CHECKSUMMED, value: 10n }),
    )).toThrow(ClassifyError);
    expect(() => classify(
      { from: SELLER, to: BUYER },
      tx({ from: BUYER_CHECKSUMMED, value: 10n }),
    )).toThrow(/tx\.from/);
  });

  it('throws on a checksummed transfer.to', () => {
    expect(() => classify(
      { from: SELLER, to: BUYER_CHECKSUMMED },
      tx({ from: BUYER, value: 10n }),
    )).toThrow(ClassifyError);
    expect(() => classify(
      { from: SELLER, to: BUYER_CHECKSUMMED },
      tx({ from: BUYER, value: 10n }),
    )).toThrow(/transfer\.to/);
  });

  it('throws on a checksummed transfer.from', () => {
    expect(() => classify(
      { from: BUYER_CHECKSUMMED, to: BUYER },
      tx({ from: BUYER, value: 10n }),
    )).toThrow(ClassifyError);
    expect(() => classify(
      { from: BUYER_CHECKSUMMED, to: BUYER },
      tx({ from: BUYER, value: 10n }),
    )).toThrow(/transfer\.from/);
  });

  it('still classifies a buy when every address is already lowercase', () => {
    expect(classify({ from: SELLER, to: BUYER }, tx({ from: BUYER, value: 10n })))
      .toBe('buy');
  });

  it('does not match two different addresses that differ only beyond case', () => {
    expect(classify({ from: SELLER, to: BUYER }, tx({ from: SELLER, value: 10n })))
      .toBe('transfer');
  });
});

describe('classify — tx.value is a bigint, never a string or number', () => {
  it('treats a value above 2^53 as paid', () => {
    const huge = 2n ** 60n;   // 1152921504606846976 — beyond Number.MAX_SAFE_INTEGER
    expect(huge > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(classify({ from: SELLER, to: BUYER }, tx({ from: BUYER, value: huge }))).toBe('buy');
  });

  it('treats max-uint256 as paid', () => {
    expect(classify({ from: SELLER, to: BUYER }, tx({ from: BUYER, value: 2n ** 256n - 1n })))
      .toBe('buy');
  });

  it('treats exactly zero as unpaid', () => {
    expect(classify({ from: SELLER, to: BUYER }, tx({ from: BUYER, value: 0n })))
      .toBe('transfer');
  });

  it('treats 1 wei as paid', () => {
    expect(classify({ from: SELLER, to: BUYER }, tx({ from: BUYER, value: 1n }))).toBe('buy');
  });

  // A raw database row carries tx_value_wei as TEXT. Handing one straight to
  // classify must fail loudly rather than misclassify: '0' is a non-empty
  // string and any coercing comparison would read it as paid.
  it('throws on a string value rather than misclassifying it', () => {
    expect(() => classify(
      { from: SELLER, to: BUYER },
      { from: BUYER, value: '1000000000000000000' as unknown as bigint },
    )).toThrow(ClassifyError);
  });

  it('throws on a string "0" rather than treating it as unpaid by luck', () => {
    expect(() => classify(
      { from: SELLER, to: BUYER },
      { from: BUYER, value: '0' as unknown as bigint },
    )).toThrow(ClassifyError);
  });

  it('throws on a number value', () => {
    expect(() => classify(
      { from: SELLER, to: BUYER },
      { from: BUYER, value: 10 as unknown as bigint },
    )).toThrow(ClassifyError);
  });

  it('names the offending type in the error', () => {
    expect(() => classify(
      { from: SELLER, to: BUYER },
      { from: BUYER, value: '10' as unknown as bigint },
    )).toThrow(/string/i);
  });

  // These four are the inputs the guard actually exists for. Measured: a
  // NUMERIC string compares correctly against 0n ('10' is paid, '0' is not),
  // so that was never the risk. But undefined, null, '' and a non-numeric
  // string all compare as false against 0n WITHOUT throwing — so a missing or
  // malformed tx.value (an absent field on a real row, a provider returning
  // nothing) silently reads as unpaid and downgrades a genuine buy to a
  // transfer. Unlike the numeric-string case, there is no lucky coercion here.
  it('throws on undefined rather than reading a missing value as unpaid', () => {
    expect(() => classify(
      { from: SELLER, to: BUYER },
      { from: BUYER, value: undefined as unknown as bigint },
    )).toThrow(ClassifyError);
  });

  it('throws on null rather than reading a missing value as unpaid', () => {
    expect(() => classify(
      { from: SELLER, to: BUYER },
      { from: BUYER, value: null as unknown as bigint },
    )).toThrow(ClassifyError);
  });

  it('throws on an empty string rather than reading it as unpaid', () => {
    expect(() => classify(
      { from: SELLER, to: BUYER },
      { from: BUYER, value: '' as unknown as bigint },
    )).toThrow(ClassifyError);
  });

  it('throws on a non-numeric string rather than reading it as unpaid', () => {
    expect(() => classify(
      { from: SELLER, to: BUYER },
      { from: BUYER, value: 'abc' as unknown as bigint },
    )).toThrow(ClassifyError);
  });
});

// Documented limitation, pinned as a test so widening burn detection is a
// deliberate edit rather than a silent behaviour change.
//
// FLAGGED FINDING (see task-7-report.md addendum): DEAD is deliberately
// mixed-case ("that is how it is written"), and the first two tests below
// used to feed it straight into `transfer.to`, relying on classify's own
// .toLowerCase() to tolerate it. That reliance is exactly what the new
// assert-based contract forbids, so those two now use the lowercase form —
// the shape decode.ts actually produces before classify ever sees it — and a
// third test asserts that the original mixed-case fixture now throws instead
// of being silently tolerated. This was not fixed silently: flagged to the
// coordinator before landing, per their request.
describe('classify — burn detects the zero address only', () => {
  const deadLower = DEAD.toLowerCase() as Address;

  it('calls a transfer to 0x…dead a transfer, not a burn', () => {
    expect(classify({ from: SELLER, to: deadLower }, tx({ from: SELLER }))).toBe('transfer');
  });

  it('calls a PAID transfer to 0x…dead a transfer too', () => {
    expect(classify({ from: SELLER, to: deadLower }, tx({ from: ROUTER, value: 10n })))
      .toBe('transfer');
  });

  // The case-insensitivity this used to demonstrate is gone by design: a
  // mixed-case dead address is now itself a bug signal (decode.ts should
  // have normalised it), so classify throws rather than tolerating it.
  it('throws on the conventionally-written mixed-case dead address', () => {
    expect(() => classify({ from: SELLER, to: DEAD }, tx({ from: SELLER })))
      .toThrow(ClassifyError);
  });
});
