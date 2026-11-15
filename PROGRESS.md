# calendar_track - progress & handoff

**Read this first in any new session.** The user is on a Claude Pro plan, so a
session can run out mid-task. Keep this file current: update it before ending
any piece of work, and tick things off as they're done.

Live URL: https://anonymousecheese.github.io/calendar_track/
Source: `D:\Githubrepos\calendar_track` (deploy steps: `D:\Githubrepos\DEPLOY.md`)

---

## What it is

A private calendar / job-notes app for the user's iPhone, installed to the
Home Screen from Safari. Three tabs:

1. **Calendar** - month grid, tap a day, type a note (autosaves).
2. **Active jobs** - each job has dated notes. A recurring job is a chain of
   "rounds" sharing a `seriesId`. A "Show previous notes" toggle shows the notes
   from the earlier rounds.
3. **Old jobs** - finished jobs, searchable by title and note text. They can be
   restarted as a new round or moved back to active.

There's also a password lock (simple screen lock, hash only), an encrypted
backup export/import, and an automatic daily safety copy with undo.

## Privacy model (do not break)

- **All notes live only on the phone** (localStorage). Nothing is ever sent
  anywhere. The repo is PUBLIC and must never contain real notes.
- The CSP in `index.html` blocks requests to other sites. Don't add CDNs,
  analytics, fonts or any third-party script. No libraries.
- Render user text with `textContent` only, never `innerHTML`.
- The password is never in the code. The user sets it on the device, and only a
  PBKDF2 hash is stored (`ct.lock`). A recovery code (shown once at setup)
  can reset it.

## DATA SAFETY ACROSS VERSIONS (user's top priority)

The user's rule: **data must never be wiped when the app is updated.**

- localStorage keys: `ct.data` (all notes), `ct.lock` (password hash),
  `ct.lastBackup`, `ct.snapshot` (daily copy), plus `ct.data.before-*` and
  `ct.rescue.*` safety copies. **Never rename or delete these keys.**
- To change the data format, raise `SCHEMA` in `app.js` and add a
  `MIGRATIONS[oldVersion]` step. The old data is copied aside automatically
  before migrating.
- `normalise()` keeps unknown fields, so older code never strips newer data.
- If the stored schema is newer than the code, the app goes read-only.
- If the stored data is unreadable, it's moved to `ct.rescue.<time>` and never
  overwritten.
- **Never change the URL.** No repo rename, no GitHub username change, no
  custom domain. iPhone ties the data to the exact web address. A new address
  means the app opens empty (the old data is stranded, not deleted). If a move
  is ever needed: export on the old address, then import on the new one.
- On iPhone, the Home Screen app and a Safari tab have **separate** storage.

## Releasing a new version

1. Bump `?v=N` on **every** asset in `index.html`.
2. In `sw.js`, bump `CACHE` (`ct-vN`) and the `?v=N` entries in `SHELL` to match.
3. Run all four test suites (below). Each must print `ALL PASSED`.
4. Commit and push (DEPLOY.md, Case 1). Pages updates in ~1-2 min, and the
   phone picks it up on the next open while online.

## Tests

```bash
cd /d/Githubrepos/calendar_track/tests
npm install            # first time only (puppeteer-core; node_modules is gitignored)
# terminal 1: serve the app
cd .. && python -m http.server 8765 --bind 127.0.0.1
# terminal 2:
node test.js           # 103 feature checks, drives real Edge at iPhone size
node test_drag.js      # 12 checks: drag-to-reorder Active jobs with a real mouse
node test_stages.js    # 30 checks: job stages / timeline / calendar link / settings list
node test_upgrade.js   # 17 checks: ships a fake next version and proves notes survive
```

Screenshots (`s*.png`) land in `tests/` and are gitignored.

---

## Status

