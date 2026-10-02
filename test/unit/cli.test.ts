import { describe, expect, it } from 'vitest';
import { parseArgs, USAGE, wantsHelp } from '../../src/cli/args.js';
import { estimateBackfill, formatEstimate, humanizeSeconds } from '../../src/cli/estimate.js';
import { EXIT, formatError, reportError } from '../../src/cli/exit.js';
import { createProgressReporter } from '../../src/cli/progress.js';
import { manualClock } from '../../src/clock.js';
import * as errors from '../../src/errors.js';

const ADDR = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const CHECKSUMMED = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';

describe('every error class maps to a readable message and an exit code', () => {
  /**
   * Enumerated from the module rather than listed by hand, so a new error class added
   * to src/errors.ts without a CLI mapping FAILS here. A hand-written list would
   * quietly stay complete-looking while the real set grew past it.
   */
  const classes = Object.entries(errors).filter(
    ([, v]) => typeof v === 'function' && v !== errors.ByakuganError
      && Object.prototype.isPrototypeOf.call(errors.ByakuganError, v),
  ) as Array<[string, new (m: string) => Error]>;

  it('finds every subclass, so this suite cannot silently shrink', () => {
    // EXACT, not a lower bound. The `it.each` blocks below are only as good as this
    // filter: if it ever returned nothing they would silently run zero cases and pass.
    // Exact equality also means adding an error class fails HERE, which is the prompt
    // to give it a mapping rather than letting it fall through to "Unhandled".
    expect(classes.length).toBe(11);
    expect(classes.map(([n]) => n)).toContain('EnrichmentLevelError');
    expect(classes.map(([n]) => n)).toContain('DeployBlockUnavailableError');
  });

  it.each(classes)('%s produces a headline, the detail, and no stack', (name, Cls) => {
    const reported = reportError(new Cls(`specific detail for ${name}`));
    expect(reported.headline).not.toBe('');
    expect(reported.detail).toContain(`specific detail for ${name}`);
    expect(reported.exitCode).not.toBe(EXIT.OK);

    const text = formatError(reported);
    expect(text).toContain(reported.headline);
    expect(text).toContain(`specific detail for ${name}`);
    // The whole point: readable, not a stack trace.
    expect(text).not.toMatch(/\bat .*:\d+:\d+/);
  });

  it.each(classes)('%s is mapped specifically, not caught by the fallback', (_name, Cls) => {
    // The generic ByakuganError branch says so in its headline. Reaching it means the
    // class was added without a mapping, which is the defect this asserts against.
    expect(reportError(new Cls('x')).headline).not.toMatch(/^Unhandled /);
  });
});

describe('exit codes separate user error from infrastructure failure', () => {
  // The distinction a wrapping script needs: stop and tell a human, versus retry later.
  it('treats a bad request as USAGE', () => {
    expect(reportError(new errors.ConfigError('x')).exitCode).toBe(EXIT.USAGE);
    expect(reportError(new errors.UsageError('x')).exitCode).toBe(EXIT.USAGE);
    expect(reportError(new errors.UnsupportedStandardError('x')).exitCode).toBe(EXIT.USAGE);
    expect(reportError(new errors.EnrichmentLevelError('x')).exitCode).toBe(EXIT.USAGE);
  });

  it('treats provider and chain failures as UNAVAILABLE', () => {
    expect(reportError(new errors.DeployBlockUnavailableError('x')).exitCode)
      .toBe(EXIT.UNAVAILABLE);
    expect(reportError(new errors.RangeExhaustedError('x')).exitCode).toBe(EXIT.UNAVAILABLE);
    expect(reportError(new errors.TxEnrichmentError('x')).exitCode).toBe(EXIT.UNAVAILABLE);
  });

  it('separates a held lock, local schema state, and internal defects', () => {
    expect(reportError(new errors.CollectionLockedError('x')).exitCode).toBe(EXIT.BUSY);
    expect(reportError(new errors.MigrationError('x')).exitCode).toBe(EXIT.LOCAL_STATE);
    expect(reportError(new errors.DecodeError('x')).exitCode).toBe(EXIT.INTERNAL);
    expect(reportError(new errors.ClassifyError('x')).exitCode).toBe(EXIT.INTERNAL);
  });

  it('gives the two codes a script will branch on different values', () => {
    // "bad address" must be distinguishable from "RPC down" by code alone, without
    // parsing message text that will be reworded later.
    expect(reportError(new errors.ConfigError('x')).exitCode)
      .not.toBe(reportError(new errors.DeployBlockUnavailableError('x')).exitCode);
  });

  it('reports an unknown throw as INTERNAL without pretending to classify it', () => {
    expect(reportError(new Error('who knows')).exitCode).toBe(EXIT.INTERNAL);
    expect(reportError('a bare string').exitCode).toBe(EXIT.INTERNAL);
    expect(reportError('a bare string').detail).toBe('a bare string');
  });

  it('does not give a bad address advice about environment variables', () => {
    // A misleading hint is worse than none: it sends the reader somewhere the fault
    // is not. This is why UsageError and ConfigError are separate classes.
    const bad = reportError(new errors.UsageError('--contract "0xnope" is not valid'));
    expect(bad.hint).not.toMatch(/environment variable|chains\.json/);
    expect(bad.hint).toMatch(/--help/);
  });

  it('includes a stack only when --verbose asked for one', () => {
    const e = new errors.ConfigError('boom');
    expect(formatError(reportError(e), { verbose: false, err: e })).not.toContain('at ');
    expect(formatError(reportError(e), { verbose: true, err: e })).toContain('ConfigError');
  });
});

