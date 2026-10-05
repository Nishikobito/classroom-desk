'use strict';
const api = window.classroomAPI;

/* ===== ユーティリティ ===== */
const $ = (s, el = document) => el.querySelector(s);
const settingsRoot = document.getElementById('settings'); // 設定のタブの中に移して使う
const IS_WEB = document.body.classList.contains('web'); // ブラウザ版(Chrome / Chromebook)かどうか

// 小さなDOM生成ヘルパー。文字列は必ず text として入るので、Classroom由来の本文でもXSSにならない
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

// 標準の append / replaceChildren は null を渡すと文字の「null」を表示してしまうので、null と false は無視するようにする
for (const fn of ['append', 'replaceChildren']) {
  const orig = Element.prototype[fn];
  Element.prototype[fn] = function (...kids) { return orig.apply(this, kids.filter((k) => k != null && k !== false)); };
}

const DAY = 864e5;
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const hhmm = (ms) => new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
const fmtShort = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function fmtDate(ms, allDay) {
  const d = new Date(ms);
  const date = `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  return allDay ? date : `${date} ${hhmm(ms)}`;
}
function relative(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 6e4);
  const hr = Math.round(abs / 36e5);
  const d = Math.round(abs / DAY);
  const t = m < 60 ? `${m}分` : hr < 24 ? `${hr}時間` : `${d}日`;
  return diff >= 0 ? `あと${t}` : `${t}超過`;
}
function ago(iso) {
  const d = Date.now() - Date.parse(iso);
  if (d < 6e4) return 'たった今';
  if (d < 36e5) return `${Math.floor(d / 6e4)}分前`;
  if (d < DAY) return `${Math.floor(d / 36e5)}時間前`;
  if (d < 2 * DAY) return '昨日';
  return fmtShort(new Date(iso));
}
// コースごとに色を自動で割り当てる
function courseColor(id) {
  const l = look(id);
  return l.color || `hsl(${courseHue(id)} 62% 50%)`;
}
function dueClass(it) {
  if (it.status === 'done') return 'done';
  if (it.dueMs < Date.now()) return 'over';
  if (it.dueMs - Date.now() < DAY) return 'soon';
  return '';
}

/* ===== 見た目の設定(この端末の localStorage に保存) ===== */
const UI_DEFAULT = {
  theme: 'system', accent: '#2c5fd0', radius: 12, density: 'normal', grid: false, css: '',
  fontSize: 14, fsTab: 16, fsSide: 14, fsCardTitle: 20, fsCardBody: 13, fsList: 14, fsBody: 14,
  filter: 'todo', calMode: 'month', calOnlyTodo: false, sidebar: 'open', coursesOpen: true,
  courseOrder: [], hidden: [],
  hiddenWorks: [], showHiddenWorks: false, fontScale: 100, shadowSide: 'soft', shadowCard: 'soft',
  pinned: [], hiddenTabs: [], groups: [], tabGroup: {},
  cardButtons: true, sidebarHidden: [], v: 5,
  tabOrder: [], sidebarWidth: 250, sidebarItem: 44,
};
const FONT_KEYS = ['fontScale', 'fontSize', 'fsTab', 'fsSide', 'fsCardTitle', 'fsCardBody', 'fsList', 'fsBody'];
let ui = (() => {
  try { return { ...UI_DEFAULT, ...JSON.parse(localStorage.getItem('ui2') || '{}') }; } catch { return { ...UI_DEFAULT }; }
})();
if ((ui.v || 0) < 5) { ui.fsTab = UI_DEFAULT.fsTab; ui.v = 5; } // 上のタブの文字を少し大きく
const saveUi = () => { try { localStorage.setItem('ui2', JSON.stringify(ui)); } catch { /* 無視 */ } };

// クラスごとのバナー・アイコン(画像は縮小して、この端末の localStorage に保存)
let looks = (() => { try { return JSON.parse(localStorage.getItem('looks2') || '{}'); } catch { return {}; } })();
function saveLooks() {
  try { localStorage.setItem('looks2', JSON.stringify(looks)); return true; } catch { alert('保存できませんでした。画像が大きすぎるかもしれません。'); return false; }
}
const look = (id) => looks[id] || {};
const SHADOWS = {
  side: { none: 'none', soft: '3px 0 10px rgba(0,0,0,.08)', medium: '5px 0 18px rgba(0,0,0,.16)', strong: '8px 0 28px rgba(0,0,0,.28)' },
  card: {
    none: 'none',
    soft: '0 1px 2px rgba(60,64,67,.16), 0 1px 4px rgba(60,64,67,.08)',
    medium: '0 2px 6px rgba(60,64,67,.22), 0 2px 10px rgba(60,64,67,.10)',
    strong: '0 4px 14px rgba(60,64,67,.32), 0 2px 6px rgba(60,64,67,.18)',
  },
};

function applyUi() {
  const r = document.documentElement;
  const k = (Number(ui.fontScale) || 100) / 100; // 全体の拡大率(各文字サイズに掛ける)
  const px = (v) => Math.round(v * k * 10) / 10 + 'px';
  r.dataset.theme = ui.theme;
  r.dataset.density = ui.density;
  r.dataset.grid = ui.grid ? 'on' : 'off';
  r.style.setProperty('--accent', ui.accent);
  r.style.setProperty('--radius', ui.radius + 'px');
  r.style.setProperty('--fs', px(ui.fontSize));
  r.style.setProperty('--fs-tab', px(ui.fsTab));
  r.style.setProperty('--fs-side', px(ui.fsSide));
  r.style.setProperty('--fs-ctitle', px(ui.fsCardTitle));
  r.style.setProperty('--fs-cbody', px(ui.fsCardBody));
  r.style.setProperty('--fs-list', px(ui.fsList));
  r.style.setProperty('--fs-body', px(ui.fsBody));
  r.style.setProperty('--sb-w', (Number(ui.sidebarWidth) || 250) + 'px');
  r.style.setProperty('--sb-item-h', (Number(ui.sidebarItem) || 44) + 'px');
  r.style.setProperty('--sb-ico', Math.round((Number(ui.sidebarItem) || 44) * 0.55) + 'px');
  r.style.setProperty('--shadow-side', SHADOWS.side[ui.shadowSide] || 'none');
  r.style.setProperty('--shadow-card', SHADOWS.card[ui.shadowCard] || 'none');
  settingsRoot.querySelectorAll('[data-val]').forEach((el) => { el.textContent = ui[el.dataset.val] + (el.dataset.unit || 'px'); });
  $('#user-css').textContent = ui.css;
}

/* ===== 状態 ===== */
let data = { hasCredentials: false, signedIn: false, courses: [], items: [], notifications: [], settings: {}, syncing: false };
let q = '';            // 検索文字
let courseFilter = ''; // コース絞り込み
let calCursor = new Date();
let calSel = new Date();
let pendingOpen = null;
let dataLoaded = false;

const FIXED = [
  { id: 'home', title: 'ホーム', icon: 'home', kind: 'fixed' },
  { id: 'assignments', title: '課題', icon: 'clipboard', kind: 'fixed' },
  { id: 'notifications', title: '通知', icon: 'bell', kind: 'fixed' },
  { id: 'calendar', title: 'カレンダー', icon: 'calendar', kind: 'fixed' },
  { id: 'memo', title: 'メモ', icon: 'note', kind: 'fixed' },
  { id: 'settings', title: '設定', icon: 'gear', kind: 'fixed' },
];
let tabs = [...FIXED];
let active = 'home';
const viewEls = new Map();

const KIND = {
  work: { ico: 'clipboard', label: '新しい課題' },
  announcement: { ico: 'megaphone', label: 'お知らせ' },
  material: { ico: 'bookmark', label: '資料' },
  'due-changed': { ico: 'clock', label: '期限変更' },
};
const ready = () => data.hasCredentials && data.signedIn;
const banner = () => (data.lastError ? h('div', { class: 'banner' }, '同期エラー: ' + data.lastError) : null);

/* ===== アイコン・クラス用ヘルパー ===== */
const ICONS = {
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
  assign: 'M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm0 4c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm6 12H6v-1.4c0-2 4-3.1 6-3.1s6 1.1 6 3.1V19z',
  folder: 'M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  up: 'M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z',
  down: 'M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z',
  people: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  refresh: 'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  back: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  fwd: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  class: 'M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z',
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  eye: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
  eyeoff: 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z',
  pin: 'M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z',
};
// 歯車は計算で描く(8枚の歯)
function gearPath() {
  const n = 8; const ro = 9.4; const ri = 7.4; const w = Math.PI / n; const pts = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2 * w;
    for (const [r, da] of [[ri, -0.95 * w], [ro, -0.5 * w], [ro, 0.5 * w], [ri, 0.95 * w]]) {
      pts.push(`${(12 + r * Math.cos(a + da)).toFixed(2)} ${(12 + r * Math.sin(a + da)).toFixed(2)}`);
    }
  }
  return `M${pts.join('L')}Z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0z`;
}
// 線で描くアイコン(ホーム・カレンダー・ベルなど、同じ太さ・同じ雰囲気でそろえる)
const STROKE_ICONS = {
  note: 'M6.5 3.5h8l4 4v12a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 19.5v-14A1.5 1.5 0 0 1 6.5 3.5z M14.5 3.5v4h4 M8.5 12h7 M8.5 15.5h7',
  home: 'M4 10.6 12 4l8 6.6V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z',
  calendar: 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M4 9.5h16 M8.5 3v4 M15.5 3v4',
  gear: gearPath(),
  bell: 'M5 18.5 6.5 17V11a5.5 5.5 0 0 1 11 0v6l1.5 1.5z M12 3v2 M10 21.3h4',
  megaphone: 'M3 9.5h4.5L19.5 4.5v13L7.5 14.5H3z M7.5 9.5v5 M5.5 14.5v5H9v-3',
  // 添付のクリップ(二重の輪)。縦に描いてから45度かたむける
  clip: { d: 'M17 21.5V8A5 5 0 0 0 7 8v9A1.5 1.5 0 0 0 10 17V7A1.5 1.5 0 0 1 13 7v8', transform: 'rotate(45 12 12)' },
  user: 'M12 4.5a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z M4.5 20c.6-3.6 3.6-5.5 7.5-5.5s6.9 1.9 7.5 5.5',
  clipboard: 'M8 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H16 M9 3.5h6v3H9z M8.5 11h7 M8.5 14.5h7 M8.5 18h4',
  bookmark: 'M5 4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5z M9.5 3v8l2.5-1.8 2.5 1.8V3',
  comment: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4 4v-4H4z M8 8.5h8 M8 11.5h5',
  trash: 'M5 7h14 M9.5 7V4.5h5V7 M7 7l.8 12.5h8.4L17 7 M10 11v5 M14 11v5',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  clock: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z M12 7.5V12l3 2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6L6 18',
  // 角帽(登録科目): 上の平らな板・帽子の本体・房
  cap: 'M12 4.5 2.5 9.2 12 14l9.5-4.8z M6.5 11.4v4.2c0 1.6 2.5 3 5.5 3s5.5-1.4 5.5-3v-4.2 M21.5 9.2v5.3 M20.3 16.1a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0-2.4 0z',
};

function icon(name, size = 20) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  const def = STROKE_ICONS[name];
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  if (def) {
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  } else svg.setAttribute('fill', 'currentColor');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', typeof def === 'string' ? def : def ? def.d : ICONS[name]);
  if (def && def.transform) p.setAttribute('transform', def.transform);
  svg.append(p);
  return svg;
}

// 添付のユーザーアイコン(青〜紫の丸に白い人)
let userIconSeq = 0;
function userIcon(size) {
  const NS = 'http://www.w3.org/2000/svg';
  const id = `ug${userIconSeq++}`; // 同じ画面に複数あっても、色の指定がぶつからないように番号をつける
  const mk = (tag, attrs, ...kids) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    kids.forEach((c) => e.append(c));
    return e;
  };
  return mk('svg', { viewBox: '0 0 100 100', width: size, height: size, 'aria-hidden': 'true' },
    mk('defs', {},
      mk('linearGradient', { id: `${id}g`, x1: '0', y1: '1', x2: '1', y2: '0' },
        mk('stop', { offset: '0', 'stop-color': '#72a8dc' }), mk('stop', { offset: '1', 'stop-color': '#5f66b8' })),
      mk('clipPath', { id: `${id}c` }, mk('circle', { cx: '50', cy: '50', r: '50' }))),
    mk('circle', { cx: '50', cy: '50', r: '50', fill: `url(#${id}g)` }),
    mk('g', { 'clip-path': `url(#${id}c)`, fill: '#fff' },
      mk('circle', { cx: '50', cy: '38', r: '20.5' }),
      mk('rect', { x: '16.5', y: '62', width: '67', height: '60', rx: '20' })));
}

function courseHue(id) {
  let x = 0;
  for (const c of String(id)) x = (x * 31 + c.charCodeAt(0)) % 360;
  return x;
}
// 「2026_全校生徒」のような名前でも、数字や記号を飛ばして最初の文字を頭文字にする
const initial = (name) => [...String(name).replace(/^[0-9_\-\s]+/, '')][0] || [...String(name)][0] || '?';
// 並び順は、ドラッグで決めた順 → 決めていないものは名前順。hidden のクラスは普段は除く
function sortedCourses(includeHidden = false) {
  const order = new Map((ui.courseOrder || []).map((id, i) => [id, i]));
  const rank = (c) => (order.has(c.id) ? order.get(c.id) : 1e6);
  const list = [...data.courses].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ja'));
  return includeHidden ? list : list.filter((c) => !ui.hidden.includes(c.id));
}
const byNewest = (a, b) => Date.parse(b.created) - Date.parse(a.created);

