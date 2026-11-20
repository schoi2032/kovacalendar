import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storage } from '../storage.js';
import { synchronization } from '../sync.js';
import { GoogleError } from '../google.js';
import { occurrences } from '../occurrences.js';

const date = day => ({ date: `2026-11-${day}` });
const event = {
  id: 'event', etag: '"v1"', summary: 'Google original', start: date('20'), end: date('21'),
};
const error = status => new GoogleError(status);

function setup(t, api, webhook, direction = 'both') {
  const db = storage(':memory:');
  t.after(() => db.close());
  db.run("INSERT INTO users VALUES('u','subject','User',NULL)");
  db.run("INSERT INTO accounts VALUES('a','u','subject',NULL,'refresh','scopes')");
  db.run("INSERT INTO calendars(id,user,account,remote,name,color,direction) VALUES('c','u','a','google calendar','Work','#674cce',?)", direction);
  return {
    db, sync: synchronization(db, { api }, webhook),
    calendar: () => db.get("SELECT * FROM calendars WHERE id='c'"),
    event: () => db.get("SELECT * FROM events WHERE google_id='event'"),
  };
}

test('pagination, stored incremental token, replay and 410 recovery preserve local event IDs', async t => {
  const requests = [];
  const steps = [
    { items: [event], nextPageToken: 'page2' },
    { items: [], nextSyncToken: 'token1' },
    { items: [event], nextSyncToken: 'token2' },
    error(410),
    { items: [{ ...event, etag: '"v2"', summary: 'Google edited' }], nextSyncToken: 'token3' },
    { items: [{ id: 'event', status: 'cancelled' }], nextSyncToken: 'token4' },
  ];
  const { sync, calendar, event: row } = setup(t, async (_, path) => {
    const query = new URLSearchParams(path.split('?')[1]);
    requests.push([query.get('syncToken'), query.get('pageToken')]);
    const next = steps.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  await sync.start('c');
  const id = row().id;
  assert.equal(calendar().sync_token, 'token1');
  await sync.start('c');
  assert.equal(row().revision, 1);
  await sync.start('c');
  assert.equal(calendar().sync_token, 'token3');
  assert.equal(JSON.parse(row().data).summary, 'Google edited');
  assert.equal(row().id, id);
  await sync.start('c');
  assert.equal(row().deleted, 1);
  assert.deepEqual(requests, [[null, null], [null, 'page2'], ['token1', null], ['token2', null], [null, null], ['token3', null]]);
});

test('outgoing edits are conditional and a raced Google change preserves both versions', async t => {
  const remote = { ...event, summary: 'Google edited', etag: '"v2"' };
  const steps = [
    () => ({ items: [event], nextSyncToken: 'one' }),
    () => ({ items: [], nextSyncToken: 'two' }),
    (_path, options) => {
      assert.equal(options.method, 'PATCH');
      assert.equal(options.etag, '"v1"');
      assert.equal(options.body.summary, 'Kova edited');
      throw error(412);
    },
    () => remote,
  ];
  const { db, sync, event: row } = setup(t, async (_, path, options) => steps.shift()(path, options));
  await sync.start('c');
  db.run("UPDATE events SET data=?,status='pending',operation='edit' WHERE id=?",
    JSON.stringify({ ...event, summary: 'Kova edited' }), row().id);
  await sync.start('c');
  assert.equal(row().status, 'conflict');
  assert.equal(JSON.parse(row().data).summary, 'Kova edited');
  assert.equal(JSON.parse(row().remote_data).summary, 'Google edited');
});

test('read-only sync leaves queued local changes in Kova', async t => {
  let calls = 0;
  const { db, sync, event: row } = setup(t, async () => {
    calls++;
    return { items: [event], nextSyncToken: String(calls) };
  }, null, 'read');
  await sync.start('c');
  db.run("UPDATE events SET data=?,status='pending',operation='edit' WHERE id=?",
    JSON.stringify({ ...event, summary: 'Kova edited' }), row().id);
  await sync.start('c');
  assert.equal(calls, 2);
  assert.equal(row().status, 'pending');
});

test('retry after a lost insert response acknowledges the same Google event without inserting again', async t => {
  let sent;
  const steps = [
    () => ({ items: [], nextSyncToken: 'one' }),
    (_path, options) => {
      sent = options.body;
      assert.equal(options.method, 'POST');
      assert.equal(sent.id, 'event');
      throw error(503);
    },
    () => ({ items: [{ ...sent, etag: '"created"' }], nextSyncToken: 'two' }),
  ];
  const { db, sync, calendar, event: row } = setup(t, async (_, path, options) => steps.shift()(path, options));
  db.run("INSERT INTO events(id,calendar,google_id,data,status,operation) VALUES('local','c','event',?,'pending','insert')",
    JSON.stringify(event));
  await sync.start('c');
  assert.equal(calendar().failures, 1);
  assert.ok(calendar().due > Date.now());
  await sync.start('c');
  assert.equal(calendar().failures, 0);
  assert.equal(row().status, 'synced');
  assert.equal(row().id, 'local');
  assert.equal(steps.length, 0);
});

test('watch renewal replaces the channel and stops the previous one', async t => {
  const webhook = 'https://calendar.example.com/webhooks/google';
  let watched = 0;
  const stopped = [];
  const { db, sync } = setup(t, async (_, path, options) => {
    if (path.endsWith('/watch')) {
      assert.equal(options.body.address, webhook);
      assert.ok(options.body.token.length >= 32);
      return { resourceId: String(++watched), expiration: String(Date.now() + 24 * 60 * 60_000) };
    }
    if (path === 'channels/stop') { stopped.push(options.body.resourceId); return null; }
    return { items: [], nextSyncToken: 'token' };
  }, webhook);
  await sync.start('c');
  await sync.start('c');
  assert.equal(watched, 1);
  db.run("UPDATE calendars SET watch_due=0 WHERE id='c'");
  await sync.start('c');
  assert.deepEqual(stopped, ['1']);
  assert.equal(db.get('SELECT resource FROM channels').resource, '2');
});

test('recurrences preserve wall time across DST and suppress cancelled instances', () => {
  const row = { id: 'series', calendar: 'c', google_id: 'parent', data: {
    summary: 'Weekly', start: { dateTime: '2026-03-01T09:00:00-05:00', timeZone: 'America/New_York' },
    end: { dateTime: '2026-03-01T10:00:00-05:00', timeZone: 'America/New_York' },
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'],
  } };
  const cancelled = { id: 'child', calendar: 'c', deleted: 1, data: {
    recurringEventId: 'parent', originalStartTime: { dateTime: '2026-03-08T09:00:00-04:00' },
  } };
  const result = occurrences([row, cancelled], Date.parse('2026-03-01'), Date.parse('2026-04-01'));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.items.map(item => item.start.dateTime), ['2026-03-01T14:00:00.000Z', '2026-03-15T13:00:00.000Z']);
});
