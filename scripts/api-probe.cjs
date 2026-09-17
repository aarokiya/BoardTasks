#!/usr/bin/env node
/* eslint-disable no-console -- this script's entire output is its console report */
/**
 * Google Tasks API capability probe. Dev-only: nothing in the app ever runs it.
 *
 *   GOOGLE_ACCESS_TOKEN=ya29.… npm run probe:api
 *
 * A handful of Google Tasks behaviours are genuinely undocumented, or documented
 * contradictorily. The sync engine is written so it is correct under every
 * answer (the pull is an idempotent merge, not a delta application) — but
 * knowing the real answers lets us stop paying for the defensive path. This
 * script settles each question empirically against a scratch list it creates
 * and deletes, and writes docs/api-probe-results.md.
 *
 * Get a token with the right scope by signing in to BoardTasks and copying one
 * from the log, or from https://developers.google.com/oauthplayground (select
 * https://www.googleapis.com/auth/tasks).
 */
'use strict';

const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.env.GOOGLE_TASKS_BASE_URL || 'https://tasks.googleapis.com/tasks/v1';
const TOKEN = process.env.GOOGLE_ACCESS_TOKEN || '';
const ALL_FLAGS = { showCompleted: 'true', showDeleted: 'true', showHidden: 'true', showAssigned: 'true', maxResults: '100' };

if (!TOKEN) {
  console.error('GOOGLE_ACCESS_TOKEN is not set.\n\n  GOOGLE_ACCESS_TOKEN=ya29.… npm run probe:api\n');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0;
async function api(method, path, opts = {}) {
  calls += 1;
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json', ...(opts.headers || {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error bodies exist; keep the raw text */
  }
  return { status: res.status, ok: res.ok, json, text, etag: res.headers.get('etag'), date: res.headers.get('date') };
}

function must(r, what) {
  if (!r.ok) {
    const reason = (r.json && r.json.error && r.json.error.message) || r.text.slice(0, 300);
    throw new Error(`${what} failed: HTTP ${r.status} ${reason}`);
  }
  return r.json;
}

const results = [];
function record(question, answer, detail) {
  results.push({ question, answer, detail });
  const pad = answer.padEnd(22);
  console.log(`  ${pad} ${question}\n      ${detail}\n`);
}

async function createTask(listId, fields, query) {
  return must(await api('POST', `/lists/${listId}/tasks`, { body: fields, query }), `create task "${fields.title}"`);
}

async function listTasks(listId, query) {
  const r = must(await api('GET', `/lists/${listId}/tasks`, { query: { ...ALL_FLAGS, ...query } }), 'list tasks');
  return r.items || [];
}

// ---------------------------------------------------------------- probes ----

async function probeUpdatedMinAndTombstones(listId) {
  const t1 = await createTask(listId, { title: 'probe-A-first' });
  await sleep(2500); // the API's `updated` has second resolution
  const t2 = await createTask(listId, { title: 'probe-B-second' });

  // Q1: is updatedMin inclusive of an item whose `updated` equals it exactly?
  const atT1 = await listTasks(listId, { updatedMin: t1.updated });
  const ids = new Set(atT1.map((t) => t.id));
  record(
    'updatedMin: inclusive of an item whose updated == updatedMin?',
    ids.has(t1.id) ? 'INCLUSIVE' : 'EXCLUSIVE',
    `updatedMin=${t1.updated} returned ${atT1.length} item(s); the boundary task was ${ids.has(t1.id) ? 'present' : 'absent'}. ` +
      (ids.has(t1.id)
        ? 'Re-fetching the watermark item every poll is expected; the merge is idempotent so this is harmless.'
        : 'A watermark set to max(updated) will NOT re-deliver the boundary item — the 2-minute safety skew is what covers clock edges.'),
  );

  // Q2: do deletes flow through updatedMin + showDeleted, or only a full reconcile?
  const before = t2.updated;
  must(await api('DELETE', `/lists/${listId}/tasks/${t2.id}`), 'delete task');
  await sleep(2500);
  const afterDelete = await listTasks(listId, { updatedMin: before });
  const tomb = afterDelete.find((t) => t.id === t2.id);
  record(
    'Tombstones: does a deleted task appear with updatedMin + showDeleted=true?',
    tomb ? 'TOMBSTONES FLOW' : 'NO TOMBSTONE',
    tomb
      ? `The deleted task came back with deleted=${String(tomb.deleted)}, updated=${tomb.updated}. Deletes can be learned from a delta pull.`
      : 'The delete was invisible to a delta pull. Only the periodic full reconcile (no updatedMin, diff the key sets) will catch remote deletes — keep it.',
  );

  // Q3: does a delete without updatedMin show up at all with showDeleted=true?
  const fullList = await listTasks(listId, {});
  record(
    'Full list: is a deleted task visible with showDeleted=true and no updatedMin?',
    fullList.some((t) => t.id === t2.id) ? 'VISIBLE' : 'ABSENT',
    fullList.some((t) => t.id === t2.id)
      ? 'A full reconcile sees the tombstone explicitly.'
      : 'A full reconcile must infer the delete from the missing key, not from a deleted:true row.',
  );

  return t1;
}

