import ICAL from 'ical.js';

const utcZones = new Set(['UTC', 'Etc/UTC', 'GMT']);
const zones = new Map();

function zone(name) {
  if (!name || utcZones.has(name)) return ICAL.Timezone.utcTimezone;
  if (!zones.has(name)) {
    const format = new Intl.DateTimeFormat('en-GB', {
      timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    const result = new ICAL.Timezone({ tzid: name });
    result.utcOffset = time => {
      const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
      const offset = instant => {
        const parts = Object.fromEntries(format.formatToParts(instant).map(p => [p.type, Number(p.value)]));
        return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant) / 1000;
      };
      const first = offset(wall);
      const second = offset(wall - first * 1000);
      const third = offset(wall - second * 1000);
      return second === third ? second : Math.min(second, third);
    };
    zones.set(name, result);
    ICAL.TimezoneService.register(result);
  }
  return zones.get(name);
}

const millis = value => value.date ? Date.parse(value.date) : Date.parse(value.dateTime);
const key = value => value.date ?? millis(value);
const compact = value => value.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function startLine(value, fallback) {
  if (value.date) return `DTSTART;VALUE=DATE:${compact(value.date)}`;
  const date = new Date(value.dateTime);
  const timeZone = value.timeZone ?? fallback ?? 'UTC';
  zone(timeZone);
  if (utcZones.has(timeZone)) return `DTSTART:${compact(date.toISOString())}`;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return `DTSTART;TZID=${timeZone}:${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
}

export function occurrences(rows, from, to) {
  const output = [];
  const errors = [];
  const exceptions = new Map();
  for (const row of rows) {
    const event = row.data;
    if (!event.recurringEventId || !event.originalStartTime) continue;
    const series = `${row.calendar}/${event.recurringEventId}`;
    if (!exceptions.has(series)) exceptions.set(series, new Set());
    exceptions.get(series).add(key(event.originalStartTime));
  }
  function add(row, event, instance = false) {
    if (!event.start || !event.end) return;
    const start = millis(event.start);
    const end = millis(event.end);
    if (start < to && Math.max(start + 1, end) > from) {
      output.push({ id: row.id, calendar: row.calendar, revision: row.revision, status: row.status,
        summary: event.summary, start: event.start, end: event.end, instance });
    }
  }
  for (const row of rows) {
    if (row.deleted) continue;
    const event = row.data;
    if (!event.recurrence?.length || event.recurringEventId) {
      add(row, event);
      continue;
    }
    try {
      if (!event.start || !event.end) continue;
      const duration = millis(event.end) - millis(event.start);
      for (const line of event.recurrence) {
        const timeZone = line.match(/;TZID=([^;:]+)(?=[;:])/)?.[1];
        if (timeZone) zone(timeZone);
        if (!/^(RRULE|RDATE|EXRULE|EXDATE)[;:]/.test(line) || /[\r\n]/.test(line)) throw new Error('Invalid recurrence');
      }
      const component = new ICAL.Component(ICAL.parse(
        ['BEGIN:VEVENT', startLine(event.start, row.zone), ...event.recurrence, 'END:VEVENT'].join('\r\n')));
      const recurring = new ICAL.Event(component);
      const iterator = recurring.iterator();
      const excluded = exceptions.get(`${row.calendar}/${row.google_id}`);
      let count = 0;
      for (let occurrence = iterator.next(); occurrence; occurrence = iterator.next()) {
        if (++count > 100_000) throw new Error('Recurrence limit exceeded');
        const start = occurrence.toUnixTime() * 1000;
        if (start >= to) break;
        if (start + Math.max(1, duration) <= from) continue;
        const value = instant => event.start.date
          ? { date: new Date(instant).toISOString().slice(0, 10) }
          : { dateTime: new Date(instant).toISOString(), timeZone: event.start.timeZone ?? row.zone ?? 'UTC' };
        const startValue = value(start);
        if (!excluded?.has(key(startValue))) {
          add(row, { ...event, start: startValue, end: value(start + duration) }, true);
        }
      }
    } catch {
      errors.push(event.summary || 'Untitled event');
      add(row, event);
    }
  }
  return { items: output.sort((a, b) => millis(a.start) - millis(b.start)), errors };
}
