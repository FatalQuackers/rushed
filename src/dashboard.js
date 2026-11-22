// RUSHED scouting dashboard.
// IMPORTANT: this site is static (no server). Accounts, games and settings are kept in each browser
// (localStorage). Use Settings → Backup to move data between devices. Discord sign-in uses Discord's
// browser login (no server needed) and the webhook posts straight to your Discord channel.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const KEYS = {
    accounts: 'rushed-accounts', subs: 'rushed-submissions', session: 'rushed-session', admin: 'rushed-admin',
    legacyAdminHash: 'rushed-admin-hash', settings: 'rushed-settings', activity: 'rushed-activity', watch: 'rushed-watch', oauth: 'rushed-oauth',
  };
  const CONFIG = window.RUSHED_CONFIG || {};

  /* ---------- tiny SHA-256 so passwords are never stored as plain text ---------- */
  const K = [], H0 = [];
  (() => {
    const prime = n => { for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; };
    for (let n = 2, c = 0; c < 64; n++) {
      if (!prime(n)) continue;
      if (c < 8) H0.push((Math.pow(n, 1 / 2) % 1) * 2 ** 32 | 0);
      K.push((Math.pow(n, 1 / 3) % 1) * 2 ** 32 | 0);
      c++;
    }
  })();
  const sha256 = text => {
    const bytes = new TextEncoder().encode(text);
    const total = Math.ceil((bytes.length + 9) / 64) * 64;
    const buf = new Uint8Array(total);
    buf.set(bytes); buf[bytes.length] = 0x80;
    const dv = new DataView(buf.buffer);
    const bits = bytes.length * 8;
    dv.setUint32(total - 8, Math.floor(bits / 2 ** 32)); dv.setUint32(total - 4, bits >>> 0);
    const H = H0.slice(); const W = new Int32Array(64);
    const rot = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < total; o += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getInt32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rot(W[i - 15], 7) ^ rot(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rot(W[i - 2], 17) ^ rot(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  };
  const fingerprint = (user, pass) => sha256(`rushed:${user.toLowerCase()}:${pass}`);

  /* ---------- storage ---------- */
  const read = (key, fallback) => { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

  // Built-in main admin ("rushed"); only a fingerprint of the password is in the code.
  const ADMIN = { username: 'rushed', hash: '9acf36ebfbc6ae8886c51e864ff66e26543ace21d6cc288294c85471cec42a76', role: 'admin', created: '2026-01-01', builtIn: true };
  (() => { // move the older single-value admin password into the admin record
    const legacy = read(KEYS.legacyAdminHash, null);
    if (legacy) { write(KEYS.admin, { ...read(KEYS.admin, {}), hash: legacy }); try { localStorage.removeItem(KEYS.legacyAdminHash); } catch {} }
  })();
  const accounts = () => {
    const extra = read(KEYS.admin, {});
    const admin = { ...ADMIN, hash: extra.hash || ADMIN.hash, discord: extra.discord || null };
    return [admin, ...read(KEYS.accounts, []).filter(a => a.username.toLowerCase() !== ADMIN.username)];
  };
  const saveAccounts = list => {
    const admin = list.find(a => a.builtIn);
    if (admin) write(KEYS.admin, { hash: admin.hash === ADMIN.hash ? undefined : admin.hash, discord: admin.discord || null });
    write(KEYS.accounts, list.filter(a => !a.builtIn));
  };
  const updateAccount = (username, patch) => saveAccounts(accounts().map(a => (a.username === username ? { ...a, ...patch } : a)));
  const submissions = () => read(KEYS.subs, []);
  const saveSubmissions = list => write(KEYS.subs, list);
  const activity = () => read(KEYS.activity, []);
  const settings = () => {
    const s = read(KEYS.settings, {});
    return {
      clientId: s.clientId || CONFIG.discordClientId || '',
      webhook: s.webhook || CONFIG.discordWebhook || '',
      notifySubmit: s.notifySubmit ?? true, notifyReview: s.notifyReview ?? true, notifyScout: s.notifyScout ?? false,
    };
  };
  const watchOf = user => (read(KEYS.watch, {})[user] || []);
  const setWatch = (user, ids) => { const all = read(KEYS.watch, {}); all[user] = ids; write(KEYS.watch, all); };

  const session = {
    get: () => { try { return sessionStorage.getItem(KEYS.session) || localStorage.getItem(KEYS.session); } catch { return null; } },
    set: (user, remember) => { try { sessionStorage.setItem(KEYS.session, user); if (remember) localStorage.setItem(KEYS.session, user); else localStorage.removeItem(KEYS.session); } catch {} },
    clear: () => { try { sessionStorage.removeItem(KEYS.session); localStorage.removeItem(KEYS.session); } catch {} },
  };

  /* ---------- helpers ---------- */
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(k => { if (k !== '' && k != null && k !== false) node.append(k instanceof Node ? k : document.createTextNode(String(k))); });
    return node;
  };
  const note = (node, text, error = false) => { node.textContent = text; node.classList.toggle('is-error', error); };
  const ratio = g => (g.visits > 0 ? (g.ccu / g.visits) * 1000 : 0);
  const fmt = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(n); };
  const placeId = link => { const v = String(link || '').trim(); const m = v.match(/^\d+$/) || v.match(/roblox\.com\/games\/(\d+)/i); return m ? (m[1] || m[0]) : null; };
  const robloxUrl = link => {
    const v = String(link || '').trim();
    if (/^\d+$/.test(v)) return `https://www.roblox.com/games/${v}`;
    try { const u = new URL(v); return u.protocol === 'https:' && /(^|\.)roblox\.com$/.test(u.hostname) ? u.href : null; } catch { return null; }
  };
  const verdict = r => (r >= 5 ? 'Exceptional — a real hidden gem' : r >= 2 ? 'Strong — worth a closer look' : r >= 1 ? 'Promising' : 'Low for now');
  const stars = n => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '—');
  const ago = iso => {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    return new Date(iso).toLocaleDateString();
  };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const discordAvatar = d => (d && d.avatar ? `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.png?size=64` : null);
  const redirectUri = () => location.origin + location.pathname;

  /* ---------- state ---------- */
  let me = null;
  let subFilter = 'all';
  const isAdmin = () => !!me && me.role === 'admin';
  const refreshMe = () => { if (me) me = accounts().find(a => a.username === me.username) || null; };

  const log = (text, about) => {
    const list = activity();
    list.unshift({ t: new Date().toISOString(), who: me ? me.username : 'system', text, about: about || null });
    write(KEYS.activity, list.slice(0, 300));
  };

  /* ---------- Discord webhook ---------- */
  const COLORS = { red: 0xf34b3f, green: 0x2fb46c, purple: 0x7658ef, yellow: 0xffdf61, grey: 0x77736f };
  const postWebhook = async (embed, url = settings().webhook) => {
    if (!url) return { ok: false, reason: 'No webhook set' };
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'RUSHED Scouting', allowed_mentions: { parse: [] }, embeds: [{ ...embed, footer: { text: 'RUSHED scouting dashboard' }, timestamp: new Date().toISOString() }] }),
      });
      return { ok: res.ok, reason: res.ok ? '' : `Discord said ${res.status}` };
    } catch { return { ok: false, reason: 'Could not reach Discord' }; }
  };
  const gameFields = s => [
    { name: 'Genre', value: s.genre, inline: true },
    { name: 'CCU', value: fmt(s.ccu), inline: true },
    { name: 'Visits', value: fmt(s.visits), inline: true },
    { name: 'CCU / 1K visits', value: ratio(s).toFixed(2), inline: true },
    { name: 'Scout', value: s.by, inline: true },
  ];
  const notify = (kind, s) => {
    const st = settings();
    if (!st.webhook) return;
    if (kind === 'submit' && st.notifySubmit) {
      postWebhook({ title: `New game to scout: ${s.name}`, url: robloxUrl(s.link) || undefined, color: COLORS.yellow, description: (s.notes || 'No notes.').slice(0, 300), fields: gameFields(s) });
    } else if (kind === 'review' && st.notifyReview) {
      const ok = s.status === 'approved';
      postWebhook({ title: `${ok ? 'Approved' : 'Passed'}: ${s.name}`, url: robloxUrl(s.link) || undefined, color: ok ? COLORS.green : COLORS.grey,
        description: s.comment ? `“${s.comment.slice(0, 300)}” — ${s.reviewedBy}` : `Reviewed by ${s.reviewedBy}`,
        fields: [...gameFields(s), { name: 'Rating', value: stars(s.rating), inline: true }] });
    } else if (kind === 'scout' && st.notifyScout) {
      postWebhook({ title: `New scout: ${s.username}`, color: COLORS.purple, description: `${s.username} joined the RUSHED scouting team as ${s.role}.` });
    }
  };

  /* ---------- Discord sign-in (OAuth2 in the browser) ---------- */
  const startDiscord = (mode, msgNode) => {
    const { clientId } = settings();
    if (!clientId) { note(msgNode, 'Discord isn\'t set up yet — an admin needs to add the Discord Client ID in Settings.', true); return; }
    const state = uid() + uid();
    try { sessionStorage.setItem(KEYS.oauth, JSON.stringify({ state, mode, user: me ? me.username : null })); } catch {}
    const q = new URLSearchParams({ client_id: clientId, response_type: 'token', redirect_uri: redirectUri(), scope: 'identify', state, prompt: 'none' });
    location.href = `https://discord.com/oauth2/authorize?${q}`;
  };

  const finishDiscord = async () => {
    if (!/access_token=|error=/.test(location.hash)) return null;
    const p = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(KEYS.oauth)); sessionStorage.removeItem(KEYS.oauth); } catch {}
    if (p.get('error')) return { error: 'Discord sign-in was cancelled.' };
    if (!saved || saved.state !== p.get('state')) return { error: 'That Discord sign-in didn\'t come from this page. Please try again.' };
    try {
      const res = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${p.get('access_token')}` } });
      if (!res.ok) throw new Error();
      const u = await res.json();
      return { mode: saved.mode, user: saved.user, discord: { id: u.id, name: u.global_name || u.username, handle: u.username, avatar: u.avatar } };
    } catch { return { error: 'Couldn\'t read your Discord profile. Please try again.' }; }
  };

  /* ---------- views ---------- */
  const loginView = $('#login-view');
  const appView = $('#app-view');

  const paintWho = () => {
    $('#who-name').textContent = me.discord ? me.discord.name : me.username;
    $('#who-role').textContent = me.role.toUpperCase() + (me.discord ? ` · ${me.username}` : '');
    const av = $('#who-avatar');
    const pic = discordAvatar(me.discord);
    av.replaceChildren(pic ? el('img', { src: pic, alt: '' }) : me.username.charAt(0).toUpperCase());
    const dp = $('#who-discord');
    dp.hidden = !me.discord;
    if (me.discord) $('span', dp).textContent = `@${me.discord.handle}`;
  };

  const showApp = tab => {
    loginView.hidden = true; appView.hidden = false;
    paintWho();
    $$('[data-admin]').forEach(n => { n.hidden = !isAdmin(); });
    $('#st-mine-label').textContent = isAdmin() ? 'SCOUT ACCOUNTS' : 'YOUR APPROVED GAMES';
    renderAll();
    selectTab(tab || 'overview', false);
  };
  const showLogin = () => { me = null; appView.hidden = true; loginView.hidden = false; };

  const signIn = (acc, remember) => {
    me = acc;
    session.set(acc.username, remember);
    log('signed in');
  };

  $('#login-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.currentTarget;
    const user = f.username.value.trim();
    const msg = $('#login-note');
    if (!user || !f.password.value) { note(msg, 'Enter your username and password.', true); return; }
    const acc = accounts().find(a => a.username.toLowerCase() === user.toLowerCase());
    if (!acc || acc.hash !== fingerprint(user, f.password.value)) { note(msg, 'That username and password don\'t match.', true); f.password.value = ''; f.password.focus(); return; }
    note(msg, '');
    signIn(acc, f.remember.checked);
    f.reset();
    showApp();
    appView.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#discord-login').addEventListener('click', () => startDiscord('login', $('#discord-login-note')));

  /* ---------- password ---------- */
  const pwForm = $('#pw-form');
  const pwToggle = $('#pw-toggle');
  pwToggle.addEventListener('click', () => {
    pwForm.hidden = !pwForm.hidden;
    pwToggle.setAttribute('aria-expanded', String(!pwForm.hidden));
    pwForm.username.value = me.username;
    if (!pwForm.hidden) pwForm.current.focus();
  });
  pwForm.addEventListener('submit', e => {
    e.preventDefault();
    const msg = $('#pw-note');
    const acc = accounts().find(a => a.username === me.username);
    if (!acc || acc.hash !== fingerprint(me.username, pwForm.current.value)) { note(msg, 'Your current password is not right.', true); return; }
    if (pwForm.next.value.length < 6) { note(msg, 'Use at least 6 characters for the new password.', true); return; }
    if (pwForm.next.value !== pwForm.repeat.value) { note(msg, "The two new passwords don't match.", true); return; }
    updateAccount(me.username, { hash: fingerprint(me.username, pwForm.next.value) });
    refreshMe();
    pwForm.reset();
    log('changed their password');
    note(msg, 'Password changed. Use the new one next time you sign in on this device.');
  });

  $('#sign-out').addEventListener('click', () => {
    session.clear();
    pwForm.hidden = true; pwToggle.setAttribute('aria-expanded', 'false');
    showLogin();
  });

  /* ---------- tabs ---------- */
  const tabs = $$('[role="tab"]');
  const selectTab = (name, focus = true) => {
    const target = $(`#tab-${name}`);
    if (!target || target.hidden) name = 'overview';
    tabs.forEach(t => {
      const on = t.id === `tab-${name}`;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    $$('.panel').forEach(p => { p.hidden = p.id !== `panel-${name}` || (p.hasAttribute('data-admin') && !isAdmin()); });
  };
  tabs.forEach(t => {
    t.addEventListener('click', () => selectTab(t.id.replace('tab-', '')));
    t.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const visible = tabs.filter(x => !x.hidden);
      const i = visible.indexOf(t) + (e.key === 'ArrowRight' ? 1 : -1);
      selectTab(visible[(i + visible.length) % visible.length].id.replace('tab-', ''));
    });
  });
  document.addEventListener('click', e => { const go = e.target.closest('[data-go]'); if (go) selectTab(go.dataset.go); });

  /* ---------- data views ---------- */
  const approved = () => submissions().filter(s => s.status === 'approved');
  const visibleSubs = () => (isAdmin() ? submissions() : submissions().filter(s => s.by === me.username));

  const toggleWatch = id => {
    const list = watchOf(me.username);
    setWatch(me.username, list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
    renderAll();
  };
  const watchBtn = s => {
    const on = watchOf(me.username).includes(s.id);
    return el('button', { type: 'button', class: `star-btn${on ? ' on' : ''}`, 'aria-pressed': String(on), 'aria-label': on ? `Remove ${s.name} from watchlist` : `Add ${s.name} to watchlist`, onclick: () => toggleWatch(s.id) }, on ? '★' : '☆');
  };
  const gameLink = s => { const url = robloxUrl(s.link); return url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, s.name, ' ↗') : s.name; };

  const renderOverview = () => {
    const gems = approved();
    const subs = submissions();
    $('#st-games').textContent = gems.length;
    $('#st-ratio').textContent = gems.length ? (gems.reduce((t, g) => t + ratio(g), 0) / gems.length).toFixed(1) : '—';
    $('#st-pending').textContent = (isAdmin() ? subs : subs.filter(s => s.by === me.username)).filter(s => s.status === 'pending').length;
    $('#st-mine').textContent = isAdmin() ? accounts().filter(a => a.role === 'scout').length : gems.filter(s => s.by === me.username).length;

    const top = [...gems].sort((a, b) => ratio(b) - ratio(a)).slice(0, 5);
    $('#top-list').replaceChildren(...top.map(g => el('li', {},
      el('button', { type: 'button', class: 'tl-name', onclick: () => openGame(g.id) }, g.name),
      el('span', { class: 'tl-genre' }, g.genre), el('b', {}, ratio(g).toFixed(1)))));
    $('#top-empty').hidden = top.length > 0;

    const watched = watchOf(me.username).map(id => subs.find(s => s.id === id)).filter(Boolean);
    $('#watch-list').replaceChildren(...watched.map(s => el('li', {},
      el('button', { type: 'button', class: 'tl-name', onclick: () => openGame(s.id) }, s.name),
      el('span', { class: `status status-${s.status}` }, statusText[s.status]), watchBtn(s))));
    $('#watch-empty').hidden = watched.length > 0;

    const feedItems = (isAdmin() ? activity() : activity().filter(a => a.who === me.username || a.about === me.username)).slice(0, 6);
    $('#feed').replaceChildren(...feedItems.map(feedRow));
    $('#feed-empty').hidden = feedItems.length > 0;

    const linked = !!me.discord;
    $('#ov-discord-title').textContent = linked ? `Linked as ${me.discord.name}` : 'Connect Discord';
    $('#ov-discord-text').textContent = linked ? 'You can sign in with Discord on this device.' : 'Link your Discord to sign in with one click.';
  };
  const feedRow = a => el('li', {}, el('span', { class: 'feed-who' }, a.who), ' ', a.text, el('time', { datetime: a.t, title: new Date(a.t).toLocaleString() }, ago(a.t)));

  const renderGems = () => {
    const gems = approved();
    const genreSel = $('#gem-genre');
    const genres = [...new Set(gems.map(g => g.genre))].sort();
    const current = genreSel.value;
    genreSel.replaceChildren(el('option', { value: '' }, 'All genres'), ...genres.map(g => el('option', { value: g }, g)));
    genreSel.value = genres.includes(current) ? current : '';
    const q = $('#gem-search').value.trim().toLowerCase();
    const sort = $('#gem-sort').value;
    const watched = watchOf(me.username);
    const list = gems
      .filter(g => (!q || g.name.toLowerCase().includes(q) || g.by.toLowerCase().includes(q)) && (!genreSel.value || g.genre === genreSel.value) && (!$('#gem-watch-only').checked || watched.includes(g.id)))
      .sort((a, b) => sort === 'ccu' ? b.ccu - a.ccu : sort === 'visits' ? a.visits - b.visits : sort === 'new' ? (b.reviewedAt || b.date).localeCompare(a.reviewedAt || a.date) : sort === 'rating' ? (b.rating || 0) - (a.rating || 0) || ratio(b) - ratio(a) : ratio(b) - ratio(a));
    const best = Math.max(1, ...gems.map(ratio));
    $('#gem-rows').replaceChildren(...list.map(g => el('div', { class: 'gem-row', role: 'row' },
      el('span', { role: 'cell', class: 'g-name', 'data-label': 'Game' }, gameLink(g), el('small', {}, `by ${g.by}`)),
      el('span', { role: 'cell', 'data-label': 'Genre' }, g.genre),
      el('span', { role: 'cell', 'data-label': 'CCU' }, fmt(g.ccu)),
      el('span', { role: 'cell', 'data-label': 'Visits' }, fmt(g.visits)),
      el('span', { role: 'cell', class: 'g-ratio', 'data-label': 'CCU / 1K' }, el('i', { style: `--w:${Math.max(6, (ratio(g) / best) * 100).toFixed(0)}%`, 'aria-hidden': 'true' }), ratio(g).toFixed(1)),
      el('span', { role: 'cell', class: 'g-stars', 'data-label': 'Rating', 'aria-label': g.rating ? `${g.rating} of 5 stars` : 'Not rated' }, stars(g.rating)),
      el('span', { role: 'cell', class: 'g-actions' }, watchBtn(g), el('button', { type: 'button', class: 'mini', onclick: () => openGame(g.id) }, 'Details')))));
    $('#gem-empty').hidden = list.length > 0;
    $('#gem-empty').textContent = gems.length ? 'No games match that search.' : 'No approved games yet — once an admin approves a submission it shows up here.';
  };

  const statusText = { pending: 'WAITING', approved: 'APPROVED', rejected: 'PASSED' };
  const renderSubs = () => {
    const mine = visibleSubs();
    const badge = mine.filter(s => s.status === 'pending').length;
    $('#subs-count').textContent = badge; $('#subs-count').hidden = badge === 0;
    const q = $('#sub-search').value.trim().toLowerCase();
    const shown = mine.filter(s => (subFilter === 'all' || s.status === subFilter) && (!q || `${s.name} ${s.by} ${s.genre}`.toLowerCase().includes(q))).sort((a, b) => b.date.localeCompare(a.date));
    $('#subs').replaceChildren(...shown.map(s => el('article', { class: `sub sub-${s.status}` },
      el('div', { class: 'sub-top' }, el('span', { class: `status status-${s.status}` }, statusText[s.status]), el('span', {}, ago(s.date))),
      el('h3', {}, gameLink(s)),
      el('p', { class: 'sub-meta' }, `${s.genre} · ${fmt(s.ccu)} CCU · ${fmt(s.visits)} visits · ${ratio(s).toFixed(1)} per 1K`),
      s.rating ? el('p', { class: 'sub-rating' }, stars(s.rating), s.comment ? el('span', {}, ` “${s.comment}”`) : '') : '',
      el('div', { class: 'sub-foot' }, el('span', {}, `by ${s.by}`),
        el('div', { class: 'sub-actions' },
          watchBtn(s),
          el('button', { type: 'button', class: `mini${isAdmin() && s.status === 'pending' ? ' mini-yes' : ''}`, onclick: () => openGame(s.id) }, isAdmin() && s.status === 'pending' ? 'Review' : 'Details'))))));
    $('#subs-empty').hidden = shown.length > 0;
  };

  const renderBoard = () => {
    const subs = submissions();
    const rows = accounts().map(a => {
      const mine = subs.filter(s => s.by === a.username);
      const ok = mine.filter(s => s.status === 'approved');
      const stars = ok.reduce((t, s) => t + (s.rating || 0), 0);
      return { a, total: mine.length, ok: ok.length, rate: mine.length ? Math.round((ok.length / mine.length) * 100) : 0, points: ok.length * 3 + mine.length + stars };
    }).filter(r => r.total > 0).sort((x, y) => y.points - x.points || y.ok - x.ok);
    $('#board').replaceChildren(...rows.map((r, i) => el('li', { class: `board-row${r.a.username === me.username ? ' is-me' : ''}` },
      el('span', { class: 'board-pos' }, String(i + 1).padStart(2, '0')),
      el('span', { class: 'avatar avatar-sm' }, discordAvatar(r.a.discord) ? el('img', { src: discordAvatar(r.a.discord), alt: '' }) : r.a.username.charAt(0).toUpperCase()),
      el('div', { class: 'board-name' }, el('b', {}, r.a.discord ? r.a.discord.name : r.a.username), el('span', {}, `${r.ok} approved · ${r.total} sent · ${r.rate}% hit rate`)),
      el('b', { class: 'board-pts' }, `${r.points}`, el('small', {}, ' pts')))));
    $('#board-empty').hidden = rows.length > 0;
  };

  const renderDiscord = () => {
    const box = $('#discord-me');
    const { clientId } = settings();
    if (me.discord) {
      box.replaceChildren(
        el('div', { class: 'discord-card' },
          el('span', { class: 'avatar' }, discordAvatar(me.discord) ? el('img', { src: discordAvatar(me.discord), alt: '' }) : me.discord.name.charAt(0)),
          el('div', {}, el('b', {}, me.discord.name), el('span', {}, `@${me.discord.handle} · linked to ${me.username}`))),
        el('div', { class: 'form-row' },
          el('button', { type: 'button', class: 'discord-btn', onclick: () => startDiscord('link', $('#discord-note')) }, 'RE-LINK DISCORD'),
          el('button', { type: 'button', class: 'ghost-btn', onclick: unlinkDiscord }, 'UNLINK')));
    } else {
      box.replaceChildren(
        el('p', { class: 'hint-block' }, clientId ? 'Link your Discord account, then use “Continue with Discord” to sign in.' : 'Discord isn\'t set up yet. ' + (isAdmin() ? 'Add your Discord app\'s Client ID in Settings first.' : 'Ask an admin to finish the Discord setup.')),
        el('button', { type: 'button', class: 'discord-btn', disabled: !clientId, onclick: () => startDiscord('link', $('#discord-note')) }, el('span', { class: 'sr' }, ''), 'LINK MY DISCORD'));
    }
  };
  const unlinkDiscord = () => {
    updateAccount(me.username, { discord: null });
    refreshMe(); log('unlinked their Discord');
    note($('#discord-note'), 'Discord unlinked.');
    paintWho(); renderAll();
  };

  const renderActivity = () => {
    if (!isAdmin()) return;
    const list = activity();
    $('#activity').replaceChildren(...list.map(feedRow));
    $('#activity-empty').hidden = list.length > 0;
  };

  const renderAccounts = () => {
    if (!isAdmin()) return;
    const subs = submissions();
    $('#accounts').replaceChildren(...accounts().map(a => {
      const count = subs.filter(s => s.by === a.username).length;
      return el('li', {},
        el('span', { class: 'avatar avatar-sm' }, discordAvatar(a.discord) ? el('img', { src: discordAvatar(a.discord), alt: '' }) : a.username.charAt(0).toUpperCase()),
        el('div', {}, el('b', {}, a.username, a.discord ? el('em', { class: 'discord-tag' }, ` @${a.discord.handle}`) : ''), el('span', {}, `${a.role.toUpperCase()} · ${count} game${count === 1 ? '' : 's'} · added ${a.created}`)),
        a.builtIn || a.username === me.username ? el('em', { class: 'pill' }, a.builtIn ? 'Main admin' : 'You')
          : el('button', { type: 'button', class: 'mini mini-del', onclick: () => removeAccount(a.username) }, 'Remove'));
    }));
  };

  const renderSettings = () => {
    if (!isAdmin()) return;
    const f = $('#settings-form');
    const st = settings();
    const stored = read(KEYS.settings, {});
    f.clientId.value = stored.clientId || '';
    f.clientId.placeholder = CONFIG.discordClientId ? `${CONFIG.discordClientId} (from the site settings file)` : 'e.g. 123456789012345678';
    f.webhook.value = stored.webhook || '';
    f.webhook.placeholder = CONFIG.discordWebhook ? 'Set in the site settings file' : 'https://discord.com/api/webhooks/…';
    f.notifySubmit.checked = st.notifySubmit; f.notifyReview.checked = st.notifyReview; f.notifyScout.checked = st.notifyScout;
    $('#redirect-url').textContent = redirectUri();
  };

  const renderAll = () => { refreshMe(); renderOverview(); renderGems(); renderSubs(); renderBoard(); renderDiscord(); renderActivity(); renderAccounts(); renderSettings(); };

  /* ---------- game dialog: details, review, edit, withdraw ---------- */
  const dlg = $('#dlg');
  const openGame = id => {
    const s = submissions().find(x => x.id === id);
    if (!s) return;
    dlg.dataset.id = id;
    $('#dlg-kicker').textContent = `${statusText[s.status]} · SENT ${ago(s.date).toUpperCase()} BY ${s.by.toUpperCase()}`;
    $('#dlg-title').replaceChildren(gameLink(s));
    $('#dlg-meta').textContent = [s.genre, s.dev ? `by ${s.dev}` : '', `found on ${s.found}`].filter(Boolean).join(' · ');
    $('#dlg-stats').replaceChildren(...[
      ['CCU', fmt(s.ccu)], ['VISITS', fmt(s.visits)], ['CCU / 1K', ratio(s).toFixed(2)], ['FAVOURITES', s.favs ? fmt(s.favs) : '—'],
    ].map(([k, v]) => el('div', {}, el('span', {}, k), el('b', {}, v))));
    $('#dlg-notes').textContent = s.notes || 'No notes from the scout.';
    $('#dlg-review').replaceChildren(...(s.reviewedBy ? [el('p', { class: 'sub-rating' }, stars(s.rating), ` — ${s.status === 'approved' ? 'approved' : 'passed'} by ${s.reviewedBy}`, s.comment ? el('span', { class: 'block' }, `“${s.comment}”`) : '')] : []));
    const rb = $('#review-box');
    rb.hidden = !isAdmin();
    $$('input[name="rating"]', rb).forEach(r => { r.checked = Number(r.value) === (s.rating || 0); });
    $('textarea[name="comment"]', rb).value = s.comment || '';
    $('#dlg-approve').textContent = s.status === 'approved' ? 'Save review' : 'Approve';
    $('#dlg-pass').hidden = s.status === 'rejected';
    const own = s.by === me.username;
    $('#dlg-actions').replaceChildren(
      watchBtn(s),
      own && s.status === 'pending' ? el('button', { type: 'button', class: 'mini', onclick: () => editSub(s.id) }, 'Edit') : '',
      own && s.status === 'pending' ? el('button', { type: 'button', class: 'mini mini-del', onclick: () => withdrawSub(s.id) }, 'Withdraw') : '',
      isAdmin() ? el('button', { type: 'button', class: 'mini mini-del', onclick: () => deleteSub(s.id) }, 'Delete') : '');
    if (!dlg.open) dlg.showModal();
  };
  const review = status => {
    const id = dlg.dataset.id;
    const rating = Number(($('input[name="rating"]:checked', dlg) || {}).value || 0) || null;
    const comment = $('textarea[name="comment"]', dlg).value.trim();
    let updated = null;
    saveSubmissions(submissions().map(s => {
      if (s.id !== id) return s;
      updated = { ...s, status, rating, comment, reviewedBy: me.username, reviewedAt: new Date().toISOString() };
      return updated;
    }));
    if (!updated) return;
    log(`${status === 'approved' ? 'approved' : 'passed on'} “${updated.name}”${rating ? ` (${rating}★)` : ''}`, updated.by);
    notify('review', updated);
    dlg.close(); renderAll();
  };
  $('#dlg-approve').addEventListener('click', () => review('approved'));
  $('#dlg-pass').addEventListener('click', () => review('rejected'));
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  const deleteSub = id => {
    const s = submissions().find(x => x.id === id);
    if (!s || !confirm(`Delete “${s.name}”? This can't be undone.`)) return;
    saveSubmissions(submissions().filter(x => x.id !== id));
    log(`deleted “${s.name}”`, s.by);
    dlg.close(); renderAll();
  };
  const withdrawSub = id => {
    const s = submissions().find(x => x.id === id);
    if (!s || !confirm(`Withdraw “${s.name}”?`)) return;
    saveSubmissions(submissions().filter(x => x.id !== id));
    log(`withdrew “${s.name}”`);
    dlg.close(); renderAll();
  };

  /* ---------- submit / edit ---------- */
  const submitForm = $('#submit-form');
  const preview = () => {
    const ccu = Number(submitForm.ccu.value), visits = Number(submitForm.visits.value);
    const ok = ccu >= 0 && visits > 0 && submitForm.ccu.value !== '';
    $('#ratio-preview').textContent = ok ? ((ccu / visits) * 1000).toFixed(1) : '—';
    $('#ratio-verdict').textContent = ok ? verdict((ccu / visits) * 1000) : '';
  };
  const resetSubmit = () => {
    submitForm.reset(); submitForm.editing.value = '';
    $('#cancel-edit').hidden = true;
    $('#submit-btn').firstChild.textContent = 'SUBMIT FOR SCOUTING ';
    preview();
  };
  const editSub = id => {
    const s = submissions().find(x => x.id === id);
    if (!s) return;
    dlg.close();
    ['name', 'link', 'genre', 'found', 'ccu', 'visits', 'dev', 'favs', 'notes'].forEach(k => { submitForm[k].value = s[k] ?? ''; });
    submitForm.editing.value = id;
    $('#cancel-edit').hidden = false;
    $('#submit-btn').firstChild.textContent = 'SAVE CHANGES ';
    preview();
    selectTab('submit');
  };
  $('#cancel-edit').addEventListener('click', () => { resetSubmit(); note($('#submit-note'), ''); });
  submitForm.addEventListener('input', preview);
  submitForm.addEventListener('submit', e => {
    e.preventDefault();
    const f = submitForm, msg = $('#submit-note');
    const required = [f.name, f.link, f.ccu, f.visits];
    required.forEach(x => x.classList.toggle('is-invalid', !x.value.trim()));
    if (required.some(x => !x.value.trim())) { note(msg, 'Please fill in the game name, link, players and visits.', true); return; }
    if (!robloxUrl(f.link.value)) { f.link.classList.add('is-invalid'); note(msg, 'Use a roblox.com game link or a number place ID.', true); return; }
    if (Number(f.visits.value) < 1) { f.visits.classList.add('is-invalid'); note(msg, 'Visits must be at least 1.', true); return; }
    const editing = f.editing.value;
    const pid = placeId(f.link.value);
    const dupe = pid && submissions().find(s => s.id !== editing && placeId(s.link) === pid);
    if (dupe) { f.link.classList.add('is-invalid'); note(msg, `That game was already sent in by ${dupe.by} (${statusText[dupe.status].toLowerCase()}).`, true); return; }
    const fields = {
      name: f.name.value.trim(), link: f.link.value.trim(), genre: f.genre.value, found: f.found.value,
      ccu: Math.round(Number(f.ccu.value)), visits: Math.round(Number(f.visits.value)),
      dev: f.dev.value.trim(), favs: f.favs.value ? Math.round(Number(f.favs.value)) : null, notes: f.notes.value.trim(),
    };
    if (editing) {
      saveSubmissions(submissions().map(s => (s.id === editing ? { ...s, ...fields, edited: new Date().toISOString() } : s)));
      log(`edited “${fields.name}”`);
      note(msg, 'Changes saved.');
    } else {
      const s = { id: uid(), ...fields, by: me.username, date: new Date().toISOString(), status: 'pending' };
      saveSubmissions([...submissions(), s]);
      log(`sent in “${s.name}” to be scouted`);
      notify('submit', s);
      note(msg, isAdmin() ? 'Added — review it under Submissions to approve it.' : 'Thanks! Your game is waiting for review — follow it under Submissions.');
    }
    resetSubmit();
    renderAll();
  });

  /* ---------- lists: filters ---------- */
  ['#gem-search', '#gem-genre', '#gem-sort', '#gem-watch-only'].forEach(s => $(s).addEventListener('input', renderGems));
  $('#sub-search').addEventListener('input', renderSubs);
  $$('.sub-filter [data-filter]').forEach(b => b.addEventListener('click', () => {
    subFilter = b.dataset.filter;
    $$('.sub-filter [data-filter]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderSubs();
  }));

  /* ---------- downloads ---------- */
  const download = (name, text, type) => {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#export-subs').addEventListener('click', () => {
    if (!isAdmin()) return;
    const cols = ['name', 'link', 'genre', 'found', 'dev', 'ccu', 'visits', 'favs', 'ratio', 'status', 'rating', 'comment', 'by', 'reviewedBy', 'date', 'notes'];
    const cell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = submissions().map(s => cols.map(c => cell(c === 'ratio' ? ratio(s).toFixed(2) : s[c])).join(','));
    download(`rushed-submissions-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + [cols.join(','), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
  });

  /* ---------- scouts ---------- */
  $('#scout-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.currentTarget, msg = $('#scout-note');
    const user = f.username.value.trim(), pass = f.password.value;
    if (!/^[A-Za-z0-9_]{3,24}$/.test(user)) { note(msg, 'Usernames are 3–24 letters, numbers or underscores.', true); return; }
    if (pass.length < 6) { note(msg, 'Passwords need at least 6 characters.', true); return; }
    const list = accounts();
    if (list.some(a => a.username.toLowerCase() === user.toLowerCase())) { note(msg, 'That username is already taken.', true); return; }
    const acc = { username: user, hash: fingerprint(user, pass), role: f.role.value, created: new Date().toISOString().slice(0, 10), discord: null };
    saveAccounts([...list, acc]);
    log(`added ${acc.role} ${user}`, user);
    notify('scout', acc);
    f.reset();
    note(msg, `Account created. Share the username “${user}” and its password with them privately.`);
    renderAll();
  });
  const removeAccount = username => {
    const theirs = submissions().filter(s => s.by === username);
    const extra = theirs.length ? ` This also removes the ${theirs.length} game${theirs.length === 1 ? '' : 's'} they sent in.` : '';
    if (!confirm(`Remove ${username}'s account?${extra}`)) return;
    const ids = theirs.map(s => s.id);
    saveAccounts(accounts().filter(a => a.username !== username));
    saveSubmissions(submissions().filter(s => s.by !== username));
    const watch = read(KEYS.watch, {});
    delete watch[username];
    Object.keys(watch).forEach(u => { watch[u] = watch[u].filter(id => !ids.includes(id)); });
    write(KEYS.watch, watch);
    log(`removed ${username}${theirs.length ? ` and their ${theirs.length} game${theirs.length === 1 ? '' : 's'}` : ''}`, username);
    renderAll();
  };

  /* ---------- settings, backup, wipe ---------- */
  $('#settings-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.currentTarget, msg = $('#settings-note');
    const clientId = f.clientId.value.trim();
    const webhook = f.webhook.value.trim();
    if (clientId && !/^\d{15,22}$/.test(clientId)) { note(msg, 'The Client ID is a long number from your Discord app\'s OAuth2 page.', true); return; }
    if (webhook && !/^https:\/\/(?:canary\.|ptb\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook)) { note(msg, 'That doesn\'t look like a Discord webhook URL.', true); return; }
    write(KEYS.settings, { clientId, webhook, notifySubmit: f.notifySubmit.checked, notifyReview: f.notifyReview.checked, notifyScout: f.notifyScout.checked });
    log('updated the Discord settings');
    note(msg, 'Settings saved on this device.');
    renderAll();
  });
  $('#test-webhook').addEventListener('click', async () => {
    const msg = $('#settings-note');
    const url = $('#settings-form').webhook.value.trim() || settings().webhook;
    if (!url) { note(msg, 'Add a webhook URL first.', true); return; }
    note(msg, 'Sending…');
    const r = await postWebhook({ title: 'RUSHED scouting is connected ✳', color: COLORS.red, description: `Test message sent by ${me.username}. New submissions and reviews will show up here.` }, url);
    note(msg, r.ok ? 'Sent! Check your Discord channel.' : `That didn't work: ${r.reason}.`, !r.ok);
  });
  $('#copy-redirect').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(redirectUri()); note($('#settings-note'), 'Redirect address copied.'); } catch { note($('#settings-note'), 'Select the address and copy it by hand.', true); }
  });
  $('#backup-save').addEventListener('click', () => {
    const data = { app: 'rushed-dashboard', version: 2, exported: new Date().toISOString(), accounts: read(KEYS.accounts, []), admin: read(KEYS.admin, {}), submissions: submissions(), activity: activity(), watch: read(KEYS.watch, {}), settings: read(KEYS.settings, {}) };
    download(`rushed-dashboard-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
    note($('#backup-note'), 'Backup saved. Keep it somewhere safe — it includes account logins.');
  });
  $('#backup-load').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    const msg = $('#backup-note');
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'rushed-dashboard' || !Array.isArray(data.submissions) || !Array.isArray(data.accounts)) throw new Error();
      if (!confirm('Load this backup? It replaces the accounts, games and settings on this device.')) return;
      write(KEYS.accounts, data.accounts); write(KEYS.admin, data.admin || {}); write(KEYS.subs, data.submissions);
      write(KEYS.activity, data.activity || []); write(KEYS.watch, data.watch || {}); write(KEYS.settings, data.settings || {});
      refreshMe();
      if (!me) { session.clear(); showLogin(); return; }
      log('loaded a backup');
      note(msg, `Backup loaded: ${data.submissions.length} games, ${data.accounts.length + 1} accounts.`);
      renderAll();
    } catch { note(msg, 'That file isn\'t a RUSHED dashboard backup.', true); }
  });
  $('#wipe-subs').addEventListener('click', () => {
    if (!confirm('Delete ALL submissions and the activity log? This can\'t be undone.')) return;
    write(KEYS.subs, []); write(KEYS.activity, []); write(KEYS.watch, {});
    log('deleted all submissions');
    renderAll();
  });
  $('#clear-activity').addEventListener('click', () => {
    if (!confirm('Clear the activity log?')) return;
    write(KEYS.activity, []); renderAll();
  });

  /* ---------- start ---------- */
  (async () => {
    const back = await finishDiscord();
    if (back && back.error) {
      const saved = session.get();
      me = saved ? accounts().find(a => a.username === saved) || null : null;
      if (me) { showApp('discord'); note($('#discord-note'), back.error, true); }
      else { showLogin(); note($('#discord-login-note'), back.error, true); }
      return;
    }
    if (back && back.mode === 'link') {
      const owner = accounts().find(a => a.discord && a.discord.id === back.discord.id && a.username !== back.user);
      me = accounts().find(a => a.username === back.user) || null;
      if (!me) { showLogin(); note($('#discord-login-note'), 'Please sign in again, then link Discord.', true); return; }
      session.set(me.username, !!localStorage.getItem(KEYS.session));
      if (owner) { showApp('discord'); note($('#discord-note'), `That Discord is already linked to ${owner.username}.`, true); return; }
      updateAccount(me.username, { discord: back.discord });
      refreshMe(); log(`linked Discord @${back.discord.handle}`);
      showApp('discord'); note($('#discord-note'), `Linked! You can now sign in with Discord as ${back.discord.name}.`);
      return;
    }
    if (back && back.mode === 'login') {
      const acc = accounts().find(a => a.discord && a.discord.id === back.discord.id);
      if (!acc) { showLogin(); note($('#discord-login-note'), `No RUSHED account is linked to @${back.discord.handle} on this device yet. Sign in with your RUSHED login and link Discord first.`, true); return; }
      acc.discord = back.discord; updateAccount(acc.username, { discord: back.discord });
      signIn(acc, true);
      showApp();
      return;
    }
    const saved = session.get();
    const acc = saved && accounts().find(a => a.username === saved);
    if (acc) { me = acc; showApp(); } else showLogin();
  })();
})();
