# Milestone 2 — Telegram bot

**Status:** design approved 2026-10-02, pending written-spec review.
**Depends on:** Milestone 1 (complete, 676 tests).

## Purpose

Give the owner and a short allowlist the Milestone 1 indexer without the CLI: index a
collection from a chat, and ask who minted and who bought across collections.

The commands are the easy part. The work is in three places that have nothing to do with
Telegram's API surface: a long-running job that must not block the handler, progress
reporting under a rate limit that is not Alchemy's, and output that does not fit in a
message.

## Scope

**In:** `/index`, `/status`, `/firstminters`, `/firstrecipients`, `/overlap`, allowed-user gating, detached
background jobs, rate-limited in-place progress edits, CSV output past the message limit.

**Out:** anything the scope bar already forbids (signing, keys, buying). Also out, and
listed under Known limitations with reasons: a job queue, job persistence across restart,
`/cancel`, webhooks, multiple instances, group chats.

## What this reuses unchanged

Nothing in `src/indexer/`, `src/chain/` or `src/db/` changes. The bot is a new caller of
the same functions the CLI calls:

| from M1 | used for |
|---|---|
| `backfill` | `/index`, including its bound, level refusal and per-chunk atomic commit |
| `firstMinters`, `firstRecipients`, `overlap` | the query commands, including their refusals |
| `getCollection`, `countByKind`, `getEnrichmentLevel` | `/status` |
| `parseArgs` | `/index` argument validation — see Commands |
| `estimateBackfill`, `probeEffectiveChunk` | the confirmation gate |
| `makeTransferSource` wiring, `supportsAssetTransfers` | fetch path selection |
| `outputScrubbing` | the bot token must never reach output |

**One refactor, not a rewrite:** `src/cli/exit.ts` moves wholesale to `src/report.ts`,
contents unchanged, and both front ends import it. `reportError` is renamed `describeError`
because it no longer lives in a CLI directory.

An earlier draft of this spec split it — prose mapping shared, exit codes left in `src/cli/`
— and that was wrong: §9 then needed the bot to import `EXIT` from `src/cli/`, which is the
layering smell the split existed to remove. Exit codes are not CLI-specific; both front ends
are processes that exit. One file, imported by both, and the bot simply ignores the exit code
in replies while using it at startup.

## Settled decisions

Recorded with reasoning, because each had a defensible alternative.

| decision | why |
|---|---|
| **No jobs table, no migration.** A restart loses the job and keeps the work. | The watermark makes resumption free, and the collection lock already expires on its own. A supervisor plus a jobs table would add a migration, a boot path, and the problem of a progress message whose chat no longer exists — to re-start work a user can re-start with one command. |
| **`/index` estimates first and requires confirmation above a threshold.** | This is `--dry-run`'s guard carried into the bot. A detached job cannot be stopped and holds the collection lock, so an accidental multi-hour run is expensive in a way the CLI's guard already exists to prevent. |
| **Default level `full`.** | Every command works immediately after indexing. Enrichment dominates cost, but the confirmation gate now surfaces that before anything starts; a user hitting a refusal from `/overlap` straight after a successful `/index` would read it as a bug. |
| **In-process map plus the DB lock, no serial queue.** | The map answers fast for this process, the lock answers correctly across processes. A queue was considered and rejected: the CU budget is account-wide, so two concurrent jobs each run at half rate and finish in roughly the time a queue would take to run them in sequence. The queue relocates the waiting rather than removing it, while adding position messaging and a drain-failure mode. |
| **Plain text, no `parse_mode`.** | Collection names come from on-chain `name()` and are attacker-controlled. |
| **Empty allowlist is a startup failure.** | The two ways to get this wrong are a bot that drops everything (useless) and one that treats empty as allow-all (catastrophic). Neither should be reachable by leaving a variable unset. |

---

## 1 · Layout

```
src/report.ts               describeError, EXIT, formatError — moved from cli/exit.ts
src/bot/index.ts            entry: config, wiring, long polling, startup failures
src/bot/auth.ts             allowlist middleware
src/bot/jobs.ts             job registry, three-state inspection, detached runner
src/bot/progress.ts         throttled message editor
src/bot/render.ts           text/CSV decision, on-chain text sanitisation
src/bot/args.ts             command text → CLI flag form
src/bot/commands/index.ts   /index
src/bot/commands/status.ts  /status
src/bot/commands/queries.ts /firstminters, /overlap
```

**Boundary that makes this testable:** commands never see grammY types. They take a
`Replier`:

