# Sync design

Offline-first sync against Google Tasks. The local SQLite store is the source of
truth for the UI; the renderer never waits on the network. Everything here runs
in the main process.

```
scheduler ──▶ engine.runCycle ──▶ pre-pull ──▶ push ──▶ pull (merge)
                   │             (conflicts)  (outbox)      │
                   └── SyncState ─────────────┴─ data:changed┘
```

A cycle is **pre-pull → push → pull**.

*Push before pull* is the ordering that matters for the user's own work: their
changes reach Google before we merge anything from it, so a local edit is never
overwritten by the stale copy the server still holds.

*The pre-pull exists because push-then-pull is blind to conflicts.* The push's
own staleness check compares the row's `updated_at` against the entry's
`base_updated_at` — both written by the **same** pull — so an edit another
device made since then is invisible to it, and the push silently overwrites it.
So before pushing, `runPrePull` incrementally pulls the lists that hold queued
work for tasks Google already knows about (`listsWithPendingRemoteTasks()`).
That cannot lose a local edit: the merge is per-field and dirty-aware, so a
field the user touched is either kept or raised as a conflict.

It costs nothing in the common case — nothing queued, or only creates, and the
query returns no lists and no request is made. A list that fails to pull is
reported as **unverified** rather than throwing: the rest of the outbox still
drains, and only already-synced tasks in that list are held back.

---

## Outbox

Every user mutation writes the row **and** an outbox entry in one transaction
(`src/main/db/repositories/*`). If those two can diverge, you lose user edits.

| Status | Meaning |
|---|---|
| `pending` | Ready to send once `next_attempt_at` has passed. |
| `inflight` | Handed to the request queue. Reset to `pending` on startup — a crash leaves nothing actually in flight. |
| `blocked` | Held, not failed. Either something it references has no remote id yet, or the task carries an unresolved conflict, or its list could not be conflict-checked this cycle. **Never burns `attempts`.** |
| `parked` | Stopped. Surfaced to the user with Retry / Discard. **Never auto-deleted.** |
| `done` | Sent, or cancelled because it became meaningless. Vacuumed after 7 days. |

Ordering is FIFO by `seq`, with a per-entity barrier: if an entry for entity *E*
stalls, later entries for *E* wait. Entries drain sequentially through the
request queue with `serialKey = listId`, so two `move`s in one list can never
land out of order.

### Readiness rule

An entry is **ready** iff every local id it references resolves to a remote id:
the entity itself, its list, `parentId`, and `destListId`. Otherwise it is
`blocked`: `blocked_passes++`, `attempts` **untouched**, and after 3 passes it
parks with `DEPENDENCY_FAILED`.

Two other holds share the status but **not** the pass counter, so they can wait
indefinitely without ever parking:

- the task carries an unresolved **conflict** (`CONFLICT`) — the whole point of
  raising one is that the user, not the client, picks the winner;
- its list was **unverified** this cycle (`NETWORK`) — we could not check Google
  for newer changes, so we do not overwrite blind.

Causality is already encoded by construction — you cannot update a task before
creating it — so FIFO plus a readiness check is sufficient; a topological sort
is unnecessary.

`previousId` (sibling ordering) is a **soft** reference. It is resolved from the
row's own `sort_key`: the nearest earlier sibling that already has a remote id,
otherwise omitted. Blocking a user's task creation because a sibling is slow
would be absurd.

### Failure disposition

Every failure lands on one of a **closed set** of codes (`OutboxErrorCode` in
`backoff.ts`), because the "Changes that didn't sync" sheet maps them to human
sentences — an ad-hoc `http_400` reaches the user as a raw string.

| Cause | Code | Result |
|---|---|---|
| 5xx / 408 / unknown throw | `INTERNAL` | `attempts++`, `next_attempt_at = now + nextDelay()`, park at 8 attempts |
| transport / timeout | `NETWORK` | as above (the timeout detail lives in the message, not the code) |
| 429 / 403-rate-limit | `RATE_LIMITED` | Exact `Retry-After`; **`attempts` untouched** and the drain stops |
| 400 | `VALIDATION` | Parked immediately — retrying eight times proves nothing |
| real 403 (`insufficient_scope`) | `FORBIDDEN` | Parked immediately |
| 404 | `NOT_FOUND` | Parked immediately |
| 409 / **412** | `CONFLICT` | Re-queued at once, `attempts++` as a loop bound. The next cycle's pre-pull merges the server's copy and the entry is re-derived from what is still dirty |
| unmet dependency | `DEPENDENCY_FAILED` | `blocked`, then parked after 3 passes |
| `AuthError` | `AUTH` | Entry stays `pending`, drain aborts, engine pauses. The outbox is **never** cleared on re-auth |

Backoff is exponential with jitter in `[exp/2, exp)`, base 1s, cap 5min. Jitter
is not decoration: a laptop waking with 200 queued entries would otherwise retry
them all in lockstep and cause the very 429s the backoff exists to avoid.

