/* Event catalog Mini App — app.js */
(function () {
  "use strict";

  // ── Telegram SDK ────────────────────────────────────────────────────
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); }

  // ── State ────────────────────────────────────────────────────────────
  let allEvents    = [];
  let activeDate   = "all";   // all | today | weekend | week | month
  let activeTag    = null;    // null = no tag filter
  let searchQuery  = "";

  // ── DOM ──────────────────────────────────────────────────────────────
  const spinner      = document.getElementById("spinner");
  const errorDiv     = document.getElementById("error");
  const catalog      = document.getElementById("catalog");
  const cardGrid     = document.getElementById("cardGrid");
  const resultsMeta  = document.getElementById("resultsMeta");
  const dateBar      = document.getElementById("dateFilterBar");
  const tagBar       = document.getElementById("tagFilterBar");
  const tagsSection  = document.getElementById("tagsSection");
  const searchInput  = document.getElementById("searchInput");
  const noResults    = document.getElementById("noResults");
  const greetingEl   = document.getElementById("greeting");

  // ── Date helpers ─────────────────────────────────────────────────────
  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }
  function offsetISO(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }
  // Returns [from, to] YYYY-MM-DD inclusive for the given filter key.
  function dateRange(key) {
    const today = todayISO();
    if (key === "today") return [today, today];
    if (key === "week") {
      // Monday–Sunday of current week (Sunday = 0 in JS).
      const now = new Date();
      const day = now.getDay(); // 0=Sun
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((day + 6) % 7));
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      return [monday.toISOString().slice(0, 10), sunday.toISOString().slice(0, 10)];
    }
    if (key === "weekend") {
      // Next or current Friday + Saturday (Israel weekend).
      const now = new Date();
      const day = now.getDay(); // 0=Sun … 5=Fri … 6=Sat
      const daysToFri = (5 - day + 7) % 7;
      const fri = new Date(now);
      fri.setDate(now.getDate() + daysToFri);
      const sat = new Date(fri);
      sat.setDate(fri.getDate() + 1);
      return [fri.toISOString().slice(0, 10), sat.toISOString().slice(0, 10)];
    }
    if (key === "month") {
      const now = new Date();
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return [today, last.toISOString().slice(0, 10)];
    }
    return [null, null]; // "all"
  }

  // ── Fetch ─────────────────────────────────────────────────────────────
  async function loadEvents() {
    const initData = tg?.initData || "";
    if (!initData) { showError("פתח את הקטלוג דרך הבוט בטלגרם."); return; }

    try {
      const res  = await fetch(`/miniapp/events?${new URLSearchParams({ initData })}`);
      const body = await res.json();
      if (!res.ok) { showError(body.error || `שגיאה ${res.status}`); return; }

      if (body.profile?.firstName) {
        greetingEl.textContent = `שלום, ${body.profile.firstName} 👋`;
      }

      // Build interest-tag filter chips from profile.
      buildTagChips(body.profile?.interests || []);

      allEvents = body.events || [];
      applyFilters();
      spinner.style.display = "none";
      catalog.style.display = "block";
    } catch (err) {
      showError("לא ניתן לטעון את האירועים כרגע. נסו שוב.");
      console.error(err);
    }
  }

  // ── Build tag chips from user interests ────────────────────────────
  function buildTagChips(interests) {
    if (!interests.length) return;
    tagBar.innerHTML = "";
    // "הכל" chip resets tag filter.
    tagBar.appendChild(makeChip("הכל", null, true, "tag"));
    for (const tag of interests) {
      tagBar.appendChild(makeChip(tag, tag, false, "tag"));
    }
    tagsSection.style.display = "block";

    tagBar.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      tagBar.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      activeTag = chip.dataset.tagValue === "__all__" ? null : chip.dataset.tagValue;
      applyFilters();
    });
  }

  function makeChip(label, value, active, type) {
    const btn = document.createElement("button");
    btn.className = "chip" + (active ? " active" : "");
    btn.textContent = label;
    if (type === "tag") btn.dataset.tagValue = value ?? "__all__";
    return btn;
  }

  // ── Filter ────────────────────────────────────────────────────────────
  function applyFilters() {
    const [dateFrom, dateTo] = dateRange(activeDate);
    const q = searchQuery.trim().toLowerCase();

    const visible = allEvents.filter((e) => {
      // Date window.
      if (dateFrom && e.date < dateFrom) return false;
      if (dateTo   && e.date > dateTo)   return false;
      // Interest tag filter.
      if (activeTag) {
        const tags = e.tags || [];
        if (!tags.some((t) => t === activeTag)) return false;
      }
      // Text search.
      if (q) {
        const hay = [e.name, e.location, e.category, ...(e.tags || [])]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    renderGrid(visible);
  }

  // ── Render grid ───────────────────────────────────────────────────────
  function renderGrid(events) {
    cardGrid.innerHTML = "";
    resultsMeta.textContent = events.length ? `${events.length} אירועים` : "";
    noResults.style.display = events.length ? "none" : "block";
    for (const ev of events) cardGrid.appendChild(buildCard(ev));
  }

  // ── Build card ────────────────────────────────────────────────────────
  function buildCard(ev) {
    const card = document.createElement("div");
    card.className = "event-card";

    const metaParts = [];
    if (ev.dateHe) metaParts.push(`📅 ${esc(ev.dateHe)}`);
    if (ev.timeHe) metaParts.push(`🕐 ${esc(ev.timeHe)}`);
    if (ev.location && !isCityWide(ev.location)) metaParts.push(`📍 ${esc(ev.location)}`);
    else if (isCityWide(ev.location)) metaParts.push(`🗺️ ברחבי העיר`);

    const tagsHtml = (ev.tags || []).slice(0, 4)
      .map((t) => `<span class="tag-pill">${esc(t)}</span>`).join("");

    const audienceHtml = ev.audienceLine
      ? `<div class="audience-line">${esc(ev.audienceLine)}</div>` : "";

    // Image — use a proxy via our own server to avoid CORS issues with
    // Smarticket/city CDN. Falls back to a placeholder on error.
    const imgHtml = ev.image
      ? `<div class="card-img-wrap">
           <img class="card-image"
             src="${esc(ev.image)}"
             alt="${esc(ev.name)}"
             loading="lazy"
             onerror="this.closest('.card-img-wrap').style.display='none'"
           />
         </div>`
      : "";

    card.innerHTML = `
      ${imgHtml}
      <div class="card-body">
        <div class="card-title-row">
          <span class="card-icon">${esc(ev.icon || "📌")}</span>
          <span class="card-title">${esc(ev.name)}</span>
        </div>
        ${audienceHtml}
        <div class="card-meta">${metaParts.map((p) => `<span>${p}</span>`).join("")}</div>
        ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ""}
      </div>
      <div class="card-detail">
        ${buildDetail(ev)}
      </div>
    `;

    card.querySelector(".card-body").addEventListener("click", () => toggleCard(card));
    return card;
  }

  function buildDetail(ev) {
    const parts = [];
    if (ev.description) {
      parts.push(`<div class="card-description">${esc(ev.description).replace(/\n/g, "<br>")}</div>`);
    }
    const actions = [];
    if (ev.bookingUrl) {
      actions.push(`<a class="btn btn-primary" href="${esc(ev.bookingUrl)}" target="_blank" rel="noopener">🔗 פרטים והרשמה</a>`);
    }
    if (ev.onlineUrl) {
      actions.push(`<a class="btn btn-secondary" href="${esc(ev.onlineUrl)}" target="_blank" rel="noopener">📹 הצטרף למפגש</a>`);
    }
    if (ev._lat && ev._lng) {
      actions.push(`<a class="btn btn-secondary" href="https://maps.google.com/?q=${ev._lat},${ev._lng}" target="_blank" rel="noopener">🧭 ניווט</a>`);
    } else if (ev.location && !isCityWide(ev.location)) {
      actions.push(`<a class="btn btn-secondary" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}" target="_blank" rel="noopener">🧭 ניווט</a>`);
    }
    if (actions.length) parts.push(`<div class="card-actions">${actions.join("")}</div>`);
    return parts.join("") || "<div class='card-description'>אין פרטים נוספים.</div>";
  }

  function toggleCard(card) {
    const wasOpen = card.classList.contains("open");
    document.querySelectorAll(".event-card.open").forEach((c) => c.classList.remove("open"));
    if (!wasOpen) {
      card.classList.add("open");
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  // ── Date filter chips ─────────────────────────────────────────────────
  dateBar.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || !chip.dataset.date) return;
    dateBar.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    activeDate = chip.dataset.date;
    applyFilters();
  });

  // ── Search ────────────────────────────────────────────────────────────
  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchQuery = searchInput.value; applyFilters(); }, 250);
  });

  // ── Utils ─────────────────────────────────────────────────────────────
  const CITY_WIDE = ["ברחבי העיר", "רחבי העיר", "כלל העיר", "מספר מיקומים", "מיקומים שונים"];
  function isCityWide(loc) { return CITY_WIDE.some((k) => (loc || "").includes(k)); }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function showError(msg) {
    spinner.style.display = "none";
    errorDiv.style.display = "block";
    errorDiv.innerHTML = `<div class="error-banner">${esc(msg)}</div>`;
  }

  loadEvents();
})();
