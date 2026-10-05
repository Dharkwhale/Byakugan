/**
 * Reports the SHAPE and the SPAN of specific collections, so a candidate can be judged
 * before any compute units are spent indexing it.
 *
 *   npm run inspect:shape -- 8453 0xaaa… 0xbbb…
 *
 * The companion to `find-public-mint-collection.ts`: that one discovers candidates by scanning
 * a window, this one answers the two questions that decide whether a known address is worth
 * indexing. They are split because discovery costs a window scan that cannot be resumed, and
 * re-scanning to re-judge two addresses already in hand is waste.
 *
 * WHAT IT MEASURES, and why each number.
 *
 * SPAN — the first transfer the chain has for this contract, found with one ascending
 * `getAssetTransfers` from block 0. `find-smoke-collection.ts` asked only whether ANY transfer
 * predated its window, which answers "recently deployed?" with yes or no. That was the wrong
 * question: what decides affordability is HOW FAR BACK, because the index runs deploy block to
 * bound, and "older than two days" covers both a week and two years. A lower bound on the
 * deploy block is also a lower bound on the work.
 *
 * SHAPE — two ratios over recent mints, which together separate three cases that no single
 * ratio can. Measured on Base:
 *
 *   distinct txs ÷ mints    distinct recipients ÷ mints
 *   ~1.00                   ~1.00                        public mint, many wallets
 *   LOW                     ~1.00                        distribution: one wallet minted the
 *                                                        supply and sent it out (TAGGED CREW)
 *   ~1.00                   LOW                          protocol artifact: one wallet opening
 *                                                        many positions (Uniswap V3, 0.25;
 *                                                        Slipstream, 0.04)
 *
 * Recipients alone passes a distribution; transactions alone passes an LP contract. Both are
 * free — `getAssetTransfers` returns a `hash` and a `to` per transfer — which matters because
 * the definitive signal is not.
 *
 * SENDERS — the definitive signal, and the only paid one. The acting wallet is `tx_from`, which
 * costs an `eth_getTransactionByHash` per mint, so a sample of a few transactions stands in for
 * it: one distinct sender across six transactions is a distribution whatever the ratios say.
 * This is the same reason the bot indexes `tx_from` at all.
 *
 * COST, counted rather than estimated: about 330 CU per address — one first-transfer call, one
 * recent-mints page, and up to six sampled transactions. Printed at the end.
 *
 * It PRINTS for a human to confirm against an explorer. Two Base addresses in this project were
 * accepted on my word and later proved unverifiable, so no value here goes into a test.
 */
import './_scrub-output.js'; // MUST be first: output-boundary secret scrubbing.
import { createPublicClient, http, parseAbi } from 'viem';
import { CU_COSTS } from '../src/chain/cuCosts.js';
import { loadConfig } from '../src/config.js';
import type { Address } from '../src/types.js';

const CHAIN_ID = Number(process.argv[2] ?? '8453');
const ADDRESSES = process.argv.slice(3).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
  .map((a) => a.toLowerCase());
if (ADDRESSES.length === 0) {
  throw new Error('usage: inspect-collection-shape.ts <chainId> <0xaddress> [0xaddress…]');
}

/**
 * Window for the shape ratios, back from head. Base is ~2s, so 100k blocks is roughly two days.
 * Widen it with BYAKUGAN_WINDOW to reach a collection that has FINISHED minting — a window that
 * misses the mint entirely reports "no recent mints" and judges nothing.
 */
const WINDOW = BigInt(process.env.BYAKUGAN_WINDOW ?? '100000');
const TXS_PER_SAMPLE = 6;
const ZERO = '0x0000000000000000000000000000000000000000';

const config = loadConfig();
const chain = config.chains.get(CHAIN_ID);
if (!chain) throw new Error(`chain ${CHAIN_ID} is not configured`);

const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: 30_000 }) });
const METADATA = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
]);

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
process.stdout.write(
  `\nchain ${CHAIN_ID} (${chain.name})  head ${head}\n` +
  `inspecting ${ADDRESSES.length} address(es)\n`,
);

