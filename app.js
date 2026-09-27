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
  if (!sharedUrl && !sharedText && !sharedTitle) return;
  const urlMatch = (sharedUrl || sharedText).match(/https?:\/\/\S+/);
  const link = urlMatch ? urlMatch[0] : (sharedUrl || '');
  const title = sharedTitle || (sharedText && !urlMatch ? sharedText : '');
  if (link || title) pendingSharedWish = { link, title: title.slice(0, 80), text: sharedText };
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
  notices: {},           // noticeId -> notice data
  shownNudges: {},       // noticeId -> last nudge timestamp we already toasted
  anniversaries: {},     // annivId -> anniversary data
  editingTaskId: null,
  editingAnniversaryId: null,
  unsubUser: null,
  unsubFamily: null,
  unsubMembers: null,
  unsubTasks: null,
  unsubShopping: null,
  unsubAnniversaries: null,
  notifiedAnniversaryToday: null,
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
  if (state.unsubNotices) { state.unsubNotices(); state.unsubNotices = null; }
  if (state.unsubAnniversaries) { state.unsubAnniversaries(); state.unsubAnniversaries = null; }
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

  state.unsubNotices = db.collection('families').doc(familyId).collection('notices')
    .orderBy('createdAt', 'desc')
    .onSnapshot(snap => {
      // "콕 찌르기" — toast when someone pokes me about a notice I haven't read
      snap.docChanges().forEach(change => {
        if (change.type !== 'modified') return;
        const n = change.doc.data();
        if (n.nudge && n.nudge.by && n.nudge.by !== state.memberId && n.nudge.at &&
            (!n.readBy || !n.readBy.includes(state.memberId)) &&
            !change.doc.metadata.hasPendingWrites) {
          const key = n.nudge.at.seconds || Date.now();
          if (state.shownNudges[change.doc.id] !== key) {
            state.shownNudges[change.doc.id] = key;
            const who = state.members[n.nudge.by]?.name || '가족';
            notifyUser(`${who}님이 확인을 기다리고 있어요!`, (n.text || '').slice(0, 30));
          }
        }
      });
      state.notices = {};
      snap.forEach(doc => { state.notices[doc.id] = { id: doc.id, ...doc.data() }; });
      renderNotices();
      renderNoticeBanner();
      markNoticesReadIfVisible();
    });

  state.unsubAnniversaries = db.collection('families').doc(familyId).collection('anniversaries')
    .onSnapshot(snap => {
      state.anniversaries = {};
      snap.forEach(doc => { state.anniversaries[doc.id] = { id: doc.id, ...doc.data() }; });
      renderAnniversaries();
      checkUpcomingAnniversaries();
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
        <button class="member-delete-btn" title="구성원 삭제" aria-label="구성원 삭제">✕</button>
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
    sel.innerHTML = '<option value="all">👪 전체</option>' +
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
    <span class="task-checkbox ${t.done ? 'checked' : ''}">${t.done ? '✓' : ''}</span>
    <div class="task-body">
      <p class="task-title">${escapeHtml(t.title)}</p>
      <div class="task-meta">
        <span class="event-assignee-badge">
          <span class="avatar-dot" style="background:${colorForAssignee(t.assignee)}">${t.assignee==='all'?'👪':initialsFor(assigneeName)}</span>
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
    list.innerHTML = '<p class="empty-state">집안일이 없어요. 오른쪽 위 버튼으로 추가해보세요.</p>';
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
  const items = Object.values(state.shopping)
    .sort((a,b) => (a.purchased === b.purchased) ? 0 : (a.purchased ? 1 : -1));
  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">사고 싶은 물건을 추가해보세요.</p>';
    return;
  }
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'shopping-item' + (item.purchased ? ' purchased' : '');
    const requesterName = state.members[item.requestedBy]?.name || '?';
    const priceLabel = item.price != null ? `${Number(item.price).toLocaleString('ko-KR')}원` : '';
    row.innerHTML = `
      <span class="task-checkbox ${item.purchased ? 'checked' : ''}">${item.purchased ? '✓' : ''}</span>
      <div class="shopping-body">
        <span class="shopping-name">${escapeHtml(item.name)}${item.qty ? ` <span class="shopping-qty">${escapeHtml(item.qty)}</span>` : ''}</span>
        ${(priceLabel || item.link) ? `<span class="shopping-sub">
          ${priceLabel ? `<span class="shopping-price">${priceLabel}</span>` : ''}
          ${item.link ? `<a class="shopping-link" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">🔗 구매 링크</a>` : ''}
        </span>` : ''}
        <span class="shopping-meta">${escapeHtml(requesterName)}님 요청</span>
      </div>
      <button class="shopping-delete-btn" title="삭제" aria-label="삭제">✕</button>
    `;
    row.querySelector('.task-checkbox').addEventListener('click', () => toggleShoppingPurchased(item));
    row.querySelector('.shopping-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      db.collection('families').doc(state.familyId).collection('shopping').doc(item.id).delete();
    });
    list.appendChild(row);
  });
}

