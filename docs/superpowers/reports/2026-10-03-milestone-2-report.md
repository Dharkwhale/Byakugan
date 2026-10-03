# Milestone 2 report: the Telegram bot

Branch `milestone-1-indexer`. Written 2026-10-03 from the controller's ledger and the per-task
reports for this milestone. Nothing here was re-measured for this document except the test
counts in section 2, which were re-run when it was written.

This is a record, not a summary of achievements. The sections that matter most are 3 to 5 and
7 to 9, which say what is not known.

## 1. What was built

A Telegram bot, started with `npm run bot`, that drives the Milestone 1 indexer and query
functions from a chat. Read-only: no keys, no signing, no wallet client, as before.

**Commands** (grammar from `src/bot/args.ts` and `src/bot/app.ts`):

| command | behaviour |
|---|---|
| `/index 0x… [--chain N] [--mints-only] [--logs-only] [--level L] [--to-block N] [--deploy-block N] [--dry-run] [--yes]` | Parses through the CLI's own `parseArgs`, so there is one validation path. Contradictory level options, a repeated `--contract` and `--help` are refused. `--dry-run` replies with the estimate and starts nothing, and `--yes` cannot reach past it. An estimate over 300 seconds is not started without `--yes`. A job is claimed atomically before the "progress follows" reply. A live job gets "already indexing"; an orphaned lock that has not yet expired gets a refusal naming when it will; an expired one is cleared by the new job. |
| `/status [0x…] [--chain N]` | With no address, lists up to 20 collections and states the total. With one, reports level, deploy block, watermark, row counts and job state, in each state of the lifecycle (absent, claimed-not-bootstrapped, bootstrapping, indexing, complete, orphaned lock live, orphaned lock expired). |
| `/firstminters 0x… [--chain N] [--limit N]` | Earliest minting wallets, one row per acting wallet, showing `firstRecipient` when a mint went to someone other than the sender. Refuses `logs_only`. |
| `/firstrecipients 0x… [--chain N] [--limit N]` | Earliest recipients. Works at every level. |
| `/overlap 0x… 0x… [--chain N] [--min N]` | Cross-collection wallets. Needs at least two addresses and refuses unless every collection is complete, offering a re-index command per offending collection. |
| `/help`, `/start` | Static replies. |

**Behaviour shared by the query commands:** a collection that was never indexed is reported as
"not indexed", distinct from an empty result. Every reply states the watermark it answered
from, and the `/overlap` title names the least-indexed collection. A query answered while a job
is running says so and still answers. Completeness is derived by counting unclassified rows, not
by reading `enrichment_level`.

**Infrastructure:**

- `src/bot/auth.ts` is the first middleware. An unauthorised user gets no reply and no API call
  of any kind; the drop is logged to stderr with the id.
- `src/bot/jobs.ts` is the in-process job registry, keyed on chain and contract, with
  atomic claim, release in a `finally`, and a runner that cannot reject.
- `src/bot/progress.ts` edits one progress message, throttled, skipping unchanged text, with a
  single in-flight edit. A failed progress edit never aborts the indexing; a permanent failure
  (403, message not found) stops further edit attempts for that job, which still completes.
- `src/bot/render.ts` and `replier.ts` render tables, switch to a CSV document over 3500
  characters, sanitise on-chain text (control and bidi characters, truncation by code point),
  and neutralise CSV formula prefixes.
- **Outbound scrubbing:** every chat string is scrubbed at the replier, and again by a grammY
  API transformer under every outbound call, so a handler that bypasses the replier is still
  covered. `src/bot/index.ts` imports the output scrubber first.
- `src/chain/ports.ts` extracts the port construction both front ends use. `src/bot/indexRun.ts`
  builds the ports once per `/index` command, so the progress label, the estimate and the run
  cannot come from different probes.
- Startup: `requireBotConfig` refuses an empty allowlist; `classifyStartupFailure` maps a 409 to
  exit code 4 and a rejected token to exit code 2.
- `test/unit/noPlaceholders.test.ts` fails the suite while any `@@UNWIRED@@` marker remains in
  `src/`.

**Exit codes a supervisor sees:** 0 OK, 1 internal, 2 usage (including a bad token and an empty
allowlist), 3 provider unavailable, 4 busy (another instance took over polling), 5 local state.

