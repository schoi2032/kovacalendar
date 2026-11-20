const root = document.querySelector('#root');
const dialog = document.querySelector('#dialog');
const toast = document.querySelector('#toast');
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
let selected = new Date();
let view = 'month';
let collapsed = false;
let session;
let calendars = [];
let accounts = [];
let items = [];
let recurrenceErrors = [];
let version = 0;
let toastTimer;
let settingsOpen = false;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'click') node.addEventListener('click', value);
    else if (key === 'change') node.addEventListener('change', value);
    else if (key === 'color') node.style.setProperty('--event-color', value);
    else if (key.startsWith('aria-')) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children.flat().filter(child => child != null));
  return node;
}
const button = (text, click, options = {}) => el('button', {
  type: 'button', click: () => Promise.resolve().then(click).catch(error => notify(error.message)), ...options,
});
const field = (label, input) => el('label', { className: 'field' }, label, input);
const option = (value, label) => el('option', { value }, label);
const text = (label, className = 'muted') => el('p', { className }, label);

async function api(path, method = 'GET', data = {}) {
  const response = await fetch(`/api${path}`, method === 'GET' ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Something went wrong.');
  return result;
}
function notify(message) {
  clearTimeout(toastTimer);
  const alert = dialog.open && dialog.querySelector('[role=alert]');
  if (alert) {
    alert.textContent = message;
    alert.hidden = false;
    return;
  }
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5500);
}
async function oauth(mode, account) {
  window.location.assign((await api('/oauth', 'POST', { mode, account })).url);
}
function dateKey(day) {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
function gridDays() {
  const first = new Date(selected.getFullYear(), selected.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}
function range() {
  return view === 'day' ? [selected] : gridDays();
}
async function refresh(draw = true) {
  const request = ++version;
  const days = range();
  const query = new URLSearchParams({
    from: addDays(days[0], -1).toISOString(),
    to: addDays(days.at(-1), 2).toISOString(),
  });
  const [settings, events] = await Promise.all([api('/calendars'), api(`/events?${query}`)]);
  if (request !== version) return;
  ({ calendars, accounts } = settings);
  items = events.items;
  recurrenceErrors = events.errors;
  if (draw) render();
  if (settingsOpen) updateStatuses();
}
function changeDay(value, nextView = view) {
  selected = value;
  view = nextView;
  return refresh();
}
function itemsOn(date) {
  const key = dateKey(date);
  const start = addDays(date, 0).getTime();
  const end = addDays(date, 1).getTime();
  return items.filter(event => event.start.date
    ? event.start.date <= key && event.end.date > key
    : Date.parse(event.start.dateTime) < end && Date.parse(event.end.dateTime) > start);
}
function eventButton(event) {
  const calendar = calendars.find(item => item.id === event.calendar);
  const state = event.status === 'pending' ? ' · pending' : event.status === 'conflict' ? ' · conflict' : '';
  const time = event.start.dateTime ? `${clock.format(new Date(event.start.dateTime))} ` : '';
  const title = event.summary || 'Untitled event';
  return button(`${time}${title}${state}`, () => editEvent(event.id), {
    className: `event${calendar?.account ? ' external' : ''}`,
    color: calendar?.color || '#674cce', title: `${title} · ${calendar?.name ?? ''}${state}`,
  });
}
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function sidebar() {
  const days = gridDays();
  const sections = [false, true].map(external => {
    const list = calendars.filter(c => Boolean(c.account) === external);
    if (external && !list.length) return null;
    return el('section', {}, el('h2', {}, external ? 'Google Calendars' : 'My calendars'),
      list.map(calendar => el('label', { className: 'cal-check', color: calendar.color },
        el('input', { type: 'checkbox', checked: !calendar.hidden, change: async event => {
          try {
            await api(`/calendars/${calendar.id}`, 'PATCH', { hidden: !event.target.checked });
            await refresh();
          } catch (error) {
            event.target.checked = !event.target.checked;
            notify(error.message);
          }
        } }), el('span', { title: calendar.name }, calendar.name))));
  });
  return el('aside', { className: 'sidebar' },
    el('div', { className: 'brand' }, el('span', { className: 'mark', 'aria-hidden': 'true' }, 'K'), 'KovaCalendar'),
    button('+ New event', () => editEvent(null, selected), { className: 'primary' }),
    el('section', {}, el('h2', {}, monthFormat.format(selected)), el('div', { className: 'mini' },
      weekdays.map(day => el('small', {}, day.slice(0, 2))),
      days.map(day => button(String(day.getDate()), () => changeDay(day, 'day'), {
        className: [day.getMonth() !== selected.getMonth() && 'outside',
          dateKey(day) === dateKey(selected) && 'selected', dateKey(day) === dateKey(new Date()) && 'today'].filter(Boolean).join(' '),
        'aria-label': dayFormat.format(day),
      })))),
    sections,
    el('div', { className: 'sidebar-footer' }, button('Calendar settings', openSettings, { className: 'ghost' })));
}
function render() {
  const selection = el('select', { 'aria-label': 'Calendar view', change: event => changeDay(selected, event.target.value).catch(err => notify(err.message)) },
    option('month', 'Month'), option('day', 'Day'), option('agenda', 'Agenda'));
  selection.value = view;
  const shift = amount => changeDay(view === 'day' ? addDays(selected, amount)
    : new Date(selected.getFullYear(), selected.getMonth() + amount, 1));
  const toolbar = el('header', { className: 'toolbar' },
    el('div', { className: 'row' },
      button('☰', () => { collapsed = !collapsed; render(); }, { 'aria-label': collapsed ? 'Show sidebar' : 'Hide sidebar' }),
      button('Today', () => changeDay(new Date())),
      button('‹', () => shift(-1), { 'aria-label': 'Previous period' }),
      button('›', () => shift(1), { 'aria-label': 'Next period' }),
      el('h1', {}, view === 'day' ? dayFormat.format(selected) : monthFormat.format(selected))),
    el('div', { className: 'row' }, selection,
      collapsed && button('+ New event', () => editEvent(null, selected), { className: 'primary' }) || null,
      button('Settings', openSettings)));
  let panel;
  if (view === 'month') {
    panel = el('div', { className: 'scroll-grid' }, el('div', { className: 'month', 'aria-label': 'Month calendar' },
      weekdays.map(day => el('div', { className: 'week-label' }, day)),
      gridDays().map(day => {
        const events = itemsOn(day);
        const classes = `day${day.getMonth() !== selected.getMonth() ? ' outside' : ''}`;
        const current = dateKey(day) === dateKey(new Date());
        return el('section', { className: classes },
          button(String(day.getDate()), () => changeDay(day, 'day'), {
            className: `day-number${current ? ' today' : ''}`, 'aria-label': dayFormat.format(day),
          }),
          events.slice(0, 4).map(eventButton),
          events.length > 4 ? button(`+${events.length - 4} more`, () => changeDay(day, 'day'), { className: 'ghost more' }) : null);
      })));
  } else {
    const rows = range().filter(day => view === 'day' || day.getMonth() === selected.getMonth())
      .map(day => ({ day, events: itemsOn(day) })).filter(row => view === 'day' || row.events.length);
    panel = el('div', { className: 'agenda' },
      rows.map(({ day, events }) => el('section', {},
        el('div', { className: 'section-title' }, el('h2', {}, dayFormat.format(day)), button('+ Add event', () => editEvent(null, day))),
        events.length ? events.map(eventButton) : text('No events scheduled.'))),
      !rows.length ? text('No events scheduled this month.') : null);
  }
  root.replaceChildren(el('div', { className: `shell${collapsed ? ' collapsed' : ''}` },
    collapsed ? null : sidebar(), el('div', { className: 'workspace' }, toolbar, panel,
      recurrenceErrors.length ? text(`Some recurring events could not be expanded (${recurrenceErrors.length}).`, 'error initial') : null)));
}

function modal(title, ...content) {
  settingsOpen = false;
  dialog.replaceChildren(el('header', {}, el('h2', {}, title),
    button('Close', () => dialog.close(), { className: 'ghost' })),
    el('p', { className: 'error', hidden: true }), ...content.filter(Boolean));
  dialog.querySelector('p.error').setAttribute('role', 'alert');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
dialog.addEventListener('close', () => { settingsOpen = false; });

function syncLabel(calendar) {
  const last = calendar.last_sync ? `Last successful sync ${new Date(calendar.last_sync).toLocaleString()}` : 'Waiting for first sync';
  const state = calendar.running ? 'Synchronizing' : calendar.error ? calendar.error : 'Continuous sync enabled';
  return [state, last, calendar.pending ? `${calendar.pending} pending` : '',
    calendar.conflicts ? `${calendar.conflicts} conflicts` : '', calendar.watch_error ? 'Polling active. Push unavailable.' : ''].filter(Boolean).join(' · ');
}
function updateStatuses() {
  for (const node of dialog.querySelectorAll('[data-sync-status]')) {
    const calendar = calendars.find(item => item.id === node.dataset.syncStatus);
    if (calendar) node.textContent = syncLabel(calendar);
  }
}
function formSubmit(form, action) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true;
    try { await action(); }
    catch (error) { notify(error.message); }
    finally { submit.disabled = false; }
  });
}

