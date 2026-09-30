import { DeployBlockUnavailableError } from '../errors.js';
import { deriveSecretTokens, scrubSecrets } from '../secrets.js';
import type { Address, DeployBlockSource } from '../types.js';
import { classifyProbeError } from './probeErrors.js';
import { createRateLimiter, type RateLimiter } from './rateLimit.js';

export interface CodeReader {
  (a: { address: Address; blockNumber: bigint }): Promise<string>;
}

/**
 * `unvalidatable` is a third outcome, not a flavour of `invalid`: the provider
 * could not serve state for the block (Arbitrum pre-Nitro, measured), so the
 * answer is unchecked rather than wrong. Collapsing it into `invalid` discards
 * a correct explorer answer and falls through to a binary search the archive
 * probe has already disabled.
 */
export type ValidationOutcome = 'valid' | 'invalid' | 'unvalidatable';

const hasCode = (code: string | undefined): boolean => Boolean(code) && code !== '0x';

/**
 * Code must exist at `block` and must not exist at `block - 1`.
 * A `state_unavailable` throw is `unvalidatable`; a `transient` one rethrows.
 */
export async function validateDeployBlock(
  getCode: CodeReader,
  address: Address,
  block: bigint,
): Promise<ValidationOutcome> {
  try {
    if (!hasCode(await getCode({ address, blockNumber: block }))) return 'invalid';
    if (block === 0n) return 'valid';
    if (hasCode(await getCode({ address, blockNumber: block - 1n }))) return 'invalid';
    return 'valid';
  } catch (err) {
    if (classifyProbeError(err) === 'state_unavailable') return 'unvalidatable';
    throw err;
  }
}

const PROBE_BACKOFF_MS = 250;

/**
 * True when the node serves historical state at the probe's block. A
 * `state_unavailable` throw or empty code means it does not. A transient
 * failure is retried with exponential backoff up to `attempts`, then rethrown:
 * "could not reach the node" must never be reported as "node is pruned".
 */
export async function probeArchive(
  getCode: CodeReader,
  probe: { address: Address; block: number },
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      return hasCode(await getCode({ address: probe.address, blockNumber: BigInt(probe.block) }));
    } catch (err) {
      if (classifyProbeError(err) === 'state_unavailable') return false;
      if (i >= attempts) throw err;
      await sleep(PROBE_BACKOFF_MS * 2 ** (i - 1));
    }
  }
}

/** Smallest block in [0, safeHead] that has code. Needs an archive node. */
export async function binarySearchDeployBlock(
  getCode: CodeReader,
  address: Address,
  safeHead: bigint,
): Promise<bigint> {
  if (!hasCode(await getCode({ address, blockNumber: safeHead }))) {
    throw new DeployBlockUnavailableError(
      `No contract code at ${address} at block ${safeHead}; cannot binary search for its deploy block.`,
    );
  }
  let lo = 0n;
  let hi = safeHead; // invariant: code exists at hi
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (hasCode(await getCode({ address, blockNumber: mid }))) hi = mid;
    else lo = mid + 1n;
  }
  return hi;
}

export type ExplorerResult = { ok: true; block: number } | { ok: false; reason: string };

const EXPLORER_URL = 'https://api.etherscan.io/v2/api';
const MAX_REASON_LENGTH = 200;

/**
 * Etherscan's free tier allows 5 calls/second and signals every failure,
 * including rate limiting, as HTTP 200. This bucket is deliberately separate
 * from any chain's RPC limiter: the limits are unrelated and sharing one lets
 * either starve the other. One bucket for the process, since the limit is per
 * API key, not per chain.
 */
let defaultExplorerLimiter: RateLimiter | undefined;
function explorerLimiter(): RateLimiter {
  defaultExplorerLimiter ??= createRateLimiter({ capacity: 5, refillPerSec: 5 });
  return defaultExplorerLimiter;
}

