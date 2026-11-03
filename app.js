/* ===================== Setup check ===================== */
const cfg = window.__FIREBASE_CONFIG__ || {};
if (!cfg.apiKey || cfg.apiKey === "YOUR_API_KEY") {
  document.getElementById('screen-setup').classList.remove('hidden');
  throw new Error("Firebase not configured yet — see screen-setup");
}

firebase.initializeApp(cfg);
const auth = firebase.auth();
const db = firebase.firestore();

/* ===================== Web Share Target capture (Android: "공유" → 인생찜) =====================
   Runs immediately so the shared payload survives before anything else executes, and the
   query string is scrubbed right away so a reload/back-navigation doesn't re-trigger it. */
let pendingSharedWish = null;
(function captureShareTarget() {
  const params = new URLSearchParams(location.search);
  const sharedUrl = params.get('url') || '';
  const sharedText = params.get('text') || '';
  const sharedTitle = params.get('title') || '';
  const hasPhoto = params.get('photo') === '1';
  if (!sharedUrl && !sharedText && !sharedTitle && !hasPhoto) return;
  const urlMatch = (sharedUrl || sharedText).match(/https?:\/\/\S+/);
  const link = urlMatch ? urlMatch[0] : (sharedUrl || '');
  const title = sharedTitle || (sharedText && !urlMatch ? sharedText : '');
  pendingSharedWish = { link, title: title.slice(0, 80), text: sharedText, hasPhoto };
  history.replaceState(null, '', location.pathname);
})();

/* ===================== Constants ===================== */
const MEMBER_COLORS = [
  { name: 'sage',     hex: '#7A8B69' },
  { name: 'marigold', hex: '#E8A33D' },
  { name: 'rose',     hex: '#C97064' },
  { name: 'slate',    hex: '#5B7C99' },
  { name: 'plum',     hex: '#8B6A9C' },
  { name: 'teal',     hex: '#4F8A82' },
];
const WEEKDAYS_KO = ['일','월','화','수','목','금','토'];
const MONTHS_KO = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

