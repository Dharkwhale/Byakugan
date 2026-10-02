import { describe, expect, it, vi } from 'vitest';
import {
  MESSAGE_BUDGET, renderTable, respond, sanitizeOnChainText, toCsv,
} from '../../src/bot/render.js';
import type { Replier } from '../../src/bot/replier.js';

function fakeReplier() {
  const reply = vi.fn(async (_t: string) => ({ messageId: 1 }));
  const edit = vi.fn(async (_id: number, _t: string) => undefined);
  const sendDocument = vi.fn(async (_a: { filename: string; contents: string; caption: string }) => undefined);
  return { replier: { reply, edit, sendDocument } as Replier, reply, edit, sendDocument };
}

// String.prototype.isWellFormed is Node 20+ but absent from this project's TS lib target.
const wellFormed = (s: string): boolean => (s as unknown as { isWellFormed(): boolean }).isWellFormed();

describe('sanitizeOnChainText', () => {
  // name() is attacker-controlled. Dropping parse_mode handles Markdown; none of these
  // involve Markdown at all.
  it('strips newlines, which would forge message structure', () => {
    expect(sanitizeOnChainText('Cool\nCollection\r\nFake: 999')).toBe('Cool Collection Fake: 999');
  });

  it('strips control characters', () => {
    expect(sanitizeOnChainText('A\u0000B\u0007C\u001bD')).toBe('ABCD');
  });

  // Escapes, not literals: a bidi control pasted into source is invisible and easily lost.
  it('strips bidi overrides, which can make text read as something else', () => {
    expect(sanitizeOnChainText('abc\u202edef\u202c')).toBe('abcdef');
    expect(sanitizeOnChainText('\u2066x\u2069')).toBe('x');
  });

  it('collapses whitespace runs', () => {
    expect(sanitizeOnChainText('a     b\t\tc')).toBe('a b c');
  });

  it('truncates a long name rather than letting it eat the message budget', () => {
    const out = sanitizeOnChainText('x'.repeat(2000));
    expect(out.length).toBeLessThanOrEqual(65);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not split a surrogate pair at the truncation boundary', () => {
    // isWellFormed() rather than a surrogate regex: that regex was twice written to disk as
    // literal U+FFFD characters by mistake, which can never match and made the check vacuous.
    // 63 x's, then an emoji whose high surrogate sits at UTF-16 index 63.
    const out = sanitizeOnChainText('x'.repeat(63) + '😀yyy');
    expect(wellFormed(out)).toBe(true);
    expect(out).toBe('x'.repeat(63) + '😀…');
    // A cut that lands on code-unit 64 but code point 62: slice() would keep only two of the
    // three emoji, so the exact string is what pins this case.
    const out2 = sanitizeOnChainText('x'.repeat(60) + '😀😀😀yyyy');
    expect(wellFormed(out2)).toBe(true);
    expect(out2).toBe('x'.repeat(60) + '😀😀😀y…');
  });

  it('turns an all-invisible name into the placeholder', () => {
    expect(sanitizeOnChainText('\u200b\u200c\u200d\u2060')).toBe('(unnamed)');
  });

  it('strips LRM, RLM and ALM, which can still reorder text', () => {
    expect(sanitizeOnChainText('foo\u200e bar')).toBe('foo bar');
    expect(sanitizeOnChainText('a\u200fb\u061cc')).toBe('abc');
  });

  it('renders an absent name as a placeholder, not as "undefined"', () => {
    expect(sanitizeOnChainText(null)).toBe('(unnamed)');
    expect(sanitizeOnChainText('')).toBe('(unnamed)');
  });
});

describe('respond', () => {
  const small = {
    title: 'First minters', headers: ['wallet', 'minted'],
    rows: [['0xaaa', '3'], ['0xbbb', '1']], filename: 'firstminters-1-0xaaa-123.csv',
  };

  it('sends a message when the output fits', async () => {
    const { replier, reply, sendDocument } = fakeReplier();
    await respond(replier, small);
    expect(reply).toHaveBeenCalledOnce();
    expect(sendDocument).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]![0]).toContain('First minters');
  });

  it('sends a CSV document once the output exceeds the budget', async () => {
    const { replier, reply, sendDocument } = fakeReplier();
    const rows = Array.from({ length: 500 }, (_, i) => [`0x${String(i).padStart(40, '0')}`, '1']);
    await respond(replier, { ...small, rows });
    expect(sendDocument).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    const doc = sendDocument.mock.calls[0]![0];
    expect(doc.contents.split('\n')[0]).toBe('wallet,minted');
    expect(doc.contents.split('\n')).toHaveLength(501);
    expect(doc.caption).toContain('500');
  });

  it('BOUNDS an over-long caption, because Telegram rejects the whole send', async () => {
    // A caller composes the title and it can grow with its input. Over Telegram's limit the
    // sendDocument is REJECTED, so an answer too long for a message becomes no answer at
    // all — the failure lands exactly on the large results this path exists for. The rows
    // are never abridged; only the label is, and it says so.
    const { replier, sendDocument } = fakeReplier();
    const rows = Array.from({ length: 500 }, (_, i) => [`0x${String(i).padStart(40, '0')}`, '1']);
    await respond(replier, { ...small, title: 'T'.repeat(5_000), rows });
    const { caption } = sendDocument.mock.calls[0]![0];
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption).toContain('caption truncated');
    // The file itself is untouched by the truncation.
    expect(sendDocument.mock.calls[0]![0].contents.split('\n')).toHaveLength(501);
  });

  it('leaves a caption that already fits completely alone', async () => {
    const { replier, sendDocument } = fakeReplier();
    const rows = Array.from({ length: 500 }, (_, i) => [`0x${String(i).padStart(40, '0')}`, '1']);
    await respond(replier, { ...small, rows });
    expect(sendDocument.mock.calls[0]![0].caption).not.toContain('truncated');
  });

  it('switches on the rendered LENGTH, not on a row count', async () => {
    // One rule for every command, and the real limit is characters.
    const { replier, sendDocument } = fakeReplier();
    await respond(replier, { ...small, rows: [['x'.repeat(MESSAGE_BUDGET + 1), '1']] });
    expect(sendDocument).toHaveBeenCalledOnce();
  });

  it('quotes a CSV field containing a comma or a quote', async () => {
    const { replier, sendDocument } = fakeReplier();
    const rows = Array.from({ length: 400 }, () => ['a,b', 'he said "hi"']);
    await respond(replier, { ...small, rows });
    expect(sendDocument.mock.calls[0]![0].contents).toContain('"a,b"');
    expect(sendDocument.mock.calls[0]![0].contents).toContain('"he said ""hi"""');
  });
  it('neutralises a spreadsheet formula in a field', () => {
    const csv = toCsv({
      headers: ['name'],
      rows: [['=HYPERLINK("http://evil","x")'], ['+1'], ['@SUM(A1)'], ['-2+3'], ['plain']],
    });
    const fields = csv.split('\n').slice(1);
    expect(fields[0]).toBe('"\'=HYPERLINK(""http://evil"",""x"")"');
    for (const f of fields) expect(f).not.toMatch(/^"?[=+\-@\t\r]/);
    expect(fields[4]).toBe('plain');
  });

  it('throws on a ragged row instead of rendering a blank cell', () => {
    expect(() => renderTable({ title: 't', headers: ['a', 'b'], rows: [['1', '2'], ['only']] }))
      .toThrow(/row 1 has 1 cells, expected 2/);
  });
});
