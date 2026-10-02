import { describe, expect, it, vi } from 'vitest';
import { createJobProgress } from '../../src/bot/progress.js';
import { manualClock } from '../../src/clock.js';
import type { Replier } from '../../src/bot/replier.js';

function setup(over: { edit?: Replier['edit']; sleep?: (ms: number) => Promise<void> } = {}) {
  const clock = manualClock(0);
  const edits: string[] = [];
  const edit = over.edit ?? vi.fn(async (_id: number, text: string) => { edits.push(text); });
  const replier = { reply: vi.fn(), edit, sendDocument: vi.fn() } as unknown as Replier;
  const progress = createJobProgress({
    replier, messageId: 42, clock, intervalMs: 4_000, header: 'indexing 0xaaa on chain 1',
    ...(over.sleep ? { sleep: over.sleep } : {}),
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
    // finish/fail write the result, and a throttled tick can still be in flight when they
    // do. If a late tick wins, the user is left reading progress for a job that already ended.
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
