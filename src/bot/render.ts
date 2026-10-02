import type { Replier } from './replier.js';

/**
 * 3500, not Telegram's 4096.
 *
 * The headroom covers the caption, and keeps a borderline message from being pushed
 * over by its own last row. One threshold for every command, so /overlap across
 * fifteen collections and /firstminters --limit 500 behave the same way.
 */
export const MESSAGE_BUDGET = 3500;

const NAME_LIMIT = 64;
/** C0 and C1 controls. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Bidi embedding and isolate controls, which can make text display as something else. */
const BIDI = /[‪-‮⁦-⁩]/g;

/**
 * Makes on-chain text safe to put in a message.
 *
 * `name()` is attacker-controlled: anyone can deploy a contract. Sending without
 * `parse_mode` handles Markdown, and Markdown is the least of it — a newline forges
 * message structure, control characters corrupt rendering, a bidi override can make
 * the text read as something entirely different, and a 2,000-character name eats the
 * message budget so the real output is pushed into a CSV.
 *
 * This project has met hostile text before: the `İ` index-skew bug in secrets.ts. The
 * lesson was that it needs a boundary, not vigilance at each use. This is that boundary.
 */
export function sanitizeOnChainText(value: string | null | undefined): string {
  if (typeof value !== 'string') return '(unnamed)';
  // Newlines and tabs are C0 controls, so CONTROL would delete them and fuse "Cool\nCollection"
  // into "CoolCollection". Turn whitespace into a space first, then strip what remains.
  const cleaned = value.replace(/\s+/g, ' ').replace(CONTROL, '').replace(BIDI, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return '(unnamed)';
  return cleaned.length > NAME_LIMIT ? `${cleaned.slice(0, NAME_LIMIT)}…` : cleaned;
}

export function renderTable(a: { title: string; headers: string[]; rows: string[][] }): string {
  const lines = [a.title, ''];
  if (a.rows.length === 0) return [a.title, '', '(no rows)'].join('\n');
  for (const row of a.rows) {
    lines.push(a.headers.map((h, i) => `${h}: ${row[i] ?? ''}`).join('  '));
  }
  return lines.join('\n');
}

/** RFC-4180 quoting: a field containing a comma, quote or newline is quoted, quotes doubled. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(a: { headers: string[]; rows: string[][] }): string {
  return [a.headers, ...a.rows].map((row) => row.map(csvField).join(',')).join('\n');
}

/**
 * The ONE output rule, shared by every command.
 *
 * Render, measure, and switch to a document if the text would not fit. Deciding on the
 * rendered length rather than a row count is the point: characters are the actual limit,
 * and a row-count rule would send a CSV for 200 short rows while overflowing on 20 long
 * ones.
 */
export async function respond(
  replier: Replier,
  a: { title: string; headers: string[]; rows: string[][]; filename: string },
): Promise<void> {
  const text = renderTable(a);
  if (text.length <= MESSAGE_BUDGET) {
    await replier.reply(text);
    return;
  }
  await replier.sendDocument({
    filename: a.filename,
    contents: toCsv(a),
    caption: `${a.title} — ${a.rows.length} rows, too long for a message.`,
  });
}
