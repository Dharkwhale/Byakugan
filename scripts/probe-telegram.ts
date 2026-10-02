/**
 * Measures the two Telegram SERVER behaviours the bot's design depends on and that
 * grammY's source cannot answer:
 *
 *   1. What does editing a message to the text it already has return?
 *   2. What exactly does a second concurrent getUpdates return?
 *
 * See docs/superpowers/notes/2026-10-02-grammy-behaviour.md for everything the source DID
 * answer. This fills the two rows marked OUTSTANDING there.
 *
 *   npm run probe:telegram
 *
 * SECRETS. The scrub guard is the first import and must stay first. The bot token appears
 * in the path of every request grammY makes — api.telegram.org/bot<TOKEN>/<method> — so any
 * unhandled error, any dump of a request, any error message can carry it. This is the exact
 * situation that leaked an Alchemy key in this project and cost a rotation: a live probe
 * against a credentialed endpoint, run outside the main code path. Verified before running
 * with `npm run verify:scrub -- TELEGRAM_BOT_TOKEN`, which attempts seven leak paths
 * including an uncaught throw and confirms each is redacted.
 *
 * NO POLLER IS STARTED. `bot.api` issues one-off calls; `bot.start()` is never called. The
 * 409 is forced with two concurrent `getUpdates` requests, which conflict because Telegram
 * permits only one in flight per bot — so there is nothing to tear down afterwards and no
 * chance of leaving a poller behind to steal the real bot's updates. Both requests are
 * awaited before the script exits.
 *
 * NO OFFSET IS PASSED to getUpdates, so nothing is marked as confirmed and the real bot
 * still receives any pending messages.
 */
import './_scrub-output.js'; // MUST be first: output-boundary secret scrubbing.
import { Bot, GrammyError, HttpError } from 'grammy';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const token = config.telegramBotToken;
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is not set. Nothing to probe.');
}
// In a private chat the chat id IS the user id, so the allowlist already holds it and no
// extra argument is needed.
const chatId = config.telegramAllowedUserIds[0];
if (chatId === undefined) {
  throw new Error(
    'TELEGRAM_ALLOWED_USER_IDS is empty, so there is no chat to probe. Set it to your ' +
    'numeric Telegram user id.',
  );
}

/** Renders an error's full shape. Everything here passes through the stream scrub. */
function describe(err: unknown): string {
  if (err instanceof GrammyError) {
    return JSON.stringify({
      class: 'GrammyError',
      error_code: err.error_code,
      description: err.description,
      parameters: err.parameters,
      method: err.method,
    }, null, 4);
  }
  if (err instanceof HttpError) {
    return JSON.stringify({ class: 'HttpError', error: String(err.error) }, null, 4);
  }
  return JSON.stringify({
    class: err?.constructor?.name ?? typeof err,
    message: err instanceof Error ? err.message : String(err),
  }, null, 4);
}

const out = (s: string): void => { process.stdout.write(s); };
const bot = new Bot(token);

out('\nprobing Telegram server behaviour\n');
out('  no poller is started; bot.api issues one-off calls only\n\n');

// ---------------------------------------------------------------- 1. unchanged edit
const TEXT = `byakugan probe ${Date.now()}`;
const sent = await bot.api.sendMessage(chatId, TEXT);
out(`sent a probe message (id ${sent.message_id})\n\n`);

out('--- 1. editing to DIFFERENT text (the happy path, for contrast) ---\n');
try {
  await bot.api.editMessageText(chatId, sent.message_id, `${TEXT} (edited)`);
  out('  succeeded, as expected\n\n');
} catch (err) {
  out(`  unexpectedly threw:\n${describe(err)}\n\n`);
}

out('--- 2. editing to the SAME text (does this throw, and with what?) ---\n');
try {
  await bot.api.editMessageText(chatId, sent.message_id, `${TEXT} (edited)`);
  out('  SUCCEEDED — an unchanged edit is a no-op, NOT an error.\n');
  out('  => isUnchangedEdit is unnecessary and the skip-identical-renders guard is the\n');
  out('     only thing preventing wasted calls.\n\n');
} catch (err) {
  out(`  THREW:\n${describe(err)}\n\n`);
}

// ---------------------------------------------------------------- 3. the 409
out('--- 3. two concurrent getUpdates (the second instance case) ---\n');
// The first is deliberately short-lived but long enough to still be in flight when the
// second arrives. No offset, so nothing is confirmed and the real bot loses nothing.
const first = bot.api.getUpdates({ timeout: 3 });
let conflict: unknown;
try {
  await bot.api.getUpdates({ timeout: 3 });
  out('  the second call did NOT error — no conflict was produced.\n');
  out('  => the 409 could not be measured this way; see the notes.\n\n');
} catch (err) {
  conflict = err;
  out(`  THREW:\n${describe(err)}\n\n`);
}

// Awaited so nothing is left in flight when the process exits.
const firstResult = await first.then(
  (updates) => `resolved with ${updates.length} update(s)`,
  (err) => `rejected: ${err instanceof GrammyError ? err.description : String(err)}`,
);
out(`  the first call ${firstResult}\n`);
out('  both requests have settled; no poller was ever started\n\n');

out('--- summary for the notes ---\n');
out(`  unchanged edit : ${
  '(see section 2 above)'
}\n`);
out(`  conflict       : ${
  conflict instanceof GrammyError
    ? `error_code ${conflict.error_code}, description present`
    : conflict === undefined ? 'not reproduced' : 'non-GrammyError'
}\n\n`);