// 「月曜日」「明日」のような期限の言い方(Classroomのカードと同じ見せ方)
function dueLabel(ms) {
  const d = new Date(ms);
  const diff = Math.round((startOfDay(d).getTime() - startOfDay(new Date()).getTime()) / DAY);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff > 1 && diff < 7) return WD[d.getDay()] + '曜日';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 先生のアイコン。取得できない場合は、クラス名の頭文字を丸で表示する
function avatar(c, size) {
  const l = look(c.id);
  const el = h('div', {
    class: 'avatar',
    title: c.ownerName || '',
    style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.44)}px;--c:${courseColor(c.id)}`,
  });
  const fallback = () => el.replaceChildren(l.text || initial(c.name));
  const src = l.icon || (l.text ? '' : c.ownerPhoto);
  if (src) {
    const img = h('img', { src, alt: '' });
    img.addEventListener('error', fallback);
    el.append(img);
  } else fallback();
  return el;
}

/* ===== バナー・アイコン・日時のヘルパー ===== */
const fmtDT = (iso) => new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const isEdited = (it) => !!(it.updated && it.created && Date.parse(it.updated) - Date.parse(it.created) > 60000);
const profileOf = (id) => (id && (data.profiles || {})[id]) || null;
const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'ja');

// バナーの背景。画像 > 色 > 自動の色 の順
function bannerBg(c) {
  const l = look(c.id);
  if (l.banner) return `linear-gradient(rgba(0,0,0,.25), rgba(0,0,0,.25)), url("${l.banner}") center / cover no-repeat`;
  if (l.color) return `linear-gradient(rgba(0,0,0,.18), rgba(0,0,0,.18)), ${l.color}`;
  return `linear-gradient(rgba(0,0,0,.3), rgba(0,0,0,.3)), hsl(${courseHue(c.id)} 36% 46%)`;
}

// 投稿した人・参加者のアイコン(写真が無ければ頭文字)
function personAvatar(p, size) {
  const name = p?.name || '';
  const el = h('div', { class: 'avatar person', title: name, style: `width:${size}px;height:${size}px` });
  const fallback = () => { el.classList.add('generic'); el.replaceChildren(userIcon(size)); };
  if (p?.photo) {
    const img = h('img', { src: p.photo, alt: '' });
    img.addEventListener('error', fallback);
    el.append(img);
  } else fallback();
  return el;
}

/* ===== 投稿の見た目(Classroomのストリーム風) ===== */
const fmtMD = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}年` : '';
  return `${y}${d.getMonth() + 1}月${d.getDate()}日`;
};

