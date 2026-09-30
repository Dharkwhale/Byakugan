# Deploying the fixture contracts to Base Sepolia

Verified end to end on a local anvil before being written down: every call below
was executed in this order, all ten succeeded, and the decoded output matched what
is stated under "What this should produce". Nothing here is predicted.

**You need one funded wallet, not two.** Wallet **B** only ever *receives* — it never
sends a transaction and needs no ETH. Everything is sent from wallet **A**.

| | |
|---|---|
| Network | Base Sepolia, chain id **84532** |
| Compiler | **0.8.24** |
| Optimizer | enabled, **200** runs — optional, see note |
| Constructor args | **none**, for both contracts |
| Funded wallets | **one** (A). B is any second address you control. |
| ETH needed | a few cents of faucet ETH, plus 0.0001 ETH for one payable call |

The optimizer setting only matters if you want the deployed bytecode to match
`forge build` locally. Behaviour is identical either way, so if Remix defaults differ,
leave it — nothing in the tests depends on bytecode identity. Leave the EVM version at
the compiler default (shanghai for 0.8.24); Base Sepolia accepts it.

## 1. Deploy

1. Open <https://remix.ethereum.org>.
2. Create two files under `contracts/` and paste in the sources:
   - `FixtureERC721.sol`
   - `FixtureERC1155.sol`
3. **Solidity compiler** tab: set *Compiler* to `0.8.24`. Optionally tick *Enable
   optimization* and set runs to `200`. Compile both files.
4. **Deploy & run transactions** tab: set *Environment* to `Injected Provider -
   MetaMask`, with MetaMask on **Base Sepolia**. Confirm the account shown is wallet A.
5. Select contract `FixtureERC721` in the dropdown → **Deploy**. No arguments.
6. Select contract `FixtureERC1155` → **Deploy**. No arguments.

Order does not matter — the two are independent — but deploy 721 first so the
recorded blocks read in the same order as everything below.

## 2. Call sequence — ERC-721

All five from wallet A, in this order. Token ids are assigned by the contract
(`nextTokenId` starts at 1), so they come out as stated provided the order holds.

| # | call | Remix input | value |
|---|---|---|---|
| 1 | `mint` | `to`: **A** | — |
| 2 | `mintManyTo` | `recipients`: `["A","B","A"]` | — |
| 3 | `transferFrom` | `from`: **A**, `to`: **B**, `tokenId`: `1` | — |
| 4 | `buy` | `tokenId`: `3` | **0.0001 ETH** |
| 5 | `burn` | `tokenId`: `4` | — |

Notes that matter:

- **Step 2** is the important one: three mints in **one transaction**, and the middle
  one goes to **B** while `tx.from` is **A**. That is the acting-wallet-differs-from-
  recipient case `firstMinters` reports, and it cannot be got from three separate
  mints.
- **Step 4 must have value attached** or it reverts (`require(msg.value > 0)`). In
  Remix, set the *Value* field to `0.0001` and the unit dropdown to `Ether` before
  clicking `buy`. This is the only call that needs value, and it is the only way to
  produce a `buy` row: the rule is `tx.value > 0 && tx.from == to`, so it needs a
  payable call whose sender is the recipient. Token 3 is owned by B at that point, and
  A is buying it — `buy` reverts if you are already the owner.
- Put `["A","B","A"]` in with the real addresses, double-quoted, including the square
  brackets. Remix wants JSON for array arguments.

## 3. Call sequence — ERC-1155

All five from wallet A, in this order.

| # | call | Remix input | value |
|---|---|---|---|
| 1 | `mint` | `to`: **A**, `id`: `1`, `amount`: `1` | — |
| 2 | `mintBatch` | `to`: **A**, `ids`: `[7,7,9]`, `amounts`: `[1,2,3]` | — |
| 3 | `mintEmptyBatch` | `to`: **A** | — |
| 4 | `transferFrom` | `from`: **A**, `to`: **B**, `id`: `7`, `amount`: `2` | — |
| 5 | `burn` | `id`: `9`, `amount`: `1` | — |

- **Step 2 is the whole reason this contract exists.** `[7,7,9]` repeats an id and the
  amounts differ, so the three rows it decodes to are distinguishable *only* by
  `batch_index` — the collision the original primary key could not hold, which
  silently undercounted batch mints.
- **Step 3** emits a valid `TransferBatch` carrying zero movements. It must decode to
  zero rows rather than throwing.
- Arrays go in as `[7,7,9]` — brackets, no quotes, since they are numbers.

## What this should produce

Confirmed on anvil. If your run differs, something above was done out of order.

**ERC-721 — 7 logs, 7 decoded rows.** Token ids in log order:
`1, 2, 3, 4` (the four mints), then `1` (transfer), `3` (buy), `4` (burn).
Every `batch_index` is 0. Kinds: **4 mint, 1 transfer, 1 buy, 1 burn.**

`firstMinters` should return **one** row, because every mint was sent by A: minter
**A**, 4 minted, **2** distinct recipients, `mintedToOthers` **true**.
`firstRecipients` should return **two** rows: A (received 3) then B (received 1).

**ERC-1155 — 5 logs, 6 decoded rows.** The extra row is the batch. Token ids in log
order: `1, 7, 7, 9, 7, 9`. Batch indexes in log order: `0, 0, 1, 2, 0, 0` — the `0,1,2`
run is `mintBatch`. Kinds: **4 mint, 1 transfer, 1 burn.** The empty batch contributes
nothing, which is why 5 logs give 6 rows and not 7.

## Optional: a second minter

Everything above has a single minter, so `firstMinters` returns one row. To get two,
fund wallet B and have **B** call `mint(B)` on the 721 *after* step 2 but *before*
step 3. `firstMinters` then returns A first, then B (1 minted, 1 recipient,
`mintedToOthers` false). Skip it if funding a second wallet is a nuisance — nothing
else depends on it, and the anvil fixture already covers multi-minter ordering with 20
of them.

## What to send back

Plain data is fine:

- both contract addresses
- the block number each was deployed in
- the transaction hash of `mintManyTo` (721 step 2) and of `mintBatch` (1155 step 2)
- wallet A's address, and wallet B's
- if you did the optional step, B's `mint` transaction hash

Expectations for the integration test get written from **this document**, not read back
off the chain. A hand-authored `TransferBatch` fixture here once had two extra hex
characters that shifted its values to `[0, <huge>]`; it was caught only because the
expected values had been written down independently first.
