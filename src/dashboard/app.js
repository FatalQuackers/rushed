// RUSHED scouting dashboard — runs the sign-in, sign-up and dashboard pages.
// Data lives in Supabase. Who can see or change what is enforced by the database
// rules in supabase/setup.sql, so this file only decides what to show.
(() => {
  'use strict';
  const CFG = window.RUSHED_DASH || {};
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const page = document.body.dataset.page;
  const isRecovery = /type=recovery/.test(location.hash);
  const hashError = new URLSearchParams(location.hash.slice(1)).get('error_description');

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    kids.flat(Infinity).forEach(c => { if (c != null && c !== false && c !== '') n.append(c instanceof Node ? c : document.createTextNode(String(c))); });
    return n;
  };
  const say = (node, text, err = false) => { if (!node) return; node.textContent = text || ''; node.classList.toggle('err', !!err); };
  const busy = async (btn, fn) => { if (btn) btn.disabled = true; try { return await fn(); } finally { if (btn) btn.disabled = false; } };

  /* ---------- theme ---------- */
  const themeBtn = $('#theme-btn');
  if (themeBtn) themeBtn.addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
    if (dark) document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('rushed-theme', dark ? 'dark' : 'light'); } catch {}
  });

  /* ---------- Supabase ---------- */
  // Accept a pasted dashboard address (supabase.com/dashboard/project/<id>) as well as the API URL.
  const dashRef = String(CFG.supabaseUrl || '').match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dashRef) CFG.supabaseUrl = `https://${dashRef[1]}.supabase.co`;
  const configured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
  const sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;
  const dashUrl = new URL(document.body.dataset.root + 'dashboard/', location.href).href;
  $$('#ticket-link').forEach(a => { a.href = CFG.accessTicketUrl || '#'; if (CFG.accessTicketName) a.textContent = CFG.accessTicketName; });
  if (!configured) {
    $('#setup-warn').hidden = false;
    $$('form button[type=submit]').forEach(b => { b.disabled = true; });
    return;
  }
  const friendly = e => {
    const m = (e && (e.message || e.error_description)) || String(e || 'Something went wrong');
    if (/Invalid login credentials/i.test(m)) return 'That email and password don\'t match.';
    if (/Email not confirmed/i.test(m)) return 'Confirm your email first. Check your inbox for the link we sent.';
    if (/User already registered/i.test(m)) return 'There\'s already an account with that email. Sign in instead.';
    if (/rate limit|too many/i.test(m)) return 'Too many tries. Wait a minute and try again.';
    if (/Password should be/i.test(m)) return 'That password is too weak. Use at least 8 characters.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Couldn\'t reach the dashboard server. Check your connection.';
    if (/row-level security|permission denied/i.test(m)) return 'You don\'t have permission to do that.';
    return m;
  };

  if (page === 'signup') return initSignup();
  initApp();

  /* =====================================================================
     SIGN UP
     ===================================================================== */
  function initSignup() {
    const f = $('#signup-form');
    const msg = $('#signup-note');
    f.addEventListener('submit', e => {
      e.preventDefault();
      const v = k => f[k].value.trim();
      if (!v('username') || !v('discord') || !v('email') || !f.password.value) return say(msg, 'Fill in your name, Discord, email and a password.', true);
      if (!f.email.checkValidity()) return say(msg, 'That email doesn\'t look right.', true);
      if (f.password.value.length < 8) return say(msg, 'Use at least 8 characters for your password.', true);
      if (!f.rules.checked) return say(msg, 'Tick the box to agree to keep dashboard data inside the team.', true);
      busy($('button[type=submit]', f), async () => {
        say(msg, 'Creating your account…');
        const { data, error } = await sb.auth.signUp({
          email: v('email'), password: f.password.value,
          options: { emailRedirectTo: dashUrl, data: { username: v('username'), discord: v('discord').replace(/^@/, ''), roblox: v('roblox') } },
        });
        if (error) return say(msg, friendly(error), true);
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) return say(msg, 'There\'s already an account with that email. Sign in instead.', true);
        $$('.done-email').forEach(b => { b.textContent = v('email'); });
        $('#done-confirm').hidden = !!data.session;
        if (data.session) await sb.auth.signOut();
        f.hidden = true; $('#signup-done').hidden = false;
      });
    });
  }

  /* =====================================================================
     SIGN IN + DASHBOARD
     ===================================================================== */
  function initApp() {
    /* ---------- state ---------- */
    const PROFILE_COLS = 'id,username,discord,roblox,role,status,created_at,approved_at';
    let user = null, me = null;
    let team = [], games = [], statsBy = new Map(), watch = new Set(), activity = [], emails = new Map();
    let loadedAt = 0;
    const ROLES = { founder: 'Founder', co_founder: 'Co-Founder', management: 'Management', scout_lead: 'Scout Lead', scout: 'Scout' };
    const OWNER = ['founder', 'co_founder'];
    const STAFF = [...OWNER, 'management', 'scout_lead'];
    const isOwner = () => !!me && OWNER.includes(me.role);
    const isStaff = () => !!me && STAFF.includes(me.role);
    const CONTACT = { none: 'Not contacted', contacted: 'Contacted', talking: 'In talks', deal: 'Deal closed', declined: 'Declined' };
    const STATUS = { pending: 'Waiting', approved: 'Approved', rejected: 'Passed' };
    const GENRES = ['Simulator', 'Tycoon', 'Obby', 'Fighting', 'Shooter', 'Horror', 'RPG', 'Roleplay', 'Tower Defense', 'Survival', 'Racing', 'Sports', 'Puzzle', 'Party', 'Incremental', 'Strategy', 'Adventure', 'Other'];

    const authView = $('#auth-view'), appView = $('#app-view');
    const forms = { login: $('#login-form'), forgot: $('#forgot-form'), reset: $('#reset-form'), pending: $('#pending-view') };
    const showAuth = which => {
      appView.hidden = true; authView.hidden = false;
      Object.entries(forms).forEach(([k, n]) => { n.hidden = k !== which; });
      const first = forms[which] && $('input', forms[which]); if (first) first.focus({ preventScroll: true });
    };
    $$('[data-auth]').forEach(b => b.addEventListener('click', () => showAuth(b.dataset.auth)));
    $('#forgot-open').addEventListener('click', () => { forms.forgot.email.value = forms.login.email.value; showAuth('forgot'); });
    $$('[data-signout]').forEach(b => b.addEventListener('click', async () => { await sb.auth.signOut(); me = null; showAuth('login'); }));

    let recovering = isRecovery;
    sb.auth.onAuthStateChange(event => { if (event === 'PASSWORD_RECOVERY') { recovering = true; showAuth('reset'); } });

    forms.login.addEventListener('submit', e => {
      e.preventDefault();
      const f = e.currentTarget, msg = $('#login-note');
      if (!f.email.value.trim() || !f.password.value) return say(msg, 'Enter your email and password.', true);
      busy($('button[type=submit]', f), async () => {
        const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
        if (error) { f.password.value = ''; return say(msg, friendly(error), true); }
        say(msg, ''); f.reset();
        await route(data.session);
      });
    });
    forms.forgot.addEventListener('submit', e => {
      e.preventDefault();
      const f = e.currentTarget, msg = $('#forgot-note');
      if (!f.email.checkValidity() || !f.email.value) return say(msg, 'Enter the email you signed up with.', true);
      busy($('button[type=submit]', f), async () => {
        const { error } = await sb.auth.resetPasswordForEmail(f.email.value.trim(), { redirectTo: dashUrl });
        say(msg, error ? friendly(error) : 'If that email has an account, a reset link is on its way.', !!error);
      });
    });
    forms.reset.addEventListener('submit', e => {
      e.preventDefault();
      const f = e.currentTarget, msg = $('#reset-note');
      if (f.password.value.length < 8) return say(msg, 'Use at least 8 characters.', true);
      if (f.password.value !== f.repeat.value) return say(msg, 'The two passwords don\'t match.', true);
      busy($('button[type=submit]', f), async () => {
        const { data, error } = await sb.auth.updateUser({ password: f.password.value });
        if (error) return say(msg, friendly(error), true);
        recovering = false; f.reset(); history.replaceState(null, '', location.pathname);
        const { data: s } = await sb.auth.getSession();
        await route(s.session || (data && data.session));
        toast('Password changed.');
      });
    });
    $('#pending-refresh').addEventListener('click', async () => { const { data } = await sb.auth.getSession(); route(data.session); });

    const route = async session => {
      if (recovering) return showAuth('reset');
      if (!session) return showAuth('login');
      user = session.user;
      const { data: prof, error } = await sb.from('profiles').select(PROFILE_COLS).eq('id', user.id).maybeSingle();
      if (error) { say($('#login-note'), friendly(error), true); return showAuth('login'); }
      if (!prof || prof.status !== 'approved') return showPending(prof);
      me = prof;
      await startApp();
    };
    const showPending = prof => {
      showAuth('pending');
      $('#pending-email').textContent = user.email;
      const status = prof ? prof.status : 'pending';
      const blocked = status === 'rejected' || status === 'suspended';
      $('#pending-eyebrow').textContent = blocked ? (status === 'rejected' ? 'ACCESS DECLINED' : 'ACCESS PAUSED') : 'WAITING FOR VERIFICATION';
      $('#pending-title').textContent = blocked ? 'No dashboard access right now.' : 'You\'re almost in.';
      $('#pending-body').hidden = blocked;
      if (blocked && !$('#blocked-msg')) $('#pending-body').after(el('p', { id: 'blocked-msg', class: 'muted', text: 'An owner has turned off dashboard access for this account. If you think that\'s a mistake, ask in the RUSHED Discord.' }));
      if (!blocked && $('#blocked-msg')) $('#blocked-msg').remove();
    };

    (async () => {
      if (hashError) say($('#login-note'), hashError.replace(/\+/g, ' '), true);
      const { data } = await sb.auth.getSession();
      await route(data.session);
    })();

    /* ---------- helpers ---------- */
    const fmt = n => { n = Number(n) || 0; const a = Math.abs(n); return a >= 1e6 ? (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K' : String(Math.round(n)); };
    const eff = g => (g.visits > 0 ? (g.ccu / g.visits) * 1000 : 0);
    const verdict = r => (r >= 5 ? 'Exceptional, a real hidden gem' : r >= 2 ? 'Strong, worth a closer look' : r >= 1 ? 'Promising' : 'Low for now');
    const stars = n => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '');
    const placeId = link => { const v = String(link || '').trim(); const m = v.match(/^\d+$/) || v.match(/roblox\.com\/(?:[a-z-]+\/)?games\/(\d+)/i); return m ? (m[1] || m[0]) : null; };
    const robloxUrl = link => { const id = placeId(link); return id ? `https://www.roblox.com/games/${id}` : null; };
    const safeUrl = (v, hosts) => {
      v = String(v || '').trim(); if (!v) return '';
      try { const u = new URL(/^https?:\/\//i.test(v) ? v : 'https://' + v); return u.protocol === 'https:' && hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h)) ? u.href : null; } catch { return null; }
    };
    const DISCORD_HOSTS = ['discord.gg', 'discord.com', 'discordapp.com'], X_HOSTS = ['x.com', 'twitter.com'];
    const ago = iso => {
      const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
      if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`; return new Date(iso).toLocaleDateString();
    };
    const day = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const member = id => team.find(t => t.id === id);
    const nameOf = (id, fallback) => (member(id) || {}).username || fallback || 'someone';
    const byName = g => (g.legacy_by ? g.legacy_by : nameOf(g.submitted_by, 'former member'));
    const growth = g => {
      const list = statsBy.get(g.id) || [];
      if (list.length < 2) return null;
      const last = list[list.length - 1];
      const cut = new Date(last.recorded_at).getTime() - 7 * 86400e3;
      let base = list[0];
      for (const s of list) { if (new Date(s.recorded_at).getTime() <= cut) base = s; else break; }
      if (base === last || !base.ccu) return null;
      return ((last.ccu - base.ccu) / base.ccu) * 100;
    };
    const growthText = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(v >= 100 || v <= -100 ? 0 : 1)}%`);
    const growthEl = v => el('span', { class: v == null ? '' : v >= 0 ? 'up' : 'down' }, growthText(v));
    const pill = (cls, text) => el('span', { class: `pill ${cls}` }, text);
    let toastTimer;
    const toast = (text, err = false) => {
      const t = $('#toast'); t.textContent = text; t.classList.toggle('err', err); t.hidden = false;
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 6000 : 3200);
    };
    const run = async (promise, okText) => {
      const { error } = await promise;
      if (error) { toast(friendly(error), true); return false; }
      if (okText) toast(okText);
      await loadAll(); renderAll();
      return true;
    };
    const avatar = name => el('span', { class: 'avatar', 'aria-hidden': 'true' }, (name || '?').charAt(0).toUpperCase());

    /* ---------- loading ---------- */
    async function loadAll() {
      const [p, g, s, w, a] = await Promise.all([
        sb.from('profiles').select(PROFILE_COLS).order('created_at'),
        sb.from('games').select('*').order('created_at', { ascending: false }),
        sb.from('game_stats').select('game_id,ccu,visits,recorded_at').order('recorded_at').limit(20000),
        sb.from('watchlist').select('game_id'),
        sb.from('activity').select('*').order('at', { ascending: false }).limit(300),
      ]);
      const err = [p, g, s, w, a].find(r => r.error);
      if (err) { toast(friendly(err.error), true); return; }
      team = p.data; games = g.data; activity = a.data; watch = new Set(w.data.map(r => r.game_id));
      statsBy = new Map();
      s.data.forEach(r => { if (!statsBy.has(r.game_id)) statsBy.set(r.game_id, []); statsBy.get(r.game_id).push(r); });
      me = member(me.id) || me;
      if (isOwner()) { const { data } = await sb.rpc('member_emails'); emails = new Map((data || []).map(r => [r.id, r.email])); }
      loadedAt = Date.now();
    }

    async function startApp() {
      authView.hidden = true; appView.hidden = false;
      await loadAll();
      if (me.status !== 'approved') return route((await sb.auth.getSession()).data.session);
      fillGenreSelects();
      renderAll();
      go();
    }
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && me && !appView.hidden && Date.now() - loadedAt > 60e3) { await loadAll(); renderAll(); }
    });
    $('#refresh-btn').addEventListener('click', async () => { await loadAll(); renderAll(); toast('Up to date.'); });

    /* ---------- navigation ---------- */
    const views = $$('.view').map(v => v.id.replace('view-', ''));
    const allowed = v => views.includes(v) && !(v === 'settings' && !isOwner()) && !(v === 'activity' && !isStaff());
    function go() {
      if (!me || appView.hidden) return;
      let v = location.hash.slice(1) || 'overview';
      if (!allowed(v)) v = 'overview';
      $$('.view').forEach(n => { n.hidden = n.id !== `view-${v}`; });
      $$('[data-view]').forEach(a => { if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
      $('#main').scrollTo?.(0, 0); window.scrollTo(0, 0);
    }
    window.addEventListener('hashchange', go);

    /* ---------- render ---------- */
    function renderAll() {
      if (!me) return;
      $$('[data-owner]').forEach(n => { n.hidden = !isOwner(); });
      $$('[data-staff]').forEach(n => { n.hidden = !isStaff(); });
      $('#me-name').textContent = me.username; $('#me-role').textContent = ROLES[me.role];
      $('#me-avatar').textContent = me.username.charAt(0).toUpperCase();
      $('#hello-name').textContent = me.username;
      const pendingSubs = games.filter(g => g.status === 'pending');
      const myPending = isStaff() ? pendingSubs.length : pendingSubs.filter(g => g.submitted_by === me.id).length;
      $('#badge-subs').textContent = myPending; $('#badge-subs').hidden = !myPending;
      const waiting = team.filter(t => t.status === 'pending').length;
      $('#badge-team').textContent = waiting; $('#badge-team').hidden = !(isOwner() && waiting);
      renderOverview(); renderGems(); renderSubs(); renderOutreach(); renderLeader(); renderTeam(); renderActivity(); renderAccount();
      if (isOwner()) renderSettings();
    }

    const approved = () => games.filter(g => g.status === 'approved');
    const openBtn = (g, cls = 'name') => el('button', { type: 'button', class: cls, onclick: () => openGame(g.id) }, g.name);
    const feedRow = a => el('li', {}, el('b', {}, nameOf(a.who)), ' ', a.text, el('time', { datetime: a.at, title: new Date(a.at).toLocaleString() }, ago(a.at)));

    function renderOverview() {
      const gems = approved();
      $('#st-gems').textContent = gems.length;
      $('#st-eff').textContent = gems.length ? (gems.reduce((t, g) => t + eff(g), 0) / gems.length).toFixed(1) : '—';
      $('#st-pending-label').textContent = isStaff() ? 'WAITING FOR REVIEW' : 'YOUR WAITING GAMES';
      $('#st-pending').textContent = games.filter(g => g.status === 'pending' && (isStaff() || g.submitted_by === me.id)).length;
      $('#st-deals').textContent = games.filter(g => g.contact_status === 'deal').length;
      const top = [...gems].sort((a, b) => eff(b) - eff(a)).slice(0, 6);
      $('#ov-top').replaceChildren(...top.map(g => el('li', {}, openBtn(g), el('small', {}, g.genre), el('span', { class: 'num' }, eff(g).toFixed(1)))));
      $('#ov-top-empty').hidden = top.length > 0;
      const grow = gems.map(g => [g, growth(g)]).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]).slice(0, 6);
      $('#ov-growth').replaceChildren(...grow.map(([g, v]) => el('li', {}, openBtn(g), el('small', {}, fmt(g.ccu) + ' CCU'), el('span', { class: 'num' }, growthEl(v)))));
      $('#ov-growth-empty').hidden = grow.length > 0;
      const watched = games.filter(g => watch.has(g.id));
      $('#ov-watch').replaceChildren(...watched.map(g => el('li', {}, openBtn(g), pill(g.status, STATUS[g.status]), starBtn(g))));
      $('#ov-watch-empty').hidden = watched.length > 0;
      const feed = activity.slice(0, 7);
      $('#ov-feed').replaceChildren(...feed.map(feedRow));
      $('#ov-feed-empty').hidden = feed.length > 0;
    }

    const starBtn = g => {
      const on = watch.has(g.id);
      return el('button', { type: 'button', class: `star${on ? ' on' : ''}`, 'aria-pressed': String(on), title: on ? 'Remove from watchlist' : 'Add to watchlist',
        'aria-label': `${on ? 'Remove' : 'Add'} ${g.name} ${on ? 'from' : 'to'} your watchlist`,
        onclick: () => run(on ? sb.from('watchlist').delete().eq('game_id', g.id).eq('user_id', me.id) : sb.from('watchlist').insert({ game_id: g.id, user_id: me.id })) }, on ? '★' : '☆');
    };
    const socials = g => {
      const links = [];
      const r = robloxUrl(g.link); if (r) links.push(el('a', { href: r, target: '_blank', rel: 'noopener noreferrer' }, 'ROBLOX ↗'));
      const d = safeUrl(g.discord_url, DISCORD_HOSTS); if (d) links.push(el('a', { href: d, target: '_blank', rel: 'noopener noreferrer' }, 'DISCORD ↗'));
      const x = safeUrl(g.x_url, X_HOSTS); if (x) links.push(el('a', { href: x, target: '_blank', rel: 'noopener noreferrer' }, 'X ↗'));
      return el('span', { class: 'socials' }, links);
    };

    function fillGenreSelects() {
      const all = [...new Set([...GENRES, ...games.map(g => g.genre)])];
      $$('.genre-select').forEach(s => { const cur = s.value; s.replaceChildren(el('option', { value: '' }, 'Pick a genre'), ...all.map(g => el('option', { value: g }, g))); s.value = cur; });
    }
    ['#f-q', '#f-genre', '#f-ccu', '#f-growth', '#f-sort', '#f-watch'].forEach(s => $(s).addEventListener('input', () => renderGems()));
    const filteredGems = () => {
      const gems = approved();
      const q = $('#f-q').value.trim().toLowerCase(), genre = $('#f-genre').value;
      const minC = Number($('#f-ccu').value) || 0, minG = $('#f-growth').value === '' ? null : Number($('#f-growth').value);
      const sort = $('#f-sort').value;
      const key = { eff, growth: g => growth(g) ?? -Infinity, ccu: g => g.ccu, visits: g => -g.visits, rating: g => (g.rating || 0) * 1e6 + eff(g), new: g => new Date(g.reviewed_at || g.created_at).getTime() }[sort] || eff;
      return gems.filter(g => (!q || `${g.name} ${byName(g)}`.toLowerCase().includes(q)) && (!genre || g.genre === genre) && g.ccu >= minC
        && (minG == null || (growth(g) ?? -Infinity) >= minG) && (!$('#f-watch').checked || watch.has(g.id)))
        .sort((a, b) => key(b) - key(a));
    };
    function renderGems() {
      const gems = approved();
      const gs = $('#f-genre'), cur = gs.value;
      const genres = [...new Set(gems.map(g => g.genre))].sort();
      gs.replaceChildren(el('option', { value: '' }, 'All genres'), ...genres.map(g => el('option', { value: g }, g)));
      gs.value = genres.includes(cur) ? cur : '';
      const list = filteredGems();
      const best = Math.max(1, ...gems.map(eff));
      $('#gems-rows').replaceChildren(...list.map(g => el('div', { class: 'tr', role: 'row' },
        el('span', { class: 'g-name', role: 'cell' }, openBtn(g, ''), el('small', { class: 'hint' }, `by ${byName(g)}${g.rating ? ' · ' + stars(g.rating) : ''}`), socials(g)),
        el('span', { role: 'cell', 'data-label': 'Genre' }, g.genre),
        el('span', { role: 'cell', 'data-label': 'CCU' }, fmt(g.ccu)),
        el('span', { role: 'cell', 'data-label': 'Visits' }, fmt(g.visits)),
        el('span', { role: 'cell', class: 'eff', 'data-label': 'Efficiency' }, eff(g).toFixed(1), el('i', { style: `--w:${Math.max(6, (eff(g) / best) * 100).toFixed(0)}%`, 'aria-hidden': 'true' })),
        el('span', { role: 'cell', 'data-label': 'Growth 7d' }, growthEl(growth(g))),
        el('span', { role: 'cell', 'data-label': 'Outreach' }, pill(g.contact_status, CONTACT[g.contact_status])),
        el('span', { role: 'cell', class: 'actions' }, starBtn(g), el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => openGame(g.id) }, 'OPEN')))));
      $('#gems-empty').textContent = gems.length ? 'No games match those filters.' : 'No approved games yet. Once a submission is approved it shows up here.';
      $('#gems-empty').hidden = list.length > 0;
    }
    $('#gems-export').addEventListener('click', () => {
      const rows = [['Name', 'Roblox', 'Genre', 'CCU', 'Visits', 'Efficiency', 'Growth 7d %', 'Rating', 'Outreach', 'Discord', 'X', 'Scout']];
      filteredGems().forEach(g => rows.push([g.name, robloxUrl(g.link) || g.link, g.genre, g.ccu, g.visits, eff(g).toFixed(2), growth(g) == null ? '' : growth(g).toFixed(1), g.rating || '', CONTACT[g.contact_status], g.discord_url || '', g.x_url || '', byName(g)]));
      const csv = rows.map(r => r.map(c => { c = String(c); if (/^[=+\-@]/.test(c)) c = "'" + c; return /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c; }).join(',')).join('\n');
      const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `rushed-gems-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.append(a); a.click(); a.remove();
    });

    /* ---------- submit ---------- */
    const sf = $('#submit-form');
    const liveEff = () => { const c = Number(sf.ccu.value), v = Number(sf.visits.value); $('#submit-eff').textContent = v > 0 ? `Efficiency factor: ${((c / v) * 1000).toFixed(2)} · ${verdict((c / v) * 1000)}` : 'Efficiency factor: —'; };
    sf.ccu.addEventListener('input', liveEff); sf.visits.addEventListener('input', liveEff);
    const readGameForm = (f, msg) => {
      const v = k => (f[k] ? f[k].value.trim() : '');
      const id = placeId(v('link'));
      if (!id) { say(msg, 'Paste a Roblox game link (roblox.com/games/…) or the place ID.', true); return null; }
      if (!v('name')) { say(msg, 'Add the game\'s name.', true); return null; }
      if (!v('genre')) { say(msg, 'Pick a genre.', true); return null; }
      if (v('ccu') === '' || v('visits') === '' || Number(v('ccu')) < 0 || Number(v('visits')) < 0) { say(msg, 'Add the current CCU and total visits.', true); return null; }
      const d = safeUrl(v('discord_url'), DISCORD_HOSTS), x = safeUrl(v('x_url'), X_HOSTS);
      if (d === null) { say(msg, 'The Discord link should be a discord.gg or discord.com link.', true); return null; }
      if (x === null) { say(msg, 'The X link should be an x.com or twitter.com link.', true); return null; }
      const num = k => (v(k) === '' ? null : Number(v(k)));
      return { link: id, name: v('name'), genre: v('genre'), ccu: Math.round(Number(v('ccu'))), visits: Math.round(Number(v('visits'))), discord_url: d || null, x_url: x || null,
        notes: v('notes') || null, avg_playtime_min: num('avg_playtime_min'), d1_retention: num('d1_retention'), est_monthly_robux: num('est_monthly_robux') };
    };
    sf.addEventListener('submit', e => {
      e.preventDefault();
      const msg = $('#submit-note');
      const row = readGameForm(sf, msg); if (!row) return;
      const dupe = games.find(g => placeId(g.link) === row.link);
      if (dupe) return say(msg, `"${dupe.name}" is already on the dashboard (${STATUS[dupe.status].toLowerCase()}, sent by ${byName(dupe)}).`, true);
      busy($('button[type=submit]', sf), async () => {
        const ok = await run(sb.from('games').insert({ ...row, submitted_by: me.id }), 'Sent for review.');
        if (ok) { sf.reset(); liveEff(); say(msg, 'Sent! You can follow it under Submissions.'); }
      });
    });

    /* ---------- submissions ---------- */
    let subFilter = 'pending';
    $$('#sub-chips button').forEach(b => b.addEventListener('click', () => {
      subFilter = b.dataset.f; $$('#sub-chips button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderSubs();
    }));
    $('#sub-mine').addEventListener('change', () => renderSubs());
    function renderSubs() {
      $('#sub-mine-wrap').hidden = !isStaff();
      const mineOnly = !isStaff() || $('#sub-mine').checked;
      $('#h-subs').textContent = isStaff() ? 'Review queue.' : 'Your submissions.';
      const list = games.filter(g => (subFilter === 'all' || g.status === subFilter) && (!mineOnly || g.submitted_by === me.id));
      $('#subs').replaceChildren(...list.map(g => el('article', { class: `sub ${g.status}` },
        el('div', { class: 'sub-top' }, pill(g.status, STATUS[g.status]), el('span', {}, ago(g.created_at))),
        el('h3', {}, g.name),
        el('p', {}, `${g.genre} · ${fmt(g.ccu)} CCU · ${fmt(g.visits)} visits · efficiency ${eff(g).toFixed(1)}`),
        g.rating || g.review_comment ? el('p', {}, stars(g.rating), g.review_comment ? ` “${g.review_comment}”` : '') : '',
        socials(g),
        el('div', { class: 'sub-foot' }, el('span', {}, `by ${byName(g)}`),
          el('button', { type: 'button', class: `btn btn-sm ${isStaff() && g.status === 'pending' ? 'btn-red' : 'btn-ghost'}`, onclick: () => openGame(g.id) }, isStaff() && g.status === 'pending' ? 'REVIEW' : 'DETAILS')))));
      $('#subs-empty').hidden = list.length > 0;
      $('#subs-empty').textContent = subFilter === 'pending' ? (isStaff() ? 'Nothing waiting for review. 🎉' : 'None of your games are waiting.') : 'Nothing here.';
    }

    /* ---------- outreach ---------- */
    const contactSelect = (g, label) => el('select', { 'aria-label': label || `Outreach status for ${g.name}`, onchange: e => run(sb.from('games').update({ contact_status: e.target.value }).eq('id', g.id), 'Outreach updated.') },
      Object.entries(CONTACT).map(([k, t]) => el('option', { value: k, selected: g.contact_status === k }, t)));
    function renderOutreach() {
      const gems = approved();
      $('#outreach').replaceChildren(...Object.entries(CONTACT).map(([k, t]) => {
        const list = gems.filter(g => g.contact_status === k).sort((a, b) => eff(b) - eff(a));
        return el('div', { class: 'lane' }, el('div', { class: 'lane-head' }, pill(k, t), el('span', { class: 'hint' }, list.length)),
          list.map(g => el('div', { class: 'lane-card' }, openBtn(g),
            el('small', {}, `${fmt(g.ccu)} CCU · eff ${eff(g).toFixed(1)}${g.contacted_by ? ' · ' + nameOf(g.contacted_by) : ''}`), socials(g), contactSelect(g))));
      }));
    }

    /* ---------- leaderboard ---------- */
    function renderLeader() {
      const rows = new Map();
      const row = (key, name) => { if (!rows.has(key)) rows.set(key, { key, name, total: 0, ok: 0, stars: 0, deals: 0 }); return rows.get(key); };
      games.forEach(g => {
        const r = row(g.legacy_by ? 'legacy:' + g.legacy_by : g.submitted_by, byName(g));
        r.total++; if (g.status === 'approved') { r.ok++; r.stars += g.rating || 0; }
        if (g.contact_status === 'deal' && g.contacted_by) row(g.contacted_by, nameOf(g.contacted_by)).deals++;
      });
      const list = [...rows.values()].map(r => ({ ...r, points: r.ok * 3 + r.total + r.stars + r.deals * 5 })).filter(r => r.points > 0).sort((a, b) => b.points - a.points || b.ok - a.ok);
      $('#leader').replaceChildren(...list.map((r, i) => el('li', { class: r.key === me.id ? 'me-row' : '' },
        el('span', { class: 'pos' }, String(i + 1).padStart(2, '0')),
        el('span', { class: 'person' }, avatar(r.name), el('span', {}, el('b', {}, r.name), el('small', {}, `${r.ok} of ${r.total} approved${r.deals ? ` · ${r.deals} deal${r.deals > 1 ? 's' : ''}` : ''}`))),
        el('span', {}, el('small', {}, 'Points'), el('b', {}, r.points)),
        el('span', {}, el('small', {}, 'Approved'), el('b', {}, r.ok)),
        el('span', {}, el('small', {}, 'Hit rate'), el('b', {}, r.total ? Math.round((r.ok / r.total) * 100) + '%' : '—')))));
      $('#leader-empty').hidden = list.length > 0;
    }

    /* ---------- team ---------- */
    const canEditMember = t => isOwner() && t.id !== me.id && (me.role === 'founder' || !OWNER.includes(t.role));
    const roleOptions = (current) => Object.entries(ROLES).filter(([k]) => me.role === 'founder' || !OWNER.includes(k))
      .map(([k, t]) => el('option', { value: k, selected: current === k }, t));
    function renderTeam() {
      const pending = team.filter(t => t.status === 'pending');
      if (isOwner()) {
        $('#pending-list').replaceChildren(...pending.map(t => {
          const sel = el('select', { 'aria-label': `Role for ${t.username}` }, roleOptions('scout'));
          return el('div', { class: 'pending-row' },
            el('span', { class: 'person' }, avatar(t.username), el('span', {}, el('b', {}, t.username), el('small', {}, `${emails.get(t.id) || ''} · signed up ${ago(t.created_at)}`))),
            el('span', {}, el('small', { class: 'hint' }, 'Discord'), el('div', {}, t.discord || '—'), t.roblox ? el('small', { class: 'hint' }, `Roblox: ${t.roblox}`) : ''),
            el('span', { class: 'row-btns' }, sel,
              el('button', { type: 'button', class: 'btn btn-ok btn-sm', onclick: () => run(sb.from('profiles').update({ status: 'approved', role: sel.value }).eq('id', t.id), `${t.username} is verified.`) }, 'VERIFY ✓'),
              el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => confirm(`Decline ${t.username}'s account?`) && run(sb.from('profiles').update({ status: 'rejected' }).eq('id', t.id), 'Declined.') }, 'DECLINE')));
        }));
        $('#pending-empty').hidden = pending.length > 0;
      }
      const shown = team.filter(t => t.status !== 'pending' && (isOwner() || t.status === 'approved'))
        .sort((a, b) => Object.keys(ROLES).indexOf(a.role) - Object.keys(ROLES).indexOf(b.role) || a.username.localeCompare(b.username));
      $('#team-rows').replaceChildren(...shown.map(t => {
        const edit = canEditMember(t);
        return el('div', { class: 'tr', role: 'row' },
          el('span', { role: 'cell', class: 'person' }, avatar(t.username), el('span', {}, el('b', {}, t.username, t.id === me.id ? ' (you)' : ''), isOwner() ? el('small', {}, emails.get(t.id) || '') : '')),
          el('span', { role: 'cell', 'data-label': 'Discord' }, t.discord || '—'),
          el('span', { role: 'cell', 'data-label': 'Roblox' }, t.roblox || '—'),
          el('span', { role: 'cell', 'data-label': 'Role' }, edit
            ? el('select', { 'aria-label': `Role for ${t.username}`, onchange: e => run(sb.from('profiles').update({ role: e.target.value }).eq('id', t.id), 'Role updated.') }, roleOptions(t.role))
            : pill(OWNER.includes(t.role) ? 'owner' : '', ROLES[t.role])),
          el('span', { role: 'cell', 'data-label': 'Status' }, edit
            ? el('select', { 'aria-label': `Access for ${t.username}`, onchange: e => run(sb.from('profiles').update({ status: e.target.value }).eq('id', t.id), 'Access updated.') },
              [['approved', 'Active'], ['suspended', 'Paused'], ['rejected', 'Declined']].map(([k, l]) => el('option', { value: k, selected: t.status === k }, l)))
            : pill(t.status === 'approved' ? 'approved' : t.status, t.status === 'approved' ? 'Active' : t.status === 'suspended' ? 'Paused' : 'Declined')),
          el('span', { role: 'cell', 'data-label': 'Joined' }, day(t.approved_at || t.created_at)));
      }));
    }

    function renderActivity() { if (isStaff()) $('#feed-full').replaceChildren(...activity.map(feedRow)); }

    /* ---------- account ---------- */
    function renderAccount() {
      const f = $('#profile-form');
      if (document.activeElement && f.contains(document.activeElement)) return;
      f.username.value = me.username; f.discord.value = me.discord || ''; f.roblox.value = me.roblox || '';
      $('#acc-email').textContent = user.email;
      $('#password-form').email.value = user.email;
    }
    $('#profile-form').addEventListener('submit', e => {
      e.preventDefault();
      const f = e.currentTarget, msg = $('#profile-note');
      if (!f.username.value.trim()) return say(msg, 'Your display name can\'t be empty.', true);
      busy($('button[type=submit]', f), async () => {
        const ok = await run(sb.from('profiles').update({ username: f.username.value.trim(), discord: f.discord.value.trim().replace(/^@/, '') || null, roblox: f.roblox.value.trim() || null }).eq('id', me.id));
        if (ok) say(msg, 'Saved.');
      });
    });
    $('#password-form').addEventListener('submit', e => {
      e.preventDefault();
      const f = e.currentTarget, msg = $('#password-note');
      if (f.password.value.length < 8) return say(msg, 'Use at least 8 characters.', true);
      if (f.password.value !== f.repeat.value) return say(msg, 'The two passwords don\'t match.', true);
      busy($('button[type=submit]', f), async () => {
        const { error } = await sb.auth.updateUser({ password: f.password.value });
        if (error) return say(msg, friendly(error), true);
        f.password.value = ''; f.repeat.value = ''; say(msg, 'Password changed.');
      });
    });

    /* ---------- settings (owners) ---------- */
    let settingsLoaded = false;
    async function renderSettings() {
      if (settingsLoaded) return;
      const { data, error } = await sb.rpc('get_settings');
      if (error) return say($('#settings-note'), friendly(error), true);
      settingsLoaded = true;
      paintLocal();
      const f = $('#settings-form');
      ['signup', 'submit', 'review', 'deal'].forEach(k => { f['n_' + k].checked = data['notify_' + k]; });
      $('#hook-state').textContent = data.webhook_set ? 'WEBHOOK CONNECTED ✓' : 'NO WEBHOOK YET';
    }
    const saveSettings = async (webhook, okText) => {
      const f = $('#settings-form'), msg = $('#settings-note');
      const { error } = await sb.rpc('save_settings', { webhook, n_signup: f.n_signup.checked, n_submit: f.n_submit.checked, n_review: f.n_review.checked, n_deal: f.n_deal.checked });
      if (error) return say(msg, friendly(error), true);
      f.webhook.value = ''; settingsLoaded = false; await renderSettings(); say(msg, okText);
    };
    $('#settings-form').addEventListener('submit', e => {
      e.preventDefault();
      const v = e.currentTarget.webhook.value.trim();
      busy($('button[type=submit]', e.currentTarget), () => saveSettings(v || null, 'Saved.'));
    });
    $('#hook-clear').addEventListener('click', () => confirm('Remove the Discord webhook? Notifications will stop.') && saveSettings('', 'Webhook removed.'));
    $('#hook-test').addEventListener('click', e => busy(e.currentTarget, async () => {
      const { error } = await sb.rpc('test_webhook');
      say($('#settings-note'), error ? friendly(error) : 'Test sent. Check your Discord channel.', !!error);
    }));
    $('#import-file').addEventListener('change', async e => {
      const file = e.target.files[0]; e.target.value = '';
      const msg = $('#import-note');
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); } catch { return say(msg, 'That file isn\'t a dashboard backup.', true); }
      const subs = Array.isArray(data && data.submissions) ? data.submissions : null;
      if (!subs) return say(msg, 'That file isn\'t a dashboard backup.', true);
      importSubs(subs);
    });
    // The old dashboard saved games in this browser on the same site, so they can be read directly.
    const localSubs = () => { try { const v = JSON.parse(localStorage.getItem('rushed-submissions')); return Array.isArray(v) ? v : []; } catch { return []; } };
    $('#import-local').addEventListener('click', () => importSubs(localSubs()));
    const paintLocal = () => { const n = localSubs().length; $('#import-local').hidden = !n; $('#import-local').textContent = `IMPORT ${n} GAME${n === 1 ? '' : 'S'} FOUND IN THIS BROWSER`; };
    async function importSubs(subs) {
      const msg = $('#import-note');
      const have = new Set(games.map(g => placeId(g.link)));
      const rows = subs.filter(s => s && s.name && placeId(s.link) && !have.has(placeId(s.link))).map(s => ({
        name: String(s.name).slice(0, 120), link: placeId(s.link), genre: String(s.genre || 'Other').slice(0, 40), ccu: Math.max(0, Math.round(Number(s.ccu) || 0)), visits: Math.max(0, Math.round(Number(s.visits) || 0)),
        notes: s.notes ? String(s.notes).slice(0, 2000) : null, status: ['pending', 'approved', 'rejected'].includes(s.status) ? s.status : 'pending',
        rating: s.rating >= 1 && s.rating <= 5 ? Math.round(s.rating) : null, review_comment: s.comment ? String(s.comment).slice(0, 1000) : null,
        legacy_by: String(s.by || 'old dashboard').slice(0, 40), submitted_by: me.id, created_at: s.date && !isNaN(new Date(s.date)) ? new Date(s.date).toISOString() : undefined,
      }));
      if (!rows.length) return say(msg, 'Nothing new to import. Those games are already here.');
      if (!confirm(`Import ${rows.length} game${rows.length > 1 ? 's' : ''} from the old dashboard?`)) return;
      say(msg, 'Importing…');
      const ok = await run(sb.from('games').insert(rows));
      say(msg, ok ? `Imported ${rows.length} game${rows.length > 1 ? 's' : ''}.` : 'Import failed.', !ok);
    }

    /* ---------- game details dialog ---------- */
    const dlg = $('#dlg');
    $('#dlg-close').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    let openId = null;
    dlg.addEventListener('close', () => { openId = null; });

    const chart = (list, key, label, color) => {
      const box = el('div', { class: 'chart' }, el('b', {}, label));
      if (list.length < 2) { box.append(el('p', { class: 'empty' }, 'Not enough history yet. Update the stats to start the chart.')); return box; }
      const W = 300, H = 110, P = 4;
      const t0 = new Date(list[0].recorded_at).getTime(), t1 = new Date(list[list.length - 1].recorded_at).getTime() || t0 + 1;
      const vals = list.map(s => Number(s[key])), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
      const pts = list.map((s, i) => [P + ((new Date(s.recorded_at).getTime() - t0) / (t1 - t0 || 1)) * (W - P * 2), P + (1 - (vals[i] - lo) / span) * (H - P * 2)]);
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H + 18}`); svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${label}: from ${fmt(vals[0])} on ${day(list[0].recorded_at)} to ${fmt(vals[vals.length - 1])} on ${day(list[list.length - 1].recorded_at)}`);
      const add = (tag, attrs, text) => { const n = document.createElementNS(ns, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); if (text != null) n.textContent = text; svg.append(n); return n; };
      [P, H / 2, H - P].forEach(y => add('line', { x1: 0, x2: W, y1: y, y2: y, class: 'grid' }));
      const line = pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
      add('polygon', { points: `${pts[0][0]},${H - P} ${line} ${pts[pts.length - 1][0]},${H - P}`, fill: color, opacity: '.12' });
      add('polyline', { points: line, fill: 'none', stroke: color, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      pts.forEach((p, i) => add('circle', { cx: p[0], cy: p[1], r: 2.6, fill: color }).append(Object.assign(document.createElementNS(ns, 'title'), { textContent: `${fmt(vals[i])} · ${new Date(list[i].recorded_at).toLocaleString()}` })));
      add('text', { x: 0, y: H + 14, class: 'axis' }, day(list[0].recorded_at));
      add('text', { x: W, y: H + 14, class: 'axis', 'text-anchor': 'end' }, day(list[list.length - 1].recorded_at));
      add('text', { x: 0, y: 10, class: 'axis' }, 'max ' + fmt(hi));
      box.append(svg);
      return box;
    };
    const metric = (label, value, small) => el('div', { class: 'metric' }, el('span', {}, label), el('b', {}, value), small ? el('small', {}, small) : '');

    function openGame(id) {
      const g = games.find(x => x.id === id); if (!g) return;
      openId = id;
      const mine = g.submitted_by === me.id && !g.legacy_by;
      const canEdit = isStaff() || (mine && g.status === 'pending');
      const canDelete = isOwner() || (mine && g.status === 'pending');
      const hist = statsBy.get(g.id) || [];
      $('#dlg-status').textContent = `${STATUS[g.status].toUpperCase()} · ${g.genre.toUpperCase()}`;
      $('#dlg-title').textContent = g.name;
      $('#dlg-sub').replaceChildren(`Sent by ${byName(g)} · ${ago(g.created_at)}`, g.reviewed_by ? ` · reviewed by ${nameOf(g.reviewed_by)}` : '');
      const body = $('#dlg-body');
      const sections = [
        el('div', { class: 'row-btns' }, socials(g), starBtnDlg(g)),
        el('div', { class: 'metrics' },
          metric('CCU', fmt(g.ccu), `updated ${ago(hist.length ? hist[hist.length - 1].recorded_at : g.updated_at)}`),
          metric('Visits', fmt(g.visits)),
          metric('Efficiency factor', eff(g).toFixed(2), verdict(eff(g))),
          metric('CCU growth (7d)', growthText(growth(g)), hist.length < 2 ? 'needs 2+ updates' : `${hist.length} data points`),
          metric('Avg playtime', g.avg_playtime_min != null ? `${g.avg_playtime_min} min` : '—'),
          metric('Day-1 retention', g.d1_retention != null ? `${g.d1_retention}%` : '—'),
          metric('Est. monthly Robux', g.est_monthly_robux != null ? fmt(g.est_monthly_robux) : '—'),
          metric('Rating', g.rating ? stars(g.rating) : '—')),
        el('div', { class: 'charts' }, chart(hist, 'ccu', 'CCU history', '#f34b3f'), chart(hist, 'visits', 'Visits history', '#7658ef')),
        g.notes ? el('p', { class: 'notes' }, g.notes) : '',
        g.review_comment ? el('p', { class: 'notes' }, `“${g.review_comment}”, ${nameOf(g.reviewed_by)}`) : '',
      ];

      // update stats (everyone)
      const sForm = el('form', { class: 'inline', novalidate: true },
        el('label', {}, 'Current CCU', el('input', { name: 'ccu', type: 'number', min: 0, value: g.ccu, required: true })),
        el('label', {}, 'Total visits', el('input', { name: 'visits', type: 'number', min: 0, value: g.visits, required: true })),
        el('button', { class: 'btn btn-red', type: 'submit' }, 'ADD SNAPSHOT'));
      const sNote = el('p', { class: 'note', role: 'status' });
      sForm.addEventListener('submit', e => {
        e.preventDefault();
        const c = Number(sForm.ccu.value), v = Number(sForm.visits.value);
        if (sForm.ccu.value === '' || sForm.visits.value === '' || c < 0 || v < 0) return say(sNote, 'Enter the CCU and visits from the Roblox page.', true);
        busy($('button', sForm), async () => { if (await run(sb.from('game_stats').insert({ game_id: g.id, ccu: Math.round(c), visits: Math.round(v), recorded_by: me.id }), 'Stats updated.')) reopen(); });
      });
      sections.push(el('section', { class: 'dlg-sec' }, el('h3', {}, 'Update stats'), el('p', { class: 'muted' }, 'Copy today\'s numbers from the Roblox page. Each update adds a point to the charts and growth rate.'), sForm, sNote));

      // outreach (approved games)
      if (g.status === 'approved') {
        sections.push(el('section', { class: 'dlg-sec' }, el('h3', {}, 'Outreach'),
          el('div', { class: 'inline' }, el('label', {}, 'Status', contactSelect(g, 'Outreach status')),
            el('p', { class: 'muted' }, g.contacted_by ? `Last changed by ${nameOf(g.contacted_by)} ${ago(g.contacted_at)}` : 'Nobody has reached out yet.'))));
      }

      // review (staff)
      if (isStaff()) {
        let rating = g.rating || 0;
        const rate = el('div', { class: 'rate', role: 'group', 'aria-label': 'Rating' });
        const paint = () => rate.replaceChildren(...[1, 2, 3, 4, 5].map(n => el('button', { type: 'button', class: n <= rating ? 'on' : '', 'aria-label': `${n} star${n > 1 ? 's' : ''}`, 'aria-pressed': String(n === rating), onclick: () => { rating = rating === n ? 0 : n; paint(); } }, n <= rating ? '★' : '☆')));
        paint();
        const comment = el('textarea', { rows: 2, maxlength: 1000, placeholder: 'Feedback for the scout (optional)' }, g.review_comment || '');
        const review = status => run(sb.from('games').update({ status, rating: rating || null, review_comment: comment.value.trim() || null }).eq('id', g.id), status === 'approved' ? 'Approved.' : status === 'rejected' ? 'Passed.' : 'Moved back to waiting.').then(ok => ok && reopen());
        sections.push(el('section', { class: 'dlg-sec' }, el('h3', {}, g.status === 'pending' ? 'Review' : 'Change review'), rate, el('label', {}, 'Comment', comment),
          el('div', { class: 'row-btns' },
            el('button', { type: 'button', class: 'btn btn-ok', onclick: () => review('approved') }, 'APPROVE ✓'),
            el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => review('rejected') }, 'PASS'),
            g.status !== 'pending' ? el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => review('pending') }, 'BACK TO WAITING') : '')));
      }

      // edit / delete
      if (canEdit || canDelete) {
        const tools = el('div', { class: 'row-btns' });
        if (canEdit) tools.append(el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => showEdit(g) }, 'EDIT DETAILS'));
        if (canDelete) tools.append(el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => confirm(`Delete "${g.name}"? This can't be undone.`) && run(sb.from('games').delete().eq('id', g.id), 'Deleted.').then(ok => ok && dlg.close()) }, 'DELETE'));
        sections.push(el('section', { class: 'dlg-sec' }, tools));
      }
      body.replaceChildren(...sections);
      if (!dlg.open) dlg.showModal();
    }
    const reopen = () => { if (openId) openGame(openId); };
    const starBtnDlg = g => { const b = starBtn(g); b.addEventListener('click', () => setTimeout(reopen, 400)); return b; };

    function showEdit(g) {
      const fields = [['name', 'Game name', 'text'], ['link', 'Roblox link or place ID', 'text'], ['genre', 'Genre', 'genre'], ['ccu', 'CCU', 'number'], ['visits', 'Visits', 'number'],
        ['discord_url', 'Discord invite', 'url'], ['x_url', 'X / Twitter', 'url'], ['avg_playtime_min', 'Avg playtime (min)', 'number'], ['d1_retention', 'Day-1 retention (%)', 'number'], ['est_monthly_robux', 'Est. monthly Robux', 'number']];
      const f = el('form', { class: 'form', novalidate: true });
      const grid = el('div', { class: 'form-grid' });
      fields.forEach(([k, label, type]) => {
        let input;
        if (type === 'genre') { input = el('select', { name: k, class: 'genre-select' }); }
        else input = el('input', { name: k, type, value: g[k] ?? '', min: type === 'number' ? 0 : null, step: type === 'number' ? 'any' : null });
        grid.append(el('label', {}, label, input));
      });
      f.append(grid, el('label', {}, 'Notes', el('textarea', { name: 'notes', rows: 3, maxlength: 2000 }, g.notes || '')));
      const note = el('p', { class: 'note', role: 'status' });
      f.append(el('div', { class: 'row-btns' }, el('button', { class: 'btn btn-red', type: 'submit' }, 'SAVE ↗'), el('button', { class: 'btn btn-ghost', type: 'button', onclick: reopen }, 'CANCEL')), note);
      $('#dlg-body').replaceChildren(f);
      fillGenreSelects(); f.genre.value = g.genre;
      f.addEventListener('submit', e => {
        e.preventDefault();
        const row = readGameForm(f, note); if (!row) return;
        const dupe = games.find(x => x.id !== g.id && placeId(x.link) === row.link);
        if (dupe) return say(note, `That Roblox game is already on the dashboard as "${dupe.name}".`, true);
        busy($('button[type=submit]', f), async () => { if (await run(sb.from('games').update(row).eq('id', g.id), 'Saved.')) reopen(); });
      });
    }
  }
})();
