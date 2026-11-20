import { randomBytes, randomUUID } from 'node:crypto';

export const eventPath = calendar => `calendars/${encodeURIComponent(calendar.remote)}/events`;
const interval = 5 * 60_000;
const now = () => new Date().toISOString();
const writable = ['summary', 'description', 'location', 'start', 'end', 'recurrence'];
const tombstone = (id, prior) => ({
  id, status: 'cancelled',
  ...(prior?.recurringEventId && { recurringEventId: prior.recurringEventId, originalStartTime: prior.originalStartTime }),
});
function matchesOperation(row, remote) {
  if (!row.operation || remote.extendedProperties?.private?.kovaOperation !== row.operation || row.deleted) return false;
  const data = JSON.parse(row.data);
  return writable.every(field => {
    if (field === 'recurrence') return JSON.stringify(data[field] ?? []) === JSON.stringify(remote[field] ?? []);
    if (field === 'start' || field === 'end') {
      const a = data[field];
      const b = remote[field];
      return a?.date ? a.date === b?.date : Date.parse(a?.dateTime) === Date.parse(b?.dateTime) &&
        (!a?.timeZone || !b?.timeZone || a.timeZone === b.timeZone);
    }
    return (data[field] ?? '') === (remote[field] ?? '');
  });
}

export function synchronization(db, google, webhook) {
  const work = new Map();
  const log = (id, kind, message) => {
    db.run('INSERT INTO logs(calendar,at,kind,message) VALUES(?,?,?,?)', id, now(), kind, message);
    db.run('DELETE FROM logs WHERE calendar=? AND id NOT IN (SELECT id FROM logs WHERE calendar=? ORDER BY id DESC LIMIT 100)', id, id);
  };

  function apply(calendar, remote, acknowledged = false) {
    const row = db.get('SELECT * FROM events WHERE calendar=? AND google_id=?', calendar.id, remote.id);
    const deleted = Number(remote.status === 'cancelled');
    const snapshot = JSON.stringify(remote);
    if (!row) {
      db.run(`INSERT INTO events(id,calendar,google_id,data,remote_data,etag,synced,deleted)
        VALUES(?,?,?,?,?,?,?,?)`, randomUUID(), calendar.id, remote.id, snapshot, snapshot, remote.etag ?? null, now(), deleted);
      return;
    }
    if (row.status === 'synced' && row.remote_data === snapshot) return;
    const canCommit = acknowledged || row.status === 'synced' || (row.status === 'pending' && (
      matchesOperation(row, remote) ||
      (deleted && row.deleted)
    ));
    if (canCommit) {
      db.run(`UPDATE events SET data=?,remote_data=?,etag=?,synced=?,deleted=?,status='synced',
        operation=NULL,revision=revision+1 WHERE id=?`, snapshot, snapshot, remote.etag ?? null, now(), deleted, row.id);
      return;
    }
    if (row.remote_data === snapshot || (row.etag && row.etag === remote.etag)) return;
    db.run(`UPDATE events SET remote_data=?,etag=?,status='conflict',revision=revision+1 WHERE id=?`,
      snapshot, remote.etag ?? null, row.id);
    log(calendar.id, 'conflict', 'A local change and a Google change need review.');
  }

  async function pull(calendar, account, token) {
    const items = [];
    let page;
    let next;
    do {
      const query = new URLSearchParams({ showDeleted: 'true', singleEvents: 'false', maxResults: '2500' });
      if (token) query.set('syncToken', token);
      if (page) query.set('pageToken', page);
      const result = await google.api(account, `${eventPath(calendar)}?${query}`);
      items.push(...(result.items ?? []));
      page = result.nextPageToken;
      next = result.nextSyncToken;
    } while (page);
    if (!next) throw new Error('Google did not return a synchronization token.');
    db.transaction(() => {
      for (const event of items) apply(calendar, event);
      if (!token) {
        const seen = new Set(items.map(event => event.id));
        for (const row of db.all('SELECT google_id,remote_data FROM events WHERE calendar=? AND google_id IS NOT NULL', calendar.id)) {
          if (row.remote_data && !seen.has(row.google_id)) apply(calendar, tombstone(row.google_id, JSON.parse(row.remote_data)));
        }
      }
      db.run('UPDATE calendars SET sync_token=?,full_sync=CASE WHEN ? THEN ? ELSE full_sync END WHERE id=?',
        next, Number(!token), Date.now(), calendar.id);
    });
    return items.length;
  }

  async function push(calendar, account) {
    if (calendar.direction !== 'both') return 0;
    let count = 0;
    for (const event of db.all("SELECT * FROM events WHERE calendar=? AND status='pending'", calendar.id)) {
      const collection = eventPath(calendar);
      const resource = `${collection}/${encodeURIComponent(event.google_id)}`;
      const data = JSON.parse(event.data);
      const existing = event.remote_data && JSON.parse(event.remote_data);
      const create = !existing || existing.status === 'cancelled';
      const body = Object.fromEntries(writable.filter(key => key in data).map(key => [key, data[key]]));
      body.extendedProperties = { private: { ...(existing?.extendedProperties?.private ?? {}), kovaOperation: event.operation } };
      try {
        if (event.deleted) {
          if (!create) {
            if (!event.etag) throw new Error('Google did not provide a version for this event.');
            await google.api(account, resource, { method: 'DELETE', etag: event.etag });
          }
          apply(calendar, tombstone(event.google_id, existing), true);
        } else if (create) {
          apply(calendar, await google.api(account, collection, { method: 'POST', body: { ...body, id: event.google_id } }), true);
        } else {
          if (!event.etag) throw new Error('Google did not provide a version for this event.');
          apply(calendar, await google.api(account, resource, { method: 'PATCH', body, etag: event.etag }), true);
        }
        count++;
      } catch (error) {
        if (![404, 409, 410, 412].includes(error.status)) throw error;
        let current;
        try { current = await google.api(account, resource); }
        catch (readError) {
          if (![404, 410].includes(readError.status)) throw readError;
          current = tombstone(event.google_id, existing);
        }
        apply(calendar, current);
      }
    }
    return count;
  }

  async function stopChannel(account, channel) {
    if (!channel.resource) return;
    await google.api(account, 'channels/stop', {
      method: 'POST', body: { id: channel.id, resourceId: channel.resource },
    });
  }

  async function watch(calendar, account) {
    if (!webhook || calendar.watch_due > Date.now()) return;
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const expiration = Date.now() + 24 * 60 * 60_000;
    db.run('INSERT INTO channels(id,calendar,token,expires) VALUES(?,?,?,?)', id, calendar.id, token, expiration);
    try {
      const result = await google.api(account, `${eventPath(calendar)}/watch`, {
        method: 'POST', body: { id, token, type: 'web_hook', address: webhook, expiration: String(expiration) },
      });
      const expires = Number(result.expiration ?? expiration);
      db.run('UPDATE channels SET resource=?,expires=? WHERE id=?', result.resourceId, expires, id);
      db.run('UPDATE calendars SET watch_due=?,watch_error=NULL WHERE id=?', expires - 10 * 60_000, calendar.id);
      for (const old of db.all('SELECT * FROM channels WHERE calendar=? AND id<>?', calendar.id, id)) {
        try {
          await stopChannel(account, old);
          db.run('DELETE FROM channels WHERE id=?', old.id);
        } catch {
          // Overlapping channels are harmless and expire automatically.
        }
      }
    } catch (error) {
      db.run('DELETE FROM channels WHERE id=?', id);
      db.run('UPDATE calendars SET watch_due=?,watch_error=? WHERE id=?', Date.now() + interval, error.message, calendar.id);
      log(calendar.id, 'watch', `Push unavailable. ${error.message}`);
    }
  }

  async function process(id) {
    const calendar = db.get('SELECT * FROM calendars WHERE id=?', id);
    if (!calendar?.account) return;
    const account = db.get('SELECT * FROM accounts WHERE id=?', calendar.account);
    // Advance the schedule before calling Google so an in-flight notification can make it due again.
    db.run('UPDATE calendars SET due=? WHERE id=?', Date.now() + interval, id);
    try {
      let incoming;
      const token = Date.now() - calendar.full_sync < 7 * 24 * 60 * 60_000 ? calendar.sync_token : null;
      try { incoming = await pull(calendar, account, token); }
      catch (error) {
        if (error.status !== 410 || !token) throw error;
        log(id, 'reset', 'Google expired the sync token. Refreshing the calendar.');
        incoming = await pull(calendar, account, null);
      }
      const outgoing = await push(calendar, account);
      db.run('UPDATE calendars SET last_sync=?,error=NULL,failures=0 WHERE id=?', now(), id);
      log(id, 'success', `${incoming} Google changes received, ${outgoing} Kova changes sent.`);
      await watch(calendar, account);
    } catch (error) {
      const failures = calendar.failures + 1;
      const delay = Math.min(60 * 60_000, 15_000 * 2 ** Math.min(failures - 1, 8));
      const message = error.code === 'invalid_grant' ? 'Google permission expired. Reconnect the account.' : error.message;
      db.run('UPDATE calendars SET failures=?,error=?,due=? WHERE id=?',
        failures, message, Date.now() + delay + Math.floor(Math.random() * delay / 4), id);
      log(id, 'error', message);
    }
  }

  return {
    active: id => work.has(id),
    start(id) {
      if (!work.has(id)) work.set(id, process(id).finally(() => work.delete(id)));
      return work.get(id);
    },
    stopChannel,
    log,
  };
}
