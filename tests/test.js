const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const URL = 'http://localhost:8765/';
const OUT = __dirname;
let fails = 0;
function ok(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; }
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--no-first-run']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [], offsite = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => { if (!r.url().startsWith(URL) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) offsite.push(r.url()); });
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });

  // Stub the share sheet so we can capture the backup file.
  await page.evaluateOnNewDocument(() => {
    navigator.canShare = () => true;
    navigator.share = async (o) => { window.__shared = { name: o.files[0].name, text: await o.files[0].text() }; };
  });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  const vis = sel => page.$eval(sel, e => !e.hidden && !e.closest('[hidden]')).catch(() => false);
  const click = async sel => { await page.click(sel); await wait(150); };
  const type = async (sel, t) => { await page.click(sel, { clickCount: 3 }); await page.type(sel, t); };

  // 1. setup
  ok(await vis('#lock-setup'), 'first open shows Create password');
  await type('#setupPw1', 'ben'); await type('#setupPw2', 'bex');
  await click('#setupGo'); await wait(600);
  ok((await page.$eval('#setupErr', e => e.textContent)).includes("don't match"), 'mismatched passwords rejected');
  await type('#setupPw2', 'ben');
  await click('#setupGo'); await wait(1500);
  ok(await vis('#lock-code'), 'recovery code shown');
  const code = await page.$eval('#codeShow', e => e.textContent);
  ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), 'recovery code format ' + code);
  const lockRec = await page.evaluate(() => localStorage.getItem('ct.lock'));
  ok(!lockRec.includes('ben') && !lockRec.includes(code), 'password and code not stored in plain text');
  await page.screenshot({ path: path.join(OUT, 's0_code.png') });
  await click('#codeDone');
  ok(await vis('#app'), 'app visible after setup');

  // 2. calendar
  const todayKey = await page.evaluate(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); });
  ok(await page.$('.cell.today.sel') !== null, 'today highlighted and selected');
  await page.click('#dayNote'); await page.type('#dayNote', 'Dentist 3pm\nBring forms');
  await wait(900);
  let stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));
  ok(stored.days[todayKey] === 'Dentist 3pm\nBring forms', 'day note autosaved');
  ok(await page.$eval('.cell.today', e => e.classList.contains('has') && e.querySelector('.snip').textContent === 'Dentist 3pm'), 'cell shows snippet');
  // another day in the grid
  const otherKey = await page.$$eval('.cell:not(.other)', cs => cs[3].dataset.key);
  await page.click('.cell[data-key="' + otherKey + '"]'); await wait(150);
  ok((await page.$eval('#dayNote', e => e.value)) === '', 'switching day shows empty note');
  await page.type('#dayNote', 'Pay rent');
  await click('#mNext'); // should flush
  ok(!(await page.$eval('#btnToday', b => b.disabled)), 'Today active when viewing another month');
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));
  ok(stored.days[otherKey] === 'Pay rent', 'note saved when changing month');
  await click('#mPrev');
  await click('#btnToday');
  await page.screenshot({ path: path.join(OUT, 's1_calendar.png') });
  ok(await page.$eval('#btnToday', b => b.disabled), 'Today greyed out in month view when today is selected');

  ok(await vis('#dayChecks') && !(await vis('#dayNote')), 'month view: day with items shows a tick list, not the text box');
  ok((await page.$$('#dayChecks .check')).length === 2, 'month tick list has both items');

  // 2b. week view (opens with no day open, every day a tick list)
  await click('.seg button[data-mode="week"]');
  ok(await vis('#week') && !(await vis('#grid')), 'week view replaces month grid');
  ok((await page.$$('#week .wk-row')).length === 7, 'week shows 7 days');
  ok((await page.$$('#week .wk-row.sel')).length === 0 && !(await vis('#dayPanel')), 'week opens with no day open');
  ok((await page.$$('#week .wk-row.today .check')).length === 2, 'today shows its items as tick boxes');
  ok((await page.$eval('#week .wk-row.today .left', e => e.textContent)) === '2 left', 'today says 2 left');
  ok(!(await page.$eval('#btnToday', b => b.disabled)), 'Today active while nothing is open');
  // open today with its Edit button and add more lines
  await page.evaluate(() => document.querySelector('#week .wk-row.today .wk-btn').click()); await wait(150);
  ok(await page.$eval('#week .wk-row.sel', r => r.classList.contains('today') && !!r.querySelector('#dayNote')), 'Edit opens the text box inside the row');
  ok(await page.$eval('#btnToday', b => b.disabled), 'Today greyed out in week view when today is open');
  await page.click('#dayNote');
  await page.$eval('#dayNote', t => { t.setSelectionRange(t.value.length, t.value.length); });
  await page.type('#dayNote', '\nCall printer re: mailer\n\nTeam lunch\nPick up banner');
  const otherRow = await page.$$eval('#week .wk-row:not(.sel)', rs => rs[0].dataset.key);
  await page.click('#week .wk-row[data-key="' + otherRow + '"] .wk-empty'); await wait(150);
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));
  ok(stored.days[todayKey] === 'Dentist 3pm\nBring forms\nCall printer re: mailer\n\nTeam lunch\nPick up banner', 'week edit saved when tapping another day');
  const items = await page.$$eval('#week .wk-row.today .check .txt', ls => ls.map(l => l.textContent));
  ok(items.length === 5 && items[2] === 'Call printer re: mailer', 'every line is its own item (blank lines skipped): ' + items.length);
  ok(await page.$eval('#week .wk-row[data-key="' + otherRow + '"]', r => r.classList.contains('sel') && !!r.querySelector('#dayNote')), 'text box moved to the tapped day');
  ok(!(await page.$eval('#btnToday', b => b.disabled)), 'Today active when another day is open');
  await page.evaluate(() => document.querySelector('#week .wk-row.sel .wk-btn').click()); await wait(150);
  ok((await page.$$('#week .wk-row.sel')).length === 0 && !(await vis('#dayPanel')), 'Done closes the day: nothing open');
  ok((await page.$$eval('#week .wk-empty', e => e.length)) >= 5, 'empty days say Nothing');

  // ticking
  const tick = async (sel, i) => { await page.evaluate((s, n) => document.querySelectorAll(s)[n].querySelector('.box').click(), sel, i); await wait(120); };
  await tick('#week .wk-row.today .check', 0);
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));
  ok(stored.days[todayKey].split('\n')[0] === '✓ Dentist 3pm', 'ticking saves a check mark on that line');
  ok(await page.$eval('#week .wk-row.today .check', e => e.classList.contains('done')), 'ticked item shown as done');
  ok((await page.$eval('#week .wk-row.today .left', e => e.textContent)) === '4 left', 'count drops to 4 left');
  ok((await page.$$('#week .wk-row.sel')).length === 0, 'ticking does not open the day');
  for (const i of [1, 2, 3, 4]) await tick('#week .wk-row.today .check', i);
  ok((await page.$eval('#week .wk-row.today .left', e => e.textContent)) === 'All done', 'all ticked says All done');
  await tick('#week .wk-row.today .check', 4);
  ok((await page.$eval('#week .wk-row.today .left', e => e.textContent)) === '1 left', 'untick brings it back: 1 left');
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));
  ok(stored.days[todayKey].split('\n')[5] === 'Pick up banner', 'untick removes the check mark');
  // tapping the text does not tick; Undo reverses a tick
  const beforeTap = (await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')))).days[todayKey];
  await page.evaluate(() => document.querySelector('#week .wk-row.today .check .txt').click()); await wait(150);
  ok((await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')))).days[todayKey] === beforeTap, 'tapping the item text does not tick it');
  if ((await page.$$('#week .wk-row.sel')).length) { await page.evaluate(() => document.querySelector('#week .wk-row.sel .wk-btn').click()); await wait(150); }
  await tick('#week .wk-row.today .check', 4);
  ok(await vis('#toast') && (await page.$eval('#toast', t => t.textContent)).includes('Ticked: Pick up banner'), 'tick shows a message with Undo');
  await page.click('#toast .toast-undo'); await wait(150);
  ok((await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')))).days[todayKey] === beforeTap, 'Undo puts it back');
  await page.screenshot({ path: path.join(OUT, 's1b_week.png'), fullPage: true });

  const wkLabel = await page.$eval('#mLabel', e => e.textContent);
  await click('#mNext');
  ok((await page.$eval('#mLabel', e => e.textContent)) !== wkLabel && (await page.$$('#week .wk-row')).length === 7, 'arrow moves a week');
  await click('#mPrev');
  ok((await page.$eval('#mLabel', e => e.textContent)) === wkLabel, 'back arrow returns');
  await click('#btnToday');
  ok(await page.$eval('#week .wk-row.sel', r => r.classList.contains('today')), 'Today button opens today');
  await page.click('#week .wk-row.sel .wk-date'); await wait(150);
  ok((await page.$$('#week .wk-row.sel')).length === 0, 'tapping the open day heading closes it');
  const todayNote = (await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')))).days[todayKey];
  // lock / unlock keeps week view and the note
  await click('#btnLock');
  ok(await page.$('#dayPanel') !== null, 'day editor not destroyed by lock');
  await type('#unlockPw', 'ben'); await click('#unlockGo'); await wait(1000);
  ok(await vis('#week') && (await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')))).days[todayKey] === todayNote, 'after unlock: still week view, note intact');

  // month view shows the same ticks
  await click('.seg button[data-mode="month"]');
  ok(await vis('#grid') && await page.$eval('#dayPanel', p => !p.closest('#week')), 'month view puts the day panel back under the grid');
  await page.click('.cell.today'); await wait(150);
  ok((await page.$eval('.cell.today .snip', e => e.textContent)) === 'Pick up banner' && !(await page.$('.cell.today .more')), 'month box shows the one item still to do');
  ok((await page.$$('#dayChecks .check.done')).length === 4, 'month day list shows the same ticks');
  await tick('#dayChecks .check', 4);
  ok(await page.$eval('.cell.today', e => e.classList.contains('alldone') && e.querySelector('.snip').textContent === '✓ done'), 'ticking in month view turns the box green');
  await tick('#dayChecks .check', 0);
  await tick('#dayChecks .check', 1);
  ok((await page.$eval('.cell.today .snip', e => e.textContent)) === 'Dentist 3pm' && (await page.$eval('.cell.today .more', e => e.textContent)) === '+1', 'box shows first item to do and +1');
  await page.screenshot({ path: path.join(OUT, 's1d_month_ticks.png') });
  await click('#dayEdit');
  ok(await vis('#dayNote') && !(await vis('#dayChecks')) && await vis('#dayDone'), 'Edit shows the text box with Done');
  ok((await page.$eval('#dayNote', t => t.value)).startsWith('Dentist 3pm\nBring forms\n✓ Call printer'), 'ticks visible as check marks in the text');
  await click('#dayDone');
  ok(await vis('#dayChecks') && !(await vis('#dayNote')), 'Done goes back to the tick list');
  const todayNoteFinal = (await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')))).days[todayKey];

  // 3. jobs
  await click('.tabs button[data-tab="active"]');
  ok(await vis('#activeEmpty'), 'empty active message');
  await type('#newJobTitle', 'Monthly mailer - client A');
  await click('#newJobGo');
  ok(await vis('#sheet-job'), 'new job opens detail');
  ok(!(await vis('#prevWrap')), 'no previous-notes toggle on first round');
  await page.type('#noteNew', 'Used 120gsm paper, 5000 pcs');
  await click('#noteAdd');
  await page.type('#noteNew', 'Client wants proof by Tue');
  await click('#noteAdd');
  ok((await page.$$('#jobNotes .note')).length === 2, 'two notes added');
  ok((await page.$eval('#jobNotes .note .note-text', e => e.textContent)) === 'Client wants proof by Tue', 'newest note first');
  // edit a note
  await page.evaluate(() => [...document.querySelectorAll('#jobNotes button')].find(b => b.textContent === 'Edit').click());
  await wait(100);
  await page.$eval('#jobNotes textarea', t => { t.value = 'Client wants proof by Wed'; });
  await page.evaluate(() => [...document.querySelectorAll('#jobNotes button')].find(b => b.textContent === 'Save').click());
  await wait(100);
  ok((await page.$eval('#jobNotes .note .note-text', e => e.textContent)) === 'Client wants proof by Wed', 'note edited');
  // editing a long note: the box is big enough to show all of it
  await page.evaluate(() => [...document.querySelectorAll('#jobNotes button')].find(b => b.textContent === 'Edit').click());
  await wait(150);
  const fits = await page.$eval('#jobNotes textarea', t => { t.value = 'line\n'.repeat(14) + 'end'; t.dispatchEvent(new Event('input')); return { h: t.clientHeight, need: t.scrollHeight }; });
  ok(fits.h >= fits.need - 2, 'edit box grows to fit a long note (' + fits.h + 'px for ' + fits.need + 'px)');
  const short = await page.$eval('#jobNotes textarea', t => { t.value = 'x'; t.dispatchEvent(new Event('input')); return t.clientHeight; });
  ok(short >= 150, 'edit box is never small (' + short + 'px)');
  await page.evaluate(() => [...document.querySelectorAll('#jobNotes button')].find(b => b.textContent === 'Cancel').click());
  await wait(100);
  // rename
  await type('#jobTitle', 'Monthly mailer');
  await page.keyboard.press('Enter'); await wait(100);
  // done & next round
  await page.evaluate(() => [...document.querySelectorAll('#jobActions button')].find(b => b.textContent.startsWith('Done, and')).click());
  await wait(300);
  ok(await vis('#prevWrap'), 'round 2 shows previous-notes toggle');
  ok((await page.$eval('#prevLabel', e => e.textContent)) === 'Show previous notes (2)', 'toggle label counts 2');
  ok(!(await vis('#prevNotes')), 'previous notes hidden until toggled');
  await click('#prevToggle');
  ok(await vis('#prevNotes'), 'toggle reveals previous notes');
  ok((await page.$$('#prevNotes .note')).length === 2, 'both previous notes listed');
  ok((await page.$eval('#jobMeta', e => e.textContent)).includes('round 2 of 2'), 'meta shows round 2 of 2');
  await page.type('#noteNew', 'Round 2: same spec');
  await click('#noteAdd');
  await page.screenshot({ path: path.join(OUT, 's2_job.png'), fullPage: true });
  await click('#jobBack');
  ok((await page.$$('#activeList .card')).length === 1, 'one active job in list');
  ok((await page.$eval('#activeList .card-title', e => e.textContent)) === 'Monthly mailer', 'renamed title carried to round 2');

  // second, simple job; mark done
  await type('#newJobTitle', 'Banner reprint');
  await click('#newJobGo');
  await page.evaluate(() => [...document.querySelectorAll('#jobActions button')].find(b => b.textContent.startsWith('Mark as done')).click());
  await wait(200);
  ok(!(await vis('#sheet-job')), 'mark done closes detail');
  ok((await page.$eval('#toast', e => e.textContent)) === 'Moved to Old jobs', 'jobs still say Old jobs');

  // 4. old jobs
  await click('.tabs button[data-tab="old"]');
  ok((await page.$$('#oldList .card')).length === 2, 'two old jobs');
  await page.type('#oldSearch', '120gsm'); await wait(100);
  ok((await page.$$('#oldList .card')).length === 1, 'search matches note text');
  await type('#oldSearch', 'zzz'); await wait(100);
  ok(await vis('#oldEmpty'), 'no-match message');
  await page.$eval('#oldSearch', e => { e.value = ''; e.dispatchEvent(new Event('input')); });
  await page.screenshot({ path: path.join(OUT, 's3_old.png') });
  // open old mailer round 1 -> should show "other rounds"
  await page.evaluate(() => [...document.querySelectorAll('#oldList .card')].find(c => c.textContent.includes('Monthly mailer')).click());
  await wait(150);
  ok((await page.$eval('#prevLabel', e => e.textContent)).startsWith('Show notes from other rounds (1)'), 'old round sees other rounds');
  await click('#jobBack');

  // 4b. old jobs grouped by month; month can be chosen
  const heads = () => page.$$eval('#oldList .month-head .month-name', h => h.map(x => x.textContent));
  const nowLabel = await page.evaluate(() => ['January','February','March','April','May','June','July','August','September','October','November','December'][new Date().getMonth()] + ' ' + new Date().getFullYear());
  let hs = await heads();
  ok(hs.length === 1 && hs[0] === nowLabel, 'old jobs grouped under the month they were done: ' + hs);
  await page.evaluate(() => [...document.querySelectorAll('#oldList .card')].find(c => c.textContent.includes('Banner reprint')).click()); await wait(150);
  ok(await vis('#jobMonth'), 'month picker on old job');
  await page.$eval('#jobMonth', e => { e.value = '2026-09'; e.dispatchEvent(new Event('change')); }); await wait(100);
  ok((await page.$eval('#monthHint', e => e.textContent)).includes('September 2026'), 'hint names the new month');
  await click('#jobBack');
  hs = await heads();
  ok(JSON.stringify(hs) === JSON.stringify([nowLabel, 'September 2026']), 'moved job listed under September, newest month first: ' + hs);
  await page.click('#oldList .month-head[data-month="2026-09"]'); await wait(100);
  ok((await page.$$('#oldList .card')).length === 1, 'tapping a month heading folds it away');
  await page.click('#oldList .month-head[data-month="2026-09"]'); await wait(100);
  ok((await page.$$('#oldList .card')).length === 2, 'tapping again opens it');
  await click('.tabs button[data-tab="active"]');
  await page.click('#activeList .card'); await wait(150);
  ok((await page.$eval('#jobMonth', e => e.value)) === '', 'active job has no month until you pick one');
  await page.$eval('#jobMonth', e => { e.value = '2026-12'; e.dispatchEvent(new Event('change')); }); await wait(100);
  ok((await page.$eval('#monthHint', e => e.textContent)).includes('December 2026'), 'active job hint names the chosen month');
  await page.evaluate(() => [...document.querySelectorAll('#jobActions button')].find(b => b.textContent.startsWith('Mark as done')).click()); await wait(200);
  await click('.tabs button[data-tab="old"]');
  hs = await heads();
  ok(JSON.stringify(hs) === JSON.stringify(['December 2026', nowLabel, 'September 2026']), 'finished job filed under the chosen month: ' + hs);
  await page.screenshot({ path: path.join(OUT, 's3b_old_months.png'), fullPage: true });
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));
  ok(stored.jobs.find(j => j.title === 'Banner reprint').month === '2026-09', 'chosen month saved in the data');

  // 5. lock / unlock
  await click('#btnLock');
  ok(await vis('#lock-unlock'), 'locked');
  ok((await page.$eval('#grid', e => e.children.length)) === 0, 'private content cleared while locked');
  await type('#unlockPw', 'nope'); await click('#unlockGo'); await wait(800);
  ok((await page.$eval('#unlockErr', e => e.textContent)) === 'Wrong password.', 'wrong password rejected');
  await type('#unlockPw', 'ben'); await page.keyboard.press('Enter'); await wait(800);
  ok(await vis('#app'), 'right password unlocks (Enter key)');

  // 6. forgot password
  await click('#btnLock');
  await click('#forgotGo');
  await type('#forgotCode', 'AAAA-BBBB-CCCC'); await type('#forgotPw1', 'new1'); await type('#forgotPw2', 'new1');
  await click('#forgotSet'); await wait(800);
  ok((await page.$eval('#forgotErr', e => e.textContent)).includes("isn't right"), 'bad recovery code rejected');
  await type('#forgotCode', code.toLowerCase().replace(/-/g, ' '));
  await click('#forgotSet'); await wait(1200);
  ok(await vis('#app'), 'recovery code resets password (case/spacing tolerant)');
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));
  ok(stored.jobs.length === 3 && Object.keys(stored.days).length === 2, 'data intact after reset');
  await click('#btnLock');
  await type('#unlockPw', 'new1'); await click('#unlockGo'); await wait(800);
  ok(await vis('#app'), 'new password works');

  // 7. backup banner + export
  ok(await vis('#backupBanner'), 'backup banner shows when never backed up');
  await click('#backupBanner');
  ok(await vis('#sheet-settings'), 'banner opens settings');
  await page.type('#exportPw', 'filepw');
  await click('#exportGo'); await wait(2000);
  const shared = await page.evaluate(() => window.__shared);
  ok(shared && /^calendar_track_backup_\d{4}-\d{2}-\d{2}\.json$/.test(shared.name), 'backup file shared: ' + (shared && shared.name));
  ok(shared && !shared.text.includes('Dentist') && JSON.parse(shared.text).encrypted === true, 'backup file is encrypted');
  ok((await page.$eval('#backupInfo', e => e.textContent)).includes('today'), 'last backup recorded');
  fs.writeFileSync(path.join(OUT, 'backup.json'), shared.text);

  // 8. wipe data, then import
  await page.evaluate(() => localStorage.setItem('ct.data', JSON.stringify({ schema: 1, days: { '2020-01-01': 'x' }, jobs: [] })));
  const input = await page.$('#importFile');
  await input.uploadFile(path.join(OUT, 'backup.json'));
  await wait(500);
  ok(await vis('#importPwWrap'), 'asks for backup password');
  await page.type('#importPw', 'wrong'); await click('#importOpen'); await wait(2000);
  ok((await page.$eval('#importErr', e => e.textContent)).includes('Wrong password'), 'wrong backup password rejected');
  await type('#importPw', 'filepw'); await click('#importOpen'); await wait(2000);
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));
  ok(stored.jobs.length === 3 && stored.days[todayKey] === todayNoteFinal, 'import restored everything');
  ok(dialogs.some(d => d.startsWith('Replace everything')), 'import asked to confirm');

  // non-backup file
  fs.writeFileSync(path.join(OUT, 'junk.json'), '{"hello":1}');
  await input.uploadFile(path.join(OUT, 'junk.json')); await wait(400);
  ok(dialogs.some(d => d.includes("isn't a Calendar Track backup")), 'junk file rejected');

  // unencrypted export
  await page.evaluate(() => { window.__shared = null; });
  await page.$eval('#exportPw', e => { e.value = ''; });
  await click('#exportGo'); await wait(800);
  const plain = await page.evaluate(() => window.__shared);
  ok(plain && JSON.parse(plain.text).data.jobs.length === 3, 'unprotected export works after confirm');
  await page.screenshot({ path: path.join(OUT, 's4_settings.png'), fullPage: true });
  await click('#setBack');

  // XSS check: note with HTML is shown as text
  await click('.tabs button[data-tab="calendar"]');
  await click('#dayEdit');
  await page.click('#dayNote', { clickCount: 3 });
  await page.$eval('#dayNote', t => { t.value = '<img src=x onerror=alert(1)>'; t.dispatchEvent(new Event('input')); });
  await wait(800);
  ok((await page.$$('.cell img')).length === 0, 'HTML in notes is not run');

  // 9. offline reload (service worker)
  await page.reload({ waitUntil: 'networkidle0' });
  await wait(1000);
  const swOk = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  ok(swOk, 'service worker controls the page');
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded' }); await wait(5000);
  ok(await vis('#app'), 'app opens offline (still unlocked)');
  await page.setOfflineMode(false);

  ok(offsite.length === 0, 'no requests to other sites ' + offsite.join(','));
  const realErrors = errors.filter(e => !e.includes('ERR_INTERNET_DISCONNECTED') && !e.includes('Failed to fetch') && !e.includes('timeout'));
  ok(realErrors.length === 0, 'no console errors ' + realErrors.join(' | '));

  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