The backoff is honoured by a timer, not by the poll. `runPush` reports the
soonest `next_attempt_at` still ahead of it (`retryAt`), the cycle hands that to
the scheduler, and the scheduler wakes for it with the `retry` trigger — while
online. Without this a 2s backoff would wait for the next poll, a minute away
when focused and fifteen on battery. Offline the wake is suppressed: every
attempt would fail, and eight of them park the entry within minutes; the
`network` trigger re-runs the cycle when the route is back.

### `tasks.insert` is not idempotent

A lost 500 might mean the task *was* created, so the HTTP wrapper never retries
it (`spec.idempotent = false`). The outbox owns that retry, and the next pull
reconciles duplicates: a local row with no remote id whose create was *actually
attempted* adopts a matching remote task (same title, same list, created within
10 minutes) and deletes the extras. If a duplicate-delete fails, the extra is
**left in the merge** — a visible duplicate the user can delete beats a task
that exists on Google and nowhere on this machine.

---

## Pull

Per list: `updatedMin` = watermark − 2 min, all four `show*` flags explicit,
`maxResults=100`, paginated. Each page is merged as it arrives (the merge is
idempotent, so a partial pull still leaves the store correct).

Pagination stops at `MAX_PAGES`. A listing truncated there does **not** advance
the watermark and does **not** run the key-set diff: the first would lose
everything past the cap forever, and the second would read "not seen" as
"deleted on the server" and hard-delete it.

### Watermark rule

The watermark advances **only after every page succeeds**, and it is taken from
`max(item.updated)`, or the HTTP `Date` header when a page is empty — the
**server's** clock, never `Date.now()`.

Setting it from local wall time compares two different clocks: a laptop 45
seconds fast asks for changes after a moment that has not happened server-side,
and every edit in that window is silently lost forever.

### Full reconcile

No `updatedMin`; diff the server's key set against ours. Triggered by: a null
watermark, `sync:now {full:true}`, >12h since the last full pass, cold start
>24h, or >7 days since the last success. Local rows with a remote id that the
server no longer lists and no pending outbox entry are hard-deleted — or, if
dirty, turned into a `remoteDeleted` conflict.

This is what catches deletes if tombstones don't flow.

### First-pull list adoption

An offline first run creates a local "My Tasks" with a queued `list.create`.
Google already has a default list with that exact name. A local list with
`remote_id IS NULL` and a pending `list.create` whose title matches a remote
list (case-insensitive, trimmed) is **bound** to it and the create is cancelled
— otherwise the user ends up with two identical lists.

---

## Merge policy

Three-way, per field, over `base_json` (last-known server state) + `dirty_fields`
(what the user changed since that base).

| Field | Rule |
|---|---|
| `title`, `notes`, `due` | Not dirty → server wins. Dirty & server unchanged → local wins. Both changed to the same value → converge. Both changed differently → **keep local**, record a conflict with the server's value. |
| `status` | Same, plus: completion beats un-completion. Losing a "done" is worse than losing an "undone". |
| `parent`, `position`, `hidden` | Always server-wins. They are server-owned; fighting causes visible list jitter. |
| `dueTime` | Local-only, never sent. A changed remote date keeps it; a cleared remote date drops it. |

The asymmetry is about recency of intent: overwriting a field the user just
edited produces the single most infuriating bug class in sync software — text
disappearing mid-edit. Per-field means a remote due-date change and a local
title change both survive with zero user involvement.

Deletions:

- Remote deleted, local clean → hard delete, emit the id.
- Remote deleted, local dirty → keep the row, set `remote_deleted = 1`, raise a
  `remoteDeleted` conflict offering Restore (which creates a *new* task, since
  the Google id is gone; the stable `localId` keeps editors and selection intact).

While a conflict is unresolved the outbox entry for that task is **held**, so
Google keeps its value until the user decides. `tasks:resolveConflict` clears
the conflict and releases the entry: `keepLocal` re-derives the body from what
is still dirty and pushes it, `useServer` adopts the server's fields (including
a cleared `due`, which drops the local-only `dueTime`) and cancels the entry —
or, when the server deleted the task, accepts the deletion rather than leaving a
row pointing at a dead Google id.

A pull that brings back identical state writes nothing and reports no change —
otherwise every 60s tick would re-arm the tray badge and the whole reminder
schedule for nothing.

`base_json` also carries `listRemoteId`, because `tasks.move` across lists needs
the list the **server** currently holds the task in, and the local `list_id` has
already been optimistically updated by the time the entry runs.

---

## What Google leaves undocumented, and how it is neutralised

| Unknown | Neutralisation |
|---|---|
| Do tombstones flow with `updatedMin`? | The pull is an idempotent **merge**, not a delta application, and the full reconcile catches deletes either way. The whole pull suite runs under **both** settings (`describe.each`). |
| Is `updatedMin` inclusive? | The 2-minute read-back skew makes it irrelevant; re-merging an item is a no-op. |
| Is `If-Match` / 412 honoured? | `task.update` sends the etag of the **last server state we merged** (the row's current etag, never the outbox entry's `base_etag`, which goes stale on a retry and would 412 forever). A 412 is classified as a conflict, re-queued and resolved by the next cycle's pre-pull. This is the **second** line of defence: if Google ignores the header nothing is lost, because the pre-pull already caught the conflict. |
| The real rate limit | AIMD converges on it: halve the token-bucket refill on a 429, recover 10% every 30s. |
| `showHidden` default | Never relied on — all four `show*` flags are always explicit. |

