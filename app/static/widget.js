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
 *     because the two legitimately differ (a RAG answer gains a `Sources:` footer,
 *     and an escalated message is answered with a holding note instead of the draft
 *     that's waiting on a human).
 */
(function () {
  "use strict";

  const script = document.currentScript;
  const API = (script && script.dataset.api ? script.dataset.api : window.location.origin)
    .replace(/\/$/, "");
  const WS_BASE = API.replace(/^http/, "ws");
  const STORAGE_KEY = "replyo:thread_id";
  const POLL_MS = 4000;
  const MAX_BACKOFF = 15000;

  // One stable thread per browser, so a returning visitor keeps their history.
  function threadId() {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      const uuid = window.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(16).slice(2);
      id = "web:" + uuid;
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  }

  const THREAD = threadId();

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .bubble {
      position: fixed; right: 20px; bottom: 20px; width: 56px; height: 56px;
      border-radius: 50%; border: 0; cursor: pointer; z-index: 2147483000;
      background: linear-gradient(135deg, #0f766e, #14b8a6); color: #fff;
      box-shadow: 0 10px 28px rgba(13,148,136,.38);
      display: grid; place-items: center; transition: transform .15s ease;
    }
    .bubble:hover { transform: scale(1.06); }
    .badge {
      position: absolute; top: -2px; right: -2px; min-width: 18px; height: 18px;
      border-radius: 9px; background: #ef4444; color: #fff; font-size: 11px;
      font-weight: 700; display: none; place-items: center; padding: 0 5px; border: 2px solid #fff;
    }
    .badge.show { display: grid; }
    .panel {
      position: fixed; right: 20px; bottom: 88px; width: 374px; max-width: calc(100vw - 40px);
      height: 560px; max-height: calc(100vh - 120px); z-index: 2147483000;
      background: #fff; color: #0f172a; border: 1px solid #e3e8ef; border-radius: 18px;
      box-shadow: 0 26px 64px rgba(15,23,42,.22); display: none; flex-direction: column; overflow: hidden;
    }
    .panel.open { display: flex; }
    .head {
      padding: 14px 16px; background: linear-gradient(135deg, #0f766e, #14b8a6); color: #fff;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .title { font-size: 14px; font-weight: 700; letter-spacing: -.01em; }
    .sub { font-size: 11px; opacity: .9; margin-top: 2px; display: flex; align-items: center; gap: 5px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; }
    .dot.off { background: #fbbf24; }
    .close { background: transparent; border: 0; color: #fff; cursor: pointer; font-size: 21px; line-height: 1; opacity: .85; }
    .close:hover { opacity: 1; }
    .log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px; background: #f8fafc; }
    .msg { max-width: 84%; padding: 9px 12px; border-radius: 14px; font-size: 13.5px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
    .ai { align-self: flex-start; background: #fff; border: 1px solid #e3e8ef; border-top-left-radius: 5px; }
    .human { align-self: flex-end; background: #0f766e; color: #fff; border-top-right-radius: 5px; }
    .note { align-self: center; font-size: 11px; color: #64748b; font-style: italic; padding: 2px 8px; text-align: center; }
    .empty { margin: auto; text-align: center; color: #94a3b8; font-size: 13px; padding: 0 22px; line-height: 1.6; }
    .form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #e3e8ef; background: #fff; }
    .input {
      flex: 1; border: 1px solid #d5dbe4; border-radius: 10px; padding: 9px 11px;
      font-size: 13.5px; outline: none; color: #0f172a; background: #fff; min-width: 0;
    }
    .input:focus { border-color: #14b8a6; box-shadow: 0 0 0 3px rgba(20,184,166,.18); }
    .send { border: 0; border-radius: 10px; padding: 0 15px; background: #0f766e; color: #fff; font-size: 13.5px; font-weight: 600; cursor: pointer; }
    .send:disabled { opacity: .5; cursor: default; }
    .typing span { display: inline-block; animation: blink 1.4s infinite both; }
    .typing span:nth-child(2) { animation-delay: .2s; }
    .typing span:nth-child(3) { animation-delay: .4s; }
    @keyframes blink { 0%, 80%, 100% { opacity: .25 } 40% { opacity: 1 } }
    .cursor::after { content: "▍"; opacity: .5; animation: blink 1s infinite; }
  `;

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${STYLES}</style>
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
          <div class="title">BrightSmile Dental</div>
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

  const els = {
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

  let ws = null;
  let open = false;
  let backoff = 1000;
  let pollTimer = null;
  let known = 0;         // messages rendered, used to detect new ones when polling
  let unread = 0;
  let streamEl = null;   // the bubble currently being streamed into
  let typingEl = null;

  // ---------- rendering ----------

  const scroll = () => { els.log.scrollTop = els.log.scrollHeight; };

  function addMessage(role, content) {
    const div = document.createElement("div");
    div.className = "msg " + (role === "human" ? "human" : "ai");
    // textContent, never innerHTML: replies are model-generated and must never be
    // interpreted as markup on the host page.
    div.textContent = content;
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
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    let socket;
    try {
      socket = new WebSocket(`${WS_BASE}/ws/chat/${encodeURIComponent(THREAD)}`);
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
        }
        streamEl.textContent += msg.text;
        scroll();
        break;

      case "message": {
        clearTyping();
        if (streamEl) {
          // Replace the streamed preview with the authoritative text.
          streamEl.textContent = msg.content;
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
      const res = await fetch(`${API}/chat/${encodeURIComponent(THREAD)}/messages`, { cache: "no-store" });
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
    if (pollTimer) return;
    syncOverHttp();
    pollTimer = setInterval(syncOverHttp, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

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
        body: JSON.stringify({ thread_id: THREAD, message: text }),
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

  // Connect straight away (not just on open) so an approved reply or a nudge can
  // raise the unread badge while the panel is still closed.
  showEmpty();
  connect();
})();
