import { describe, expect, it } from 'vitest';
import { BaseError, HttpRequestError } from 'viem';
import {
  INTERFACE_IDS, detectStandard, isExecutionFailure, supportsEnumerable,
} from '../../src/chain/standard.js';
import { UnsupportedStandardError } from '../../src/errors.js';
import type { Address } from '../../src/types.js';

const ADDRESS = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d' as Address;

/** A contract that answers true only for the listed ids, false otherwise. */
const answering = (ids: string[]) => async (id: `0x${string}`) => ids.includes(id);

/** A contract with no supportsInterface at all — measured shape for CryptoPunks. */
function executionFailure(): Error {
  const inner = new Error('execution reverted');
  inner.name = 'TransactionRejectedRpcError';
  const outer = new BaseError('The contract function reverted.', { cause: inner });
  outer.name = 'ContractFunctionExecutionError';
  return outer;
}

/**
 * WETH's measured shape (mainnet WETH has no supportsInterface and a fallback that
 * returns no data): ContractFunctionExecutionError < ContractFunctionZeroDataError
 * < AbiDecodingZeroDataError. Synthesised with those `name` values as a stand-in
 * for the real chain; there is no TransactionRejectedRpcError anywhere in it.
 */
function wethZeroDataFailure(): Error {
  const inner = new BaseError('Cannot decode zero data ("0x") with ABI parameters.');
  inner.name = 'AbiDecodingZeroDataError';
  const mid = new BaseError('The contract function returned no data.', { cause: inner });
  mid.name = 'ContractFunctionZeroDataError';
  const outer = new BaseError('The contract function execution failed.', { cause: mid });
  outer.name = 'ContractFunctionExecutionError';
  return outer;
}

/** A transport failure — measured shape when the RPC returns HTTP 500. */
function transportFailure(): Error {
  const inner = new HttpRequestError({ url: 'http://example.test', status: 500 });
  const outer = new BaseError('The contract function call failed.', { cause: inner });
  outer.name = 'ContractFunctionExecutionError';
  return outer;
}

describe('isExecutionFailure', () => {
  it('treats a contract-level rejection as an execution failure', () => {
    expect(isExecutionFailure(executionFailure())).toBe(true);
  });

  it('treats the measured WETH zero-data chain as an execution failure', () => {
    expect(isExecutionFailure(wethZeroDataFailure())).toBe(true);
  });

  it('does NOT treat a transport failure as an execution failure', () => {
    expect(isExecutionFailure(transportFailure())).toBe(false);
  });

  it('does not treat a plain error or junk as an execution failure', () => {
    expect(isExecutionFailure(new Error('boom'))).toBe(false);
    expect(isExecutionFailure(null)).toBe(false);
  });
});

describe('detectStandard — happy paths', () => {
  it('detects ERC-721', async () => {
    expect(await detectStandard(answering([INTERFACE_IDS.erc721]), ADDRESS)).toBe('721');
  });

  it('detects ERC-1155', async () => {
    expect(await detectStandard(answering([INTERFACE_IDS.erc1155]), ADDRESS)).toBe('1155');
  });
});

// ERC-165 REQUIRES supportsInterface(0xffffffff) === false. A contract that
// returns true for it is not answering questions, it is saying yes to
// everything, so no positive answer from it can be trusted. Measured: both
// real contracts tested return false here.
describe('detectStandard — the 0xffffffff conformance check', () => {
  it('rejects a contract that claims to support the invalid interface id', async () => {
    const liar = answering([INTERFACE_IDS.invalid, INTERFACE_IDS.erc721]);
    await expect(detectStandard(liar, ADDRESS)).rejects.toThrow(UnsupportedStandardError);
  });

  it('says why, naming the conformance failure rather than "unsupported"', async () => {
    const liar = answering([INTERFACE_IDS.invalid, INTERFACE_IDS.erc721]);
    await expect(detectStandard(liar, ADDRESS)).rejects.toThrow(/0xffffffff|conformance/i);
  });

  // The 0xffffffff + ERC-721-ONLY liar: the claims-both check cannot catch it,
  // so only the conformance check stands between it and being detected as '721'.
  it('rejects a liar answering true to 0xffffffff and ERC-721 only, naming conformance', async () => {
    const liar = answering([INTERFACE_IDS.invalid, INTERFACE_IDS.erc721]);
    await expect(detectStandard(liar, ADDRESS)).rejects.toThrow(UnsupportedStandardError);
    await expect(detectStandard(liar, ADDRESS)).rejects.toThrow(/0xffffffff/);
  });

  it('rejects a liar answering true to 0xffffffff and ERC-1155 only, naming conformance', async () => {
    const liar = answering([INTERFACE_IDS.invalid, INTERFACE_IDS.erc1155]);
    await expect(detectStandard(liar, ADDRESS)).rejects.toThrow(UnsupportedStandardError);
    await expect(detectStandard(liar, ADDRESS)).rejects.toThrow(/0xffffffff/);
  });

  // Does NOT pin conformance: the claims-both check also rejects this contract.
  it('rejects a contract claiming true to everything (caught as claiming both standards)', async () => {
    await expect(detectStandard(async () => true, ADDRESS))
      .rejects.toThrow(UnsupportedStandardError);
  });

  // Order, not presence: on a CONFORMING ERC-721 (the path that returns), the
  // first id queried must be 0xffffffff, so it has been asked before any
  // standard id is and before detectStandard can return.
  it('queries 0xffffffff first, before any standard id, on a successful detection', async () => {
    const calls: string[] = [];
    const good = async (id: `0x${string}`) => { calls.push(id); return id === INTERFACE_IDS.erc721; };
    expect(await detectStandard(good, ADDRESS)).toBe('721');
    expect(calls[0]).toBe(INTERFACE_IDS.invalid);
    expect(calls).toContain(INTERFACE_IDS.erc721);
  });
});