describe('argument parsing rejects rather than guesses', () => {
  it('parses a full command', () => {
    expect(parseArgs(
      ['--contract', ADDR, '--chain', '8453', '--level', 'mints_only', '--to-block', '99'],
      undefined,
    )).toMatchObject({
      chainId: 8453, contract: ADDR, level: 'mints_only', toBlock: 99n, dryRun: false,
    });
  });

  it('LOWERCASES a checksummed address at the boundary', () => {
    // Everything downstream stores and compares lowercase, and the query layer asserts
    // rather than re-normalising. This is the boundary that makes that safe.
    expect(parseArgs(['--contract', CHECKSUMMED], 1).contract).toBe(ADDR);
  });

  it('rejects a malformed address by naming the flag', () => {
    expect(() => parseArgs(['--contract', '0xnope'], 1))
      .toThrow(/--contract "0xnope" is not a valid address/);
  });

  it('rejects a bad address as UsageError, so the exit code is USAGE', () => {
    let code: number | undefined;
    try { parseArgs(['--contract', 'garbage'], 1); }
    catch (e) { code = reportError(e).exitCode; }
    expect(code).toBe(EXIT.USAGE);
  });

  it('requires a contract', () => {
    expect(() => parseArgs([], 1)).toThrow(/--contract is required/);
  });

  it('requires a chain when there is no default', () => {
    expect(() => parseArgs(['--contract', ADDR], undefined))
      .toThrow(/DEFAULT_CHAIN_ID is not set/);
  });

  it('falls back to the default chain when one is configured', () => {
    expect(parseArgs(['--contract', ADDR], 8453).chainId).toBe(8453);
  });

  it('rejects an unknown level, listing the valid ones', () => {
    expect(() => parseArgs(['--contract', ADDR, '--level', 'some'], 1))
      .toThrow(/logs_only, mints_only, full/);
  });

  it('rejects a non-numeric block bound', () => {
    expect(() => parseArgs(['--contract', ADDR, '--to-block', 'soon'], 1))
      .toThrow(/must be a non-negative whole number/);
  });

  it('rejects a flag given no value', () => {
    expect(() => parseArgs(['--contract', ADDR, '--chain'], 1)).toThrow(/--chain needs a value/);
  });

  it('rejects a bare positional argument', () => {
    expect(() => parseArgs([ADDR], 1)).toThrow(/unexpected argument/);
  });

  it('defaults the fetch path to auto, preferring the cheap source', () => {
    expect(parseArgs(['--contract', ADDR], 1).fetchPath).toBe('auto');
    expect(parseArgs(['--contract', ADDR, '--fetch-path', 'logs'], 1).fetchPath).toBe('logs');
    expect(parseArgs(['--contract', ADDR, '--fetch-path', 'auto'], 1).fetchPath).toBe('auto');
  });

  it('rejects an unknown fetch path rather than silently choosing one', () => {
    expect(() => parseArgs(['--contract', ADDR, '--fetch-path', 'assets'], 1))
      .toThrow(/not recognised/);
  });

  it('recognises flags and defaults', () => {
    const a = parseArgs(['--contract', ADDR, '--dry-run', '--verbose'], 1);
    expect(a).toMatchObject({ dryRun: true, verbose: true, level: 'full', progressMs: 2000 });
  });

  it('treats no arguments and --help as a help request', () => {
    expect(wantsHelp([])).toBe(true);
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['--contract', ADDR])).toBe(false);
    expect(USAGE).toContain('--dry-run');
  });
});

