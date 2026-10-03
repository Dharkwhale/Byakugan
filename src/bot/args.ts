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
  // Every way the user asked for a level, so contradictory input is refused rather than
  // resolved by token order. A collection's level is fixed at its FIRST index, so a silent
  // pick here is expensive and hard to undo.
  const levelFlags: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i]!;
    if (token === '--mints-only') { levelFlags.push(token); argv.push('--level', 'mints_only'); continue; }
    if (token === '--logs-only') { levelFlags.push(token); argv.push('--level', 'logs_only'); continue; }
    if (token === '--yes') { confirmed = true; continue; }
    if (token === '--level') levelFlags.push(token);
    if (token === '--contract') {
      // The CLI parser keeps the last --contract, which would silently discard the
      // address the user typed first.
      throw new UsageError('Give the address once, right after /index. Do not also pass --contract.');
    }
    if (token === '--help') {
      throw new UsageError('Send /help to see the bot commands.');
    }
    argv.push(token);
    const next = parts[i + 1];
    if (next !== undefined && !next.startsWith('--')) { argv.push(next); i++; }
  }
  if (levelFlags.length > 1) {
    throw new UsageError(
      `Conflicting level options (${levelFlags.join(', ')}). Pick one of --level, --mints-only or --logs-only.`,
    );
  }
  if (levelFlags.length === 0) argv.push('--level', 'full');

  return { ...parseArgs(argv, defaultChainId), confirmed };
}

export interface QueryArgs {
  chainId: number;
  contracts: Address[];
  limit: number;
  min: number;
}

/**
 * How many addresses the command being parsed accepts.
 *
 * Checked HERE rather than in each handler. `/status` enforced it itself and the two
 * single-address queries forgot, so `/firstminters 0xA 0xB` answered about `0xA` and said
 * nothing about `0xB` — a question nobody asked, answered confidently, which is the same
 * family as the visibility bugs: the output looks complete and the omission is invisible.
 * Putting it in the one path every query already goes through means a new command cannot
 * forget it, and the single-address commands pass `'one'` rather than re-deriving the rule.
 */
export type AddressArity = 'one' | 'many';

/**
 * The options a command actually uses.
 *
 * Same reasoning as the arity above, applied to flags. `parseQueryCommand` accepted
 * `--limit` and `--min` for every command and each handler read only the ones it cared
 * about, so `/overlap 0xA 0xB --limit 50` was accepted, did nothing, and said nothing — and
 * `/status 0xA --limit 50` likewise. The grammar was wider than any command's behaviour,
 * which is the same wrong shape as answering about the first of two addresses: the user's
 * instruction is discarded and the reply looks like it was obeyed.
 *
 * `--chain` is accepted everywhere, so only the other two need naming.
 */
export type QueryOption = 'limit' | 'min';

/**
 * Addresses are DEDUPED. `/overlap 0xA 0xA 0xB` asks about two collections, not three,
 * and counting the repeat would make every wallet that touched 0xA look like it spanned
 * two collections. Note the dedupe runs BEFORE the arity check, so `/status 0xA 0xA` is one
 * address and is allowed — the user named one collection, twice.
 */
export function parseQueryCommand(
  text: string,
  defaultChainId: number | undefined,
  arity: AddressArity = 'many',
  accepts: readonly QueryOption[] = ['limit', 'min'],
): QueryArgs {
  const parts = tokens(text);
  const contracts: Address[] = [];
  let chainId = defaultChainId;
  let chainRaw: string | undefined;
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
    if (token === '--chain') { chainRaw = value; chainId = Number(value); }
    else if (token === '--limit' || token === '--min') {
      const name = token.slice(2) as QueryOption;
      // Refused, not ignored. A flag this command does not read is an instruction the user
      // gave and the reply would silently discard.
      if (!accepts.includes(name)) {
        throw new UsageError(
          `${token} does not apply to this command, so it is refused rather than ignored — ` +
          'a reply that quietly dropped it would look like it had been obeyed.',
        );
      }
      if (name === 'limit') limit = Number(value);
      else min = Number(value);
    }
    else throw new UsageError(`unknown option ${token}.`);
  }

  if (contracts.length === 0) throw new UsageError('Send at least one address.');
  if (arity === 'one' && contracts.length > 1) {
    throw new UsageError(
      `This command takes ONE address and you sent ${contracts.length} ` +
      `(${contracts.join(', ')}). It is refused rather than answered about the first, ` +
      'because a reply about one of them would look like a complete answer. Send them one ' +
      'at a time, or use /overlap for a question across several collections.',
    );
  }
  if (chainId === undefined) {
    throw new UsageError('No chain specified and no default is configured. Use --chain N.');
  }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new UsageError(`--chain "${chainRaw}" is not a chain id.`);
  }
  for (const [name, value] of [['--limit', limit], ['--min', min]] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new UsageError(`${name} must be a whole number of at least 1.`);
    }
  }
  return { chainId, contracts, limit, min };
}
