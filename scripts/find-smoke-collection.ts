/**
 * Finds a candidate collection for the real-provider smoke test.
 *
 * THE INVERSE QUERY. What is wanted is a RECENTLY DEPLOYED ERC-721 — recent so the
 * deploy-block-to-head span is small enough for a bounded run to be cheap and
 * repeatable. There is no "collections by deploy date" endpoint, so this asks the
 * question backwards:
 *
 *   1. `alchemy_getAssetTransfers` with `fromAddress = 0x0` over a recent window
 *      returns MINTS only, across every contract at once.
 *   2. Group them by contract: those are the collections minting right now.
 *   3. For each candidate, ask whether it had ANY transfer BEFORE that window. If it
 *      had none, its first transfer is inside the window, so it was deployed recently.
 *      That is the inverse of "when was this deployed", and it needs one call each.
 *   4. Read `name`/`symbol` to filter out protocol artifacts — LP positions, vault
 *      receipts, airdrop spam — which are ERC-721 by interface but are not the thing
 *      this bot exists to track. The sampled Base collection that produced the earlier
 *      density figures was Uniswap V3 Positions, where every "mint" is an independent
 *      LP action; a smoke test wants real collector mints instead.
 *
 * Nothing here is hardcoded into a test. It PRINTS candidates for a human to confirm
 * against a block explorer, because this project has already had two Base addresses
 * accepted on my word and then found unverifiable.
 */
import './_scrub-output.js'; // MUST be first: output-boundary secret scrubbing.
import { createPublicClient, http, parseAbi } from 'viem';
import { loadConfig } from '../src/config.js';
import type { Address } from '../src/types.js';

const CHAIN_ID = Number(process.argv[2] ?? '8453');
/** Blocks to look back for active mints. Base is ~2s, so 100k is roughly two days. */
const WINDOW = BigInt(process.argv[3] ?? '100000');
const ZERO = '0x0000000000000000000000000000000000000000';

const config = loadConfig();
const chain = config.chains.get(CHAIN_ID);
if (!chain) throw new Error(`chain ${CHAIN_ID} is not configured`);

const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: 30_000 }) });
const METADATA = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
]);

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

const head = await client.getBlockNumber();
const windowStart = head - WINDOW;
process.stdout.write(
  `\nchain ${CHAIN_ID} (${chain.name})  head ${head}\n` +
  `scanning mints in blocks ${windowStart}..${head} (${WINDOW} blocks)\n\n`,
);

// ---- 1 & 2: recent mints, grouped by contract.
const mintsByContract = new Map<string, { mints: number; firstBlock: bigint; lastBlock: bigint }>();
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
  const result = await rpc('alchemy_getAssetTransfers', [params]);
  pages += 1;
  for (const transfer of result.transfers as Array<Record<string, any>>) {
    const contract = String(transfer.rawContract?.address ?? '').toLowerCase();
    if (!contract) continue;
    const block = BigInt(transfer.blockNum);
    const entry = mintsByContract.get(contract);
    if (entry) {
      entry.mints += 1;
      if (block < entry.firstBlock) entry.firstBlock = block;
      if (block > entry.lastBlock) entry.lastBlock = block;
    } else {
      mintsByContract.set(contract, { mints: 1, firstBlock: block, lastBlock: block });
    }
  }
  pageKey = result.pageKey;
} while (pageKey && pages < 6);

process.stdout.write(
  `${pages} page(s): ${mintsByContract.size} contracts minting in that window\n\n`,
);

// Enough mints to be a real collection, few enough to index quickly.
const shortlist = [...mintsByContract.entries()]
  .filter(([, v]) => v.mints >= 20 && v.mints <= 2_000)
  .sort((a, b) => b[1].mints - a[1].mints)
  .slice(0, 12);

process.stdout.write(`${shortlist.length} shortlisted by mint count (20..2000)\n\n`);

// ---- 3 & 4: is it NEW, and is it a real collection?
interface Candidate {
  contract: string;
  mints: number;
  firstBlock: bigint;
  lastBlock: bigint;
  priorTransfers: number;
  name?: string;
  symbol?: string;
  totalSupply?: bigint;
}

const candidates: Candidate[] = [];
for (const [contract, stats] of shortlist) {
  const prior = await rpc('alchemy_getAssetTransfers', [{
    fromBlock: '0x0',
    toBlock: hex(windowStart - 1n),
    contractAddresses: [contract],
    category: ['erc721'],
    maxCount: '0x1',
  }]);
  const priorTransfers = (prior.transfers as unknown[]).length;

  const candidate: Candidate = { contract, ...stats, priorTransfers };
  for (const fn of ['name', 'symbol', 'totalSupply'] as const) {
    try {
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

const fresh = candidates.filter((c) => c.priorTransfers === 0);
const artifacts = fresh.filter((c) => ARTIFACT.test(`${c.name ?? ''} ${c.symbol ?? ''}`));
const real = fresh.filter((c) => !ARTIFACT.test(`${c.name ?? ''} ${c.symbol ?? ''}`));

function show(label: string, list: Candidate[]): void {
  process.stdout.write(`\n=== ${label} (${list.length}) ===\n`);
  for (const c of list) {
    process.stdout.write(
      `\n  ${c.contract}\n` +
      `    name/symbol   ${c.name ?? '(none)'} / ${c.symbol ?? '(none)'}\n` +
      `    totalSupply   ${c.totalSupply ?? '(not Enumerable)'}\n` +
      `    mints seen    ${c.mints} in blocks ${c.firstBlock}..${c.lastBlock}\n` +
      `    span to head  ${head - c.firstBlock} blocks\n` +
      `    prior history ${c.priorTransfers === 0 ? 'NONE — first transfer is inside the window' : 'has older transfers'}\n`,
    );
  }
}

show('CANDIDATES: recently deployed, not obviously a protocol artifact', real);
show('REJECTED as protocol artifacts by name', artifacts);
show('REJECTED as not recently deployed', candidates.filter((c) => c.priorTransfers > 0));

process.stdout.write(
  '\nConfirm a candidate against the explorer before any value is written into a test.\n' +
  'Two Base addresses in this project were accepted on my word and later proved\n' +
  'unverifiable, which is why this prints rather than decides.\n\n',
);
