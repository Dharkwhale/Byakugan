# The path to walk

Shorter than the README's bot section, which explains why each step exists. This is just the
commands, in order, assuming nothing is running. The README has the detail if a step fails.

## Once, before anything

```bash
BYAKUGAN_NO_DOTENV=1 npx vitest run    # confirm the suite is green: 912 passed, 17 skipped
npm run migrate                        # creates ./data/byakugan.db
```

**Always prefix test runs with `BYAKUGAN_NO_DOTENV=1`.** Without it, `test/setup.ts` loads
`.env` and the 17-test real-provider suite runs against your live Alchemy endpoint. That suite
exists on purpose — run it when you want it, not every time you check something:

```bash
npx vitest run test/integration/smoke.provider.test.ts   # deliberate, spends quota
```

Nothing else in the project spends quota from a test run. `npm run bot` and `npm run index` of
course do, because indexing is the point.

## Start the bot

```bash
npm run bot
```

Prints `byakugan bot starting, pid <n>` and stays running. Leave the terminal open; Ctrl+C
stops it. Run exactly one copy — a second one silently takes over polling from the first.

In Telegram, open your bot and send `/start`. If nothing comes back, your numeric id is not in
`TELEGRAM_ALLOWED_USER_IDS`; the terminal prints the id it dropped.

## Index a collection

Check the cost before committing to it:

```
/index 0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d --dry-run
```

That resolves the deploy block, reports the span and the estimate, and indexes nothing. Then:

```
/index 0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d
```

Replies immediately and edits that one message as it goes. Anything estimated over five
minutes asks you to confirm with `--yes` first.

- Add `--chain 8453` for a chain other than your default.
- `--mints-only` is cheaper and still answers `/firstminters`; `--logs-only` is cheapest and
  answers only `/firstrecipients`. **The level is fixed at the first index** and a later run at
  a different level is refused, so pick deliberately.
- While it runs, `/status` (no address) lists running jobs; `/status <address>` gives detail.

Index three or four collections on the same chain if you want `/overlap` to have something to
work with — it needs at least two.

## Run each query

```
/status
/status 0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d
/firstminters 0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d
/firstminters 0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d --limit 5
/firstrecipients 0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d
/overlap 0xFIRST 0xSECOND
/overlap 0xFIRST 0xSECOND 0xTHIRD --min 3
/help
```

`--limit 5` is worth sending alongside the bare `/firstminters`: the default is 20 rows and
twenty rows of that width exceed the message budget, so the default almost certainly arrives
as a CSV file rather than as a message. Seeing both is the point — see question 1 in
`docs/superpowers/notes/2026-10-03-what-to-watch.md`.

## If something goes wrong

The exit code says which kind: `2` your fault (bad address, bad token), `3` the provider's,
`4` another instance took over polling, `1` a bug. Every error reply names a next action.
