// Misc items (Jobs | Misc switch). Needs the app served on http://localhost:8765/
const puppeteer = require('puppeteer-core');
const path = require('path');

const URL = 'http://localhost:8765/';
let fails = 0;
function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  const vis = sel => page.$eval(sel, e => !e.hidden && !e.closest('[hidden]')).catch(() => false);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));
  const clickText = async (sel, text) => { await page.evaluate((s, t) => [...document.querySelectorAll(s)].filter(b => !b.closest('[hidden]')).find(b => b.textContent.trim().startsWith(t)).click(), sel, text); await wait(150); };
  const titles = sel => page.$$eval(sel + ' .card-title', t => t.map(x => x.textContent));
  const kind = k => clickText('.view:not([hidden]) .kind-seg button', k);
  const tomorrow = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.type('#setupPw1', 'ben'); await page.type('#setupPw2', 'ben');
  await page.click('#setupGo'); await wait(1500); await page.click('#codeDone'); await wait(200);
  await page.click('.tabs button[data-tab="active"]'); await wait(100);

  ok(await page.$eval('#view-active .kind-seg button.on', b => b.textContent) === 'Jobs', 'Active opens on Jobs');
  await page.type('#newJobTitle', 'Print job'); await page.click('#newJobGo'); await wait(150);
  await page.click('#jobBack'); await wait(100);

  await kind('Misc');
  ok((await page.$eval('#viewTitle', e => e.textContent)) === 'Active misc', 'title says Active misc');
  ok((await page.$eval('#newJobTitle', e => e.placeholder)) === 'New misc item', 'add box says New misc item');
  ok((await page.$$('#activeList .card')).length === 0 && await vis('#activeEmpty'), 'misc list starts empty (jobs not shown)');
  await page.type('#newJobTitle', 'Renew business licence'); await page.click('#newJobGo'); await wait(200);
  // misc stage chips start empty: only "+ New stage"
  const chips = await page.$$eval('#stageAdd .chip', c => c.map(x => x.textContent));
  ok(chips.length === 1 && chips[0] === '+ New stage', 'misc items start with no stage suggestions');
  await clickText('#stageAdd .chip', '+ New stage');
  await page.type('#stageNewName', 'Submit form'); await page.keyboard.press('Enter'); await wait(150);
  await clickText('#stageAdd .chip', '+ New stage');
  await page.type('#stageNewName', 'Pay fee'); await page.keyboard.press('Enter'); await wait(150);
  ok((await page.$$('#stages .stage')).length === 2, 'misc item has its own stages');
  // due date on misc stage -> calendar
  await page.evaluate(() => document.querySelectorAll('#stages .stage .st-more')[0].click()); await wait(120);
  await page.$eval('#stages .st-edit input[type="date"]', (e, v) => { e.value = v; e.dispatchEvent(new Event('change')); }, tomorrow); await wait(120);
  await page.click('#jobBack'); await wait(100);
  ok(JSON.stringify(await titles('#activeList')) === JSON.stringify(['Renew business licence']), 'misc list shows only misc');
  ok((await page.$eval('#activeList .card-stage', e => e.textContent)).startsWith('Next: Submit form'), 'misc card shows stage progress');
  let d = await stored();
  ok(d.jobs.find(j => j.title === 'Renew business licence').kind === 'misc' && !d.jobs.find(j => j.title === 'Print job').kind, 'kind saved');
  ok(JSON.stringify(d.miscStageLib) === JSON.stringify(['Submit form', 'Pay fee']) && !d.stageLib, 'misc names remembered separately from job stages');
  await page.screenshot({ path: path.join(__dirname, 's8_misc.png') });

  await kind('Jobs');
  ok(JSON.stringify(await titles('#activeList')) === JSON.stringify(['Print job']), 'jobs list shows only jobs');
  await page.click('#activeList .card'); await wait(150);
  const jobChips = await page.$$eval('#stageAdd .chip', c => c.map(x => x.textContent));
  ok(jobChips.includes('+ Printing') && !jobChips.includes('+ Pay fee'), 'job chips unaffected by misc names');
  await page.click('#jobBack'); await wait(100);

  // calendar shows the misc stage
  await page.click('.tabs button[data-tab="calendar"]'); await wait(100);
  await clickText('#calSeg button', 'Week');
  let onCal = await page.$$eval('#week .wk-row[data-key="' + tomorrow + '"] .check.jobstage .txt', e => e.map(x => x.textContent)).catch(() => []);
  if (!onCal.length) { await page.click('#mNext'); await wait(120); onCal = await page.$$eval('#week .wk-row[data-key="' + tomorrow + '"] .check.jobstage .txt', e => e.map(x => x.textContent)); }
  ok(onCal.includes('Renew business licence: Pay fee'), 'misc stage due date on calendar');
  ok(await page.$eval('#calSeg button.on', b => b.textContent) === 'Week', 'calendar switch still works');

  // done -> Old misc, not Old jobs
  await page.click('.tabs button[data-tab="active"]'); await wait(100);
  ok(await page.$eval('#view-active .kind-seg button.on', b => b.textContent) === 'Jobs', 'switch remembered (Jobs)');
  await kind('Misc');
  await page.click('#activeList .card'); await wait(150);
  ok(JSON.stringify(await page.$$eval('#jobActions button', b => b.map(x => x.textContent))) === JSON.stringify(['Mark as done (move to Old misc)', 'Done, and start the next round', 'Delete this item']), 'misc item buttons say item / misc');
  await clickText('#jobActions button', 'Mark as done');
  ok((await page.$eval('#toast', e => e.textContent)) === 'Moved to Old misc', 'message says Old misc');
  await page.click('.tabs button[data-tab="old"]'); await wait(100);
  ok(await page.$eval('#view-old .kind-seg button.on', b => b.textContent) === 'Misc', 'Old tab follows the same switch');
  ok((await page.$eval('#viewTitle', e => e.textContent)) === 'Old misc', 'title says Old misc');
  ok(JSON.stringify(await titles('#oldList')) === JSON.stringify(['Renew business licence']), 'done misc item in Old misc');
  await kind('Jobs');
  ok((await page.$$('#oldList .card')).length === 0 && (await page.$eval('#oldEmpty', e => e.textContent)).startsWith('No old jobs'), 'not in Old jobs');
  await kind('Misc');

  // bin wording
  await page.click('#oldList .card'); await wait(150);
  ok(JSON.stringify(await page.$$eval('#jobActions button', b => b.map(x => x.textContent))) === JSON.stringify(['Start a new round of this item', 'Move back to Active misc', 'Delete this item']), 'old misc item buttons say item / misc');
  await clickText('#jobActions button', 'Delete this item');
  await page.click('#binOpen'); await wait(150);
  ok((await page.$eval('#binList .card-meta', e => e.textContent)).includes('Was in Old misc'), 'bin says Old misc');
  await clickText('#binList button', 'Restore');
  await page.click('#binBack'); await wait(100);
  ok((await titles('#oldList')).length === 1, 'restored back to Old misc');

  // settings shows both stage lists
  await page.click('#btnSettings'); await wait(150);
  const miscLib = await page.$$eval('#miscLibList .lib-row span', e => e.map(x => x.textContent));
  ok(JSON.stringify(miscLib) === JSON.stringify(['Submit form', 'Pay fee']), 'settings: misc stages list');
  await page.type('#miscLibNew', 'Follow up'); await page.click('#miscLibAdd'); await wait(100);
  ok((await stored()).miscStageLib.includes('Follow up'), 'add misc stage in settings');
  ok((await page.$$('#libList .lib-row')).length === 8, 'job stages list unchanged');
  await page.click('#setBack'); await wait(100);

  // reload: kind switch remembered
  await page.reload({ waitUntil: 'networkidle0' });
  await wait(1000);
  ok(await vis('#app'), 'reopening within 4 hours skips the password');
  await page.click('.tabs button[data-tab="active"]'); await wait(100);
  ok(await page.$eval('#view-active .kind-seg button.on', b => b.textContent) === 'Misc', 'Misc remembered after reopening');

  ok(errors.length === 0, 'no errors ' + errors.join(' | '));
  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