async function toggleShoppingPurchased(item) {
  await db.collection('families').doc(state.familyId).collection('shopping').doc(item.id).update({
    purchased: !item.purchased,
    purchasedBy: !item.purchased ? state.memberId : null,
  });
}

document.getElementById('form-shopping-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById('shopping-item-name');
  const qtyInput = document.getElementById('shopping-item-qty');
  const priceInput = document.getElementById('shopping-item-price');
  const linkInput = document.getElementById('shopping-item-link');
  const name = nameInput.value.trim();
  if (!name) return;
  const qty = qtyInput.value.trim() || null;
  const priceRaw = priceInput.value.trim();
  const price = priceRaw ? Number(priceRaw) : null;
  let link = linkInput.value.trim() || null;
  if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
  await db.collection('families').doc(state.familyId).collection('shopping').add({
    name, qty, price, link, purchased: false, requestedBy: state.memberId, createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  nameInput.value = '';
  qtyInput.value = '';
  priceInput.value = '';
  linkInput.value = '';
  toast(`"${name}" 추가했어요`);
});

/* ===================== Wishlist: 인스타/SNS에서 본 가고 싶은 곳 · 먹고 싶은 음식 · 갖고 싶은 것 ===================== */
const WISH_CATEGORIES = ['place', 'food', 'gift'];
const WISH_CAT_META = {
  place: { emoji: '📍', label: '가고 싶은 곳' },
  food: { emoji: '🍽️', label: '먹고 싶은 음식' },
  gift: { emoji: '🛍️', label: '갖고 싶은 것' },
};
const WISH_NOTES_EXAMPLES = {
  place: '위치, 특징 등',
  food: '가게 이름, 메뉴 등',
  gift: '사이즈, 색상, 가격대 등',
};

let selectedWishCat = 'place';
function setWishCatPicker(cat) {
  selectedWishCat = cat;
  document.querySelectorAll('#wish-cat-picker .wish-cat-btn').forEach(b => b.classList.toggle('active', b.dataset.wishCat === cat));
  document.getElementById('wish-notes').placeholder = `상세정보 (선택 · ${WISH_NOTES_EXAMPLES[cat]})`;
}
document.querySelectorAll('#wish-cat-picker .wish-cat-btn').forEach(btn => {
  btn.addEventListener('click', () => setWishCatPicker(btn.dataset.wishCat));
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

/* Apply a link shared in from another app (Instagram/YouTube/네이버지도 "공유" → 인생찜) */
function applySharedWish({ link, title, text }) {
  applyGoodsView('wish');
  const guess = guessWishCategory(link, text);
  if (guess) setWishCatPicker(guess);
  document.getElementById('wish-title').value = title || '';
  document.getElementById('wish-link').value = link || '';
  const form = document.getElementById('form-wish-add');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('wish-title').focus();
  toast('공유된 링크를 담았어요 🔖 나머지 정보를 채워주세요');
}

/* "📋 붙여넣기" — a tap-triggered clipboard read works everywhere (Safari requires the
   read to happen inside a direct user gesture, so this is more reliable than auto-detecting) */
document.querySelectorAll('.paste-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) { toast('클립보드가 비어있어요'); return; }
      document.getElementById(btn.dataset.target).value = text;
      if (btn.dataset.target === 'wish-link') {
        const guess = guessWishCategory(text, '');
        if (guess) setWishCatPicker(guess);
      }
    } catch (err) {
      toast('클립보드 읽기 권한이 필요해요');
    }
  });
});

