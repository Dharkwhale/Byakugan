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
only), grammY, better-sqlite3, zod, pino, vitest.

Foundry is test infrastructure, pinned to **1.5.1-stable** with `solc` **0.8.24**
in `foundry.toml`. Two distinct uses, and only the second waits for Milestone 3:

- **Now:** `anvil --no-mining` for the deterministic density fixture. The
  fetch-strategy break-even turns on transactions per block, and the expensive
  half of that — N separate wallets landing in ONE block — cannot be produced by
  any contract or by any public testnet; it is a property of transaction
  bundling. Queue N transactions, mine one block, and the density is exact.
  No key is involved: anvil's accounts are unlocked, so the local node signs.
- **From Milestone 3:** fork tests for live tracking.

The anvil suite skips with a printed reason when Foundry is absent, since nothing
else needs a chain. Note that vitest DISCARDS `console.*` from a file whose every
test is skipped — write skip notices to `process.stderr` directly, or the skip is
silent, which is close to a deleted test.

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

**Recorded gap (argued, not tested):** the `AND tx_from IS NULL` on
`applyEnrichment`'s UPDATE. Mutation-tested; the mutant survived with 88 passed,
0 failed, because the SELECT already excludes enriched rows. Kept as defence in
depth. The interleaving that would distinguish it needs two processes writing
after both have read, which a synchronous driver inside one transaction cannot
produce — the same limitation as the stale-lock racing test above.

### Never let missing data pick the cheaper answer

**When a value is unavailable, the code says so. It does not fall through to
whichever valid-looking answer needs no extra work.** A default that is
indistinguishable from a real result converts a missing fetch into a confident
wrong answer, and nothing downstream can tell.

This has now arrived twice through different doors, which is what makes it a
rule rather than an incident:

- `classify` receiving a raw DB row: `tx.value` as a string, `undefined` or `''`
  all compare false against `0n` without throwing, so a genuine buy read as
  unpaid and became `transfer`. Fixed by a `typeof` guard that throws.
- `mints_only` enrichment: an unenriched non-mint stored as `kind = 'transfer'`
  is indistinguishable from a real transfer, so every buy in the range is lost
  and `overlap` — which scores wallets on [mint, buy] — returns zero for a
  wallet that bought seven of fifteen collections. Fixed by `'unclassified'`
  plus a table CHECK that makes `'buy'`/`'transfer'` unrepresentable without a
  transaction.

`transfer` was the trap both times because it is the residual branch: the answer
you reach by failing to look. Audit every residual `else`/default for whether it
can be reached by absent input rather than by decided input.

**And a corollary, learned by getting it wrong immediately afterwards: deciding
`kind` is not the only thing a fetch is for.** Having established that `mint` is
`from == 0x0` and needs no transaction, the obvious optimisation was a level that
fetched nothing at all — correct about classification, and it quietly destroyed
the product. `tx_from` on a mint is the ACTING wallet, and one bot minting 200
tokens to 200 fresh addresses produces rows identical to 200 collectors once
`tx_from` is null. The index could still report every mint, so nothing looked
broken; it just could not answer the question the whole bot exists to answer.

Before cutting a fetch because the classifier does not need the data, check what
the QUERIES report out of it. The cheap level must stay useful, not merely
correct. Levels now run `logs_only` (fetches nothing, gated away from
`firstMinters`, never a default) → `mints_only` (mints enriched) → `full`.

Three things follow, and they are cheap:

1. Give "not looked at" its own representable state, distinct from every real
   answer. Then make the wrong combination impossible at the database layer, not
   merely discouraged in code.
2. **Derive a completeness claim from the data, never from a column recording an
   intent.** A column saying `full` beside unclassified rows waves the query
   through; counting the unclassified rows cannot drift, because there is
   nothing to drift from. It is also more precise in the honest direction — a
   `mints_only` collection whose every transfer was log-decidable really is
   complete, and deriving it permits that instead of demanding a pointless
   re-index.
3. A query that cannot be answered completely **throws, naming what is missing
   and how to fix it.** It does not return a partial result. An undercount is
   not a degraded answer; it is a wrong one wearing the shape of a right one.

When a test cannot be made to fail against the mutant, say so and record the
gap. An honest "argued, not tested" comment beats a contrived pass.

**Mutation work never edits the working tree in place.** Put the mutant on a
branch or a stash, so restoring is `git checkout`/`git stash pop` rather than a
manual copy that can be forgotten. This rule exists because a manual restore
was forgotten once and a scrubbing guard sat mutated in the working tree until
it was noticed. Same structural fix as scrubbing at the boundary: remove the
step that depends on remembering.

### Derive expectations from the spec, never from the fixture

When a fixture is hand-authored — ABI-encoded log data, a hex blob, a
pre-computed hash — write the assertions from what the code *should* produce,
not from what the fixture *does* produce. A hand-written `TransferBatch`
fixture in this project had two extra hex characters that shifted its values
array to `[0n, <huge>]` instead of `[1n, 2n]`. The test failed loudly and the
fixture got fixed. Had the expectations been read off the fixture instead,
every batch amount in the index would have been silently wrong with a green
suite.

Prefer generating adversarial or malformed fixtures programmatically
(`encodeAbiParameters`) over hand-computing offsets: the encoder is correct by
construction, and a malformed shape usually cannot be captured from a
compliant chain anyway.

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

### No secret ever reaches output. This is a hard rule, not a preference.

**No secret of the owner's may reach any output path: not stdout, not stderr,
not a log, not an error message, not a commit, not a report, not a scratch
script.** That covers throwaway probes, one-off debugging, and anything run in
a controller session — every path, without exception.

A script that touches a credentialed endpoint **does not run** until its output
is scrubbed at the boundary. If it is unclear whether a path is covered, it is
not covered: add the guard first.

Every file in `scripts/`, and every throwaway probe, imports
`scripts/_scrub-output.ts` as its **first** import. That module intercepts
`process.stdout.write` and `process.stderr.write` and installs
`uncaughtException`/`unhandledRejection` handlers, so no print site can be
forgotten and no thrown error can bypass it.

This rule exists because it was broken. A scratch probe hit HTTP 429, the
unhandled viem error printed its full dump including the request URL, and the
owner's Alchemy API key went into a conversation transcript in plain text and
had to be rotated. The probe *did* scrub — per call site, in the happy path
only. That is the same mistake Task 2 exists to prevent: redaction at each
print site gets forgotten, which is why the logger scrubs at serialization
instead. The lesson had been applied to the product and not to the tooling.

Rotating a key is the owner's work, not Claude's, so the cost of forgetting
lands on them. Add the guard first.

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
