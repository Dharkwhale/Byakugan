/**
 * `npm run bot`
 *
 * THE SCRUBBING IMPORT IS FIRST and must stay first. grammY builds request URLs as
 * api.telegram.org/bot<TOKEN>/… and prints them in error dumps, so without this an
 * unhandled error puts the bot token in the terminal — the same shape that put an
 * Alchemy key in a transcript and cost a rotation.
 *
 * The wiring lives in `./app.ts` so tests can build a bot without starting this process.
 */
import '../outputScrubbing.js';

import { systemClock } from '../clock.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createLogger } from '../logger.js';
import { EXIT, formatError, describeError } from '../report.js';
import {
  CONFIRM_THRESHOLD_SECONDS, STALE_LOCK_MS, buildBot, classifyStartupFailure,
  requireBotConfig, writeDropLog, writeHandlerError,
} from './app.js';
import { makePrepare } from './indexRun.js';
import { createJobRegistry } from './jobs.js';

async function main(): Promise<number> {
  const config = loadConfig();
  const { token, allowedUserIds } = requireBotConfig(config);

  // The pid, on every start. A handover leaves no error anywhere once the displaced process
  // is gone — the new bot works, the old one vanishes, and neither chat shows anything — so
  // without this a flip-flop is diagnosed by guessing.
  process.stderr.write(`byakugan bot starting, pid ${process.pid}\n`);

  const db = openDb(config.dbPath);
  runMigrations(db);

  const bot = buildBot({
    token, allowedUserIds, db, secrets: config.secrets,
    clock: systemClock,
    registry: createJobRegistry({ clock: systemClock, staleMs: STALE_LOCK_MS }),
    // To stderr, scrubbed at serialization by the logger as well as by the stream guard.
    logger: createLogger(config.secrets, process.stderr),
    defaultChainId: config.defaultChainId,
    chainName: (chainId) => config.chains.get(chainId)?.name ?? `chain ${chainId}`,
    staleMs: STALE_LOCK_MS,
    confirmThresholdSeconds: CONFIRM_THRESHOLD_SECONDS,
    logDrop: writeDropLog,
    onHandlerError: writeHandlerError,
    // One chain-facing build per /index command; the label, estimate and run share it.
    prepare: makePrepare({ config, db, clock: systemClock, staleLockMs: STALE_LOCK_MS }),
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
