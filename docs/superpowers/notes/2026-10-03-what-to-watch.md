# What I'd most want feedback on

Specific questions, ordered by how much I doubt the answer. Each says what I chose, what I
chose it against, and what would change my mind — so you can answer from what you see rather
than reconstruct my reasoning.

Everything here passes its tests. That is the point: tests pin what a reply *contains*, and
none of them can tell me whether it reads well.

---

## 1. The default `/firstminters` probably never appears in the chat at all

**Measured, not suspected.** One rendered row is **181 characters**:

```
minter: 0xaaaa…aaaa  first recipient: 0xbbbb…bbbb  minted: 12  recipients: 7  to others: yes  block: 18500000  log: 143
```

The message budget is 3,500 characters, so the crossover is about **19 rows** — and the default
limit is 20. So a collection with twenty-odd first minters sends you a **CSV file**, every
time, and the chat-native output I spent the milestone on is reachable only via `--limit`.

- Does the CSV actually bother you, or is a file the right answer for this query and the
  message format the thing that should go?
- Should the default limit drop to something that fits (8? 10?), so the common case renders?
- Or should a long result send **both** — a short message *and* the file?

This is the one I'd change first, and I don't know in which direction.

## 2. Seven columns per row, rendered as `key: value  key: value`

I chose repeated `key: value` pairs over a fixed-width table because aligned columns need a
monospace block, which needs `parse_mode`, which this bot deliberately never sets — on-chain
names are attacker-controlled and `parse_mode` is how that becomes an injection. So the format
is a consequence of a security decision, not a preference.

On a phone, 181 characters is five or six wrapped lines per row, with no visual column.

- Is it readable at all on a phone, or only on desktop?
- Would fewer columns help more than a different layout? `first recipient` and `to others`
  overlap in purpose — `to others: yes` says a mint went elsewhere, `first recipient` says
  where. Dropping either loses something; which one do you not look at?
- Would one row per line but values on their own lines (taller, narrower) read better?

## 3. The dry-run reply is terminal output pasted into a chat

`--dry-run` replies with the CLI's `formatEstimate` verbatim. That function was written for an
80-column terminal and uses twenty-space indentation to align values:

```
  estimated time    4.2 hours  for log fetching alone
                    at 5.0 getLogs/s, derived from the
                    compute-unit ceiling rather than from a flat configured rate
```

In a chat that alignment collapses into ragged wrapping. I reused it rather than writing a
second format because two formats drift — but I think this reads badly and no test can see it.

- Is it legible, or does it need a chat-shaped version?
- Which numbers in it do you actually use? If it is only the time and the block span, the rest
  can go and the drift problem disappears.

## 4. Does the estimate bear any resemblance to reality?

This is the most valuable empirical thing you can report, because nothing in the repo can check
it. The number rests on two unmeasured figures (report §3): the published compute-unit prices
with `VERIFIED = false`, and a `/ 50` divisor standing in for how much faster
`getAssetTransfers` is than `getLogs`.

- For a real index, how far off was the estimate? Ratio, not minutes — 2× is tolerable, 50× is
  not and tells me the divisor is wrong.
- Was it wrong in the same direction every time?

If it is consistently out by a factor, that factor is more useful than any amount of reasoning
about it.

## 5. The progress message stops changing on a slow run

The progress line is `header / via <path> / blocks X-Y / rows N` — deliberately with **no
elapsed counter**. A timestamp would make the text differ on every tick, which makes the
"don't re-send identical text" guard unreachable, so I removed it.

The consequence is that a run whose chunk is slow shows an identical message for as long as it
takes, and an unchanging message is how a *hung* process looks.

- On a long index, did you ever think it had died?
- If so, the fix is a changing element that is cheap to justify — a tick count, say, or the
  block range moving even when rows do not — and I would rather add it than have you wondering.

## 6. The edit interval is 4 seconds, chosen rather than measured

Telegram's documented ceiling is roughly one message per second per chat, and edits count. I
picked 4s for headroom; I never measured where it actually complains.

- Too chatty, about right, or too slow to feel responsive?
- Did you ever see a progress edit get rate-limited? (A dropped tick is invisible by design —
  the next one just shows later numbers — so this one you may only notice as the message
  jumping further than expected.)

## 7. Two replies I rewrote late and am unsure about

**The lock message.** It used to say "nothing is indexing it now". That was false — a lock held
by a live CLI run against the same database looks identical to one a crashed process left — so
it now offers both readings and names the lock holder. It is longer and hedgier:

> `0x… is locked by job <id>, which is not running in this bot. Either a previous run died
> holding the lock, or another process is indexing it right now. If it died, the lock goes stale
> in N minutes…`

Honest, but does it read as useless waffle when you just want to know whether to wait?

**"recorded level full".** I say *recorded* because the column states an intent and completeness
is derived from the rows instead. Does "recorded" read as oddly defensive, or does it land?

## 8. Error replies have four parts

Headline, detail, hint, and `next: /command`. On the two errors you will actually hit —
`EnrichmentLevelError` and `DeployBlockUnavailableError` — that is four stacked paragraphs.

- Is the `next:` line the part you use? If so the hint may be redundant with it.
- Does the headline alone tell you enough, with the rest as noise?

## 9. `/overlap` has no row bound

Recorded as a gap. It returns every qualifying wallet, builds the whole list in memory, and
`--limit` is **refused** rather than silently capping — because capping a "wallets in 3+ of
these collections" question changes the answer instead of bounding the output.

- On your real collections, how many rows does it actually return? If it is tens, the gap is
  theoretical. If it is thousands, it needs a real answer and your number tells me what shape.

---

## What I am not asking

Whether the commands are the right commands, or what Milestone 3 should contain. You said the
scope should come from using it, and a list of my guesses about that would only anchor you to
them.
