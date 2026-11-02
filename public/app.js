// 前端：无框架，纯 ES Module + 手写渲染
const state = {
  user: null,
  folder: 'INBOX',
  messages: [],
  selected: null,
  folders: [],
  view: 'mail', // mail | settings | admin | aliases
  adminTab: 'overview',
  search: '',
  filter: null, // all | unread | flagged | attach
  compose: null,
  composeMask: null,
  attachments: [],
  // 当前使用的邮箱身份（主邮箱或别名），null = 主邮箱
  mailbox: null,
  mailboxes: [],
  aliasOpen: true,
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

// ---------- DOM 工具 ----------
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

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const p = (n) => String(n).padStart(2, '0');
  if (sameDay) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtFull(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const FOLDER_LABEL = {
  INBOX: '收件箱', Sent: '已发送', Drafts: '草稿箱', Trash: '垃圾箱', Junk: '垃圾邮件',
};

// 复制到剪贴板（带降级方案）
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
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

// 复制按钮：点击后图标短暂变对勾
function copyBtn(getText, { title = '复制', cls = 'copy-btn', size = 12 } = {}) {
  const btn = h('button', { class: cls, title, type: 'button', html: icon('copy', size) });
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    const text = typeof getText === 'function' ? getText() : getText;
    if (!text) return;
    const ok = await copyText(text);
    if (ok) {
      btn.innerHTML = icon('check', size);
      btn.classList.add('copied');
      toast(`已复制 ${text}`);
      setTimeout(() => {
        btn.innerHTML = icon('copy', size);
        btn.classList.remove('copied');
      }, 1400);
    } else {
      toast('复制失败，请手动选择');
    }
  });
  return btn;
}

// ---------- 线性图标（Lucide 风格，1.75 描边，currentColor）----------
const ICONS = {
  inbox: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M22 7 13.03 12.7a2 2 0 0 1-2.06 0L2 7"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  pen: '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
  mailbox: '<path d="M22 17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.5C2 7.57 3.57 6 5.5 6H18a4 4 0 0 1 4 4z"/><path d="M6 11h4"/><path d="M6 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  reply: '<path d="M20 18v-2a4 4 0 0 0-4-4H4"/><path d="m9 17-5-5 5-5"/>',
  forward: '<path d="M4 18v-2a4 4 0 0 1 4-4h12"/><path d="m15 7 5 5-5 5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  inboxEmpty: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  infinity: '<path d="M6 16c5 0 7-8 12-8a4 4 0 0 1 0 8c-5 0-7-8-12-8a4 4 0 1 0 0 8"/>',
  swap: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  minus: '<path d="M5 12h14"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
};