document.querySelectorAll('.wish-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.wish-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.wishFilter = btn.dataset.wfilter;
    renderWishes();
  });
});

function renderWishes() {
  renderRequestStatus();
  const list = document.getElementById('wish-list');
  if (!list) return;
  list.innerHTML = '';
  let items = Object.values(state.wishes);
  if (state.wishFilter !== 'all') items = items.filter(w => (w.category || 'gift') === state.wishFilter);

  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">아직 담아둔 게 없어요. 링크와 함께 하나씩 담아보세요 🔖</p>';
    return;
  }

  // group by category (section) first so items are easy to browse by kind, not by who added them
  const byCategory = new Map();
  items.forEach(w => {
    const key = WISH_CATEGORIES.includes(w.category) ? w.category : 'gift';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(w);
  });

  WISH_CATEGORIES.forEach(cat => {
    const wishItems = byCategory.get(cat);
    if (!wishItems || wishItems.length === 0) return;
    const meta = WISH_CAT_META[cat];

    const header = document.createElement('div');
    header.className = 'wish-group-header';
    header.innerHTML = `<span class="wish-group-emoji">${meta.emoji}</span><span>${meta.label}</span><span class="wish-group-count">${wishItems.length}</span>`;
    list.appendChild(header);

    wishItems.sort((a,b) => (a.done === b.done) ? 0 : (a.done ? 1 : -1));
    wishItems.forEach(w => {
      const requester = state.members[w.requestedBy];
      const row = document.createElement('div');
      row.className = 'wish-item' + (w.done ? ' done' : '');
      row.innerHTML = `
        <span class="avatar-dot wish-requester-dot" style="background:${requester ? colorFor(requester.colorIndex) : '#B9AE94'}" title="${escapeHtml(requester?.name || '?')}">${initialsFor(requester?.name || '?')}</span>
        <div class="wish-body">
          <span class="wish-name">${escapeHtml(w.title)}</span>
          ${(w.notes || w.link) ? `<span class="wish-sub">
            ${w.notes ? `<span class="wish-notes">${escapeHtml(w.notes)}</span>` : ''}
            ${w.link ? `<a class="wish-link" href="${escapeHtml(w.link)}" target="_blank" rel="noopener noreferrer">🔗 링크</a>` : ''}
          </span>` : ''}
        </div>
        <button class="wish-heart ${w.done ? 'on' : ''}" title="이뤄졌어요">${w.done ? '💖' : '🤍'}</button>
        <button class="wish-delete-btn" title="삭제" aria-label="삭제">✕</button>
      `;
      row.querySelector('.wish-body').addEventListener('click', () => openWishModal(w));
      row.querySelector('.wish-heart').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleWishDone(w);
      });
      row.querySelector('.wish-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('이 위시를 삭제할까요?')) {
          db.collection('families').doc(state.familyId).collection('wishes').doc(w.id).delete();
        }
      });
      list.appendChild(row);
    });
  });
}

async function toggleWishDone(w) {
  await db.collection('families').doc(state.familyId).collection('wishes').doc(w.id).update({
    done: !w.done,
    doneBy: !w.done ? state.memberId : null,
  });
}

/* ---- Wish detail/edit modal: tap a card to see and fix what was entered ---- */
const wishModal = document.getElementById('modal-wish');
let editingWishId = null;
let editingWishCat = 'place';

document.querySelectorAll('#wish-detail-cat-picker .wish-cat-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#wish-detail-cat-picker .wish-cat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    editingWishCat = btn.dataset.wishCat;
    document.getElementById('wish-detail-notes-input').placeholder = WISH_NOTES_EXAMPLES[editingWishCat];
  });
});