export async function fetchCreationBlockFromExplorer(a: {
  chainId: number;
  address: Address;
  apiKey: string;
  fetchFn?: typeof fetch;
  limit?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<ExplorerResult> {
  const fetchFn = a.fetchFn ?? fetch;
  const limit = a.limit ?? explorerLimiter();
  const tokens = deriveSecretTokens([a.apiKey]);
  // The request URL carries the key; every reason is scrubbed before it leaves.
  const fail = (reason: string): ExplorerResult => ({
    ok: false,
    reason: scrubSecrets(reason, tokens).slice(0, MAX_REASON_LENGTH),
  });

  const url = new URL(EXPLORER_URL);
  url.searchParams.set('chainid', String(a.chainId));
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'getcontractcreation');
  url.searchParams.set('contractaddresses', a.address);
  url.searchParams.set('apikey', a.apiKey);

  let body: unknown;
  try {
    const response = await limit(() => fetchFn(url.toString()));
    // response.ok is deliberately ignored: measured, failures are HTTP 200.
    body = await response.json();
  } catch (err) {
    return fail(`explorer request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (body === null || typeof body !== 'object') return fail('explorer returned a non-object body');
  const { status, message, result } = body as { status?: unknown; message?: unknown; result?: unknown };

  if (String(status) !== '1') {
    const detail =
      typeof result === 'string' ? result : typeof message === 'string' ? message : 'no reason given';
    return fail(`explorer refused: ${detail}`);
  }

  const first: unknown = Array.isArray(result) ? result[0] : undefined;
  const raw =
    first !== null && typeof first === 'object'
      ? (first as { blockNumber?: unknown }).blockNumber
      : undefined;
  const block = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (!Number.isInteger(block) || block < 0) return fail('explorer response has no usable blockNumber');
  return { ok: true, block };
}

export async function resolveDeployBlock(a: {
  getCode: CodeReader;
  chainId: number;
  address: Address;
  safeHead: bigint;
  archiveProbe: { address: Address; block: number };
  override?: number;
  etherscanApiKey?: string;
  fetchFn?: typeof fetch;
  explorerLimit?: <T>(fn: () => Promise<T>) => Promise<T>;
  onWarn?: (message: string) => void;
}): Promise<{ block: number; source: DeployBlockSource; validated: boolean }> {
  const warn = a.onWarn ?? (() => undefined);

  // 1. Override: an explicit human claim. An invalid one throws. Falling
  // through would silently start the index somewhere the operator did not ask.
  if (a.override !== undefined) {
    const outcome = await validateDeployBlock(a.getCode, a.address, BigInt(a.override));
    if (outcome === 'invalid') {
      throw new DeployBlockUnavailableError(
        `--deploy-block ${a.override} was rejected: ${a.address} must have code at that block ` +
          `and none at the block before it. Check the override for a typo.`,
      );
    }
    return { block: a.override, source: 'override', validated: outcome === 'valid' };
  }

  // 2. Explorer: invalid warns and falls through, since it is not a human claim.
  if (a.etherscanApiKey) {
    const r = await fetchCreationBlockFromExplorer({
      chainId: a.chainId,
      address: a.address,
      apiKey: a.etherscanApiKey,
      ...(a.fetchFn ? { fetchFn: a.fetchFn } : {}),
      ...(a.explorerLimit ? { limit: a.explorerLimit } : {}),
    });
    if (!r.ok) {
      warn(`explorer could not resolve the deploy block: ${r.reason}`);
    } else {
      const outcome = await validateDeployBlock(a.getCode, a.address, BigInt(r.block));
      if (outcome !== 'invalid') {
        return { block: r.block, source: 'explorer', validated: outcome === 'valid' };
      }
      warn(`explorer reported deploy block ${r.block} but it failed on-chain validation; ignoring it`);
    }
  }

  // 3. Binary search, only on a node that serves historical state.
  if (!(await probeArchive(a.getCode, a.archiveProbe))) {
    throw new DeployBlockUnavailableError(
      `Cannot resolve the deploy block of ${a.address} on chain ${a.chainId}: the node does not serve ` +
        `historical state, so it cannot be searched for. Pass --deploy-block <n>, or set ` +
        `ETHERSCAN_API_KEY (a plan that covers this chain) so the explorer can supply it.`,
    );
  }
  const found = await binarySearchDeployBlock(a.getCode, a.address, a.safeHead);
  const outcome = await validateDeployBlock(a.getCode, a.address, found);
  if (outcome === 'invalid') {
    throw new DeployBlockUnavailableError(
      `Binary search for ${a.address} on chain ${a.chainId} found block ${found}, which failed on-chain ` +
        `validation (the node answered inconsistently). Pass --deploy-block <n> to set it explicitly.`,
    );
  }
  return { block: Number(found), source: 'binary_search', validated: outcome === 'valid' };
}