```ts
export interface Replier {
  reply(text: string): Promise<{ messageId: number }>;
  edit(messageId: number, text: string): Promise<void>;
  sendDocument(a: { filename: string; contents: string; caption: string }): Promise<void>;
}
```

Every command is therefore a unit test with a fake `Replier` and an in-memory database. One
thin wiring test covers the grammY assembly, and its only real assertion is middleware
order.

## 2 · Gating

```ts
export function allowOnly(ids: ReadonlySet<number>): Middleware
```

Registered with `bot.use(...)` **before any command handler**. An update is dropped —
`next()` not called, nothing sent — when `ctx.from?.id` is absent or not in the set.

Silence is the requirement, not a side effect. Any reply, including an error, confirms the
bot exists to whoever found its username. The rejection is logged at `info` with the id so
attempts are visible to the owner; a Telegram user id is not a secret.

**Test:** an unauthorized update results in **zero** calls on the `Replier` and `next` never
invoked. Asserting "no reply text" would pass against a handler that sent an error.

**Mutation target:** removing the membership check must fail that test.

## 3 · Configuration

Two fields, parsed in `src/config.ts` (currently in `.env.example` and parsed nowhere):

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_IDS=111111111,222222222
```

- **The token joins `config.secrets`.** grammY builds request URLs as
  `api.telegram.org/bot<TOKEN>/…` and includes them in error dumps, which is the exact shape
  that put an Alchemy key into a transcript and cost a rotation. The existing stream scrub
  covers it once the token is in `secrets`, and not before.
- **Both fields are optional in `Config` and required by the bot.** The CLI must keep
  working with neither set, so `loadConfig` parses them without demanding them. A single
  `requireBotConfig(config)` in `src/bot/index.ts` throws `ConfigError` when the token is
  absent or the allowlist is empty, and returns a narrowed type that cannot represent
  either. The check has exactly one home, and the type system stops a handler reading an
  allowlist that might be empty.

**Mutation target:** removing the token from `secrets` must fail a test that asserts it is
redacted from output.

## 4 · Commands

```
/index 0x… [--chain N] [--mints-only|--logs-only] [--to-block N] [--yes]
/status [0x…]
/firstminters 0x… [--chain N] [--limit N]
/firstrecipients 0x… [--chain N] [--limit N]
/overlap 0x… 0x… [0x… …] [--min N]
/help
```

**`/index` routes through the CLI's `parseArgs`.** `src/bot/args.ts` translates the chat
form into the flag form (`/index 0xabc --mints-only` → `['--contract','0xabc','--level','mints_only']`)
and hands it over. Address validation, level validation, lowercasing and the `UsageError`
type then have one implementation, and a bad address produces the same message in both
front ends. A second parser would drift.

`--yes` skips the confirmation gate. The reply **states the level used**, so a later
`EnrichmentLevelError` from `/overlap` is traceable to a choice the user can see.

`/status` with no address lists running jobs and recently indexed collections; with an
address, reports standard, deploy block and whether it was validated, watermark, enrichment
level, kind counts, and the job state from §5.

`/overlap` requires at least two addresses and defaults `--min` to 2.

`/firstrecipients` was added after review found an incoherence: without it, `logs_only`
could be indexed and nothing could query it, which makes a level dead configuration. It is
also the ONLY query with no enrichment gate — `to_addr` comes from the log — so it is the
only test of that path. Its `minter` column is nullable and renders as
"unknown (not enriched)" rather than blank, because a blank column reads as an address
nobody noticed was missing.

## 5 · Jobs

```ts
export type JobState =
  | { kind: 'running';  startedAt: number; lastProgress?: ChunkContext; source: string }
  | { kind: 'orphaned'; lockedBy: string; lockedAt: number; expiresAt: number }
  | { kind: 'idle' };

