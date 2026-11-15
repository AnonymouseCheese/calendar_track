// Drag-to-reorder for Active jobs. Needs the app served on http://localhost:8765/
const puppeteer = require('puppeteer-core');
const path = require('path');

const URL = 'http://localhost:8765/';
let fails = 0;
function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  const vis = sel => page.$eval(sel, e => !e.hidden && !e.closest('[hidden]')).catch(() => false);
  const titles = () => page.$$eval('#activeList .job-row .card-title', t => t.map(x => x.textContent));
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('ct.data')));

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.type('#setupPw1', 'ben'); await page.type('#setupPw2', 'ben');
  await page.click('#setupGo'); await wait(1500); await page.click('#codeDone'); await wait(200);
  await page.click('.tabs button[data-tab="active"]'); await wait(100);

  for (const t of ['Job A', 'Job B', 'Job C', 'Job D']) {
    await page.type('#newJobTitle', t); await page.click('#newJobGo'); await wait(150);
    await page.click('#jobBack'); await wait(100);
  }
  ok(JSON.stringify(await titles()) === JSON.stringify(['Job D', 'Job C', 'Job B', 'Job A']), 'new jobs go on top: ' + await titles());
  ok(await vis('#dragTip'), 'drag tip shown with 2+ jobs');
  ok((await page.$$('#activeList .job-row .grip')).length === 8, 'grip on both sides of every job');

  // drag(fromIndex, toIndex, side) using a real mouse (pointer events)
  async function drag(from, to, side) {
    const rows = await page.$$('#activeList .job-row');
    const grip = (await rows[from].$$('.grip'))[side === 'left' ? 0 : 1];
    const g = await grip.boundingBox();
    const target = await rows[to].boundingBox();
    const x = g.x + g.width / 2, y0 = g.y + g.height / 2;
    const y1 = to > from ? target.y + target.height * 0.8 : target.y + target.height * 0.2;
    await page.mouse.move(x, y0);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(x, y0 + (y1 - y0) * i / 12); await wait(15); }
    await page.mouse.up();
    await wait(200);
  }

  await drag(0, 2, 'right');
  ok(JSON.stringify(await titles()) === JSON.stringify(['Job C', 'Job B', 'Job D', 'Job A']), 'drag down by right grip: ' + await titles());
  ok(!(await vis('#sheet-job')), 'dragging does not open the job');
  await drag(3, 0, 'left');
  ok(JSON.stringify(await titles()) === JSON.stringify(['Job A', 'Job C', 'Job B', 'Job D']), 'drag up by left grip: ' + await titles());
  let d = await stored();
  const rank = t => d.jobs.find(j => j.title === t).rank;
  ok(rank('Job A') === 0 && rank('Job C') === 1 && rank('Job B') === 2 && rank('Job D') === 3, 'order saved');

  // order survives a reload + unlock
  await page.reload({ waitUntil: 'networkidle0' });
  await wait(1000);
  ok(await vis('#app'), 'reopening within 4 hours skips the password');
  await page.click('.tabs button[data-tab="active"]'); await wait(100);
  ok(JSON.stringify(await titles()) === JSON.stringify(['Job A', 'Job C', 'Job B', 'Job D']), 'order kept after reopening the app');

  // adding a note no longer reshuffles
  await page.evaluate(() => [...document.querySelectorAll('#activeList .card')].find(c => c.textContent.includes('Job D')).click()); await wait(150);
  await page.type('#noteNew', 'fresh note'); await page.click('#noteAdd'); await wait(100);
  await page.click('#jobBack'); await wait(100);
  ok((await titles())[3] === 'Job D', 'adding a note keeps the position');

  // next round keeps the same place
  await page.evaluate(() => [...document.querySelectorAll('#activeList .card')].find(c => c.textContent.includes('Job C')).click()); await wait(150);
  await page.evaluate(() => [...document.querySelectorAll('#jobActions button')].find(b => b.textContent.startsWith('Done, and')).click()); await wait(300);
  await page.click('#jobBack'); await wait(100);
  ok(JSON.stringify(await titles()) === JSON.stringify(['Job A', 'Job C', 'Job B', 'Job D']), 'next round stays in the same spot: ' + await titles());

  // tapping the middle still opens the job
  await page.click('#activeList .job-row .card'); await wait(150);
  ok(await vis('#sheet-job'), 'tapping the job itself still opens it');
  await page.click('#jobBack'); await wait(100);
  await page.screenshot({ path: path.join(__dirname, 's5_active_drag.png') });

  ok(errors.length === 0, 'no errors ' + errors.join(' | '));
  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
