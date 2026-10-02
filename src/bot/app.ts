/**
 * The bot's wiring, separated from its entry point so a test can build one.
 *
 * `src/bot/index.ts` runs `main()` as an import side effect (the scrubbing import has to
 * be a side effect too), so anything a test needs must live here: importing the entry point
 * from a test would start a poller. Nothing here touches the network on its own.
 */
import { Bot, type BotConfig, type Context } from 'grammy';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import { ConfigError } from '../errors.js';
import { EXIT, describeError, formatError, type ExitCode } from '../report.js';
import { isConflict, isUnauthorized } from '../telegram/failures.js';
import { allowOnly } from './auth.js';
import type { JobRegistry } from './jobs.js';
import { deriveSecretTokens } from '../secrets.js';
import { makeReplier as makeScrubbedReplier } from './replier.js';
import { handleIndex, type HandleIndexDeps } from './commands/index.js';
import { handleStatus } from './commands/status.js';
import { handleFirstMinters, handleFirstRecipients, handleOverlap } from './commands/queries.js';

export const STALE_LOCK_MS = 15 * 60_000;
export const CONFIRM_THRESHOLD_SECONDS = 300;

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
 * THE 409 GOES TO THE INCUMBENT, which is the opposite of what this was first designed
 * around. Measured against a live bot: two concurrent `getUpdates` and the SECOND
 * succeeded while the FIRST was rejected with "terminated by other getUpdates request".
 * Telegram does not refuse a newcomer; it kills the existing request and serves the new
 * one. So a process receiving a 409 has been DISPLACED and cannot poll at all — exiting is
 * the only honest response, and there is no split-brain to prevent because only one poller
 * ever receives updates.
 *
 * What this changes is the advice. Telling the displaced process's operator to "stop the
 * other instance and start this one" produces a flip-flop: restarting it displaces the
 * other, which exits and gets restarted in turn. The message has to say it was displaced
 * and that restarting blindly trades places.
 */
