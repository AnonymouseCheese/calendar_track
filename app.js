'use strict';
/*
 * Calendar Track - everything is stored on this device only (localStorage).
 * Nothing is ever sent to a server. The Content-Security-Policy in index.html
 * blocks the page from talking to any other site.
 */
(function () {
  var KEY_DATA = 'ct.data';
  var KEY_LOCK = 'ct.lock';
  var KEY_BACKUP = 'ct.lastBackup';
  var SCHEMA = 1;
  var LOCK_ITER = 150000;
  var EXPORT_ITER = 250000;
  var LOCK_AFTER_MS = 2 * 60 * 1000;
  var BACKUP_NAG_DAYS = 7;

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(label, cls, onClick) {
    var b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------- small helpers ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function keyToDate(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function nowIso() { return new Date().toISOString(); }
  function fmtDate(iso) { var d = new Date(iso); return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); }
  function fmtDateTime(iso) {
    var d = new Date(iso), h = d.getHours(), ap = h < 12 ? 'am' : 'pm';
    h = h % 12 || 12;
    return fmtDate(iso) + ', ' + h + ':' + pad(d.getMinutes()) + ' ' + ap;
  }
  function monthKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function monthLabel(m) { return MONTHS[+m.slice(5) - 1] + ' ' + m.slice(0, 4); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function firstLine(s) { return String(s).trim().split('\n')[0]; }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = crypto.getRandomValues(new Uint8Array(16)), s = '';
    for (var i = 0; i < a.length; i++) s += pad16(a[i]);
    return s;
  }
  function pad16(n) { return (n < 16 ? '0' : '') + n.toString(16); }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  // ---------- data ----------
  function emptyData() { return { schema: SCHEMA, days: {}, jobs: [] }; }

  // Cleans up data from storage or from a backup file, so a bad file can't break the app.
  // Fields this version doesn't know about are kept, so newer data is never stripped.
  function normalise(d) {
    if (!d || typeof d !== 'object') throw new Error('not data');
    var out = Object.assign({}, d, emptyData());
    if (d.days && typeof d.days === 'object') {
      Object.keys(d.days).forEach(function (k) {
        var v = d.days[k];
        if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'string' && v.trim()) out.days[k] = v;
      });
    }
    if (Array.isArray(d.jobs)) {
      d.jobs.forEach(function (j) {
        if (!j || typeof j !== 'object') return;
        var id = str(j.id) || uid();
        out.jobs.push(Object.assign({}, j, {
          id: id,
          title: str(j.title) || 'Untitled job',
          seriesId: str(j.seriesId) || id,
          status: j.status === 'old' ? 'old' : 'active',
          created: str(j.created) || nowIso(),
          closed: j.status === 'old' ? (str(j.closed) || nowIso()) : null,
          month: /^\d{4}-\d{2}$/.test(str(j.month)) ? j.month : undefined,
          rank: typeof j.rank === 'number' && isFinite(j.rank) ? j.rank : undefined,
          notes: (Array.isArray(j.notes) ? j.notes : []).filter(function (n) {
            return n && typeof n.text === 'string';
          }).map(function (n) {
            return Object.assign({}, n, { id: str(n.id) || uid(), at: str(n.at) || nowIso(), text: n.text });
          })
        }));
      });
    }
    return out;
  }

  /*
   * KEEPING DATA SAFE ACROSS VERSIONS - read before changing the data format.
   * - Notes live in localStorage under KEY_DATA. Updating the code never touches them.
   * - If the format must change: raise SCHEMA and add a step to MIGRATIONS
   *   (MIGRATIONS[1] turns schema 1 into schema 2, and so on). Never rename or
   *   delete KEY_DATA. The old data is copied aside before any migration runs.
   * - If saved data is from a NEWER version than this code (e.g. an old cached copy
   *   of the app opened offline), the app goes read-only rather than overwrite it.
   * - If saved data can't be read, the raw text is kept under a rescue key and
   *   never overwritten.
   */
  var MIGRATIONS = {};
  var KEY_SNAPSHOT = 'ct.snapshot';

  var data = emptyData();
  var readOnly = '';

  function loadData() {
    readOnly = '';
    var raw = localStorage.getItem(KEY_DATA);
    if (!raw) return emptyData();
    var d;
    try {
      d = JSON.parse(raw);
      if (!d || typeof d !== 'object') throw new Error('not data');
    } catch (e) {
      localStorage.setItem('ct.rescue.' + Date.now(), raw);
      localStorage.removeItem(KEY_DATA);
      alert("Your saved notes couldn't be read. A copy has been kept aside so nothing is lost. Please restore from your latest backup file.");
      return emptyData();
    }
    var v = typeof d.schema === 'number' ? d.schema : 1;
    if (v > SCHEMA) {
      readOnly = 'This copy of the app is older than your notes, so changes are switched off to protect them. ' +
        'Close the app completely and reopen it while online to get the update.';
      return normalise(d);
    }
    if (v < SCHEMA) {
      localStorage.setItem(KEY_DATA + '.before-v' + SCHEMA, raw);
      while (v < SCHEMA) { d = MIGRATIONS[v](d); v++; }
      d.schema = SCHEMA;
      d = normalise(d);
      localStorage.setItem(KEY_DATA, JSON.stringify(d));
      return d;
    }
    return normalise(d);
  }

  // Once a day, keep a copy of all notes as they were, as an undo for mistakes.
  function takeSnapshot() {
    if (readOnly || !hasAnything()) return;
    try {
      var s = JSON.parse(localStorage.getItem(KEY_SNAPSHOT) || 'null');
      if (s && s.at && dayKey(new Date(s.at)) === dayKey(new Date())) return;
      localStorage.setItem(KEY_SNAPSHOT, JSON.stringify({ at: nowIso(), data: data }));
    } catch (e) { /* not worth bothering the user about */ }
  }

  function save() {
    if (readOnly) {
      alert(readOnly);
      return false;
    }
    try {
      localStorage.setItem(KEY_DATA, JSON.stringify(data));
      return true;
    } catch (e) {
      alert('Could not save. The phone may be out of storage space.');
      return false;
    }
  }
  function hasAnything() { return Object.keys(data.days).length > 0 || data.jobs.length > 0; }

  // ---------- crypto ----------
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }
  function toB64(buf) {
    var a = new Uint8Array(buf), s = '';
    for (var i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(s) {
    var bin = atob(s), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function pbkdf2Key(secret) {
    return crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
  }
  function hashSecret(secret, saltB64, iter) {
    return pbkdf2Key(secret).then(function (key) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromB64(saltB64), iterations: iter, hash: 'SHA-256' }, key, 256);
    }).then(toB64);
  }
  function aesKey(secret, salt, iter) {
    return pbkdf2Key(secret).then(function (key) {
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' },
        key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }

  // ---------- lock ----------
  // Only a fingerprint (hash) of the password is stored, never the password itself.
  var CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function makeCode() {
    var a = rand(12), s = '';
    for (var i = 0; i < 12; i++) {
      s += CODE_CHARS[a[i] % CODE_CHARS.length];
      if (i === 3 || i === 7) s += '-';
    }
    return s;
  }
  function normCode(s) { return String(s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function getLock() {
    try { return JSON.parse(localStorage.getItem(KEY_LOCK)); } catch (e) { return null; }
  }
  function createLock(pw) {
    var code = makeCode();
    var lock = { v: 1, iter: LOCK_ITER, salt: toB64(rand(16)), rsalt: toB64(rand(16)) };
    return hashSecret(pw, lock.salt, lock.iter).then(function (h) {
      lock.hash = h;
      return hashSecret(normCode(code), lock.rsalt, lock.iter);
    }).then(function (rh) {
      lock.rhash = rh;
      localStorage.setItem(KEY_LOCK, JSON.stringify(lock));
      return code;
    });
  }
  function setNewPassword(pw) {
    var lock = getLock();
    lock.salt = toB64(rand(16));
    return hashSecret(pw, lock.salt, lock.iter).then(function (h) {
      lock.hash = h;
      localStorage.setItem(KEY_LOCK, JSON.stringify(lock));
    });
  }
  function checkPassword(pw) {
    var lock = getLock();
    return hashSecret(pw, lock.salt, lock.iter).then(function (h) { return h === lock.hash; });
  }
  function checkCode(code) {
    var lock = getLock();
    return hashSecret(normCode(code), lock.rsalt, lock.iter).then(function (h) { return h === lock.rhash; });
  }
  function pwProblem(a, b) {
    if (a.length < 3) return 'Use at least 3 characters.';
    if (a !== b) return "The two passwords don't match.";
    return '';
  }

  var unlocked = false;
  var busy = false;

  function showLock(mode) {
    unlocked = false;
    $('app').hidden = true;
    $('sheet-job').hidden = true;
    $('sheet-settings').hidden = true;
    $('lock').hidden = false;
    ['setup', 'code', 'unlock', 'forgot'].forEach(function (m) { $('lock-' + m).hidden = m !== mode; });
    ['setupPw1', 'setupPw2', 'unlockPw', 'forgotCode', 'forgotPw1', 'forgotPw2'].forEach(function (id) { $(id).value = ''; });
    ['setupErr', 'unlockErr', 'forgotErr'].forEach(function (id) { $(id).textContent = ''; });
    // Clear private content from the page while locked. Forget which day / job was
    // being edited first, so the emptied boxes are never saved over real notes.
    clearTimeout(dayTimer);
    dayTimer = null;
    dayEditKey = null;
    openId = null;
    editingNoteId = null;
    parkPanel();
    $('grid').textContent = '';
    $('week').textContent = '';
    $('dayNote').value = '';
    $('activeList').textContent = '';
    $('oldList').textContent = '';
    $('jobNotes').textContent = '';
    $('prevNotes').textContent = '';
  }

  function guard(fn) {
    return function () {
      if (busy) return;
      busy = true;
      Promise.resolve().then(fn).catch(function (e) {
        alert('Something went wrong: ' + (e && e.message ? e.message : e));
      }).then(function () { busy = false; });
    };
  }

  $('setupGo').addEventListener('click', guard(function () {
    var a = $('setupPw1').value, b = $('setupPw2').value, p = pwProblem(a, b);
    if (p) { $('setupErr').textContent = p; return; }
    return createLock(a).then(function (code) {
      $('codeShow').textContent = code;
      showLock('code');
    });
  }));
  $('codeDone').addEventListener('click', function () { $('codeShow').textContent = ''; unlock(); });

  $('unlockGo').addEventListener('click', guard(function () {
    var pw = $('unlockPw').value;
    if (!pw) return;
    return checkPassword(pw).then(function (ok) {
      if (ok) unlock();
      else { $('unlockErr').textContent = 'Wrong password.'; $('unlockPw').value = ''; }
    });
  }));
  $('forgotGo').addEventListener('click', function () { showLock('forgot'); });
  $('forgotBack').addEventListener('click', function () { showLock('unlock'); });
  $('forgotSet').addEventListener('click', guard(function () {
    var a = $('forgotPw1').value, b = $('forgotPw2').value;
    return checkCode($('forgotCode').value).then(function (ok) {
      if (!ok) { $('forgotErr').textContent = "That recovery code isn't right."; return; }
      var p = pwProblem(a, b);
      if (p) { $('forgotErr').textContent = p; return; }
      return setNewPassword(a).then(function () { unlock(); toast('New password set'); });
    });
  }));

  // Enter key on lock-screen inputs presses the main button.
  [['setupPw2', 'setupGo'], ['unlockPw', 'unlockGo'], ['forgotPw2', 'forgotSet'], ['setupPw1', 'setupGo']].forEach(function (p) {
    $(p[0]).addEventListener('keydown', function (e) { if (e.key === 'Enter') $(p[1]).click(); });
  });

  function unlock() {
    unlocked = true;
    data = loadData();
    takeSnapshot();
    $('dayNote').readOnly = !!readOnly;
    $('noteNew').readOnly = !!readOnly;
    $('lock').hidden = true;
    $('app').hidden = false;
    var t = new Date();
    viewY = t.getFullYear(); viewM = t.getMonth(); selKey = dayKey(t);
    editing = false;
    showTab(tab);
    updateBanner();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  }

  function lockNow() {
    flushAll();
    showLock(getLock() ? 'unlock' : 'setup');
  }
  $('btnLock').addEventListener('click', lockNow);

  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      flushAll();
      hiddenAt = Date.now();
    } else if (unlocked && hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) {
      lockNow();
    }
  });
  window.addEventListener('pagehide', flushAll);

  function flushAll() {
    if (!unlocked) return;
    commitDay();
    commitTitle();
  }

  // ---------- tabs ----------
  var tab = 'calendar';
  var TITLES = { calendar: 'Calendar', active: 'Active jobs', old: 'Old jobs' };
  function showTab(t) {
    flushAll();
    tab = t;
    ['calendar', 'active', 'old'].forEach(function (v) { $('view-' + v).hidden = v !== t; });
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.classList.toggle('on', b.dataset.tab === t);
    });
    $('viewTitle').textContent = TITLES[t];
    renderTab();
    window.scrollTo(0, 0);
  }
  function renderTab() {
    if (tab === 'calendar') renderCal();
    else if (tab === 'active') renderActive();
    else renderOld();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.tab); });
  });

  // ---------- calendar ----------
  var viewY, viewM, selKey;
  var dayTimer = null;
  var dayEditKey = null;

  // Month view (overview grid) or Week view (every item of each day, full width).
  var calMode = localStorage.getItem('ct.calMode') === 'week' ? 'week' : 'month';
  // Whether the selected day's text box is open. When closed, days show as tick lists.
  var editing = false;

  // The day editor is one element that moves between the month view (below the
  // grid) and the selected row of the week view. Put it back before clearing lists.
  function parkPanel() { $('view-calendar').appendChild($('dayPanel')); }

  // ---- items & ticks ----
  // Each line of a day's note is one item. A done item starts with "✓ " - the tick
  // lives in the text itself, so it survives edits, backups and moving to a PC.
  var TICK = '✓';
  var TICK_RE = /^(\s*)✓\s*/;
  function dayItemsOf(k) {
    var out = [];
    (data.days[k] || '').split('\n').forEach(function (raw, i) {
      var done = TICK_RE.test(raw);
      var text = raw.replace(TICK_RE, '').trim();
      if (text) out.push({ i: i, text: text, done: done });
    });
    return out;
  }
  function toggleItem(k, idx) {
    commitDay();
    var lines = (data.days[k] || '').split('\n');
    var raw = lines[idx];
    if (raw == null) return;
    lines[idx] = TICK_RE.test(raw) ? raw.replace(TICK_RE, '$1') : raw.replace(/^(\s*)/, '$1' + TICK + ' ');
    data.days[k] = lines.join('\n');
    if (!save()) return;
    renderCal();
  }
  function checklist(k) {
    var items = dayItemsOf(k);
    if (!items.length) return el('div', 'wk-empty', 'Nothing');
    var ul = el('ul', 'checks');
    items.forEach(function (it) {
      var li = el('li', 'check' + (it.done ? ' done' : ''));
      li.dataset.key = k;
      li.dataset.idx = it.i;
      li.setAttribute('role', 'checkbox');
      li.setAttribute('aria-checked', it.done ? 'true' : 'false');
      li.appendChild(el('span', 'box'));
      li.appendChild(el('span', 'txt', it.text));
      ul.appendChild(li);
    });
    return ul;
  }
  function leftLabel(k) {
    var items = dayItemsOf(k);
    if (!items.length) return null;
    var left = items.filter(function (it) { return !it.done; }).length;
    return left ? el('span', 'left', left + ' left') : el('span', 'left all', 'All done');
  }
  // Ticking works anywhere a checklist is shown.
  document.addEventListener('click', function (e) {
    var li = e.target.closest && e.target.closest('.check');
    if (!li || !unlocked) return;
    e.stopPropagation();
    toggleItem(li.dataset.key, +li.dataset.idx);
  }, true);

  function renderCal() {
    parkPanel();
    var isWeek = calMode === 'week';
    Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
      b.classList.toggle('on', b.dataset.mode === calMode);
    });
    $('weekdays').hidden = isWeek;
    $('grid').hidden = isWeek;
    $('week').hidden = !isWeek;
    $('dayHead').hidden = isWeek;
    $('dayPanel').hidden = isWeek && !editing;
    if (isWeek) renderWeek();
    else renderMonth();
    renderDay();
    var now = new Date();
    $('btnToday').disabled = selKey === dayKey(now) &&
      (isWeek ? editing : (viewY === now.getFullYear() && viewM === now.getMonth()));
  }

  function renderWeek() {
    var sel = keyToDate(selKey);
    var start = new Date(sel.getFullYear(), sel.getMonth(), sel.getDate() - sel.getDay());
    var end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    $('mLabel').textContent = start.getDate() + ' ' + MON[start.getMonth()] +
      (start.getFullYear() !== end.getFullYear() ? ' ' + start.getFullYear() : '') +
      ' – ' + end.getDate() + ' ' + MON[end.getMonth()] + ' ' + end.getFullYear();
    var wk = $('week');
    wk.textContent = '';
    var todayKey = dayKey(new Date());
    for (var i = 0; i < 7; i++) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var k = dayKey(d);
      var row = el('div', 'wk-row');
      row.dataset.key = k;
      if (k === todayKey) row.classList.add('today');
      var head = el('div', 'wk-head');
      head.appendChild(el('span', 'wk-date', DAYS[d.getDay()].slice(0, 3) + ' ' + d.getDate() + ' ' + MON[d.getMonth()]));
      if (k === todayKey) head.appendChild(el('span', 'pill active', 'Today'));
      var left = leftLabel(k);
      if (left) head.appendChild(left);
      row.appendChild(head);
      if (k === selKey && editing) {
        row.classList.add('sel');
        head.appendChild(btn('Done', 'small wk-btn', closeDay));
        row.appendChild($('dayPanel'));
      } else {
        head.appendChild(btn('Edit', 'small wk-btn', function () { selectDay(this.closest('.wk-row').dataset.key); }));
        row.appendChild(checklist(k));
      }
      wk.appendChild(row);
    }
  }

  function renderMonth() {
    $('mLabel').textContent = MONTHS[viewM] + ' ' + viewY;
    var grid = $('grid');
    grid.textContent = '';
    var first = new Date(viewY, viewM, 1);
    var daysIn = new Date(viewY, viewM + 1, 0).getDate();
    var weeks = Math.ceil((first.getDay() + daysIn) / 7);
    var todayKey = dayKey(new Date());
    for (var i = 0; i < weeks * 7; i++) {
      var d = new Date(viewY, viewM, 1 - first.getDay() + i);
      var k = dayKey(d);
      var b = el('button', 'cell');
      b.type = 'button';
      b.dataset.key = k;
      if (d.getMonth() !== viewM) b.classList.add('other');
      if (k === todayKey) b.classList.add('today');
      if (k === selKey) b.classList.add('sel');
      b.appendChild(el('span', 'num', String(d.getDate())));
      fillCell(b, k);
      grid.appendChild(b);
    }
  }
  // A month box shows the first item still to do (+N for more), or turns green when all are done.
  function fillCell(b, k) {
    Array.prototype.forEach.call(b.querySelectorAll('.snip, .more'), function (x) { x.remove(); });
    var items = dayItemsOf(k);
    var todo = items.filter(function (it) { return !it.done; });
    b.classList.toggle('has', todo.length > 0);
    b.classList.toggle('alldone', items.length > 0 && !todo.length);
    if (todo.length) {
      b.appendChild(el('span', 'snip', todo[0].text));
      if (todo.length > 1) b.appendChild(el('span', 'more', '+' + (todo.length - 1)));
    } else if (items.length) {
      b.appendChild(el('span', 'snip', TICK + ' done'));
    }
  }
  function renderDay() {
    var d = keyToDate(selKey);
    $('dayLabel').textContent = DAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    $('dayNote').value = data.days[selKey] || '';
    $('daySaved').textContent = '';
    dayEditKey = selKey;
    panelMode();
  }
  // Month view: the selected day shows as a tick list, or as the text box while editing
  // (or when the day is still empty, so you can just start typing).
  function panelMode() {
    var isWeek = calMode === 'week';
    var has = dayItemsOf(selKey).length > 0;
    var typing = isWeek || editing || !has;
    $('dayNote').hidden = !typing;
    $('dayTip').hidden = !typing;
    $('dayChecks').hidden = typing;
    $('dayChecks').textContent = '';
    if (!typing) $('dayChecks').appendChild(checklist(selKey));
    $('dayEdit').hidden = isWeek || typing;
    $('dayDone').hidden = isWeek || !typing || !has;
  }
  function commitDay() {
    clearTimeout(dayTimer);
    dayTimer = null;
    if (!dayEditKey) return;
    var v = $('dayNote').value;
    var before = data.days[dayEditKey] || '';
    if (v === before || (!v.trim() && !before)) return;
    if (v.trim()) data.days[dayEditKey] = v;
    else delete data.days[dayEditKey];
    if (save()) {
      $('daySaved').textContent = 'Saved';
      var cell = $('grid').querySelector('[data-key="' + dayEditKey + '"]');
      if (cell) fillCell(cell, dayEditKey);
      if (calMode === 'month') $('dayDone').hidden = !dayItemsOf(dayEditKey).length;
      updateBanner();
    }
  }
  $('dayNote').addEventListener('input', function () {
    editing = true;
    $('daySaved').textContent = '';
    clearTimeout(dayTimer);
    dayTimer = setTimeout(commitDay, 500);
  });
  $('dayNote').addEventListener('blur', commitDay);

  function selectDay(k) {
    commitDay();
    selKey = k;
    editing = calMode === 'week'; // in Week view, tapping a day opens it for typing
    var d = keyToDate(k);
    viewY = d.getFullYear(); viewM = d.getMonth();
    renderCal();
  }
  $('grid').addEventListener('click', function (e) {
    var cell = e.target.closest('.cell');
    if (cell) selectDay(cell.dataset.key);
  });
  // Arrows / swipe: a month at a time in Month view, a week at a time in Week view.
  function moveBy(delta) {
    commitDay();
    if (calMode === 'week') {
      var s = keyToDate(selKey);
      selKey = dayKey(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7 * delta));
      s = keyToDate(selKey);
      viewY = s.getFullYear(); viewM = s.getMonth();
    } else {
      var d = new Date(viewY, viewM + delta, 1);
      viewY = d.getFullYear(); viewM = d.getMonth();
    }
    renderCal();
  }
  $('mPrev').addEventListener('click', function () { moveBy(-1); });
  $('mNext').addEventListener('click', function () { moveBy(1); });
  $('btnToday').addEventListener('click', function () { selectDay(dayKey(new Date())); });

  function closeDay() {
    commitDay();
    editing = false;
    renderCal();
  }
  $('dayDone').addEventListener('click', closeDay);
  $('dayEdit').addEventListener('click', function () {
    editing = true;
    panelMode();
    $('dayNote').focus();
  });
  $('week').addEventListener('click', function (e) {
    var row = e.target.closest('.wk-row');
    if (!row || e.target.closest('button')) return;
    if (!row.classList.contains('sel')) selectDay(row.dataset.key);
    else if (e.target.closest('.wk-head')) closeDay(); // tap the open day's heading to close it
  });

  Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
    b.addEventListener('click', function () {
      if (calMode === b.dataset.mode) return;
      commitDay();
      calMode = b.dataset.mode;
      editing = false;
      localStorage.setItem('ct.calMode', calMode);
      // Going to Week after browsing to another month: show that month's first week.
      var s = keyToDate(selKey);
      if (calMode === 'week' && (s.getFullYear() !== viewY || s.getMonth() !== viewM)) {
        var t = new Date();
        selKey = t.getFullYear() === viewY && t.getMonth() === viewM ? dayKey(t) : dayKey(new Date(viewY, viewM, 1));
      }
      renderCal();
      window.scrollTo(0, 0);
    });
  });

  // Swipe left / right on the month or week to move.
  var touchX = null, touchY = null;
  ['grid', 'week'].forEach(function (id) {
    $(id).addEventListener('touchstart', function (e) {
      if (e.target.closest('textarea')) { touchX = null; return; }
      touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
    }, { passive: true });
    $(id).addEventListener('touchend', function (e) {
      if (touchX == null) return;
      var dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
      touchX = null;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 40) moveBy(dx < 0 ? 1 : -1);
    }, { passive: true });
  });

  // ---------- jobs ----------
  function jobById(id) {
    for (var i = 0; i < data.jobs.length; i++) if (data.jobs[i].id === id) return data.jobs[i];
    return null;
  }
  function seriesOf(j) {
    return data.jobs.filter(function (x) { return x.seriesId === j.seriesId; })
      .sort(function (a, b) { return a.created < b.created ? -1 : a.created > b.created ? 1 : 0; });
  }
  function latestNote(j) {
    var best = null;
    j.notes.forEach(function (n) { if (!best || n.at > best.at) best = n; });
    return best;
  }
  function lastActivity(j) {
    var n = latestNote(j);
    return n && n.at > j.created ? n.at : j.created;
  }
  function newJob(title, seriesId) {
    var id = uid();
    var j = { id: id, title: title, seriesId: seriesId || id, status: 'active', created: nowIso(), closed: null, notes: [] };
    data.jobs.push(j);
    return j;
  }

  function jobCard(j) {
    var b = el('button', 'card');
    b.type = 'button';
    b.appendChild(el('div', 'card-title', j.title));
    var s = seriesOf(j), parts = [];
    if (s.length > 1) parts.push('Round ' + (s.indexOf(j) + 1));
    parts.push(plural(j.notes.length, 'note'));
    parts.push(j.status === 'old' ? 'done ' + fmtDate(j.closed) : 'updated ' + fmtDate(lastActivity(j)));
    b.appendChild(el('div', 'card-meta', parts.join(' · ')));
    var last = latestNote(j);
    if (last) b.appendChild(el('div', 'card-snip', firstLine(last.text)));
    b.addEventListener('click', function () { openJob(j.id); });
    return b;
  }

  // Active jobs are in the user's own order (job.rank, 0 = top), set by dragging.
  // Jobs without a rank yet (new ones) go to the top.
  function activeInOrder() {
    var jobs = data.jobs.filter(function (j) { return j.status === 'active'; });
    var unranked = jobs.filter(function (j) { return typeof j.rank !== 'number'; })
      .sort(function (a, b) { return lastActivity(a) < lastActivity(b) ? 1 : -1; });
    var ranked = jobs.filter(function (j) { return typeof j.rank === 'number'; })
      .sort(function (a, b) { return a.rank - b.rank || (lastActivity(a) < lastActivity(b) ? 1 : -1); });
    return unranked.concat(ranked);
  }
  function setRanks(jobs) {
    var changed = false;
    jobs.forEach(function (j, i) { if (j.rank !== i) { j.rank = i; changed = true; } });
    return changed;
  }

  function renderActive() {
    var list = $('activeList');
    list.textContent = '';
    var jobs = activeInOrder();
    if (!readOnly && setRanks(jobs)) save();
    jobs.forEach(function (j) {
      var row = el('div', 'job-row');
      row.dataset.id = j.id;
      row.appendChild(el('span', 'grip', '≡'));
      row.appendChild(jobCard(j));
      row.appendChild(el('span', 'grip', '≡'));
      list.appendChild(row);
    });
    $('activeEmpty').hidden = jobs.length > 0;
    $('dragTip').hidden = jobs.length < 2;
  }

  // Drag a job up or down by the grip on its left or right edge.
  var drag = null;
  $('activeList').addEventListener('pointerdown', function (e) {
    var grip = e.target.closest('.grip');
    if (!grip || drag) return;
    e.preventDefault();
    var row = grip.closest('.job-row');
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    drag = { row: row, grip: grip, id: e.pointerId, startY: e.pageY, origTop: row.offsetTop, lastY: e.pageY };
    row.classList.add('dragging');
  });
  function dragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    // Scroll the page when dragging near the top or bottom of the screen.
    if (e.clientY < 90) window.scrollBy(0, -10);
    else if (e.clientY > window.innerHeight - 130) window.scrollBy(0, 10);
    var y = e.clientY + window.scrollY;
    drag.lastY = y;
    var row = drag.row, list = $('activeList');
    var prev = row.previousElementSibling, next = row.nextElementSibling;
    if (next && y > mid(next)) list.insertBefore(next, row);
    else if (prev && y < mid(prev)) list.insertBefore(row, prev);
    row.style.transform = 'translateY(' + ((y - drag.startY) - (row.offsetTop - drag.origTop)) + 'px)';
  }
  function mid(elm) {
    var r = elm.getBoundingClientRect();
    return r.top + window.scrollY + r.height / 2;
  }
  function dragEnd(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var row = drag.row;
    row.classList.remove('dragging');
    row.style.transform = '';
    drag = null;
    var order = Array.prototype.map.call($('activeList').querySelectorAll('.job-row'), function (r) {
      return jobById(r.dataset.id);
    }).filter(Boolean);
    if (setRanks(order)) save();
    renderActive();
  }
  $('activeList').addEventListener('pointermove', dragMove);
  $('activeList').addEventListener('pointerup', dragEnd);
  $('activeList').addEventListener('pointercancel', dragEnd);

  // The month a job is filed under in Old jobs: the one the user picked,
  // otherwise the month it was finished.
  function jobMonth(j) {
    return j.month || monthKey(new Date(j.closed || j.created));
  }

  var collapsedMonths = {};

  function renderOld() {
    var list = $('oldList');
    list.textContent = '';
    var q = $('oldSearch').value.trim().toLowerCase();
    var all = data.jobs.filter(function (j) { return j.status === 'old'; });
    var jobs = all.filter(function (j) {
      if (!q) return true;
      if (j.title.toLowerCase().indexOf(q) >= 0) return true;
      return j.notes.some(function (n) { return n.text.toLowerCase().indexOf(q) >= 0; });
    }).sort(function (a, b) {
      var ma = jobMonth(a), mb = jobMonth(b);
      if (ma !== mb) return ma < mb ? 1 : -1;
      return a.closed < b.closed ? 1 : -1;
    });
    var counts = {};
    jobs.forEach(function (j) { var m = jobMonth(j); counts[m] = (counts[m] || 0) + 1; });
    var cur = null;
    jobs.forEach(function (j) {
      var m = jobMonth(j);
      var shut = !q && collapsedMonths[m];
      if (m !== cur) {
        cur = m;
        var h = el('button', 'month-head' + (shut ? ' shut' : ''));
        h.type = 'button';
        h.dataset.month = m;
        h.appendChild(el('span', 'month-name', monthLabel(m)));
        h.appendChild(el('span', 'month-count', plural(counts[m], 'job')));
        h.addEventListener('click', function () {
          collapsedMonths[m] = !collapsedMonths[m];
          renderOld();
        });
        list.appendChild(h);
      }
      if (!shut) list.appendChild(jobCard(j));
    });
    var empty = $('oldEmpty');
    empty.hidden = jobs.length > 0;
    empty.textContent = all.length ? 'No old jobs match that search.' : 'No old jobs yet. When you mark a job as done, it moves here.';
  }
  $('oldSearch').addEventListener('input', renderOld);

  function addJobFromInput() {
    var t = $('newJobTitle').value.trim();
    if (!t) return;
    var j = newJob(t);
    if (!save()) return;
    $('newJobTitle').value = '';
    $('newJobTitle').blur();
    renderActive();
    updateBanner();
    openJob(j.id);
  }
  $('newJobGo').addEventListener('click', addJobFromInput);
  $('newJobTitle').addEventListener('keydown', function (e) { if (e.key === 'Enter') addJobFromInput(); });

  // ---------- job detail ----------
  var openId = null;
  var editingNoteId = null;

  function openJob(id) {
    flushAll();
    openId = id;
    editingNoteId = null;
    $('prevToggle').checked = false;
    $('noteNew').value = '';
    $('sheet-job').hidden = false;
    $('sheet-job').scrollTop = 0;
    renderJob();
  }
  function closeJob() {
    commitTitle();
    openId = null;
    editingNoteId = null;
    $('sheet-job').hidden = true;
    renderTab();
  }
  $('jobBack').addEventListener('click', closeJob);

  function commitTitle() {
    var j = openId && jobById(openId);
    if (!j) return;
    var t = $('jobTitle').value.trim();
    if (t && t !== j.title) { j.title = t; save(); }
    else if (!t) $('jobTitle').value = j.title;
  }
  $('jobTitle').addEventListener('blur', commitTitle);
  $('jobTitle').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('jobTitle').blur(); });

  function renderJob() {
    var j = jobById(openId);
    if (!j) { closeJob(); return; }
    var isOld = j.status === 'old';
    var pill = $('jobStatus');
    pill.textContent = isOld ? 'Done' : 'Active';
    pill.className = 'pill ' + (isOld ? 'old' : 'active');
    if (document.activeElement !== $('jobTitle')) $('jobTitle').value = j.title;

    var s = seriesOf(j);
    var meta = ['Started ' + fmtDate(j.created)];
    if (isOld) meta.push('done ' + fmtDate(j.closed));
    if (s.length > 1) meta.push('round ' + (s.indexOf(j) + 1) + ' of ' + s.length);
    $('jobMeta').textContent = meta.join(' · ');

    $('jobMonth').value = isOld ? jobMonth(j) : (j.month || '');
    $('monthHint').textContent = isOld
      ? 'This job is listed under ' + monthLabel(jobMonth(j)) + ' in Old jobs.'
      : j.month
        ? 'When done, it will be listed under ' + monthLabel(j.month) + ' in Old jobs.'
        : 'Optional. When done, it will be listed under the month you finish it, unless you pick a month here.';

    // Notes from the other rounds of a recurring job.
    var others = s.filter(function (x) { return x !== j && x.notes.length; }).reverse();
    var otherCount = others.reduce(function (n, x) { return n + x.notes.length; }, 0);
    $('prevWrap').hidden = otherCount === 0;
    $('prevLabel').textContent = (isOld ? 'Show notes from other rounds' : 'Show previous notes') + ' (' + otherCount + ')';
    var prev = $('prevNotes');
    prev.textContent = '';
    prev.hidden = !$('prevToggle').checked;
    if ($('prevToggle').checked) {
      others.forEach(function (x) {
        var head = 'Round ' + (s.indexOf(x) + 1) + ' · ' + fmtDate(x.created) +
          (x.closed ? ' to ' + fmtDate(x.closed) : ' (active)');
        prev.appendChild(el('div', 'round-head', head));
        sortedNotes(x).forEach(function (n) {
          var box = el('div', 'note past');
          box.appendChild(el('div', 'note-when', fmtDateTime(n.at)));
          box.appendChild(el('div', 'note-text', n.text));
          prev.appendChild(box);
        });
      });
    }

    // This job's own notes, newest first.
    var list = $('jobNotes');
    list.textContent = '';
    sortedNotes(j).forEach(function (n) { list.appendChild(noteBox(j, n)); });
    $('jobNoNotes').hidden = j.notes.length > 0;

    // Actions
    var act = $('jobActions');
    act.textContent = '';
    if (!isOld) {
      act.appendChild(btn('Mark as done (move to Old jobs)', '', function () { finishJob(j, false); }));
      act.appendChild(btn('Done, and start the next round', '', function () { finishJob(j, true); }));
    } else {
      act.appendChild(btn('Start a new round of this job', '', function () { startRound(j); }));
      act.appendChild(btn('Move back to Active jobs', '', function () { reopenJob(j); }));
    }
    act.appendChild(btn('Delete this job', 'danger', function () { deleteJob(j); }));
  }

  function sortedNotes(j) {
    return j.notes.slice().sort(function (a, b) { return a.at < b.at ? 1 : -1; });
  }

  function noteBox(j, n) {
    var box = el('div', 'note');
    box.appendChild(el('div', 'note-when', fmtDateTime(n.at)));
    if (editingNoteId === n.id) {
      var ta = el('textarea');
      ta.value = n.text;
      box.appendChild(ta);
      var row = el('div', 'note-btns');
      row.appendChild(btn('Save', 'link', function () {
        var v = ta.value;
        if (!v.trim()) return;
        n.text = v;
        editingNoteId = null;
        save();
        renderJob();
      }));
      row.appendChild(btn('Cancel', 'link', function () { editingNoteId = null; renderJob(); }));
      box.appendChild(row);
      setTimeout(function () { ta.focus(); }, 0);
    } else {
      box.appendChild(el('div', 'note-text', n.text));
      var btns = el('div', 'note-btns');
      btns.appendChild(btn('Edit', 'link', function () { editingNoteId = n.id; renderJob(); }));
      btns.appendChild(btn('Delete', 'link danger', function () {
        if (!confirm('Delete this note?')) return;
        j.notes = j.notes.filter(function (x) { return x !== n; });
        save();
        renderJob();
      }));
      box.appendChild(btns);
    }
    return box;
  }

  $('noteAdd').addEventListener('click', function () {
    var j = jobById(openId), v = $('noteNew').value;
    if (!j || !v.trim()) return;
    j.notes.push({ id: uid(), at: nowIso(), text: v });
    if (!save()) return;
    $('noteNew').value = '';
    $('noteNew').blur();
    renderJob();
    updateBanner();
  });
  $('prevToggle').addEventListener('change', renderJob);

  $('jobMonth').addEventListener('change', function () {
    var j = jobById(openId);
    if (!j) return;
    var v = $('jobMonth').value;
    if (/^\d{4}-\d{2}$/.test(v)) j.month = v;
    else delete j.month;
    save();
    renderJob();
  });

  function finishJob(j, repeat) {
    commitTitle();
    j.status = 'old';
    j.closed = nowIso();
    if (!j.month) j.month = monthKey(new Date());
    var next = repeat ? newJob(j.title, j.seriesId) : null;
    if (next && typeof j.rank === 'number') next.rank = j.rank;
    save();
    if (next) { openJob(next.id); toast('Next round started. Old notes are under "Show previous notes".'); }
    else { closeJob(); toast('Moved to Old jobs'); }
  }
  function startRound(j) {
    var next = newJob(j.title, j.seriesId);
    save();
    showTab('active');
    openJob(next.id);
    toast('New round started in Active jobs');
  }
  function reopenJob(j) {
    j.status = 'active';
    j.closed = null;
    delete j.rank;
    save();
    closeJob();
    toast('Moved back to Active jobs');
  }
  function deleteJob(j) {
    if (!confirm('Delete "' + j.title + '" and its ' + plural(j.notes.length, 'note') + "? This can't be undone.")) return;
    data.jobs = data.jobs.filter(function (x) { return x !== j; });
    save();
    closeJob();
    toast('Job deleted');
  }

  // ---------- backup banner ----------
  function daysSinceBackup() {
    var lb = localStorage.getItem(KEY_BACKUP);
    if (!lb) return null;
    return Math.floor((Date.now() - new Date(lb).getTime()) / 864e5);
  }
  function updateBanner() {
    var b = $('backupBanner'), d = daysSinceBackup();
    if (readOnly) { b.hidden = false; b.textContent = readOnly; return; }
    var show = hasAnything() && (d === null || d >= BACKUP_NAG_DAYS);
    b.hidden = !show;
    if (show) {
      b.textContent = (d === null ? "You haven't backed up yet." : 'Last backup was ' + d + ' days ago.') +
        ' Tap here to make a backup.';
    }
  }
  $('backupBanner').addEventListener('click', openSettings);

  // ---------- settings ----------
  function openSettings() {
    flushAll();
    $('exportPw').value = '';
    $('shareGo').hidden = true;
    $('importPwWrap').hidden = true;
    $('pwForm').hidden = true;
    pendingFile = null;
    $('sheet-settings').hidden = false;
    $('sheet-settings').scrollTop = 0;
    renderSettings();
  }
  function closeSettings() {
    $('sheet-settings').hidden = true;
    pendingImport = null;
    pendingFile = null;
    renderTab();
    updateBanner();
  }
  $('btnSettings').addEventListener('click', openSettings);
  $('setBack').addEventListener('click', closeSettings);

  function renderSettings() {
    var lb = localStorage.getItem(KEY_BACKUP), d = daysSinceBackup();
    $('backupInfo').textContent = lb
      ? 'Last backup: ' + fmtDate(lb) + (d === 0 ? ' (today)' : ' (' + plural(d, 'day') + ' ago)') + '.'
      : "You haven't made a backup yet.";
    var noteCount = data.jobs.reduce(function (n, j) { return n + j.notes.length; }, 0);
    var info = 'This phone holds ' + plural(Object.keys(data.days).length, 'calendar day') + ' with notes and ' +
      plural(data.jobs.length, 'job') + ' (' + plural(noteCount, 'job note') + '). Nothing is stored online.';
    $('storageInfo').textContent = info;
    var snap = getSnapshot();
    $('snapInfo').textContent = snap
      ? 'The app keeps one automatic copy a day. Latest: ' + fmtDateTime(snap.at) + ' (' + summary(snap.data) + ').'
      : 'The app keeps one automatic copy a day. There isn\'t one yet.';
    $('snapGo').hidden = !snap;
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then(function (p) {
        $('storageInfo').textContent = info + (p ? ' The phone has agreed to keep this data.' : '');
      }).catch(function () {});
    }
  }

  // Export: build the file first, then share it. iPhone only lets the share menu
  // open straight after a tap, so if building took too long we show a second button.
  var pendingFile = null;

  function buildBackup(pw) {
    var payload = { app: 'calendar_track', schema: SCHEMA, exported: nowIso() };
    var name = 'calendar_track_backup_' + dayKey(new Date()) + '.json';
    var done = function () {
      return new File([JSON.stringify(payload, null, pw ? 0 : 1)], name, { type: 'application/json' });
    };
    if (!pw) {
      payload.encrypted = false;
      payload.data = data;
      return Promise.resolve(done());
    }
    var salt = rand(16), iv = rand(12);
    return aesKey(pw, salt, EXPORT_ITER).then(function (key) {
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(JSON.stringify(data)));
    }).then(function (ct) {
      payload.encrypted = true;
      payload.kdf = { name: 'PBKDF2', hash: 'SHA-256', iter: EXPORT_ITER, salt: toB64(salt) };
      payload.iv = toB64(iv);
      payload.data = toB64(ct);
      return done();
    });
  }

  function deliver(file) {
    if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: file.name }).then(function () { return 'shared'; });
    }
    var a = el('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return Promise.resolve('downloaded');
  }
  function backupDone() {
    localStorage.setItem(KEY_BACKUP, nowIso());
    pendingFile = null;
    $('shareGo').hidden = true;
    $('exportPw').value = '';
    renderSettings();
    updateBanner();
    toast('Backup made');
  }
  function deliverAndRecord(file) {
    return deliver(file).then(backupDone, function (e) {
      if (e && e.name === 'AbortError') return; // user closed the share menu
      if (e && e.name === 'NotAllowedError') {
        pendingFile = file;
        $('shareGo').hidden = false;
        return;
      }
      throw e;
    });
  }

  $('exportGo').addEventListener('click', guard(function () {
    flushAll();
    var pw = $('exportPw').value;
    if (!pw && !confirm("No password set, so anyone who gets this file can read it. Make an unprotected backup anyway?")) return;
    return buildBackup(pw).then(deliverAndRecord);
  }));
  $('shareGo').addEventListener('click', guard(function () {
    if (pendingFile) return deliverAndRecord(pendingFile);
  }));

  // Import
  var pendingImport = null;
  $('importGo').addEventListener('click', function () {
    $('importFile').value = '';
    $('importFile').click();
  });
  $('importFile').addEventListener('change', function () {
    var f = $('importFile').files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      var p;
      try { p = JSON.parse(r.result); } catch (e) { p = null; }
      if (!p || p.app !== 'calendar_track') { alert("That file isn't a Calendar Track backup."); return; }
      if (p.encrypted) {
        pendingImport = p;
        $('importPw').value = '';
        $('importErr').textContent = '';
        $('importPwWrap').hidden = false;
        return;
      }
      finishImport(p.data);
    };
    r.onerror = function () { alert("Couldn't read that file."); };
    r.readAsText(f);
  });
  $('importOpen').addEventListener('click', guard(function () {
    var p = pendingImport;
    if (!p) return;
    var pw = $('importPw').value;
    return aesKey(pw, fromB64(p.kdf.salt), p.kdf.iter).then(function (key) {
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(p.iv) }, key, fromB64(p.data));
    }).then(function (plain) {
      $('importPwWrap').hidden = true;
      pendingImport = null;
      finishImport(JSON.parse(dec.decode(plain)));
    }, function () {
      $('importErr').textContent = 'Wrong password for this backup file.';
    });
  }));
  $('importPw').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('importOpen').click(); });

  function summary(d) {
    var notes = d.jobs.reduce(function (n, j) { return n + j.notes.length; }, 0);
    return plural(Object.keys(d.days).length, 'calendar day') + ', ' + plural(d.jobs.length, 'job') + ', ' + plural(notes, 'job note');
  }
  function finishImport(raw) {
    var clean;
    try { clean = normalise(raw); } catch (e) { alert('That backup file is damaged.'); return; }
    if (!confirm('Replace everything in the app with this backup?\n\nBackup: ' + summary(clean) +
      '\nIn the app now: ' + summary(data))) return;
    if (readOnly) { alert(readOnly); return; }
    localStorage.setItem(KEY_DATA + '.before-import', JSON.stringify(data));
    data = clean;
    if (!save()) return;
    renderSettings();
    updateBanner();
    toast('Backup restored');
  }

  // Undo to the automatic daily copy
  function getSnapshot() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY_SNAPSHOT) || 'null');
      if (s && s.at && s.data) { s.data = normalise(s.data); return s; }
    } catch (e) { /* ignore */ }
    return null;
  }
  $('snapGo').addEventListener('click', function () {
    var s = getSnapshot();
    if (!s) return;
    if (!confirm('Go back to the automatic copy from ' + fmtDateTime(s.at) + '?\n\nCopy: ' + summary(s.data) +
      '\nIn the app now: ' + summary(data) + '\n\nAnything added since then will be lost.')) return;
    if (readOnly) { alert(readOnly); return; }
    localStorage.setItem(KEY_DATA + '.before-undo', JSON.stringify(data));
    data = s.data;
    if (!save()) return;
    renderSettings();
    toast('Restored the automatic copy');
  });

  // Change password
  $('pwChange').addEventListener('click', function () {
    var f = $('pwForm');
    f.hidden = !f.hidden;
    ['pwOld', 'pwNew1', 'pwNew2'].forEach(function (id) { $(id).value = ''; });
    $('pwErr').textContent = '';
  });
  $('pwSave').addEventListener('click', guard(function () {
    var a = $('pwNew1').value, b = $('pwNew2').value;
    return checkPassword($('pwOld').value).then(function (ok) {
      if (!ok) { $('pwErr').textContent = 'Current password is wrong.'; return; }
      var p = pwProblem(a, b);
      if (p) { $('pwErr').textContent = p; return; }
      return setNewPassword(a).then(function () {
        $('pwForm').hidden = true;
        toast('Password changed');
      });
    });
  }));

  // ---------- start ----------
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  $('installTip').hidden = !(isIOS && !standalone);

  if (!window.crypto || !crypto.subtle) {
    document.body.textContent = 'This app needs a secure (https) connection to run.';
    return;
  }

  showLock(getLock() ? 'unlock' : 'setup');

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
