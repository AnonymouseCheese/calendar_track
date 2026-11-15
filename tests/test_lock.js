// Password stays valid for a while (default 4 hours). Needs the app on http://localhost:8765/
const puppeteer = require('puppeteer-core');

const URL = 'http://localhost:8765/';
let fails = 0;
function ok(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const vis = sel => page.$eval(sel, e => !e.hidden && !e.closest('[hidden]')).catch(() => false);
  const until = () => page.evaluate(() => +localStorage.getItem('ct.unlockUntil') || 0);
  const reopen = async () => { await page.reload({ waitUntil: 'networkidle0' }); await wait(800); };
  const unlock = async () => { await page.type('#unlockPw', 'ben'); await page.click('#unlockGo'); await wait(1000); };
  const H = 3600e3;

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.type('#setupPw1', 'ben'); await page.type('#setupPw2', 'ben');
  await page.click('#setupGo'); await wait(1500); await page.click('#codeDone'); await wait(200);
  let u = await until(), now = Date.now();
  ok(Math.abs(u - (now + 4 * H)) < 60e3, 'default: unlocked for 4 hours after setting the password');

  await reopen();
  ok(await vis('#app') && !(await vis('#lock')), 'reopening the app within 4 hours: no password');

  await page.click('#btnSettings'); await wait(150);
  ok((await page.$eval('#lockMode', e => e.value)) === '4h', 'settings shows After 4 hours');
  ok((await page.$eval('#lockInfo', e => e.textContent)).startsWith('Unlocked until '), 'settings says until when');
  await page.click('#setBack'); await wait(100);

  // Lock button really locks, even within the 4 hours
  await page.click('#btnLock'); await wait(200);
  ok(await vis('#lock-unlock'), 'Lock button locks');
  await reopen();
  ok(await vis('#lock-unlock'), 'after Lock, reopening asks for the password');
  await unlock();
  ok(await vis('#app'), 'unlock works');

  // time is up -> asks again
  await page.evaluate(() => localStorage.setItem('ct.unlockUntil', String(Date.now() - 1000)));
  await reopen();
  ok(await vis('#lock-unlock'), 'after 4 hours, asks again');
  await unlock();

  // time runs out while the app is in the background
  await page.evaluate(() => {
    localStorage.setItem('ct.unlockUntil', String(Date.now() - 1000));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await wait(200);
  ok(await vis('#lock-unlock'), 'coming back after the time is up locks');
  await unlock();

  // change the setting
  await page.click('#btnSettings'); await wait(150);
  await page.select('#lockMode', 'day'); await wait(100);
  u = await until();
  const midnight = await page.evaluate(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); });
  ok(u === midnight, 'Once a day: unlocked until midnight');
  ok((await page.$eval('#lockInfo', e => e.textContent)) === 'Unlocked until midnight tonight.', 'says midnight tonight');
  await page.select('#lockMode', '1h'); await wait(100);
  ok(Math.abs((await until()) - (Date.now() + H)) < 60e3, 'After 1 hour: counts from now');
  await page.select('#lockMode', 'always'); await wait(100);
  ok((await page.$eval('#lockInfo', e => e.textContent)) === '', 'Every time: no until message');
  await page.click('#setBack'); await wait(100);
  await reopen();
  ok(await vis('#lock-unlock'), 'Every time: reopening asks for the password');
  await unlock();
  ok((await until()) === 0, 'Every time: nothing kept');
  await page.click('#btnSettings'); await wait(150);
  ok((await page.$eval('#lockMode', e => e.value)) === 'always', 'setting remembered');

  ok(errors.length === 0, 'no errors ' + errors.join(' | '));
  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
