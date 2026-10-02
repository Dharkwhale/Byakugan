# Milestone 2 — Telegram Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private Telegram bot that indexes NFT collections and answers who minted and who bought, driving Milestone 1's indexer unchanged.

**Architecture:** grammY with long polling. An allowlist middleware runs before any handler. `/index` replies immediately and runs the backfill detached, tracked in an in-process registry backed by the existing database lock; one message is edited with progress under a throttle. Commands are written against a narrow `Replier` port so they unit-test without a Telegram server, and any output over 3500 characters becomes a CSV document.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), grammY 1.46, better-sqlite3, zod, vitest. Everything in `src/indexer/`, `src/chain/` and `src/db/` is reused unchanged.

**Spec:** `docs/superpowers/specs/2026-10-02-milestone-2-telegram-bot-design.md`

## Global Constraints

- TypeScript `strict: true`, `noUnusedLocals`, `noUncheckedIndexedAccess`, ESM, NodeNext. Node 20+.
- **No private key anywhere in the repo or its config.** A test asserts the config schema has no private-key field.
- Read-only chain access. viem public client only; no wallet client.
- **`TELEGRAM_BOT_TOKEN` must be in `config.secrets`.** grammY builds URLs as `api.telegram.org/bot<TOKEN>/…` and includes them in error dumps.
- Every file in `scripts/` imports `scripts/_scrub-output.ts` as its **first** import.
- Time comes from an injected `Clock` (epoch ms). Never `sleep` to test a timeout; never use SQLite `datetime()`/`unixepoch()`.
- Addresses are stored and compared lowercase.
- Any test pinning a concurrency, security, idempotency or atomicity property is **mutation-verified** before it counts as done, with both results reported. Mutation work goes on a branch or a stash, never an in-place edit.
- Assert behaviour, not configuration. Derive expectations from the spec, not from the fixture.
- Messages are sent with **no `parse_mode`**.
- `npm test` and `npm run typecheck` pass before the milestone is called done.
- Never `git push` without asking.

## Review Focus

Five input classes the spec implies but does not name, most likely to bite first. Each line's test is added to the task that owns the code.

1. **`/index` with no address, or with trailing junk.** A user types `/index` alone. Must reply with usage, not crash and not go silent. → Task 6.
2. **The same contract address on two different chains.** The job registry and every reply must key on `chainId:contract`; keying on the address alone makes an Ethereum and a Base collection at the same address collide, and one job's progress would overwrite the other's. → Task 7.
3. **`/overlap` given the same address twice.** Without dedupe, one collection counts as two and every wallet that touched it looks like an overlap. → Task 11.
4. **A throttled progress edit landing after the job finished.** The final edit must win; a tick in flight must not overwrite it with a stale line. → Task 8.
5. **A query command on a collection that was never indexed.** `firstMinters` on an unknown collection returns an empty array, which renders as "no results" — indistinguishable from a collection with no mints. Must say "not indexed" and name `/index`. → Task 11.

---

## File Structure

| file | responsibility |
|---|---|
| `src/report.ts` | **moved** from `src/cli/exit.ts`: `describeError`, `EXIT`, `formatError`. Imported by both front ends. |
| `src/telegram/failures.ts` | classifies grammY errors: unchanged edit, rate limit with seconds, conflict, unauthorized. Shape determined by Task 1's measurements. |
| `src/bot/replier.ts` | the `Replier` port plus its grammY implementation. |
| `src/bot/render.ts` | text/CSV decision, on-chain text sanitisation, table formatting. |
| `src/bot/auth.ts` | allowlist middleware. |
| `src/bot/args.ts` | command text → CLI flag form. |
| `src/bot/jobs.ts` | job registry, three-state inspection, detached runner. |
| `src/bot/progress.ts` | throttled single-message progress editor. |
| `src/bot/commands/index.ts` | `/index`, including the confirmation gate. |
| `src/bot/commands/status.ts` | `/status`. |
| `src/bot/commands/queries.ts` | `/firstminters`, `/overlap`. |
| `src/bot/index.ts` | entry: `requireBotConfig`, wiring, long polling, startup failures. |
| `src/db/repositories/collections.ts` | **modify**: add `inspectLock`. |
| `src/config.ts` | **modify**: parse the two Telegram fields, token into `secrets`. |

---

## Task 1: Measure grammY, do not recall it

Every Milestone 1 defect that cost a round came from an assumed mechanism: viem's timeout, the CU ceiling, vitest discarding console output from fully-skipped files, the dry-run reading `maxChunk` instead of the measured cap. grammY has the same surface. This task establishes its real behaviour **before** anything is designed around it.

**Files:**
- Create: `docs/superpowers/notes/2026-10-02-grammy-behaviour.md`
- Create: `scripts/probe-telegram.ts`
- Create: `src/telegram/failures.ts`
- Test: `test/unit/telegramFailures.test.ts`
- Modify: `package.json` (add `grammy`, add a `probe:telegram` script)

**Interfaces:**
- Produces:
  - `isUnchangedEdit(err: unknown): boolean`
  - `retryAfterSeconds(err: unknown): number | undefined`
  - `isConflict(err: unknown): boolean`
  - `isUnauthorized(err: unknown): boolean`

- [ ] **Step 1: Install grammY and pin it**

```bash
npm install grammy@1.46.0
```

- [ ] **Step 2: Read the error surface out of the installed source and write down what is actually there**

Read these files and record findings verbatim in the notes document — class names, property names, and whether each property is typed:

```bash
sed -n '1,120p' node_modules/grammy/out/core/error.d.ts
sed -n '1,80p' node_modules/grammy/out/core/error.js
grep -rn "retry_after" node_modules/grammy/out/ | head -20
grep -rn "class GrammyError\|class HttpError" node_modules/grammy/out/ | head
grep -rn "retry\|backoff" node_modules/grammy/out/core/client.js | head -20
grep -rn "autoRetry\|throttle" node_modules/grammy/out/ | head
```

Four questions the notes must answer with a quotation from the source, not a recollection:

1. What class is thrown for a Bot API error, and does it expose `error_code` and `description` as typed properties?
2. Is `retry_after` reachable as a typed property (for example `err.parameters.retry_after`), or only inside `description` as text? **If it is only in text, every retry decision depends on string parsing and that must be stated.**
3. Does grammY retry anything by default? If it retries 429s internally, our own handling would double-count the wait, and the throttle interval must be chosen knowing that.
4. Are `@grammyjs/auto-retry` and `@grammyjs/transformer-throttler` bundled or separate packages? If separate, we are not using them and our throttle is the only one.

- [ ] **Step 3: Write the probe script for the two SERVER behaviours source cannot answer**

`scripts/probe-telegram.ts`. Unchanged-edit and 409 are Telegram's behaviour, not grammY's, so they need a live token. The script must print the full error shape with the token redacted — the scrub guard import is first, and non-negotiable, because grammY error dumps contain the token in a URL.

```ts
/**
 * Measures the two Telegram SERVER behaviours the design depends on and that
 * grammY's source cannot answer: what an unchanged edit returns, and what a
 * second long-polling instance returns.
 *
 * Needs TELEGRAM_BOT_TOKEN and a chat id to post into. Prints error shapes with
 * every secret redacted at the boundary.
 *
 *   npm run probe:telegram -- --chat <your numeric chat id>
 */
import './_scrub-output.js'; // MUST be first.
import { Bot, GrammyError, HttpError } from 'grammy';

const chatId = Number(process.argv[process.argv.indexOf('--chat') + 1]);
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
if (!Number.isInteger(chatId)) throw new Error('pass --chat <numeric chat id>');

const describe = (err: unknown): string => {
  if (err instanceof GrammyError) {
    return JSON.stringify({
      kind: 'GrammyError', error_code: err.error_code,
      description: err.description, parameters: err.parameters, method: err.method,
    }, null, 2);
  }
  if (err instanceof HttpError) return `HttpError: ${String(err.error)}`;
  return `other: ${err instanceof Error ? err.message : String(err)}`;
};

const bot = new Bot(token);

// 1. Unchanged edit.
const sent = await bot.api.sendMessage(chatId, 'probe: initial text');
try {
  await bot.api.editMessageText(chatId, sent.message_id, 'probe: initial text');
  process.stdout.write('\nUNCHANGED EDIT: succeeded, no error thrown\n');
} catch (err) {
  process.stdout.write(`\nUNCHANGED EDIT threw:\n${describe(err)}\n`);
}

// 2. A changed edit, to confirm the happy path.
await bot.api.editMessageText(chatId, sent.message_id, 'probe: changed text');
process.stdout.write('\nCHANGED EDIT: ok\n');

// 3. Conflict: two getUpdates at once.
const a = bot.api.getUpdates({ timeout: 10 });
try {
  await bot.api.getUpdates({ timeout: 10 });
  process.stdout.write('\n409 PROBE: second getUpdates did NOT error\n');
} catch (err) {
  process.stdout.write(`\n409 PROBE threw:\n${describe(err)}\n`);
}
await a.catch(() => undefined);
```

- [ ] **Step 4: Hand the probe to the owner and record the results**

The repo has no bot token. Ask the owner to create one with @BotFather, set `TELEGRAM_BOT_TOKEN`, send the bot a message to get a chat id, and run `npm run probe:telegram -- --chat <id>`. Paste the output into the notes document. **Do not guess these two answers and do not proceed to Step 5 with them unknown** — write `src/telegram/failures.ts` against the recorded shapes.

- [ ] **Step 5: Write the failing tests for the classifier, using the RECORDED shapes**

`test/unit/telegramFailures.test.ts`. Construct errors matching exactly what Task 1 recorded. The example below assumes `GrammyError` carries typed `error_code`, `description` and `parameters`; **if the notes say otherwise, change these fixtures to match the notes, not the other way round.**

```ts
import { describe, expect, it } from 'vitest';
import {
  isConflict, isUnauthorized, isUnchangedEdit, retryAfterSeconds,
} from '../../src/telegram/failures.js';

/** Shaped from the recorded probe output, not from recollection. */
function apiError(a: { code: number; description: string; parameters?: Record<string, number> }) {
  return Object.assign(new Error(`Call to method failed: ${a.description}`), {
    name: 'GrammyError',
    error_code: a.code,
    description: a.description,
    parameters: a.parameters ?? {},
  });
}

describe('isUnchangedEdit', () => {
  it('recognises the unchanged-edit rejection', () => {
    expect(isUnchangedEdit(apiError({
      code: 400,
      description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
    }))).toBe(true);
  });

  it('does not treat other 400s as unchanged edits', () => {
    expect(isUnchangedEdit(apiError({ code: 400, description: 'Bad Request: message to edit not found' })))
      .toBe(false);
  });

  it('is false for a non-API error', () => {
    expect(isUnchangedEdit(new Error('socket hang up'))).toBe(false);
    expect(isUnchangedEdit(undefined)).toBe(false);
  });
});

describe('retryAfterSeconds', () => {
  it('reads the wait out of a 429', () => {
    expect(retryAfterSeconds(apiError({
      code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 },
    }))).toBe(7);
  });

  it('is undefined when the error is not a rate limit', () => {
    expect(retryAfterSeconds(apiError({ code: 400, description: 'Bad Request: x' })))
      .toBeUndefined();
    expect(retryAfterSeconds(new Error('nope'))).toBeUndefined();
  });
});

describe('isConflict and isUnauthorized', () => {
  it('recognises a second polling instance', () => {
    expect(isConflict(apiError({
      code: 409,
      description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
    }))).toBe(true);
  });

  it('recognises a bad token', () => {
    expect(isUnauthorized(apiError({ code: 401, description: 'Unauthorized' }))).toBe(true);
  });

  it('keeps the three classes distinct', () => {
    const conflict = apiError({ code: 409, description: 'Conflict: terminated by other getUpdates request' });
    expect(isUnauthorized(conflict)).toBe(false);
    expect(isUnchangedEdit(conflict)).toBe(false);
    expect(retryAfterSeconds(conflict)).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run the tests and watch them fail**

Run: `npx vitest run test/unit/telegramFailures.test.ts`
Expected: FAIL — `src/telegram/failures.ts` does not exist.

- [ ] **Step 7: Implement the classifier**

`src/telegram/failures.ts`. Classify on `error_code` first and on `description` text only where the code alone is ambiguous — a 400 covers many conditions, so the unchanged-edit case genuinely needs the text, and that dependence is written down rather than hidden.

```ts
/**
 * Classifies Telegram Bot API failures.
 *
 * Shapes here were MEASURED, not recalled — see
 * docs/superpowers/notes/2026-10-02-grammy-behaviour.md for the probe output every
 * predicate below is written against. This project has lost rounds to assumed
 * mechanisms (viem's timeout, the compute-unit ceiling, vitest discarding console
 * output from fully-skipped files), so the notes are the authority and this file
 * follows them.
 */
interface ApiError {
  error_code: number;
  description: string;
  parameters?: { retry_after?: number };
}

function asApiError(err: unknown): ApiError | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as Partial<ApiError>;
  if (typeof candidate.error_code !== 'number') return undefined;
  if (typeof candidate.description !== 'string') return undefined;
  return candidate as ApiError;
}

/**
 * Editing a message to the text it already has is an ERROR, not a no-op.
 *
 * Matched on description text because 400 covers many unrelated conditions, and that
 * text dependence is deliberate rather than lazy: there is no code that means only
 * this. If Telegram rewords it, this predicate returns false, the editor stops
 * skipping redundant edits, and progress updates start failing visibly — noisy
 * rather than silent, which is the right direction for a guess about someone else's
 * wording.
 */
export function isUnchangedEdit(err: unknown): boolean {
  const api = asApiError(err);
  return api?.error_code === 400 && /message is not modified/i.test(api.description);
}

/** Seconds Telegram asked us to wait, when it asked. A different budget from Alchemy's. */
export function retryAfterSeconds(err: unknown): number | undefined {
  const api = asApiError(err);
  if (api?.error_code !== 429) return undefined;
  const typed = api.parameters?.retry_after;
  if (typeof typed === 'number' && Number.isFinite(typed)) return typed;
  // Fallback only if the notes recorded that the typed field can be absent.
  const parsed = /retry after (\d+)/i.exec(api.description);
  return parsed ? Number(parsed[1]) : undefined;
}

/** Another instance is already polling. Long polling does not error under contention. */
export function isConflict(err: unknown): boolean {
  return asApiError(err)?.error_code === 409;
}

/** The token is wrong. */
export function isUnauthorized(err: unknown): boolean {
  return asApiError(err)?.error_code === 401;
}
```

- [ ] **Step 8: Run the tests and verify they pass**

Run: `npx vitest run test/unit/telegramFailures.test.ts`
Expected: PASS.

- [ ] **Step 9: Record the findings document**

`docs/superpowers/notes/2026-10-02-grammy-behaviour.md` must contain: the pinned grammY version; the quoted error-class surface; whether `retry_after` is typed; whether grammY retries anything by default; whether auto-retry and the throttler are separate packages; and the verbatim probe output for the unchanged edit and the 409. Where a question could not be answered — for example if no token was available — say so explicitly and name what the code assumes instead.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/telegram/ test/unit/telegramFailures.test.ts \
  scripts/probe-telegram.ts docs/superpowers/notes/
git commit -m "feat: classify Telegram failures from measured behaviour, not recalled"
```

