import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Update } from 'grammy/types';
import { buildBot, task13Placeholders, type BotDeps } from '../../src/bot/app.js';
import { createJobRegistry } from '../../src/bot/jobs.js';
import { manualClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLogger } from '../../src/logger.js';
import { Writable } from 'node:stream';

/**
 * The WIRING, not the handlers. Each handler is tested on its own; what can regress here is
 * the ORDER (the allowlist must run before every handler) and what the entry point passes in.
 *
 * No network: `botInfo` skips `getMe`, `handleUpdate` is driven directly, and a transformer on
 * `bot.api` records every outbound call and answers it, so "the bot said nothing" is an
 * assertion over a list of ALL outbound methods rather than over the ones someone thought of.
 */
const ALLOWED = 111;
const STRANGER = 999;
const ADDR = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const flush = () => new Promise<void>((r) => setImmediate(r));

const botInfo = {
  id: 1, is_bot: true as const, first_name: 'byakugan', username: 'byakugan_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:'); runMigrations(db); });

function setup(over: Partial<BotDeps> = {}) {
  const clock = manualClock(0);
  const drops: string[] = [];
  const handlerErrors: unknown[] = [];
  const calls: Array<{ method: string; text?: string }> = [];
  const estimate = vi.fn(async (_a: unknown) => ({ seconds: 30, summary: 'DRY RUN REPORT' }));
  const runBackfill = vi.fn(async (_a: unknown) => { await new Promise(() => undefined); throw new Error('unreachable'); });
  const deps: BotDeps = {
    token: '123456:TEST-TOKEN-NOT-REAL',
    allowedUserIds: new Set([ALLOWED]),
    db, clock,
    registry: createJobRegistry({ clock, staleMs: 900_000 }),
    logger: createLogger([], new Writable({ write(_c, _e, cb) { cb(); } })),
    defaultChainId: 1,
    chainName: (id) => (id === 8453 ? 'base' : id === 1 ? 'ethereum' : `chain ${id}`),
    fetchPath: () => 'getAssetTransfers',
    estimate: estimate as BotDeps['estimate'],
    runBackfill: runBackfill as unknown as BotDeps['runBackfill'],
    staleMs: 900_000,
    confirmThresholdSeconds: 300,
    logDrop: (m) => { drops.push(m); },
    onHandlerError: (e) => { handlerErrors.push(e); },
    botConfig: { botInfo },
    ...over,
  };
  const bot = buildBot(deps);
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, text: (payload as { text?: string }).text });
    return { ok: true, result: { message_id: 7 } } as never;
  });
  return { bot, deps, calls, drops, handlerErrors, estimate, runBackfill };
}

let updateId = 0;
function command(fromId: number | undefined, text: string): Update {
  const space = text.indexOf(' ');
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId, date: 0,
      chat: { id: fromId ?? 5, type: 'private', first_name: 'x' },
      ...(fromId === undefined ? {} : { from: { id: fromId, is_bot: false, first_name: 'x' } }),
      text,
      entities: [{ type: 'bot_command', offset: 0, length: space === -1 ? text.length : space }],
    },
  } as Update;
}

const EVERY_COMMAND = [
  '/start', '/help', '/status', `/status ${ADDR}`,
  `/index ${ADDR}`, `/index ${ADDR} --dry-run`, `/index ${ADDR} --chain 8453 --yes`,
  `/firstminters ${ADDR}`, `/firstrecipients ${ADDR}`, `/overlap ${ADDR} ${ADDR}`,
];

describe('the allowlist is first', () => {
  it.each(EVERY_COMMAND)('an unauthorized user sending %s gets NOTHING', async (text) => {
    const { bot, calls, estimate, runBackfill, deps, drops } = setup();
    await bot.handleUpdate(command(STRANGER, text));
    await flush();
    // Not an error message either: a refusal confirms the bot exists.
    expect(calls).toEqual([]);
    // Nor did any handler get as far as work: no estimate, no job, no claim.
    expect(estimate).not.toHaveBeenCalled();
    expect(runBackfill).not.toHaveBeenCalled();
    expect(deps.registry.inspect(db, { chainId: 1, contract: ADDR }).kind).toBe('idle');
    // The drop is logged for the operator, in the log channel and not the chat.
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain(String(STRANGER));
  });

  it('an update with NO sender gets nothing', async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(command(undefined, '/help'));
    expect(calls).toEqual([]);
  });

  it('an allowed user DOES reach the handlers, so the gate is not simply closed', async () => {
    const { bot, calls, drops } = setup();
    await bot.handleUpdate(command(ALLOWED, '/help'));
    expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
    // The content, not merely that something was sent.
    expect(calls[0]?.text).toContain('/firstminters 0x…');
    expect(drops).toEqual([]);
  });

  it('an allowed user reaches the /index handler and its dependencies', async () => {
    const { bot, estimate, calls } = setup();
    await bot.handleUpdate(command(ALLOWED, `/index ${ADDR} --dry-run`));
    expect(estimate).toHaveBeenCalledOnce();
    expect(calls.map((c) => c.text)).toEqual(['DRY RUN REPORT']);
  });

  it('a handler that throws does not kill the poll loop', async () => {
    // Driven through `bot.start()`, because that is where grammY applies `bot.catch`:
    // `handleUpdate` alone rethrows. The update is served once, then the loop is stopped.
    const { bot, handlerErrors } = setup();
    let served = false;
    bot.api.config.use(async (prev, method, payload) => {
      if (method === 'deleteWebhook') return { ok: true, result: true } as never;
      if (method === 'getUpdates') {
        if (served) { await bot.stop(); return { ok: true, result: [] } as never; }
        served = true;
        return { ok: true, result: [command(ALLOWED, '/help')] } as never;
      }
      // sendMessage: the reply itself fails, so the /help handler throws.
      void prev; void payload;
      throw new Error('telegram is down');
    });
    await bot.start();
    expect(handlerErrors).toHaveLength(1);
    expect((handlerErrors[0] as Error).message).toBe('telegram is down');
  });
});

describe('/index names the chain it parsed', () => {
  it('shows the parsed chain, not the default chain, on the line that says what is running', async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(command(ALLOWED, `/index ${ADDR} --chain 8453`));
    await flush();
    const text = calls[0]?.text ?? '';
    expect(text).toContain('on chain 8453 (base)');
    expect(text).not.toContain('ethereum');
  });
});

describe('Task 13 placeholders fail loudly', () => {
  it('each one throws and names Task 13, rather than returning a value', async () => {
    const p = task13Placeholders();
    await expect(p.estimate({ chainId: 1, contract: ADDR })).rejects.toThrow(/Task 13/);
    await expect(p.runBackfill({
      chainId: 1, contract: ADDR, level: 'full', onProgress: () => undefined,
    })).rejects.toThrow(/Task 13/);
    expect(() => p.fetchPath()).toThrow(/Task 13/);
  });

  it('an unwired /index starts NO job and tells the user it failed, never "Indexing"', async () => {
    const { bot, calls, deps } = setup({ ...task13Placeholders() });
    // `--yes` and a long run would pass an inert gate; a dry run would reply with nothing.
    for (const text of [`/index ${ADDR}`, `/index ${ADDR} --yes`, `/index ${ADDR} --dry-run`]) {
      await bot.handleUpdate(command(ALLOWED, text));
    }
    await flush();
    expect(deps.registry.inspect(db, { chainId: 1, contract: ADDR }).kind).toBe('idle');
    for (const c of calls) {
      expect(c.text ?? '').not.toMatch(/^Indexing /);
      expect(c.text ?? '').not.toBe('');
    }
  });
});
