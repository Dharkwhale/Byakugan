/**
 * Dashboard-verifiable compute-unit measurement.
 *
 * Makes EXACTLY `--calls` requests of ONE method and nothing else, so the CU
 * delta between two dashboard readings is attributable to that method alone.
 * There is deliberately no head lookup, no chain-id probe and no warm-up: a
 * single extra method would contaminate the delta.
 *
 * Usage, reading the Alchemy dashboard's compute-units counter before and after
 * each run:
 *
 *   npm run measure-cu -- --calls 250 --with-txs false
 *   npm run measure-cu -- --calls 250 --with-txs true
 *
 * Expected deltas if eth_getBlockByNumber really costs 20 CU regardless of
 * includeTransactions: 5,000 CU for both runs. If including transactions is
 * priced higher, the second run's delta will be visibly larger — that is the
 * whole question this script exists to settle.
 *
 * Block numbers vary per call so a provider-side cache cannot absorb the
 * requests and understate the cost.
 */
import './_scrub-output.js'; // MUST be first: output-boundary secret scrubbing.
import { loadConfig } from '../src/config.js';

interface Args {
  calls: number;
  withTxs: boolean;
  chainId: number;
  startBlock: bigint;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key?.startsWith('--') && value !== undefined) flags.set(key.slice(2), value);
  }
  const calls = Number(flags.get('calls') ?? '250');
  const withTxs = (flags.get('with-txs') ?? 'false') === 'true';
  const chainId = Number(flags.get('chain') ?? '1');
  const startBlock = BigInt(flags.get('start-block') ?? '21000000');
  if (!Number.isInteger(calls) || calls < 1) {
    throw new Error('--calls must be a positive integer');
  }
  return { calls, withTxs, chainId, startBlock };
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const chain = config.chains.get(args.chainId);
if (!chain) throw new Error(`chain ${args.chainId} is not configured`);

const hex = (n: bigint): string => `0x${n.toString(16)}`;

/**
 * Paced to stay under the documented 300 CU/s free-tier ceiling even if the
 * method turns out to be expensive. A 429 mid-run would leave the delta
 * ambiguous, because a rejected request may or may not be billed.
 */
const PACE_MS = 250;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let ok = 0;
let rejected = 0;
const started = new Date();

for (let i = 0; i < args.calls; i++) {
  const response = await fetch(chain.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'eth_getBlockByNumber',
      params: [hex(args.startBlock + BigInt(i)), args.withTxs],
    }),
  });
  if (response.status === 429) rejected++;
  else ok++;
  await sleep(PACE_MS);
}

const finished = new Date();
process.stdout.write(
  [
    '',
    'CU measurement run complete.',
    `  method              : eth_getBlockByNumber`,
    `  includeTransactions : ${args.withTxs}`,
    `  chain               : ${args.chainId} (${chain.name})`,
    `  blocks              : ${args.startBlock} .. ${args.startBlock + BigInt(Math.max(0, args.calls - 1))}`,
    `  requests accepted   : ${ok}`,
    `  requests 429'd      : ${rejected}${rejected > 0 ? '   <-- delta is AMBIGUOUS, re-run slower' : ''}`,
    `  window (UTC)        : ${started.toISOString()}  ..  ${finished.toISOString()}`,
    '',
    'Read the Alchemy dashboard compute-units counter for that window.',
    `Expected delta if the method costs 20 CU flat: ${ok * 20} CU.`,
    '',
  ].join('\n'),
);