async function openSettings() {
  await refresh(false);
  const createName = el('input', { required: true, maxLength: 100, placeholder: 'Calendar name' });
  const create = el('form', {}, field('Calendar name', createName),
    el('div', { className: 'actions' }, el('button', { type: 'submit' }, 'Add Kova calendar')));
  formSubmit(create, async () => {
    await api('/calendars', 'POST', { name: createName.value });
    await refresh();
    await openSettings();
  });
  const googleSection = el('section', {},
    el('div', { className: 'section-title' }, el('h3', {}, 'Google Calendar'),
      button('Connect Google Calendar', () => oauth('read'), { className: 'primary', disabled: !session.connectEnabled })),
    text(session.connectEnabled ? 'Choose which Google calendars appear in Kova. New connections use read-only access.'
      : 'Google Calendar connection requires server configuration.'),
    accounts.map(account => el('section', {},
      el('h4', {}, account.email || 'Google account'),
      text(account.write ? 'Calendar list and event read/write access' : 'Calendar list and event read-only access'),
      el('div', { className: 'actions' },
        button('Choose calendars', () => chooseCalendars(account)),
        button(account.write ? 'Switch to read-only' : 'Allow event changes', () => oauth(account.write ? 'read' : 'write', account.id)),
        button('Reconnect', () => oauth(account.write ? 'write' : 'read', account.id)),
        button('Disconnect account', () => confirmAction('Disconnect Google account?',
          'Imported events will disappear. Active events created in Kova and unsynced edits will be preserved in a local recovery calendar.',
          async () => {
            const result = await api(`/accounts/${account.id}`, 'DELETE');
            await refresh();
            await openSettings();
            notify(result.revoked ? 'Google account disconnected.' : 'Account disconnected from Kova. Google could not confirm permission revocation.');
          }), { className: 'danger' })))));
  modal('Calendar settings',
    el('section', {}, el('h3', {}, session.user.name),
      session.user.email ? text(session.user.email) : null,
      button('Sign out', async () => { await api('/logout', 'POST'); location.reload(); })),
    googleSection,
    el('section', {}, el('h3', {}, 'Add a Kova calendar'), create),
    calendars.map(calendarSettings));
  settingsOpen = true;
}
function calendarSettings(calendar) {
  const name = el('input', { value: calendar.name, required: true, maxLength: 100 });
  const color = el('input', { type: 'color', value: calendar.color });
  const hide = el('input', { type: 'checkbox', checked: Boolean(calendar.hidden) });
  const account = accounts.find(a => a.id === calendar.account);
  const direction = el('select', {}, option('read', 'Google to Kova'), option('both', 'Two-way sync'));
  direction.value = calendar.direction;
  direction.options[1].disabled = !account?.write || !['writer', 'owner'].includes(calendar.role);
  const form = el('form', {}, el('div', { className: 'split' }, field('Display name', name), field('Color', color)),
    el('label', { className: 'row' }, hide, 'Hide in calendar'),
    account ? field('Sync direction', direction) : null,
    el('div', { className: 'actions' }, el('button', { type: 'submit' }, 'Save calendar')));
  formSubmit(form, async () => {
    await api(`/calendars/${calendar.id}`, 'PATCH', {
      name: name.value, color: color.value, hidden: hide.checked, ...(account && { direction: direction.value }),
    });
    await refresh();
    notify('Calendar settings saved.');
  });
  const status = text(syncLabel(calendar));
  status.dataset.syncStatus = calendar.id;
  return el('section', {},
    el('h3', {}, calendar.name, el('small', {}, account ? ' · Google' : ' · Kova')),
    account ? status : null, form, account ? el('p', { className: 'actions' },
      button('Sync now', async () => { await api(`/calendars/${calendar.id}/sync`, 'POST'); notify('Synchronization requested.'); }),
      button('Sync log', () => openLog(calendar)),
      button('Review conflicts', () => showConflicts(calendar)),
      button('Disconnect calendar', () => confirmAction('Disconnect this calendar?',
        'Imported events will disappear. Active events created in Kova and unsynced edits will be preserved in a local recovery calendar.',
        async () => { await api(`/calendars/${calendar.id}`, 'DELETE'); await refresh(); await openSettings(); }),
      { className: 'danger' })) : null);
}
function confirmAction(title, description, action) {
  modal(title, text(description), el('div', { className: 'actions' },
    button('Cancel', openSettings), button('Disconnect', action, { className: 'danger' })));
}
async function chooseCalendars(account) {
  const available = await api(`/accounts/${account.id}/calendars`);
  const rows = available.map(calendar => {
    const connected = calendars.some(c => c.account === account.id && c.remote === calendar.id);
    const input = el('input', { type: 'checkbox', checked: connected, disabled: connected });
    return { input, calendar, label: el('label', { className: 'cal-check', color: calendar.color }, input,
      el('span', {}, calendar.name), connected ? el('small', {}, 'Connected') : null) };
  });
  const form = el('form', {}, rows.map(row => row.label), !rows.length ? text('No readable Google calendars found.') : null,
    el('div', { className: 'actions' }, button('Back to settings', openSettings),
      el('button', { type: 'submit', className: 'primary' }, 'Import selected calendars')));
  formSubmit(form, async () => {
    for (const { input, calendar } of rows) {
      if (!input.checked || input.disabled) continue;
      await api('/calendars', 'POST', { account: account.id, remote: calendar.id });
      input.disabled = true;
    }
    await refresh();
    await openSettings();
  });
  modal('Choose Google calendars', form);
}
async function openLog(calendar) {
  const records = await api(`/calendars/${calendar.id}/logs`);
  modal(`${calendar.name} sync log`, button('Back to settings', openSettings),
    records.length ? records.map(record => el('section', {},
      el('small', {}, new Date(record.at).toLocaleString(), ' · ', record.kind), text(record.message)))
      : text('No synchronization attempts yet.'));
}
async function showConflicts(calendar) {
  const records = await api(`/calendars/${calendar.id}/conflicts`);
  modal(`${calendar.name} conflicts`, button('Back to settings', openSettings),
    records.length ? records.map(record => el('section', {},
      button(record.data.summary || record.remote?.summary || 'Untitled event', () => reviewConflict(record, calendar))))
      : text('No conflicts to review.'));
}
function preview(data, deleted) {
  if (deleted || data?.status === 'cancelled') return 'Deleted';
  const start = data?.start?.date ?? data?.start?.dateTime;
  const end = data?.end?.date ?? data?.end?.dateTime;
  return [data?.summary || 'Untitled event', start && end ? `${start} – ${end}` : '',
    data?.start?.timeZone, data?.location, data?.description, ...(data?.recurrence ?? [])].filter(Boolean).join('\n');
}
function reviewConflict(record, calendar) {
  const resolve = async choice => {
    await api(`/events/${record.id}/resolve`, 'POST', { choice, revision: record.revision });
    await refresh();
    await showConflicts(calendar);
  };
  modal('Resolve event conflict',
    text('Choose the version to keep. Keeping Kova queues its changes for Google.'),
    el('section', {}, el('h3', {}, 'Kova version'), el('pre', {}, preview(record.data, record.deleted))),
    el('section', {}, el('h3', {}, 'Google version'), el('pre', {}, preview(record.remote))),
    el('div', { className: 'actions' }, button('Keep Google version', () => resolve('google')),
      button('Keep Kova version', () => resolve('kova'), { disabled: calendar.direction !== 'both' }),
      button('Back to conflicts', () => showConflicts(calendar))));
}