// 添付の種類(ファイル名の拡張子から推測)
function fileKind(m) {
  if (m.type === 'video') return 'YouTube';
  if (m.type === 'form') return 'フォーム';
  const ext = ((m.title || '').match(/\.([A-Za-z0-9]{1,5})$/) || [])[1]?.toLowerCase();
  const map = { pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel', ppt: 'PowerPoint', pptx: 'PowerPoint', png: '画像', jpg: '画像', jpeg: '画像', gif: '画像', zip: 'ZIP', txt: 'テキスト', csv: 'CSV', mp4: '動画', mov: '動画' };
  return map[ext] || 'Google ドライブ';
}

// 添付ファイルをアプリ内のタブで開く(Ctrlを押しながらクリックでブラウザ)
function openFile(m) {
  if (/^https:\/\//.test(m.url || '')) openWeb(m.url, m.title, 'clip');
}
function attachCard(m) {
  const thumb = h('div', { class: 'att-thumb' });
  const glyph = () => thumb.replaceChildren(h('span', { class: 'att-glyph' }, icon('clip', 30)));
  if (m.thumb) {
    const img = h('img', { src: m.thumb, alt: '' });
    img.addEventListener('error', glyph); // ログインが必要などで読めないときは、アイコンにする
    thumb.append(img);
  } else glyph();
  return h('button', {
    class: 'att',
    title: `${m.title}\n(Ctrlを押しながらクリックで新しいタブで開く)`,
    onclick: (e) => { e.stopPropagation(); if (e.metaKey) api.openExternal(m.url); else openFile(m); },
  },
    h('div', { class: 'att-text' },
      h('div', { class: 'att-title' }, m.title),
      h('div', { class: 'att-sub' }, m.type === 'link' ? m.url : fileKind(m))),
    thumb);
}

function postMenuEntries(it) {
  const e = [['詳細を開く', () => openItem(it.key)]];
  if (it.link) {
    e.push(['Classroomを新しいタブで開く', () => openWeb(it.link, it.title)]);
    e.push(['新しいタブで開く', () => api.openExternal(it.link)]);
    e.push(['リンクをコピー', () => navigator.clipboard?.writeText(it.link)]);
  }
  if (it.kind === 'work') e.push([isWorkHidden(it) ? 'この課題を再表示' : 'この課題を非表示にする', () => toggleWorkHidden(it.key)]);
  return e;
}
const moreBtn = (it) => h('button', {
  class: 'post-more-btn', title: 'その他', 'aria-label': 'その他',
  onclick: (e) => { e.stopPropagation(); showMenu(e.currentTarget, postMenuEntries(it)); },
}, icon('more', 22));

// 課題・資料の丸いアイコン(クラスの色)
function postBadge(kind, courseId) {
  return h('span', { class: 'post-badge', style: `--c:${courseColor(courseId)}` }, icon((KIND[kind] || KIND.work).ico, 24));
}

// 「◯◯ さんが新しい課題を投稿しました: タイトル」の行
function postRow(it) {
  const pf = profileOf(it.creatorId);
  const verb = it.kind === 'material' ? '新しい資料' : '新しい課題';
  const hid = it.kind === 'work' && isWorkHidden(it);
  const meta = [fmtMD(it.created)];
  if (it.kind === 'work') {
    if (it.dueMs) meta.push(`期限: ${fmtDate(it.dueMs, it.allDay)}`);
    if (it.status === 'done') meta.push(it.subState === 'RETURNED' ? '返却済み' : '提出済み');
    if (it.grade != null) meta.push(`点数: ${gradeText(it)}`);
  }
  return h('div', {
    class: 'post-row' + (hid ? ' is-hidden-work' : ''), role: 'button', tabindex: '0',
    onclick: () => openItem(it.key),
    onkeydown: (e) => { if (e.key === 'Enter') openItem(it.key); },
  },
    postBadge(it.kind, it.courseId),
    h('div', { class: 'post-row-main' },
      h('div', { class: 'post-row-title' }, `${pf?.name ? pf.name + ' さんが' : ''}${verb}を投稿しました: `, h('b', {}, it.title)),
      h('div', { class: 'post-date' }, meta.filter(Boolean).join('  ・  '))),
    moreBtn(it));
}

// お知らせ: アイコン・名前・日付 / 本文 / 添付 / コメントを追加
function announcementCard(it) {
  const pf = profileOf(it.creatorId);
  const long = (it.text || '').length > 300 || ((it.text || '').match(/\n/g) || []).length > 9;
  return h('article', { class: 'post' },
    h('div', { class: 'post-head' },
      personAvatar(pf, 42, it.creatorId),
      h('div', { class: 'post-who' },
        h('div', { class: 'post-name' }, pf?.name || '投稿者'),
        h('div', { class: 'post-date' }, fmtMD(it.created), isEdited(it) ? `(最終編集: ${fmtMD(it.updated)})` : '')),
      moreBtn(it)),
    it.text ? h('div', { class: 'post-body', onclick: () => openItem(it.key) }, ...linkify(it.text)) : null,
    long ? h('button', { class: 'post-more', onclick: () => openItem(it.key) }, '続きを読む') : null,
    it.materials && it.materials.length ? h('div', { class: 'att-grid' }, ...it.materials.map(attachCard)) : null,
    h('div', { class: 'post-foot' },
      h('button', { class: 'post-comment', onclick: () => it.link && openWeb(it.link, it.title) }, icon('comment', 22), 'コメントを追加')));
}
const streamItem = (it) => (it.kind === 'announcement' ? announcementCard(it) : postRow(it));

// 左の「期限間近」カード
function dueSoonCard(works, tab) {
  const soon = works.filter((w) => w.status !== 'done' && w.dueMs && w.dueMs >= Date.now()).sort((a, b) => a.dueMs - b.dueMs).slice(0, 3);
  return h('aside', { class: 'duesoon' },
    h('h3', {}, '期限間近'),
    soon.length
      ? soon.map((w) => h('button', { class: 'ds-item', title: w.title, onclick: () => openItem(w.key) },
        h('div', {}, `期限: ${dueLabel(w.dueMs)}`),
        h('div', { class: 'ds-t' }, w.allDay ? w.title : `${hhmm(w.dueMs)} – ${w.title}`)))
      : h('p', { class: 'muted' }, '近日中に期限が来る課題はありません'),
    h('button', { class: 'ds-all', onclick: () => { tab.sub = 'work'; ui.filter = 'todo'; saveUi(); render(); } }, 'すべて表示'));
}

// 通知の丸いアイコン(お知らせは投稿した人のアイコン)
function kindBadge(n, item) {
  return postBadge(n.kind === 'due-changed' ? 'work' : n.kind, item?.courseId || n.courseName);
}

// クラス内検索(スペース区切りでAND)
function matchQ(it, q) {
  const t = (q || '').trim().toLowerCase();
  if (!t) return true;
  const pf = profileOf(it.creatorId);
  const hay = [it.title, it.text, pf?.name, ...(it.materials || []).map((m) => m.title)].join('\n').toLowerCase();
  return t.split(/\s+/).every((w) => hay.includes(w));
}

/* ===== 点数・提出(Classroomの仕様上、提出の操作はClassroomの提出ページで行う) ===== */
const gradeText = (it) => (it.grade != null ? `${it.grade}${it.maxPoints ? ` / ${it.maxPoints}` : ''}点` : '');
const SUB_LABEL = { TURNED_IN: '提出済み', RETURNED: '返却済み', RECLAIMED_BY_STUDENT: '提出を取り消し済み', NEW: '未提出', CREATED: '未提出' };
const subLabel = (it) => SUB_LABEL[it.subState] || (it.status === 'done' ? '提出済み' : '未提出');

const needsResubmit = (it) => ['RETURNED', 'RECLAIMED_BY_STUDENT'].includes(it.subState);
// 返却された・取り消した課題は「再提出」
const submitTabLabel = (it) => (needsResubmit(it) ? '再提出' : it.status === 'done' ? '提出済み' : '提出');

function submissionBody(it) {
  const url = it.subLink || it.link;
  const done = it.status === 'done';
  const returned = it.subState === 'RETURNED';
  const reclaimed = it.subState === 'RECLAIMED_BY_STUDENT';
  const open = () => url && openWeb(url, it.title);
  return h('div', {},
    h('div', { class: 'meta' },
      h('span', { class: 'pill' + (done ? ' ok' : '') }, subLabel(it)),
      it.grade != null ? h('span', { class: 'pill score' }, `点数 ${gradeText(it)}`) : null),
    returned ? h('p', {}, h('b', {}, '返却されました。'), it.grade != null ? ` 点数は ${gradeText(it)} です。` : '', ' やり直しや再提出が必要なときは、下のボタンから提出ページを開きます。') : null,
    reclaimed ? h('p', {}, '提出を取り消しています。内容を直して、もう一度提出してください。') : null,
    it.mySubmission && it.mySubmission.length
      ? h('div', {}, h('div', { class: 'muted' }, '提出したファイル'), h('div', { class: 'att-grid' }, ...it.mySubmission.map(attachCard)))
      : null,
    h('p', { class: 'muted' }, 'Classroomの仕様で、提出・取り消し・ファイルの追加は、このアプリから直接はできません。下のボタンで提出ページをアプリ内のタブで開き、そこで操作します。'),
    h('div', { class: 'actions col' },
      returned || reclaimed
        ? [h('button', { class: 'btn primary', onclick: open }, '再提出する'), h('button', { class: 'btn', onclick: open }, '返却された内容・フィードバックを見る')]
        : done
          ? [h('button', { class: 'btn primary', onclick: open }, '提出を取り消して再提出する'), h('button', { class: 'btn', onclick: open }, 'ファイルを追加する')]
          : h('button', { class: 'btn primary', onclick: open }, '提出する')));
}

// ClassroomのAPIにはコメントの機能が無いので、投稿ページをアプリ内タブで開いて書き込む
function commentBody(it) {
  const open = () => it.link && openWeb(it.link, it.title);
  return h('div', {},
    h('p', { class: 'muted' }, 'Classroomの仕様で、このアプリから直接コメントを書き込むことはできません。投稿ページをアプリ内のタブで開いて書き込みます。'),
    h('div', { class: 'actions col' },
      it.kind === 'work'
        ? [h('button', { class: 'btn primary', onclick: open }, '限定公開コメントを書く(先生だけ)'), h('button', { class: 'btn', onclick: open }, 'クラスのコメントを書く(全員に公開)')]
        : h('button', { class: 'btn primary', onclick: open }, 'コメントを書く(クラス全体に公開)')));
}

// 右側のパネル: 「提出/再提出」と「コメント」のタブを並べる
function sidePanel(it, tab) {
  const items = [];
  if (it.kind === 'work') items.push(['submit', submitTabLabel(it)]);
  if (it.link && it.kind !== 'material') items.push(['comment', 'コメント']);
  if (!items.length) return null;
  const cur = items.some(([k]) => k === tab.side) ? tab.side : items[0][0];
  return h('aside', { class: 'detail-side' },
    h('div', { class: 'side-tabs', role: 'tablist' },
      ...items.map(([k, label]) => h('button', { class: 'side-tab' + (cur === k ? ' on' : ''), role: 'tab', onclick: () => { tab.side = k; render(); } }, label))),
    h('div', { class: 'side-body' }, cur === 'submit' ? submissionBody(it) : commentBody(it)));
}

// 採点された課題・テストの一覧
function gradesView(list) {
  if (!list.length) return h('p', { class: 'muted empty' }, 'まだ採点された課題・テストはありません(採点されて返却されると、ここに表示されます)');
  const box = h('div', {});
  const withMax = list.filter((w) => w.maxPoints);
  const sum = withMax.reduce((a, w) => a + Number(w.grade), 0);
  const max = withMax.reduce((a, w) => a + Number(w.maxPoints), 0);
  if (max) {
    box.append(h('div', { class: 'grade-summary' },
      h('div', { class: 'gs-big' }, `${Math.round((sum / max) * 1000) / 10}%`),
      h('div', { class: 'muted' }, `合計 ${sum} / ${max} 点(${withMax.length}件の得点率)`)));
  }
  box.append(...[...list].sort(byNewest).map((w) => h('div', {
    class: 'post-row', role: 'button', tabindex: '0', onclick: () => openItem(w.key),
    onkeydown: (e) => { if (e.key === 'Enter') openItem(w.key); },
  },
    h('span', { class: 'post-badge score', style: `--c:${courseColor(w.courseId)}` }, w.maxPoints ? `${Math.round((w.grade / w.maxPoints) * 100)}%` : '–'),
    h('div', { class: 'post-row-main' }, h('div', { class: 'post-row-title' }, h('b', {}, w.title)), h('div', { class: 'post-date' }, fmtMD(w.created))),
    h('div', { class: 'score-big' }, gradeText(w)))));
  return box;
}

/* ===== 設定タブ(設定の画面をタブの中に置く) ===== */
function buildSettings() {
  settingsRoot.classList.remove('hidden');
  settingsRoot.classList.add('as-page');
  const page = h('div', { class: 'page' });
  page.append(settingsRoot);
  setTimeout(updateSettingsUi, 0);
  return page;
}

/* ===== メモタブ ===== */
let memos = (() => { try { return JSON.parse(localStorage.getItem('memos2') || '[]'); } catch { return []; } })();
let memoActive = null;
let memoTimer = null;
const saveMemos = () => {
  clearTimeout(memoTimer);
  memoTimer = setTimeout(() => { try { localStorage.setItem('memos2', JSON.stringify(memos)); } catch { alert('メモを保存できませんでした'); } }, 300);
};
const memoTitle = (m) => (m.body || '').split('\n').find((l) => l.trim())?.trim().slice(0, 40) || '(空のメモ)';
const memoSub = (m) => {
  const c = m.courseId && data.courses.find((x) => x.id === m.courseId);
  return `${c ? c.name + ' ・ ' : ''}${new Date(m.updated).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
};

function buildMemo() {
  const page = h('div', { class: 'page wide' });
  const list = h('div', { class: 'memo-list' });
  const editor = h('div', { class: 'memo-editor' });
  let q = '';
  if (!memoActive && memos.length) memoActive = [...memos].sort((a, b) => b.updated - a.updated)[0].id;

  function drawList() {
    const t = q.trim().toLowerCase();
    const rows = [...memos].sort((a, b) => b.updated - a.updated).filter((m) => !t || (m.body || '').toLowerCase().includes(t));
    list.replaceChildren(...rows.map((m) => h('button', {
      class: 'memo-item' + (m.id === memoActive ? ' on' : ''),
      onclick: () => { memoActive = m.id; drawList(); drawEditor(); },
    }, h('div', { class: 'memo-t' }, memoTitle(m)), h('div', { class: 'post-date' }, memoSub(m)))));
    if (!rows.length) list.append(h('p', { class: 'muted' }, memos.length ? '一致するメモはありません' : 'メモはまだありません'));
  }

  function drawEditor() {
    const m = memos.find((x) => x.id === memoActive);
    if (!m) { editor.replaceChildren(h('p', { class: 'muted empty' }, 'メモを選ぶか、「新しいメモ」を押してください')); return; }
    const ta = h('textarea', {
      class: 'memo-text', placeholder: 'ここにメモを書きます(自動で保存されます)', spellcheck: 'false',
      oninput: (e) => { m.body = e.target.value; m.updated = Date.now(); saveMemos(); drawList(); },
    });
    ta.value = m.body || '';
    editor.replaceChildren(
      h('div', { class: 'memo-bar' },
        h('select', { class: 'input', onchange: (e) => { m.courseId = e.target.value; m.updated = Date.now(); saveMemos(); drawList(); } },
          h('option', { value: '' }, 'クラスを指定しない'),
          ...sortedCourses(true).map((c) => h('option', { value: c.id, selected: c.id === m.courseId }, c.name))),
        h('span', { class: 'grow' }),
        h('button', {
          class: 'btn',
          onclick: () => { if (confirm('このメモを削除しますか?')) { memos = memos.filter((x) => x.id !== m.id); memoActive = null; saveMemos(); drawList(); drawEditor(); } },
        }, icon('trash', 18), '削除')),
      ta);
    return ta;
  }

  function newMemo() {
    const m = { id: 'm' + Date.now(), body: '', courseId: '', updated: Date.now() };
    memos.push(m);
    memoActive = m.id;
    saveMemos();
    drawList();
    const ta = drawEditor();
    if (ta && ta.focus) ta.focus();
  }

  drawList();
  drawEditor();
  page.append(h('div', { class: 'memo-cols' },
    h('div', { class: 'memo-side' },
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', onclick: newMemo }, '新しいメモ'),
        h('input', { class: 'input grow', type: 'search', placeholder: 'メモを検索', oninput: (e) => { q = e.target.value; drawList(); } })),
      list),
    editor));
  return page;
}

/* ===== 本文のURLを開けるようにする ===== */
// 本文の中のURLを、クリックで開けるリンクにする(アプリ内のタブで開く。Ctrlを押しながらクリックでブラウザ)
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]+/g;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
function linkify(text) {
  const s = String(text || '');
  const out = [];
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)'\]]+$/); // 文末の記号はURLに含めない
    if (trail) url = url.slice(0, -trail[0].length);
    if (!url) continue;
    out.push(s.slice(last, m.index));
    out.push(h('a', {
      class: 'lnk', href: url, title: `${url}\n(Ctrlを押しながらクリックで新しいタブで開く)`,
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        const u = url.replace(/^http:/, 'https:');
        if (e.metaKey) api.openExternal(u); else openWeb(u, hostOf(u), '🔗');
      },
    }, url));
    last = m.index + url.length;
  }
  out.push(s.slice(last));
  return out;
}

/* ===== 答案(自分が提出したファイル)をその場で表示する ===== */
// Googleドライブ・ドキュメントの「プレビュー」用のURLにする
function previewUrl(m) {
  const u = m.url || '';
  let mm = u.match(/drive\.google\.com\/file\/d\/([^/?#]+)/) || u.match(/drive\.google\.com\/open\?id=([^&#]+)/);
  if (mm) return `https://drive.google.com/file/d/${mm[1]}/preview`;
  mm = u.match(/docs\.google\.com\/(document|presentation|spreadsheets)\/d\/([^/?#]+)/);
  if (mm) return `https://docs.google.com/${mm[1]}/d/${mm[2]}/preview`;
  return u;
}

function answerSection(it, tab) {
  const files = it.mySubmission || [];
  if (it.kind !== 'work' || !files.length) return null;
  const returned = it.subState === 'RETURNED';
  const open = tab.showAnswer ?? returned; // 返却されたものは、最初から表示する
  const idx = Math.min(tab.answerIdx || 0, files.length - 1);
  const m = files[idx];
  const box = h('div', { class: 'answer' },
    h('h3', { class: 'group' }, icon('clip', 18), returned ? '返却された答案' : '提出した答案'),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn' + (open ? '' : ' primary'), onclick: () => { tab.showAnswer = !open; render(); } }, open ? '答案を閉じる' : '答案を表示'),
      ...(files.length > 1
        ? files.map((f, i) => h('button', {
          class: 'chip-btn' + (i === idx ? ' on' : ''), title: f.title,
          onclick: () => { tab.answerIdx = i; tab.showAnswer = true; render(); },
        }, f.title.length > 18 ? f.title.slice(0, 17) + '…' : f.title))
        : []),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: () => openFile(m) }, 'タブで大きく開く'),
      h('button', { class: 'btn', onclick: () => api.openExternal(m.url) }, '新しいタブで開く')));
  if (open) {
    box.append(
      IS_WEB
        ? h('iframe', { src: previewUrl(m), class: 'answer-view', allow: 'fullscreen' })
        : h('webview', { src: previewUrl(m), partition: 'persist:classroom', class: 'answer-view' }),
      h('p', { class: 'hint' }, '表示されないときは、アプリ内でGoogleにログインしていない可能性があります。「タブで大きく開く」でログインするか、「新しいタブで開く」を使ってください。'));
  }
  return box;
}

/* ===== 初回セットアップ / ログイン画面 ===== */
function webGate() {
  if (!data.hasCredentials) {
    const input = h('input', { class: 'input wide-input', placeholder: '1234567890-xxxxxxxx.apps.googleusercontent.com', spellcheck: 'false', autocomplete: 'off' });
    return h('div', { class: 'page gate' },
      h('h2', {}, 'Google連携の設定が必要です'),
      h('ol', {},
        h('li', {}, 'Google Cloud Console で、Google Classroom API(カレンダー連携を使うなら Google Calendar API も)を有効にする'),
        h('li', {}, '「OAuth同意画面」で、テストユーザーに自分のGoogleアカウントを追加する'),
        h('li', {}, '「認証情報」→「OAuthクライアントID」→ 種類「ウェブアプリケーション」を作成する'),
        h('li', {}, ['「承認済みのJavaScript生成元」に、次のアドレスを追加する: ', h('code', {}, location.origin)]),
        h('li', {}, '作成された「クライアントID」を、下に貼り付けて保存する')),
      h('div', { class: 'gate-row' }, input, h('button', {
        class: 'btn primary',
        onclick: async () => { try { await api.setClientId(input.value); } catch (e) { alert(cleanErr(e)); } },
      }, '保存')));
  }
  return h('div', { class: 'page gate' },
    h('h2', {}, 'Googleアカウントでログイン'),
    h('p', { class: 'muted' }, 'Googleのログイン画面が小さなウィンドウで開きます。許可すると、このアプリに戻ります。'),
    h('button', {
      class: 'btn primary',
      onclick: async () => { try { await api.signIn(); } catch (e) { alert(cleanErr(e)); } },
    }, 'Googleでログイン'));
}

function gate() {
  if (IS_WEB) return webGate();
  if (!data.hasCredentials) {
    return h('div', { class: 'page gate' },
      h('h2', {}, 'Google連携の設定が必要です'),
      h('ol', {},
        h('li', {}, 'Google Cloud Console でプロジェクトを作成し、Google Classroom API を有効にする'),
        h('li', {}, '「OAuth同意画面」を作り、テストユーザーに自分のGoogleアカウントを追加する'),
        h('li', {}, '「認証情報」→「OAuthクライアントID」→ 種類「デスクトップアプリ」を作成して、JSONをダウンロードする')),
      h('div', {}, h('button', {
        class: 'btn primary',
        onclick: async () => { try { await api.importCredentials(); } catch (e) { alert(cleanErr(e)); } },
      }, 'ダウンロードしたJSONを選ぶ')));
  }
  return h('div', { class: 'page gate' },
    h('h2', {}, 'Googleアカウントでログイン'),
    h('p', { class: 'muted' }, 'ブラウザが開きます。許可すると、このアプリに戻ります。'),
    h('button', {
      class: 'btn primary',
      onclick: async () => { try { await api.signIn(); } catch (e) { alert(cleanErr(e)); } },
    }, 'Googleでログイン'));
}

/* ===== 課題タブ ===== */
function groupWorks(works) {
  const sod = startOfDay(new Date()).getTime();
  const buckets = new Map(['期限切れ', '今日', '明日', '7日以内', 'それ以降', '期限なし', '提出済み'].map((k) => [k, []]));
  for (const w of works) {
    let key;
    if (w.status === 'done') key = '提出済み';
    else if (!w.dueMs) key = '期限なし';
    else if (w.dueMs < Date.now()) key = '期限切れ';
    else if (w.dueMs < sod + DAY) key = '今日';
    else if (w.dueMs < sod + 2 * DAY) key = '明日';
    else if (w.dueMs < sod + 8 * DAY) key = '7日以内';
    else key = 'それ以降';
    buckets.get(key).push(w);
  }
  for (const [k, arr] of buckets) {
    arr.sort((a, b) => (k === '提出済み' ? (b.dueMs ?? 0) - (a.dueMs ?? 0) : (a.dueMs ?? 9e15) - (b.dueMs ?? 9e15)));
  }
  return [...buckets].filter(([, a]) => a.length);
}

const isWorkHidden = (it) => ui.hiddenWorks.includes(it.key);
function toggleWorkHidden(key) {
  const s = new Set(ui.hiddenWorks);
  if (s.has(key)) s.delete(key); else s.add(key);
  ui.hiddenWorks = [...s];
  saveUi();
  render();
}

function workCard(it, opts = {}) {
  const hid = isWorkHidden(it);
  const card = h('button', {
    class: 'card' + (opts.big ? ' big' : '') + (hid ? ' is-hidden-work' : ''),
    style: `--c:${courseColor(it.courseId)}`,
    onclick: () => openItem(it.key),
  },
    h('div', { class: 'card-main' },
      h('div', { class: 'card-title' }, it.title),
      h('div', { class: 'card-sub' }, it.courseName),
      opts.big && it.text ? h('div', { class: 'card-body' }, it.text.replace(/\s+/g, ' ').slice(0, 100)) : null),
    it.dueMs
      ? h('div', { class: 'due ' + dueClass(it) }, it.status === 'done' ? fmtDate(it.dueMs, it.allDay) : `${fmtDate(it.dueMs, it.allDay)}  ${relative(it.dueMs)}`)
      : h('div', { class: 'muted' }, '期限なし'),
    it.status === 'done' ? h('span', { class: 'pill ok' }, it.late ? '提出済み(遅れ)' : '提出済み') : null,
    it.grade != null ? h('span', { class: 'pill score' }, gradeText(it)) : null,
    opts.hideable
      ? h('span', {
        class: 'eye', role: 'button', title: hid ? '再表示する' : 'この課題を非表示にする',
        onclick: (e) => { e.stopPropagation(); toggleWorkHidden(it.key); },
      }, icon(hid ? 'eye' : 'eyeoff', 20))
      : null);
  if (opts.preview) attachPreview(card, it);
  return card;
}

/* ---- カーソルを合わせたときのプレビュー(カレンダー右の締切など) ---- */
let prevTimer = null;
function hidePreview() {
  clearTimeout(prevTimer);
  document.getElementById('preview')?.remove();
}
function attachPreview(el, it) {
  el.addEventListener('mouseenter', () => { clearTimeout(prevTimer); prevTimer = setTimeout(() => showPreview(el, it), 250); });
  el.addEventListener('mouseleave', hidePreview);
  el.addEventListener('click', hidePreview);
}
function showPreview(anchor, it) {
  hidePreview();
  const r = anchor.getBoundingClientRect();
  const W = 340;
  const box = h('div', { class: 'preview', id: 'preview', style: `width:${W}px;left:${Math.max(8, r.left - W - 12)}px;top:${Math.max(8, r.top)}px` },
    h('div', { class: 'pv-course', style: `--c:${courseColor(it.courseId)}` }, it.courseName),
    h('div', { class: 'pv-title' }, it.title),
    h('div', { class: 'pv-meta' },
      it.dueMs ? `期限 ${fmtDate(it.dueMs, it.allDay)}(${relative(it.dueMs)})` : '期限なし', '  ・  ', it.status === 'done' ? '提出済み' : '未提出'),
    it.text ? h('div', { class: 'pv-body' }, it.text) : h('div', { class: 'muted' }, '説明はありません'),
    it.materials && it.materials.length ? h('div', { class: 'pv-meta' }, `添付 ${it.materials.length} 件`) : null);
  document.body.append(box);
  const height = box.offsetHeight || 220;
  box.style.top = Math.max(8, Math.min(r.top, window.innerHeight - height - 8)) + 'px';
}

function buildAssignments() {
  if (!ready()) return gate();
  const page = h('div', { class: 'page' });
  const list = h('div', {});
  const allWorks = data.items.filter((i) => i.kind === 'work');

  const chips = [['todo', '未提出'], ['done', '提出済み'], ['all', 'すべて']].map(([k, label]) =>
    h('button', { class: 'chip-btn', 'data-k': k, onclick: () => { ui.filter = k; saveUi(); draw(); } }, label));
  const courseSel = h('select', { class: 'input', onchange: (e) => { courseFilter = e.target.value; draw(); } },
    h('option', { value: '' }, 'すべてのコース'),
    ...data.courses.map((c) => h('option', { value: c.id, selected: c.id === courseFilter }, c.name)));
  const search = h('input', { class: 'input', type: 'search', placeholder: '検索', value: q, oninput: (e) => { q = e.target.value; draw(); } });

  function draw() {
    chips.forEach((c) => c.classList.toggle('on', c.dataset.k === ui.filter));
    let works = visibleWorks(allWorks);
    if (ui.filter === 'todo') works = works.filter((i) => i.status !== 'done');
    if (ui.filter === 'done') works = works.filter((i) => i.status === 'done');
    if (courseFilter) works = works.filter((i) => i.courseId === courseFilter);
    const t = q.trim().toLowerCase();
    if (t) works = works.filter((i) => (i.title + i.courseName).toLowerCase().includes(t));

    list.replaceChildren(...workGroups(works, { big: true, hideable: true }));
    if (!works.length) list.append(h('p', { class: 'muted empty' }, ui.filter === 'todo' ? '未提出の課題はありません' : '該当する課題はありません'));
  }

  draw();
  page.append(banner(), h('div', { class: 'toolbar' }, ...chips, courseSel, search, hiddenToggle(allWorks)), list);
  return page;
}

/* ===== 通知タブ ===== */
function buildNotifications() {
  if (!ready()) return gate();
  const unread = data.notifications.filter((n) => !n.read).length;
  const readN = data.notifications.length - unread;
  const page = h('div', { class: 'page' });
  page.append(
    banner(),
    h('div', { class: 'toolbar' },
      h('h2', { class: 'grow' }, unread ? `通知(未読 ${unread})` : '通知'),
      h('button', { class: 'btn', disabled: !unread, onclick: () => api.markRead('all') }, 'すべて既読にする'),
      h('button', { class: 'btn', disabled: !readN, onclick: () => api.deleteNotifs('read') }, '既読を削除'),
      h('button', { class: 'btn', disabled: !data.notifications.length, onclick: () => { if (confirm('通知をすべて削除します。よろしいですか?')) api.deleteNotifs('all'); } }, 'すべて削除')));

  if (!data.notifications.length) {
    page.append(h('p', { class: 'muted empty' }, '新しいお知らせや課題が届くと、ここに表示されます'));
    return page;
  }
  for (const n of data.notifications) {
    const item = data.items.find((i) => i.key === n.itemKey);
    page.append(h('button', {
      class: 'card notif' + (n.read ? '' : ' unread'),
      onclick: () => (item ? openItem(n.itemKey) : api.markRead([n.id])),
    },
      kindBadge(n, item),
      h('div', { class: 'card-main' },
        h('div', { class: 'card-title' }, n.title),
        h('div', { class: 'card-sub' }, `${n.courseName} ・ ${KIND[n.kind]?.label || ''}`),
        n.summary ? h('div', { class: 'card-body' }, n.summary) : null),
      h('div', { class: 'muted' }, ago(n.time)),
      n.read ? null : h('span', { class: 'unread-dot' }),
      h('span', { class: 'eye', role: 'button', title: 'この通知を削除', onclick: (e) => { e.stopPropagation(); api.deleteNotifs([n.id]); } }, icon('trash', 20))));
  }
  return page;
}

/* ===== カレンダータブ ===== */
function chip(w) {
  return h('div', {
    class: 'chip ' + dueClass(w),
    style: `--c:${courseColor(w.courseId)}`,
    title: `${w.title}\n${w.courseName}`,
    onclick: (e) => { e.stopPropagation(); openItem(w.key); },
  }, w.allDay ? null : h('b', {}, hhmm(w.dueMs) + ' '), w.title);
}

function buildCalendar() {
  if (!ready()) return gate();
  const month = ui.calMode === 'month';
  const works = data.items.filter((i) => i.kind === 'work' && i.dueMs && (!ui.calOnlyTodo || i.status !== 'done'));
  const byDay = new Map();
  for (const w of works) {
    const k = dayKey(new Date(w.dueMs));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(w);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => a.dueMs - b.dueMs);

  // 表示する日付の範囲
  const first = month ? new Date(calCursor.getFullYear(), calCursor.getMonth(), 1) : startOfDay(calCursor);
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - first.getDay());
  const monthDays = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 0).getDate();
  const count = month ? Math.ceil((first.getDay() + monthDays) / 7) * 7 : 7;
  const days = Array.from({ length: count }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const todayKey = dayKey(new Date());
  const selKey = dayKey(calSel);

  const move = (dir) => {
    calCursor = month
      ? new Date(calCursor.getFullYear(), calCursor.getMonth() + dir, 1)
      : new Date(calCursor.getFullYear(), calCursor.getMonth(), calCursor.getDate() + 7 * dir);
    render();
  };
  const title = month ? `${calCursor.getFullYear()}年${calCursor.getMonth() + 1}月` : `${fmtShort(days[0])} 〜 ${fmtShort(days[6])}`;

  const cell = (d) => {
    const k = dayKey(d);
    const arr = byDay.get(k) || [];
    const shown = month ? arr.slice(0, 3) : arr;
    return h('div', {
      class: 'cell' + (k === todayKey ? ' today' : '') + (k === selKey ? ' sel' : '') + (month && d.getMonth() !== calCursor.getMonth() ? ' other' : ''),
      onclick: () => { calSel = d; render(); },
    },
      h('span', { class: 'num' }, String(d.getDate())),
      ...shown.map(chip),
      month && arr.length > 3 ? h('div', { class: 'more' }, `ほか ${arr.length - 3} 件`) : null);
  };

  // 今日・明日・期限切れの件数
  const todo = works.filter((w) => w.status !== 'done');
  const sod = startOfDay(new Date()).getTime();
  const nToday = todo.filter((w) => w.dueMs >= Date.now() && w.dueMs < sod + DAY).length;
  const nTomorrow = todo.filter((w) => w.dueMs >= sod + DAY && w.dueMs < sod + 2 * DAY).length;
  const nOver = todo.filter((w) => w.dueMs < Date.now()).length;

  const main = h('div', { class: 'cal-main' + (month ? '' : ' week') },
    banner(),
    h('div', { class: 'cal-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', title: '前へ', onclick: () => move(-1) }, '‹'),
      h('button', { class: 'btn', onclick: () => { calCursor = new Date(); calSel = new Date(); render(); } }, '今日'),
      h('button', { class: 'icon-btn', title: '次へ', onclick: () => move(1) }, '›'),
      h('span', { class: 'grow' }),
      h('button', { class: 'chip-btn' + (month ? ' on' : ''), onclick: () => { ui.calMode = 'month'; saveUi(); render(); } }, '月'),
      h('button', { class: 'chip-btn' + (month ? '' : ' on'), onclick: () => { ui.calMode = 'week'; saveUi(); render(); } }, '週'),
      h('button', { class: 'chip-btn tint' + (ui.calOnlyTodo ? ' on' : ''), onclick: () => { ui.calOnlyTodo = !ui.calOnlyTodo; saveUi(); render(); } }, '未提出のみ')),
    h('p', { class: 'cal-summary' },
      '今日 ', h('b', {}, `${nToday}件`), ' ・ 明日 ', h('b', {}, `${nTomorrow}件`), ' ・ 期限切れ ', h('b', {}, `${nOver}件`)),
    h('div', { class: 'grid7' }, ...WD.map((w) => h('div', { class: 'dow' }, w)), ...days.map(cell)));

  const selItems = byDay.get(selKey) || [];
  const upcoming = todo.filter((w) => w.dueMs >= Date.now()).sort((a, b) => a.dueMs - b.dueMs).slice(0, 6);
  const side = h('aside', { class: 'side' },
    h('h3', {}, `${calSel.getMonth() + 1}/${calSel.getDate()}(${WD[calSel.getDay()]})の締切`),
    selItems.length ? selItems.map((w) => workCard(w, { preview: true })) : h('p', { class: 'muted' }, 'この日の締切はありません'),
    h('h3', {}, '次の締切'),
    upcoming.length ? upcoming.map((w) => workCard(w, { preview: true })) : h('p', { class: 'muted' }, '未提出の課題はありません'));

  return h('div', { class: 'page cal-page' }, main, side);
}