// 生成内联 SVG 图标
function icon(name, size = 16, cls = '') {
  const path = ICONS[name] || ICONS.folder;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${path}</svg>`;
}

const FOLDER_ICON = {
  INBOX: 'inbox', Sent: 'send', Drafts: 'file', Trash: 'trash', Junk: 'alert',
};

// 首字头像：shadcn 风格统一使用 muted 灰，不抢视觉
function avatarColor() {
  return 'hsl(var(--muted))';
}
function avatarInitial(name, addr) {
  const src = (name || addr || '?').trim();
  return src.charAt(0).toUpperCase();
}

// 列表行里显示的对方名字
function counterpartName(m) {
  const f = state.folder;
  if (f === 'Sent' || f === 'Drafts') return m.to?.split(',')[0]?.trim() || '（无收件人）';
  return m.fromName || m.from || '(未知)';
}
function counterpartAddr(m) {
  const f = state.folder;
  if (f === 'Sent' || f === 'Drafts') return m.to?.split(',')[0]?.trim() || '';
  return m.from || '';
}

const MAIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';

function renderAuth(mode = 'login') {
  const app = document.getElementById('app');
  app.replaceChildren();

  const errBox = h('div', { class: 'msg err' });
  const okBox = h('div', { class: 'msg ok' });

  const emailInput = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'username' });
  const passInput = h('input', { type: 'password', placeholder: '密码', autocomplete: 'current-password' });
  const nameInput = h('input', { type: 'text', placeholder: '显示名（可选）' });

  const submit = async () => {
    errBox.classList.remove('show');
    okBox.classList.remove('show');
    try {
      if (mode === 'login') {
        const r = await api('/api/auth/login', {
          method: 'POST',
          body: { email: emailInput.value.trim(), password: passInput.value },
        });
        state.user = r.user;
        await boot();
      } else {
        await api('/api/auth/register', {
          method: 'POST',
          body: { email: emailInput.value.trim(), password: passInput.value, displayName: nameInput.value },
        });
        toast('注册成功');
        await boot();
      }
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.add('show');
    }
  };

  passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  // 轮播文案（参考 参考实现）
  const SLIDES = [
    { l1: '让沟通，', l2: '简单一点。', domain: '发送、收信，都在一个页面。' },
    { l1: '邮件有序，', l2: '查找更轻松。', domain: '全文搜索，附件直达。' },
    { l1: '一个账户，', l2: '管理多个邮箱。', domain: '无限别名，随时切换身份。' },
  ];
  let slideIdx = 0;
  const h1l1 = h('span', { class: 'l1', text: SLIDES[0].l1 });
  const h1l2 = h('span', { class: 'l2', text: SLIDES[0].l2 });
  const domainNote = h('span', { text: SLIDES[0].domain });
  let slideTimer = null;

  const startSlides = () => {
    clearInterval(slideTimer);
    slideTimer = setInterval(() => {
      slideIdx = (slideIdx + 1) % SLIDES.length;
      const s = SLIDES[slideIdx];
      h1l1.textContent = s.l1;
      h1l2.textContent = s.l2;
      domainNote.textContent = s.domain;
    }, 4000);
  };
  startSlides();

  const logoEl = h('span', { class: 'portal-logo', html: MAIL_SVG });
  const brandName = h('span', { text: '域名邮箱' });

  const card = h('div', { class: 'login-card' },
    h('h1', { text: mode === 'login' ? '登录邮箱' : '注册账号' }),
    h('div', { class: 'sub', text: mode === 'login' ? '使用你的邮箱地址登录' : '创建新的邮箱账号' }),
    h('div', { class: 'login-tabs' },
      h('button', { class: mode === 'login' ? 'on' : '', onClick: () => { clearInterval(slideTimer); renderAuth('login'); startSlides(); } }, '登录'),
      h('button', { class: mode === 'register' ? 'on' : '', onClick: () => { clearInterval(slideTimer); renderAuth('register'); startSlides(); } }, '注册'),
    ),
    errBox, okBox,
    h('div', { class: 'field' }, h('label', { text: '邮箱地址' }), emailInput),
    h('div', { class: 'field' }, h('label', { text: '密码' }), passInput),
    mode === 'register' ? h('div', { class: 'field' }, h('label', { text: '显示名' }), nameInput) : null,
    h('button', { class: 'btn primary block', onClick: submit }, mode === 'login' ? '登录' : '创建账号'),
  );

  const root = h('div', { class: 'portal' },
    h('header', { class: 'portal-header' },
      h('div', { class: 'portal-brand' }, logoEl, brandName),
    ),
    h('main', { class: 'portal-main' },
      h('section', { class: 'portal-hero' },
        h('div', { class: 'portal-tag' }, h('span', { class: 'line' }), h('span', { text: 'DOMAIN MAIL' })),
        h('h1', { class: 'portal-h1' }, h1l1, h1l2),
        h('div', { class: 'portal-domain' }, domainNote),
        h('div', { class: 'portal-features' },
          h('div', { class: 'portal-feature' }, h('span', { class: 'fi', html: icon('infinity', 15) }), h('span', { text: '无限别名地址' })),
          h('div', { class: 'portal-feature' }, h('span', { class: 'fi', html: icon('swap', 15) }), h('span', { text: '多身份一键切换' })),
          h('div', { class: 'portal-feature' }, h('span', { class: 'fi', html: icon('shield', 15) }), h('span', { text: 'DKIM 签名直达收件箱' })),
        ),
      ),
      card,
    ),
    h('footer', { class: 'portal-footer' }, '© 2026 域名邮箱 · 自建邮件服务'),
  );

  app.append(root);
  setTimeout(() => emailInput.focus(), 50);
}

// ---------- 主框架 ----------
function renderShell() {
  const app = document.getElementById('app');
  app.replaceChildren();

  const folderList = h('div', { class: 'folder-list' });
  const aliasPanel = h('div', { class: 'alias-panel' });
  const foot = h('div', { class: 'sidebar-foot' });

  // 顶栏搜索（参考实现: 64px 通栏，含品牌 + 搜索 + 用户）
  const topSearch = h('input', {
    type: 'search', placeholder: '搜索邮件…', value: state.search,
    onKeydown: (e) => {
      if (e.key === 'Enter') { state.search = topSearch.value; loadMessages(); }
    },
  });
  state.refs = state.refs || {};
  state.refs.topSearch = topSearch;

  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-brand' },
      h('span', { class: 'logo', html: MAIL_SVG }),
      h('span', { text: '域名邮箱' }),
    ),
    h('div', { class: 'topbar-search' },
      h('span', { class: 'ico', html: icon('search', 16) }), topSearch,
    ),
    h('div', { class: 'topbar-right' },
      h('span', { class: 'topbar-avatar', text: (state.user?.email || '?').slice(0, 1).toUpperCase() }),
      h('span', { class: 'topbar-user', text: (state.user?.email || '').split('@')[0] }),
      h('button', { class: 'topbar-lang', type: 'button' },
        h('span', { class: 'foot-ico', html: icon('globe', 14) }),
        h('span', { text: '简体中文' }),
      ),
    ),
  );

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'side-head' },
      h('div', { class: 'mailbox-switcher', id: 'mailbox-switcher' }),
      h('button', { class: 'compose-btn', onClick: () => openCompose() },
        h('span', { class: 'ico', html: icon('pen', 15) }), h('span', { class: 'txt', text: '写邮件' })),
    ),
    folderList,
    aliasPanel,
    foot,
  );

  const toolbar = h('div', { class: 'toolbar' });
  const content = h('div', { class: 'content' });
  const main = h('main', { class: 'main' }, toolbar, content);
  const body = h('div', { class: 'body' }, sidebar, h('div', { class: 'panel-sep' }), main);

  app.append(h('div', { class: 'shell' }, topbar, body));

  state.refs = { ...state.refs, folderList, aliasPanel, foot, toolbar, content, topbar };
  renderMailboxSwitcher();
  renderFolders();
  renderAliasPanel();
  renderFoot();
  renderView();
}

// ---------- 邮箱切换器 ----------
async function renderMailboxSwitcher() {
  const box = document.getElementById('mailbox-switcher');
  if (!box) return;

  let data;
  try {
    data = await api('/api/mailboxes');
  } catch {
    box.replaceChildren();
    return;
  }
  state.mailboxes = data.mailboxes || [];

  const current = state.mailbox || state.user?.email || data.current;
  const cur = state.mailboxes.find((m) => m.address === current) || state.mailboxes[0];
  const isPrimary = cur?.type === 'primary';

  const label = h('div', { class: 'mb-current', title: cur?.address || '' },
    h('div', { class: 'mb-label' },
      h('span', { class: 'mb-addr', text: cur?.address || '' }),
    ),
    copyBtn(() => cur?.address, { title: '复制邮箱地址', cls: 'mb-copy', size: 12 }),
    h('span', { class: 'mb-arrow', html: icon('chevronDown', 14) }),
  );

  const menu = h('div', { class: 'mb-menu' });
  menu.style.display = 'none';

  const renderMenu = () => {
    menu.replaceChildren(
      ...state.mailboxes.map((m) =>
        h('div', {
          class: `mb-item ${m.address === current ? 'on' : ''}`,
          onClick: () => switchMailbox(m.address),
        },
          h('span', { class: 'mb-badge', text: m.type === 'primary' ? '主' : '别名' }),
          h('span', { class: 'mb-addr', text: m.address }),
          m.unread > 0 ? h('span', { class: 'mb-unread', text: String(m.unread) }) : null,
          copyBtn(() => m.address, { title: '复制', cls: 'mb-item-copy', size: 12 }),
        )
      ),
      state.mailboxes.length > 1
        ? h('div', {
            class: 'mb-manage',
            onClick: () => { state.view = 'aliases'; renderView(); renderFolders(); menu.style.display = 'none'; },
          }, '管理邮箱地址 →')
        : h('div', {
            class: 'mb-manage',
            onClick: () => { state.view = 'aliases'; renderView(); renderFolders(); menu.style.display = 'none'; },
          }, '+ 新建邮箱地址'),
    );
  };

  label.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.style.display === 'none';
    renderMenu();
    menu.style.display = open ? 'block' : 'none';
  });

  const closeMenu = () => { menu.style.display = 'none'; };
  document.addEventListener('click', closeMenu, { once: true });

  box.replaceChildren(label, menu);
}

async function switchMailbox(address) {
  const primary = state.mailboxes.find((m) => m.type === 'primary')?.address;
  state.mailbox = address === primary ? null : address;
  state.selected = null;
  state.messages = [];
  state.search = '';
  state.view = 'mail';

  const menu = document.querySelector('.mb-menu');
  if (menu) menu.style.display = 'none';

  await renderMailboxSwitcher();
  await renderFolders();
  renderView();
  toast(`已切换到 ${address}`);
}

// ---------- 侧边栏：我的邮箱地址（无限邮箱） ----------
async function renderAliasPanel() {
  const { aliasPanel } = state.refs;
  if (!aliasPanel) return;

  let data;
  try {
    data = await api('/api/aliases');
  } catch {
    aliasPanel.replaceChildren();
    return;
  }

  const open = state.aliasOpen !== false;
  const head = h('div', {
    class: 'alias-head',
    onClick: () => { state.aliasOpen = !open; renderAliasPanel(); },
  },
    h('span', { class: 'alias-title', text: '我的邮箱' }),
    h('span', { class: 'alias-count', text: String(data.total) }),
    h('span', { class: 'alias-caret', html: icon(open ? 'chevronDown' : 'chevronRight', 13) }),
  );

  if (!open) {
    aliasPanel.replaceChildren(head);
    return;
  }

  const quickInput = h('input', {
    class: 'alias-quick-input',
    placeholder: '输入前缀，回车创建',
  });

  const doQuick = async () => {
    const prefix = quickInput.value.trim();
    if (!prefix) return;
    try {
      const r = await api('/api/aliases', { method: 'POST', body: { prefix } });
      quickInput.value = '';
      toast(`已创建 ${r.alias.address}`);
      await renderAliasPanel();
    } catch (e) { toast(e.message); }
  };

  quickInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doQuick(); });

  const items = data.aliases.slice(0, 6).map((a) =>
    h('div', { class: 'alias-item', title: a.address },
      h('span', { class: 'alias-dot' }),
      h('span', { class: 'alias-addr', text: a.address.split('@')[0] }),
      copyBtn(() => a.address, { title: '复制完整地址', cls: 'alias-copy', size: 12 }),
      h('button', {
        class: 'alias-del',
        title: '删除',
        html: icon('trash', 12),
        onClick: async (e) => {
          e.stopPropagation();
          if (!confirm(`删除 ${a.address}？`)) return;
          await api(`/api/aliases/${a.id}`, { method: 'DELETE' });
          toast('已删除');
          await renderAliasPanel();
        },
      }),
    )
  );

  aliasPanel.replaceChildren(
    head,
    h('div', { class: 'alias-body' },
      h('div', { class: 'alias-quick' },
        quickInput,
        h('button', { class: 'alias-add-btn', title: '创建', html: icon('plus', 14), onClick: doQuick }),
      ),
      data.total > 0
        ? h('div', { class: 'alias-list' }, ...items)
        : h('div', { class: 'alias-empty', text: '还没有额外地址' }),
      data.total > 6
        ? h('div', { class: 'alias-hint', text: `还有 ${data.total - 6} 个地址` })
        : null,
      h('button', {
        class: 'alias-manage-btn',
        onClick: () => { state.view = 'aliases'; renderView(); renderFolders(); },
      },
        h('span', { class: 'alias-manage-ico', html: icon('settings', 13) }),
        h('span', { text: '管理 / 批量生成' }),
      ),
    ),
  );
}

async function renderFolders() {
  const { folderList } = state.refs;
  try {
    const q = state.mailbox ? `?mailbox=${encodeURIComponent(state.mailbox)}` : '';
    const r = await api('/api/folders' + q);
    state.folders = r.folders;
  } catch {
    state.folders = [];
  }

  const head = h('div', { class: 'folder-group-head' },
    h('span', { text: '邮件夹' }),
    h('span', { class: 'acts' },
      h('button', { class: 'act', type: 'button', title: '新建文件夹', html: icon('plus', 12) }),
    ),
  );

  folderList.replaceChildren(
    h('div', { class: 'folder-group' },
      head,
      ...state.folders.map((f) =>
        h('div', {
          class: `folder ${state.view === 'mail' && state.folder === f.name ? 'on' : ''}`,
          onClick: () => { state.view = 'mail'; state.folder = f.name; state.selected = null; renderView(); renderFolders(); },
        },
          h('span', { class: 'ico', html: icon(FOLDER_ICON[f.name] || 'folder', 16) }),
          h('span', { class: 'name', text: FOLDER_LABEL[f.name] || f.name }),
          f.unread > 0
            ? h('span', { class: 'badge', text: String(f.unread) })
            : f.total > 0 ? h('span', { class: 'cnt', text: String(f.total) }) : null,
        )
      ),
    ),
  );
}

function renderFoot() {
  const { foot } = state.refs;
  const email = state.user?.email || '';
  const initial = (email.split('@')[0] || '?').slice(0, 1).toUpperCase();
  const total = state.folders.reduce((n, f) => n + (f.total || 0), 0);

  foot.replaceChildren(
    h('div', { class: 'foot-row' },
      h('span', { text: '邮箱容量' }),
      h('span', { class: 'val', text: `${total} 封` }),
    ),
    h('div', { class: 'foot-bar' }, h('i', { style: 'width:12%' })),
    h('div', { class: 'me-card' },
      h('span', { class: 'me-avatar', text: initial }),
      h('span', { class: 'me-mail', text: email }),
      copyBtn(() => email, { title: '复制登录邮箱', cls: 'me-copy', size: 12 }),
    ),
    h('button', {
      class: 'foot-btn', type: 'button',
      onClick: () => { state.view = 'settings'; state.selected = null; renderView(); renderFolders(); },
    },
      h('span', { class: 'foot-ico', html: icon('settings', 14) }),
      h('span', { text: '设置' }),
    ),
    state.user?.isAdmin
      ? h('button', {
          class: 'foot-btn', type: 'button',
          onClick: () => { state.view = 'admin'; state.selected = null; renderView(); renderFolders(); },
        },
          h('span', { class: 'foot-ico', html: icon('shield', 14) }),
          h('span', { text: '管理后台' }),
        )
      : null,
    h('button', {
      class: 'foot-btn', type: 'button',
      onClick: async () => {
        await api('/api/auth/logout', { method: 'POST' });
        state.user = null;
        renderAuth('login');
      },
    },
      h('span', { class: 'foot-ico', html: icon('power', 14) }),
      h('span', { text: '退出登录' }),
    ),
  );
}

function renderView() {
  const { toolbar, content } = state.refs;
  toolbar.replaceChildren();
  content.replaceChildren();
  content.className = 'content';

  if (state.view === 'settings') return renderSettings(toolbar, content);
  if (state.view === 'admin') return renderAdmin(toolbar, content);
  if (state.view === 'aliases') return renderAliasView(toolbar, content);
  return renderMail(toolbar, content);
}

// ---------- 独立视图：邮箱地址管理 ----------
async function renderAliasView(toolbar, content) {
  toolbar.append(
    h('h2', { text: '我的邮箱地址' }),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => { state.view = 'mail'; renderView(); renderFolders(); } }, '返回邮箱'),
  );
  content.replaceChildren(h('div', { class: 'loading-row', text: '加载中…' }));

  const card = await renderAliasCard();
  content.replaceChildren(h('div', { class: 'admin' }, card));
}

// ---------- 邮件视图 ----------
function renderMail(toolbar, content) {
  const unread = state.messages.filter((m) => !m.seen).length;
  toolbar.replaceChildren(
    h('h2', { text: FOLDER_LABEL[state.folder] || state.folder }),
    h('span', { class: 'count', text: `${unread} 封未读` }),
    h('div', { class: 'spacer' }),
    h('div', { class: 'acts' },
      h('button', {
        class: 'icon-btn', title: '刷新', html: icon('refresh', 16),
        onClick: () => { loadMessages(); renderFolders(); },
      }),
      state.folder === 'Trash'
        ? h('button', {
            class: 'btn sm ghost', onClick: async () => {
              if (!confirm('清空垃圾箱？此操作不可恢复。')) return;
              await api(`/api/folders/${state.folder}/empty`, { method: 'POST' });
              toast('已清空');
              loadMessages();
              renderFolders();
            },
          }, '清空')
        : null,
      h('button', { class: 'btn sm ghost', title: '阅读布局' },
        h('span', { html: icon('layers', 14) }), h('span', { text: '阅读布局' })),
    ),
  );

  const list = h('div', { class: `list-pane ${state.selected ? 'with-read' : 'full'}` });
  const read = h('div', { class: 'read-pane' });
  if (state.selected) {
    content.append(list, h('div', { class: 'panel-sep v' }), read);
  } else {
    content.append(list, read);
  }
  state.refs.list = list;
  state.refs.read = read;
  state.refs.content = content;

  if (state.selected) content.classList.add('reading');
  loadMessages();
}

// 筛选胶囊（实测：h-28 / r=7px / 12px-500 / 激活 rgb(237,243,255) + rgb(29,78,216)）
function buildFilterBar() {
  const items = [
    { key: 'all', label: '全部邮件' },
    { key: 'unread', label: '未读邮件' },
    { key: 'flagged', label: '星标邮件' },
    { key: 'attach', label: '附件' },
  ];
  return h('div', { class: 'filter-bar' },
    ...items.map((f) =>
      h('button', {
        class: `chip ${(state.filter || 'all') === f.key ? 'on' : ''}`,
        onClick: () => {
          state.filter = f.key === 'all' ? null : f.key;
          renderList();
        },
      }, f.label)
    )
  );
}

async function loadMessages() {
  const list = state.refs.list;
  if (!list) return;
  list.replaceChildren(h('div', { class: 'loading-row', text: '加载中…' }));
  try {
    const q = new URLSearchParams({ folder: state.folder, limit: '100' });
    if (state.search) q.set('q', state.search);
    if (state.mailbox) q.set('mailbox', state.mailbox);
    const r = await api(`/api/messages?${q}`);
    state.messages = r.messages;
    renderList();
  } catch (e) {
    list.replaceChildren(h('div', { class: 'loading-row', text: `加载失败：${e.message}` }));
  }
}

function renderList() {
  const list = state.refs.list;
  if (!list) return;

  const rows = state.messages
    .filter((m) => {
      if (state.filter === 'unread') return !m.seen;
      if (state.filter === 'flagged') return m.flagged;
      if (state.filter === 'attach') return m.hasAttachment;
      return true;
    })
    .map((m) => {
      const who = counterpartName(m);
      const addr = counterpartAddr(m);
      const isSent = state.folder === 'Sent' || state.folder === 'Drafts';
      return h('div', {
        class: `mail-item ${m.seen ? '' : 'unread'} ${state.selected?.id === m.id ? 'on' : ''}`,
        onClick: () => openMessage(m.id),
      },
        h('div', { class: 'mi-avatar', text: avatarInitial(who, addr) }),
        h('div', { class: 'mi-main' },
          h('div', { class: 'mi-top' },
            h('span', { class: 'mi-from', title: addr, text: isSent ? `致 ${who}` : who }),
            h('span', { class: 'mi-time', text: fmtTime(m.date) }),
          ),
          h('div', { class: 'mi-sub', text: m.subject || '(无主题)' }),
          h('div', { class: 'mi-snip', text: m.snippet || '' }),
          (m.hasAttachment || m.spamScore >= 5)
            ? h('div', { class: 'mi-flags' },
                m.hasAttachment ? h('span', { class: 'mi-att', title: '附件', html: icon('paperclip', 11) }) : null,
                m.spamScore >= 5 ? h('span', { class: 'mi-tag-warn', text: '垃圾' }) : null,
              )
            : null,
        ),
        h('span', { class: 'mi-dot' }),
        h('button', {
          class: 'mi-tail', type: 'button',
          title: m.flagged ? '取消星标' : '加星标',
          html: icon('star', 14),
          style: m.flagged ? 'color:rgb(240,169,43)' : '',
          onClick: async (e) => {
            e.stopPropagation();
            const add = m.flagged ? [] : ['\\Flagged'];
            const del = m.flagged ? ['\\Flagged'] : [];
            await api(`/api/messages/${m.id}/flags`, { method: 'POST', body: { add, remove: del } });
            m.flagged = !m.flagged;
            renderList();
          },
        }),
      );
    });

  const footBar = h('div', { class: 'list-foot' },
    h('span', { class: 'l', text: `${rows.length} 封邮件` }),
    h('span', { class: 'r' },
      h('button', { class: 'icon-btn', type: 'button', title: '上一页', html: icon('chevronLeft', 14) }),
      h('span', { class: 'pg-num', text: '1 / 1' }),
      h('button', { class: 'icon-btn', type: 'button', title: '下一页', html: icon('chevronRight', 14) }),
    ),
  );

  if (!rows.length) {
    list.replaceChildren(
      buildFilterBar(),
      h('div', { class: 'empty', style: 'min-height:240px' },
        h('div', {},
          h('div', { class: 'empty-ico', html: icon(state.search ? 'search' : 'inboxEmpty', 34) }),
          h('div', { class: 'empty-txt', text: state.search ? '没有匹配的邮件' : (state.filter ? '该筛选下没有邮件' : '这个文件夹是空的') }),
        ),
      ),
    );
    return;
  }

  list.replaceChildren(buildFilterBar(), ...rows, footBar);
}

async function openMessage(id) {
  const read = state.refs.read;
  const list = state.refs.list;
  if (!read) return;
  read.replaceChildren(h('div', { class: 'loading-row', text: '加载中…' }));
  try {
    const m = await api(`/api/messages/${id}`);
    state.selected = m;
    if (list) { list.classList.remove('full'); list.classList.add('with-read'); }
    state.refs.content?.classList?.add?.('reading');
    const contentEl = read.parentElement;
    if (contentEl) contentEl.classList.add('reading');
    renderReader(m);
    const idx = state.messages.findIndex((x) => x.id === id);
    if (idx >= 0) state.messages[idx].seen = true;
    renderList();
    renderFolders();
  } catch (e) {
    read.replaceChildren(h('div', { class: 'empty', text: `加载失败：${e.message}` }));
  }
}

function renderReader(m) {
  const read = state.refs.read;
  read.replaceChildren();

  const isJunk = m.folder === 'Junk';
  const backBtn = h('button', {
    class: 'btn sm ghost', title: '返回列表',
    onClick: () => { state.selected = null; renderView(); renderFolders(); },
  }, '← 返回');

  // Postbox: .reader-toolbar 52px
  const readerBar = h('div', { class: 'reader-toolbar' },
    backBtn,
    h('button', {
      class: 'icon-btn', title: '回复', html: icon('reply', 16),
      onClick: () => openCompose({ to: m.from, subject: `Re: ${m.subject}`, inReplyTo: m.messageId }),
    }),
    h('button', {
      class: 'icon-btn', title: '转发', html: icon('forward', 16),
      onClick: () => openCompose({ to: m.from, subject: `Fwd: ${m.subject}`, text: `\n\n-------- 转发邮件 --------\n发件人: ${m.from}\n日期: ${fmtFull(m.date)}\n主题: ${m.subject}\n\n${m.text}` }),
    }),
    h('button', {
      class: 'icon-btn', title: '星标', html: icon('star', 16),
      onClick: async () => {
        await api(`/api/messages/${m.id}/flags`, { method: 'POST', body: { add: ['\\Flagged'] } });
        toast('已加星标'); loadMessages();
      },
    }),
    h('div', { class: 'spacer' }),
    isJunk
      ? h('button', {
          class: 'btn sm ghost', onClick: async () => {
            await api(`/api/messages/${m.id}/move`, { method: 'POST', body: { folder: 'INBOX' } });
            toast('已移到收件箱'); state.selected = null; renderView(); renderFolders();
          },
        }, '非垃圾')
      : null,
    h('a', { class: 'icon-btn', href: `/api/messages/${m.id}/raw`, download: '', title: '下载原文', html: icon('download', 16) }),
    m.folder !== 'Trash'
      ? h('button', {
          class: 'icon-btn', title: '移入回收站', html: icon('trash', 16), onClick: async () => {
            await api(`/api/messages/${m.id}/move`, { method: 'POST', body: { folder: 'Trash' } });
            toast('已移入回收站'); state.selected = null; renderView(); renderFolders();
          },
        })
      : h('button', {
          class: 'icon-btn', title: '彻底删除', html: icon('trash', 16), onClick: async () => {
            if (!confirm('彻底删除这封邮件？')) return;
            await api(`/api/messages/${m.id}`, { method: 'DELETE' });
            toast('已删除'); state.selected = null; renderView(); renderFolders();
          },
        }),
  );

  const initial = (m.fromName || m.from || '?').trim().charAt(0).toUpperCase();

  const scroll = h('div', { class: 'reader-scroll' });

  // heading（p 22px 26px + 底边框）
  const heading = h('div', { class: 'reader-heading' },
    h('h2', { class: 'reader-subject', text: m.subject || '(无主题)' }),
    h('div', { class: 'reader-meta' },
      h('div', { class: 'avatar', text: initial }),
      h('div', { class: 'reader-meta-text' },
        h('div', { class: 'reader-from' },
          h('strong', { text: m.fromName || m.from }),
          m.fromName ? h('span', { class: 'addr', text: `<${m.from}>` }) : null,
          copyBtn(() => m.from, { title: '复制发件人', cls: 'reader-copy', size: 12 }),
        ),
        h('div', { class: 'reader-to' },
          h('span', { text: `收件人: ${m.mailbox || m.to}${m.cc ? ` · 抄送: ${m.cc}` : ''}` }),
          copyBtn(() => (m.mailbox || m.to), { title: '复制收件地址', cls: 'reader-copy', size: 12 }),
        ),
      ),
      h('div', { class: 'reader-when', text: fmtFull(m.date) }),
    ),
  );
  scroll.append(heading);

  // content（p 26px）
  const contentBox = h('div', { class: 'reader-content' });
  const body = h('div', { class: 'read-body' });
  if (m.html) {
    const iframe = h('iframe', { sandbox: 'allow-same-origin' });
    iframe.srcdoc = `<!DOCTYPE html><meta charset="utf-8"><base target="_blank"><style>body{margin:0;font:16px/1.8 -apple-system,"Segoe UI","PingFang SC",sans-serif;color:rgb(52,64,84);word-break:break-word}img{max-width:100%;border-radius:8px}a{color:rgb(37,99,235)}blockquote{border-left:3px solid #e4e4e7;margin:1rem 0;padding-left:1rem;color:#71717a}</style>${m.html}`;
    iframe.onload = () => {
      try {
        const d = iframe.contentDocument;
        if (d) iframe.style.height = `${Math.min(Math.max(d.body.scrollHeight + 8, 120), 6000)}px`;
      } catch {}
    };
    body.append(iframe);
  } else {
    body.append(h('pre', { text: m.text || '(无正文)' }));
  }
  contentBox.append(body);

  if (m.attachments?.length) {
    contentBox.append(
      h('div', { class: 'att-list' },
        h('div', { style: 'font-size:12px;color:var(--muted);margin-bottom:10px', text: `附件 ${m.attachments.length} 个` }),
        ...m.attachments.map((a) =>
          h('a', { class: 'att-item', href: `/api/attachments/${a.id}`, download: a.filename },
            h('span', { class: 'att-ico', html: icon('paperclip', 13) }),
            h('span', { text: a.filename }),
            h('span', { class: 'sz', text: fmtSize(a.size) }),
          )
        ),
      )
    );
  }
  scroll.append(contentBox);

  // actions（p 12px 24px + 上边框）
  const actions = h('div', { class: 'reader-actions' },
    h('button', {
      class: 'btn primary sm', type: 'button',
      onClick: () => openCompose({ to: m.from, subject: `Re: ${m.subject}`, inReplyTo: m.messageId }),
    }, h('span', { html: icon('reply', 14) }), h('span', { text: '回复' })),
    h('button', {
      class: 'btn sm', type: 'button',
      onClick: () => openCompose({ to: m.from, subject: `Fwd: ${m.subject}`, text: `\n\n-------- 转发邮件 --------\n发件人: ${m.from}\n日期: ${fmtFull(m.date)}\n主题: ${m.subject}\n\n${m.text}` }),
    }, h('span', { html: icon('forward', 14) }), h('span', { text: '转发' })),
  );

  read.append(readerBar, scroll, actions);
}


