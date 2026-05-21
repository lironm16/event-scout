/* Event catalog Mini App — app.js */
(function () {
  "use strict";

  // ── Telegram SDK ────────────────────────────────────────────────────
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  const INIT_DATA = tg?.initData || "";

  // ── State ────────────────────────────────────────────────────────────
  let allEvents   = [];
  let activeDate  = "all";
  let activeTag   = null;
  let searchQuery = "";
  let currentView = "list";  // "list" | "map"
  let leafletMap  = null;
  // Set of event IDs the user has marked as interested (persists in session).
  const interestedIds = new Set();

  // ── DOM ──────────────────────────────────────────────────────────────
  const spinner     = document.getElementById("spinner");
  const errorDiv    = document.getElementById("error");
  const catalog     = document.getElementById("catalog");
  const cardGrid    = document.getElementById("cardGrid");
  const resultsMeta = document.getElementById("resultsMeta");
  const dateBar     = document.getElementById("dateFilterBar");
  const tagBar      = document.getElementById("tagFilterBar");
  const tagsSection = document.getElementById("tagsSection");
  const searchWrap  = document.getElementById("searchWrap");
  const searchInput = document.getElementById("searchInput");
  const noResults   = document.getElementById("noResults");
  const greetingEl  = document.getElementById("greeting");
  const viewToggle  = document.getElementById("viewToggle");
  const mapView     = document.getElementById("mapView");

  // ── Date helpers ─────────────────────────────────────────────────────
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function dateRange(key) {
    const today = todayISO();
    if (key === "today") return [today, today];
    if (key === "week") {
      const now = new Date(), day = now.getDay();
      const mon = new Date(now); mon.setDate(now.getDate() - ((day + 6) % 7));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return [mon.toISOString().slice(0, 10), sun.toISOString().slice(0, 10)];
    }
    if (key === "weekend") {
      const now = new Date(), day = now.getDay();
      const fri = new Date(now); fri.setDate(now.getDate() + (5 - day + 7) % 7);
      const sat = new Date(fri); sat.setDate(fri.getDate() + 1);
      return [fri.toISOString().slice(0, 10), sat.toISOString().slice(0, 10)];
    }
    if (key === "month") {
      const now = new Date();
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return [today, last.toISOString().slice(0, 10)];
    }
    return [null, null];
  }

  // ── Fetch ─────────────────────────────────────────────────────────────
  async function loadEvents() {
    if (!INIT_DATA) { showError("פתח את הקטלוג דרך הבוט בטלגרם."); return; }
    try {
      const res  = await fetch(`/miniapp/events?${new URLSearchParams({ initData: INIT_DATA })}`);
      const body = await res.json();
      if (!res.ok) { showError(body.error || `שגיאה ${res.status}`); return; }
      if (body.profile?.firstName) {
        greetingEl.textContent = `שלום, ${body.profile.firstName} 👋`;
      }
      buildTagChips(body.profile?.interests || []);
      allEvents = body.events || [];
      applyFilters();
      spinner.style.display = "none";
      catalog.style.display = "block";
    } catch (err) {
      showError("לא ניתן לטעון את האירועים כרגע.");
      console.error(err);
    }
  }

  // ── Signal to server (מעניין אותי / לא מתאים) ──────────────────────
  async function sendSignal(eventId, signal) {
    if (!INIT_DATA) return;
    await fetch("/miniapp/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: INIT_DATA, eventId, signal }),
    });
  }

  // ── Build tag chips ───────────────────────────────────────────────────
  function buildTagChips(interests) {
    if (!interests.length) return;
    tagBar.innerHTML = "";
    tagBar.appendChild(makeChip("הכל", "__all__", true));
    for (const tag of interests) tagBar.appendChild(makeChip(tag, tag, false));
    tagsSection.style.display = "block";
    tagBar.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip || !chip.dataset.tag) return;
      tagBar.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      activeTag = chip.dataset.tag === "__all__" ? null : chip.dataset.tag;
      applyFilters();
    });
  }
  function makeChip(label, val, active) {
    const b = document.createElement("button");
    b.className = "chip" + (active ? " active" : "");
    b.textContent = label;
    b.dataset.tag = val;
    return b;
  }

  // ── Filter ────────────────────────────────────────────────────────────
  function applyFilters() {
    const [df, dt] = dateRange(activeDate);
    const q = searchQuery.trim().toLowerCase();
    const visible = allEvents.filter((e) => {
      if (df && e.date < df) return false;
      if (dt && e.date > dt) return false;
      if (activeTag) {
        if (!(e.tags || []).includes(activeTag)) return false;
      }
      if (q) {
        const hay = [e.name, e.location, e.category, ...(e.tags || [])]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (currentView === "list") renderGrid(visible);
    else renderMap(visible);
  }

  // ── Render list (grouped by date) ────────────────────────────────────
  function renderGrid(events) {
    cardGrid.innerHTML = "";
    noResults.style.display = events.length ? "none" : "block";
    if (!events.length) { resultsMeta.textContent = ""; return; }

    // Group by date string (YYYY-MM-DD).
    const groups = [];
    let lastDate = null;
    for (const ev of events) {
      if (ev.date !== lastDate) {
        groups.push({ date: ev.date, dateHe: ev.dateHe || ev.date, events: [] });
        lastDate = ev.date;
      }
      groups[groups.length - 1].events.push(ev);
    }

    let total = 0;
    for (const g of groups) {
      // Date section header.
      const header = document.createElement("div");
      header.className = "date-header";
      header.textContent = g.dateHe;
      cardGrid.appendChild(header);
      for (const ev of g.events) {
        cardGrid.appendChild(buildCard(ev));
        total++;
      }
    }
    resultsMeta.textContent = `${total} אירועים`;
  }

  // ── Build card ────────────────────────────────────────────────────────
  function buildCard(ev) {
    const card = document.createElement("div");
    card.className = "event-card";
    card.dataset.id = ev.id;

    const metaParts = [];
    // Date is shown as a section header above the group — not repeated in the card.
    if (ev.timeHe) metaParts.push(`🕐 ${esc(ev.timeHe)}`);
    if (ev.location && !isCityWide(ev.location)) metaParts.push(`📍 ${esc(ev.location)}`);
    else if (isCityWide(ev.location)) metaParts.push(`🗺️ ברחבי העיר`);

    const tagsHtml = (ev.tags || []).slice(0, 4)
      .map((t) => `<span class="tag-pill">${esc(t)}</span>`).join("");

    const audienceHtml = ev.audienceLine
      ? `<div class="audience-line">${esc(ev.audienceLine)}</div>` : "";

    const imgHtml = ev.image
      ? `<div class="card-img-wrap card-click">
           <img class="card-image"
             src="${esc(ev.image)}"
             alt="${esc(ev.name)}"
             loading="lazy"
             onerror="this.closest('.card-img-wrap').style.display='none'"
           />
         </div>`
      : "";

    const isInterested = interestedIds.has(ev.id);

    card.innerHTML = `
      ${imgHtml}
      <div class="card-body card-click">
        <div class="card-title-row">
          <span class="card-icon">${esc(ev.icon || "📌")}</span>
          <span class="card-title">${esc(ev.name)}</span>
        </div>
        ${audienceHtml}
        <div class="card-meta">${metaParts.map((p) => `<span>${p}</span>`).join("")}</div>
        ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ""}
      </div>
      <div class="card-detail">
        ${buildDetail(ev, isInterested)}
      </div>
    `;

    // Both image and text body toggle the card open.
    card.querySelectorAll(".card-click").forEach((el) =>
      el.addEventListener("click", () => toggleCard(card, ev)),
    );
    return card;
  }

  function buildDetail(ev, isInterested) {
    const parts = [];

    if (ev.description) {
      parts.push(`<div class="card-description">${esc(ev.description).replace(/\n/g, "<br>")}</div>`);
    }

    const actions = [];

    // Primary action: booking / details
    if (ev.bookingUrl) {
      actions.push(`<a class="btn btn-primary" href="${esc(ev.bookingUrl)}" target="_blank" rel="noopener">🔗 פרטים והרשמה</a>`);
    }
    // Online join
    if (ev.onlineUrl) {
      actions.push(`<a class="btn btn-secondary" href="${esc(ev.onlineUrl)}" target="_blank" rel="noopener">📹 הצטרף למפגש</a>`);
    }
    // Navigation
    if (ev._lat && ev._lng) {
      actions.push(`<a class="btn btn-secondary" href="https://maps.google.com/?q=${ev._lat},${ev._lng}" target="_blank" rel="noopener">🧭 ניווט</a>`);
    } else if (ev.location && !isCityWide(ev.location)) {
      actions.push(`<a class="btn btn-secondary" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}" target="_blank" rel="noopener">🧭 ניווט</a>`);
    }
    // Umbrella: all events in series
    if (ev.umbrella_slug && ev.umbrella_title) {
      actions.push(`<button class="btn btn-secondary" onclick="window.filterUmbrella('${esc(ev.umbrella_slug)}','${esc(ev.umbrella_title)}')">📋 כל אירועי ${esc(ev.umbrella_title)}</button>`);
    }

    if (actions.length) parts.push(`<div class="card-actions">${actions.join("")}</div>`);

    // Interest / feedback row
    const intClass = isInterested ? "btn btn-interest active" : "btn btn-interest";
    const intLabel = isInterested ? "⭐ מעניין אותי ✓" : "⭐ מעניין אותי";
    parts.push(`
      <div class="card-feedback">
        <button class="${intClass}" data-event="${ev.id}" onclick="window.toggleInterest(this,${ev.id})">${intLabel}</button>
        <button class="btn btn-muted" data-event="${ev.id}" onclick="window.markNotInterested(this,${ev.id})">✕ לא מתאים</button>
      </div>
    `);

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

  // ── Interest / feedback handlers (global so inline onclick can reach) ──
  window.toggleInterest = async function (btn, eventId) {
    const isNow = interestedIds.has(eventId);
    if (isNow) {
      interestedIds.delete(eventId);
      btn.textContent = "⭐ מעניין אותי";
      btn.classList.remove("active");
      sendSignal(eventId, "not_interested").catch(() => {});
    } else {
      interestedIds.add(eventId);
      btn.textContent = "⭐ מעניין אותי ✓";
      btn.classList.add("active");
      sendSignal(eventId, "interest").catch(() => {});
      tg?.HapticFeedback?.impactOccurred("light");
    }
  };

  window.markNotInterested = async function (btn, eventId) {
    btn.textContent = "✓ נרשם";
    btn.disabled = true;
    sendSignal(eventId, "not_interested").catch(() => {});
    // Fade out the card after a moment.
    setTimeout(() => {
      const card = document.querySelector(`.event-card[data-id="${eventId}"]`);
      if (card) { card.style.opacity = "0.4"; card.style.pointerEvents = "none"; }
    }, 500);
  };

  // Filter to umbrella siblings (client-side).
  window.filterUmbrella = function (slug, title) {
    const matches = allEvents.filter((e) => e.umbrella_slug === slug);
    if (!matches.length) return;
    renderGrid(matches);
    resultsMeta.textContent = `📋 ${esc(title)} — ${matches.length} אירועים`;
    // Scroll to top.
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // ── Map view ──────────────────────────────────────────────────────────
  function renderMap(events) {
    // Lazy-init Leaflet map.
    if (!leafletMap) {
      leafletMap = L.map("mapContainer").setView([32.08, 34.81], 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap",
        maxZoom: 18,
      }).addTo(leafletMap);
    } else {
      leafletMap.eachLayer((l) => { if (l instanceof L.Marker) leafletMap.removeLayer(l); });
    }

    const withCoords = events.filter((e) => e._lat && e._lng);
    if (!withCoords.length) {
      resultsMeta.textContent = "אין אירועים עם מיקום ידוע";
      return;
    }

    const bounds = [];
    for (const ev of withCoords) {
      const icon = L.divIcon({
        className: "",
        html: `<div class="map-pin">${esc(ev.icon || "📌")}</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32],
      });
      const marker = L.marker([ev._lat, ev._lng], { icon }).addTo(leafletMap);
      marker.bindPopup(`
        <div class="map-popup-title">${esc(ev.name)}</div>
        <div class="map-popup-meta">📅 ${esc(ev.dateHe || ev.date)}${ev.timeHe ? " · " + esc(ev.timeHe) : ""}${ev.location ? "<br>📍 " + esc(ev.location) : ""}</div>
        ${ev.bookingUrl ? `<a class="map-popup-link" href="${esc(ev.bookingUrl)}" target="_blank">🔗 פרטים</a>` : ""}
      `);
      bounds.push([ev._lat, ev._lng]);
    }
    if (bounds.length) leafletMap.fitBounds(bounds, { padding: [30, 30] });
    resultsMeta.textContent = `${withCoords.length} אירועים על המפה`;

    // Force map to recalculate size after display:block.
    setTimeout(() => leafletMap.invalidateSize(), 100);
  }

  // ── View toggle ───────────────────────────────────────────────────────
  viewToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".view-btn");
    if (!btn || btn.dataset.view === currentView) return;
    viewToggle.querySelectorAll(".view-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentView = btn.dataset.view;

    if (currentView === "map") {
      catalog.style.display   = "none";
      mapView.style.display   = "block";
      searchWrap.style.display = "none";
    } else {
      catalog.style.display   = "block";
      mapView.style.display   = "none";
      searchWrap.style.display = "block";
    }
    applyFilters();
  });

  // ── Date filter chips ─────────────────────────────────────────────────
  dateBar.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-date]");
    if (!chip) return;
    dateBar.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    activeDate = chip.dataset.date;
    applyFilters();
  });

  // ── Search ────────────────────────────────────────────────────────────
  let st = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(st);
    st = setTimeout(() => { searchQuery = searchInput.value; applyFilters(); }, 250);
  });

  // ── Utils ─────────────────────────────────────────────────────────────
  const CITY_WIDE = ["ברחבי העיר", "רחבי העיר", "כלל העיר", "מספר מיקומים", "מיקומים שונים"];
  function isCityWide(loc) { return CITY_WIDE.some((k) => (loc || "").includes(k)); }
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function showError(msg) {
    spinner.style.display = "none";
    errorDiv.style.display = "block";
    errorDiv.innerHTML = `<div class="error-banner">${esc(msg)}</div>`;
  }

  loadEvents();
})();