/* ===== 詳細タブ ===== */
function buildDetail(tab) {
  const page = h('div', { class: 'page wide detail' });
  const it = data.items.find((i) => i.key === tab.itemKey);
  if (!it) {
    page.append(h('p', { class: 'muted empty' }, 'このアイテムは一覧から見つかりませんでした'));
    return page;
  }
  const meta = [];
  if (it.kind === 'work') {
    meta.push(it.dueMs ? `期限 ${fmtDate(it.dueMs, it.allDay)}(${relative(it.dueMs)})` : '期限なし');
    meta.push(subLabel(it));
    if (it.late) meta.push('遅れて提出');
    if (it.grade != null) meta.push(`点数 ${gradeText(it)}`);
  }

  // 発信した人のアイコン・配信日時・最終編集日時(編集されたときだけ)
  const pf = profileOf(it.creatorId);
  const creator = h('div', { class: 'creator' },
    personAvatar(pf, 46, it.creatorId),
    h('div', {},
      h('div', { class: 'cname' }, pf?.name || '投稿者'),
      it.created
        ? h('div', { class: 'muted' }, `配信 ${fmtDT(it.created)}`, isEdited(it) ? `  ・  最終編集 ${fmtDT(it.updated)}` : '')
        : null));

  const main = h('div', { class: 'detail-main' },
    h('div', { class: 'detail-head', style: `--c:${courseColor(it.courseId)}` },
      h('div', { class: 'muted kind-line' }, icon(KIND[it.kind].ico, 18), it.courseName),
      h('h1', {}, it.title)),
    creator,
    meta.length ? h('div', { class: 'meta' }, ...meta.map((m) => h('span', { class: 'pill' + (['提出済み', '返却済み'].includes(m) ? ' ok' : '') }, m))) : null,
    it.text ? h('div', { class: 'body' }, ...linkify(it.text)) : h('p', { class: 'muted' }, '本文はありません'),
    it.materials.length
      ? h('div', {}, h('h3', { class: 'group' }, '添付'), h('div', { class: 'att-grid' }, ...it.materials.map(attachCard)))
      : null,
    answerSection(it, tab),
    it.link
      ? h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => openWeb(it.link, it.title) }, 'Classroomを新しいタブで開く'),
        h('button', { class: 'btn', onclick: () => api.openExternal(it.link) }, '新しいタブで開く'))
      : null);

  const side = sidePanel(it, tab);
  page.append(side ? h('div', { class: 'detail-cols' }, main, side) : main);
  return page;
}

