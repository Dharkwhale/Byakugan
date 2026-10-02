import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A STANDING GUARD against a placeholder shipping, not a one-off check that today's are gone.
 *
 * THE CONVENTION. Any code that exists only to fail until a later task replaces it carries
 * the placeholder marker: two at-signs, the word UNWIRED in capitals, two at-signs, with no
 * spaces. Put it in the thrown message (so the failure names itself at runtime) and in the
 * comment beside it. The marker is built from parts below so this file does not contain it
 * either, and it is chosen to collide with nothing: a comment saying "Task 13 supplies
 * this", the word "placeholder" in prose, or a SQL `?` placeholder list all stay legal.
 * Only a deliberate marker trips it.
 *
 * A placeholder that returns a plausible value instead of throwing is the defect this repo
 * guards against elsewhere; this test is what makes a forgotten one a red suite rather than
 * a runtime surprise. Whoever introduces a stub is expected to mark it, and to delete it (and
 * the mark) in the task that wires the real thing.
 */
const MARKER = ['@@', 'UNWIRED', '@@'].join('');

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

/** Files under `dir` that carry the marker. Exported shape kept trivial so it can be self-tested. */
function filesWithMarker(dir: string): string[] {
  return tsFiles(dir).filter((f) => readFileSync(f, 'utf8').includes(MARKER));
}

describe('no placeholder marker remains in src/', () => {
  it('scans a real tree: src/ has TypeScript files for the scan to look at', () => {
    // Guards the guard: a wrong path would scan nothing and pass.
    expect(tsFiles(SRC).length).toBeGreaterThan(20);
  });

  it('finds no file carrying the marker', () => {
    const offenders = filesWithMarker(SRC).map((f) => f.slice(SRC.length + 1));
    expect(offenders, `placeholders still present in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('would catch one: the scan reports a planted marker, by file name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byakugan-marker-'));
    try {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'clean.ts'), '// Task 13 supplies this; a placeholder in prose is fine\n');
      writeFileSync(
        join(dir, 'nested', 'stub.ts'),
        `export const f = () => { throw new Error('${MARKER} not wired'); };\n`,
      );
      expect(filesWithMarker(dir).map((f) => f.slice(dir.length + 1).replace(/\\/g, '/')))
        .toEqual(['nested/stub.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
