/**
 * The documented entry point for output scrubbing in `scripts/`.
 *
 * The implementation lives in `src/outputScrubbing.ts` because the shipped CLI needs
 * it too and `tsconfig.build.json` sets `rootDir: "src"`, so a build-time import
 * reaching into `scripts/` fails. This file stays because the standing rule in
 * CLAUDE.md names it: every file in `scripts/`, and every throwaway probe, imports
 * `scripts/_scrub-output.ts` as its FIRST import. Keeping the name stable means that
 * rule needs no exception and no script needs to know the implementation moved.
 *
 * Importing this installs the guard, exactly as before — via the side effect in the
 * module it re-exports, so there is nothing to remember to call.
 */
export { installOutputScrubbing } from '../src/outputScrubbing.js';
