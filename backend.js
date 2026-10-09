'use strict';
// ブラウザ版(Chrome / Chromebook)のバックエンド。
// Electron版で main プロセスが担っていた「ログイン・Classroom取得・既読管理・通知・カレンダー連携」を、
// ブラウザの中で行う。画面側(app.js)には、Electron版と同じ window.classroomAPI として見せる。
(() => {
  const SCOPE_BASE = [
    'classroom.courses.readonly',
    'classroom.coursework.me.readonly',
    'classroom.student-submissions.me.readonly',
    'classroom.announcements.readonly',
    'classroom.courseworkmaterials.readonly',
    'classroom.profile.photos',
    'classroom.rosters', // 生徒一覧の表示・自分の登録解除(登録解除は確認ダイアログの後だけ)
  ].map((s) => 'https://www.googleapis.com/auth/' + s);
  const SCOPE_CAL = 'https://www.googleapis.com/auth/calendar.events'; // Googleカレンダー連携をオンにしたときだけ追加

  const LS = { clientId: 'cd-client-id', token: 'cd-token', authed: 'cd-authed', cal: 'cd-cal-scope' };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 保存できない環境 */ } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* 無視 */ } };

  /* ===== 保存(IndexedDB。使えないときは localStorage) ===== */
  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDBが使えません'));
      const r = window.indexedDB.open('classroom-desk', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function kvGet(key) {
    try {
      const db = await idbOpen();
      return await new Promise((res, rej) => {
        const q = db.transaction('kv').objectStore('kv').get(key);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    } catch {
      const v = lsGet('cd-kv-' + key);
      return v ? JSON.parse(v) : undefined;
    }
  }
  async function kvSet(key, val) {
    try {
      const db = await idbOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    } catch { lsSet('cd-kv-' + key, JSON.stringify(val)); }
  }

  const DEFAULT_STATE = () => ({
    initialized: false, // 最初の同期は「基準」として通知を出さない
    known: {},
    notifications: [],
    calendar: {},
    cache: null,
    lastSync: null,
    reminded: {},   // 提出忘れアラートを出した課題 { key: 期限 }
    lastDigest: '', // 朝のまとめを出した日
    settings: {
      pollMinutes: 10, calendarEnabled: false, calendarName: 'Classroom', alarmMinutes: 1440, deleteOnSubmit: true, openAtLogin: false,
      mutedCourses: [], keywords: ['テスト', '提出', '締切', '変更', '延期', '持ち物'],
      reminderEnabled: true, reminderHours: 3, digestEnabled: false, digestTime: '07:30',
    },
  });
  let state = DEFAULT_STATE();
  let saveTimer = null;
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => kvSet('state', state), 300); };

  /* ===== ログイン(Google Identity Services のトークン方式) ===== */
  let clientId = lsGet(LS.clientId) || (window.APP_CONFIG && window.APP_CONFIG.clientId) || '';
  let tok = (() => {
    try { const t = JSON.parse(lsGet(LS.token) || 'null'); return t && t.expires_at > Date.now() ? t : null; } catch { return null; }
  })();
  let calGranted = lsGet(LS.cal) === '1';
  let tokenClient = null;
  const scopes = () => (calGranted ? [...SCOPE_BASE, SCOPE_CAL] : SCOPE_BASE).join(' ');
  const hasCredentials = () => !!clientId;
  const isSignedIn = () => lsGet(LS.authed) === '1';

  function gsiReady() {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function check() {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
        if (Date.now() - t0 > 10000) return reject(new Error('Googleのログイン部品を読み込めませんでした。ネットワークを確認してください'));
        setTimeout(check, 100);
      })();
    });
  }

  // トークンを取得する(ポップアップ)。ユーザーのクリックの直後に呼ぶと、ブロックされない
  function requestToken(prompt = '') {
    return new Promise((resolve, reject) => {
      gsiReady().then(() => {
        if (!tokenClient) {
          tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: clientId, scope: scopes(), include_granted_scopes: true, callback: () => {}, error_callback: () => {},
          });
        }
        tokenClient.callback = (resp) => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          tok = { access_token: resp.access_token, expires_at: Date.now() + Math.max(60, Number(resp.expires_in) - 60) * 1000 };
          lsSet(LS.token, JSON.stringify(tok));
          lsSet(LS.authed, '1');
          resolve(tok.access_token);
        };
        tokenClient.error_callback = (err) => {
          const msg = err.type === 'popup_closed' ? 'ログインのウィンドウが閉じられました'
            : err.type === 'popup_failed_to_open' ? 'ログインのウィンドウを開けませんでした(ポップアップがブロックされています)'
              : err.message || err.type || 'ログインに失敗しました';
          reject(Object.assign(new Error(msg), { code: err.type }));
        };
        tokenClient.requestAccessToken({ prompt });
      }, reject);
    });
  }

  // トークンは1時間で切れる。切れたら、次にクリックしたときに自動で取り直す(ブラウザはクリック無しのポップアップを許さないため)
  let reauthArmed = false;
  function armReauth() {
    if (reauthArmed) return;
    reauthArmed = true;
    window.addEventListener('pointerdown', async () => {
      reauthArmed = false;
      try { await requestToken(''); runSync(); } catch { /* 閉じられたら次の同期でまた案内 */ }
    }, { once: true, capture: true });
  }
  async function getToken() {
    if (tok && tok.expires_at > Date.now()) return tok.access_token;
    try { return await requestToken(''); } catch (e) {
      armReauth();
      throw Object.assign(new Error('ログインの有効期限が切れました。画面のどこかをクリックすると、自動で更新します'), { needsLogin: true });
    }
  }

  async function request(url, { method = 'GET', body } = {}) {
    const go = (t) => fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let token = await getToken();
    let res = await go(token);
    if (res.status === 401) { tok = null; lsDel(LS.token); token = await getToken(); res = await go(token); }
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* 本文なし */ }
      const msg = (data && data.error && (data.error.message || data.error)) || `HTTP ${res.status}`;
      throw Object.assign(new Error(String(msg)), { response: { status: res.status, data } });
    }
    if (res.status === 204) return {};
    try { return await res.json(); } catch { return {}; }
  }
  window.CdHttp = { request: (url, method) => request(url, { method }) }; // classroom-core.js が使う

  /* ===== 同期・新着判定・通知 ===== */
  const DAY = 864e5;
  const L = window.CdLogic; // 通知まわりの共通ロジック(logic.js)
  const LABEL = { work: '新しい課題', announcement: 'お知らせ', material: '新しい資料', 'due-changed': '期限が変更されました', reminder: 'もうすぐ期限' };
  const listeners = { data: [], open: [], cmd: [], update: [] };
  let cache = { courses: [], items: [], profiles: {} };
  let syncing = false;
  let lastError = null;
  let timer = null;
  let lastSyncAt = 0;
  const core = () => window.ClassroomCore;

  function snapshot() {
    return {
      hasCredentials: hasCredentials(), signedIn: isSignedIn(),
      courses: cache.courses, items: cache.items, profiles: cache.profiles || {},
      notifications: state.notifications, lastSync: state.lastSync, settings: state.settings, syncing, lastError,
    };
  }
  function broadcast() { const snap = snapshot(); listeners.data.forEach((cb) => { try { cb(snap); } catch (e) { console.error(e); } }); }

  // 未読の数: アイコンのバッジ(インストールしたアプリ)と、ブラウザのタブの題名
  function updateBadge() {
    const n = state.notifications.filter((x) => !x.read).length;
    try {
      if (n && navigator.setAppBadge) navigator.setAppBadge(n);
      else if (!n && navigator.clearAppBadge) navigator.clearAppBadge();
    } catch { /* 非対応 */ }
    document.title = (n ? `(${n}) ` : '') + 'Classroom Desk';
  }

  function makeNotif(it, kind, time, id = it.key) {
    const when = (ms) => new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    let summary = '';
    if (kind === 'due-changed') summary = `新しい期限: ${when(it.dueMs)}`;
    else if (kind === 'announcement') summary = (it.text || '').replace(/\s+/g, ' ').slice(0, 100);
    else if (kind === 'work' && it.dueMs) summary = `期限: ${when(it.dueMs)}`;
    else if (kind === 'reminder') summary = `${L.remainText(it.dueMs - Date.now())}(期限: ${when(it.dueMs)})`;
    return { id, kind, itemKey: it.key, courseId: it.courseId, courseName: it.courseName, title: it.title, summary, time, read: false };
  }

  // ミュート中のクラスは「既読」で届く(数字・通知に出ない)。キーワードに合うものは強調し、ミュート中でも通知する
  function classified(n, it, settings) {
    const c = L.classify(it, settings);
    if (c.important) n.important = true;
    if (c.muted) { n.muted = true; n.read = true; }
    return n;
  }

  // 前回との差分から新着を作る。初回同期は「基準」にするだけで通知しない
  function diff(items, s) {
    const fresh = [];
    const next = {};
    for (const it of items) {
      const prev = s.known[it.key];
      next[it.key] = { due: it.dueMs ?? null };
      if (!s.initialized) continue;
      if (!prev) {
        if (Date.now() - Date.parse(it.created) > 14 * DAY) continue; // 古い項目は新着扱いしない
        fresh.push(classified(makeNotif(it, it.kind, it.created), it, s.settings));
      } else if (it.kind === 'work' && it.dueMs && prev.due !== it.dueMs) {
        fresh.push(classified(makeNotif(it, 'due-changed', new Date().toISOString(), `${it.key}:due:${it.dueMs}`), it, s.settings));
      }
    }
    s.known = { ...s.known, ...next };
    const ids = new Set(s.notifications.map((n) => n.id));
    const out = fresh.filter((n) => !ids.has(n.id));
    s.notifications = [...out, ...s.notifications].slice(0, 200);
    return out;
  }

  function notifyPermission() { return 'Notification' in window ? Notification.permission : 'unsupported'; }
  async function requestNotifyPermission() {
    if (!('Notification' in window)) return 'unsupported';
    try { return await Notification.requestPermission(); } catch { return Notification.permission; }
  }
  function notify(all) {
    const list = all.filter((n) => !n.muted);
    if (!list.length || notifyPermission() !== 'granted') return;
    for (const n of list.slice(0, 3)) {
      try {
        const nt = new Notification(`${n.important ? '★ ' : ''}${n.courseName} — ${LABEL[n.kind]}`, { body: n.title, tag: n.id });
        nt.onclick = () => { try { window.focus(); } catch { /* 無視 */ } markRead([n.id]); listeners.open.forEach((cb) => cb(n.itemKey)); nt.close(); };
      } catch { /* 通知を出せない環境 */ }
    }
    if (list.length > 3) { try { new Notification('Classroom', { body: `ほか ${list.length - 3} 件の新着があります` }); } catch { /* 無視 */ } }
  }

  async function runSync() {
    if (syncing || !isSignedIn() || !hasCredentials()) return;
    syncing = true;
    lastError = null;
    broadcast();
    try {
      const data = await core().fetchAll();
      cache = data;
      state.cache = data;
      const fresh = diff(data.items, state);
      state.initialized = true;
      state.lastSync = new Date().toISOString();
      lastSyncAt = Date.now();
      save();
      notify(fresh);
      checkReminders();
      if (state.settings.calendarEnabled) {
        await syncCalendar(data.items).catch((e) => { lastError = 'カレンダー: ' + calErr(e); });
      }
    } catch (e) {
      console.error('sync failed:', e);
      lastError = String((e && e.message) || e).slice(0, 200);
    } finally {
      syncing = false;
      updateBadge();
      broadcast();
    }
  }

  // 提出忘れアラート: 期限まであと reminderHours 時間以内で、まだ未提出の課題を知らせる
  function checkReminders() {
    const s = state.settings;
    if (!s.reminderEnabled) return;
    state.reminded = state.reminded || {};
    const due = L.dueReminders(cache.items || [], s.reminderHours || 3, Date.now(), state.reminded);
    if (!due.length) return;
    const out = due.map((it) => {
      state.reminded[it.key] = it.dueMs;
      return makeNotif(it, 'reminder', new Date().toISOString(), `${it.key}:rem:${it.dueMs}`);
    });
    state.notifications = [...out, ...state.notifications].slice(0, 200);
    save(); notify(out); updateBadge(); broadcast();
  }

  // 朝のまとめ: 設定した時刻になったら、1日1回だけ知らせる(アプリを開いている間)
  function maybeDigest() {
    const s = state.settings;
    if (!s.digestEnabled) return;
    const now = new Date();
    const act = L.digestAction(now, s.digestTime, state.lastDigest);
    if (act === 'wait' || act === 'done') return;
    state.lastDigest = L.dayKey(now);
    save();
    if (act !== 'send' || notifyPermission() !== 'granted') return;
    const d = L.buildDigest(cache.items || [], state.notifications.filter((n) => !n.read).length, now);
    if (d.empty) return;
    try {
      const nt = new Notification(d.title, { body: d.body, tag: 'digest' });
      nt.onclick = () => { try { window.focus(); } catch { /* 無視 */ } listeners.cmd.forEach((cb) => cb('tab:today')); nt.close(); };
    } catch { /* 通知を出せない環境 */ }
  }
  function tick() {
    try { checkReminders(); maybeDigest(); } catch (e) { console.error('tick failed:', e); }
  }

  function markRead(ids) {
    for (const n of state.notifications) if (ids === 'all' || ids.includes(n.id)) n.read = true;
    save(); updateBadge(); broadcast();
  }
  // 通知の削除('all' = すべて / 'read' = 既読だけ / ID の配列)。削除しても、同じ投稿の通知は作り直されない
  function removeNotifications(ids) {
    state.notifications = state.notifications.filter((n) => !(ids === 'all' || (ids === 'read' && n.read) || (Array.isArray(ids) && ids.includes(n.id))));
    save(); updateBadge(); broadcast();
  }

  function schedule() {
    clearInterval(timer);
    const m = Math.max(2, state.settings.pollMinutes || 10);
    timer = setInterval(runSync, m * 60 * 1000);
  }

  /* ===== Googleカレンダー連携(提出期限をカレンダーに登録) ===== */
  const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const calErr = (e) => (e && e.response && e.response.status === 403
    ? 'Googleカレンダーの許可がありません。設定でいったんオフにして、もう一度オンにしてください'
    : String((e && e.message) || e));

  function eventBody(it) {
    const mins = state.settings.alarmMinutes;
    const body = {
      summary: `📝 ${it.title}(${it.courseName})`,
      description: `${it.link || ''}\n\n[classroom-desk:${it.key}]`,
      extendedProperties: { private: { classroomDeskKey: it.key } },
      reminders: { useDefault: false, overrides: mins > 0 ? [{ method: 'popup', minutes: mins }] : [] },
    };
    if (it.allDay) { // 時刻なしの期限 → 終日の予定
      const d = new Date(it.dueMs);
      body.start = { date: ymd(d) };
      body.end = { date: ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) };
    } else { // 期限の30分前〜期限
      body.start = { dateTime: new Date(it.dueMs - 30 * 60000).toISOString() };
      body.end = { dateTime: new Date(it.dueMs).toISOString() };
    }
    return body;
  }

  async function syncCalendar(items) {
    const s = state;
    const now = Date.now();
    const gone = (e) => [404, 410].includes(e && e.response && e.response.status);
    for (const it of items) {
      if (it.kind !== 'work' || !it.dueMs) continue;
      const m = s.calendar[it.key];
      if (it.status === 'done') { // 提出済み → (設定がONなら)予定を削除
        if (m && s.settings.deleteOnSubmit) {
          await request(`${CAL}/${m.id}`, { method: 'DELETE' }).catch((e) => { if (!gone(e)) throw e; });
          delete s.calendar[it.key];
          save();
        }
        continue;
      }
      if (!m && it.dueMs < now) continue; // 過ぎた課題は新規登録しない
      if (m && m.due === it.dueMs) continue; // 変更なし
      let id = m && m.id;
      if (!id) { // 記録が無くても、重複して作らないよう探す
        const found = await request(`${CAL}?privateExtendedProperty=${encodeURIComponent('classroomDeskKey=' + it.key)}`);
        id = found.items && found.items[0] && found.items[0].id;
      }
      let res;
      if (id) {
        try { res = await request(`${CAL}/${id}`, { method: 'PUT', body: eventBody(it) }); } catch (e) { if (!gone(e)) throw e; }
      }
      if (!res) res = await request(CAL, { method: 'POST', body: eventBody(it) });
      s.calendar[it.key] = { id: res.id, due: it.dueMs };
      save();
    }
  }
  async function runCalendar() {
    try { await syncCalendar(cache.items); lastError = null; } catch (e) { lastError = 'カレンダー: ' + calErr(e); }
    broadcast();
  }

  /* ===== 設定・アカウント ===== */
  const ALLOWED = { mutedCourses: 'array', keywords: 'array', reminderEnabled: 'boolean', reminderHours: 'number', digestEnabled: 'boolean', digestTime: 'string', pollMinutes: 'number', calendarEnabled: 'boolean', calendarName: 'string', alarmMinutes: 'number', deleteOnSubmit: 'boolean', openAtLogin: 'boolean' };
  function setSettings(patch) {
    const s = state.settings;
    // カレンダー連携をオンにするとき、許可(スコープ)を追加する。クリックの直後なので、先に呼ぶ
    let consent = null;
    if (patch.calendarEnabled === true && !calGranted) {
      calGranted = true; lsSet(LS.cal, '1'); tokenClient = null;
      consent = requestToken('consent').catch((e) => {
        calGranted = false; lsSet(LS.cal, '0'); tokenClient = null;
        s.calendarEnabled = false; lastError = 'Googleカレンダーの許可が得られませんでした: ' + e.message;
        save(); broadcast();
        throw e;
      });
    }
    for (const [k, t] of Object.entries(ALLOWED)) {
      if (!(k in patch)) continue;
      if (t === 'array') { if (Array.isArray(patch[k])) s[k] = patch[k].map((x) => String(x).trim()).filter(Boolean).slice(0, 200); } else if (typeof patch[k] === t) s[k] = patch[k];
    }
    if (!/^\d{1,2}:\d{2}$/.test(s.digestTime)) s.digestTime = '07:30';
    s.reminderHours = Math.min(48, Math.max(1, Math.round(s.reminderHours) || 3));
    s.pollMinutes = Math.min(120, Math.max(2, Math.round(s.pollMinutes) || 10));
    save();
    schedule();
    if (consent) consent.then(() => runCalendar()).catch(() => {});
    else if (patch.calendarEnabled === true) runCalendar();
    broadcast();
  }

  async function setClientId(id) {
    const v = String(id || '').trim();
    if (v && !/^[0-9]+-[a-z0-9_]+\.apps\.googleusercontent\.com$/i.test(v)) throw new Error('クライアントIDの形式が違います(「…apps.googleusercontent.com」で終わる文字列です)');
    clientId = v;
    tokenClient = null;
    if (v) lsSet(LS.clientId, v); else lsDel(LS.clientId);
    broadcast();
  }

  async function signIn() {
    if (!clientId) throw new Error('先にクライアントIDを入力してください');
    await requestToken('consent');
    broadcast();
    runSync();
  }

  async function signOut() {
    const t = tok && tok.access_token;
    try { if (t && window.google && window.google.accounts && window.google.accounts.oauth2.revoke) window.google.accounts.oauth2.revoke(t, () => {}); } catch { /* 無視 */ }
    tok = null; tokenClient = null;
    lsDel(LS.token); lsDel(LS.authed);
    const settings = state.settings;
    state = DEFAULT_STATE();
    state.settings = settings;
    cache = { courses: [], items: [], profiles: {} };
    try { core().clearProfileCache(); } catch { /* 無視 */ }
    lastError = null;
    save(); updateBadge(); broadcast();
  }

  /* ===== アプリの更新(version.json を見て、変わっていたらお知らせ) ===== */
  let runningVersion = null;
  async function checkUpdate() {
    try {
      const r = await fetch('version.json', { cache: 'no-store' });
      const v = (await r.json()).version;
      if (runningVersion === null) { runningVersion = v; return { version: v, updated: false }; }
      if (v !== runningVersion) { listeners.update.forEach((cb) => cb(v)); return { version: v, updated: true }; }
      return { version: v, updated: false };
    } catch { return { version: runningVersion, updated: false, error: true }; }
  }

  /* ===== 起動 ===== */
  const ready = (async () => {
    const saved = await kvGet('state');
    if (saved) state = { ...DEFAULT_STATE(), ...saved, settings: { ...DEFAULT_STATE().settings, ...(saved.settings || {}) } };
    cache = state.cache || cache;
  })();
  ready.then(() => {
    updateBadge();
    schedule();
    setTimeout(runSync, 1500);
    setInterval(tick, 60000);
    setTimeout(tick, 8000);
    checkUpdate();
    setInterval(checkUpdate, 30 * 60 * 1000);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastSyncAt > 60000) runSync();
    checkUpdate();
  });
  window.addEventListener('online', () => runSync());
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => { /* 登録できなくても動く */ });
  }

  window.__WEB__ = true;
  window.classroomAPI = {
    getData: async () => { await ready; return snapshot(); },
    syncNow: () => runSync(),
    importCredentials: async () => { throw new Error('ブラウザ版では、クライアントIDを入力してください'); },
    setClientId,
    signIn,
    signOut,
    markRead: async (ids) => markRead(ids),
    deleteNotifs: async (ids) => removeNotifications(ids),
    setSettings: async (patch) => setSettings(patch || {}),
    syncCalendar: () => runCalendar(),
    members: (id) => core().fetchMembers(String(id)),
    unenroll: async (id) => { await core().unenroll(String(id)); runSync(); },
    openExternal: async (url) => { if (/^https:\/\//.test(url || '')) window.open(url, '_blank', 'noopener'); },
    onData: (cb) => listeners.data.push(cb),
    onOpenItem: (cb) => listeners.open.push(cb),
    onCommand: (cb) => listeners.cmd.push(cb),
    onUpdate: (cb) => listeners.update.push(cb),
    web: { tick, requestNotifyPermission, notifyPermission, checkUpdate, version: () => runningVersion },
  };
})();
