/* Single-event detail page — event.js */
(function () {
  "use strict";
  const API_PREFIX = "/miniapp";
  const tg = window.Telegram?.WebApp || null;

  function parseInitDataFromLocation() {
    for (const raw of [location.hash.slice(1), location.search.slice(1)]) {
      if (!raw) continue;
      const d = new URLSearchParams(raw).get("tgWebAppData");
      if (d) return d;
    }
    return "";
  }
  function readInitData() {
    if (tg) { try { tg.ready(); tg.expand(); } catch (_) {} return tg.initData || parseInitDataFromLocation(); }
    return parseInitDataFromLocation();
  }
  function eventIdFromUrl() {
    const q = new URLSearchParams(location.search);
    if (q.get("ev")) return q.get("ev");
    // Telegram direct-link start_param fallback: "ev_<id>"
    const sp = tg?.initDataUnsafe?.start_param || "";
    const m = /^ev[_-](\d+)$/.exec(sp);
    return m ? m[1] : null;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function render(ev) {
    const root = document.getElementById("ev-root");
    const parts = [];
    if (ev.image) parts.push(`<img class="ev-img" src="${esc(ev.image)}" alt="" />`);
    parts.push(`<h1 class="ev-title">${esc(ev.icon || "")} ${esc(ev.name)}</h1>`);
    const meta = [];
    if (ev.dateHe) meta.push(`📅 ${esc(ev.dateHe)}`);
    if (ev.timeHe) meta.push(`🕐 ${esc(ev.timeHe)}`);
    if (meta.length) parts.push(`<div class="ev-meta">${meta.join(" · ")}</div>`);
    if (ev.audienceLine) parts.push(`<div class="ev-line">${esc(ev.audienceLine)}</div>`);
    if (ev.location) {
      const maps = ev._lat && ev._lng
        ? `https://www.google.com/maps/search/?api=1&query=${ev._lat},${ev._lng}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}`;
      parts.push(`<div class="ev-line">📍 <a href="${esc(maps)}" target="_blank" rel="noopener">${esc(ev.location)}</a></div>`);
    }
    if (ev.ticketsLeft != null) {
      const t = ev.ticketsLeft;
      parts.push(`<div class="ev-line">${t === 0 ? "🚫 אזלו הכרטיסים" : t <= 9 ? `🎫 ${t} כרטיסים אחרונים ❗️` : `🎫 ${t} כרטיסים`}</div>`);
    }
    if (ev.description) parts.push(`<div class="ev-desc">${esc(ev.description)}</div>`);
    if (Array.isArray(ev.tags) && ev.tags.length) {
      parts.push(`<div class="ev-tags">${ev.tags.map((t) => `<span class="ev-tag">${esc(t)}</span>`).join("")}</div>`);
    }
    const actions = [];
    const reg = ev.onlineUrl || ev.externalUrl || ev.bookingUrl;
    if (reg) actions.push(`<a class="ev-btn primary" href="${esc(reg)}" target="_blank" rel="noopener">${ev.onlineUrl ? "📹 הצטרפו למפגש" : "🔗 הרשמה / פרטים באתר"}</a>`);
    if (actions.length) parts.push(`<div class="ev-actions">${actions.join("")}</div>`);
    root.innerHTML = parts.join("");
  }

  async function boot() {
    const root = document.getElementById("ev-root");
    const initData = readInitData();
    const id = eventIdFromUrl();
    if (!id) { root.innerHTML = '<div class="ev-error">לא צוין אירוע.</div>'; return; }
    if (!initData) { root.innerHTML = '<div class="ev-error">פתחו מתוך טלגרם.</div>'; return; }
    try {
      const res = await fetch(`${API_PREFIX}/event?${new URLSearchParams({ initData, id })}`);
      if (!res.ok) throw new Error(res.status);
      const body = await res.json();
      render(body.event);
    } catch (_) {
      root.innerHTML = '<div class="ev-error">לא הצלחנו לטעון את האירוע.</div>';
    }
  }
  boot();
})();
