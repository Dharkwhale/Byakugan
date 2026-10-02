import { CU_COSTS } from './cuCosts.js';
import type { RateLimiter } from './rateLimit.js';
import type { AssetTransferEntry } from '../indexer/assetTransfers.js';
import type { AssetTransfersFetcher } from '../indexer/transferSource.js';
import type { Address, Standard } from '../types.js';

/** Up to 1000 per page, which is the API's maximum and what makes one call cover a lot. */
const PAGE_SIZE = 1000;

/**
 * `alchemy_getAssetTransfers`, as a fetcher the transfer source can use.
 *
 * It is a raw JSON-RPC call rather than a viem action because viem has no action for a
 * vendor method, and adding one would mean teaching viem a schema for a response this
 * project already types in `AssetTransferEntry`.
 *
 * `order: 'asc'` is not cosmetic. The source's watermark discipline depends on pages
 * arriving in ascending block order — it yields only up to the block before the last one
 * seen, holding the rest back — and descending pages would make that reasoning wrong in a
 * way that silently advances the watermark past unwritten blocks.
 */
export function makeAssetTransfersFetcher(a: {
  rpcUrl: string;
  limit: RateLimiter;
  contract: Address;
  standard: Standard;
  fetchFn?: typeof fetch;
}): AssetTransfersFetcher {
  const doFetch = a.fetchFn ?? fetch;
  let id = 1;

  return async ({ fromBlock, toBlock, pageKey }) => {
    const params: Record<string, unknown> = {
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      contractAddresses: [a.contract],
      category: [a.standard === '721' ? 'erc721' : 'erc1155'],
      maxCount: `0x${PAGE_SIZE.toString(16)}`,
      order: 'asc',
      excludeZeroValue: false,
    };
    if (pageKey) params.pageKey = pageKey;

    return a.limit(async () => {
      const response = await doFetch(a.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: id++, jsonrpc: '2.0', method: 'alchemy_getAssetTransfers', params: [params],
        }),
      });
      if (!response.ok) {
        // Status first: a 429 or 5xx has no JSON body worth parsing, and reporting
        // "unexpected end of JSON" instead of "rate limited" sends the reader nowhere.
        throw new Error(
          `alchemy_getAssetTransfers failed with HTTP ${response.status} ${response.statusText}`,
        );
      }
      const body = await response.json() as {
        result?: { transfers?: AssetTransferEntry[]; pageKey?: string };
        error?: { message?: string; code?: number };
      };
      if (body.error) {
        throw new Error(
          `alchemy_getAssetTransfers: ${body.error.message ?? 'unknown error'}` +
          (body.error.code === undefined ? '' : ` (code ${body.error.code})`),
        );
      }
      return {
        transfers: body.result?.transfers ?? [],
        ...(body.result?.pageKey ? { pageKey: body.result.pageKey } : {}),
      };
    }, CU_COSTS.alchemy_getAssetTransfers);
  };
}