---

## Task 2: Move the error mapping so both front ends share it

**Files:**
- Create: `src/report.ts` (moved from `src/cli/exit.ts`)
- Delete: `src/cli/exit.ts`
- Modify: `src/cli/index.ts` (import path)
- Modify: `test/unit/cli.test.ts` (import path)

**Interfaces:**
- Produces: `describeError(err: unknown): Reported`, `formatError(reported, opts?): string`, `EXIT`, `type Reported`, `type ExitCode`. `Reported` is `{ exitCode: ExitCode; headline: string; detail: string; hint?: string }`.

- [ ] **Step 1: Move the file with git so history follows it**

```bash
git mv src/cli/exit.ts src/report.ts
```

- [ ] **Step 2: Rename the entry point and explain the move in the file header**

In `src/report.ts`, rename `reportError` to `describeError` and add to the top-of-file comment:

```ts
/**
 * Turning any thrown value into something worth printing, plus the exit-code table.
 *
 * LIVES IN src/, NOT src/cli/, because the Telegram bot needs the same mapping and a
 * second one would drift. An earlier design split it — prose here, exit codes left in
 * src/cli/ — and that was wrong: the bot's startup path needs EXIT too, so the split
 * would have had the bot importing from src/cli/, which is the layering smell the
 * split existed to remove. Exit codes are not CLI-specific; both front ends are
 * processes that exit. The bot ignores `exitCode` in replies and uses it on startup.
 */
```

- [ ] **Step 3: Update both importers**

```bash
grep -rln "cli/exit.js" src/ test/ | xargs sed -i "s#'\./exit\.js'#'../report.js'#; s#'\.\./\.\./src/cli/exit\.js'#'../../src/report.js'#"
```

Then read the two files and fix any import the substitution missed.

- [ ] **Step 4: Run the full suite — this is a pure move and nothing should change**

