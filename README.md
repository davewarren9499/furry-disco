# Todo Dashboard

A single-user todo dashboard that pulls in:

- **IRIS CRM (Banquest) Helpdesk tickets** — assigned to you, plus tickets where a comment @mentions you.
- **Missive conversations** assigned to you, with the email thread shown inline.
- Manually-added tasks.

Tasks are ranked by drag-and-drop and importance, and move through three tabs:
**Open → Resolved → Done**. Resolved is auto-populated from the source system's
status (capped at the most recent 50 per source); Done is a manual bucket for
anything you want off your plate regardless of who's actually responsible for it.

## Setup

```
npm install
cp .env.example .env   # fill in IRIS_API_KEY, IRIS_USER_ID, MISSIVE_API_TOKEN, MISSIVE_USER_ID
npm start
```

Open http://localhost:3000.

Either integration can be left unconfigured (just omit its API key) — the
poller skips it and logs nothing is wrong; the dashboard still works for
manual tasks.

## How it works

- `server/integrations/iris.js` and `server/integrations/missive.js` are thin
  REST clients. **Both were written against each vendor's documented API
  conventions without being able to reach their live docs from this build
  environment** (outbound access to iriscrm.com / missiveapp.com was
  network-blocked). The request/response shapes are a best-effort match —
  once you plug in a real API key, check the server logs on first sync; if a
  path 404s, the fix is almost always a one-line change to
  `IRIS_TICKETS_PATH` / `IRIS_COMMENTS_PATH` in `.env`, or the field names in
  `normalizeTicket()` / `normalizeConversation()`.
- `server/poller.js` polls both sources on a cron schedule (`POLL_CRON`,
  default every 2 minutes) and upserts into a local `tasks` table (SQLite).
  There's no reliable "assigned to me" or "@mention" *webhook* in either
  vendor's public API, so this is polling-based by design: each tick re-fetches
  your assigned tickets/conversations, and separately scans tickets updated
  since the last poll for a comment that @mentions you, even if you're not
  the assignee.
- Status changes made in the dashboard (Open ⇄ Done) are local-only and never
  write back to IRIS or Missive — this dashboard is read-only with respect to
  ticket/conversation status. `resolved` specifically can only be set by the
  source sync (see `server/poller.js`); the UI and API both reject any
  attempt to set it manually, since that's the one status IRIS/Missive
  themselves are authoritative over. Posting a comment is the one action
  that *does* write back to IRIS for real (see `server/routes/comments.js`).
- Comment templates are just named snippets stored in SQLite, picked from a
  dropdown in the task drawer and inserted into the comment box for editing
  before posting.

## Known gaps to verify against your real IRIS/Missive accounts

1. **IRIS auth header** — the client sends both `Authorization: Bearer` and
   `X-API-KEY`; drop whichever your account doesn't use.
2. **IRIS mention detection** — `commentMentionsMe()` checks a
   `mentioned_user_ids`/`mentions` array on the comment object and falls back
   to a plain `@username` text match. Confirm which (if either) your IRIS
   instance actually returns; this is the part flagged as "difficult" in the
   original ask, and it's the one integration point most likely to need
   real trial-and-error against live data.
3. **Missive "task"** — Missive doesn't have a native task object, so a task
   here means a conversation assigned to you. If you actually use Missive's
   separate "Tasks" feature (checklist items inside conversations) rather
   than assignment, that's a different endpoint and `normalizeConversation()`
   needs adjusting.
