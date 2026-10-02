/**
 * Proves the output-boundary scrubber actually redacts a named credential, before any
 * script is run against the endpoint that credential belongs to.
 *
 *   npm run verify:scrub -- TELEGRAM_BOT_TOKEN
 *
 * WHY THIS EXISTS AS A SCRIPT rather than a test: a test cannot use a real credential,
 * because CI and a fresh clone do not have one. `test/unit/scrubOutput.test.ts` covers the
 * mechanism with fabricated secrets; this covers a SPECIFIC real one, on the machine that
 * holds it, at the moment it starts being used.
 *
 * It exists at all because the rule it checks was broken once. A probe hit HTTP 429, the
 * unhandled error printed its full dump including the request URL, and an Alchemy key
 * reached a conversation transcript in plain text and had to be rotated. The probe did
 * scrub — per call site, in its happy path only. Adding a credential is exactly when that
 * mistake repeats, so this runs first and the answer is a yes or a no rather than a belief.
 *
 * It never prints the secret. The child tries to leak it four ways; the parent only ever
 * reports whether the value appears, and the value is read solely to search for it.
 */
import './_scrub-output.js'; // MUST be first.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const SELF = fileURLToPath(import.meta.url);
const CHILD_FLAG = '--leak-attempt';

const name = process.argv.find((a) => /^[A-Z][A-Z0-9_]*$/.test(a));
if (!name) {
  throw new Error('name the environment variable to check, e.g. TELEGRAM_BOT_TOKEN');
}

/**
 * Child mode: try every path by which a credential has ever reached output in this
 * project, including the one that actually leaked — an uncaught error carrying a URL.
 */
if (process.argv.includes(CHILD_FLAG)) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in this environment`);

  process.stdout.write(`direct-stdout: ${value}\n`);
  process.stderr.write(`direct-stderr: ${value}\n`);
  console.log(`console-log: ${value}`);
  // The grammY request shape: the token sits in the path of every call it makes.
  process.stdout.write(`in-a-url: https://api.telegram.org/bot${value}/sendMessage\n`);
  // URL-encoded, since a secret containing ':' is escaped when embedded in a query.
  process.stdout.write(`encoded: ${encodeURIComponent(value)}\n`);
  // THE PATH THAT ACTUALLY LEAKED: an unhandled rejection whose message holds the URL.
  void Promise.reject(new Error(
    `unhandled: request to https://api.telegram.org/bot${value}/getUpdates failed`,
  ));
  // And an uncaught throw, which Node prints through its own handler.
  setTimeout(() => {
    throw new Error(`uncaught: https://api.telegram.org/bot${value}/getMe timed out`);
  }, 10);
} else {
  // ---- Parent: run the child and inspect what escaped.
  const config = loadConfig();
  const secret = process.env[name];
  if (!secret) {
    process.stdout.write(`\n${name} is not set. Nothing to verify.\n\n`);
    process.exitCode = 1;
  } else {
    const inSecrets = config.secrets.includes(secret);

    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        ['--import', 'tsx', SELF, name, CHILD_FLAG],
        { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (thrown) {
      const e = thrown as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }

    const leaked = output.includes(secret);
    const encodedLeaked = output.includes(encodeURIComponent(secret))
      && encodeURIComponent(secret) !== secret;

    process.stdout.write([
      '',
      `secret-scrub check for ${name}`,
      '',
      `  in config.secrets          ${inSecrets ? 'YES' : 'NO  <-- the scrub cannot cover it'}`,
      `  child produced output      ${output.length} characters`,
      `  raw value present          ${leaked ? 'YES  <-- LEAK' : 'no'}`,
      `  url-encoded form present   ${encodedLeaked ? 'YES  <-- LEAK' : 'no'}`,
      '',
      '  the child attempted: stdout, stderr, console.log, inside a request URL,',
      '  url-encoded, an unhandled rejection, and an uncaught throw.',
      '',
      `  VERDICT: ${!leaked && !encodedLeaked && inSecrets
        ? 'SAFE — the boundary redacts this credential on every path tried'
        : 'NOT SAFE — do not run anything against this endpoint'}`,
      '',
    ].join('\n'));

    // The redacted output, which is safe to show precisely because it is redacted.
    process.stdout.write('  what the child actually emitted:\n');
    for (const line of output.split('\n').filter((l) => l.trim().length > 0).slice(0, 10)) {
      process.stdout.write(`    ${line.slice(0, 140)}\n`);
    }
    process.stdout.write('\n');

    if (leaked || encodedLeaked || !inSecrets) process.exitCode = 1;
  }
}