## 2. Test results

- `npm run typecheck`: clean.
- `BYAKUGAN_NO_DOTENV=1 npx vitest run`: **904 passed, 17 skipped, across 45 files** (44 files
  passed, 1 skipped). Re-run when this report was written.
- The 17 skipped are the real-provider smoke suite, skipped because this run had no credentials
  loaded. They were not run for this report, so nothing here is evidence about the real provider.
- Four suites skip themselves when their prerequisite is absent: three anvil suites (no Foundry)
  and the smoke suite (no RPC credential). In this run Foundry was present, so the anvil suites
  ran and only the smoke suite skipped.

## 3. Numbers the estimate rests on that nobody has measured

Two figures sit under every time estimate the bot shows. Neither has been measured.

**The compute-unit prices** in `src/chain/cuCosts.ts`. The file exports `VERIFIED = false`. They
are Alchemy's published figures, not confirmed against a dashboard reading. The one cross-check
is arithmetic: `eth_getLogs` at 60 CU against a 300 CU/s ceiling gives 5 calls per second. They
set the request rate the limiter allows and the estimate's time. What it would take: run
`npm run measure-cu`, which makes exactly N calls of one method so a dashboard delta is
attributable, read the dashboard, edit the prices in that one file and flip `VERIFIED`. That is
the owner's action, since it needs the owner's dashboard.

**The `/ 50` divisor** in `src/bot/indexRun.ts`, exported as
`ASSET_TRANSFERS_SPEEDUP_UNVERIFIED = 50`. When the run will use `alchemy_getAssetTransfers`,
the bot divides the `eth_getLogs` time estimate by 50, on the assumption that this path is about
fifty times faster. Its call count is not knowable before the logs are read, because it pages by
transfer count and has no block-range cap, so 50 is a stated guess and not a measurement. The
only related figure measured in this project is one collection's whole history: 70 `getLogs`
calls against 1 page. One collection does not establish a ratio for others.

**What the divisor feeds:** the user-visible "estimated N" line, and the confirmation gate,
which decides whether `/index` asks for `--yes` (threshold 300 seconds). The word "estimated" is
the only hedge in the reply. A wrong divisor can therefore make a long run start without a
confirmation, or a short one ask for it. What it would take to verify: index several real
collections of different sizes by the `getAssetTransfers` path, record the actual elapsed time
against the `eth_getLogs` estimate for the same span, and replace the constant with a figure the
data supports, or replace the divisor with a measured per-transfer model.

The CU caveat is printed by `--dry-run` while `VERIFIED` is false. The divisor has no such flag
and no caveat beyond "estimated".

## 4. `BYAKUGAN_NO_DOTENV=1`, and why it exists

`test/setup.ts` loads `.env` on purpose, so the real-provider smoke suite can run against a real
endpoint. The consequence is that a plain `npx vitest run` executes those 17 tests against the
owner's live Alchemy endpoint and **spends real compute units**. The credentialed suite must be
run deliberately, not incidentally.

It was being spent incidentally during development. The full suite was run well over a dozen
times to check bot unit tests before this was noticed, each run spending quota. With
`BYAKUGAN_NO_DOTENV=1` the smoke suite skips cleanly and prints its reason. Routine runs now go
through it, and it is in `CLAUDE.md`'s working rules and in the README's Tests section. The
amount of quota spent was not measured.

## 5. Argued, not tested

Each of these is code whose guard cannot be shown to matter by any test that exists. For each,
a mutant was written and survived, or no reachable mutant exists. They are kept for stated
reasons and recorded here so the claim they make is not mistaken for a tested one.

1. **The 403 path of the anvil progress-edit test.** The rows-written property on the 403 path
   cannot be shown by that test's own row-count and watermark assertions, and this is
   structural. `handleIndex` puts a `.catch` on `progress.onChunk`, which absorbs any rethrow
   before it can reach the backfill. So no reachable mutant lets a permanent edit failure abort
   the indexing. The obvious mutant (a permanent failure propagating instead of going quiet) was
   tried: the 403 test does fail, but on the log assertion, with the rows still fully indexed.
   The 403 test's row-count and watermark assertions are therefore redundant defence and can
   never be the failing assertion. The property is pinned by the generic-error anvil test, whose
   row assertion is the first to fire against an aborting backfill: a mutant that makes a failed
   edit abort the backfill fails it with `expected 3 to be 5`. So the 403 case rests on the same
   `.catch` that the generic test pins, and is not independently demonstrated.