function colorFor(idx) { return MEMBER_COLORS[idx % MEMBER_COLORS.length].hex; }
function initialsFor(name) { return (name || '?').trim().slice(0,1).toUpperCase(); }
// Members are keyed by normalized name (not device auth uid) so the same
// person entering from a phone and a desktop lands on the same member —
// otherwise every device would register itself as a separate family member.
function memberKeyFor(name) {
  // used both as a Firestore doc id and as a dynamic map-field key (e.g. `reactions.${memberId}`),
  // so strip characters that are meaningful in Firestore paths/field-path strings.
  return (name || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/[.$#\[\]/]/g, '');
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function pad2(n){ return String(n).padStart(2,'0'); }

/* ===================== App state ===================== */
const state = {
  user: null,          // firebase auth user (per-device identity)
  userDoc: null,       // { name, email, familyId, memberId }
  familyId: null,
  memberId: null,       // this device's family-member id (shared across devices with the same name)
  familyDoc: null,      // { name, inviteCode }
  members: {},          // memberId -> { name, colorIndex }
  tasks: {},             // taskId -> task data
  shopping: {},          // itemId -> shopping item data
  wishes: {},            // wishId -> wishlist item data
  wishFilter: 'all',
  editingTaskId: null,
  unsubUser: null,
  unsubFamily: null,
  unsubMembers: null,
  unsubTasks: null,
  unsubShopping: null,
};

/* ===================== Screen / tab helpers ===================== */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}
function showTab(name) {
  document.querySelectorAll('.tab-panel').forEach(el => el.classList.add('hidden'));
  document.getElementById(`tab-${name}`).classList.remove('hidden');
}
document.getElementById('btn-settings').addEventListener('click', () => showTab('family'));
document.getElementById('btn-settings-back').addEventListener('click', () => showTab('request'));

function icon(name, cls = '') {
  return `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function toast(msg) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---- 모션 도우미 ---- */
// 칸의 숫자가 0에서(또는 이전 값에서) 새 값까지 올라간다
function countUp(el, to) {
  const known = el.dataset.shown !== undefined;
  const from = known ? Number(el.dataset.shown) : (Number(el.textContent) || 0);
  if (known && from === to) return;
  el.dataset.shown = to;
  cancelAnimationFrame(el._raf); clearTimeout(el._cto);
  if (from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = to; return; }
  const dur = 750, t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) el._raf = requestAnimationFrame(step); else restartAnim(el, 'bump');
  };
  el._raf = requestAnimationFrame(step);
  el._cto = setTimeout(() => { el.textContent = to; }, dur + 80);
}
function restartAnim(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
// 화면·칸·종류를 바꿨을 때 목록 줄이 위에서부터 차례로 올라온다
function staggerList(list) {
  if (!list) return;
  [...list.children].forEach((el, i) => el.style.setProperty('--i', Math.min(i, 9)));
  restartAnim(list, 'stagger');
  clearTimeout(list._stg);
  list._stg = setTimeout(() => list.classList.remove('stagger'), 900);
}
// 숫자가 바뀌면 톡 튄다
const bumpObserver = new MutationObserver(muts => muts.forEach(m => {
  const el = m.target;
  const v = el.textContent;
  if (el.dataset.prev !== undefined && el.dataset.prev !== v) restartAnim(el, 'bump');
  el.dataset.prev = v;
}));
document.querySelectorAll('.status-chip-count, .seg .num').forEach(el => {
  el.dataset.prev = el.textContent;
  bumpObserver.observe(el, { childList: true });
});

/* ===================== Entry (name + shared password, no signup) ===================== */
let pendingEntry = null; // { name, password } — set when offering to create a new family

document.getElementById('form-entry').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('entry-name').value.trim();
  const password = document.getElementById('entry-password').value.trim();
  const errEl = document.getElementById('entry-error');
  const createBlock = document.getElementById('entry-create-block');
  errEl.textContent = '';
  createBlock.classList.add('hidden');
  pendingEntry = null;
  if (!name || !password) { errEl.textContent = '이름과 인생찜 암호를 입력해주세요.'; return; }

  const submitBtn = document.querySelector('#form-entry button[type=submit]');
  submitBtn.disabled = true;
  try {
    if (!auth.currentUser) await auth.signInAnonymously();
    const uid = auth.currentUser.uid;
    await db.collection('users').doc(uid).set(
      { name, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }
    );

    const q = await db.collection('families').where('sharedPassword', '==', password).limit(1).get();
    if (!q.empty) {
      // family exists → join it. Members are keyed by name, not device uid, so
      // entering the same name from another device links to the same person.
      const famDoc = q.docs[0];
      const memberId = memberKeyFor(name);
      const membersSnap = await famDoc.ref.collection('members').get();
      const existing = membersSnap.docs.find(d => d.id === memberId);
      await famDoc.ref.collection('members').doc(memberId).set({
        name,
        colorIndex: existing ? (existing.data().colorIndex ?? 0) : membersSnap.size,
      }, { merge: true });
      await db.collection('users').doc(uid).set({ familyId: famDoc.id, memberId }, { merge: true });
      // the user-doc onSnapshot listener will drive enterFamily()
    } else {
      // no family with this password — offer to create one
      pendingEntry = { name, password };
      document.getElementById('entry-create-text').textContent =
        `"${password}" 암호로 된 인생찜이 아직 없어요. 처음이시면 이 암호로 새로 만들 수 있어요.`;
      createBlock.classList.remove('hidden');
    }
  } catch (err) {
    errEl.textContent = friendlyEntryError(err);
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById('btn-entry-create').addEventListener('click', async () => {
  if (!pendingEntry) return;
  const errEl = document.getElementById('entry-error');
  errEl.textContent = '';
  const btn = document.getElementById('btn-entry-create');
  btn.disabled = true;
  try {
    if (!auth.currentUser) await auth.signInAnonymously();
    const uid = auth.currentUser.uid;
    const familyRef = db.collection('families').doc();
    await familyRef.set({
      name: '인생찜',
      sharedPassword: pendingEntry.password,
      createdBy: uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    const memberId = memberKeyFor(pendingEntry.name);
    await familyRef.collection('members').doc(memberId).set({
      name: pendingEntry.name, colorIndex: 0
    });
    await db.collection('users').doc(uid).set({ name: pendingEntry.name, familyId: familyRef.id, memberId }, { merge: true });
    pendingEntry = null;
  } catch (err) {
    errEl.textContent = friendlyEntryError(err);
  } finally {
    btn.disabled = false;
  }
});

function friendlyEntryError(err) {
  if (err.code === 'auth/configuration-not-found' || err.code === 'auth/operation-not-allowed') {
    return 'Firebase 콘솔에서 "익명" 로그인을 켜주세요 (Authentication → 로그인 방법 → 익명).';
  }
  if (err.code === 'auth/network-request-failed') return '네트워크 연결을 확인해주세요.';
  return `문제가 발생했어요 (${err.code || err.message})`;
}

document.getElementById('btn-logout').addEventListener('click', async () => {
  // leave the current family view but keep the anonymous session (so the same
  // device keeps its identity); returns to the entry screen.
  if (state.user) {
    try { await db.collection('users').doc(state.user.uid).set({ familyId: null }, { merge: true }); } catch (e) {}
  }
});

/* ===================== Auth state observer ===================== */
auth.onAuthStateChanged((user) => {
  teardownFamilyListeners();
  if (state.unsubUser) { state.unsubUser(); state.unsubUser = null; }
  if (!user) {
    state.user = null;
    state.familyId = null;
    showScreen('screen-entry');
    return;
  }
  state.user = user;
  state.unsubUser = db.collection('users').doc(user.uid).onSnapshot(async snap => {
    state.userDoc = snap.data() || {};
    if (!state.userDoc.familyId) {
      state.memberId = null;
      teardownFamilyListeners();
      state.familyId = null;
      showScreen('screen-entry');
      return;
    }
    if (!state.userDoc.memberId) {
      // This session signed in before members were keyed by name (memberId).
      // Backfill it from the name we already have on file so this device's
      // actions attribute correctly instead of silently using a null id.
      if (state.userDoc.name) {
        try {
          const memberId = memberKeyFor(state.userDoc.name);
          const membersCol = db.collection('families').doc(state.userDoc.familyId).collection('members');
          const memberSnap = await membersCol.doc(memberId).get();
          if (!memberSnap.exists) {
            const membersSnap = await membersCol.get();
            await membersCol.doc(memberId).set({ name: state.userDoc.name, colorIndex: membersSnap.size }, { merge: true });
          }
          await db.collection('users').doc(user.uid).set({ memberId }, { merge: true });
        } catch (e) { /* will retry on next snapshot */ }
      }
      return; // the memberId write above re-fires this listener
    }
    state.memberId = state.userDoc.memberId;
    if (state.familyId !== state.userDoc.familyId) {
      state.familyId = state.userDoc.familyId;
      enterFamily(state.familyId);
    }
  });
});

/* ===================== Enter family / realtime listeners ===================== */
function teardownFamilyListeners() {
  if (state.unsubFamily) { state.unsubFamily(); state.unsubFamily = null; }
  if (state.unsubMembers) { state.unsubMembers(); state.unsubMembers = null; }
  if (state.unsubTasks) { state.unsubTasks(); state.unsubTasks = null; }
  if (state.unsubShopping) { state.unsubShopping(); state.unsubShopping = null; }
  if (state.unsubWishes) { state.unsubWishes(); state.unsubWishes = null; }
}

function enterFamily(familyId) {
  state.unsubFamily = db.collection('families').doc(familyId).onSnapshot(snap => {
    if (!snap.exists) return;
    state.familyDoc = snap.data();
    // 앱 이름이 '우리집'이던 시절에 만든 데이터는 이름을 한 번만 '인생찜'으로 고친다
    if (state.familyDoc.name === '우리집') {
      state.familyDoc.name = '인생찜';
      db.collection('families').doc(familyId).update({ name: '인생찜' }).catch(() => {});
    }
    document.getElementById('family-name-label').textContent = state.familyDoc.name || '인생찜';
    document.getElementById('invite-code-display').textContent = state.familyDoc.sharedPassword || state.familyDoc.inviteCode || '';
  });

  state.unsubMembers = db.collection('families').doc(familyId).collection('members')
    .onSnapshot(snap => {
      state.members = {};
      snap.forEach(doc => { state.members[doc.id] = doc.data(); });
      renderMembers();
      renderAssigneeOptions();
    });

  state.unsubTasks = db.collection('families').doc(familyId).collection('tasks')
    .onSnapshot(snap => {
      state.tasks = {};
      snap.forEach(doc => { state.tasks[doc.id] = { id: doc.id, ...doc.data() }; });
      renderTasks();
    });

  state.unsubShopping = db.collection('families').doc(familyId).collection('shopping')
    .orderBy('createdAt', 'desc')
    .onSnapshot(snap => {
      state.shopping = {};
      snap.forEach(doc => { state.shopping[doc.id] = { id: doc.id, ...doc.data() }; });
      renderShopping();
    });

  state.unsubWishes = db.collection('families').doc(familyId).collection('wishes')
    .orderBy('createdAt', 'desc')
    .onSnapshot(snap => {
      state.wishes = {};
      snap.forEach(doc => { state.wishes[doc.id] = { id: doc.id, ...doc.data() }; });
      renderWishes();
      migrateTagsFromNotes();
    });

  showScreen('screen-app');
  if (pendingSharedWish) {
    applySharedWish(pendingSharedWish);
    pendingSharedWish = null;
  }
}

/* ===================== Notifications ===================== */
document.getElementById('btn-notif').addEventListener('click', async () => {
  if (!('Notification' in window)) { toast('이 브라우저는 알림을 지원하지 않아요'); return; }
  const perm = await Notification.requestPermission();
  toast(perm === 'granted' ? '알림이 켜졌어요' : '알림 권한이 필요해요');
});
function notifyUser(title, body) {
  toast(`${title}${body ? ' · ' + body : ''}`);
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: 'icon.svg' }); } catch(e) {}
  }
}

/* ===================== Members render ===================== */
function renderMembers() {
  const list = document.getElementById('member-list');
  list.innerHTML = '';
  Object.entries(state.members).forEach(([memberId, m]) => {
    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML = `
      <span class="avatar-dot" style="background:${colorFor(m.colorIndex)}">${initialsFor(m.name)}</span>
      <span>${escapeHtml(m.name)}</span>
      <span class="member-row-right">
        ${memberId === state.memberId ? '<span class="member-you">나</span>' : ''}
        <button class="member-delete-btn" title="구성원 삭제" aria-label="구성원 삭제">${icon('x', 'ic-sm')}</button>
      </span>
    `;
    row.querySelector('.member-delete-btn').addEventListener('click', () => {
      if (confirm(`"${m.name}" 구성원을 목록에서 삭제할까요?\n(등록했던 집안일·장보기·위시는 남아있고, 중복된 기기 항목을 정리할 때 써요.)`)) {
        db.collection('families').doc(state.familyId).collection('members').doc(memberId).delete();
      }
    });
    list.appendChild(row);
  });
}
document.getElementById('btn-copy-invite').addEventListener('click', () => {
  const code = document.getElementById('invite-code-display').textContent;
  navigator.clipboard?.writeText(code).then(() => toast('인생찜 암호를 복사했어요'));
});

/* ===================== Change shared family password ===================== */
const passwordModal = document.getElementById('modal-password');
document.getElementById('btn-change-password').addEventListener('click', () => {
  document.getElementById('new-password').value = state.familyDoc?.sharedPassword || '';
  document.getElementById('password-error').textContent = '';
  passwordModal.classList.remove('hidden');
});
document.getElementById('modal-password-close').addEventListener('click', () => passwordModal.classList.add('hidden'));
passwordModal.addEventListener('click', (e) => { if (e.target === passwordModal) passwordModal.classList.add('hidden'); });

document.getElementById('form-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('password-error');
  errEl.textContent = '';
  const newPw = document.getElementById('new-password').value.trim();
  if (!newPw) { errEl.textContent = '새 암호를 입력해주세요.'; return; }
  if (newPw === state.familyDoc?.sharedPassword) { passwordModal.classList.add('hidden'); return; }
  try {
    // make sure another family isn't already using this password
    const dup = await db.collection('families').where('sharedPassword', '==', newPw).limit(1).get();
    if (!dup.empty && dup.docs[0].id !== state.familyId) {
      errEl.textContent = '다른 인생찜이 이미 쓰는 암호예요. 다른 암호를 정해주세요.';
      return;
    }
    await db.collection('families').doc(state.familyId).update({ sharedPassword: newPw });
    passwordModal.classList.add('hidden');
    toast('인생찜 암호를 변경했어요');
  } catch (err) {
    errEl.textContent = `변경에 실패했어요 (${err.code || err.message})`;
  }
});

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function colorForAssignee(assignee) {
  if (assignee === 'all' || !assignee) return '#B9AE94';
  const m = state.members[assignee];
  return m ? colorFor(m.colorIndex) : '#B9AE94';
}

function renderAssigneeOptions() {
  ['event-assignee', 'task-assignee'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="all">전체</option>' +
      Object.entries(state.members).map(([uid,m]) => `<option value="${uid}">${escapeHtml(m.name)}</option>`).join('');
    if (prev) sel.value = prev;
  });
}

/* "옵션 더보기" toggles shared by the event/task modals */
function setMoreOptionsOpen(kind, open) {
  document.getElementById(`${kind}-more-options`).classList.toggle('hidden', !open);
  const btn = document.getElementById(`${kind}-more-toggle`);
  if (btn) btn.textContent = open ? '옵션 접기' : '옵션 더보기';
}
document.getElementById('task-more-toggle').addEventListener('click', () => {
  const isOpen = !document.getElementById('task-more-options').classList.contains('hidden');
  setMoreOptionsOpen('task', !isOpen);
});

/* ===================== Tasks (chores) ===================== */
function buildTaskCard(t) {
  const card = document.createElement('div');
  card.className = 'task-card' + (t.done ? ' done' : '');
  const assigneeName = t.assignee === 'all' ? '전체' : (state.members[t.assignee]?.name || '?');
  let repeatLabel = '';
  if (t.repeat === 'daily') repeatLabel = '매일 반복';
  else if (t.repeat === 'weekly') {
    const wds = (t.weekdays && t.weekdays.length) ? [...t.weekdays].sort((a,b) => a - b) : [];
    repeatLabel = wds.length ? '매주 ' + wds.map(d => WEEKDAYS_KO[d]).join('·') : '매주 반복';
  }
  card.innerHTML = `
    <button type="button" class="task-checkbox ${t.done ? 'checked' : ''}" aria-label="${t.done ? '완료 취소' : '완료'}">${t.done ? icon('check', 'ic-sm') : ''}</button>
    <div class="task-body">
      <p class="task-title">${escapeHtml(t.title)}</p>
      <div class="task-meta">
        <span class="event-assignee-badge">
          <span class="avatar-dot" style="background:${colorForAssignee(t.assignee)}">${t.assignee==='all'?'전':initialsFor(assigneeName)}</span>
          ${escapeHtml(assigneeName)}
        </span>
        ${t.dueDate ? `<span>~${t.dueDate}</span>` : ''}
        ${repeatLabel ? `<span>${repeatLabel}</span>` : ''}
      </div>
    </div>
  `;
  card.querySelector('.task-checkbox').addEventListener('click', (e) => {
    e.stopPropagation();
    e.currentTarget.classList.add('checked');
    e.currentTarget.innerHTML = icon('check', 'ic-sm');
    card.classList.add('done');
    setTimeout(() => card.classList.add('leaving'), 220);
    setTimeout(() => { toggleTaskDone(t); toast('보관함으로 보냈어요'); }, 560);
  });
  card.querySelector('.task-body').addEventListener('click', () => openTaskModal(t));
  return card;
}

function renderTasks() {
  renderRequestStatus();
  const list = document.getElementById('tasks-list');
  if (!list) return;
  list.innerHTML = '';
  const tasks = Object.values(state.tasks).filter(t => !t.done);

  if (tasks.length === 0) {
    list.innerHTML = '<p class="empty-state"><b>남은 집안일이 없어요</b>위쪽 추가 버튼으로 만들어보세요. 끝낸 건 보관함에 있어요.</p>';
    return;
  }
  tasks.forEach(t => list.appendChild(buildTaskCard(t)));
}

async function toggleTaskDone(t) {
  await db.collection('families').doc(state.familyId).collection('tasks').doc(t.id).update({
    done: !t.done,
    completedBy: !t.done ? state.memberId : null,
    completedAt: !t.done ? firebase.firestore.FieldValue.serverTimestamp() : null,
  });
}

const taskModal = document.getElementById('modal-task');
document.getElementById('btn-add-task').addEventListener('click', () => openTaskModal(null));
document.getElementById('modal-task-close').addEventListener('click', closeTaskModal);
taskModal.addEventListener('click', (e) => { if (e.target === taskModal) closeTaskModal(); });

function syncTaskRepeatRows() {
  const repeat = document.getElementById('task-repeat').value;
  document.getElementById('task-weekdays').classList.toggle('hidden', repeat !== 'weekly');
}
document.getElementById('task-repeat').addEventListener('change', () => {
  if (document.getElementById('task-repeat').value === 'weekly') {
    const anyChecked = [...document.querySelectorAll('#task-weekdays input')].some(c => c.checked);
    if (!anyChecked) {
      const box = document.querySelector(`#task-weekdays input[value="${new Date().getDay()}"]`);
      if (box) box.checked = true;
    }
  }
  syncTaskRepeatRows();
});

