import { isAddress } from 'viem';
import { parseArgs, type ParsedArgs } from '../cli/args.js';
import { UsageError } from '../errors.js';
import type { Address } from '../types.js';

/** Telegram appends @botname to commands in groups. */
function tokens(text: string): string[] {
  return text.trim().split(/\s+/).slice(1).filter((t) => t.length > 0);
}

/**
 * Translates the chat form into the CLI's flag form and hands it to `parseArgs`.
 *
 * ONE VALIDATION PATH, deliberately. Address checking, level checking, lowercasing and
 * the UsageError type all live in the CLI parser, so a bad address produces the same
 * message in both front ends and there is no second implementation to drift. The cost is
 * that the bot's grammar is constrained by the CLI's flags, which is a price worth paying
 * for not having two parsers disagree about what a valid address is.
 */
export function parseIndexCommand(
  text: string,
  defaultChainId: number | undefined,
): ParsedArgs & { confirmed: boolean } {
  const parts = tokens(text);
  const address = parts[0];
  if (address === undefined || address.startsWith('--')) {
    throw new UsageError(
      'Send an address: /index 0x… [--chain N] [--mints-only|--logs-only] [--to-block N]',
    );
  }

  const argv: string[] = ['--contract', address];
  let confirmed = false;
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i]!;
    if (token === '--mints-only') { argv.push('--level', 'mints_only'); continue; }
    if (token === '--logs-only') { argv.push('--level', 'logs_only'); continue; }
    if (token === '--yes') { confirmed = true; continue; }
    argv.push(token);
    const next = parts[i + 1];
    if (next !== undefined && !next.startsWith('--')) { argv.push(next); i++; }
  }
  if (!argv.includes('--level')) argv.push('--level', 'full');

  return { ...parseArgs(argv, defaultChainId), confirmed };
}

export interface QueryArgs {
  chainId: number;
  contracts: Address[];
  limit: number;
  min: number;
}

/**
 * Addresses are DEDUPED. `/overlap 0xA 0xA 0xB` asks about two collections, not three,
 * and counting the repeat would make every wallet that touched 0xA look like it spanned
 * two collections.
 */
export function parseQueryCommand(
  text: string,
  defaultChainId: number | undefined,
): QueryArgs {
  const parts = tokens(text);
  const contracts: Address[] = [];
  let chainId = defaultChainId;
  let limit = 20;
  let min = 2;

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]!;
    if (!token.startsWith('--')) {
      if (!isAddress(token)) {
        throw new UsageError(
          `"${token}" is not a valid address. It must be 0x followed by 40 hex characters.`,
        );
      }
      const lower = token.toLowerCase() as Address;
      if (!contracts.includes(lower)) contracts.push(lower);
      continue;
    }
    const value = parts[++i];
    if (value === undefined) throw new UsageError(`${token} needs a value.`);
    if (token === '--chain') chainId = Number(value);
    else if (token === '--limit') limit = Number(value);
    else if (token === '--min') min = Number(value);
    else throw new UsageError(`unknown option ${token}.`);
  }

  if (contracts.length === 0) throw new UsageError('Send at least one address.');
  if (chainId === undefined || !Number.isInteger(chainId) || chainId <= 0) {
    throw new UsageError('No chain specified and no default is configured. Use --chain N.');
  }
  for (const [name, value] of [['--limit', limit], ['--min', min]] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new UsageError(`${name} must be a whole number of at least 1.`);
    }
  }
  return { chainId, contracts, limit, min };
}