function renderEmptyRead() {
  const read = state.refs.read;
  if (read) read.replaceChildren(h('div', { class: 'empty', text: '选择一封邮件查看' }));
}

// ---------- 写信 ----------
function openCompose(prefill = {}) {
  if (state.compose) state.compose.remove();
  state.attachments = [];

  const toInput = h('input', { placeholder: '收件人，多个用逗号分隔', value: prefill.to || '' });
  const ccInput = h('input', { placeholder: '抄送（可选）' });
  const subjInput = h('input', { placeholder: '主题', value: prefill.subject || '' });
  const bodyInput = h('textarea', { placeholder: '正文…', value: prefill.text || '' });
  const attBox = h('div');
  const errBox = h('div', { class: 'msg err' });
  const fileInput = h('input', { type: 'file', multiple: true, style: 'display:none' });

  const renderAtts = () => {
    attBox.replaceChildren(
      ...state.attachments.map((a, i) =>
        h('span', { class: 'att-chip' },
          h('span', { text: `${a.filename} (${fmtSize(a.size)})` }),
          h('button', { onClick: () => { state.attachments.splice(i, 1); renderAtts(); } }, '×'),
        )
      )
    );
  };

  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) {
      if (f.size > 15 * 1024 * 1024) { toast(`${f.name} 超过 15MB`); continue; }
      const buf = await f.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      state.attachments.push({ filename: f.name, mime: f.type || 'application/octet-stream', content: b64, size: f.size });
    }
    fileInput.value = '';
    renderAtts();
  });

  const sendBtn = h('button', {
    class: 'btn primary sm', onClick: async () => {
      errBox.classList.remove('show');
      if (!toInput.value.trim()) { errBox.textContent = '请填写收件人'; errBox.classList.add('show'); return; }
      sendBtn.disabled = true;
      sendBtn.textContent = '发送中…';
      try {
        const r = await api('/api/send', {
          method: 'POST',
          body: {
            to: toInput.value,
            cc: ccInput.value,
            subject: subjInput.value,
            text: bodyInput.value,
            attachments: state.attachments.map(({ filename, mime, content }) => ({ filename, mime, content })),
            inReplyTo: prefill.inReplyTo || '',
            from: state.mailbox || state.user?.email,
          },
        });
        toast(`已发送（本地 ${r.local}，队列 ${r.queued}）`);
        closeCompose();
        if (state.folder === 'Sent') loadMessages();
        renderFolders();
      } catch (e) {
        errBox.textContent = e.message;
        errBox.classList.add('show');
        sendBtn.disabled = false;
        sendBtn.textContent = '发送';
      }
    },
  }, '发送');

  const closeCompose = () => {
    state.compose?.remove();
    state.compose = null;
    state.composeMask?.remove();
    state.composeMask = null;
  };

  // 写信窗：1024×717 / r=16px / 居中 / 黑色遮罩
  const mask = h('div', { class: 'compose-mask', onClick: closeCompose });

  const box = h('div', { class: 'compose' },
    h('div', { class: 'compose-head' },
      h('h2', { text: prefill.inReplyTo ? '回复邮件' : '写邮件' }),
      h('button', { class: 'x', type: 'button', title: '关闭', html: icon('close', 16), onClick: closeCompose }),
    ),
    h('div', { class: 'compose-body' },
      errBox,
      h('div', { class: 'compose-row' }, h('label', { text: '收件人' }), toInput),
      h('div', { class: 'compose-row' }, h('label', { text: '抄送' }), ccInput),
      h('div', { class: 'compose-toolbar' },
        h('button', { class: 'icon-btn', type: 'button', title: '添加附件', html: icon('paperclip', 16), onClick: () => fileInput.click() }),
        fileInput,
        attBox,
      ),
      h('div', { class: 'compose-subject' }, subjInput),
      bodyInput,
    ),
    h('div', { class: 'compose-foot' },
      h('span', { class: 'hint', text: `发件人 ${state.mailbox || state.user?.email || ''}` }),
      h('button', { class: 'btn sm', type: 'button', onClick: closeCompose }, '取消'),
      sendBtn,
    ),
  );

  document.body.append(mask, box);
  state.compose = box;
  state.composeMask = mask;
  setTimeout(() => toInput.focus(), 50);
}