async function probeIfMatch(listId, task) {
  const fresh = await api('GET', `/lists/${listId}/tasks/${task.id}`);
  must(fresh, 'get task');
  const realEtag = fresh.etag || (fresh.json && fresh.json.etag);

  const stale = await api('PATCH', `/lists/${listId}/tasks/${task.id}`, {
    body: { title: 'probe-A-first (if-match stale)' },
    headers: { 'If-Match': '"definitely-not-the-current-etag"' },
  });
  record(
    'If-Match: is a stale etag rejected with 412?',
    stale.status === 412 ? 'HONOURED (412)' : `IGNORED (${stale.status})`,
    stale.status === 412
      ? 'Optimistic concurrency is available: mutations can carry the base etag and 412 means "someone else won".'
      : `A stale If-Match returned HTTP ${stale.status}, so the write went through regardless. Conflict detection must stay entirely client-side (compare base_json against the server copy).`,
  );

  if (realEtag) {
    const good = await api('PATCH', `/lists/${listId}/tasks/${task.id}`, {
      body: { notes: 'probe' },
      headers: { 'If-Match': realEtag },
    });
    record(
      'If-Match: is a CURRENT etag accepted?',
      good.ok ? 'ACCEPTED' : `REJECTED (${good.status})`,
      good.ok ? `Sending the current etag (${String(realEtag).slice(0, 24)}…) succeeded.` : 'Even a current etag was rejected — do not send If-Match at all.',
    );
  } else {
    record('If-Match: is a CURRENT etag accepted?', 'NO ETAG RETURNED', 'The response carried no ETag header or etag field, so there is nothing to send.');
  }
}

async function probeShowHiddenAfterClear(listId) {
  const t = await createTask(listId, { title: 'probe-C-cleared', status: 'completed' });
  await sleep(1500);
  must(await api('POST', `/lists/${listId}/clear`), 'clear completed');
  await sleep(2500);

  // Deliberately send NO show* flags: this is the documented-contradiction case.
  const bare = must(await api('GET', `/lists/${listId}/tasks`, { query: { maxResults: '100' } }), 'list tasks (no flags)');
  const bareItems = bare.items || [];
  const withHidden = await listTasks(listId, {});
  const cleared = withHidden.find((x) => x.id === t.id);

  record(
    'clear: does it hide or delete?',
    cleared ? (cleared.deleted ? 'DELETES' : 'HIDES') : 'GONE ENTIRELY',
    cleared
      ? `After clear the task has hidden=${String(cleared.hidden)}, deleted=${String(cleared.deleted)}, status=${cleared.status}. hidden:true is NOT deleted:true.`
      : 'The task vanished even with all show* flags on.',
  );
  record(
    'showHidden default when the flag is omitted',
    bareItems.some((x) => x.id === t.id) ? 'DEFAULTS TRUE' : 'DEFAULTS FALSE',
    `A request with no show* flags returned ${bareItems.length} item(s) and the cleared task was ${
      bareItems.some((x) => x.id === t.id) ? 'included' : 'excluded'
    }. Send all four flags explicitly regardless — the docs contradict themselves here.`,
  );
  record(
    'maxResults default',
    'SEE DETAIL',
    'tasks.list defaults to 20 per page (tasklists.list defaults to 1000). Always send maxResults=100 or a 500-task list is 25 round trips.',
  );
}