/* ===== アプリ内ブラウザタブ(Classroom本体を開く) ===== */
function buildFrameTab(tab) {
  const frame = h('iframe', { src: tab.url, class: 'web-frame', allow: 'fullscreen', referrerpolicy: 'no-referrer-when-downgrade' });
  return h('div', { class: 'webwrap' },
    h('div', { class: 'webbar' },
      h('button', { class: 'icon-btn', title: '再読み込み', onclick: () => { frame.src = tab.url; } }, icon('refresh', 18)),
      h('span', { class: 'grow muted url' }, tab.url),
      h('button', { class: 'btn', onclick: () => api.openExternal(tab.url) }, '新しいタブで開く')),
    frame,
    h('p', { class: 'hint frame-hint' }, '表示されないときは、Googleにログインしていないか、ブラウザの設定でサードパーティCookieがブロックされている可能性があります。「新しいタブで開く」を使ってください。'));
}

function buildWeb(tab) {
  if (IS_WEB) return buildFrameTab(tab);
  const wv = h('webview', { src: tab.url, partition: 'persist:classroom' });
  tab.wv = wv;
  const urlEl = h('span', { class: 'grow muted url' }, tab.url);
  const call = (fn) => () => { try { fn(); } catch { /* 読み込み前は無視 */ } };
  wv.addEventListener('page-title-updated', (e) => { tab.title = e.title; renderTabbar(); });
  wv.addEventListener('did-navigate', (e) => { urlEl.textContent = e.url; renderNav(); });
  wv.addEventListener('did-navigate-in-page', renderNav);
  wv.addEventListener('dom-ready', renderNav);
  return h('div', { class: 'webwrap' },
    h('div', { class: 'webbar' },
      h('button', { class: 'icon-btn', title: '戻る', onclick: call(() => wv.canGoBack() && wv.goBack()) }, icon('back', 20)),
      h('button', { class: 'icon-btn', title: '進む', onclick: call(() => wv.canGoForward() && wv.goForward()) }, icon('fwd', 20)),
      h('button', { class: 'icon-btn', title: '再読み込み', onclick: call(() => wv.reload()) }, icon('refresh', 18)),
      urlEl,
      h('button', { class: 'btn', onclick: call(() => api.openExternal(wv.getURL())) }, '新しいタブで開く')),
    wv);
}

/* ===== ホーム(クラスのカード一覧) ===== */
let dragId = null;
let showHidden = false;

function courseCard(c, next, isHidden = false) {
  const btn = (name, label, fn) => h('button', {
    title: label,
    'aria-label': label,
    onclick: (e) => { e.stopPropagation(); fn(e); },
  }, icon(name, 22));
  const clearOver = () => document.querySelectorAll('.dragover').forEach((x) => x.classList.remove('dragover'));
  const menu = () => [
    ['クラスを開く', () => openCourse(c.id)],
    ['参加している生徒の一覧', () => openCourse(c.id, 'people')],
    ['ファイル(Googleドライブ)', () => openCourse(c.id, 'files')],
    ['バナー・アイコンを変更…', () => openCustomize(c)],
    ['先頭に移動', () => moveTo(c.id, 'first')],
    ['最後に移動', () => moveTo(c.id, 'last')],
    [isHidden ? 'ホームに再表示' : '非表示にする', () => hideCourse(c.id, !isHidden)],
    ['Classroomを新しいタブで開く', () => c.link && openWeb(c.link, c.name)],
    ['新しいタブで開く', () => c.link && api.openExternal(c.link)],
    ['登録解除…', () => leaveCourse(c), 'danger'],
  ];

  return h('article', {
    class: 'ccard' + (isHidden ? ' is-hidden' : ''),
    tabindex: '0',
    role: 'link',
    draggable: 'true',
    onclick: () => openCourse(c.id),
    onkeydown: (e) => { if (e.key === 'Enter') openCourse(c.id); },
    oncontextmenu: (e) => { e.preventDefault(); showMenu(pointAnchor(e), menu()); }, // 右クリックでも同じメニュー
    ondragstart: (e) => {
      dragId = c.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', c.id);
      e.currentTarget.classList.add('dragging');
    },
    ondragend: (e) => { dragId = null; e.currentTarget.classList.remove('dragging'); clearOver(); },
    ondragover: (e) => {
      if (!dragId || dragId === c.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.currentTarget.classList.add('dragover');
    },
    ondragleave: (e) => e.currentTarget.classList.remove('dragover'),
    ondrop: (e) => {
      e.preventDefault();
      const from = dragId;
      dragId = null;
      clearOver();
      if (from && from !== c.id) reorder(from, c.id);
    },
  },
    h('div', { class: 'cbanner', style: `background:${bannerBg(c)}` },
      h('div', { class: 'ctitle' }, c.name),
      c.section ? h('div', { class: 'csub' }, c.section) : null,
      avatar(c, 68)),
    h('div', { class: 'cbody' },
      next
        ? [h('div', {}, `期限: ${dueLabel(next.dueMs)}`),
           h('div', { class: 'cdue' }, next.allDay ? next.title : `${hhmm(next.dueMs)} - ${next.title}`)]
        : h('div', { class: 'muted' }, '直近の期限はありません')),
    ui.cardButtons
      ? h('div', { class: 'cfoot' },
        btn('user', '参加している生徒の一覧', () => openCourse(c.id, 'people')),
        btn('folder', 'ファイル(Googleドライブ)', () => openCourse(c.id, 'files')),
        btn('more', 'その他', (e) => showMenu(e.currentTarget, menu())))
      : null);
}

/* ---- 並べ替え・非表示・登録解除 ---- */
function reorder(fromId, toId) {
  const ids = sortedCourses(true).map((c) => c.id);
  const i = ids.indexOf(fromId);
  const j = ids.indexOf(toId);
  if (i < 0 || j < 0 || i === j) return;
  ids.splice(i, 1);
  ids.splice(j, 0, fromId);
  ui.courseOrder = ids;
  saveUi();
  render();
}
function moveTo(id, where) {
  const ids = sortedCourses(true).map((c) => c.id).filter((x) => x !== id);
  if (where === 'first') ids.unshift(id); else ids.push(id);
  ui.courseOrder = ids;
  saveUi();
  render();
}
function hideCourse(id, hide) {
  const s = new Set(ui.hidden);
  if (hide) s.add(id); else s.delete(id);
  ui.hidden = [...s];
  saveUi();
  render();
}
async function leaveCourse(c) {
  if (!confirm(`「${c.name}」の登録を解除します。\n\n元に戻せません。もう一度参加するには、先生からの招待かクラスコードが必要です。\n\n本当に解除しますか?`)) return;
  try {
    await api.unenroll(c.id);
    const t = tabs.find((x) => x.courseId === c.id);
    if (t) closeTab(t.id);
  } catch (e) {
    alert('登録解除できませんでした。\n' + cleanErr(e));
  }
}

function buildHome() {
  if (!ready()) return gate();
  const all = sortedCourses(true);
  const courses = all.filter((c) => !ui.hidden.includes(c.id));
  const hidden = all.filter((c) => ui.hidden.includes(c.id));
  // クラスごとに「いちばん近い未提出の期限」を求める
  const next = new Map();
  for (const w of data.items) {
    if (w.kind !== 'work' || w.status === 'done' || !w.dueMs || w.dueMs < Date.now()) continue;
    const cur = next.get(w.courseId);
    if (!cur || w.dueMs < cur.dueMs) next.set(w.courseId, w);
  }
  const page = h('div', { class: 'page wide' });
  page.append(
    banner(),
    h('div', { class: 'home-head' },
      h('h2', {}, `クラス (${courses.length})`),
      h('span', { class: 'grow' }),
      hidden.length ? h('button', { class: 'chip-btn' + (showHidden ? ' on' : ''), onclick: () => { showHidden = !showHidden; render(); } }, `非表示 (${hidden.length})`) : null,
      h('button', { class: 'btn add-class', onclick: openAddClass }, icon('add', 18), 'クラスを追加')),
    courses.length
      ? h('div', { class: 'cgrid' }, ...courses.map((c) => courseCard(c, next.get(c.id))))
      : h('p', { class: 'muted empty' }, data.syncing ? '読み込み中…' : '表示するクラスがありません'),
    showHidden && hidden.length
      ? h('div', {}, h('h3', { class: 'group' }, '非表示のクラス', h('span', { class: 'count' }, String(hidden.length))),
        h('div', { class: 'cgrid' }, ...hidden.map((c) => courseCard(c, next.get(c.id), true))))
      : null);
  return page;
}

/* ===== クラス専用タブ ===== */
function hiddenToggle(works) {
  const n = works.filter(isWorkHidden).length;
  if (!n) return null;
  return h('button', { class: 'chip-btn' + (ui.showHiddenWorks ? ' on' : ''), title: '非表示にした課題を表示/隠す', onclick: () => { ui.showHiddenWorks = !ui.showHiddenWorks; saveUi(); render(); } },
    ui.showHiddenWorks ? `非表示の課題を隠す (${n})` : `非表示の課題を表示 (${n})`);
}
const visibleWorks = (works) => (ui.showHiddenWorks ? works : works.filter((w) => !isWorkHidden(w)));

const workGroups = (works, opts = {}) => groupWorks(works).flatMap(([label, arr]) => [
  h('h3', { class: 'group' }, label, h('span', { class: 'count' }, String(arr.length))),
  ...arr.map((w) => (opts.post ? postRow(w) : workCard(w, opts))),
]);

function itemCard(it) {
  const pf = profileOf(it.creatorId);
  return h('button', { class: 'card', style: `--c:${courseColor(it.courseId)}`, onclick: () => openItem(it.key) },
    it.kind === 'announcement' ? personAvatar(pf, 38, it.creatorId) : h('span', { class: 'icon' }, icon(KIND[it.kind].ico, 22)),
    h('div', { class: 'card-main' },
      h('div', { class: 'card-title' }, it.title),
      it.created ? h('div', { class: 'card-sub' }, `${pf?.name ? pf.name + ' ・ ' : ''}配信 ${fmtDT(it.created)}${isEdited(it) ? ' ・ 編集済み' : ''}`) : null,
      it.text ? h('div', { class: 'card-body' }, it.text.replace(/\s+/g, ' ').slice(0, 120)) : null),
    it.created ? h('div', { class: 'muted' }, ago(it.created)) : null);
}

// 参加者の一覧(開いたときに取得)
function peopleView(tab, c, q = '') {
  const box = h('div', {});
  if (!tab.members && !tab.membersLoading) {
    tab.membersLoading = true;
    api.members(c.id)
      .then((m) => { tab.members = m; })
      .catch((e) => { tab.members = { error: cleanErr(e) }; })
      .finally(() => { tab.membersLoading = false; render(); });
  }
  const m = tab.members;
  if (!m) { box.append(h('p', { class: 'muted empty' }, '読み込み中…')); return box; }
  if (m.error) {
    box.append(h('div', { class: 'banner' }, m.error), h('button', { class: 'btn', onclick: () => { tab.members = null; render(); } }, '再読み込み'));
    return box;
  }
  const t = q.trim().toLowerCase();
  const f = (list) => (t ? list.filter((p) => (p.name || '').toLowerCase().includes(t)) : list);
  const section = (label, list) => [
    h('h3', { class: 'group' }, label, h('span', { class: 'count' }, String(list.length))),
    h('div', { class: 'people-grid' }, ...list.map((p) => h('div', { class: 'person' }, personAvatar(p, 36), h('span', { class: 'pname' }, p.name || '(名前なし)')))),
  ];
  box.append(...section('先生', f([...m.teachers].sort(byName))), ...section('生徒', f([...m.students].sort(byName))));
  return box;
}

// クラスの添付ファイル(Googleドライブなど)を、投稿をまたいで一覧にする
function filesView(c, items, q = '') {
  const rows = [];
  const seen = new Set();
  const t = q.trim().toLowerCase();
  for (const it of [...items].sort(byNewest)) {
    for (const m of it.materials || []) {
      if (seen.has(m.url)) continue;
      seen.add(m.url);
      if (!t || `${m.title} ${it.title}`.toLowerCase().includes(t)) rows.push({ m, it });
    }
  }
  const box = h('div', {});
  box.append(h('div', { class: 'toolbar' },
    h('button', { class: 'btn', onclick: () => openWeb('https://drive.google.com/', 'Googleドライブ') }, 'Googleドライブを開く'),
    c.folder ? h('button', { class: 'btn', onclick: () => api.openExternal(c.folder) }, 'クラスのフォルダを開く') : null));
  box.append(h('div', { class: 'att-grid' }, ...rows.map(({ m }) => attachCard(m))));
  if (!rows.length) box.append(h('p', { class: 'muted empty' }, q ? `「${q}」に一致するファイルはありません` : 'このクラスに添付されたファイルはありません'));
  return box;
}

function buildCourse(tab) {
  const page = h('div', { class: 'page wide course' });
  const c = data.courses.find((x) => x.id === tab.courseId);
  if (!c) {
    page.append(h('p', { class: 'muted empty' }, 'このクラスは見つかりませんでした'));
    return page;
  }
  const items = data.items.filter((i) => i.courseId === c.id);
  const works = items.filter((i) => i.kind === 'work');
  const anns = items.filter((i) => i.kind === 'announcement').sort(byNewest);
  const mats = items.filter((i) => i.kind === 'material').sort(byNewest);
  const graded = works.filter((i) => i.grade != null);
  const sub = tab.sub || 'all';
  const seg = (k, label) => h('button', { class: 'chip-btn' + (sub === k ? ' on' : ''), onclick: () => { tab.sub = k; render(); } }, label);
  const main = h('div', { class: 'feed' });
  const search = h('input', {
    class: 'input course-search', type: 'search', placeholder: 'このクラス内を検索', value: tab.q || '',
    oninput: (e) => { tab.q = e.target.value; drawMain(); }, // 入力のたびに一覧だけ描き直す(入力欄は保つ)
  });

  function drawMain() {
    const q = (tab.q || '').trim();
    const hit = (it) => matchQ(it, q);
    const none = (msg) => h('p', { class: 'muted empty' }, q ? `「${q}」に一致するものはありません` : msg);
    let nodes = [];
    if (sub === 'all') {
      const feed = [...items].sort(byNewest).filter(hit);
      nodes = feed.length ? feed.map(streamItem) : [none('まだ投稿がありません')];
    } else if (sub === 'work') {
      const filters = [['todo', '未提出'], ['done', '提出済み'], ['all', 'すべて']].map(([k, l]) =>
        h('button', { class: 'chip-btn' + (ui.filter === k ? ' on' : ''), onclick: () => { ui.filter = k; saveUi(); render(); } }, l));
      let list = visibleWorks(works).filter(hit);
      if (ui.filter === 'todo') list = list.filter((i) => i.status !== 'done');
      if (ui.filter === 'done') list = list.filter((i) => i.status === 'done');
      nodes = [h('div', { class: 'toolbar' }, ...filters, hiddenToggle(works)), ...workGroups(list, { post: true })];
      if (!list.length) nodes.push(none(ui.filter === 'todo' ? '未提出の課題はありません' : '該当する課題はありません'));
    } else if (sub === 'grades') {
      nodes = [gradesView(graded.filter(hit))];
    } else if (sub === 'people') {
      nodes = [peopleView(tab, c, q)];
    } else if (sub === 'files') {
      nodes = [filesView(c, items, q)];
    } else {
      const list = (sub === 'ann' ? anns : mats).filter(hit);
      nodes = list.length ? list.map(sub === 'ann' ? announcementCard : postRow) : [none(sub === 'ann' ? 'お知らせはありません' : '資料はありません')];
    }
    main.replaceChildren(...nodes);
  }
  drawMain();

  page.append(
    banner(),
    h('div', { class: 'chead', style: `background:${bannerBg(c)}` },
      h('button', { class: 'chead-edit', onclick: () => openCustomize(c) }, '✎ バナー・アイコンを変更'),
      h('div', { class: 'chead-text' }, h('h1', {}, c.name), c.section ? h('div', { class: 'csub' }, c.section) : null),
      avatar(c, 88)),
    h('div', { class: 'toolbar' },
      seg('all', `すべて (${items.length})`),
      seg('work', `課題 (${works.length})`), seg('ann', `お知らせ (${anns.length})`), seg('mat', `資料 (${mats.length})`),
      seg('grades', `成績 (${graded.length})`), seg('people', 'メンバー'), seg('files', 'ファイル'),
      h('span', { class: 'grow' }),
      search,
      c.link ? h('button', { class: 'btn', onclick: () => openWeb(c.link, c.name) }, 'Classroomで開く') : null),
    ['people', 'files'].includes(sub)
      ? main
      : h('div', { class: 'course-cols' }, dueSoonCard(works, tab), main));
  return page;
}

function openCourse(id, sub) {
  const c = data.courses.find((x) => x.id === id);
  if (!c) return;
  let tab = tabs.find((t) => t.courseId === id);
  if (!tab) {
    tab = { id: 'course:' + id, kind: 'course', courseId: id, title: c.name, sub: 'all' };
    tabs.push(tab);
  }
  if (sub) tab.sub = sub;
  activate(tab.id);
}

// クラスへの参加はClassroom本体で行う。タブを閉じたときに自動で再同期して、新しいクラスを反映する
function openAddClass() {
  const tab = { id: 'web:' + Date.now(), kind: 'web', url: 'https://classroom.google.com/', glyph: 'globe', title: 'クラスに参加', syncOnClose: true };
  tabs.push(tab);
  activate(tab.id);
}

/* ===== ポップアップメニュー(カードの⋮) ===== */
const closeMenu = () => document.getElementById('popmenu')?.remove();
// entries: [ラベル, 実行する関数, 'danger'など, アイコン名, チェックを付けるか] / 'sep' は区切り線
// opts.align === 'left' のときは、ボタンの左端に合わせて表示する
function showMenu(anchor, entries, opts = {}) {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  const seps = entries.filter((x) => x === 'sep').length;
  const height = (entries.length - seps) * 40 + seps * 9 + 12;
  const top = r.bottom + height > window.innerHeight ? r.top - height : r.bottom + 4;
  const left = opts.align === 'left' ? r.left : r.right - 230;
  const m = h('div', { class: 'popmenu', id: 'popmenu', style: `top:${Math.max(8, top)}px;left:${Math.max(8, left)}px` },
    ...entries.map((x) => (x === 'sep'
      ? h('hr', { class: 'pm-sep' })
      : h('button', { class: x[2] || null, onclick: () => { closeMenu(); x[1](); } },
        x[3] ? icon(x[3], 18) : null,
        h('span', { class: 'pm-label' }, x[0]),
        x[4] ? h('span', { class: 'pm-check' }, icon('check', 16)) : null))));
  document.body.append(m);
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}

/* ===== バナー・アイコンの変更ダイアログ ===== */
const PRESET = ['#c0392b', '#e67e22', '#d4a017', '#2e7d32', '#00838f', '#1565c0', '#6a1b9a', '#455a64'];
const escClose = (e) => { if (e.key === 'Escape') closeModal(); };
function closeModal() {
  document.getElementById('modal')?.remove();
  document.removeEventListener('keydown', escClose);
}

// 画像を選んで、保存しやすい大きさに縮小する(アイコンは正方形に切り抜き)
function pickImage(maxW, maxH, square) {
  return new Promise((resolve, reject) => {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return resolve(null);
      try {
        const bmp = await createImageBitmap(f);
        let sx = 0; let sy = 0; let sw = bmp.width; let sh = bmp.height;
        if (square) { const s = Math.min(sw, sh); sx = (sw - s) / 2; sy = (sh - s) / 2; sw = s; sh = s; }
        const k = Math.min(1, maxW / sw, maxH / sh);
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(sw * k));
        cv.height = Math.max(1, Math.round(sh * k));
        cv.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/webp', 0.82));
      } catch { reject(new Error('この画像は読み込めませんでした')); }
    });
    input.click();
  });
}