// ---------- 无限邮箱：别名管理卡片 ----------
async function renderAliasCard() {
  let data;
  try {
    data = await api('/api/aliases');
  } catch (e) {
    return h('div', { class: 'card' }, h('h3', { text: '我的邮箱地址' }), h('div', { text: `加载失败：${e.message}` }));
  }

  const listBox = h('div');
  const domainSelect = h('select');
  for (const d of data.domains) domainSelect.append(h('option', { value: d }, `@${d}`));
  const prefixInput = h('input', { placeholder: '前缀，例如 shop' });
  const countInput = h('input', { type: 'number', value: '1', min: '1', max: String(data.maxBatch || 500), style: 'width:90px' });
  const manualInput = h('input', { placeholder: '前缀，例如 contact' });
  const manualDomain = h('select');
  for (const d of data.domains) manualDomain.append(h('option', { value: d }, `@${d}`));

  // 前缀输入实时预览完整地址
  const preview = h('span', { style: 'font-size:12px;color:var(--muted);font-family:ui-monospace,monospace' });
  const updatePreview = () => {
    const p = prefixInput.value.trim();
    preview.textContent = p ? `→ ${p}${domainSelect.value}` : '';
  };
  prefixInput.addEventListener('input', updatePreview);
  domainSelect.addEventListener('change', updatePreview);

  const manualPreview = h('span', { style: 'font-size:12px;color:var(--muted);font-family:ui-monospace,monospace' });
  const updateManualPreview = () => {
    const p = manualInput.value.trim();
    manualPreview.textContent = p ? `→ ${p}${manualDomain.value}` : '';
  };
  manualInput.addEventListener('input', updateManualPreview);
  manualDomain.addEventListener('change', updateManualPreview);

  const renderList = () => {
    if (!data.aliases.length) {
      listBox.replaceChildren(
        h('div', { class: 'alias-list-empty' },
          h('span', { class: 'ale-ico', html: icon('inboxEmpty', 32) }),
          h('div', { text: '还没有额外地址' }),
          h('div', { class: 'ale-sub', text: '在上方填写前缀即可创建' }),
        ),
      );
      return;
    }
    listBox.replaceChildren(
      h('table', { class: 'alias-table' },
        h('thead', {}, h('tr', {},
          h('th', { text: '邮箱地址' }),
          h('th', { text: '转发到' }),
          h('th', { text: '状态' }),
          h('th', {}, ''),
        )),
        h('tbody', {}, ...data.aliases.map((a) =>
          h('tr', {},
            h('td', {},
              h('div', { class: 'at-addr' },
                h('span', { class: 'at-dot' }),
                h('code', { text: a.address }),
              ),
            ),
            h('td', { class: 'at-target', text: a.targets.join(', ') }),
            h('td', {},
              h('span', { class: `at-badge ${a.active ? 'on' : 'off'}` },
                a.active ? '启用' : '停用'),
            ),
            h('td', { class: 'actions' },
              h('button', {
                class: 'icon-btn', title: a.active ? '停用' : '启用',
                html: icon('power', 15),
                onClick: async () => {
                  await api(`/api/aliases/${a.id}`, { method: 'PUT', body: { active: !a.active } });
                  data = await api('/api/aliases'); renderList(); renderAliasPanel();
                  toast(a.active ? '已停用' : '已启用');
                },
              }),
              h('button', {
                class: 'icon-btn', title: '删除',
                html: icon('trash', 15),
                onClick: async () => {
                  if (!confirm(`删除 ${a.address}？`)) return;
                  await api(`/api/aliases/${a.id}`, { method: 'DELETE' });
                  data = await api('/api/aliases'); renderList(); renderAliasPanel();
                  toast('已删除');
                },
              }),
            ),
          )
        )),
      ),
    );
  };
  renderList();

  const doBatch = async () => {
    try {
      const r = await api('/api/aliases/batch', {
        method: 'POST',
        body: {
          count: Number(countInput.value) || 1,
          prefix: prefixInput.value.trim(),
          domain: domainSelect.value,
        },
      });
      data = await api('/api/aliases');
      renderList();
      prefixInput.value = '';
      updatePreview();
      toast(`已创建 ${r.count} 个地址`);
      renderAliasPanel();
      if (r.errors?.length) console.warn('部分失败', r.errors);
    } catch (e) { toast(e.message); }
  };

  // 只填前缀即可创建
  const doManual = async () => {
    const prefix = manualInput.value.trim();
    if (!prefix) { toast('请填写前缀'); return; }
    try {
      const r = await api('/api/aliases', {
        method: 'POST',
        body: { prefix, domain: manualDomain.value },
      });
      manualInput.value = '';
      updateManualPreview();
      data = await api('/api/aliases');
      renderList();
      toast(`已创建 ${r.alias.address}`);
      renderAliasPanel();
    } catch (e) { toast(e.message); }
  };

  // 回车直接创建
  manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doManual();
  });
  prefixInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doBatch();
  });

  const statPill = (label, value, accent) =>
    h('div', { class: 'alias-stat' },
      h('span', { class: 'alias-stat-k', text: label }),
      h('span', { class: `alias-stat-v ${accent ? 'accent' : ''}`, text: String(value) }),
    );

  return h('div', { class: 'alias-page' },
    // 顶部统计
    h('div', { class: 'alias-stats' },
      statPill('地址总数', data.total, true),
      statPill('数量上限', data.unlimited ? '不限' : data.limit),
      statPill('可用域名', data.domains.length),
      statPill('单次批量', `≤${data.maxBatch || 500}`),
    ),

    // 新建（单条）
    h('div', { class: 'alias-block' },
      h('div', { class: 'alias-block-head' },
        h('span', { class: 'ab-ico', html: icon('plus', 15) }),
        h('div', {},
          h('div', { class: 'ab-title', text: '新建邮箱地址' }),
          h('div', { class: 'ab-desc', text: '只填前缀即可，自动补全域名' }),
        ),
      ),
      h('div', { class: 'alias-form' },
        h('div', { class: 'af-field' },
          h('label', { text: '前缀' }),
          manualInput,
        ),
        h('div', { class: 'af-field', style: 'flex:0 0 170px' },
          h('label', { text: '域名' }),
          manualDomain,
        ),
        h('button', { class: 'btn primary', onClick: doManual },
          h('span', { class: 'btn-ico', html: icon('plus', 14) }), '创建'),
      ),
      h('div', { class: 'alias-preview' }, manualPreview),
    ),

    // 批量生成
    h('div', { class: 'alias-block' },
      h('div', { class: 'alias-block-head' },
        h('span', { class: 'ab-ico', html: icon('layers', 15) }),
        h('div', {},
          h('div', { class: 'ab-title', text: '批量生成' }),
          h('div', { class: 'ab-desc', text: '前缀留空生成随机地址；填前缀则生成 前缀-1、前缀-2…' }),
        ),
      ),
      h('div', { class: 'alias-form' },
        h('div', { class: 'af-field' },
          h('label', { text: '前缀（可留空）' }),
          prefixInput,
        ),
        h('div', { class: 'af-field', style: 'flex:0 0 170px' },
          h('label', { text: '域名' }),
          domainSelect,
        ),
        h('div', { class: 'af-field', style: 'flex:0 0 90px' },
          h('label', { text: '数量' }),
          countInput,
        ),
        h('button', { class: 'btn', onClick: doBatch },
          h('span', { class: 'btn-ico', html: icon('layers', 14) }), '生成'),
      ),
      h('div', { class: 'alias-preview' }, preview),
    ),

    // 地址列表
    h('div', { class: 'alias-block alias-block-list' },
      h('div', { class: 'alias-block-head' },
        h('span', { class: 'ab-ico', html: icon('mailbox', 15) }),
        h('div', {},
          h('div', { class: 'ab-title', text: '全部地址' }),
          h('div', { class: 'ab-desc', text: data.unlimited ? '无数量限制，全部投递到主邮箱' : `上限 ${data.limit} 个` }),
        ),
      ),
      listBox,
    ),
  );
}