Run: `npm run typecheck && npm test`
Expected: PASS, with the same count as before the move (676).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move the error mapping to src/report.ts for both front ends"
```

---

## Task 3: Config — the two Telegram fields, and the token in secrets

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: `Config` (existing).
- Produces: `Config.telegramBotToken?: string`, `Config.telegramAllowedUserIds: number[]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/config.test.ts`:

```ts
describe('Telegram configuration', () => {
  const base = {
    RPC_URL_1: 'https://eth.example/v2/abcdefghijklmnop',
    DEFAULT_CHAIN_ID: '1',
  };

  it('parses the token and the allowlist', () => {
    const config = loadConfig({
      ...base,
      TELEGRAM_BOT_TOKEN: '123456:AAbbccddeeffgghh',
      TELEGRAM_ALLOWED_USER_IDS: '111, 222 ,333',
    });
    expect(config.telegramBotToken).toBe('123456:AAbbccddeeffgghh');
    expect(config.telegramAllowedUserIds).toEqual([111, 222, 333]);
  });

  it('puts the BOT TOKEN in secrets, so the output scrubber covers it', () => {
    // grammY builds request URLs as api.telegram.org/bot<TOKEN>/… and includes them in
    // error dumps. That is the shape that put an Alchemy key in a transcript and cost a
    // rotation; the stream scrub only covers the token once it is in `secrets`.
    const config = loadConfig({ ...base, TELEGRAM_BOT_TOKEN: '123456:AAbbccddeeffgghh' });
    expect(config.secrets).toContain('123456:AAbbccddeeffgghh');
  });

  it('tolerates both fields being absent, because the CLI needs neither', () => {
    const config = loadConfig(base);
    expect(config.telegramBotToken).toBeUndefined();
    expect(config.telegramAllowedUserIds).toEqual([]);
  });

  it('rejects an allowlist entry that is not a user id', () => {
    expect(() => loadConfig({ ...base, TELEGRAM_ALLOWED_USER_IDS: '111,alice' }))
      .toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `telegramBotToken` is not on `Config`.

- [ ] **Step 3: Implement**

In `src/config.ts`, add to the `Config` interface:

```ts
  /** Absent unless the bot is being run. The CLI needs neither field. */
  telegramBotToken: string | undefined;
  /** Telegram user ids permitted to use the bot. Empty means the bot refuses to start. */
  telegramAllowedUserIds: number[];
```

and in the returned object:

```ts
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN || undefined;
  // The token is a secret like any RPC key, and for the same reason: it appears inside
  // request URLs that error dumps print verbatim.
  if (telegramBotToken) secrets.push(telegramBotToken);

  const telegramAllowedUserIds = (env.TELEGRAM_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      if (!/^\d+$/.test(part)) {
        throw new ConfigError(
          `TELEGRAM_ALLOWED_USER_IDS contains "${part}", which is not a numeric Telegram ` +
          'user id. Use the numeric ids, comma separated — a @username is not accepted ' +
          'because it can be changed by its owner.',
        );
      }
      return Number(part);
    });
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-verify the secret**

On a branch, remove `if (telegramBotToken) secrets.push(telegramBotToken);` and run the suite. The secrets test must fail. Restore with `git checkout`. Report both results.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/unit/config.test.ts .env.example
git commit -m "feat: parse the Telegram config, with the bot token as a scrubbed secret"
```

---

## Task 4: The Replier port, rendering, and hostile on-chain text

**Files:**
- Create: `src/bot/replier.ts`
- Create: `src/bot/render.ts`
- Test: `test/unit/botRender.test.ts`

**Interfaces:**
- Produces:
  - `interface Replier { reply(text: string): Promise<{ messageId: number }>; edit(messageId: number, text: string): Promise<void>; sendDocument(a: { filename: string; contents: string; caption: string }): Promise<void> }`
  - `makeReplier(ctx): Replier`
  - `sanitizeOnChainText(value: string | null | undefined): string`
  - `MESSAGE_BUDGET = 3500`
  - `renderTable(a: { title: string; headers: string[]; rows: string[][] }): string`
  - `respond(replier: Replier, a: { title: string; headers: string[]; rows: string[][]; filename: string }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`test/unit/botRender.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  MESSAGE_BUDGET, renderTable, respond, sanitizeOnChainText,
} from '../../src/bot/render.js';
import type { Replier } from '../../src/bot/replier.js';

function fakeReplier() {
  const reply = vi.fn(async (_t: string) => ({ messageId: 1 }));
  const edit = vi.fn(async () => undefined);
  const sendDocument = vi.fn(async () => undefined);
  return { replier: { reply, edit, sendDocument } as Replier, reply, edit, sendDocument };
}

describe('sanitizeOnChainText', () => {
  // name() is attacker-controlled. Dropping parse_mode handles Markdown; none of these
  // involve Markdown at all.
  it('strips newlines, which would forge message structure', () => {
    expect(sanitizeOnChainText('Cool\nCollection\r\nFake: 999')).toBe('Cool Collection Fake: 999');
  });

  it('strips control characters', () => {
    expect(sanitizeOnChainText('A\u0000B\u0007C\u001bD')).toBe('ABCD');
  });

  it('strips bidi overrides, which can make text read as something else', () => {
    expect(sanitizeOnChainText('abc‮def‬')).toBe('abcdef');
    expect(sanitizeOnChainText('⁦x⁩')).toBe('x');
  });

  it('collapses whitespace runs', () => {
    expect(sanitizeOnChainText('a     b\t\tc')).toBe('a b c');
  });

  it('truncates a long name rather than letting it eat the message budget', () => {
    const out = sanitizeOnChainText('x'.repeat(2000));
    expect(out.length).toBeLessThanOrEqual(65);
    expect(out.endsWith('…')).toBe(true);
  });

  it('renders an absent name as a placeholder, not as "undefined"', () => {
    expect(sanitizeOnChainText(null)).toBe('(unnamed)');
    expect(sanitizeOnChainText('')).toBe('(unnamed)');
  });
});

describe('respond', () => {
  const small = {
    title: 'First minters', headers: ['wallet', 'minted'],
    rows: [['0xaaa', '3'], ['0xbbb', '1']], filename: 'firstminters-1-0xaaa-123.csv',
  };

  it('sends a message when the output fits', async () => {
    const { replier, reply, sendDocument } = fakeReplier();
    await respond(replier, small);
    expect(reply).toHaveBeenCalledOnce();
    expect(sendDocument).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]![0]).toContain('First minters');
  });

  it('sends a CSV document once the output exceeds the budget', async () => {
    const { replier, reply, sendDocument } = fakeReplier();
    const rows = Array.from({ length: 500 }, (_, i) => [`0x${String(i).padStart(40, '0')}`, '1']);
    await respond(replier, { ...small, rows });
    expect(sendDocument).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    const doc = sendDocument.mock.calls[0]![0];
    expect(doc.contents.split('\n')[0]).toBe('wallet,minted');
    expect(doc.contents.split('\n')).toHaveLength(501);
    expect(doc.caption).toContain('500');
  });

  it('switches on the rendered LENGTH, not on a row count', async () => {
    // One rule for every command, and the real limit is characters.
    const { replier, sendDocument } = fakeReplier();
    await respond(replier, { ...small, rows: [['x'.repeat(MESSAGE_BUDGET + 1), '1']] });
    expect(sendDocument).toHaveBeenCalledOnce();
  });

  it('quotes a CSV field containing a comma or a quote', async () => {
    const { replier, sendDocument } = fakeReplier();
    const rows = Array.from({ length: 400 }, () => ['a,b', 'he said "hi"']);
    await respond(replier, { ...small, rows });
    expect(sendDocument.mock.calls[0]![0].contents).toContain('"a,b"');
    expect(sendDocument.mock.calls[0]![0].contents).toContain('"he said ""hi"""');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/botRender.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the port**

`src/bot/replier.ts`:

```ts
import type { Context } from 'grammy';
import { InputFile } from 'grammy';

/**
 * Everything a command needs from Telegram, and nothing more.
 *
 * Commands take this rather than grammY's `Context` so they unit-test with a fake and
 * no Telegram server. It is also why there is exactly one place that knows about
 * `parse_mode` — namely nowhere, because it is never set.
 */
export interface Replier {
  reply(text: string): Promise<{ messageId: number }>;
  edit(messageId: number, text: string): Promise<void>;
  sendDocument(a: { filename: string; contents: string; caption: string }): Promise<void>;
}

export function makeReplier(ctx: Context): Replier {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) throw new Error('no chat on this update');
  return {
    async reply(text) {
      const sent = await ctx.api.sendMessage(chatId, text);
      return { messageId: sent.message_id };
    },
    async edit(messageId, text) {
      await ctx.api.editMessageText(chatId, messageId, text);
    },
    async sendDocument({ filename, contents, caption }) {
      await ctx.api.sendDocument(
        chatId,
        new InputFile(Buffer.from(contents, 'utf8'), filename),
        { caption },
      );
    },
  };
}
```

- [ ] **Step 4: Implement rendering and sanitisation**

`src/bot/render.ts`:

```ts
import type { Replier } from './replier.js';

/**
 * 3500, not Telegram's 4096.
 *
 * The headroom covers the caption, and keeps a borderline message from being pushed
 * over by its own last row. One threshold for every command, so /overlap across
 * fifteen collections and /firstminters --limit 500 behave the same way.
 */
export const MESSAGE_BUDGET = 3500;

const NAME_LIMIT = 64;
/** C0 and C1 controls. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Bidi embedding and isolate controls, which can make text display as something else. */
const BIDI = /[‪-‮⁦-⁩]/g;

/**
 * Makes on-chain text safe to put in a message.
 *
 * `name()` is attacker-controlled: anyone can deploy a contract. Sending without
 * `parse_mode` handles Markdown, and Markdown is the least of it — a newline forges
 * message structure, control characters corrupt rendering, a bidi override can make
 * the text read as something entirely different, and a 2,000-character name eats the
 * message budget so the real output is pushed into a CSV.
 *
 * This project has met hostile text before: the `İ` index-skew bug in secrets.ts. The
 * lesson was that it needs a boundary, not vigilance at each use. This is that boundary.
 */
export function sanitizeOnChainText(value: string | null | undefined): string {
  if (typeof value !== 'string') return '(unnamed)';
  const cleaned = value.replace(CONTROL, '').replace(BIDI, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return '(unnamed)';
  return cleaned.length > NAME_LIMIT ? `${cleaned.slice(0, NAME_LIMIT)}…` : cleaned;
}

export function renderTable(a: { title: string; headers: string[]; rows: string[][] }): string {
  const lines = [a.title, ''];
  if (a.rows.length === 0) return [a.title, '', '(no rows)'].join('\n');
  for (const row of a.rows) {
    lines.push(a.headers.map((h, i) => `${h}: ${row[i] ?? ''}`).join('  '));
  }
  return lines.join('\n');
}

/** RFC-4180 quoting: a field containing a comma, quote or newline is quoted, quotes doubled. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(a: { headers: string[]; rows: string[][] }): string {
  return [a.headers, ...a.rows].map((row) => row.map(csvField).join(',')).join('\n');
}

/**
 * The ONE output rule, shared by every command.
 *
 * Render, measure, and switch to a document if the text would not fit. Deciding on the
 * rendered length rather than a row count is the point: characters are the actual limit,
 * and a row-count rule would send a CSV for 200 short rows while overflowing on 20 long
 * ones.
 */
export async function respond(
  replier: Replier,
  a: { title: string; headers: string[]; rows: string[][]; filename: string },
): Promise<void> {
  const text = renderTable(a);
  if (text.length <= MESSAGE_BUDGET) {
    await replier.reply(text);
    return;
  }
  await replier.sendDocument({
    filename: a.filename,
    contents: toCsv(a),
    caption: `${a.title} — ${a.rows.length} rows, too long for a message.`,
  });
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run test/unit/botRender.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation-verify the threshold and the sanitiser**

On a branch, make each of these changes in turn, run the suite, and record which tests fail:
1. `MESSAGE_BUDGET = 100000` — the CSV tests must fail.
2. Switch `respond` to `a.rows.length > 50` instead of a length check — the "switches on the rendered LENGTH" test must fail.
3. Remove `.replace(CONTROL, '')` — the control-character test must fail.
4. Remove `.replace(BIDI, '')` — the bidi test must fail.
5. Remove the truncation — the long-name test must fail.
Restore with `git checkout` and report all five.

- [ ] **Step 7: Commit**

```bash
git add src/bot/replier.ts src/bot/render.ts test/unit/botRender.test.ts
git commit -m "feat: Replier port, one output rule, and a boundary for hostile on-chain text"
```

---

## Task 5: The allowlist middleware

**Files:**
- Create: `src/bot/auth.ts`
- Test: `test/unit/botAuth.test.ts`

**Interfaces:**
- Produces: `allowOnly(ids: ReadonlySet<number>, log?: (msg: string) => void): (ctx: AuthContext, next: () => Promise<void>) => Promise<void>` where `AuthContext` is `{ from?: { id: number } }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/botAuth.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { allowOnly } from '../../src/bot/auth.js';

describe('allowOnly', () => {
  const ids = new Set([111, 222]);

  it('passes an allowed user through', async () => {
    const next = vi.fn(async () => undefined);
    await allowOnly(ids)({ from: { id: 111 } }, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('drops an unauthorized user SILENTLY — no reply of any kind', async () => {
    // The requirement is silence, not a polite refusal. Any response, including an
    // error, confirms the bot exists to whoever found its username.
    const next = vi.fn(async () => undefined);
    const api = { sendMessage: vi.fn(), editMessageText: vi.fn(), sendDocument: vi.fn() };
    await allowOnly(ids)({ from: { id: 999 }, api } as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  it('drops an update with no sender at all', async () => {
    const next = vi.fn(async () => undefined);
    await allowOnly(ids)({}, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('logs the rejected id, so attempts are visible to the owner', async () => {
    // A Telegram user id is not a secret, and the owner should be able to see that
    // someone found the bot.
    const log = vi.fn();
    await allowOnly(ids, log)({ from: { id: 999 } }, vi.fn(async () => undefined));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('999'));
  });

  it('refuses to construct with an empty allowlist', async () => {
    expect(() => allowOnly(new Set())).toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/botAuth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/bot/auth.ts`:

```ts
export interface AuthContext {
  from?: { id: number };
}

/**
 * Drops every update from a user not on the allowlist.
 *
 * Registered FIRST, before any handler, because anyone who finds the bot's username can
 * message it.
 *
 * SILENCE IS THE REQUIREMENT. Not calling `next()` is half of it; sending nothing is the
 * other half. A refusal message — however polite — confirms the bot exists and that
 * someone is behind it, which is exactly what a private bot should not volunteer.
 *
 * Constructing with an empty set throws rather than dropping everything, so a
 * misconfiguration surfaces at startup instead of looking like a dead bot.
 */
export function allowOnly(
  ids: ReadonlySet<number>,
  log: (message: string) => void = () => undefined,
) {
  if (ids.size === 0) {
    throw new Error(
      'allowOnly was given an empty allowlist. Every update would be dropped and the ' +
      'bot would look dead. Set TELEGRAM_ALLOWED_USER_IDS.',
    );
  }
  return async function gate(ctx: AuthContext, next: () => Promise<void>): Promise<void> {
    const id = ctx.from?.id;
    if (id === undefined || !ids.has(id)) {
      log(`dropped an update from unauthorized user ${id ?? '(no sender)'}`);
      return;
    }
    await next();
  };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/botAuth.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-verify the gate**

On a branch: change `!ids.has(id)` to `false` so everyone passes. The silent-drop test must fail. Then separately, make the drop branch send a reply before returning; the zero-API-calls assertion must fail. Restore and report both.

- [ ] **Step 6: Commit**

```bash
git add src/bot/auth.ts test/unit/botAuth.test.ts
git commit -m "feat: allowlist middleware that drops unauthorized updates silently"
```

---

## Task 6: Command text to CLI arguments

**Files:**
- Create: `src/bot/args.ts`
- Test: `test/unit/botArgs.test.ts`

**Interfaces:**
- Consumes: `parseArgs`, `ParsedArgs`, `UsageError`.
- Produces: `parseIndexCommand(text: string, defaultChainId: number | undefined): ParsedArgs & { confirmed: boolean }`, `parseQueryCommand(text: string, defaultChainId: number | undefined): { chainId: number; contracts: Address[]; limit: number; min: number }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/botArgs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseIndexCommand, parseQueryCommand } from '../../src/bot/args.js';
import { UsageError } from '../../src/errors.js';

const ADDR = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const ADDR2 = '0xd77b6acabea379b4a838bc9a11bb08d3327eae62';

describe('parseIndexCommand', () => {
  it('reads an address and defaults the level to full', () => {
    expect(parseIndexCommand(`/index ${ADDR}`, 8453)).toMatchObject({
      contract: ADDR, chainId: 8453, level: 'full', confirmed: false,
    });
  });

  it('accepts the level shorthands', () => {
    expect(parseIndexCommand(`/index ${ADDR} --mints-only`, 1).level).toBe('mints_only');
    expect(parseIndexCommand(`/index ${ADDR} --logs-only`, 1).level).toBe('logs_only');
  });

  it('accepts a chain, a bound and a confirmation', () => {
    expect(parseIndexCommand(`/index ${ADDR} --chain 1 --to-block 500 --yes`, 8453))
      .toMatchObject({ chainId: 1, toBlock: 500n, confirmed: true });
  });

  it('lowercases a checksummed address, like the CLI does', () => {
    const mixed = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
    expect(parseIndexCommand(`/index ${mixed}`, 1).contract).toBe(ADDR);
  });

  it('rejects a bare /index with a usage error, rather than crashing or going silent', () => {
    // Review Focus 1.
    expect(() => parseIndexCommand('/index', 1)).toThrow(UsageError);
    expect(() => parseIndexCommand('/index   ', 1)).toThrow(/address/i);
  });

  it('rejects a malformed address through the CLI validator, not a second one', () => {
    expect(() => parseIndexCommand('/index 0xnope', 1)).toThrow(/not a valid address/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseIndexCommand(`/index ${ADDR} --turbo`, 1)).toThrow(UsageError);
  });

  it('tolerates the @botname suffix Telegram adds in groups', () => {
    expect(parseIndexCommand(`/index@byakugan_bot ${ADDR}`, 1).contract).toBe(ADDR);
  });
});

describe('parseQueryCommand', () => {
  it('reads one address and defaults the limit', () => {
    expect(parseQueryCommand(`/firstminters ${ADDR}`, 8453))
      .toMatchObject({ chainId: 8453, contracts: [ADDR], limit: 20, min: 2 });
  });

  it('reads several addresses for overlap', () => {
    expect(parseQueryCommand(`/overlap ${ADDR} ${ADDR2} --min 2`, 1).contracts)
      .toEqual([ADDR, ADDR2]);
  });

  it('DEDUPES repeated addresses', () => {
    // Review Focus 3: without this, one collection counts as two and every wallet that
    // touched it looks like an overlap.
    expect(parseQueryCommand(`/overlap ${ADDR} ${ADDR} ${ADDR2}`, 1).contracts)
      .toEqual([ADDR, ADDR2]);
  });

  it('requires at least one address', () => {
    expect(() => parseQueryCommand('/firstminters', 1)).toThrow(UsageError);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/botArgs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/bot/args.ts`:

```ts
import { isAddress } from 'viem';
import { parseArgs, type ParsedArgs } from '../cli/args.js';
import { UsageError } from '../errors.js';
import type { Address } from '../types.js';

/** Telegram appends @botname to commands in groups. */
function tokens(text: string): string[] {
  return text.trim().split(/\s+/).slice(1).filter((t) => t.length > 0);
}

/**
 * Translates the chat form into the CLI's flag form and hands it to `parseArgs`.
 *
 * ONE VALIDATION PATH, deliberately. Address checking, level checking, lowercasing and
 * the UsageError type all live in the CLI parser, so a bad address produces the same
 * message in both front ends and there is no second implementation to drift. The cost is
 * that the bot's grammar is constrained by the CLI's flags, which is a price worth paying
 * for not having two parsers disagree about what a valid address is.
 */
export function parseIndexCommand(
  text: string,
  defaultChainId: number | undefined,
): ParsedArgs & { confirmed: boolean } {
  const parts = tokens(text);
  const address = parts[0];
  if (address === undefined || address.startsWith('--')) {
    throw new UsageError(
      'Send an address: /index 0x… [--chain N] [--mints-only|--logs-only] [--to-block N]',
    );
  }

  const argv: string[] = ['--contract', address];
  let confirmed = false;
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i]!;
    if (token === '--mints-only') { argv.push('--level', 'mints_only'); continue; }
    if (token === '--logs-only') { argv.push('--level', 'logs_only'); continue; }
    if (token === '--yes') { confirmed = true; continue; }
    argv.push(token);
    const next = parts[i + 1];
    if (next !== undefined && !next.startsWith('--')) { argv.push(next); i++; }
  }
  if (!argv.includes('--level')) argv.push('--level', 'full');

  return { ...parseArgs(argv, defaultChainId), confirmed };
}

export interface QueryArgs {
  chainId: number;
  contracts: Address[];
  limit: number;
  min: number;
}

/**
 * Addresses are DEDUPED. `/overlap 0xA 0xA 0xB` asks about two collections, not three,
 * and counting the repeat would make every wallet that touched 0xA look like it spanned
 * two collections.
 */
export function parseQueryCommand(
  text: string,
  defaultChainId: number | undefined,
): QueryArgs {
  const parts = tokens(text);
  const contracts: Address[] = [];
  let chainId = defaultChainId;
  let limit = 20;
  let min = 2;

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]!;
    if (!token.startsWith('--')) {
      if (!isAddress(token)) {
        throw new UsageError(
          `"${token}" is not a valid address. It must be 0x followed by 40 hex characters.`,
        );
      }
      const lower = token.toLowerCase() as Address;
      if (!contracts.includes(lower)) contracts.push(lower);
      continue;
    }
    const value = parts[++i];
    if (value === undefined) throw new UsageError(`${token} needs a value.`);
    if (token === '--chain') chainId = Number(value);
    else if (token === '--limit') limit = Number(value);
    else if (token === '--min') min = Number(value);
    else throw new UsageError(`unknown option ${token}.`);
  }

  if (contracts.length === 0) throw new UsageError('Send at least one address.');
  if (chainId === undefined || !Number.isInteger(chainId) || chainId <= 0) {
    throw new UsageError('No chain specified and no default is configured. Use --chain N.');
  }
  for (const [name, value] of [['--limit', limit], ['--min', min]] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new UsageError(`${name} must be a whole number of at least 1.`);
    }
  }
  return { chainId, contracts, limit, min };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/botArgs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/args.ts test/unit/botArgs.test.ts
git commit -m "feat: translate command text through the CLI's single validation path"
```

---

## Task 7: The job registry and its three states

**Files:**
- Create: `src/bot/jobs.ts`
- Modify: `src/db/repositories/collections.ts` (add `inspectLock`)
- Test: `test/unit/botJobs.test.ts`

**Interfaces:**
- Consumes: `Clock`, `openDb`, `runMigrations`.
- Produces:
  - `inspectLock(db, chainId: number, contract: string): { lockedBy: string; lockedAt: number } | null`
  - `type JobState = { kind: 'running'; startedAt: number; lastBlock?: number; source: string } | { kind: 'orphaned'; lockedBy: string; lockedAt: number; expiresAt: number } | { kind: 'idle' }`
  - `createJobRegistry(a: { clock: Clock; staleMs: number }): JobRegistry`
  - `interface JobRegistry { inspect(db, a: { chainId: number; contract: string }): JobState; start(a: { chainId: number; contract: string; source: string; run: () => Promise<void>; onError?: (err: unknown) => void }): void; note(a: { chainId: number; contract: string; lastBlock: number }): void; size(): number }`

- [ ] **Step 1: Write the failing tests**

`test/unit/botJobs.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createJobRegistry } from '../../src/bot/jobs.js';
import { inspectLock } from '../../src/db/repositories/collections.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';

const CONTRACT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const STALE_MS = 900_000;

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
  db.prepare('INSERT INTO collections (chain_id, contract, standard) VALUES (1, ?, ?)')
    .run(CONTRACT, '721');
});

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('inspectLock', () => {
  it('is null when nothing holds the lock', () => {
    expect(inspectLock(db, 1, CONTRACT)).toBeNull();
  });

  it('reports the holder and when it was taken', () => {
    db.prepare('UPDATE collections SET locked_by = ?, locked_at = ? WHERE contract = ?')
      .run('job-7', 5_000, CONTRACT);
    expect(inspectLock(db, 1, CONTRACT)).toEqual({ lockedBy: 'job-7', lockedAt: 5_000 });
  });
});

describe('the three states', () => {
  it('is idle with no job and no lock', () => {
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    expect(registry.inspect(db, { chainId: 1, contract: CONTRACT }))
      .toEqual({ kind: 'idle' });
  });

  it('is running for a job in this process, and reports elapsed time', async () => {
    const clock = manualClock(1_000);
    const registry = createJobRegistry({ clock, staleMs: STALE_MS });
    let release: () => void = () => undefined;
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getAssetTransfers',
      run: () => new Promise<void>((r) => { release = r; }),
    });
    const state = registry.inspect(db, { chainId: 1, contract: CONTRACT });
    expect(state).toMatchObject({ kind: 'running', startedAt: 1_000, source: 'getAssetTransfers' });
    release();
    await flush();
  });

  it('is ORPHANED when the lock is held but no job is in the map', () => {
    // The state that only exists after a crash: the map is empty on restart while a stale
    // lock row survives until its timeout. Without this, /index reports "already
    // indexing" for a job that does not exist.
    const clock = manualClock(10_000);
    const registry = createJobRegistry({ clock, staleMs: STALE_MS });
    db.prepare('UPDATE collections SET locked_by = ?, locked_at = ? WHERE contract = ?')
      .run('job-from-a-dead-process', 4_000, CONTRACT);
    expect(registry.inspect(db, { chainId: 1, contract: CONTRACT })).toEqual({
      kind: 'orphaned',
      lockedBy: 'job-from-a-dead-process',
      lockedAt: 4_000,
      expiresAt: 4_000 + STALE_MS,
    });
  });

  it('prefers RUNNING when both the map and the lock are present', async () => {
    const registry = createJobRegistry({ clock: manualClock(2_000), staleMs: STALE_MS });
    db.prepare('UPDATE collections SET locked_by = ?, locked_at = ? WHERE contract = ?')
      .run('job-9', 1_000, CONTRACT);
    let release: () => void = () => undefined;
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs',
      run: () => new Promise<void>((r) => { release = r; }),
    });
    expect(registry.inspect(db, { chainId: 1, contract: CONTRACT }).kind).toBe('running');
    release();
    await flush();
  });

  it('keys on chain AND contract, so the same address on two chains cannot collide', async () => {
    // Review Focus 2.
    db.prepare('INSERT INTO collections (chain_id, contract, standard) VALUES (8453, ?, ?)')
      .run(CONTRACT, '721');
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    let release: () => void = () => undefined;
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs',
      run: () => new Promise<void>((r) => { release = r; }),
    });
    expect(registry.inspect(db, { chainId: 1, contract: CONTRACT }).kind).toBe('running');
    expect(registry.inspect(db, { chainId: 8453, contract: CONTRACT }).kind).toBe('idle');
    release();
    await flush();
  });
});

describe('the detached runner', () => {
  it('clears the map when the job succeeds', async () => {
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    registry.start({ chainId: 1, contract: CONTRACT, source: 'getLogs', run: async () => undefined });
    await flush();
    expect(registry.size()).toBe(0);
    expect(registry.inspect(db, { chainId: 1, contract: CONTRACT }).kind).toBe('idle');
  });

  it('clears the map when the job THROWS, and reports it', async () => {
    // The leak this prevents has no recovery. backfill releases the DB lock in its own
    // finally, so the lock is always correct — but the map has NO expiry, so a leaked
    // entry reports "already indexing" for the life of the process with nothing in the
    // database to show a problem. Strictly worse than the orphan case it impersonates.
    const onError = vi.fn();
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs',
      run: async () => { throw new Error('backfill exploded'); },
      onError,
    });
    await flush();
    expect(registry.size()).toBe(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'backfill exploded' }));
  });

  it('never produces an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs',
      run: async () => { throw new Error('boom'); },
      onError: () => undefined,
    });
    await flush();
    await flush();
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });

  it('refuses to start a second job for the same collection', () => {
    const registry = createJobRegistry({ clock: manualClock(0), staleMs: STALE_MS });
    registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs',
      run: () => new Promise<void>(() => undefined),
    });
    expect(() => registry.start({
      chainId: 1, contract: CONTRACT, source: 'getLogs', run: async () => undefined,
    })).toThrow(/already running/i);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/botJobs.test.ts`
Expected: FAIL — modules and `inspectLock` do not exist.

- [ ] **Step 3: Add `inspectLock` to the collections repository**

```ts
/**
 * Who holds this collection's lock, if anyone.
 *
 * Read-only, and deliberately NOT filtered on `standard IS NOT NULL` like
 * `getCollection` is: a row claimed by a job that then died mid-bootstrap still holds a
 * lock, and the bot has to be able to say so.
 */
export function inspectLock(
  db: Database.Database,
  chainId: number,
  contract: string,
): { lockedBy: string; lockedAt: number } | null {
  const row = db
    .prepare(`
      SELECT locked_by AS lockedBy, locked_at AS lockedAt
        FROM collections
       WHERE chain_id = ? AND contract = ? AND locked_by IS NOT NULL
    `)
    .get(chainId, contract) as { lockedBy: string; lockedAt: number } | undefined;
  return row ?? null;
}
```

- [ ] **Step 4: Implement the registry**

`src/bot/jobs.ts`:

```ts
import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import { inspectLock } from '../db/repositories/collections.js';

export type JobState =
  | { kind: 'running'; startedAt: number; lastBlock?: number; source: string }
  | { kind: 'orphaned'; lockedBy: string; lockedAt: number; expiresAt: number }
  | { kind: 'idle' };

interface Entry { startedAt: number; source: string; lastBlock?: number }

export interface JobRegistry {
  inspect(db: Database.Database, a: { chainId: number; contract: string }): JobState;
  start(a: {
    chainId: number; contract: string; source: string;
    run: () => Promise<void>;
    onError?: (err: unknown) => void;
  }): void;
  note(a: { chainId: number; contract: string; lastBlock: number }): void;
  size(): number;
}

const key = (chainId: number, contract: string): string => `${chainId}:${contract}`;

/**
 * Tracks jobs running in THIS process, over the database lock that tracks them globally.
 *
 * Two sources of truth on purpose, because each answers a question the other cannot. The
 * map knows elapsed time, the fetch path and the current block for a job here and now;
 * the lock knows that SOME process holds this collection, including one that has since
 * died. They disagree after a crash — the map is empty on restart while a stale lock row
 * survives until its timeout — and `inspect` exists to tell those apart rather than
 * reporting "already indexing" for a job that does not exist.
 *
 * The registry owns its map rather than keeping it in module scope, so a test gets a
 * fresh one without resetting global state.
 */
export function createJobRegistry(a: { clock: Clock; staleMs: number }): JobRegistry {
  const running = new Map<string, Entry>();

  return {
    inspect(db, { chainId, contract }) {
      const entry = running.get(key(chainId, contract));
      // The map wins when both are present: it is the more specific fact, and it is this
      // process's own job.
      if (entry) {
        return {
          kind: 'running',
          startedAt: entry.startedAt,
          source: entry.source,
          ...(entry.lastBlock === undefined ? {} : { lastBlock: entry.lastBlock }),
        };
      }
      const lock = inspectLock(db, chainId, contract);
      if (lock) {
        return {
          kind: 'orphaned',
          lockedBy: lock.lockedBy,
          lockedAt: lock.lockedAt,
          expiresAt: lock.lockedAt + a.staleMs,
        };
      }
      return { kind: 'idle' };
    },

    start({ chainId, contract, source, run, onError }) {
      const k = key(chainId, contract);
      if (running.has(k)) {
        throw new Error(`a job for ${k} is already running in this process`);
      }
      running.set(k, { startedAt: a.clock.now(), source });

      // CLEANUP IS IN A `finally` AND THE RUNNER NEVER REJECTS. If cleanup sat in the
      // happy path, a throwing job would leak its map entry — and the map has no expiry,
      // so that collection would report "already indexing" until the process restarted,
      // with nothing in the database to indicate a problem. The DB lock recovers on its
      // own; the map does not. An unhandled rejection from a detached promise should be
      // structurally impossible, not something to remember.
      void (async () => {
        try {
          await run();
        } catch (err) {
          try { onError?.(err); } catch { /* a failing reporter must not break cleanup */ }
        } finally {
          running.delete(k);
        }
      })();
    },

    note({ chainId, contract, lastBlock }) {
      const entry = running.get(key(chainId, contract));
      if (entry) entry.lastBlock = lastBlock;
    },

    size() { return running.size; },
  };
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run test/unit/botJobs.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation-verify the three states and the cleanup**

On a branch, each change separately, running `test/unit/botJobs.test.ts` and recording failures:
1. Make `inspect` return `{ kind: 'running' }` whenever the lock is held — the orphan test must fail.
2. Make `inspect` check the lock before the map — the "prefers RUNNING" test must fail.
3. Key the map on `contract` alone — the two-chains test must fail.
4. Move `running.delete(k)` from the `finally` into the `try` after `await run()` — the throwing-job test must fail.
5. Remove the `try/catch` around `run()` so the promise rejects — the unhandled-rejection test must fail.
Restore and report all five.

- [ ] **Step 7: Commit**

```bash
git add src/bot/jobs.ts src/db/repositories/collections.ts test/unit/botJobs.test.ts
git commit -m "feat: job registry distinguishing a running job from an orphaned lock"
```

---

## Task 8: Throttled progress

**Files:**
- Create: `src/bot/progress.ts`
- Test: `test/unit/botProgress.test.ts`

**Interfaces:**
- Consumes: `Replier`, `Clock`, `isUnchangedEdit`, `retryAfterSeconds`, `Reported`.
- Produces: `createJobProgress(a: { replier: Replier; messageId: number; clock: Clock; intervalMs?: number; header: string }): JobProgress` with `JobProgress = { onChunk(a: { fromBlock: bigint; toBlock: bigint; rows: number; source: string }): Promise<void>; finish(text: string): Promise<void>; fail(reported: Reported, nextCommand?: string): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/botProgress.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createJobProgress } from '../../src/bot/progress.js';
import { manualClock } from '../../src/clock.js';
import type { Replier } from '../../src/bot/replier.js';

function setup(over: { edit?: Replier['edit'] } = {}) {
  const clock = manualClock(0);
  const edits: string[] = [];
  const edit = over.edit ?? vi.fn(async (_id: number, text: string) => { edits.push(text); });
  const replier = { reply: vi.fn(), edit, sendDocument: vi.fn() } as unknown as Replier;
  const progress = createJobProgress({
    replier, messageId: 42, clock, intervalMs: 4_000, header: 'indexing 0xaaa on chain 1',
  });
  return { clock, edits, edit, progress };
}

const chunk = (to: number, rows: number) => ({
  fromBlock: BigInt(to - 9), toBlock: BigInt(to), rows, source: 'getAssetTransfers',
});

describe('throttling', () => {
  it('edits on the first chunk, so the user sees it is alive', async () => {
    const { progress, edits } = setup();
    await progress.onChunk(chunk(10, 1));
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('getAssetTransfers');
  });

  it('suppresses chunks inside the interval', async () => {
    const { progress, edits, clock } = setup();
    await progress.onChunk(chunk(10, 1));
    for (let i = 0; i < 20; i++) {
      clock.advance(100);
      await progress.onChunk(chunk(20 + i * 10, i + 2));
    }
    expect(edits).toHaveLength(1);
  });

  it('edits again once the interval has passed', async () => {
    const { progress, edits, clock } = setup();
    await progress.onChunk(chunk(10, 1));
    clock.advance(4_000);
    await progress.onChunk(chunk(20, 2));
    expect(edits).toHaveLength(2);
  });
});

describe('Telegram-specific behaviour', () => {
  it('skips an edit whose text is unchanged', async () => {
    // An unchanged edit is an ERROR, not a no-op. This happens routinely when a slow
    // chunk has not moved the numbers between ticks.
    const { progress, edit, clock } = setup();
    await progress.onChunk(chunk(10, 5));
    clock.advance(10_000);
    await progress.onChunk(chunk(10, 5));
    expect(edit).toHaveBeenCalledOnce();
  });

  it('swallows the unchanged-edit error if one arrives anyway', async () => {
    const edit = vi.fn(async () => {
      throw Object.assign(new Error('x'), {
        error_code: 400, description: 'Bad Request: message is not modified',
      });
    });
    const { progress } = setup({ edit });
    await expect(progress.onChunk(chunk(10, 1))).resolves.toBeUndefined();
  });

  it('DROPS a rate-limited edit rather than queueing it', async () => {
    // A stale progress line has no value, and queueing converts one rate-limit into a
    // backlog that outlives the job.
    const edit = vi.fn(async () => {
      throw Object.assign(new Error('x'), {
        error_code: 429, description: 'Too Many Requests: retry after 5',
        parameters: { retry_after: 5 },
      });
    });
    const { progress, clock } = setup({ edit });
    await progress.onChunk(chunk(10, 1));
    clock.advance(4_000);
    await progress.onChunk(chunk(20, 2));
    // Still inside the 5s Telegram asked for, so no second attempt.
    expect(edit).toHaveBeenCalledOnce();
    clock.advance(2_000);
    await progress.onChunk(chunk(30, 3));
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it('lets a transport error propagate rather than hiding a real failure', async () => {
    const edit = vi.fn(async () => { throw new Error('socket hang up'); });
    const { progress } = setup({ edit });
    await expect(progress.onChunk(chunk(10, 1))).rejects.toThrow('socket hang up');
  });
});

describe('finish and fail always land', () => {
  it('finish ignores the throttle', async () => {
    const { progress, edits } = setup();
    await progress.onChunk(chunk(10, 1));
    await progress.finish('done: 152 rows');
    expect(edits.at(-1)).toContain('done: 152 rows');
  });

  it('a late chunk cannot overwrite the final message', async () => {
    // Review Focus 4: a throttled tick in flight must not clobber the result.
    const { progress, edits, clock } = setup();
    await progress.finish('done: 152 rows');
    clock.advance(60_000);
    await progress.onChunk(chunk(999, 99));
    expect(edits.at(-1)).toContain('done: 152 rows');
  });

  it('fail reports the error and its next command', async () => {
    const { progress, edits } = setup();
    await progress.fail(
      { exitCode: 2, headline: 'Enrichment level conflicts', detail: 'indexed at mints_only' },
      '/index 0xaaa --chain 1',
    );
    expect(edits.at(-1)).toContain('Enrichment level conflicts');
    expect(edits.at(-1)).toContain('/index 0xaaa --chain 1');
  });

  it('retries the final edit once after retry_after', async () => {
    let call = 0;
    const edit = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        throw Object.assign(new Error('x'), {
          error_code: 429, description: 'Too Many Requests: retry after 1',
          parameters: { retry_after: 1 },
        });
      }
    });
    const { progress } = setup({ edit });
    await progress.finish('done');
    expect(edit).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/botProgress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/bot/progress.ts`:

```ts
import type { Clock } from '../clock.js';
import type { Reported } from '../report.js';
import { isUnchangedEdit, retryAfterSeconds } from '../telegram/failures.js';
import type { Replier } from './replier.js';

export interface JobProgress {
  onChunk(a: { fromBlock: bigint; toBlock: bigint; rows: number; source: string }): Promise<void>;
  finish(text: string): Promise<void>;
  fail(reported: Reported, nextCommand?: string): Promise<void>;
}

/**
 * One message, edited as the job runs.
 *
 * Telegram allows roughly one message per second per chat and counts edits, so a chunk
 * is not a tick: at the measured 10-block getLogs cap a large backfill is tens of
 * thousands of chunks, and editing per chunk would be rate-limited within seconds.
 *
 * Three behaviours here are Telegram's, not choices:
 *   - An edit whose text is UNCHANGED is an error, not a no-op, so identical renders are
 *     skipped before they are sent.
 *   - A 429 carries `retry_after`, on a budget separate from Alchemy's. The edit is
 *     DROPPED rather than queued: a stale progress line has no value, and queueing turns
 *     one rate-limit into a backlog that outlives the job.
 *   - `finish` and `fail` bypass the throttle and retry once. A reporter that can swallow
 *     its last line leaves the user unable to tell a finished job from a hung one.
 */
export function createJobProgress(a: {
  replier: Replier;
  messageId: number;
  clock: Clock;
  intervalMs?: number;
  header: string;
}): JobProgress {
  const intervalMs = a.intervalMs ?? 4_000;
  let lastSentAt: number | null = null;
  let lastText: string | null = null;
  let mutedUntil = 0;
  let finished = false;

  const send = async (text: string): Promise<void> => {
    if (text === lastText) return;         // unchanged edits throw; skip before sending
    try {
      await a.replier.edit(a.messageId, text);
      lastText = text;
      lastSentAt = a.clock.now();
    } catch (err) {
      if (isUnchangedEdit(err)) { lastText = text; return; }
      const wait = retryAfterSeconds(err);
      if (wait !== undefined) { mutedUntil = a.clock.now() + wait * 1_000; return; }
      throw err;                            // a transport failure is not ours to hide
    }
  };

  return {
    async onChunk({ fromBlock, toBlock, rows, source }) {
      // The final message is the result; a tick still in flight must not clobber it.
      if (finished) return;
      const now = a.clock.now();
      if (now < mutedUntil) return;
      if (lastSentAt !== null && now - lastSentAt < intervalMs) return;
      const elapsed = Math.round((now - (lastSentAt ?? now)) / 1_000);
      await send(
        `${a.header}\n` +
        `  via ${source}\n` +
        `  blocks ${fromBlock}-${toBlock}\n` +
        `  rows ${rows}` +
        (elapsed > 0 ? `  (+${elapsed}s)` : ''),
      );
    },

    async finish(text) {
      finished = true;
      await forceSend(a, text, () => { lastText = null; }, send);
    },

    async fail(reported, nextCommand) {
      finished = true;
      const lines = [`${a.header}`, '', `failed: ${reported.headline}`, '', `  ${reported.detail}`];
      if (reported.hint) lines.push('', `  ${reported.hint}`);
      if (nextCommand) lines.push('', `  next: ${nextCommand}`);
      await forceSend(a, lines.join('\n'), () => { lastText = null; }, send);
    },
  };
}

/**
 * Sends past the throttle, retrying ONCE after `retry_after`.
 *
 * Once, not repeatedly: the point is that the last line lands, and a job that cannot post
 * its result after two attempts has a problem that more attempts will not fix.
 */
async function forceSend(
  a: { replier: Replier; messageId: number; clock: Clock },
  text: string,
  clearCache: () => void,
  send: (text: string) => Promise<void>,
): Promise<void> {
  clearCache();
  try {
    await a.replier.edit(a.messageId, text);
    return;
  } catch (err) {
    if (isUnchangedEdit(err)) return;
    const wait = retryAfterSeconds(err);
    if (wait === undefined) throw err;
    await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1_000));
    await a.replier.edit(a.messageId, text);
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/botProgress.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-verify**

On a branch, each separately:
1. Make `finish` respect the throttle — "finish ignores the throttle" must fail.
2. Remove the `if (finished) return;` guard in `onChunk` — the late-chunk test must fail.
3. Remove the `text === lastText` check — the unchanged-skip test must fail.
4. Queue instead of dropping on 429 (retry inside `onChunk`) — the drop test must fail.
5. Swallow a transport error instead of rethrowing — the propagation test must fail.
Restore and report all five.

- [ ] **Step 6: Commit**

```bash
git add src/bot/progress.ts test/unit/botProgress.test.ts
git commit -m "feat: throttled progress that drops stale edits and always posts its result"
```

---

## Task 9: /index with the confirmation gate

**Files:**
- Create: `src/bot/commands/index.ts`
- Test: `test/unit/botIndexCommand.test.ts`

**Interfaces:**
- Consumes: `parseIndexCommand`, `JobRegistry`, `createJobProgress`, `backfill`, `estimateBackfill`, `probeEffectiveChunk`, `describeError`, `respond`.
- Produces:
  - `nextCommand(err: unknown, a: { contract: string; chainId: number }): string | undefined`
  - `handleIndex(a: HandleIndexDeps): Promise<void>` where `HandleIndexDeps` carries `{ text, replier, db, registry, config, chainConfig, ports, clock, confirmThresholdSeconds }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/botIndexCommand.test.ts`. These drive the handler with a fake `Replier`, an in-memory database and stub ports — no Telegram and no chain.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { handleIndex, nextCommand } from '../../src/bot/commands/index.js';
import { createJobRegistry } from '../../src/bot/jobs.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  DeployBlockUnavailableError, EnrichmentLevelError, UsageError,
} from '../../src/errors.js';
import type { Replier } from '../../src/bot/replier.js';

const ADDR = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const flush = () => new Promise<void>((r) => setImmediate(r));

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:'); runMigrations(db); });

function deps(over: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const edits: string[] = [];
  const replier = {
    reply: vi.fn(async (t: string) => { sent.push(t); return { messageId: 1 }; }),
    edit: vi.fn(async (_id: number, t: string) => { edits.push(t); }),
    sendDocument: vi.fn(),
  } as unknown as Replier;
  const clock = manualClock(0);
  return {
    sent, edits, replier, clock,
    base: {
      replier, db, clock,
      registry: createJobRegistry({ clock, staleMs: 900_000 }),
      defaultChainId: 1,
      chainConfig: { name: 'ethereum', initialChunk: 10, maxChunk: 10, confirmations: 12 },
      computeUnitsPerSecond: 300,
      runBackfill: vi.fn(async () => ({
        status: 'indexed' as const, source: 'getAssetTransfers' as const, standard: '721' as const,
        deployBlock: 1, fromBlock: 1, toBlock: 100, chunks: 1, rowsInserted: 5,
        lastIndexedBlock: 100,
      })),
      estimateSeconds: vi.fn(async () => 30),
      confirmThresholdSeconds: 300,
      fetchPath: 'getAssetTransfers',
      ...over,
    },
  };
}

describe('nextCommand', () => {
  it('offers a re-index for an enrichment-level refusal', () => {
    expect(nextCommand(new EnrichmentLevelError('x'), { contract: ADDR, chainId: 8453 }))
      .toBe(`/index ${ADDR} --chain 8453`);
  });

  it('offers a deploy-block override when the block cannot be resolved', () => {
    expect(nextCommand(new DeployBlockUnavailableError('x'), { contract: ADDR, chainId: 1 }))
      .toContain('--deploy-block');
  });

  it('offers /help for a usage error', () => {
    expect(nextCommand(new UsageError('x'), { contract: ADDR, chainId: 1 })).toBe('/help');
  });

  it('is undefined when no command would help', () => {
    expect(nextCommand(new Error('internal'), { contract: ADDR, chainId: 1 })).toBeUndefined();
  });
});

describe('handleIndex', () => {
  it('replies immediately and runs the job detached', async () => {
    const { base, sent, replier } = deps();
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    expect(replier.reply).toHaveBeenCalledOnce();
    expect(sent[0]).toContain('level full');
    expect(base.registry.inspect(db, { chainId: 1, contract: ADDR }))
      .toMatchObject({ source: 'getAssetTransfers' });
    await flush();
    expect(base.runBackfill).toHaveBeenCalledOnce();
  });

  it('STATES the level used, so a later refusal is traceable', async () => {
    const { base, sent } = deps();
    await handleIndex({ ...base, text: `/index ${ADDR} --mints-only` });
    expect(sent[0]).toContain('mints_only');
  });

  it('asks for confirmation when the estimate exceeds the threshold', async () => {
    const { base, sent } = deps({ estimateSeconds: vi.fn(async () => 7_200) });
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    expect(sent[0]).toMatch(/2\.0 hours/);
    expect(sent[0]).toContain('--yes');
    await flush();
    expect(base.runBackfill).not.toHaveBeenCalled();
  });

  it('runs without asking when --yes is given', async () => {
    const { base } = deps({ estimateSeconds: vi.fn(async () => 7_200) });
    await handleIndex({ ...base, text: `/index ${ADDR} --yes` });
    await flush();
    expect(base.runBackfill).toHaveBeenCalledOnce();
  });

  it('reports a RUNNING job with its elapsed time', async () => {
    const { base, sent, clock } = deps({
      runBackfill: vi.fn(() => new Promise(() => undefined)),
    });
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    clock.advance(180_000);
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    expect(sent.at(-1)).toMatch(/already indexing/i);
    expect(sent.at(-1)).toContain('3 minutes');
  });

  it('reports an ORPHANED lock differently, with when it expires', async () => {
    // The distinction matters: "running" means wait for it; "orphaned" means it clears
    // itself. Reporting both as "already indexing" would leave the user waiting for a job
    // that does not exist.
    const { base, sent } = deps();
    db.prepare('INSERT INTO collections (chain_id, contract, standard, locked_by, locked_at) VALUES (1, ?, ?, ?, ?)')
      .run(ADDR, '721', 'dead-job', 0);
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    expect(sent.at(-1)).toMatch(/previous run/i);
    expect(sent.at(-1)).toMatch(/15 minutes/);
    expect(base.runBackfill).not.toHaveBeenCalled();
  });

  it('reports a usage error without starting anything', async () => {
    const { base, sent } = deps();
    await handleIndex({ ...base, text: '/index' });
    expect(sent[0]).toMatch(/Send an address/);
    expect(base.runBackfill).not.toHaveBeenCalled();
  });

  it('edits the message with the failure when the job throws', async () => {
    const { base, edits } = deps({
      runBackfill: vi.fn(async () => { throw new EnrichmentLevelError('indexed at mints_only'); }),
    });
    await handleIndex({ ...base, text: `/index ${ADDR}` });
    await flush();
    await flush();
    expect(edits.at(-1)).toContain('Enrichment level');
    expect(edits.at(-1)).toContain(`/index ${ADDR}`);
    expect(base.registry.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/botIndexCommand.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/bot/commands/index.ts`. Keep the handler thin: parse, inspect, estimate, reply, start. The deps are injected so the test above needs no chain.

```ts
import type Database from 'better-sqlite3';
import type { Clock } from '../../clock.js';
import {
  DeployBlockUnavailableError, EnrichmentLevelError, CollectionLockedError, UsageError,
} from '../../errors.js';
import { humanizeSeconds } from '../../cli/estimate.js';
import { describeError } from '../../report.js';
import { parseIndexCommand } from '../args.js';
import type { JobRegistry } from '../jobs.js';
import { createJobProgress } from '../progress.js';
import type { Replier } from '../replier.js';
import type { BackfillResult } from '../../indexer/backfill.js';

/**
 * A tappable command that would help, where one exists.
 *
 * Deliberately a table of COMMANDS rather than a second message mapping: the prose comes
 * from `describeError`, which both front ends share. "Re-index at full" reads worse in a
 * chat than the command itself, and chat affordances have no business in a shared module.
 */
export function nextCommand(
  err: unknown,
  a: { contract: string; chainId: number },
): string | undefined {
  if (err instanceof EnrichmentLevelError) return `/index ${a.contract} --chain ${a.chainId}`;
  if (err instanceof DeployBlockUnavailableError) {
    return `/index ${a.contract} --chain ${a.chainId} --deploy-block <block>`;
  }
  if (err instanceof CollectionLockedError) return `/status ${a.contract}`;
  if (err instanceof UsageError) return '/help';
  return undefined;
}

export interface HandleIndexDeps {
  text: string;
  replier: Replier;
  db: Database.Database;
  clock: Clock;
  registry: JobRegistry;
  defaultChainId: number | undefined;
  chainConfig: { name: string };
  /**
   * Which source the run will use, for the registry and the progress line.
   *
   * Passed in rather than read off the result, because the result only exists when the
   * job ENDS and the progress line has to name it from the first edit. Naming it is the
   * whole point: a capability probe wired into the dry-run path only meant every real CLI
   * run silently used getLogs, finishing correctly in seventy chunks where one page would
   * have done, and nothing in the output said so.
   */
  fetchPath: string;
  runBackfill(a: {
    chainId: number; contract: string; level: string; toBlock?: bigint;
    onProgress(ctx: { fromBlock: bigint; toBlock: bigint; inserted: number }): void;
  }): Promise<BackfillResult>;
  /** Seconds the run is expected to take. Injected so the handler needs no chain. */
  estimateSeconds(a: { chainId: number; contract: string; toBlock?: bigint }): Promise<number>;
  confirmThresholdSeconds: number;
}

export async function handleIndex(d: HandleIndexDeps): Promise<void> {
  let args: ReturnType<typeof parseIndexCommand>;
  try {
    args = parseIndexCommand(d.text, d.defaultChainId);
  } catch (err) {
    const reported = describeError(err);
    await d.replier.reply(`${reported.headline}\n\n  ${reported.detail}`);
    return;
  }

  const { contract, chainId, level, toBlock, confirmed } = args;

  const state = d.registry.inspect(d.db, { chainId, contract });
  if (state.kind === 'running') {
    const minutes = Math.round((d.clock.now() - state.startedAt) / 60_000);
    await d.replier.reply(
      `Already indexing ${contract} on chain ${chainId}.\n` +
      `  started ${minutes} minutes ago, via ${state.source}` +
      (state.lastBlock === undefined ? '' : `, at block ${state.lastBlock}`) + '\n' +
      '  Wait for it to finish — /status for detail.',
    );
    return;
  }
  if (state.kind === 'orphaned') {
    // NOT the same as running. A previous process died holding the lock; nothing is
    // working on this collection and the lock clears itself.
    const minutes = Math.max(0, Math.round((state.expiresAt - d.clock.now()) / 60_000));
    await d.replier.reply(
      `A previous run left a lock on ${contract} (chain ${chainId}) and did not release it.\n` +
      `  Nothing is indexing it now. The lock expires in ${minutes} minutes and clears itself.\n` +
      '  Try again after that.',
    );
    return;
  }

  const seconds = await d.estimateSeconds({ chainId, contract, toBlock });
  if (!confirmed && seconds > d.confirmThresholdSeconds) {
    await d.replier.reply(
      `Indexing ${contract} on chain ${chainId} at level ${level} is estimated at ` +
      `${humanizeSeconds(seconds)}.\n` +
      '  A started job cannot be cancelled and holds the collection lock.\n' +
      `  To go ahead: /index ${contract} --chain ${chainId} --yes`,
    );
    return;
  }

  const sent = await d.replier.reply(
    `Indexing ${contract} on chain ${chainId} (${d.chainConfig.name}) at level ${level}.\n` +
    `  estimated ${humanizeSeconds(seconds)}; progress follows in this message.`,
  );

  const progress = createJobProgress({
    replier: d.replier, messageId: sent.messageId, clock: d.clock,
    header: `Indexing ${contract} on chain ${chainId} at level ${level}`,
  });

  d.registry.start({
    chainId, contract, source: d.fetchPath,
    onError: (err) => {
      void progress.fail(describeError(err), nextCommand(err, { contract, chainId }));
    },
    run: async () => {
      let rows = 0;
      const result = await d.runBackfill({
        chainId, contract, level, ...(toBlock === undefined ? {} : { toBlock }),
        onProgress: (ctx) => {
          rows += ctx.inserted;
          d.registry.note({ chainId, contract, lastBlock: Number(ctx.toBlock) });
          void progress.onChunk({
            fromBlock: ctx.fromBlock, toBlock: ctx.toBlock, rows, source: d.fetchPath,
          });
        },
      });
      await progress.finish(
        result.status === 'indexed'
          ? `Indexed ${contract} on chain ${chainId} at level ${level}.\n` +
            `  ERC-${result.standard}, deploy block ${result.deployBlock}\n` +
            `  ${result.rowsInserted} rows in ${result.chunks} chunk(s), via ${result.source}\n` +
            `  indexed through block ${result.lastIndexedBlock}`
          : `Nothing to do for ${contract}: ${result.reason}`,
      );
    },
  });
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/botIndexCommand.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-verify the running/orphaned distinction**

On a branch, collapse the two branches into one "already indexing" reply. The orphaned test must fail. Restore and report.

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/index.ts test/unit/botIndexCommand.test.ts
git commit -m "feat: /index with a confirmation gate and distinct running vs orphaned replies"
```

---

## Task 10: /status

**Files:**
- Create: `src/bot/commands/status.ts`
- Test: `test/unit/botStatus.test.ts`

**Interfaces:**
- Consumes: `getCollection` and `inspectLock` (collections.ts), `getEnrichmentLevel` (enrichment.ts), `countByKind` (transfers.ts), `JobRegistry`, `sanitizeOnChainText`, `respond`.
- Produces: `handleStatus(a: { text: string; replier: Replier; db: Database.Database; clock: Clock; registry: JobRegistry; defaultChainId: number | undefined; staleMs: number }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`test/unit/botStatus.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { handleStatus } from '../../src/bot/commands/status.js';
import { createJobRegistry } from '../../src/bot/jobs.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { insertTransfers } from '../../src/db/repositories/transfers.js';
import type { Replier } from '../../src/bot/replier.js';

const ADDR = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const MINTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ZERO = '0x0000000000000000000000000000000000000000';

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:'); runMigrations(db); });

function setup() {
  const sent: string[] = [];
  const replier = {
    reply: vi.fn(async (t: string) => { sent.push(t); return { messageId: 1 }; }),
    edit: vi.fn(), sendDocument: vi.fn(),
  } as unknown as Replier;
  const clock = manualClock(600_000);
  return {
    sent, replier,
    base: {
      replier, db, clock, defaultChainId: 1, staleMs: 900_000,
      registry: createJobRegistry({ clock, staleMs: 900_000 }),
    },
  };
}

function indexed(name: string | null = 'Test Collection') {
  db.prepare(`
    INSERT INTO collections
      (chain_id, contract, standard, name, deploy_block, deploy_block_source,
       deploy_block_validated, enrichment_level, last_indexed_block)
    VALUES (1, ?, '721', ?, 100, 'binary_search', 1, 'full', 500)
  `).run(ADDR, name);
  insertTransfers(db, [{
    chainId: 1, contract: ADDR, tokenId: '1', amount: '1', fromAddr: ZERO, toAddr: MINTER,
    txHash: '0xtx', blockNumber: 200, logIndex: 0, batchIndex: 0,
    txFrom: MINTER, txValueWei: '0', kind: 'mint',
  }]);
}

describe('handleStatus', () => {
  it('says a collection is not indexed, and names /index', async () => {
    const { base, sent } = setup();
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toMatch(/not indexed/i);
    expect(sent[0]).toContain(`/index ${ADDR}`);
  });

  it('reports standard, deploy block, watermark, level and counts', async () => {
    const { base, sent } = setup();
    indexed();
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toContain('ERC-721');
    expect(sent[0]).toContain('100');
    expect(sent[0]).toContain('500');
    expect(sent[0]).toContain('full');
    expect(sent[0]).toMatch(/mint\D*1/);
  });

  it('SANITISES the collection name', async () => {
    const { base, sent } = setup();
    indexed('Evil\nCollection‮');
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toContain('Evil Collection');
    expect(sent[0]).not.toContain('\n Evil');
    expect(sent[0]).not.toContain('‮');
  });

  it('reports a running job', async () => {
    const { base, sent } = setup();
    indexed();
    base.registry.start({
      chainId: 1, contract: ADDR, source: 'getAssetTransfers',
      run: () => new Promise(() => undefined),
    });
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toMatch(/indexing now/i);
  });

  it('reports an orphaned lock as such', async () => {
    const { base, sent } = setup();
    indexed();
    db.prepare('UPDATE collections SET locked_by = ?, locked_at = ? WHERE contract = ?')
      .run('dead', 0, ADDR);
    await handleStatus({ ...base, text: `/status ${ADDR}` });
    expect(sent[0]).toMatch(/orphan|previous run/i);
  });

  it('lists indexed collections when given no address', async () => {
    const { base, sent } = setup();
    indexed();
    await handleStatus({ ...base, text: '/status' });
    expect(sent[0]).toContain(ADDR);
  });

  it('says so when nothing has been indexed at all', async () => {
    const { base, sent } = setup();
    await handleStatus({ ...base, text: '/status' });
    expect(sent[0]).toMatch(/nothing indexed yet/i);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/botStatus.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/bot/commands/status.ts`. Read the collection row directly for the fields `getCollection` does not expose (name, source, validated), use `getCollection` for the indexed/not-indexed decision so the `standard IS NOT NULL` guard is not duplicated, and render through `sanitizeOnChainText`.

```ts
import type Database from 'better-sqlite3';
import type { Clock } from '../../clock.js';
import { getCollection } from '../../db/repositories/collections.js';
import { getEnrichmentLevel } from '../../db/repositories/enrichment.js';
import { countByKind } from '../../db/repositories/transfers.js';
import { parseQueryCommand } from '../args.js';
import type { JobRegistry } from '../jobs.js';
import { sanitizeOnChainText } from '../render.js';
import type { Replier } from '../replier.js';
import { describeError } from '../../report.js';

export async function handleStatus(a: {
  text: string;
  replier: Replier;
  db: Database.Database;
  clock: Clock;
  registry: JobRegistry;
  defaultChainId: number | undefined;
  staleMs: number;
}): Promise<void> {
  const hasAddress = a.text.trim().split(/\s+/).length > 1;
  if (!hasAddress) {
    const rows = a.db.prepare(`
      SELECT chain_id AS chainId, contract, enrichment_level AS level,
             last_indexed_block AS watermark
        FROM collections
       WHERE standard IS NOT NULL
       ORDER BY indexed_at DESC NULLS LAST
       LIMIT 20
    `).all() as Array<{ chainId: number; contract: string; level: string; watermark: number }>;
    if (rows.length === 0) {
      await a.replier.reply('Nothing indexed yet. Start with /index 0x…');
      return;
    }
    await a.replier.reply(
      ['Indexed collections', '', ...rows.map((r) =>
        `chain ${r.chainId}  ${r.contract}  ${r.level}  through ${r.watermark}`)].join('\n'),
    );
    return;
  }

  let parsed;
  try {
    parsed = parseQueryCommand(a.text, a.defaultChainId);
  } catch (err) {
    const reported = describeError(err);
    await a.replier.reply(`${reported.headline}\n\n  ${reported.detail}`);
    return;
  }
  const contract = parsed.contracts[0]!;
  const chainId = parsed.chainId;

  const state = getCollection(a.db, chainId, contract);
  const job = a.registry.inspect(a.db, { chainId, contract });

  if (state.state === 'not_indexed') {
    const extra = job.kind === 'orphaned'
      ? `\n  A previous run left a lock; it expires in ` +
        `${Math.max(0, Math.round((job.expiresAt - a.clock.now()) / 60_000))} minutes.`
      : '';
    await a.replier.reply(
      `${contract} on chain ${chainId} is not indexed.${extra}\n  /index ${contract} --chain ${chainId}`,
    );
    return;
  }

  const extra = a.db.prepare(`
    SELECT name, deploy_block_source AS source, deploy_block_validated AS validated
      FROM collections WHERE chain_id = ? AND contract = ?
  `).get(chainId, contract) as { name: string | null; source: string; validated: number };
  const counts = countByKind(a.db, chainId, contract);
  const level = getEnrichmentLevel(a.db, chainId, contract);

  const jobLine = job.kind === 'running'
    ? `  indexing now, started ${Math.round((a.clock.now() - job.startedAt) / 60_000)} minutes ago`
    : job.kind === 'orphaned'
      ? `  a previous run left an orphaned lock, expiring in ` +
        `${Math.max(0, Math.round((job.expiresAt - a.clock.now()) / 60_000))} minutes`
      : '  no job running';

  await a.replier.reply([
    `${sanitizeOnChainText(extra.name)}  ${contract}`,
    `  chain ${chainId}, ERC-${state.standard}`,
    `  deploy block ${state.deployBlock} (${extra.source}` +
      `${extra.validated === 1 ? ', validated' : ', NOT validated'})`,
    `  indexed through ${state.lastIndexedBlock}, level ${level ?? 'unknown'}`,
    `  mint ${counts.mint}  buy ${counts.buy}  transfer ${counts.transfer}  ` +
      `burn ${counts.burn}  unclassified ${counts.unclassified}`,
    jobLine,
  ].join('\n'));
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/botStatus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/status.ts test/unit/botStatus.test.ts
git commit -m "feat: /status reporting index state and job state separately"
```

---

## Task 11: /firstminters and /overlap

**Files:**
- Create: `src/bot/commands/queries.ts`
- Test: `test/unit/botQueries.test.ts`

**Interfaces:**
- Consumes: `firstMinters`, `firstRecipients`, `overlap`, `getCollection`, `parseQueryCommand`, `respond`, `describeError`, `nextCommand`.
- Produces: `handleFirstMinters(a: QueryDeps): Promise<void>`, `handleOverlap(a: QueryDeps): Promise<void>` with `QueryDeps = { text: string; replier: Replier; db: Database.Database; defaultChainId: number | undefined }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/botQueries.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { handleFirstMinters, handleOverlap } from '../../src/bot/commands/queries.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { insertTransfers } from '../../src/db/repositories/transfers.js';
import { setEnrichmentLevel } from '../../src/db/repositories/enrichment.js';
import type { Replier } from '../../src/bot/replier.js';
import type { TransferRow } from '../../src/types.js';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';
const WALLET = '0xcccccccccccccccccccccccccccccccccccccce1';
const ZERO = '0x0000000000000000000000000000000000000000';

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
});

function setup() {
  const sent: string[] = [];
  const docs: Array<{ filename: string; contents: string; caption: string }> = [];
  const replier = {
    reply: vi.fn(async (t: string) => { sent.push(t); return { messageId: 1 }; }),
    edit: vi.fn(),
    sendDocument: vi.fn(async (d: never) => { docs.push(d); }),
  } as unknown as Replier;
  return { sent, docs, base: { replier, db, defaultChainId: 1 } };
}

function collection(contract: string) {
  db.prepare(`
    INSERT INTO collections (chain_id, contract, standard, deploy_block, last_indexed_block)
    VALUES (1, ?, '721', 1, 100)
  `).run(contract);
}

function mint(contract: string, to: string, token: number, block: number): TransferRow {
  return {
    chainId: 1, contract, tokenId: String(token), amount: '1', fromAddr: ZERO, toAddr: to,
    txHash: `0x${String(token).padStart(64, '0')}`, blockNumber: block, logIndex: 0,
    batchIndex: 0, txFrom: to, txValueWei: '0', kind: 'mint',
  };
}

describe('handleFirstMinters', () => {
  it('says NOT INDEXED rather than returning an empty list', async () => {
    // Review Focus 5: an empty result and an unknown collection are different answers,
    // and rendering both as "no rows" hides a missing index behind a plausible result.
    const { base, sent } = setup();
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent[0]).toMatch(/not indexed/i);
    expect(sent[0]).toContain(`/index ${A}`);
  });

  it('reports minters with their counts', async () => {
    const { base, sent } = setup();
    collection(A);
    insertTransfers(db, [mint(A, WALLET, 1, 10), mint(A, WALLET, 2, 11)]);
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent[0]).toContain(WALLET);
    expect(sent[0]).toContain('2');
  });

  it('sends a CSV when the output is long', async () => {
    const { base, docs } = setup();
    collection(A);
    insertTransfers(db, Array.from({ length: 300 }, (_, i) =>
      mint(A, `0x${String(i).padStart(40, '0')}`, i + 1, 10 + i)));
    await handleFirstMinters({ ...base, text: `/firstminters ${A} --limit 300` });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.filename).toContain(A);
  });

  it('surfaces the enrichment refusal with a next command', async () => {
    const { base, sent } = setup();
    collection(A);
    setEnrichmentLevel(db, { chainId: 1, contract: A, level: 'logs_only' });
    insertTransfers(db, [{ ...mint(A, WALLET, 1, 10), txFrom: null, txValueWei: null }]);
    await handleFirstMinters({ ...base, text: `/firstminters ${A}` });
    expect(sent[0]).toMatch(/minting wallet/i);
    expect(sent[0]).toContain(`/index ${A}`);
  });
});

describe('handleOverlap', () => {
  it('requires at least two collections', async () => {
    const { base, sent } = setup();
    await handleOverlap({ ...base, text: `/overlap ${A}` });
    expect(sent[0]).toMatch(/at least two/i);
  });

  it('treats a repeated address as one collection', async () => {
    // Review Focus 3.
    const { base, sent } = setup();
    await handleOverlap({ ...base, text: `/overlap ${A} ${A}` });
    expect(sent[0]).toMatch(/at least two/i);
  });

  it('names every collection that is not indexed', async () => {
    const { base, sent } = setup();
    collection(A);
    await handleOverlap({ ...base, text: `/overlap ${A} ${B}` });
    expect(sent[0]).toMatch(/not indexed/i);
    expect(sent[0]).toContain(B);
    expect(sent[0]).not.toMatch(new RegExp(`${A}[^\\n]*not indexed`));
  });

  it('reports wallets spanning both collections', async () => {
    const { base, sent } = setup();
    collection(A); collection(B);
    insertTransfers(db, [mint(A, WALLET, 1, 10), mint(B, WALLET, 2, 11)]);
    await handleOverlap({ ...base, text: `/overlap ${A} ${B}` });
    expect(sent[0]).toContain(WALLET);
    expect(sent[0]).toContain('2');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/botQueries.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/bot/commands/queries.ts`:

```ts
import type Database from 'better-sqlite3';
import { firstMinters, overlap } from '../../db/repositories/analytics.js';
import { getCollection } from '../../db/repositories/collections.js';
import { describeError } from '../../report.js';
import { parseQueryCommand } from '../args.js';
import { respond } from '../render.js';
import type { Replier } from '../replier.js';
import { nextCommand } from './index.js';
import type { Address } from '../../types.js';

export interface QueryDeps {
  text: string;
  replier: Replier;
  db: Database.Database;
  defaultChainId: number | undefined;
}

/**
 * Collections in the request that have never been indexed.
 *
 * Reported BY NAME rather than folded into an empty result. `firstMinters` on an unknown
 * collection returns `[]`, which renders identically to a collection that genuinely has
 * no mints — so an unindexed collection would look like a real answer of "nobody".
 */
function notIndexed(db: Database.Database, chainId: number, contracts: Address[]): Address[] {
  return contracts.filter((c) => getCollection(db, chainId, c).state === 'not_indexed');
}

export async function handleFirstMinters(d: QueryDeps): Promise<void> {
  let parsed;
  try {
    parsed = parseQueryCommand(d.text, d.defaultChainId);
  } catch (err) {
    const r = describeError(err);
    await d.replier.reply(`${r.headline}\n\n  ${r.detail}`);
    return;
  }
  const contract = parsed.contracts[0]!;
  const missing = notIndexed(d.db, parsed.chainId, [contract]);
  if (missing.length > 0) {
    await d.replier.reply(
      `${contract} on chain ${parsed.chainId} is not indexed, so there is nothing to ` +
      `report — this is different from having no minters.\n  /index ${contract} ` +
      `--chain ${parsed.chainId}`,
    );
    return;
  }

  try {
    const rows = firstMinters(d.db, {
      chainId: parsed.chainId, contract, limit: parsed.limit,
    });
    await respond(d.replier, {
      title: `First minters of ${contract} (chain ${parsed.chainId})`,
      headers: ['minter', 'minted', 'recipients', 'to others', 'block', 'log'],
      rows: rows.map((r) => [
        r.minter, String(r.minted), String(r.recipients),
        r.mintedToOthers ? 'yes' : 'no', String(r.blockNumber), String(r.logIndex),
      ]),
      filename: `firstminters-${parsed.chainId}-${contract}-${Date.now()}.csv`,
    });
  } catch (err) {
    const r = describeError(err);
    const next = nextCommand(err, { contract, chainId: parsed.chainId });
    await d.replier.reply(
      `${r.headline}\n\n  ${r.detail}` +
      (r.hint ? `\n\n  ${r.hint}` : '') + (next ? `\n\n  next: ${next}` : ''),
    );
  }
}

export async function handleOverlap(d: QueryDeps): Promise<void> {
  let parsed;
  try {
    parsed = parseQueryCommand(d.text, d.defaultChainId);
  } catch (err) {
    const r = describeError(err);
    await d.replier.reply(`${r.headline}\n\n  ${r.detail}`);
    return;
  }
  // parseQueryCommand already deduped, so a repeated address cannot inflate this count.
  if (parsed.contracts.length < 2) {
    await d.replier.reply(
      'Send at least two different collections: /overlap 0x… 0x… [--min N]',
    );
    return;
  }

  const missing = notIndexed(d.db, parsed.chainId, parsed.contracts);
  if (missing.length > 0) {
    await d.replier.reply(
      `These are not indexed, so they cannot be counted:\n` +
      missing.map((c) => `  ${c} — not indexed`).join('\n') +
      `\n\nIndex them first: ${missing.map((c) => `/index ${c} --chain ${parsed.chainId}`).join('  ')}`,
    );
    return;
  }

  try {
    const rows = overlap(d.db, {
      chainId: parsed.chainId, contracts: parsed.contracts, minCollections: parsed.min,
    });
    await respond(d.replier, {
      title: `Wallets in ${parsed.min}+ of ${parsed.contracts.length} collections ` +
        `(chain ${parsed.chainId})`,
      headers: ['wallet', 'collections'],
      rows: rows.map((r) => [r.address, String(r.collections)]),
      filename: `overlap-${parsed.chainId}-${parsed.contracts.length}-${Date.now()}.csv`,
    });
  } catch (err) {
    const r = describeError(err);
    const next = nextCommand(err, { contract: parsed.contracts[0]!, chainId: parsed.chainId });
    await d.replier.reply(
      `${r.headline}\n\n  ${r.detail}` +
      (r.hint ? `\n\n  ${r.hint}` : '') + (next ? `\n\n  next: ${next}` : ''),
    );
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/botQueries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/queries.ts test/unit/botQueries.test.ts
git commit -m "feat: /firstminters and /overlap, distinguishing unindexed from empty"
```

---

## Task 12: Wiring, startup failures, and requireBotConfig

**Files:**
- Create: `src/bot/index.ts`
- Test: `test/unit/botStartup.test.ts`
- Modify: `package.json` (add a `bot` script)

**Interfaces:**
- Consumes: everything above.
- Produces: `requireBotConfig(config: Config): { token: string; allowedUserIds: Set<number> }`, `classifyStartupFailure(err: unknown): { exitCode: ExitCode; message: string } | undefined`.

- [ ] **Step 1: Write the failing tests**

`test/unit/botStartup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyStartupFailure, requireBotConfig } from '../../src/bot/index.js';
import { EXIT } from '../../src/report.js';
import { ConfigError } from '../../src/errors.js';
import type { Config } from '../../src/config.js';

const base: Config = {
  chains: new Map(), defaultChainId: 1, dbPath: ':memory:',
  etherscanApiKey: undefined, computeUnitsPerSecond: 300, secrets: [],
  telegramBotToken: undefined, telegramAllowedUserIds: [],
};

describe('requireBotConfig', () => {
  it('returns the token and a set of ids', () => {
    expect(requireBotConfig({
      ...base, telegramBotToken: 'tok', telegramAllowedUserIds: [1, 2],
    })).toEqual({ token: 'tok', allowedUserIds: new Set([1, 2]) });
  });

  it('throws when the token is missing', () => {
    expect(() => requireBotConfig({ ...base, telegramAllowedUserIds: [1] }))
      .toThrow(ConfigError);
  });

  it('throws on an EMPTY allowlist rather than starting', () => {
    // The two ways to get this wrong are a bot that drops everything (useless) and one
    // that treats empty as allow-all (catastrophic). Neither should be reachable by
    // leaving a variable unset.
    expect(() => requireBotConfig({ ...base, telegramBotToken: 'tok' }))
      .toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
  });
});

describe('classifyStartupFailure', () => {
  const api = (code: number, description: string) =>
    Object.assign(new Error(description), { error_code: code, description });

  it('maps a 409 to BUSY, and does NOT suggest retrying', () => {
    // Long polling does not error under contention: updates go to one poller at random,
    // so a second instance makes messages disappear intermittently. Retrying here would
    // produce exactly that split-brain.
    const result = classifyStartupFailure(api(409, 'Conflict: terminated by other getUpdates request'));
    expect(result?.exitCode).toBe(EXIT.BUSY);
    expect(result?.message).toMatch(/another instance/i);
    expect(result?.message).not.toMatch(/retry/i);
  });

  it('maps a 401 to USAGE', () => {
    expect(classifyStartupFailure(api(401, 'Unauthorized'))?.exitCode).toBe(EXIT.USAGE);
  });

  it('is undefined for anything else, so it is not swallowed', () => {
    expect(classifyStartupFailure(new Error('network down'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/botStartup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the entry point**

`src/bot/index.ts`. The scrubbing import is first, as in the CLI.

```ts
/**
 * `npm run bot`
 *
 * THE SCRUBBING IMPORT IS FIRST and must stay first. grammY builds request URLs as
 * api.telegram.org/bot<TOKEN>/… and prints them in error dumps, so without this an
 * unhandled error puts the bot token in the terminal — the same shape that put an
 * Alchemy key in a transcript and cost a rotation.
 */
import '../outputScrubbing.js';

import { Bot } from 'grammy';
import { getChainClient } from '../chain/client.js';
import { systemClock } from '../clock.js';
import { loadConfig, type Config } from '../config.js';
import { openDb } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { ConfigError } from '../errors.js';
import { EXIT, formatError, describeError, type ExitCode } from '../report.js';
import { isConflict, isUnauthorized } from '../telegram/failures.js';
import { allowOnly } from './auth.js';
import { createJobRegistry } from './jobs.js';
import { makeReplier } from './replier.js';
import { handleIndex, nextCommand } from './commands/index.js';
import { handleStatus } from './commands/status.js';
import { handleFirstMinters, handleOverlap } from './commands/queries.js';

const STALE_LOCK_MS = 15 * 60_000;
const CONFIRM_THRESHOLD_SECONDS = 300;

/**
 * Narrows the config to what the bot needs, in ONE place.
 *
 * The two fields are optional on `Config` because the CLI must run without them. This
 * returns a type that cannot represent a missing token or an empty allowlist, so no
 * handler can read an allowlist that might be empty.
 */
export function requireBotConfig(
  config: Config,
): { token: string; allowedUserIds: Set<number> } {
  if (!config.telegramBotToken) {
    throw new ConfigError(
      'TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and put its token in .env.',
    );
  }
  if (config.telegramAllowedUserIds.length === 0) {
    throw new ConfigError(
      'TELEGRAM_ALLOWED_USER_IDS is empty. The bot refuses to start rather than guess: ' +
      'an empty list could mean "nobody" (a bot that looks dead) or "everybody" (a ' +
      'private bot that is not private). Set the numeric user ids, comma separated.',
    );
  }
  return {
    token: config.telegramBotToken,
    allowedUserIds: new Set(config.telegramAllowedUserIds),
  };
}

/**
 * The two startup failures worth exiting on rather than retrying.
 *
 * A 409 means another instance is already polling. Long polling does NOT error under
 * contention — Telegram hands each update to one poller at random — so a second instance
 * makes messages disappear intermittently, which is the worst possible shape to debug.
 * Retrying here would create exactly that split-brain, so the bot exits.
 */
export function classifyStartupFailure(
  err: unknown,
): { exitCode: ExitCode; message: string } | undefined {
  if (isConflict(err)) {
    return {
      exitCode: EXIT.BUSY,
      message:
        'Another instance of this bot is already polling Telegram. Only one may run at a ' +
        'time: updates are delivered to one poller at random, so two instances make ' +
        'messages vanish intermittently. Stop the other instance, then start this one.',
    };
  }
  if (isUnauthorized(err)) {
    return {
      exitCode: EXIT.USAGE,
      message: 'Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN.',
    };
  }
  return undefined;
}

async function main(): Promise<number> {
  const config = loadConfig();
  const { token, allowedUserIds } = requireBotConfig(config);

  const db = openDb(config.dbPath);
  runMigrations(db);

  const registry = createJobRegistry({ clock: systemClock, staleMs: STALE_LOCK_MS });
  const bot = new Bot(token);

  // FIRST, before any handler.
  bot.use(allowOnly(allowedUserIds, (message) => process.stderr.write(`${message}\n`)));

  bot.command('help', async (ctx) => {
    await makeReplier(ctx).reply([
      'Byakugan — NFT minter and buyer tracking',
      '',
      '/index 0x… [--chain N] [--mints-only|--logs-only] [--to-block N] [--yes]',
      '/status [0x…]',
      '/firstminters 0x… [--chain N] [--limit N]',
      '/overlap 0x… 0x… [--min N]',
      '',
      'Levels: logs_only indexes without transactions and cannot answer /firstminters;',
      'mints_only fetches mint transactions; full fetches everything and is the default.',
      'A collection’s level is fixed when it is first indexed.',
    ].join('\n'));
  });
  bot.command('start', async (ctx) => { await makeReplier(ctx).reply('Ready. /help for commands.'); });

  bot.command('index', async (ctx) => {
    const chainConfig = config.chains.get(config.defaultChainId ?? 0);
    await handleIndex({
      text: ctx.message?.text ?? '', replier: makeReplier(ctx), db, clock: systemClock,
      registry, defaultChainId: config.defaultChainId,
      chainConfig: { name: chainConfig?.name ?? 'unknown' },
      confirmThresholdSeconds: CONFIRM_THRESHOLD_SECONDS,
      estimateSeconds: async () => 0,   // replaced in Task 13's wiring
      runBackfill: async () => { throw new Error('wired in Task 13'); },
    });
  });

  bot.command('status', async (ctx) => {
    await handleStatus({
      text: ctx.message?.text ?? '', replier: makeReplier(ctx), db, clock: systemClock,
      registry, defaultChainId: config.defaultChainId, staleMs: STALE_LOCK_MS,
    });
  });
  bot.command('firstminters', async (ctx) => {
    await handleFirstMinters({
      text: ctx.message?.text ?? '', replier: makeReplier(ctx), db,
      defaultChainId: config.defaultChainId,
    });
  });
  bot.command('overlap', async (ctx) => {
    await handleOverlap({
      text: ctx.message?.text ?? '', replier: makeReplier(ctx), db,
      defaultChainId: config.defaultChainId,
    });
  });

  // A handler that throws must not kill the poll loop.
  bot.catch((err) => {
    const reported = describeError(err.error);
    process.stderr.write(formatError(reported));
  });

  try {
    await bot.start();
  } catch (err) {
    const startup = classifyStartupFailure(err);
    if (startup) {
      process.stderr.write(`error: ${startup.message}\n`);
      return startup.exitCode;
    }
    throw err;
  }
  return EXIT.OK;
}

try {
  process.exitCode = await main();
} catch (err) {
  const reported = describeError(err);
  process.stderr.write(formatError(reported, { verbose: process.argv.includes('--verbose'), err }));
  process.exitCode = reported.exitCode;
}
```

Add to `package.json`:

```json
"bot": "node --env-file-if-exists=.env --import tsx src/bot/index.ts"
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/botStartup.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-verify the startup guards**

On a branch, each separately:
1. Make `requireBotConfig` tolerate an empty allowlist — the empty-allowlist test must fail.
2. Make `classifyStartupFailure` return `undefined` for a 409 — the BUSY test must fail.
Restore and report both.

- [ ] **Step 6: Commit**

```bash
git add src/bot/index.ts test/unit/botStartup.test.ts package.json
git commit -m "feat: bot entry point with allowlist first and no retry into split-brain"
```

---

## Task 13: Wire /index to the real backfill, and test it end to end on anvil

**Files:**
- Create: `src/chain/ports.ts`
- Modify: `src/cli/index.ts` (use the extracted factory)
- Modify: `src/bot/index.ts` (replace the two placeholder deps)
- Create: `test/integration/bot.anvil.test.ts`

**Interfaces:**
- Produces:
  - `makeBackfillPorts(a: { config: Config; chainId: number; contract: Address; fetchPath: 'auto' | 'logs'; deployBlockOverride?: number; onWarn?(m: string): void; onFallback?(n: FallbackNotice): void }): Promise<{ ports: BackfillPorts; fetchLogs: LogFetcher; fetchPath: string; safeHead: bigint }>`

- [ ] **Step 1: Extract port construction so both front ends build identical ports**

`src/chain/ports.ts`. The CLI already builds these; two copies would drift, and the bot needs the same capability probe the CLI has — the one whose absence from the real path meant every CLI run silently used `getLogs`.

```ts
import { type Address as ViemAddress } from 'viem';
import { getChainClient } from './client.js';
import { resolveDeployBlock } from './deployBlock.js';
import { makeSupportsInterface } from './standard.js';
import { makeTxSource } from './tx.js';
import { makeAssetTransfersFetcher } from './assetTransfersRpc.js';
import { CU_COSTS } from './cuCosts.js';
import type { Config } from '../config.js';
import {
  makeAssetTransfersSource, makeLogsSource, supportsAssetTransfers, withFallback,
  type FallbackNotice,
} from '../indexer/transferSource.js';
import type { LogFetcher } from '../indexer/logs.js';
import type { BackfillPorts } from '../indexer/backfill.js';
import type { Address, Hash } from '../types.js';

/**
 * Builds the backfill's ports, once, for either front end.
 *
 * Extracted from the CLI rather than copied into the bot. The capability probe in
 * particular must happen in exactly one place: when it lived only in the CLI's dry-run
 * path, every real run silently used `eth_getLogs` and finished correctly in seventy
 * chunks where one page would have done. Nothing in the output said so, and only running
 * it found the defect.
 */
export async function makeBackfillPorts(a: {
  config: Config;
  chainId: number;
  contract: Address;
  fetchPath: 'auto' | 'logs';
  deployBlockOverride?: number;
  onWarn?(message: string): void;
  onFallback?(notice: FallbackNotice): void;
}): Promise<{
  ports: BackfillPorts; fetchLogs: LogFetcher; fetchPath: string; safeHead: bigint;
}> {
  const chain = a.config.chains.get(a.chainId);
  if (!chain) throw new Error(`chain ${a.chainId} is not configured`);
  const { client, limit } = getChainClient(a.chainId, a.config);
  const chainClient = { chainId: a.chainId, client, limit };

  const fetchLogs: LogFetcher = async ({ fromBlock, toBlock }) => {
    const logs = await limit(() => client.getLogs({
      address: a.contract as ViemAddress, fromBlock, toBlock,
    }), CU_COSTS.eth_getLogs);
    return logs.map((l) => ({
      topics: l.topics as Hash[], data: l.data as Hash,
      transactionHash: l.transactionHash as Hash,
      blockNumber: l.blockNumber!, logIndex: l.logIndex!,
    }));
  };

  const safeHeadOf = async (): Promise<bigint> => {
    const head = await limit(() => client.getBlockNumber(), CU_COSTS.eth_blockNumber);
    const confirmed = head - BigInt(chain.confirmations);
    return confirmed < 0n ? 0n : confirmed;
  };
  const safeHead = await safeHeadOf();

  const probeFetcher = makeAssetTransfersFetcher({
    rpcUrl: chain.rpcUrl, limit, contract: a.contract, standard: '721',
  });
  const support = a.fetchPath === 'logs'
    ? { supported: false, reason: 'forced by --fetch-path logs' }
    : await supportsAssetTransfers(probeFetcher, safeHead);

  const supports = makeSupportsInterface(client, a.contract);
  const getCode = async (c: { address: Address; blockNumber: bigint }): Promise<string> =>
    (await limit(() => client.getBytecode({
      address: c.address as ViemAddress, blockNumber: c.blockNumber,
    }), CU_COSTS.eth_getCode)) ?? '0x';

  const ports: BackfillPorts = {
    makeTransferSource: (standard) => {
      const logsSource = makeLogsSource({
        fetchLogs, standard, initialChunk: chain.initialChunk, maxChunk: chain.maxChunk,
      });
      if (!support.supported) return logsSource;
      return withFallback({
        primary: makeAssetTransfersSource({
          standard,
          fetch: makeAssetTransfersFetcher({
            rpcUrl: chain.rpcUrl, limit, contract: a.contract, standard,
          }),
        }),
        secondary: logsSource,
        ...(a.onFallback ? { onFallback: a.onFallback } : {}),
      });
    },
    txSource: makeTxSource(chainClient),
    supports,
    resolveDeployBlock: async ({ safeHead: head }) => resolveDeployBlock({
      getCode, chainId: a.chainId, address: a.contract, safeHead: head,
      archiveProbe: chain.archiveProbe,
      ...(a.deployBlockOverride === undefined ? {} : { override: a.deployBlockOverride }),
      ...(a.config.etherscanApiKey === undefined
        ? {} : { etherscanApiKey: a.config.etherscanApiKey }),
      explorerLimit: limit,
      ...(a.onWarn ? { onWarn: a.onWarn } : {}),
    }),
    safeHead: safeHeadOf,
  };

  return {
    ports, fetchLogs, safeHead,
    fetchPath: support.supported ? 'getAssetTransfers' : 'getLogs',
  };
}
```

Then rewrite `src/cli/index.ts` to call it, deleting its inline construction.

- [ ] **Step 2: Run the whole suite — a pure extraction changes nothing**

Run: `npm run typecheck && npm test`
Expected: PASS, with every CLI test unchanged. If a CLI test changes behaviour, the extraction was not faithful.

- [ ] **Step 3: Implement the bot's two real deps**

In `src/bot/index.ts`, replace the `estimateSeconds` and `runBackfill` placeholders:

```ts
  bot.command('index', async (ctx) => {
    const replier = makeReplier(ctx);
    const text = ctx.message?.text ?? '';

    // Peeked only to learn which chain and contract to build ports for. handleIndex
    // parses again and owns every reply, including the usage message, so a parse failure
    // here just hands over without ports.
    let peeked: { chainId: number; contract: Address } | undefined;
    try {
      const parsed = parseIndexCommand(text, config.defaultChainId);
      peeked = { chainId: parsed.chainId, contract: parsed.contract };
    } catch {
      peeked = undefined;
    }

    if (!peeked) {
      await handleIndex({
        text, replier, db, clock: systemClock, registry,
        defaultChainId: config.defaultChainId, chainConfig: { name: 'unknown' },
        fetchPath: 'getLogs', confirmThresholdSeconds: CONFIRM_THRESHOLD_SECONDS,
        estimateSeconds: async () => 0,
        runBackfill: async () => { throw new Error('unreachable: parsing failed'); },
      });
      return;
    }

    const { chainId, contract } = peeked;
    const chain = config.chains.get(chainId);
    const built = await makeBackfillPorts({
      config, chainId, contract, fetchPath: 'auto',
      onWarn: (m) => process.stderr.write(`warning: ${m}\n`),
      onFallback: (n) => process.stderr.write(
        `warning: ${n.from} failed, continuing with ${n.to} from ${n.resumedAt}: ${n.reason}\n`,
      ),
    });

    await handleIndex({
      text, replier, db, clock: systemClock, registry,
      defaultChainId: config.defaultChainId,
      chainConfig: { name: chain?.name ?? 'unknown' },
      fetchPath: built.fetchPath,
      confirmThresholdSeconds: CONFIRM_THRESHOLD_SECONDS,

      estimateSeconds: async ({ toBlock }) => {
        const probe = await probeEffectiveChunk({
          fetch: built.fetchLogs, nearBlock: built.safeHead,
          requested: chain?.maxChunk ?? 10,
        });
        const resolved = await built.ports.resolveDeployBlock({ safeHead: built.safeHead });
        const bound = toBlock !== undefined && toBlock < built.safeHead
          ? toBlock : built.safeHead;
        const logsSeconds = estimateBackfill({
          fromBlock: BigInt(resolved.block), toBlock: bound,
          chunkBlocks: probe.blocks,
          requestsPerSecond: callsPerSecond('eth_getLogs', config.computeUnitsPerSecond),
        }).logsSeconds;
        // getAssetTransfers has no range cap, so a getLogs-derived figure is a CEILING
        // when that path is in use.
        return built.fetchPath === 'getAssetTransfers' ? logsSeconds / 50 : logsSeconds;
      },

      runBackfill: async ({ level, toBlock, onProgress }) => backfill(db, {
        clock: systemClock, jobId: newJobId(), ports: built.ports,
        options: {
          chainId, contract, level: level as EnrichmentLevel,
          ...(toBlock === undefined ? {} : { toBlock }),
          costs: null, staleLockMs: STALE_LOCK_MS, onProgress,
        },
      }),
    });
  });
```

The `/ 50` divisor is a **stated approximation, not a measurement.** `getAssetTransfers` pages scale with transfers rather than blocks, so the real figure is unknowable before the logs are read. Record it in the milestone report as unverified, exactly as the compute-unit prices are, and do not present it to the user as measured — the reply says "estimated", and the estimate's provenance belongs in the report.

- [ ] **Step 4: Write the end-to-end test**

`test/integration/bot.anvil.test.ts`. Skips with `process.stderr.write` — vitest discards `console.*` from a file whose every test is skipped, so a `console.warn` notice is invisible.

```ts
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createPublicClient, http, type Address as ViemAddress } from 'viem';
import type Database from 'better-sqlite3';
import {
  anvilAvailability, call, deploy, readArtifact, startAnvil, type AnvilChain,
} from '../helpers/anvil.js';
import { binarySearchDeployBlock } from '../../src/chain/deployBlock.js';
import { makeSupportsInterface } from '../../src/chain/standard.js';
import { makeTxSource } from '../../src/chain/tx.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { backfill, type BackfillPorts } from '../../src/indexer/backfill.js';
import { makeLogsSource } from '../../src/indexer/transferSource.js';
import { createJobRegistry, type JobRegistry } from '../../src/bot/jobs.js';
import { handleIndex } from '../../src/bot/commands/index.js';
import { newJobId } from '../../src/jobId.js';
import type { Address, Hash } from '../../src/types.js';

const availability = anvilAvailability();
if (!availability.ok) {
  process.stderr.write(`\n[bot.anvil] SKIPPED — ${availability.reason}\n\n`);
}

const CHAIN_ID = 31337;

describe.skipIf(!availability.ok)('/index end to end on anvil', () => {
  let chain: AnvilChain;
  let contract: Address;
  let ports: BackfillPorts;
  let db: Database.Database;
  const clock = manualClock(0);

  beforeAll(async () => {
    const artifact = readArtifact('FixtureERC721');
    chain = await startAnvil({ accounts: 8 });
    const deployer = chain.accounts[0]!;
    for (let i = 0; i < 3; i++) await chain.mine();
    contract = (await deploy(chain, { from: deployer, bytecode: artifact.bytecode }))
      .toLowerCase() as Address;

    // Five mints in five separate blocks, so a chunk size of 2 makes the walk
    // multi-chunk and progress is edited more than once.
    for (let i = 0; i < 5; i++) {
      const wallet = chain.accounts[i + 1]!;
      await chain.send({
        from: wallet, to: contract, data: call(artifact.abi, 'mint', [wallet]),
      });
      await chain.mine();
    }
    await chain.mine();

    const client = createPublicClient({ transport: http(chain.url) });
    const head = await client.getBlockNumber();
    const fetchLogs = async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      const logs = await client.getLogs({
        address: contract as ViemAddress, fromBlock, toBlock,
      });
      return logs.map((l) => ({
        topics: l.topics as Hash[], data: l.data as Hash,
        transactionHash: l.transactionHash as Hash,
        blockNumber: l.blockNumber!, logIndex: l.logIndex!,
      }));
    };

    ports = {
      makeTransferSource: (standard) => makeLogsSource({
        fetchLogs, standard, initialChunk: 2, maxChunk: 2,
      }),
      txSource: makeTxSource({ chainId: CHAIN_ID, client, limit: (fn) => fn() }),
      supports: makeSupportsInterface(client, contract),
      resolveDeployBlock: async ({ safeHead }) => ({
        block: Number(await binarySearchDeployBlock(
          async ({ address, blockNumber }) =>
            (await client.getBytecode({
              address: address as ViemAddress, blockNumber,
            })) ?? '0x',
          contract, safeHead,
        )),
        source: 'binary_search', validated: true,
      }),
      safeHead: async () => head - 1n,
    };

    db = openDb(':memory:');
    runMigrations(db);
  }, 180_000);

  afterAll(() => { chain?.stop(); db?.close(); });

  /** Waits for the detached job by polling the registry rather than sleeping a guess. */
  async function settle(registry: JobRegistry): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (registry.size() > 0) {
      if (Date.now() > deadline) throw new Error('the job never finished');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  function fakeReplier() {
    const edits: string[] = [];
    const sent: string[] = [];
    return {
      edits, sent,
      replier: {
        reply: vi.fn(async (t: string) => { sent.push(t); return { messageId: 7 }; }),
        edit: vi.fn(async (_id: number, t: string) => { edits.push(t); }),
        sendDocument: vi.fn(),
      },
    };
  }

  function deps(registry: JobRegistry, replier: unknown) {
    return {
      text: `/index ${contract} --chain ${CHAIN_ID}`,
      replier: replier as never, db, clock, registry,
      defaultChainId: CHAIN_ID, chainConfig: { name: 'anvil' },
      fetchPath: 'getLogs', confirmThresholdSeconds: 100_000,
      estimateSeconds: async () => 1,
      runBackfill: async (a: {
        level: string; toBlock?: bigint;
        onProgress(c: { fromBlock: bigint; toBlock: bigint; inserted: number }): void;
      }) => backfill(db, {
        clock, jobId: newJobId(), ports,
        options: {
          chainId: CHAIN_ID, contract, level: a.level as 'full',
          ...(a.toBlock === undefined ? {} : { toBlock: a.toBlock }),
          costs: null, staleLockMs: 900_000, onProgress: a.onProgress,
        },
      }),
    };
  }

  it('replies immediately, edits progress, and reports the final watermark', async () => {
    const registry = createJobRegistry({ clock, staleMs: 900_000 });
    const { replier, edits, sent } = fakeReplier();
    await handleIndex(deps(registry, replier) as never);

    // The handler returned before the job did: exactly one reply, no result yet.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('level full');

    await settle(registry);
    expect(edits.at(-1)).toContain('Indexed');
    expect(edits.at(-1)).toMatch(/through block \d+/);
    const row = db.prepare(
      'SELECT COUNT(*) AS n FROM transfers WHERE contract = ?',
    ).get(contract) as { n: number };
    expect(row.n).toBe(5);
  }, 300_000);

  it('reports a second /index as RUNNING, not orphaned, while the first is in flight', async () => {
    const registry = createJobRegistry({ clock, staleMs: 900_000 });
    const first = fakeReplier();
    let release: () => void = () => undefined;
    const held = {
      ...deps(registry, first.replier),
      runBackfill: () => new Promise((resolve) => {
        release = () => resolve({
          status: 'indexed', source: 'getLogs', standard: '721', deployBlock: 1,
          fromBlock: 1, toBlock: 2, chunks: 1, rowsInserted: 0, lastIndexedBlock: 2,
        });
      }),
    };
    await handleIndex(held as never);

    const second = fakeReplier();
    clock.advance(120_000);
    await handleIndex(deps(registry, second.replier) as never);
    expect(second.sent.at(-1)).toMatch(/already indexing/i);
    // The distinction that matters: a live job is not an orphaned lock.
    expect(second.sent.at(-1)).not.toMatch(/previous run/i);
    expect(second.sent.at(-1)).toContain('2 minutes');

    release();
    await settle(registry);
  }, 300_000);
});
```

- [ ] **Step 5: Run it**

Run: `npx vitest run test/integration/bot.anvil.test.ts`
Expected: PASS with Foundry installed.

- [ ] **Step 6: Verify the skip path by removing Foundry from PATH**

Not by reading the code — that is how the `console.warn` defect was found.

```bash
NODE_DIR=$(dirname "$(command -v node)")
PATH="$NODE_DIR:/usr/bin:/bin" npx vitest run test/integration/bot.anvil.test.ts
```

Expected: the file skips, the suite is green, and the printed reason names Foundry.

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: wire /index to the real backfill, with an end-to-end anvil test"
```

---

## Task 14: README, and the honest milestone report

**Files:**
- Modify: `README.md`
- Modify: `.superpowers/sdd/2026-10-02-milestone-2-telegram-bot/progress.md`

- [ ] **Step 1: Add a bot section to the README**

Cover: creating a bot with @BotFather; the two environment variables; that the allowlist is required and empty means refusal to start; `npm run bot`; the four commands with their arguments; that the level is fixed at first index; that output over 3500 characters arrives as a CSV; and the exit codes a supervisor will see (4 for another instance, 2 for a bad token).

- [ ] **Step 2: Record the known limitations, verbatim from the spec**

No queue, no persistence across restart, no `/cancel`, single instance enforced by exiting on 409, group chats untested, and the compute-unit prices still unverified.

- [ ] **Step 3: Write the milestone report**

State what was built, the test counts, every mutation result including any survivor, which suites skipped and why, and anything claimed but not verified — including, if it is still true, that no real Telegram 429 was ever observed and the retry path is covered by unit tests only.

- [ ] **Step 4: Commit and stop for the owner's confirmation**

```bash
git add -A
git commit -m "docs: bot usage, limitations, and the Milestone 2 report"
```

Then stop. The standing rule is that a milestone ends with a summary and waits for confirmation.
