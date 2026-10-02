import { describe, expect, it, vi } from 'vitest';
import { createJobProgress } from '../../src/bot/progress.js';
import { manualClock } from '../../src/clock.js';
import type { Replier } from '../../src/bot/replier.js';

function setup(over: {
  edit?: Replier['edit']; sleep?: (ms: number) => Promise<void>;
  onPermanentFailure?: (err: unknown) => void;
} = {}) {
  const clock = manualClock(0);
  const edits: string[] = [];
  const edit = over.edit ?? vi.fn(async (_id: number, text: string) => { edits.push(text); });
  const replier = { reply: vi.fn(), edit, sendDocument: vi.fn() } as unknown as Replier;
  const progress = createJobProgress({
    replier, messageId: 42, clock, intervalMs: 4_000, header: 'indexing 0xaaa on chain 1',
    ...(over.sleep ? { sleep: over.sleep } : {}),
    ...(over.onPermanentFailure ? { onPermanentFailure: over.onPermanentFailure } : {}),
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

  it('re-sends the SAME render after a 429, because that edit never applied', async () => {
    let call = 0;
    const edit = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        throw Object.assign(new Error('x'), {
          error_code: 429, description: 'Too Many Requests: retry after 5',
          parameters: { retry_after: 5 },
        });
      }
    });
    const { progress, clock } = setup({ edit });
    await progress.onChunk(chunk(10, 1));
    clock.advance(6_000);                              // mute expired
    await progress.onChunk(chunk(10, 1));              // identical render
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it('skips locally the identical render after the server said "not modified"', async () => {
    const edit = vi.fn(async () => {
      throw Object.assign(new Error('x'), {
        error_code: 400, description: 'Bad Request: message is not modified',
      });
    });
    const { progress, clock } = setup({ edit });
    await progress.onChunk(chunk(10, 1));
    clock.advance(10_000);
    await progress.onChunk(chunk(10, 1));              // identical: must not cost another 400
    expect(edit).toHaveBeenCalledOnce();
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
    // A tick that STARTS after finish is dropped by the `finished` guard. (A tick already
    // in flight when finish is called is a different case, pinned below.) If a late tick
    // won, the user would be left reading progress for a job that already ended.
    const { progress, edits, clock } = setup();
    await progress.finish('done: 152 rows');
    clock.advance(60_000);
    await progress.onChunk(chunk(999, 99));
    expect(edits.at(-1)).toContain('done: 152 rows');
  });

  /** An edit whose completion order the test controls: the first call waits on a gate. */
  function gatedFirstEdit() {
    const done: string[] = [];
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const firstEditStarted = new Promise<void>((r) => { reached = r; });
    const edit = vi.fn(async (_id: number, text: string) => {
      calls += 1;
      if (calls === 1) { reached(); await gate; }
      done.push(text);   // pushed AFTER the await: this records completion, not call order
    });
    return { done, edit, release, firstEditStarted };
  }

  it('finish waits for a tick already in flight, so the result is written last', async () => {
    const { done, edit, release, firstEditStarted } = gatedFirstEdit();
    const { progress } = setup({ edit });
    const tick = progress.onChunk(chunk(10, 140));   // not awaited: the real wiring is fire-and-forget
    await firstEditStarted;
    const fin = progress.finish('done: 152 rows');
    release();
    await Promise.all([tick, fin]);
    expect(done).toHaveLength(2);
    expect(done[0]).toContain('rows 140');
    expect(done.at(-1)).toBe('done: 152 rows');
  });

  it('drops a tick that arrives while another is in flight, rather than queueing it', async () => {
    const { done, edit, release, firstEditStarted } = gatedFirstEdit();
    const { progress, clock } = setup({ edit });
    const first = progress.onChunk(chunk(10, 1));
    await firstEditStarted;
    clock.advance(60_000);                            // past the throttle: only in-flight can stop it
    await progress.onChunk(chunk(20, 2));             // a different render, so no text-skip either
    expect(edit).toHaveBeenCalledOnce();
    release();
    await first;
    expect(done).toHaveLength(1);
    expect(done[0]).toContain('rows 1');
  });

  it('finish tolerates an unchanged-edit error (called twice, or same text as shown)', async () => {
    const edit = vi.fn(async () => {
      throw Object.assign(new Error('x'), {
        error_code: 400, description: 'Bad Request: message is not modified',
      });
    });
    const { progress } = setup({ edit });
    await expect(progress.finish('done')).resolves.toBeUndefined();
    await expect(progress.finish('done')).resolves.toBeUndefined();
    expect(edit).toHaveBeenCalledTimes(2);
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

  function rateLimitedOnce(retryAfter: number) {
    let call = 0;
    return vi.fn(async () => {
      call += 1;
      if (call === 1) {
        throw Object.assign(new Error('x'), {
          error_code: 429, description: `Too Many Requests: retry after ${retryAfter}`,
          parameters: { retry_after: retryAfter },
        });
      }
    });
  }

  it('retries the final edit once after retry_after', async () => {
    const edit = rateLimitedOnce(1);
    const sleep = vi.fn(async () => {});
    const { progress } = setup({ edit, sleep });
    await progress.finish('done');
    expect(edit).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
  });

  it('caps the wait before the final retry at 30s', async () => {
    const edit = rateLimitedOnce(300);
    const sleep = vi.fn(async () => {});
    const { progress } = setup({ edit, sleep });
    await progress.finish('done');
    expect(sleep).toHaveBeenCalledExactlyOnceWith(30_000);
    expect(edit).toHaveBeenCalledTimes(2);
  });
});

describe('a permanently undeliverable edit silences the reporter', () => {
  const blocked = () => Object.assign(new Error('Forbidden: bot was blocked by the user'), {
    error_code: 403, description: 'Forbidden: bot was blocked by the user',
  });
  const deleted = () => Object.assign(new Error('Bad Request: message to edit not found'), {
    error_code: 400, description: 'Bad Request: message to edit not found',
  });

  it.each([['403 (blocked)', blocked], ['400 message not found', deleted]])(
    'after a %s, makes ONE attempt across many ticks, then finish and fail, and never throws',
    async (_name, make) => {
      const edit = vi.fn(async () => { throw make(); });
      const seen: unknown[] = [];
      const { progress, clock } = setup({ edit, onPermanentFailure: (e) => seen.push(e) });
      await expect(progress.onChunk(chunk(10, 1))).resolves.toBeUndefined();
      // Every later tick is past the interval, so only the quiet flag can stop it.
      for (let i = 0; i < 10; i++) {
        clock.advance(5_000);
        await progress.onChunk(chunk(20 + i * 10, i + 2));
      }
      await expect(progress.finish('done')).resolves.toBeUndefined();
      await expect(progress.fail(
        { exitCode: 2, headline: 'h', detail: 'd' }, '/help',
      )).resolves.toBeUndefined();
      expect(edit).toHaveBeenCalledOnce();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ error_code: expect.any(Number) });
    },
  );

  it('goes quiet when the FINAL edit is the one that fails permanently, without throwing', async () => {
    const edit = vi.fn(async () => { throw blocked(); });
    const seen: unknown[] = [];
    const { progress } = setup({ edit, onPermanentFailure: (e) => seen.push(e) });
    await expect(progress.finish('done')).resolves.toBeUndefined();
    await expect(progress.fail({ exitCode: 2, headline: 'h', detail: 'd' })).resolves.toBeUndefined();
    expect(edit).toHaveBeenCalledOnce();
    expect(seen).toHaveLength(1);
  });

  it('goes quiet when the RETRY of a rate-limited final edit fails permanently', async () => {
    let call = 0;
    const edit = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        throw Object.assign(new Error('x'), {
          error_code: 429, description: 'Too Many Requests: retry after 1',
          parameters: { retry_after: 1 },
        });
      }
      throw blocked();
    });
    const seen: unknown[] = [];
    const { progress } = setup({ edit, sleep: async () => {}, onPermanentFailure: (e) => seen.push(e) });
    await expect(progress.finish('done')).resolves.toBeUndefined();
    expect(edit).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(1);
  });

  it('a TRANSIENT failure does not silence it: the next tick tries again', async () => {
    const edit = vi.fn(async () => { throw new Error('socket hang up'); });
    const seen: unknown[] = [];
    const { progress, clock } = setup({ edit, onPermanentFailure: (e) => seen.push(e) });
    await expect(progress.onChunk(chunk(10, 1))).rejects.toThrow('socket hang up');
    clock.advance(5_000);
    await expect(progress.onChunk(chunk(20, 2))).rejects.toThrow('socket hang up');
    expect(edit).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(0);
  });

  it('a 400 that is not "message to edit not found" is transient, not permanent', async () => {
    const edit = vi.fn(async () => {
      throw Object.assign(new Error('x'), { error_code: 400, description: 'Bad Request: chat not found' });
    });
    const { progress, clock } = setup({ edit });
    await expect(progress.onChunk(chunk(10, 1))).rejects.toThrow();
    clock.advance(5_000);
    await expect(progress.onChunk(chunk(20, 2))).rejects.toThrow();
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it('a callback that throws does not break the silence', async () => {
    const edit = vi.fn(async () => { throw blocked(); });
    const { progress, clock } = setup({ edit, onPermanentFailure: () => { throw new Error('logger down'); } });
    await expect(progress.onChunk(chunk(10, 1))).resolves.toBeUndefined();
    clock.advance(5_000);
    await progress.onChunk(chunk(20, 2));
    expect(edit).toHaveBeenCalledOnce();
  });
});
