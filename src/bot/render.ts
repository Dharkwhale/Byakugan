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
/**
 * Unicode format characters (category Cf), matched by property so the list cannot drift.
 * Probed on this runtime: U+200B/200C/200D/2060 (zero-width), U+200E/200F (LRM/RLM),
 * U+061C (ALM) and every bidi embedding/override/isolate control (U+202A-202E,
 * U+2066-2069) are ALL Cf, so none needs naming separately. They are invisible or they
 * reorder text, and an all-zero-width name would otherwise survive as a blank string
 * instead of "(unnamed)".
 *
 * Stripping all of Cf also removes ZWJ, so an emoji family sequence may render as
 * separate people. That is a deliberate trade for a security boundary on
 * attacker-controlled text. It likewise removes ZWNJ (U+200C), which is orthographically
 * meaningful in Persian, Urdu and Kurdish, so names in those scripts lose a character that
 * changes how they read; still the right call for a 64-character display label.
 */
const FORMAT = /\p{Cf}/gu;

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
  // The emptiness check below stays AFTER stripping, so an all-invisible name is "(unnamed)".
  const cleaned = value
    .replace(/\s+/g, ' ')
    .replace(CONTROL, '')
    .replace(FORMAT, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return '(unnamed)';
  // Truncate by CODE POINT, not UTF-16 code unit: slice() can cut a surrogate pair in half,
  // and the lone surrogate is sent as U+FFFD. Grapheme clusters (combining marks, ZWJ-less
  // sequences) may still be split at the cut. That is a decision, not an oversight: a cut
  // mark is cosmetic, whereas a lone surrogate is corrupt text.
  const points = Array.from(cleaned);
  return points.length > NAME_LIMIT ? `${points.slice(0, NAME_LIMIT).join('')}…` : cleaned;
}

export function renderTable(a: { title: string; headers: string[]; rows: string[][] }): string {
  if (a.rows.length === 0) return [a.title, '', '(no rows)'].join('\n');
  const lines = [a.title, ''];
  a.rows.forEach((row, r) => {
    // A short row would render as a silently blank cell: missing data picking the cheaper
    // answer. Say so instead.
    if (row.length !== a.headers.length) {
      throw new Error(
        `renderTable: row ${r} has ${row.length} cells, expected ${a.headers.length} (one per header)`,
      );
    }
    lines.push(a.headers.map((h, i) => `${h}: ${row[i]}`).join('  '));
  });
  return lines.join('\n');
}

/**
 * Spreadsheet formula injection: a cell starting with = + - @ tab or CR is executed when the
 * owner opens the file in Excel or Sheets (=HYPERLINK(...) is the classic). Collection names
 * are attacker-controlled, so neutralise with a leading apostrophe, which spreadsheets treat
 * as a text marker. Note this also prefixes a legitimate negative number; no column here
 * holds one.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** RFC-4180 quoting: a field containing a comma, quote or newline is quoted, quotes doubled. */
function csvField(raw: string): string {
  const value = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
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
    caption: boundCaption(`${a.title} — ${a.rows.length} rows, too long for a message.`),
  });
}

/**
 * Telegram's documented limit on a document caption. NOT measured here, unlike the error
 * shapes in `src/telegram/failures.ts` — it comes from the published Bot API reference, so
 * treat the exact number as unverified. The guard below does not depend on it being exact:
 * any bound that is comfortably under the real one prevents the failure.
 */
const CAPTION_LIMIT = 1024;

/**
 * Keeps a caption short enough to send.
 *
 * A title is composed by the caller and can grow with its input — a `/overlap` across many
 * collections once built one about 52 characters per collection. Over the limit Telegram
 * REJECTS the whole `sendDocument`, so an answer too long for a message becomes no answer
 * at all: the failure lands precisely on the large results the document path exists for.
 *
 * Truncation is visible rather than silent. The caption is a label — the rows are in the
 * file and are never abridged — so losing the tail of a label is the cheap half of this
 * trade, and saying it was cut is what stops a reader trusting a sentence that stops
 * mid-clause.
 */
function boundCaption(caption: string): string {
  if (caption.length <= CAPTION_LIMIT) return caption;
  const marker = '… (caption truncated; the full result is in the file)';
  const budget = CAPTION_LIMIT - marker.length;
  // MEASURED AND CUT IN THE SAME UNIT. `caption.length` counts UTF-16 code units, which is
  // what Telegram counts, so slicing by CODE POINT could return a value twice the limit this
  // function exists to enforce: ~970 astral characters pass the slice and arrive as ~1,940
  // units, and the send is rejected — the outcome being guarded against. Not reachable
  // through today's callers, whose titles hold only addresses and integers, which is exactly
  // why no test noticed; it is a guard for the caller that comes later.
  //
  // Cut on a code-point boundary even so, by stepping back off a lone high surrogate. A split
  // pair would otherwise render as U+FFFD, and `sanitizeOnChainText` above is careful about
  // the same thing.
  let end = budget;
  const code = caption.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${caption.slice(0, end)}${marker}`;
}
