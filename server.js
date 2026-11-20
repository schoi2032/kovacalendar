import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { googleClient, scopes } from './google.js';
import { storage } from './storage.js';
import { synchronization } from './sync.js';
import { occurrences } from './occurrences.js';

const port = Number(process.env.PORT || 3000);
const origin = new URL(process.env.APP_ORIGIN || `http://localhost:${port}`);
const https = origin.protocol === 'https:';
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
if ((!https && !loopback) || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('APP_ORIGIN must be an HTTPS origin or loopback HTTP origin.');
}
const local = loopback && !https && process.env.KOVA_LOCAL_MODE === '1';
const clientId = process.env.GOOGLE_CLIENT_ID;
const secret = process.env.GOOGLE_CLIENT_SECRET;
const key = process.env.KOVA_TOKEN_KEY ?? '';
const loginEnabled = Boolean(clientId && secret);
const connectEnabled = loginEnabled && /^[a-f\d]{64}$/i.test(key);
const redirect = `${origin.origin}/oauth/callback`;
const webhook = process.env.GOOGLE_WEBHOOK_URL || '';
if (webhook && (new URL(webhook).protocol !== 'https:' || new URL(webhook).pathname !== '/webhooks/google')) {
  throw new Error('GOOGLE_WEBHOOK_URL must use HTTPS and the /webhooks/google path.');
}
const file = process.env.KOVA_DB_PATH || './data/kova.sqlite';
process.umask(0o077);
mkdirSync(dirname(file), { recursive: true });
const db = storage(file);
const google = googleClient({ clientId, secret, redirect, key: Buffer.from(key, 'hex') });
const sync = synchronization(db, google, webhook);
const day = 86_400_000;
const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
const googleID = () => randomBytes(16).toString('hex');
const palette = '#674cce';
const cookieName = https ? '__Host-kova' : 'kova';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireThat(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

function session(req) {
  const id = req.headers.cookie?.match(new RegExp(`(?:^|; )${cookieName}=([\\w-]+)(?:;|$)`))?.[1];
  return id && db.get('SELECT * FROM sessions WHERE id=? AND expires>?', hash(id), Date.now());
}

function issueSession(res, user = null) {
  const raw = random();
  const id = hash(raw);
  const lifetime = user ? 30 * day : 10 * 60_000;
  db.run('INSERT INTO sessions VALUES(?,?,?)', id, user, Date.now() + lifetime);
  res.setHeader('Set-Cookie', `${cookieName}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lifetime / 1000}${https ? '; Secure' : ''}`);
  return id;
}

function createUser(subject, name, email) {
  const id = randomUUID();
  db.transaction(() => {
    db.run('INSERT INTO users VALUES(?,?,?,?)', id, subject, name, email);
    db.run('INSERT INTO calendars(id,user,name,color) VALUES(?,?,?,?)', randomUUID(), id, 'Personal', palette);
  });
  return id;
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function redirectTo(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

async function payload(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    requireThat(size <= 128_000, 413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw new HttpError(400, 'Invalid JSON request.'); }
}

function startOAuth(res, current, mode, account) {
  requireThat(mode === 'login' ? loginEnabled : connectEnabled, 503, 'Google OAuth is unavailable.');
  const id = current?.id ?? issueSession(res);
  const state = random();
  const verifier = random();
  db.run('INSERT INTO oauth VALUES(?,?,?,?,?,?)', hash(state), id, verifier, mode, account?.id ?? null, Date.now() + 10 * 60_000);
  const requestScopes = ['openid', 'email', 'profile'];
  if (mode !== 'login') requestScopes.push(scopes.list, mode === 'write' ? scopes.write : scopes.read);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: requestScopes.join(' '),
    state, code_challenge: hash(verifier), code_challenge_method: 'S256',
    ...(mode !== 'login' && { access_type: 'offline', prompt: 'consent select_account' }),
    ...(account?.email && { login_hint: account.email }),
  });
  json(res, { url: url.href });
}

async function callback(res, current, params) {
  const state = params.get('state');
  const attempt = current && state && db.get('DELETE FROM oauth WHERE state=? AND session=? AND expires>? RETURNING *',
    hash(state), current.id, Date.now());
  if (!attempt) return redirectTo(res, '/?notice=invalid');
  if (!params.get('code')) return redirectTo(res, '/?notice=denied');
  try {
    const token = await google.exchange(params.get('code'), attempt.verifier);
    const profile = await google.profile(token.access_token);
    requireThat(profile?.sub, 400, 'Google account identity is unavailable.');
    requireThat(db.get('SELECT id FROM sessions WHERE id=? AND expires>?', current.id, Date.now()), 401, 'Session expired.');
    if (attempt.mode === 'login') {
      const user = db.get('SELECT id FROM users WHERE subject=?', profile.sub)?.id ??
        createUser(profile.sub, profile.name || profile.email || 'Kova user', profile.email ?? null);
      db.run('DELETE FROM sessions WHERE id=?', current.id);
      issueSession(res, user);
      return redirectTo(res, '/');
    }
    requireThat(current.user, 401, 'Sign in to Kova first.');
    const existing = db.get('SELECT * FROM accounts WHERE subject=?', profile.sub);
    requireThat(!existing || existing.user === current.user, 409, 'This Google account is already connected to another Kova account.');
    requireThat(!attempt.account || existing?.id === attempt.account, 400, 'Choose the Google account already connected in Kova.');
    const granted = (token.scope || '').split(' ');
    requireThat(granted.includes(scopes.list) &&
      granted.includes(attempt.mode === 'write' ? scopes.write : scopes.read), 403, 'Grant the requested Calendar permissions to connect.');
    requireThat(token.refresh_token, 403, 'Google did not grant offline access. Reconnect and approve access.');
    const id = existing?.id ?? randomUUID();
    requireThat(!accountLocks.has(id) && !accountRunning(id), 409, 'Synchronization is running. Try reconnecting again shortly.');
    db.transaction(() => {
      db.run(`INSERT INTO accounts VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        email=excluded.email,refresh=excluded.refresh,scopes=excluded.scopes`,
        id, current.user, profile.email ?? null, google.seal(token.refresh_token), granted.join(' '));
      if (!granted.includes(scopes.write)) {
        db.run("UPDATE calendars SET direction='read' WHERE account=?", id);
      }
      db.run('UPDATE calendars SET due=0,failures=0,error=NULL,watch_due=0 WHERE account=?', id);
    });
    return redirectTo(res, '/?notice=connected');
  } catch (error) {
    const message = error instanceof HttpError ? error.message : 'Google authorization failed. Try again.';
    return redirectTo(res, `/?oauthError=${encodeURIComponent(message)}`);
  }
}

const accountLocks = new Set();
const accountRunning = id => db.all('SELECT id FROM calendars WHERE account=?', id).some(row => sync.active(row.id));
const canWrite = account => account.scopes.split(' ').includes(scopes.write);
const editableRole = role => role === 'owner' || role === 'writer';
function owned(table, id, user) {
  requireThat(typeof id === 'string' && id.length <= 100, 404, 'Item unavailable.');
  const row = db.get(`SELECT * FROM ${table} WHERE id=? AND user=?`, id, user);
  requireThat(row, 404, 'Item unavailable.');
  return row;
}
function ready(calendar) {
  requireThat(!sync.active(calendar.id) && !accountLocks.has(calendar.account), 409, 'Calendar is synchronizing. Try again shortly.');
}
function queue(calendar) {
  if (calendar.account) db.run('UPDATE calendars SET due=0 WHERE id=?', calendar.id);
}
function calendarEdit(body, fallback) {
  const name = (body.name ?? fallback.name);
  const color = body.color ?? fallback.color;
  requireThat(typeof name === 'string' && name.trim() && name.length <= 100, 400, 'Enter a calendar name.');
  requireThat(typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color), 400, 'Choose a valid calendar color.');
  return [name.trim(), color, Number(Boolean(body.hidden ?? fallback.hidden))];
}
async function listCalendars(account) {
  const items = [];
  let next;
  do {
    const query = new URLSearchParams({ minAccessRole: 'reader', maxResults: '250', showHidden: 'true' });
    if (next) query.set('pageToken', next);
    const page = await google.api(account, `users/me/calendarList?${query}`);
    items.push(...(page.items ?? []));
    next = page.nextPageToken;
  } while (next);
  return items.map(row => ({
    id: row.id, name: row.summaryOverride || row.summary || row.id, color: row.backgroundColor || palette,
    role: row.accessRole, zone: row.timeZone ?? null,
  }));
}

