/* =========================================================
   EduBudget · 연구회 운영비 관리
   - Google 로그인 후 Firestore(users/{uid}/groups/{groupId})에 저장됩니다.
   ========================================================= */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

const SEL_KEY = 'edubudget.selected';
const COUNCIL_CATEGORY = '협의회비';
const COUNCIL_LIMIT = 0.2; // 협의회비 20% 이내
const COLORS = ['#7c5cff', '#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#fb7185', '#a3e635', '#60a5fa', '#c084fc', '#f97316'];
const PAY_METHODS = ['카드', '계좌이체', '현금', '기타'];

// 「5. 연구회 운영비 사용 계획」 기본 템플릿
const TEMPLATE_ITEMS = [
  { category: '활동운영비', name: '자료제작 및 인쇄, 기타 등', basis: '원고료 15,000*40매=600,000원', amount: 600000, note: '' },
  { category: '활동운영비', name: '물품구입비', basis: '연구회 활동복(유니폼) 100,000원*10개=1,000,000원', amount: 1000000, note: '예산 1인당 분배 금지' },
  { category: '활동운영비', name: '수업 자료 구입비', basis: '체육대회 연계 종목 연구용 자료 및 교구 구입 200,000*1회=200,000원', amount: 200000, note: '' },
  { category: '활동운영비', name: '강사수당', basis: '강의수당 300,000원*2명=600,000원', amount: 600000, note: '' },
  { category: '활동운영비', name: '시설 사용료', basis: '시설사용료 100,000원*4회 = 500,000원', amount: 400000, note: '' },
  {
    category: COUNCIL_CATEGORY, name: '간담회 등',
    basis: '2026. 4월 1차 협의회 간담회비 20,000원*10명=200,000원\n2026. 6월 2차 협의회 간담회비 20,000원*10명=200,000원\n2026. 9월 3차 협의회 간담회비 20,000원*10명=300,000원',
    amount: 700000, note: '20% 이내'
  },
];

/* ---------- utils ---------- */
const $ = (s, el = document) => el.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const won = n => (Number(n) || 0).toLocaleString('ko-KR');
const parseNum = s => Number(String(s ?? '').replace(/[^\d]/g, '')) || 0;
const sum = arr => arr.reduce((a, b) => a + (Number(b) || 0), 0);
const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const barClass = p => (p > 100 ? 'over' : p >= 90 ? 'warn' : '');

/* ---------- state ---------- */
let state = { groups: [], selectedId: localStorage.getItem(SEL_KEY) || null };
const ui = { filterItem: 'all', q: '' };
let user = null;
let unsubGroups = null;

const groupsCol = () => collection(db, 'users', user.uid, 'groups');
const groupDoc = id => doc(db, 'users', user.uid, 'groups', id);
const plain = o => JSON.parse(JSON.stringify(o));

function saveSelection() {
  localStorage.setItem(SEL_KEY, state.selectedId || '');
}

// 현재 선택된 연구회를 Firestore에 저장
function save() {
  saveSelection();
  const g = current();
  if (!g || !user) return;
  setDoc(groupDoc(g.id), plain(g)).catch(onDbError);
}

function removeGroup(id) {
  if (!user) return;
  deleteDoc(groupDoc(id)).catch(onDbError);
}

function onDbError(err) {
  console.error(err);
  toast(err.code === 'permission-denied' ? '저장 권한이 없습니다 (보안 규칙 확인)' : '저장 중 오류가 발생했습니다');
}

function createGroup({ name, leader, year, memo }, useTemplate) {
  return {
    id: uid(), name, leader, year, memo,
    createdAt: Date.now(),
    items: useTemplate ? TEMPLATE_ITEMS.map(t => ({ ...t, id: uid() })) : [],
    expenses: [],
  };
}

const current = () => state.groups.find(g => g.id === state.selectedId) || null;

function computeStats(g) {
  const total = sum(g.items.map(i => i.amount));
  const spentByItem = {};
  g.expenses.forEach(e => { spentByItem[e.itemId] = (spentByItem[e.itemId] || 0) + Number(e.amount); });
  const spent = sum(g.expenses.map(e => e.amount));
  const councilItems = g.items.filter(i => i.category === COUNCIL_CATEGORY);
  const councilPlan = sum(councilItems.map(i => i.amount));
  const councilSpent = sum(councilItems.map(i => spentByItem[i.id] || 0));
  const colorOf = {};
  g.items.forEach((it, idx) => { colorOf[it.id] = COLORS[idx % COLORS.length]; });
  return { total, spent, remain: total - spent, rate: pct(spent, total), spentByItem, councilPlan, councilSpent, colorOf };
}

/* ---------- render ---------- */
function render() {
  renderSidebar();
  renderMain();
}