export function createJobRegistry(a: { clock: Clock; staleMs: number }): {
  inspect(db, a: { chainId: number; contract: string }): JobState;
  start(a: { chainId: number; contract: string; run: () => Promise<void> }): void;
  size(): number;
};
```

The registry owns the map rather than holding it in module scope, so a test gets a fresh one
without resetting global state. The map is keyed `${chainId}:${contract}`; the lock is read
from `collections.locked_by` / `locked_at` via a new read-only repository function, and
`expiresAt = locked_at + staleMs`.

**The three states exist because the map and the lock disagree after a crash.** The map is
empty on restart while a stale lock row survives until its timeout, so without this
distinction `/index` in that window reports "already indexing" for a job that does not
exist. When both are present the map wins — it is the more specific fact.

| state | reply says | what the user should do |
|---|---|---|
| `running` | started N minutes ago, at block B, via `<fetch path>` | wait for it |
| `orphaned` | a previous run left a lock, expires in N minutes | wait for the timeout; it clears itself |
| `idle` | — | the job starts |

### The detached runner

```ts
void startJob(...)   // startJob NEVER rejects
```

Cleanup lives in a `finally`, and the runner swallows its own failure after reporting it, so
an unhandled rejection is structurally impossible rather than something to remember:

```ts
async function run(): Promise<void> {
  try {
    const result = await backfill(...);
    await progress.finish(result);
  } catch (err) {
    await progress.fail(describeError(err));      // the user is told
  } finally {
    jobs.delete(key);                              // the map is cleared
  }
}
```

**Why the `finally` is load-bearing, and not merely tidy.** `backfill` releases the DB lock
in its own `finally`, so the lock is always correct. The map is not covered by that, and
**the map has no expiry**. A leaked entry makes that collection report "already indexing"
for the life of the process, with no timeout to recover and nothing in the database to
indicate a problem — strictly worse than the orphan case it would impersonate.

**Mutation target:** a job that throws must leave the map empty and the user informed.
Moving either statement out of the `finally` must fail.

## 6 · Progress

```ts
createJobProgress(a: { replier; messageId; clock; intervalMs?; render })
  → { onChunk(ctx); finish(result); fail(reported) }
