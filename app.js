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
    toggleTaskDone(t);
  });
  card.querySelector('.task-body').addEventListener('click', () => openTaskModal(t));
  return card;
}

function renderTasks() {
  renderRequestStatus();
  const list = document.getElementById('tasks-list');
  if (!list) return;
  list.innerHTML = '';
  const tasks = Object.values(state.tasks)
    .sort((a,b) => (a.done === b.done) ? 0 : (a.done ? 1 : -1));

  if (tasks.length === 0) {
    list.innerHTML = '<p class="empty-state"><b>집안일이 없어요</b>위쪽 추가 버튼으로 만들어보세요.</p>';
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
const GOODS_VIEWS = ['wish', 'tasks', 'shopping'];
function applyGoodsView(view) {
  if (!GOODS_VIEWS.includes(view)) view = 'wish';
  localStorage.setItem('goodsView', view);
  GOODS_VIEWS.forEach(v => document.getElementById(`goods-view-${v}`).classList.toggle('hidden', v !== view));
  document.querySelectorAll('.status-chip').forEach(b => b.classList.toggle('active', b.dataset.goodsView === view));
}
document.querySelectorAll('.status-chip').forEach(btn => {
  btn.addEventListener('click', () => applyGoodsView(btn.dataset.goodsView));
});
applyGoodsView(localStorage.getItem('goodsView'));

function renderRequestStatus() {
  const setCount = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  setCount('status-count-tasks', Object.values(state.tasks).filter(t => !t.done).length);
  setCount('status-count-shopping', Object.values(state.shopping).filter(i => !i.purchased).length);
  setCount('status-count-wish', Object.values(state.wishes).filter(w => !w.done).length);
}

/* ===================== Shopping / household supplies ===================== */
function renderShopping() {
  renderRequestStatus();
  const list = document.getElementById('shopping-list');
  if (!list) return;
  list.innerHTML = '';
  // 체크하면 목록에서 빠진다 — 예전에 "구매 완료"로 남은 항목은 보이지 않게 거른다
  const items = Object.values(state.shopping)
    .filter(i => !i.purchased)
    .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">살 것이 없어요. 위에 적어서 추가하세요.</p>';
    return;
  }
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'shopping-item';
    row.innerHTML = `
      <button type="button" class="task-checkbox" aria-label="샀어요, 목록에서 빼기"></button>
      <div class="shopping-body">
        <span class="shopping-name">${escapeHtml(item.name)}${item.qty ? ` <span class="shopping-qty">${escapeHtml(item.qty)}</span>` : ''}</span>
      </div>
    `;
    row.querySelector('.task-checkbox').addEventListener('click', (e) => {
      e.currentTarget.classList.add('checked');
      e.currentTarget.innerHTML = icon('check', 'ic-sm');
      row.classList.add('purchased');
      setTimeout(() => {
        db.collection('families').doc(state.familyId).collection('shopping').doc(item.id).delete();
      }, 350);
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
const wishUi = { state: 'open', query: '', rendered: false, known: new Set() };

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

/* ---- add sheet ---- */
const wishAddModal = document.getElementById('modal-wish-add');
function openWishAdd(prefill = {}) {
  applyGoodsView('wish');
  const pickable = !!prefill.pick;
  document.getElementById('wish-title').value = prefill.title || '';
  document.getElementById('wish-notes').value = '';
  document.getElementById('wish-link').value = prefill.link || '';
  setWishCatPicker(prefill.cat || selectedWishCat);
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
document.querySelectorAll('.cat-add').forEach(btn => {
  btn.addEventListener('click', () => openWishAdd({ cat: btn.dataset.cat }));
});
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
      notes: document.getElementById('wish-notes').value.trim() || null,
      link: normalizeLink(document.getElementById('wish-link').value),
      photo: photoSlots.add.data || null,
      done: false, requestedBy: state.memberId,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    closeWishAdd();
    state.wishFilter = 'all'; wishUi.state = 'open'; wishUi.query = '';
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

/* ---- list: tiles filter, search, 남은 것 / 다녀옴 ---- */
document.querySelectorAll('.cat-tile').forEach(tile => {
  tile.addEventListener('click', () => {
    state.wishFilter = state.wishFilter === tile.dataset.cat ? 'all' : tile.dataset.cat;
    renderWishes();
  });
});
document.querySelectorAll('#wish-state-seg button').forEach(btn => {
  btn.addEventListener('click', () => { wishUi.state = btn.dataset.wstate; renderWishes(); });
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
      ${w.notes ? `<span class="wish-note">${escapeHtml(w.notes)}</span>` : ''}
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
    document.getElementById(`tile-count-${cat}`).textContent = all.filter(w => !w.done && catOf(w) === cat).length;
  });
  document.querySelectorAll('.cat-tile').forEach(t => {
    const on = t.dataset.cat === filter;
    t.classList.toggle('on', on);
    t.setAttribute('aria-pressed', on);
  });
  document.getElementById('cat-tiles').classList.toggle('has-on', filter !== 'all');

  const inCat = all.filter(w => filter === 'all' || catOf(w) === filter);
  document.getElementById('seg-open').textContent = inCat.filter(w => !w.done).length;
  document.getElementById('seg-done').textContent = inCat.filter(w => w.done).length;
  document.querySelectorAll('#wish-state-seg button').forEach(b => b.classList.toggle('on', b.dataset.wstate === wishUi.state));

  const wantDone = wishUi.state === 'done';
  let items = inCat.filter(w => !!w.done === wantDone);
  if (wishUi.query) {
    items = items.filter(w => `${w.title || ''} ${w.notes || ''}`.toLowerCase().includes(wishUi.query));
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

  document.getElementById('wish-detail-tag').innerHTML = `${icon(meta.icon, 'ic-sm')}${meta.long}`;
  document.getElementById('wish-detail-title').textContent = w.title || '';
  const date = shortDate(w.createdAt);
  document.getElementById('wish-detail-meta').textContent = `${requester?.name || '?'} 담음${date ? ' · ' + date : ''}`;
  const notesWrap = document.getElementById('wish-detail-notes-wrap');
  notesWrap.classList.toggle('hidden', !w.notes);
  document.getElementById('wish-detail-notes').textContent = w.notes || '';
  const linkEl = document.getElementById('wish-detail-link');
  linkEl.classList.toggle('hidden', !w.link);
  if (w.link) { linkEl.href = w.link; document.getElementById('wish-detail-link-host').textContent = linkHost(w.link); }
  document.getElementById('btn-wish-detail-heart').innerHTML = w.done
    ? `${icon('undo')}다시 찜하기`
    : `${icon('check')}${meta.done}`;

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
