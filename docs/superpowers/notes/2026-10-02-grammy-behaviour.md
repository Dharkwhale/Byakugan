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

## OUTSTANDING — needs a live bot token

These are Telegram **server** behaviours. grammY's source cannot answer them and neither
can recollection, so `src/telegram/failures.ts` must be checked against the real output
before its tests count as pinning anything.

| question | why it matters | status |
|---|---|---|
| What does editing a message to its existing text return? | The editor skips unchanged renders. If the real error differs from `400 / "message is not modified"`, `isUnchangedEdit` returns false, redundant edits are attempted, and progress updates start failing visibly. | **not yet measured** |
| What exactly does a second long-polling instance return? | Task 12 exits on 409. The code path is confirmed (Q3), but the `description` text is not. | **not yet measured** |

Run `npm run probe:telegram -- --chat <numeric chat id>` with `TELEGRAM_BOT_TOKEN` set and
paste the output here. The probe imports the scrub guard first, so the token is redacted at
the boundary even in an unhandled dump.

Until then, the fixtures in `test/unit/telegramFailures.test.ts` are shaped from the Bot API
documentation rather than from observation, and that distinction is recorded here rather
than assumed away.