function openTaskModal(t) {
  state.editingTaskId = t ? t.id : null;
  document.getElementById('modal-task-title').textContent = t ? '집안일 수정' : '집안일 추가';
  document.getElementById('task-title').value = t ? t.title : '';
  document.getElementById('task-due').value = t?.dueDate || '';
  document.getElementById('task-repeat').value = t?.repeat || 'none';
  document.querySelectorAll('#task-weekdays input').forEach(cb => {
    cb.checked = !!(t?.weekdays && t.weekdays.includes(Number(cb.value)));
  });
  syncTaskRepeatRows();
  document.getElementById('task-error').textContent = '';
  renderAssigneeOptions();
  document.getElementById('task-assignee').value = t?.assignee || 'all';
  document.getElementById('btn-delete-task').classList.toggle('hidden', !t);
  setMoreOptionsOpen('task', !!(t && t.repeat && t.repeat !== 'none'));
  taskModal.classList.remove('hidden');
}
function closeTaskModal() { taskModal.classList.add('hidden'); state.editingTaskId = null; }

document.getElementById('form-task').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('task-error');
  errEl.textContent = '';
  const repeat = document.getElementById('task-repeat').value;
  const weekdays = repeat === 'weekly'
    ? [...document.querySelectorAll('#task-weekdays input:checked')].map(c => Number(c.value))
    : [];
  const data = {
    title: document.getElementById('task-title').value.trim(),
    assignee: document.getElementById('task-assignee').value,
    dueDate: document.getElementById('task-due').value || null,
    repeat,
    weekdays,
  };
  if (!data.title) { errEl.textContent = '집안일 내용을 입력해주세요.'; return; }
  if (repeat === 'weekly' && weekdays.length === 0) { errEl.textContent = '반복할 요일을 하나 이상 선택해주세요.'; return; }
  try {
    const col = db.collection('families').doc(state.familyId).collection('tasks');
    if (state.editingTaskId) {
      await col.doc(state.editingTaskId).update(data);
    } else {
      await col.add({ ...data, done: false, createdBy: state.memberId, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    }
    closeTaskModal();
  } catch (err) {
    errEl.textContent = `저장에 실패했어요 (${err.code || err.message})`;
  }
});

document.getElementById('btn-delete-task').addEventListener('click', async () => {
  if (!state.editingTaskId) return;
  if (!confirm('이 집안일을 삭제할까요?')) return;
  await db.collection('families').doc(state.familyId).collection('tasks').doc(state.editingTaskId).delete();
  closeTaskModal();
});

/* ===================== Request tab: 위시 / 집안일 / 장보기 sub-view toggle (per-device) ===================== */
const GOODS_VIEWS = ['wish', 'tasks', 'shopping', 'archive'];
function applyGoodsView(view) {
  if (!GOODS_VIEWS.includes(view)) view = 'wish';
  localStorage.setItem('goodsView', view);
  GOODS_VIEWS.forEach(v => document.getElementById(`goods-view-${v}`).classList.toggle('hidden', v !== view));
  document.querySelectorAll('.status-chip').forEach(b => b.classList.toggle('active', b.dataset.goodsView === view));
  document.getElementById('btn-archive').classList.toggle('active', view === 'archive');
  if (applyGoodsView.last !== view) {
    applyGoodsView.last = view;
    staggerList(document.getElementById({ wish: 'wish-list', tasks: 'tasks-list', shopping: 'shopping-list', archive: 'archive-list' }[view]));
  }
}
document.getElementById('btn-archive').addEventListener('click', () => {
  showTab('request');
  applyGoodsView(document.getElementById('goods-view-archive').classList.contains('hidden') ? 'archive' : 'wish');
});
document.querySelectorAll('.status-chip').forEach(btn => {
  btn.addEventListener('click', () => applyGoodsView(btn.dataset.goodsView));
});
applyGoodsView(localStorage.getItem('goodsView'));

function renderRequestStatus() {
  const setCount = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  setCount('status-count-tasks', Object.values(state.tasks).filter(t => !t.done).length);
  setCount('status-count-shopping', Object.values(state.shopping).filter(i => !i.purchased).length);
  setCount('status-count-wish', Object.values(state.wishes).filter(w => !w.done).length);
  renderArchive();
}