2. **The `release()` identity check in `src/bot/jobs.ts`.** `free()` deletes the slot only if it
   still belongs to this claim. Unreachable: `spent` short-circuits first, so a late second
   `release` returns before reaching it, and deleting the check passes every test. It stays as
   defence in depth against `spent` being removed or a handle being shared. An earlier comment
   claimed it was load-bearing; that comment was false, was agreed with by the controller on
   review, and was corrected in `e86d326`.
3. **The `description` type check in `asApiError`** (`src/telegram/failures.ts`). The mutant
   survived with 14 passed, 0 failed, because every consumer tolerates a missing description
   through regex coercion. Kept because that tolerance is accidental and the declared type
   would otherwise be a lie.
4. **The `AND tx_from IS NULL` on `applyEnrichment`'s UPDATE**
   (`src/db/repositories/enrichment.ts`). The mutant survived with 88 passed, 0 failed, because
   the SELECT already excludes enriched rows. Distinguishing them needs two processes writing
   after both have read, which a synchronous driver inside one transaction cannot produce. This
   one and the previous one date from Milestone 1 and are carried here for completeness.
5. **The `contract === undefined` guards in the three query handlers.** Unreachable, because
   `parseQueryCommand` throws `Send at least one address.` on an empty list, so `contracts` is
   never empty on return. Kept as cheap insurance against that contract in another file
   changing. The controller's first ruling on this asserted a live crash; it was wrong, and was
   corrected after the implementer read the parser.

6. **WITHDRAWN — this entry was wrong, and it is left here rather than deleted because a
   false "argued, not tested" is the most expensive kind of entry in this list.** It claimed
   the 90-second request timeout could only be asserted as configuration, because the
   behaviour was "observable only by waiting 90 seconds, and this project does not sleep in
   tests". The whole-branch review disproved both halves.

   The reason was false: grammY arms the timeout with a plain `setTimeout`, which vitest's
   fake timers drive in zero wall time, and its rejection message names the number of seconds
   it was configured with — so the value is observable from outside.

   And the weaker assertion did not even hold. The review mutated `buildBot` to
   `new Bot(d.token, d.botConfig)`, deleting the timeout wiring entirely, and the suite stayed
   green at 898 passed. The controller reproduced that result. The test compared three
   exported constants to each other and never asked whether `buildBot` passed any of them to
   grammY, so the guard was wired by nothing at all while an entry in this section closed the
   question over it.

   Now tested behaviourally against a hanging stub `fetch` under fake timers: pending at
   89,999 ms, rejected at 90,001 ms with `timed out after 90 seconds`. Two mutants die —
   deleting the wiring, and changing 90 to 400. Nothing about the timeout is argued any more.

**A fixture-level gap that was fixed, not argued:** the first scrub test used a URL-shaped fake
secret, and a mutant that derived tokens from `[]` survived, because `scrubSecrets` has fallback
passes that redact URL-shaped keys with no tokens at all. The test switched to a plain fake secret
no fallback can catch, and every mutant was re-run. That became the "fixture a fallback also
handles" rule in `CLAUDE.md`.

## 6. Mutation record

Mutation work ran on throwaway branches with path-scoped restores. The counts below are from the
per-task reports; a "round" is a review fix round with its own mutants. The table counts
mutants run, not distinct defects.

| task | mutants run | outcome |
|---|---|---|
| 1 (grammY and Telegram measurement) | 6 | 5 died, 1 parked as argued-not-tested (the `description` check, section 5.3) |
| 4 (render, CSV, sanitiser) | 5, then 4, then 1 | all died |
| 5 (allowlist) | 2, then 5 | all died |
| 6 (argument parsing) | 5 in the fix round; none in the first pass | all died; the first pass has no mutation record |
| 7 (job registry) | 5, then 1 | all died |
| 8 (progress editor) | 7, then 7 (including 2 re-runs) | all died |
| 9 (`/index`) | 6, then 3, then 1 by the controller | all died |
| 10 (`/status`) | 4, then 3 | all died |
| 11 (queries) | 6, then 8, then 3 | 1 survived, killed (below) |
| 12a (atomic claim, edit failure, mid-backfill notice) | 2, 6 and 2 | all died; the `release()` identity check was later found unreachable by review, not by a mutant (section 5.2) |
| 12b (wiring, scrubbing) | 6, then 8, then 2 | all died; one fixture-level survivor, fixed (section 5) |
| 13 (real wiring) | 5 plus one variant | all died; see 5.1 for the 403 caveat |

