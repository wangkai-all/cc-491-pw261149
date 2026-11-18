// TraceLink front-end. No framework, no build step: the whole console is one
// module so that the exported graph and the on-screen graph come from the same
// projection.

const state = {
  user: null,
  meta: null,
  window: null,
  edges: {
    shared_device: true,
    ip_overlap: true,
    merchant_link: true,
    amount_flow: true,
    manual_link: false,
  },
  minStrength: 0,
  hops: 2,
  seeds: [],
  graph: null,
  selected: null, // {type, id}
  selectedEdge: null,
  inspectorTab: 'overview',
  searches: [],
  trace: null,
  path: null,
  busy: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === false) node.removeAttribute(k);
    // `el('input', { value })` must set the live value, not only the default
    // attribute, or later reads (e.g. the path dialog's start id) see ''.
    // Only `value` needs this: routing other keys through the property would
    // turn `checked: null` into `checked = false` and silently uncheck a box
    // that is meant to start checked. Attributes with no matching property
    // (data-*, maxlength, aria-*) keep going through setAttribute.
    else if (k === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select') && v !== undefined && v !== null) node.value = v;
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TYPE_COLOR = { account: '#3987e5', device: '#d95926', merchant: '#199e70' };
const TYPE_LABEL = { account: '账户', device: '设备', merchant: '商户' };
const EDGE_LABEL = {
  shared_device: '共用设备', ip_overlap: 'IP 重合', merchant_link: '商户关联', amount_flow: '资金流向', manual_link: '人工关联',
};
const EDGE_DASH = { shared_device: '', ip_overlap: '1 4', merchant_link: '7 4', amount_flow: '', manual_link: '2 3' };
const LABEL_LABEL = { confirmed_fraud: '已确认欺诈', suspicious: '可疑', legitimate: '正常', watchlist: '关注名单' };
const REVIEW_LABEL = { pending: '待复核', approved: '已复核通过', rejected: '已驳回', revoked: '已撤销', 'n/a': '不适用' };

function fmtEUR(cents) { return cny(cents); }
function cny(cents) {
  if (cents == null) return '—';
  const n = cents / 100;
  if (Math.abs(n) >= 1e8) return `¥${(n / 1e8).toFixed(2)} 亿`;
  if (Math.abs(n) >= 1e4) return `¥${(n / 1e4).toFixed(1)} 万`;
  return `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
}
function compact(n) {
  if (n == null) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)}K`;
  return String(n);
}
function fmtTime(iso, opts = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  if (opts.dateOnly) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function relTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`;
  return `${Math.round(diff / 86400)} 天前`;
}
function pct(v) { return `${Math.round((v || 0) * 100)}%`; }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    state.user = null;
    state.demoUsers = null;
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then(r => r.json()).catch(() => null);
    state.demoUsers = me?.demo_users || [];
    renderLogin();
    throw new Error('登录已过期');
  }
  const ct = res.headers.get('content-type') || '';
  const payload = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(payload.error || `请求失败 (${res.status})`);
    err.detail = payload.detail;
    err.status = res.status;
    throw err;
  }
  return payload;
}

function toast(message, kind = '', sub = '') {
  const host = $('#toasts') || (() => { const h = el('div', { id: 'toasts', class: 'toast-host' }); document.body.append(h); return h; })();
  const t = el('div', { class: `toast ${kind}` }, [el('div', {}, message), sub ? el('div', { class: 't2' }, sub) : null]);
  host.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .2s'; setTimeout(() => t.remove(), 220); }, 4200);
}

function withBusy(fn) {
  return async (...args) => {
    if (state.busy) return;
    state.busy = true;
    try { return await fn(...args); } finally { state.busy = false; }
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const me = await api('/api/auth/me');
    if (me.user) {
      state.user = me.user;
      await enterApp();
    } else {
      state.demoUsers = me.demo_users;
      renderLogin();
    }
  } catch {
    renderLogin();
  }
}

function renderLogin() {
  const app = $('#app');
  app.innerHTML = '';
  const demos = state.demoUsers || [];
  const wrap = el('div', { class: 'login-shell' }, [
    el('div', { class: 'login-hero' }, [
      el('div', { class: 'login-brand' }, [
        el('div', { class: 'brand-mark' }, 'TL'),
        el('div', {}, [el('strong', {}, 'TraceLink'), el('span', {}, '交易关系调查台 · 26.11')]),
      ]),
      el('div', { class: 'login-pitch' }, [
        el('h1', { html: '把账户、设备、商户与交易<br>还原成一张可追溯的图。' }),
        el('p', {}, '每一根关系边都能回到原始交易；合并与撤销只重算受影响子图；导出与页面共用同一套权限投影。'),
        el('div', { class: 'login-points' }, [
          point('证据可回溯', '边 → 日桶 → 交易 → 批次，四级链路可核对'),
          point('增量重算', '合并、撤销、迟到数据只触碰受影响节点'),
          point('权限不绕过', '导出、图谱、痕迹共用字段级策略'),
        ]),
        miniGraph(),
      ]),
      el('div', { class: 'login-foot' }, '演示环境 · 数据为合成样本 · 所有操作写入审计日志'),
    ]),
    el('div', { class: 'login-panel' }, [
      el('h2', {}, '调查员登录'),
      el('div', { class: 'sub' }, '选择演示身份，或以用户名密码登录'),
      el('div', { class: 'form-error', id: 'login-error' }),
      el('form', { onsubmit: onSubmitLogin }, [
        el('div', { class: 'field' }, [el('label', { for: 'u' }, '用户名'), el('input', { id: 'u', name: 'username', autocomplete: 'username', value: 'analyst' })]),
        el('div', { class: 'field' }, [el('label', { for: 'p' }, '密码'), el('input', { id: 'p', name: 'password', type: 'password', autocomplete: 'current-password', value: 'demo-analyst' })]),
        el('button', { class: 'btn primary wide', type: 'submit', id: 'login-btn' }, '登录'),
      ]),
      el('div', { style: 'margin:18px 0 8px;display:flex;align-items:center;gap:8px;color:var(--muted);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase' }, [
        el('span', { style: 'height:1px;flex:1;background:var(--line)' }), '演示身份', el('span', { style: 'height:1px;flex:1;background:var(--line)' }),
      ]),
      el('div', { class: 'demo-users' }, demos.map(u => el('button', {
        class: 'demo-user', type: 'button',
        onclick: () => { $('#u').value = u.username; $('#p').value = u.password; onSubmitLogin(); },
      }, [
        el('span', { class: 'dot', style: `background:${roleColor(u.role)}` }),
        el('span', {}, [el('strong', {}, u.name), el('small', {}, `${u.username} · ${u.password}`)]),
        el('span', { class: `role-tag ${u.role}` }, u.role),
      ]))),
    ]),
  ]);
  app.append(wrap);
}

function point(title, body) {
  return el('div', { class: 'login-point' }, [el('b', {}, title), el('span', {}, body)]);
}

function miniGraph() {
  const ns = [
    { x: 60, y: 60, c: '#3987e5', r: 9 }, { x: 150, y: 30, c: '#d95926', r: 6 },
    { x: 190, y: 100, c: '#3987e5', r: 7 }, { x: 300, y: 55, c: '#199e70', r: 8 },
    { x: 360, y: 118, c: '#3987e5', r: 6 }, { x: 100, y: 128, c: '#199e70', r: 5 },
    { x: 250, y: 128, c: '#d95926', r: 5 },
  ];
  const links = [[0, 1], [0, 5], [1, 2], [2, 3], [3, 4], [2, 6], [6, 4], [0, 2]];
  const svg = `<svg viewBox="0 0 420 150" width="100%" height="100%">
    ${links.map(([a, b]) => `<line x1="${ns[a].x}" y1="${ns[a].y}" x2="${ns[b].x}" y2="${ns[b].y}" stroke="rgba(255,255,255,.18)" stroke-width="1.5"/>`).join('')}
    ${ns.map(n => `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${n.c}" opacity=".9"/><circle cx="${n.x}" cy="${n.y}" r="${n.r + 4}" fill="${n.c}" opacity=".10"/>`).join('')}
  </svg>`;
  return el('div', { class: 'login-mini-graph', html: svg });
}

function roleColor(role) {
  return { admin: '#9085e9', analyst: '#3987e5', auditor: '#fab219', viewer: '#898781' }[role] || '#898781';
}

async function onSubmitLogin(e) {
  if (e) e.preventDefault();
  const btn = $('#login-btn');
  const errBox = $('#login-error');
  errBox.classList.remove('show');
  btn.disabled = true;
  btn.textContent = '验证中…';
  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('#u').value.trim(), password: $('#p').value },
    });
    state.user = res.user;
    await enterApp();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.add('show');
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  // Rebuild the login screen from the server's demo list rather than a stale
  // in-memory copy, so a role change or reseed is reflected immediately.
  state.demoUsers = null;
  state.overview = null;
  const me = await api('/api/auth/me').catch(() => null);
  state.demoUsers = me?.demo_users || [];
  renderLogin();
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

async function enterApp() {
  state.meta = await api('/api/meta');
  state.window = { ...state.meta.default_window };
  const app = $('#app');
  app.innerHTML = '';
  app.append(renderShell());
  await refreshAll();
}

function renderShell() {
  const u = state.user;
  const can = cap => u.caps.includes(cap);
  const shell = el('div', { class: 'app-shell' }, [
    el('header', { class: 'topbar' }, [
      el('div', { class: 'brand' }, [
        el('div', { class: 'brand-mark' }, 'TL'),
        el('div', {}, [el('strong', {}, 'TraceLink'), el('span', {}, '关系调查台')]),
      ]),
      el('div', { class: 'window-controls' }, [
        el('div', { class: 'seg', id: 'preset-seg' }, [
          presetBtn('24h', 1), presetBtn('7天', 7), presetBtn('30天', 30), presetBtn('全部', 0),
        ]),
        el('div', { class: 'window-inputs' }, [
          el('input', { type: 'date', id: 'win-from', onchange: onWindowChange }),
          el('span', {}, '→'),
          el('input', { type: 'date', id: 'win-to', onchange: onWindowChange }),
        ]),
      ]),
      el('div', { class: 'spacer' }),
      el('div', { class: 'version-chip', title: '当前图版本' }, [
        el('span', { class: 'live' }), el('span', { id: 'gv' }, 'v—'),
      ]),
      el('div', { class: 'user-chip' }, [
        el('div', { class: 'avatar' }, (u.name || u.username).slice(0, 1)),
        el('div', { class: 'who' }, [el('b', {}, u.name), el('span', {}, u.role)]),
        el('span', { class: `role-tag ${u.role}` }, u.role),
        el('button', { class: 'btn small ghost', onclick: logout, title: '退出登录' }, '退出'),
      ]),
    ]),
    el('div', { class: 'main' }, [
      el('aside', { class: 'rail', id: 'rail' }),
      el('section', { class: 'stage' }, [
        el('div', { class: 'stage-head' }, [
          el('div', { class: 'search-box' }, [
            el('svg', { width: '13', height: '13', viewBox: '0 0 16 16', fill: 'none' }, []),
            el('input', {
              id: 'search',
              placeholder: can('audit.read') || u.role === 'analyst'
                ? '搜索账户 / 设备 / 商户…'
                : '搜索图中的化名标识 anon_…',
              autocomplete: 'off', oninput: onSearch, onkeydown: onSearchKey,
            }),
            el('div', { class: 'search-results hidden', id: 'search-results' }),
          ]),
          el('div', { class: 'stage-tools' }, [
            el('button', { class: 'btn small', onclick: () => findPathDialog() }, '路径分析'),
            el('button', { class: 'btn small', onclick: () => openImport() , id: 'btn-import', disabled: can('ingest') ? null : 'disabled', title: can('ingest') ? '' : '当前角色无导入权限' }, '导入数据'),
            el('span', { class: 'divider' }),
            el('button', {
              class: 'btn small', onclick: () => openExport(), id: 'btn-export',
              disabled: can('export') ? null : 'disabled', title: can('export') ? '' : '当前角色无导出权限',
            }, '导出'),
            el('button', { class: 'btn small', onclick: () => openReviews() }, '复核队列'),
            el('button', { class: 'btn small ghost', onclick: () => openLedger() }, '版本与审计'),
          ]),
        ]),
        el('div', { class: 'graph-wrap' }, [
          el('svg', { id: 'graph' }),
          el('div', { class: 'zoom-btns' }, [
            el('button', { onclick: () => zoom(1.2), title: '放大' }, '+'),
            el('button', { onclick: () => zoom(1 / 1.2), title: '缩小' }, '−'),
            el('button', { onclick: () => resetView(), title: '适应画布' }, '⤢'),
          ]),
          el('div', { class: 'graph-tooltip', id: 'gtip' }),
          el('div', { class: 'graph-legend' }, [
            el('div', { class: 'group' }, Object.entries(TYPE_LABEL).map(([k, v]) => el('span', { class: 'key' }, [
              el('span', { class: 'k-dot', style: `background:${TYPE_COLOR[k]}` }), v,
            ]))),
            el('div', { class: 'group' }, [
              el('span', { class: 'cap' }, '边'),
              ...Object.entries(EDGE_LABEL).map(([k, v]) => el('span', { class: 'key', title: v }, [
                el('span', { class: `k-line ${EDGE_DASH[k] ? 'dash' : ''}`, style: `color:var(--text-2);${k === 'shared_device' ? 'background:var(--text-2)' : ''}` }),
                v,
              ])),
            ]),
            el('div', { class: 'cap' }, '线宽 = 关系强度 · 节点环 = 风险分 · 虚线 = 非直接关联'),
          ]),
        ]),
        el('div', { class: 'stage-foot' }, [
          el('span', { id: 'graph-stat' }, '—'),
          el('span', { class: 'spacer' }),
          el('span', { id: 'window-stat' }, ''),
        ]),
      ]),
      el('aside', { class: 'inspector', id: 'inspector' }, [inspectorEmpty()]),
    ]),
    el('footer', { class: 'dock' }, [
      el('button', { class: 'on', onclick: () => openLedger() }, '图版本'),
      el('span', { id: 'dock-version', class: 'stat' }, 'v—'),
      el('button', { onclick: () => openLedger('batches') }, '导入批次'),
      el('button', { onclick: () => openReviews() }, '待复核'),
      el('span', { class: 'spacer' }),
      el('span', { class: 'stat', id: 'dock-policy' }, ''),
      el('span', { class: 'stat', id: 'dock-clock' }, ''),
    ]),
  ]);
  requestAnimationFrame(() => {
    if (state.window) {
      $('#win-from').value = state.window.from.slice(0, 10);
      $('#win-to').value = state.window.to.slice(0, 10);
    }
    $('#dock-policy').textContent = `角色 ${state.user.role} · 可见字段 ${state.user.fields.join('/')}`;
  });
  return shell;
}

function presetBtn(label, days) {
  return el('button', {
    type: 'button', 'data-days': String(days),
    onclick: () => applyPreset(days),
  }, label);
}

function applyPreset(days) {
  // Anchor on the newest data day the server knows about, not a stale window.
  const anchor = state.meta.default_window.to;
  const to = new Date(anchor);
  const from = days === 0 ? new Date(new Date(anchor).getTime() - 365 * 86400000) : new Date(new Date(anchor).getTime() - days * 86400000);
  state.window = { from: from.toISOString(), to: to.toISOString() };
  $('#win-from').value = state.window.from.slice(0, 10);
  $('#win-to').value = state.window.to.slice(0, 10);
  $$('#preset-seg button').forEach(b => b.classList.toggle('on', Number(b.dataset.days) === days));
  refreshGraph();
  refreshOverview();
}

function onWindowChange() {
  const from = $('#win-from').value;
  const to = $('#win-to').value;
  if (!from || !to) return;
  if (new Date(from) >= new Date(to)) { toast('起始日期必须早于结束日期', 'error'); return; }
  state.window = { from: new Date(`${from}T00:00:00.000Z`).toISOString(), to: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86400000).toISOString() };
  $$('#preset-seg button').forEach(b => b.classList.remove('on'));
  refreshGraph();
  refreshOverview();
}

async function refreshAll() {
  await refreshOverview();
  await refreshGraph();
  $('#gv').textContent = `v${state.meta.graph_version}`;
  $('#dock-version').textContent = `v${state.meta.graph_version}`;
  $('#dock-clock').textContent = `数据时间 ${fmtTime(state.meta.now)}`;
}

async function refreshOverview() {
  const q = windowQuery();
  try {
    const data = await api(`/api/overview?${q}`);
    state.overview = data;
    state.meta.graph_version = data.summary.version;
    renderRail(data);
    $('#dock-version').textContent = `v${data.summary.version}`;
    $('#gv').textContent = `v${data.summary.version}`;
    const pend = data.pending_reviews.labels + data.pending_reviews.merges;
    $$('.dock button').find(b => b.textContent.includes('待复核'))?.classList.toggle('on', pend > 0);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function windowQuery(extra = {}) {
  const p = new URLSearchParams({
    from: state.window.from,
    to: state.window.to,
    hops: String(state.hops),
    min_strength: String(state.minStrength),
    edge_types: Object.entries(state.edges).filter(([, v]) => v).map(([k]) => k).join(','),
    ...extra,
  });
  if (state.seeds.length) p.set('seeds', state.seeds.join(','));
  return p.toString();
}

function renderRail(data) {
  const rail = $('#rail');
  if (!rail) return;
  const s = data.summary;
  rail.innerHTML = '';
  rail.append(
    el('section', {}, [
      el('h3', {}, ['时间窗口', el('span', { class: 'count' }, `${s.days.length} 天有数据`)]),
      el('div', { class: 'metric-grid' }, [
        metric(compact(s.transactions), '交易', '去重后'),
        metric(cny(s.amount_cents), '金额', '累计'),
        metric(String(s.active_nodes), '活跃节点', '窗口内'),
        metric(String(s.edges), '关系边', '日聚合'),
      ]),
    ]),
    el('section', {}, [
      el('h3', {}, ['数据质量', el('span', { class: 'count' }, '窗口内')]),
      el('div', { class: 'metric-grid' }, [
        metric(String(s.late), '迟到交易', '超过 30 分钟', s.late ? 'warn' : ''),
        metric(String(s.duplicates), '重复投递', '已剔除出聚合', s.duplicates ? 'warn' : ''),
        metric(String(s.revisions), '上游更正', '保留旧版本', s.revisions ? 'warn' : ''),
        metric(String(data.pending_reviews.labels + data.pending_reviews.merges), '待复核', '标签 + 合并'),
      ]),
    ]),
    el('section', {}, [
      el('h3', {}, ['筛选', el('button', { class: 'btn small ghost', onclick: resetFilters }, '重置')]),
      el('div', {}, Object.entries(EDGE_LABEL).map(([k, label]) => el('div', { class: 'filter-row' }, [
        el('label', {}, [
          el('input', { type: 'checkbox', checked: state.edges[k] ? '' : null, onchange: e => { state.edges[k] = e.target.checked; refreshGraph(); } }),
          el('span', { class: `swatch ${EDGE_DASH[k] ? 'dash' : ''}`, style: `background:${EDGE_DASH[k] ? 'var(--text-2)' : 'var(--blue)'}` }),
          label,
        ]),
        el('span', { class: 'small muted mono' }, String(state.graph?.edges.filter(e => e.edge_type === k).length ?? '')),
      ]))),
      el('div', { class: 'range-row' }, [
        el('div', { class: 'lbl' }, [el('span', {}, '最小关系强度'), el('span', { class: 'mono' }, `${state.minStrength}%`)]),
        el('input', {
          type: 'range', min: '0', max: '90', step: '5', value: String(state.minStrength),
          oninput: e => { state.minStrength = Number(e.target.value); e.target.closest('.range-row').querySelector('.lbl .mono').textContent = `${state.minStrength}%`; },
          onchange: () => refreshGraph(),
        }),
      ]),
      el('div', { class: 'range-row' }, [
        el('div', { class: 'lbl' }, [el('span', {}, '展开层数'), el('span', { class: 'mono' }, `${state.hops} 跳`)]),
        el('input', {
          type: 'range', min: '1', max: '4', step: '1', value: String(state.hops),
          oninput: e => { state.hops = Number(e.target.value); e.target.closest('.range-row').querySelector('.lbl .mono').textContent = `${state.hops} 跳`; },
          onchange: () => refreshGraph(),
        }),
      ]),
    ]),
    el('section', {}, [
      el('h3', {}, ['焦点节点', state.seeds.length ? el('button', { class: 'btn small ghost', onclick: () => { state.seeds = []; refreshGraph(); } }, '清除') : null]),
      state.seeds.length
        ? el('div', { class: 'seed-list' }, state.seeds.map(sd => {
          const [type, id] = sd.split(':');
          return el('span', { class: 'seed-chip' }, [
            el('span', { class: 'k-dot', style: `width:7px;height:7px;border-radius:50%;background:${TYPE_COLOR[type] || '#888'}` }),
            el('span', {}, shortId(id)),
            el('button', { onclick: () => { state.seeds = state.seeds.filter(x => x !== sd); refreshGraph(); } }, '×'),
          ]);
        }))
        : el('div', { class: 'hint' }, '点击节点可设为焦点；没有焦点时展示窗口中风险最高的节点邻域。'),
    ]),
    el('section', {}, [
      el('h3', {}, ['高风险节点', el('span', { class: 'count' }, '按风险分')]),
      el('div', { style: 'display:flex;flex-direction:column;gap:5px' }, data.top_nodes.slice(0, 6).map(n => el('button', {
        class: 'edge-row', onclick: () => selectNode(n.type, n.id),
      }, [
        el('div', { class: 'to' }, [el('span', { class: 'k-dot', style: `display:inline-block;width:7px;height:7px;border-radius:50%;background:${TYPE_COLOR[n.type]};margin-right:6px` }), el('b', {}, n.label)]),
        el('div', { class: 'strength' }, n.risk.toFixed(2)),
        el('div', { class: 'etype' }, [TYPE_LABEL[n.type], ` · ${n.degree} 条关系`]),
        el('div', { class: 'mini-bar high' }, [el('i', { style: `width:${Math.min(100, n.risk * 100)}%` })]),
      ]))),
    ]),
    data.suggestions?.length ? el('section', {}, [
      el('h3', {}, ['合并建议', el('span', { class: 'count' }, `${data.suggestions.length}`)]),
      el('div', {}, data.suggestions.slice(0, 3).map(sg => el('div', { class: 'suggest' }, [
        el('div', {}, sg.reason),
        el('div', { class: 'accts' }, sg.accounts.map(a => el('span', { class: 'acct-pill' }, shortId(a)))),
        el('button', { class: 'btn small', onclick: () => openMerge(sg) }, '合并这些账户'),
      ]))),
    ]) : null,
    el('section', {}, [
      el('h3', {}, ['最近导入', el('button', { class: 'btn small ghost', onclick: () => openLedger('batches') }, '全部')]),
      el('div', { style: 'display:flex;flex-direction:column;gap:5px' }, data.batches.slice(0, 4).map(b => el('div', { class: 'suggest' }, [
        el('div', {}, b.id),
        el('div', { class: 'why' }, `${relTime(b.received_at)} · ${b.accepted} 接受 · ${b.duplicates} 重复 · ${b.late} 迟到${b.rejected ? ` · ${b.rejected} 拒绝` : ''}`),
      ]))),
    ]),
  );
}

function metric(value, label, sub, kind = '') {
  return el('div', { class: 'metric' }, [
    el('b', { style: kind === 'warn' ? 'color:var(--warning)' : null }, value),
    el('span', {}, label),
    el('div', { class: 'sub' }, sub),
  ]);
}

function resetFilters() {
  state.edges = { shared_device: true, ip_overlap: true, merchant_link: true, amount_flow: true, manual_link: false };
  state.minStrength = 0;
  state.hops = 2;
  state.seeds = [];
  refreshOverview();
  refreshGraph();
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

let sim = null;

async function refreshGraph() {
  try {
    const data = await api(`/api/graph?${windowQuery()}`);
    state.graph = data;
    renderGraph(data);
    const total = data.edges.reduce((a, e) => a + e.txn_count, 0);
    $('#graph-stat').textContent = `${data.nodes.length} 节点 · ${data.edges.length} 关系 · ${total} 笔交易支撑${data.truncated ? ' · 已截断' : ''}`;
    $('#window-stat').textContent = `${fmtTime(data.window.from, { dateOnly: true })} → ${fmtTime(new Date(new Date(data.window.to).getTime() - 1), { dateOnly: true })} · 图 v${data.graph_version}`;
    const rail = $('#rail');
    if (rail) $$('.filter-row .small', rail).forEach(() => {});
  } catch (err) {
    toast(err.message, 'error');
  }
}

function shortId(id) {
  if (!id) return '—';
  return String(id).replace(/^(account|device|merchant):/, '').slice(0, 14);
}

function renderGraph(data) {
  const svg = $('#graph');
  const wrap = svg.parentElement;
  const W = wrap.clientWidth || 800;
  const H = wrap.clientHeight || 600;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';

  if (!data.nodes.length) {
    wrap.querySelector('.graph-empty')?.remove();
    wrap.append(el('div', { class: 'graph-empty' }, '当前窗口和筛选条件下没有关系数据'));
    return;
  }
  wrap.querySelector('.graph-empty')?.remove();

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  svg.append(defs);

  const gLinks = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const gNodes = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svg.append(gLinks, gNodes);

  const typeOrder = { merchant: 0, account: 1, device: 2 };
  const nodes = data.nodes.map((n, i) => {
    const angle = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
    // Compare projected ids in full: shortId truncates, which would stop a
    // pseudonymous seed from ever matching its node.
    const seedSet = new Set((data.seeds || []).map(s => (s.includes(':') ? s : `account:${s}`)));
    const isSeed = seedSet.has(`${n.type}:${n.id}`);
    return {
      ...n, key: `${n.type}:${n.id}`,
      x: W / 2 + Math.cos(angle) * (90 + (i % 5) * 28),
      y: H / 2 + Math.sin(angle) * (70 + (i % 4) * 24),
      vx: 0, vy: 0, isSeed,
      r: nodeRadius(n),
    };
  });
  const byKey = new Map(nodes.map(n => [n.key, n]));
  // projectEdge emits `source`/`target` (projected ids) plus `src_id`/`dst_id`;
  // `source_id`/`target_id` never exist. Truncating a node may also drop an
  // endpoint, in which case the link is skipped rather than drawn to nowhere.
  const endpoint = (e, side) => {
    const type = side === 'src' ? e.source_type : e.target_type;
    const id = side === 'src' ? (e.src_id ?? e.source) : (e.dst_id ?? e.target);
    return byKey.get(`${type}:${id}`);
  };
  const links = data.edges.map(e => ({ ...e, s: endpoint(e, 'src'), t: endpoint(e, 'dst') }))
    .filter(l => l.s && l.t);

  // Force simulation: light, deterministic-ish, bounded iterations so it always settles.
  const iterations = 220;
  const nodesArr = nodes;
  for (let step = 0; step < iterations; step++) {
    const alpha = 1 - step / iterations;
    const k = 0.9 * alpha;
    for (const n of nodesArr) { n.vx += (W / 2 - n.x) * 0.0009 * alpha; n.vy += (H / 2 - n.y) * 0.0009 * alpha; }
    for (let i = 0; i < nodesArr.length; i++) {
      for (let j = i + 1; j < nodesArr.length; j++) {
        const a = nodesArr[i], b = nodesArr[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy || 1;
        const minD = a.r + b.r + 26;
        if (d2 < minD * minD) {
          const d = Math.sqrt(d2) || 1;
          const push = (minD - d) / d * 0.5;
          const fx = dx * push, fy = dy * push;
          a.x -= fx; a.y -= fy; b.x += fx; b.y += fy;
        } else {
          const force = 2200 / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * force, fy = (dy / d) * force;
          a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        }
      }
    }
    for (const l of links) {
      const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
      const d = Math.hypot(dx, dy) || 1;
      const target = 96 + (1 - l.strength) * 78;
      const force = (d - target) * 0.012 * alpha;
      const fx = (dx / d) * force, fy = (dy / d) * force;
      l.s.vx += fx; l.s.vy += fy; l.t.vx -= fx; l.t.vy -= fy;
    }
    for (const n of nodesArr) {
      n.x += n.vx * k; n.y += n.vy * k;
      n.vx *= 0.72; n.vy *= 0.72;
      n.x = Math.max(n.r + 16, Math.min(W - n.r - 16, n.x));
      n.y = Math.max(n.r + 30, Math.min(H - n.r - 16, n.y));
    }
  }

  const maxStrength = Math.max(...links.map(l => l.strength), 0.001);
  const NS = 'http://www.w3.org/2000/svg';

  for (const l of links) {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', l.s.x); line.setAttribute('y1', l.s.y);
    line.setAttribute('x2', l.t.x); line.setAttribute('y2', l.t.y);
    line.setAttribute('class', 'link');
    const w = 1 + (l.strength / maxStrength) * 3.2;
    line.setAttribute('stroke-width', String(w));
    line.setAttribute('stroke', edgeColor(l.strength));
    line.setAttribute('opacity', String(0.35 + 0.5 * (l.strength / maxStrength)));
    if (EDGE_DASH[l.edge_type]) line.setAttribute('stroke-dasharray', EDGE_DASH[l.edge_type]);
    line.style.cursor = 'pointer';
    line.addEventListener('mousemove', ev => showEdgeTip(ev, l));
    line.addEventListener('mouseleave', hideTip);
    line.addEventListener('click', () => selectEdge(l));
    gLinks.append(line);
    l.el = line;
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('class', 'link-label');
    label.setAttribute('x', (l.s.x + l.t.x) / 2);
    label.setAttribute('y', (l.s.y + l.t.y) / 2 - 3);
    label.setAttribute('text-anchor', 'middle');
    label.textContent = `${l.txn_count}`;
    label.setAttribute('opacity', '0.62');
    gLinks.append(label);
  }

  for (const n of nodes) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `node${n.isSeed ? ' seed' : ''}`);
    g.setAttribute('transform', `translate(${n.x},${n.y})`);
    g.style.color = TYPE_COLOR[n.type];
    const halo = document.createElementNS(NS, 'circle');
    halo.setAttribute('r', n.r + 7);
    halo.setAttribute('class', 'halo');
    halo.setAttribute('fill', TYPE_COLOR[n.type]);
    g.append(halo);
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('r', n.r);
    circle.setAttribute('fill', TYPE_COLOR[n.type]);
    circle.setAttribute('opacity', '0.92');
    g.append(circle);
    // risk ring: circumference fraction = risk, status-colored
    const riskRing = document.createElementNS(NS, 'circle');
    riskRing.setAttribute('r', n.r + 4);
    riskRing.setAttribute('class', 'risk-ring');
    riskRing.setAttribute('stroke', riskColor(n.risk));
    riskRing.setAttribute('stroke-dasharray', `${2 * Math.PI * (n.r + 4) * n.risk} ${2 * Math.PI * (n.r + 4)}`);
    riskRing.setAttribute('transform', 'rotate(-90)');
    riskRing.setAttribute('opacity', '0.95');
    g.append(riskRing);
    const glyph = document.createElementNS(NS, 'text');
    glyph.setAttribute('class', 'glyph');
    glyph.setAttribute('text-anchor', 'middle');
    glyph.setAttribute('dy', '3.2');
    glyph.textContent = n.type === 'account' ? 'A' : n.type === 'device' ? 'D' : 'M';
    g.append(glyph);
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('y', String(n.r + 15));
    label.textContent = truncateLabel(n.label, 16);
    g.append(label);
    const hit = document.createElementNS(NS, 'circle');
    hit.setAttribute('r', String(n.r + 9));
    hit.setAttribute('class', 'hit');
    g.append(hit);
    g.addEventListener('mousemove', ev => showNodeTip(ev, n));
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('click', ev => { ev.stopPropagation(); selectNode(n.type, n.id); });
    g.addEventListener('dblclick', ev => { ev.stopPropagation(); state.seeds = [`${n.type}:${n.id}`]; refreshGraph(); });
    if (state.selected && state.selected.type === n.type && state.selected.id === n.id) g.classList.add('selected');
    gNodes.append(g);
    n.el = g;
  }

  enablePanZoom(svg, { nodes, links, W, H });
}

function truncateLabel(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function nodeRadius(n) {
  const base = n.type === 'merchant' ? 13 : 11;
  return base + Math.min(9, Math.sqrt(n.degree || 0) * 2.2) + (n.risk > 0.8 ? 2 : 0);
}

function riskColor(risk) {
  if (risk >= 0.8) return '#d03b3b';
  if (risk >= 0.6) return '#ec835a';
  if (risk >= 0.4) return '#fab219';
  return '#0ca30c';
}

// Sequential blue ramp for edge strength (single-hue, light->saturated).
function edgeColor(strength) {
  if (strength >= 0.75) return '#86b6ef';
  if (strength >= 0.5) return '#5598e7';
  if (strength >= 0.3) return '#3987e5';
  if (strength >= 0.15) return '#256abf';
  return '#1c5cab';
}

function showNodeTip(ev, n) {
  const tip = $('#gtip');
  const labels = (n.labels || []).filter(l => !l.revoked_at);
  tip.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
      <span style="width:8px;height:8px;border-radius:50%;background:${TYPE_COLOR[n.type]}"></span>
      <strong style="font-size:11.5px">${esc(n.label)}</strong>
    </div>
    <div style="color:var(--muted);font-size:10px;font-family:var(--mono)">${esc(shortId(n.id))}</div>
    <div style="display:flex;gap:10px;margin-top:5px;font-size:10.5px">
      <span>风险 <b style="color:${riskColor(n.risk)}">${n.risk.toFixed(2)}</b></span>
      <span>关系 ${n.degree}</span>
      ${n.member_count > 1 ? `<span>合并 ${n.member_count} 实体</span>` : ''}
    </div>
    ${labels.length ? `<div style="margin-top:5px;font-size:10px;color:var(--text-2)">${labels.map(l => esc(LABEL_LABEL[l.label])).join(' · ')}</div>` : ''}
    <div style="margin-top:5px;font-size:9.5px;color:var(--muted)">单击查看 · 双击设为焦点</div>`;
  positionTip(ev, tip);
}

function showEdgeTip(ev, l) {
  const tip = $('#gtip');
  tip.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
      <span style="width:14px;height:2px;background:${edgeColor(l.strength)}"></span>
      <strong style="font-size:11px">${esc(EDGE_LABEL[l.edge_type])}</strong>
      <span style="margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--text-2)">${(l.strength * 100).toFixed(0)}</span>
    </div>
    <div style="font-size:10.5px;color:var(--text-2);margin-bottom:3px">${esc(l.txn_count)} 笔 · ${cny(l.amount_cents)} · ${l.day_count} 天</div>
    <div style="font-size:10px;color:var(--muted)">${esc(shortId(l.source))} → ${esc(shortId(l.target))}</div>
    <div style="font-size:9.5px;color:var(--muted)">${esc(l.evidence_txn_ids?.length || 0)} 条证据交易 · 单击下钻</div>
    ${l.late_count ? `<div style="font-size:10px;color:var(--serious);margin-top:3px">含 ${l.late_count} 笔迟到交易</div>` : ''}
    <div style="margin-top:5px;font-size:9.5px;color:var(--muted)">单击查看交易证据</div>`;
  positionTip(ev, tip);
}

function positionTip(ev, tip) {
  const wrap = $('#graph').parentElement.getBoundingClientRect();
  tip.classList.add('show');
  const x = ev.clientX - wrap.left, y = ev.clientY - wrap.top;
  const tw = tip.offsetWidth || 200;
  tip.style.left = `${Math.min(wrap.width - tw - 8, x + 14)}px`;
  tip.style.top = `${Math.max(8, y - 10)}px`;
}

function hideTip() { $('#gtip')?.classList.remove('show'); }

function enablePanZoom(svg, { W, H }) {
  let view = { x: 0, y: 0, k: 1 };
  const apply = () => { svg.setAttribute('viewBox', `${view.x} ${view.y} ${W / view.k} ${H / view.k}`); };
  state._view = view;
  state._applyView = apply;
  state._viewDims = { W, H };
  svg.onwheel = e => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = view.x + (e.clientX - rect.left) / rect.width * (W / view.k);
    const my = view.y + (e.clientY - rect.top) / rect.height * (H / view.k);
    const k = Math.max(0.5, Math.min(3.2, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
    view.x = mx - (mx - view.x) * (view.k / k);
    view.y = my - (my - view.y) * (view.k / k);
    view.k = k;
    apply();
  };
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  svg.onmousedown = e => {
    if (e.target.closest('.node') || e.target.classList.contains('link')) return;
    dragging = true; svg.classList.add('dragging');
    sx = e.clientX; sy = e.clientY; ox = view.x; oy = view.y;
  };
  svg.onmousemove = e => {
    if (!dragging) return;
    view.x = ox - (e.clientX - sx) * (W / view.k) / svg.clientWidth;
    view.y = oy - (e.clientY - sy) * (H / view.k) / svg.clientHeight;
    apply();
  };
  svg.onmouseup = () => { dragging = false; svg.classList.remove('dragging'); };
  svg.onmouseleave = () => { dragging = false; svg.classList.remove('dragging'); };
  apply();
}

function zoom(factor) {
  if (!state._view) return;
  const v = state._view;
  const { W, H } = state._viewDims;
  const cx = v.x + (W / v.k) / 2, cy = v.y + (H / v.k) / 2;
  v.k = Math.max(0.5, Math.min(3.2, v.k * factor));
  v.x = cx - (W / v.k) / 2; v.y = cy - (H / v.k) / 2;
  state._applyView();
}

function resetView() {
  if (!state._view) return;
  Object.assign(state._view, { x: 0, y: 0, k: 1 });
  state._applyView();
}

function selectNode(type, id) {
  state.selected = { type, id };
  state.selectedEdge = null;
  state.inspectorTab = 'overview';
  $$('#graph .node').forEach(g => g.classList.remove('selected'));
  const key = `${type}:${id}`;
  const match = [...document.querySelectorAll('#graph .node')].find(g => {
    const t = g.getAttribute('transform') || '';
    return false;
  });
  renderInspector();
  refreshGraph();
}

function selectEdge(edge) {
  state.selectedEdge = edge;
  state.selected = null;
  state.inspectorTab = 'evidence';
  renderInspector();
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

function inspectorEmpty() {
  return el('div', { class: 'inspector-empty' }, [
    el('div', { class: 'art', html: '<svg width="64" height="64" viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="21" stroke="#2c2c30" stroke-width="1.5"/><circle cx="32" cy="32" r="10" stroke="#39393f" stroke-width="1.5"/><circle cx="32" cy="32" r="3" fill="#3987e5"/><line x1="32" y1="11" x2="32" y2="22" stroke="#39393f" stroke-width="1.5"/><line x1="32" y1="42" x2="32" y2="53" stroke="#39393f" stroke-width="1.5"/><line x1="11" y1="32" x2="22" y2="32" stroke="#39393f" stroke-width="1.5"/><line x1="42" y1="32" x2="53" y2="32" stroke="#39393f" stroke-width="1.5"/></svg>' }),
    el('div', {}, '选择一个节点或关系边'),
    el('div', { class: 'small', style: 'margin-top:6px' }, '查看风险证据、原始交易、合并历史与复核状态。'),
  ]);
}

let inspectorCache = null;

async function renderInspector() {
  const box = $('#inspector');
  if (!box) return;
  if (state.selectedEdge) { renderEvidenceInspector(box); return; }
  if (!state.selected) { box.innerHTML = ''; box.append(inspectorEmpty()); return; }
  const { type, id } = state.selected;
  box.innerHTML = '';
  box.append(el('div', { class: 'inspector-head' }, [
    el('div', { class: 'row1' }, [
      el('span', { class: 'kind' }, TYPE_LABEL[type]),
      el('span', { class: 'spacer', style: 'flex:1' }),
      el('button', { class: 'btn small ghost', onclick: () => openMergeForNode(type, id), id: 'btn-merge-node', title: '合并实体' }, '合并'),
    ]),
    el('h2', { id: 'insp-title' }, '载入中…'),
    el('div', { class: 'sub', id: 'insp-sub' }, ''),
  ]));
  box.append(el('div', { class: 'inspector-tabs', id: 'insp-tabs' }));
  box.append(el('div', { class: 'inspector-body', id: 'insp-body' }, [el('div', { class: 'loading-line' }, [el('span', { class: 'spinner' }), '读取节点…'])]));
  try {
    const data = await api(`/api/node?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}&${windowQuery()}`);
    inspectorCache = data;
    $('#insp-title').textContent = data.node.label;
    $('#insp-sub').textContent = data.node.id;
    renderInspectorTabs(data);
    renderInspectorBody(data);
  } catch (err) {
    $('#insp-body').innerHTML = '';
    $('#insp-body').append(el('div', { class: 'banner danger' }, [el('span', { class: 'ico' }, '!'), err.message]));
  }
}

function renderInspectorTabs(data) {
  const tabs = $('#insp-tabs');
  tabs.innerHTML = '';
  const defs = [
    ['overview', '概览'],
    ['evidence', '关系证据'],
    ['transactions', '交易'],
    ['labels', `标记${data.node.labels.length ? ` · ${data.node.labels.length}` : ''}`],
    ['merges', '合并历史'],
  ];
  for (const [key, label] of defs) {
    tabs.append(el('button', {
      class: state.inspectorTab === key ? 'on' : '',
      onclick: () => { state.inspectorTab = key; renderInspectorTabs(data); renderInspectorBody(data); },
    }, label));
  }
}

function renderInspectorBody(data) {
  const body = $('#insp-body');
  body.innerHTML = '';
  const tab = state.inspectorTab;
  const node = data.node;
  if (tab === 'overview') {
    body.append(
      riskBlock(node),
      el('div', { class: 'stat-row' }, [
        el('div', { class: 'cell' }, [el('b', {}, String(node.degree)), el('span', {}, '关系边')]),
        el('div', { class: 'cell' }, [el('b', {}, compact(node.member_count)), el('span', {}, '合并实体')]),
        el('div', { class: 'cell' }, [el('b', {}, cny(node.txn_amount_cents)), el('span', {}, '累计金额')]),
      ]),
      node.member_count > 1 ? el('div', { class: 'banner info' }, [el('span', { class: 'ico' }, '⧉'), el('div', {}, [
        el('div', {}, `该节点合并了 ${node.member_count} 个原始实体，关系边按合并后的规范 ID 聚合。`),
        node.merge ? el('div', { class: 'small', style: 'margin-top:3px' }, `合并 ${node.merge.id} · ${node.merge.created_by} · ${relTime(node.merge.created_at)} · 复核：${REVIEW_LABEL[node.review_state] || node.review_state}`) : null,
      ])]) : null,
      el('div', { class: 'section' }, [
        el('h3', {}, '属性'),
        el('dl', { class: 'kv' }, [
          el('dt', {}, '类型'), el('dd', {}, TYPE_LABEL[node.type]),
          el('dt', {}, '规范 ID'), el('dd', {}, [el('span', { class: 'mono' }, node.id), el('button', {
            class: 'btn small ghost', style: 'margin-left:6px;padding:0 6px',
            title: '复制 ID 用于路径分析',
            onclick: ev => {
              navigator.clipboard?.writeText(node.id).then(
                () => toast('已复制节点 ID', 'success', node.id),
                () => toast('复制失败', 'error'),
              );
              ev.currentTarget.blur();
            },
          }, '复制')]),
          el('dt', {}, '合并成员'), el('dd', {}, node.members.length ? node.members.join(', ') : '（未合并）'),
          el('dt', {}, '计算版本'), el('dd', {}, `v${node.computed_version}`),
          el('dt', {}, '复核状态'), el('dd', {}, REVIEW_LABEL[node.review_state] || node.review_state),
          el('dt', {}, '最近活动'), el('dd', {}, fmtTime(data.transactions[0]?.occurred_at)),
        ]),
      ]),
      el('div', { class: 'section' }, [
        el('h3', {}, ['风险构成', el('span', { class: 'small muted' }, '可解释')]),
        factorRows(node.risk_factors),
      ]),
      fisheyeEdges(data.edges),
      el('div', { class: 'section' }, [
        el('h3', {}, '快捷操作'),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [
          el('button', { class: 'btn small', onclick: () => { state.seeds = [`${node.type}:${node.id}`]; refreshGraph(); } }, '设为焦点'),
          el('button', { class: 'btn small', onclick: () => findPathDialog(node) }, '从此节点找路径'),
          el('button', { class: 'btn small', onclick: () => openLabelDialog(node) }, '添加标记'),
        ]),
      ]),
    );
  } else if (tab === 'evidence') {
    body.append(fisheyeEdges(data.edges, true));
  } else if (tab === 'transactions') {
    body.append(transactionList(data.transactions, { showAccount: node.type !== 'account' }));
  } else if (tab === 'labels') {
    body.append(labelPanel(node), openLabelForm(node));
  } else if (tab === 'merges') {
    body.append(mergeHistory(data.merge_history, node));
  }
}

function riskBlock(node) {
  const risk = node.risk || 0;
  const cls = risk >= 0.8 ? '' : risk >= 0.6 ? 'serious' : risk >= 0.4 ? 'warning' : 'low';
  const level = risk >= 0.8 ? '高' : risk >= 0.6 ? '中高' : risk >= 0.4 ? '中' : '低';
  return el('div', { class: 'risk-meter' }, [
    el('div', { class: 'top' }, [
      el('div', {}, [el('div', { class: 'small muted' }, '综合风险分'), el('span', { class: 'score', style: `color:${riskColor(risk)}` }, risk.toFixed(2))]),
      el('div', { class: 'lvl', style: `color:${riskColor(risk)}` }, [el('span', { html: '●' }), `${level}风险`]),
    ]),
    el('div', { class: 'risk-track' }, [el('div', { class: `risk-fill ${cls}`, style: `width:${Math.max(2, risk * 100)}%` })]),
    el('div', { class: 'risk-legend' }, [el('span', {}, '0'), el('span', {}, '0.4'), el('span', {}, '0.6'), el('span', {}, '0.8+')]),
  ]);
}

function factorRows(factors) {
  if (!factors) return el('div', { class: 'muted small' }, '暂无');
  const rows = [];
  const max = 1.2;
  const push = (label, value, detail) => rows.push(el('div', { class: 'factor', title: detail || '' }, [
    el('span', {}, label),
    el('span', { class: 'bar' }, [el('i', { style: `width:${Math.min(100, Math.abs(value) / max * 100)}%` })]),
    el('span', { class: 'v' }, (value >= 0 ? '+' : '') + value.toFixed(2)),
  ]));
  if (factors.base != null) push('邻域暴露', factors.base, '由关系边的强度与总额推导');
  for (const [k, v] of Object.entries(factors.labels || {})) push(`标记 ${LABEL_LABEL[k] || k}`, v, '人工标记（已复核才计入）');
  if (factors.late_boost) push('迟到数据', factors.late_boost, '迟到交易带来的不确定性加成');
  if (factors.neighbors) {
    rows.push(el('div', { class: 'small muted', style: 'margin-top:4px' },
      `邻域：${Object.entries(factors.neighbors).map(([k, v]) => `${TYPE_LABEL[k] || k} ${v}`).join(' · ')}`));
  }
  return el('div', { class: 'factor-list' }, rows);
}

function fisheyeEdges(edges, full = false) {
  if (!edges.length) return el('div', { class: 'muted small' }, '窗口内没有关系边');
  const shown = full ? edges : edges.slice(0, 6);
  return el('div', { class: 'section' }, [
    el('h3', {}, ['关系边', el('span', { class: 'count' }, `${edges.length}`)]),
    el('div', { class: 'edge-list' }, shown.map(e => el('div', { class: 'edge-row', onclick: () => selectEdge(e) }, [
      el('div', { class: 'to' }, [el('b', {}, shortId(e.source === e.target ? e.source : (e.source))), el('span', { class: 'muted' }, ` → ${shortId(e.target)}`)]),
      el('div', { class: 'strength' }, e.strength.toFixed(2)),
      el('div', { class: 'etype' }, [el('span', { style: `width:14px;height:2px;background:${edgeColor(e.strength)};display:inline-block;border-radius:2px;${EDGE_DASH[e.edge_type] ? 'background:repeating-linear-gradient(90deg,var(--text-2) 0 4px,transparent 4px 7px)' : ''}` }), `${EDGE_LABEL[e.edge_type]} · ${e.txn_count} 笔 · ${cny(e.amount_cents)}`]),
      el('div', { class: 'mini-bar' }, [el('i', { style: `width:${Math.max(3, e.strength * 100)}%` })]),
    ]))),
    !full && edges.length > 6 ? el('button', { class: 'btn small ghost', style: 'margin-top:6px', onclick: () => { state.inspectorTab = 'evidence'; renderInspectorTabs(inspectorCache); renderInspectorBody(inspectorCache); } }, `查看全部 ${edges.length} 条`) : null,
  ]);
}

function transactionList(txns, opts = {}) {
  if (!txns.length) return el('div', { class: 'muted small' }, '窗口内没有交易');
  return el('div', { class: 'section' }, [
    el('h3', {}, ['交易', el('span', { class: 'count' }, `${txns.length}`)]),
    el('div', { class: 'txn-list' }, txns.slice(0, 60).map(t => el('div', { class: 'txn-row', onclick: () => openTrace(t.txn_id), title: '查看完整证据链' }, [
      el('div', { class: 'time' }, fmtTime(t.occurred_at)),
      el('div', { class: 'who' }, `${t.channel || ''}${opts.showAccount ? ' · ' + shortId(t.account_id) : ''}${t.merchant_id ? ' · ' + shortId(t.merchant_id) : ''}`),
      el('div', { class: 'amt' }, cny(t.amount_cents)),
      el('div', { class: 'flags' }, [
        t.is_late ? el('span', { class: 'chip late' }, '迟到') : null,
        t.is_duplicate ? el('span', { class: 'chip duplicate' }, '重复') : null,
        t.superseded_by ? el('span', { class: 'chip' }, '已更正') : null,
        t.version > 1 ? el('span', { class: 'chip' }, `v${t.version}`) : null,
      ]),
    ]))),
  ]);
}

function labelPanel(node) {
  const labels = node.labels || [];
  return el('div', { class: 'section' }, [
    el('h3', {}, ['人工标记', el('span', { class: 'count' }, `${labels.length}`)]),
    labels.length ? el('div', { class: 'label-list' }, labels.map(l => el('div', { class: `label-item ${l.label}` }, [
      el('div', { class: 'l1' }, [
        el('span', {}, LABEL_LABEL[l.label] || l.label),
        el('span', { class: `chip ${l.review_state}` }, REVIEW_LABEL[l.review_state] || l.review_state),
        el('span', { class: 'conf' }, `置信 ${Math.round(l.confidence * 100)}%`),
      ]),
      l.note ? el('div', { class: 'note' }, l.note) : null,
      el('div', { class: 'meta' }, [
        el('span', {}, `${l.author} · ${relTime(l.created_at)}`),
        l.reviewed_by ? el('span', {}, `复核 ${l.reviewed_by}`) : null,
        l.revoked_at ? el('span', { class: 'chip revoked' }, `已撤销 · ${l.revoked_by}`) :
          (state.user.caps.includes('annotate') && (state.user.username === l.author || state.user.role === 'admin')
            ? el('button', { class: 'btn small ghost', style: 'margin-left:auto', onclick: () => revokeLabel(l, node) }, '撤销')
            : null),
      ]),
    ]))) : el('div', { class: 'muted small' }, '尚无人工标记'),
    el('div', { class: 'small muted', style: 'margin-top:8px' }, '只有已复审通过的标记会显著影响风险分；待复核标记以较弱的权重参与。'),
  ]);
}

function openLabelForm(node) {
  if (!state.user.caps.includes('annotate')) {
    return el('div', { class: 'banner warn' }, [el('span', { class: 'ico' }, '!'), '当前角色无标记权限']);
  }
  const labelSel = el('select', {}, state.meta.label_types.map(t => el('option', { value: t }, `${LABEL_LABEL[t] || t}`)));
  const conf = el('input', { type: 'range', min: '0', max: '100', value: '70' });
  const confVal = el('span', { class: 'mono small' }, '70%');
  conf.addEventListener('input', () => { confVal.textContent = `${conf.value}%`; });
  const note = el('textarea', { rows: '2', placeholder: '证据说明（会出现在导出与复核中）' });
  return el('div', { class: 'section' }, [
    el('h3', {}, '新增标记'),
    el('div', { class: 'form-grid' }, [
      labelSel,
      el('div', { class: 'lbl', style: 'display:flex;justify-content:space-between;font-size:11px;color:var(--muted)' }, [el('span', {}, '置信度'), confVal]),
      conf, note,
      el('button', {
        class: 'btn primary',
        onclick: withBusy(async () => {
          try {
            await api('/api/label', {
              method: 'POST',
              body: { target_type: node.type, target_id: node.id, label: labelSel.value, confidence: Number(conf.value) / 100, note: note.value },
            });
            toast('标记已创建', 'success', '进入待复核队列');
            await renderInspector();
            await refreshGraph();
            await refreshOverview();
          } catch (err) { toast(err.message, 'error'); }
        }),
      }, '提交标记'),
    ]),
  ]);
}

async function revokeLabel(label, node) {
  try {
    await api('/api/label/revoke', { method: 'POST', body: { label_id: label.id } });
    toast('标记已撤销', 'success');
    await renderInspector();
    await refreshGraph();
    await refreshOverview();
  } catch (err) { toast(err.message, 'error'); }
}

function mergeHistory(merges, node) {
  if (!merges.length) return el('div', { class: 'muted small' }, '该节点没有合并记录');
  return el('div', { class: 'section' }, [
    el('h3', {}, '合并历史'),
    el('div', { class: 'versions-list' }, merges.map(m => el('div', { class: 'version-row' }, [
      el('span', { class: 'v' }, m.id),
      el('span', {}, m.undone_at ? '已撤销' : `合并 ${JSON.parse(m.source_ids).length} 个实体`),
      el('div', { class: 'meta' }, [
        el('span', {}, `${m.created_by} · ${fmtTime(m.created_at)}`),
        el('span', { class: `chip ${m.review_state}` }, REVIEW_LABEL[m.review_state] || m.review_state),
        m.undone_at ? el('span', {}, `撤销于 ${fmtTime(m.undone_at)}`) : null,
        m.stats ? el('span', {}, `重算 ${m.stats.edges_recomputed ?? '—'} 边 / ${m.stats.nodes_touched ?? '—'} 节点`) : null,
      ]),
      m.stats ? el('div', { class: 'detail' }, JSON.stringify(m.stats)) : null,
      !m.undone_at && state.user.caps.includes('undo_merge')
        ? el('button', { class: 'btn small danger', style: 'justify-self:start', onclick: () => undoMerge(m) }, '撤销合并')
        : null,
    ]))),
  ]);
}

async function undoMerge(m) {
  try {
    const res = await api('/api/merge/undo', { method: 'POST', body: { merge_id: m.id } });
    toast('合并已撤销', 'success', `重算 ${res.stats.undo_edges_recomputed} 条边 · 删除 ${res.stats.undo_edges_deleted} 条 · 图版本 v${res.graph_version}`);
    state.seeds = [];
    await renderInspector();
    await refreshGraph();
    await refreshOverview();
  } catch (err) { toast(err.message, 'error', err.detail ? JSON.stringify(err.detail) : ''); }
}

// ---------------------------------------------------------------------------
// Evidence inspector
// ---------------------------------------------------------------------------

async function renderEvidenceInspector(box) {
  const edge = state.selectedEdge;
  box.innerHTML = '';
  box.append(el('div', { class: 'inspector-head' }, [
    el('div', { class: 'row1' }, [
      el('span', { class: 'kind' }, '关系证据'),
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn small ghost', onclick: () => { state.selectedEdge = null; state.selected = null; renderInspector(); } }, '关闭'),
    ]),
    el('h2', {}, EDGE_LABEL[edge.edge_type]),
    el('div', { class: 'sub' }, `${shortId(edge.source)} → ${shortId(edge.target)}`),
  ]));
  const body = el('div', { class: 'inspector-body' }, [el('div', { class: 'loading-line' }, [el('span', { class: 'spinner' }), '展开交易证据…'])]);
  box.append(body);
  try {
    const data = await api(`/api/edge/evidence?agg_key=${encodeURIComponent(edge.agg_key)}&${windowQuery()}`);
    body.innerHTML = '';
    body.append(
      el('div', { class: 'path-summary' }, [
        el('b', {}, `强度 ${edge.strength.toFixed(2)}`),
        el('div', { class: 'small', style: 'color:var(--text-2)' }, `${edge.txn_count} 笔交易 · ${cny(edge.amount_cents)} · ${edge.day_count} 天 · 图 v${data.graph_version}`),
        el('div', { class: 'small muted', style: 'margin-top:3px' }, '强度按窗口重新推导，不是日强度的简单求和。'),
      ]),
      el('div', { class: 'section' }, [
        el('h3', {}, ['按日聚合', el('span', { class: 'count' }, `${edge.days?.length || 0} 天`)]),
        el('div', { class: 'factor-list' }, (edge.day_strengths || []).map(d => el('div', { class: 'factor' }, [
          el('span', { class: 'mono' }, d.day),
          el('span', { class: 'bar' }, [el('i', { style: `width:${Math.min(100, d.strength * 100)}%` })]),
          el('span', { class: 'v' }, `${d.txn_count} 笔 · ${d.strength.toFixed(2)}`),
        ]))),
      ]),
      el('div', { class: 'section' }, [
        el('h3', {}, ['原始交易', el('span', { class: 'count' }, `${data.rows.length}`)]),
        el('table', { class: 'evidence-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', {}, '日期'), el('th', {}, '交易号'), el('th', { class: 'right' }, '金额'), el('th', {}, '状态')])]),
          el('tbody', {}, data.rows.map(r => {
            const t = r.transaction;
            if (!t) return el('tr', {}, [el('td', { colspan: '4', class: 'muted' }, `交易 ${r.txn_ref} 不在当前视图权限内`)]);
            return el('tr', {}, [
              el('td', { class: 'mono' }, r.day),
              el('td', {}, [el('span', { class: 'linkish', onclick: () => openTrace(t.txn_id) }, t.txn_id)]),
              el('td', { class: 'num' }, cny(t.amount_cents)),
              el('td', {}, [
                t.is_late ? el('span', { class: 'chip late' }, '迟到') : null,
                t.is_duplicate ? el('span', { class: 'chip duplicate' }, '重复') : null,
                t.superseded_by ? el('span', { class: 'chip' }, '已更正') : null,
              ]),
            ]);
          })),
        ]),
      ]),
      el('div', { class: 'section' }, [
        el('h3', {}, ['可复算校验']),
        (() => {
          const sum = data.rows.reduce((a, r) => a + (r.transaction?.amount_cents || 0), 0);
          const observed = data.rows.reduce((a, r) => a + (r.day_amount_cents || 0), 0);
          const ok = sum === edge.amount_cents;
          return [
            el('div', { class: 'callout-code' }, `窗口内证据金额 ${cny(sum)} vs 关系边金额 ${cny(edge.amount_cents)}`),
            el('div', { class: `banner ${ok ? 'info' : 'warn'}`, style: 'margin-top:8px' }, [
              el('span', { class: 'ico' }, ok ? '✓' : '!'),
              ok
                ? '逐笔求和与边上的金额一致。窗口外的日桶（若存在）不计入本视图。'
                : '当前视图受时间窗口截断，只有完整窗口下两者才会相等。',
            ]),
            el('div', { class: 'small muted', style: 'margin-top:6px' }, `按日桶原值求和 ${cny(observed)}；每条边通过 edge_transactions 关联到具体交易，交易被更正或判重后边会在同一事务内重算。`),
          ];
        })(),
      ]),
    );
  } catch (err) {
    body.innerHTML = '';
    body.append(el('div', { class: 'banner danger' }, [el('span', { class: 'ico' }, '!'), err.message]));
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

let searchTimer = null;
function onSearch(e) {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const box = $('#search-results');
  if (!q) { box.classList.add('hidden'); return; }
  searchTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => ({ results: [] }));
      const results = data.results || [];
      box.innerHTML = '';
      if (!results.length) {
        box.classList.remove('hidden');
        box.append(el('div', { style: 'padding:9px;color:var(--muted);font-size:11.5px' }, '没有匹配的实体'));
        return;
      }
      box.classList.remove('hidden');
      for (const r of results.slice(0, 12)) {
        box.append(el('button', { onclick: () => { box.classList.add('hidden'); selectNode(r.type, r.id); } }, [
          el('span', { class: 'k-dot', style: `width:7px;height:7px;border-radius:50%;background:${TYPE_COLOR[r.type]}` }),
          el('span', {}, r.label),
          el('span', { class: 'type' }, TYPE_LABEL[r.type]),
        ]));
      }
    } catch { /* ignore */ }
  }, 160);
}

function onSearchKey(e) {
  if (e.key === 'Escape') $('#search-results').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function modal({ title, sub, wide = false, body, foot, tabs }) {
  const overlay = el('div', { class: 'overlay', onclick: e => { if (e.target === overlay) overlay.remove(); } });
  const box = el('div', { class: `modal${wide ? ' wide' : ''}` }, [
    el('div', { class: 'modal-head' }, [
      el('div', {}, [el('h2', {}, title), sub ? el('div', { class: 'sub' }, sub) : null]),
      el('button', { class: 'x', onclick: () => overlay.remove(), 'aria-label': '关闭' }, '×'),
    ]),
    tabs || null,
    el('div', { class: 'modal-body' }, [body]),
    foot ? el('div', { class: 'modal-foot' }, foot) : null,
  ]);
  overlay.append(box);
  document.body.append(overlay);
  return { overlay, box };
}

function closeModals() { $$('.overlay').forEach(o => o.remove()); }

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function openMergeForNode(type, id) {
  if (!state.user.caps.includes('merge')) { toast('当前角色无合并权限', 'error'); return; }
  openMerge({ kind: type, accounts: [id], reason: '手动选择合并', txn_counts: [] });
}

function openMerge(sg) {
  const candidateType = sg.kind || 'account';
  if (candidateType !== 'account') {
    toast('当前仅支持账户合并', 'warn', '设备/商户合并接口已预留');
    return;
  }
  const accounts = sg.accounts.map(a => typeof a === 'string' ? a : a.id);
  const targetSel = el('select', {}, accounts.map(a => el('option', { value: a }, shortId(a))));
  const note = el('textarea', { rows: '2', placeholder: '合并理由（写入审计与复核记录）' });
  const impact = el('div', { class: 'banner info' }, [
    el('span', { class: 'ico' }, '⧉'),
    el('div', {}, `将合并 ${accounts.length} 个实体。系统只重算与被合并节点相关的日桶关系，其余子图保持不变。合并后进入待复核状态。`),
  ]);
  const body = el('div', {}, [
    impact,
    el('div', { class: 'section' }, [
      el('h3', {}, '合并范围'),
      el('div', { class: 'form-grid' }, [
        el('div', { class: 'field' }, [el('label', {}, '保留为主实体'), targetSel]),
        el('div', { class: 'field' }, [
          el('label', {}, '被并入'),
          el('div', { class: 'accts' }, accounts.map(a => el('span', { class: 'acct-pill' }, shortId(a)))),
        ]),
        note,
      ]),
    ]),
    el('div', { class: 'small muted' }, sg.reason || ''),
  ]);
  const foot = [
    el('span', { class: 'small muted' }, '合并会写入图版本，并可通过“撤销合并”完整回退。'),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn ghost', onclick: closeModals }, '取消'),
    el('button', {
      class: 'btn primary',
      onclick: withBusy(async ev => {
        const btn = ev.currentTarget;
        btn.disabled = true; btn.textContent = '合并中…';
        try {
          const target = targetSel.value;
          const sources = accounts.filter(a => a !== target);
          if (!sources.length) throw new Error('至少需要一个被并入实体');
          const res = await api('/api/merge', { method: 'POST', body: { kind: 'account', source_ids: sources, target_id: target, note: note.value } });
          closeModals();
          const st = res.stats;
          toast('合并完成', 'success', `仅重算 ${st.edges_recomputed} 条边 · ${st.nodes_touched} 个节点受影响 · 图 v${st.version}`);
          state.selected = { type: 'account', id: res.target.id };
          state.seeds = [`account:${res.target.id}`];
          await refreshGraph();
          await refreshOverview();
          await renderInspector();
        } catch (err) {
          toast(err.message, 'error', err.detail ? JSON.stringify(err.detail) : '');
          btn.disabled = false; btn.textContent = '确认合并';
        }
      }),
    }, '确认合并'),
  ];
  modal({ title: '合并实体', sub: `${accounts.length} 个账户 → 1 个规范节点`, body, foot });
}

// ---------------------------------------------------------------------------
// Labels / review
// ---------------------------------------------------------------------------

function openLabelDialog(node) {
  const m = modal({ title: '添加标记', sub: `${node.label} · ${node.id}`, body: openLabelForm(node), foot: null });
  return m;
}

async function openReviews() {
  const body = el('div', {}, [el('div', { class: 'loading-line' }, [el('span', { class: 'spinner' }), '载入复核队列…'])]);
  const m = modal({ title: '复核队列', sub: '四眼原则：复核人不能是提交人', wide: true, body });
  try {
    const data = await api('/api/reviews');
    body.innerHTML = '';
    const pendingLabels = data.labels.filter(l => l.review_state === 'pending' && !l.revoked_at);
    const pendingMerges = data.merges.filter(x => x.review_state === 'pending' && !x.undone_at);
    const canReview = state.user.caps.includes('review');
    body.append(
      el('div', { class: 'banner info' }, [el('span', { class: 'ico' }, '◐'), `待复核：${pendingLabels.length} 个标记 · ${pendingMerges.length} 次合并。${canReview ? '' : '当前角色只能查看，不能复核。'}`]),
      el('div', { class: 'section' }, [
        el('h3', {}, ['标记', el('span', { class: 'pill-count' }, String(data.labels.length))]),
        tableOf(data.labels, [
          ['对象', l => `${TYPE_LABEL[l.target_type] || l.target_type} ${shortId(l.target_id)}`],
          ['标签', l => LABEL_LABEL[l.label] || l.label],
          ['置信', l => `${Math.round(l.confidence * 100)}%`, 'mono'],
          ['提交', l => `${l.author} · ${fmtTime(l.created_at)}`],
          ['状态', l => el('span', { class: `chip ${l.revoked_at ? 'revoked' : l.review_state}` }, l.revoked_at ? '已撤销' : (REVIEW_LABEL[l.review_state] || l.review_state))],
          ['', l => reviewActions('label', l, data.labels, canReview)],
        ]),
      ]),
      el('div', { class: 'section' }, [
        el('h3', {}, ['合并', el('span', { class: 'pill-count' }, String(data.merges.length))]),
        tableOf(data.merges, [
          ['合并 ID', m => m.id, 'mono'],
          ['范围', m => `${JSON.parse(m.source_ids).length} → 1`],
          ['提交', m => `${m.created_by} · ${fmtTime(m.created_at)}`],
          ['状态', m => el('span', { class: `chip ${m.undone_at ? 'revoked' : m.review_state}` }, m.undone_at ? '已撤销' : (REVIEW_LABEL[m.review_state] || m.review_state))],
          ['重算', m => m.stats ? `${m.stats.edges_recomputed} 边 / ${m.stats.nodes_touched} 节点` : '—', 'mono'],
          ['', m => reviewActions('merge', m, data.merges, canReview)],
        ]),
      ]),
    );
  } catch (err) {
    body.innerHTML = '';
    body.append(el('div', { class: 'banner danger' }, [el('span', { class: 'ico' }, '!'), err.message]));
  }
}

function tableOf(rows, cols) {
  if (!rows.length) return el('div', { class: 'muted small' }, '队列为空');
  return el('table', { class: 'table' }, [
    el('thead', {}, [el('tr', {}, cols.map(([h, , cls]) => el('th', { class: cls || '' }, h)))]),
    el('tbody', {}, rows.map(r => el('tr', {}, cols.map(([, fn, cls]) => {
      const v = fn(r);
      return el('td', { class: cls || '' }, [v?.nodeType ? v : v]);
    })))),
  ]);
}

function reviewActions(objectType, row, all, canReview) {
  if (!canReview) return el('span', { class: 'muted small' }, '只读');
  if (row.revoked_at || row.undone_at) return el('span', { class: 'muted small' }, '—');
  const disabled = (row.author || row.created_by) === state.user.username;
  return el('div', { class: 'actions' }, [
    el('button', { class: 'btn small', disabled: disabled || null, title: disabled ? '不能复核自己提交的内容' : '', onclick: () => doReview(objectType, row, 'approved') }, '通过'),
    el('button', { class: 'btn small danger', disabled: disabled || null, onclick: () => doReview(objectType, row, 'rejected') }, '驳回'),
  ]);
}

async function doReview(objectType, row, decision) {
  try {
    await api('/api/review', { method: 'POST', body: { object_type: objectType, object_id: row.id, decision } });
    toast('复核已记录', 'success', `${objectType === 'label' ? '标记' : '合并'} → ${REVIEW_LABEL[decision]}`);
    closeModals();
    await openReviews();
    await refreshOverview();
    if (state.selected) await renderInspector();
  } catch (err) { toast(err.message, 'error'); }
}

// ---------------------------------------------------------------------------
// Ledger (versions / batches / audit)
// ---------------------------------------------------------------------------

async function openLedger(defaultTab = 'versions') {
  const [versionsRes, batchesRes] = await Promise.all([
    api('/api/versions').catch(() => ({ versions: [] })),
    api('/api/import/batches').catch(() => ({ batches: [] })),
  ]);
  let auditRes = { entries: [] };
  if (state.user.caps.includes('audit.read')) auditRes = await api('/api/audit').catch(() => ({ entries: [] }));
  let tab = defaultTab;
  const body = el('div', {});
  const tabs = el('div', { class: 'tabs' });
  const render = () => {
    body.innerHTML = '';
    tabs.innerHTML = '';
    const mk = (key, label) => el('button', {
      class: tab === key ? 'on' : '',
      onclick: () => { tab = key; render(); },
    }, label);
    tabs.append(mk('versions', '图版本'), mk('batches', '导入批次'), mk('quality', '数据质量'));
    if (state.user.caps.includes('audit.read')) tabs.append(mk('audit', '审计日志'));
    if (tab === 'versions') {
      body.append(el('table', { class: 'table' }, [
        el('thead', {}, [el('tr', {}, ['版本', '触发', '影响节点', '重算边', '删除边', '耗时', '时间'].map((h, i) => el('th', { class: i > 1 && i < 6 ? 'right' : '' }, h)))]),
        el('tbody', {}, versionsRes.versions.map(v => el('tr', {}, [
          el('td', { class: 'mono' }, `v${v.version}`),
          el('td', {}, v.trigger),
          el('td', { class: 'right mono' }, String(v.affected_nodes)),
          el('td', { class: 'right mono' }, String(v.edges_recomputed)),
          el('td', { class: 'right mono' }, String(v.edges_deleted)),
          el('td', { class: 'right mono' }, `${v.duration_ms}ms`),
          el('td', { class: 'mono' }, fmtTime(v.created_at)),
        ]))),
      ]));
    } else if (tab === 'batches') {
      body.append(el('table', { class: 'table' }, [
        el('thead', {}, [el('tr', {}, ['批次', '来源', '总数', '接受', '重复', '迟到', '拒绝', '时间'].map(h => el('th', {}, h)))]),
        el('tbody', {}, batchesRes.batches.map(b => el('tr', {}, [
          el('td', { class: 'mono' }, b.id),
          el('td', {}, b.detail?.source || '—'),
          el('td', { class: 'mono' }, String(b.total)),
          el('td', { class: 'mono' }, String(b.accepted)),
          el('td', { class: 'mono', style: b.duplicates ? 'color:var(--warning)' : '' }, String(b.duplicates)),
          el('td', { class: 'mono', style: b.late ? 'color:var(--serious)' : '' }, String(b.late)),
          el('td', { class: 'mono', style: b.rejected ? 'color:#e8a3a3' : '' }, String(b.rejected)),
          el('td', { class: 'mono' }, fmtTime(b.received_at)),
        ]))),
      ]));
      if (!batchesRes.batches.some(b => b.detail)) {
        body.append(el('div', { class: 'banner warn', style: 'margin-top:10px' }, [el('span', { class: 'ico' }, '!'), '当前角色看不到批次明细（需要导入权限）。']));
      }
    } else if (tab === 'quality') {
      body.append(qualityPanel());
    } else if (tab === 'audit') {
      body.append(el('div', { class: 'audit-list' }, auditRes.entries.map(a => el('div', { class: 'audit-row' }, [
        el('span', { class: 'actor' }, `${a.actor} (${a.role})`),
        el('span', {}, a.action),
        el('div', { class: 'meta' }, [el('span', {}, fmtTime(a.at)), a.object_type ? el('span', {}, `${a.object_type} ${a.object_id || ''}`) : null]),
        a.detail ? el('div', { class: 'detail' }, a.detail) : null,
      ]))));
    }
  };
  render();
  modal({ title: '版本与审计', sub: '每一次重算都可追溯到触发点', wide: true, body, tabs });
}

function qualityPanel() {
  const s = state.overview?.summary;
  const gap = (minutes) => `${minutes} 分钟`;
  return el('div', {}, [
    el('div', { class: 'banner info' }, [el('span', { class: 'ico' }, '◷'), [
      el('div', {}, '顺序保证：交易按 (txn_id, 版本) 记录，重复投递不进入聚合；迟到数据在到达时立即并入对应日桶并重算该日关系。'),
      el('div', { class: 'small', style: 'margin-top:3px' }, '当前窗口内迟到判定阈值 30 分钟；上游更正保留旧版本，可在交易痕迹中对比。'),
    ]]),
    el('div', { class: 'section' }, [
      el('h3', {}, '校验入口'),
      el('div', { class: 'small muted', style: 'line-height:1.7' }, [
        el('div', {}, '1. 任取一条关系边 → 证据表 → 逐笔金额求和，应等于边上的 amount_cents。'),
        el('div', {}, '2. 任取一条交易 → 痕迹面板 → 查看 ingesting 批次、版本链、派生边。'),
        el('div', {}, '3. 导入同一批次两次 → 第二次应全部判为 duplicate，图版本不变或仅增加重复计数。'),
        el('div', {}, '4. 导入 occurred_at 早于 received_at 30 分钟以上的记录 → 标记迟到并触发重算。'),
      ]),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const SAMPLE_RECORDS = [
  { txn_id: 'T-DEMO-01', account_id: 'AC-1001', device_id: 'DV-01', merchant_id: 'MC-03', amount_cents: 250000, occurred_at: new Date(Date.now() - 3600e3).toISOString(), received_at: new Date().toISOString(), ip: '203.0.113.10', channel: 'app' },
  { txn_id: 'T-DEMO-02', account_id: 'AC-2001', device_id: 'DV-05', merchant_id: 'MC-05', counterparty_account_id: 'AC-1003', amount_cents: 900000, occurred_at: new Date(Date.now() - 7200e3).toISOString(), received_at: new Date().toISOString(), ip: '198.51.100.40', channel: 'web' },
];

function sampleSet(kind) {
  const received_at = new Date().toISOString();
  if (kind === 'duplicate') {
    // Same business event delivered twice in one batch: one accepted, one
    // classified duplicate. Re-running this batch a second time should classify
    // both as duplicates and leave the graph's numbers unchanged.
    const rec = { ...SAMPLE_RECORDS[0], txn_id: 'T-DUP-DEMO', occurred_at: new Date(Date.now() - 1800e3).toISOString(), received_at };
    return [rec, { ...rec }];
  }
  if (kind === 'late') {
    return [{
      ...SAMPLE_RECORDS[0], txn_id: 'T-LATE-DEMO',
      occurred_at: new Date(Date.now() - 5 * 3600e3).toISOString(), received_at,
      note: 'T+5h 补传',
    }];
  }
  if (kind === 'revision') {
    // Same txn_id as a seeded trade but a different merchant: a correction,
    // not a replay. The old version leaves the evidence set.
    const base = SAMPLE_RECORDS[0];
    return [{
      ...base, txn_id: 'T-2112', account_id: 'AC-2004', device_id: 'DV-05',
      counterparty_account_id: 'AC-1001', merchant_id: 'MC-02', amount_cents: 233000,
      occurred_at: `2026-11-16T14:13:17.672Z`, received_at, ip: '198.51.100.41', note: '上游再次更正商户号',
    }];
  }
  if (kind === 'invalid') {
    return [
      { ...SAMPLE_RECORDS[0], txn_id: 'T-BAD-1', amount_cents: -5 },
      { ...SAMPLE_RECORDS[0], txn_id: 'T-BAD-2', account_id: 'AC-9999' },
      { ...SAMPLE_RECORDS[0], txn_id: 'T-BAD-3', occurred_at: 'not-a-date' },
    ];
  }
  return SAMPLE_RECORDS;
}

function openImport() {
  if (!state.user.caps.includes('ingest')) { toast('当前角色无导入权限', 'error'); return; }
  let payload = JSON.stringify(SAMPLE_RECORDS, null, 2);
  const area = el('textarea', { class: 'code-area', spellcheck: 'false' }, []);
  area.value = payload;
  const status = el('div', {});
  const report = el('div', {});
  const dz = el('div', { class: 'dropzone', onclick: () => fileInput.click() }, [
    el('b', {}, '拖入 CSV / JSON 文件'),
    el('div', { class: 'small' }, '或点击选择。CSV 需包含 txn_id, account_id, amount, occurred_at 列。'),
  ]);
  const fileInput = el('input', { type: 'file', accept: '.json,.csv,.txt', onchange: e => loadFile(e.target.files[0]) });
  dz.append(fileInput);
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('hot'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('hot'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('hot'); loadFile(e.dataTransfer.files[0]); });
  async function loadFile(file) {
    if (!file) return;
    const text = await file.text();
    if (file.name.endsWith('.csv')) {
      area.value = csvToJson(text);
    } else {
      area.value = text;
    }
    toast(`已载入 ${file.name}`, 'success');
  }

  const body = el('div', {}, [
    dz,
    el('div', { class: 'sample-row' }, [
      ...[['normal', '正常数据'], ['duplicate', '重复投递'], ['late', '迟到数据'], ['revision', '上游更正'], ['invalid', '校验失败']]
        .map(([kind, label]) => el('button', {
          class: 'btn small',
          onclick: () => { area.value = JSON.stringify(sampleSet(kind), null, 2); status.innerHTML = ''; report.innerHTML = ''; },
        }, label)),
    ]),
    area,
    el('div', { class: 'small muted', style: 'margin-top:6px' }, '校验：金额为正整数分、occurred_at 合法、账户/设备/商户必须已存在、不允许未来时间。'),
    status,
    report,
  ]);
  const foot = [
    el('span', { class: 'small muted' }, '导入写入审计日志，并在同一事务内只重算受影响关系。'),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn ghost', onclick: closeModals }, '取消'),
    el('button', {
      class: 'btn primary',
      onclick: withBusy(async ev => {
        const btn = ev.currentTarget;
        btn.disabled = true; btn.textContent = '导入中…';
        try {
          let records;
          try { records = JSON.parse(area.value); } catch { throw new Error('JSON 解析失败'); }
          if (!Array.isArray(records)) records = records.records;
          if (!Array.isArray(records)) throw new Error('需要记录数组');
          const res = await api('/api/ingest', { method: 'POST', body: { records, source: 'manual' } });
          status.innerHTML = '';
          report.innerHTML = '';
          report.append(el('div', { class: 'import-report' }, [
            cell(res.total, '总数'),
            cell(res.accepted, '接受', 'good'),
            cell(res.duplicates, '重复', res.duplicates ? 'warn' : ''),
            cell(res.late, '迟到', res.late ? 'warn' : ''),
            cell(res.rejected, '拒绝', res.rejected ? 'bad' : ''),
            cell(res.graph ? res.graph.edges_recomputed : 0, '重算边'),
          ]));
          if (res.graph) report.append(el('div', { class: 'banner ok' }, [el('span', { class: 'ico' }, '✓'), `图已更新到 v${res.graph.version}：仅 ${res.graph.edges_recomputed} 条边被重算，${res.graph.nodes ?? '—'} 个节点受影响。`]));
          const rejects = res.results.filter(r => r.outcome === 'rejected');
          if (rejects.length) {
            report.append(el('div', { class: 'section' }, [
              el('h3', {}, `拒绝明细 · ${rejects.length}`),
              el('table', { class: 'table' }, [
                el('thead', {}, [el('tr', {}, [el('th', {}, '交易号'), el('th', {}, '原因')])]),
                el('tbody', {}, rejects.map(r => el('tr', {}, [el('td', { class: 'mono' }, r.txn_id || '—'), el('td', {}, r.reasons.join('; '))]))),
              ]),
            ]));
          }
          toast('导入完成', 'success', `${res.accepted} 接受 · ${res.duplicates} 重复 · ${res.late} 迟到`);
          // An import can introduce a new day, which moves the server's default
          // window. Refresh meta so presets and the "全部" range stay correct.
          state.meta = await api('/api/meta');
          await refreshGraph();
          await refreshOverview();
          $('#gv').textContent = `v${res.graph?.version ?? state.meta.graph_version}`;
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          btn.disabled = false; btn.textContent = '导入';
        }
      }),
    }, '导入'),
  ];
  modal({ title: '导入交易数据', sub: '支持 JSON 数组或 CSV；重复与迟到会被显式处理', wide: true, body, foot });
}

function cell(v, label, kind = '') {
  return el('div', { class: `cell ${kind}` }, [el('b', {}, String(v ?? 0)), el('span', {}, label)]);
}

function csvToJson(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).filter(Boolean).map(line => {
    const cells = line.split(',');
    const obj = {};
    headers.forEach((h, i) => {
      const raw = (cells[i] ?? '').trim();
      obj[h] = h === 'amount' || h === 'amount_cents' ? Number(raw) : raw;
    });
    return obj;
  });
  return JSON.stringify(rows, null, 2);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function openExport() {
  if (!state.user.caps.includes('export')) { toast('当前角色无导出权限', 'error'); return; }
  const canGraph = state.user.caps.includes('export.graph');
  const kind = el('select', {}, [
    el('option', { value: 'transactions' }, '交易明细 (CSV)'),
    el('option', { value: 'evidence' }, '当前视图交易 (CSV)'),
    ...(canGraph ? [el('option', { value: 'graph' }, '关系图 (JSON)')] : []),
  ]);
  const note = el('div', { class: 'banner info' }, [
    el('span', { class: 'ico' }, '⇩'),
    el('div', {}, [
      el('div', {}, `导出使用与页面完全相同的字段级投影：当前角色可见 ${state.user.fields.join(' / ')}。`),
      el('div', { class: 'small', style: 'margin-top:3px' }, '未授权字段在服务端被移除，而不是在前端隐藏；CSV 已做公式注入转义。'),
    ]),
  ]);
  const body = el('div', {}, [
    note,
    el('div', { class: 'export-opts' }, [
      el('div', { class: 'field' }, [el('label', {}, '导出类型'), kind]),
      el('div', { class: 'field' }, [el('label', {}, '时间窗口'), el('div', { class: 'callout-code' }, `${fmtTime(state.window.from)} → ${fmtTime(state.window.to)}`)]),
    ]),
    el('div', { class: 'section' }, [
      el('h3', {}, '权限对照'),
      el('table', { class: 'table' }, [
        el('thead', {}, [el('tr', {}, [el('th', {}, '角色'), el('th', {}, '可见字段'), el('th', {}, '导出'), el('th', {}, '图导出')])]),
        el('tbody', {}, [
          ['admin', '全部字段', '✓', '✓'],
          ['analyst', '全部字段', '✓', '✓'],
          ['auditor', '金额/设备/商户/时间，账户为化名', '✓', '✗'],
          ['viewer', '金额/时间，实体为化名', '✗', '✗'],
        ].map(([r, f, e, g]) => el('tr', { style: r === state.user.role ? 'background:rgba(57,135,229,.07)' : '' }, [
          el('td', {}, [el('span', { class: `role-tag ${r}` }, r)]),
          el('td', { class: 'small' }, f),
          el('td', {}, e), el('td', {}, g),
        ]))),
      ]),
    ]),
  ]);
  const foot = [
    el('span', { class: 'small muted' }, '每次导出写入审计日志。'),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn ghost', onclick: closeModals }, '取消'),
    el('button', {
      class: 'btn primary',
      onclick: withBusy(async ev => {
        const btn = ev.currentTarget;
        btn.disabled = true; btn.textContent = '生成中…';
        try {
          const res = await fetch('/api/export', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ kind: kind.value, from: state.window.from, to: state.window.to, seeds: state.seeds }),
          });
          if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            throw new Error(payload.error || '导出失败');
          }
          const blob = await res.blob();
          const cd = res.headers.get('content-disposition') || '';
          const name = /filename="([^"]+)"/.exec(cd)?.[1] || 'export';
          const url = URL.createObjectURL(blob);
          const a = el('a', { href: url, download: name });
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          toast('导出完成', 'success', `${name} · ${res.headers.get('x-export-policy') || ''}`);
        } catch (err) {
          toast(err.message, 'error');
        } finally { btn.disabled = false; btn.textContent = '下载'; }
      }),
    }, '下载'),
  ];
  modal({ title: '导出数据', sub: '服务端投影 + 能力校验', body, foot });
}

// ---------------------------------------------------------------------------
// Trace drawer
// ---------------------------------------------------------------------------

async function openTrace(txnId) {
  const body = el('div', {}, [el('div', { class: 'loading-line' }, [el('span', { class: 'spinner' }), '追溯证据链…'])]);
  modal({ title: '交易痕迹', sub: `txn ${txnId}`, wide: true, body });
  // Always trace by the business txn_id: internal row ids are not a navigation
  // handle for the UI, and restricted roles are refused them server-side.
  try {
    const data = await api(`/api/trace?txn_id=${encodeURIComponent(txnId)}`);
    body.innerHTML = '';
    const t = data.transaction;
    body.append(
      el('div', { class: 'banner info' }, [el('span', { class: 'ico' }, '⛓'), [
        el('div', {}, `从图上的关系边回溯到这一笔原始交易：${data.lineage.edges_derived.length} 条边由它支撑，共 ${data.lineage.occurrences.length} 个版本，${data.lineage.duplicate_copies} 份重复投递。`),
      ]]),
      el('div', { class: 'stat-row', style: 'grid-template-columns:repeat(4,1fr)' }, [
        el('div', { class: 'cell' }, [el('b', {}, cny(t.amount_cents)), el('span', {}, '金额')]),
        el('div', { class: 'cell' }, [el('b', {}, fmtTime(t.occurred_at)), el('span', {}, '发生时间')]),
        el('div', { class: 'cell' }, [el('b', {}, fmtTime(t.received_at)), el('span', {}, '到达时间')]),
        el('div', { class: 'cell' }, [el('b', {}, t.is_late ? `+${t.late_minutes}m` : '准时'), el('span', {}, '时效')]),
      ]),
      el('div', { class: 'section' }, [
        el('h3', {}, '字段'),
        el('dl', { class: 'kv' }, Object.entries(t).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [
          el('dt', {}, k), el('dd', {}, typeof v === 'object' ? JSON.stringify(v) : String(v)),
        ]).flat()),
      ]),
      el('div', { class: 'section' }, [
        el('h3', {}, ['版本链', el('span', { class: 'count' }, `${data.versions.length}`)]),
        el('div', { class: 'trace-chain' }, data.versions.map(v => el('div', { class: `trace-step${v.superseded_by ? '' : ' done'}` }, [
          el('div', { class: 't' }, `${fmtTime(v.received_at)} · 批次 ${v.ingest_batch_id || '—'}`),
          el('div', { class: 'd' }, [el('b', {}, `v${v.version}`), ` · ${cny(v.amount_cents)} · ${v.merchant_id || '—'} · ${v.device_id || '—'}`]),
          v.superseded_by ? el('div', { class: 'small muted' }, `已被 ${v.superseded_by} 更正`) : el('div', { class: 'small muted' }, '当前有效版本'),
        ]))),
      ]),
      el('div', { class: 'section' }, [
        el('h3', {}, ['由该交易派生的关系边', el('span', { class: 'count' }, `${data.endpoints.length}`)]),
        el('table', { class: 'evidence-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', {}, '类型'), el('th', {}, '日期'), el('th', {}, '端点'), el('th', { class: 'right' }, '日强度'), el('th', { class: 'right' }, '贡献')])]),
          el('tbody', {}, data.endpoints.map(e => el('tr', {}, [
            el('td', {}, EDGE_LABEL[e.edge_type] || e.edge_type),
            el('td', { class: 'mono' }, e.day),
            el('td', { class: 'mono small' }, `${shortId(e.src_id)} → ${shortId(e.dst_id)}`),
            el('td', { class: 'num' }, e.strength.toFixed(3)),
            el('td', { class: 'num' }, `${Math.round(e.contribution * 100)}%`),
          ]))),
        ]),
        el('div', { class: 'small muted', style: 'margin-top:6px' }, `计算版本：${data.endpoints.map(e => `v${e.computed_version}`).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`),
      ]),
      data.duplicate_divergence.length ? el('div', { class: 'section' }, [
        el('h3', {}, '重复投递记录'),
        el('div', { class: 'trace-chain' }, data.duplicate_divergence.map(d => el('div', { class: 'trace-step' }, [
          el('div', { class: 't' }, fmtTime(d.received_at)),
          el('div', { class: 'd' }, [el('b', {}, '重复份'), ` · 指纹相同 · 不计入聚合`]),
        ]))),
      ]) : null,
      el('div', { class: 'section' }, [
        el('h3', {}, '批次来源'),
        data.batch ? el('div', { class: 'callout-code' }, JSON.stringify(data.batch, null, 2)) : el('div', { class: 'muted small' }, '—'),
      ]),
    );
  } catch (err) {
    body.innerHTML = '';
    body.append(el('div', { class: 'banner danger' }, [el('span', { class: 'ico' }, '!'), err.message]));
  }
}

// ---------------------------------------------------------------------------
// Path analysis
// ---------------------------------------------------------------------------

function findPathDialog(fromNode = null) {
  const typeSel = el('select', {}, [el('option', { value: 'account' }, '账户'), el('option', { value: 'device' }, '设备'), el('option', { value: 'merchant' }, '商户')]);
  const rawVisible = state.user.role === 'admin' || state.user.role === 'analyst';
  const start = fromNode || state.selected || null;
  const fromInput = el('input', {
    placeholder: rawVisible ? '起始 ID，如 AC-1002' : '粘贴图中的化名标识 anon_…',
    value: start ? start.id : '',
  });
  if (start) typeSel.value = start.type;
  // The default destination is a merchant, so the type selector must agree with
  // it — otherwise the dialog submits to_type=account + to_id=MC-03 and fails.
  const toTypeSel = el('select', {}, [el('option', { value: 'account' }, '账户'), el('option', { value: 'device' }, '设备'), el('option', { value: 'merchant' }, '商户')]);
  if (rawVisible) toTypeSel.value = 'merchant';
  const toInput = el('input', { placeholder: rawVisible ? '目标 ID，如 MC-03' : '目标化名标识', value: rawVisible ? 'MC-03' : '' });
  const hops = el('input', { type: 'number', min: '1', max: '6', value: '3', style: 'width:70px' });
  const result = el('div', {});
  const body = el('div', {}, [
    el('div', { class: 'banner info' }, [el('span', { class: 'ico' }, '↝'), '在时间窗口内寻找最少跳数的关系链。每一步都标注关系类型、强度与支撑交易。']),
    el('div', { class: 'export-opts', style: 'grid-template-columns:1fr 1fr' }, [
      el('div', { class: 'form-grid' }, [
        el('div', { class: 'field' }, [el('label', {}, '起点类型'), typeSel]),
        el('div', { class: 'field' }, [el('label', {}, '起点 ID'), fromInput]),
      ]),
      el('div', { class: 'form-grid' }, [
        el('div', { class: 'field' }, [el('label', {}, '终点类型'), toTypeSel]),
        el('div', { class: 'field' }, [el('label', {}, '终点 ID'), toInput]),
      ]),
    ]),
    el('div', { class: 'field', style: 'max-width:180px' }, [el('label', {}, '最大跳数'), hops]),
    result,
  ]);
  const foot = [
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn ghost', onclick: closeModals }, '关闭'),
    el('button', {
      class: 'btn primary',
      onclick: withBusy(async ev => {
        const btn = ev.currentTarget;
        btn.disabled = true; btn.textContent = '搜索中…';
        try {
          const q = new URLSearchParams({
            from_type: typeSel.value, from_id: fromInput.value.trim(), to_type: toTypeSel.value, to_id: toInput.value.trim(),
            hops: hops.value, from: state.window.from, to: state.window.to, min_strength: String(state.minStrength),
          });
          const res = await api(`/api/path?${q}`);
          result.innerHTML = '';
          if (!res.found) {
            result.append(el('div', { class: 'banner warn' }, [el('span', { class: 'ico' }, '!'), `在 ${res.searched_hops} 跳内未找到 ${shortId(res.start)} → ${shortId(res.goal)} 的路径。可尝试放宽时间窗口或降低强度阈值。`]));
            return;
          }
          result.append(
            el('div', { class: 'path-summary' }, [
              el('b', {}, `${res.hops} 跳 · 置信度 ${(res.confidence * 100).toFixed(0)}%`),
              el('div', { class: 'small', style: 'color:var(--text-2)' }, `最弱一步 ${res.weakest.toFixed(2)} · 图 v${res.graph_version}`),
            ]),
            el('div', { class: 'path-steps' }, res.steps.map((s, i) => el('div', { class: 'path-step' }, [
              el('div', { class: 'h' }, [
                el('span', { class: 'idx' }, String(i + 1)),
                el('span', { class: 'mono small' }, `${shortId(s.from)} → ${shortId(s.to)}`),
                el('span', { class: 'strength' }, s.edge.strength.toFixed(2)),
              ]),
              el('div', { class: 'meta' }, [
                el('span', {}, EDGE_LABEL[s.edge.edge_type] || s.edge.edge_type),
                el('span', {}, `${s.edge.txn_count} 笔 · ${cny(s.edge.amount_cents)}`),
                el('span', {}, `${s.edge.day_count} 天`),
                el('span', { class: 'linkish', onclick: () => { closeModals(); selectEdge(s.edge); } }, '查看证据'),
              ]),
            ]))),
          );
        } catch (err) {
          toast(err.message, 'error');
        } finally { btn.disabled = false; btn.textContent = '寻找路径'; }
      }),
    }, '寻找路径'),
  ];
  modal({ title: '路径分析', sub: '时间窗口内的最少跳数关系链', body, foot });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModals(); $('#search-results')?.classList.add('hidden'); }
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
    e.preventDefault();
    $('#search')?.focus();
  }
});

window.addEventListener('resize', () => {
  if (state.graph) renderGraph(state.graph);
});

boot();
