// Recycle bin for deleted jobs. Needs the app served on http://localhost:8765/
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
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  const vis = sel => page.$eval(sel, e => !e.hidden && !e.closest('[hidden]')).catch(() => false);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));
  const clickText = async (sel, text) => { await page.evaluate((s, t) => [...document.querySelectorAll(s)].find(b => b.textContent.trim().startsWith(t)).click(), sel, text); await wait(150); };
  const activeTitles = () => page.$$eval('#activeList .card-title', t => t.map(x => x.textContent));

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.type('#setupPw1', 'ben'); await page.type('#setupPw2', 'ben');
  await page.click('#setupGo'); await wait(1500); await page.click('#codeDone'); await wait(200);
  await page.click('.tabs button[data-tab="active"]'); await wait(100);

  // a job with notes and stages
  await page.type('#newJobTitle', 'Precious job'); await page.click('#newJobGo'); await wait(200);
  await clickText('#stageAdd .chip', '+ Quotation');
  await clickText('#stageAdd .chip', '+ Printing');
  await page.evaluate(() => [...document.querySelectorAll('#stages .stage .st-dot')].pop().click()); await wait(120); // Quotation, at the bottom
  await page.type('#noteNew', 'Important note 1'); await page.click('#noteAdd'); await wait(100);
  await page.type('#noteNew', 'Important note 2'); await page.click('#noteAdd'); await wait(100);
  await page.click('#jobBack'); await wait(100);
  await page.type('#newJobTitle', 'Other job'); await page.click('#newJobGo'); await wait(200);
  await page.click('#jobBack'); await wait(100);
  const original = (await stored()).jobs.find(j => j.title === 'Precious job');

  // delete: no "can't be undone" prompt, goes to the bin, Undo offered
  await page.evaluate(() => [...document.querySelectorAll('#activeList .card')].find(c => c.textContent.includes('Precious job')).click()); await wait(150);
  await clickText('#jobActions button', 'Delete this job');
  ok(!dialogs.some(d => d.includes("can't be undone")), 'deleting does not need a scary confirm');
  let d = await stored();
  ok(!d.jobs.some(j => j.title === 'Precious job') && d.bin.length === 1, 'deleted job moved to the bin');
  ok((await page.$eval('#toast', t => t.textContent)).includes('recycle bin'), 'message says recycle bin');
  await page.click('#toast .toast-undo'); await wait(150);
  d = await stored();
  ok(d.jobs.some(j => j.title === 'Precious job') && d.bin.length === 0, 'Undo brings it straight back');
  ok((await activeTitles())[0] === 'Precious job', 'restored job is back in Active jobs');

  // delete again, restore from the bin (via Old jobs link)
  await page.evaluate(() => [...document.querySelectorAll('#activeList .card')].find(c => c.textContent.includes('Precious job')).click()); await wait(150);
  await clickText('#jobActions button', 'Delete this job');
  await page.click('.tabs button[data-tab="old"]'); await wait(100);
  ok(await vis('#binOpen') && (await page.$eval('#binOpen', b => b.textContent)) === 'Recycle bin (1)', 'Old jobs shows a Recycle bin (1) link');
  await page.click('#binOpen'); await wait(150);
  ok(await vis('#sheet-bin'), 'recycle bin opens');
  const meta = await page.$eval('#binList .bin-card .card-meta', e => e.textContent);
  ok(meta.includes('Was in Active jobs') && meta.includes('2 notes') && meta.includes('2 stages'), 'bin shows where it was, notes and stages: ' + meta);
  await page.screenshot({ path: path.join(__dirname, 's7_bin.png') });
  await clickText('#binList button', 'Restore');
  ok(await vis('#binEmpty'), 'bin empty after restore');
  d = await stored();
  const back = d.jobs.find(j => j.title === 'Precious job');
  ok(back && back.notes.length === 2 && back.notes.map(n => n.text).sort().join('|') === 'Important note 1|Important note 2', 'notes restored');
  ok(back.stages.length === 2 && back.stages[0].done && back.stages[0].doneAt === original.stages[0].doneAt, 'stages restored with ticks and dates');
  ok(back.id === original.id && back.seriesId === original.seriesId && back.created === original.created, 'same job, not a copy');
  await page.click('#binBack'); await wait(100);

  // an old job goes back to Old jobs
  await page.click('.tabs button[data-tab="active"]'); await wait(100);
  await page.evaluate(() => [...document.querySelectorAll('#activeList .card')].find(c => c.textContent.includes('Other job')).click()); await wait(150);
  await clickText('#jobActions button', 'Mark as done');
  await page.click('.tabs button[data-tab="old"]'); await wait(100);
  await page.click('#oldList .card'); await wait(150);
  await clickText('#jobActions button', 'Delete this job');
  await page.click('#binOpen'); await wait(150);
  ok((await page.$eval('#binList .card-meta', e => e.textContent)).includes('Was in Old jobs'), 'bin remembers it was an old job');
  await clickText('#binList button', 'Restore');
  await page.click('#binBack'); await wait(100);
  ok((await page.$$('#oldList .card')).length === 1, 'restored back into Old jobs');

  // delete forever and empty bin (both confirm), from settings
  await page.click('#oldList .card'); await wait(150);
  await clickText('#jobActions button', 'Delete this job');
  await page.click('.tabs button[data-tab="active"]'); await wait(100);
  await page.click('#activeList .card'); await wait(150);
  await clickText('#jobActions button', 'Delete this job');
  await page.click('#btnSettings'); await wait(150);
  ok((await page.$eval('#binOpen2', b => b.textContent)) === 'Open the recycle bin (2)', 'settings shows bin count');
  await page.click('#binOpen2'); await wait(150);
  ok((await page.$$('#binList .bin-card')).length === 2, 'two jobs in the bin');
  await clickText('#binList button', 'Delete forever');
  ok(dialogs.some(d => d.includes('forever')), 'delete forever asks first');
  ok((await page.$$('#binList .bin-card')).length === 1, 'one left after delete forever');

  // bin survives reload
  await page.reload({ waitUntil: 'networkidle0' });
  await wait(1000);
  ok(await vis('#app'), 'reopening within 4 hours skips the password');
  d = await stored();
  ok(d.bin.length === 1 && d.bin[0].job.title === 'Other job', 'bin kept after reopening');
  await page.click('#btnSettings'); await wait(150);
  await page.click('#binOpen2'); await wait(150);
  await page.click('#binEmptyAll'); await wait(150);
  d = await stored();
  ok(d.bin.length === 0 && await vis('#binEmpty'), 'empty the recycle bin');

  ok(errors.length === 0, 'no errors ' + errors.join(' | '));
  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
