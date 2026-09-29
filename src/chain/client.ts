import { createPublicClient, http, type PublicClient } from 'viem';
import type { Config } from '../config.js';
import { ConfigError } from '../errors.js';
import { createRateLimiter, type RateLimiter } from './rateLimit.js';

export interface ChainClient {
  chainId: number;
  client: PublicClient;
  /** This chain's own token bucket. Never shared with another chain. */
  limit: RateLimiter;
}

const clients = new Map<number, ChainClient>();

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
      // Coalesces concurrent calls into JSON-RPC batch requests, which is what
      // makes per-tx enrichment affordable without manual batching.
      batch: { batchSize: 50, wait: 10 },
    }),
  });

  const entry: ChainClient = {
    chainId,
    client,
    limit: createRateLimiter({
      capacity: chain.requestsPerSecond,
      refillPerSec: chain.requestsPerSecond,
    }),
  };

  // Only reached on success, so a throw above leaves nothing cached.
  clients.set(chainId, entry);
  return entry;
}

export function resetChainClients(): void {
  clients.clear();
}
