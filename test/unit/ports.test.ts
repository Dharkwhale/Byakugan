import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBackfillPorts } from '../../src/chain/ports.js';
import { resetChainClients } from '../../src/chain/client.js';
import type { ChainConfig, Config } from '../../src/config.js';
import type { Address } from '../../src/types.js';

/**
 * `makeBackfillPorts` against a stubbed endpoint, because the branch that matters here cannot
 * be reached any other way: anvil serves no `alchemy_getAssetTransfers`, so the integration
 * test only ever sees the getLogs path.
 *
 * The stub replaces the global `fetch` that both viem's transport and the asset-transfers
 * fetcher use. It answers `eth_blockNumber` always, and `alchemy_getAssetTransfers` as the
 * test dictates. The assertion that carries the weight is not the label alone but the label
 * AGAINST the source the ports actually build: a label that says getAssetTransfers while the
 * ports return a getLogs source is the defect, and `makeTransferSource('721').name` is what
 * the run would execute.
 */
const CONTRACT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d' as Address;
const URL_ = 'http://stub.invalid/rpc';

const chain: ChainConfig = {
  chainId: 1, name: 'stub', rpcUrl: URL_, initialChunk: 10, maxChunk: 10, confirmations: 2,
  archiveProbe: { address: CONTRACT, block: 1 },
};
const config: Config = {
  chains: new Map([[1, chain]]), defaultChainId: 1, dbPath: ':memory:',
  etherscanApiKey: undefined, computeUnitsPerSecond: 1_000_000,
  telegramBotToken: undefined, telegramAllowedUserIds: [], secrets: [],
};

let assetTransfersAnswer: 'supported' | 'unsupported';
let assetTransferCalls: number;

function rpcAnswer(req: { id: number; method: string }): unknown {
  if (req.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: req.id, result: '0x64' };
  if (req.method === 'alchemy_getAssetTransfers') {
    assetTransferCalls++;
    return assetTransfersAnswer === 'supported'
      ? { jsonrpc: '2.0', id: req.id, result: { transfers: [] } }
      : { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } };
  }
  return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'unexpected method' } };
}

beforeEach(() => {
  assetTransfersAnswer = 'supported';
  assetTransferCalls = 0;
  resetChainClients();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { id: number; method: string } | Array<{ id: number; method: string }>;
    const out = Array.isArray(body) ? body.map(rpcAnswer) : rpcAnswer(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); resetChainClients(); });

describe('makeBackfillPorts — the fetch path label and the ports agree', () => {
  it('names getAssetTransfers, and builds that source, when the endpoint answers the probe', async () => {
    const built = await makeBackfillPorts({
      config, chainId: 1, contract: CONTRACT, fetchPath: 'auto',
    });
    expect(built.fetchPath).toBe('getAssetTransfers');
    expect(built.fetchPathReason).toBeUndefined();
    expect(built.ports.makeTransferSource('721').name).toBe('getAssetTransfers');
    expect(assetTransferCalls).toBe(1);   // probed once, here, not per chunk
  });

  it('names getLogs, with the reason, and builds that source, when the probe fails', async () => {
    assetTransfersAnswer = 'unsupported';
    const built = await makeBackfillPorts({
      config, chainId: 1, contract: CONTRACT, fetchPath: 'auto',
    });
    expect(built.fetchPath).toBe('getLogs');
    expect(built.fetchPathReason).toMatch(/Method not found/);
    expect(built.ports.makeTransferSource('721').name).toBe('getLogs');
  });

  it('forced to logs: never probes, even where the endpoint would have answered', async () => {
    const built = await makeBackfillPorts({
      config, chainId: 1, contract: CONTRACT, fetchPath: 'logs',
    });
    expect(built.fetchPath).toBe('getLogs');
    expect(built.fetchPathReason).toMatch(/forced/);
    expect(built.ports.makeTransferSource('721').name).toBe('getLogs');
    expect(assetTransferCalls).toBe(0);
  });

  it('reports the safe head as the head minus the chain confirmations', async () => {
    const built = await makeBackfillPorts({
      config, chainId: 1, contract: CONTRACT, fetchPath: 'logs',
    });
    expect(built.safeHead).toBe(0x64n - 2n);
  });

  it('refuses a chain that is not configured, rather than guessing', async () => {
    await expect(makeBackfillPorts({
      config, chainId: 999, contract: CONTRACT, fetchPath: 'auto',
    })).rejects.toThrow(/chain 999 is not configured/);
  });
});