function editDate(value, zone) {
  if (value.date) return value.date;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(value.dateTime)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function fromWall(value, zone) {
  const wall = Date.parse(`${value}Z`);
  if (!Number.isFinite(wall)) throw new Error('Choose a start and end time.');
  let instant = wall;
  for (let attempt = 0; attempt < 4; attempt++) {
    const rendered = editDate({ dateTime: new Date(instant).toISOString() }, zone);
    if (rendered === value) return { dateTime: new Date(instant).toISOString(), timeZone: zone };
    instant += wall - Date.parse(`${rendered}Z`);
  }
  throw new Error('This time does not exist in the chosen time zone. Choose another time.');
}
async function editEvent(id, day = selected) {
  const record = id ? await api(`/events/${id}`) : null;
  const calendar = calendars.find(item => item.id === record?.calendar);
  if (record?.status === 'conflict') return reviewConflict(record, calendar);
  const data = record?.data ?? {};
  if (record && !record.editable) {
    return modal(data.summary || 'Untitled event',
      text(`${calendar?.name ?? 'Calendar'} · Google read-only`), el('pre', {}, preview(data)),
      data.htmlLink && /^https:\/\/calendar\.google\.com\//.test(data.htmlLink)
        ? el('a', { href: data.htmlLink, rel: 'noopener noreferrer', target: '_blank' }, 'Open in Google Calendar') : null);
  }
  const zoneName = data.start?.timeZone || localZone;
  const date = dateKey(day);
  const initialStart = data.start ? editDate(data.start, zoneName) : `${date}T09:00`;
  const initialEnd = data.end ? editDate(data.end, data.end.timeZone || zoneName) : `${date}T10:00`;
  const summary = el('input', { value: data.summary ?? '', required: true, maxLength: 8192 });
  const location = el('input', { value: data.location ?? '', maxLength: 8192 });
  const description = el('textarea', { value: data.description ?? '', maxLength: 8192, rows: 3 });
  const timezone = el('input', { value: zoneName, required: true, disabled: Boolean(data.start?.date) });
  const allDay = el('input', { type: 'checkbox', checked: Boolean(data.start?.date), change: () => {
    const dayStart = start.value.slice(0, 10);
    let dayEnd = end.value.slice(0, 10);
    if (allDay.checked && dayStart && (!dayEnd || dayStart === dayEnd)) {
      dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString().slice(0, 10);
    }
    start.type = end.type = allDay.checked ? 'date' : 'datetime-local';
    start.value = allDay.checked ? dayStart : `${dayStart}T09:00`;
    end.value = allDay.checked ? dayEnd : `${dayEnd}T10:00`;
    timezone.disabled = allDay.checked;
  } });
  const type = allDay.checked ? 'date' : 'datetime-local';
  const start = el('input', { type, value: initialStart, required: true });
  const end = el('input', { type, value: initialEnd, required: true });
  const recurrence = el('textarea', { rows: 2, value: (data.recurrence ?? []).join('\n'), placeholder: 'RRULE:FREQ=WEEKLY' });
  const destinations = calendar?.account ? [calendar] : calendars.filter(item => item.direction !== 'read');
  const destination = el('select', { disabled: Boolean(calendar?.account) }, destinations.filter(Boolean).map(item =>
    option(item.id, `${item.name}${item.account ? ' · Google' : ''}`)));
  if (calendar) destination.value = calendar.id;
  const actions = el('div', { className: 'actions' },
    el('button', { type: 'submit', className: 'primary' }, record ? 'Save event' : 'Create event'),
    record ? button('Delete event', () => modal('Delete this event?',
      text(calendar.account ? 'This deletion will also sync to Google.' : 'This event will be removed from your calendar.'),
      el('div', { className: 'actions' }, button('Cancel', () => editEvent(id)),
        button('Delete', async () => {
          await api(`/events/${id}`, 'DELETE', { revision: record.revision });
          dialog.close();
          await refresh();
        }, { className: 'danger' }))), { className: 'danger' }) : null);
  const recurring = data.recurrence?.length && !data.recurringEventId;
  const form = el('form', {}, field('Title', summary), field('Calendar', destination),
    recurring ? text('Changes apply to the recurring series.') : null,
    el('label', { className: 'row' }, allDay, 'All-day event'),
    el('div', { className: 'split' }, field('Starts', start), field('Ends', end)),
    field('Time zone', timezone), field('Location', location), field('Description', description),
    data.recurringEventId ? null : field('Recurrence rules', recurrence),
    actions);
  formSubmit(form, async () => {
    const zone = timezone.value.trim();
    const point = (input, initial, old) => {
      if (old && input.value === initial && zone === zoneName && Boolean(old.date) === allDay.checked) return old;
      return allDay.checked ? { date: input.value } : fromWall(input.value, zone);
    };
    const body = {
      calendar: destination.value, revision: record?.revision, summary: summary.value,
      start: point(start, initialStart, data.start), end: point(end, initialEnd, data.end),
      location: location.value, description: description.value,
      ...(!data.recurringEventId && { recurrence: recurrence.value.split('\n').map(rule => rule.trim()).filter(Boolean) }),
    };
    if (record) await api(`/events/${id}`, 'PATCH', body);
    else await api('/events', 'POST', body);
    dialog.close();
    await refresh();
  });
  modal(record ? 'Edit event' : 'New event', form);
}
async function initialize() {
  session = await api('/session');
  const query = new URLSearchParams(location.search);
  if (query.size) history.replaceState(null, '', '/');
  if (query.get('oauthError')) notify(query.get('oauthError'));
  if (query.get('notice') === 'denied') notify('Google access was declined.');
  if (query.get('notice') === 'invalid') notify('The Google sign-in request expired. Try again.');
  if (!session.user) {
    root.replaceChildren(el('div', { className: 'auth' }, el('article', {},
      el('div', { className: 'brand' }, el('span', { className: 'mark', 'aria-hidden': 'true' }, 'K'), 'KovaCalendar'),
      el('h1', {}, 'Your time, organized.'),
      text('Create events and manage your calendars in one workspace. Connect Google Calendar whenever you’re ready.'),
      el('div', { className: 'actions' },
        button('Sign in with Google', () => oauth('login'), { className: 'primary', disabled: !session.loginEnabled }),
        session.local ? button('Open local workspace', async () => { await api('/local', 'POST'); location.reload(); }) : null),
      !session.loginEnabled ? text('Google sign-in requires server configuration.') : null)));
    return;
  }
  await refresh();
  if (query.get('notice') === 'connected') {
    notify('Google account connected. Choose calendars to import.');
    await openSettings();
  }
  setInterval(() => {
    if (document.visibilityState === 'visible' && !root.contains(document.activeElement)) {
      refresh().catch(error => notify(error.message));
    }
  }, 15_000);
}

initialize().catch(error => root.replaceChildren(text(error.message, 'initial error')));
