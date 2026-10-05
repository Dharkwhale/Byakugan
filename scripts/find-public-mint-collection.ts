/**
 * Finds a collection with MANY DISTINCT MINTERS, not merely many mints.
 *
 * Sibling to `find-smoke-collection.ts`, which shortlists by mint count. That filter found
 * TAGGED CREW — 152 mints, and exactly ONE minter, because a deployer minted the whole supply
 * and distributed it. For a question like "the first ten wallets that minted this" a
 * distribution has no meaningful answer, so mint count is the wrong filter and this script
 * uses the shape instead.
 *
 * THE DISCRIMINATOR, and why the obvious one does not work. Distinct RECIPIENTS cannot tell
 * the two apart: TAGGED CREW sent its 152 mints to 120 distinct addresses, so by that ratio it
 * looks like a healthy public mint. The acting wallet is what differs — 1 sender versus ~N —
 * and that is precisely why `tx_from` is indexed at all.
 *
 * `tx_from` costs one `eth_getTransactionByHash` per mint, which is too much to spend on every
 * candidate, so this goes in two stages:
 *
 *   1. FREE. `alchemy_getAssetTransfers` already returns a transaction `hash` per transfer, so
 *      distinct hashes ÷ mints needs no extra call. A deployer minting a supply does it in a
 *      few transactions; a public mint is roughly one transaction per mint. This rejects the
 *      distribution shape at zero cost.
 *   2. PAID, on survivors only. Sample a few transactions and count distinct `from`. Distinct
 *      hashes is necessary but not sufficient — one wallet can send two hundred transactions —
 *      so the sample is what confirms the senders really are different wallets.
 *
 * Both ratios are printed for every candidate, including the recipient ratio that misleads, so
 * the shape is visible rather than asserted.
 *
 * COMPUTE UNITS. Budgeted to come in under `find-smoke-collection.ts`, which the owner
 * approved as the scale: 1 blockNumber (10) + 6 pages (6 x 120) + 8 prior-history (8 x 120) +
 * 24 metadata eth_call (24 x 26) + 36 sampled transactions (36 x 15) = about 2,850 CU against
 * that script's ~3,100. Printed at the end as a running total, measured not assumed.
 *
 * Nothing here is hardcoded into a test. It PRINTS for a human to confirm against an explorer,
 * because two Base addresses in this project were accepted on my word and later proved
 * unverifiable.
 */
import './_scrub-output.js'; // MUST be first: output-boundary secret scrubbing.
import { createPublicClient, http, parseAbi } from 'viem';
import { CU_COSTS } from '../src/chain/cuCosts.js';
import { loadConfig } from '../src/config.js';
import type { Address } from '../src/types.js';

const CHAIN_ID = Number(process.argv[2] ?? '8453');
/** Blocks to look back for active mints. Base is ~2s, so 100k is roughly two days. */
const WINDOW = BigInt(process.argv[3] ?? '100000');
const ZERO = '0x0000000000000000000000000000000000000000';

/** Kept deliberately below find-smoke-collection's 12/0 so the CU total stays under it. */
const SHORTLIST = 8;
const SURVIVORS_TO_SAMPLE = 6;
const TXS_PER_SAMPLE = 6;

const config = loadConfig();
const chain = config.chains.get(CHAIN_ID);
if (!chain) throw new Error(`chain ${CHAIN_ID} is not configured`);

const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: 30_000 }) });
const METADATA = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
]);

/** Running CU total, so the reported cost is counted rather than estimated. */
let cu = 0;
const charge = (method: keyof typeof CU_COSTS): void => { cu += CU_COSTS[method]; };

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
const ratio = (a: number, b: number): string => (b === 0 ? 'n/a' : (a / b).toFixed(2));

charge('eth_blockNumber');
const head = await client.getBlockNumber();
const windowStart = head - WINDOW;
process.stdout.write(
  `\nchain ${CHAIN_ID} (${chain.name})  head ${head}\n` +
  `scanning mints in blocks ${windowStart}..${head} (${WINDOW} blocks)\n` +
  'filter: DISTINCT MINTERS, not mint count\n\n',
);

// ---- Stage 1, free: mints grouped by contract, with distinct hashes and recipients.
interface Stats {
  mints: number;
  firstBlock: bigint;
  lastBlock: bigint;
  hashes: Set<string>;
  recipients: Set<string>;
  sampleHashes: string[];
}
const byContract = new Map<string, Stats>();
let pageKey: string | undefined;
let pages = 0;
do {
  const params: Record<string, unknown> = {
    fromBlock: hex(windowStart),
    toBlock: hex(head),
    fromAddress: ZERO,          // mints only
    category: ['erc721'],
    maxCount: '0x3e8',
    order: 'asc',
  };
  if (pageKey) params.pageKey = pageKey;
  charge('alchemy_getAssetTransfers');
  const result = await rpc('alchemy_getAssetTransfers', [params]);
  pages += 1;
  for (const transfer of result.transfers as Array<Record<string, any>>) {
    const contract = String(transfer.rawContract?.address ?? '').toLowerCase();
    if (!contract) continue;
    const block = BigInt(transfer.blockNum);
    const hash = String(transfer.hash ?? '').toLowerCase();
    const to = String(transfer.to ?? '').toLowerCase();
    let entry = byContract.get(contract);
    if (!entry) {
      entry = {
        mints: 0, firstBlock: block, lastBlock: block,
        hashes: new Set(), recipients: new Set(), sampleHashes: [],
      };
      byContract.set(contract, entry);
    }
    entry.mints += 1;
    if (block < entry.firstBlock) entry.firstBlock = block;
    if (block > entry.lastBlock) entry.lastBlock = block;
    if (hash) {
      entry.hashes.add(hash);
      // Spread the sample across the window rather than taking the first N, so a collection
      // that opened with a deployer batch and then went public is not judged on its first
      // few transactions alone.
      if (entry.sampleHashes.length < TXS_PER_SAMPLE * 4) entry.sampleHashes.push(hash);
    }
    if (to) entry.recipients.add(to);
  }
  pageKey = result.pageKey;
} while (pageKey && pages < 6);

