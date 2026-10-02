import { describe, expect, it } from 'vitest';
import { parseIndexCommand, parseQueryCommand } from '../../src/bot/args.js';
import { UsageError } from '../../src/errors.js';

const ADDR = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const ADDR2 = '0xd77b6acabea379b4a838bc9a11bb08d3327eae62';

describe('parseIndexCommand', () => {
  it('reads an address and defaults the level to full', () => {
    expect(parseIndexCommand(`/index ${ADDR}`, 8453)).toMatchObject({
      contract: ADDR, chainId: 8453, level: 'full', confirmed: false,
    });
  });

  it('accepts the level shorthands', () => {
    expect(parseIndexCommand(`/index ${ADDR} --mints-only`, 1).level).toBe('mints_only');
    expect(parseIndexCommand(`/index ${ADDR} --logs-only`, 1).level).toBe('logs_only');
  });

  it('accepts a chain, a bound and a confirmation', () => {
    expect(parseIndexCommand(`/index ${ADDR} --chain 1 --to-block 500 --yes`, 8453))
      .toMatchObject({ chainId: 1, toBlock: 500n, confirmed: true });
  });

  it('lowercases a checksummed address, like the CLI does', () => {
    const mixed = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
    expect(parseIndexCommand(`/index ${mixed}`, 1).contract).toBe(ADDR);
  });

  it('rejects a bare /index with a usage error, rather than crashing or going silent', () => {
    // Review Focus 1.
    expect(() => parseIndexCommand('/index', 1)).toThrow(UsageError);
    expect(() => parseIndexCommand('/index   ', 1)).toThrow(/address/i);
  });

  it('rejects a malformed address through the CLI validator, not a second one', () => {
    expect(() => parseIndexCommand('/index 0xnope', 1)).toThrow(/not a valid address/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseIndexCommand(`/index ${ADDR} --turbo`, 1)).toThrow(/unknown option --turbo/);
  });

  it('rejects contradictory level options instead of letting token order decide', () => {
    expect(() => parseIndexCommand(`/index ${ADDR} --level full --mints-only`, 1))
      .toThrow(/Conflicting level options/);
    expect(() => parseIndexCommand(`/index ${ADDR} --mints-only --logs-only`, 1))
      .toThrow(/Conflicting level options/);
    expect(() => parseIndexCommand(`/index ${ADDR} --logs-only --level full`, 1))
      .toThrow(/Conflicting level options/);
  });

  it('rejects a --contract flag after the positional address', () => {
    expect(() => parseIndexCommand(`/index ${ADDR} --contract ${ADDR2}`, 1))
      .toThrow(/once/);
  });

  it('rejects --help with a pointer to /help rather than ignoring it', () => {
    expect(() => parseIndexCommand('/index --help', 1)).toThrow(UsageError);
    expect(() => parseIndexCommand(`/index ${ADDR} --help`, 1)).toThrow(/\/help/);
  });

  it('tolerates the @botname suffix Telegram adds in groups', () => {
    expect(parseIndexCommand(`/index@byakugan_bot ${ADDR}`, 1).contract).toBe(ADDR);
  });
});

describe('parseQueryCommand', () => {
  it('reads one address and defaults the limit', () => {
    expect(parseQueryCommand(`/firstminters ${ADDR}`, 8453))
      .toMatchObject({ chainId: 8453, contracts: [ADDR], limit: 20, min: 2 });
  });

  it('reads several addresses for overlap', () => {
    expect(parseQueryCommand(`/overlap ${ADDR} ${ADDR2} --min 2`, 1).contracts)
      .toEqual([ADDR, ADDR2]);
  });

  it('DEDUPES repeated addresses', () => {
    // Review Focus 3: without this, one collection counts as two and every wallet that
    // touched it looks like an overlap.
    expect(parseQueryCommand(`/overlap ${ADDR} ${ADDR} ${ADDR2}`, 1).contracts)
      .toEqual([ADDR, ADDR2]);
  });

  it('DEDUPES the same address written checksummed and lowercase', () => {
    // A checksummed paste from Etherscan next to a lowercase one is the realistic
    // duplicate; deduping on the raw token would count one collection twice.
    const mixed = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
    expect(parseQueryCommand(`/overlap ${mixed} ${ADDR}`, 1).contracts).toEqual([ADDR]);
    expect(parseQueryCommand(`/overlap ${ADDR} ${mixed}`, 1).contracts).toEqual([ADDR]);
  });

  it('names an invalid chain as invalid, not as missing', () => {
    expect(() => parseQueryCommand(`/overlap ${ADDR} --chain x`, 1)).toThrow(/"x" is not a chain id/);
    expect(() => parseQueryCommand(`/overlap ${ADDR}`, undefined)).toThrow(/No chain specified/);
  });

  it('requires at least one address', () => {
    expect(() => parseQueryCommand('/firstminters', 1)).toThrow(UsageError);
  });
});