function openCustomize(c) {
  closeModal();
  const box = h('div', { class: 'modal' });
  const set = (patch) => {
    const next = { ...look(c.id), ...patch };
    for (const k of Object.keys(next)) if (next[k] == null || next[k] === '') delete next[k];
    if (Object.keys(next).length) looks[c.id] = next; else delete looks[c.id];
    if (saveLooks()) { draw(); render(); }
  };
  const choose = async (maxW, maxH, square, key, other) => {
    try {
      const d = await pickImage(maxW, maxH, square);
      if (d) set({ [key]: d, ...other });
    } catch (e) { alert(cleanErr(e)); }
  };

  function draw() {
    const l = look(c.id);
    box.replaceChildren(
      h('h3', {}, `「${c.name}」のバナーとアイコン`),
      h('div', { class: 'cbanner cust-preview', style: `background:${bannerBg(c)}` },
        h('div', { class: 'ctitle' }, c.name),
        c.section ? h('div', { class: 'csub' }, c.section) : null,
        avatar(c, 68)),
      h('div', { class: 'mrow' },
        h('b', {}, 'バナー'),
        ...PRESET.map((col) => h('button', { class: 'swatch' + (l.color === col && !l.banner ? ' on' : ''), style: `background:${col}`, title: col, onclick: () => set({ color: col, banner: null }) })),
        h('input', { type: 'color', value: l.color || '#1565c0', title: '好きな色', onchange: (e) => set({ color: e.target.value, banner: null }) }),
        h('button', { class: 'btn', onclick: () => choose(960, 480, false, 'banner', {}) }, '画像を選ぶ…'),
        h('button', { class: 'btn', disabled: !(l.color || l.banner), onclick: () => set({ color: null, banner: null }) }, '元に戻す')),
      h('div', { class: 'mrow' },
        h('b', {}, 'アイコン'),
        h('button', { class: 'btn', onclick: () => choose(192, 192, true, 'icon', { text: null }) }, '画像を選ぶ…'),
        h('input', { class: 'input', placeholder: '文字・絵文字', maxlength: '2', value: l.text || '', onchange: (e) => set({ text: e.target.value.trim(), icon: null }) }),
        h('button', { class: 'btn', disabled: !(l.icon || l.text), onclick: () => set({ icon: null, text: null }) }, '元に戻す')),
      h('p', { class: 'hint' }, '設定はこのパソコンに保存されます。画像は自動で小さくします。'),
      h('div', { class: 'mrow end' }, h('button', { class: 'btn primary', onclick: closeModal }, '閉じる')));
  }

  const back = h('div', { class: 'modal-back', id: 'modal', onclick: closeModal }, box);
  box.addEventListener('click', (e) => e.stopPropagation());
  draw();
  document.body.append(back);
  document.addEventListener('keydown', escClose);
}

/* ===== 左サイドバー(最小化・最大化できる) ===== */
function toggleSidebar() {
  ui.sidebar = ui.sidebar === 'mini' ? 'open' : 'mini';
  saveUi();
  renderSidebar();
}

// サイドバーの小さな丸(クラスのアイコン)。コントラストは控えめ
function sbDot(c) {
  const l = look(c.id);
  const el = h('span', { class: 'sb-dot', style: `--c:${courseColor(c.id)}` });
  if (l.icon) { el.classList.add('has-img'); el.append(h('img', { src: l.icon, alt: '' })); } else el.append(l.text || initial(c.name));
  return el;
}

const toggleSettings = () => activate('settings');

const sidebarCourses = () => sortedCourses().filter((c) => !ui.sidebarHidden.includes(c.id));

// サイドバーのクラスを右クリック
function sbCourseMenu(e, c) {
  showMenu(pointAnchor(e), [
    ['クラスを開く', () => openCourse(c.id)],
    ['メニューから非表示', () => { ui.sidebarHidden = [...new Set([...ui.sidebarHidden, c.id])]; saveUi(); render(); }],
    ['ホームでも非表示にする', () => hideCourse(c.id, true)],
    ['バナー・アイコンを変更…', () => openCustomize(c)],
  ]);
}

const brandLogo = () => h('span', { class: 'brand-logo' },
  h('img', { class: 'bl-light', src: 'assets/classroom-logo.png', alt: '' }),
  h('img', { class: 'bl-dark', src: 'assets/classroom-logo-dark.svg', alt: '' }));

// クラスごとの未読の通知数
function unreadByCourse() {
  const m = new Map();
  const byName = new Map(data.courses.map((c) => [c.name, c.id]));
  for (const n of data.notifications) {
    if (n.read) continue;
    const cid = n.courseId || String(n.itemKey || '').split(':')[1] || byName.get(n.courseName);
    if (cid) m.set(cid, (m.get(cid) || 0) + 1);
  }
  return m;
}