// ---------- 设置 ----------
async function renderSettings(toolbar, content) {
  toolbar.append(h('h2', { text: '账号设置' }), h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => { state.view = 'mail'; renderView(); renderFolders(); } }, '返回'));
  content.replaceChildren(h('div', { class: 'loading-row', text: '加载中…' }));

  let s;
  try {
    s = await api('/api/settings');
  } catch (e) {
    content.replaceChildren(h('div', { class: 'empty', text: e.message }));
    return;
  }

  const quotaPct = s.quotaMb ? Math.min(100, Math.round((s.usedMb / s.quotaMb) * 100)) : 0;

  const fwdTarget = h('input', { placeholder: '转发到 other@example.com（留空关闭）', value: s.forward?.target || '' });
  const fwdKeep = h('input', { type: 'checkbox', checked: s.forward ? !!s.forward.keep_copy : true });

  const arSubject = h('input', { placeholder: '自动回复主题', value: s.autoresponder?.subject || '自动回复' });
  const arBody = h('textarea', { placeholder: '自动回复内容' });
  arBody.value = s.autoresponder?.body || '';

  const nameInput = h('input', { placeholder: '显示名', value: s.user.displayName || '' });

  const oldPass = h('input', { type: 'password', placeholder: '原密码' });
  const newPass = h('input', { type: 'password', placeholder: '新密码（至少 6 位）' });

  const keyBox = h('div');
  const renderKeys = (keys) => {
    keyBox.replaceChildren(
      keys.length
        ? h('table', {},
            h('thead', {}, h('tr', {}, h('th', { text: '名称' }), h('th', { text: '前缀' }), h('th', { text: '创建时间' }), h('th', {}, ''))),
            h('tbody', {}, ...keys.map((k) =>
              h('tr', {},
                h('td', { text: k.name || '-' }),
                h('td', {}, h('code', { text: `${k.key_hint}…` })),
                h('td', { text: fmtFull(k.created_at) }),
                h('td', { class: 'actions' }, h('button', {
                  class: 'btn sm danger', onClick: async () => {
                    await api(`/api/settings/apikeys/${k.id}`, { method: 'DELETE' });
                    toast('已删除'); renderSettings(toolbar, content);
                  },
                }, '删除')),
              )
            )),
          )
        : h('div', { style: 'color:var(--muted);font-size:13px', text: '暂无 API Key' })
    );
  };
  renderKeys(s.apiKeys || []);

  content.replaceChildren(
    h('div', { class: 'admin' },
      h('div', { class: 'stat-grid' },
        h('div', { class: 'stat' }, h('div', { class: 'k', text: '邮箱地址' }), h('div', { class: 'v', style: 'font-size:15px', text: s.user.email })),
        h('div', { class: 'stat' }, h('div', { class: 'k', text: '空间使用' }), h('div', { class: 'v', style: 'font-size:15px', text: `${s.usedMb} / ${s.quotaMb} MB` }), h('div', { style: 'font-size:11px;color:var(--muted)', text: `${quotaPct}%` })),
        h('div', { class: 'stat' }, h('div', { class: 'k', text: 'IMAP' }), h('div', { class: 'v', style: 'font-size:14px', text: `${s.imap.host}:${s.imap.port}` })),
        h('div', { class: 'stat' }, h('div', { class: 'k', text: 'SMTP' }), h('div', { class: 'v', style: 'font-size:14px', text: `${s.smtp.host}:${s.smtp.port}` })),
      ),

      h('div', { class: 'card' },
        h('h3', { text: '个人信息' }),
        h('div', { class: 'inline-form' },
          h('div', { class: 'field' }, h('label', { text: '显示名' }), nameInput),
          h('button', {
            class: 'btn primary', onClick: async () => {
              await api('/api/settings/profile', { method: 'POST', body: { displayName: nameInput.value } });
              toast('已保存');
            },
          }, '保存'),
        ),
      ),

      await renderAliasCard(),

      h('div', { class: 'card' },
        h('h3', { text: '邮件转发' }),
        h('div', { class: 'inline-form' },
          h('div', { class: 'field' }, h('label', { text: '转发地址' }), fwdTarget),
          h('label', { style: 'display:flex;align-items:center;gap:6px;font-size:13px;padding-bottom:10px' }, fwdKeep, '保留副本'),
          h('button', {
            class: 'btn primary', onClick: async () => {
              await api('/api/settings/forward', {
                method: 'POST',
                body: { target: fwdTarget.value.trim(), keepCopy: fwdKeep.checked },
              });
              toast(fwdTarget.value.trim() ? '转发已设置' : '转发已关闭');
            },
          }, '保存'),
        ),
      ),

      h('div', { class: 'card' },
        h('h3', { text: '自动回复' }),
        h('div', { class: 'field' }, h('label', { text: '主题' }), arSubject),
        h('div', { class: 'field' }, h('label', { text: '内容' }), arBody),
        h('div', { style: 'display:flex;gap:8px' },
          h('button', {
            class: 'btn primary', onClick: async () => {
              await api('/api/settings/autoresponder', {
                method: 'POST', body: { subject: arSubject.value, body: arBody.value, active: true },
              });
              toast('自动回复已开启');
            },
          }, '开启'),
          h('button', {
            class: 'btn', onClick: async () => {
              await api('/api/settings/autoresponder', { method: 'POST', body: { active: false } });
              toast('自动回复已关闭');
            },
          }, '关闭'),
        ),
      ),

      h('div', { class: 'card' },
        h('h3', { text: '修改密码' }),
        h('div', { class: 'inline-form' },
          h('div', { class: 'field' }, h('label', { text: '原密码' }), oldPass),
          h('div', { class: 'field' }, h('label', { text: '新密码' }), newPass),
          h('button', {
            class: 'btn primary', onClick: async () => {
              try {
                await api('/api/auth/password', { method: 'POST', body: { oldPassword: oldPass.value, newPassword: newPass.value } });
                toast('密码已修改');
                oldPass.value = newPass.value = '';
              } catch (e) { toast(e.message); }
            },
          }, '修改'),
        ),
      ),

      h('div', { class: 'card' },
        h('h3', { text: '客户端配置（Foxmail / Outlook / 手机邮件）' }),
        h('div', { style: 'font-size:13px;line-height:1.9' },
          h('div', {}, '收信服务器 IMAP：', h('code', { text: `${s.imap.host}` }), ` 端口 ${s.imap.port}，加密方式 STARTTLS`),
          h('div', {}, '发信服务器 SMTP：', h('code', { text: `${s.smtp.host}` }), ` 端口 ${s.smtp.port}，需勾选“服务器需要认证”`),
          h('div', {}, '账号：', h('code', { text: s.user.email }), '，密码：邮箱登录密码'),
        ),
      ),

      h('div', { class: 'card' },
        h('h3', { text: 'API Key（用于程序化发信/取信）' }),
        h('div', { class: 'inline-form' },
          h('button', {
            class: 'btn', onClick: async () => {
              const r = await api('/api/settings/apikeys', { method: 'POST', body: { name: 'default' } });
              alert(`请立即保存，此密钥只显示一次：\n\n${r.key}`);
              renderSettings(toolbar, content);
            },
          }, '+ 新建 API Key'),
        ),
        keyBox,
      ),
    ),
  );
}

