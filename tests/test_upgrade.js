// Simulates shipping a new version: serve a copy, add notes, change the code
// (new ?v=, new cache name), reload like a phone would, and check nothing was lost.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..');
const COPY = path.join(__dirname, 'site');
const URL = 'http://localhost:8766/';
let fails = 0;
function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
const wait = ms => new Promise(r => setTimeout(r, ms));

fs.rmSync(COPY, { recursive: true, force: true });
// Copy only the app's own files (not .git or this tests folder).
fs.mkdirSync(COPY);
for (const f of fs.readdirSync(SRC)) {
  if (f === 'tests' || f.startsWith('.')) continue;
  fs.cpSync(path.join(SRC, f), path.join(COPY, f), { recursive: true });
}

(async () => {
  const server = spawn('python', ['-m', 'http.server', '8766', '--bind', '127.0.0.1'], { cwd: COPY, stdio: 'ignore' });
  await wait(1200);
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const vis = sel => page.$eval(sel, e => !e.hidden && !e.closest('[hidden]')).catch(() => false);
  const unlock = async () => { await page.type('#unlockPw', 'ben'); await page.click('#unlockGo'); await wait(1200); };

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.type('#setupPw1', 'ben'); await page.type('#setupPw2', 'ben');
  await page.click('#setupGo'); await wait(1500); await page.click('#codeDone'); await wait(200);
  await page.type('#dayNote', 'Version 1 note'); await wait(900);
  await page.click('.tabs button[data-tab="active"]');
  await page.type('#newJobTitle', 'Job from v1'); await page.click('#newJobGo'); await wait(200);
  await page.type('#noteNew', 'note from v1'); await page.click('#noteAdd'); await wait(200);
  await page.click('#jobBack');
  const before = await page.evaluate(() => localStorage.getItem('ct.data'));
  const lockBefore = await page.evaluate(() => localStorage.getItem('ct.lock'));
  ok(before.includes('Version 1 note') && before.includes('note from v1'), 'v1 data saved');

  // --- ship "version 2" ---
  // Bump whatever version is current (N) to N+1, exactly as a real release does.
  const cur = +fs.readFileSync(path.join(COPY, 'sw.js'), 'utf8').match(/'ct-v(\d+)'/)[1], nxt = cur + 1;
  const bump = t => t.split('?v=' + cur + '"').join('?v=' + nxt + '"').split('?v=' + cur + "'").join('?v=' + nxt + "'");
  let html = bump(fs.readFileSync(path.join(COPY, 'index.html'), 'utf8')).replace('<title>Calendar Track</title>', '<title>Calendar Track next</title>');
  fs.writeFileSync(path.join(COPY, 'index.html'), html);
  let sw = bump(fs.readFileSync(path.join(COPY, 'sw.js'), 'utf8').replace("'ct-v" + cur + "'", "'ct-v" + nxt + "'"));
  fs.writeFileSync(path.join(COPY, 'sw.js'), sw);

  await page.reload({ waitUntil: 'networkidle0' }); await wait(1500);
  await page.reload({ waitUntil: 'networkidle0' }); await wait(1000);
  ok((await page.title()) === 'Calendar Track next', 'new version is live after reload');
  const caches = await page.evaluate(() => caches.keys());
  ok(caches.includes('ct-v' + nxt) && !caches.includes('ct-v' + cur), 'old code cache replaced: ' + caches.join(','));
  ok(await vis('#lock-unlock'), 'still asks for the SAME password (not setup again)');
  await unlock();
  ok(await vis('#app'), 'old password works on new version');
  const after = await page.evaluate(() => localStorage.getItem('ct.data'));
  ok(after.includes('Version 1 note') && after.includes('note from v1'), 'all notes survived the update');
  ok((await page.evaluate(() => localStorage.getItem('ct.lock'))) === lockBefore, 'password record untouched');
  ok(await page.evaluate(() => !!localStorage.getItem('ct.snapshot')), 'daily safety copy exists');

  // --- unknown future fields are kept ---
  await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('ct.data'));
    d.futureThing = { keep: true }; d.jobs[0].colour = 'red'; d.jobs[0].notes[0].pinned = true;
    localStorage.setItem('ct.data', JSON.stringify(d));
  });
  await page.click('#btnLock'); await unlock();
  await page.click('.tabs button[data-tab="calendar"]');
  await page.click('#dayNote'); await page.type('#dayNote', ' edited'); await wait(900);
  let d = await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));
  ok(d.futureThing && d.futureThing.keep && d.jobs[0].colour === 'red' && d.jobs[0].notes[0].pinned === true, 'fields from newer versions are not stripped on save');

  // --- data from a NEWER version opened by older code: read-only, never overwritten ---
  await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('ct.data')); d.schema = 99; localStorage.setItem('ct.data', JSON.stringify(d)); });
  const newer = await page.evaluate(() => localStorage.getItem('ct.data'));
  await page.click('#btnLock'); await unlock();
  ok((await page.$eval('#backupBanner', e => e.textContent)).includes('older than your notes'), 'warns that the app copy is older');
  ok(await page.$eval('#dayNote', e => e.readOnly), 'editing switched off');
  await page.click('.tabs button[data-tab="active"]');
  await page.type('#newJobTitle', 'should not save'); await page.click('#newJobGo'); await wait(300);
  ok((await page.evaluate(() => localStorage.getItem('ct.data'))) === newer, 'newer data left exactly as it was');
  await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('ct.data')); d.schema = 1; localStorage.setItem('ct.data', JSON.stringify(d)); });

  // --- corrupted data: kept aside, not destroyed ---
  await page.evaluate(() => localStorage.setItem('ct.data', '{broken'));
  await page.click('#btnLock'); await unlock();
  const rescue = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ct.rescue.')).map(k => localStorage.getItem(k)));
  ok(rescue.length === 1 && rescue[0] === '{broken', 'unreadable data kept in a rescue copy');
  ok(dialogs.some(m => m.includes("couldn't be read")), 'user told about it');

  // --- undo to daily copy ---
  await page.click('#btnSettings'); await wait(200);
  ok(await vis('#snapGo'), 'undo button shown');
  await page.click('#snapGo'); await wait(300);
  d = await page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));
  ok(JSON.stringify(d).includes('Version 1 note'), 'undo brings notes back from the daily copy');

  ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await browser.close();
  server.kill();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