// 左メニューの幅をドラッグで変える(ダブルクリックで元に戻す)
function startResize(e) {
  if (ui.sidebar === 'mini') return;
  e.preventDefault();
  const sb = $('#sidebar');
  const startX = e.clientX;
  const startW = sb.getBoundingClientRect().width || ui.sidebarWidth || 250;
  sb.classList.add('resizing');
  const move = (ev) => {
    const w = Math.max(200, Math.min(460, Math.round(startW + ev.clientX - startX)));
    ui.sidebarWidth = w;
    document.documentElement.style.setProperty('--sb-w', w + 'px');
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    sb.classList.remove('resizing');
    saveUi();
    updateSettingsUi();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function renderSidebar() {
  const sb = $('#sidebar');
  const mini = ui.sidebar === 'mini';
  const activeCourse = tabs.find((t) => t.id === active && t.kind === 'course')?.courseId;
  const scroll = sb.querySelector('.sb-list')?.scrollTop || 0;
  const courses = sidebarCourses();
  const hiddenN = sortedCourses().length - courses.length;
  const unread = data.notifications.filter((n) => !n.read).length;
  const perCourse = unreadByCourse();
  const nav = (id, ico, label, count = 0) => h('button', { class: 'sb-item' + (active === id ? ' on' : ''), title: label, onclick: () => activate(id) },
    icon(ico, 24),
    mini ? null : h('span', { class: 'sb-label' }, label),
    count ? h('span', { class: 'sb-badge' + (mini ? ' dot' : '') }, mini ? '' : String(count)) : null);

  sb.classList.toggle('mini', mini);
  sb.replaceChildren(
    h('div', { class: 'sb-head' },
      h('button', { class: 'sb-btn', title: mini ? 'メニューを大きくする (Alt+B)' : 'メニューを小さくする (Alt+B)', onclick: toggleSidebar }, icon('menu')),
      mini ? null : h('div', { class: 'sb-brand' }, brandLogo(), h('span', {}, 'Classroom'))),
    nav('home', 'home', 'ホーム'),
    nav('calendar', 'calendar', 'カレンダー'),
    nav('memo', 'note', 'メモ'), // カレンダーの下
    nav('notifications', 'bell', '通知', unread),
    mini
      ? h('hr', { class: 'sb-sep' })
      : h('button', { class: 'sb-section', onclick: () => { ui.coursesOpen = !ui.coursesOpen; saveUi(); renderSidebar(); } },
        h('span', { class: 'sb-sec-title' }, h('span', { class: 'sec-ico' }, icon('cap', 24)), `登録科目 (${courses.length})`), icon(ui.coursesOpen ? 'up' : 'down', 20)),
    mini || ui.coursesOpen
      ? h('div', { class: 'sb-list' }, ...courses.map((c) => h('button', {
        class: 'sb-item' + (c.id === activeCourse ? ' on' : '') + (perCourse.get(c.id) ? ' has-unread' : ''),
        title: perCourse.get(c.id) ? `${c.name}(未読の通知 ${perCourse.get(c.id)} 件)` : c.name,
        onclick: () => openCourse(c.id),
        oncontextmenu: (e) => { e.preventDefault(); sbCourseMenu(e, c); },
      },
        sbDot(c),
        mini ? null : h('span', { class: 'sb-label' }, c.name),
        !mini && perCourse.get(c.id) ? h('span', { class: 'sb-badge' }, String(perCourse.get(c.id))) : null))) // 展開時だけ、クラスごとの通知数
      : null,
    hiddenN && !mini && ui.coursesOpen
      ? h('button', { class: 'sb-restore', onclick: () => { ui.sidebarHidden = []; saveUi(); render(); } }, `非表示の ${hiddenN} 件を戻す`)
      : null,
    // 設定は登録科目の下(いちばん下)
    h('button', { class: 'sb-item sb-settings' + (active === 'settings' ? ' on' : ''), title: '設定 (Alt+,)', onclick: toggleSettings },
      icon('gear', 24), mini ? null : h('span', { class: 'sb-label' }, '設定')),
    mini ? null : h('div', {
      class: 'sb-resize', title: 'ドラッグで幅を変更(ダブルクリックで元に戻す)',
      onmousedown: startResize,
      ondblclick: () => { ui.sidebarWidth = 250; saveUi(); applyUi(); updateSettingsUi(); },
    }));
  const list = sb.querySelector('.sb-list');
  if (list) list.scrollTop = scroll;
}

/* ===== タブの管理 ===== */
const BUILDERS = { home: buildHome, assignments: buildAssignments, notifications: buildNotifications, calendar: buildCalendar, memo: buildMemo, settings: buildSettings };
const buildFor = (tab) => (tab.kind === 'fixed' ? BUILDERS[tab.id]() : tab.kind === 'course' ? buildCourse(tab) : buildDetail(tab));

const GROUP_COLORS = ['#d93025', '#e8710a', '#c79a00', '#188038', '#129eaf', '#1a73e8', '#9334e6', '#5f6368'];
const isPinned = (id) => ui.pinned.includes(id);
const pointAnchor = (e) => ({ getBoundingClientRect: () => ({ top: e.clientY, bottom: e.clientY, left: e.clientX, right: e.clientX + 230 }) });

function pruneGroups() {
  const used = new Set(Object.values(ui.tabGroup));
  ui.groups = ui.groups.filter((g) => used.has(g.id));
}
function togglePin(id) {
  const s = new Set(ui.pinned);
  if (s.has(id)) s.delete(id); else { s.add(id); delete ui.tabGroup[id]; pruneGroups(); }
  ui.pinned = [...s];
  saveUi();
  render();
}
function setGroup(id, gid) {
  if (gid) { ui.tabGroup[id] = gid; ui.pinned = ui.pinned.filter((x) => x !== id); } else delete ui.tabGroup[id];
  pruneGroups();
  saveUi();
  render();
}
function ungroupAll(gid) {
  for (const [k, v] of Object.entries(ui.tabGroup)) if (v === gid) delete ui.tabGroup[k];
  pruneGroups();
  saveUi();
  render();
}
function hideTab(id) {
  closeTab(id);
}
function showTab(id) {
  activate(id);
}

// 表示する順番: ホーム → ピン留め → (グループごとにまとめた)その他
const visibleTabs = () => tabs.filter((t) => t.id === 'home' || !(t.kind === 'fixed' && ui.hiddenTabs.includes(t.id))); // ホームは常に表示

// 表示する順番: ホーム → ピン留め → (グループごとにまとめた)その他
function tabEntries() {
  const vis = visibleTabs();
  const rest = vis.filter((t) => t.id !== 'home' && !isPinned(t.id));
  const out = [...vis.filter((t) => t.id === 'home'), ...vis.filter((t) => t.id !== 'home' && isPinned(t.id))].map((t) => ({ t }));
  const done = new Set();
  for (const t of rest) {
    const g = ui.groups.find((x) => x.id === ui.tabGroup[t.id]);
    if (!g) { out.push({ t }); continue; }
    if (done.has(g.id)) continue;
    done.add(g.id);
    const members = rest.filter((m) => ui.tabGroup[m.id] === g.id);
    out.push({ g, members });
    for (const m of members) if (!g.collapsed || m.id === active) out.push({ t: m, g });
  }
  return out;
}

function tabMenu(e, t) {
  if (t.id === 'home') return;
  const cur = ui.tabGroup[t.id];
  const entries = [[isPinned(t.id) ? 'ピン留めを外す' : 'ピン留めする', () => togglePin(t.id)]];
  for (const g of ui.groups) if (g.id !== cur) entries.push([`グループ「${g.name || '無題'}」に追加`, () => setGroup(t.id, g.id)]);
  entries.push(['新しいグループに追加…', () => openGroupDialog(null, t.id)]);
  if (cur) entries.push(['グループから外す', () => setGroup(t.id, null)]);
  entries.push(['タブを閉じる', () => closeTab(t.id)]);
  showMenu(pointAnchor(e), entries);
}
function groupMenu(e, g) {
  showMenu(pointAnchor(e), [
    ['名前・色を変更…', () => openGroupDialog(g)],
    [g.collapsed ? '展開する' : '折りたたむ', () => { g.collapsed = !g.collapsed; saveUi(); render(); }],
    ['グループを解除', () => ungroupAll(g.id)],
    ['グループのタブを閉じる', () => {
      for (const t of tabs.filter((x) => ui.tabGroup[x.id] === g.id && x.kind !== 'fixed')) closeTab(t.id);
      ungroupAll(g.id);
    }, 'danger'],
  ]);
}
// 「⋯」: 固定タブの表示/非表示
function closeAllTabs() {
  for (const t of [...tabs]) if (t.id !== 'home') closeTab(t.id); // ホームだけは残る
}
// 「⋯」: 固定タブの開閉と、すべて閉じる
// 「⋯」: 固定タブの開閉と、すべて閉じる
function tabsMenu(anchor) {
  const vis = new Set(visibleTabs().map((t) => t.id));
  showMenu(anchor, [
    ...FIXED.map((t) => (t.id === 'home'
      ? [`${t.title}(閉じられません)`, () => activate('home'), null, t.icon, true]
      : [t.title, () => (vis.has(t.id) ? closeTab(t.id) : showTab(t.id)), null, t.icon, vis.has(t.id)])),
    'sep',
    ['ホーム以外のタブをすべて閉じる', closeAllTabs, 'danger', 'close'],
    'sep',
    ['新しいタブ', () => openWeb('https://classroom.google.com/', 'Classroom'), null, 'plus'],
  ], { align: 'left' });
}

function openGroupDialog(g, tabId) {
  closeModal();
  const draft = g ? { ...g } : { id: 'g' + Date.now(), name: '', color: GROUP_COLORS[ui.groups.length % GROUP_COLORS.length], collapsed: false };
  const box = h('div', { class: 'modal small' });
  const save = () => {
    if (g) Object.assign(g, { name: draft.name.trim(), color: draft.color });
    else {
      ui.groups.push({ ...draft, name: draft.name.trim() });
      ui.tabGroup[tabId] = draft.id;
      ui.pinned = ui.pinned.filter((x) => x !== tabId);
    }
    saveUi();
    closeModal();
    render();
  };
  function draw() {
    box.replaceChildren(
      h('h3', {}, g ? 'グループを編集' : '新しいグループ'),
      h('div', { class: 'mrow' }, h('b', {}, '名前'),
        h('input', { class: 'input wide', value: draft.name, placeholder: '例: 数学', maxlength: '20', oninput: (e) => { draft.name = e.target.value; } })),
      h('div', { class: 'mrow' }, h('b', {}, '色'),
        ...GROUP_COLORS.map((col) => h('button', { class: 'swatch' + (draft.color === col ? ' on' : ''), style: `background:${col}`, title: col, onclick: () => { draft.color = col; draw(); } }))),
      h('div', { class: 'mrow end' }, h('button', { class: 'btn primary', onclick: save }, '完了')));
  }
  draw();
  document.body.append(h('div', { class: 'modal-back', id: 'modal', onclick: closeModal }, box));
  box.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', escClose);
}

let syncIco = null;

let dragTabId = null;

// タブを動かす。ホームはいつも先頭
function moveTab(fromId, toId) {
  if (fromId === 'home' || fromId === toId) return;
  const i = tabs.findIndex((t) => t.id === fromId);
  const j0 = tabs.findIndex((t) => t.id === toId);
  if (i < 0 || j0 < 0) return;
  const [t] = tabs.splice(i, 1);
  const j = tabs.findIndex((x) => x.id === toId);
  tabs.splice(toId === 'home' ? j + 1 : (i < j0 ? j + 1 : j), 0, t); // 右へ動かすときは相手の後ろ、左へは前
  ui.tabOrder = tabs.map((x) => x.id).slice(0, 80);
  saveUi();
  render();
}
// 保存した並び順を反映(新しく開いたタブは末尾)
function applyTabOrder() {
  const order = ui.tabOrder || [];
  if (!order.length) return;
  const idx = (t) => { const i = order.indexOf(t.id); return i < 0 ? 1e6 : i; };
  const sorted = tabs.map((t, k) => [t, k]).sort((a, b) => idx(a[0]) - idx(b[0]) || a[1] - b[1]).map((x) => x[0]);
  tabs.splice(0, tabs.length, ...sorted);
  const hi = tabs.findIndex((t) => t.id === 'home');
  if (hi > 0) tabs.unshift(...tabs.splice(hi, 1));
}

function tabButton(t, g, unread) {
  const pinned = isPinned(t.id);
  return h('button', {
    class: 'tab' + (t.id === active ? ' active' : '') + (t.icon ? ' icon-tab' : '') + (t.id === 'home' ? ' is-home' : '') + (pinned ? ' pinned' : '') + (g ? ' in-group' : ''),
    style: g ? `--g:${g.color}` : null,
    title: t.title,
    draggable: t.id === 'home' ? null : 'true',
    onclick: () => activate(t.id),
    onauxclick: (e) => { if (e.button === 1 && !pinned && t.id !== 'home') closeTab(t.id); },
    oncontextmenu: (e) => { e.preventDefault(); tabMenu(e, t); },
    ondragstart: (e) => { dragTabId = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); },
    ondragover: (e) => { if (!dragTabId || dragTabId === t.id) return; e.preventDefault(); e.currentTarget.classList.add('tab-over'); },
    ondragleave: (e) => e.currentTarget.classList.remove('tab-over'),
    ondrop: (e) => { e.preventDefault(); const from = dragTabId; dragTabId = null; if (from) moveTab(from, t.id); },
    ondragend: () => { dragTabId = null; document.querySelectorAll('.tab-over').forEach((x) => x.classList.remove('tab-over')); },
  },
    pinned ? icon('pin', 13) : null,
    t.glyph ? icon(t.glyph, 17) : null,
    t.icon ? icon(t.icon, 20) : h('span', { class: 'tab-title' }, t.title),
    t.id === 'notifications' && unread ? h('span', { class: 'badge' }, String(unread)) : null,
    !pinned && t.id !== 'home' ? h('span', { class: 'tab-close', onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, '×') : null);
}

function renderTabbar() {
  const unread = data.notifications.filter((n) => !n.read).length;
  const els = tabEntries().map((e) => (e.t
    ? tabButton(e.t, e.g, unread)
    : h('button', {
      class: 'tab-group' + (e.g.collapsed ? ' collapsed' : ''),
      style: `--g:${e.g.color}`,
      title: 'クリックで折りたたみ・展開 / 右クリックで編集',
      onclick: () => { e.g.collapsed = !e.g.collapsed; saveUi(); render(); },
      oncontextmenu: (ev) => { ev.preventDefault(); groupMenu(ev, e.g); },
    }, e.g.name || '無題', e.g.collapsed ? h('span', { class: 'gcount' }, String(e.members.length)) : null)));
  $('#tabs').replaceChildren(
    ...els,
    h('button', { class: 'tab-add', title: '新しいタブ・タブの表示/非表示', onclick: (e) => { e.stopPropagation(); tabsMenu(e.currentTarget); } }, '+'));
  if (syncIco) syncIco.classList.toggle('spin', !!data.syncing); // 回すのは矢印だけ
  $('#btn-sync').title = data.lastSync ? `今すぐ同期 (最終: ${new Date(data.lastSync).toLocaleString('ja-JP')})` : '今すぐ同期 (Alt+R)';
  renderNav();
}

// 前回ピン留め・グループ分けしたクラスのタブを、起動時に開き直す
function restoreTabs() {
  const wanted = new Set([...ui.pinned, ...Object.keys(ui.tabGroup)]);
  for (const id of wanted) {
    if (!id.startsWith('course:') || tabs.some((t) => t.id === id)) continue;
    const c = data.courses.find((x) => 'course:' + x.id === id);
    if (c) tabs.push({ id, kind: 'course', courseId: c.id, title: c.name, sub: 'all' });
  }
}

function viewFor(tab) {
  let el = viewEls.get(tab.id);
  if (!el) {
    el = h('section', { class: 'view hidden' + (tab.id === 'home' ? ' is-home' : '') });
    viewEls.set(tab.id, el);
    $('#views').append(el);
  }
  return el;
}

function refreshView(tab) {
  const el = viewFor(tab);
  if (tab.id === 'memo' && typeof el.contains === 'function' && el.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA') return;
  if (tab.kind === 'web') {
    if (!el.firstChild) el.append(buildWeb(tab)); // webview は作り直さない(閲覧状態を保つ)
    return;
  }
  if (tab.kind === 'detail') {
    const it = data.items.find((i) => i.key === tab.itemKey);
    const sig = JSON.stringify([it?.updated, it?.status, it?.subState, it?.grade, (it?.mySubmission || []).length,
      tab.showAnswer, tab.answerIdx, tab.side, Object.keys(data.profiles || {}).length]);
    if (el.firstChild && tab.sig === sig) return;
    tab.sig = sig;
  }
  const old = el.querySelector('.page');
  const top = old ? old.scrollTop : 0;
  el.replaceChildren(buildFor(tab));
  const page = el.querySelector('.page');
  if (page) page.scrollTop = top;
}

function buildEmptyTabs() {
  return h('div', { class: 'page gate' },
    h('h2', {}, '開いているタブがありません'),
    h('p', { class: 'muted' }, '開きたい画面を選んでください'),
    h('div', { class: 'actions center' }, ...FIXED.map((t) => h('button', { class: 'btn', onclick: () => activate(t.id) }, t.title))));
}

function render() {
  hidePreview();
  const vis = visibleTabs();
  if (!vis.some((t) => t.id === active)) active = vis.length ? vis[0].id : null;
  renderTabbar();
  renderSidebar();
  for (const t of tabs) {
    const el = viewFor(t);
    const on = t.id === active;
    el.classList.toggle('hidden', !on);
    if (on) refreshView(t);
  }
  // タブが1つも無いとき
  let empty = viewEls.get('__empty');
  if (!empty) { empty = h('section', { class: 'view hidden' }); viewEls.set('__empty', empty); $('#views').append(empty); }
  empty.classList.toggle('hidden', active !== null);
  if (active === null) empty.replaceChildren(buildEmptyTabs());
}

// 画面の履歴(戻る・進む)。Webタブの中では、ページの履歴を優先する
let hist = ['home'];
let hpos = 0;
function activate(id, fromHist = false) {
  if (ui.hiddenTabs.includes(id)) { ui.hiddenTabs = ui.hiddenTabs.filter((x) => x !== id); saveUi(); } // 非表示のタブへ移動したら再表示
  if (!fromHist && hist[hpos] !== id) {
    hist = hist.slice(0, hpos + 1);
    hist.push(id);
    hpos = hist.length - 1;
  }
  active = id;
  render();
}
const tabExists = (id) => tabs.some((t) => t.id === id);
function histTarget(dir) {
  let p = hpos + dir;
  while (p >= 0 && p < hist.length && !tabExists(hist[p])) p += dir;
  return p >= 0 && p < hist.length ? p : -1;
}
const activeWeb = () => { const t = tabs.find((x) => x.id === active); return t && t.kind === 'web' && t.wv ? t.wv : null; };
function webCan(dir) {
  try { const w = activeWeb(); return !!w && (dir < 0 ? w.canGoBack() : w.canGoForward()); } catch { return false; }
}
const canStep = (dir) => webCan(dir) || histTarget(dir) >= 0;
function navStep(dir) {
  if (webCan(dir)) { const w = activeWeb(); if (dir < 0) w.goBack(); else w.goForward(); return; }
  const p = histTarget(dir);
  if (p < 0) return;
  hpos = p;
  activate(hist[p], true);
}
function renderNav() {
  $('#nav-back').disabled = !canStep(-1);
  $('#nav-fwd').disabled = !canStep(1);
}

function closeTab(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t || id === 'home') return; // ホームは消せない
  const idx = visibleTabs().findIndex((x) => x.id === id);
  if (t.kind === 'fixed') {
    // 固定タブも閉じられる(「⋯」やサイドバーからまた開ける)
    if (!ui.hiddenTabs.includes(id)) ui.hiddenTabs.push(id);
  } else {
    tabs.splice(tabs.indexOf(t), 1);
    if (t.syncOnClose) api.syncNow();
    viewEls.get(id)?.remove();
    viewEls.delete(id);
    ui.pinned = ui.pinned.filter((x) => x !== id);
    delete ui.tabGroup[id];
    pruneGroups();
  }
  saveUi();
  if (active === id) {
    const after = visibleTabs();
    const next = after[Math.max(0, Math.min(idx - 1, after.length - 1))];
    if (next) activate(next.id);
    else { active = null; render(); }
  } else render();
}

function openItem(key) {
  const it = data.items.find((i) => i.key === key);
  if (!it) return;
  let tab = tabs.find((t) => t.itemKey === key);
  if (!tab) {
    tab = { id: 'item:' + key, kind: 'detail', itemKey: key, glyph: KIND[it.kind].ico, title: it.title };
    tabs.push(tab);
  }
  const ids = data.notifications.filter((n) => n.itemKey === key && !n.read).map((n) => n.id);
  if (ids.length) api.markRead(ids);
  activate(tab.id);
}

function openWeb(url, title, glyph = 'globe') {
  if (IS_WEB) {
    // ブラウザ版: Googleドライブ・ドキュメントのプレビューだけアプリ内のタブに表示し、ほかは新しいブラウザタブで開く
    const pv = previewUrl({ url });
    if (!/\/preview$/.test(pv)) { api.openExternal(url); return; }
    url = pv;
  }
  const tab = { id: 'web:' + Date.now() + Math.random().toString(36).slice(2, 6), kind: 'web', url, glyph, title };
  tabs.push(tab);
  activate(tab.id);
}

function handleCmd(c) {
  const order = tabEntries().filter((e) => e.t).map((e) => e.t);
  const cur = Math.max(0, order.findIndex((t) => t.id === active));
  if (c === 'close-tab') { if (active) closeTab(active); }
  else if (c === 'next-tab') { if (order.length) activate(order[(cur + 1) % order.length].id); }
  else if (c === 'prev-tab') { if (order.length) activate(order[(cur - 1 + order.length) % order.length].id); }
  else if (c === 'nav-back') navStep(-1);
  else if (c === 'nav-forward') navStep(1);
  else if (c === 'toggle-sidebar') toggleSidebar();
  else if (c === 'settings') toggleSettings();
  else if (c.startsWith('tab:')) activate(c.slice(4));
}

/* ===== 設定ドロワー ===== */
const readEl = (el) => (el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' || el.dataset.num !== undefined ? Number(el.value) : el.value);
const writeEl = (el, v) => { if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; };

function updateSettingsUi() {
  updateWebSettings();
  settingsRoot.querySelectorAll('[data-ui]').forEach((el) => { if (document.activeElement !== el) writeEl(el, ui[el.dataset.ui]); });
  settingsRoot.querySelectorAll('[data-set]').forEach((el) => { if (document.activeElement !== el) writeEl(el, data.settings?.[el.dataset.set]); });
  const last = settingsRoot.querySelector('#last-sync');
  if (last) last.textContent = data.lastSync ? `最終同期: ${new Date(data.lastSync).toLocaleString('ja-JP')}` : 'まだ同期していません';
  const out = settingsRoot.querySelector('#btn-signout');
  if (out) out.disabled = !data.signedIn;
}

function updateWebSettings() {
  if (!IS_WEB || !api.web) return;
  const perm = api.web.notifyPermission();
  const btn = $('#btn-notif-perm');
  if (btn) {
    btn.textContent = perm === 'granted' ? '許可済み' : perm === 'denied' ? 'ブロック中(ブラウザの設定で変更)' : '許可する';
    btn.disabled = perm === 'granted' || perm === 'denied' || perm === 'unsupported';
  }
  const v = $('#app-version');
  if (v) v.textContent = `バージョン: ${api.web.version() || '(確認中)'}`;
}

// 新しいバージョンがあるときの案内(「今すぐ更新」で再読み込み)
function showUpdateBanner() {
  if (document.getElementById('update-banner')) return;
  const bar = h('div', { class: 'update-banner', id: 'update-banner', role: 'status' },
    h('span', {}, '新しいバージョンがあります。'),
    h('button', { class: 'btn primary', onclick: () => location.reload() }, '今すぐ更新'),
    h('button', { class: 'btn', onclick: () => bar.remove() }, 'あとで'));
  document.body.append(bar);
}

function bindWebSettings() {
  if (!IS_WEB || !api.web) return;
  $('#btn-notif-perm').onclick = async () => { await api.web.requestNotifyPermission(); updateWebSettings(); };
  $('#btn-update-check').onclick = async () => {
    $('#update-status').textContent = '確認中…';
    const r = await api.web.checkUpdate(true);
    $('#update-status').textContent = r.error ? '確認できませんでした' : r.updated ? '新しいバージョンがあります' : '最新です';
    updateWebSettings();
  };
  $('#btn-reset-client').onclick = async () => {
    if (!confirm('クライアントIDを入力し直します。いったんサインアウトされます。よろしいですか?')) return;
    await api.signOut();
    await api.setClientId('');
  };
  // ブラウザは ⌘/Ctrl のショートカットを多く使うので、Alt を使う(Alt+W: タブを閉じる, Alt+B: メニューの大小, Alt+R: 同期, Alt+, : 設定, Alt+0〜4: タブ, Alt+←/→: 戻る/進む)
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const map = { KeyW: 'close-tab', KeyB: 'toggle-sidebar', Comma: 'settings', Digit0: 'tab:home', Digit1: 'tab:assignments', Digit2: 'tab:notifications', Digit3: 'tab:calendar', Digit4: 'tab:memo', ArrowLeft: 'nav-back', ArrowRight: 'nav-forward' };
    if (e.code === 'KeyR') { e.preventDefault(); api.syncNow(); return; }
    if (map[e.code]) { e.preventDefault(); handleCmd(map[e.code]); }
  });
}

function bindSettings() {
  bindWebSettings();
  $('#settings-close').onclick = () => closeTab('settings');
  $('#btn-sync').onclick = () => api.syncNow();
  $('#nav-back').onclick = () => navStep(-1);
  $('#nav-fwd').onclick = () => navStep(1);
  $('#btn-cal-sync').onclick = () => api.syncCalendar();
  $('#btn-signout').onclick = () => { if (confirm('サインアウトします。よろしいですか?')) api.signOut(); };
  $('#btn-font-reset').onclick = () => {
    for (const k of FONT_KEYS) ui[k] = UI_DEFAULT[k];
    saveUi();
    applyUi();
    updateSettingsUi();
  };
  $('#btn-class-reset').onclick = () => {
    if (!confirm('クラスの並び順・非表示・バナー/アイコンの設定をすべて初期化します。よろしいですか?')) return;
    ui.courseOrder = [];
    ui.hidden = [];
    ui.sidebarHidden = [];
    looks = {};
    saveUi();
    saveLooks();
    render();
  };

  document.querySelectorAll('[data-ui]').forEach((el) => el.addEventListener('input', () => {
    ui[el.dataset.ui] = readEl(el);
    saveUi();
    applyUi();
  }));
  document.querySelectorAll('[data-set]').forEach((el) => el.addEventListener('change', () => {
    api.setSettings({ [el.dataset.set]: readEl(el) });
  }));
}

/* ===== 起動 ===== */
(async function init() {
  applyUi();
  bindSettings();
  syncIco = h('span', { class: 'sync-ico' }, icon('refresh', 18));
  $('#btn-sync').replaceChildren(syncIco);
  $('#nav-back').replaceChildren(icon('back', 22));
  $('#nav-fwd').replaceChildren(icon('fwd', 22));

  api.onData((d) => { data = d; restoreTabs(); applyTabOrder(); updateSettingsUi(); render(); });
  api.onOpenItem((key) => { if (dataLoaded) openItem(key); else pendingOpen = key; });
  api.onCommand(handleCmd);
  if (api.onUpdate) api.onUpdate(() => showUpdateBanner());

  data = await api.getData();
  dataLoaded = true;
  restoreTabs();
  applyTabOrder();
  updateSettingsUi();
  render();
  if (pendingOpen) { openItem(pendingOpen); pendingOpen = null; }
})();