// ---------- 管理后台 ----------
async function renderAdmin(toolbar, content) {
  toolbar.append(h('h2', { text: '管理后台' }), h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => { state.view = 'mail'; renderView(); renderFolders(); } }, '返回邮箱'));
  const box = h('div', { class: 'admin' });
  content.replaceChildren(box);

  const tabs = ['overview', 'domains', 'users', 'aliases', 'queue'];
  const tabLabels = { overview: '概览', domains: '域名', users: '账号', aliases: '别名转发', queue: '投递队列' };

  const tabBar = h('div', { class: 'admin-tabs' },
    ...tabs.map((t) => h('button', {
      class: state.adminTab === t ? 'on' : '',
      onClick: () => { state.adminTab = t; renderAdmin(toolbar, content); },
    }, tabLabels[t]))
  );
  box.append(tabBar);

  const pane = h('div');
  box.append(pane);

  try {
    if (state.adminTab === 'overview') {
      const s = await api('/api/admin/stats');
      const c = await api('/api/admin/config');
      pane.append(
        h('div', { class: 'stat-grid' },
          h('div', { class: 'stat' }, h('div', { class: 'k', text: '账号数' }), h('div', { class: 'v', text: String(s.users) })),
          h('div', { class: 'stat' }, h('div', { class: 'k', text: '域名数' }), h('div', { class: 'v', text: String(s.domains) })),
          h('div', { class: 'stat' }, h('div', { class: 'k', text: '邮件总数' }), h('div', { class: 'v', text: String(s.messages) })),
          h('div', { class: 'stat' }, h('div', { class: 'k', text: '今日收信' }), h('div', { class: 'v', text: String(s.todayMessages) })),
          h('div', { class: 'stat' }, h('div', { class: 'k', text: '占用空间' }), h('div', { class: 'v', text: `${s.storageMb} MB` })),
          h('div', { class: 'stat' }, h('div', { class: 'k', text: '队列待发' }), h('div', { class: 'v', text: String(s.outbox?.queued || 0) })),
        ),
        h('div', { class: 'card' },
          h('h3', { text: '服务配置' }),
          h('div', { style: 'font-size:13px;line-height:2' },
            h('div', {}, `主机名：`, h('code', { text: c.hostname })),
            h('div', {}, `SMTP 收信端口：`, h('code', { text: String(c.smtpPort) })),
            h('div', {}, `SMTP 提交端口：`, h('code', { text: String(c.submissionPort) })),
            h('div', {}, `IMAP 端口：`, h('code', { text: String(c.imapPort) })),
            h('div', {}, `Web 端口：`, h('code', { text: String(c.httpPort) })),
            h('div', {}, `TLS：`, h('span', { class: c.tls.enabled ? 'badge-ok' : 'badge-err', text: c.tls.enabled ? '已启用' : '未配置' })),
            h('div', {}, `外发中继：`, h('span', { class: c.relay.enabled ? 'badge-ok' : 'badge-off', text: c.relay.enabled ? `${c.relay.type} ${c.relay.host}` : '直连 MX' })),
            h('div', {}, `开放注册：`, h('span', { class: c.allowSelfRegister ? 'badge-ok' : 'badge-off', text: c.allowSelfRegister ? '是' : '否' })),
          ),
        ),
      );
    }

    if (state.adminTab === 'domains') {
      const r = await api('/api/admin/domains');
      const nameInput = h('input', { placeholder: 'example.com' });
      const dnsBox = h('div');

      const showDns = async (id) => {
        const d = await api(`/api/admin/domains/${id}/dns`);
        dnsBox.replaceChildren(
          h('div', { class: 'card' },
            h('h3', { text: `${d.domain} 的 DNS 记录` }),
            h('table', { class: 'dns-table' },
              h('thead', {}, h('tr', {}, h('th', { text: '类型' }), h('th', { text: '主机记录' }), h('th', { text: '值' }), h('th', { text: '说明' }))),
              h('tbody', {},
                ...d.records.map((rec) =>
                  h('tr', {},
                    h('td', {}, h('code', { text: rec.type })),
                    h('td', {}, h('code', { text: rec.name })),
                    h('td', {}, h('code', { text: rec.value })),
                    h('td', { style: 'color:var(--muted);font-size:12px', text: rec.note }),
                  )
                ),
                d.dkim ? h('tr', {},
                  h('td', {}, h('code', { text: 'TXT' })),
                  h('td', {}, h('code', { text: d.dkim.name })),
                  h('td', {}, h('code', { text: d.dkim.value })),
                  h('td', { style: 'color:var(--muted);font-size:12px', text: 'DKIM 签名公钥' }),
                ) : null,
              ),
            ),
          ),
        );
      };

      pane.append(
        h('div', { class: 'card' },
          h('h3', { text: '添加域名' }),
          h('div', { class: 'inline-form' },
            h('div', { class: 'field' }, h('label', { text: '域名' }), nameInput),
            h('button', {
              class: 'btn primary', onClick: async () => {
                try {
                  await api('/api/admin/domains', { method: 'POST', body: { name: nameInput.value.trim() } });
                  toast('域名已添加'); state.adminTab = 'domains'; renderAdmin(toolbar, content);
                } catch (e) { toast(e.message); }
              },
            }, '添加'),
          ),
        ),
        h('div', { class: 'card' },
          h('h3', { text: '域名列表' }),
          h('table', {},
            h('thead', {}, h('tr', {}, h('th', { text: '域名' }), h('th', { text: '状态' }), h('th', { text: 'Catch-all' }), h('th', { text: 'DKIM' }), h('th', {}, ''))),
            h('tbody', {}, ...r.domains.map((d) =>
              h('tr', {},
                h('td', {}, h('code', { text: d.name })),
                h('td', {}, h('span', { class: d.active ? 'badge-ok' : 'badge-off', text: d.active ? '启用' : '停用' })),
                h('td', { text: d.catch_all || '-' }),
                h('td', {}, h('span', { class: d.dkim_enabled ? 'badge-ok' : 'badge-off', text: d.dkim_enabled ? d.dkim_selector : '关闭' })),
                h('td', { class: 'actions' },
                  h('button', { class: 'btn sm', onClick: () => showDns(d.id) }, 'DNS 记录'),
                  ' ',
                  h('button', {
                    class: 'btn sm', onClick: async () => {
                      await api(`/api/admin/domains/${d.id}`, { method: 'PUT', body: { active: !d.active } });
                      toast(d.active ? '已停用' : '已启用'); renderAdmin(toolbar, content);
                    },
                  }, d.active ? '停用' : '启用'),
                  ' ',
                  h('button', {
                    class: 'btn sm danger', onClick: async () => {
                      if (!confirm(`删除域名 ${d.name}？`)) return;
                      try {
                        await api(`/api/admin/domains/${d.id}`, { method: 'DELETE' });
                        toast('已删除'); renderAdmin(toolbar, content);
                      } catch (e) { toast(e.message); }
                    },
                  }, '删除'),
                ),
              )
            )),
          ),
        ),
        dnsBox,
      );
    }

    if (state.adminTab === 'users') {
      const r = await api('/api/admin/users');
      const emailInput = h('input', { placeholder: 'user@example.com' });
      const passInput = h('input', { type: 'password', placeholder: '初始密码' });
      const nameInput = h('input', { placeholder: '显示名' });
      const adminChk = h('input', { type: 'checkbox' });

      pane.append(
        h('div', { class: 'card' },
          h('h3', { text: '新建账号' }),
          h('div', { class: 'inline-form' },
            h('div', { class: 'field' }, h('label', { text: '邮箱' }), emailInput),
            h('div', { class: 'field' }, h('label', { text: '密码' }), passInput),
            h('div', { class: 'field' }, h('label', { text: '显示名' }), nameInput),
            h('label', { style: 'display:flex;align-items:center;gap:6px;font-size:13px;padding-bottom:10px' }, adminChk, '管理员'),
            h('button', {
              class: 'btn primary', onClick: async () => {
                try {
                  await api('/api/admin/users', {
                    method: 'POST',
                    body: { email: emailInput.value.trim(), password: passInput.value, displayName: nameInput.value, isAdmin: adminChk.checked },
                  });
                  toast('账号已创建'); renderAdmin(toolbar, content);
                } catch (e) { toast(e.message); }
              },
            }, '创建'),
          ),
        ),
        h('div', { class: 'card' },
          h('h3', { text: `账号列表（${r.users.length}）` }),
          h('table', {},
            h('thead', {}, h('tr', {}, h('th', { text: '邮箱' }), h('th', { text: '显示名' }), h('th', { text: '角色' }), h('th', { text: '状态' }), h('th', { text: '最后登录' }), h('th', {}, ''))),
            h('tbody', {}, ...r.users.map((u) =>
              h('tr', {},
                h('td', {}, h('code', { text: u.email })),
                h('td', { text: u.display_name || '-' }),
                h('td', {}, h('span', { class: u.is_admin ? 'badge-ok' : '', text: u.is_admin ? '管理员' : '用户' })),
                h('td', {}, h('span', { class: u.active ? 'badge-ok' : 'badge-off', text: u.active ? '正常' : '停用' })),
                h('td', { text: u.last_login_at ? fmtFull(u.last_login_at) : '-' }),
                h('td', { class: 'actions' },
                  h('button', {
                    class: 'btn sm', onClick: async () => {
                      const p = prompt(`为 ${u.email} 设置新密码（至少 6 位）：`);
                      if (!p) return;
                      try {
                        await api(`/api/admin/users/${u.id}/password`, { method: 'POST', body: { password: p } });
                        toast('密码已重置');
                      } catch (e) { toast(e.message); }
                    },
                  }, '重置密码'),
                  ' ',
                  h('button', {
                    class: 'btn sm', onClick: async () => {
                      await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { active: !u.active } });
                      toast(u.active ? '已停用' : '已启用'); renderAdmin(toolbar, content);
                    },
                  }, u.active ? '停用' : '启用'),
                  ' ',
                  h('button', {
                    class: 'btn sm danger', onClick: async () => {
                      if (!confirm(`删除账号 ${u.email} 及其全部邮件？`)) return;
                      await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
                      toast('已删除'); renderAdmin(toolbar, content);
                    },
                  }, '删除'),
                ),
              )
            )),
          ),
        ),
      );
    }

    if (state.adminTab === 'aliases') {
      const r = await api('/api/admin/aliases');
      const addrInput = h('input', { placeholder: 'sales@example.com' });
      const targetInput = h('input', { placeholder: 'alice@example.com, bob@example.com' });

      pane.append(
        h('div', { class: 'card' },
          h('h3', { text: '新建别名（一个地址转发给多个账号）' }),
          h('div', { class: 'inline-form' },
            h('div', { class: 'field' }, h('label', { text: '别名地址' }), addrInput),
            h('div', { class: 'field' }, h('label', { text: '目标地址（逗号分隔）' }), targetInput),
            h('button', {
              class: 'btn primary', onClick: async () => {
                try {
                  await api('/api/admin/aliases', { method: 'POST', body: { address: addrInput.value.trim(), targets: targetInput.value } });
                  toast('别名已创建'); renderAdmin(toolbar, content);
                } catch (e) { toast(e.message); }
              },
            }, '创建'),
          ),
        ),
        h('div', { class: 'card' },
          h('h3', { text: `别名列表（${r.aliases.length}）` }),
          r.aliases.length
            ? h('table', {},
                h('thead', {}, h('tr', {}, h('th', { text: '别名' }), h('th', { text: '目标' }), h('th', { text: '状态' }), h('th', {}, ''))),
                h('tbody', {}, ...r.aliases.map((a) =>
                  h('tr', {},
                    h('td', {}, h('code', { text: a.address })),
                    h('td', { text: JSON.parse(a.targets).join(', ') }),
                    h('td', {}, h('span', { class: a.active ? 'badge-ok' : 'badge-off', text: a.active ? '启用' : '停用' })),
                    h('td', { class: 'actions' }, h('button', {
                      class: 'btn sm danger', onClick: async () => {
                        await api(`/api/admin/aliases/${a.id}`, { method: 'DELETE' });
                        toast('已删除'); renderAdmin(toolbar, content);
                      },
                    }, '删除')),
                  )
                )),
              )
            : h('div', { style: 'color:var(--muted);font-size:13px', text: '暂无别名' }),
        ),
      );
    }

    if (state.adminTab === 'queue') {
      const r = await api('/api/admin/outbox');
      pane.append(
        h('div', { class: 'stat-grid' },
          h('div', { class: 'stat' }, h('div', { class: 'k', text: '待发' }), h('div', { class: 'v', text: String(r.stats.queued || 0) })),
          h('div', { class: 'stat' }, h('div', { class: 'k', text: '发送中' }), h('div', { class: 'v', text: String(r.stats.sending || 0) })),
          h('div', { class: 'stat' }, h('div', { class: 'k', text: '已发送' }), h('div', { class: 'v', text: String(r.stats.sent || 0) })),
          h('div', { class: 'stat' }, h('div', { class: 'k', text: '失败' }), h('div', { class: 'v', text: String(r.stats.failed || 0) })),
        ),
        h('div', { class: 'card' },
          h('h3', { text: '最近投递记录' }),
          r.queue.length
            ? h('table', {},
                h('thead', {}, h('tr', {}, h('th', { text: 'ID' }), h('th', { text: '发件人' }), h('th', { text: '收件人' }), h('th', { text: '状态' }), h('th', { text: '尝试' }), h('th', { text: '错误' }), h('th', {}, ''))),
                h('tbody', {}, ...r.queue.map((q) =>
                  h('tr', {},
                    h('td', { text: String(q.id) }),
                    h('td', {}, h('code', { text: q.mail_from })),
                    h('td', {}, h('code', { text: q.rcpt_to })),
                    h('td', {}, h('span', {
                      class: q.status === 'sent' ? 'badge-ok' : q.status === 'failed' ? 'badge-err' : '',
                      text: q.status,
                    })),
                    h('td', { text: String(q.attempts) }),
                    h('td', { style: 'max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--muted)', text: q.last_error || '' }),
                    h('td', { class: 'actions' },
                      q.status !== 'sent'
                        ? h('button', {
                            class: 'btn sm', onClick: async () => {
                              await api(`/api/admin/outbox/${q.id}/retry`, { method: 'POST' });
                              toast('已重新入队'); renderAdmin(toolbar, content);
                            },
                          }, '重试')
                        : null,
                    ),
                  )
                )),
              )
            : h('div', { style: 'color:var(--muted);font-size:13px', text: '队列为空' }),
        ),
      );
    }
  } catch (e) {
    pane.append(h('div', { class: 'card', text: `加载失败：${e.message}` }));
  }
}

// ---------- 启动 ----------
async function boot() {
  try {
    const r = await api('/api/auth/me');
    state.user = r.user;
    renderShell();
  } catch {
    renderAuth('login');
  }
}

boot();
