# grammY 1.46.0 — measured behaviour

Task 1 of the Milestone 2 plan. Every Milestone 1 defect that cost a round came from an
assumed mechanism — viem's 10s default timeout, the compute-unit ceiling, vitest
discarding `console.*` from a fully-skipped file, the dry-run reading `maxChunk` instead of
the measured cap. This document is the authority for anything the bot assumes about
grammY, and `src/telegram/failures.ts` follows it rather than the reverse.

**Pinned:** `grammy@1.46.0`, `@grammyjs/types@5.0.0`.

**Status:** the four source-readable questions are answered below with quotations. The two
**server** behaviours — what an unchanged edit returns and what a 409 looks like in
practice — need a live bot token and are marked OUTSTANDING.

---

## Q1 — What is thrown for a Bot API error, and are its fields typed?

`node_modules/grammy/out/core/error.d.ts`:

```ts
export declare class GrammyError extends Error implements ApiError {
    /** The called method name which caused this error to be thrown. */
    readonly method: string;
    /** The payload that was passed when calling the method. */
    readonly payload: Record<string, unknown>;
    /** Flag that this request was unsuccessful. Always `false`. */
    readonly ok: false;
    /** An integer holding Telegram's error code. Subject to change. */
    readonly error_code: number;
    /** A human-readable description of the error. */
    readonly description: string;
    /** Further parameters that may help to automatically handle the error. */
    readonly parameters: ResponseParameters;
}
```

**Answer:** `GrammyError`, with `error_code` and `description` as typed readonly
properties. A *transport* failure is a separate class:

```ts
export declare class HttpError extends Error {
    /** The thrown error object. */
    readonly error: unknown;
}
```

So the classifier must distinguish them: a `GrammyError` means Telegram answered and said
no; an `HttpError` means the call never got an answer.

## Q2 — Is `retry_after` a typed property, or only text in `description`?

`node_modules/@grammyjs/types/api.d.ts:17-22`:

```ts
export interface ResponseParameters {
    /** The group has been migrated to a supergroup with the specified identifier. */
    migrate_to_chat_id?: number;
    /** In case of exceeding flood control, the number of seconds left to wait before the request can be repeated */
    retry_after?: number;
}
```

**Answer:** typed, as `parameters.retry_after?: number`. So `err.parameters?.retry_after`
is the correct path and no string parsing is required for the normal case.

It is **optional**, though, which is why `retryAfterSeconds` keeps a `description` fallback
— not because the typed path is unreliable, but because the field can be absent on a 429
and silently returning `undefined` would turn a rate limit into an un-waited retry.

## Q3 — Does grammY retry anything by default?

**Yes, in three places, and none of them is an ordinary API call.** This was the question
most likely to invalidate the design, and the answer makes two planned behaviours work.

### The poll loop rethrows 401 and 409

`node_modules/grammy/out/bot.js:439-460`, `handlePollingError`:

```js
let sleepSeconds = 3;
if (error instanceof error_js_1.GrammyError) {
    debugErr(error.message);
    // rethrow upon unauthorized or conflict
    if (error.error_code === 401 || error.error_code === 409) {
        throw error;
    }
    else if (error.error_code === 429) { ... sleepSeconds = error.parameters.retry_after ?? sleepSeconds; }
}
debugErr(`Call to getUpdates failed, retrying in ${sleepSeconds} seconds ...`);
await sleep(1000 * sleepSeconds);
```

**This confirms the Task 12 design rather than contradicting it.** `bot.start()` genuinely
rejects on 409 and 401, so catching them and exiting works. Had grammY retried a 409
instead, `start()` would never have returned and the bot would have spun quietly in exactly
the split-brain the exit exists to prevent — the design would have been correct in intent
and inert in practice.

Everything else in the poll loop is grammY's problem, retried after 3 seconds. **The bot
must not add its own poll retry** on top.

### `withRetries` wraps only startup calls

Used in exactly three places, all in `bot.js`:

```
bot.js:169  withRetries(() => this.api.getMe(signal), signal)        // init
bot.js:294  withRetries(async () => { await this.api.deleteWebhook(...) })  // start
bot.js:478  async function withRetries(task, signal)                  // the definition
```

It retries `HttpError`, any `error_code >= 500`, and 429 (sleeping `retry_after` when
present), with a delay doubling to a 20-minute cap. Other 4xx are rethrown.

### Ordinary API calls are NOT retried

`node_modules/grammy/out/core/client.js:49-61` performs one fetch and converts a failure:

```js
const successPromise = this.fetch(url, options).then((res) => res.json());
try { return await Promise.race(operations); }
catch (error) { throw (0, error_js_1.toHttpError)(method, opts.sensitiveLogs, error); }
```

