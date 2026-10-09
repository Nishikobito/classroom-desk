'use strict';
// ブラウザ版用(自動生成: tools/build-web.js が src/main/classroom.js から作ります。直接編集しないでください)
(() => {
async function api(pathname, params = {}, method = 'GET') {
  const url = new URL('https://classroom.googleapis.com/v1/' + pathname);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  return window.CdHttp.request(url.toString(), method);
}

async function listAll(pathname, key, params = {}) {
  const out = [];
  let pageToken;
  do {
    const d = await api(pathname, { ...params, pageToken });
    out.push(...(d[key] || []));
    pageToken = d.nextPageToken;
  } while (pageToken);
  return out;
}

// 権限が無い・存在しない(403/404)コースの項目だけは黙って空にする
const soft = (p) =>
  p.catch((e) => {
    const s = e?.response?.status;
    if (s === 403 || s === 404) return [];
    throw e;
  });

function normMaterials(list = []) {
  return list
    .map((m) => {
      if (m.driveFile) return { type: 'drive', title: m.driveFile.driveFile?.title || 'Drive ファイル', url: m.driveFile.driveFile?.alternateLink, thumb: fixPhoto(m.driveFile.driveFile?.thumbnailUrl) };
      if (m.link) return { type: 'link', title: m.link.title || m.link.url, url: m.link.url, thumb: fixPhoto(m.link.thumbnailUrl) };
      if (m.youtubeVideo) return { type: 'video', title: m.youtubeVideo.title || 'YouTube', url: m.youtubeVideo.alternateLink, thumb: fixPhoto(m.youtubeVideo.thumbnailUrl) };
      if (m.form) return { type: 'form', title: m.form.title || 'フォーム', url: m.form.formUrl, thumb: fixPhoto(m.form.thumbnailUrl) };
      return null;
    })
    .filter((m) => m && m.url);
}

// 期限(dueDate/dueTime)は UTC で返ってくる。時刻なしの場合は「その日の終わり(ローカル)」扱いにする
function parseDue(w) {
  if (!w.dueDate) return { dueMs: null, allDay: false };
  const { year, month, day } = w.dueDate;
  if (w.dueTime) {
    const { hours = 0, minutes = 0 } = w.dueTime;
    return { dueMs: Date.UTC(year, month - 1, day, hours, minutes), allDay: false };
  }
  return { dueMs: new Date(year, month - 1, day, 23, 59).getTime(), allDay: true };
}

const firstLine = (t) => (t || '').split('\n').find((l) => l.trim())?.trim().slice(0, 60) || '(お知らせ)';

// 先生(クラスのオーナー)の名前とアイコン。権限が無い・取得できない場合は null(画面側は頭文字アイコンにする)
const profileCache = new Map(); // ownerId -> { v, t }
async function ownerProfile(id) {
  const hit = profileCache.get(id);
  if (hit && Date.now() - hit.t < (hit.v ? 864e5 : 36e5)) return hit.v;
  let v = null;
  try {
    const d = await api(`userProfiles/${id}`);
    const photo = d.photoUrl ? (d.photoUrl.startsWith('//') ? 'https:' + d.photoUrl : d.photoUrl) : '';
    v = { name: d.name?.fullName || '', photo };
  } catch (e) {
    if (/invalid_grant/.test(String(e?.message))) throw e;
  }
  profileCache.set(id, { v, t: Date.now() });
  return v;
}
const clearProfileCache = () => profileCache.clear();

async function fetchAll() {
  const courses = await listAll('courses', 'courses', { courseStates: 'ACTIVE', studentId: 'me' });
  const owners = [...new Set(courses.map((c) => c.ownerId).filter(Boolean))];
  const profiles = new Map(await Promise.all(owners.map(async (id) => [id, await ownerProfile(id)])));
  const items = [];

  await Promise.all(
    courses.map(async (c) => {
      const [works, subs, anns, mats] = await Promise.all([
        soft(listAll(`courses/${c.id}/courseWork`, 'courseWork')),
        soft(listAll(`courses/${c.id}/courseWork/-/studentSubmissions`, 'studentSubmissions', { userId: 'me' })),
        soft(api(`courses/${c.id}/announcements`, { pageSize: 30 }).then((d) => d.announcements || [])),
        soft(api(`courses/${c.id}/courseWorkMaterials`, { pageSize: 30 }).then((d) => d.courseWorkMaterial || [])),
      ]);
      const subByWork = new Map(subs.map((s) => [s.courseWorkId, s]));
      const base = { courseId: c.id, courseName: c.name };

      for (const w of works) {
        const sub = subByWork.get(w.id);
        items.push({
          ...base,
          key: `w:${c.id}:${w.id}`,
          kind: 'work',
          title: w.title,
          text: w.description || '',
          link: w.alternateLink,
          created: w.creationTime,
          creatorId: w.creatorUserId || '',
          updated: w.updateTime,
          materials: normMaterials(w.materials),
          ...parseDue(w),
          status: sub && ['TURNED_IN', 'RETURNED'].includes(sub.state) ? 'done' : 'todo',
          late: !!sub?.late,
          subState: sub?.state || '', // NEW / CREATED / TURNED_IN / RETURNED / RECLAIMED_BY_STUDENT
          subLink: sub?.alternateLink || '', // 自分の提出ページ
          mySubmission: normMaterials(sub?.assignmentSubmission?.attachments), // 提出したファイル
          grade: sub?.assignedGrade ?? null,
          maxPoints: w.maxPoints ?? null,
        });
      }
      for (const a of anns) {
        items.push({
          ...base,
          key: `a:${c.id}:${a.id}`,
          kind: 'announcement',
          title: firstLine(a.text),
          text: a.text || '',
          link: a.alternateLink,
          created: a.creationTime,
          creatorId: a.creatorUserId || '',
          updated: a.updateTime,
          materials: normMaterials(a.materials),
        });
      }
      for (const m of mats) {
        items.push({
          ...base,
          key: `m:${c.id}:${m.id}`,
          kind: 'material',
          title: m.title,
          text: m.description || '',
          link: m.alternateLink,
          created: m.creationTime,
          creatorId: m.creatorUserId || '',
          updated: m.updateTime,
          materials: normMaterials(m.materials),
        });
      }
    })
  );

  // 連絡などを投稿した人のプロフィール(名前・アイコン)も集める
  const ids = new Set([...owners, ...items.map((i) => i.creatorId).filter(Boolean)]);
  const profileObj = {};
  await Promise.all([...ids].map(async (id) => {
    const p = profiles.has(id) ? profiles.get(id) : await ownerProfile(id);
    if (p) profileObj[id] = p;
  }));

  return {
    courses: courses.map((c) => ({
      id: c.id,
      name: c.name,
      section: c.section || '',
      room: c.room || '',
      link: c.alternateLink || '',
      folder: c.teacherFolder?.alternateLink || '', // 先生のアカウントだけ取得できる
      ownerName: profiles.get(c.ownerId)?.name || '',
      ownerPhoto: profiles.get(c.ownerId)?.photo || '',
    })),
    items,
    profiles: profileObj,
  };
}

const fixPhoto = (u) => (u ? (u.startsWith('//') ? 'https:' + u : u) : '');

// クラスの参加者(先生と生徒)。開いたときだけ取得する
async function fetchMembers(courseId) {
  const pick = (u) => ({ id: u.userId, name: u.profile?.name?.fullName || '', photo: fixPhoto(u.profile?.photoUrl) });
  try {
    const [teachers, students] = await Promise.all([
      listAll(`courses/${courseId}/teachers`, 'teachers'),
      listAll(`courses/${courseId}/students`, 'students'),
    ]);
    return { teachers: teachers.map(pick), students: students.map(pick) };
  } catch (e) {
    if (e?.response?.status === 403) {
      throw new Error('参加者の一覧を見る権限がありません。学校の設定で制限されているか、許可が足りません(設定からサインアウトして、もう一度ログインしてください)');
    }
    throw e;
  }
}

// 自分の登録解除(元に戻せない)。呼び出し側で必ず確認ダイアログを出すこと
async function unenroll(courseId) {
  try {
    await api(`courses/${courseId}/students/me`, {}, 'DELETE');
  } catch (e) {
    if (e?.response?.status === 403) {
      throw new Error('このアプリからは登録解除できませんでした(権限がありません)。Classroom本体で解除してください');
    }
    throw e;
  }
}

window.ClassroomCore = { fetchAll, fetchMembers, unenroll, clearProfileCache };

})();
