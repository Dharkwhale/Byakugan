/**
 * Splits a list so an `IN (...)` clause stays under SQLite's bound-variable
 * limit. 500 is well below the 32766 of modern SQLite and safe on older builds.
 */
export function chunked<T>(items: T[], size = 500): T[][] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
