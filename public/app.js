// 前端：无框架，纯 ES Module + 手写渲染
// 结构 1:1 对齐参考产品的内部界面（实测数值）
const state = {
  user: null,
  folder: 'INBOX',
  messages: [],
  selected: null,
  selectedMsg: null,
  folders: [],
  view: 'mail', // mail | settings | admin | aliases
  adminTab: 'overview',
  search: '',
  filter: null, // null | unread | flagged | attach
  compose: null,
  composeMask: null,
  attachments: [],
  mailbox: null,
  mailboxes: [],
  page: 1,
  pageSize: 30,
  refs: {},
};

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- DOM ----------
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
};

function toast(text) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = h('div', { class: 'toast' });
    document.body.append(t);
  }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

const p2 = (n) => String(n).padStart(2, '0');

// ---------- 复制 ----------
async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// 复制按钮：点击后短暂变对勾
function copyBtn(getText, { title = '复制邮箱地址', cls = 'copy-btn', size = 13 } = {}) {
  const btn = h('button', { class: cls, type: 'button', title, html: icon('copy', size) });
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    const text = typeof getText === 'function' ? getText() : getText;
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return toast('复制失败');
    btn.innerHTML = icon('check', size);
    btn.classList.add('copied');
    toast(`已复制 ${text}`);
    setTimeout(() => {
      btn.innerHTML = icon('copy', size);
      btn.classList.remove('copied');
    }, 1400);
  });
  return btn;
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// 参考站列表时间格式：当天 HH:mm，同年 MM/DD HH:mm
function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
}

