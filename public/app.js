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
  let userHome = null; // { lat, lng, address } from the profile — distance/nav
  const eventsById = new Map(); // id → serialized event (for related lookups)
  let catalogScope = "me";      // "me" (בשבילי) | "all" (כללי)

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
  window.openLightbox = openLightbox; // reachable from inline card onclick
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
      spinner.style.display = "none";
      showSkeletons();
      const res  = await fetch(`${API_PREFIX}/events?${buildSearchQuery(extra)}`);
      const body = await res.json();
      if (!res.ok) { showError(body.error || `שגיאה ${res.status}`); return; }
      buildTagChips(body.profile?.interests || []);
      userHome = body.profile?.home || null;
      catalogScope = body.scope || (serverSearch.ignore_profile ? "all" : "me");
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
  function buildTagChips(_interests) {
    // Interest-tag chips removed — the concept was unclear to users.
    // (May return later in a clearer form.)
    if (tagsSection) tagsSection.style.display = "none";
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
    } else if (activeSort === "dist-asc") {
      // Closest first; events with no known distance sink to the bottom.
      arr.sort((a, b) => {
        const da = a.distanceKm == null ? Infinity : a.distanceKm;
        const db = b.distanceKm == null ? Infinity : b.distanceKm;
        return da - db || (a.date || "").localeCompare(b.date || "");
      });
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

  // Full reset — clears BOTH client-side (date/type/tag) and server-side
  // (audiences / activity / options / keyword) filters, then re-runs the
  // search. Scope (בשבילי/כללי) is intentionally left untouched — it's a
  // separate switch, not a "filter". The arrays are mutated IN PLACE
  // because multiToggle() captured them by reference.
  function resetAllFilters() {
    activeDate = "all";
    activeType = "all";
    activeTag = null;
    serverSearch.date_preset = "upcoming";
    serverSearch.audiences.length = 0;
    serverSearch.activity_types.length = 0;
    serverSearch.keywords.length = 0;
    serverSearch.proximity = false;
    serverSearch.available_only = false;
    serverSearch.unseen_only = false;
    document
      .querySelectorAll("#dateFilterBar .chip")
      .forEach((c) => c.classList.toggle("active", c.dataset.date === "all"));
    document
      .querySelectorAll("#typeFilterBar .chip")
      .forEach((c) => c.classList.toggle("active", c.dataset.type === "all"));
    document
      .querySelectorAll(
        "#audienceFilterBar .chip, #activityFilterBar .chip, #optionFilterBar .chip, #tagFilterBar .chip",
      )
      .forEach((c) => c.classList.remove("active"));
    const kw = document.getElementById("keywordInput");
    if (kw) kw.value = "";
    loadEvents();
  }

  function syncScopeChips() {
    document.querySelectorAll("#scopeFilterBar .chip").forEach((c) => {
      const isAll = c.dataset.scope === "all";
      c.classList.toggle("active", isAll === serverSearch.ignore_profile);
    });
    // Floating "בשבילי / כולל" switch: ON = בשבילי (profile-matched only).
    const t = document.getElementById("forMeToggle");
    if (t) {
      const forMe = !serverSearch.ignore_profile;
      t.classList.toggle("on", forMe);
      t.setAttribute("aria-pressed", String(forMe));
      // Label stays "✨ בשבילי" always — the knob shows on/off (off = disabled).
    }
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
  // Progressive (infinite-scroll) rendering. We keep the FULL sorted list and
  // reveal it in chunks as the user scrolls — preserving the requested sort.
  const PAGE_SIZE = 12;
  let _renderPlan = [];   // flat list of {type:"header"|"card", …}
  let _renderIdx = 0;
  let _scrollObserver = null;

  function showSkeletons(n = 4) {
    catalog.style.display = "block";
    noResults.style.display = "none";
    errorDiv.style.display = "none";
    resultsMeta.textContent = "";
    cardGrid.innerHTML = Array.from({ length: n }).map(() => `
      <div class="skel-card">
        <div class="skel-hero"></div>
        <div class="skel-body"><div class="skel-line w70"></div><div class="skel-line w40"></div></div>
      </div>`).join("");
  }

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
        const node = buildCard(item.ev);
        node.classList.add("card-reveal");
        cardGrid.appendChild(node);
        if (revealObserver) revealObserver.observe(node); else node.classList.add("card-in");
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
  // Per-category color pair → each card gets its own accent (esp. the
  // image-less hero gradient). Falls back to a stable hash-based hue.
  const CAT_COLORS = {
    "הצגה": ["#ff6a88", "#ff99ac"], "הופעה": ["#7367f0", "#9e95f5"],
    "סדנה": ["#00b8a9", "#3fd0c9"], "הרצאה": ["#3a7bd5", "#00d2ff"],
    "הפעלה": ["#ff9a3c", "#ffc56e"], "משחקייה": ["#ff5fa2", "#ff9ecb"],
    "מסיבה": ["#b14aed", "#e07bff"], "ארוחה": ["#e8616d", "#ffb199"],
    "מפגש": ["#2bb673", "#7bd88f"], "סיור": ["#1d976c", "#93f9b9"],
    "ספורט": ["#f7971e", "#ffd200"], "אחר": ["#5b7fff", "#8a5bff"],
  };
  function catColors(ev) {
    if (ev.category && CAT_COLORS[ev.category]) return CAT_COLORS[ev.category];
    const s = ev.icon || ev.category || ev.name || "?";
    let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return [`hsl(${h} 68% 56%)`, `hsl(${(h + 38) % 360} 70% 62%)`];
  }

  // Reveal cards as they scroll into view.
  const revealObserver = "IntersectionObserver" in window
    ? new IntersectionObserver((entries, obs) => {
        entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("card-in"); obs.unobserve(e.target); } });
      }, { rootMargin: "0px 0px -8% 0px" })
    : null;

  function buildCard(ev, opts = {}) {
    const card = document.createElement("div");
    card.className = "event-card";
    card.dataset.id = ev.id;
    // "✨ בשבילך" — only in כללי mode for profile-matching events.
    const forMeMark = catalogScope === "all" && ev.forMe;
    if (forMeMark) card.classList.add("for-me");
    eventsById.set(ev.id, ev);
    const [c1, c2] = catColors(ev);
    card.style.setProperty("--c1", c1);
    card.style.setProperty("--c2", c2);

    // ── Location line — 📷 for online, 📍 physical, 🗺️ city-wide ──
    let locText = "";
    if (isOnline(ev)) locText = "📷 אונליין";
    else if (ev.location && !isCityWide(ev.location)) locText = `📍 ${esc(ev.location)}`;
    else if (isCityWide(ev.location)) locText = "🗺️ ברחבי העיר";

    // ── Visual ticket status (overlay badge, not a body line) ──
    let statusBadge = "";
    let soldOut = false;
    const t = ev.ticketsLeft;
    if (t != null) {
      if (t <= 0) { soldOut = true; statusBadge = `<span class="status-badge soldout">אזל</span>`; }
      else if (t <= 9) statusBadge = `<span class="status-badge low"><span class="pulse-dot"></span>${t} אחרונים</span>`;
      else statusBadge = `<span class="status-badge ok">🎟️ ${t} כרטיסים</span>`;
    }

    const tagsHtml = (ev.tags || []).slice(0, 4)
      .map((tg) => `<button class="tag-pill" onclick="event.stopPropagation();window.drillTag('${esc(tg)}')">${esc(tg)}</button>`).join("");

    const audiencePill = ev.audienceLine
      ? `<span class="aud-pill">${esc(ev.audienceLine.replace(/^🎯\s*/, ""))}</span>` : "";

    // Own row, shown only when the event is narrowed to specific community/ies.
    const accessHtml = ev.accessLine
      ? `<div class="card-access">${esc(ev.accessLine)}</div>` : "";

    const umbrellaHtml = ev.umbrella_title
      ? `<button class="card-umbrella" onclick="event.stopPropagation();window.filterUmbrella('${esc(ev.umbrella_slug)}','${esc(ev.umbrella_title)}')">📋 ${esc(ev.umbrella_title)}</button>`
      : "";

    const whenPill = ev.timeHe || ev.dateHe
      ? `<span class="when-pill">🕒 ${esc(ev.timeHe || ev.dateHe)}</span>` : "";

    // ── Hero: image (or gradient fallback) with title overlaid ──
    const heroInner = ev.image
      ? `<img class="card-image" src="${esc(ev.image)}" alt="${esc(ev.name)}" loading="lazy"
            onerror="this.closest('.card-hero').classList.add('no-img')" />`
      : `<span class="hero-emoji">${esc(ev.icon || "📌")}</span>`;

    const isInterested = interestedIds.has(ev.id);

    card.innerHTML = `
      <div class="card-hero${ev.image ? "" : " no-img"}${soldOut ? " soldout" : ""}">
        ${heroInner}
        <div class="hero-grad"></div>
        <div class="hero-top">
          <div class="hero-badges">${statusBadge}</div>
          ${whenPill}
        </div>
        <div class="hero-foot">
          <h3 class="card-title">${ev.image ? "" : `<span class="title-emoji">${esc(ev.icon || "📌")}</span> `}${esc(ev.name)}</h3>
        </div>
      </div>
      <div class="card-body card-click">
        <div class="card-pillrow">
          ${forMeMark ? `<span class="forme-dot" title="בשבילך">✨</span>` : ""}
          ${audiencePill}
          ${locText ? `<span class="loc-pill">${locText}</span>` : ""}
          ${ev.distanceLabel ? `<span class="dist-pill${ev.requiresCar ? " car" : ""}">${esc(ev.distanceLabel)}</span>` : ""}
        </div>
        ${accessHtml}
        ${umbrellaHtml}
        ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ""}
      </div>
      <div class="card-detail">
        ${buildDetail(ev, isInterested, opts)}
      </div>
    `;

    // Body tap → open the event in the shared popup modal (same one the bot
    // deep-link uses; tapping another card swaps it). Hero: an image opens the
    // lightbox (zoom); an image-less gradient hero opens the modal too.
    card.querySelector(".card-body")?.addEventListener("click", () => window.openEventModal(ev.id, ev));
    const heroEl = card.querySelector(".card-hero");
    if (ev.image) {
      heroEl?.addEventListener("click", () => openLightbox(ev.image, ev.name));
    } else {
      heroEl?.addEventListener("click", () => window.openEventModal(ev.id, ev));
    }
    return card;
  }

  // Navigation URL — directions FROM the user's home when we know it
  // (origin=home → destination=venue), so the maps app opens a ROUTE from
  // home rather than just dropping a pin. Falls back to a venue search when
  // there's no home on file.
  function navUrlFor(ev) {
    if (isOnline(ev)) return null;
    // Destination: the venue's textual address (a readable place name in the
    // maps app) when we have one; fall back to raw coords only otherwise.
    const dest = (ev.location && !isCityWide(ev.location))
      ? ev.location
      : (ev._lat != null && ev._lng != null ? `${ev._lat},${ev._lng}` : null);
    if (!dest) return null;
    const destParam = encodeURIComponent(dest);
    // Origin: the saved home ADDRESS as words (so the route starts from the
    // place name, not a lat/lng pin). Fall back to coords, then no origin.
    const originRaw = userHome
      ? (userHome.address ||
          (userHome.lat != null && userHome.lng != null ? `${userHome.lat},${userHome.lng}` : null))
      : null;
    if (originRaw) {
      return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originRaw)}&destination=${destParam}&travelmode=driving`;
    }
    return `https://www.google.com/maps/search/?api=1&query=${destParam}`;
  }

  function buildDetail(ev, isInterested, opts = {}) {
    const parts = [];

    // 1) Primary CTA + ניווט (+ watch when sold out) on one row.
    const navUrl = navUrlFor(ev);
    const ctaRow = [];
    if (ev.bookingUrl) {
      ctaRow.push(`<a class="btn btn-primary cta-main" href="${esc(ev.bookingUrl)}" target="_blank" rel="noopener">🔗 לאתר</a>`);
    } else if (ev.onlineUrl) {
      ctaRow.push(`<a class="btn btn-primary cta-main" href="${esc(ev.onlineUrl)}" target="_blank" rel="noopener">📹 הצטרפו למפגש</a>`);
    }
    if (navUrl) ctaRow.push(`<a class="btn btn-secondary cta-nav" href="${esc(navUrl)}" target="_blank" rel="noopener">🧭 ניווט</a>`);
    if (ctaRow.length) parts.push(`<div class="cta-row">${ctaRow.join("")}</div>`);

    // Sold-out → a dedicated watch block on its own row, with a short prompt
    // so it's clear what "follow" does (availability from the site + 2nd-hand).
    const soldOut = ev.ticketsLeft != null && ev.ticketsLeft <= 0;
    if (soldOut) {
      const watching = watchedIds.has(ev.id);
      parts.push(`<div class="watch-block">
        <div class="watch-q">🎫 אזל — רוצה שנעדכן אותך כשמתפנים כרטיסים? (זמינות מהאתר וגם כרטיסים יד שנייה)</div>
        <button class="btn btn-watch${watching ? " active" : ""}" onclick="event.stopPropagation();window.toggleWatch(this,${ev.id})">${watching ? "🔔 עוקבים — נעדכן אותך" : "🔔 כן, עדכנו אותי"}</button>
      </div>`);
    }

    // 2) Description — clamped to 3 lines, with a קרא עוד ↔ סגור toggle.
    if (ev.description) {
      const descHtml = linkifyPhones(esc(ev.description).replace(/\n/g, "<br>"));
      const isLong = ev.description.length > 140;
      parts.push(`<div class="desc-wrap">
        <div class="card-description${isLong ? " clamped" : ""}">${descHtml}</div>
        ${isLong ? `<button class="desc-readmore" onclick="event.stopPropagation();window.toggleDesc(this)">קרא עוד</button>` : ""}
      </div>`);
    }

    // 4) Related set → compact list; each row opens a popup. Works for both a
    //    same-name series AND an umbrella program (rows show titles when the
    //    items differ). Grouped by the same seriesKey the count uses.
    if (!opts.hideOccurrences && (ev.totalOccurrences || 1) > 1) {
      const word = ev.umbrella_slug ? "בתוכנית" : "מהסדרה";
      // "עוד N" = the OTHERS (the list excludes the current occurrence).
      const more = (ev.totalOccurrences || 1) - 1;
      parts.push(`<button class="series-btn" onclick="window.showSeries(this,${ev.id})">🗓️ עוד ${more} ${word} ▾</button>`);
      parts.push(`<div class="occ-list"></div>`);
    }

    // 5) Quiet "hide" entry → opens the suppression sheet. Shown for events
    //    that ARE for you (so you can refine your feed). NOT shown for
    //    non-matching events in כללי mode — those are already filtered out of
    //    בשבילי, so there's nothing to suppress.
    if (ev.forMe !== false) {
      parts.push(`<button class="hide-link" onclick="window.openSuppressSheet(${ev.id})">🙈 אל תראה לי אירועים כאלה</button>`);
    }

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
      btn.classList.remove("active");
      sendSignal(eventId, "not_interested").catch(() => {});
    } else {
      interestedIds.add(eventId);
      btn.classList.add("active");
      sendSignal(eventId, "interest").catch(() => {});
      tg?.HapticFeedback?.impactOccurred("light");
    }
  };

  // "קרא עוד" ↔ "סגור" — toggle the full description in place.
  window.toggleDesc = function (btn) {
    const desc = btn.closest(".desc-wrap")?.querySelector(".card-description");
    if (!desc) return;
    const clamped = desc.classList.toggle("clamped");
    btn.textContent = clamped ? "קרא עוד" : "סגור";
  };

  // ⋯ overflow menu toggle.
  window.toggleMoreMenu = function (btn, eventId) {
    const menu = btn.closest(".card-detail")?.querySelector(`#fb-${eventId}`);
    if (menu) menu.hidden = !menu.hidden;
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
      if (watching) { watchedIds.add(eventId); btn.classList.add("active"); }
      else { watchedIds.delete(eventId); btn.classList.remove("active"); }
      if (btn.classList.contains("btn-watch")) {
        btn.textContent = watching ? "🔔 עוקבים — נעדכן אותך" : "🔔 כן, עדכנו אותי";
      }
      tg?.HapticFeedback?.impactOccurred("light");
    } catch (_) { /* ignore */ } finally { btn.disabled = false; }
  };

  // Open a single event as a full card in a popup (used by the map).
  let _lastModalEvId = null;
  window.openEventModal = async function (eventId, preloaded) {
    let overlay = document.getElementById("eventModal");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "eventModal";
      overlay.className = "event-modal-backdrop";
      overlay.innerHTML = `
        <div class="event-modal">
          <div class="event-modal-head"><button class="event-modal-back" type="button">← חזרה</button></div>
          <div class="event-modal-body"></div>
        </div>`;
      document.body.appendChild(overlay);
      const close = () => { overlay.classList.remove("open"); document.body.style.overflow = ""; };
      overlay.querySelector(".event-modal-back").addEventListener("click", close);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    }
    const body = overlay.querySelector(".event-modal-body");
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
    _lastModalEvId = String(eventId);
    const renderInto = (ev) => {
      if (!ev) { body.innerHTML = `<div class="card-description" style="padding:16px">האירוע לא נמצא.</div>`; return; }
      body.innerHTML = "";
      const card = buildCard(ev, { hideOccurrences: true });
      card.classList.add("open");
      body.appendChild(card);
    };
    // Card taps pass the already-loaded event → render instantly (no refetch).
    if (preloaded) { renderInto(preloaded); return; }
    body.innerHTML = `<div class="card-description" style="padding:16px">טוען…</div>`;
    try {
      const res = await fetch(`${API_PREFIX}/event?${new URLSearchParams({ initData: INIT_DATA, id: eventId })}`);
      renderInto((await res.json()).event);
    } catch (_) {
      body.innerHTML = `<div class="card-description" style="padding:16px">שגיאה בטעינה.</div>`;
    }
  };

  // ── "אל תראה לי" organized suppression sheet ──────────────────────
  // Shows the event's own attributes (tags / venue / audience) as toggle
  // chips; selected ones are written into the user's profile filters.
  const CHILD_AUD = new Set(["תינוקות", "ילדים", "נוער"]);
  window.openSuppressSheet = async function (eventId) {
    let ov = document.getElementById("suppressSheet");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "suppressSheet";
      ov.className = "ss-backdrop";
      ov.innerHTML = `
        <div class="ss-sheet">
          <div class="ss-head">
            <span class="ss-title">לא להציג יותר</span>
            <button class="ss-close" aria-label="סגירה">✕</button>
          </div>
          <div class="ss-intro">מה גרם לזה לא להתאים? נסנן את זה גם בעתיד 🎯</div>
          <div class="ss-body"></div>
          <div class="ss-foot">
            <button class="ss-apply btn btn-primary btn-block">החל סינון</button>
            <button class="ss-report">משהו שגוי באירוע? דווחו לנו</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const close = () => { ov.classList.remove("open"); document.body.style.overflow = ""; };
      ov.querySelector(".ss-close").addEventListener("click", close);
      ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
      ov.querySelector(".ss-body").addEventListener("click", (e) => {
        const chip = e.target.closest(".ss-chip");
        if (chip) chip.classList.toggle("sel");
      });
    }
    const close = () => { ov.classList.remove("open"); document.body.style.overflow = ""; };
    const body = ov.querySelector(".ss-body");
    body.innerHTML = `<div class="ss-loading">טוען…</div>`;
    ov.classList.add("open");
    document.body.style.overflow = "hidden";

    let ev;
    try { ev = (await (await fetch(`${API_PREFIX}/event?${new URLSearchParams({ initData: INIT_DATA, id: eventId })}`)).json()).event; }
    catch (_) { ev = null; }
    if (!ev) { body.innerHTML = `<div class="ss-loading">שגיאה בטעינה.</div>`; return; }

    const groups = [];
    const tags = (ev.tags || []).slice(0, 8);
    if (tags.length) {
      groups.push(`<div class="ss-group"><div class="ss-glabel">לפי נושא</div><div class="ss-chips">${
        tags.map((t) => `<button class="ss-chip" data-kind="tag" data-val="${esc(t)}">🏷️ ${esc(t)}</button>`).join("")
      }</div></div>`);
    }
    if (ev.location && !isCityWide(ev.location)) {
      groups.push(`<div class="ss-group"><div class="ss-glabel">לפי מקום</div><div class="ss-chips">
        <button class="ss-chip" data-kind="place">📍 ${esc(ev.location)}</button></div></div>`);
    }
    if (ev.audience && CHILD_AUD.has(ev.audience)) {
      groups.push(`<div class="ss-group"><div class="ss-glabel">לפי קהל</div><div class="ss-chips">
        <button class="ss-chip" data-kind="childaud">👶 אירועי ${esc(ev.audience)}</button></div></div>`);
    }
    // Travel-time opt-out — when we know the drive time, offer to cap the
    // profile's max drive distance just under this event's (e.g. 12 → 11 דק').
    const cachedEv = eventsById.get(eventId) || eventsById.get(Number(eventId)) || {};
    const driveMin = Number(cachedEv.driveMinutes);
    if (Number.isFinite(driveMin) && driveMin > 1) {
      groups.push(`<div class="ss-group"><div class="ss-glabel">לפי זמן נסיעה</div><div class="ss-chips">
        <button class="ss-chip" data-kind="toofar" data-min="${driveMin}">🚗 רחוק מדי (${driveMin} דק' נסיעה)</button></div></div>`);
    }
    groups.push(`<div class="ss-group"><div class="ss-chips">
      <button class="ss-chip ss-chip-wide" data-kind="this">🙈 רק את האירוע הזה</button></div></div>`);
    body.innerHTML = groups.join("");

    ov.querySelector(".ss-report").onclick = () => { close(); window.openReportSheet(eventId); };
    ov.querySelector(".ss-apply").onclick = async () => {
      const sel = [...body.querySelectorAll(".ss-chip.sel")];
      const applyBtn = ov.querySelector(".ss-apply");
      applyBtn.disabled = true; applyBtn.textContent = "מחיל…";
      const tagsToHide = sel.filter((c) => c.dataset.kind === "tag").map((c) => c.dataset.val);
      const patch = {};
      if (tagsToHide.length) patch.add_suppressed_labels = tagsToHide;
      if (sel.some((c) => c.dataset.kind === "childaud")) patch.suppress_child_audiences = true;
      // "Too far" → cap max drive minutes just under this event's drive time
      // (and turn on drive mode so the cap actually engages).
      const tooFar = sel.find((c) => c.dataset.kind === "toofar");
      if (tooFar) {
        const x = parseInt(tooFar.dataset.min, 10);
        if (Number.isFinite(x) && x > 1) {
          patch.constraints = { location_modes: ["walk", "drive"], max_drive_minutes: x - 1 };
        }
      }
      const jobs = [];
      if (Object.keys(patch).length) {
        jobs.push(fetch(`${API_PREFIX}/profile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: INIT_DATA, patch }) }));
      }
      if (sel.some((c) => c.dataset.kind === "place")) {
        jobs.push(fetch(`${API_PREFIX}/exclude-place`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: INIT_DATA, eventId }) }));
      }
      // Always log a hide for this event (covers "just this one" + any choice).
      jobs.push(fetch(`${API_PREFIX}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: INIT_DATA, eventId, reason: "not_interested" }) }));
      try { await Promise.allSettled(jobs); } catch (_) {}
      tg?.HapticFeedback?.notificationOccurred?.("success");
      close();
      fadeOutCard(eventId);
      applyBtn.disabled = false; applyBtn.textContent = "החל סינון";
      // Refresh so the new filters take effect across the list.
      setTimeout(() => loadEvents(), 400);
    };
  };

  // Expand a single occurrence inline (dropdown) as a full event card.
  // The card is built WITHOUT its own "מופעים נוספים" button (no loop).
  window.toggleOccurrence = async function (rowEl, eventId) {
    const box = rowEl.parentElement.querySelector(".occ-detail");
    if (!box) return;
    rowEl.classList.toggle("expanded");
    if (box.dataset.loaded === "1") { box.hidden = !box.hidden; return; }
    box.hidden = false;
    box.innerHTML = `<div class="card-description" style="padding:10px">טוען…</div>`;
    try {
      const res = await fetch(`${API_PREFIX}/event?${new URLSearchParams({ initData: INIT_DATA, id: eventId })}`);
      const ev = (await res.json()).event;
      box.innerHTML = "";
      if (!ev) { box.innerHTML = `<div class="card-description" style="padding:10px">האירוע לא נמצא.</div>`; return; }
      const card = buildCard(ev, { hideOccurrences: true });
      card.classList.add("open");                    // detail expanded
      box.appendChild(card);
      box.dataset.loaded = "1";
    } catch (_) {
      box.innerHTML = `<div class="card-description" style="padding:10px">שגיאה בטעינה.</div>`;
    }
  };

  // Light inline ticket text for the compact series rows (not a big pill).
  function seriesTicketText(t) {
    if (t == null) return "";
    if (t <= 0) return `<span class="sr-tk sold">אזל</span>`;
    if (t <= 9) return `<span class="sr-tk low">🔥 ${t} אחרונים</span>`;
    return `<span class="sr-tk ok">🎟️ ${t} כרטיסים</span>`;
  }

  // 📅 "עוד X מהסדרה" → a compact date list. Each row opens that date as a
  // popup (no nested inline expansion).
  window.showSeries = async function (btn, eventId) {
    const box = btn.closest(".card-detail")?.querySelector(".occ-list");
    if (!box) return;
    if (box.dataset.loaded === "1") { box.hidden = !box.hidden; return; }
    btn.disabled = true;
    try {
      const res = await fetch(`${API_PREFIX}/occurrences?${new URLSearchParams({ initData: INIT_DATA, id: eventId })}`);
      const list = (await res.json()).occurrences || [];
      // Show titles only when the items are DIFFERENT events (umbrella program);
      // for a same-name series the title is redundant → keep rows minimal.
      const varied = new Set(list.map((o) => o.name)).size > 1;
      // Show the venue per row only when occurrences span DIFFERENT places.
      const variedLoc = new Set(list.map((o) => o.location || "")).size > 1;
      if (!list.length) { box.innerHTML = `<div class="occ-empty">אין עוד מופעים.</div>`; }
      else {
        box.innerHTML = list.map((o) => {
          const when = [o.dateHe, o.timeHe].filter(Boolean).join(" · ");
          const tk = seriesTicketText(o.ticketsLeft);
          const meta = [];
          let top;
          if (varied) { // umbrella program — the event name is primary
            top = `<span class="sr-title">${esc(o.icon || "📌")} ${esc(o.name || "")}</span>`;
            meta.push(`🗓️ ${esc(when)}`);
          } else {       // same-name series — the date is primary
            top = `<span class="sr-when">🗓️ ${esc(when)}</span>`;
          }
          if (tk) meta.push(tk);
          if (variedLoc && o.location) meta.push(`📍 ${esc(o.location)}`);
          // For-me occurrences get a bold accent FRAME (replaces the ✨ dot).
          return `<button class="series-row${o.forMe ? " forme" : ""}" onclick="window.openEventModal(${o.id})"${o.forMe ? ' title="בשבילך"' : ""}>
            <span class="sr-body">
              <span class="sr-top">${top}</span>
              ${meta.length ? `<span class="sr-meta">${meta.join(" · ")}</span>` : ""}
            </span>
            <span class="sr-go">›</span>
          </button>`;
        }).join("");
      }
      box.dataset.loaded = "1";
      box.hidden = false;
    } catch (_) {
      box.innerHTML = `<div class="occ-empty">שגיאה בטעינת התאריכים.</div>`;
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

    // Group events that share a location (rounded coords) so overlapping
    // markers don't hide each other — one marker per spot, its popup lists
    // ALL events there (scrollable).
    const groups = new Map();
    for (const ev of withCoords) {
      const key = `${(+ev._lat).toFixed(5)},${(+ev._lng).toFixed(5)}`;
      if (!groups.has(key)) groups.set(key, { lat: ev._lat, lng: ev._lng, list: [] });
      groups.get(key).list.push(ev);
    }

    const bounds = [];
    for (const g of groups.values()) {
      const n = g.list.length;
      const top = g.list[0];
      // Multiple events at one spot → a distinct "multiple" glyph (not one
      // event's icon) + a count badge.
      const pinGlyph = n > 1 ? "🗂️" : (top.icon || "📌");
      const icon = L.divIcon({
        className: "",
        html: `<div class="map-pin${n > 1 ? " map-pin-multi" : ""}">${esc(pinGlyph)}${n > 1 ? `<span class="map-pin-badge">${n}</span>` : ""}</div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 40],
        popupAnchor: [0, -42],
      });
      const marker = L.marker([g.lat, g.lng], { icon }).addTo(leafletMap);
      const rows = g.list.map((ev) => {
        const nav = navUrlFor(ev);
        return `
        <div class="map-popup-ev map-popup-ev-clickable" onclick="window.openEventModal(${ev.id})">
          <div class="map-popup-title">${esc(ev.icon || "📌")} ${esc(ev.name)}</div>
          <div class="map-popup-meta">📅 ${esc(ev.dateHe || ev.date)}${ev.timeHe ? " · " + esc(ev.timeHe) : ""}${ev.distanceLabel ? " · " + esc(ev.distanceLabel) : ""}</div>
          ${nav ? `<a class="map-popup-nav" href="${esc(nav)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🧭 ניווט</a>` : ""}
        </div>`;
      }).join("");
      const head = n > 1
        ? `<div class="map-popup-head">${n} אירועים${top.location ? " · 📍 " + esc(top.location) : ""}</div>`
        : (top.location ? `<div class="map-popup-head">📍 ${esc(top.location)}</div>` : "");
      marker.bindPopup(`<div class="map-popup${n > 1 ? " multi" : ""}">${head}${rows}</div>`);
      bounds.push([g.lat, g.lng]);
    }
    // "My location" — a distinct home marker so the user sees where events
    // sit relative to home. Added to the bounds so it stays in view.
    if (userHome && userHome.lat != null && userHome.lng != null) {
      const homeIcon = L.divIcon({
        className: "",
        html: `<div class="map-pin map-pin-home">🏠</div>`,
        iconSize: [40, 40], iconAnchor: [20, 40], popupAnchor: [0, -42],
      });
      L.marker([userHome.lat, userHome.lng], { icon: homeIcon })
        .addTo(leafletMap)
        .bindPopup(`<div class="map-popup"><div class="map-popup-head">🏠 הבית שלי${userHome.address ? " · " + esc(userHome.address) : ""}</div></div>`);
      bounds.push([userHome.lat, userHome.lng]);
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
    syncScopeChips();
    loadEvents();
  });
  // Floating בשבילי/כולל switch — toggles profile scope and reloads.
  document.getElementById("forMeToggle")?.addEventListener("click", () => {
    serverSearch.ignore_profile = !serverSearch.ignore_profile; // off = כולל
    syncScopeChips();
    loadEvents();
    tg?.HapticFeedback?.impactOccurred("light");
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
  // "נקה הכל" — reset every filter; keep the sheet open so the user sees
  // the cleared state (results refresh underneath).
  document.getElementById("filterSheetClear")?.addEventListener("click", () => {
    resetAllFilters();
    tg?.HapticFeedback?.impactOccurred("light");
  });

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
  // Online / virtual event → show a camera, never a map pin or navigation.
  function isOnline(ev) {
    if (ev && ev.onlineUrl) return true;
    return /\bzoom\b|\bonline\b|webinar|זום|אונליין|מקוון|וובינר/i.test(`${ev?.name || ""} ${ev?.location || ""}`);
  }

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
    if (cardGrid && cardGrid.querySelector(".skel-card")) cardGrid.innerHTML = "";
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
  const _search = window.location.search;       // "?…" or ""
  const _hash = window.location.hash;            // "#…" or ""
  // Which event was requested? From ?ev=<id> (query) or start_param "ev_<id>".
  function requestedEventId() {
    const fromQuery = new URLSearchParams(window.location.search).get("ev");
    if (fromQuery) return fromQuery;
    const m = /^ev[_-]?(.+)$/.exec(startParam() || "");
    return m ? m[1] : null;
  }
  if (_sp === "profile") {
    // Opened via t.me/<bot>?startapp=profile. start_param stays "profile" for
    // the whole session, so redirect ONLY on the first load — otherwise tapping
    // "← אירועים" back from the profile lands on the catalog, which would see
    // start_param=profile and bounce straight back → an endless ping-pong.
    let done = false;
    try { done = !!sessionStorage.getItem("dl_profile_done"); } catch (_) {}
    if (done) {
      loadEvents(); // returned from the profile — stay on the catalog
    } else {
      try { sessionStorage.setItem("dl_profile_done", "1"); } catch (_) {}
      location.replace("profile.html" + _search + _hash);
    }
  } else {
    // Catalog. If an event was requested, open it as an in-app modal OVER the
    // catalog (single, reusable "← חזרה" popup) — NOT a separate window. A new
    // event just swaps the same popup.
    loadEvents();
    const _evId = requestedEventId();
    if (_evId) window.openEventModal(_evId);
    // Telegram reuses the open Mini App when a new event deep-link is tapped;
    // on foreground, re-read and swap the popup — but only when the id actually
    // changed, so we never reopen a modal the user just closed.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      const id = requestedEventId();
      if (id && String(id) !== String(_lastModalEvId)) window.openEventModal(id);
    });
  }
})();
