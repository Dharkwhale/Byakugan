/**
 * The CLI as a PROCESS, not as functions.
 *
 * `cli.test.ts` covers the error-to-message mapping and the exit-code table. Neither
 * proves the process actually exits with those codes — `process.exitCode` can be set
 * and then lost to a later throw, an unawaited promise, or a `finally` that overwrites
 * it. A wrapping script sees only the number, so the number is what gets asserted here.
 *
 * The scrubbing case is the other reason this file spawns children: the path that
 * leaked an API key in this project was Node's own uncaught-exception printer, which no
 * in-process assertion can reach.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const ADDR = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';

interface Run { status: number; stdout: string; stderr: string; all: string }

/**
 * Runs the CLI with a controlled environment.
 *
 * `env` REPLACES rather than extends the parent's, apart from PATH, so the developer's
 * real `.env`-derived variables cannot leak in and change what the test exercises —
 * and so a real RPC URL is never in scope for a test about a fake one.
 */
function run(args: string[], env: Record<string, string> = {}): Run {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 120_000,
        env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 0, stdout, stderr: '', all: stdout };
  } catch (thrown) {
    const e = thrown as SpawnSyncReturns<string> & { stdout?: string; stderr?: string };
    const stdout = e.stdout ?? '';
    const stderr = e.stderr ?? '';
    return { status: e.status ?? -1, stdout, stderr, all: stdout + stderr };
  }
}

describe('exit codes, as the process actually reports them', () => {
  it('exits 0 for --help', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--dry-run');
  }, 120_000);

  it('exits 0 for no arguments, treating it as a help request', () => {
    expect(run([]).status).toBe(0);
  }, 120_000);

  it('exits 2 for a malformed address', () => {
    const r = run(['--contract', '0xnope'], { DEFAULT_CHAIN_ID: '1', RPC_URL_1: 'http://x/k' });
    expect(r.status).toBe(2);
    expect(r.all).toContain('not a valid address');
  }, 120_000);

  it('exits 2 for an unrecognised enrichment level', () => {
    const r = run(['--contract', ADDR, '--level', 'partial'],
      { DEFAULT_CHAIN_ID: '1', RPC_URL_1: 'http://x/k' });
    expect(r.status).toBe(2);
    expect(r.all).toContain('logs_only, mints_only, full');
  }, 120_000);

  it('exits 2 for an unconfigured chain', () => {
    const r = run(['--contract', ADDR, '--chain', '999999'],
      { DEFAULT_CHAIN_ID: '1', RPC_URL_1: 'http://x/k' });
    expect(r.status).toBe(2);
    expect(r.all).toContain('is not configured');
  }, 120_000);

  it('exits 2 for an unknown option rather than ignoring it', () => {
    const r = run(['--contract', ADDR, '--turbo'],
      { DEFAULT_CHAIN_ID: '1', RPC_URL_1: 'http://x/k' });
    expect(r.status).toBe(2);
  }, 120_000);

  it('exits 3 — not 2 — when the endpoint is unreachable', () => {
    // THE DISTINCTION THE CODES EXIST FOR. "bad address" is 2 and a human must fix it;
    // "RPC down" is 3 and a wrapper should retry later. Port 1 refuses connections, so
    // this is an infrastructure failure with a perfectly valid command.
    const r = run(['--contract', ADDR, '--chain', '84532', '--dry-run'], {
      RPC_URL_84532: 'http://127.0.0.1:1/v2/UNREACHABLEKEY123456',
    });
    expect(r.status).toBe(3);
  }, 120_000);

  it('never exits 0 on a failure, whatever the category', () => {
    for (const args of [
      ['--contract', '0xnope'],
      ['--contract', ADDR, '--chain', '999999'],
      ['--contract', ADDR, '--to-block', 'later'],
    ]) {
      expect(run(args, { DEFAULT_CHAIN_ID: '1', RPC_URL_1: 'http://x/k' }).status)
        .not.toBe(0);
    }
  }, 120_000);
});

describe('no secret reaches output, even from a failing run', () => {
  /**
   * A DELIBERATELY FAKE key. Nothing real is in scope: `run` replaces the environment
   * rather than extending it, so the developer's actual RPC URL is not present in the
   * child at all.
   */
  const FAKE_KEY = 'ZZfakeAlchemyKey0123456789';

  it('redacts the API key from an unreachable-endpoint error', () => {
    // viem's transport errors carry the request URL, and the URL carries the key. This
    // is the exact shape that put a real key into a transcript in this project: a
    // probe hit an error, the dump printed `url:`, and the key had to be rotated.
    const r = run(['--contract', ADDR, '--chain', '84532', '--dry-run'], {
      RPC_URL_84532: `http://127.0.0.1:1/v2/${FAKE_KEY}`,
    });
    expect(r.status).not.toBe(0);
    expect(r.all).not.toContain(FAKE_KEY);
  }, 120_000);

  it('redacts it from a URL-encoded appearance too', () => {
    const r = run(['--contract', ADDR, '--chain', '84532', '--dry-run'], {
      RPC_URL_84532: `http://127.0.0.1:1/v2/${FAKE_KEY}?k=${FAKE_KEY}`,
    });
    expect(r.all).not.toContain(FAKE_KEY);
  }, 120_000);

  it('still produces a useful message while redacting', () => {
    // Scrubbing that silenced the error would be safe and useless. The operator must
    // still learn the endpoint could not be reached.
    const r = run(['--contract', ADDR, '--chain', '84532', '--dry-run'], {
      RPC_URL_84532: `http://127.0.0.1:1/v2/${FAKE_KEY}`,
    });
    expect(r.all).not.toContain(FAKE_KEY);
    expect(r.all.length).toBeGreaterThan(20);
    expect(r.all.toLowerCase()).toMatch(/error|fail|unavailable|could not/);
  }, 120_000);

  it('prints no raw stack trace by default', () => {
    const r = run(['--contract', ADDR, '--chain', '84532', '--dry-run'], {
      RPC_URL_84532: `http://127.0.0.1:1/v2/${FAKE_KEY}`,
    });
    // A stack trace is both unreadable and the carrier that leaked the key.
    expect(r.all).not.toMatch(/\n\s+at .*\(.*:\d+:\d+\)/);
  });
});