### Done (2026-11-15)
- [x] Calendar month view with per-day notes, swipe to change month, Today button
- [x] Active jobs: add, rename, dated notes (add / edit / delete)
- [x] Recurring jobs: "Done, and start the next round" + "Show previous notes" toggle
- [x] Old jobs: list, search, start a new round, move back to active, delete
- [x] Password lock (hash only), recovery code, change password, auto-lock after 2 min in background
- [x] Backup: encrypted export (AES-GCM, optional password) via the iPhone share sheet, import with confirm
- [x] Backup reminder banner (never / older than 7 days)
- [x] Version-safety guards (schema/migrations, read-only on newer data, rescue copy, daily snapshot + undo)
- [x] Offline support (service worker, network-first)
- [x] Found and fixed a bug where lock then unlock wiped the open day's note (covered by a test)
- [x] Both test suites passing

- [x] v2 (2026-11-15): Month | Week switch. The month boxes were too small to show a
      busy day. Week view = 7 full-width rows, each line of a day's note shown
      as its own item. The tapped day's editor opens inside its row (the single
      `#dayPanel` element is moved; `parkPanel()` puts it back before any list
      is cleared). Mode remembered in `ct.calMode`. Week starts Sunday, like the grid.
- [x] Upgrade test now bumps whatever the current version is (no hardcoded v1/v2)
- [x] Deployed 2026-11-15: public repo AnonymouseCheese/calendar_track, Pages built,
      registered in GitHub Desktop, live-site smoke test passed (https, service worker active)

- [x] v5 (2026-11-15), all from user requests the same day:
      - Old jobs grouped by month (newest first, tap a heading to fold it). Each
        job has an optional `month` ('YYYY-MM') picked in the job screen. When
        a job is marked done it's filed under the picked month, or the current one.
      - The Today button greys out when tapping it would do nothing.
      - Week view opens with no day open. Each day has Edit / Done, and tapping
        the open day's heading closes it (state: `editing`).
      - Tick-off items: each line of a day note is an item. Done = the line
        starts with "✓ " (stored in the text itself, so it's PC/backup safe).
        Week rows show "N left / All done". The month box shows the first item
        still to do + "+N", and turns green when all are done. The month day
        panel shows the same tick list, with Edit for the text box.
      - Active jobs in the user's own order: `rank` (0 = top), drag by the ≡ grip
        on the left or right edge (pointer events). New jobs go on top, the next
        round keeps the same spot, and adding notes no longer reorders.
- [x] Bug fixed: a garbled CSS escape showed "BE" before the month names
      (the shell mangled backslashes). Write file content with the Write tool, not heredocs.

- [x] v6 (2026-11-15): job stages / timeline. The user said "not all jobs have the same
      process, your design, just easy to use", so:
      - A job starts with NO stages. Tap chips (from `data.stageLib`, defaulting
        to DEFAULT_STAGES in app.js) to add only the stages it needs. "+ New stage"
        adds a one-off name, which is remembered as a chip. Chips stay open until
        "Done adding".
      - Stages are kept in list order whatever order they're tapped in. Each stage can
        be moved up/down, renamed or removed via its Edit button.
      - Tap the circle to tick, which stamps `doneAt` = today (editable). Optional `due`
        date, red when late.
      - The Active job card shows "Next: X (due ..) · n/m" or "Late: ..." plus a progress bar.
      - Stage due dates (active jobs only) appear on the calendar as tickable items
        (diamond marker), synced both ways, and counted in "N left" / month boxes.
      - "Next round" copies the stage names, unticked and with no dates.
      - Settings > Job stages: add / remove / reorder the chip list.
      - Data: `job.stages[] = {id,name,done,doneAt,due}`, `data.stageLib[]`. Additive,
        so no SCHEMA bump was needed (older code keeps unknown fields).

### To do next
- [ ] User installs on iPhone: Safari > Share > Add to Home Screen, sets password, saves recovery code
- [ ] User does a first backup and test-restores it once

### Not done / ideas for later (only if the user asks)
- [ ] Sync with a PC (encrypted file sync). The data format is ready for it.
- [ ] Extra job fields (client, due date, price). The user asked for title + notes only for now.
- [ ] Real encryption of the stored data with the password (user chose the simple lock)
- [ ] Separate profiles for other people (for now each person uses their own phone)
- [ ] Not yet tried on a real iPhone (tested in Edge at iPhone size only)
