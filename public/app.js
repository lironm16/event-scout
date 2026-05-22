/* Event catalog Mini App — app.js */
(function () {
  "use strict";

  // ── Telegram SDK ────────────────────────────────────────────────────
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  const INIT_DATA = tg?.initData || "";

  // ── State ────────────────────────────────────────────────────────────
  let allEvents    = [];
  let activeDate   = "all";
  let activeType   = "all";   // all | registration | free | online
  let activeTag    = null;
  let searchQuery  = "";
  let currentView  = "list";  // "list" | "map"
  let leafletMap   = null;
  let tagDrilldown = null;
  const interestedIds = new Set();

  // ── DOM ──────────────────────────────────────────────────────────────
  const spinner     = document.getElementById("spinner");
  const errorDiv    = document.getElementById("error");
  const catalog     = document.getElementById("catalog");
  const cardGrid    = document.getElementById("cardGrid");
  const resultsMeta = document.getElementById("resultsMeta");
  const dateBar     = document.getElementById("dateFilterBar");
  const typeBar     = document.getElementById("typeFilterBar");
  const tagBar      = document.getElementById("tagFilterBar");
  const tagsSection = document.getElementById("tagsSection");
  const searchInput = document.getElementById("searchInput");
  const noResults   = document.getElementById("noResults");
  const viewFab          = document.getElementById("viewFab");
  const mapView          = document.getElementById("mapView");
  const drillBar         = document.getElementById("drillBar");
  const activeFiltersBar = document.getElementById("activeFiltersBar");
  const appHeader        = document.querySelector(".app-header");
  const imgLightbox  = document.getElementById("imgLightbox");
  const lightboxImg  = document.getElementById("lightboxImg");
  const lightboxClose = document.getElementById("lightboxClose");

  function openLightbox(src, alt) {
    lightboxImg.src = src;
    lightboxImg.alt = alt || "";
    imgLightbox.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function closeLightbox() {
    imgLightbox.classList.remove("open");
    document.body.style.overflow = "";
  }
  imgLightbox?.addEventListener("click", (e) => {
    if (e.target === imgLightbox || e.target === lightboxImg) closeLightbox();
  });
  lightboxClose?.addEventListener("click", closeLightbox);

  // Keep --header-h CSS variable in sync so sticky date-headers offset correctly.
  if (appHeader) {
    const hObs = new ResizeObserver(() => {
      document.documentElement.style.setProperty("--header-h", appHeader.offsetHeight + "px");
    });
    hObs.observe(appHeader);
  }
  if (drillBar) {
    const dObs = new ResizeObserver(() => {
      const h = drillBar.style.display === "none" ? 0 : drillBar.offsetHeight;
      document.documentElement.style.setProperty("--drill-h", h + "px");
    });
    dObs.observe(drillBar);
  }

  // ── Date helpers ─────────────────────────────────────────────────────
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function dateRange(key) {
    const today = todayISO();
    if (key === "today")    return [today, today];
    if (key === "tomorrow") { const t = offsetISO(1); return [t, t]; }
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

  // ── Sort ──────────────────────────────────────────────────────────────
  let activeSort = "date-asc"; // date-asc | date-desc | name-asc

  const sortToggleBtn = document.getElementById("sortToggleBtn");
  const sortPanel     = document.getElementById("sortPanel");
  const sortBackdrop  = document.getElementById("sortBackdrop");
  const sortSheetClose = document.getElementById("sortSheetClose");

  function openSortSheet() {
    sortPanel.classList.add("open");
    sortBackdrop.classList.add("open");
    sortToggleBtn.classList.add("active");
    document.body.style.overflow = "hidden";
  }
  function closeSortSheet() {
    sortPanel.classList.remove("open");
    sortBackdrop.classList.remove("open");
    sortToggleBtn.classList.toggle("active", activeSort !== "date-asc");
    document.body.style.overflow = "";
  }

  sortToggleBtn?.addEventListener("click", openSortSheet);
  sortSheetClose?.addEventListener("click", closeSortSheet);
  sortBackdrop?.addEventListener("click", closeSortSheet);

  // Listen to radio changes inside the sort sheet.
  sortPanel?.querySelectorAll("input[name='sort']").forEach((radio) => {
    radio.addEventListener("change", () => {
      activeSort = radio.value;
      closeSortSheet();
      applyFilters();
    });
  });

  function sortEvents(events) {
    const arr = [...events];
    if (activeSort === "date-desc") {
      arr.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.timeHe || "").localeCompare(a.timeHe || ""));
    } else if (activeSort === "name-asc") {
      arr.sort((a, b) => (a.name || "").localeCompare(b.name || "", "he"));
    }
    // date-asc: already server-sorted, no-op.
    return arr;
  }

  // ── Filter ────────────────────────────────────────────────────────────
  function applyFilters() {
    const [df, dt] = dateRange(activeDate);
    const q = searchQuery.trim().toLowerCase();
    const visible = allEvents.filter((e) => {
      if (df && e.date < df) return false;
      if (dt && e.date > dt) return false;
      // "מחייב הרשמה" = has a dedicated registration page (external_url)
      // OR is an online event (zoom/meet) OR is a paid Smarticket event.
      // City page URLs (bookingUrl for rg-muni without external_url) are
      // NOT registration — they're just info pages.
      const requiresReg = !!(e.externalUrl || e.onlineUrl ||
        (e.source !== "rg-muni" && e.ticketsLeft != null));
      if (activeType === "registration" && !requiresReg) return false;
      if (activeType === "free"         && requiresReg)  return false;
      if (activeType === "online"       && !e.onlineUrl) return false;
      if (activeType === "low_stock") {
        const t = e.ticketsLeft;
        if (t == null || t <= 0 || t > 10) return false;
      }
      // Profile tag chip filter.
      if (activeTag && !(e.tags || []).includes(activeTag)) return false;
      // Tag drill-down.
      if (tagDrilldown && !(e.tags || []).includes(tagDrilldown)) return false;
      // Umbrella drill-down.
      if (umbrellaDrilldown && e.umbrella_slug !== umbrellaDrilldown.slug) return false;
      if (q) {
        const hay = [e.name, e.location, e.category, ...(e.tags || [])]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    updateDrillBar();
    updateActiveFiltersBar();
    const sorted = sortEvents(visible);
    if (currentView === "list") renderGrid(sorted);
    else renderMap(sorted);
  }

  // ── Drill-down bar (tag or umbrella) ─────────────────────────────────
  function updateDrillBar() {
    if (!drillBar) return;
    const inDrill = tagDrilldown || umbrellaDrilldown;
    if (inDrill) {
      const label = tagDrilldown
        ? `🏷️ ${esc(tagDrilldown)}`
        : `📋 ${esc(umbrellaDrilldown.title)}`;
      drillBar.style.display = "flex";
      drillBar.innerHTML = `
        <button class="drill-back" id="drillBackBtn">← חזרה</button>
        <span class="drill-label">${label}</span>
      `;
      document.getElementById("drillBackBtn").addEventListener("click", () => {
        const returnScroll = umbrellaDrilldown ? umbrellaReturnScroll : tagReturnScroll;
        tagDrilldown = null;
        umbrellaDrilldown = null;
        applyFilters();
        // Restore scroll position after DOM re-renders.
        requestAnimationFrame(() => window.scrollTo({ top: returnScroll, behavior: "instant" }));
      });
    } else {
      drillBar.style.display = "none";
    }
  }

  // ── Active-filters strip ──────────────────────────────────────────────
  const DATE_LABELS = { today: "היום", tomorrow: "מחר", weekend: "סוף שבוע", week: "השבוע", month: "החודש" };
  const TYPE_LABELS = { registration: "📋 מחייב הרשמה", free: "🎁 כניסה חופשית", online: "💻 אונליין", low_stock: "🎫 נשארו מעט כרטיסים" };

  function clearFilters() {
    activeDate = "all";
    activeType = "all";
    activeTag  = null;
    // Sync chip UI inside the filter sheet.
    dateBar.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.date === "all"));
    typeBar?.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.type === "all"));
    tagBar?.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    applyFilters();
  }

  function updateActiveFiltersBar() {
    if (!activeFiltersBar) return;
    const pills = [];

    if (activeDate !== "all") {
      pills.push({ label: DATE_LABELS[activeDate] || activeDate, clear: () => {
        activeDate = "all";
        dateBar.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.date === "all"));
        applyFilters();
      }});
    }
    if (activeType !== "all") {
      pills.push({ label: TYPE_LABELS[activeType] || activeType, clear: () => {
        activeType = "all";
        typeBar?.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.type === "all"));
        applyFilters();
      }});
    }
    if (activeTag) {
      pills.push({ label: `🏷️ ${activeTag}`, clear: () => {
        activeTag = null;
        tagBar?.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
        applyFilters();
      }});
    }

    // Update badge on filter button.
    const filterToggleBtn = document.getElementById("filterToggleBtn");
    filterToggleBtn?.classList.toggle("has-badge", pills.length > 0);

    if (!pills.length) {
      activeFiltersBar.style.display = "none";
      return;
    }

    activeFiltersBar.style.display = "flex";
    activeFiltersBar.innerHTML = "";

    for (const p of pills) {
      const pill = document.createElement("span");
      pill.className = "active-filter-pill";
      const x = document.createElement("button");
      x.className = "active-filter-pill-x";
      x.textContent = "×";
      x.addEventListener("click", p.clear);
      pill.append(x, document.createTextNode(p.label));
      activeFiltersBar.appendChild(pill);
    }

    if (pills.length > 1) {
      const clearBtn = document.createElement("button");
      clearBtn.className = "clear-filters-btn";
      clearBtn.textContent = "נקה הכל";
      clearBtn.addEventListener("click", clearFilters);
      activeFiltersBar.appendChild(clearBtn);
    }
  }

  // Enter tag drill-down — called from card tag pills.
  window.drillTag = function (tag) {
    tagReturnScroll = window.scrollY;
    tagDrilldown = tag;
    document.querySelectorAll(".event-card.open").forEach((c) => c.classList.remove("open"));
    applyFilters();
    // Don't scroll to top — user stays where they were.
  };

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
    // Time is shown as a badge on the image — not repeated in the meta line.
    if (ev.location && !isCityWide(ev.location)) metaParts.push(`📍 ${esc(ev.location)}`);
    else if (isCityWide(ev.location)) metaParts.push(`🗺️ ברחבי העיר`);

    const tagsHtml = (ev.tags || []).slice(0, 5)
      .map((t) => `<button class="tag-pill tag-pill-btn" onclick="window.drillTag('${esc(t)}')">${esc(t)}</button>`).join("");

    // Audience/age shown in meta line (not as a separate div).
    if (ev.audienceLine) metaParts.push(esc(ev.audienceLine));

    const audienceHtml = "";

    // Ticket / availability line — mirrors the bot's formatTicketsLine.
    let ticketHtml = "";
    const t = ev.ticketsLeft;
    if (t != null) {
      if (t <= 0)       ticketHtml = `<div class="ticket-line sold-out">🚫 אזלו הכרטיסים</div>`;
      else if (t <= 10) ticketHtml = `<div class="ticket-line low-stock">🎫 ${t} כרטיסים אחרונים ❗️</div>`;
      else              ticketHtml = `<div class="ticket-line">🎫 ${t} כרטיסים</div>`;
    }

    // Description is shown only in the expanded detail section — not in the collapsed card.

    const umbrellaHtml = ev.umbrella_title
      ? `<div class="card-umbrella" onclick="event.stopPropagation();window.filterUmbrella('${esc(ev.umbrella_slug)}','${esc(ev.umbrella_title)}')">📋 ${esc(ev.umbrella_title)} ←</div>`
      : "";

    const dateBadge = ev.timeHe
      ? `<div class="card-date-badge">${esc(ev.timeHe)}</div>`
      : (ev.dateHe ? `<div class="card-date-badge">${esc(ev.dateHe)}</div>` : "");

    // Images open the lightbox; placeholder (no image) still expands the card.
    const imgHtml = ev.image
      ? `<div class="card-img-wrap card-img-clickable">
           <img class="card-image"
             src="${esc(ev.image)}"
             alt="${esc(ev.name)}"
             loading="lazy"
             onerror="this.closest('.card-img-wrap').style.display='none'"
           />
           ${dateBadge}
         </div>`
      : (dateBadge ? `<div class="card-img-wrap card-img-placeholder card-click">${dateBadge}</div>` : "");

    const isInterested = interestedIds.has(ev.id);

    card.innerHTML = `
      ${imgHtml}
      <div class="card-body card-click">
        <div class="card-title-row">
          <span class="card-icon">${esc(ev.icon || "📌")}</span>
          <span class="card-title">${esc(ev.name)}</span>
        </div>
        ${audienceHtml}
        ${umbrellaHtml}
        <div class="card-meta">${metaParts.map((p) => `<span>${p}</span>`).join("")}</div>
        ${ticketHtml}
        ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ""}
      </div>
      <div class="card-detail">
        ${buildDetail(ev, isInterested)}
      </div>
    `;

    // Card body (and image-less placeholder) expands the card.
    card.querySelectorAll(".card-click").forEach((el) =>
      el.addEventListener("click", () => toggleCard(card, ev)),
    );
    // Image opens the lightbox instead.
    const imgWrap = card.querySelector(".card-img-clickable");
    if (imgWrap) {
      imgWrap.addEventListener("click", () => openLightbox(ev.image, ev.name));
    }
    return card;
  }

  function buildDetail(ev, isInterested) {
    const parts = [];

    // Full description shown in expanded view.
    if (ev.description) {
      const descHtml = linkifyPhones(esc(ev.description).replace(/\n/g, "<br>"));
      parts.push(`<div class="card-description">${descHtml}</div>`);
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
    // Navigation — prefer text address (shows venue name) over raw coords.
    if (ev.location && !isCityWide(ev.location)) {
      actions.push(`<a class="btn btn-secondary" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}" target="_blank" rel="noopener">🧭 ניווט</a>`);
    } else if (ev._lat && ev._lng) {
      actions.push(`<a class="btn btn-secondary" href="https://maps.google.com/?q=${ev._lat},${ev._lng}" target="_blank" rel="noopener">🧭 ניווט</a>`);
    }
    // Umbrella button removed — the card-umbrella chip in the collapsed card
    // already serves this purpose (with the ← arrow to signal navigation).

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

  // umbrella / tag drill-down state.
  let umbrellaDrilldown = null; // { slug, title }
  let umbrellaReturnScroll = 0; // scrollY position to restore on back
  let tagReturnScroll = 0;

  // Filter to umbrella siblings (client-side) with back button.
  window.filterUmbrella = function (slug, title) {
    umbrellaReturnScroll = window.scrollY;
    umbrellaDrilldown = { slug, title };
    document.querySelectorAll(".event-card.open").forEach((c) => c.classList.remove("open"));
    applyFilters();
    // Don't scroll to top — user stays where they were.
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
        iconSize: [40, 40],
        iconAnchor: [20, 40],
        popupAnchor: [0, -42],
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

  // ── View toggle FAB ───────────────────────────────────────────────────
  function setView(view) {
    currentView = view;
    if (view === "map") {
      catalog.style.display = "none";
      mapView.style.display = "block";
      viewFab.textContent   = "☰";
      viewFab.title         = "תצוגת רשימה";
    } else {
      catalog.style.display = "block";
      mapView.style.display = "none";
      viewFab.textContent   = "🗺️";
      viewFab.title         = "תצוגת מפה";
    }
    applyFilters();
  }

  viewFab?.addEventListener("click", () => {
    setView(currentView === "list" ? "map" : "list");
    tg?.HapticFeedback?.impactOccurred("light");
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

  // ── Type filter chips ─────────────────────────────────────────────────
  typeBar?.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-type]");
    if (!chip) return;
    typeBar.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    activeType = chip.dataset.type;
    applyFilters();
  });

  // ── Filter sheet (bottom sheet overlay) ──────────────────────────────
  const filterPanel     = document.getElementById("filterPanel");
  const filterBackdrop  = document.getElementById("filterBackdrop");
  const filterToggleBtn = document.getElementById("filterToggleBtn");
  const filterSheetClose  = document.getElementById("filterSheetClose");
  const filterSheetApply  = document.getElementById("filterSheetApply");

  function openFilterSheet() {
    filterPanel.classList.add("open");
    filterBackdrop.classList.add("open");
    filterToggleBtn.classList.add("active");
    document.body.style.overflow = "hidden";
  }
  function closeFilterSheet() {
    filterPanel.classList.remove("open");
    filterBackdrop.classList.remove("open");
    filterToggleBtn.classList.remove("active");
    document.body.style.overflow = "";
  }

  filterToggleBtn?.addEventListener("click", openFilterSheet);
  filterSheetClose?.addEventListener("click", closeFilterSheet);
  filterSheetApply?.addEventListener("click", closeFilterSheet);
  filterBackdrop?.addEventListener("click", closeFilterSheet);

  // ── Search ────────────────────────────────────────────────────────────
  let st = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(st);
    st = setTimeout(() => { searchQuery = searchInput.value; applyFilters(); }, 250);
  });

  // ── Utils ─────────────────────────────────────────────────────────────
  const CITY_WIDE = ["ברחבי העיר", "רחבי העיר", "כלל העיר", "מספר מיקומים", "מיקומים שונים"];
  function isCityWide(loc) { return CITY_WIDE.some((k) => (loc || "").includes(k)); }

  // Wrap Israeli phone numbers in a tel: link so mobile users can tap to call.
  // Runs on already-escaped HTML; dashes/spaces aren't affected by esc().
  function linkifyPhones(html) {
    return html.replace(
      /\b(0\d[\s\u00a0-]?\d{2,3}[\s\u00a0-]?\d{4})\b/g,
      (match) => {
        const digits = match.replace(/[\s\u00a0-]/g, "");
        return `<a href="tel:${digits}" class="phone-link">${match}</a>`;
      },
    );
  }

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