function renderSidebar() {
  const list = $('#group-list');
  if (!state.groups.length) {
    list.innerHTML = `<li class="muted" style="padding:10px 6px;font-size:12.5px">아직 등록된 연구회가 없습니다.</li>`;
    return;
  }
  list.innerHTML = state.groups.map(g => {
    const s = computeStats(g);
    return `
      <li class="group-item ${g.id === state.selectedId ? 'active' : ''}" data-id="${g.id}">
        <div class="gi-name">${esc(g.name)}</div>
        <div class="bar ${barClass(s.rate)}"><span style="width:${Math.min(s.rate, 100)}%"></span></div>
        <div class="gi-meta"><span>잔액 ${won(s.remain)}원</span><span>${s.rate.toFixed(0)}%</span></div>
      </li>`;
  }).join('');
}

function renderMain() {
  const main = $('#main');
  const g = current();
  if (!g) {
    main.innerHTML = `
      <section class="hero-empty">
        <div class="logo" style="margin:0 auto;width:64px;height:64px;font-size:30px;border-radius:20px">₩</div>
        <h1>연구회 운영비를 한눈에</h1>
        <p>연구회를 추가하고 예산 항목별로 사용 내역을 기록하세요. 사용액과 잔액이 자동으로 계산됩니다.</p>
        <div><button class="btn btn-primary" data-action="add-group">＋ 첫 연구회 추가하기</button></div>
      </section>`;
    return;
  }

  const s = computeStats(g);
  main.innerHTML = `
    <header class="main-head">
      <div>
        <div class="eyebrow">
          ${g.year ? `<span class="chip">${esc(g.year)}학년도</span>` : ''}
          ${g.leader ? `<span class="chip">대표 ${esc(g.leader)}</span>` : ''}
        </div>
        <h1>${esc(g.name)}</h1>
        ${g.memo ? `<p class="head-memo">${esc(g.memo)}</p>` : ''}
      </div>
      <div class="head-actions">
        <button class="btn btn-sm" data-action="export-csv">⤓ 엑셀(CSV)</button>
        <button class="btn btn-sm" data-action="print">🖨 인쇄</button>
        <button class="btn btn-sm" data-action="edit-group">✎ 정보 수정</button>
        <button class="btn btn-sm btn-danger" data-action="delete-group">삭제</button>
      </div>
    </header>

    ${renderStats(s, g)}
    ${renderAlerts(s, g)}

    <section class="grid-2">
      ${renderItemsCard(g, s)}
      ${renderChartCard(g, s)}
    </section>

    ${renderExpensesCard(g, s)}
  `;
}

function renderStats(s, g) {
  return `
    <section class="stats">
      <article class="card stat s-total">
        <div class="label"><i></i>총 예산</div>
        <div class="value">${won(s.total)}<small>원</small></div>
        <div class="sub">예산 항목 ${g.items.length}개</div>
      </article>
      <article class="card stat s-spent">
        <div class="label"><i></i>사용액</div>
        <div class="value">${won(s.spent)}<small>원</small></div>
        <div class="sub">사용 내역 ${g.expenses.length}건</div>
      </article>
      <article class="card stat s-remain">
        <div class="label"><i></i>잔액</div>
        <div class="value ${s.remain < 0 ? 'neg' : ''}">${won(s.remain)}<small>원</small></div>
        <div class="sub">${s.remain < 0 ? '예산을 초과했습니다' : '사용 가능한 금액'}</div>
      </article>
      <article class="card stat s-rate">
        <div class="label"><i></i>집행률</div>
        <div class="value">${s.rate.toFixed(1)}<small>%</small></div>
        <div class="bar ${barClass(s.rate)}"><span style="width:${Math.min(s.rate, 100)}%"></span></div>
      </article>
    </section>`;
}

function renderAlerts(s, g) {
  const alerts = [];
  if (s.total > 0 && s.councilPlan / s.total > COUNCIL_LIMIT + 1e-9) {
    alerts.push(`<div class="alert">⚠️ <span>협의회비 계획액(${won(s.councilPlan)}원)이 총 예산의 <b>${pct(s.councilPlan, s.total).toFixed(1)}%</b>로, 기준(20% 이내)을 초과합니다.</span></div>`);
  }
  if (s.total > 0 && s.councilSpent / s.total > COUNCIL_LIMIT + 1e-9) {
    alerts.push(`<div class="alert danger">⛔ <span>협의회비 사용액(${won(s.councilSpent)}원)이 총 예산의 20%를 초과했습니다.</span></div>`);
  }
  const overs = g.items.filter(i => (s.spentByItem[i.id] || 0) > i.amount);
  if (overs.length) {
    alerts.push(`<div class="alert danger">⛔ <span>예산 초과 항목: ${overs.map(i => `<b>${esc(i.name)}</b> (${won((s.spentByItem[i.id] || 0) - i.amount)}원 초과)`).join(', ')}</span></div>`);
  }
  return alerts.length ? `<section class="alerts">${alerts.join('')}</section>` : '';
}