**So `editMessageText` is not auto-retried, and the progress editor sees 429s itself.** Had
the client retried internally, the editor's 429 branch would have been unreachable and both
it and its test would have been vacuous against the real library — a passing test for a
code path that could never run.

## Q4 — Are auto-retry and the throttler bundled?

`node_modules/grammy/package.json`:

```json
"dependencies": { "@grammyjs/types": "5.0.0", "abort-controller": "^3.0.0", "debug": "^4.4.3", "node-fetch": "^2.7.0" }
```

`node_modules/@grammyjs/` contains `types` only.

**Answer:** separate packages, not installed. `@grammyjs/auto-retry` and
`@grammyjs/transformer-throttler` are not in play, so **our throttle is the only one** and
nothing is silently rate-limiting or retrying our edits behind it.

---

## Incidental finding: `sensitiveLogs` defaults to false

`core/client.js:83`:

```js
sensitiveLogs: options.sensitiveLogs ?? false,
```

`core/error.js:76-80`:

```js
function toHttpError(method, sensitiveLogs, err) {
    let msg = `Network request for '${method}' failed!`;
    if (sensitiveLogs && err instanceof Error) msg += ` ${err.message}`;
```

By default grammY does **not** append the underlying error's message to an `HttpError`,
which narrows one path by which a token-bearing URL could reach output. Two things follow:

- **Do not enable `sensitiveLogs`.** It exists to widen exactly this.
- **It is not the guarantee.** The request URL is built with the token at `client.js:42`
  and handed to `fetch`, so a rejection from the fetch layer can still carry it, and this
  default is grammY's choice rather than ours. `src/outputScrubbing.ts` with the token in
  `config.secrets` remains the guarantee, and the token being in `secrets` is what makes it
  one.

---

## MEASURED against a live bot — 2026-10-02

Run with `npm run probe:telegram`. Preconditions checked first, not assumed:
`npm run verify:scrub -- TELEGRAM_BOT_TOKEN` confirmed the token is in `config.secrets` and
redacted across seven leak paths including an unhandled rejection and an uncaught throw. No
poller was started — `bot.api` issues one-off calls and `bot.start()` was never called — so
nothing was left behind to steal the real bot's updates, and no offset was passed, so no
update was marked confirmed.

### An unchanged edit THROWS

```json
{
    "class": "GrammyError",
    "error_code": 400,
    "description": "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
    "parameters": {},
    "method": "editMessageText"
}
```

**Confirms the design.** `isUnchangedEdit` matching `error_code === 400` plus
`/message is not modified/` on the description is correct. Two details worth having:

- `parameters` is `{}` — an empty object, not `undefined` — so `parameters?.retry_after`
  is safe to read on any `GrammyError`, not only a 429.
- The text dependence is real and unavoidable: 400 covers many conditions and there is no
  code that means only this. If Telegram rewords the description, `isUnchangedEdit` returns
  false, the editor stops skipping identical renders, and progress edits begin failing
  visibly rather than silently — the right direction for a guess about someone else's
  wording.

### The 409 goes to the INCUMBENT, not the newcomer

This is the finding that changes the design, and it is the opposite of what was assumed.

Two concurrent `getUpdates` were issued. The **second** call succeeded. The **first** —
already in flight — was rejected:

```
GrammyError: Call to 'getUpdates' failed!
(409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running)
```

Read the description literally: *terminated by other getUpdates request.* Telegram does not
refuse the newcomer. It **kills the existing request** and serves the new one.

So when a second bot instance starts:

| instance | what happens |
|---|---|
| the new one | polls successfully and begins receiving updates |
| the one already running | its `getUpdates` is terminated with 409, grammY rethrows it (Q3), `bot.start()` rejects, and it exits |

**Starting a second instance is therefore a handover, not a standoff.** There is no
split-brain — only one poller ever receives updates — but the protection runs the opposite
way from the plan: exiting on 409 does not defend the incumbent, because the incumbent is
the one receiving the 409.

Two consequences for Task 12:

1. **Exiting on 409 is still right**, for a different reason than planned. A displaced
   instance cannot poll at all; its request has been terminated. Exiting is the only honest
   response.
2. **The message was wrong.** "Another instance is already polling, stop it and start this
   one" is advice to the displaced process, and following it produces a flip-flop: restart
   this one and it displaces the other, which then exits and gets restarted in turn. The
   message must say that this instance has been **displaced**, and that restarting it
   without finding the other one will just trade places.

### Incidental: a probe flaw worth not repeating

The probe attached its rejection handler to the first request only after awaiting the
second, so the 409 was briefly unhandled and the scrub guard's `unhandledRejection` handler
printed it. Harmless here — the output was redacted and carried no token — but it is the
same ordering mistake that makes an unhandled rejection reach output in the first place.
Attach the handler at creation.

