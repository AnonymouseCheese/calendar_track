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
  await clickText('#stageAdd .chip', '+ Quotation');
  await clickText('#stageAdd .chip', '+ Printing');
  ok((await stageNames())[0] === 'Printing', 'a newly added stage goes on top');
  await clickText('#stageAdd .chip', '+ Delivery date');
  await clickText('#stageAdd .chip', '+ Billing');
  ok(JSON.stringify(await stageNames()) === JSON.stringify(['Billing', 'Delivery date', 'Printing', 'Quotation']), 'each new stage on top, first at the bottom: ' + await stageNames());
  ok(JSON.stringify((await stored()).jobs[0].stages.map(x => x.name)) === JSON.stringify(['Quotation', 'Printing', 'Delivery date', 'Billing']), 'stored first-to-last');
  const chips2 = await page.$$eval('#stageAdd .chip', c => c.map(x => x.textContent));
  ok(chips2.includes('+ Printing again') && !chips2.includes('+ Printing'), 'used stages stay as "+ Printing again"');
  // custom stage
  await clickText('#stageAdd .chip', '+ New stage');
  await page.type('#stageNewName', 'Proof approved'); await page.keyboard.press('Enter'); await wait(150);
  ok((await stageNames()).includes('Proof approved'), 'custom stage added');
  await clickText('#stageAdd button', 'Done adding');
  ok(await page.$eval('#stageAdd', e => e.textContent.trim() === '+ Add a stage'), 'chips fold away into "+ Add a stage"');

  // tick the first stage: date stamped, next one highlighted
  const qRow = () => page.evaluateHandle(() => [...document.querySelectorAll('#stages .stage')].find(r => r.querySelector('.st-name').textContent === 'Quotation'));
  await page.evaluate(r => r.querySelector('.st-dot').click(), await qRow()); await wait(150);
  ok(await page.evaluate(r => r.classList.contains('done'), await qRow()), 'tick marks stage done');
  ok((await page.evaluate(r => r.querySelector('.st-sub').textContent, await qRow())).startsWith('Done '), 'done date shown');
  ok(await page.evaluate(r => r.classList.contains('last'), await qRow()), 'first stage is at the bottom');
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
  // iPhone fills in a date as soon as the box is tapped: the picker must stay open
  {
    const i = (await stageNames()).indexOf('Delivery date');
    await page.evaluate(n => document.querySelectorAll('#stages .stage .st-more')[n].click(), i); await wait(120);
    const box = await page.$('#stages .st-edit input[type="date"]');
    await box.evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('change')); }, today); await wait(120);
    ok(await box.evaluate(e => e.isConnected), 'date box stays open after a date is filled in');
    ok((await stored()).jobs[0].stages.find(s => s.name === 'Delivery date').due === today, 'first date saved');
    await box.evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('change')); }, yesterday); await wait(120);
    ok(await box.evaluate(e => e.isConnected), 'can pick another date without reopening');
    ok((await stored()).jobs[0].stages.find(s => s.name === 'Delivery date').due === yesterday, 'second date saved');
    const subTxt = await page.evaluate(() => [...document.querySelectorAll('#stages .stage')].find(r => r.querySelector('.st-name').textContent === 'Delivery date').querySelector('.st-sub'));
    ok(subTxt !== null, 'date line updates while the box is open');
    await page.evaluate(() => [...document.querySelectorAll('#stages .st-edit .date-clear')][0].click()); await wait(120);
    ok((await stored()).jobs[0].stages.find(s => s.name === 'Delivery date').due === null && await box.evaluate(e => e.value === ''), 'Clear removes the date');
    await page.evaluate(n => document.querySelectorAll('#stages .stage .st-more')[n].click(), i); await wait(120);
  }
  // same for the job's Month box
  {
    const m = await page.$('#jobMonth');
    await m.evaluate(e => { e.value = '2026-12'; e.dispatchEvent(new Event('change')); }); await wait(120);
    ok(await m.evaluate(e => e.isConnected && e.value === '2026-12'), 'month box stays put after picking');
    ok((await stored()).jobs[0].month === '2026-12' && (await page.$eval('#monthHint', e => e.textContent)).includes('December 2026'), 'month saved, hint updated');
    await page.click('#monthClear'); await wait(120);
    ok(!(await stored()).jobs[0].month && (await page.$eval('#jobMonth', e => e.value)) === '', 'month Clear works');
  }
  await setDue('Delivery date', tomorrow);
  await setDue('Printing', yesterday);
  ok(await page.$eval('#stages .stage.next .st-sub', e => e.classList.contains('late') && e.textContent.startsWith('Due ')), 'overdue stage shown in red');
  // due today still shows the date, never "Due today"
  await setDue('Billing', today);
  const billSub = await page.evaluate(() => [...document.querySelectorAll('#stages .stage')].find(r => r.textContent.includes('Billing')).querySelector('.st-sub').textContent);
  ok(/^Due \d{1,2} [A-Z][a-z]{2}/.test(billSub) && !billSub.includes('today'), 'due today shows the date: ' + billSub);
  // a note on a stage
  const iBill = (await stageNames()).indexOf('Billing');
  await page.evaluate(n => document.querySelectorAll('#stages .stage .st-more')[n].click(), iBill); await wait(120);
  await page.type('#stages .st-edit textarea', 'Bill to finance dept\nPO 4471');
  await page.evaluate(n => document.querySelectorAll('#stages .stage .st-more')[n].click(), iBill); await wait(120);
  const billNote = await page.evaluate(() => [...document.querySelectorAll('#stages .stage')].find(r => r.textContent.includes('Billing')).querySelector('.st-note'));
  ok(billNote !== null, 'stage note shows under the stage');
  ok((await stored()).jobs[0].stages.find(s => s.name === 'Billing').note === 'Bill to finance dept\nPO 4471', 'stage note saved');
  // move a stage, remove a stage
  const iProof = (await stageNames()).indexOf('Proof approved');
  await page.evaluate(n => document.querySelectorAll('#stages .stage .st-more')[n].click(), iProof); await wait(120);
  ok(iProof === 0, 'newest custom stage is at the top');
  await clickText('#stages .st-edit button', 'Move down');
  ok((await stageNames()).indexOf('Proof approved') === iProof + 1, 'Move down moves it one place lower on screen');
  await clickText('#stages .st-edit button', 'Move up');
  ok((await stageNames()).indexOf('Proof approved') === iProof, 'Move up moves it back');
  await clickText('#stages .st-edit button', 'Remove');
  ok(!(await stageNames()).includes('Proof approved'), 'stage removed');
  // the same stage twice (e.g. a reprint)
  await clickText('#stageAdd button', '+ Add a stage');
  await clickText('#stageAdd .chip', '+ Printing again');
  ok(JSON.stringify(await stageNames()) === JSON.stringify(['Printing (2nd time)', 'Billing', 'Delivery date', 'Printing', 'Quotation']), 'same stage added again, on top: ' + await stageNames());
  ok((await stored()).jobs[0].stages.filter(s => s.name === 'Printing').length === 2, 'both saved with the same name');
  await clickText('#stageAdd .chip', '+ New stage');
  await page.type('#stageNewName', 'printing'); await page.keyboard.press('Enter'); await wait(150);
  ok((await stageNames()).includes('printing (3rd time)'), 'typing an existing name also works (3rd time)');
  // remove the extras again so the rest of the test is unchanged
  for (const nm of ['printing (3rd time)', 'Printing (2nd time)']) {
    const k = (await stageNames()).indexOf(nm);
    await page.evaluate(n => document.querySelectorAll('#stages .stage .st-more')[n].click(), k); await wait(120);
    await clickText('#stages .st-edit button', 'Remove');
  }
  await clickText('#stageAdd button', 'Done adding');
  ok(JSON.stringify(await stageNames()) === JSON.stringify(['Billing', 'Delivery date', 'Printing', 'Quotation']), 'extras removed');
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
  await page.evaluate(s => document.querySelector(s + ' .check.jobstage .txt').click(), rowSel); await wait(150);
  ok(!(await stored()).jobs[0].stages.find(s => s.name === 'Delivery date').done, 'tapping the stage text on the calendar does not tick it');
  if ((await page.$$('#week .wk-row.sel')).length) { await page.evaluate(() => document.querySelector('#week .wk-row.sel .wk-btn').click()); await wait(150); }
  await page.evaluate(s => document.querySelector(s + ' .check.jobstage .box').click(), rowSel); await wait(150);
  await page.click('#toast .toast-undo'); await wait(150);
  ok(!(await stored()).jobs[0].stages.find(s => s.name === 'Delivery date').done, 'Undo reverses a calendar tick');
  await page.evaluate(s => document.querySelector(s + ' .check.jobstage .box').click(), rowSel); await wait(150);
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
  ok(JSON.stringify(await stageNames()) === JSON.stringify(['Billing', 'Delivery date', 'Printing', 'Quotation']), 'next round has the same stages');
  ok((await page.$$('#stages .stage.done')).length === 0 && (await page.$$('#stages .st-sub')).length === 0, 'unticked, no dates');
  ok((await page.$$('#stages .st-note')).length === 0, 'stage notes not copied into the next round');
  ok((await page.$eval('#prevLabel', e => e.textContent)) === 'Show previous notes (1)', 'previous notes count includes the stage note');
  await page.click('#prevToggle'); await wait(120);
  ok((await page.$eval('#prevNotes', e => e.textContent)).includes('Stage: Billing') && (await page.$eval('#prevNotes', e => e.textContent)).includes('PO 4471'), 'previous round stage note shown');
  await page.click('#prevToggle'); await wait(120);
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
  await wait(1000);
  ok(await vis('#app'), 'reopening within 4 hours skips the password');
  d = await stored();
  ok(d.jobs.some(j => j.stages && j.stages.length === 4), 'stages kept after reopening');

  ok(errors.length === 0, 'no errors ' + errors.join(' | '));
  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
