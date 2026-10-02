import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Update } from 'grammy/types';
import { buildBot, type BotDeps } from '../../src/bot/app.js';
import type { IndexRun } from '../../src/bot/commands/index.js';
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
    secrets: [],
    db, clock,
    registry: createJobRegistry({ clock, staleMs: 900_000 }),
    logger: createLogger([], new Writable({ write(_c, _e, cb) { cb(); } })),
    defaultChainId: 1,
    chainName: (id) => (id === 8453 ? 'base' : id === 1 ? 'ethereum' : `chain ${id}`),
    prepare: async () => ({
      fetchPath: 'getAssetTransfers',
      estimate: estimate as unknown as IndexRun['estimate'],
      runBackfill: runBackfill as unknown as IndexRun['runBackfill'],
    }),
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

describe('chat output is scrubbed through the wiring', () => {
  it('an /index failure whose error carries an RPC URL replies WITHOUT the key', async () => {
    // Plain string: no generic URL/key fallback pass can catch it, so only the configured tokens can.
    const FAKE_KEY = 'zz-fake-secret-ZXCV0987654321';
    const FAKE_URL = `see ${FAKE_KEY} here`;
    const { bot, calls } = setup({
      secrets: [FAKE_KEY],
      prepare: async () => ({
        fetchPath: 'getLogs',
        estimate: async () => { throw new Error(`request to ${FAKE_URL} failed`); },
        runBackfill: async () => { throw new Error('unreachable'); },
      }),
    });
    await bot.handleUpdate(command(ALLOWED, `/index ${ADDR}`));
    await flush();
    const text = calls.map((c) => c.text ?? '').join('\n');
    expect(text).toContain('failed');
    expect(text).not.toContain(FAKE_KEY);
  });

  /**
   * Captures what would actually go over the wire.
   *
   * MEASURED, not assumed: grammY calls the LAST-installed transformer FIRST, so the scrub
   * `buildBot` installs is the INNERMOST one — correct, since nothing downstream can then
   * reintroduce a secret, but it means a test recorder installed afterwards short-circuits
   * above it and sees pre-scrub payloads. Stubbing `client.fetch` instead observes the
   * request after every transformer has run, which is the only position that proves what
   * leaves the process. Nothing is sent: the stub never calls the network.
   */
  function wireTap() {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchStub = (async (_url: unknown, init: unknown) => {
      const body = (init as { body?: string } | undefined)?.body;
      if (typeof body === 'string') bodies.push(JSON.parse(body) as Record<string, unknown>);
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 7, date: 0, chat: { id: 1 } } }),
      };
    }) as unknown as typeof fetch;
    return { bodies, fetchStub };
  }

  it('scrubs a handler that BYPASSES the replier and calls ctx.api directly', async () => {
    // The replier's scrubbing is a convention every handler has to follow. This is the gate
    // that does not depend on remembering: the transformer sits under every outbound call,
    // whatever made it, so a handler written later that reaches for `ctx.api` cannot leak.
    const FAKE_KEY = 'zz-fake-secret-ZXCV0987654321';
    const { bodies, fetchStub } = wireTap();
    // buildBot directly, not via setup(): setup installs a recording transformer, and
    // being installed LAST it runs first and short-circuits above the scrub.
    const { deps } = setup({ secrets: [FAKE_KEY] });
    const bot = buildBot({ ...deps, botConfig: { botInfo, client: { fetch: fetchStub } } });
    bot.command('direct', async (ctx) => {
      await ctx.api.sendMessage(ctx.chat!.id, `leaking ${FAKE_KEY} straight out`);
    });
    await bot.handleUpdate(command(ALLOWED, '/direct'));
    await flush();
    const sent = bodies.map((b) => String(b.text ?? '')).join('\n');
    expect(sent).toContain('leaking');
    expect(sent).not.toContain(FAKE_KEY);
  });

  it('leaves non-string payload fields alone, so an upload is not reshaped', async () => {
    const FAKE_KEY = 'zz-fake-secret-ZXCV0987654321';
    const { bodies, fetchStub } = wireTap();
    const { deps } = setup({ secrets: [FAKE_KEY] });
    const bot = buildBot({ ...deps, botConfig: { botInfo, client: { fetch: fetchStub } } });
    bot.command('direct', async (ctx) => {
      await ctx.api.sendMessage(ctx.chat!.id, 'hello', { disable_notification: true });
    });
    await bot.handleUpdate(command(ALLOWED, '/direct'));
    await flush();
    expect(bodies[0]).toMatchObject({ disable_notification: true, text: 'hello' });
    expect(typeof bodies[0]!.chat_id).toBe('number');
  });
});

describe('a failing prepare', () => {
  it('starts NO job and tells the user, never "Indexing"', async () => {
    const { bot, calls, deps } = setup({
      prepare: async () => { throw new Error('the chain is unreachable'); },
    });
    // `--yes` and a dry run both go through prepare; neither may start anything.
    for (const text of [`/index ${ADDR}`, `/index ${ADDR} --yes`, `/index ${ADDR} --dry-run`]) {
      await bot.handleUpdate(command(ALLOWED, text));
    }
    await flush();
    expect(deps.registry.inspect(db, { chainId: 1, contract: ADDR }).kind).toBe('idle');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.text ?? '').not.toMatch(/^Indexing /);
      expect(c.text ?? '').toMatch(/unreachable/);
    }
  });
});
