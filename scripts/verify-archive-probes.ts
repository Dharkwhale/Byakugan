/** Confirms each chains.json archiveProbe really has code at its block. */
// MUST be the first import: installs output-boundary secret scrubbing before
// anything can print. See CLAUDE.md, "No secret ever reaches output".
import './_scrub-output.js';
import { createPublicClient, http } from 'viem';
import { loadConfig } from '../src/config.js';
import { classifyProbeError } from '../src/chain/probeErrors.js';
import { deriveSecretTokens, scrubSecrets } from '../src/secrets.js';

const config = loadConfig();

/**
 * viem embeds the request URL — which carries the API key — in transport error
 * messages, so nothing from an error (or any config-derived string) reaches
 * stdout unscrubbed.
 */
const tokens = deriveSecretTokens(config.secrets);

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

const results: { chainId: number; name: string; verdict: Verdict }[] = [];

for (const [chainId, chain] of config.chains) {
  const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: 30_000 }) });
  const { address, block } = chain.archiveProbe;
  let verdict: Verdict;
  let detail = '';

  try {
    const code = await client.getCode({ address, blockNumber: BigInt(block) });
    const ok = Boolean(code) && code !== '0x';
    verdict = ok ? 'PASS' : 'FAIL';
    if (!ok) detail = 'empty code returned';
  } catch (err) {
    const outcome = classifyProbeError(err);
    verdict = outcome === 'state_unavailable' ? 'FAIL' : 'INCONCLUSIVE';
    // Message only, not the shared scrubUnknown's stack-preferring form: this
    // is a human-facing gate, and a full stack trace on every probe failure
    // would flood the console.
    detail = scrubSecrets(err instanceof Error ? err.message : String(err), tokens);
  }

  results.push({ chainId, name: chain.name, verdict });
  process.stdout.write(
    `${verdict}  chain ${chainId} (${chain.name})  ${address} @ ${block}` +
      (detail ? `  ${detail}` : '') +
      '\n',
  );
}

const failed = results.filter((r) => r.verdict === 'FAIL');
const inconclusive = results.filter((r) => r.verdict === 'INCONCLUSIVE');
const passed = results.filter((r) => r.verdict === 'PASS');

process.stdout.write(
  `\nSummary: ${passed.length} PASS, ${failed.length} FAIL, ${inconclusive.length} INCONCLUSIVE\n`,
);
if (passed.length > 0) {
  process.stdout.write(`  PASS: ${passed.map((r) => `${r.chainId} (${r.name})`).join(', ')}\n`);
}
if (failed.length > 0) {
  process.stdout.write(`  FAIL: ${failed.map((r) => `${r.chainId} (${r.name})`).join(', ')}\n`);
}
if (inconclusive.length > 0) {
  process.stdout.write(
    `  INCONCLUSIVE (retry needed): ${inconclusive
      .map((r) => `${r.chainId} (${r.name})`)
      .join(', ')}\n`,
  );
}

process.exitCode = failed.length > 0 || inconclusive.length > 0 ? 1 : 0;