function fmtFull(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// ---------- 图标 ----------
const ICONS = {
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  queue: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  pen: '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
  pen2: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  mailbox: '<path d="M22 17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.5C2 7.57 3.57 6 5.5 6H18a4 4 0 0 1 4 4z"/><path d="M6 11h4"/><path d="M6 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  reply: '<path d="M20 18v-2a4 4 0 0 0-4-4H4"/><path d="m9 17-5-5 5-5"/>',
  forward: '<path d="M4 18v-2a4 4 0 0 1 4-4h12"/><path d="m15 7 5 5-5 5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  layout: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  chevronsLeft: '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
};

function icon(name, size = 16, cls = '') {
  const path = ICONS[name] || ICONS.folder;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${path}</svg>`;
}

const MAIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';

// 侧栏文件夹（对齐参考站顺序与文案）
const FOLDERS = [
  { key: 'INBOX', label: '收件箱', icon: 'inbox' },
  { key: 'INBOX', label: '星标邮件', icon: 'star', filter: 'flagged' },
  { key: 'Sent', label: '已发送', icon: 'send' },
  { key: 'Drafts', label: '草稿箱', icon: 'file' },
  { key: 'Archive', label: '归档', icon: 'archive' },
  { key: 'Junk', label: '垃圾邮件', icon: 'alert' },
  { key: 'Trash', label: '回收站', icon: 'trash' },
];

const TAGS = [
  { name: '工作', color: 'rgb(34,195,77)' },
  { name: '订阅', color: 'rgb(195,99,34)' },
  { name: '账单', color: 'rgb(34,195,69)' },
];

function initial(name, addr) {
  const src = (name || addr || '?').trim();
  return src.charAt(0).toUpperCase();
}

function counterpartName(m) {
  if (state.folder === 'Sent' || state.folder === 'Drafts') {
    return (m.to || '').split(',')[0]?.trim() || '（无收件人）';
  }
  return m.fromName || m.from || '(未知)';
}
function counterpartAddr(m) {
  if (state.folder === 'Sent' || state.folder === 'Drafts') return (m.to || '').split(',')[0]?.trim() || '';
  return m.from || '';
}

// ============ 登录页 ============
function renderAuth() {
  const app = document.getElementById('app');
  app.replaceChildren();

  const err = h('div', { class: 'msg err' });
  const email = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com', autocomplete: 'username' });
  const pass = h('input', { class: 'input', type: 'password', placeholder: '密码', autocomplete: 'current-password' });

  const submit = async () => {
    err.classList.remove('show');
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { email: email.value.trim(), password: pass.value } });
      state.user = r.user;
      await boot();
    } catch (e) {
      err.textContent = e.message;
      err.classList.add('show');
    }
  };

  email.addEventListener('keydown', (e) => { if (e.key === 'Enter') pass.focus(); });
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  app.append(
    h('div', { class: 'auth-wrap' },
      h('div', { class: 'auth-card' },
        h('div', { class: 'auth-logo', html: MAIL_SVG }),
        h('h1', { text: '登录邮箱' }),
        h('p', { class: 'sub', text: '使用你的域名邮箱账号登录' }),
        err,
        h('div', { class: 'field' }, h('label', { text: '邮箱地址' }), email),
        h('div', { class: 'field' }, h('label', { text: '密码' }), pass),
        h('button', { class: 'btn primary', onClick: submit }, '登录'),
      ),
    ),
  );
  setTimeout(() => email.focus(), 50);
}

// ============ 外壳 ============
function renderShell() {
  const app = document.getElementById('app');
  app.replaceChildren();

  const search = h('input', {
    type: 'search', placeholder: '搜索邮件…', value: state.search,
    onKeydown: (e) => {
      if (e.key === 'Enter') { state.search = search.value; state.page = 1; loadMessages(); }
    },
  });

  const topbar = h('header', { class: 'topbar' },
    h('button', {
      class: 'icon-btn topbar-menu', type: 'button', title: '菜单',
      html: icon('menu', 20),
      onClick: () => toggleDrawer(),
    }),
    h('div', { class: 'topbar-brand' },
      h('span', { class: 'logo', html: MAIL_SVG }),
      h('span', { class: 'topbar-title', text: '域名邮箱' }),
    ),
    h('div', { class: 'topbar-search' },
      h('span', { class: 'ico', html: icon('search', 16) }),
      search,
    ),
    h('div', { class: 'topbar-right' },
      h('div', { class: 'topbar-user' },
        h('span', { class: 'topbar-avatar', text: initial(state.user?.displayName, state.user?.email) }),
        h('span', { class: 'topbar-name', text: state.user?.displayName || (state.user?.email || '').split('@')[0] }),
      ),
      h('button', { class: 'topbar-lang', type: 'button', html: `${icon('globe', 14)}<span>简体中文</span>` }),
      h('button', { class: 'icon-btn topbar-settings', type: 'button', title: '设置', html: icon('settings', 16), onClick: () => go('settings') }),
    ),
  );

  const folderList = h('ul', { class: 'folder-list' });
  const tagList = h('ul', { class: 'folder-list' });
  const foot = h('div', { class: 'sidebar-foot' });
  const switcher = h('div', { class: 'mailbox-switcher', id: 'mailbox-switcher' });

  const sideScroll = h('div', { class: 'side-scroll' },
    h('div', { class: 'folder-group' },
      h('div', { class: 'folder-group-head' },
        h('div', { class: 'folder-group-title', text: '邮件夹' }),
        h('button', { class: 'icon-btn', type: 'button', title: '新建文件夹', html: icon('plus', 14) }),
      ),
      folderList,
      h('div', { class: 'group-divider' }),
    ),
    h('div', { class: 'folder-group' },
      h('div', { class: 'folder-group-head' },
        h('div', { class: 'folder-group-title', text: '标签' }),
        h('div', { style: 'display:flex;gap:2px' },
          h('button', { class: 'icon-btn', type: 'button', html: icon('minus', 14) }),
          h('button', { class: 'icon-btn', type: 'button', html: icon('plus', 14) }),
        ),
      ),
      tagList,
    ),
  );

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'side-head' },
      switcher,
      h('button', { class: 'compose-btn', onClick: () => openCompose() },
        h('span', { html: icon('pen2', 16) }), h('span', { text: '写邮件' })),
    ),
    sideScroll,
    foot,
    h('div', { class: 'sidebar-collapse' },
      h('button', { class: 'foot-btn', type: 'button' },
        h('span', { html: icon('chevronsLeft', 16) }), h('span', { text: '收起侧栏' })),
    ),
  );

  const toolbar = h('div', { class: 'toolbar' });
  const filterBar = h('div', { class: 'filter-bar' });
  const listPane = h('div', { class: 'list-pane' });
  const readPane = h('div', { class: 'read-pane' });
  const content = h('div', { class: 'content' }, listPane, h('div', { class: 'panel-sep v' }), readPane);
  const main = h('main', { class: 'main' }, toolbar, filterBar, content);
  const body = h('div', { class: 'body' }, sidebar, h('div', { class: 'panel-sep' }), main);
  const scrim = h('div', { class: 'side-scrim', onClick: () => closeDrawer() });

  app.append(h('div', { class: 'app' }, topbar, body, scrim));

  state.refs = { ...state.refs, folderList, tagList, foot, toolbar, filterBar, listPane, readPane, content, topbar, search, sidebar, main };

  renderMailboxSwitcher();
  renderFolders();
  renderTags();
  renderFoot();
  renderMobileBar();
  renderView();
}

function go(view) {
  state.view = view;
  state.selected = null;
  state.selectedMsg = null;
  closeDrawer();
  renderView();
  renderFolders();
  renderMobileBar();
}

// ---------- 移动端抽屉 ----------
function isMobile() {
  return window.matchMedia('(max-width: 860px)').matches;
}

function toggleDrawer() {
  const app = document.querySelector('.app');
  if (!app) return;
  app.classList.toggle('drawer-open');
  document.body.classList.toggle('drawer-locked', app.classList.contains('drawer-open'));
}

function closeDrawer() {
  document.querySelector('.app')?.classList.remove('drawer-open');
  document.body.classList.remove('drawer-locked');
}

// 邮箱地址节点：单行 14px 显示
function addrNode(address) {
  const s = String(address || '');
  return h('span', { class: 'mb-addr', title: s, text: s });
}

// ---------- 邮箱切换器 ----------
async function renderMailboxSwitcher() {
  const box = document.getElementById('mailbox-switcher');
  if (!box) return;
  let data;
  try { data = await api('/api/mailboxes'); } catch { box.replaceChildren(); return; }
  state.mailboxes = data.mailboxes || [];

  const current = state.mailbox || state.user?.email || data.current;
  const cur = state.mailboxes.find((m) => m.address === current) || state.mailboxes[0] || { address: state.user?.email };

  // 身份卡：完整地址换行显示 + 复制按钮 + 展开箭头
  // 身份卡：完整地址 + 右侧箭头/复制共用槽位
  const label = h('div', { class: 'mb-current', title: cur.address },
    h('span', { class: 'mb-icon', html: icon('mailbox', 14) }),
    h('span', { class: 'mb-label' }, addrNode(cur.address)),
    h('span', { class: 'mb-arrow', html: icon('chevronDown', 14) }),
    copyBtn(() => cur.address, { title: '复制邮箱地址', cls: 'mb-copy', size: 12 }),
  );

  const menu = h('div', { class: 'mb-menu' });
  const renderMenu = () => {
    menu.replaceChildren(
      ...state.mailboxes.map((m) => h('div', {
        class: `mb-item ${m.address === current ? 'on' : ''}`,
        onClick: () => switchMailbox(m.address),
      },
        h('span', { class: 'mb-badge', text: m.type === 'primary' ? '主' : '别名' }),
        addrNode(m.address),
        m.unread > 0 ? h('span', { class: 'mb-unread', text: String(m.unread) }) : null,
        copyBtn(() => m.address, { title: '复制', cls: 'mb-item-copy', size: 13 }),
      )),
      h('div', { class: 'mb-manage', onClick: () => { menu.classList.remove('open'); go('aliases'); } },
        state.mailboxes.length > 1 ? '管理邮箱地址 →' : '+ 新建邮箱地址'),
    );
  };

  label.addEventListener('click', (e) => {
    if (e.target.closest('.mb-copy')) return;
    e.stopPropagation();
    renderMenu();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', () => menu.classList.remove('open'), { once: true });

  box.replaceChildren(label, menu);
}

// 移动端底栏的「写信」按钮
function renderMobileBar() {
  const app = document.querySelector('.app');
  if (!app) return;
  app.querySelector('.mobile-bar')?.remove();
  const active = (v) => (state.view === v ? ' on' : '');
  const bar = h('nav', { class: 'mobile-bar' },
    h('button', {
      class: `mb-tab${active('mail')}`, type: 'button', html: `${icon('inbox', 20)}<span>邮件</span>`,
      onClick: () => { state.view = 'mail'; closeDrawer(); renderView(); renderFolders(); renderMobileBar(); },
    }),
    h('button', {
      class: 'mb-tab mb-tab-compose', type: 'button', html: `${icon('pen2', 20)}<span>写信</span>`,
      onClick: () => openCompose(),
    }),
    h('button', {
      class: `mb-tab${active('aliases')}`, type: 'button', html: `${icon('mailbox', 20)}<span>邮箱</span>`,
      onClick: () => { go('aliases'); renderMobileBar(); },
    }),
    h('button', {
      class: `mb-tab${active('settings')}`, type: 'button', html: `${icon('settings', 20)}<span>设置</span>`,
      onClick: () => { go('settings'); renderMobileBar(); },
    }),
  );
  app.append(bar);
}

async function switchMailbox(address) {
  const primary = state.mailboxes.find((m) => m.type === 'primary')?.address;
  state.mailbox = address === primary ? null : address;
  state.selected = null;
  state.selectedMsg = null;
  state.messages = [];
  state.search = '';
  state.page = 1;
  state.view = 'mail';
  document.querySelector('.mb-menu')?.classList.remove('open');
  await renderMailboxSwitcher();
  renderView();
  renderFolders();
  await loadMessages();
  toast(`已切换到 ${address}`);
}

// ---------- 文件夹 ----------
function renderFolders() {
  const list = state.refs.folderList;
  if (!list) return;
  list.replaceChildren(...FOLDERS.map((f) => {
    const cnt = f.filter ? 0 : (state.folders.find((x) => x.name === f.key)?.unread || 0);
    const on = state.view === 'mail' && state.folder === f.key && (state.filter || null) === (f.filter || null);
    return h('li', {},
      h('button', {
        class: `folder ${on ? 'on' : ''}`, type: 'button',
        onClick: () => {
          state.view = 'mail';
          state.folder = f.key;
          state.filter = f.filter || null;
          state.selected = null;
          state.selectedMsg = null;
          state.page = 1;
          closeDrawer();
          renderView();
          renderFolders();
          loadMessages();
        },
      },
        h('span', { html: icon(f.icon, 16) }),
        h('span', { class: 'name', text: f.label }),
        cnt > 0 ? h('span', { class: 'count', text: String(cnt) }) : null,
      ),
    );
  }));
}

function renderTags() {
  const list = state.refs.tagList;
  if (!list) return;
  list.replaceChildren(...TAGS.map((t) => h('li', {},
    h('button', { class: 'folder', type: 'button' },
      h('span', { class: 'folder-dot', style: `background:${t.color}` }),
      h('span', { class: 'name', text: t.name }),
    ),
  )));
}

// ---------- 侧栏底部 ----------
function renderFoot() {
  const foot = state.refs.foot;
  if (!foot) return;
  const quotaMb = state.user?.quotaMb || 1024;
  const used = state.user?.usedMb ?? 0;
  const pct = Math.min(100, (used / quotaMb) * 100);
  const quotaText = quotaMb >= 1024 ? `${(quotaMb / 1024).toFixed(1)} GB` : `${quotaMb} MB`;

  foot.replaceChildren(
    h('div', {},
      h('div', { class: 'foot-quota' },
        h('span', { text: '邮箱容量' }),
        h('span', { class: 'used', text: `${used.toFixed(1)} MB / ${quotaText}` }),
      ),
      h('div', { class: 'foot-bar' }, h('i', { style: `width:${pct}%` })),
    ),
    h('button', { class: 'foot-btn', type: 'button', onClick: () => go('aliases') },
      h('span', { html: icon('mailbox', 16) }), h('span', { text: '我的邮箱' })),
    state.user?.isAdmin
      ? h('button', { class: 'foot-btn', type: 'button', onClick: () => go('admin') },
        h('span', { html: icon('shield', 16) }), h('span', { text: '管理后台' }))
      : null,
    h('button', {
      class: 'foot-btn', type: 'button',
      onClick: async () => {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        location.reload();
      },
    }, h('span', { html: icon('power', 16) }), h('span', { text: '退出登录' })),
  );
}

// ---------- 视图分发 ----------
function renderView() {
  const { toolbar, filterBar, listPane, readPane, content } = state.refs;
  if (!toolbar) return;

  if (state.view === 'mail') {
    content.classList.toggle('reading', !!state.selected);
    filterBar.style.display = '';
    readPane.style.display = '';
    listPane.style.display = '';
    content.querySelector('.page-host')?.remove();
    renderMailToolbar();
    renderFilterBar();
    renderList();
    renderReader();
    return;
  }

  filterBar.style.display = 'none';
  readPane.style.display = 'none';
  listPane.style.display = 'none';
  content.classList.remove('reading');

  let host = content.querySelector('.page-host');
  if (!host) {
    host = h('div', { class: 'page-host', style: 'flex:1 1 0;min-width:0;display:flex;flex-direction:column;overflow:hidden' });
    content.append(host);
  }
  const page = h('div', { class: 'page' });
  host.replaceChildren(page);

  if (state.view === 'settings') renderSettings(toolbar, page);
  else if (state.view === 'admin') renderAdmin(toolbar, page);
  else if (state.view === 'aliases') renderAliasPage(toolbar, page);
}

// ---------- 工具栏 ----------
function renderMailToolbar() {
  const { toolbar } = state.refs;
  const unread = state.folders.find((f) => f.name === state.folder)?.unread || 0;
  const label = FOLDERS.find((f) => f.key === state.folder && (f.filter || null) === (state.filter || null))?.label
    || FOLDERS.find((f) => f.key === state.folder)?.label || '收件箱';

  toolbar.replaceChildren(
    h('div', { class: 'toolbar-left' },
      h('h1', { text: label }),
      unread > 0 ? h('span', { class: 'badge-unread', text: `${unread} 封未读` }) : null,
    ),
    h('div', { class: 'toolbar-right' },
      h('button', { class: 'icon-btn', type: 'button', title: '刷新', html: icon('refresh', 16), onClick: () => loadMessages() }),
      h('button', {
        class: 'toolbar-btn', type: 'button',
        onClick: () => { state.selected = null; state.selectedMsg = null; renderReader(); renderList(); },
      }, h('span', { html: icon('layout', 14) }), h('span', { text: '阅读布局' })),
      h('button', { class: 'icon-btn', type: 'button', title: '更多', html: icon('more', 16) }),
    ),
  );
  toolbar.style.display = '';
}

function renderFilterBar() {
  const { filterBar } = state.refs;
  filterBar.style.display = '';
  const chips = [
    { key: null, label: '全部邮件' },
    { key: 'unread', label: '未读邮件' },
    { key: 'flagged', label: '星标邮件' },
    { key: 'attach', label: '有附件' },
  ];
  filterBar.replaceChildren(
    h('div', { class: 'filter-check' }, h('input', { type: 'checkbox', title: '全选' })),
    ...chips.map((c) => h('button', {
      class: `chip ${state.filter === c.key ? 'on' : ''}`, type: 'button',
      onClick: () => { state.filter = c.key; state.page = 1; renderFilterBar(); renderFolders(); loadMessages(); },
    }, c.label)),
  );
}

// ---------- 列表 ----------
async function loadMessages() {
  if (state.view !== 'mail') return;
  const q = new URLSearchParams({ folder: state.folder, limit: String(state.pageSize * state.page) });
  if (state.search) q.set('q', state.search);
  if (state.filter === 'unread') q.set('unread', '1');
  if (state.mailbox) q.set('mailbox', state.mailbox);
  try {
    const r = await api(`/api/messages?${q}`);
    state.messages = r.messages || [];
  } catch {
    state.messages = [];
  }
  try {
    const f = await api('/api/folders');
    state.folders = f.folders || [];
  } catch {}
  renderFolders();
  renderMailToolbar();
  renderList();
}

function renderList() {
  const { listPane } = state.refs;
  const all = state.messages;
  const total = all.length;
  const start = (state.page - 1) * state.pageSize;
  const rows = all.slice(start, start + state.pageSize);
  const pages = Math.max(1, Math.ceil(total / state.pageSize));

  const scroll = h('div', { class: 'list-scroll' });

  if (!rows.length) {
    scroll.append(h('div', { class: 'empty' },
      h('div', { class: 'box', html: icon('inbox', 24) }),
      h('span', { text: state.search ? '没有匹配的邮件' : '该筛选下没有邮件' }),
    ));
  } else {
    for (const m of rows) {
      const unread = !m.seen;
      const row = h('div', {
        class: `mail-item ${state.selected === m.id ? 'on' : ''}`,
        onClick: () => openMessage(m.id),
      },
        h('input', { class: 'mi-check', type: 'checkbox', onClick: (e) => e.stopPropagation() }),
        h('span', { class: 'mi-avatar', text: initial(counterpartName(m), counterpartAddr(m)) }),
        h('div', { class: 'mi-copy' },
          h('div', { class: 'mi-top' },
            h('span', { class: 'mi-from', text: counterpartName(m) }),
            h('span', { class: 'mi-time', text: fmtTime(m.date) }),
          ),
          h('div', { class: 'mi-sub-line' },
            h('span', { class: 'mi-sub', text: m.subject || '（无主题）' }),
          ),
          h('div', { class: 'mi-snip', text: m.snippet || '' }),
        ),
        h('span', { class: `mi-dot ${unread ? 'on' : ''}` }),
        h('button', {
          class: `mi-star ${m.flagged ? 'on' : ''}`, type: 'button', title: '星标',
          html: icon('star', 15),
          onClick: async (e) => {
            e.stopPropagation();
            const on = !m.flagged;
            await api(`/api/messages/${m.id}/flags`, {
              method: 'POST',
              body: { add: on ? ['\\Flagged'] : [], remove: on ? [] : ['\\Flagged'] },
            });
            m.flagged = on;
            e.currentTarget.classList.toggle('on', on);
          },
        }),
      );
      scroll.append(row);
    }
  }

  const foot = h('div', { class: 'list-foot' },
    h('div', { class: 'range', text: total ? `${start + 1}–${Math.min(start + state.pageSize, total)} / ${total}` : '0 / 0' }),
    h('div', { class: 'pager' },
      h('span', { class: 'lbl', text: '每页' }),
      h('select', {
        onChange: (e) => { state.pageSize = Number(e.target.value); state.page = 1; renderList(); },
      }, ...[30, 50, 100].map((n) => h('option', { value: String(n), selected: n === state.pageSize }, String(n)))),
      h('button', {
        class: 'pg', type: 'button', disabled: state.page <= 1, html: icon('chevronLeft', 14),
        onClick: () => { state.page = Math.max(1, state.page - 1); renderList(); },
      }),
      h('span', { class: 'num', text: `${state.page} / ${pages}` }),
      h('button', {
        class: 'pg', type: 'button', disabled: state.page >= pages, html: icon('chevronRight', 14),
        onClick: () => { state.page = Math.min(pages, state.page + 1); renderList(); },
      }),
    ),
  );

  listPane.replaceChildren(scroll, foot);
}

// ---------- 阅读 ----------
async function openMessage(id) {
  state.selected = id;
  state.view = 'mail';
  state.refs.content.classList.add('reading');
  renderList();
  // 手机上先切到阅读视图，让用户看到加载反馈
  if (isMobile()) {
    const { readPane } = state.refs;
    if (readPane) {
      readPane.style.display = '';
      readPane.replaceChildren(h('div', { class: 'reader-empty' },
        h('div', { class: 'box', html: icon('inbox', 28) }),
        h('p', { text: '加载中…' }),
      ));
    }
    window.scrollTo(0, 0);
  }
  try {
    const r = await api(`/api/messages/${id}`);
    state.selectedMsg = r;
  } catch (e) {
    toast(e.message);
    return;
  }
  renderReader();
  loadMessages();
}

function renderReader() {
  const { readPane } = state.refs;
  if (!readPane) return;
  readPane.style.display = '';
  const m = state.selectedMsg;

  if (!state.selected || !m) {
    readPane.replaceChildren(h('div', { class: 'reader-empty' },
      h('div', { class: 'box', html: icon('inbox', 32) }),
      h('p', { text: '选择一封邮件查看内容' }),
    ));
    return;
  }

  const back = () => {
    state.selected = null;
    state.selectedMsg = null;
    state.refs.content.classList.remove('reading');
    renderReader();
    renderList();
  };

  const toolbar = h('div', { class: 'reader-toolbar' },
    h('div', { class: 'grp' },
      h('button', { class: 'icon-btn', type: 'button', title: '返回', html: icon('chevronLeft', 16), onClick: back }),
      h('div', { class: 'divider' }),
      h('button', { class: 'icon-btn', type: 'button', title: '回复', html: icon('reply', 16), onClick: () => openCompose({ to: m.from, subject: `Re: ${m.subject || ''}` }) }),
      h('button', { class: 'icon-btn', type: 'button', title: '转发', html: icon('forward', 16), onClick: () => openCompose({ subject: `Fwd: ${m.subject || ''}`, body: `\n\n---------- 转发邮件 ----------\n${m.text || ''}` }) }),
    ),
    h('div', { class: 'grp' },
      h('button', {
        class: 'icon-btn', type: 'button', title: '星标', html: icon('star', 16),
        onClick: async () => {
          const on = !m.flagged;
          await api(`/api/messages/${m.id}/flags`, {
            method: 'POST',
            body: { add: on ? ['\\Flagged'] : [], remove: on ? [] : ['\\Flagged'] },
          });
          m.flagged = on;
          renderReader();
          loadMessages();
        },
      }),
      h('button', {
        class: 'icon-btn', type: 'button', title: '删除', html: icon('trash', 16),
        onClick: async () => {
          await api(`/api/messages/${m.id}`, { method: 'DELETE' });
          back();
        },
      }),
    ),
  );

  const toList = (m.to || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ccList = (m.cc || '').split(',').map((s) => s.trim()).filter(Boolean);

  const heading = h('div', { class: 'reader-heading' },
    h('h2', { class: 'reader-subject', text: m.subject || '（无主题）' }),
    h('div', { class: 'reader-meta' },
      h('div', { class: 'reader-from-line' },
        h('span', { class: 'reader-avatar', text: initial(m.fromName, m.from) }),
        h('div', { class: 'reader-from-main' },
          h('div', { class: 'reader-from-row' },
            h('span', { class: 'reader-from-name' },
              h('span', { text: m.fromName || m.from || '' }),
              h('span', { class: 'reader-from-addr', text: `<${m.from || ''}>` }),
            ),
            h('span', { class: 'reader-when', text: fmtFull(m.date) }),
          ),
          h('div', { class: 'reader-grid' },
            h('div', { class: 'k', text: '收件人' }),
            h('div', { class: 'v' },
              h('div', { class: 'reader-chips' },
                ...toList.map((a) => h('span', { class: 'reader-chip' }, h('span', { class: 'txt', text: a }))),
              ),
            ),
            ccList.length ? h('div', { class: 'k', text: '抄送' }) : null,
            ccList.length ? h('div', { class: 'v' },
              h('div', { class: 'reader-chips' },
                ...ccList.map((a) => h('span', { class: 'reader-chip' }, h('span', { class: 'txt', text: a }))),
              ),
            ) : null,
          ),
          h('div', { class: 'reader-links' },
            h('button', { class: 'link-btn', type: 'button', html: `邮件详情 ${icon('chevronDown', 14)}` }),
            h('a', { class: 'link-btn', href: `/api/messages/${m.id}/raw`, html: `显示原始邮件 ${icon('chevronRight', 14)}` }),
          ),
        ),
      ),
    ),
  );

  const body = h('div', { class: 'reader-content' });
  if (m.html) body.innerHTML = m.html;
  else body.append(h('div', { style: 'white-space:pre-wrap', text: m.text || '' }));

  const atts = m.attachments || [];
  if (atts.length) {
    body.append(h('div', { style: 'margin-top:24px;padding-top:16px;border-top:1px solid var(--line)' },
      h('div', { style: 'margin-bottom:10px;font-size:12px;color:var(--muted)', text: `${atts.length} 个附件` }),
      ...atts.map((a) => h('a', {
        class: 'att-chip', href: `/api/attachments/${a.id}`, style: 'margin-right:8px;margin-bottom:8px',
      },
        h('span', { html: icon('paperclip', 13) }),
        h('span', { text: a.filename }),
        h('span', { style: 'color:var(--muted)', text: fmtSize(a.size) }),
      )),
    ));
  }

  const actions = h('div', { class: 'reader-actions' },
    h('button', { class: 'btn', type: 'button', onClick: () => openCompose({ to: m.from, subject: `Re: ${m.subject || ''}` }) },
      h('span', { html: icon('reply', 15) }), h('span', { text: '回复' })),
    h('button', { class: 'btn', type: 'button', onClick: () => openCompose({ subject: `Fwd: ${m.subject || ''}`, body: `\n\n---------- 转发邮件 ----------\n${m.text || ''}` }) },
      h('span', { html: icon('forward', 15) }), h('span', { text: '转发' })),
  );

  readPane.replaceChildren(toolbar, h('div', { class: 'reader-scroll' }, heading, body), actions);
}

// ---------- 写信 ----------
function openCompose(prefill = {}) {
  closeCompose();
  const senders = [state.user?.email, ...state.mailboxes.filter((m) => m.type === 'alias').map((m) => m.address)].filter(Boolean);

  const from = h('input', { type: 'text', value: prefill.from || state.mailbox || state.user?.email || '', list: 'sender-list' });
  const to = h('input', { type: 'text', value: prefill.to || '', placeholder: 'recipient@example.com' });
  const cc = h('input', { type: 'text', value: prefill.cc || '', placeholder: '抄送地址' });
  const subject = h('input', { type: 'text', value: prefill.subject || '', placeholder: '邮件主题' });
  const text = h('textarea', { class: 'compose-editor', placeholder: '写点什么…' });
  text.value = prefill.body || '';

  const ccRow = h('div', { class: 'compose-row', style: 'display:none' },
    h('label', { text: '抄　送' }),
    h('div', { class: 'field' }, cc),
  );

  const attachRow = h('div', { class: 'compose-attach' });
  state.attachments = [];

  const fileInput = h('input', { type: 'file', multiple: true, style: 'display:none' });
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) {
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      state.attachments.push({ filename: f.name, mime: f.type || 'application/octet-stream', content: btoa(bin), size: f.size });
    }
    renderAtt();
    fileInput.value = '';
  });

  function renderAtt() {
    attachRow.replaceChildren(...state.attachments.map((a, i) => h('span', { class: 'att-chip' },
      h('span', { html: icon('paperclip', 13) }),
      h('span', { text: a.filename }),
      h('span', { style: 'color:var(--muted)', text: fmtSize(a.size) }),
      h('button', { type: 'button', html: icon('close', 13), onClick: () => { state.attachments.splice(i, 1); renderAtt(); } }),
    )));
  }

  const doSend = async () => {
    const toArr = to.value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    if (!toArr.length) return toast('请填写收件人');
    const btn = box.querySelector('.compose-foot .btn.dark');
    if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
    try {
      await api('/api/send', {
        method: 'POST',
        body: {
          from: from.value.trim(),
          to: toArr.join(','),
          cc: cc.value,
          subject: subject.value,
          text: text.value,
          attachments: state.attachments,
        },
      });
      closeCompose();
      toast('已发送');
      loadMessages();
    } catch (e) {
      toast(e.message);
      if (btn) { btn.disabled = false; btn.textContent = '发送'; }
    }
  };

  const mask = h('div', { class: 'compose-mask', onClick: closeCompose });

  const box = h('div', { class: 'compose' },
    h('div', { class: 'compose-head' },
      h('h2', { text: '写信' }),
      h('button', { class: 'icon-btn', type: 'button', html: icon('close', 16), onClick: closeCompose }),
    ),
    h('div', { class: 'compose-rows' },
      h('div', { class: 'compose-row' },
        h('label', { text: '发件邮箱' }),
        h('div', { class: 'field' }, from,
          h('datalist', { id: 'sender-list' }, ...senders.map((s) => h('option', { value: s })))),
      ),
      h('div', { class: 'compose-row' },
        h('label', { text: '收件人' }),
        h('div', { class: 'field' }, to,
          h('button', { class: 'mini', type: 'button', onClick: () => { ccRow.style.display = 'flex'; } }, '抄送'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox' }), h('span', { text: '分别发送' })),
        ),
      ),
      ccRow,
      h('div', { class: 'compose-row compose-subject' },
        h('label', { text: '主　题' }),
        h('div', { class: 'field' }, subject),
      ),
    ),
    h('div', { class: 'compose-toolbar' },
      h('button', { class: 'icon-btn', type: 'button', title: '附件', html: icon('paperclip', 16), onClick: () => fileInput.click() }),
      h('button', { class: 'icon-btn', type: 'button', title: '插入链接', html: icon('globe', 16) }),
      h('button', { class: 'icon-btn', type: 'button', title: '插入图片', html: icon('eye', 16) }),
      fileInput,
    ),
    text,
    attachRow,
    h('div', { class: 'compose-foot' },
      h('span', { class: 'left', text: `发件人：${from.value}` }),
      h('button', { class: 'btn', type: 'button', onClick: closeCompose }, '取消'),
      h('button', { class: 'btn dark', type: 'button', onClick: doSend },
        h('span', { html: icon('send', 15) }), h('span', { text: '发送' })),
    ),
  );

  state.composeMask = mask;
  state.compose = box;
  document.body.append(mask, box);
  setTimeout(() => (prefill.to ? subject : to).focus(), 60);

  const esc = (e) => {
    if (e.key === 'Escape') { closeCompose(); document.removeEventListener('keydown', esc); }
  };
  document.addEventListener('keydown', esc);
}

function closeCompose() {
  state.composeMask?.remove();
  state.compose?.remove();
  state.composeMask = null;
  state.compose = null;
}

// ---------- 设置页 ----------
async function renderSettings(toolbar, page) {
  toolbar.replaceChildren(
    h('div', { class: 'toolbar-left' }, h('h1', { text: '设置' })),
    h('div', { class: 'toolbar-right' },
      h('button', { class: 'toolbar-btn', type: 'button', onClick: () => go('mail') }, '返回邮箱')),
  );
  toolbar.style.display = '';

  page.replaceChildren(h('div', { class: 'empty' }, h('span', { text: '加载中…' })));

  let s;
  try { s = await api('/api/settings'); } catch (e) {
    page.replaceChildren(h('div', { class: 'empty' }, h('span', { text: e.message })));
    return;
  }

  const displayName = h('input', { class: 'input', value: s.user?.displayName || '' });

  const fwdEnabled = h('input', { type: 'checkbox', checked: !!s.forward?.active });
  const fwdAddr = h('input', { class: 'input', value: s.forward?.target || '', placeholder: 'forward@example.com' });
  const fwdKeep = h('input', { type: 'checkbox', checked: s.forward?.keep_copy !== 0 });

  const arEnabled = h('input', { type: 'checkbox', checked: !!s.autoresponder?.active });
  const arSubject = h('input', { class: 'input', value: s.autoresponder?.subject || '' });
  const arBody = h('textarea', { class: 'input', rows: '4' });
  arBody.value = s.autoresponder?.body || '';

  const oldPass = h('input', { class: 'input', type: 'password' });
  const newPass = h('input', { class: 'input', type: 'password' });

  page.replaceChildren(
    h('h2', { text: '账号设置' }),
    h('p', { class: 'sub', text: s.user?.email || '' }),

    h('div', { class: 'card' },
      h('h3', {}, '个人资料'),
      h('div', { class: 'field-row' }, h('label', { text: '邮箱' }), h('div', { class: 'grow' }, h('input', { class: 'input', value: s.user?.email || '', disabled: true }))),
      h('div', { class: 'field-row' }, h('label', { text: '显示名' }), h('div', { class: 'grow' }, displayName)),
      h('div', { class: 'field-row' }, h('label', { text: '容量' }), h('div', { class: 'grow' }, h('span', { class: 'pill', text: `${s.quotaMb || 0} MB` }))),
      h('div', { class: 'field-row' }, h('label', {}), h('div', { class: 'grow' },
        h('button', {
          class: 'btn sm primary', type: 'button',
          onClick: async () => {
            await api('/api/settings/profile', { method: 'POST', body: { displayName: displayName.value } });
            state.user.displayName = displayName.value;
            toast('已保存');
          },
        }, '保存'))),
    ),

    h('div', { class: 'card' },
      h('h3', {}, '邮件转发'),
      h('div', { class: 'field-row' }, h('label', { text: '启用' }), h('div', { class: 'grow' }, fwdEnabled)),
      h('div', { class: 'field-row' }, h('label', { text: '转发到' }), h('div', { class: 'grow' }, fwdAddr)),
      h('div', { class: 'field-row' }, h('label', { text: '保留副本' }), h('div', { class: 'grow' }, fwdKeep)),
      h('div', { class: 'field-row' }, h('label', {}), h('div', { class: 'grow' },
        h('button', {
          class: 'btn sm primary', type: 'button',
          onClick: async () => {
            try {
              await api('/api/settings/forward', {
                method: 'POST',
                body: { target: fwdEnabled.checked ? fwdAddr.value.trim() : '', keepCopy: fwdKeep.checked },
              });
              toast('已保存');
            } catch (e) { toast(e.message); }
          },
        }, '保存'))),
    ),

    h('div', { class: 'card' },
      h('h3', {}, '自动回复'),
      h('div', { class: 'field-row' }, h('label', { text: '启用' }), h('div', { class: 'grow' }, arEnabled)),
      h('div', { class: 'field-row' }, h('label', { text: '主题' }), h('div', { class: 'grow' }, arSubject)),
      h('div', { class: 'field-row' }, h('label', { text: '正文' }), h('div', { class: 'grow' }, arBody)),
      h('div', { class: 'field-row' }, h('label', {}), h('div', { class: 'grow' },
        h('button', {
          class: 'btn sm primary', type: 'button',
          onClick: async () => {
            await api('/api/settings/autoresponder', {
              method: 'POST',
              body: { active: arEnabled.checked, subject: arSubject.value, body: arBody.value },
            });
            toast('已保存');
          },
        }, '保存'))),
    ),

    h('div', { class: 'card' },
      h('h3', {}, '修改密码'),
      h('div', { class: 'field-row' }, h('label', { text: '当前密码' }), h('div', { class: 'grow' }, oldPass)),
      h('div', { class: 'field-row' }, h('label', { text: '新密码' }), h('div', { class: 'grow' }, newPass)),
      h('div', { class: 'field-row' }, h('label', {}), h('div', { class: 'grow' },
        h('button', {
          class: 'btn sm primary', type: 'button',
          onClick: async () => {
            try {
              await api('/api/auth/password', { method: 'POST', body: { oldPassword: oldPass.value, newPassword: newPass.value } });
              oldPass.value = '';
              newPass.value = '';
              toast('密码已修改');
            } catch (e) { toast(e.message); }
          },
        }, '修改'))),
    ),

    h('div', { class: 'card' },
      h('h3', {}, '客户端配置', h('span', { class: 'hint', text: 'IMAP / SMTP' })),
      h('div', { class: 'field-row' }, h('label', { text: 'IMAP' }), h('div', { class: 'grow' }, h('input', { class: 'input', value: `${s.imap?.host || location.hostname}:${s.imap?.port || 993}（SSL）`, disabled: true }))),
      h('div', { class: 'field-row' }, h('label', { text: 'SMTP' }), h('div', { class: 'grow' }, h('input', { class: 'input', value: `${s.smtp?.host || location.hostname}:${s.smtp?.port || 587}（STARTTLS）`, disabled: true }))),
    ),
  );
}

// ---------- 我的邮箱（别名）页 ----------
async function renderAliasPage(toolbar, page) {
  toolbar.replaceChildren(
    h('div', { class: 'toolbar-left' }, h('h1', { text: '我的邮箱' })),
    h('div', { class: 'toolbar-right' },
      h('button', { class: 'toolbar-btn', type: 'button', onClick: () => go('mail') }, '返回邮箱')),
  );
  toolbar.style.display = '';
  page.replaceChildren(h('div', { class: 'empty' }, h('span', { text: '加载中…' })));

  let data;
  try { data = await api('/api/aliases'); } catch (e) {
    page.replaceChildren(h('div', { class: 'empty' }, h('span', { text: e.message })));
    return;
  }
  const list = data.aliases || [];
  const domains = data.domains || [];

  const input = h('input', { class: 'input', placeholder: '新邮箱前缀，如 sales' });
  const dom = h('select', { class: 'input', style: 'max-width:180px' },
    ...domains.map((d) => h('option', { value: d }, d)));

  const add = async () => {
    const prefix = input.value.trim();
    if (!prefix) return toast('请输入前缀');
    try {
      await api('/api/aliases', { method: 'POST', body: { prefix, domain: dom.value } });
      input.value = '';
      toast('已创建');
      renderAliasPage(toolbar, page);
      renderMailboxSwitcher();
    } catch (e) { toast(e.message); }
  };

  page.replaceChildren(
    h('h2', { text: '我的邮箱' }),
    h('p', { class: 'sub', text: '同一账号下可创建多个邮箱地址，共用收件箱' }),
    h('div', { class: 'card' },
      h('h3', {}, `共 ${list.length + 1} 个地址`),
      h('div', { class: 'mailbox-list' },
        h('div', { class: 'mailbox-row' },
          h('span', { class: 'mailbox-row-icon', html: icon('mailbox', 18) }),
          h('div', { class: 'main-col' },
            h('div', { class: 'addr', text: state.user?.email || '' }),
            h('div', { class: 'meta', text: '主邮箱' }),
          ),
          h('span', { class: 'pill', text: '主' }),
        ),
        ...list.map((a) => h('div', { class: 'mailbox-row' },
          h('span', { class: 'mailbox-row-icon', html: icon('mailbox', 18) }),
          h('div', { class: 'main-col' },
            h('div', { class: 'addr', text: a.address }),
            h('div', { class: 'meta', text: a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '别名' }),
          ),
          h('span', { class: 'pill gray', text: '别名' }),
          h('button', {
            class: 'icon-btn', type: 'button', title: '删除', html: icon('trash', 15),
            onClick: async () => {
              await api(`/api/aliases/${a.id}`, { method: 'DELETE' });
              toast('已删除');
              renderAliasPage(toolbar, page);
              renderMailboxSwitcher();
            },
          }),
        )),
      ),
    ),
    h('div', { class: 'card' },
      h('h3', {}, '新建邮箱地址'),
      h('div', { class: 'field-row' },
        h('label', { text: '地址' }),
        h('div', { class: 'grow', style: 'display:flex;gap:8px' }, input, dom,
          h('button', { class: 'btn sm primary', type: 'button', onClick: add }, '创建')),
      ),
    ),
  );
}

// ---------- 管理后台 ----------
async function renderAdmin(toolbar, page) {
  toolbar.replaceChildren(
    h('div', { class: 'toolbar-left' }, h('h1', { text: '管理后台' })),
    h('div', { class: 'toolbar-right' },
      h('button', { class: 'toolbar-btn', type: 'button', onClick: () => go('mail') }, '返回邮箱')),
  );
  toolbar.style.display = '';

  const tabs = [
    { k: 'overview', l: '概览' },
    { k: 'domains', l: '域名' },
    { k: 'users', l: '账号' },
    { k: 'aliases', l: '别名' },
    { k: 'outbox', l: '队列' },
    { k: 'audit', l: '审计' },
  ];

  const body = h('div', {});
  page.replaceChildren(
    h('h2', { text: '管理后台' }),
    h('p', { class: 'sub', text: '域名、账号、别名与投递队列' }),
    h('div', { class: 'tabs' }, ...tabs.map((t) => h('button', {
      class: `tab ${state.adminTab === t.k ? 'on' : ''}`, type: 'button', text: t.l,
      onClick: () => { state.adminTab = t.k; renderAdmin(toolbar, page); },
    }))),
    body,
  );

  const tab = state.adminTab;

  if (tab === 'overview') {
    let st;
    try { st = await api('/api/admin/stats'); } catch (e) {
      body.append(h('div', { class: 'empty' }, h('span', { text: e.message })));
      return;
    }
    const ob = st.outbox || {};
    body.append(h('div', { class: 'card' },
      h('h3', {}, '系统概览'),
      h('div', { class: 'field-row' }, h('label', { text: '账号' }), h('div', { class: 'grow' }, h('span', { text: String(st.users) }))),
      h('div', { class: 'field-row' }, h('label', { text: '域名' }), h('div', { class: 'grow' }, h('span', { text: String(st.domains) }))),
      h('div', { class: 'field-row' }, h('label', { text: '邮件' }), h('div', { class: 'grow' }, h('span', { text: String(st.messages) }))),
      h('div', { class: 'field-row' }, h('label', { text: '存储' }), h('div', { class: 'grow' }, h('span', { text: `${st.storageMb} MB` }))),
      h('div', { class: 'field-row' }, h('label', { text: '今日' }), h('div', { class: 'grow' }, h('span', { text: `${st.todayMessages} 封` }))),
      h('div', { class: 'field-row' }, h('label', { text: '队列' }), h('div', { class: 'grow' }, h('span', { text: `待发 ${ob.queued ?? 0} / 已发 ${ob.sent ?? 0} / 失败 ${ob.failed ?? 0}` }))),
    ));
    return;
  }

  if (tab === 'domains') {
    let d;
    try { d = await api('/api/admin/domains'); } catch (e) {
      body.append(h('div', { class: 'empty' }, h('span', { text: e.message })));
      return;
    }
    const rows = (d.domains || []).map((x) => h('tr', {},
      h('td', { class: 'mono', text: x.name }),
      h('td', {}, h('span', { class: `pill ${x.active ? 'green' : 'gray'}`, text: x.active ? '启用' : '停用' })),
      h('td', { text: x.catch_all ? '是' : '否' }),
      h('td', { text: x.dkim_enabled ? '已签名' : '未签名' }),
      h('td', { class: 'act' },
        h('button', {
          class: 'link-btn sm', type: 'button', text: 'DNS',
          onClick: async () => {
            const r = await api(`/api/admin/domains/${x.id}/dns`);
            const txt = (r.records || []).map((z) => `${z.type}\t${z.name}\t${z.value}`).join('\n');
            const ta = h('textarea', { class: 'input', rows: '12' });
            ta.value = txt;
            body.prepend(h('div', { class: 'card' }, h('h3', {}, `${x.name} DNS 记录`), ta));
          },
        }),
      ),
    ));
    body.append(h('div', { class: 'card' },
      h('h3', {}, '域名列表'),
      h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {},
          h('th', { text: '域名' }), h('th', { text: '状态' }), h('th', { text: '全收' }),
          h('th', { text: 'DKIM' }), h('th', { text: '操作' }))),
        h('tbody', {}, ...rows),
      ),
    ));
    return;
  }

  if (tab === 'users') {
    let u;
    try { u = await api('/api/admin/users'); } catch (e) {
      body.append(h('div', { class: 'empty' }, h('span', { text: e.message })));
      return;
    }
    const rows = (u.users || []).map((x) => h('tr', {},
      h('td', { class: 'mono', text: x.email }),
      h('td', { text: x.displayName || '' }),
      h('td', {}, h('span', { class: `pill ${x.isAdmin ? '' : 'gray'}`, text: x.isAdmin ? '管理员' : '用户' })),
      h('td', { text: `${x.quotaMb} MB` }),
      h('td', { text: x.createdAt ? new Date(x.createdAt).toLocaleDateString() : '' }),
    ));
    body.append(h('div', { class: 'card' },
      h('h3', {}, '账号列表'),
      h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {},
          h('th', { text: '邮箱' }), h('th', { text: '显示名' }), h('th', { text: '角色' }),
          h('th', { text: '配额' }), h('th', { text: '创建' }))),
        h('tbody', {}, ...rows),
      ),
    ));
    return;
  }

  if (tab === 'aliases') {
    let a;
    try { a = await api('/api/admin/aliases'); } catch (e) {
      body.append(h('div', { class: 'empty' }, h('span', { text: e.message })));
      return;
    }
    const rows = (a.aliases || []).map((x) => h('tr', {},
      h('td', { class: 'mono', text: x.address }),
      h('td', { class: 'mono', text: (x.targets || []).join(', ') }),
      h('td', {}, h('span', { class: `pill ${x.active ? 'green' : 'gray'}`, text: x.active ? '启用' : '停用' })),
    ));
    body.append(h('div', { class: 'card' },
      h('h3', {}, '别名列表'),
      h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {},
          h('th', { text: '地址' }), h('th', { text: '目标' }), h('th', { text: '状态' }))),
        h('tbody', {}, ...rows),
      ),
    ));
    return;
  }

  if (tab === 'outbox') {
    let o;
    try { o = await api('/api/admin/outbox'); } catch (e) {
      body.append(h('div', { class: 'empty' }, h('span', { text: e.message })));
      return;
    }
    const rows = (o.queue || []).map((x) => h('tr', {},
      h('td', { class: 'mono', text: x.mail_from || '' }),
      h('td', { class: 'mono', text: x.rcpt_to || '' }),
      h('td', {}, h('span', { class: `pill ${x.status === 'sent' ? 'green' : x.status === 'failed' ? 'red' : 'gray'}`, text: x.status })),
      h('td', { text: String(x.attempts ?? 0) }),
      h('td', { style: 'max-width:280px;overflow:hidden;text-overflow:ellipsis', text: x.last_error || '' }),
      h('td', { class: 'act' },
        h('button', {
          class: 'link-btn sm', type: 'button', text: '重试',
          onClick: async () => {
            await api(`/api/admin/outbox/${x.id}/retry`, { method: 'POST' });
            toast('已加入重试');
            renderAdmin(toolbar, page);
          },
        }),
      ),
    ));
    body.append(h('div', { class: 'card' },
      h('h3', {}, '投递队列'),
      h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {},
          h('th', { text: '发件' }), h('th', { text: '收件' }), h('th', { text: '状态' }),
          h('th', { text: '尝试' }), h('th', { text: '错误' }), h('th', { text: '操作' }))),
        h('tbody', {}, ...rows),
      ),
    ));
    return;
  }

  if (tab === 'audit') {
    let a;
    try { a = await api('/api/admin/audit'); } catch (e) {
      body.append(h('div', { class: 'empty' }, h('span', { text: e.message })));
      return;
    }
    const rows = (a.audit || []).map((x) => h('tr', {},
      h('td', { text: x.at ? new Date(x.at).toLocaleString() : '' }),
      h('td', { text: x.actor || '' }),
      h('td', { text: x.action || '' }),
      h('td', { class: 'mono', text: x.detail || '' }),
    ));
    body.append(h('div', { class: 'card' },
      h('h3', {}, '审计日志'),
      h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {},
          h('th', { text: '时间' }), h('th', { text: '操作者' }), h('th', { text: '动作' }), h('th', { text: '详情' }))),
        h('tbody', {}, ...rows),
      ),
    ));
  }
}

// ---------- 启动 ----------
async function boot() {
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
  } catch {
    renderAuth();
    return;
  }
  state.folders = (await api('/api/folders').catch(() => ({ folders: [] }))).folders || [];
  try {
    const s = await api('/api/settings');
    state.user.usedMb = s.usedMb ?? 0;
    state.user.quotaMb = s.quotaMb ?? state.user.quotaMb;
  } catch {}
  renderShell();
  await loadMessages();
  renderReader();
}

boot();