Tasks 2 and 3 have no mutation record: Task 2 was a pure move covered by the existing suite, and
Task 3 was implemented ahead of order as a precondition for a live probe.

**Two survivors in this milestone were dealt with:**

- Task 11: `leastIndexedThrough` ignoring an unknown watermark and returning the smallest
  readable one survived all 46 tests, because every handler pre-checks `notIndexed` so the branch
  is unreachable in situ. **Killed** by exporting `leastIndexedThrough` and testing it directly;
  re-run gives 1 failed, 29 passed.
- Task 12a: the `release()` identity check (section 5.2). **Kept as defence in depth and
  recorded.**

The Task 1 parked mutant (the `description` check) predates these and is in section 5. If the
count is read as "mutants that survived during Milestone 2 tasks 2 to 13", it is two; including
Task 1 it is three.

**Process failures recorded along the way, because they bear on how much to trust the numbers:**
several first mutant attempts did not apply (a quoting error, a CRLF working copy, a
nonexistent test file) and ran against unmutated code, reporting a clean pass that proved
nothing. Each was caught and redone; the table above counts only the redone runs. One
implementer died on a network error and one on a rate limit; the controller ran the Task 8
matrix itself and applied the Task 10 fix round itself.

## 7. What was measured against live Telegram, and what was not

**Measured live** (`docs/superpowers/notes/2026-10-02-grammy-behaviour.md`):

- The error returned for an edit to identical text: a 400. `isUnchangedEdit` matches on that
  and on its description text, and the text dependence is real and unavoidable.
- The 409 on a second concurrent poller. It goes to the incumbent, not the newcomer: the second
  `getUpdates` succeeded and the first was rejected. This reversed an assumption in the original
  spec and the design with it.

**Never observed:**

- **No real Telegram 429 was ever observed.** The rate-limit retry path (cap on wait, one retry
  on the final edit) is covered by unit tests against a synthesised error shape. If a real 429
  differs from the shape in the published reference, the unit tests would not show it.
- **The 403 ("bot was blocked by the user") and "message to edit not found" shapes** come from
  the published Bot API reference and have never been observed. `isPermanentEditFailure`
  matches on them. If a real one differs, the reporter keeps retrying: noisy, not silent. The
  owner can verify the 403 by blocking and unblocking the bot.
- The 1024-character caption limit used by `boundCaption` is from the published API reference,
  not measured.

## 8. Known limitations

- **No job queue.** Two jobs share the account-wide compute-unit budget and both run slower.
- **No persistence of jobs across a restart.** The job is lost and its progress message goes
  stale. Indexed rows are kept and a re-run resumes from the watermark. Until the lock expires
  (15 minutes), `/index` and `/status` report the orphan.
- **No `/cancel`.** A started job runs to completion or failure.
- **Single instance, enforced by exiting on 409,** not by coordination. A displaced process
  exits with code 4 and its jobs die with it. Blindly restarting it makes the two trade places.
- **Group chats are untested.** The allowlist is per user.
- **The compute-unit prices and the `/ 50` divisor are unverified** (section 3).
- **A failed progress edit is invisible to the user.** By decision, an edit failure never aborts
  the backfill, so a stale progress message does not mean a stalled job. The failure is logged.
- **`finish` and `fail` wait for a progress edit already in flight.** If that edit's socket
  stalls, they wait with it, and a fresh send would have succeeded in that case. The bound is
  now an explicit 90-second client timeout rather than grammY's 500-second default.
  **This was a dropped carry-forward, found while writing this report.** Task 8 deferred the
  fix to "where the grammY client is configured", the wiring task never did it, and neither the
  controller nor the Task 12b review noticed; a stalled edit could therefore have held a
  finished job's final message for over eight minutes while `/status` reported it as running.
  90 rather than 30 because `bot.start()` long-polls through the same client with a 30-second
  timeout. Both grammY figures were read out of its source. The timeout's behaviour IS tested,
  under fake timers against a hanging stub fetch, after a first attempt that asserted nothing
  useful at all; see section 5.6, which records that failure rather than hiding it.
