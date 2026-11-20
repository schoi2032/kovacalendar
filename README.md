# KovaCalendar

Simple, Minimalistic, andEasy to use. Organize your tasks in one place.

# About Kova

Kova is a lightweight productivity suite designed around clarity and focus. One account, clean interfaces, and essential tools—made to help you get things done without getting in your way.

# Other Kova Apps

## Run KovaCalendar

Install Node.js 24 or later and run `npm ci`. Start with `npm start` and open
`http://localhost:3000`. To evaluate the standalone calendar without Google,
set `KOVA_LOCAL_MODE=1`. Local mode uses a shared development workspace and is
available only over loopback HTTP.

## Configure Google Calendar

1. Copy `.env.example` to `.env`. In Google Cloud, enable the Calendar API and
   create a Web application OAuth client. Register
   `http://localhost:3000/oauth/callback` for local testing. For a hosted instance,
   register its HTTPS origin with the same callback path.
2. Set `APP_ORIGIN`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`. Generate
   `KOVA_TOKEN_KEY` with `openssl rand -hex 32`. Keep the key with the server's
   secrets and retain it when backing up the database.
3. Sign in with Google, then open **Settings → Connect Google Calendar** to
   grant calendar-list and event read access. Choose the calendars to import.
   To send changes back, grant event write access under the connected account
   and enable **Two-way sync** on each writable calendar.
4. For push notifications, set `GOOGLE_WEBHOOK_URL` to the public HTTPS
   `/webhooks/google` endpoint. Keep the server running to process jobs.
   Kova also polls every five minutes and does a full reconciliation weekly.

Sign-in and Google Calendar consent are separate. Create events in a Kova
calendar by default. Choose an enabled two-way calendar in the event editor to
send an event to Google. Generated recurring occurrences open the series editor.
Google exceptions and cancellations are applied to displayed instances.

Settings show the last successful sync, errors, pending changes, and a sync log
for each Google calendar. For concurrent edits, review the Kova and Google
versions and choose which to keep. Disconnecting removes imported calendar
data. Active events created in Kova and pending edits to active events are
preserved in a local recovery calendar.

Run one Node server process per persistent SQLite database. The default database
path is `data/kova.sqlite`, configurable with `KOVA_DB_PATH`. Put hosted
instances behind an HTTPS reverse proxy and back up the database using
SQLite-compatible backups. `npm test` runs the synchronization and recurrence
tests with a simulated Google API.
