/**
 * Alchemy compute-unit prices, and the one place they live.
 *
 * ⚠️ PUBLISHED, NOT MEASURED. These are the figures from Alchemy's published
 * compute-unit table as recorded in this project's notes. They have NOT been confirmed
 * against a dashboard reading. `scripts/measure-cu-cost.ts` exists to settle them: it
 * makes exactly N calls of ONE method so a dashboard delta is attributable.
 *
 * They are hardcoded rather than left absent because leaving them absent had a cost of
 * its own. `requestsPerSecond: 25` sat in config as a flat per-chain rate while
 * `eth_getLogs` at 60 CU against a 300 CU/s ceiling allows only 5 — so every estimate
 * was optimistic by 5x and a real backfill would have met 429s on every run. A wrong
 * number nobody can see is worse than a published one labelled unverified.
 *
 * WHEN A MEASUREMENT ARRIVES, change the numbers here and nowhere else. Nothing else in
 * the codebase contains a CU figure; `VERIFIED` flips to true in the same edit, and the
 * CLI stops printing the caveat.
 *
 * The one figure the arithmetic has been sanity-checked against is `eth_getLogs` at 60:
 * 300 / 60 = 5 sustained calls per second, which matches the ~5.6 hours per million
 * blocks this project has been planning around.
 */

/** Whether the costs below have been confirmed against a dashboard reading. */
export const VERIFIED = false;

/**
 * Free-tier throughput ceiling, in compute units per second.
 *
 * ACCOUNT-WIDE, not per chain — measured earlier in this project: concurrent work on
 * two chains draws on one budget, so a saturating mainnet backfill necessarily slows a
 * Base one. That is why the limiter is shared rather than built per chain.
 */
export const FREE_TIER_CU_PER_SECOND = 300;

/**
 * Cost per call, by JSON-RPC method.
 *
 * A method absent from this map is charged `DEFAULT_CU`, which is deliberately the most
 * expensive entry here. Guessing LOW on an unknown method would let it through too fast
 * and earn a 429; guessing HIGH only makes it slower. When data is missing, the code
 * must not pick the cheaper answer — the same rule that produced `'unclassified'` and
 * the null-cost per-tx fallback.
 */
export const CU_COSTS = {
  eth_blockNumber: 10,
  eth_getLogs: 60,
  eth_getTransactionByHash: 15,
  eth_getBlockByNumber: 16,
  eth_getCode: 19,
  eth_call: 26,
  alchemy_getAssetTransfers: 120,
} as const satisfies Record<string, number>;

export type CuMethod = keyof typeof CU_COSTS;

/** The most expensive known method, used for anything unlisted. See CU_COSTS. */
export const DEFAULT_CU: number = Math.max(...Object.values(CU_COSTS));

export function cuFor(method: CuMethod | string): number {
  return (CU_COSTS as Record<string, number>)[method] ?? DEFAULT_CU;
}

/**
 * Sustainable calls per second for one method at a given ceiling.
 *
 * This is what replaced `requestsPerSecond` in config. A single flat rate cannot be
 * right for every method: at 300 CU/s, `eth_getLogs` sustains 5 calls per second and
 * `eth_getTransactionByHash` sustains 20. A flat 25 was wrong for both — five times too
 * fast for the first, and slightly too fast for the second.
 */
export function callsPerSecond(method: CuMethod | string, cuPerSecond: number): number {
  return cuPerSecond / cuFor(method);
}
