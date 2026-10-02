/**
 * THE GATE on `getAssetTransfers` being the default fetch path.
 *
 * It is 698x cheaper than `eth_getLogs`, and that is not a reason to trust it. This runs
 * BOTH sources over the same bounded range on a real collection and asserts the row sets
 * are identical: same count, same `(tx_hash, log_index, batch_index)` tuples, and the same
 * token ids, amounts and addresses within each. Anything missing from `getAssetTransfers`
 * disqualifies it as the default however cheap it is, so this exits non-zero on divergence
 * rather than printing a warning somebody skims past.
 *
 * Two things it is really checking, because both would be silent if wrong:
 *
 *   log_index    exists only inside `uniqueId`, as `<hash>:log:<n>`. `firstMinters` orders
 *                by it, so a wrong one reorders the product's headline answer.
 *   batch_index  comes from the position in `erc1155Metadata`, which is only valid if that
 *                array's order matches the log's `ids[]`. Undocumented, so measured here.
 *
 * Usage:
 *   npm run compare:paths -- --chain 8453 --contract 0x… --standard 721 \
 *       --from 51905209 --to 51905900
 */
import './_scrub-output.js'; // MUST be first: output-boundary secret scrubbing.
import { createPublicClient, http, type Address as ViemAddress } from 'viem';
import { CU_COSTS } from '../src/chain/cuCosts.js';
import { loadConfig } from '../src/config.js';
import {
  makeAssetTransfersSource, makeLogsSource, type TransferSource,
} from '../src/indexer/transferSource.js';
import type { AssetTransferEntry } from '../src/indexer/assetTransfers.js';
import type { Address, DecodedTransfer, Hash, Standard } from '../src/types.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  return value;
}

const chainId = Number(arg('chain', '8453'));
const contract = arg('contract').toLowerCase() as Address;
const standard = arg('standard', '721') as Standard;
const fromBlock = BigInt(arg('from'));
const toBlock = BigInt(arg('to'));

const config = loadConfig();
const chain = config.chains.get(chainId);
if (!chain) throw new Error(`chain ${chainId} is not configured`);

const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: 30_000 }) });

let rpcId = 1;
async function rpc(method: string, params: unknown[]): Promise<any> {
  const response = await fetch(chain!.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: rpcId++, jsonrpc: '2.0', method, params }),
  });
  const body = await response.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const hex = (n: bigint): string => `0x${n.toString(16)}`;

const logsSource = makeLogsSource({
  standard,
  initialChunk: chain.maxChunk,
  maxChunk: chain.maxChunk,
  fetchLogs: async ({ fromBlock: f, toBlock: t }) => {
    const logs = await client.getLogs({ address: contract as ViemAddress, fromBlock: f, toBlock: t });
    return logs.map((l) => ({
      topics: l.topics as Hash[],
      data: l.data as Hash,
      transactionHash: l.transactionHash as Hash,
      blockNumber: l.blockNumber!,
      logIndex: l.logIndex!,
    }));
  },
});

const assetSource = makeAssetTransfersSource({
  standard,
  fetch: async ({ fromBlock: f, toBlock: t, pageKey }) => {
    const params: Record<string, unknown> = {
      fromBlock: hex(f), toBlock: hex(t),
      contractAddresses: [contract],
      category: [standard === '721' ? 'erc721' : 'erc1155'],
      maxCount: '0x3e8',
      order: 'asc',
    };
    if (pageKey) params.pageKey = pageKey;
    const result = await rpc('alchemy_getAssetTransfers', [params]);
    return {
      transfers: (result.transfers ?? []) as AssetTransferEntry[],
      ...(result.pageKey ? { pageKey: result.pageKey as string } : {}),
    };
  },
});

