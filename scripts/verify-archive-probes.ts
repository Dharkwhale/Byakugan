/** Confirms each chains.json archiveProbe really has code at its block. */
import { createPublicClient, http } from 'viem';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
let failures = 0;

for (const [chainId, chain] of config.chains) {
  const client = createPublicClient({ transport: http(chain.rpcUrl) });
  const { address, block } = chain.archiveProbe;
  try {
    const code = await client.getCode({ address, blockNumber: BigInt(block) });
    const ok = Boolean(code) && code !== '0x';
    process.stdout.write(
      `${ok ? 'PASS' : 'FAIL'}  chain ${chainId} (${chain.name})  ${address} @ ${block}\n`,
    );
    if (!ok) failures += 1;
  } catch (err) {
    process.stdout.write(
      `FAIL  chain ${chainId} (${chain.name})  ${address} @ ${block}  ` +
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    failures += 1;
  }
}

process.exitCode = failures > 0 ? 1 : 0;