describe('detectStandard — rejections', () => {
  it('rejects a contract supporting neither standard', async () => {
    await expect(detectStandard(answering([]), ADDRESS)).rejects.toThrow(UnsupportedStandardError);
  });

  // Claiming both is broken or hostile; guessing would silently decode the
  // wrong events for the whole collection.
  it('rejects a contract claiming both standards', async () => {
    const both = answering([INTERFACE_IDS.erc721, INTERFACE_IDS.erc1155]);
    await expect(detectStandard(both, ADDRESS)).rejects.toThrow(UnsupportedStandardError);
  });

  it('distinguishes the both-standards message from the neither message', async () => {
    const both = answering([INTERFACE_IDS.erc721, INTERFACE_IDS.erc1155]);
    await expect(detectStandard(both, ADDRESS)).rejects.toThrow(/both/i);
    await expect(detectStandard(answering([]), ADDRESS)).rejects.toThrow(/neither/i);
  });

  it('treats a pre-ERC-165 contract as unsupported, not a crash', async () => {
    const preErc165 = async () => { throw executionFailure(); };
    await expect(detectStandard(preErc165, ADDRESS)).rejects.toThrow(UnsupportedStandardError);
  });

  it('names the address so the error is actionable', async () => {
    await expect(detectStandard(answering([]), ADDRESS)).rejects.toThrow(ADDRESS);
  });

  it('treats a WETH-shaped zero-data failure as unsupported, not a crash', async () => {
    const weth = async () => { throw wethZeroDataFailure(); };
    await expect(detectStandard(weth, ADDRESS)).rejects.toThrow(UnsupportedStandardError);
  });

  it('mentions --standard as the escape hatch for pre-ERC-165 collections', async () => {
    const preErc165 = async () => { throw executionFailure(); };
    await expect(detectStandard(preErc165, ADDRESS)).rejects.toThrow(/--standard/);
  });
});

// A transport failure reported as "supports neither standard" is a confident,
// wrong answer that sends the user looking at their contract instead of their
// connection.
describe('detectStandard — transport failures must not look like unsupported', () => {
  it('rethrows a transport failure instead of reporting unsupported', async () => {
    const flaky = async () => { throw transportFailure(); };
    await expect(detectStandard(flaky, ADDRESS)).rejects.not.toThrow(UnsupportedStandardError);
  });

  it('propagates the original transport error', async () => {
    const err = transportFailure();
    const flaky = async () => { throw err; };
    await expect(detectStandard(flaky, ADDRESS)).rejects.toBe(err);
  });

  it('rethrows a transport failure raised on the conformance probe itself', async () => {
    const err = transportFailure();
    const flaky = async (id: `0x${string}`) => {
      if (id === INTERFACE_IDS.invalid) throw err;
      return true;
    };
    await expect(detectStandard(flaky, ADDRESS)).rejects.toBe(err);
  });
});

describe('supportsEnumerable', () => {
  it('is true when the Enumerable id is supported', async () => {
    expect(await supportsEnumerable(answering([INTERFACE_IDS.erc721Enumerable]))).toBe(true);
  });

  // totalSupply() is Enumerable, not base ERC-721 — asserting against it
  // unconditionally would fail on collections that lack it.
  it('is false for a base ERC-721', async () => {
    expect(await supportsEnumerable(answering([INTERFACE_IDS.erc721]))).toBe(false);
  });

  it('is false when the contract has no supportsInterface at all', async () => {
    expect(await supportsEnumerable(async () => { throw executionFailure(); })).toBe(false);
  });

  // Unlike detection, a transport failure here is not fatal: the caller falls
  // back to a hardcoded expected count. But it must not silently read as
  // "no Enumerable" either, so it rethrows and the caller decides.
  it('rethrows a transport failure rather than reporting false', async () => {
    const err = transportFailure();
    await expect(supportsEnumerable(async () => { throw err; })).rejects.toBe(err);
  });
});

describe('INTERFACE_IDS', () => {
  it('uses the canonical ERC-165 interface ids', () => {
    expect(INTERFACE_IDS.erc721).toBe('0x80ac58cd');
    expect(INTERFACE_IDS.erc1155).toBe('0xd9b67a26');
    expect(INTERFACE_IDS.erc721Enumerable).toBe('0x780e9d63');
    expect(INTERFACE_IDS.invalid).toBe('0xffffffff');
  });
});
