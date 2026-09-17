# Sync design

Offline-first sync against Google Tasks. The local SQLite store is the source of
truth for the UI; the renderer never waits on the network. Everything here runs
in the main process.

```
scheduler ──▶ engine.runCycle ──▶ push (drain outbox) ──▶ pull (merge)
                   │                     │                    │
                   └── SyncState ────────┴── data:changed ────┘
```

A cycle is always **push then pull**: the user's own changes should reach Google
before we merge anything from it, so a local edit is never overwritten by the
stale copy the server still holds.

---

## Outbox

Every user mutation writes the row **and** an outbox entry in one transaction
(`src/main/db/repositories/*`). If those two can diverge, you lose user edits.

| Status | Meaning |
|---|---|
| `pending` | Ready to send once `next_attempt_at` has passed. |
| `inflight` | Handed to the request queue. Reset to `pending` on startup — a crash leaves nothing actually in flight. |
| `blocked` | Not ready: something it references has no remote id yet. **Not a failure.** |
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
parks with `dependency_failed`.

Causality is already encoded by construction — you cannot update a task before
creating it — so FIFO plus a readiness check is sufficient; a topological sort
is unnecessary.

`previousId` (sibling ordering) is a **soft** reference. It is resolved from the
row's own `sort_key`: the nearest earlier sibling that already has a remote id,
otherwise omitted. Blocking a user's task creation because a sibling is slow
would be absurd.

### Failure disposition

| Cause | Result |
|---|---|
| 5xx / 408 / transport | `attempts++`, `next_attempt_at = now + nextDelay()`, park at 8 attempts |
| 429 / 403-rate-limit | Exact `Retry-After`; **`attempts` untouched** and the drain stops |
| 400 / real 403 / 404 | Parked immediately — retrying eight times proves nothing |
| `AuthError` | Entry stays `pending`, drain aborts, engine pauses. The outbox is **never** cleared on re-auth |

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

> **Implementation status (verified 2026-09-17):** the policy below is what the
> merge code implements, but in practice it is **not reached for a both-sides
> edit**. `runPush` runs before `runPull` (`src/main/sync/engine.ts:181-187`) and
> `src/main/sync/push.ts:325` sends no `If-Match`, so the local edit is pushed
> blind and the pull then sees only our own write. Last-write-wins is the actual
> behaviour today. See [`feature-matrix.md`](feature-matrix.md) F1/F2 for the
> measurements and the suggested fix.

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
| Is `If-Match` / 412 honoured? | *Designed as:* sent when an etag is known, and a 412 classified as a conflict and re-pulled. **Not currently wired** — `push.ts:325` omits the etag argument, so no request ever carries `If-Match` and the 412 branch in `http-client.ts:176` is dead. |
| The real rate limit | AIMD converges on it: halve the token-bucket refill on a 429, recover 10% every 30s. |
| `showHidden` default | Never relied on — all four `show*` flags are always explicit. |

`403` is **not** always auth: `403 + reason: rateLimitExceeded` is throttling
wearing a 403 costume. The client inspects `error.errors[].reason`; treating
every 403 as "signed out" logs users out under load.

---

## Scheduling and network

Triggers: startup, interval, window focus, network regain, power resume,
local edit (800ms debounce, 5s max wait), manual, post-auth. Intervals: 60s
focused / 5min background / 15min on battery. One cycle at a time; a trigger
arriving mid-cycle sets a resync flag. Everything pauses while auth is not
`signed_in` and resumes immediately on sign-in.

`net.isOnline()` is a **negative** signal only; real request outcomes are the
authoritative positive signal; transitions trigger a `HEAD` probe of a known
204 endpoint with `redirect: 'manual'`, where an unexpected redirect to a
foreign host means a captive portal. Suspend forces offline at once (requests
on a sleeping NIC hang for minutes); resume re-probes after 3s.

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