/* ===================== 보관함: 끝낸 위시·집안일·장보기를 한곳에 ===================== */
const archiveUi = { kind: 'all' };
const ARCHIVE_KINDS = { wish: '위시', task: '집안일', shopping: '장보기' };
const tsMs = (t) => (t && t.seconds ? t.seconds * 1000 : 0);

function archiveItems() {
  const out = [];
  const shopColl = () => db.collection('families').doc(state.familyId).collection('shopping');
  Object.values(state.wishes).filter(w => w.done).forEach(w => out.push({
    kind: 'wish', cat: catOf(w), title: w.title, time: tsMs(w.doneAt), stamp: w.doneAt,
    open: () => openWishModal(w), restore: () => { toggleWishDone(w); toast('다시 꺼냈어요'); },
  }));
  Object.values(state.tasks).filter(t => t.done).forEach(t => out.push({
    kind: 'task', title: t.title, time: tsMs(t.completedAt), stamp: t.completedAt,
    open: () => openTaskModal(t), restore: () => { toggleTaskDone(t); toast('다시 꺼냈어요'); },
  }));
  Object.values(state.shopping).filter(i => i.purchased).forEach(i => out.push({
    kind: 'shopping', title: i.name + (i.qty ? ' ' + i.qty : ''), time: tsMs(i.purchasedAt), stamp: i.purchasedAt,
    restore: () => { shopColl().doc(i.id).update({ purchased: false, purchasedBy: null, purchasedAt: null }); toast('다시 꺼냈어요'); },
    remove: () => shopColl().doc(i.id).delete(),
  }));
  return out.sort((a, b) => b.time - a.time);
}

function renderArchive() {
  const list = document.getElementById('archive-list');
  if (!list) return;
  const all = archiveItems();
  document.getElementById('arch-num-all').textContent = all.length;
  Object.keys(ARCHIVE_KINDS).forEach(k => { document.getElementById('arch-num-' + k).textContent = all.filter(x => x.kind === k).length; });
  document.querySelectorAll('#archive-seg button').forEach(b => b.classList.toggle('on', b.dataset.akind === archiveUi.kind));
  const items = archiveUi.kind === 'all' ? all : all.filter(x => x.kind === archiveUi.kind);
  list.innerHTML = '';
  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state"><b>보관함이 비어 있어요</b>끝낸 위시·집안일·장보기가 여기로 와요.</p>';
    return;
  }
  items.forEach(it => {
    const row = document.createElement('div');
    row.className = 'arch-row';
    row.dataset.kind = it.kind;
    if (it.cat) row.dataset.cat = it.cat;
    const tag = it.kind === 'wish' ? WISH_CAT_META[it.cat].label : ARCHIVE_KINDS[it.kind];
    row.innerHTML = `
      <span class="arch-tag">${escapeHtml(tag)}</span>
      <button type="button" class="arch-main"><span class="arch-title">${escapeHtml(it.title)}</span><span class="arch-date">${shortDate(it.stamp)}</span></button>
      <button type="button" class="arch-restore">${icon('undo', 'ic-sm')}다시 꺼내기</button>
      ${it.remove ? `<button type="button" class="arch-del" aria-label="완전히 지우기">${icon('x', 'ic-sm')}</button>` : ''}`;
    const main = row.querySelector('.arch-main');
    if (it.open) main.addEventListener('click', it.open); else main.disabled = true;
    const leaveThen = (fn) => () => { row.classList.add('leaving'); setTimeout(fn, 340); };
    row.querySelector('.arch-restore').addEventListener('click', leaveThen(it.restore));
    const del = row.querySelector('.arch-del');
    if (del) del.addEventListener('click', leaveThen(it.remove));
    list.appendChild(row);
  });
}
document.querySelectorAll('#archive-seg button').forEach(btn => {
  btn.addEventListener('click', () => { archiveUi.kind = btn.dataset.akind; renderArchive(); staggerList(document.getElementById('archive-list')); });
});

/* ===================== Shopping / household supplies ===================== */
function renderShopping() {
  renderRequestStatus();
  const list = document.getElementById('shopping-list');
  if (!list) return;
  list.innerHTML = '';
  // 체크하면 목록에서 빠져 보관함으로 간다
  const items = Object.values(state.shopping)
    .filter(i => !i.purchased)
    .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">살 것이 없어요. 위에 적어서 추가하세요. 산 것은 보관함에 있어요.</p>';
    return;
  }
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'shopping-item';
    row.innerHTML = `
      <button type="button" class="task-checkbox" aria-label="샀어요, 목록에서 빼기"></button>
      <div class="shopping-body">
        <span class="shopping-name">${escapeHtml(item.name)}${item.qty ? ` <span class="shopping-qty">${escapeHtml(item.qty)}</span>` : ''}</span>
        ${item.link ? `<a class="shopping-link" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkHost(item.link) || '링크')} ↗</a>` : ''}
      </div>
    `;
    row.querySelector('.task-checkbox').addEventListener('click', (e) => {
      e.currentTarget.classList.add('checked');
      e.currentTarget.innerHTML = icon('check', 'ic-sm');
      row.classList.add('purchased');
      setTimeout(() => row.classList.add('leaving'), 220);
      setTimeout(() => {
        db.collection('families').doc(state.familyId).collection('shopping').doc(item.id).update({
          purchased: true, purchasedBy: state.memberId, purchasedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }, 560);
    });
    list.appendChild(row);
  });
}

document.getElementById('form-shopping-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById('shopping-item-name');
  const name = nameInput.value.trim();
  if (!name) return;
  nameInput.value = '';
  nameInput.focus();
  await db.collection('families').doc(state.familyId).collection('shopping').add({
    name, purchased: false, requestedBy: state.memberId, createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
});

/* ===================== Wishlist: 장소 · 음식 · 물건 ===================== */
const WISH_CATEGORIES = ['place', 'food', 'gift'];
const WISH_CAT_META = {
  place: { icon: 'pin',  label: '장소', long: '가고 싶은 곳',   done: '다녀왔어요', hint: '위치, 특징 등' },
  food:  { icon: 'food', label: '음식', long: '먹고 싶은 음식', done: '먹었어요',   hint: '가게 이름, 메뉴 등' },
  gift:  { icon: 'bag',  label: '물건', long: '갖고 싶은 것',   done: '샀어요',     hint: '사이즈, 색상, 가격대 등' },
};
const wishUi = { state: 'open', query: '', tag: '', rendered: false, known: new Set() };

const wishColl = () => db.collection('families').doc(state.familyId).collection('wishes');
const catOf = (w) => (WISH_CATEGORIES.includes(w.category) ? w.category : 'gift');
const tsSeconds = (t) => (t && t.seconds) || Infinity;
function shortDate(t) {
  if (!t || !t.seconds) return '';
  const d = new Date(t.seconds * 1000);
  return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}
function normalizeLink(raw) {
  let link = (raw || '').trim() || null;
  if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
  return link;
}
function linkHost(link) {
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}
function youtubeId(link) {
  try {
    const u = new URL(link);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0] || null;
    if (u.hostname.includes('youtube.com')) {
      if (/^\/(shorts|embed|live)\//.test(u.pathname)) return u.pathname.split('/')[2] || null;
      return u.searchParams.get('v');
    }
  } catch (e) { /* not a URL */ }
  return null;
}
function wishImageSrc(w) {
  if (w.photo) return w.photo;
  const id = w.link && youtubeId(w.link);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

/* ---- photos: shrink in the browser, keep inside the wish document (no paid storage needed) ---- */
async function imageToDataUrl(blob, max = 640, quality = 0.72) {
  let src, w, h;
  try {
    src = await createImageBitmap(blob);
    w = src.width; h = src.height;
  } catch (e) {
    src = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}
async function readClipboardPayload() {
  try {
    if (navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find(t => t.startsWith('image/'));
        if (type) return { image: await it.getType(type) };
      }
      for (const it of items) {
        if (it.types.includes('text/plain')) return { text: await (await it.getType('text/plain')).text() };
      }
    }
  } catch (e) { /* fall back to plain text below */ }
  return { text: await navigator.clipboard.readText() };
}

/* photo slots: 'add' (new-wish sheet) and 'edit' (detail sheet) */
const photoSlots = {
  add:  { data: null, preview: 'wish-photo-preview',      remove: 'btn-wish-photo-remove' },
  edit: { data: null, preview: 'wish-edit-photo-preview', remove: 'btn-edit-photo-remove' },
};
function renderPhotoSlot(key) {
  const s = photoSlots[key];
  const box = document.getElementById(s.preview);
  box.innerHTML = s.data ? `<img src="${s.data}" alt="">` : icon('image', 'ic-lg');
  document.getElementById(s.remove).classList.toggle('hidden', !s.data);
}
async function setPhoto(key, blob) {
  try {
    photoSlots[key].data = await imageToDataUrl(blob);
    renderPhotoSlot(key);
  } catch (e) {
    toast('이 사진은 불러올 수 없어요');
  }
}
function wirePhotoControls(key, pickBtn, pasteBtn, removeBtn, fileInput) {
  document.getElementById(pickBtn).addEventListener('click', () => document.getElementById(fileInput).click());
  document.getElementById(fileInput).addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) setPhoto(key, f);
    e.target.value = '';
  });
  document.getElementById(removeBtn).addEventListener('click', () => { photoSlots[key].data = null; renderPhotoSlot(key); });
  document.getElementById(pasteBtn).addEventListener('click', async () => {
    try {
      const got = await readClipboardPayload();
      if (got.image) setPhoto(key, got.image);
      else toast('복사된 이미지가 없어요. 인스타·갤러리에서 이미지를 길게 눌러 복사해주세요');
    } catch (e) { toast('클립보드 읽기 권한이 필요해요'); }
  });
}
wirePhotoControls('add', 'btn-wish-photo-pick', 'btn-wish-photo-paste', 'btn-wish-photo-remove', 'wish-photo-file');
wirePhotoControls('edit', 'btn-edit-photo-pick', 'btn-edit-photo-paste', 'btn-edit-photo-remove', 'wish-edit-photo-file');