function openWishModal(w) {
  editingWishId = w.id;
  editingWishCat = WISH_CATEGORIES.includes(w.category) ? w.category : 'gift';
  const requester = state.members[w.requestedBy];
  document.getElementById('wish-detail-meta').textContent = `${requester?.name || '?'}님이 담음`;

  document.getElementById('wish-detail-title-input').value = w.title || '';
  document.querySelectorAll('#wish-detail-cat-picker .wish-cat-btn').forEach(b => b.classList.toggle('active', b.dataset.wishCat === editingWishCat));
  document.getElementById('wish-detail-notes-input').value = w.notes || '';
  document.getElementById('wish-detail-link-input').value = w.link || '';

  const linkEl = document.getElementById('wish-detail-link');
  if (w.link) {
    linkEl.href = w.link;
    linkEl.classList.remove('hidden');
  } else {
    linkEl.classList.add('hidden');
  }

  const heartBtn = document.getElementById('btn-wish-detail-heart');
  heartBtn.textContent = w.done ? '🤍 다시 담기' : '💖 이뤄졌어요로 표시';

  wishModal.classList.remove('hidden');
}
function closeWishModal() { wishModal.classList.add('hidden'); editingWishId = null; }
document.getElementById('modal-wish-close').addEventListener('click', closeWishModal);
wishModal.addEventListener('click', (e) => { if (e.target === wishModal) closeWishModal(); });
document.getElementById('btn-wish-detail-heart').addEventListener('click', async () => {
  const w = state.wishes[editingWishId];
  if (w) await toggleWishDone(w);
  closeWishModal();
});
document.getElementById('btn-delete-wish').addEventListener('click', async () => {
  if (!editingWishId) return;
  if (confirm('이 위시를 삭제할까요?')) {
    await db.collection('families').doc(state.familyId).collection('wishes').doc(editingWishId).delete();
    closeWishModal();
  }
});

document.getElementById('form-wish-edit').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingWishId) return;
  const title = document.getElementById('wish-detail-title-input').value.trim();
  if (!title) return;
  const notes = document.getElementById('wish-detail-notes-input').value.trim() || null;
  let link = document.getElementById('wish-detail-link-input').value.trim() || null;
  if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
  try {
    await db.collection('families').doc(state.familyId).collection('wishes').doc(editingWishId).update({
      title, category: editingWishCat, notes, link,
    });
    toast('수정했어요');
    closeWishModal();
  } catch (err) {
    toast('수정 실패: ' + (err.code || err.message));
  }
});