function renderItemsCard(g, s) {
  const cats = [...new Set(g.items.map(i => i.category || '기타'))];
  let rows = '';
  cats.forEach(cat => {
    const items = g.items.filter(i => (i.category || '기타') === cat);
    const catPlan = sum(items.map(i => i.amount));
    const catSpent = sum(items.map(i => s.spentByItem[i.id] || 0));
    rows += `<tr class="cat-row"><td colspan="6">${esc(cat)}<span class="cat-sum">${won(catSpent)} / ${won(catPlan)}원</span></td></tr>`;
    items.forEach(it => {
      const used = s.spentByItem[it.id] || 0;
      const remain = it.amount - used;
      const p = pct(used, it.amount);
      rows += `
        <tr>
          <td>
            <div class="item-name"><span class="dot" style="background:${s.colorOf[it.id]}"></span>${esc(it.name)}</div>
            ${it.basis ? `<div class="item-basis">${esc(it.basis)}</div>` : ''}
            ${it.note ? `<span class="item-note">${esc(it.note)}</span>` : ''}
          </td>
          <td class="num">${won(it.amount)}</td>
          <td class="num">${won(used)}</td>
          <td class="num ${remain < 0 ? 'neg' : remain === 0 ? 'muted' : 'pos'}">${won(remain)}</td>
          <td class="prog-cell">
            <div class="bar ${barClass(p)}"><span style="width:${Math.min(p, 100)}%"></span></div>
            <div class="pct">${p.toFixed(0)}%</div>
          </td>
          <td>
            <div class="row-actions">
              <button class="icon-btn" title="이 항목으로 사용 내역 추가" data-action="add-expense" data-item="${it.id}">＋</button>
              <button class="icon-btn" title="수정" data-action="edit-item" data-id="${it.id}">✎</button>
              <button class="icon-btn danger" title="삭제" data-action="delete-item" data-id="${it.id}">🗑</button>
            </div>
          </td>
        </tr>`;
    });
  });

  return `
    <article class="card">
      <div class="card-head">
        <h2>항목별 예산 집행 현황 <span class="count">${g.items.length}개 항목</span></h2>
        <button class="btn btn-sm" data-action="add-item">＋ 예산 항목 추가</button>
      </div>
      ${g.items.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>항목 / 산출기초</th><th class="num">예산</th><th class="num">사용액</th><th class="num">잔액</th><th>집행률</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr>
            <td>계</td>
            <td class="num">${won(s.total)}</td>
            <td class="num">${won(s.spent)}</td>
            <td class="num ${s.remain < 0 ? 'neg' : 'pos'}">${won(s.remain)}</td>
            <td class="num">${s.rate.toFixed(1)}%</td><td></td>
          </tr></tfoot>
        </table>
      </div>` : `
      <div class="empty">
        <div class="em-icon">📋</div>
        <p>예산 항목이 없습니다.</p>
        <p style="margin-top:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" data-action="add-item">＋ 항목 추가</button>
          <button class="btn btn-sm" data-action="apply-template">사용 계획 템플릿 불러오기</button>
        </p>
      </div>`}
    </article>`;
}

function renderChartCard(g, s) {
  const R = 80, C = 2 * Math.PI * R;
  let offset = 0;
  const base = Math.max(s.total, s.spent) || 1;
  const segs = g.items.map(it => {
    const used = s.spentByItem[it.id] || 0;
    const len = (used / base) * C;
    const seg = `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${s.colorOf[it.id]}" stroke-width="20"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" stroke-linecap="butt"></circle>`;
    offset += len;
    return used > 0 ? seg : '';
  }).join('');

  const councilPlanPct = pct(s.councilPlan, s.total);
  const councilSpentPct = pct(s.councilSpent, s.total);

  return `
    <article class="card">
      <div class="card-head"><h2>집행 구성</h2></div>
      <div class="donut-wrap">
        <svg viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="${R}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="20"></circle>
          ${segs}
        </svg>
        <div class="donut-center">
          <div class="big">${s.rate.toFixed(0)}%</div>
          <div class="small">집행률</div>
        </div>
      </div>
      <ul class="legend">
        ${g.items.map(it => `
          <li>
            <span class="dot" style="background:${s.colorOf[it.id]}"></span>
            <span class="lg-name" title="${esc(it.name)}">${esc(it.name)}</span>
            <span class="lg-val">${won(s.spentByItem[it.id] || 0)} / ${won(it.amount)}</span>
          </li>`).join('') || '<li class="muted">항목을 추가하세요</li>'}
      </ul>
      <div class="ratio-box">
        <div class="rb-head"><span>협의회비 비율 (기준 20% 이내)</span><b class="${councilPlanPct > 20 ? 'neg' : ''}">${councilPlanPct.toFixed(1)}%</b></div>
        <div class="ratio-track">
          <div class="bar ${councilPlanPct > 20 ? 'over' : ''}" style="height:8px"><span style="width:${Math.min(councilPlanPct, 100)}%"></span></div>
          <div class="ratio-limit" style="left:20%"></div>
        </div>
        <div class="rb-foot">계획 ${won(s.councilPlan)}원 · 사용 ${won(s.councilSpent)}원 (${councilSpentPct.toFixed(1)}%)</div>
      </div>
    </article>`;
}

function renderExpensesCard(g, s) {
  const itemMap = Object.fromEntries(g.items.map(i => [i.id, i]));
  const q = ui.q.trim().toLowerCase();
  if (ui.filterItem !== 'all' && !itemMap[ui.filterItem]) ui.filterItem = 'all';
  const list = g.expenses
    .filter(e => ui.filterItem === 'all' || e.itemId === ui.filterItem)
    .filter(e => !q || [e.description, e.vendor, e.memo, itemMap[e.itemId]?.name].some(v => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);

  const rows = list.map(e => {
    const it = itemMap[e.itemId];
    return `
      <tr>
        <td style="white-space:nowrap">${esc(e.date)}</td>
        <td>${it ? `<span class="tag"><span class="dot" style="background:${s.colorOf[it.id]}"></span>${esc(it.name)}</span>` : '<span class="muted">(삭제된 항목)</span>'}</td>
        <td>
          <div style="font-weight:600">${esc(e.description)}</div>
          ${e.memo ? `<div class="item-basis">${esc(e.memo)}</div>` : ''}
        </td>
        <td>${esc(e.vendor) || '<span class="muted">-</span>'}</td>
        <td><span class="pay">${esc(e.method || '')}</span></td>
        <td class="num" style="font-weight:700">${won(e.amount)}원</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn" title="수정" data-action="edit-expense" data-id="${e.id}">✎</button>
            <button class="icon-btn danger" title="삭제" data-action="delete-expense" data-id="${e.id}">🗑</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  return `
    <section class="card" id="expenses-card">
      <div class="card-head">
        <h2>사용 내역 <span class="count">${list.length}건 · ${won(sum(list.map(e => e.amount)))}원</span></h2>
        <div class="toolbar">
          <select class="select" id="filter-item" aria-label="항목 필터">
            <option value="all">전체 항목</option>
            ${g.items.map(i => `<option value="${i.id}" ${ui.filterItem === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
          </select>
          <input class="input search" id="search" type="search" placeholder="내용·사용처 검색" value="${esc(ui.q)}">
          <button class="btn btn-primary btn-sm" data-action="add-expense" id="btn-add-expense">＋ 사용 내역 추가</button>
        </div>
      </div>
      ${list.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>사용일</th><th>항목</th><th>내용</th><th>사용처</th><th>결제</th><th class="num">금액</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : `
      <div class="empty">
        <div class="em-icon">🧾</div>
        <p>${g.expenses.length ? '조건에 맞는 사용 내역이 없습니다.' : '아직 사용 내역이 없습니다. 지출이 생기면 기록해 보세요.'}</p>
      </div>`}
    </section>`;
}

/* ---------- modal ---------- */
let modalSubmit = null;

function openModal({ title, body, submitText = '저장', danger = false, onSubmit, onOpen }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  const btn = $('#modal-submit');
  btn.textContent = submitText;
  btn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  modalSubmit = onSubmit;
  $('#modal').hidden = false;
  onOpen && onOpen($('#modal-body'));
  const first = $('#modal-body input:not([type=radio]), #modal-body select, #modal-body textarea');
  setTimeout(() => (first ? first.focus() : btn.focus()), 30);
}

function closeModal() {
  $('#modal').hidden = true;
  modalSubmit = null;
}

function confirmModal(title, html, onOk, okText = '삭제') {
  openModal({ title, body: `<p class="confirm-text">${html}</p>`, submitText: okText, danger: true, onSubmit: () => { onOk(); } });
}

$('#modal-form').addEventListener('submit', e => {
  e.preventDefault();
  if (!modalSubmit) return closeModal();
  const data = Object.fromEntries(new FormData(e.target).entries());
  const keepOpen = modalSubmit(data) === false;
  if (!keepOpen) closeModal();
});
$('#modal-close').onclick = closeModal;
$('#modal-cancel').onclick = closeModal;
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

// 금액 입력란 자동 콤마
document.addEventListener('input', e => {
  if (e.target.classList.contains('money')) {
    const n = parseNum(e.target.value);
    e.target.value = n ? won(n) : '';
  }
});

function moneyField(name, label, value, required = true) {
  return `
    <div class="field">
      <label for="f-${name}">${label}${required ? ' <span class="req">*</span>' : ''}</label>
      <div class="money-wrap"><input class="input money" id="f-${name}" name="${name}" inputmode="numeric" value="${value ? won(value) : ''}" ${required ? 'required' : ''} placeholder="0"></div>
    </div>`;
}

/* ---------- group CRUD ---------- */
function groupForm(g) {
  const isNew = !g;
  g = g || { name: '', leader: '', year: new Date().getFullYear(), memo: '' };
  return `
    <div class="field">
      <label for="f-name">연구회 이름 <span class="req">*</span></label>
      <input class="input" id="f-name" name="name" value="${esc(g.name)}" required maxlength="60" placeholder="예) 체육교육 연구회">
    </div>
    <div class="field-row">
      <div class="field"><label for="f-leader">대표(담당) 교사</label><input class="input" id="f-leader" name="leader" value="${esc(g.leader)}" placeholder="홍길동"></div>
      <div class="field"><label for="f-year">학년도</label><input class="input" id="f-year" name="year" type="number" value="${esc(g.year)}" min="2000" max="2100"></div>
    </div>
    <div class="field"><label for="f-memo">메모</label><textarea class="input" id="f-memo" name="memo" rows="2" placeholder="연구 주제, 회원 수 등">${esc(g.memo)}</textarea></div>
    ${isNew ? `
    <div class="field">
      <label>예산 항목 구성</label>
      <div class="radio-cards">
        <label class="radio-card"><input type="radio" name="template" value="yes" checked>
          <div><b>운영비 사용 계획 템플릿 사용</b><span>활동운영비 5개 + 협의회비 1개 항목 · 총 ${won(sum(TEMPLATE_ITEMS.map(t => t.amount)))}원 (추후 수정 가능)</span></div></label>
        <label class="radio-card"><input type="radio" name="template" value="no">
          <div><b>빈 상태로 시작</b><span>예산 항목을 직접 추가합니다</span></div></label>
      </div>
    </div>` : ''}`;
}

function addGroup() {
  openModal({
    title: '새 연구회 추가',
    body: groupForm(),
    submitText: '추가',
    onSubmit: d => {
      if (!d.name.trim()) return false;
      const g = createGroup({ name: d.name.trim(), leader: d.leader.trim(), year: d.year, memo: d.memo.trim() }, d.template === 'yes');
      state.groups.push(g);
      state.selectedId = g.id;
      ui.filterItem = 'all'; ui.q = '';
      save(); render(); toast(`'${g.name}' 연구회가 추가되었습니다`);
    },
  });
}

function editGroup() {
  const g = current();
  openModal({
    title: '연구회 정보 수정',
    body: groupForm(g),
    onSubmit: d => {
      if (!d.name.trim()) return false;
      Object.assign(current(), { name: d.name.trim(), leader: d.leader.trim(), year: d.year, memo: d.memo.trim() });
      save(); render(); toast('저장되었습니다');
    },
  });
}

function deleteGroup() {
  const g = current();
  confirmModal('연구회 삭제', `<b>${esc(g.name)}</b> 연구회와 모든 예산 항목·사용 내역(${g.expenses.length}건)이 삭제됩니다.<br>이 작업은 되돌릴 수 없습니다.`, () => {
    state.groups = state.groups.filter(x => x.id !== g.id);
    state.selectedId = state.groups[0]?.id || null;
    removeGroup(g.id); saveSelection(); render(); toast('삭제되었습니다');
  });
}

/* ---------- item CRUD ---------- */
function itemForm(it = {}) {
  const g = current();
  const cats = [...new Set(['활동운영비', COUNCIL_CATEGORY, ...g.items.map(i => i.category)])];
  return `
    <div class="field-row">
      <div class="field">
        <label for="f-category">구분 <span class="req">*</span></label>
        <input class="input" id="f-category" name="category" list="cat-list" value="${esc(it.category || '활동운영비')}" required>
        <datalist id="cat-list">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      </div>
      <div class="field">
        <label for="f-iname">항목 <span class="req">*</span></label>
        <input class="input" id="f-iname" name="name" value="${esc(it.name || '')}" required placeholder="예) 물품구입비">
      </div>
    </div>
    <div class="field"><label for="f-basis">산출기초</label><textarea class="input" id="f-basis" name="basis" rows="3" placeholder="예) 활동복 100,000원*10개=1,000,000원">${esc(it.basis || '')}</textarea></div>
    ${moneyField('amount', '예산 금액', it.amount)}
    <div class="field"><label for="f-note">비고</label><input class="input" id="f-note" name="note" value="${esc(it.note || '')}" placeholder="예) 예산 1인당 분배 금지"></div>`;
}

function addItem() {
  openModal({
    title: '예산 항목 추가',
    body: itemForm(),
    submitText: '추가',
    onSubmit: d => {
      const g = current();
      g.items.push({ id: uid(), category: d.category.trim(), name: d.name.trim(), basis: d.basis.trim(), amount: parseNum(d.amount), note: d.note.trim() });
      save(); render(); toast('예산 항목이 추가되었습니다');
    },
  });
}

function editItem(id) {
  const g = current();
  const it = g.items.find(i => i.id === id);
  openModal({
    title: '예산 항목 수정',
    body: itemForm(it),
    onSubmit: d => {
      const it = current()?.items.find(i => i.id === id);
      if (!it) return;
      Object.assign(it, { category: d.category.trim(), name: d.name.trim(), basis: d.basis.trim(), amount: parseNum(d.amount), note: d.note.trim() });
      save(); render(); toast('저장되었습니다');
    },
  });
}

function deleteItem(id) {
  const g = current();
  const it = g.items.find(i => i.id === id);
  const linked = g.expenses.filter(e => e.itemId === id).length;
  confirmModal('예산 항목 삭제',
    `<b>${esc(it.name)}</b> 항목을 삭제할까요?` + (linked ? `<br>이 항목에 연결된 사용 내역 <b>${linked}건</b>도 함께 삭제됩니다.` : ''),
    () => {
      const g = current();
      g.items = g.items.filter(i => i.id !== id);
      g.expenses = g.expenses.filter(e => e.itemId !== id);
      save(); render(); toast('삭제되었습니다');
    });
}

function applyTemplate() {
  const g = current();
  g.items.push(...TEMPLATE_ITEMS.map(t => ({ ...t, id: uid() })));
  save(); render(); toast('템플릿 항목을 불러왔습니다');
}

/* ---------- expense CRUD ---------- */
function expenseForm(e = {}, presetItem) {
  const g = current();
  const s = computeStats(g);
  const sel = e.itemId || presetItem || (ui.filterItem !== 'all' ? ui.filterItem : g.items[0]?.id);
  const cats = [...new Set(g.items.map(i => i.category || '기타'))];
  const options = cats.map(c => `
    <optgroup label="${esc(c)}">
      ${g.items.filter(i => (i.category || '기타') === c).map(i =>
        `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)} (잔액 ${won(i.amount - (s.spentByItem[i.id] || 0))}원)</option>`).join('')}
    </optgroup>`).join('');
  return `
    <div class="field-row">
      <div class="field"><label for="f-date">사용일 <span class="req">*</span></label><input class="input" id="f-date" name="date" type="date" value="${esc(e.date || today())}" required></div>
      <div class="field"><label for="f-item">예산 항목 <span class="req">*</span></label><select class="select" id="f-item" name="itemId" required>${options}</select></div>
    </div>
    <div class="field"><label for="f-desc">사용 내용 <span class="req">*</span></label><input class="input" id="f-desc" name="description" value="${esc(e.description || '')}" required placeholder="예) 1차 협의회 간담회비"></div>
    <div class="field-row">
      ${moneyField('amount', '금액', e.amount)}
      <div class="field"><label for="f-method">결제 방법</label>
        <select class="select" id="f-method" name="method">${PAY_METHODS.map(m => `<option ${m === (e.method || '카드') ? 'selected' : ''}>${m}</option>`).join('')}</select>
      </div>
    </div>
    <div id="amount-hint" class="hint"></div>
    <div class="field"><label for="f-vendor">사용처</label><input class="input" id="f-vendor" name="vendor" value="${esc(e.vendor || '')}" placeholder="예) ○○식당, ○○스포츠"></div>
    <div class="field"><label for="f-emo">메모</label><textarea class="input" id="f-emo" name="memo" rows="2" placeholder="참석 인원, 영수증 번호 등">${esc(e.memo || '')}</textarea></div>`;
}

function bindExpenseHint(body, editingId) {
  const g = current();
  const update = () => {
    const s = computeStats(g);
    const itemId = $('#f-item', body).value;
    const it = g.items.find(i => i.id === itemId);
    if (!it) return;
    const prev = editingId ? Number(g.expenses.find(x => x.id === editingId)?.itemId === itemId ? g.expenses.find(x => x.id === editingId).amount : 0) : 0;
    const used = (s.spentByItem[itemId] || 0) - prev;
    const amt = parseNum($('#f-amount', body).value);
    const after = it.amount - used - amt;
    const hint = $('#amount-hint', body);
    let msg = `항목 예산 ${won(it.amount)}원 · 현재 잔액 ${won(it.amount - used)}원 → 저장 후 잔액 <b>${won(after)}원</b>`;
    hint.className = 'hint';
    if (after < 0) { hint.className = 'hint danger'; msg += ' (예산 초과)'; }
    if (it.category === COUNCIL_CATEGORY && s.total > 0) {
      const cAfter = s.councilSpent - prev + amt;
      if (cAfter > s.total * COUNCIL_LIMIT) { hint.className = 'hint warn'; msg += `<br>⚠️ 협의회비 사용액이 총 예산의 20%(${won(s.total * COUNCIL_LIMIT)}원)를 넘습니다.`; }
    }
    hint.innerHTML = msg;
  };
  $('#f-item', body).addEventListener('change', update);
  $('#f-amount', body).addEventListener('input', update);
  update();
}

function addExpense(presetItem) {
  const g = current();
  if (!g.items.length) { toast('먼저 예산 항목을 추가하세요'); return; }
  openModal({
    title: '사용 내역 추가',
    body: expenseForm({}, presetItem),
    submitText: '추가',
    onOpen: body => bindExpenseHint(body),
    onSubmit: d => {
      const amount = parseNum(d.amount);
      if (!amount) { toast('금액을 입력하세요'); return false; }
      current().expenses.push({ id: uid(), createdAt: Date.now(), date: d.date, itemId: d.itemId, description: d.description.trim(), amount, method: d.method, vendor: d.vendor.trim(), memo: d.memo.trim() });
      save(); render(); toast(`${won(amount)}원 사용 내역이 추가되었습니다`);
    },
  });
}

function editExpense(id) {
  const g = current();
  const e = g.expenses.find(x => x.id === id);
  openModal({
    title: '사용 내역 수정',
    body: expenseForm(e),
    onOpen: body => bindExpenseHint(body, id),
    onSubmit: d => {
      const amount = parseNum(d.amount);
      if (!amount) { toast('금액을 입력하세요'); return false; }
      const e = current()?.expenses.find(x => x.id === id);
      if (!e) return;
      Object.assign(e, { date: d.date, itemId: d.itemId, description: d.description.trim(), amount, method: d.method, vendor: d.vendor.trim(), memo: d.memo.trim() });
      save(); render(); toast('저장되었습니다');
    },
  });
}

function deleteExpense(id) {
  const g = current();
  const e = g.expenses.find(x => x.id === id);
  confirmModal('사용 내역 삭제', `<b>${esc(e.date)} · ${esc(e.description)}</b> (${won(e.amount)}원) 내역을 삭제할까요?`, () => {
    const g = current();
    g.expenses = g.expenses.filter(x => x.id !== id);
    save(); render(); toast('삭제되었습니다');
  });
}

/* ---------- export / import ---------- */
function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportCSV() {
  const g = current();
  const s = computeStats(g);
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [];
  lines.push([q(g.name), q(`${g.year || ''}학년도`), q(`대표 ${g.leader || ''}`)].join(','));
  lines.push('');
  lines.push('[예산 집행 현황]');
  lines.push(['구분', '항목', '산출기초', '예산', '사용액', '잔액', '집행률(%)', '비고'].map(q).join(','));
  g.items.forEach(i => {
    const used = s.spentByItem[i.id] || 0;
    lines.push([i.category, i.name, i.basis, i.amount, used, i.amount - used, pct(used, i.amount).toFixed(1), i.note].map(q).join(','));
  });
  lines.push(['계', '', '', s.total, s.spent, s.remain, s.rate.toFixed(1), ''].map(q).join(','));
  lines.push('');
  lines.push('[사용 내역]');
  lines.push(['사용일', '구분', '항목', '내용', '사용처', '결제방법', '금액', '메모'].map(q).join(','));
  const itemMap = Object.fromEntries(g.items.map(i => [i.id, i]));
  [...g.expenses].sort((a, b) => (a.date || '').localeCompare(b.date || '')).forEach(e => {
    const it = itemMap[e.itemId] || {};
    lines.push([e.date, it.category, it.name, e.description, e.vendor, e.method, e.amount, e.memo].map(q).join(','));
  });
  download(`${g.name}_운영비_${today()}.csv`, '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  toast('CSV 파일을 저장했습니다 (엑셀에서 열 수 있어요)');
}

function exportJSON() {
  download(`EduBudget_백업_${today()}.json`, JSON.stringify(state, null, 2), 'application/json');
  toast('전체 데이터를 백업했습니다');
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      if (!d || !Array.isArray(d.groups)) throw new Error('invalid');
      confirmModal('백업 복원', `백업 파일의 연구회 <b>${d.groups.length}개</b>로 현재 데이터를 <b>덮어씁니다</b>. 계속할까요?`, async () => {
        try {
          const batch = writeBatch(db);
          const existing = await getDocs(groupsCol());
          existing.forEach(s => batch.delete(s.ref));
          d.groups.forEach(g => {
            const id = g.id || uid();
            batch.set(groupDoc(id), plain({ ...g, id, items: g.items || [], expenses: g.expenses || [], createdAt: g.createdAt || Date.now() }));
          });
          await batch.commit();
          state.selectedId = d.selectedId || d.groups[0]?.id || null;
          saveSelection(); toast('복원되었습니다');
        } catch (err) { onDbError(err); }
      }, '복원');
    } catch (e) {
      toast('올바른 백업 파일이 아닙니다');
    }
  };
  reader.readAsText(file);
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- events ---------- */
$('#btn-add-group').onclick = addGroup;
$('#btn-export-json').onclick = exportJSON;
$('#btn-import-json').onclick = () => $('#file-import').click();
$('#file-import').onchange = e => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; };

$('#group-list').addEventListener('click', e => {
  const li = e.target.closest('.group-item');
  if (!li) return;
  state.selectedId = li.dataset.id;
  ui.filterItem = 'all'; ui.q = '';
  saveSelection(); render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

$('#main').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id, item } = btn.dataset;
  const actions = {
    'add-group': addGroup,
    'edit-group': editGroup,
    'delete-group': deleteGroup,
    'add-item': addItem,
    'edit-item': () => editItem(id),
    'delete-item': () => deleteItem(id),
    'apply-template': applyTemplate,
    'add-expense': () => addExpense(item),
    'edit-expense': () => editExpense(id),
    'delete-expense': () => deleteExpense(id),
    'export-csv': exportCSV,
    'print': () => window.print(),
  };
  actions[action] && actions[action]();
});

$('#main').addEventListener('change', e => {
  if (e.target.id === 'filter-item') { ui.filterItem = e.target.value; refreshExpenses(); }
});

function refreshExpenses() {
  const g = current();
  const tmp = document.createElement('div');
  tmp.innerHTML = renderExpensesCard(g, computeStats(g));
  const node = tmp.firstElementChild;
  node.style.animation = 'none';
  $('#expenses-card').replaceWith(node);
}

$('#main').addEventListener('input', e => {
  if (e.target.id === 'search') {
    ui.q = e.target.value;
    const pos = e.target.selectionStart;
    refreshExpenses();
    const s = $('#search');
    s.focus();
    s.setSelectionRange(pos, pos);
  }
});

/* ---------- auth & sync ---------- */
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

async function login() {
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);
    } else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      console.error(err);
      toast(err.code === 'auth/unauthorized-domain' ? '이 도메인이 Firebase 승인 도메인에 등록되지 않았습니다' : `로그인에 실패했습니다 (${err.code || err.message})`);
    }
  }
}

function setScreen(name) {
  document.body.dataset.screen = name; // loading | auth | app
}

function renderUser() {
  $('#user-box').innerHTML = user ? `
    ${user.photoURL ? `<img src="${esc(user.photoURL)}" alt="" referrerpolicy="no-referrer">` : `<div class="avatar">${esc((user.displayName || user.email || '?')[0])}</div>`}
    <div class="ub-text"><b>${esc(user.displayName || '사용자')}</b><small>${esc(user.email || '')}</small></div>
    <button class="icon-btn" id="btn-logout" title="로그아웃" aria-label="로그아웃">⎋</button>` : '';
}

$('#btn-login').onclick = login;
$('#user-box').addEventListener('click', e => {
  if (e.target.closest('#btn-logout')) {
    confirmModal('로그아웃', '로그아웃 할까요?', () => signOut(auth), '로그아웃');
  }
});

onAuthStateChanged(auth, u => {
  user = u;
  if (unsubGroups) { unsubGroups(); unsubGroups = null; }
  renderUser();
  if (!u) {
    state.groups = [];
    setScreen('auth');
    return;
  }
  setScreen('loading');
  unsubGroups = onSnapshot(groupsCol(), snap => {
    state.groups = snap.docs
      .map(d => ({ items: [], expenses: [], ...d.data(), id: d.id }))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (!state.groups.some(g => g.id === state.selectedId)) state.selectedId = state.groups[0]?.id || null;
    setScreen('app');
    const searching = document.activeElement?.id === 'search';
    const pos = searching ? document.activeElement.selectionStart : 0;
    render();
    if (searching && $('#search')) { $('#search').focus(); $('#search').setSelectionRange(pos, pos); }
  }, err => {
    onDbError(err);
    setScreen('app');
    render();
  });
});