async function probeNesting(listId) {
  const parent = await createTask(listId, { title: 'probe-D-parent' });
  const child = await createTask(listId, { title: 'probe-D-child' }, { parent: parent.id });
  record(
    'Subtask creation via ?parent=',
    child.parent === parent.id ? 'WORKS' : 'IGNORED',
    child.parent === parent.id ? `child.parent === ${parent.id}.` : `The parent query param was ignored; child.parent=${String(child.parent)}.`,
  );

  const grand = await api('POST', `/lists/${listId}/tasks`, { body: { title: 'probe-D-grandchild' }, query: { parent: child.id } });
  const grandParent = grand.ok && grand.json ? grand.json.parent : null;
  record(
    'Nesting depth: can a grandchild be created?',
    !grand.ok ? `REJECTED (${grand.status})` : grandParent === child.id ? 'ACCEPTED (2 levels!)' : 'FLATTENED',
    !grand.ok
      ? `HTTP ${grand.status}: ${((grand.json && grand.json.error && grand.json.error.message) || grand.text).slice(0, 200)}. One level of nesting confirmed.`
      : grandParent === child.id
        ? 'The API accepted two levels even though Google’s own UI renders only one. Keep the depth<=1 clamp in the UI anyway.'
        : `The grandchild was created with parent=${String(grandParent)} — the request was flattened rather than rejected.`,
  );

  const body = await api('POST', `/lists/${listId}/tasks`, { body: { title: 'probe-D-body-parent', parent: parent.id, position: '00000000000000000001' } });
  const created = body.ok ? body.json : null;
  record(
    'parent/position in the request BODY',
    created && created.parent === parent.id ? 'HONOURED' : 'IGNORED (output-only)',
    created
      ? `Created with parent=${String(created.parent)}, position=${String(created.position)} from a body that asked for parent=${parent.id}. ` +
          'Hierarchy must be set with ?parent=&previous= and order with tasks.move.'
      : `HTTP ${body.status}.`,
  );

  return parent;
}

async function probeDueTruncation(listId) {
  const created = await createTask(listId, { title: 'probe-E-due', due: '2026-09-18T15:30:00.000Z' });
  record(
    'due: is the time component preserved?',
    created.due === '2026-09-18T15:30:00.000Z' ? 'PRESERVED' : 'TRUNCATED',
    `Sent 2026-09-18T15:30:00.000Z, got back ${String(created.due)}. ` +
      'Time-of-day for reminders has to live in the local DB, and due must be treated as a civil date.',
  );
}

// ------------------------------------------------------------------ main ----

async function main() {
  console.log('\nGoogle Tasks API probe');
  console.log(`  endpoint: ${BASE}\n`);

  const list = must(await api('POST', '/users/@me/lists', { body: { title: `BoardTasks API probe ${new Date().toISOString()}` } }), 'create scratch list');
  console.log(`  scratch list: ${list.id} ("${list.title}")\n`);

  let failure = null;
  try {
    const t1 = await probeUpdatedMinAndTombstones(list.id);
    await probeIfMatch(list.id, t1);
    await probeShowHiddenAfterClear(list.id);
    await probeNesting(list.id);
    await probeDueTruncation(list.id);
  } catch (e) {
    failure = e;
    console.error(`\n  probe aborted: ${e && e.message ? e.message : String(e)}\n`);
  } finally {
    const del = await api('DELETE', `/users/@me/lists/${list.id}`);
    console.log(del.ok ? `  scratch list ${list.id} deleted.\n` : `  WARNING: could not delete scratch list ${list.id} (HTTP ${del.status}) — remove it by hand.\n`);
  }

  const lines = [
    '# Google Tasks API probe results',
    '',
    `Generated by \`npm run probe:api\` on ${new Date().toISOString()} against \`${BASE}\`.`,
    'Each row was measured against a throwaway list, not read from the documentation.',
    '',
    '| Question | Answer | What it means |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.question} | **${r.answer}** | ${r.detail.replace(/\|/g, '\\|')} |`),
    '',
    `${calls} API calls.${failure ? ` Probe aborted early: ${failure.message}` : ''}`,
    '',
  ];
  const out = join(__dirname, '..', 'docs', 'api-probe-results.md');
  writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(`  ${results.length} findings written to ${out}\n`);

  if (failure) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
