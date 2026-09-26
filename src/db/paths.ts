import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | undefined;

export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('repo root not found: no package.json in any parent directory');
    }
    dir = parent;
  }
}

/** `MIGRATIONS_DIR` exists so tests can point the runner at a fixture directory. */
export function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? join(repoRoot(), 'db', 'migrations');
}
