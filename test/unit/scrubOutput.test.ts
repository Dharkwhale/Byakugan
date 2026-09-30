import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * These tests spawn a CHILD process, because the failure this guard exists to
 * prevent happened in the one path an in-process test cannot reach: Node's own
 * uncaught-exception printer. Asserting on a scrub function's return value would
 * have passed while the real leak occurred.
 *
 * The secret here is invented. No real credential is involved.
 */
const FAKE_KEY = 'TESTSECRET1234567890abcdef';
const FAKE_URL = `https://fake-endpoint.example/v2/${FAKE_KEY}`;

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Runs a child that imports the guard first, and returns its combined output. */
function runChild(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'byakugan-scrub-'));
  roots.push(root);
  const file = join(root, 'probe.ts');
  const guard = join(process.cwd(), 'scripts', '_scrub-output.ts').replace(/\\/g, '/');
  writeFileSync(file, `import '${guard}';\n${body}\n`);

  try {
    return execFileSync(process.execPath, ['--import', 'tsx', file], {
      encoding: 'utf8',
      env: { ...process.env, RPC_URL_9999: FAKE_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // A non-zero exit is expected for the throwing cases; we want its output.
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

describe('output scrubbing guard', () => {
  it('scrubs a secret written to stdout', () => {
    const out = runChild(`console.log('endpoint is ${FAKE_URL}');`);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain('[REDACTED]');
  });

  it('scrubs a secret written to stderr', () => {
    const out = runChild(`console.error('failed calling ${FAKE_URL}');`);
    expect(out).not.toContain(FAKE_KEY);
  });

  it('scrubs a secret in a direct process.stdout.write', () => {
    const out = runChild(`process.stdout.write('raw ${FAKE_URL}\\n');`);
    expect(out).not.toContain(FAKE_KEY);
  });

  // THE PATH THAT ACTUALLY LEAKED. viem's error dump printed the request URL via
  // Node's uncaught-exception handler, which no per-call-site scrub could catch.
  it('scrubs a secret in an UNCAUGHT exception', () => {
    const out = runChild(`throw new Error('request failed for ${FAKE_URL}');`);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain('uncaughtException');
  });

  it('scrubs a secret nested in an error cause, uncaught', () => {
    const out = runChild(
      `const inner = new Error('inner ${FAKE_URL}');\n` +
      `throw new Error('outer', { cause: inner });`,
    );
    expect(out).not.toContain(FAKE_KEY);
  });

  it('scrubs a secret in an unhandled promise rejection', () => {
    const out = runChild(
      `void Promise.reject(new Error('rejected calling ${FAKE_URL}'));\n` +
      `setTimeout(() => {}, 50);`,
    );
    expect(out).not.toContain(FAKE_KEY);
  });

  it('scrubs a secret in an error printed by console.error with the object itself', () => {
    const out = runChild(
      `const e = new Error('boom');\n` +
      `(e as Error & { url?: string }).url = '${FAKE_URL}';\n` +
      `console.error(e, { url: '${FAKE_URL}' });`,
    );
    expect(out).not.toContain(FAKE_KEY);
  });

  it('covers an env var config knows nothing about', () => {
    // RPC_URL_9999 is not in chains.json, so config.secrets cannot carry it.
    // The env scan is what covers it — this is the case that caught out the
    // Base Sepolia probe, which read process.env directly.
    const out = runChild(`console.log(process.env.RPC_URL_9999);`);
    expect(out).not.toContain(FAKE_KEY);
  });

  it('leaves ordinary output untouched', () => {
    const out = runChild(`console.log('indexed 1200 transfers for chain 8453');`);
    expect(out).toContain('indexed 1200 transfers for chain 8453');
  });

  it('still exits non-zero on an uncaught exception', () => {
    let code = 0;
    const root = mkdtempSync(join(tmpdir(), 'byakugan-scrub-'));
    roots.push(root);
    const file = join(root, 'probe.ts');
    const guard = join(process.cwd(), 'scripts', '_scrub-output.ts').replace(/\\/g, '/');
    writeFileSync(file, `import '${guard}';\nthrow new Error('boom');\n`);
    try {
      execFileSync(process.execPath, ['--import', 'tsx', file], { stdio: 'pipe' });
    } catch (err) {
      code = (err as { status?: number }).status ?? 0;
    }
    expect(code).not.toBe(0);
  });
});
