/*
 * Replyo embeddable chat widget.
 *
 * Drop onto any site with a single tag:
 *   <script src="https://your-api/widget/widget.js" data-api="https://your-api"></script>
 * (data-api is optional; it defaults to the origin this script was served from.)
 *
 * Design notes:
 *
 *  1. Shadow DOM. The host site's CSS can't leak in and ours can't leak out, which
 *     is what makes this safe to embed on a site we don't control.
 *
 *  2. WebSocket first, HTTP fallback. The socket gives live token-by-token replies
 *     and lets messages arrive that aren't answers to anything the visitor just
 *     typed — a reply a human approved in the dashboard, or a 48h re-engagement
 *     nudge. If the socket can't be established (a proxy blocking upgrades, say)
 *     the widget degrades to POST /chat plus polling and keeps working.
 *
 *  3. The server is the source of truth. Streamed tokens are a preview; the
 *     trailing `message` event carries the authoritative text and replaces them,
 *     because the two legitimately differ (an escalated message is answered with a
 *     holding note instead of the draft that's waiting on a human).
 *
 *  4. Appearance comes from two layers. data-* attributes on the script tag pin
 *     fields explicitly (hand-tunable, renders with zero round-trips); anything NOT
 *     pinned follows the tenant's saved customization, fetched from
 *     GET /widget/config at boot — so a bare src+data-tenant tag (like the clinic
 *     site's) restyles itself as the owner tweaks the console's Install page, and
 *     picks the changes up on the next page load. Omitting every attribute with no
 *     saved config yields the original look (teal, light, 374×560, bottom-right at
 *     20px):
 *
 *       data-name="Bright Smile Dental"   header title (plain text, never markup)
 *       data-theme="teal|ocean|violet|sunset|rose|forest|crimson|slate"
 *       data-mode="light|dark"            panel surfaces; the accent theme is shared
 *       data-size="compact|standard|large|custom"
 *                                         custom = exact dims from data-width/height
 *                                         (the launcher bubble stays the standard 56px)
 *       data-width / data-height          exact px, clamped to 320–480 × 420–720;
 *                                         overrides the preset dimension(s)
 *       data-position="bottom-right|bottom-left|top-right|top-left"
 *       data-offset-x / data-offset-y     px from the chosen corner, clamped 0–200
 */