/* long-press → 붙여넣기 on the page also works while a sheet is open */
document.addEventListener('paste', (e) => {
  const f = e.clipboardData && [...e.clipboardData.files].find(x => x.type.startsWith('image/'));
  if (!f) return;
  if (!document.getElementById('modal-wish-add').classList.contains('hidden')) { e.preventDefault(); setPhoto('add', f); }
  else if (!document.getElementById('form-wish-edit').classList.contains('hidden')) { e.preventDefault(); setPhoto('edit', f); }
});

/* ---- category pickers (add sheet + edit sheet) ---- */
let selectedWishCat = localStorage.getItem('wishCat');
if (!WISH_CATEGORIES.includes(selectedWishCat)) selectedWishCat = 'place';
let editingWishId = null;
let editingWishCat = 'place';

function paintPicker(containerId, cat) {
  document.querySelectorAll(`#${containerId} button`).forEach(b => b.classList.toggle('on', b.dataset.wishCat === cat));
}
function setWishCatPicker(cat) {
  selectedWishCat = cat;
  localStorage.setItem('wishCat', cat);
  paintPicker('wish-cat-picker', cat);
  renderTagSuggest('wish-tag-suggest', 'wish-tag', cat);
  document.getElementById('wish-notes').placeholder = WISH_CAT_META[cat].hint;
  const card = document.getElementById('wish-add-card');
  if (card) card.dataset.cat = cat;
}
document.querySelectorAll('#wish-cat-picker button').forEach(btn => {
  btn.addEventListener('click', () => setWishCatPicker(btn.dataset.wishCat));
});
document.querySelectorAll('#wish-detail-cat-picker button').forEach(btn => {
  btn.addEventListener('click', () => {
    editingWishCat = btn.dataset.wishCat;
    paintPicker('wish-detail-cat-picker', editingWishCat);
    renderTagSuggest('wish-detail-tag-suggest', 'wish-detail-tag-input', editingWishCat);
    document.getElementById('wish-detail-notes-input').placeholder = WISH_CAT_META[editingWishCat].hint;
  });
});

/* Best-effort guess from the shared link/caption — only acts when fairly confident,
   otherwise leaves the category on whatever was last picked (sticky) */
function guessWishCategory(url, text) {
  const combined = `${url || ''} ${text || ''}`.toLowerCase();
  if (/map\.naver\.com|naver\.me\/|map\.kakao\.com|kko\.to|maps\.google|goo\.gl\/maps/.test(combined)) return 'place';
  const foodWords = ['맛집', '카페', '레스토랑', '메뉴', '맛있', '디저트', '베이커리', '브런치', '식당', '술집', '분식'];
  const placeWords = ['여행', '관광', '가볼만한', '핫플', '명소', '드라이브', '숙소', '호텔', '펜션', '캠핑'];
  const giftWords = ['구매', '쇼핑', '할인', '상품', '주문', '세일', '브랜드', '제품', '아이템'];
  if (foodWords.some(k => combined.includes(k))) return 'food';
  if (placeWords.some(k => combined.includes(k))) return 'place';
  if (giftWords.some(k => combined.includes(k))) return 'gift';
  return null;
}

/* ---- 분류(태그): 같은 종류 안에서 다시 묶어 보기 ---- */
function tagList(cat) {
  const m = {};
  Object.values(state.wishes).forEach(w => { if (w.tag && (!cat || catOf(w) === cat)) m[w.tag] = (m[w.tag] || 0) + 1; });
  return Object.keys(m).sort((a, b) => m[b] - m[a] || a.localeCompare(b, 'ko'));
}
function markTagSuggest(boxId, val) {
  document.querySelectorAll('#' + boxId + ' .tag-pill').forEach(b => b.classList.toggle('on', b.textContent === val));
}
function renderTagSuggest(boxId, inputId, cat) {
  const box = document.getElementById(boxId), input = document.getElementById(inputId);
  if (!box || !input) return;
  box.innerHTML = '';
  tagList(cat).slice(0, 14).forEach(t => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tag-pill'; b.textContent = t;
    b.addEventListener('click', () => { input.value = input.value.trim() === t ? '' : t; markTagSuggest(boxId, input.value.trim()); });
    box.appendChild(b);
  });
  markTagSuggest(boxId, input.value.trim());
}
[['wish-tag', 'wish-tag-suggest'], ['wish-detail-tag-input', 'wish-detail-tag-suggest']].forEach(([inp, box]) => {
  document.getElementById(inp).addEventListener('input', (e) => markTagSuggest(box, e.target.value.trim()));
});
function renderTagBar(items) {
  const bar = document.getElementById('tag-bar');
  const counts = {}; let none = 0;
  items.forEach(w => { if (w.tag) counts[w.tag] = (counts[w.tag] || 0) + 1; else none++; });
  const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, 'ko'));
  if (!tags.length) { wishUi.tag = ''; bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  if (wishUi.tag && wishUi.tag !== '__none' && !counts[wishUi.tag]) wishUi.tag = '';
  if (wishUi.tag === '__none' && !none) wishUi.tag = '';
  const keep = bar.scrollLeft;
  const chip = (val, label, n) => `<button type="button" class="tag-chip${wishUi.tag === val ? ' on' : ''}" data-tag="${escapeHtml(val)}">${escapeHtml(label)}<span class="num">${n}</span></button>`;
  bar.innerHTML = chip('', '전체', items.length) + tags.map(t => chip(t, t, counts[t])).join('') + (none ? chip('__none', '분류 없음', none) : '');
  bar.classList.remove('hidden');
  bar.scrollLeft = keep;
}
document.getElementById('tag-bar').addEventListener('click', (e) => {
  const b = e.target.closest('.tag-chip');
  if (!b) return;
  wishUi.tag = b.dataset.tag;
  renderWishes();
  staggerList(document.getElementById('wish-list'));
});
// 예전에 가져온 목록은 분류가 메모 글자("테크 · 스탠드·거치대 · …")에만 들어 있었다 — 진짜 분류 칸으로 한 번 옮긴다
function migrateTagsFromNotes() {
  if (state._tagMigrating || !state.familyId) return;
  const todo = [];
  Object.values(state.wishes).forEach(w => {
    if (w.tag || !w.notes) return;
    const m = w.notes.match(/^(테크|데스크테리어) · (.+?)(?: · (.*))?$/);
    if (m) todo.push([w, m]);
  });
  if (!todo.length) return;
  state._tagMigrating = true;
  const batch = db.batch();
  todo.slice(0, 400).forEach(([w, m]) => {
    batch.update(wishColl().doc(w.id), { tag: m[2].trim(), notes: m[3] ? `${m[1]} · ${m[3]}` : m[1] });
  });
  batch.commit().catch(() => {}).finally(() => { state._tagMigrating = false; });
}

