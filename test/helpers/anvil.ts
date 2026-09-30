/**
 * A local anvil chain for deterministic fixtures.
 *
 * WHY ANVIL AND NOT A TESTNET. The fetch-strategy break-even turns on
 * transactions per block, and the expensive half of that — many SEPARATE wallets
 * landing in one block — cannot be caused by any contract. It is a property of how
 * transactions get bundled. On a public testnet one wallet submitting quickly gets
 * close by luck and is not reproducible; with `--no-mining` the density is exact by
 * construction: send N transactions, mine one block, get N transactions in 1 block.
 *
 * NO PRIVATE KEY LIVES HERE, and none is needed. anvil's accounts are unlocked, so
 * `eth_sendTransaction` is signed by the local node. This repo stays free of keys,
 * per the hard scope bar, and nothing here signs anything.
 *
 * Every helper talks raw JSON-RPC rather than going through viem's wallet client:
 * the scope bar forbids building a wallet client at all, and a fixture has no
 * business being the exception.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, type Abi, type Address, type Hash } from 'viem';

/** Foundry version this fixture is pinned to. See test/fixtures/contracts/README.md. */
export const PINNED_FOUNDRY_VERSION = '1.5.1-stable';

/**
 * Whether anvil can be run at all.
 *
 * Returns a reason rather than a bare boolean so a skipped suite can say WHY it
 * skipped. A silent skip is close to a deleted test: it stops being noticed.
 */
export function anvilAvailability(): { ok: true; version: string } | { ok: false; reason: string } {
  for (const tool of ['anvil', 'forge'] as const) {
    try {
      execFileSync(tool, ['--version'], { stdio: 'pipe', timeout: 20_000 });
    } catch {
      return {
        ok: false,
        reason:
          `${tool} was not found on PATH. These fixtures need Foundry ` +
          `(pinned ${PINNED_FOUNDRY_VERSION}); install it with ` +
          "'curl -L https://foundry.paradigm.xyz | bash' then 'foundryup'. " +
          'Skipping rather than failing: the rest of the suite does not need a chain.',
      };
    }
  }
  const version = execFileSync('anvil', ['--version'], { encoding: 'utf8', timeout: 20_000 })
    .split('\n')[0]
    ?.trim() ?? 'unknown';
  return { ok: true, version };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export interface AnvilChain {
  url: string;
  accounts: Address[];
  rpc(method: string, params?: unknown[]): Promise<unknown>;
  /** Mines exactly one block, sweeping in every pending transaction. */
  mine(): Promise<void>;
  /** Sends a transaction WITHOUT mining it, so several can share one block. */
  send(tx: { from: Address; to?: Address; data?: string; value?: bigint }): Promise<Hash>;
  stop(): void;
}

/**
 * Starts anvil with mining OFF and returns a handle.
 *
 * `--no-mining` is the whole point: with automining, each transaction gets its own
 * block and the clustered extreme is unreachable. Transactions queue until `mine()`
 * is called, so block composition is chosen rather than observed.
 */
export async function startAnvil(a: { accounts: number }): Promise<AnvilChain> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    'anvil',
    [
      '--port', String(port),
      '--accounts', String(a.accounts),
      '--no-mining',
      '--silent',
      // A fixed mnemonic and chain id keep addresses identical between runs, so a
      // failure is reproducible rather than a different set of accounts each time.
      // This is anvil's own published default test mnemonic, not a secret: it holds
      // nothing but ephemeral local funds and exists in anvil's help text.
      '--mnemonic', 'test test test test test test test test test test test junk',
      '--chain-id', '31337',
    ],
    { stdio: 'ignore' },
  );

  const url = `http://127.0.0.1:${port}`;
  let nextId = 1;
  const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: nextId++, jsonrpc: '2.0', method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };

  const stop = (): void => { child.kill(); };

  // Poll until it answers rather than sleeping a guessed interval.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await rpc('eth_chainId');
      break;
    } catch (err) {
      if (Date.now() > deadline) {
        stop();
        throw new Error(`anvil did not become ready within 30s: ${String(err)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const accounts = (await rpc('eth_accounts')) as Address[];

  return {
    url,
    accounts,
    rpc,
    async mine() { await rpc('evm_mine'); },
    async send(tx) {
      const params: Record<string, string> = { from: tx.from };
      if (tx.to !== undefined) params.to = tx.to;
      if (tx.data !== undefined) params.data = tx.data;
      if (tx.value !== undefined) params.value = `0x${tx.value.toString(16)}`;
      return (await rpc('eth_sendTransaction', [params])) as Hash;
    },
    stop,
  };
}

/**
 * Compiled fixture, read from the forge artifact.
 *
 * Throws a directive rather than a file-not-found if `forge build` has not run —
 * the missing step is the actual problem and the path is not the useful part.
 */
export function readArtifact(name: string): { abi: Abi; bytecode: `0x${string}` } {
  const file = fileURLToPath(
    new URL(`../fixtures/artifacts/${name}.sol/${name}.json`, import.meta.url),
  );
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `No compiled artifact for ${name}. Run 'npm run build:fixtures' (forge build) ` +
      'first; artifacts are gitignored because they are reproducible from the pinned ' +
      'solc version in foundry.toml.',
    );
  }
  const artifact = JSON.parse(raw) as { abi: Abi; bytecode: { object: `0x${string}` } };
  return { abi: artifact.abi, bytecode: artifact.bytecode.object };
}

/** Deploys a compiled fixture and mines it in. */
export async function deploy(
  chain: AnvilChain,
  a: { from: Address; bytecode: `0x${string}` },
): Promise<Address> {
  const hash = await chain.send({ from: a.from, data: a.bytecode });
  await chain.mine();
  const receipt = (await chain.rpc('eth_getTransactionReceipt', [hash])) as
    | { contractAddress: Address | null; status: string }
    | null;
  if (!receipt) throw new Error('deploy produced no receipt');
  if (receipt.status !== '0x1') throw new Error(`deploy reverted (status ${receipt.status})`);
  if (!receipt.contractAddress) throw new Error('deploy receipt carried no contract address');
  return receipt.contractAddress;
}

/** ABI-encodes a call. Thin wrapper so tests read as calls, not as hex. */
export function call(abi: Abi, functionName: string, args: unknown[]): `0x${string}` {
  return encodeFunctionData({ abi, functionName, args });
}
