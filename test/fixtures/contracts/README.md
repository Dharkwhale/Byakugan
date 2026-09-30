# Deterministic fixture contracts

Two minimal contracts that emit exactly the logs the indexer decodes, in shapes
chosen rather than found. They replace hunting for a real collection whose history
happens to contain an interesting case.

`FixtureERC721.sol` · `FixtureERC1155.sol` — self-contained, no imports, one file
each.

## Who deploys these

**The owner, not Claude.** The hard scope bar in `CLAUDE.md` is that no private key
exists anywhere in this repo or its config, and a test asserts the config schema has
no private-key field. Deploying needs a funded key, so deployment happens outside
this repo entirely — Remix, Foundry with a key held elsewhere, whatever is
convenient. Base Sepolia (chain `84532`) is already configured, and faucet ETH is
free.

What to report back, so the integration test can be written against fixed values:

- both contract addresses, and the block each was deployed in
- the `TransferBatch` transaction hash
- the mint order, if it is not simply the call order below

## Recommended calls

Ordinary ERC-721 history, one call each, covering all four classifier branches:

| call | produces | `kind` |
|---|---|---|
| `mint(owner)` | `Transfer(0x0 → owner)` | `mint` |
| `mintManyTo([a, b, c, a])` | four mints, ONE transaction, `a` twice | `mint` |
| `transferFrom(owner, b, 1)` | unpaid movement | `transfer` |
| `buy(2)` from another wallet, with value | paid, and `tx.from == to` | `buy` |
| `burn(3)` | `Transfer(… → 0x0)` | `burn` |

`buy` is the branch that is otherwise only ever tested against mocks: the rule is
`tx.value > 0 && tx.from == to`, so it needs a payable call whose caller is the
recipient. `mintManyTo` with a repeated address is deliberate — it makes a wallet
appear as several recipients but one acting wallet, which is what `firstMinters`
groups by and `firstRecipients` does not.

ERC-1155, where the batch is the point:

| call | produces |
|---|---|
| `mint(owner, 1, 1)` | `TransferSingle` |
| `mintBatch(owner, [7, 7, 9], [1, 2, 3])` | ONE `TransferBatch`, THREE rows, `batch_index` 0/1/2 |
| `mintEmptyBatch(owner)` | a valid `TransferBatch` carrying zero movements |

`[7, 7, 9]` repeats an id on purpose. With amounts `[1, 2, 3]` the three rows differ
only by `batch_index`, which is exactly the collision the original primary key could
not hold — batch mints were silently undercounted until `batch_index` was added.
`mintEmptyBatch` must decode to zero rows rather than throwing.

Expectations for these get written from the **spec**, not read off whatever the chain
returns. A hand-authored `TransferBatch` fixture in this project once had two extra
hex characters that shifted its values to `[0n, <huge>]`; it was caught only because
the expected values had been written independently. The same discipline applies to a
real deployment: decide what `mintBatch(owner, [7,7,9], [1,2,3])` *should* produce,
then check the chain agrees.

## Density, and what a testnet cannot give you

The threshold that picks per-transaction against whole-block enrichment turns on
**transactions per block** (see `src/chain/fetchStrategy.ts`). These contracts cover
one extreme and cannot cover the other:

- **Sparse, and cheap per transfer** — `mintManyTo([...200 addresses])` is 200 mints
  in ONE transaction. Worth being clear about, because it inverts an intuition: a bot
  airdropping to 200 wallets is the *cheapest* case for enrichment, 200 transfers
  needing a single fetch. It is 1.0 transactions per block.
- **Clustered, and expensive** — 200 separate wallets each sending their own mint
  transaction into the same block. This is the case block-fetch exists for, and **no
  contract can cause it.** It is a property of how transactions get bundled, not of
  what they call. Submitting many transactions quickly from one wallet gets close by
  luck and is not reproducible.

So the clustered extreme is produced locally, in
[`test/integration/density.anvil.test.ts`](../../integration/density.anvil.test.ts),
with `anvil --no-mining`: send N transactions, mine one block, and the density is
exact by construction. No funded key is needed — anvil's accounts are unlocked, so
the local node signs and nothing is stored here — and it costs no compute units.

`CLAUDE.md` scheduled anvil from Milestone 3, but that note is about fork tests for
live tracking. This is a different use, it is test infrastructure rather than a
milestone feature, and 200 wallets in one block is exactly what it is for.

The resulting default is therefore derived from a **synthetic upper bound**, not from
an observed drop — a deliberate choice, so the constant does not encode whatever
collection happened to be minting the week it was measured. The break-even itself
(`perBlock / perTx`) is provider pricing and still needs the dashboard CU deltas; the
fixture settles the densities the rule must sit between, not the price.

## Toolchain, pinned

| tool | version | why pinned |
|---|---|---|
| Foundry (`anvil`, `forge`) | **1.5.1-stable** | `anvil --no-mining` semantics and the account set are what the density fixture's exactness rests on |
| `solc` | **0.8.24** | set in `foundry.toml`, so the fixture bytecode is reproducible across machines rather than drifting with whatever compiler is installed |

```
curl -L https://foundry.paradigm.xyz | bash && foundryup --version 1.5.1
npm run build:fixtures     # forge build, into the gitignored test/fixtures/artifacts/
npm test
```

Artifacts are gitignored on purpose: with `solc` pinned they are reproducible, and
committed bytecode is opaque to review in a way source is not.

**Without Foundry installed the anvil suite skips and says why** — it does not fail,
because nothing else in the suite needs a chain. Worth knowing how that message
survives: vitest *discards* `console.*` output from a file whose every test is
skipped, so the first version of it printed nothing at all and the skip was silent.
It writes to `process.stderr` directly instead, which does survive. A silent skip is
close to a deleted test.
