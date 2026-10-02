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

**Resolved, and kept here as the worked example.** Task 13's interrupt-and-resume
test was flagged at risk: with every log fixture inside the first chunk, the
injected fault fires after everything is already committed, and the test asserts
resumption while proving none. What fixed it:

- Eight fixtures across FOUR chunks, with the fault landing in chunk 2.
- The row count asserted STRICTLY between zero and the total. Both bounds carry
  weight: zero means the fault preceded all work, the total means it followed all
  of it, and under either the test proves nothing about resuming.
- The watermark asserted on a chunk boundary below the target.
- A separate test guarding the FIXTURE LAYOUT, so a later edit collapsing the
  blocks into one chunk fails loudly instead of quietly hollowing out the rest.
- Mutation-verified: making the insert and the watermark non-atomic fails three
  tests.

The transferable part is the third and fourth points. Asserting the final state
after a resume proves nothing — the assertion has to be that the intermediate
state was genuinely intermediate, and something has to defend the fixture shape
that makes it so.

**Recorded gap (argued, not tested):** the `description` type check in
`asApiError` (src/telegram/failures.ts). Mutation-tested; the mutant survived with 14
passed, 0 failed, because every consumer tolerates a missing description through
regex coercion. Kept because that tolerance is accidental, and the declared type
would otherwise be a lie the next consumer could act on.

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

### A visibility feature is tested on what it DISPLAYS

**When a feature exists to make something visible, the test asserts the visible
output — not that the code path ran.** Correct code, correctly wired, displaying
nothing is the failure mode, and it passes any test that only checks the wiring.

This has now happened twice, a milestone apart, and both times the code was right:

- The dry-run capability probe was wired into the dry-run path only, so every real
  CLI run silently used `eth_getLogs`. The run completed, the rows were correct,
  and it took seventy chunks where one page would have done. Nothing in the output
  said which fetch path it used, so nothing could have noticed.
- The bot's progress line was planned to NAME the fetch path, and the plan passed
  `'pending'` to the job registry and `'indexing'` to the renderer. The line would
  have rendered, the test would have found a line, and the one thing it existed to
  show would have been absent.

Both are the same defect: a feature whose whole purpose is to surface information,
tested on its own existence. The questions that catch it are "what string does a
user see?" and "would this test fail if the value shown were wrong rather than
missing?" — assert the content, with a value that could only come from the real
source.

**And a third instance, which is why the note above became the rule below.**
`/status` replied "is not indexed — /index 0x…" for the whole of a live first
index. `getCollection` reads `not_indexed` until `standard` is set, and the
deploy-block search runs before that, so the longest part of a first run was
reported as nothing happening — and the reply told the user to start a second
job. Correct code, correctly wired, three times now, hiding the one thing it
existed to show. Three instances and no structural guard means the questions
above are not enough: they are asked of the states someone thought to test.

**So: a command or output whose purpose is visibility is tested in EVERY state
the underlying thing can occupy, and the list of states is enumerated from the
state machine — not from the states that seemed worth testing.** Write the
states down first, from the data model and the lifecycle, then write one test
per state. A state with no test is a state that ships unseen, and "that one
can't happen" is a claim to prove with a test, not an exemption.

For `/status` the enumeration is, at minimum:

- **absent** — nothing in `collections`, no lock, no job
- **claimed, not bootstrapped** — a row exists, `standard` still NULL
- **bootstrapping** — a job running in this process, still no `standard`
- **indexing** — a job running, `standard` set, watermark below target
- **complete** — no job, watermark at target
- **orphaned lock, live** — lock row, no map entry, `now <= expiresAt`
- **orphan expired** — lock row, no map entry, `now > expiresAt`

The two that had no test were the two that were broken. The enumeration is what
makes that visible before a user finds it, and it belongs in the plan's task,
not in the reviewer's head.

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

### A fixture that a fallback also handles cannot test the mechanism

**When the code under test has a fallback, a secondary pass, or any other path that
could produce the same output, a fixture satisfied by that path proves nothing about
the mechanism. Pick a fixture only the mechanism can handle — otherwise the test
passes against an implementation that is not wired up at all.**

The worked example. The bot scrubs outbound chat text using secret tokens derived
from `config.secrets`. Its first test used a URL-shaped fake secret — and the mutant
that derived tokens from `[]`, i.e. a completely unwired `secrets` list, SURVIVED.
`scrubSecrets` has fallback passes that redact URL-shaped keys with no tokens at all,
so the fallback did the redaction and the assertion could not tell the difference. A
plain string that no fallback pass can catch kills the mutant immediately.

This is the same shape as a gate reading `enrichment_level` instead of counting the
rows: two mechanisms that agree on the easy cases, and a fixture drawn from the
overlap tests neither. The questions that catch it:

- What else in this code path could produce the output I am asserting?
- If the mechanism I am testing were deleted entirely, would this fixture still pass?

So the fixture has to sit where only one path reaches: a secret with no URL shape, a
`mints_only` collection with zero unclassified rows, a `logs_only` collection with
zero mints. A fixture in the overlap is worth keeping as a second case, never as the
only one.

### Where a test depends on exact bytes, assert the bytes

**When a test's meaning rests on a precise byte sequence — a control character,
an RTL or bidi mark, a zero-width character, an encoded or escaped form, a
specific line ending — assert that sequence against the file or value itself.
Do not read the source and judge it correct.** Reading proves what you believe
you wrote; counting proves what is there.

This exists because fixing a one-line escape took three attempts, and the first
two produced a *plausible wrong answer* rather than an error:

- The intent was a test constant holding U+202E written as the escape `‮`,
  so the invisible character would not sit in the file that tests the defence
  against it. Attempt one went through a tool-call's JSON, which parsed the
  escape into the character — leaving a literal under a comment claiming an
  escape, which is the exact defect being repaired.
- Attempt two produced **two** backslashes. TypeScript reads that as the
  six-character text `‮`, not the override character, so
  `expect(reply).not.toContain(RLO)` would have passed against output that still
  carried the real override. A green test proving nothing.
- Attempt three wrote the byte with `chr(92)` in Python, bypassing both layers,
  and was settled by counting: one backslash on the line, zero literal U+202E
  anywhere in the file.

Three escaping layers sat between the intention and the file — the tool-call
JSON, bash heredoc backslash handling, and TypeScript's own string escapes — and
two of them failed silently in the direction of looking right. **This is the same
shape as `INSERT OR IGNORE` suppressing a `CHECK` violation: the mechanism
absorbs the error and returns something that resembles success.** The remedy is
the same too — stop asking the mechanism whether it worked, and measure the
result.

In practice: after writing such a value, count it (`line.count(chr(92))`, a
search for the literal character across the whole file, `od -c` on the region).
And when a test depends on a constant like this, **re-run its mutant after
changing the constant** — a mutation run against the old value proves nothing
about the new one.

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