document.getElementById('form-wish-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('wish-title');
  const notesInput = document.getElementById('wish-notes');
  const linkInput = document.getElementById('wish-link');
  const title = input.value.trim();
  if (!title) return;
  const category = selectedWishCat;
  const notes = notesInput?.value.trim() || null;
  let link = linkInput?.value.trim() || null;
  if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
  try {
    await db.collection('families').doc(state.familyId).collection('wishes').add({
      title, category, notes, link, done: false,
      requestedBy: state.memberId, createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    input.value = '';
    if (notesInput) notesInput.value = '';
    if (linkInput) linkInput.value = '';
    // category stays as-is (sticky) — adding several items of the same kind in a row shouldn't
    // require re-tapping the category every time
    toast(`"${title}" 담았어요 🔖`);
  } catch (err) {
    if (err.code === 'permission-denied') toast('위시리스트 권한 설정이 필요해요 (규칙 재게시)');
    else toast('추가 실패: ' + (err.code || err.message));
  }
});

/* ===================== Family notice board ===================== */
const REACTIONS = ['확인했어요!', '감사해요', '넵!', '👍', '💗', '😂'];

document.getElementById('form-notice-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ta = document.getElementById('notice-text');
  const text = ta.value.trim();
  if (!text) return;
  const pinned = document.getElementById('notice-pin').checked;
  try {
    await db.collection('families').doc(state.familyId).collection('notices').add({
      text, pinned, reactions: {}, readBy: [state.memberId],
      createdBy: state.memberId, createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    ta.value = '';
    document.getElementById('notice-pin').checked = false;
  } catch (err) {
    if (err.code === 'permission-denied') toast('공지 권한 설정이 필요해요 (규칙 재게시)');
    else toast('올리기 실패: ' + (err.code || err.message));
  }
});

function noticeRef(id) {
  return db.collection('families').doc(state.familyId).collection('notices').doc(id);
}
async function toggleReaction(id, label) {
  const n = state.notices[id]; if (!n) return;
  const field = 'reactions.' + state.memberId;
  const mine = (n.reactions || {})[state.memberId];
  await noticeRef(id).update({ [field]: mine === label ? firebase.firestore.FieldValue.delete() : label });
}
async function toggleNoticePin(id) {
  const n = state.notices[id]; if (!n) return;
  await noticeRef(id).update({ pinned: !n.pinned });
}
async function nudgeNotice(id) {
  await noticeRef(id).update({ nudge: { by: state.memberId, at: firebase.firestore.FieldValue.serverTimestamp() } });
  toast('안 읽은 가족에게 콕 알림을 보냈어요');
}
async function deleteNotice(id) {
  if (!confirm('이 공지를 삭제할까요?')) return;
  await noticeRef(id).delete();
}
function convertNoticeToTask(id) {
  const n = state.notices[id]; if (!n) return;
  closeNoticeModal();
  showTab('request');
  applyGoodsView('tasks');
  openTaskModal(null);
  document.getElementById('task-title').value = (n.text || '').slice(0, 60);
}
function markNoticesReadIfVisible() {
  const modal = document.getElementById('modal-notice');
  if (modal && !modal.classList.contains('hidden')) markNoticesRead();
}
function markNoticesRead() {
  if (!state.memberId) return;
  Object.values(state.notices).forEach(n => {
    if (!n.readBy || !n.readBy.includes(state.memberId)) {
      noticeRef(n.id).update({ readBy: firebase.firestore.FieldValue.arrayUnion(state.memberId) }).catch(() => {});
    }
  });
}

function renderNotices() {
  const list = document.getElementById('notice-list');
  if (!list) return;
  list.innerHTML = '';
  const items = Object.values(state.notices).sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
  });
  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">아직 공지가 없어요. 가족에게 한마디 남겨보세요 💌</p>';
    return;
  }
  const memberCount = Object.keys(state.members).length || 1;
  items.forEach(n => {
    const author = state.members[n.createdBy]?.name || '?';
    const mine = (n.reactions || {})[state.memberId];
    const reactionEntries = Object.entries(n.reactions || {});
    const readBy = n.readBy || [];
    const isAuthor = n.createdBy === state.memberId;
    const unread = memberCount - readBy.length;

    const summary = reactionEntries.map(([uid, label]) =>
      `<span class="reaction-chip">${escapeHtml(label)} <b>${escapeHtml(state.members[uid]?.name || '?')}</b></span>`
    ).join('');
    const readAvatars = readBy.map(uid => {
      const m = state.members[uid]; if (!m) return '';
      return `<span class="avatar-dot mini" style="background:${colorFor(m.colorIndex)}">${initialsFor(m.name)}</span>`;
    }).join('');

    const card = document.createElement('div');
    card.className = 'notice-card' + (n.pinned ? ' pinned' : '');
    card.innerHTML = `
      ${n.pinned ? '<span class="pin-badge">📌 고정</span>' : ''}
      <p class="notice-text">${escapeHtml(n.text).replace(/\n/g, '<br>')}</p>
      <div class="notice-byline">
        <span class="avatar-dot" style="background:${colorForAssignee(n.createdBy)}">${initialsFor(author)}</span>
        <span>${escapeHtml(author)}</span>
        <span class="notice-time">${n.createdAt ? formatRelativeTime(n.createdAt) : ''}</span>
      </div>
      <div class="reaction-bar">
        ${REACTIONS.map(r => `<button class="react-btn ${mine === r ? 'on' : ''}" data-r="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join('')}
      </div>
      ${summary ? `<div class="reaction-summary">${summary}</div>` : ''}
      <div class="notice-foot">
        <span class="read-info">👀 ${readBy.length}/${memberCount} ${readAvatars}</span>
        <span class="notice-actions">
          <button class="notice-mini todo">집안일로</button>
          ${unread > 0 ? '<button class="notice-mini nudge">콕 찌르기</button>' : ''}
          ${isAuthor ? `<button class="notice-mini pin">${n.pinned ? '고정해제' : '고정'}</button>` : ''}
          ${isAuthor ? '<button class="notice-mini del">삭제</button>' : ''}
        </span>
      </div>
    `;
    card.querySelectorAll('.react-btn').forEach(b => b.addEventListener('click', () => toggleReaction(n.id, b.dataset.r)));
    card.querySelector('.todo')?.addEventListener('click', () => convertNoticeToTask(n.id));
    card.querySelector('.nudge')?.addEventListener('click', () => nudgeNotice(n.id));
    card.querySelector('.pin')?.addEventListener('click', () => toggleNoticePin(n.id));
    card.querySelector('.del')?.addEventListener('click', () => deleteNotice(n.id));
    list.appendChild(card);
  });
}

/* Mini banner shown above every tab: top pinned notice, else latest; opens the full board */
function renderNoticeBanner() {
  const banner = document.getElementById('notice-banner');
  if (!banner) return;
  const items = Object.values(state.notices).sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
  });
  if (items.length === 0) {
    document.getElementById('notice-banner-text').textContent = '가족에게 한마디를 남겨보세요 💌';
    banner.classList.remove('hidden');
    return;
  }
  const top = items[0];
  const author = state.members[top.createdBy]?.name || '?';
  document.getElementById('notice-banner-text').textContent =
    (top.pinned ? '📌 ' : '') + `${author}: ${top.text}`;
  banner.classList.remove('hidden');
}

const noticeModal = document.getElementById('modal-notice');
function openNoticeModal() {
  noticeModal.classList.remove('hidden');
  markNoticesRead();
}
function closeNoticeModal() { noticeModal.classList.add('hidden'); }
document.getElementById('notice-banner').addEventListener('click', openNoticeModal);
document.getElementById('modal-notice-close').addEventListener('click', closeNoticeModal);
noticeModal.addEventListener('click', (e) => { if (e.target === noticeModal) closeNoticeModal(); });

/* ===================== Anniversaries ===================== */
function populateMonthDaySelects() {
  const monthSel = document.getElementById('anniversary-month');
  const daySel = document.getElementById('anniversary-day');
  if (monthSel.options.length === 0) {
    for (let m=1;m<=12;m++) monthSel.innerHTML += `<option value="${m}">${m}월</option>`;
  }
  const refreshDays = () => {
    const days = new Date(2024, parseInt(monthSel.value,10), 0).getDate(); // leap-safe max
    const prev = daySel.value;
    daySel.innerHTML = '';
    for (let d=1; d<=days; d++) daySel.innerHTML += `<option value="${d}">${d}일</option>`;
    if (prev && parseInt(prev,10) <= days) daySel.value = prev;
  };
  monthSel.onchange = refreshDays;
  refreshDays();
}

function nextOccurrence(month, day) {
  const now = new Date();
  let year = now.getFullYear();
  let d = new Date(year, month-1, day);
  if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d = new Date(year+1, month-1, day);
  return d;
}

function renderAnniversaries() {
  const list = document.getElementById('anniversary-list');
  if (!list) return;
  list.innerHTML = '';
  const items = Object.values(state.anniversaries).sort((a,b) => nextOccurrence(a.month,a.day) - nextOccurrence(b.month,b.day));
  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">등록된 생일·기념일이 없어요.</p>';
    return;
  }
  items.forEach(a => {
    const row = document.createElement('div');
    row.className = 'anniversary-row';
    const next = nextOccurrence(a.month, a.day);
    const daysLeft = Math.ceil((next - new Date(new Date().toDateString())) / 86400000);
    row.innerHTML = `
      <span class="anniversary-icon">${a.type === 'birthday' ? '🎂' : '🎉'}</span>
      <span class="anniversary-name">${escapeHtml(a.title)}</span>
      <span class="anniversary-date">${a.month}월 ${a.day}일</span>
      ${daysLeft <= 14 ? `<span class="anniversary-badge">${daysLeft === 0 ? '오늘' : 'D-' + daysLeft}</span>` : ''}
    `;
    row.addEventListener('click', () => openAnniversaryModal(a));
    list.appendChild(row);
  });
}

const annivModal = document.getElementById('modal-anniversary');
document.getElementById('btn-add-anniversary').addEventListener('click', () => openAnniversaryModal(null));
document.getElementById('modal-anniversary-close').addEventListener('click', closeAnniversaryModal);
annivModal.addEventListener('click', (e) => { if (e.target === annivModal) closeAnniversaryModal(); });

function openAnniversaryModal(a) {
  state.editingAnniversaryId = a ? a.id : null;
  populateMonthDaySelects();
  document.getElementById('anniversary-type').value = a?.type || 'birthday';
  document.getElementById('anniversary-title').value = a?.title || '';
  document.getElementById('anniversary-error').textContent = '';
  if (a) {
    document.getElementById('anniversary-month').value = a.month;
    document.getElementById('anniversary-month').onchange();
    document.getElementById('anniversary-day').value = a.day;
  }
  document.getElementById('btn-delete-anniversary').classList.toggle('hidden', !a);
  annivModal.classList.remove('hidden');
}
function closeAnniversaryModal() { annivModal.classList.add('hidden'); state.editingAnniversaryId = null; }

document.getElementById('form-anniversary').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('anniversary-error');
  errEl.textContent = '';
  const data = {
    type: document.getElementById('anniversary-type').value,
    title: document.getElementById('anniversary-title').value.trim(),
    month: parseInt(document.getElementById('anniversary-month').value, 10),
    day: parseInt(document.getElementById('anniversary-day').value, 10),
  };
  if (!data.title) { errEl.textContent = '이름을 입력해주세요.'; return; }
  try {
    const col = db.collection('families').doc(state.familyId).collection('anniversaries');
    if (state.editingAnniversaryId) {
      await col.doc(state.editingAnniversaryId).update(data);
    } else {
      await col.add({ ...data, createdBy: state.memberId, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    }
    closeAnniversaryModal();
  } catch (err) {
    errEl.textContent = `저장에 실패했어요 (${err.code || err.message})`;
  }
});

document.getElementById('btn-delete-anniversary').addEventListener('click', async () => {
  if (!state.editingAnniversaryId) return;
  if (!confirm('삭제할까요?')) return;
  await db.collection('families').doc(state.familyId).collection('anniversaries').doc(state.editingAnniversaryId).delete();
  closeAnniversaryModal();
});

function checkUpcomingAnniversaries() {
  const key = todayStr();
  if (state.notifiedAnniversaryToday === key) return;
  const todayItems = Object.values(state.anniversaries).filter(a => {
    const next = nextOccurrence(a.month, a.day);
    const daysLeft = Math.ceil((next - new Date(new Date().toDateString())) / 86400000);
    return daysLeft === 0 || daysLeft === 3;
  });
  todayItems.forEach(a => {
    const next = nextOccurrence(a.month, a.day);
    const daysLeft = Math.ceil((next - new Date(new Date().toDateString())) / 86400000);
    if (daysLeft === 0) notifyUser(`오늘은 ${a.title}${a.type === 'birthday' ? ' 생일' : ''}이에요 🎉`);
    else notifyUser(`${a.title}이(가) 3일 뒤예요`, `${a.month}월 ${a.day}일`);
  });
  state.notifiedAnniversaryToday = key;
}

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
    toast('앱이 설치됐어요 🎉');
  });

  // iOS Safari has no beforeinstallprompt — show manual instructions instead
  if (isIOS && !isStandalone && !dismissed()) {
    subEl.innerHTML = '공유 버튼 <strong>􀈂</strong> → "홈 화면에 추가"를 누르세요.';
    subEl.textContent = '아래 공유 버튼(□↑)을 누른 뒤 "홈 화면에 추가"를 선택하세요.';
    actionBtn.style.display = 'none';
    setTimeout(show, 1200);
  }
})();