/* ---- add sheet ---- */
const wishAddModal = document.getElementById('modal-wish-add');
function openWishAdd(prefill = {}) {
  applyGoodsView('wish');
  const pickable = !!prefill.pick;
  document.getElementById('wish-title').value = prefill.title || '';
  document.getElementById('wish-notes').value = '';
  document.getElementById('wish-link').value = prefill.link || '';
  let cat0 = prefill.cat;
  if (!cat0 && wishUi.tag && wishUi.tag !== '__none') { const hit = Object.values(state.wishes).find(w => w.tag === wishUi.tag); if (hit) cat0 = catOf(hit); }
  setWishCatPicker(cat0 || selectedWishCat);
  document.getElementById('wish-tag').value = prefill.tag != null ? prefill.tag : ((wishUi.tag && wishUi.tag !== '__none') ? wishUi.tag : '');
  renderTagSuggest('wish-tag-suggest', 'wish-tag', selectedWishCat);
  const meta = WISH_CAT_META[selectedWishCat];
  document.getElementById('wish-cat-picker').classList.toggle('hidden', !pickable);
  document.getElementById('wish-add-card').dataset.cat = selectedWishCat;
  document.getElementById('wish-add-heading').textContent = pickable ? '새 찜' : '새 ' + meta.label + ' 찜';
  photoSlots.add.data = null;
  renderPhotoSlot('add');
  wishAddModal.classList.remove('hidden');
  document.getElementById('wish-title').focus();
}
function closeWishAdd() { wishAddModal.classList.add('hidden'); }
/* 오른쪽 아래 + 버튼: 칸을 고른 상태면 그 종류로 바로, 아무것도 안 골랐으면 종류를 고르며 추가 */
document.getElementById('fab-wish').addEventListener('click', () => {
  const f = state.wishFilter;
  if (f === 'all') openWishAdd({ pick: true }); else openWishAdd({ cat: f });
});
function syncWishFab() {
  const f = state.wishFilter;
  const fab = document.getElementById('fab-wish');
  const changed = fab.dataset.mode !== f;
  fab.dataset.mode = f;
  if (changed) restartAnim(fab, 'pop');
  const label = f === 'all' ? '찜 추가' : WISH_CAT_META[f].label + ' 추가';
  document.getElementById('fab-wish-label').textContent = label;
  fab.setAttribute('aria-label', f === 'all' ? '찜 추가' : WISH_CAT_META[f].label + ' 찜 추가');
}
document.getElementById('modal-wish-add-close').addEventListener('click', closeWishAdd);
wishAddModal.addEventListener('click', (e) => { if (e.target === wishAddModal) closeWishAdd(); });

/* Apply something shared in from another app (Instagram/YouTube/네이버지도 "공유" → 인생찜) */
async function applySharedWish({ link, title, text, hasPhoto }) {
  openWishAdd({ title, link, cat: guessWishCategory(link, text) || selectedWishCat, pick: true });
  if (hasPhoto && window.caches) {
    try {
      const cache = await caches.open('share-inbox');
      const key = new URL('share-photo', document.baseURI).href;
      const resp = await cache.match(key);
      if (resp) { await setPhoto('add', await resp.blob()); await cache.delete(key); }
    } catch (e) { /* the photo is optional */ }
  }
  toast('공유받았어요. 이름을 확인하고 담아주세요');
}

/* 📋 — one tap pastes whatever is on the clipboard: an image becomes the photo, text becomes the link */
document.querySelectorAll('.paste-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const isAdd = btn.dataset.target === 'wish-link';
    try {
      const got = await readClipboardPayload();
      if (got.image) { setPhoto(isAdd ? 'add' : 'edit', got.image); toast('사진을 붙여넣었어요'); return; }
      const text = (got.text || '').trim();
      if (!text) { toast('클립보드가 비어있어요'); return; }
      document.getElementById(btn.dataset.target).value = text;
      if (isAdd && !document.getElementById('wish-cat-picker').classList.contains('hidden')) {
        const guess = guessWishCategory(text, '');
        if (guess) setWishCatPicker(guess);
      }
    } catch (err) {
      toast('클립보드 읽기 권한이 필요해요');
    }
  });
});

