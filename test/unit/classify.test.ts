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

// THE HIGHEST-VALUE BLOCK HERE. classify runs PRE-INSERT on viem's output, and
// viem returns CHECKSUMMED addresses. The database's lower() CHECK constraints
// are downstream and guarantee nothing at this point. A comparison that
// lowercases one side only never matches, so every buy silently becomes a
// transfer — no error, no missing rows, just a wrong `kind` that looks fine.
describe('classify — checksummed input must still match', () => {
  it('matches a checksummed tx.from against a checksummed recipient', () => {
    expect(classify(
      { from: SELLER, to: BUYER_CHECKSUMMED },
      tx({ from: BUYER_CHECKSUMMED, value: 10n }),
    )).toBe('buy');
  });

  it('matches a checksummed tx.from against a lowercase recipient', () => {
    expect(classify({ from: SELLER, to: BUYER }, tx({ from: BUYER_CHECKSUMMED, value: 10n })))
      .toBe('buy');
  });

  it('matches a lowercase tx.from against a checksummed recipient', () => {
    expect(classify({ from: SELLER, to: BUYER_CHECKSUMMED }, tx({ from: BUYER, value: 10n })))
      .toBe('buy');
  });

  // No "checksummed zero address" test: the zero address has no letters, so
  // ZERO_ADDRESS.toUpperCase() is a no-op and there is no case variation of
  // it to exercise. The plain-mint test above already covers this input;
  // the property is not merely untested here, it is untestable.

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
describe('classify — burn detects the zero address only', () => {
  it('calls a transfer to 0x…dEaD a transfer, not a burn', () => {
    expect(classify({ from: SELLER, to: DEAD }, tx({ from: SELLER }))).toBe('transfer');
  });

  it('calls a PAID transfer to 0x…dEaD a transfer too', () => {
    expect(classify({ from: SELLER, to: DEAD }, tx({ from: ROUTER, value: 10n })))
      .toBe('transfer');
  });

  it('is unaffected by the case of the dead address', () => {
    const lower = DEAD.toLowerCase() as Address;
    expect(classify({ from: SELLER, to: lower }, tx({ from: SELLER }))).toBe('transfer');
  });
});
