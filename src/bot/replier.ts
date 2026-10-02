import type { Context } from 'grammy';
import { InputFile } from 'grammy';

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

export function makeReplier(ctx: Context): Replier {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) throw new Error('no chat on this update');
  return {
    async reply(text) {
      const sent = await ctx.api.sendMessage(chatId, text);
      return { messageId: sent.message_id };
    },
    async edit(messageId, text) {
      await ctx.api.editMessageText(chatId, messageId, text);
    },
    async sendDocument({ filename, contents, caption }) {
      await ctx.api.sendDocument(
        chatId,
        new InputFile(Buffer.from(contents, 'utf8'), filename),
        { caption },
      );
    },
  };
}