document.getElementById('form-wish-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('wish-title').value.trim();
  if (!title) return;
  const submitBtn = e.target.querySelector('button[type=submit]');
  submitBtn.disabled = true;
  try {
    await wishColl().add({
      title, category: selectedWishCat,
      tag: document.getElementById('wish-tag').value.trim() || null,
      notes: document.getElementById('wish-notes').value.trim() || null,
      link: normalizeLink(document.getElementById('wish-link').value),
      photo: photoSlots.add.data || null,
      done: false, requestedBy: state.memberId,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    closeWishAdd();
    state.wishFilter = 'all'; wishUi.state = 'open'; wishUi.query = ''; wishUi.tag = '';
    document.getElementById('wish-search').value = '';
    renderWishes();
    toast(`"${title}" 담았어요`);
  } catch (err) {
    if (err.code === 'permission-denied') toast('권한 설정이 필요해요 (규칙 재게시)');
    else toast('담기 실패: ' + (err.code || err.message));
  } finally {
    submitBtn.disabled = false;
  }
});

/* ---- 목록 가져오기: 붙여넣은 여러 줄을 한 번에 찜으로 ---- */
const IMPORT_HEADERS = [
  ['title', /^(이름|제목|품명|상품명|제품명|물건|품목|항목)$/],
  ['tag', /^(세부분류|세부|소분류)$/],
  ['detail', /^(분류|종류|카테고리|상세|메모|비고|설명)$/],
  ['link', /^(링크|url|주소|사이트)$/i],
  ['price', /^(가격|금액|단가)$/],
  ['status', /^상태$/],
  ['done', /^(구입|구매|완료|구입여부|구매여부)$/],
  ['photo', /^(이미지|사진|그림|image|img)$/i],
];
const IMPORT_DONE = /^(완료|구입|구매|샀|샀음|샀어요|구입함|구매함|구입완료|구매완료|구입 완료|구매 완료|o|v|y|yes|true|✓|✔)$/i;
const IMPORT_IMG = /^https?:\/\/\S+\.(jpe?g|png|webp|gif|avif)(\?\S*)?$/i;
const importPriceLabel = (v) => {
  const m = v.replace(/\s/g, '').match(/^₩?([\d,]+)원?$/);
  if (!m) return null;
  const digits = m[1].replace(/,/g, '');
  if (!/원/.test(v) && digits.length < 4) return null;
  return Number(digits).toLocaleString('ko-KR') + '원';
};
function parseImportText(text, cat) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const split = (l) => (l.includes('\t') ? l.split('\t') : l.includes('|') ? l.split('|') : [l]).map(s => s.trim());
  let map = null;
  const first = split(lines[0]);
  const hdr = first.map(cell => (IMPORT_HEADERS.find(([, re]) => re.test(cell.replace(/\s/g, ''))) || [])[0]);
  if (first.length > 1 && hdr.filter(Boolean).length >= 2 && hdr.includes('title')) { map = hdr; lines.shift(); }
  const existing = new Set(Object.values(state.wishes).filter(w => catOf(w) === cat).map(w => w.title.trim().toLowerCase()));
  const seen = new Set();
  const items = [];
  lines.forEach(line => {
    const cells = split(line);
    let title = '', link = null, price = null, done = false, photo = null, tag = null;
    const details = [];
    if (cells.length === 1) {
      const url = cells[0].match(/https?:\/\/\S+/);
      if (url) link = url[0];
      title = cells[0].replace(/https?:\/\/\S+/g, '').trim();
    } else {
      cells.forEach((cell, idx) => {
        if (!cell) return;
        const role = map ? map[idx] : (idx === 0 ? 'title' : null);
        if (role === 'title') title = cell;
        else if (role === 'tag') tag = cell;
        else if (role === 'status') { if (IMPORT_DONE.test(cell)) done = true; else if (cell !== '후보' && cell !== '보류') details.push(cell); }
        else if (role === 'photo' || (!role && IMPORT_IMG.test(cell))) { if (/^https?:/i.test(cell)) photo = cell; }
        else if (role === 'link' || (!role && /^https?:\/\//i.test(cell))) link = normalizeLink(cell);
        else if (role === 'price' || (!role && importPriceLabel(cell))) { const lab = importPriceLabel(cell); if (lab) price = lab; else if (!/미확인|^-$/.test(cell)) price = cell; }
        else if (role === 'done' || (!role && IMPORT_DONE.test(cell))) done = done || IMPORT_DONE.test(cell);
        else details.push(cell);
      });
    }
    if (!title) return;
    const key = title.toLowerCase();
    const dup = existing.has(key) || seen.has(key);
    seen.add(key);
    const notes = [details.join(' · '), price ? '가격 ' + price : ''].filter(Boolean).join(' · ') || null;
    items.push({ title, notes, tag, link, photo, done, dup });
  });
  return items;
}
function refreshImportSummary() {
  const items = parseImportText(document.getElementById('import-text').value, document.getElementById('import-cat').value);
  const fresh = items.filter(i => !i.dup);
  const sum = document.getElementById('import-summary');
  const btn = document.getElementById('btn-import');
  if (!items.length) { sum.textContent = '붙여넣으면 몇 개인지 보여드려요.'; btn.disabled = true; btn.textContent = '가져오기'; return fresh; }
  const done = fresh.filter(i => i.done).length;
  const pics = fresh.filter(i => i.photo).length;
  sum.textContent = `${fresh.length}개를 넣어요${done ? ` (구입 표시 ${done}개는 보관함으로)` : ''}${pics ? ` · 사진 ${pics}개` : ''}${items.length - fresh.length ? ` · 이미 있는 ${items.length - fresh.length}개는 건너뛰어요` : ''}`;
  btn.disabled = fresh.length === 0;
  btn.textContent = fresh.length ? `${fresh.length}개 가져오기` : '가져오기';
  return fresh;
}
document.getElementById('btn-import-paste').addEventListener('click', async () => {
  try {
    document.getElementById('import-text').value = await navigator.clipboard.readText();
    refreshImportSummary();
  } catch (e) { toast('칸을 길게 눌러 붙여넣기 해주세요'); }
});
document.getElementById('import-text').addEventListener('input', refreshImportSummary);
document.getElementById('import-cat').addEventListener('change', refreshImportSummary);
document.getElementById('btn-import').addEventListener('click', async (e) => {
  const fresh = refreshImportSummary();
  if (!fresh.length) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  const cat = document.getElementById('import-cat').value;
  try {
    const now = Date.now();
    for (let start = 0; start < fresh.length; start += 400) {
      const batch = db.batch();
      fresh.slice(start, start + 400).forEach((it, k) => {
        const stamp = firebase.firestore.Timestamp.fromMillis(now - (start + k) * 1000);
        batch.set(wishColl().doc(), {
          title: it.title, category: cat, tag: it.tag || null, notes: it.notes, link: it.link, photo: it.photo || null,
          done: it.done, doneBy: it.done ? state.memberId : null, doneAt: it.done ? stamp : null,
          requestedBy: state.memberId, createdAt: stamp,
        });
      });
      await batch.commit();
    }
    document.getElementById('import-text').value = '';
    refreshImportSummary();
    state.wishFilter = 'all'; wishUi.state = 'open'; wishUi.query = ''; wishUi.tag = '';
    document.getElementById('wish-search').value = '';
    toast(`${fresh.length}개 넣었어요`);
    showTab('request');
    applyGoodsView('wish');
    renderWishes();
  } catch (err) {
    toast('가져오기 실패: ' + (err.code || err.message));
    refreshImportSummary();
  }
});

/* ---- list: tiles filter, search, 남은 것 / 다녀옴 ---- */
document.querySelectorAll('.cat-tile').forEach(tile => {
  tile.addEventListener('click', () => {
    state.wishFilter = state.wishFilter === tile.dataset.cat ? 'all' : tile.dataset.cat;
    wishUi.tag = '';
    renderWishes();
    staggerList(document.getElementById('wish-list'));
  });
});
document.querySelectorAll('#wish-state-seg button').forEach(btn => {
  btn.addEventListener('click', () => { wishUi.state = btn.dataset.wstate; renderWishes(); staggerList(document.getElementById('wish-list')); });
});
document.getElementById('wish-search').addEventListener('input', (e) => {
  wishUi.query = e.target.value.trim().toLowerCase();
  document.getElementById('wish-search-clear').classList.toggle('hidden', !e.target.value);
  renderWishes();
});
document.getElementById('wish-search-clear').addEventListener('click', () => {
  const input = document.getElementById('wish-search');
  input.value = ''; wishUi.query = '';
  document.getElementById('wish-search-clear').classList.add('hidden');
  renderWishes();
  input.focus();
});

// 목록 줄에서는 가격을 맨 앞으로 — 훑어볼 때 분류보다 가격이 더 쓸모 있다
const dropSheetTags = (notes) => (notes || '').split(' · ').filter(p => p !== '후보' && p !== '보류').join(' · ');
function rowNote(notes) {
  const parts = dropSheetTags(notes).split(" · ").filter(Boolean);
  const i = parts.findIndex(p => p.startsWith("가격 "));
  if (i > 0) parts.unshift(parts.splice(i, 1)[0]);
  return parts.join(" · ");
}
function buildWishRow(w, ignite) {
  const cat = catOf(w);
  const meta = WISH_CAT_META[cat];
  const src = wishImageSrc(w);
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'wish-row' + (w.done ? ' off' : '') + (ignite ? ' ignite' : '');
  row.dataset.cat = cat;
  const date = shortDate(w.done && w.doneAt ? w.doneAt : w.createdAt);
  row.innerHTML = `
    <span class="wish-thumb">${src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy">` : icon(meta.icon, 'ic-lg')}</span>
    <span class="wish-main">
      <span class="wish-title">${escapeHtml(w.title)}</span>
      ${(w.tag || w.notes) ? `<span class="wish-note">${w.tag ? `<b class="wish-tag">${escapeHtml(w.tag)}</b>` : ''}${escapeHtml(rowNote(w.notes))}</span>` : ''}
    </span>
    <span class="wish-side">${icon(meta.icon)}<span class="wish-date">${date}</span></span>`;
  const img = row.querySelector('img');
  if (img) img.addEventListener('error', () => { row.querySelector('.wish-thumb').innerHTML = icon(meta.icon, 'ic-lg'); });
  row.addEventListener('click', () => openWishModal(w));
  return row;
}

function renderWishes() {
  renderRequestStatus();
  const list = document.getElementById('wish-list');
  if (!list) return;
  const all = Object.values(state.wishes);
  const filter = state.wishFilter;

  WISH_CATEGORIES.forEach(cat => {
    countUp(document.getElementById(`tile-count-${cat}`), all.filter(w => !w.done && catOf(w) === cat).length);
  });
  document.querySelectorAll('.cat-tile').forEach(t => {
    const on = t.dataset.cat === filter;
    t.classList.toggle('on', on);
    t.setAttribute('aria-pressed', on);
  });
  document.getElementById('cat-tiles').classList.toggle('has-on', filter !== 'all');
  syncWishFab();

  const inCat = all.filter(w => filter === 'all' || catOf(w) === filter);
  document.getElementById('seg-open').textContent = inCat.filter(w => !w.done).length;
  document.getElementById('seg-done').textContent = inCat.filter(w => w.done).length;
  document.querySelectorAll('#wish-state-seg button').forEach(b => b.classList.toggle('on', b.dataset.wstate === wishUi.state));

  const wantDone = wishUi.state === 'done';
  let items = inCat.filter(w => !!w.done === wantDone);
  renderTagBar(items);
  if (wishUi.tag === '__none') items = items.filter(w => !w.tag);
  else if (wishUi.tag) items = items.filter(w => w.tag === wishUi.tag);
  if (wishUi.query) {
    items = items.filter(w => `${w.title || ''} ${w.tag || ''} ${w.notes || ''}`.toLowerCase().includes(wishUi.query));
  }
  items.sort((a, b) => tsSeconds(b.createdAt) - tsSeconds(a.createdAt));

  list.innerHTML = '';
  if (items.length === 0) {
    let msg;
    if (wishUi.query) msg = `<b>찾는 찜이 없어요</b>"${escapeHtml(wishUi.query)}"에 맞는 이름이나 메모가 없어요.`;
    else if (wantDone) msg = '<b>아직 다녀온 곳이 없어요</b>찜을 이루면 여기에 따로 모여요.';
    else if (all.length === 0) msg = '<b>아직 담아둔 게 없어요</b>아래 + 버튼으로 첫 찜을 담아보세요.';
    else msg = '<b>이 종류는 비어있어요</b>다른 종류를 보거나 새로 담아보세요.';
    list.innerHTML = `<p class="empty-state">${msg}</p>`;
    items.forEach(w => wishUi.known.add(w.id));
    wishUi.rendered = true;
    return;
  }

  const igniteNew = (w) => wishUi.rendered && !wishUi.known.has(w.id);
  const grouped = filter === 'all' && !wishUi.query && !wantDone;
  if (grouped) {
    WISH_CATEGORIES.forEach(cat => {
      const part = items.filter(w => catOf(w) === cat);
      if (!part.length) return;
      const meta = WISH_CAT_META[cat];
      const head = document.createElement('div');
      head.className = 'wish-sec';
      head.dataset.cat = cat;
      head.innerHTML = `${icon(meta.icon, 'ic-sm')}${meta.long}<span class="num">${part.length}</span>`;
      list.appendChild(head);
      part.forEach(w => list.appendChild(buildWishRow(w, igniteNew(w))));
    });
  } else {
    items.forEach(w => list.appendChild(buildWishRow(w, igniteNew(w))));
  }
  all.forEach(w => wishUi.known.add(w.id));
  wishUi.rendered = true;
}

async function toggleWishDone(w) {
  await wishColl().doc(w.id).update({
    done: !w.done,
    doneBy: !w.done ? state.memberId : null,
    doneAt: !w.done ? firebase.firestore.FieldValue.serverTimestamp() : null,
  });
}

/* ---- detail / edit sheet ---- */
const wishModal = document.getElementById('modal-wish');
function showWishViewMode(show) {
  document.getElementById('wish-view-mode').classList.toggle('hidden', !show);
  document.getElementById('form-wish-edit').classList.toggle('hidden', show);
}
function openWishModal(w) {
  editingWishId = w.id;
  const cat = catOf(w);
  const meta = WISH_CAT_META[cat];
  const requester = state.members[w.requestedBy];
  document.getElementById('wish-detail-card').dataset.cat = cat;

  const src = wishImageSrc(w);
  const img = document.getElementById('wish-detail-img');
  const fallback = document.getElementById('wish-detail-fallback');
  fallback.querySelector('use').setAttribute('href', `#i-${meta.icon}`);
  if (src) { img.src = src; img.classList.remove('hidden'); fallback.classList.add('hidden'); }
  else { img.removeAttribute('src'); img.classList.add('hidden'); fallback.classList.remove('hidden'); }
  img.onerror = () => { img.classList.add('hidden'); fallback.classList.remove('hidden'); };

  document.getElementById('wish-detail-tag').innerHTML = `${icon(meta.icon, 'ic-sm')}${meta.long}${w.tag ? ' · ' + escapeHtml(w.tag) : ''}`;
  document.getElementById('wish-detail-title').textContent = w.title || '';
  const date = shortDate(w.createdAt);
  document.getElementById('wish-detail-meta').textContent = `${requester?.name || '?'} 담음${date ? ' · ' + date : ''}`;
  const notesWrap = document.getElementById('wish-detail-notes-wrap');
  const shownNotes = dropSheetTags(w.notes);
  notesWrap.classList.toggle('hidden', !shownNotes);
  document.getElementById('wish-detail-notes').textContent = shownNotes;
  const linkEl = document.getElementById('wish-detail-link');
  linkEl.classList.toggle('hidden', !w.link);
  if (w.link) { linkEl.href = w.link; document.getElementById('wish-detail-link-host').textContent = linkHost(w.link); }
  document.getElementById('btn-wish-detail-heart').innerHTML = w.done
    ? `${icon('undo')}다시 찜하기`
    : `${icon('check')}${meta.done}`;

  document.getElementById('btn-wish-to-shopping').parentElement.classList.toggle('hidden', !!w.done);
  showWishViewMode(true);
  wishModal.classList.remove('hidden');
}
function closeWishModal() { wishModal.classList.add('hidden'); editingWishId = null; }
document.getElementById('modal-wish-close').addEventListener('click', closeWishModal);
wishModal.addEventListener('click', (e) => { if (e.target === wishModal) closeWishModal(); });

document.getElementById('btn-wish-detail-heart').addEventListener('click', async () => {
  const w = state.wishes[editingWishId];
  if (!w) return;
  const meta = WISH_CAT_META[catOf(w)];
  await toggleWishDone(w);
  closeWishModal();
  toast(w.done ? '다시 찜했어요' : `"${w.title}" ${meta.done}`);
});
document.getElementById('btn-wish-to-shopping').addEventListener('click', async () => {
  const w = state.wishes[editingWishId];
  if (!w) return;
  if (!confirm(`"${w.title}"을(를) 장보기로 옮길까요?\n찜 목록에서는 빠져요.`)) return;
  const fam = db.collection('families').doc(state.familyId);
  const batch = db.batch();
  batch.set(fam.collection('shopping').doc(), {
    name: w.title, link: w.link || null, purchased: false,
    requestedBy: state.memberId, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  batch.delete(wishColl().doc(w.id));
  try {
    await batch.commit();
    closeWishModal();
    toast('장보기로 옮겼어요');
  } catch (err) { toast('옮기기 실패: ' + (err.code || err.message)); }
});
document.getElementById('btn-delete-wish').addEventListener('click', async () => {
  if (!editingWishId) return;
  if (confirm('이 찜을 삭제할까요?')) {
    await wishColl().doc(editingWishId).delete();
    closeWishModal();
  }
});
document.getElementById('btn-edit-wish').addEventListener('click', () => {
  const w = state.wishes[editingWishId];
  if (!w) return;
  editingWishCat = catOf(w);
  document.getElementById('wish-detail-title-input').value = w.title || '';
  paintPicker('wish-detail-cat-picker', editingWishCat);
  const notes = document.getElementById('wish-detail-notes-input');
  notes.value = w.notes || '';
  notes.placeholder = WISH_CAT_META[editingWishCat].hint;
  document.getElementById('wish-detail-link-input').value = w.link || '';
  document.getElementById('wish-detail-tag-input').value = w.tag || '';
  renderTagSuggest('wish-detail-tag-suggest', 'wish-detail-tag-input', editingWishCat);
  photoSlots.edit.data = w.photo || null;
  renderPhotoSlot('edit');
  showWishViewMode(false);
});
document.getElementById('btn-edit-cancel').addEventListener('click', () => showWishViewMode(true));

document.getElementById('form-wish-edit').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingWishId) return;
  const title = document.getElementById('wish-detail-title-input').value.trim();
  if (!title) return;
  try {
    await wishColl().doc(editingWishId).update({
      title, category: editingWishCat,
      tag: document.getElementById('wish-detail-tag-input').value.trim() || null,
      notes: document.getElementById('wish-detail-notes-input').value.trim() || null,
      link: normalizeLink(document.getElementById('wish-detail-link-input').value),
      photo: photoSlots.edit.data || null,
    });
    toast('수정했어요');
    closeWishModal();
  } catch (err) {
    toast('수정 실패: ' + (err.code || err.message));
  }
});

