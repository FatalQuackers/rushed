// RUSHED site behaviour: progress bar, phone menu, scroll reveals, cursor spark, card tilt.
(() => {
  const root = document.documentElement;
  const qs = (sel, el = document) => el.querySelector(sel);
  const qsa = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;

  root.classList.add('js');

  // Current year in the footer
  const yearEl = qs('#year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Light / dark mode switch (remembered on this device)
  const themeBtn = qs('.theme-btn');
  const paintThemeBtn = () => {
    const dark = root.getAttribute('data-theme') === 'dark';
    themeBtn.setAttribute('aria-pressed', String(dark));
    themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  };
  if (themeBtn) {
    paintThemeBtn();
    themeBtn.addEventListener('click', () => {
      const dark = root.getAttribute('data-theme') !== 'dark';
      if (dark) root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
      try { localStorage.setItem('rushed-theme', dark ? 'dark' : 'light'); } catch (e) {}
      paintThemeBtn();
    });
  }

  // Contact form: checks the fields, then opens the visitor's email app with the message filled in
  const form = qs('#talk-form');
  if (form) {
    const note = qs('.form-note', form);
    form.addEventListener('submit', e => {
      e.preventDefault();
      const missing = qsa('[required]', form).filter(f => !f.value.trim());
      qsa('[required]', form).forEach(f => f.classList.toggle('is-invalid', !f.value.trim()));
      if (missing.length) {
        note.textContent = 'Please add your name and a message first.';
        note.classList.add('is-error');
        missing[0].focus();
        return;
      }
      const data = new FormData(form);
      const body = [
        `Name: ${data.get('name')}`,
        data.get('roblox') ? `Roblox: ${data.get('roblox')}` : '',
        `Topic: ${data.get('topic')}`,
        '',
        data.get('message')
      ].filter((line, i) => line !== '' || i === 3).join('\n');
      const subject = `${data.get('topic')} — RUSHED`;
      note.classList.remove('is-error');
      note.textContent = 'Opening your email app… press send there to reach us.';
      window.location.href = `mailto:hello@rushed.studio?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    });
  }

  // Thin yellow bar at the top showing how far down the page you are
  // It only shows while you scroll, then fades away so it never sits over the page.
  const track = qs('.progress');
  const bar = qs('.progress span');
  let hideTimer = 0;
  const paintProgress = () => {
    const room = root.scrollHeight - window.innerHeight;
    bar.style.width = (room > 0 ? (window.scrollY / room) * 100 : 0) + '%';
  };
  window.addEventListener('scroll', () => {
    paintProgress();
    track.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => track.classList.remove('show'), 900);
  }, { passive: true });
  window.addEventListener('resize', paintProgress, { passive: true });
  paintProgress();

  // Phone / tablet menu
  const toggle = qs('.menu-btn');
  const nav = qs('#site-nav');
  const compact = window.matchMedia('(max-width: 820px)');
  // A closed slide-down menu can't be reached with the keyboard or a screen reader.
  const syncInert = () => {
    const hidden = compact.matches && !nav.classList.contains('open');
    nav.toggleAttribute('inert', hidden);
    if (hidden) nav.setAttribute('aria-hidden', 'true'); else nav.removeAttribute('aria-hidden');
  };
  const setMenu = open => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    nav.classList.toggle('open', open);
    syncInert();
  };
  compact.addEventListener('change', () => setMenu(false));
  syncInert();
  toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
  qsa('a', nav).forEach(a => a.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
  document.addEventListener('click', e => {
    if (nav.classList.contains('open') && !nav.contains(e.target) && !toggle.contains(e.target)) setMenu(false);
  });

  // Fade cards in as they scroll into view (things already on screen just show)
  const items = qsa('.reveal');
  if ('IntersectionObserver' in window && !calm) {
    const showAll = () => items.forEach(el => el.classList.remove('pending'));
    items.forEach(el => {
      if (el.getBoundingClientRect().top > window.innerHeight) el.classList.add('pending');
    });
    const io = new IntersectionObserver((entries, obs) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.remove('pending');
        obs.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -35px 0px' });
    items.forEach(el => io.observe(el));
    // Printing shows everything at once
    window.addEventListener('beforeprint', showAll);
  }


  if (!finePointer || calm) return;

  // Little yellow star that follows the mouse
  const spark = qs('.spark');
  window.addEventListener('pointermove', e => {
    spark.style.setProperty('--x', e.clientX + 'px');
    spark.style.setProperty('--y', e.clientY + 'px');
    spark.classList.add('on');
  }, { passive: true });
  document.addEventListener('pointerleave', () => spark.classList.remove('on'));

  // Gentle 3D tilt on the team cards
  qsa('.person').forEach(card => {
    card.addEventListener('pointermove', e => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = `translateY(-7px) rotateX(${(-y * 2.4).toFixed(2)}deg) rotateY(${(x * 2.8).toFixed(2)}deg)`;
    });
    card.addEventListener('pointerleave', () => { card.style.transform = ''; });
  });
})();