function disconnect(calendar, importCopy) {
  const keep = db.all("SELECT * FROM events WHERE calendar=? AND (local_origin=1 OR status<>'synced') AND deleted=0", calendar.id);
  if (keep.length) {
    let target = importCopy.get(calendar.user);
    if (!target) {
      target = randomUUID();
      db.run('INSERT INTO calendars(id,user,name,color) VALUES(?,?,?,?)', target, calendar.user, 'Recovered from Google', palette);
      importCopy.set(calendar.user, target);
    }
    for (const row of keep) {
      db.run(`UPDATE events SET calendar=?,google_id=NULL,remote_data=NULL,etag=NULL,synced=NULL,
        status='synced',operation=NULL,local_origin=0,revision=revision+1 WHERE id=?`, target, row.id);
    }
  }
  db.run('DELETE FROM calendars WHERE id=?', calendar.id);
}

function cleanEvent(body, prior, calendar) {
  const result = { ...prior };
  for (const field of ['summary', 'description', 'location']) {
    if (field in body) {
      requireThat(typeof body[field] === 'string' && body[field].length <= 8192, 400, 'Invalid event text.');
      result[field] = body[field].trim();
    }
  }
  requireThat(result.summary, 400, 'Enter an event title.');
  for (const field of ['start', 'end']) {
    if (!(field in body)) continue;
    const point = body[field];
    const date = point?.date;
    const time = point?.dateTime;
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Number.isFinite(Date.parse(date)) && new Date(date).toISOString().startsWith(date)) result[field] = { date };
    else {
      requireThat(typeof time === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(time) &&
        Number.isFinite(Date.parse(time)), 400, 'Enter a valid event date and time.');
      const timeZone = point.timeZone || calendar.zone || 'UTC';
      try { new Intl.DateTimeFormat('en', { timeZone }); }
      catch { throw new HttpError(400, 'Enter a valid IANA time zone.'); }
      result[field] = { dateTime: time, timeZone };
    }
  }
  requireThat(result.start && result.end && Boolean(result.start.date) === Boolean(result.end.date) &&
    Date.parse(result.end.date ?? result.end.dateTime) > Date.parse(result.start.date ?? result.start.dateTime),
  400, 'The event must end after it starts.');
  if ('recurrence' in body) {
    const rules = body.recurrence;
    requireThat(Array.isArray(rules) && rules.length <= 50 && rules.every(rule => typeof rule === 'string' &&
      rule.length <= 1024 && /^(RRULE|RDATE|EXDATE|EXRULE)[;:][^\r\n]+$/.test(rule)), 400, 'Invalid recurrence.');
    result.recurrence = rules;
  }
  return result;
}

