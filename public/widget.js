/* Embeddable chat widget.
 *
 * Install on any site with one line:
 *   <script src="https://YOUR-HOST/widget.js" data-key="pk_xxx" defer></script>
 *
 * Everything renders inside a Shadow DOM. Client sites have unpredictable
 * global CSS — Bootstrap, Elementor, a theme from 2014 — and shadow roots are
 * the only reliable way to guarantee the widget looks the same everywhere.
 */
(function () {
  const script = document.currentScript || document.querySelector('script[data-key]');
  const KEY = script?.dataset.key;
  const API = (script?.dataset.api || new URL(script.src).origin).replace(/\/$/, '');
  if (!KEY) return console.warn('[chat widget] Missing data-key attribute.');

  const STORE = 'fd_chat_' + KEY;
  let config = { botName: 'Assistant', greeting: 'Hi. How can I help?', accent: '#1B3A2F', logoUrl: '', teaser: '', autoOpenSeconds: 0, quickReplies: [], footerText: '', footerUrl: '', fontFamily: '', fontUrl: '' };
  let menuShown = false;
  // Auto-opening a full-screen panel on a phone hijacks the page before the
  // visitor has read anything, so this is desktop only.
  const isPhone = matchMedia('(max-width: 520px)').matches;
  let conversationId = null;
  let history = [];
  let suggestions = [];
  let open = false;
  let busy = false;
  let unread = 0;
  let teaserShown = false;

  // Visitors click through to another page mid-conversation. Without this the
  // chat resets and they have to explain themselves again — the single most
  // common reason people abandon a widget.
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
    if (saved && Date.now() - saved.at < 2 * 3600e3) {
      history = saved.history || [];
      conversationId = saved.conversationId || null;
    }
  } catch { /* private mode or disabled storage — start fresh */ }

  function persist() {
    try { sessionStorage.setItem(STORE, JSON.stringify({ history, conversationId, at: Date.now() })); } catch {}
  }

  // Webfonts must be loaded by the host document: a @font-face rule inside a
  // shadow root is not applied consistently across browsers.
  function loadFont(url) {
    if (!url || document.querySelector(`link[data-fd-font="${url}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = url;
    l.setAttribute('data-fd-font', url);
    l.crossOrigin = 'anonymous';
    document.head.appendChild(l);
  }

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;right:0;';
  const root = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Bot answers sometimes name a page. Making that clickable is the difference
  // between a helpful reply and a dead end.
  function linkify(s) {
    return esc(s).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function render() {
    root.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; }
        /* The client's own typeface when one is set, falling back to the system
           stack so a missing or misspelt font never renders as Times. */
        .wrap { font-family: ${config.fontFamily ? `"${config.fontFamily.replace(/"/g, '')}", ` : ''}ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }

        .launcher {
          position: fixed; bottom: 20px; right: 20px; width: 58px; height: 58px;
          border-radius: 50%; border: 0; cursor: pointer; background: ${config.accent};
          color: #fff; display: grid; place-items: center;
          box-shadow: 0 6px 24px rgba(0,0,0,.22); transition: transform .18s ease;
        }
        .launcher:hover { transform: scale(1.06); }
        /* contain, not cover: a logo must never be cropped by the circle. */
        .launcher img { width: 34px; height: 34px; object-fit: contain; display: block; pointer-events: none; }
        .launcher:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
        .badge {
          position: absolute; top: -2px; right: -2px; min-width: 20px; height: 20px;
          border-radius: 10px; background: #C2453B; color: #fff; font-size: 11px; font-weight: 700;
          display: grid; place-items: center; padding: 0 5px; border: 2px solid #fff;
        }

        .teaser {
          position: fixed; bottom: 88px; right: 20px; max-width: 250px; background: #fff;
          border: 1px solid rgba(0,0,0,.09); border-radius: 14px; border-bottom-right-radius: 4px;
          padding: 11px 34px 11px 14px; font-size: 13.5px; line-height: 1.45; color: #16181D;
          box-shadow: 0 10px 34px rgba(0,0,0,.16); cursor: pointer;
          animation: pop .3s ease both;
        }
        .teaser .x { position: absolute; top: 5px; right: 7px; border: 0; background: none; font-size: 16px; line-height: 1; color: #9aa0a6; cursor: pointer; padding: 2px 4px; }
        @keyframes pop { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }

        .panel {
          position: fixed; bottom: 90px; right: 20px; width: 384px; max-width: calc(100vw - 32px);
          height: 570px; max-height: calc(100vh - 130px); background: #fff;
          border-radius: 16px; overflow: hidden; display: flex; flex-direction: column;
          box-shadow: 0 18px 60px rgba(0,0,0,.24); border: 1px solid rgba(0,0,0,.08);
          opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity .18s, transform .18s;
        }
        .panel.open { opacity: 1; transform: none; pointer-events: auto; }

        .head { background: ${config.accent}; color: #fff; padding: 13px 15px; display: flex; align-items: center; gap: 11px; }
        .head img { width: 34px; height: 34px; border-radius: 8px; object-fit: cover; background: rgba(255,255,255,.15); flex: none; }
        .head .mark { width: 34px; height: 34px; border-radius: 8px; background: rgba(255,255,255,.16); display: grid; place-items: center; font-weight: 700; font-size: 15px; flex: none; }
        .head b { font-size: 15px; font-weight: 600; display: block; }
        .head small { display: block; font-size: 11.5px; opacity: .78; font-weight: 400; }
        .head small::before { content: "●"; color: #7BD88F; font-size: 8px; vertical-align: middle; margin-right: 4px; }
        .close { margin-left: auto; background: none; border: 0; color: #fff; opacity: .8; cursor: pointer; font-size: 22px; line-height: 1; padding: 4px 6px; border-radius: 6px; }
        .close:hover { opacity: 1; background: rgba(255,255,255,.12); }

        .log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; background: #FAFAF8; }
        .msg { max-width: 84%; padding: 10px 13px; border-radius: 14px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
        .bot { background: #fff; border: 1px solid rgba(0,0,0,.07); align-self: flex-start; border-bottom-left-radius: 4px; color: #16181D; }
        .me  { background: ${config.accent}; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
        .msg a { color: inherit; text-decoration: underline; }
        .bot a { color: ${config.accent}; }

        /* Opening menu. A grid of cards reads as "pick one" where a row of
           small pills reads as "here are some hints" — and picking one is
           exactly what we want a visitor who does not know what to ask to do. */
        .menu { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 2px; }
        .menu.one { grid-template-columns: 1fr; }
        .menuItem {
          background: #fff; border: 1px solid rgba(0,0,0,.09); border-radius: 11px;
          padding: 13px 11px; font-size: 13px; line-height: 1.35; color: #16181D;
          cursor: pointer; font-family: inherit; text-align: center; transition: border-color .15s, transform .15s;
          box-shadow: 0 1px 2px rgba(0,0,0,.04);
        }
        .menuItem:hover { border-color: ${config.accent}; transform: translateY(-1px); }
        .menuItem:focus-visible { outline: 2px solid ${config.accent}; outline-offset: 1px; }
        .menuItem.wide { grid-column: 1 / -1; background: ${config.accent}; color: #fff; border-color: ${config.accent}; font-weight: 500; }

        .chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .chip { background: #fff; border: 1px solid ${config.accent}33; color: ${config.accent};
                border-radius: 999px; padding: 6px 12px; font-size: 12.5px; cursor: pointer; font-family: inherit; }
        .chip:hover { background: ${config.accent}12; }

        .dots span { display:inline-block; width:6px; height:6px; margin-right:3px; border-radius:50%; background:#9aa0a6; animation: b 1.2s infinite; }
        .dots span:nth-child(2){ animation-delay:.15s } .dots span:nth-child(3){ animation-delay:.3s }
        @keyframes b { 0%,60%,100%{opacity:.3} 30%{opacity:1} }

        .bar { display: flex; gap: 8px; padding: 12px; border-top: 1px solid rgba(0,0,0,.07); background: #fff; }
        .bar input { flex: 1; min-width: 0; border: 1px solid rgba(0,0,0,.14); border-radius: 10px; padding: 10px 12px; font-size: 14px; font-family: inherit; color: #16181D; background: #fff; }
        .bar input:focus { outline: 2px solid ${config.accent}66; outline-offset: -1px; border-color: ${config.accent}; }
        .bar button { background: ${config.accent}; color: #fff; border: 0; border-radius: 10px; padding: 0 16px; cursor: pointer; font-size: 14px; font-weight: 500; font-family: inherit; flex: none; }
        .bar button:disabled { opacity: .45; cursor: default; }
        .foot { text-align: center; font-size: 10.5px; color: #9aa0a6; padding: 0 0 8px; background: #fff; }
        /* inherit the muted grey rather than turning link-blue */
        .foot a { color: inherit; text-decoration: none; }
        .foot a:hover { text-decoration: underline; }

        /* Phones: full screen. A 380px panel on a 360px viewport is unusable,
           and a floating launcher on top of a full-screen panel just covers
           the last message — the header's own close button is enough. */
        @media (max-width: 520px) {
          .panel {
            inset: 0; width: 100%; max-width: 100%; height: 100%; max-height: 100%;
            height: 100dvh; border-radius: 0; border: 0;
          }
          .panel.open ~ .launcher { display: none; }
          .head { padding: 15px 16px; padding-top: max(15px, env(safe-area-inset-top)); }
          .close { font-size: 26px; padding: 6px 10px; }
          .log { padding: 14px; gap: 11px; }
          .msg { max-width: 88%; font-size: 15px; }
          .bar { padding: 11px; padding-bottom: max(11px, env(safe-area-inset-bottom)); }
          /* 16px stops iOS Safari zooming the page every time the field is tapped. */
          .bar input { font-size: 16px; padding: 12px 13px; }
          .bar button { padding: 0 18px; }
          .chip { padding: 9px 14px; font-size: 13.5px; }
          .launcher { bottom: 16px; right: 16px; }
          .teaser { right: 16px; bottom: 84px; max-width: min(250px, calc(100vw - 32px)); }
          .foot { padding-bottom: max(8px, env(safe-area-inset-bottom)); }
        }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
      </style>

      <div class="wrap">
        <div class="panel ${open ? 'open' : ''}" role="dialog" aria-label="Chat with ${esc(config.botName)}" aria-modal="false">
          <div class="head">
            ${config.logoUrl
              ? `<img src="${esc(config.logoUrl)}" alt="" onerror="this.style.display='none'" />`
              : `<div class="mark" aria-hidden="true">${esc((config.botName || 'A').trim()[0].toUpperCase())}</div>`}
            <div><b>${esc(config.botName)}</b><small>Usually replies instantly</small></div>
            <button class="close" aria-label="Close chat">&times;</button>
          </div>
          <div class="log" role="log" aria-live="polite" aria-atomic="false"></div>
          <div class="bar">
            <input type="text" placeholder="Type your message" aria-label="Your message" autocomplete="off" />
            <button type="button" class="send">Send</button>
          </div>
          ${config.footerText ? `<div class="foot">${
            config.footerUrl
              ? `<a href="${esc(config.footerUrl)}" target="_blank" rel="noopener">${esc(config.footerText)}</a>`
              : esc(config.footerText)
          }</div>` : ''}
        </div>

        <button class="launcher" aria-label="${open ? 'Close' : 'Open'} chat" aria-expanded="${open}">
          ${open ? CLOSE_ICON : `<img class="lIcon" src="${esc(LAUNCHER_ICON)}" alt="" />`}
          ${unread && !open ? `<span class="badge">${unread}</span>` : ''}
        </button>
      </div>`;

    const lIcon = root.querySelector('.lIcon');
    if (lIcon) lIcon.addEventListener('error', () => { lIcon.outerHTML = CHAT_ICON; });

    root.querySelector('.launcher').addEventListener('click', toggle);
    root.querySelector('.close').addEventListener('click', toggle);
    // Wrapped, not passed directly — otherwise the click Event arrives as the
    // first argument and gets treated as the message text.
    root.querySelector('.send').addEventListener('click', () => send());
    const input = root.querySelector('.bar input');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(); } });
    root.querySelector('.panel').addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) toggle(); });
    paint();
  }

  // The closed launcher carries the aiFrontBot mark; the open one shows an X,
  // which reads as "close" far faster than a logo does.
  const LAUNCHER_ICON = script?.dataset.icon
    || 'https://aifrontbot.net/wp-content/uploads/2026/09/Ai-frontbot-logo-png-1.png';
  const CLOSE_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  // If the logo ever fails to load the button must not sit there empty, so it
  // falls back to the generic chat bubble.
  const CHAT_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 21 11.5z"/></svg>';

  const TEASER_DISMISSED = STORE + '_nudged';

  function teaserDone() {
    try { return sessionStorage.getItem(TEASER_DISMISSED) === '1'; } catch { return false; }
  }

  function showTeaser() {
    // Once per visit, not once per page. Without the stored flag a visitor who
    // dismissed it gets nagged again on every page they open, which is exactly
    // the behaviour that makes people hate these widgets.
    if (open || teaserShown || teaserDone() || !config.teaser || history.length) return;
    teaserShown = true;

    const el = document.createElement('div');
    el.className = 'teaser';
    el.setAttribute('role', 'status');
    el.innerHTML = `<button class="x" aria-label="Dismiss">&times;</button>${esc(config.teaser)}`;

    el.addEventListener('click', (e) => {
      el.remove();
      // Either way the visitor has answered it — don't ask again this visit.
      try { sessionStorage.setItem(TEASER_DISMISSED, '1'); } catch {}
      if (!e.target.classList.contains('x')) toggle();
    });

    root.querySelector('.wrap').appendChild(el);
    // No auto-hide: it stays until dismissed or the chat is opened. A bubble
    // that vanishes after a few seconds is missed by anyone who looked away.
  }

  function toggle() {
    open = !open;
    if (open) unread = 0;
    root.querySelector('.teaser')?.remove();
    // Opening the chat answers the nudge, so it should not reappear later.
    try { sessionStorage.setItem(TEASER_DISMISSED, '1'); } catch {}
    render();
    if (open) {
      if (!history.length) {
        history.push({ role: 'assistant', content: config.greeting });
        menuShown = true;
        paint();
      }
      root.querySelector('.bar input').focus();
    }
  }

  function paint() {
    const log = root.querySelector('.log');
    if (!log) return;
    log.innerHTML = history
      .map((m) => `<div class="msg ${m.role === 'user' ? 'me' : 'bot'}">${m.role === 'user' ? esc(m.content) : linkify(m.content)}</div>`)
      .join('');
    // The menu appears once, under the greeting, before the visitor has typed.
    if (!busy && menuShown && history.length === 1 && config.quickReplies?.length) {
      const items = config.quickReplies.slice(0, 8);
      log.insertAdjacentHTML('beforeend',
        `<div class="menu ${items.length === 1 ? 'one' : ''}" role="group" aria-label="Choose a topic">${
          items.map((t, i) => `<button class="menuItem ${i === items.length - 1 && items.length % 2 ? 'wide' : ''}">${esc(t)}</button>`).join('')
        }</div>`);
      log.querySelectorAll('.menuItem').forEach((b) => {
        b.addEventListener('click', () => { menuShown = false; send(b.textContent); });
      });
    }

    if (busy) log.insertAdjacentHTML('beforeend', '<div class="msg bot dots" aria-label="Typing"><span></span><span></span><span></span></div>');
    if (suggestions.length && !busy) {
      log.insertAdjacentHTML('beforeend',
        `<div class="chips">${suggestions.map((s) => `<button class="chip">${esc(s)}</button>`).join('')}</div>`);
      log.querySelectorAll('.chip').forEach((b) => { b.addEventListener('click', () => send(b.textContent)); });
    }
    log.scrollTop = log.scrollHeight;
    root.querySelector('.send').disabled = busy;
  }

  async function send(preset) {
    const input = root.querySelector('.bar input');
    const text = String(typeof preset === 'string' ? preset : input.value).trim();
    if (!text || busy) return;
    input.value = '';
    suggestions = [];
    history.push({ role: 'user', content: text });
    busy = true;
    paint();

    try {
      const res = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: KEY, message: text, conversationId, history: history.slice(0, -1).slice(-8) }),
      });
      const data = await res.json();
      conversationId = data.conversationId || conversationId;
      busy = false;
      suggestions = data.suggestions || [];
      history.push({ role: 'assistant', content: data.answer });
      if (!open) { unread++; render(); } else { paint(); }
      persist();
    } catch {
      busy = false;
      history.push({ role: 'assistant', content: 'I could not reach the server just now. Please try again in a moment.' });
      paint();
    }
  }

  fetch(`${API}/api/config/${KEY}`)
    .then((r) => r.json())
    .then((c) => { if (!c.error) { config = { ...config, ...c }; loadFont(config.fontUrl); } })
    .catch(() => {})
    .finally(() => {
      render();
      const delay = Number(config.autoOpenSeconds) || 0;
      if (delay > 0 && !isPhone) {
        // Once per visit only. A panel that reopens on every page view is the
        // fastest way to make someone leave the site.
        let already = false;
        try { already = sessionStorage.getItem(STORE + '_opened') === '1'; } catch {}
        if (!already && !history.length) {
          setTimeout(() => {
            if (open || busy) return;
            try { sessionStorage.setItem(STORE + '_opened', '1'); } catch {}
            toggle();
          }, delay * 1000);
          return;                       // teaser would be redundant
        }
      }
      setTimeout(showTeaser, 12000);
    });
})();