async function collect(source: TransferSource): Promise<DecodedTransfer[]> {
  const rows: DecodedTransfer[] = [];
  const covered: Array<[bigint, bigint]> = [];
  for await (const chunk of source.iterate({ fromBlock, toBlock })) {
    rows.push(...chunk.transfers);
    covered.push([chunk.fromBlock, chunk.toBlock]);
  }
  // A source that skipped a block would otherwise look merely sparse.
  let expected = fromBlock;
  for (const [f, t] of covered) {
    if (f !== expected) {
      throw new Error(
        `${source.name} left a GAP: expected a chunk starting at ${expected}, got ${f}`,
      );
    }
    expected = t + 1n;
  }
  if (expected !== toBlock + 1n) {
    throw new Error(
      `${source.name} stopped at ${expected - 1n}, short of the requested ${toBlock}`,
    );
  }
  return rows;
}

const key = (t: DecodedTransfer): string =>
  `${t.txHash}:${t.logIndex}:${t.batchIndex}`;
const detail = (t: DecodedTransfer): string =>
  `block=${t.blockNumber} from=${t.from} to=${t.to} id=${t.tokenId} amt=${t.amount}`;

process.stdout.write(
  `\ncomparing fetch paths\n` +
  `  chain      ${chainId} (${chain.name})\n` +
  `  contract   ${contract}  ERC-${standard}\n` +
  `  blocks     ${fromBlock}..${toBlock}  (${toBlock - fromBlock + 1n})\n\n`,
);

const [viaLogs, viaAsset] = await Promise.all([collect(logsSource), collect(assetSource)]);

const logsMap = new Map(viaLogs.map((t) => [key(t), t]));
const assetMap = new Map(viaAsset.map((t) => [key(t), t]));

const onlyLogs = [...logsMap.keys()].filter((k) => !assetMap.has(k));
const onlyAsset = [...assetMap.keys()].filter((k) => !logsMap.has(k));
const differing = [...logsMap.entries()]
  .filter(([k, t]) => assetMap.has(k) && detail(assetMap.get(k)!) !== detail(t));

process.stdout.write(
  `  eth_getLogs                ${viaLogs.length} rows\n` +
  `  alchemy_getAssetTransfers  ${viaAsset.length} rows\n\n` +
  `  in getLogs only            ${onlyLogs.length}\n` +
  `  in getAssetTransfers only  ${onlyAsset.length}\n` +
  `  same tuple, different data ${differing.length}\n`,
);

for (const k of onlyLogs.slice(0, 10)) {
  process.stdout.write(`    MISSING from getAssetTransfers: ${k}  ${detail(logsMap.get(k)!)}\n`);
}
for (const k of onlyAsset.slice(0, 10)) {
  process.stdout.write(`    EXTRA in getAssetTransfers:     ${k}  ${detail(assetMap.get(k)!)}\n`);
}
for (const [k, t] of differing.slice(0, 10)) {
  process.stdout.write(
    `    DIFFERS ${k}\n      getLogs           ${detail(t)}\n` +
    `      getAssetTransfers ${detail(assetMap.get(k)!)}\n`,
  );
}

// Ordering is asserted separately: identical sets in a different order would still
// reorder firstMinters, which is the query this whole comparison protects.
const orderedLogs = viaLogs.map(key).join('|');
const orderedAsset = viaAsset.map(key).join('|');
const sameOrder = orderedLogs === orderedAsset;
process.stdout.write(`  identical ORDER            ${sameOrder}\n`);

const identical = onlyLogs.length === 0 && onlyAsset.length === 0
  && differing.length === 0 && sameOrder;

process.stdout.write(
  `\n  VERDICT: ${identical ? 'IDENTICAL — getAssetTransfers may be the default' : 'DIVERGENT — getAssetTransfers must NOT be the default'}\n\n`,
);
if (!identical) process.exitCode = 1;

const estLogsCalls = Number((toBlock - fromBlock + 1n + 9n) / 10n);
process.stdout.write(
  `  cost over this range, at published CU prices:\n` +
  `    getLogs at the measured 10-block cap : ${estLogsCalls} calls, ` +
  `${(estLogsCalls * CU_COSTS.eth_getLogs).toLocaleString()} CU\n` +
  `    getAssetTransfers                    : ${Math.max(1, Math.ceil(viaAsset.length / 1000))} ` +
  `page(s), ${(Math.max(1, Math.ceil(viaAsset.length / 1000)) * CU_COSTS.alchemy_getAssetTransfers).toLocaleString()} CU\n\n`,
);
