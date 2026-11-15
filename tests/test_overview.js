// Stage overview of all active jobs. Needs the app served on http://localhost:8765/
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
  const clickText = async (sel, text) => { await page.evaluate((s, t) => [...document.querySelectorAll(s)].filter(b => !b.closest('[hidden]')).find(b => b.textContent.trim().startsWith(t)).click(), sel, text); await wait(150); };
  const yesterday = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); });
  const tickStage = name => page.evaluate(n => [...document.querySelectorAll('#stages .stage')].find(r => r.querySelector('.st-name').textContent === n).querySelector('.st-dot').click(), name).then(() => wait(120));
  const groups = () => page.$$eval('#ovList .ov-head', h => h.map(x => x.firstChild.textContent + ':' + x.lastChild.textContent));
  const rowsUnder = label => page.evaluate(l => {
    const out = []; let on = false;
    for (const e of document.querySelectorAll('#ovList > *')) {
      if (e.classList.contains('ov-head')) on = e.firstChild.textContent === l;
      else if (on) out.push(e.querySelector('.ov-title').textContent);
    }
    return out;
  }, label);

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.type('#setupPw1', 'ben'); await page.type('#setupPw2', 'ben');
  await page.click('#setupGo'); await wait(1500); await page.click('#codeDone'); await wait(200);
  await page.click('.tabs button[data-tab="active"]'); await wait(100);
  ok(!(await vis('#ovOpen')), 'no overview button while there are no jobs');

  async function job(title, stages, tick, setup) {
    await page.type('#newJobTitle', title); await page.click('#newJobGo'); await wait(200);
    for (const s of stages) await clickText('#stageAdd .chip', '+ ' + s);
    for (const s of tick) await tickStage(s);
    if (setup) await setup();
    await page.click('#jobBack'); await wait(120);
  }
  await job('Job A', ['Quotation', 'Printing', 'Billing'], ['Quotation']);
  await job('Job B', ['Quotation', 'Printing'], []);
  await job('Job C', [], []);
  await job('Job D', ['Printing', 'Delivered'], [], async () => {
    const i = await page.evaluate(() => [...document.querySelectorAll('#stages .stage .st-name')].findIndex(e => e.textContent === 'Printing'));
    await page.evaluate(n => document.querySelectorAll('#stages .stage .st-more')[n].click(), i); await wait(120);
    await page.$eval('#stages .st-edit input[type="date"]', (e, v) => { e.value = v; e.dispatchEvent(new Event('change')); }, yesterday); await wait(120);
  });
  await job('Job E', ['Quotation'], ['Quotation']);

  ok(await vis('#ovOpen'), 'Stage overview button shown');
  await page.click('#ovOpen'); await wait(200);
  ok(await vis('#sheet-overview'), 'overview opens');
  ok((await page.$eval('#ovTitle', e => e.textContent)) === 'Overview \u00b7 Active jobs', 'title');
  const g = await groups();
  ok(JSON.stringify(g) === JSON.stringify(['Quotation:1', 'Printing:2', 'All stages done:1', 'No stages yet:1']), 'grouped by current stage, in stage order: ' + g);
  ok(JSON.stringify(await rowsUnder('Printing')) === JSON.stringify(['Job D', 'Job A']), 'jobs under Printing in your order');
  ok(JSON.stringify(await rowsUnder('Quotation')) === JSON.stringify(['Job B']), 'Job B still at Quotation');
  ok((await page.$eval('#ovLate', e => e.textContent)) === '1 job late', 'late count');
  const rowD = await page.evaluate(() => [...document.querySelectorAll('.ov-row')].find(r => r.textContent.includes('Job D')).querySelector('.ov-sub').textContent);
  ok(rowD.startsWith('Late: Printing'), 'late job says so: ' + rowD);
  const dotsA = await page.evaluate(() => [...[...document.querySelectorAll('.ov-row')].find(r => r.textContent.includes('Job A')).querySelectorAll('.dots span')].map(s => s.className || '-'));
  ok(JSON.stringify(dotsA) === JSON.stringify(['done', 'cur', '-']), 'progress dots: done / current / to come');
  await page.screenshot({ path: path.join(__dirname, 's9_overview.png'), fullPage: true });

  // open a job from the overview, tick its stage, come back: overview updated
  await page.evaluate(() => [...document.querySelectorAll('.ov-row')].find(r => r.textContent.includes('Job B')).click()); await wait(150);
  ok(await vis('#sheet-job') && (await page.$eval('#jobTitle', e => e.value)) === 'Job B', 'tapping a job opens it on top');
  await tickStage('Quotation');
  await page.click('#jobBack'); await wait(150);
  ok(await vis('#sheet-overview'), 'back returns to the overview');
  ok(JSON.stringify(await groups()) === JSON.stringify(['Printing:3', 'All stages done:1', 'No stages yet:1']), 'overview updated: ' + await groups());
  await page.click('#ovBack'); await wait(100);

  // follows the Jobs | Misc switch
  await clickText('#view-active .kind-seg button', 'Misc');
  ok(!(await vis('#ovOpen')), 'no overview button for empty misc');
  await page.type('#newJobTitle', 'Renew licence'); await page.click('#newJobGo'); await wait(200);
  await page.click('#jobBack'); await wait(100);
  await page.click('#ovOpen'); await wait(150);
  ok((await page.$eval('#ovTitle', e => e.textContent)) === 'Overview \u00b7 Active misc' && JSON.stringify(await groups()) === JSON.stringify(['No stages yet:1']), 'misc overview shows only misc');
  await page.click('#ovBack'); await wait(100);

  ok(errors.length === 0, 'no errors ' + errors.join(' | '));
  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