export function classifyStartupFailure(
  err: unknown,
): { exitCode: ExitCode; message: string } | undefined {
  if (isConflict(err)) {
    return {
      exitCode: EXIT.BUSY,
      message:
        `Another instance has taken over polling and this one (pid ${process.pid}) is ` +
        'stopping. Telegram terminates the existing getUpdates request when a new one ' +
        'arrives, so this process can no longer receive updates.\n' +
        '  The likely cause is an older process still running — check for one before ' +
        'assuming this was a one-off.\n' +
        '  Do NOT simply restart this instance: it would displace the other in turn and ' +
        'the two would trade places indefinitely. Find and stop the other one first.\n' +
        '  Any /index job that was running here has died; its collection lock clears on ' +
        'the stale timeout and /status reports it as orphaned until then.',
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

/**
 * Stand-ins for the dependencies Task 13 supplies (the chain-facing half of `/index`).
 *
 * EVERY ONE THROWS. A placeholder that returned a plausible value would be a silent
 * defect, not a stub: `estimate` returning `{ seconds: 0, summary: '' }` makes the
 * confirmation gate inert (nothing ever exceeds the threshold) and `--dry-run` reply with
 * an empty report, and that is exactly the shape of the dry-run-only capability probe this
 * project has already shipped — correct code, correctly wired, quietly doing nothing.
 */
export function task13Placeholders(): Pick<BotDeps, 'estimate' | 'runBackfill' | 'fetchPath'> {
  const notWired = (what: string): never => {
    throw new Error(`${what} is not wired yet: it is supplied by Task 13.`);
  };
  return {
    estimate: async () => notWired('/index estimate'),
    runBackfill: async () => notWired('/index runBackfill'),
    fetchPath: () => notWired('/index fetchPath'),
  };
}

/** What `main` passes as `logDrop`: to stderr, where the stream scrub covers it. */
export function writeDropLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** What `main` passes as `onHandlerError`: a failing handler must leave a record. */
export function writeHandlerError(err: unknown): void {
  process.stderr.write(formatError(describeError(err)));
}

export interface BotDeps {
  token: string;
  allowedUserIds: ReadonlySet<number>;
  /** Raw secrets (`config.secrets`); the replier scrubs every outbound chat string with them. */
  secrets: string[];
  db: Database.Database;
  clock: Clock;
  registry: JobRegistry;
  logger: Logger;
  defaultChainId: number | undefined;
  /** Looked up per command with the PARSED chain id; see `HandleIndexDeps.chainName`. */
  chainName(chainId: number): string;
  /** A function so a placeholder can throw when asked rather than at construction. */
  fetchPath(): string;
  estimate: HandleIndexDeps['estimate'];
  runBackfill: HandleIndexDeps['runBackfill'];
  staleMs: number;
  confirmThresholdSeconds: number;
  /** Where "dropped an update from user N" goes. Never a chat. */
  logDrop(message: string): void;
  /** Where a throwing handler's error goes. The poll loop survives it. */
  onHandlerError(err: unknown): void;
  /**
   * Supplying `botInfo` skips grammY's `getMe` call, which is what lets a test drive
   * `handleUpdate` with no network. Production leaves it unset.
   */
  botConfig?: BotConfig<Context>;
}

/**
 * Builds the bot and registers everything, with the allowlist FIRST.
 *
 * Order is the security property: grammY runs middleware in registration order, and a
 * command handler that matches does not call `next()`, so any handler registered before
 * `allowOnly` answers whoever sent the update. `test/unit/botWiring.test.ts` pins this.
 */
export function buildBot(d: BotDeps): Bot {
  const bot = new Bot(d.token, d.botConfig);
  // Derived ONCE; every outbound chat string is scrubbed with these inside the replier.
  const tokens = deriveSecretTokens(d.secrets);
  const makeReplier = (ctx: Context) => makeScrubbedReplier(ctx, tokens);

  // FIRST, before any handler.
  bot.use(allowOnly(d.allowedUserIds, d.logDrop));

  bot.command('help', async (ctx) => {
    await makeReplier(ctx).reply([
      'Byakugan — NFT minter and buyer tracking',
      '',
      '/index 0x… [--chain N] [--mints-only|--logs-only] [--to-block N] [--yes]',
      '/status [0x…]',
      '/firstminters 0x… [--chain N] [--limit N]',
      '/firstrecipients 0x… [--chain N] [--limit N]',
      '/overlap 0x… 0x… [--min N]',
      '',
      'Levels: logs_only indexes without transactions and cannot answer /firstminters;',
      'mints_only fetches mint transactions; full fetches everything and is the default.',
      'A collection’s level is fixed when it is first indexed.',
    ].join('\n'));
  });
  bot.command('start', async (ctx) => {
    await makeReplier(ctx).reply('Ready. /help for commands.');
  });

  bot.command('index', async (ctx) => {
    const replier = makeReplier(ctx);
    let fetchPath: string;
    try {
      fetchPath = d.fetchPath();
    } catch (err) {
      // Before the job exists, so the user is told rather than left with silence.
      const reported = describeError(err);
      await replier.reply(`${reported.headline}

  ${reported.detail}`);
      return;
    }
    await handleIndex({
      text: ctx.message?.text ?? '', replier, db: d.db, clock: d.clock,
      registry: d.registry, logger: d.logger, defaultChainId: d.defaultChainId,
      chainName: d.chainName,
      fetchPath,
      confirmThresholdSeconds: d.confirmThresholdSeconds,
      estimate: d.estimate,
      runBackfill: d.runBackfill,
    });
  });

  bot.command('status', async (ctx) => {
    await handleStatus({
      text: ctx.message?.text ?? '', replier: makeReplier(ctx), db: d.db, clock: d.clock,
      registry: d.registry, defaultChainId: d.defaultChainId, staleMs: d.staleMs,
    });
  });

  const queryDeps = (text: string, replier: ReturnType<typeof makeReplier>) => ({
    text, replier, db: d.db, clock: d.clock, registry: d.registry,
    defaultChainId: d.defaultChainId,
  });
  bot.command('firstminters', async (ctx) => {
    await handleFirstMinters(queryDeps(ctx.message?.text ?? '', makeReplier(ctx)));
  });
  bot.command('firstrecipients', async (ctx) => {
    await handleFirstRecipients(queryDeps(ctx.message?.text ?? '', makeReplier(ctx)));
  });
  bot.command('overlap', async (ctx) => {
    await handleOverlap(queryDeps(ctx.message?.text ?? '', makeReplier(ctx)));
  });

  // A handler that throws must not kill the poll loop.
  bot.catch((err) => d.onHandlerError(err.error));

  return bot;
}
