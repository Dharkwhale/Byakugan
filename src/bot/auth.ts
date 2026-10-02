export interface AuthContext {
  from?: { id: number };
}

/**
 * Drops every update from a user not on the allowlist.
 *
 * Registered FIRST, before any handler, because anyone who finds the bot's username can
 * message it.
 *
 * SILENCE IS THE REQUIREMENT. Not calling `next()` is half of it; sending nothing is the
 * other half. A refusal message — however polite — confirms the bot exists and that
 * someone is behind it, which is exactly what a private bot should not volunteer.
 *
 * Constructing with an empty set throws rather than dropping everything, so a
 * misconfiguration surfaces at startup instead of looking like a dead bot.
 */
export function allowOnly(
  ids: ReadonlySet<number>,
  log: (message: string) => void = () => undefined,
) {
  if (ids.size === 0) {
    throw new Error(
      'allowOnly was given an empty allowlist. Every update would be dropped and the ' +
      'bot would look dead. Set TELEGRAM_ALLOWED_USER_IDS.',
    );
  }
  return async function gate(ctx: AuthContext, next: () => Promise<void>): Promise<void> {
    const id = ctx.from?.id;
    if (id === undefined || !ids.has(id)) {
      log(`dropped an update from unauthorized user ${id ?? '(no sender)'}`);
      return;
    }
    await next();
  };
}