- **A real CLI run now makes two `eth_blockNumber` calls** (20 CU rather than 10): the port
  factory fetches a safe head for the probe and the CLI then calls `safeHead()` again, so the
  probe uses the older head. Harmless to the probe. The Task 13 change is
  therefore a refactor plus two untested CLI behaviour changes, not a pure refactor.
- **Telegram auto-links URLs** that appear in on-chain names. Noted, not handled.

## 9. For the whole-branch review

Three commit ranges were written by the controller with no independent implementer, so the
controller was both author and part of the checking. They are the whole-branch review's
priority:

- `bfa999c..ba83f2b` (Task 10 fix round)
- `ded239f..98d6bf0` (Task 11 fix round)
- `e86d326` and `062dcb1` (Task 12: the `release()` comment and watermark-read fixes, and the
  API-transformer scrub)

Deferred minors that the review should also see, most important first: the two surrogate cases
in Task 4's test share one `it`, so the second can never be the first failure, and a later edit
weakening it would escape a mutation run. The Task 6 chain test has the same shape.

---

## 10. The whole-branch review, and what it found

The owner asked that the final review treat the eight controller-written commits as its
priority rather than reviewing uniformly, on the grounds that they are the only code on the
branch with no independent check. It did, and **every finding it raised was in that set** —
which is the clearest available evidence that the asymmetry was real and worth naming.

Five were fixed in `94898b3`. In descending order of how badly they wanted an outside reader:

1. **The 90-second timeout was wired by nothing.** Deleting the `client` key left the suite
   green; see the withdrawn §5.6 above. Now behaviourally tested, two mutants dead.
2. **The scrubbing transformer's comment claimed the opposite of what grammY does** — that it
   runs outermost, so a later transformer sees scrubbed payloads. It runs INNERMOST. The right
   position for the wire, but a future `bot.api.config.use(logPayloads)` would see unscrubbed
   text, and the comment invited exactly that. The same commit contained the correct statement
   in its own test, which is what makes this the clearest thing an independent reader catches.
3. **`/status` with no address held the FOURTH instance of this project's named visibility
   defect** — the one `bfa999c` fixed in the address branch of the same function. It read
   `collections` alone, so a live first index (which writes no row until its deploy-block
   search ends) was reported as "Nothing indexed yet. Start with /index", pointing the user at
   the job they had already started. The state enumeration CLAUDE.md demands had been applied
   to one half of the command and not the other. The registry grew `running()`; the list branch
   now has a test per state.
4. **Both orphan-lock replies asserted "nothing is indexing it"**, which the lock table cannot
   support — a lock held by a live CLI run against the same database is indistinguishable from
   one a crashed process left, and `advanceWatermark` refreshes `locked_at` every chunk, so a
   live run's lock never goes stale and "try again in N minutes" never comes true.
5. **`boundCaption` measured in UTF-16 units and cut in code points**, so astral characters
   could return roughly twice the limit it exists to enforce. Unreachable through today's
   callers, which is why an all-BMP fixture could not see it — a worked instance of the
   "fixture a fallback also handles" rule applied to units rather than paths.

Two Minors were left, recorded rather than fixed: three silent-drop inconsistencies across the
query surface (`/firstminters 0xA 0xB` answers about `0xA` and says nothing about `0xB`, while
`/status` refuses the same shape; `--limit` parses for `/overlap` and does nothing; `/overlap`
has no row bound), and the 90-second timeout also capping large document uploads that grammY's
500-second default would have completed.

### One process failure worth recording

While fixing finding 3 the controller ran a mutant against an UNCOMMITTED fix and restored with
`git checkout -- src/bot/commands/status.ts`, which reverted the fix along with the mutant. The
work was redone and the lesson is the one CLAUDE.md already states — mutation work goes on a
branch over COMMITTED code — but the rule had been read as being about the mutant, not about
what else the restore takes with it.
