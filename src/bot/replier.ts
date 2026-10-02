import type { Context } from 'grammy';
import { InputFile } from 'grammy';
import { scrubSecrets } from '../secrets.js';

/**
 * Everything a command needs from Telegram, and nothing more.
 *
 * Commands take this rather than grammY's `Context` so they unit-test with a fake and
 * no Telegram server. It is also why there is exactly one place that knows about
 * `parse_mode` — namely nowhere, because it is never set.
 */
export interface Replier {
  reply(text: string): Promise<{ messageId: number }>;
  edit(messageId: number, text: string): Promise<void>;
  sendDocument(a: { filename: string; contents: string; caption: string }): Promise<void>;
}

/**
 * SCRUBS EVERY OUTBOUND STRING, here, at the one place they all pass through.
 *
 * A chat reply is the one output that leaves the machine entirely, and `/index` failures
 * reply an error's `detail` — which for a viem error can carry the RPC URL, API key and
 * all. Redaction at each call site is what failed before in this project (a probe that
 * scrubbed in its happy path only), so no handler is trusted to remember: `tokens` is a
 * REQUIRED argument, and text, caption, filename and document contents are all scrubbed
 * below. Tokens come from `deriveSecretTokens(config.secrets)`.
 */
export function makeReplier(ctx: Context, tokens: string[]): Replier {
  const scrub = (value: string): string => scrubSecrets(value, tokens);
  const chatId = ctx.chat?.id;
  if (chatId === undefined) throw new Error('no chat on this update');
  return {
    async reply(text) {
      const sent = await ctx.api.sendMessage(chatId, scrub(text));
      return { messageId: sent.message_id };
    },
    async edit(messageId, text) {
      await ctx.api.editMessageText(chatId, messageId, scrub(text));
    },
    async sendDocument({ filename, contents, caption }) {
      await ctx.api.sendDocument(
        chatId,
        new InputFile(Buffer.from(scrub(contents), 'utf8'), scrub(filename)),
        { caption: scrub(caption) },
      );
    },
  };
}