```

One message, edited no more than every **4 seconds**. Three Telegram behaviours drive the
design, each a trap rather than a preference:

- **An unchanged edit is an error**, not a no-op (`message is not modified`). Renders equal
  to the last one sent are skipped. This happens routinely when a slow chunk has not moved
  the numbers between ticks.
- **A 429 carries `retry_after`**, on a budget separate from Alchemy's. The edit is
  **dropped**, not queued: a stale progress line has no value, and queueing them converts
  one rate-limit into a backlog that outlives the job.
- **`finish` and `fail` bypass the throttle and always land**, retrying once after
  `retry_after`. A reporter that can swallow its last line leaves the user unable to tell a
  finished job from a hung one — the same reasoning as the CLI reporter's `finish()`.

The rendered line carries collection, chain, level, **fetch path**, block range, rows so
far, and elapsed time. The fetch path is there because its absence hid a real defect: a
capability probe wired into the dry-run path only meant every real run silently used
`getLogs`, finishing correctly in seventy chunks where one page would have done. With this
line it would have been visible in the first second.

**Mutation targets:** throttling `finish`; removing the unchanged-text guard; queueing
instead of dropping on 429.

## 7 · Output, and sanitising on-chain text

One rule, in `render.ts`, for every command:

```ts
respond(replier, { title, headers, rows, filename }) 
```

Build the text. If it exceeds **3500 characters**, send a CSV document with a one-line
caption instead. 3500 rather than 4096 leaves room for the caption and keeps the limit from
being reached by the last row of a borderline message. The same threshold applies to every
command, so `/overlap` across fifteen collections and `/firstminters --limit 500` behave
consistently.

**On-chain `name()` is attacker-controlled text and is sanitised at this boundary.**
Dropping `parse_mode` handles Markdown, and Markdown is not the only problem:

| input | effect without sanitisation |
|---|---|
| newlines | breaks the message into fake lines, forging structure |
| C0/C1 control characters | corrupts rendering unpredictably |
| RTL override (U+202A–202E, U+2066–2069) | reverses display order; text can read as something else entirely |
| a 2,000-character name | consumes the message budget and pushes real output into CSV |

So: strip control characters, strip bidi controls, collapse runs of whitespace to a single
space, trim, and truncate to **64 characters** with an ellipsis. This project has met this
class before — the `İ` index-skew bug in `secrets.ts` — and the lesson is that hostile text
needs a boundary, not vigilance at each use.

**CSV filenames are never derived from a name.** They are
`<command>-<chainId>-<contract>-<unix>.csv`, from the contract address.

**Mutation targets:** the CSV threshold; each sanitisation step, driven by a hostile-name
fixture.

## 8 · Errors

The bot renders `describeError(err)` — `headline`, `detail`, `hint` — and ignores
`category`. On top of that, a small `nextCommand(err, args)` returns a **tappable command**
where one exists, because "re-index at full" as prose is less useful in a chat than the
command itself. It is a table of commands, not a second message mapping:

| error | next command |
|---|---|
| `EnrichmentLevelError` | `/index <contract> --chain <id>` (at the level the query needs) |
| `DeployBlockUnavailableError` | `/index <contract> --deploy-block <n>` |
| `CollectionLockedError` | `/status <contract>` |
| `UsageError` | `/help` |

Those first two are the ones users will actually hit, and both now carry an action rather
than only a description.

## 9 · Startup failures

The entry point exits rather than retrying on two conditions:

- **409 Conflict** from `getUpdates` means another instance has **displaced this one**.
  Measured against a live bot (see the Task 1 notes), and the opposite of what this spec
  first assumed: two concurrent `getUpdates` and the SECOND succeeds while the FIRST is
  rejected with *"terminated by other getUpdates request"*. Telegram does not refuse the
  newcomer; it kills the request already in flight. The process that sees a 409 is therefore
  the one being replaced, and it cannot poll at all. It exits `EXIT.BUSY` and does **not**
  retry.

  **The exit message must state the handover plainly**, because nothing else will. It says
  that another instance has taken over, that this one is stopping, and that the likely cause
  is an older process still running — and it does not advise restarting, which would displace
  the other in turn and trade places indefinitely.

- **The startup log records the process id.** A handover leaves no error anywhere once the
  displaced process is gone: the new bot works, the old one vanishes, and neither chat shows
  anything. A pid in the log is what makes a flip-flop diagnosable from logs rather than from
  guessing, and it is one line.

### What a handover actually costs

Worth writing down, because it is milder than the split-brain this spec first assumed and
not harmless either.

- **Update delivery is never split.** Exactly one poller receives updates at any moment, so
  no message is handled twice and none is lost to a race.
- **The displaced process exits on its NEXT poll**, which is prompt but not instant. Until
  then two processes are alive against the same SQLite file, and the collection lock is what
  keeps their work from colliding — which is what it was built for.
- **Its detached jobs die with it.** This is the real cost. A `/index` running in the
  displaced process is killed mid-run; the per-chunk atomic commit means nothing is corrupt
  and the watermark stays honest, but the job is gone and its collection lock survives until
  the stale timeout. `/index` and `/status` already report that as the **orphaned** state, so
  the user sees a true explanation rather than silence — which is the reason that state
  exists.

**Mutation target:** retrying on 409 instead of exiting must fail a test.

## 10 · Data

**No schema change and no migration.** One new read-only repository function to inspect the
lock, which selects columns that already exist.

## 11 · Testing

Unit, with a fake `Replier`, an in-memory database and an injected clock:

- auth: unauthorized → zero API calls; authorized → `next()` called
- args: translation to flag form, and that a bad address yields `UsageError`
- jobs: all three states, including the orphan (lock row present, map empty); a throwing
  job leaves the map empty and the user informed
- progress: throttle, unchanged-text skip, 429 drop, `finish`/`fail` always landing
- render: the 3500-character switch to CSV; hostile-name sanitisation; filenames from
  addresses
- errors: every class renders a headline and a next command where one is defined
- config: `loadConfig` puts the token in `secrets` and tolerates both fields being absent;
  `requireBotConfig` throws on a missing token and on an empty allowlist

Integration (anvil, skipping without Foundry): `/index` end to end against the local chain
through the real job runner, asserting the progress message was edited at least twice and
that the final edit reports the completed watermark.

**Mutation-verified**, per the standing rule: auth, the orphan/running distinction, map
cleanup on a throwing job, `finish` bypassing the throttle, the CSV threshold, and the token
in `secrets`.

## 12 · Known limitations

- **No job queue.** Two concurrent jobs share the account-wide CU budget and both run
  slower. Considered and rejected: a queue relocates the waiting rather than removing it.
- **No persistence across restart.** The job is lost, the progress message goes stale, the
  indexed work is kept, and a re-run resumes from the watermark. For the window until the
  lock expires, `/index` reports the orphan state.
- **No `/cancel`.** A started job runs to completion or failure. The confirmation gate is
  what prevents starting the wrong one.
- **Long polling, single instance, enforced by displacement rather than coordination.** NOT
  split-brain: that was an assumption in an earlier draft of this spec and the measurement
  showed it was wrong. Exactly one poller ever receives updates. The milder real problem is a
  **zombie**: starting a second instance while an old one lives gives a working bot and, for
  the moment before the old one next polls, two live processes — and the old one's in-flight
  jobs die when it exits, leaving locks that clear on the stale timeout. The pid in the
  startup log is how that is diagnosed after the fact.
- **Group chats are untested.** The allowlist is per-user, so a group containing an allowed
  user would let that user drive the bot while others read the output.
- **Compute-unit prices remain unverified** (`src/chain/cuCosts.ts`, `VERIFIED = false`), so
  the estimate in the confirmation gate inherits that caveat and says so.