function formatRelativeTime(ts) {
  if (!ts || !ts.toDate) return '';
  const diffMs = Date.now() - ts.toDate().getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return '방금 전';
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.floor(mins/60);
  if (hrs < 24) return `${hrs}시간 전`;
  return `${Math.floor(hrs/24)}일 전`;
}

/* ===================== PWA service worker ===================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.update(); // check for a newer sw.js as soon as the app opens
      setInterval(() => reg.update(), 60 * 60 * 1000); // and again hourly while it stays open
    }).catch(() => {});
  });
  // Once a new service worker takes over, the page is still running old JS —
  // reload so an already-installed PWA picks up the update automatically
  // instead of silently staying on a stale version until manually reinstalled.
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedForUpdate) return;
    reloadedForUpdate = true;
    window.location.reload();
  });
}

/* ===================== Install / add-to-home-screen ===================== */
(function initInstallBanner() {
  const banner = document.getElementById('install-banner');
  if (!banner) return;
  const actionBtn = document.getElementById('install-action');
  const dismissBtn = document.getElementById('install-dismiss');
  const subEl = document.getElementById('install-sub');

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const dismissed = () => localStorage.getItem('installBannerDismissed') === '1';

  let deferredPrompt = null;

  function hide() { banner.classList.add('hidden'); }
  function show() { if (!dismissed() && !isStandalone) banner.classList.remove('hidden'); }

  dismissBtn?.addEventListener('click', () => {
    localStorage.setItem('installBannerDismissed', '1');
    hide();
  });

  // Android / Chrome / Edge: capture the native install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    subEl.textContent = '홈 화면에 추가하면 앱처럼 바로 열 수 있어요.';
    actionBtn.textContent = '설치';
    actionBtn.style.display = '';
    show();
  });

  actionBtn?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (e) {}
    deferredPrompt = null;
    hide();
  });

  window.addEventListener('appinstalled', () => {
    localStorage.setItem('installBannerDismissed', '1');
    hide();
    toast('앱이 설치됐어요');
  });

  // iOS Safari has no beforeinstallprompt — show manual instructions instead
  if (isIOS && !isStandalone && !dismissed()) {
    subEl.innerHTML = '공유 버튼 <strong>􀈂</strong> → "홈 화면에 추가"를 누르세요.';
    subEl.textContent = '아래 공유 버튼(□↑)을 누른 뒤 "홈 화면에 추가"를 선택하세요.';
    actionBtn.style.display = 'none';
    setTimeout(show, 1200);
  }
})();