function eventDetail(row, calendar, account) {
  return {
    id: row.id, calendar: row.calendar, data: JSON.parse(row.data), deleted: Boolean(row.deleted),
    remote: row.status === 'conflict' && row.remote_data ? JSON.parse(row.remote_data) : null,
    source: account ? { provider: 'google', account: account.subject, calendar: calendar.remote, event: row.google_id } : { provider: 'kova' },
    status: row.status, synced: row.synced, revision: row.revision,
    editable: !account || calendar.direction === 'both',
  };
}

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);

async function route(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const url = new URL(req.url, origin);
  const path = url.pathname;
  const method = req.method;
  if (method === 'GET' && assets.has(path)) {
    const [asset, type] = assets.get(path);
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    return res.end(readFileSync(new URL(`./public/${asset}`, import.meta.url)));
  }
  if (method === 'POST' && path === '/webhooks/google') {
    const channel = db.get('SELECT * FROM channels WHERE id=? AND expires>?', req.headers['x-goog-channel-id'] ?? '', Date.now());
    const token = req.headers['x-goog-channel-token'];
    const resource = req.headers['x-goog-resource-id'];
    requireThat(channel && typeof token === 'string' && token.length === channel.token.length &&
      Buffer.byteLength(token) === channel.token.length && timingSafeEqual(Buffer.from(token), Buffer.from(channel.token)) &&
      resource && (!channel.resource || resource === channel.resource), 404, 'Unknown channel.');
    if (req.headers['x-goog-resource-state'] !== 'sync') db.run('UPDATE calendars SET due=0 WHERE id=? AND failures=0', channel.calendar);
    res.writeHead(204);
    return res.end();
  }
  const current = session(req);
  if (path === '/oauth/callback' && method === 'GET') return callback(res, current, url.searchParams);
  if (method !== 'GET') {
    requireThat(req.headers.origin === origin.origin, 403, 'Invalid request origin.');
    requireThat(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'Expected JSON.');
  }
  if (path === '/api/session' && method === 'GET') {
    const user = current?.user && db.get('SELECT id,name,email FROM users WHERE id=?', current.user);
    return json(res, { user: user || null, loginEnabled, connectEnabled, local });
  }
  if (path === '/api/local' && method === 'POST') {
    requireThat(local, 404, 'Local mode is disabled.');
    const user = db.get("SELECT id FROM users WHERE subject='local-kova'")?.id ?? createUser('local-kova', 'Local workspace', null);
    issueSession(res, user);
    return json(res, {});
  }
  if (path === '/api/oauth' && method === 'POST') {
    const { mode, account: id } = await payload(req);
    requireThat(['login', 'read', 'write'].includes(mode), 400, 'Invalid permission request.');
    if (mode === 'login') return startOAuth(res, current, mode);
    requireThat(current?.user, 401, 'Sign in to Kova.');
    const account = id ? owned('accounts', id, current.user) : null;
    requireThat(mode !== 'write' || account, 400, 'Connect a Google account first.');
    return startOAuth(res, current, mode, account);
  }
  const user = current?.user;
  requireThat(user, 401, 'Sign in to Kova.');
  if (path === '/api/logout' && method === 'POST') {
    db.run('DELETE FROM sessions WHERE id=?', current.id);
    res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${https ? '; Secure' : ''}`);
    return json(res, {});
  }
  if (path === '/api/calendars') {
    if (method === 'GET') {
      const accounts = db.all('SELECT id,email,scopes FROM accounts WHERE user=? ORDER BY email', user);
      const calendars = db.all(`SELECT c.id,c.account,c.remote,c.name,c.color,c.hidden,c.direction,c.role,c.last_sync,c.error,c.watch_error,
        (SELECT COUNT(*) FROM events WHERE calendar=c.id AND status='conflict') conflicts,
        (SELECT COUNT(*) FROM events WHERE calendar=c.id AND status='pending') pending
        FROM calendars c WHERE c.user=? ORDER BY c.account IS NOT NULL,c.name`, user)
        .map(row => ({ ...row, running: sync.active(row.id) }));
      return json(res, { calendars, accounts: accounts.map(a => ({ id: a.id, email: a.email, write: canWrite(a) })) });
    }
    if (method === 'POST') {
      const body = await payload(req);
      const id = randomUUID();
      if (body.account) {
        const account = owned('accounts', body.account, user);
        requireThat(!accountLocks.has(account.id), 409, 'Account is disconnecting.');
        const remote = (await listCalendars(account)).find(item => item.id === body.remote);
        requireThat(remote, 404, 'Google calendar is unavailable.');
        requireThat(!accountLocks.has(account.id) && db.get('SELECT id FROM accounts WHERE id=?', account.id), 409, 'Account changed.');
        const [name, color, hidden] = calendarEdit(body, remote);
        db.run(`INSERT INTO calendars(id,user,account,remote,name,color,hidden,direction,role,zone)
          VALUES(?,?,?,?,?,?,?,'read',?,?) ON CONFLICT(account,remote) DO NOTHING`, id, user, account.id,
          remote.id, name, color, hidden, remote.role, remote.zone);
        const attached = db.get('SELECT id FROM calendars WHERE account=? AND remote=?', account.id, remote.id);
        return json(res, { id: attached.id }, 201);
      }
      const [name, color, hidden] = calendarEdit(body, { name: '', color: palette });
      db.run('INSERT INTO calendars(id,user,name,color,hidden) VALUES(?,?,?,?,?)', id, user, name, color, hidden);
      return json(res, { id }, 201);
    }
  }
  const accountMatch = path.match(/^\/api\/accounts\/([\w-]+)(\/calendars)?$/);
  if (accountMatch) {
    const account = owned('accounts', accountMatch[1], user);
    if (accountMatch[2] && method === 'GET') return json(res, await listCalendars(account));
    if (!accountMatch[2] && method === 'DELETE') {
      requireThat(!accountLocks.has(account.id) && !accountRunning(account.id), 409, 'Synchronization is running. Try again shortly.');
      accountLocks.add(account.id);
      let revoked = true;
      try {
        const calendars = db.all('SELECT * FROM calendars WHERE account=?', account.id);
        // Revoke also ends the app's ability to use any remaining channels.
        try { await google.revoke(account); } catch { revoked = false; }
        db.transaction(() => {
          const copies = new Map();
          for (const calendar of calendars) disconnect(calendar, copies);
          db.run('DELETE FROM accounts WHERE id=?', account.id);
        });
      } finally { accountLocks.delete(account.id); }
      return json(res, { revoked });
    }
  }
  const calendarMatch = path.match(/^\/api\/calendars\/([\w-]+)(?:\/(sync|logs|conflicts))?$/);
  if (calendarMatch) {
    const [, id, action] = calendarMatch;
    const calendar = owned('calendars', id, user);
    const account = calendar.account && owned('accounts', calendar.account, user);
    if (action === 'logs' && method === 'GET') return json(res, db.all(
      'SELECT at,kind,message FROM logs WHERE calendar=? ORDER BY id DESC LIMIT 50', id));
    if (action === 'conflicts' && method === 'GET') return json(res, db.all(
      "SELECT * FROM events WHERE calendar=? AND status='conflict'", id).map(row => eventDetail(row, calendar, account)));
    if (action === 'sync' && method === 'POST') {
      requireThat(account && !accountLocks.has(account.id), 409, 'Calendar cannot synchronize right now.');
      if (!sync.active(id)) queue(calendar);
      return json(res, {}, 202);
    }
    if (!action && method === 'PATCH') {
      const body = await payload(req);
      const latest = owned('calendars', id, user);
      const [name, color, hidden] = calendarEdit(body, latest);
      const direction = body.direction ?? latest.direction;
      if (direction !== latest.direction) {
        ready(latest);
        requireThat(latest.account && (direction === 'read' || (
          direction === 'both' && editableRole(latest.role) && canWrite(owned('accounts', latest.account, user))
        )), 403, 'Google write access is required for two-way sync.');
      }
      db.run('UPDATE calendars SET name=?,color=?,hidden=?,direction=? WHERE id=?', name, color, hidden, direction, id);
      if (direction !== latest.direction) queue(latest);
      return json(res, {});
    }
    if (!action && method === 'DELETE') {
      requireThat(account, 400, 'Only connected calendars can be disconnected.');
      requireThat(!accountLocks.has(account.id) && !accountRunning(account.id), 409, 'Synchronization is running. Try again shortly.');
      accountLocks.add(account.id);
      try {
        await Promise.allSettled(db.all('SELECT * FROM channels WHERE calendar=?', id)
          .map(channel => sync.stopChannel(account, channel)));
        db.transaction(() => disconnect(calendar, new Map()));
      } finally { accountLocks.delete(account.id); }
      return json(res, {});
    }
  }
  if (path === '/api/events' && method === 'GET') {
    const from = Date.parse(url.searchParams.get('from'));
    const to = Date.parse(url.searchParams.get('to'));
    requireThat(Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= 100 * day, 400, 'Choose a valid date range.');
    const rows = db.all(`SELECT e.*,c.zone FROM events e JOIN calendars c ON c.id=e.calendar
      WHERE c.user=? AND c.hidden=0`, user).map(row => ({ ...row, data: JSON.parse(row.data) }));
    return json(res, occurrences(rows, from, to));
  }
  if (path === '/api/events' && method === 'POST') {
    const body = await payload(req);
    const calendar = owned('calendars', body.calendar, user);
    ready(calendar);
    requireThat(calendar.direction !== 'read', 403, 'Choose a writable calendar.');
    const id = randomUUID();
    const data = cleanEvent(body, {}, calendar);
    db.transaction(() => {
      db.run('INSERT INTO events(id,calendar,google_id,data,status,operation,local_origin) VALUES(?,?,?,?,?,?,?)',
        id, calendar.id, calendar.account ? googleID() : null, JSON.stringify(data),
        calendar.account ? 'pending' : 'synced', calendar.account ? randomUUID() : null, Number(Boolean(calendar.account)));
      queue(calendar);
    });
    return json(res, { id }, 201);
  }
  const eventMatch = path.match(/^\/api\/events\/([\w-]+)(\/resolve)?$/);
  if (eventMatch) {
    const [, id, action] = eventMatch;
    const body = ['PATCH', 'DELETE', 'POST'].includes(method) ? await payload(req) : null;
    const row = db.get('SELECT e.* FROM events e JOIN calendars c ON c.id=e.calendar WHERE e.id=? AND c.user=?', id, user);
    requireThat(row, 404, 'Event unavailable.');
    const calendar = owned('calendars', row.calendar, user);
    const account = calendar.account && owned('accounts', calendar.account, user);
    if (!action && method === 'GET') return json(res, eventDetail(row, calendar, account));
    if (body) {
      ready(calendar);
      requireThat(body.revision === row.revision, 409, 'The event changed. Reopen it to review the latest version.');
      if (action && method === 'POST') {
        requireThat(row.status === 'conflict' && ['google', 'kova'].includes(body.choice), 400, 'Choose a conflict resolution.');
        const remote = JSON.parse(row.remote_data);
        if (body.choice === 'google' || (row.deleted && remote.status === 'cancelled')) {
          db.run(`UPDATE events SET data=remote_data,status='synced',deleted=?,operation=NULL,
            synced=?,revision=revision+1 WHERE id=?`, Number(remote.status === 'cancelled'), new Date().toISOString(), id);
        } else {
          requireThat(calendar.direction === 'both', 403, 'Enable two-way sync to keep the Kova version.');
          db.transaction(() => {
            if (remote.status === 'cancelled') db.run('UPDATE events SET google_id=?,remote_data=NULL,etag=NULL WHERE id=?', googleID(), id);
            db.run("UPDATE events SET status='pending',operation=?,revision=revision+1 WHERE id=?", randomUUID(), id);
            queue(calendar);
          });
        }
        sync.log(calendar.id, 'resolution', body.choice === 'google' ? 'Kept the Google version.' : 'Kept the Kova version.');
        return json(res, {});
      }
      if (!action && ['PATCH', 'DELETE'].includes(method)) {
        requireThat(calendar.direction !== 'read', 403, 'This calendar is read-only.');
        requireThat(!row.deleted && row.status !== 'conflict', 409, 'Resolve the event status before editing.');
        if (method === 'PATCH' && body.calendar && body.calendar !== calendar.id) {
          requireThat(!account, 400, 'Only Kova events can change calendar.');
          const destination = owned('calendars', body.calendar, user);
          ready(destination);
          requireThat(destination.direction !== 'read', 403, 'Choose a writable calendar.');
          const data = cleanEvent(body, JSON.parse(row.data), destination);
          db.transaction(() => {
            db.run(`UPDATE events SET calendar=?,google_id=?,data=?,status=?,operation=?,local_origin=?,
              revision=revision+1 WHERE id=?`, destination.id, destination.account ? googleID() : null,
              JSON.stringify(data), destination.account ? 'pending' : 'synced',
              destination.account ? randomUUID() : null, Number(Boolean(destination.account)), id);
            queue(destination);
          });
          return json(res, {});
        }
        const previous = JSON.parse(row.data);
        const data = method === 'PATCH' ? cleanEvent(body, previous, calendar) : previous;
        if (method === 'DELETE' && previous.recurringEventId && previous.originalStartTime) data.status = 'cancelled';
        db.transaction(() => {
          db.run(`UPDATE events SET data=?,status=?,deleted=?,operation=?,revision=revision+1 WHERE id=?`,
            JSON.stringify(data), account ? 'pending' : 'synced', Number(method === 'DELETE'), account ? randomUUID() : null, id);
          queue(calendar);
        });
        return json(res, {});
      }
    }
  }
  throw new HttpError(404, 'Page unavailable.');
}

const server = createServer((req, res) => {
  route(req, res).catch(error => {
    if (res.headersSent) return res.destroy();
    if (!(error instanceof HttpError) && !error.status) console.error(error);
    const status = error instanceof HttpError ? error.status : error.status ? 502 : 500;
    json(res, { error: status === 500 ? 'Kova could not complete this request.' : error.message }, status);
  });
});
server.listen(port, process.env.BIND_HOST || (loopback ? '127.0.0.1' : '0.0.0.0'), () => {
  console.log(`KovaCalendar listening on ${origin.origin}`);
});
let ticking = false;
const worker = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    db.run('DELETE FROM sessions WHERE expires<?', now);
    db.run('DELETE FROM oauth WHERE expires<?', now);
    db.run('DELETE FROM channels WHERE expires<?', now);
    if (!connectEnabled) return;
    const due = db.all('SELECT id,account FROM calendars WHERE account IS NOT NULL AND due<=? ORDER BY due LIMIT 20', now);
    await Promise.allSettled(due.filter(row => !accountLocks.has(row.account)).map(row => sync.start(row.id)));
  } finally { ticking = false; }
}, 2000);
worker.unref();
