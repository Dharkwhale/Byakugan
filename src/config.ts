import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { FREE_TIER_CU_PER_SECOND } from './chain/cuCosts.js';
import { ConfigError } from './errors.js';
import type { Address } from './types.js';

const chainSchema = z.object({
  name: z.string().min(1),
  initialChunk: z.number().int().positive(),
  maxChunk: z.number().int().positive(),
  confirmations: z.number().int().nonnegative(),
  archiveProbe: z.object({
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    block: z.number().int().nonnegative(),
  }),
});

export interface ChainConfig extends z.infer<typeof chainSchema> {
  chainId: number;
  rpcUrl: string;
  archiveProbe: { address: Address; block: number };
}

export interface Config {
  chains: Map<number, ChainConfig>;
  defaultChainId: number | undefined;
  dbPath: string;
  etherscanApiKey: string | undefined;
  /**
   * Throughput ceiling in compute units per second, ACCOUNT-WIDE rather than per chain.
   *
   * This replaced a per-chain `requestsPerSecond: 25`, which was wrong in two ways at
   * once. It was five times too fast for `eth_getLogs` (60 CU against a 300 CU/s free
   * tier allows 5 calls per second, not 25), so every backfill would have met 429s. And
   * no single rate can be right for every method anyway: at the same ceiling
   * `eth_getTransactionByHash` sustains 20 calls per second. The limit belongs in compute
   * units, with per-method prices, and it belongs here rather than per chain because the
   * ceiling is a property of the account — measured: concurrent work on two chains draws
   * on one budget.
   */
  computeUnitsPerSecond: number;
  /** Substrings that must never appear in logs. */
  secrets: string[];
}

const RPC_KEY = /^RPC_URL_(\d+)$/;

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  chainsJson?: unknown,
): Config {
  const raw = chainsJson ?? readChainsFile();
  const parsedChains = z.record(z.string(), chainSchema).safeParse(raw);
  if (!parsedChains.success) {
    throw new ConfigError(`config/chains.json is invalid: ${parsedChains.error.message}`);
  }

  const chains = new Map<number, ChainConfig>();
  const secrets: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    const match = RPC_KEY.exec(key);
    if (!match || !value) continue;
    const chainId = Number(match[1]);
    const entry = parsedChains.data[String(chainId)];

    if (!entry) {
      // Configured but unknown chain: ignored, not an error. Still a real,
      // key-bearing endpoint if well-formed, so it must be scrubbed from logs
      // even though it never reaches cfg.chains.
      if (isHttpUrl(value)) secrets.push(value);
      continue;
    }

    if (!isHttpUrl(value)) {
      throw new ConfigError(`${key} is not a valid http(s) URL`);
    }
    chains.set(chainId, {
      ...entry,
      chainId,
      rpcUrl: value,
      archiveProbe: {
        address: entry.archiveProbe.address.toLowerCase() as Address,
        block: entry.archiveProbe.block,
      },
    });
    secrets.push(value);
  }

  if (chains.size === 0) {
    throw new ConfigError(
      'No usable RPC endpoint. Set at least one RPC_URL_<chainId> matching config/chains.json.',
    );
  }

  const etherscanApiKey = env.ETHERSCAN_API_KEY || undefined;
  if (etherscanApiKey) secrets.push(etherscanApiKey);

  const defaultChainId = env.DEFAULT_CHAIN_ID ? Number(env.DEFAULT_CHAIN_ID) : undefined;
  if (defaultChainId !== undefined && !Number.isInteger(defaultChainId)) {
    throw new ConfigError('DEFAULT_CHAIN_ID must be an integer');
  }

  const cuPerSecond = env.COMPUTE_UNITS_PER_SECOND
    ? Number(env.COMPUTE_UNITS_PER_SECOND)
    : FREE_TIER_CU_PER_SECOND;
  if (!Number.isFinite(cuPerSecond) || cuPerSecond <= 0) {
    throw new ConfigError(
      `COMPUTE_UNITS_PER_SECOND must be a positive number, got "${env.COMPUTE_UNITS_PER_SECOND}". ` +
      `Leave it unset for the free tier default of ${FREE_TIER_CU_PER_SECOND}.`,
    );
  }

  return {
    chains,
    defaultChainId,
    dbPath: env.DB_PATH ?? './data/byakugan.db',
    etherscanApiKey,
    computeUnitsPerSecond: cuPerSecond,
    secrets,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function readChainsFile(): unknown {
  try {
    return JSON.parse(readFileSync(new URL('../config/chains.json', import.meta.url), 'utf8'));
  } catch (err) {
    throw new ConfigError(`could not read config/chains.json: ${String(err)}`);
  }
}
