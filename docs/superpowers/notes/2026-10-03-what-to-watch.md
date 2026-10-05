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

**Candidate on the table, from the owner, and it is a better framing than mine.** The choice is
not "timestamp or nothing": a field that changes only when *work happens* — chunks completed,
rows inserted, current block — differs between renders without defeating the identical-text
guard, and a chunk that genuinely takes minutes then shows the same numbers honestly. Not
redesigned now; recorded so it is on the table when the observations come back.

**One measurement that moves where the problem is, though.** The line already contains
`blocks X-Y`, which changes every chunk, so the identical-text case is rarer than I implied
above — two consecutive ticks only collide if the chunk range *and* the row count both repeat.
And `onProgress` fires once per chunk, after it completes (`src/indexer/backfill.ts:248`), so
during a single slow chunk **no tick fires at all**: no field can change, because nothing calls
the reporter. A work counter fixes the collision case; the frozen-message case needs something
that ticks independently of chunk completion. Worth knowing which one you actually saw — the
message jumping in large steps, or sitting still for minutes — because they want different
answers.

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

---

# First-use findings (2026-10-05)

Recorded from the owner's first real use and the shape probes that followed. Not fixes —
inputs to Milestone 3 scoping, which the owner asked to come from use rather than from the PRD.

## `/firstminters` answers "who PAID". `/firstrecipients` answers "who GOT IT".

The original goal was *"the first 10 wallets that mint this NFT"*. On a sponsored or gasless
mint the payer is not the minter: a platform relayer sends the transaction and the collector
receives the token. Measured on Base — the same EOA
`0xf9ba6c1cd54a3c7fe7e9d164d1178feb29c16501` sends the mints for two unrelated collections
(The Dream Station, After School), ~1,000 mints each to ~1,000 distinct recipients, one
transaction per mint. That is a relayer, not a deployer; a deployer distributing its own supply
is collection-specific, as TAGGED CREW's `0x06c2dbe4…` is.

So on a relayed mint `/firstminters` reports ONE wallet for a thousand genuine collectors, and
the **recipient** is closer to the question that was being asked. `/overlap` is unaffected: it
groups by `to_addr`.

**Open for M3, the owner's call:** whether the default should flip — whether "who minted" should
mean the recipient, with the payer as the secondary column rather than the primary one.

## The cheap version of telling a relayer from a deployer

Distinguishing them needs no provider call once two collections are indexed: **a sender that
appears across several indexed collections is a relayer; one that appears in a single
collection is probably its deployer.** That is a local `SELECT` over `tx_from`, zero CU, and it
is exactly how the relayer above was identified — by noticing one address serving two
collections.

**Not built.** Noted because the previous conclusion was that the bot could not tell the two
apart cheaply, and that conclusion was wrong. It needs ≥2 indexed collections to say anything,
so it is worth nothing on a fresh database and everything on a used one.

## What the free ratios can and cannot do

Two ratios over recent mints — distinct transactions ÷ mints, distinct recipients ÷ mints —
are free from `getAssetTransfers` and DO separate protocol artifacts (Uniswap V3 Positions
scored 0.25 on recipients, Slipstream 0.04, because one wallet opens many positions).

They do **not** separate a public mint from a relayed one. Both candidates above scored 0.98
transactions and 0.94–1.00 recipients — the public-mint signature — and both had one sender. A
relayer that loops one transaction per mint is indistinguishable on any free signal. Only
`tx_from` separates them, which is what CLAUDE.md already said about why `tx_from` is indexed.
