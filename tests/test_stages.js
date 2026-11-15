// Job stages (timeline). Needs the app served on http://localhost:8765/
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
  const clickText = async (sel, text) => { await page.evaluate((s, t) => [...document.querySelectorAll(s)].find(b => b.textContent.trim() === t).click(), sel, text); await wait(120); };
  const stageNames = () => page.$$eval('#stages .stage .st-name', e => e.map(x => x.textContent));
  const day = off => page.evaluate(o => { const d = new Date(); d.setDate(d.getDate() + o); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }, off);
  const today = await day(0), tomorrow = await day(1), yesterday = await day(-1);

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.type('#setupPw1', 'ben'); await page.type('#setupPw2', 'ben');
  await page.click('#setupGo'); await wait(1500); await page.click('#codeDone'); await wait(200);
  await page.click('.tabs button[data-tab="active"]'); await wait(100);
  await page.type('#newJobTitle', 'Mailer client A'); await page.click('#newJobGo'); await wait(200);

  // a new job has no stages, just chips to pick from
  ok((await page.$$('#stages .stage')).length === 0, 'new job starts with no stages');
  const chips = await page.$$eval('#stageAdd .chip', c => c.map(x => x.textContent));
  ok(chips.length === 9 && chips[0] === '+ Quotation' && chips[8] === '+ New stage', 'chips: 8 suggestions + New stage');
  // tap out of order: they still line up in the list order
  await clickText('#stageAdd .chip', '+ Billing');
  await clickText('#stageAdd .chip', '+ Quotation');
  await clickText('#stageAdd .chip', '+ Delivery date');
  await clickText('#stageAdd .chip', '+ Printing');
  ok(JSON.stringify(await stageNames()) === JSON.stringify(['Quotation', 'Printing', 'Delivery date', 'Billing']), 'stages kept in sensible order: ' + await stageNames());
  ok(!(await page.$$eval('#stageAdd .chip', c => c.map(x => x.textContent))).includes('+ Printing'), 'used stages leave the chip list');
  // custom stage
  await clickText('#stageAdd .chip', '+ New stage');
  await page.type('#stageNewName', 'Proof approved'); await page.keyboard.press('Enter'); await wait(150);
  ok((await stageNames()).includes('Proof approved'), 'custom stage added');
  await clickText('#stageAdd button', 'Done adding');
  ok(await page.$eval('#stageAdd', e => e.textContent.trim() === '+ Add a stage'), 'chips fold away into "+ Add a stage"');

  // tick the first stage: date stamped, next one highlighted
  await page.click('#stages .stage .st-dot'); await wait(150);
  ok(await page.$eval('#stages .stage', s => s.classList.contains('done')), 'tick marks stage done');
  ok((await page.$eval('#stages .stage .st-sub', e => e.textContent)).startsWith('Done '), 'done date shown');
  ok(await page.$eval('#stages .stage.next .st-name', e => e.textContent) === 'Printing', 'next stage highlighted');
  let d = await stored();
  let job = d.jobs[0];
  ok(job.stages[0].done && job.stages[0].doneAt === today, 'done date saved as today');

  // due dates: delivery tomorrow, printing yesterday (late)
  async function setDue(name, val) {
    const i = (await stageNames()).indexOf(name);
    await page.evaluate(n => document.querySelectorAll('#stages .stage .st-more')[n].click(), i); await wait(120);
    await page.$eval('#stages .st-edit input[type="date"]', (e, v) => { e.value = v; e.dispatchEvent(new Event('change')); }, val); await wait(120);
    await page.evaluate(n => document.querySelectorAll('#stages .stage .st-more')[n].click(), i); await wait(120);
  }
  await setDue('Delivery date', tomorrow);
  await setDue('Printing', yesterday);
  ok(await page.$eval('#stages .stage.next .st-sub', e => e.classList.contains('late') && e.textContent.startsWith('Due ')), 'overdue stage shown in red');
  // move a stage, remove a stage
  const iProof = (await stageNames()).indexOf('Proof approved');
  await page.evaluate(n => document.querySelectorAll('#stages .stage .st-more')[n].click(), iProof); await wait(120);
  await clickText('#stages .st-edit button', 'Move up');
  ok((await stageNames()).indexOf('Proof approved') === iProof - 1, 'stage moved up');
  await clickText('#stages .st-edit button', 'Remove');
  ok(!(await stageNames()).includes('Proof approved'), 'stage removed');
  await page.screenshot({ path: path.join(__dirname, 's6_stages.png'), fullPage: true });
  await page.click('#jobBack'); await wait(150);

  // card shows progress
  const cardStage = await page.$eval('#activeList .card-stage', e => ({ t: e.textContent, late: e.classList.contains('late') }));
  ok(cardStage.late && cardStage.t.startsWith('Late: Printing') && cardStage.t.endsWith('1/4'), 'card shows Late + 1/4: ' + cardStage.t);
  ok(await page.$eval('#activeList .bar span', e => e.style.width === '25%'), 'progress bar 25%');
  await page.screenshot({ path: path.join(__dirname, 's6b_cards.png') });

  // calendar: delivery date shows tomorrow, tick it there
  await page.click('.tabs button[data-tab="calendar"]'); await wait(100);
  await clickText('.seg button', 'Week');
  const rowSel = '#week .wk-row[data-key="' + tomorrow + '"]';
  let onCal = await page.$$eval(rowSel + ' .check.jobstage .txt', e => e.map(x => x.textContent)).catch(() => []);
  if (!onCal.length) { await page.click('#mNext'); await wait(120); onCal = await page.$$eval(rowSel + ' .check.jobstage .txt', e => e.map(x => x.textContent)); }
  ok(onCal.length === 1 && onCal[0] === 'Mailer client A: Delivery date', 'stage due date appears on the calendar');
  ok((await page.$eval(rowSel + ' .left', e => e.textContent)) === '1 left', 'calendar counts it as outstanding');
  await page.evaluate(s => document.querySelector(s + ' .check.jobstage').click(), rowSel); await wait(150);
  d = await stored();
  ok(d.jobs[0].stages.find(s => s.name === 'Delivery date').done === true, 'ticking on the calendar ticks the job stage');
  await page.click('#btnToday'); await wait(100);
  await clickText('.seg button', 'Month');
  await page.click('.cell[data-key="' + tomorrow + '"]'); await wait(120);
  ok(await page.$eval('.cell[data-key="' + tomorrow + '"]', c => c.classList.contains('alldone')), 'month box shows it done');
  ok((await page.$$('#dayChecks .check.jobstage.done')).length === 1, 'month day list shows the stage');
  // a day with only a stage still lets you type your own note, stage list stays visible
  ok(await vis('#dayNote') && await vis('#dayChecks'), 'empty day: text box plus the stage list');

  // next round copies stages unticked, without dates
  await page.click('.tabs button[data-tab="active"]'); await wait(100);
  await page.click('#activeList .card'); await wait(150);
  await clickText('#jobActions button', 'Done, and start the next round');
  ok(JSON.stringify(await stageNames()) === JSON.stringify(['Quotation', 'Printing', 'Delivery date', 'Billing']), 'next round has the same stages');
  ok((await page.$$('#stages .stage.done')).length === 0 && (await page.$$('#stages .st-sub')).length === 0, 'unticked, no dates');
  await page.click('#jobBack'); await wait(100);

  // custom stage became a chip for other jobs; settings list edits it
  await page.type('#newJobTitle', 'Banner job'); await page.click('#newJobGo'); await wait(200);
  ok((await page.$$eval('#stageAdd .chip', c => c.map(x => x.textContent))).includes('+ Proof approved'), 'custom stage offered on new jobs');
  await page.click('#jobBack'); await wait(100);
  await page.click('#btnSettings'); await wait(150);
  let lib = await page.$$eval('#libList .lib-row span', e => e.map(x => x.textContent));
  ok(lib.length === 9 && lib[8] === 'Proof approved', 'settings lists the stages');
  await page.evaluate(() => [...document.querySelectorAll('#libList .lib-row')].find(r => r.textContent.includes('Inserting')).querySelector('.danger').click()); await wait(100);
  await page.type('#libNew', 'Packing'); await page.click('#libAdd'); await wait(100);
  lib = await page.$$eval('#libList .lib-row span', e => e.map(x => x.textContent));
  ok(!lib.includes('Inserting') && lib[lib.length - 1] === 'Packing', 'remove and add in settings');
  await page.evaluate(() => [...document.querySelectorAll('#libList .lib-row')].find(r => r.textContent.includes('Packing')).querySelectorAll('button')[0].click()); await wait(100);
  lib = await page.$$eval('#libList .lib-row span', e => e.map(x => x.textContent));
  ok(lib[lib.length - 2] === 'Packing', 'move up in settings');
  d = await stored();
  ok(Array.isArray(d.stageLib) && d.stageLib.includes('Packing'), 'stage list saved');
  await page.screenshot({ path: path.join(__dirname, 's6c_settings.png'), fullPage: true });
  await page.click('#setBack'); await wait(100);

  // survives reload
  await page.reload({ waitUntil: 'networkidle0' });
  await page.type('#unlockPw', 'ben'); await page.click('#unlockGo'); await wait(1200);
  d = await stored();
  ok(d.jobs.some(j => j.stages && j.stages.length === 4), 'stages kept after reopening');

  ok(errors.length === 0, 'no errors ' + errors.join(' | '));
  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
