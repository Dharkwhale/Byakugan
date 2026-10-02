import { type Address as ViemAddress } from 'viem';
import { getChainClient } from './client.js';
import { resolveDeployBlock } from './deployBlock.js';
import { makeSupportsInterface } from './standard.js';
import { makeTxSource } from './tx.js';
import { makeAssetTransfersFetcher } from './assetTransfersRpc.js';
import { CU_COSTS } from './cuCosts.js';
import type { Config } from '../config.js';
import {
  makeAssetTransfersSource, makeLogsSource, supportsAssetTransfers, withFallback,
  type FallbackNotice,
} from '../indexer/transferSource.js';
import type { LogFetcher } from '../indexer/logs.js';
import type { BackfillPorts } from '../indexer/backfill.js';
import type { Address, Hash } from '../types.js';

/** Which source a built set of ports will use. The type admits no other label. */
export type FetchPathName = 'getAssetTransfers' | 'getLogs';

/**
 * Builds the backfill's ports, once, for either front end.
 *
 * Extracted from the CLI rather than copied into the bot. The capability probe in
 * particular must happen in exactly one place: when it lived only in the CLI's dry-run
 * path, every real run silently used `eth_getLogs` and finished correctly in seventy
 * chunks where one page would have done. Nothing in the output said so, and only running
 * it found the defect.
 *
 * `fetchPath` is derived from the SAME `support` value `makeTransferSource` branches on, so
 * the label and the behaviour cannot disagree. Callers must take the label, the estimate and
 * the run from ONE build of this; a second build is a second probe, which can answer
 * differently.
 */
export async function makeBackfillPorts(a: {
  config: Config;
  chainId: number;
  contract: Address;
  fetchPath: 'auto' | 'logs';
  deployBlockOverride?: number;
  onWarn?(message: string): void;
  onFallback?(notice: FallbackNotice): void;
}): Promise<{
  ports: BackfillPorts;
  fetchLogs: LogFetcher;
  fetchPath: FetchPathName;
  /** Why the cheap path is not in use; absent when it is. */
  fetchPathReason?: string;
  safeHead: bigint;
}> {
  const chain = a.config.chains.get(a.chainId);
  if (!chain) throw new Error(`chain ${a.chainId} is not configured`);
  const { client, limit } = getChainClient(a.chainId, a.config);
  const chainClient = { chainId: a.chainId, client, limit };

  const fetchLogs: LogFetcher = async ({ fromBlock, toBlock }) => {
    const logs = await limit(() => client.getLogs({
      address: a.contract as ViemAddress, fromBlock, toBlock,
    }), CU_COSTS.eth_getLogs);
    return logs.map((l) => ({
      topics: l.topics as Hash[], data: l.data as Hash,
      transactionHash: l.transactionHash as Hash,
      blockNumber: l.blockNumber!, logIndex: l.logIndex!,
    }));
  };

  const safeHeadOf = async (): Promise<bigint> => {
    const head = await limit(() => client.getBlockNumber(), CU_COSTS.eth_blockNumber);
    const confirmed = head - BigInt(chain.confirmations);
    // Never index to head. A collection younger than the confirmations depth has
    // nothing safe to index yet, which is a real state rather than an error.
    return confirmed < 0n ? 0n : confirmed;
  };
  const safeHead = await safeHeadOf();

  // Whether this endpoint serves `getAssetTransfers`, decided ONCE. It is a property of the
  // endpoint, not of the range: a non-Alchemy RPC fails every time, so probing per chunk
  // would turn one upfront failure into thousands. The probe's standard is irrelevant.
  const probeFetcher = makeAssetTransfersFetcher({
    rpcUrl: chain.rpcUrl, limit, contract: a.contract, standard: '721',
  });
  const support = a.fetchPath === 'logs'
    ? { supported: false, reason: 'forced by --fetch-path logs' }
    : await supportsAssetTransfers(probeFetcher, safeHead);

  const supports = makeSupportsInterface(client, a.contract);
  const getCode = async (c: { address: Address; blockNumber: bigint }): Promise<string> =>
    (await limit(() => client.getBytecode({
      address: c.address as ViemAddress, blockNumber: c.blockNumber,
    }), CU_COSTS.eth_getCode)) ?? '0x';

  const ports: BackfillPorts = {
    makeTransferSource: (standard) => {
      const logsSource = makeLogsSource({
        fetchLogs, standard, initialChunk: chain.initialChunk, maxChunk: chain.maxChunk,
      });
      if (!support.supported) return logsSource;
      return withFallback({
        primary: makeAssetTransfersSource({
          standard,
          fetch: makeAssetTransfersFetcher({
            rpcUrl: chain.rpcUrl, limit, contract: a.contract, standard,
          }),
        }),
        secondary: logsSource,
        ...(a.onFallback ? { onFallback: a.onFallback } : {}),
      });
    },
    txSource: makeTxSource(chainClient),
    supports,
    resolveDeployBlock: async ({ safeHead: head }) => resolveDeployBlock({
      getCode, chainId: a.chainId, address: a.contract, safeHead: head,
      archiveProbe: chain.archiveProbe,
      ...(a.deployBlockOverride === undefined ? {} : { override: a.deployBlockOverride }),
      ...(a.config.etherscanApiKey === undefined
        ? {} : { etherscanApiKey: a.config.etherscanApiKey }),
      explorerLimit: limit,
      ...(a.onWarn ? { onWarn: a.onWarn } : {}),
    }),
    safeHead: safeHeadOf,
  };

  return {
    ports, fetchLogs, safeHead,
    fetchPath: support.supported ? 'getAssetTransfers' : 'getLogs',
    ...(support.supported ? {} : { fetchPathReason: support.reason ?? 'getAssetTransfers unavailable' }),
  };
}
