import { createPublicClient, http, type PublicClient } from 'viem';
import type { Config } from '../config.js';
import { ConfigError } from '../errors.js';
import { createRateLimiter, type RateLimiter } from './rateLimit.js';

export interface ChainClient {
  chainId: number;
  client: PublicClient;
  /**
   * The ACCOUNT-WIDE compute-unit budget, shared by every chain.
   *
   * It used to be one bucket per chain, on the reasoning that a slow mainnet backfill
   * should not throttle Base. That reasoning was wrong, and measurably so: the ceiling
   * belongs to the account, so concurrent work on two chains draws on one budget and a
   * saturating run on either necessarily slows the other. Per-chain buckets could only
   * have divided a budget they did not control, while letting their sum exceed it — the
   * worst of both.
   *
   * Per-chain FAIRNESS (stopping one chain monopolising the shared budget) is a separate
   * mechanism and is deliberately not built: nothing indexes two chains at once yet, and
   * a queue nobody contends for is speculative machinery.
   *
   * Pass the method's cost from `CU_COSTS`. Omitting it charges the most expensive known
   * method, so a forgotten cost is slow rather than rate-limited.
   */
  limit: RateLimiter;
}

// Keyed by chainId only: the Config passed on first construction for a given
// chain is the one captured for its whole lifetime. A later call passing a
// different Config for an already-cached chain silently returns the entry
// built from the first Config. Fine for a process that loads config once at
// startup; call resetChainClients() to pick up a changed config.
const clients = new Map<number, ChainClient>();

/**
 * One bucket for the whole process, because the ceiling is one budget for the whole
 * account. Built on first use from the config then in hand; `resetChainClients()` clears
 * it alongside the clients so a test can change the ceiling.
 */
let accountLimiter: RateLimiter | undefined;

function sharedLimiter(config: Config): RateLimiter {
  if (!accountLimiter) {
    accountLimiter = createRateLimiter({
      // Capacity equals one second's refill: enough to let a burst of cheap calls
      // through together, without banking an idle minute's worth and then spending it
      // all at once — which is exactly what earns a 429.
      capacity: config.computeUnitsPerSecond,
      refillPerSec: config.computeUnitsPerSecond,
    });
  }
  return accountLimiter;
}

/**
 * Memoized public client plus its rate limiter, one pair per chain.
 *
 * They are returned together so a caller cannot pair a client with the wrong
 * bucket, and so one chain's slow backfill cannot throttle another's — each
 * chain has its own token pool sized from its own `requestsPerSecond`.
 *
 * Read-only: this project never signs, so no wallet client exists anywhere.
 *
 * A failed construction is deliberately NOT cached. Caching it would turn a
 * transient misconfiguration into a permanent one for the life of the process.
 */
export function getChainClient(chainId: number, config: Config): ChainClient {
  const cached = clients.get(chainId);
  if (cached) return cached;

  const chain = config.chains.get(chainId);
  if (!chain) {
    throw new ConfigError(
      `chain ${chainId} is not configured. Set RPC_URL_${chainId} and add it to ` +
      'config/chains.json.',
    );
  }

  const client = createPublicClient({
    transport: http(chain.rpcUrl, {
      // Measured against an always-500 server: viem DOUBLES the delay each
      // retry (250/500/1000), so 3 retries cost ~1750ms of backoff across 4
      // HTTP attempts. See the worst-case arithmetic in rateLimit.ts.
      retryCount: 3,
      retryDelay: 250,
      // viem's own default is 10s (measured directly against a local server
      // that never responds: node_modules/viem/_esm/clients/transports/http.js
      // falls back to 10_000). Task 3 measured a cold archive `getCode` read
      // exceeding that default and failing as a spurious timeout — see
      // scripts/verify-archive-probes.ts, which overrides to 30s for the same
      // reason. `getLogs` over a wide range has the same profile, so 30s here
      // is a deliberate override, not viem's default. See rateLimit.ts for
      // the worst-case arithmetic this number feeds into.
      timeout: 30_000,
      // Coalesces concurrent calls into JSON-RPC batch requests, which is what
      // makes per-tx enrichment affordable without manual batching.
      batch: { batchSize: 50, wait: 10 },
    }),
  });

  const entry: ChainClient = {
    chainId,
    client,
    limit: sharedLimiter(config),
  };

  // Only reached on success, so a throw above leaves nothing cached.
  clients.set(chainId, entry);
  return entry;
}

export function resetChainClients(): void {
  clients.clear();
  accountLimiter = undefined;
}
