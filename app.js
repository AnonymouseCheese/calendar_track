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
  function toast(msg, undo) {
    var t = $('toast');
    t.textContent = msg;
    if (undo) {
      t.appendChild(btn('Undo', 'toast-undo', function () {
        t.hidden = true;
        clearTimeout(toastTimer);
        undo();
      }));
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, undo ? 5000 : 2200);
  }
  function shortText(s) { return s.length > 28 ? s.slice(0, 27) + '\u2026' : s; }

  // ---------- data ----------
  function emptyData() { return { schema: SCHEMA, days: {}, jobs: [] }; }

  // Cleans up data from storage or from a backup file, so a bad file can't break the app.
  // Fields this version doesn't know about are kept, so newer data is never stripped.
  function normalise(d) {
    if (!d || typeof d !== 'object') throw new Error('not data');
    var out = Object.assign({}, d, emptyData());
    ['stageLib', 'miscStageLib'].forEach(function (key) {
      if (Array.isArray(d[key])) {
        out[key] = [];
        d[key].forEach(function (n) {
          if (typeof n === 'string' && n.trim() && out[key].indexOf(n.trim()) < 0) out[key].push(n.trim());
        });
      } else {
        delete out[key];
      }
    });
    if (d.days && typeof d.days === 'object') {
      Object.keys(d.days).forEach(function (k) {
        var v = d.days[k];
        if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'string' && v.trim()) out.days[k] = v;
      });
    }
    if (Array.isArray(d.jobs)) {
      d.jobs.forEach(function (j) {
        var c = normJob(j);
        if (c) out.jobs.push(c);
      });
    }
    // Recycle bin: deleted jobs, kept whole so they can be restored.
    if (Array.isArray(d.bin)) {
      out.bin = [];
      d.bin.forEach(function (b) {
        var c = b && normJob(b.job);
        if (c) out.bin.push({ job: c, deletedAt: str(b.deletedAt) || nowIso() });
      });
    } else {
      delete out.bin;
    }
    return out;
  }
  function normJob(j) {
    if (!j || typeof j !== 'object') return null;
    var id = str(j.id) || uid();
    return Object.assign({}, j, {
      id: id,
      title: str(j.title) || (j.kind === 'misc' ? 'Untitled item' : 'Untitled job'),
      kind: j.kind === 'misc' ? 'misc' : undefined,
      seriesId: str(j.seriesId) || id,
      status: j.status === 'old' ? 'old' : 'active',
      created: str(j.created) || nowIso(),
      closed: j.status === 'old' ? (str(j.closed) || nowIso()) : null,
      month: /^\d{4}-\d{2}$/.test(str(j.month)) ? j.month : undefined,
      rank: typeof j.rank === 'number' && isFinite(j.rank) ? j.rank : undefined,
      stages: Array.isArray(j.stages) ? j.stages.filter(function (st) {
        return st && typeof st.name === 'string' && st.name.trim();
      }).map(function (st) {
        var day = /^\d{4}-\d{2}-\d{2}$/;
        return Object.assign({}, st, {
          id: str(st.id) || uid(), name: st.name.trim(), done: !!st.done,
          doneAt: st.done && day.test(str(st.doneAt)) ? st.doneAt : null,
          due: day.test(str(st.due)) ? st.due : null,
          note: typeof st.note === 'string' && st.note ? st.note : undefined
        });
      }) : undefined,
      notes: (Array.isArray(j.notes) ? j.notes : []).filter(function (n) {
        return n && typeof n.text === 'string';
      }).map(function (n) {
        return Object.assign({}, n, { id: str(n.id) || uid(), at: str(n.at) || nowIso(), text: n.text });
      })
    });
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
    $('sheet-bin').hidden = true;
    $('sheet-overview').hidden = true;
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
  $('codeDone').addEventListener('click', function () { $('codeShow').textContent = ''; startSession(); unlock(); });

  $('unlockGo').addEventListener('click', guard(function () {
    var pw = $('unlockPw').value;
    if (!pw) return;
    return checkPassword(pw).then(function (ok) {
      if (ok) { startSession(); unlock(); }
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
      return setNewPassword(a).then(function () { startSession(); unlock(); toast('New password set'); });
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
    endSession();
    showLock(getLock() ? 'unlock' : 'setup');
  }
  $('btnLock').addEventListener('click', lockNow);

  // How long the password lasts once typed (Settings > Password).
  //   'always' = ask every time (locks after 2 min in the background)
  //   '1h' / '4h' = stay unlocked that long, even if the app is closed (4h is the default)
  //   'day' = stay unlocked until midnight
  var KEY_LOCKMODE = 'ct.lockMode';
  var KEY_UNTIL = 'ct.unlockUntil';
  function lockMode() {
    var m = localStorage.getItem(KEY_LOCKMODE);
    return m === 'always' || m === '1h' || m === 'day' ? m : '4h';
  }
  function sessionEnd(mode) {
    var now = new Date();
    if (mode === '1h') return now.getTime() + 3600e3;
    if (mode === '4h') return now.getTime() + 4 * 3600e3;
    if (mode === 'day') return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    return 0;
  }
  function startSession() {
    var until = sessionEnd(lockMode());
    if (until) localStorage.setItem(KEY_UNTIL, String(until));
    else localStorage.removeItem(KEY_UNTIL);
  }
  function endSession() { localStorage.removeItem(KEY_UNTIL); }
  function sessionValid() {
    return lockMode() !== 'always' && Date.now() < (+localStorage.getItem(KEY_UNTIL) || 0);
  }

  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      flushAll();
      hiddenAt = Date.now();
    } else if (unlocked && !sessionValid() &&
      (lockMode() !== 'always' || (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS))) {
      lockNow();
    }
  });
  // If the app is left open past the end of the unlocked period, lock it.
  setInterval(function () {
    if (unlocked && lockMode() !== 'always' && !sessionValid()) lockNow();
  }, 60000);

  $('lockMode').addEventListener('change', function () {
    localStorage.setItem(KEY_LOCKMODE, $('lockMode').value);
    if (unlocked) startSession(); // counts from now
    renderLockInfo();
  });
  function renderLockInfo() {
    $('lockMode').value = lockMode();
    var until = +localStorage.getItem(KEY_UNTIL) || 0;
    $('lockInfo').textContent = lockMode() === 'always' || !until ? ''
      : 'Unlocked until ' + (dayKey(new Date(until - 1)) === dayKey(new Date()) && lockMode() === 'day'
        ? 'midnight tonight.' : fmtDateTime(new Date(until).toISOString()) + '.');
  }
  window.addEventListener('pagehide', flushAll);

  function flushAll() {
    if (!unlocked) return;
    commitDay();
    commitTitle();
  }

  // ---------- tabs ----------
  var tab = 'calendar';
  var TITLES = { calendar: 'Calendar', active: 'Active jobs', old: 'Old jobs' };
  // Active and Old each have a Jobs | Misc switch. Misc items work like jobs.
  var listKind = localStorage.getItem('ct.listKind') === 'misc' ? 'misc' : 'job';
  function ofKind(j) { return (j.kind === 'misc' ? 'misc' : 'job') === listKind; }
  function kindWords() {
    return listKind === 'misc'
      ? { active: 'Active misc', old: 'Old misc', add: 'New misc item', none: 'No misc items. Type a name above to add one, e.g. "Renew licence".',
        noneOld: 'No old misc items yet. When you mark one as done, it moves here.', search: 'Search old misc items and notes' }
      : { active: 'Active jobs', old: 'Old jobs', add: 'New job title', none: 'No active jobs. Type a title above to add one.',
        noneOld: 'No old jobs yet. When you mark a job as done, it moves here.', search: 'Search old jobs and their notes' };
  }
  function showTab(t) {
    flushAll();
    tab = t;
    ['calendar', 'active', 'old'].forEach(function (v) { $('view-' + v).hidden = v !== t; });
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.classList.toggle('on', b.dataset.tab === t);
    });
    $('viewTitle').textContent = t === 'calendar' ? TITLES[t] : kindWords()[t];
    renderTab();
    window.scrollTo(0, 0);
  }
  function renderTab() {
    if (tab === 'calendar') renderCal();
    else if (tab === 'active') renderActive();
    else renderOld();
    if (tab !== 'calendar') renderKindBar();
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
    var wasDone = TICK_RE.test(raw);
    lines[idx] = wasDone ? raw.replace(TICK_RE, '$1') : raw.replace(/^(\s*)/, '$1' + TICK + ' ');
    data.days[k] = lines.join('\n');
    if (!save()) return;
    renderCal();
    var text = raw.replace(TICK_RE, '').trim();
    toast((wasDone ? 'Unticked: ' : 'Ticked: ') + shortText(text), function () {
      var now = (data.days[k] || '').split('\n');
      if (now[idx] !== lines[idx]) return; // changed since, leave it alone
      now[idx] = raw;
      data.days[k] = now.join('\n');
      if (save()) renderCal();
    });
  }
  // Job stages due on a day (active jobs only) show up on the calendar too.
  function stageItemsOn(k) {
    var out = [];
    data.jobs.forEach(function (j) {
      if (j.status !== 'active' || !j.stages) return;
      j.stages.forEach(function (st) { if (st.due === k) out.push({ job: j, st: st }); });
    });
    return out;
  }
  function allItemsOf(k) {
    return dayItemsOf(k).concat(stageItemsOn(k).map(function (s) {
      return { done: s.st.done, text: s.job.title + ': ' + s.st.name };
    }));
  }
  function toggleStageFromCal(jobId, stId) {
    commitDay();
    var j = jobById(jobId);
    var st = j && (j.stages || []).filter(function (s) { return s.id === stId; })[0];
    if (!st) return;
    var before = { done: st.done, doneAt: st.doneAt };
    toggleStage(st);
    if (!save()) return;
    renderCal();
    toast((before.done ? 'Unticked: ' : 'Ticked: ') + shortText(j.title + ': ' + st.name), function () {
      st.done = before.done;
      st.doneAt = before.doneAt;
      if (save()) renderCal();
    });
  }
  function tickBox(done, label) {
    var b = el('span', 'box');
    b.setAttribute('role', 'checkbox');
    b.setAttribute('aria-checked', done ? 'true' : 'false');
    b.setAttribute('aria-label', label);
    return b;
  }
  function checklist(k, onlyStages) {
    var items = onlyStages ? [] : dayItemsOf(k);
    var stages = stageItemsOn(k);
    if (!items.length && !stages.length) return onlyStages ? null : el('div', 'wk-empty', 'Nothing');
    var ul = el('ul', 'checks');
    stages.forEach(function (s) {
      var li = el('li', 'check jobstage' + (s.st.done ? ' done' : ''));
      li.dataset.kind = 'stage';
      li.dataset.job = s.job.id;
      li.dataset.stage = s.st.id;
      li.appendChild(tickBox(s.st.done, s.job.title + ': ' + s.st.name));
      li.appendChild(el('span', 'txt', s.job.title + ': ' + s.st.name));
      ul.appendChild(li);
    });
    items.forEach(function (it) {
      var li = el('li', 'check' + (it.done ? ' done' : ''));
      li.dataset.key = k;
      li.dataset.idx = it.i;
      li.appendChild(tickBox(it.done, it.text));
      li.appendChild(el('span', 'txt', it.text));
      ul.appendChild(li);
    });
    return ul;
  }
  function leftLabel(k) {
    var items = allItemsOf(k);
    if (!items.length) return null;
    var left = items.filter(function (it) { return !it.done; }).length;
    return left ? el('span', 'left', left + ' left') : el('span', 'left all', 'All done');
  }
  // Ticking works anywhere a checklist is shown, but only on the box itself so a
  // stray tap on the text doesn't tick anything. Every tick offers Undo.
  document.addEventListener('click', function (e) {
    var box = e.target.closest && e.target.closest('.check .box');
    if (!box || !unlocked) return;
    var li = box.closest('.check');
    e.stopPropagation();
    if (li.dataset.kind === 'stage') toggleStageFromCal(li.dataset.job, li.dataset.stage);
    else toggleItem(li.dataset.key, +li.dataset.idx);
  }, true);

  function renderCal() {
    parkPanel();
    var isWeek = calMode === 'week';
    Array.prototype.forEach.call(document.querySelectorAll('#calSeg button'), function (b) {
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
    var items = allItemsOf(k);
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
    // While typing, still show that day's job stages (they aren't part of the text).
    var list = typing ? checklist(selKey, true) : checklist(selKey);
    $('dayChecks').textContent = '';
    $('dayChecks').hidden = !list;
    if (list) $('dayChecks').appendChild(list);
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

  Array.prototype.forEach.call(document.querySelectorAll('#calSeg button'), function (b) {
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
  function newJob(title, seriesId, kind) {
    var id = uid();
    var j = { id: id, title: title, seriesId: seriesId || id, status: 'active', created: nowIso(), closed: null, notes: [] };
    if (kind === 'misc') j.kind = 'misc';
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
    var sum = stageSummary(j);
    if (sum && j.status === 'active') {
      b.appendChild(el('div', 'card-stage' + (sum.late ? ' late' : sum.all ? ' all' : ''), sum.text));
      var bar = el('div', 'bar'), fill = el('span');
      fill.style.width = sum.pct + '%';
      bar.appendChild(fill);
      b.appendChild(bar);
    }
    var last = latestNote(j);
    if (last) b.appendChild(el('div', 'card-snip', firstLine(last.text)));
    b.addEventListener('click', function () { openJob(j.id); });
    return b;
  }

  // Active jobs are in the user's own order (job.rank, 0 = top), set by dragging.
  // Jobs without a rank yet (new ones) go to the top.
  function activeInOrder() {
    var jobs = data.jobs.filter(function (j) { return j.status === 'active' && ofKind(j); });
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

  function renderKindBar() {
    Array.prototype.forEach.call(document.querySelectorAll('.kind-seg button'), function (b) {
      b.classList.toggle('on', b.dataset.kind === listKind);
    });
    $('newJobTitle').placeholder = kindWords().add;
    $('oldSearch').placeholder = kindWords().search;
    $('viewTitle').textContent = kindWords()[tab] || $('viewTitle').textContent;
  }
  Array.prototype.forEach.call(document.querySelectorAll('.kind-seg button'), function (b) {
    b.addEventListener('click', function () {
      if (listKind === b.dataset.kind) return;
      listKind = b.dataset.kind;
      localStorage.setItem('ct.listKind', listKind);
      renderTab();
    });
  });

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
    $('ovOpen').hidden = !jobs.length;
    $('activeEmpty').textContent = kindWords().none;
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
    var all = data.jobs.filter(function (j) { return j.status === 'old' && ofKind(j); });
    var jobs = all.filter(function (j) {
      if (!q) return true;
      if (j.title.toLowerCase().indexOf(q) >= 0) return true;
      return j.notes.some(function (n) { return n.text.toLowerCase().indexOf(q) >= 0; }) ||
        stageNotesOf(j).some(function (st) { return st.note.toLowerCase().indexOf(q) >= 0; });
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
    empty.textContent = all.length ? 'Nothing matches that search.' : kindWords().noneOld;
    var nBin = (data.bin || []).length;
    $('binOpen').hidden = !nBin;
    $('binOpen').textContent = 'Recycle bin (' + nBin + ')';
  }
  $('oldSearch').addEventListener('input', renderOld);

  function addJobFromInput() {
    var t = $('newJobTitle').value.trim();
    if (!t) return;
    var j = newJob(t, null, listKind);
    if (!save()) return;
    $('newJobTitle').value = '';
    $('newJobTitle').blur();
    renderActive();
    updateBanner();
    openJob(j.id);
  }
  $('newJobGo').addEventListener('click', addJobFromInput);
  $('newJobTitle').addEventListener('keydown', function (e) { if (e.key === 'Enter') addJobFromInput(); });

  // ---------- stages (job timeline) ----------
  // A job can have stages (quotation, printing, ...). Not every job needs every
  // stage, so a job starts with none and the user taps the ones it needs from a
  // list of names (data.stageLib, editable in settings). Stage = { id, name,
  // done, doneAt 'YYYY-MM-DD', due 'YYYY-MM-DD' }.
  var DEFAULT_STAGES = ['Quotation', 'Jobsheet created', 'Printing', 'Inserting',
    'Ready for delivery', 'Delivery date', 'Delivered', 'Billing'];
  var stageUi = { addOpen: false, newOpen: false, editId: null };

  function isDay(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
  function libKey(kind) { return kind === 'misc' ? 'miscStageLib' : 'stageLib'; }
  // Jobs start with the usual print stages; misc items start with none and
  // remember the names typed on them.
  function stageLib(kind) {
    var l = data[libKey(kind)];
    return Array.isArray(l) ? l : (kind === 'misc' ? [] : DEFAULT_STAGES.slice());
  }
  function setLib(kind, list) { data[libKey(kind)] = list; }
  function libIndex(name, kind) {
    var lib = stageLib(kind), n = name.toLowerCase();
    for (var i = 0; i < lib.length; i++) if (lib[i].toLowerCase() === n) return i;
    return -1;
  }
  function fmtDay(k) {
    var d = keyToDate(k);
    return d.getDate() + ' ' + MON[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  }
  function stageLate(st) { return !st.done && st.due && st.due < dayKey(new Date()); }

  function addStage(j, name) {
    name = name.trim();
    if (!name) return;
    j.stages = j.stages || [];
    var n = name.toLowerCase();
    if (j.stages.some(function (s) { return s.name.toLowerCase() === n; })) return;
    var li = libIndex(name, j.kind);
    if (li < 0) {
      setLib(j.kind, stageLib(j.kind).concat([name])); // remember new names for next time
      li = stageLib(j.kind).length - 1;
    }
    // Keep stages in list order, whatever order they were tapped in.
    var pos = j.stages.length;
    for (var i = 0; i < j.stages.length; i++) {
      if (libIndex(j.stages[i].name, j.kind) > li) { pos = i; break; }
    }
    j.stages.splice(pos, 0, { id: uid(), name: name, done: false, doneAt: null, due: null });
  }
  function toggleStage(st) {
    st.done = !st.done;
    st.doneAt = st.done ? dayKey(new Date()) : null;
  }
  function copyStages(j) {
    return (j.stages || []).map(function (s) { return { id: uid(), name: s.name, done: false, doneAt: null, due: null }; });
  }

  // Short progress line for a job card, e.g. "Next: Printing · 2/5".
  function stageSummary(j) {
    var st = j.stages || [];
    if (!st.length) return null;
    var done = st.filter(function (s) { return s.done; }).length;
    var late = st.filter(stageLate)[0];
    var next = st.filter(function (s) { return !s.done; })[0];
    var text = late ? 'Late: ' + late.name + ' (due ' + fmtDay(late.due) + ')'
      : next ? 'Next: ' + next.name + (next.due ? ' (due ' + fmtDay(next.due) + ')' : '')
        : 'All stages done';
    return { text: text + ' · ' + done + '/' + st.length, pct: Math.round(100 * done / st.length), late: !!late, all: !next };
  }

  function renderStages(j) {
    var box = $('stages');
    box.textContent = '';
    var stages = j.stages || [];
    var nextIdx = -1;
    for (var i = 0; i < stages.length; i++) if (!stages[i].done) { nextIdx = i; break; }
    // Latest stages at the top: drawn bottom-up (the stored order stays first-to-last).
    stages.slice().reverse().forEach(function (st) {
      var i = stages.indexOf(st);
      var row = el('div', 'stage' + (st.done ? ' done' : '') + (i === nextIdx ? ' next' : '') + (i === 0 ? ' last' : ''));
      row.dataset.id = st.id;
      var dot = btn('', 'st-dot', function () {
        toggleStage(st);
        save();
        renderJob();
      });
      dot.setAttribute('aria-label', (st.done ? 'Untick ' : 'Tick ') + st.name);
      var main = el('div', 'st-main');
      main.appendChild(el('div', 'st-name', st.name));
      var sub = st.done ? (st.doneAt ? 'Done ' + fmtDay(st.doneAt) : 'Done')
        : st.due ? 'Due ' + fmtDay(st.due) : '';
      if (sub) main.appendChild(el('div', 'st-sub' + (stageLate(st) ? ' late' : ''), sub));
      if (st.note && st.note.trim()) main.appendChild(el('div', 'st-note', st.note));
      var more = btn(stageUi.editId === st.id ? 'Close' : 'Edit', 'link st-more', function () {
        stageUi.editId = stageUi.editId === st.id ? null : st.id;
        renderJob();
      });
      row.appendChild(dot);
      row.appendChild(main);
      row.appendChild(more);
      box.appendChild(row);
      if (stageUi.editId === st.id) box.appendChild(stageEditor(j, st, i));
    });

    // Adding stages
    var add = $('stageAdd');
    add.textContent = '';
    var open = !stages.length || stageUi.addOpen;
    if (!open) {
      add.appendChild(btn('+ Add a stage', 'link', function () { stageUi.addOpen = true; renderJob(); }));
      return;
    }
    if (!stages.length) add.appendChild(el('div', 'muted tiny', 'Tap the stages this ' + wordsFor(j).thing + ' needs. You can add or remove them any time.'));
    var have = stages.map(function (s) { return s.name.toLowerCase(); });
    var chips = el('div', 'chips');
    stageLib(j.kind).forEach(function (n) {
      if (have.indexOf(n.toLowerCase()) >= 0) return;
      chips.appendChild(btn('+ ' + n, 'chip', function () {
        stageUi.addOpen = true; // keep the chips open to add several
        addStage(j, n);
        save();
        renderJob();
      }));
    });
    chips.appendChild(btn('+ New stage', 'chip new', function () { stageUi.newOpen = true; renderJob(); $('stageNewName').focus(); }));
    add.appendChild(chips);
    if (stageUi.newOpen) {
      var row = el('div', 'add-row stage-new');
      var inp = el('input');
      inp.id = 'stageNewName';
      inp.placeholder = 'Stage name, e.g. Proof approved';
      inp.autocomplete = 'off';
      var go = function () {
        if (!inp.value.trim()) return;
        stageUi.addOpen = true;
        addStage(j, inp.value);
        stageUi.newOpen = false;
        save();
        renderJob();
      };
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
      row.appendChild(inp);
      row.appendChild(btn('Add', 'primary', go));
      add.appendChild(row);
    }
    if (stages.length) {
      add.appendChild(btn('Done adding', 'link', function () {
        stageUi.addOpen = false;
        stageUi.newOpen = false;
        renderJob();
      }));
    }
  }

  function stageEditor(j, st, i) {
    var ed = el('div', 'st-edit');
    function field(label, input) {
      var l = el('label');
      l.appendChild(el('span', null, label));
      l.appendChild(input);
      ed.appendChild(l);
      return input;
    }
    var name = el('input');
    name.value = st.name;
    name.autocomplete = 'off';
    field('Name', name).addEventListener('change', function () {
      var v = name.value.trim();
      if (v) { st.name = v; save(); }
      renderJob();
    });
    var due = el('input');
    due.type = 'date';
    due.value = st.due || '';
    field('Due date', due).addEventListener('change', function () {
      st.due = isDay(due.value) ? due.value : null;
      save();
      renderJob();
    });
    if (st.done) {
      var doneAt = el('input');
      doneAt.type = 'date';
      doneAt.value = st.doneAt || '';
      field('Done on', doneAt).addEventListener('change', function () {
        st.doneAt = isDay(doneAt.value) ? doneAt.value : null;
        save();
        renderJob();
      });
    }
    var note = el('textarea');
    note.placeholder = 'Notes for this stage';
    note.value = st.note || '';
    field('Notes', note).addEventListener('input', function () {
      if (note.value.trim()) st.note = note.value;
      else delete st.note;
      save();
    });
    var btns = el('div', 'btns');
    function move(delta) {
      var k = i + delta;
      if (k < 0 || k >= j.stages.length) return;
      j.stages.splice(k, 0, j.stages.splice(i, 1)[0]);
      save();
      renderJob();
    }
    // On screen the list is upside down, so "up" means later in the order.
    var up = btn('Move up', 'small', function () { move(1); });
    up.disabled = i === j.stages.length - 1;
    var down = btn('Move down', 'small', function () { move(-1); });
    down.disabled = i === 0;
    btns.appendChild(up);
    btns.appendChild(down);
    btns.appendChild(btn('Remove', 'small danger', function () {
      j.stages = j.stages.filter(function (s) { return s !== st; });
      stageUi.editId = null;
      save();
      renderJob();
    }));
    ed.appendChild(btns);
    return ed;
  }

  // Stage names lists in settings: one for jobs, one for misc items.
  function renderLib() { renderLibFor('job'); renderLibFor('misc'); }
  function libIds(kind) { return kind === 'misc' ? { list: 'miscLibList', input: 'miscLibNew' } : { list: 'libList', input: 'libNew' }; }
  function renderLibFor(kind) {
    var box = $(libIds(kind).list);
    box.textContent = '';
    var lib = stageLib(kind);
    lib.forEach(function (n, i) {
      var row = el('div', 'lib-row');
      row.appendChild(el('span', null, n));
      var up = btn('↑', 'small', function () { libMove(kind, i, -1); });
      up.disabled = i === 0;
      up.setAttribute('aria-label', 'Move ' + n + ' up');
      var down = btn('↓', 'small', function () { libMove(kind, i, 1); });
      down.disabled = i === lib.length - 1;
      down.setAttribute('aria-label', 'Move ' + n + ' down');
      var del = btn('×', 'small danger', function () {
        setLib(kind, stageLib(kind).filter(function (x) { return x !== n; }));
        save();
        renderLibFor(kind);
      });
      del.setAttribute('aria-label', 'Remove ' + n);
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(del);
      box.appendChild(row);
    });
    if (!lib.length) {
      box.appendChild(el('p', 'muted tiny', kind === 'misc'
        ? 'None yet. Stage names you type on misc items are added here.'
        : 'No stage names. Add some below.'));
    }
  }
  function libMove(kind, i, delta) {
    var lib = stageLib(kind).slice(), k = i + delta;
    if (k < 0 || k >= lib.length) return;
    lib.splice(k, 0, lib.splice(i, 1)[0]);
    setLib(kind, lib);
    save();
    renderLibFor(kind);
  }
  function libAdd(kind) {
    var inp = $(libIds(kind).input), v = inp.value.trim();
    inp.value = '';
    if (!v || libIndex(v, kind) >= 0) return;
    setLib(kind, stageLib(kind).concat([v]));
    save();
    renderLibFor(kind);
  }
  $('libAdd').addEventListener('click', function () { libAdd('job'); });
  $('libNew').addEventListener('keydown', function (e) { if (e.key === 'Enter') libAdd('job'); });
  $('miscLibAdd').addEventListener('click', function () { libAdd('misc'); });
  $('miscLibNew').addEventListener('keydown', function (e) { if (e.key === 'Enter') libAdd('misc'); });


  // ---------- job detail ----------
  var openId = null;
  var editingNoteId = null;

  function openJob(id) {
    flushAll();
    openId = id;
    stageUi = { addOpen: false, newOpen: false, editId: null };
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
    if (!$('sheet-overview').hidden) renderOverview();
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
      ? 'This ' + wordsFor(j).thing + ' is listed under ' + monthLabel(jobMonth(j)) + ' in ' + wordsFor(j).old + '.'
      : j.month
        ? 'When done, it will be listed under ' + monthLabel(j.month) + ' in ' + wordsFor(j).old + '.'
        : 'Optional. When done, it will be listed under the month you finish it, unless you pick a month here.';
    renderStages(j);

    // Notes from the other rounds of a recurring job.
    var others = s.filter(function (x) { return x !== j && (x.notes.length || stageNotesOf(x).length); }).reverse();
    var otherCount = others.reduce(function (n, x) { return n + x.notes.length + stageNotesOf(x).length; }, 0);
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
        stageNotesOf(x).forEach(function (st) {
          var box = el('div', 'note past');
          box.appendChild(el('div', 'note-when', 'Stage: ' + st.name + (st.doneAt ? ' (done ' + fmtDay(st.doneAt) + ')' : '')));
          box.appendChild(el('div', 'note-text', st.note));
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
      act.appendChild(btn('Mark as done (move to ' + wordsFor(j).old + ')', '', function () { finishJob(j, false); }));
      act.appendChild(btn('Done, and start the next round', '', function () { finishJob(j, true); }));
    } else {
      act.appendChild(btn('Start a new round of this ' + wordsFor(j).thing, '', function () { startRound(j); }));
      act.appendChild(btn('Move back to ' + wordsFor(j).active, '', function () { reopenJob(j); }));
    }
    act.appendChild(btn('Delete this ' + wordsFor(j).thing, 'danger', function () { deleteJob(j); }));
  }

  function stageNotesOf(j) {
    return (j.stages || []).filter(function (st) { return st.note && st.note.trim(); });
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
    var next = repeat ? newJob(j.title, j.seriesId, j.kind) : null;
    if (next && j.stages) next.stages = copyStages(j);
    if (next && typeof j.rank === 'number') next.rank = j.rank;
    save();
    if (next) { openJob(next.id); toast('Next round started. Old notes are under "Show previous notes".'); }
    else { closeJob(); toast('Moved to ' + wordsFor(j).old); }
  }
  function startRound(j) {
    var next = newJob(j.title, j.seriesId, j.kind);
    if (j.stages) next.stages = copyStages(j);
    save();
    showTab('active');
    openJob(next.id);
    toast('New round started in ' + wordsFor(j).active);
  }
  function reopenJob(j) {
    j.status = 'active';
    j.closed = null;
    delete j.rank;
    save();
    closeJob();
    toast('Moved back to ' + wordsFor(j).active);
  }
  // ---------- overview: every active job grouped by the stage it's at ----------
  function openOverview() {
    flushAll();
    $('sheet-overview').hidden = false;
    $('sheet-overview').scrollTop = 0;
    renderOverview();
  }
  function closeOverview() {
    $('sheet-overview').hidden = true;
    renderTab();
  }
  $('ovOpen').addEventListener('click', openOverview);
  $('ovBack').addEventListener('click', closeOverview);

  function currentStage(j) { return (j.stages || []).filter(function (s) { return !s.done; })[0] || null; }

  function renderOverview() {
    var jobs = activeInOrder();
    $('ovTitle').textContent = 'Overview · ' + kindWords().active;
    var box = $('ovList');
    box.textContent = '';
    // Groups: stages in the stage-list order, then unknown stage names, then
    // "All stages done", then "No stages yet".
    var groups = {}, keys = [];
    function put(key, label, rank, j) {
      if (!groups[key]) { groups[key] = { label: label, rank: rank, jobs: [] }; keys.push(key); }
      groups[key].jobs.push(j);
    }
    var late = 0;
    jobs.forEach(function (j) {
      var st = j.stages || [];
      var cur = currentStage(j);
      if (st.some(stageLate)) late++;
      if (!st.length) put('~none', 'No stages yet', [3, 0, ''], j);
      else if (!cur) put('~done', 'All stages done', [2, 0, ''], j);
      else {
        var li = libIndex(cur.name, j.kind);
        put('s:' + cur.name.toLowerCase(), cur.name, [li >= 0 ? 0 : 1, li, cur.name.toLowerCase()], j);
      }
    });
    keys.sort(function (a, b) {
      var x = groups[a].rank, y = groups[b].rank;
      return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
    });
    $('ovLate').hidden = !late;
    $('ovLate').textContent = plural(late, wordsFor({ kind: listKind === 'misc' ? 'misc' : undefined }).thing) + ' late';
    keys.forEach(function (key) {
      var g = groups[key];
      var head = el('div', 'ov-head');
      head.appendChild(el('span', null, g.label));
      head.appendChild(el('span', 'n', String(g.jobs.length)));
      box.appendChild(head);
      g.jobs.forEach(function (j) { box.appendChild(overviewRow(j)); });
    });
    $('ovEmpty').hidden = jobs.length > 0;
    $('ovEmpty').textContent = kindWords().none;
  }

  function overviewRow(j) {
    var st = j.stages || [];
    var cur = currentStage(j);
    var row = el('button', 'ov-row');
    row.type = 'button';
    var main = el('div', 'ov-main');
    main.appendChild(el('div', 'ov-title', j.title));
    var lateSt = st.filter(stageLate)[0];
    var sub = lateSt ? 'Late: ' + lateSt.name + ' (due ' + fmtDay(lateSt.due) + ')'
      : cur && cur.due ? 'Due ' + fmtDay(cur.due) : '';
    if (sub) main.appendChild(el('div', 'ov-sub' + (lateSt ? ' late' : ''), sub));
    row.appendChild(main);
    if (st.length) {
      var prog = el('div', 'ov-prog');
      var dots = el('div', 'dots');
      st.forEach(function (s) {
        var d = el('span', s.done ? 'done' : s === cur ? 'cur' : null);
        d.title = s.name;
        dots.appendChild(d);
      });
      prog.appendChild(dots);
      prog.appendChild(el('div', null, st.filter(function (s) { return s.done; }).length + '/' + st.length));
      row.appendChild(prog);
    }
    row.addEventListener('click', function () { openJob(j.id); });
    return row;
  }

  // ---------- recycle bin ----------
  // Deleted jobs go to data.bin = [{ job, deletedAt }] whole (notes, stages and
  // all), so they can be put back exactly as they were.
  function deleteJob(j) {
    data.jobs = data.jobs.filter(function (x) { return x !== j; });
    data.bin = (data.bin || []).concat([{ job: j, deletedAt: nowIso() }]);
    if (!save()) return;
    closeJob();
    toast('Moved to the recycle bin', function () { restoreJob(j.id); });
  }
  function wordsFor(j) {
    return j.kind === 'misc'
      ? { thing: 'item', untitled: 'Untitled item', old: 'Old misc', active: 'Active misc' }
      : { thing: 'job', untitled: 'Untitled job', old: 'Old jobs', active: 'Active jobs' };
  }
  function placeName(j) {
    return (j.status === 'old' ? 'Old ' : 'Active ') + (j.kind === 'misc' ? 'misc' : 'jobs');
  }
  function restoreJob(id) {
    var b = (data.bin || []).filter(function (x) { return x.job.id === id; })[0];
    if (!b) return;
    data.bin = data.bin.filter(function (x) { return x !== b; });
    delete b.job.rank; // comes back at the top of Active jobs
    data.jobs.push(b.job);
    if (!save()) return;
    if (!$('sheet-bin').hidden) renderBin();
    renderTab();
    toast('Restored to ' + placeName(b.job));
  }
  function renderBin() {
    var list = $('binList');
    list.textContent = '';
    var bin = (data.bin || []).slice().sort(function (a, b) { return a.deletedAt < b.deletedAt ? 1 : -1; });
    bin.forEach(function (b) {
      var j = b.job;
      var card = el('div', 'bin-card');
      card.appendChild(el('div', 'card-title', j.title));
      var parts = ['Was in ' + placeName(j), 'deleted ' + fmtDate(b.deletedAt),
        plural(j.notes.length, 'note')];
      if (j.stages && j.stages.length) parts.push(plural(j.stages.length, 'stage'));
      card.appendChild(el('div', 'card-meta', parts.join(' · ')));
      var row = el('div', 'bin-btns');
      row.appendChild(btn('Restore', 'small primary', function () { restoreJob(j.id); }));
      row.appendChild(btn('Delete forever', 'small danger', function () {
        if (!confirm('Delete "' + j.title + '" forever? Its notes will be gone and this can\'t be undone.')) return;
        data.bin = data.bin.filter(function (x) { return x !== b; });
        save();
        renderBin();
      }));
      card.appendChild(row);
      list.appendChild(card);
    });
    $('binEmpty').hidden = bin.length > 0;
    $('binEmptyAll').hidden = !bin.length;
  }
  function openBin() {
    flushAll();
    $('sheet-bin').hidden = false;
    $('sheet-bin').scrollTop = 0;
    renderBin();
  }
  function closeBin() {
    $('sheet-bin').hidden = true;
    if (!$('sheet-settings').hidden) renderSettings();
    renderTab();
  }
  $('binOpen').addEventListener('click', openBin);
  $('binOpen2').addEventListener('click', openBin);
  $('binBack').addEventListener('click', closeBin);
  $('binEmptyAll').addEventListener('click', function () {
    var n = (data.bin || []).length;
    if (!n || !confirm('Delete all ' + plural(n, 'job') + " in the recycle bin forever? This can't be undone.")) return;
    data.bin = [];
    save();
    renderBin();
  });

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
    renderLib();
    renderLockInfo();
    $('binOpen2').textContent = 'Open the recycle bin (' + (data.bin || []).length + ')';
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

  if (getLock() && sessionValid()) unlock();
  else showLock(getLock() ? 'unlock' : 'setup');

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
