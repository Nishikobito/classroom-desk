'use strict';
// 通知まわりの判断(Mac版とブラウザ版で共通)。画面を持たない、計算だけのモジュール。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CdLogic = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const HOUR = 36e5;
  const DAY = 864e5;
  const DEFAULT_KEYWORDS = ['テスト', '提出', '締切', '変更', '延期', '持ち物'];

  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

  // タイトル・本文に、強調したいキーワードが含まれるか
  function matchKeyword(it, keywords) {
    const words = (keywords || []).map((w) => String(w).trim().toLowerCase()).filter(Boolean);
    if (!words.length) return false;
    const hay = `${it.title || ''}\n${it.text || ''}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  }

  // 新着の扱い: キーワードに合う → 強調(ミュート中のクラスでも通知する) / ミュート中のクラス → 既読の状態で届く(数字・通知には出ない)
  function classify(it, settings) {
    const important = matchKeyword(it, settings.keywords);
    const muted = !important && (settings.mutedCourses || []).includes(it.courseId);
    return { important, muted };
  }

  // 提出期限が近い(あと hours 時間以内)のに、未提出の課題。同じ期限で一度知らせたものは除く
  function dueReminders(items, hours, now, reminded) {
    const limit = hours * HOUR;
    return items.filter((it) => it.kind === 'work' && it.status !== 'done' && it.dueMs
      && it.dueMs > now && it.dueMs - now <= limit && (reminded || {})[it.key] !== it.dueMs);
  }

  function remainText(ms) {
    return ms < HOUR ? `あと${Math.max(1, Math.round(ms / 60000))}分` : `あと約${Math.round(ms / HOUR)}時間`;
  }

  // 朝のまとめ: 'send'(今出す) / 'wait'(まだ時刻前) / 'skip'(4時間以上過ぎたので今日は出さない) / 'done'(今日はもう出した)
  function digestAction(now, timeStr, lastKey) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr || '');
    const target = m ? Number(m[1]) * 60 + Number(m[2]) : 7 * 60 + 30;
    const cur = now.getHours() * 60 + now.getMinutes();
    if (lastKey === dayKey(now)) return 'done';
    if (cur < target) return 'wait';
    if (cur > target + 240) return 'skip';
    return 'send';
  }

  function buildDigest(items, unread, now) {
    const t = now.getTime();
    const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todo = items.filter((it) => it.kind === 'work' && it.status !== 'done' && it.dueMs);
    const overdue = todo.filter((it) => it.dueMs < t);
    const today = todo.filter((it) => it.dueMs >= t && it.dueMs < sod + DAY);
    const tomorrow = todo.filter((it) => it.dueMs >= sod + DAY && it.dueMs < sod + 2 * DAY);
    const lines = [`今日の期限 ${today.length}件 ・ 明日 ${tomorrow.length}件 ・ 期限切れ ${overdue.length}件`];
    if (unread) lines.push(`未読の通知 ${unread}件`);
    for (const it of [...today, ...overdue].slice(0, 3)) lines.push(`・${it.title}`);
    return {
      counts: { overdue: overdue.length, today: today.length, tomorrow: tomorrow.length, unread },
      title: '今日のまとめ',
      body: lines.join('\n'),
      empty: !overdue.length && !today.length && !tomorrow.length && !unread,
    };
  }

  return { DEFAULT_KEYWORDS, dayKey, matchKeyword, classify, dueReminders, remainText, digestAction, buildDigest };
}));
