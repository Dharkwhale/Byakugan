import { isAddress } from 'viem';
import { UsageError } from '../errors.js';
import type { Address, EnrichmentLevel } from '../types.js';

export interface ParsedArgs {
  chainId: number;
  contract: Address;
  level: EnrichmentLevel;
  dryRun: boolean;
  verbose: boolean;
  toBlock?: bigint;
  deployBlock?: number;
  /** Minimum gap between progress lines. */
  progressMs: number;
  /**
   * Which fetch path to use. `auto` prefers getAssetTransfers where the endpoint serves
   * it; `logs` forces eth_getLogs.
   *
   * `logs` exists so the two paths can be compared end to end on a real collection —
   * index the same range both ways and diff the databases — and so a suspected divergence
   * can be investigated without editing code. It is not a tuning knob: `auto` is correct,
   * and the paths are required to produce identical rows.
   */
  fetchPath: 'auto' | 'logs';
}

const LEVELS: EnrichmentLevel[] = ['logs_only', 'mints_only', 'full'];

/**
 * Every option this CLI accepts. An unknown one is REJECTED, not ignored.
 *
 * The dangerous case is not a meaningless flag but a near miss: `--dry-runn` silently
 * dropped means a run the operator believed was a preview indexes for real, which is
 * the exact accident --dry-run exists to prevent.
 */
const KNOWN_OPTIONS = new Set([
  'contract', 'chain', 'level', 'to-block', 'deploy-block',
  'dry-run', 'progress-ms', 'verbose', 'help', 'fetch-path',
]);

/** Cheap edit-distance-1 suggestion, so a typo is named rather than merely refused. */
function nearest(name: string): string | undefined {
  for (const known of KNOWN_OPTIONS) {
    if (Math.abs(known.length - name.length) > 2) continue;
    if (known.startsWith(name) || name.startsWith(known)) return known;
  }
  return undefined;
}

export const USAGE = `
byakugan index — backfill an NFT collection's transfer history

  npm run index -- --contract 0x… [options]

Options
  --contract 0x…      collection address (required)
  --chain <id>        chain id; defaults to DEFAULT_CHAIN_ID
  --level <level>     logs_only | mints_only | full        (default: full)
  --to-block <n>      stop at this block, clamped to the safe head
  --deploy-block <n>  supply the deploy block instead of resolving it
  --dry-run           resolve, report the span and cost, index nothing
  --progress-ms <n>   minimum gap between progress lines   (default: 2000)
  --fetch-path <p>    auto | logs                           (default: auto)
                      auto uses alchemy_getAssetTransfers where available, which
                      is dramatically cheaper, falling back to eth_getLogs.
  --verbose           include a stack trace on failure
  --help              this text

Levels
  logs_only    fetches no transactions. Cheapest, and firstMinters REFUSES it,
               because tx_from is the minting wallet and it would be null.
  mints_only   fetches each mint's transaction. firstMinters works; overlap does not.
  full         fetches every transaction. Required by overlap.

A collection's level is fixed when it is first indexed. Resuming with a different
one is refused rather than producing an index with two levels in different block
ranges — upgrade it explicitly instead.
`;

/**
 * Parses argv, rejecting anything ambiguous rather than guessing.
 *
 * EVERY FAILURE HERE IS A `UsageError`, which the CLI maps to exit code 2 (USAGE).
 * That is the whole point of separating this from the run: a wrapping script can tell
 * "the address was wrong" from "the RPC was down" by the exit code alone, without
 * parsing message text that will be reworded later.
 *
 * The address is validated with viem's `isAddress` and then LOWERCASED. Both halves
 * matter: a typo caught here names the flag, whereas the same typo reaching SQLite
 * surfaces as an opaque CHECK constraint failure; and every address in this system is
 * stored lowercase, so normalising at the boundary is what lets the query layer assert
 * rather than defensively re-normalise.
 */
export function parseArgs(argv: string[], defaultChainId: number | undefined): ParsedArgs {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      throw new UsageError(
        `unexpected argument "${token}". Options are named, e.g. --contract 0x….`,
      );
    }
    const name = token.slice(2);
    if (!KNOWN_OPTIONS.has(name)) {
      // Silently ignoring an unknown option is how `--dry-runn` starts a real
      // eleven-hour index while the operator believes they asked for a preview. A
      // typo must stop the run, not be dropped.
      const suggestion = nearest(name);
      throw new UsageError(
        `unknown option --${name}.${suggestion ? ` Did you mean --${suggestion}?` : ''} ` +
        'Run with --help for the full list.',
      );
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      i++;
    }
  }

  const value = (name: string): string | undefined => {
    const raw = flags.get(name);
    if (raw === undefined) return undefined;
    if (raw === true) {
      throw new UsageError(`--${name} needs a value.`);
    }
    return raw;
  };

  const contractRaw = value('contract');
  if (contractRaw === undefined) {
    throw new UsageError('--contract is required. Pass the collection address.');
  }
  if (!isAddress(contractRaw)) {
    throw new UsageError(
      `--contract "${contractRaw}" is not a valid address. It must be 0x followed by ` +
      '40 hexadecimal characters.',
    );
  }

  const chainRaw = value('chain');
  const chainId = chainRaw === undefined ? defaultChainId : Number(chainRaw);
  if (chainId === undefined) {
    throw new UsageError(
      'no chain specified and DEFAULT_CHAIN_ID is not set. Pass --chain <id>.',
    );
  }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new UsageError(`--chain "${chainRaw}" is not a chain id.`);
  }

  const levelRaw = value('level') ?? 'full';
  if (!LEVELS.includes(levelRaw as EnrichmentLevel)) {
    throw new UsageError(
      `--level "${levelRaw}" is not recognised. Use one of: ${LEVELS.join(', ')}.`,
    );
  }

  return {
    chainId,
    contract: contractRaw.toLowerCase() as Address,
    level: levelRaw as EnrichmentLevel,
    dryRun: flags.has('dry-run'),
    verbose: flags.has('verbose'),
    toBlock: parseOptionalBigint(value('to-block'), 'to-block'),
    deployBlock: parseOptionalInt(value('deploy-block'), 'deploy-block'),
    progressMs: parseOptionalInt(value('progress-ms'), 'progress-ms') ?? 2_000,
    fetchPath: parseFetchPath(value('fetch-path')),
  };
}

export function wantsHelp(argv: string[]): boolean {
  return argv.length === 0 || argv.includes('--help') || argv.includes('-h');
}

function parseFetchPath(raw: string | undefined): 'auto' | 'logs' {
  if (raw === undefined || raw === 'auto') return 'auto';
  if (raw === 'logs') return 'logs';
  throw new UsageError(
    `--fetch-path "${raw}" is not recognised. Use "auto" (prefer getAssetTransfers, ` +
    'which is far cheaper) or "logs" (force eth_getLogs).',
  );
}

function parseOptionalBigint(raw: string | undefined, name: string): bigint | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`--${name} "${raw}" must be a non-negative whole number.`);
  }
  return BigInt(raw);
}

function parseOptionalInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`--${name} "${raw}" must be a non-negative whole number.`);
  }
  return Number(raw);
}