describe('progress output is rate-limited but never loses the ends', () => {
  function setup(intervalMs = 2_000) {
    const clock = manualClock(0);
    const lines: string[] = [];
    const reporter = createProgressReporter({
      clock, write: (l) => lines.push(l), intervalMs,
      contract: ADDR, chainId: 1, fromBlock: 1n, toBlock: 100n,
    });
    return { clock, lines, reporter };
  }

  it('prints the first chunk immediately, so a long run is visibly alive', () => {
    const { lines, reporter } = setup();
    reporter.onChunk({ chunkIndex: 0, fromBlock: 1n, toBlock: 10n, inserted: 3 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('chunk 1');
    expect(lines[0]).toContain('blocks 1-10');
  });

  it('suppresses chunks inside the interval', () => {
    const { clock, lines, reporter } = setup();
    reporter.onChunk({ chunkIndex: 0, fromBlock: 1n, toBlock: 10n, inserted: 1 });
    for (let i = 1; i < 50; i++) {
      clock.advance(10);
      reporter.onChunk({ chunkIndex: i, fromBlock: 1n, toBlock: 10n, inserted: 1 });
    }
    // 50 chunks in 490ms: one line, not fifty. At the measured 10-block cap a
    // million-block span is 100,000 chunks, and one line each buries everything else.
    expect(lines).toHaveLength(1);
  });

  it('prints again once the interval has elapsed', () => {
    const { clock, lines, reporter } = setup(1_000);
    reporter.onChunk({ chunkIndex: 0, fromBlock: 1n, toBlock: 10n, inserted: 1 });
    clock.advance(999);
    reporter.onChunk({ chunkIndex: 1, fromBlock: 11n, toBlock: 20n, inserted: 1 });
    expect(lines).toHaveLength(1);
    clock.advance(1);
    reporter.onChunk({ chunkIndex: 2, fromBlock: 21n, toBlock: 30n, inserted: 1 });
    expect(lines).toHaveLength(2);
  });

  it('accumulates rows across suppressed chunks rather than losing them', () => {
    const { clock, lines, reporter } = setup(1_000);
    reporter.onChunk({ chunkIndex: 0, fromBlock: 1n, toBlock: 10n, inserted: 5 });
    clock.advance(10);
    reporter.onChunk({ chunkIndex: 1, fromBlock: 11n, toBlock: 20n, inserted: 7 });
    clock.advance(1_000);
    reporter.onChunk({ chunkIndex: 2, fromBlock: 21n, toBlock: 30n, inserted: 2 });
    expect(lines[1]).toContain('rows 14');
  });

  it('always prints the final tally, whatever the interval', () => {
    const { lines, reporter } = setup(1_000_000);
    reporter.onChunk({ chunkIndex: 0, fromBlock: 1n, toBlock: 10n, inserted: 1 });
    reporter.finish({ chunks: 10, rows: 42, lastIndexedBlock: 100 });
    // A reporter that can swallow the last line leaves the operator unsure whether
    // the run finished.
    expect(lines.at(-1)).toContain('chunks 10');
    expect(lines.at(-1)).toContain('rows 42');
    expect(lines.at(-1)).toContain('block 100');
  });

  it('computes percentage from bigints, without overflowing on a huge span', () => {
    const clock = manualClock(0);
    const lines: string[] = [];
    const huge = 2n ** 64n;
    const reporter = createProgressReporter({
      clock, write: (l) => lines.push(l),
      contract: ADDR, chainId: 1, fromBlock: 1n, toBlock: huge,
    });
    reporter.onChunk({ chunkIndex: 0, fromBlock: 1n, toBlock: huge / 2n, inserted: 1 });
    expect(lines[0]).toContain('(50%)');
  });
});

describe('the dry run estimate', () => {
  it('counts getLogs calls exactly, by ceiling division', () => {
    const e = estimateBackfill({
      fromBlock: 1n, toBlock: 100n, chunkBlocks: 10, requestsPerSecond: 5,
    });
    expect(e.blocks).toBe(100n);
    expect(e.logsCalls).toBe(10);
    // A partial final chunk still costs a call.
    expect(estimateBackfill({
      fromBlock: 1n, toBlock: 101n, chunkBlocks: 10, requestsPerSecond: 5,
    }).logsCalls).toBe(11);
  });

  it('produces the eleven-hour figure that justifies its existence', () => {
    // A million blocks at the measured 10-block cap and 5 sustained getLogs/second.
    const e = estimateBackfill({
      fromBlock: 1n, toBlock: 1_000_000n, chunkBlocks: 10, requestsPerSecond: 5,
    });
    expect(e.logsCalls).toBe(100_000);
    expect(humanizeSeconds(e.logsSeconds)).toBe('5.6 hours');
  });

  it('stays exact on a span beyond Number.MAX_SAFE_INTEGER', () => {
    const e = estimateBackfill({
      fromBlock: 0n, toBlock: 2n ** 60n, chunkBlocks: 10, requestsPerSecond: 5,
    });
    expect(e.blocks).toBe(2n ** 60n + 1n);
  });

  it('reports CU as NOT COMPUTED when no prices are configured', () => {
    const e = estimateBackfill({
      fromBlock: 1n, toBlock: 100n, chunkBlocks: 10, requestsPerSecond: 5,
    });
    expect(e.logsCu).toBeNull();
    expect(e.enrichment.perTxCu).toBeNull();
    expect(e.enrichment.breakEvenTxsPerBlock).toBeNull();
  });

  it('computes CU when prices are supplied', () => {
    const e = estimateBackfill({
      fromBlock: 1n, toBlock: 100n, chunkBlocks: 10, requestsPerSecond: 5,
      prices: { perLogsCall: 60, perTx: 15, perBlock: 20 },
    });
    expect(e.logsCu).toBe(600);
    expect(e.enrichment.breakEvenTxsPerBlock).toBeCloseTo(1.3333, 3);
  });

  it('never folds enrichment into the total, and says why', () => {
    // Enrichment measured at ~142x the fetch cost. A total that omitted it silently
    // would read as an upper bound while being a small fraction of the real bill.
    const e = estimateBackfill({
      fromBlock: 1n, toBlock: 100n, chunkBlocks: 10, requestsPerSecond: 5,
      prices: { perLogsCall: 60, perTx: 15, perBlock: 20 },
    });
    expect(e.logsCu).toBe(600);
    expect(e.enrichment.reason).toMatch(/not estimable before the logs are read/);
  });

  it('refuses a backwards or nonsensical range instead of reporting zero', () => {
    expect(() => estimateBackfill({
      fromBlock: 10n, toBlock: 1n, chunkBlocks: 10, requestsPerSecond: 5,
    })).toThrow(/below fromBlock/);
    expect(() => estimateBackfill({
      fromBlock: 1n, toBlock: 10n, chunkBlocks: 0, requestsPerSecond: 5,
    })).toThrow(/positive integer/);
    expect(() => estimateBackfill({
      fromBlock: 1n, toBlock: 10n, chunkBlocks: 10, requestsPerSecond: 0,
    })).toThrow(/must be positive/);
  });

  it('formats a report that says nothing was written', () => {
    const text = formatEstimate({
      estimate: estimateBackfill({
        fromBlock: 100n, toBlock: 1_000_000n, chunkBlocks: 10, requestsPerSecond: 5,
      }),
      chainId: 8453, chainName: 'base', contract: ADDR, standard: '721',
      deployBlock: 100, deployBlockSource: 'binary_search', deployBlockValidated: true,
      level: 'full', safeHead: 1_000_030n, requestsPerSecond: 5,
    });
    expect(text).toContain('nothing was indexed and nothing was written');
    expect(text).toContain('99,991');            // exact call count
    expect(text).toContain('hours');             // the number that stops an 11-hour run
    expect(text).toContain('not computed');      // honest about missing prices
    expect(text).toContain('rerun without --dry-run');
    // The rate is a configured assumption, and the report must say so — the same
    // defect as the chunk size, which was read from config and wrong by 2000x.
    // The rate's PROVENANCE must be stated. It is now derived from the compute-unit
    // ceiling rather than from a flat configured number, and the report says which —
    // the earlier version trusted config's 25/s and was optimistic by 5x.
    expect(text).toContain('derived from the');
    expect(text).toContain('compute-unit ceiling');
  });

  it('flags an unvalidated deploy block in the report', () => {
    const text = formatEstimate({
      estimate: estimateBackfill({
        fromBlock: 1n, toBlock: 10n, chunkBlocks: 10, requestsPerSecond: 5,
      }),
      chainId: 1, chainName: 'ethereum', contract: ADDR, standard: '1155',
      deployBlock: 1, deployBlockSource: 'explorer', deployBlockValidated: false,
      level: 'mints_only', safeHead: 20n, requestsPerSecond: 5,
    });
    expect(text).toContain('NOT validated against the chain');
  });
});

describe('humanizeSeconds', () => {
  it('scales the unit to the magnitude', () => {
    expect(humanizeSeconds(12)).toBe('12.0s');
    expect(humanizeSeconds(600)).toBe('10.0 minutes');
    expect(humanizeSeconds(40_000)).toBe('11.1 hours');
    expect(humanizeSeconds(600_000)).toBe('6.9 days');
  });
});