for (const contract of ADDRESSES) {
  process.stdout.write(`\n${'='.repeat(72)}\n  ${contract}\n`);

  for (const fn of ['name', 'symbol'] as const) {
    try {
      charge('eth_call');
      const value = await client.readContract({
        address: contract as Address, abi: METADATA, functionName: fn,
      });
      process.stdout.write(`    ${fn.padEnd(16)} ${String(value)}\n`);
    } catch {
      process.stdout.write(`    ${fn.padEnd(16)} (not readable)\n`);
    }
  }

  // ---- SPAN: the first transfer the chain has, ascending from genesis.
  charge('alchemy_getAssetTransfers');
  const first = await rpc('alchemy_getAssetTransfers', [{
    fromBlock: '0x0', toBlock: hex(head),
    contractAddresses: [contract], category: ['erc721'],
    maxCount: '0x1', order: 'asc',
  }]);
  const firstTransfer = (first.transfers as Array<Record<string, any>>)[0];
  if (!firstTransfer) {
    process.stdout.write('    NO ERC-721 TRANSFERS AT ALL — not an indexable 721 here\n');
    continue;
  }
  const firstBlock = BigInt(firstTransfer.blockNum);
  const span = head - firstBlock;
  process.stdout.write(
    `    first transfer   block ${firstBlock}\n` +
    `    SPAN TO HEAD     ${span} blocks  (~${(Number(span) * 2 / 86_400).toFixed(1)} days at 2s)\n`,
  );

  // ---- SHAPE: recent mints, both free ratios, and sample hashes for the paid check.
  charge('alchemy_getAssetTransfers');
  const recent = await rpc('alchemy_getAssetTransfers', [{
    fromBlock: hex(head - WINDOW), toBlock: hex(head),
    fromAddress: ZERO,                 // mints only
    contractAddresses: [contract], category: ['erc721'],
    maxCount: '0x3e8', order: 'asc',
  }]);
  const mints = recent.transfers as Array<Record<string, any>>;
  const hashes = new Set<string>();
  const recipients = new Set<string>();
  for (const m of mints) {
    const h = String(m.hash ?? '').toLowerCase();
    if (h) hashes.add(h);
    const to = String(m.to ?? '').toLowerCase();
    if (to) recipients.add(to);
  }
  process.stdout.write(
    `    mints in ${WINDOW}  ${mints.length}\n` +
    `    distinct txs     ${hashes.size}  ratio ${ratio(hashes.size, mints.length)}\n` +
    `    distinct to:     ${recipients.size}  ratio ${ratio(recipients.size, mints.length)}\n`,
  );

  // ---- SENDERS: the definitive check, sampled.
  const sample = [...hashes].slice(0, TXS_PER_SAMPLE);
  const senders = new Set<string>();
  for (const hash of sample) {
    try {
      charge('eth_getTransactionByHash');
      const tx = await rpc('eth_getTransactionByHash', [hash]) as { from?: string } | null;
      if (tx?.from) senders.add(tx.from.toLowerCase());
    } catch { /* a dropped or reorged hash tells us nothing */ }
  }
  // WHO the sender is decides what a single sender MEANS, and the two readings are opposite.
  // One wallet sending N mints to N different wallets is either a deployer distributing a
  // supply, or a RELAYER paying gas for N real collectors — sponsored mints (ERC-4337
  // bundlers, paymasters, platform relayers) are common on Base. In the second case the
  // collectors are genuinely distinct and `tx_from` is the platform, which would make
  // `/firstminters` answer about the relayer and not about anybody who minted. A sender that
  // is a CONTRACT is strong evidence of the second reading, so it is worth 19 CU to ask.
  const senderList = [...senders];
  for (const sender of senderList) {
    let kind = 'unknown';
    try {
      charge('eth_getCode');
      const code = await rpc('eth_getCode', [sender, 'latest']) as string;
      kind = code && code !== '0x' ? 'CONTRACT (relayer/bundler?)' : 'EOA';
    } catch { /* leave unknown rather than guessing */ }
    process.stdout.write(`    sender           ${sender}  ${kind}\n`);
  }

  const verdict = sample.length === 0
    ? 'no recent mints to sample — cannot judge the shape from this window'
    : senders.size === 1
      ? 'ONE SENDER — either a deployer distributing, or a relayer paying for real ' +
        'collectors. See the sender line above; compare it across collections.'
      : senders.size === sample.length
        ? 'PUBLIC MINT — every sampled mint had a different sender'
        : 'MIXED — some wallets minted more than once';
  process.stdout.write(
    `    sampled senders  ${senders.size}/${sample.length}\n` +
    `    VERDICT          ${verdict}\n`,
  );
}

process.stdout.write(
  `\ncompute units spent: ${cu} (counted from src/chain/cuCosts.ts, itself UNVERIFIED)\n` +
  'The first-transfer block is a LOWER BOUND on the deploy block, not the deploy block;\n' +
  '/index --dry-run resolves that properly and costs little. Confirm against an explorer\n' +
  'before indexing.\n\n',
);