(function () {
  "use strict";

  // `document.currentScript` is null for dynamically-injected scripts, so fall back to
  // locating our own tag by src to read data-api / data-tenant.
  const script = document.currentScript || document.querySelector('script[src*="/widget/widget.js"]');

  // A tag that was detached before its fetch landed must not boot. Removing a <script>
  // does not cancel its pending execution, so without this bail the console's live
  // preview would resurrect a widget with stale config — or on a page that already
  // unmounted and tore the widget down for good.
  if (script && !script.isConnected) return;

  // Single-instance guard. In a single-page app (e.g. the console's Install page) the
  // widget can be injected repeatedly as the user navigates; tear down any previous
  // instance first so we never leave a zombie socket/timer running against an old,
  // detached DOM node. Without this, a fresh instance's sync could race a stale one and
  // the reconnect transcript wouldn't show. Remember whether the previous instance's
  // panel was open, so the console's live preview doesn't slam it shut on every tweak.
  let wasOpen = false;
  if (window.__replyoWidget && typeof window.__replyoWidget.teardown === "function") {
    try {
      wasOpen = typeof window.__replyoWidget.isOpen === "function" && !!window.__replyoWidget.isOpen();
    } catch (e) { wasOpen = false; }
    try { window.__replyoWidget.teardown(); } catch (e) { /* ignore */ }
  }
  const API = (script && script.dataset.api ? script.dataset.api : window.location.origin)
    .replace(/\/$/, "");
  const WS_BASE = API.replace(/^http/, "ws");
  // Which persona this widget talks to. Set data-tenant="pk_..." on the script tag.
  const TENANT_KEY = (script && script.dataset.tenant) || "";
  // Thread + storage are namespaced per persona, so two embeds on one page never share.
  const STORAGE_KEY = "replyo:thread:" + (TENANT_KEY || "default");
  const POLL_MS = 4000;
  const MAX_BACKOFF = 15000;

  // One stable thread per browser + persona, so a returning visitor keeps their history.
  function threadId() {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      const uuid = window.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(16).slice(2);
      // Just a random handle; the server binds it to this persona's tenant, so the
      // client never needs (or is trusted with) the tenant id in the thread itself.
      id = "web:" + uuid;
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  }

  const THREAD = threadId();

  // ---------- appearance config (all optional; defaults = the original look) ----------

  // Accent palettes. `a → b` paints the bubble/header gradient, `deep` fills the
  // visitor's messages and the send button (kept dark enough for white text in both
  // modes), `glow`/`ring` are its translucent shadows.
  const THEMES = {
    teal:    { a: "#0f766e", b: "#14b8a6", deep: "#0f766e", glow: "rgba(13,148,136,.38)",  ring: "rgba(20,184,166,.18)" },
    ocean:   { a: "#1d4ed8", b: "#38bdf8", deep: "#1d4ed8", glow: "rgba(37,99,235,.38)",   ring: "rgba(56,189,248,.20)" },
    violet:  { a: "#6d28d9", b: "#a78bfa", deep: "#6d28d9", glow: "rgba(124,58,237,.38)",  ring: "rgba(167,139,250,.22)" },
    sunset:  { a: "#9a3412", b: "#c2410c", deep: "#c2410c", glow: "rgba(154,52,18,.38)",   ring: "rgba(194,65,12,.20)" },
    rose:    { a: "#be185d", b: "#fb7185", deep: "#be185d", glow: "rgba(225,29,72,.36)",   ring: "rgba(251,113,133,.20)" },
    forest:  { a: "#15803d", b: "#22c55e", deep: "#166534", glow: "rgba(22,163,74,.36)",   ring: "rgba(34,197,94,.20)" },
    crimson: { a: "#b91c1c", b: "#ef4444", deep: "#991b1b", glow: "rgba(220,38,38,.36)",   ring: "rgba(239,68,68,.20)" },
    slate:   { a: "#334155", b: "#64748b", deep: "#1e293b", glow: "rgba(51,65,85,.40)",    ring: "rgba(100,116,139,.22)" },
  };

  // Panel surfaces. Mode is independent of theme so any accent works on either.
  const MODES = {
    light: {
      // placeholder "" = keep the browser's default ::placeholder, exactly as the
      // pre-customization widget rendered it.
      panelBg: "#ffffff", text: "#0f172a", border: "#e3e8ef", logBg: "#f8fafc",
      aiBg: "#ffffff", aiBorder: "#e3e8ef", note: "#64748b", empty: "#94a3b8",
      inputBg: "#ffffff", inputBorder: "#d5dbe4", placeholder: "",
      shadow: "0 26px 64px rgba(15,23,42,.22)", badgeBorder: "#ffffff",
    },
    dark: {
      panelBg: "#0f172a", text: "#e2e8f0", border: "#293548", logBg: "#0b1120",
      aiBg: "#1e293b", aiBorder: "#334155", note: "#94a3b8", empty: "#94a3b8",
      inputBg: "#1e293b", inputBorder: "#334155", placeholder: "#94a3b8",
      shadow: "0 26px 64px rgba(0,0,0,.55)", badgeBorder: "#0f172a",
    },
  };

  // Panel dimensions per preset; the launcher bubble scales with them.
  const SIZES = {
    compact:  { w: 330, h: 480, bubble: 48 },
    standard: { w: 374, h: 560, bubble: 56 },
    large:    { w: 420, h: 640, bubble: 64 },
  };
  // Hard bounds for data-width/data-height. The console mirrors these in its sliders,
  // but the widget re-clamps because the snippet is hand-editable.
  const MIN_W = 320, MAX_W = 480, MIN_H = 420, MAX_H = 720;

  // Parse an integer clamped to [lo, hi]; null (not a fallback) when absent/invalid,
  // so callers can tell "unset" apart from "explicitly set to the default value".
  function intOrNull(raw, lo, hi) {
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : Math.min(hi, Math.max(lo, n));
  }

  const ds = (script && script.dataset) || {};
  // Own-property lookups: a hand-edited value like "constructor" or "toString" is a
  // truthy *inherited* member on a plain object, which would skip a `||` fallback and
  // leak `undefined` into the stylesheet.
  const own = Object.prototype.hasOwnProperty;
  // Corner + exact px offsets from that corner's edges.
  const POSITIONS = { "bottom-right": 1, "bottom-left": 1, "top-right": 1, "top-left": 1 };

  // Attribute values, null where absent/invalid. An explicit attribute PINS its field:
  // the server-saved config (fetched after boot) fills only the nulls, so a fully
  // attributed snippet renders identically even offline, while a bare src+data-tenant
  // tag takes everything from the console's saved customization.
  const attr = {
    name: (ds.name || "").trim() || null,
    theme: ds.theme && own.call(THEMES, ds.theme) ? ds.theme : null,
    mode: ds.mode === "dark" || ds.mode === "light" ? ds.mode : null,
    // "custom" pins the sizing MODE (exact dims, standard bubble) even though it has
    // no preset entry — without it, a server preset change could regrow the bubble
    // under a pasted custom snippet.
    size: ds.size === "custom" || (ds.size && own.call(SIZES, ds.size)) ? ds.size : null,
    width: intOrNull(ds.width, MIN_W, MAX_W),
    height: intOrNull(ds.height, MIN_H, MAX_H),
    position: ds.position && own.call(POSITIONS, ds.position) ? ds.position : null,
    offsetX: intOrNull(ds.offsetX, 0, 200),
    offsetY: intOrNull(ds.offsetY, 0, 200),
  };

  // Merge tag attributes over the server config into one concrete appearance. `srv`
  // uses the same camelCase names (sanitized server-side by app/widget_config.py, but
  // re-validated here because any origin can serve us JSON); it may also carry
  // size:"custom" + width/height for exact dimensions, mirroring the console's model.
  function resolveAppearance(srv) {
    srv = srv || {};
    const pick = function (a, s) { return a != null ? a : (s != null ? s : null); };
    const srvName = typeof srv.name === "string" && srv.name.trim() ? srv.name.trim() : null;
    const srvSize = srv.size === "custom" || (srv.size && own.call(SIZES, srv.size)) ? srv.size : null;
    const sizeId = pick(attr.size, srvSize) || "standard";
    // "custom" has no preset: dims come from width/height, the bubble stays standard.
    const preset = own.call(SIZES, sizeId) ? SIZES[sizeId] : SIZES.standard;
    const srvW = intOrNull(srv.width, MIN_W, MAX_W);
    const srvH = intOrNull(srv.height, MIN_H, MAX_H);
    const themeId = pick(attr.theme, srv.theme && own.call(THEMES, srv.theme) ? srv.theme : null) || "teal";
    const modeId = pick(attr.mode, srv.mode === "dark" || srv.mode === "light" ? srv.mode : null) || "light";
    const position = pick(attr.position, srv.position && own.call(POSITIONS, srv.position) ? srv.position : null) || "bottom-right";
    const offX = pick(attr.offsetX, intOrNull(srv.offsetX, 0, 200));
    const offY = pick(attr.offsetY, intOrNull(srv.offsetY, 0, 200));
    return {
      // Set as textContent below — never interpolated into HTML — so a tenant name
      // can't inject markup onto the host page.
      name: pick(attr.name, srvName) || "BrightSmile Dental",
      themeId: themeId,
      modeId: modeId,
      width: attr.width != null ? attr.width : (sizeId === "custom" && srvW != null ? srvW : preset.w),
      height: attr.height != null ? attr.height : (sizeId === "custom" && srvH != null ? srvH : preset.h),
      bubble: preset.bubble,
      position: position,
      offX: offX != null ? offX : 20,
      offY: offY != null ? offY : 20,
    };
  }

  function buildStyles(A) {
    const theme = THEMES[A.themeId];
    const mode = MODES[A.modeId];
    const width = A.width, height = A.height, bubble = A.bubble;
    const offX = A.offX, offY = A.offY;
    const vSide = A.position.indexOf("top") === 0 ? "top" : "bottom";
    const hSide = A.position.indexOf("left") >= 0 ? "left" : "right";
    const gradient = `linear-gradient(135deg, ${theme.a}, ${theme.b})`;
    // The panel sits above the bubble in bottom corners and below it in top corners.
    const panelV = offY + bubble + 12;

    return `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .bubble {
      position: fixed; ${hSide}: ${offX}px; ${vSide}: ${offY}px; width: ${bubble}px; height: ${bubble}px;
      border-radius: 50%; border: 0; cursor: pointer; z-index: 2147483000;
      background: ${gradient}; color: #fff;
      box-shadow: 0 10px 28px ${theme.glow};
      display: grid; place-items: center; transition: transform .15s ease;
    }
    .bubble:hover { transform: scale(1.06); }
    .badge {
      position: absolute; top: -2px; right: -2px; min-width: 18px; height: 18px;
      border-radius: 9px; background: #ef4444; color: #fff; font-size: 11px;
      font-weight: 700; display: none; place-items: center; padding: 0 5px; border: 2px solid ${mode.badgeBorder};
    }
    .badge.show { display: grid; }
    .panel {
      position: fixed; ${hSide}: ${offX}px; ${vSide}: ${panelV}px;
      width: ${width}px; max-width: calc(100vw - ${offX + 20}px);
      height: ${height}px; max-height: calc(100vh - ${panelV + 32}px); z-index: 2147483000;
      background: ${mode.panelBg}; color: ${mode.text}; border: 1px solid ${mode.border}; border-radius: 18px;
      box-shadow: ${mode.shadow}; display: none; flex-direction: column; overflow: hidden;
    }
    .panel.open { display: flex; }
    .head {
      padding: 14px 16px; background: ${gradient}; color: #fff;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .title { font-size: 14px; font-weight: 700; letter-spacing: -.01em; }
    .sub { font-size: 11px; opacity: .9; margin-top: 2px; display: flex; align-items: center; gap: 5px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; }
    .dot.off { background: #fbbf24; }
    .close { background: transparent; border: 0; color: #fff; cursor: pointer; font-size: 21px; line-height: 1; opacity: .85; }
    .close:hover { opacity: 1; }
    .log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px; background: ${mode.logBg}; }
    .msg { max-width: 84%; padding: 9px 12px; border-radius: 14px; font-size: 13.5px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
    .ai { align-self: flex-start; background: ${mode.aiBg}; border: 1px solid ${mode.aiBorder}; border-top-left-radius: 5px; }
    .human { align-self: flex-end; background: ${theme.deep}; color: #fff; border-top-right-radius: 5px; }
    .note { align-self: center; font-size: 11px; color: ${mode.note}; font-style: italic; padding: 2px 8px; text-align: center; }
    .empty { margin: auto; text-align: center; color: ${mode.empty}; font-size: 13px; padding: 0 22px; line-height: 1.6; }
    .form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid ${mode.border}; background: ${mode.panelBg}; }
    .input {
      flex: 1; border: 1px solid ${mode.inputBorder}; border-radius: 10px; padding: 9px 11px;
      font-size: 13.5px; outline: none; color: ${mode.text}; background: ${mode.inputBg}; min-width: 0;
    }
    ${mode.placeholder ? `.input::placeholder { color: ${mode.placeholder}; }` : ""}
    .input:focus { border-color: ${theme.b}; box-shadow: 0 0 0 3px ${theme.ring}; }
    .send { border: 0; border-radius: 10px; padding: 0 15px; background: ${theme.deep}; color: #fff; font-size: 13.5px; font-weight: 600; cursor: pointer; }
    .send:disabled { opacity: .5; cursor: default; }
    .typing span { display: inline-block; animation: blink 1.4s infinite both; }
    .typing span:nth-child(2) { animation-delay: .2s; }
    .typing span:nth-child(3) { animation-delay: .4s; }
    @keyframes blink { 0%, 80%, 100% { opacity: .25 } 40% { opacity: 1 } }
    .cursor::after { content: "▍"; opacity: .5; animation: blink 1s infinite; }
  `;
  }

  // Boot appearance: attributes + defaults only. The saved config is fetched after the
  // UI exists and repaints it in place (see the /widget/config fetch below).
  let appearance = resolveAppearance(null);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${buildStyles(appearance)}</style>
    <button class="bubble" aria-label="Chat with us">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 20.5l1.5-5.2A8.5 8.5 0 1 1 21 11.5z"
              stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      </svg>
      <span class="badge"></span>
    </button>
    <section class="panel" role="dialog" aria-label="Chat">
      <header class="head">
        <div>
          <div class="title"></div>
          <div class="sub"><span class="dot"></span><span class="status">Online</span></div>
        </div>
        <button class="close" aria-label="Close chat">&times;</button>
      </header>
      <div class="log"></div>
      <form class="form">
        <input class="input" type="text" placeholder="Ask about treatments, prices, booking…" autocomplete="off" />
        <button class="send" type="submit">Send</button>
      </form>
    </section>
  `;
  root.querySelector(".title").textContent = appearance.name;
  root.querySelector(".panel").setAttribute("aria-label", "Chat with " + appearance.name);

  const els = {
    style: root.querySelector("style"),
    title: root.querySelector(".title"),
    bubble: root.querySelector(".bubble"),
    badge: root.querySelector(".badge"),
    panel: root.querySelector(".panel"),
    close: root.querySelector(".close"),
    log: root.querySelector(".log"),
    form: root.querySelector(".form"),
    input: root.querySelector(".input"),
    send: root.querySelector(".send"),
    dot: root.querySelector(".dot"),
    status: root.querySelector(".status"),
  };

  // Swap the stylesheet + header in place. Everything else (transcript, socket, open
  // state) is untouched, so a config landing mid-conversation never disrupts it.
  function applyAppearance(next) {
    appearance = next;
    els.style.textContent = buildStyles(next);
    els.title.textContent = next.name;
    els.panel.setAttribute("aria-label", "Chat with " + next.name);
  }

  let ws = null;
  let open = false;
  let backoff = 1000;
  let pollTimer = null;
  let known = 0;         // messages rendered, used to detect new ones when polling
  let unread = 0;
  let streamEl = null;   // the bubble currently being streamed into
  let typingEl = null;
  let destroyed = false; // set by teardown() so the socket never reconnects afterwards

  // ---------- rendering ----------

  const scroll = () => { els.log.scrollTop = els.log.scrollHeight; };

  // Render a small, safe subset of markdown (**bold**, *italic*) as real DOM nodes.
  // Crucially this uses textContent for every span and only ever appends <strong>/<em>
  // elements we create — never innerHTML — so model output still can't inject markup
  // onto the host page. Bold is matched before italic so ** isn't eaten as two *.
  function setRich(el, text) {
    el.textContent = "";
    const parts = String(text).split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g);
    for (const part of parts) {
      if (!part) continue;
      const bold = /^\*\*([^*\n]+)\*\*$/.exec(part);
      const italic = bold ? null : /^\*([^*\n]+)\*$/.exec(part);
      if (bold || italic) {
        const node = document.createElement(bold ? "strong" : "em");
        node.textContent = (bold || italic)[1];
        el.appendChild(node);
      } else {
        el.appendChild(document.createTextNode(part));
      }
    }
  }

  function addMessage(role, content) {
    const div = document.createElement("div");
    div.className = "msg " + (role === "human" ? "human" : "ai");
    // Assistant replies may contain **bold**; the customer's own text is shown verbatim.
    if (role === "ai") setRich(div, content);
    else div.textContent = content;
    els.log.appendChild(div);
    scroll();
    return div;
  }

  function addNote(text) {
    const div = document.createElement("div");
    div.className = "note";
    div.textContent = text;
    els.log.appendChild(div);
    scroll();
    return div;
  }

  function showEmpty() {
    els.log.innerHTML = "";
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "Hi! Ask about treatments, prices or opening hours — or book a visit.";
    els.log.appendChild(div);
  }

  function showTyping() {
    clearTyping();
    typingEl = document.createElement("div");
    typingEl.className = "msg ai typing";
    typingEl.innerHTML = "<span>•</span><span>•</span><span>•</span>";
    els.log.appendChild(typingEl);
    scroll();
  }

  function clearTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }

  function renderAll(messages) {
    els.log.innerHTML = "";
    streamEl = null;
    typingEl = null;
    if (!messages.length) showEmpty();
    else messages.forEach((m) => addMessage(m.role, m.content));
    known = messages.length;
    scroll();
  }

  function markUnread(n) {
    if (open) return;
    unread += n;
    els.badge.textContent = String(unread);
    els.badge.classList.add("show");
  }

  function setStatus(online, label) {
    els.dot.classList.toggle("off", !online);
    els.status.textContent = label;
  }

  // ---------- transport: websocket ----------

  function connect() {
    if (destroyed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    let socket;
    try {
      const q = TENANT_KEY ? `?tenant_key=${encodeURIComponent(TENANT_KEY)}` : "";
      socket = new WebSocket(`${WS_BASE}/ws/chat/${encodeURIComponent(THREAD)}${q}`);
    } catch (err) {
      startPolling();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      backoff = 1000;
      setStatus(true, "Online");
      stopPolling();  // the socket supersedes the fallback
    };

    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleEvent(msg);
    };

    socket.onclose = () => {
      ws = null;
      if (destroyed) return; // torn down — don't resurrect
      setStatus(false, "Reconnecting…");
      // Poll while disconnected so nothing is missed, and retry the socket with
      // backoff. Whichever recovers first wins.
      startPolling();
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };

    socket.onerror = () => { try { socket.close(); } catch {} };
  }

  function handleEvent(msg) {
    switch (msg.type) {
      case "sync":
        renderAll(msg.messages || []);
        break;

      case "typing":
        showTyping();
        break;

      case "token":
        clearTyping();
        if (!streamEl) {
          streamEl = addMessage("ai", "");
          streamEl.classList.add("cursor");
          streamEl._raw = "";
        }
        // Accumulate the raw stream and re-render, so **bold** formats as it arrives.
        streamEl._raw += msg.text;
        setRich(streamEl, streamEl._raw);
        scroll();
        break;

      case "message": {
        clearTyping();
        if (streamEl) {
          // Replace the streamed preview with the authoritative text.
          setRich(streamEl, msg.content);
          streamEl.classList.remove("cursor");
          streamEl = null;
        } else {
          // No stream in flight: this arrived out of band — a human-approved reply
          // or a scheduled follow-up nudge.
          addMessage("ai", msg.content);
          markUnread(1);
        }
        known += 1;
        if (msg.held) addNote("A team member is reviewing your message…");
        break;
      }

      case "refresh":
        // The event was too large to ship inline; pull the transcript instead.
        syncOverHttp();
        break;

      case "error":
        clearTyping();
        if (streamEl) { streamEl.remove(); streamEl = null; }
        addNote(msg.message || "Something went wrong.");
        break;
    }
  }

  // ---------- transport: http fallback ----------

  async function syncOverHttp() {
    try {
      const q = TENANT_KEY ? `?tenant_key=${encodeURIComponent(TENANT_KEY)}` : "";
      const res = await fetch(`${API}/chat/${encodeURIComponent(THREAD)}/messages${q}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.count !== known) {
        const grew = data.count - known;
        renderAll(data.messages);
        if (grew > 0) markUnread(grew);
      }
    } catch { /* next tick retries */ }
  }

  function startPolling() {
    if (destroyed || pollTimer) return;
    syncOverHttp();
    pollTimer = setInterval(syncOverHttp, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  // Fully dispose this instance: stop the socket (and its reconnect), clear timers, and
  // remove the host element. Called by the single-instance guard at the top of the next
  // load, and by the console's Install page on unmount.
  function teardown() {
    destroyed = true;
    stopPolling();
    if (ws) {
      try { ws.onclose = null; ws.onerror = null; ws.close(); } catch (e) { /* ignore */ }
      ws = null;
    }
    try { host.remove(); } catch (e) { /* ignore */ }
    if (window.__replyoWidget && window.__replyoWidget.host === host) window.__replyoWidget = null;
  }
  window.__replyoWidget = { teardown, host, thread: THREAD, isOpen: function () { return open; } };

  // ---------- sending ----------

  async function send(text) {
    addMessage("human", text);
    known += 1;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "user_message", text }));
      return;
    }

    // Fallback: plain HTTP round-trip, no streaming.
    showTyping();
    els.send.disabled = true;
    try {
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: THREAD, message: text, tenant_key: TENANT_KEY }),
      });
      if (!res.ok) throw new Error("chat " + res.status);
      const data = await res.json();
      clearTyping();
      addMessage("ai", data.reply);
      known += 1;
      if (data.held) addNote("A team member is reviewing your message…");
    } catch {
      clearTyping();
      addNote("Couldn't reach the clinic just now — please try again.");
    } finally {
      els.send.disabled = false;
      els.input.focus();
    }
  }

  // ---------- wiring ----------

  function toggle(next) {
    open = next;
    els.panel.classList.toggle("open", open);
    if (open) {
      unread = 0;
      els.badge.classList.remove("show");
      connect();
      els.input.focus();
      scroll();
    }
  }

  els.bubble.addEventListener("click", () => toggle(!open));
  els.close.addEventListener("click", () => toggle(false));
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.input.value.trim();
    if (!text) return;
    els.input.value = "";
    send(text);
  });

  // Pull the tenant's saved appearance (customized in the console's Install page).
  // Non-blocking: the widget booted with attributes/defaults and repaints only if the
  // fetched config changes a field the tag didn't pin. Fetched once per load — a page
  // load is the sync point for console changes.
  fetch(`${API}/widget/config${TENANT_KEY ? `?tenant_key=${encodeURIComponent(TENANT_KEY)}` : ""}`, { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((cfg) => {
      if (!cfg || destroyed) return;
      const next = resolveAppearance(cfg);
      if (JSON.stringify(next) !== JSON.stringify(appearance)) applyAppearance(next);
    })
    .catch(() => { /* offline or blocked — attributes/defaults already applied */ });

  // Connect straight away (not just on open) so an approved reply or a nudge can
  // raise the unread badge while the panel is still closed.
  showEmpty();
  connect();
  // Restore a panel the torn-down instance had open (the console re-injects on every
  // customization tweak) — directly, not via toggle(), so we never steal focus from
  // the control the user is still dragging.
  if (wasOpen) {
    open = true;
    els.panel.classList.add("open");
  }
})();
