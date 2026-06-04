/* Event catalog Mini App — app.js */
(function () {
  "use strict";

  // ── Telegram SDK ────────────────────────────────────────────────────
  const API_PREFIX = "/miniapp";
  let INIT_DATA = "";

  function parseInitDataFromLocation() {
    for (const raw of [window.location.hash.slice(1), window.location.search.slice(1)]) {
      if (!raw) continue;
      const params = new URLSearchParams(raw);
      const data = params.get("tgWebAppData");
      if (data) return data;
    }
    return "";
  }

  function readInitDataOnce() {
    const tg = window.Telegram?.WebApp;
    if (!tg) return { initData: parseInitDataFromLocation(), hasSdk: false };
    try {
      tg.ready();
      tg.expand();
    } catch (_) { /* ignore */ }
    const fromSdk = tg.initData || "";
    if (fromSdk) return { initData: fromSdk, hasSdk: true };
    const fromUrl = parseInitDataFromLocation();
    return { initData: fromUrl, hasSdk: true };
  }

  async function ensureInitData(maxWaitMs = 800) {
    const deadline = Date.now() + maxWaitMs;
    do {
      const { initData } = readInitDataOnce();
      if (initData) return initData;
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < deadline);
    return readInitDataOnce().initData;
  }

  function catalogAuthErrorMessage() {
    const { hasSdk } = readInitDataOnce();
    if (!hasSdk) {
      return "פתחי את הקטלוג מתוך אפליקציית טלגרם (לא בדפדפן נפרד) — מהכפתור «📅 פתיחת קטלוג» בבוט.";
    }
    return (
      "לא התקבלה הזדהות מטלגרם. סגרי את הקטלוג ופתחי שוב מהכפתור «📅 פתיחת קטלוג» בבוט " +
      "(או מהכפתור ליד שדה ההקלדה). אם זה חוזר — ודאי שב-BotFather הוגדר דומיין ל-Mini App."
    );
  }

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
  const watchedIds = new Set();

  // Server-side search state (sent to /miniapp/events, which runs the bot's
  // full search engine). Light client refinement (type/tag/free-text) still
  // runs on the returned set in applyFilters().
  const serverSearch = {
    date_preset: "upcoming",
    audiences: [],
    activity_types: [],
    keywords: [],
    proximity: false,
    available_only: false,
    unseen_only: false,
    ignore_profile: false, // "כללי"
  };
  let lastWindowLabel = null;
  let lastCanExtend = false;
  let lastExtensionHint = null;
  const DATE_PRESET_MAP = { all: "upcoming", today: "today", tomorrow: "tomorrow", weekend: "this_week", week: "this_week", month: "this_month" };

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
  function buildSearchQuery(extra) {
    const p = new URLSearchParams({ initData: INIT_DATA });
    if (serverSearch.date_preset) p.set("date_preset", serverSearch.date_preset);
    if (serverSearch.audiences.length) p.set("audiences", serverSearch.audiences.join(","));
    if (serverSearch.activity_types.length) p.set("activity_types", serverSearch.activity_types.join(","));
    if (serverSearch.keywords.length) p.set("keywords", serverSearch.keywords.join(","));
    if (serverSearch.proximity) p.set("proximity", "walk");
    if (serverSearch.available_only) p.set("available_only", "1");
    if (serverSearch.unseen_only) p.set("unseen_only", "1");
    if (serverSearch.ignore_profile) p.set("ignore_profile", "1");
    if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }

  async function loadEvents(extra) {
    INIT_DATA = await ensureInitData();
    if (!INIT_DATA) {
      showError(catalogAuthErrorMessage());
      return;
    }
    try {
      spinner.style.display = "block";
      const res  = await fetch(`${API_PREFIX}/events?${buildSearchQuery(extra)}`);
      const body = await res.json();
      if (!res.ok) { showError(body.error || `שגיאה ${res.status}`); return; }
      buildTagChips(body.profile?.interests || []);
      watchedIds.clear();
      (body.watchedIds || []).forEach((id) => watchedIds.add(id));
      allEvents = body.events || [];
      lastWindowLabel = body.window?.label_he || null;
      lastCanExtend = !!body.canExtend;
      lastExtensionHint = body.extensionHint || null;
      updateTypeChipAvailability();
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
    await fetch(`${API_PREFIX}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: INIT_DATA, eventId, signal }),
    });
  }

  // ── Disable type chips that have zero matching events ────────────────
  function updateTypeChipAvailability() {
    if (!typeBar) return;
    const hasOnline   = allEvents.some(e => e.onlineUrl);
    const hasLowStock = allEvents.some(e => e.ticketsLeft != null && e.ticketsLeft > 0 && e.ticketsLeft <= 9);
    typeBar.querySelectorAll(".chip[data-type]").forEach(chip => {
      const type = chip.dataset.type;
      let available = true;
      if (type === "online")    available = hasOnline;
      if (type === "low_stock") available = hasLowStock;
      chip.classList.toggle("chip-disabled", !available);
      chip.disabled = !available;
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
      arr.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.startTime || "").localeCompare(a.startTime || ""));
    } else if (activeSort === "name-asc") {
      arr.sort((a, b) => (a.name || "").localeCompare(b.name || "", "he"));
    } else {
      // date-asc: sort by date then by start time within the same day
      arr.sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.startTime || "").localeCompare(b.startTime || ""));
    }
    return arr;
  }

  // ── Filter ────────────────────────────────────────────────────────────
  function applyFilters() {
    // Date filtering is now done SERVER-side (serverSearch.date_preset);
    // here we only do light client refinement on the returned set.
    const q = searchQuery.trim().toLowerCase();
    const visible = allEvents.filter((e) => {
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
        if (t == null || t <= 0 || t > 9) return false;
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

  function syncScopeChips() {
    document.querySelectorAll("#scopeFilterBar .chip").forEach((c) => {
      const isAll = c.dataset.scope === "all";
      c.classList.toggle("active", isAll === serverSearch.ignore_profile);
    });
  }

  function updateActiveFiltersBar() {
    if (!activeFiltersBar) return;
    const pills = [];

    // Profile scope — default "✨ בשבילי" (only events matching the profile).
    // Removing it switches to "🌐 כללי" (all events) and reloads from server.
    if (!serverSearch.ignore_profile) {
      pills.push({ label: "✨ בשבילי", clear: () => {
        serverSearch.ignore_profile = true;
        syncScopeChips();
        loadEvents();
      }});
    } else {
      pills.push({ label: "🌐 כללי", clear: () => {
        serverSearch.ignore_profile = false;
        syncScopeChips();
        loadEvents();
      }});
    }

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
  // Progressive (infinite-scroll) rendering. We keep the FULL sorted list and
  // reveal it in chunks as the user scrolls — preserving the requested sort.
  const PAGE_SIZE = 12;
  let _renderPlan = [];   // flat list of {type:"header"|"card", …}
  let _renderIdx = 0;
  let _scrollObserver = null;

  function renderGrid(events) {
    cardGrid.innerHTML = "";
    noResults.style.display = events.length ? "none" : "block";
    if (_scrollObserver) { _scrollObserver.disconnect(); _scrollObserver = null; }
    if (!events.length) { resultsMeta.textContent = ""; return; }

    // Flatten into a render plan: a date header before each new date, then
    // its cards — so chunked rendering still shows headers in order.
    _renderPlan = [];
    let lastDate = null;
    for (const ev of events) {
      if (ev.date !== lastDate) {
        _renderPlan.push({ type: "header", dateHe: ev.dateHe || ev.date });
        lastDate = ev.date;
      }
      _renderPlan.push({ type: "card", ev });
    }
    _renderIdx = 0;

    const total = events.length;
    const win = lastWindowLabel ? ` ${lastWindowLabel}` : "";
    resultsMeta.innerHTML = "";
    const label = document.createElement("span");
    label.textContent = `${total} אירועים${win}`;
    resultsMeta.appendChild(label);
    if (lastCanExtend && lastExtensionHint?.suggested_date_to) {
      const ext = document.createElement("button");
      ext.className = "extend-btn";
      ext.textContent = "📅 הרחבת טווח";
      ext.addEventListener("click", () => {
        loadEvents({ dateTo: lastExtensionHint.suggested_date_to });
      });
      resultsMeta.appendChild(ext);
    }

    renderNextChunk();
  }

  function renderNextChunk() {
    let cardsAdded = 0;
    while (_renderIdx < _renderPlan.length && cardsAdded < PAGE_SIZE) {
      const item = _renderPlan[_renderIdx++];
      if (item.type === "header") {
        const header = document.createElement("div");
        header.className = "date-header";
        header.textContent = item.dateHe;
        cardGrid.appendChild(header);
      } else {
        cardGrid.appendChild(buildCard(item.ev));
        cardsAdded++;
      }
    }
    // Place a sentinel after the last rendered item; when it scrolls into
    // view we reveal the next chunk ("polling on scroll").
    const old = document.getElementById("scrollSentinel");
    if (old) old.remove();
    if (_renderIdx < _renderPlan.length) {
      const sentinel = document.createElement("div");
      sentinel.id = "scrollSentinel";
      sentinel.style.height = "1px";
      cardGrid.appendChild(sentinel);
      if (!_scrollObserver) {
        _scrollObserver = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) renderNextChunk();
        }, { rootMargin: "600px" });
      }
      _scrollObserver.observe(sentinel);
    } else if (_scrollObserver) {
      _scrollObserver.disconnect();
      _scrollObserver = null;
    }
  }

  // ── Build card ────────────────────────────────────────────────────────
  function buildCard(ev) {
    const card = document.createElement("div");
    card.className = "event-card";
    card.dataset.id = ev.id;

    const metaParts = [];
    // Location line: use 📷 for online events, 📍 for physical, 🗺️ city-wide.
    if (ev.onlineUrl && !ev.location) {
      metaParts.push("📷 אונליין");
    } else if (ev.location && !isCityWide(ev.location)) {
      const locPrefix = ev.onlineUrl ? "📷" : "📍";
      metaParts.push(`${locPrefix} ${esc(ev.location)}`);
    } else if (isCityWide(ev.location)) {
      metaParts.push(`🗺️ ברחבי העיר`);
    }

    const tagsHtml = (ev.tags || []).slice(0, 5)
      .map((t) => `<button class="tag-pill tag-pill-btn" onclick="window.drillTag('${esc(t)}')">${esc(t)}</button>`).join("");

    // Audience/age ALWAYS on its own line in the card (not inline with the
    // location meta).
    const audienceHtml = ev.audienceLine
      ? `<div class="card-audience">${esc(ev.audienceLine)}</div>`
      : "";

    // Ticket / availability line — mirrors the bot's formatTicketsLine.
    let ticketHtml = "";
    const t = ev.ticketsLeft;
    if (t != null) {
      if (t <= 0)       ticketHtml = `<div class="ticket-line sold-out">🚫 אזלו הכרטיסים</div>`;
      else if (t <= 9) ticketHtml = `<div class="ticket-line low-stock">🎫 ${t} כרטיסים אחרונים</div>`;
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

    // 🔁 Other occurrences of a recurring series.
    if ((ev.totalOccurrences || 1) > 1) {
      actions.push(`<button class="btn btn-secondary" onclick="window.showOccurrences(this,${ev.id})">🔁 מופעים נוספים (${ev.totalOccurrences})</button>`);
    }
    // 🔔 Watch (low-stock / back-in-stock alerts).
    const watching = watchedIds.has(ev.id);
    actions.push(`<button class="btn btn-secondary btn-watch${watching ? " active" : ""}" data-event="${ev.id}" onclick="window.toggleWatch(this,${ev.id})">${watching ? "🔔 במעקב ✓" : "🔔 מעקב"}</button>`);

    if (actions.length) parts.push(`<div class="card-actions">${actions.join("")}</div>`);
    // Container where the occurrences list renders.
    parts.push(`<div class="occ-list" id="occ-${ev.id}"></div>`);

    // Interest / feedback row
    const intClass = isInterested ? "btn btn-interest active" : "btn btn-interest";
    const intLabel = isInterested ? "⭐ מעניין אותי ✓" : "⭐ מעניין אותי";
    const canExcludePlace = ev.location && !isCityWide(ev.location);
    parts.push(`
      <div class="card-feedback">
        <button class="${intClass}" data-event="${ev.id}" onclick="window.toggleInterest(this,${ev.id})">${intLabel}</button>
        <button class="btn btn-muted" data-event="${ev.id}" onclick="window.toggleFeedbackMenu(this,${ev.id})">🚫 לא מתאים</button>
      </div>
      <div class="feedback-menu" id="fb-${ev.id}" hidden>
        <button class="btn btn-muted" onclick="window.sendFeedback(${ev.id},'not_interested')">✕ פשוט לא מעניין</button>
        <button class="btn btn-muted" onclick="window.sendFeedback(${ev.id},'wrong_audience')">👥 קהל לא מתאים</button>
        <button class="btn btn-muted" onclick="window.sendFeedback(${ev.id},'wrong_time')">🕒 שעה לא מתאימה</button>
        ${canExcludePlace ? `<button class="btn btn-muted" onclick="window.excludePlace(${ev.id})">📍 לא מעוניין במקום הזה</button>` : ""}
      </div>
      <div class="card-report-row">
        <button class="btn-report" onclick="window.openReportSheet(${ev.id})">🚩 דווח על בעיה</button>
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

  function fadeOutCard(eventId) {
    setTimeout(() => {
      const card = document.querySelector(`.event-card[data-id="${eventId}"]`);
      if (card) { card.style.opacity = "0.4"; card.style.pointerEvents = "none"; }
    }, 500);
  }

  // 🚫 toggle the detailed feedback reason menu.
  window.toggleFeedbackMenu = function (btn, eventId) {
    const menu = document.getElementById(`fb-${eventId}`);
    if (menu) menu.hidden = !menu.hidden;
  };

  // Submit a reason-tagged "not for me".
  window.sendFeedback = async function (eventId, reason) {
    const menu = document.getElementById(`fb-${eventId}`);
    if (menu) menu.hidden = true;
    try {
      await fetch(`${API_PREFIX}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: INIT_DATA, eventId, reason }),
      });
    } catch (_) { /* ignore */ }
    tg?.HapticFeedback?.impactOccurred("light");
    fadeOutCard(eventId);
  };

  // 📍 Exclude the venue from future results.
  window.excludePlace = async function (eventId) {
    const menu = document.getElementById(`fb-${eventId}`);
    if (menu) menu.hidden = true;
    try {
      await fetch(`${API_PREFIX}/exclude-place`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: INIT_DATA, eventId }),
      });
    } catch (_) { /* ignore */ }
    fadeOutCard(eventId);
  };

  // 🔔 Watch / unwatch.
  window.toggleWatch = async function (btn, eventId) {
    const now = !watchedIds.has(eventId);
    btn.disabled = true;
    try {
      const res = await fetch(`${API_PREFIX}/watch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: INIT_DATA, eventId, watch: now }),
      });
      const body = await res.json().catch(() => ({}));
      const watching = body.watching ?? now;
      if (watching) { watchedIds.add(eventId); btn.classList.add("active"); btn.textContent = "🔔 במעקב ✓"; }
      else { watchedIds.delete(eventId); btn.classList.remove("active"); btn.textContent = "🔔 מעקב"; }
      tg?.HapticFeedback?.impactOccurred("light");
    } catch (_) { /* ignore */ } finally { btn.disabled = false; }
  };

  // 🔁 Load & render other occurrences inline.
  window.showOccurrences = async function (btn, eventId) {
    const box = document.getElementById(`occ-${eventId}`);
    if (!box) return;
    if (box.dataset.loaded === "1") { box.hidden = !box.hidden; return; }
    btn.disabled = true;
    try {
      const res = await fetch(`${API_PREFIX}/occurrences?${new URLSearchParams({ initData: INIT_DATA, id: eventId })}`);
      const list = (await res.json()).occurrences || [];
      if (!list.length) { box.innerHTML = `<div class="occ-empty">אין מופעים נוספים.</div>`; }
      else {
        box.innerHTML = list.map((o) => {
          const when = [o.dateHe, o.timeHe].filter(Boolean).join(" · ");
          const loc = o.location ? ` — ${esc(o.location)}` : "";
          const link = o.bookingUrl ? ` <a href="${esc(o.bookingUrl)}" target="_blank" rel="noopener">🔗</a>` : "";
          return `<div class="occ-row">📅 ${esc(when)}${loc}${link}</div>`;
        }).join("");
      }
      box.dataset.loaded = "1";
      box.hidden = false;
    } catch (_) {
      box.innerHTML = `<div class="occ-empty">שגיאה בטעינת המופעים.</div>`;
      box.hidden = false;
    } finally { btn.disabled = false; }
  };

  // umbrella / tag drill-down state.
  let umbrellaDrilldown = null; // { slug, title }
  let umbrellaReturnScroll = 0; // scrollY position to restore on back
  let tagReturnScroll = 0;

  // Filter to umbrella siblings. Fetches the FULL set of children from the
  // server (incl. ones not in the current results) and merges them in, so
  // "opening the parent" shows everything, not just what was already loaded.
  window.filterUmbrella = async function (slug, title) {
    umbrellaReturnScroll = window.scrollY;
    umbrellaDrilldown = { slug, title };
    document.querySelectorAll(".event-card.open").forEach((c) => c.classList.remove("open"));
    applyFilters(); // show whatever we already have immediately
    try {
      const res = await fetch(`${API_PREFIX}/umbrella?${new URLSearchParams({ initData: INIT_DATA, slug })}`);
      const fetched = (await res.json()).events || [];
      const known = new Set(allEvents.map((e) => e.id));
      const added = fetched.filter((e) => !known.has(e.id));
      if (added.length) {
        allEvents = allEvents.concat(added);
        if (umbrellaDrilldown && umbrellaDrilldown.slug === slug) applyFilters();
      }
    } catch (_) { /* keep client-side subset */ }
  };

  // ── Map view ──────────────────────────────────────────────────────────
  function renderMap(events) {
    // Lazy-init Leaflet map.
    if (!leafletMap) {
      leafletMap = L.map("mapContainer").setView([32.08, 34.81], 13);
      // Muted grayscale basemap (CARTO Positron) so the event markers stand out.
      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        attribution: "© OpenStreetMap © CARTO",
        subdomains: "abcd",
        maxZoom: 19,
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
  // Flat SVG icons for the FAB — emoji are hard to read on the accent-coloured button.
  const FAB_ICON_MAP  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5" fill="currentColor" stroke="none"/></svg>`;
  const FAB_ICON_LIST = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;

  function setView(view) {
    currentView = view;
    if (view === "map") {
      catalog.style.display = "none";
      mapView.style.display = "block";
      viewFab.innerHTML     = FAB_ICON_LIST;
      viewFab.title         = "תצוגת רשימה";
      // Leaflet needs a size-recalc after the container becomes visible.
      if (leafletMap) setTimeout(() => leafletMap.invalidateSize(), 50);
    } else {
      catalog.style.display = "block";
      mapView.style.display = "none";
      viewFab.innerHTML     = FAB_ICON_MAP;
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
    serverSearch.date_preset = DATE_PRESET_MAP[chip.dataset.date] || "upcoming";
    loadEvents(); // date is a server-side window now
  });

  // ── New search-hub chips (audience / activity / options / scope) ──────
  function multiToggle(barId, dataAttr, arr) {
    const bar = document.getElementById(barId);
    bar?.addEventListener("click", (e) => {
      const chip = e.target.closest(`.chip[data-${dataAttr}]`);
      if (!chip) return;
      const val = chip.dataset[dataAttr];
      const i = arr.indexOf(val);
      if (i >= 0) { arr.splice(i, 1); chip.classList.remove("active"); }
      else { arr.push(val); chip.classList.add("active"); }
    });
  }
  multiToggle("audienceFilterBar", "aud", serverSearch.audiences);
  multiToggle("activityFilterBar", "act", serverSearch.activity_types);
  document.getElementById("optionFilterBar")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-opt]");
    if (!chip) return;
    const opt = chip.dataset.opt;
    serverSearch[opt] = !serverSearch[opt];
    chip.classList.toggle("active", serverSearch[opt]);
  });
  document.getElementById("scopeFilterBar")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-scope]");
    if (!chip) return;
    const bar = chip.parentElement;
    bar.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    serverSearch.ignore_profile = chip.dataset.scope === "all";
  });
  document.getElementById("keywordInput")?.addEventListener("input", (e) => {
    const v = e.target.value.trim();
    serverSearch.keywords = v ? [v] : [];
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
  filterSheetApply?.addEventListener("click", () => { closeFilterSheet(); loadEvents(); });
  filterBackdrop?.addEventListener("click", closeFilterSheet);

  // ── Saved searches ────────────────────────────────────────────────────
  const savedPanel    = document.getElementById("savedPanel");
  const savedBackdrop = document.getElementById("savedBackdrop");
  const savedToggleBtn = document.getElementById("savedToggleBtn");
  const savedListEl   = document.getElementById("savedList");
  const savedEmpty    = document.getElementById("savedEmpty");
  const filterSheetSave = document.getElementById("filterSheetSave");

  function currentFilters() {
    return {
      date_preset: serverSearch.date_preset,
      audiences: serverSearch.audiences,
      activity_types: serverSearch.activity_types,
      keywords: serverSearch.keywords,
      proximity: serverSearch.proximity ? "walk" : null,
      available_only: serverSearch.available_only,
      ignore_profile: serverSearch.ignore_profile,
    };
  }
  filterSheetSave?.addEventListener("click", async () => {
    try {
      const res = await fetch(`${API_PREFIX}/saved`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: INIT_DATA, filters: currentFilters() }),
      });
      if (!res.ok) throw new Error(res.status);
      tg()?.HapticFeedback?.notificationOccurred?.("success");
      filterSheetSave.textContent = "✅ נשמר";
      setTimeout(() => { filterSheetSave.textContent = "🔔 שמור חיפוש"; }, 2000);
    } catch (_) { filterSheetSave.textContent = "⚠️ נכשל"; }
  });
  function tg() { return window.Telegram?.WebApp || null; }

  async function openSavedSheet() {
    savedPanel.classList.add("open");
    savedBackdrop.classList.add("open");
    document.body.style.overflow = "hidden";
    savedListEl.innerHTML = "טוען…";
    try {
      const res = await fetch(`${API_PREFIX}/saved?${new URLSearchParams({ initData: INIT_DATA })}`);
      const body = await res.json();
      const list = body.saved || [];
      savedListEl.innerHTML = "";
      savedEmpty.style.display = list.length ? "none" : "block";
      list.forEach((s) => savedListEl.appendChild(buildSavedRow(s)));
    } catch (_) { savedListEl.innerHTML = "שגיאה בטעינה"; }
  }
  function closeSavedSheet() {
    savedPanel.classList.remove("open");
    savedBackdrop.classList.remove("open");
    document.body.style.overflow = "";
  }
  function buildSavedRow(s) {
    const row = document.createElement("div");
    row.className = "saved-row";
    const label = document.createElement("button");
    label.className = "saved-run";
    label.textContent = `🔎 ${s.query || "חיפוש"}`;
    label.addEventListener("click", () => { applySavedSearch(s); closeSavedSheet(); });
    const del = document.createElement("button");
    del.className = "saved-del";
    del.textContent = "🗑️";
    del.addEventListener("click", async () => {
      await fetch(`${API_PREFIX}/saved/archive`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: INIT_DATA, id: s.id }),
      });
      row.remove();
    });
    row.appendChild(label); row.appendChild(del);
    return row;
  }
  function applySavedSearch(s) {
    const f = s.filters || {};
    serverSearch.audiences = f.audience ? [f.audience] : [];
    serverSearch.activity_types = [];
    serverSearch.keywords = Array.isArray(s.tokens) ? s.tokens : [];
    serverSearch.proximity = f.proximity === "walk";
    serverSearch.available_only = false;
    serverSearch.ignore_profile = false;
    serverSearch.date_preset = f.date_from || f.date_to ? "upcoming" : "upcoming";
    if (Array.isArray(f.watch_tag_names) && f.watch_tag_names.length) {
      // tag-based saved search → use as keywords-ish via tags param
      serverSearch.keywords = [...serverSearch.keywords];
    }
    loadEvents(
      f.date_from || f.date_to
        ? { dateFrom: f.date_from || "", dateTo: f.date_to || "" }
        : null,
    );
  }
  savedToggleBtn?.addEventListener("click", openSavedSheet);
  document.getElementById("savedSheetClose")?.addEventListener("click", closeSavedSheet);
  savedBackdrop?.addEventListener("click", closeSavedSheet);

  // ── Search ────────────────────────────────────────────────────────────
  let st = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(st);
    st = setTimeout(() => { searchQuery = searchInput.value; applyFilters(); }, 250);
  });

  // ── Utils ─────────────────────────────────────────────────────────────
  const CITY_WIDE = ["ברחבי העיר", "רחבי העיר", "כלל העיר", "מספר מיקומים", "מיקומים שונים"];
  function isCityWide(loc) { return CITY_WIDE.some((k) => (loc || "").includes(k)); }

  // Wrap Israeli phone numbers in a tel: link — only on mobile/touch devices
  // where tapping to call is meaningful. On desktop web the link adds no value.
  const _isMobile = (() => {
    const platform = window.Telegram?.WebApp?.platform;
    if (platform) return platform === "android" || platform === "ios";
    return /Mobi|Android/i.test(navigator.userAgent) ||
      window.matchMedia("(pointer: coarse)").matches;
  })();

  function linkifyPhones(html) {
    if (!_isMobile) return html;
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

  // ── Report-a-problem sheet ────────────────────────────────────────────
  const reportBackdrop  = document.getElementById("reportBackdrop");
  const reportPanel     = document.getElementById("reportPanel");
  const reportSheetClose = document.getElementById("reportSheetClose");
  const reportChips     = document.getElementById("reportChips");
  const reportNote      = document.getElementById("reportNote");
  const reportSubmit    = document.getElementById("reportSubmit");

  let _reportEventId    = null;
  let _reportIssueType  = null;

  window.openReportSheet = function(eventId) {
    _reportEventId  = eventId;
    _reportIssueType = null;
    reportNote.value = "";
    reportSubmit.disabled = true;
    reportChips.querySelectorAll(".report-chip").forEach(c => c.classList.remove("selected"));
    reportBackdrop.classList.add("open");
    reportPanel.classList.add("open");
  };

  function closeReportSheet() {
    reportBackdrop.classList.remove("open");
    reportPanel.classList.remove("open");
  }

  reportSheetClose.addEventListener("click", closeReportSheet);
  reportBackdrop.addEventListener("click", closeReportSheet);

  reportChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".report-chip");
    if (!chip) return;
    reportChips.querySelectorAll(".report-chip").forEach(c => c.classList.remove("selected"));
    chip.classList.add("selected");
    _reportIssueType = chip.dataset.type;
    reportSubmit.disabled = false;
  });

  reportSubmit.addEventListener("click", async () => {
    if (!_reportEventId || !_reportIssueType) return;
    reportSubmit.disabled = true;
    reportSubmit.textContent = "שולח...";
    try {
      const body = { eventId: _reportEventId, issueType: _reportIssueType, note: reportNote.value.trim() || undefined };
      const initData = window.Telegram?.WebApp?.initData;
      if (initData) body.initData = initData;
      const res = await fetch(`${API_PREFIX}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("server error");
      reportSubmit.textContent = "✓ תודה על הדיווח!";
      setTimeout(closeReportSheet, 1200);
    } catch {
      reportSubmit.textContent = "שלח דיווח";
      reportSubmit.disabled = false;
      alert("שגיאה בשליחה, נסה שוב.");
    }
  });

  // Deep-link: opened via t.me/<bot>?startapp=ev_<id> ("קרא עוד" on a
  // consolidated card) → jump straight to the single-event Mini App page,
  // carrying the Telegram context (same-origin nav keeps initData).
  function startParam() {
    const tg = window.Telegram?.WebApp;
    const fromSdk = tg?.initDataUnsafe?.start_param;
    if (fromSdk) return fromSdk;
    for (const raw of [location.hash.slice(1), location.search.slice(1)]) {
      const v = new URLSearchParams(raw).get("tgWebAppStartParam");
      if (v) return v;
    }
    return "";
  }
  const _sp = startParam();
  const _evMatch = /^ev[_-]?(.+)$/.exec(_sp || "");
  // Telegram puts the launch auth in the URL hash (#tgWebAppData=…) and/or
  // query. A full navigation to a clean URL drops it → the target page has
  // no initData. Carry both across the redirect so profile/event authenticate.
  const _search = window.location.search;       // "?…" or ""
  const _hash = window.location.hash;            // "#…" or ""
  if (_sp === "profile") {
    // Opened via t.me/<bot>?startapp=profile (inline-menu profile button).
    location.replace("profile.html" + _search + _hash);
  } else if (_evMatch) {
    const extra = _search ? "&" + _search.slice(1) : ""; // merge into ?ev=…
    location.replace(
      `event.html?ev=${encodeURIComponent(_evMatch[1])}${extra}${_hash}`,
    );
  } else {
    // start_param "catalog" (or none) → just the catalog.
    loadEvents();
  }
})();
