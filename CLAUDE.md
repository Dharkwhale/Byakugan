# Byakugan

Telegram bot for tracking NFT minters and buyers across EVM collections.
Built in milestones; each must pass its tests and be confirmed by the owner
before the next begins.

The milestone spec and implementation plan live in `docs/superpowers/specs/`
and `docs/superpowers/plans/`. This file holds the standing rules.

## Scope bar (hard)

Current scope is Milestones 1–2: **read-only tracking**. Do not build
transaction signing, private keys, wallets holding funds, minting, listing,
buying, selling, copy trading, or marketplace adapters.

**No private key may exist anywhere in this repo or its config.** A test
asserts the config schema contains no private-key field.

## Stack

TypeScript (`strict: true`, ESM, NodeNext), Node 20+. viem (public client
only), grammY, better-sqlite3, zod, pino, vitest. Foundry `anvil` for fork
tests from Milestone 3.

## Testing rules

### Mutation verification is mandatory for property tests

**Any test claiming to pin a concurrency, security, idempotency, or
transactional-atomicity property is not done until it has been
mutation-verified.** Write the plausible wrong
implementation, run the test against it, and report both results. A test that
passes against the bug it names is worse than no test: it advertises a
guarantee that does not exist.

This rule exists because four vacuous tests passed review in this project,
some of them twice. Every one was accepted by reading the assertion and the
comment instead of asking whether the test could fail:

- ERC-1155 batch decoding — the documented primary key could not hold more
  than one token per batch log, so batch mints would have been silently
  undercounted.
- Secret scrubbing shape tests — a nested `cause` pino never serialised would
  have produced output with no secret in it and no scrubbing whatsoever.
- The hostile-Unicode property test — its `>= 4` prefix threshold made it
  blind to the `İ` index-skew leak it was written for: 0 detections out of
  300 against the buggy code, 266 out of 500 after the threshold was fixed.
- The stale-lock racing test — passed identically against a check-then-claim
  implementation, because a single-process synchronous driver cannot produce
  the interleaving that breaks it.

**Still at risk:** Task 13's interrupt-and-resume test. If every log fixture
lands inside the first chunk, the injected fault fires after everything is
already committed and the test asserts resumption while proving none. Spread
the fixtures across chunk boundaries and verify the partial state is genuinely
partial.

When a test cannot be made to fail against the mutant, say so and record the
gap. An honest "argued, not tested" comment beats a contrived pass.

### Assert behaviour, not configuration

Assert what a caller would notice. `PRAGMA foreign_keys` returning `1` proves
a pragma was set; an orphan insert being rejected proves the constraint is
enforced. Prefer the second. The same applies to schema text greps, presence
checks in `sqlite_master`, and any assertion on a named field where the whole
output is available.

### Time and concurrency in tests

Time comes from an injected `Clock` (epoch ms). Never `sleep` to test
staleness, and never use SQLite's `datetime()`/`unixepoch()` anywhere — two
clocks that can disagree is the bug.

For contention tests, state the journal mode the connections use and what the
test proves under it. Under WAL a reader does not block a writer, so a test
can pass for reasons unrelated to the property. Set an explicit
`busy_timeout` rather than relying on the default, and never leave the result
dependent on timing.

## Security bar

- Addresses are stored lowercase, enforced by `CHECK (col = lower(col))` at
  the database layer as well as at the boundary.
- RPC URLs carry API keys in their path. Nothing may write one unredacted to
  any output. Scrubbing happens at serialization, not by pino `redact` paths,
  which cannot reach a secret inside an error message, a stack trace, a
  nested `cause`, an array element, or an object key name.
- Do not wire a pino `transport`. It moves serialization to a worker thread
  and bypasses the stream scrub entirely.
- Never log or commit secrets. `.env` is never committed; `.env.example`
  carries placeholders only.

## Database rules

- `PRAGMA foreign_keys`, `journal_mode` and `busy_timeout` are set in the
  connection factory, never in a migration — SQLite defaults `foreign_keys`
  OFF on every new connection.
- Applied migrations are immutable. The runner stores a SHA-256 of each file;
  a changed or vanished migration is a hard failure. Add a new migration
  instead of editing an applied one.
- `token_id`, `amount` and `tx_value_wei` are TEXT (uint256 exceeds
  `Number.MAX_SAFE_INTEGER`) and therefore sort **lexicographically**. Any
  `ORDER BY` or range comparison on them must zero-pad or `CAST`.
- Inserts are idempotent via `ON CONFLICT (<pk cols>) DO NOTHING`, **not**
  `INSERT OR IGNORE`. Both absorb a duplicate-key replay, but `OR IGNORE`
  suppresses every constraint class: measured against this schema, a
  mixed-case address and an invalid `kind` both return 0 changes and are
  dropped silently, which leaves the `CHECK` constraints above unable to
  report anything. Targeting the primary key alone keeps the replay free and
  makes a malformed row loud. A foreign-key violation throws under both.
- Never index to head: stop at `head - confirmations[chainId]`.
- `transfers` cascades on a `collections` delete, so every `DELETE FROM
  collections` must be scoped — an unguarded one destroys transfer history.

## Working rules

- Write tests alongside the code. `npm test` and `npm run typecheck` must
  pass before a milestone is called done.
- Stop at the end of each milestone, summarise what was built, the test
  results, and known limitations. Wait for confirmation.
- RPC calls retry with exponential backoff and a capped attempt count. No
  unbounded loops.
- Report outcomes honestly: failing tests, skipped steps and unverified
  claims get said out loud. A test's own comment is not evidence that it
  works.
- Never `git push` without asking first.