process.stdout.write(`${pages} page(s): ${byContract.size} contracts minting in that window\n\n`);

// Enough mints to be a real collection, few enough to index cheaply; then ordered by the
// free shape signal rather than by size.
const shortlist = [...byContract.entries()]
  .filter(([, v]) => v.mints >= 20 && v.mints <= 2_000)
  .sort((a, b) => (b[1].hashes.size / b[1].mints) - (a[1].hashes.size / a[1].mints))
  .slice(0, SHORTLIST);

process.stdout.write(
  `${shortlist.length} shortlisted (20..2000 mints), ordered by distinct-hash ratio\n\n`,
);

// ---- Stage 2: is it NEW, is it a real collection, and are the senders really distinct?
interface Candidate {
  contract: string;
  stats: Stats;
  priorTransfers: number;
  name?: string;
  symbol?: string;
  totalSupply?: bigint;
  sampledTxs?: number;
  distinctSenders?: number;
}
const candidates: Candidate[] = [];
for (const [contract, stats] of shortlist) {
  charge('alchemy_getAssetTransfers');
  const prior = await rpc('alchemy_getAssetTransfers', [{
    fromBlock: '0x0',
    toBlock: hex(windowStart - 1n),
    contractAddresses: [contract],
    category: ['erc721'],
    maxCount: '0x1',
  }]);
  const candidate: Candidate = {
    contract, stats, priorTransfers: (prior.transfers as unknown[]).length,
  };
  for (const fn of ['name', 'symbol', 'totalSupply'] as const) {
    try {
      charge('eth_call');
      const value = await client.readContract({
        address: contract as Address, abi: METADATA, functionName: fn,
      });
      Object.assign(candidate, { [fn]: value });
    } catch { /* optional metadata; absence is itself a signal */ }
  }
  candidates.push(candidate);
}

/** Names that mark a protocol artifact rather than a collection someone collects. */
const ARTIFACT = /position|liquidity|\bLP\b|vault|receipt|stake|bond|debt|uniswap|aerodrome|slipstream|claim|voucher/i;
const isArtifact = (c: Candidate): boolean =>
  ARTIFACT.test(`${c.name ?? ''} ${c.symbol ?? ''}`);

const real = candidates.filter((c) => c.priorTransfers === 0 && !isArtifact(c));

// The paid confirmation, on the most promising survivors only.
for (const c of real.slice(0, SURVIVORS_TO_SAMPLE)) {
  const unique = [...new Set(c.stats.sampleHashes)].slice(0, TXS_PER_SAMPLE);
  const senders = new Set<string>();
  for (const hash of unique) {
    try {
      charge('eth_getTransactionByHash');
      const tx = await rpc('eth_getTransactionByHash', [hash]) as { from?: string } | null;
      if (tx?.from) senders.add(tx.from.toLowerCase());
    } catch { /* a dropped or reorged hash tells us nothing; skip it */ }
  }
  c.sampledTxs = unique.length;
  c.distinctSenders = senders.size;
}

function show(label: string, list: Candidate[]): void {
  process.stdout.write(`\n=== ${label} (${list.length}) ===\n`);
  for (const c of list) {
    const s = c.stats;
    const sampled = c.sampledTxs === undefined
      ? '(not sampled — below the paid-confirmation cut)'
      : `${c.distinctSenders}/${c.sampledTxs} distinct senders in the sample` +
        (c.distinctSenders === 1 ? '  <-- DISTRIBUTION, one acting wallet' : '');
    process.stdout.write(
      `\n  ${c.contract}\n` +
      `    name/symbol      ${c.name ?? '(none)'} / ${c.symbol ?? '(none)'}\n` +
      `    totalSupply      ${c.totalSupply ?? '(not Enumerable)'}\n` +
      `    mints seen       ${s.mints} in blocks ${s.firstBlock}..${s.lastBlock}\n` +
      `    distinct txs     ${s.hashes.size}  (ratio ${ratio(s.hashes.size, s.mints)} — ` +
      'near 1.00 is one transaction per mint)\n' +
      `    distinct to:     ${s.recipients.size}  (ratio ${ratio(s.recipients.size, s.mints)} — ` +
      'HIGH EVEN FOR A DISTRIBUTION, which is why this ratio is not the filter)\n' +
      `    sampled senders  ${sampled}\n` +
      `    EARLIEST MINT    block ${s.firstBlock}  <-- bound a run with --to-block above this\n` +
      `    span to head     ${head - s.firstBlock} blocks\n` +
      `    prior history    ${c.priorTransfers === 0 ? 'NONE — first transfer is inside the window' : 'has older transfers'}\n`,
    );
  }
}

show('CANDIDATES: public-mint shape, recently deployed', real);
show('REJECTED as protocol artifacts by name', candidates.filter(isArtifact));
show('REJECTED as not recently deployed', candidates.filter((c) => c.priorTransfers > 0));

process.stdout.write(
  `\ncompute units spent: ${cu} (counted from src/chain/cuCosts.ts, which is itself` +
  ' UNVERIFIED)\n' +
  '  find-smoke-collection.ts at its default scale is about 3,100 for comparison.\n\n' +
  'The EARLIEST MINT block is a lower bound on the deploy block, not the deploy block\n' +
  'itself — /index resolves that properly. Confirm any candidate against an explorer\n' +
  'before indexing it.\n\n',
);