`403` is **not** always auth: `403 + reason: rateLimitExceeded` is throttling
wearing a 403 costume. The client inspects `error.errors[].reason`; treating
every 403 as "signed out" logs users out under load.

---

## Scheduling and network

Triggers: startup, interval, window focus, network regain, power resume,
local edit (800ms debounce, 5s max wait), backoff retry, manual, post-auth. One
cycle at a time; a trigger arriving mid-cycle sets a resync flag — and
`manual()` resolves when **that** follow-up cycle ends, never when the stale one
it interrupted does. Everything pauses while auth is not `signed_in` and resumes
immediately on sign-in.

### Cadence

The poll interval comes from the user's `syncIntervalSec` setting through
`intervalsFromSetting()`, applied live via `onSettingsChanged` (a pending poll
is re-armed, so the control is not inert):

| State | Interval |
|---|---|
| focused | `sec` |
| background | `max(5 × sec, 300s)` |
| battery | `max(15 × sec, 900s)` |

Only the focused rhythm follows the setting literally. A background or battery
cadence that honoured "every 15 seconds" would drain a laptop for no benefit, so
those are multiples with a floor. The default (60s) reproduces 60s / 5min /
15min.

`schedulePoll` also respects a **floor** the engine supplies — the remaining
`Retry-After` — so a throttled account is not re-asked on the ordinary rhythm.
A manual sync bypasses the floor; the throttled *entry* still keeps its own
`next_attempt_at`, because re-asking the instant Google told us to wait is how a
burst limit becomes a long one.

### Rate limits

`Retry-After` is split by length. The HTTP wrapper absorbs only a blink
(`MAX_INLINE_RETRY_MS`, 2s); anything longer is thrown to the caller. A
`sleep(60_000)` inside the request holds the whole cycle open, so the status pill
reads "Syncing…" for a minute and the countdown is never computed. Thrown
instead, the engine sets `rateLimitedUntil`, reports `status: 'rate_limited'`
with a live `retryAfterMs`, skips the pull (throttling is account-wide, so
pulling would only collect more 429s) and parks the next poll on the floor
above. A daily quota does not clear in five minutes: it waits
`DAILY_RETRY_AFTER_MS` (1h) and carries an explanatory `errorMessage`.

### Network

`net.isOnline()` is a **negative** signal only; real request outcomes are the
authoritative positive signal. The probe is a `HEAD` of the **API base URL**
with `redirect: 'manual'` and a 5s timeout — the host we actually need, not a
third-party "generate 204" a firewall or a CI sandbox can black-hole while
Google is fine. **Any** HTTP answer proves the route (a HEAD of the collection
root is a 401 or 404 on a healthy Google); a redirect to a **foreign** host is a
captive portal; only a transport error is offline.

While offline or behind a portal the monitor re-probes on a ladder — 3s, 6s,
12s, 30s, then every 60s while there is queued work or a focused window, else
every 5 minutes — each delay jittered ±15% through the injected `Random`. The
ladder resets on any status change and on resume. Without it the only way back
is a request the scheduler will not make until its next poll, so a laptop that
reconnects sits on a full outbox for minutes.

Electron's `net` emits no online/offline events, so the same timer polls
`net.isOnline()`. When it reads `false` no request is made at all — there is
provably no route — and the poll is capped at 60s even when idle, because that
path costs only a local call and is how the flip back is noticed.

Coming back online triggers a cycle immediately, not merely a re-armed poll.
Suspend forces offline at once and cancels the ladder (requests on a sleeping
NIC hang for minutes); resume starts a fresh ladder and re-probes after 3s.

---

## Testing

Every source of nondeterminism is injected — `Clock`, `Random`, `fetch`,
`TokenProvider`, `NetworkMonitor` — so a 24-hour backoff scenario runs in
milliseconds. The store under test is the **real** repositories over
`openDatabase(':memory:')`.

- `tests/fakes/fake-google-api.ts` — in-memory Google reproducing the quirks:
  `due` truncated to midnight UTC, `parent`/`position` ignored in bodies, opaque
  renumbered positions, `clear` sets `hidden`, `delete` leaves a tombstone, a
  skewable server clock, scriptable failures and partitions.
- `tests/fixtures/fakeGoogle.ts` — a real `node:http` server for E2E, with
  control endpoints. **Offline E2E must use `POST /__control/offline`**: network
  calls happen in the main process, where Playwright's page-level offline flag
  has no effect.
- `tests/unit/main/sync/convergence.property.test.ts` — random interleavings of
  local mutations, remote edits, failures and partitions; asserts convergence
  and no lost writes. It has already caught two real defects (a request-queue
  slot leak on a synchronously-throwing task, and a duplicate-cleanup path that
  could hide a remote task forever).
