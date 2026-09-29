import { BaseError, HttpRequestError, parseAbi, TimeoutError, type PublicClient } from 'viem';
import { UnsupportedStandardError } from '../errors.js';
import type { Address, Standard } from '../types.js';

export const INTERFACE_IDS = {
  erc721: '0x80ac58cd',
  erc1155: '0xd9b67a26',
  /** totalSupply() lives here, not in base ERC-721. */
  erc721Enumerable: '0x780e9d63',
  /** ERC-165 requires this to be answered `false`. */
  invalid: '0xffffffff',
} as const;

const ERC165_ABI = parseAbi([
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
]);

export interface SupportsInterface {
  (interfaceId: `0x${string}`): Promise<boolean>;
}

export function makeSupportsInterface(
  client: PublicClient,
  address: Address,
): SupportsInterface {
  return async (interfaceId) =>
    Boolean(await client.readContract({
      address, abi: ERC165_ABI, functionName: 'supportsInterface', args: [interfaceId],
    }));
}

/**
 * True when the call failed because the CONTRACT could not answer — it has no
 * such function, or it reverted — rather than because we could not reach the
 * chain.
 *
 * The distinction matters: swallowing everything means an RPC outage reports
 * "this contract supports neither ERC-721 nor ERC-1155", which is confident,
 * wrong, and sends the user to inspect their contract instead of their
 * connection. Measured shapes:
 *
 *   contract has no supportsInterface -> TransactionRejectedRpcError < RpcRequestError
 *   RPC returns HTTP 500              -> HttpRequestError
 */
export function isExecutionFailure(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const transport = err.walk(
    (e) => e instanceof HttpRequestError || e instanceof TimeoutError,
  );
  return transport === null;
}

/** Swallows a contract-level failure as "no", rethrows anything else. */
async function safeSupports(
  supports: SupportsInterface,
  interfaceId: `0x${string}`,
): Promise<boolean> {
  try {
    return await supports(interfaceId);
  } catch (err) {
    if (isExecutionFailure(err)) return false;
    throw err;
  }
}

export async function detectStandard(
  supports: SupportsInterface,
  address: Address,
): Promise<Standard> {
  // ERC-165 conformance first. A contract that answers `true` to 0xffffffff is
  // not answering questions, it is saying yes to everything — so no positive
  // answer it gives can be trusted, including a positive ERC-721 answer. This
  // is checked BEFORE the standard ids for exactly that reason.
  if (await safeSupports(supports, INTERFACE_IDS.invalid)) {
    throw new UnsupportedStandardError(
      `${address} claims to support the invalid interface id 0xffffffff, which ERC-165 ` +
      'requires to be false. Its answers cannot be trusted; refusing to guess a standard. ' +
      'Pass --standard to override.',
    );
  }

  const [is721, is1155] = await Promise.all([
    safeSupports(supports, INTERFACE_IDS.erc721),
    safeSupports(supports, INTERFACE_IDS.erc1155),
  ]);

  if (is721 && is1155) {
    throw new UnsupportedStandardError(
      `${address} claims both ERC-721 and ERC-1155; refusing to guess, because decoding ` +
      'with the wrong standard would silently mis-index the whole collection. ' +
      'Pass --standard to override.',
    );
  }
  if (is721) return '721';
  if (is1155) return '1155';

  throw new UnsupportedStandardError(
    `${address} supports neither ERC-721 (0x80ac58cd) nor ERC-1155 (0xd9b67a26). ` +
    'Pre-ERC-165 collections such as CryptoPunks need --standard.',
  );
}

/**
 * Whether the collection implements ERC-721 Enumerable, and therefore
 * `totalSupply()`. A transport failure rethrows rather than reading as "no", so
 * a caller cannot silently fall back to a weaker assertion because the network
 * blipped.
 */
export async function supportsEnumerable(supports: SupportsInterface): Promise<boolean> {
  return safeSupports(supports, INTERFACE_IDS.erc721Enumerable);
}
