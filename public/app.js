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
  let searchTokens = []; // [{type:'name'|'tag'|'place', value}] — chosen autocomplete picks
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
    tags: [],
    communities: [],
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
    // NB: interest tags are filtered CLIENT-side (see applyFilters) against the
    // event's own tags — exact & predictable, unlike the server's fuzzy
    // name→label resolution. So we do NOT send `tags` to the server.
    if (serverSearch.keywords.length) p.set("keywords", serverSearch.keywords.join(","));
    if (serverSearch.proximity) p.set("proximity", "walk");
    if (serverSearch.available_only) p.set("available_only", "1");
    if (serverSearch.unseen_only) p.set("unseen_only", "1");
    if (serverSearch.ignore_profile) p.set("ignore_profile", "1");
    if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }

  // Cache BOTH scopes (בשבילי / כללי) for the current filter set so toggling
  // is an instant in-memory swap — no refetch. Invalidated when filters change.
  let scopeCache = { sig: "", me: null, all: null };
  function filterSig() {
    return JSON.stringify({
      d: serverSearch.date_preset, a: serverSearch.audiences, t: serverSearch.activity_types,
      k: serverSearch.keywords, p: serverSearch.proximity,
      av: serverSearch.available_only, u: serverSearch.unseen_only,
    });
  }
  function applyBody(body) {
    buildTagChips(body.profile?.interests || []);
    buildCommunityChips(body.communities || []);
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
    // Restore scroll position when returning from the profile.
    if (_pendingScrollY != null) {
      const y = _pendingScrollY; _pendingScrollY = null;
      requestAnimationFrame(() => window.scrollTo({ top: y, behavior: "instant" }));
    }
  }
  // Fetch a specific scope (ignore_profile on/off) without disturbing state.
  async function fetchScope(ignoreProfile, extra) {
    const saved = serverSearch.ignore_profile;
    serverSearch.ignore_profile = ignoreProfile;
    const qs = buildSearchQuery(extra);
    serverSearch.ignore_profile = saved;
    const res = await fetch(`${API_PREFIX}/events?${qs}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `שגיאה ${res.status}`);
    return body;
  }

  // ── Persist catalog state across navigation to the profile and back ──
  const CATALOG_STATE_KEY = "catalogState_v1";
  let _pendingScrollY = null;
  function saveCatalogState() {
    try {
      sessionStorage.setItem(CATALOG_STATE_KEY, JSON.stringify({
        ss: serverSearch, activeDate, activeType, tokens: searchTokens, y: window.scrollY,
      }));
    } catch (_) {}
  }
  function setArr(target, src) { target.length = 0; (src || []).forEach((x) => target.push(x)); }
  function restoreCatalogState() {
    let st = null;
    try { st = JSON.parse(sessionStorage.getItem(CATALOG_STATE_KEY) || "null"); } catch (_) {}
    if (!st) return false;
    sessionStorage.removeItem(CATALOG_STATE_KEY);
    const r = st.ss || {};
    serverSearch.date_preset = r.date_preset || "upcoming";
    serverSearch.proximity = !!r.proximity;
    serverSearch.available_only = !!r.available_only;
    serverSearch.unseen_only = !!r.unseen_only;
    serverSearch.ignore_profile = !!r.ignore_profile;
    setArr(serverSearch.audiences, r.audiences);
    setArr(serverSearch.activity_types, r.activity_types);
    setArr(serverSearch.tags, r.tags);
    setArr(serverSearch.communities, r.communities);
    setArr(serverSearch.keywords, r.keywords);
    activeDate = st.activeDate || "all";
    activeType = st.activeType || "all";
    searchTokens = Array.isArray(st.tokens) ? st.tokens : [];
    _pendingScrollY = typeof st.y === "number" ? st.y : null;
    syncScopeChips();
    return true;
  }
  // Save when the page is hidden/navigated away (→ profile) and right before unload.
  window.addEventListener("pagehide", saveCatalogState);

  async function loadEvents(extra) {
    INIT_DATA = await ensureInitData();
    if (!INIT_DATA) {
      showError(catalogAuthErrorMessage());
      return;
    }
    const sig = filterSig();
    if (scopeCache.sig !== sig) scopeCache = { sig, me: null, all: null };
    const scopeKey = serverSearch.ignore_profile ? "all" : "me";
    // Instant swap if we already have this scope for the current filters.
    if (!extra && scopeCache[scopeKey]) { applyBody(scopeCache[scopeKey]); return; }
    try {
      spinner.style.display = "none";
      showSkeletons();
      const body = await fetchScope(serverSearch.ignore_profile, extra);
      if (!extra) scopeCache[scopeKey] = body;
      applyBody(body);
      // Warm the OTHER scope in the background so the first toggle is instant.
      const otherKey = scopeKey === "me" ? "all" : "me";
      if (!extra && !scopeCache[otherKey]) {
        fetchScope(otherKey === "all", null)
          .then((b) => { if (scopeCache.sig === sig) scopeCache[otherKey] = b; })
          .catch(() => {});
      }
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
    if (!tagBar || !tagsSection) return;
    // Show the user's interest tags as a search filter. Exclude the audience
    // enum values (they have their own קהל-יעד filter) — keep genuine topics.
    const AUD = new Set(["תינוקות", "ילדים", "נוער", "מבוגרים", "לכל המשפחה", "הורים", "ותיקים"]);
    const tags = [...new Set((interests || []).map((s) => String(s).trim()).filter(Boolean))]
      .filter((t) => !AUD.has(t));
    tagBar.innerHTML = "";
    if (!tags.length) { tagsSection.style.display = "none"; return; }
    tags.forEach((t) => tagBar.appendChild(makeChip(t, t, serverSearch.tags.includes(t))));
    tagsSection.style.display = "";
  }
  // The user's member communities as a search filter. Selecting one narrows to
  // events restricted to that community (event.access includes the scope).
  const communityBar = document.getElementById("communityFilterBar");
  const communitiesSection = document.getElementById("communitiesSection");
  function buildCommunityChips(list) {
    if (!communityBar || !communitiesSection) return;
    communityBar.innerHTML = "";
    if (!list.length) { communitiesSection.style.display = "none"; return; }
    list.forEach((c) => {
      const b = makeChip(`${c.emoji || ""} ${c.label}`.trim(), c.scope, serverSearch.communities.includes(c.scope));
      b.dataset.comm = c.scope; // multiToggle uses data-comm
      communityBar.appendChild(b);
    });
    communitiesSection.style.display = "";
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
      // Interest-tag filter (search hub chips): event must carry at least one
      // of the selected tags. Client-side & exact so removing a pill restores
      // results immediately.
      if (serverSearch.tags.length) {
        const et = e.tags || [];
        if (!serverSearch.tags.some((t) => et.includes(t))) return false;
      }
      // Community filter: event must be restricted to a selected community.
      if (serverSearch.communities.length) {
        const ea = e.access || [];
        if (!serverSearch.communities.some((c) => ea.includes(c))) return false;
      }
      // Profile tag chip filter.
      if (activeTag && !(e.tags || []).includes(activeTag)) return false;
      // Tag drill-down.
      if (tagDrilldown && !(e.tags || []).includes(tagDrilldown)) return false;
      // Umbrella drill-down.
      if (umbrellaDrilldown && e.umbrella_slug !== umbrellaDrilldown.slug) return false;
      // Token-based search: each chosen suggestion narrows (AND). Plain typed
      // text does NOT filter on its own — only selected tokens do.
      if (searchTokens.length) {
        const ok = searchTokens.every((tok) => {
          if (tok.type === "tag") return (e.tags || []).includes(tok.value);
          if (tok.type === "place") return (e.location || "").includes(tok.value);
          if (tok.type === "program") return (e.umbrella_title || "").includes(tok.value);
          return (e.name || "").includes(tok.value); // name
        });
        if (!ok) return false;
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
  const DATE_LABELS = { today: "היום", tomorrow: "מחר", weekend: "סוף שבוע", week: "השבוע", nextweek: "שבוע הבא", "2weeks": "שבועיים", next30: "30 יום" };
  const TYPE_LABELS = { registration: "📋 מחייב הרשמה", free: "🎁 כניסה חופשית", online: "💻 אונליין", low_stock: "🎫 נשארו מעט כרטיסים" };

  function clearFilters() {
    activeDate = "all";
    activeType = "all";
    activeTag  = null;
    // Also clear the server-side search-hub filters.
    serverSearch.date_preset = "upcoming";
    serverSearch.audiences.length = 0;
    serverSearch.activity_types.length = 0;
    serverSearch.tags.length = 0;
    serverSearch.communities.length = 0;
    searchTokens.length = 0;
    serverSearch.keywords.length = 0;
    serverSearch.proximity = false;
    serverSearch.available_only = false;
    serverSearch.unseen_only = false;
    // Sync chip UI inside the filter sheet.
    dateBar.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.date === "all"));
    typeBar?.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.type === "all"));
    tagBar?.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    document.querySelectorAll("#audienceFilterBar .chip, #activityFilterBar .chip, #optionFilterBar .chip").forEach((c) => c.classList.remove("active"));
    document.querySelector('#audienceFilterBar .chip[data-aud="all"]')?.classList.add("active");
    const kw = document.getElementById("keywordInput");
    if (kw) kw.value = "";
    loadEvents(); // server filters changed → re-fetch
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
    serverSearch.tags.length = 0;
    serverSearch.communities.length = 0;
    searchTokens.length = 0;
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
    // Default audience = "הכל" (no filter).
    document.querySelector('#audienceFilterBar .chip[data-aud="all"]')?.classList.add("active");
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
        serverSearch.date_preset = "upcoming"; // date is a server filter → reset + refetch
        dateBar.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.date === "all"));
        loadEvents();
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

    // ── Server-side search-hub filters (audience / activity / interest tags /
    //    options / keyword). Each pill removes that one filter and reloads. ──
    function chipLabel(barId, attr, val) {
      const c = document.querySelector(`#${barId} .chip[data-${attr}="${CSS.escape(val)}"]`);
      return (c?.textContent || val).trim();
    }
    function deactivateChip(barId, attr, val) {
      document.querySelector(`#${barId} .chip[data-${attr}="${CSS.escape(val)}"]`)?.classList.remove("active");
    }
    const serverGroups = [
      { arr: serverSearch.audiences, bar: "audienceFilterBar", attr: "aud", reactivateAll: true },
      { arr: serverSearch.activity_types, bar: "activityFilterBar", attr: "act" },
    ];
    for (const g of serverGroups) {
      for (const val of [...g.arr]) {
        pills.push({ label: chipLabel(g.bar, g.attr, val), clear: () => {
          const i = g.arr.indexOf(val);
          if (i >= 0) g.arr.splice(i, 1);
          deactivateChip(g.bar, g.attr, val);
          if (g.reactivateAll && !g.arr.length) {
            document.querySelector('#audienceFilterBar .chip[data-aud="all"]')?.classList.add("active");
          }
          loadEvents();
        }});
      }
    }
    // Interest tags are filtered client-side → instant applyFilters(), no fetch.
    for (const val of [...serverSearch.tags]) {
      pills.push({ label: `🏷️ ${chipLabel("tagFilterBar", "tag", val)}`, clear: () => {
        const i = serverSearch.tags.indexOf(val);
        if (i >= 0) serverSearch.tags.splice(i, 1);
        deactivateChip("tagFilterBar", "tag", val);
        applyFilters();
      }});
    }
    // Chosen search tokens (autocomplete picks) — removable, client-side.
    const TYPE_ICO = { name: "🎫", program: "📋", tag: "🏷️", place: "📍" };
    for (const tok of [...searchTokens]) {
      pills.push({ label: `${TYPE_ICO[tok.type] || ""} ${tok.value}`.trim(), clear: () => {
        const i = searchTokens.findIndex((t) => t.type === tok.type && t.value === tok.value);
        if (i >= 0) searchTokens.splice(i, 1);
        applyFilters();
      }});
    }
    // Communities filtered client-side too.
    for (const val of [...serverSearch.communities]) {
      pills.push({ label: chipLabel("communityFilterBar", "comm", val), clear: () => {
        const i = serverSearch.communities.indexOf(val);
        if (i >= 0) serverSearch.communities.splice(i, 1);
        deactivateChip("communityFilterBar", "comm", val);
        applyFilters();
      }});
    }
    const optionPills = [
      { key: "proximity", label: "🚶 קרוב", opt: "proximity" },
      { key: "available_only", label: "🎫 עם כרטיסים", opt: "available_only" },
      { key: "unseen_only", label: "👀 שלא ראיתי", opt: "unseen_only" },
    ];
    for (const o of optionPills) {
      if (serverSearch[o.key]) {
        pills.push({ label: o.label, clear: () => {
          serverSearch[o.key] = false;
          document.querySelector(`#optionFilterBar .chip[data-opt="${o.opt}"]`)?.classList.remove("active");
          loadEvents();
        }});
      }
    }
    if (serverSearch.keywords.length) {
      pills.push({ label: `🔎 ${serverSearch.keywords.join(", ")}`, clear: () => {
        serverSearch.keywords.length = 0;
        const kw = document.getElementById("keywordInput");
        if (kw) kw.value = "";
        loadEvents();
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
    // Unified with the search box: tapping a tag adds it as a search TOKEN
    // (top filter pill) — same filtering path as picking it in autocomplete.
    if (!tag) return;
    if (!searchTokens.some((t) => t.type === "tag" && t.value === tag)) {
      searchTokens.push({ type: "tag", value: tag });
    }
    document.querySelectorAll(".event-card.open").forEach((c) => c.classList.remove("open"));
    applyFilters();
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "instant" }));
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
        // Drop the date preset so the explicit dateTo actually widens the window
        // (otherwise e.g. preset=today overrides it and nothing changes).
        serverSearch.date_preset = "";
        activeDate = "all";
        dateBar?.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.date === "all"));
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
    // For a named venue ("ספריית בית לזרוס, רחוב איינשטיין 16") show only the
    // short venue name (text before the first comma), dropping the street.
    const shortLoc = (s) => String(s || "").split(",")[0].trim();
    let locText = "";
    const isMultiVenueSeries = (ev.totalOccurrences || 1) > 1 && ev.seriesMultiVenue && !opts.hideOccurrences;
    if (isMultiVenueSeries) locText = "📍 מיקומים שונים";
    else if (isOnline(ev)) locText = "📷 אונליין";
    else if (ev.location && !isCityWide(ev.location)) locText = `📍 ${esc(shortLoc(ev.location))}`;
    else if (isCityWide(ev.location)) locText = "🗺️ ברחבי העיר";

    // ── Visual ticket status (overlay badge, not a body line) ──
    let statusBadge = "";
    let soldOut = false;
    // Series-aggregate display applies ONLY to the collapsed representative in
    // the list — NOT when viewing a single occurrence (opts.hideOccurrences).
    const isSeries = (ev.totalOccurrences || 1) > 1 && !opts.hideOccurrences;
    if (isSeries) {
      // Parent card: show "אזל" + dimmed image ONLY when EVERY occurrence is
      // sold out. Never a ticket count (misleading across occurrences). No
      // watch block (handled in buildDetail). Otherwise no status badge.
      if (ev.seriesAnyAvailable === false) { soldOut = true; statusBadge = `<span class="status-badge soldout">אזל</span>`; }
    } else {
      const t = ev.ticketsLeft;
      if (t != null) {
        if (t <= 0) { soldOut = true; statusBadge = `<span class="status-badge soldout">אזל</span>`; }
        else if (t <= 9) statusBadge = `<span class="status-badge low"><span class="pulse-dot"></span>${t} אחרונים</span>`;
        else statusBadge = `<span class="status-badge ok">🎟️ ${t} כרטיסים</span>`;
      }
    }

    const tagsHtml = (ev.tags || []).slice(0, 4)
      .map((tg) => `<button class="tag-pill" onclick="event.stopPropagation();window.drillTag('${esc(tg)}')">${esc(tg)}</button>`).join("");

    const audiencePill = ev.audienceLine
      ? `<span class="aud-pill">${esc(ev.audienceLine.replace(/^🎯\s*/, ""))}</span>` : "";

    // Own row, shown only when the event is narrowed to specific community/ies.
    const accessHtml = ev.accessLine
      ? `<div class="card-access">${esc(ev.accessLine)}</div>` : "";

    // Series parent under an umbrella: use the umbrella programme title as the
    // card title (the representative child's name is just one of many). The
    // separate umbrella button is then redundant → hide it.
    const useUmbrellaTitle = isSeries && !!ev.umbrella_title;
    const cardTitle = useUmbrellaTitle ? ev.umbrella_title : ev.name;
    const umbrellaHtml = (ev.umbrella_title && !useUmbrellaTitle)
      ? `<button class="card-umbrella" onclick="event.stopPropagation();window.filterUmbrella('${esc(ev.umbrella_slug)}','${esc(ev.umbrella_title)}')">📋 ${esc(ev.umbrella_title)}</button>`
      : "";

    // For a recurring series show a DATE RANGE ("1/7–8/9") instead of the
    // (misleading) single first-occurrence time. dm() = ISO yyyy-mm-dd → D/M.
    const dm = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ""); return m ? `${+m[3]}/${+m[2]}` : ""; };
    let whenPill;
    if ((ev.totalOccurrences || 1) > 1 && !opts.hideOccurrences && ev.seriesFirstDate) {
      const a = dm(ev.seriesFirstDate), b = dm(ev.seriesLastDate);
      const range = a && b && a !== b ? `${a}–${b}` : (a || b);
      whenPill = range ? `<span class="when-pill">📅 ⁦${range}⁩</span>` : "";
    } else {
      whenPill = ev.timeHe || ev.dateHe
        ? `<span class="when-pill">🕒 ${esc(ev.timeHe || ev.dateHe)}</span>` : "";
    }

    // ── Hero: image (or gradient fallback) with title overlaid ──
    // Umbrella parent → use the programme's own image, not the first child's.
    const heroImg = (useUmbrellaTitle && ev.umbrellaImage) ? ev.umbrellaImage : ev.image;
    const heroInner = heroImg
      ? `<img class="card-image" src="${esc(heroImg)}" alt="${esc(cardTitle)}" loading="lazy"
            onerror="this.closest('.card-hero').classList.add('no-img')" />`
      : `<span class="hero-emoji">${esc(ev.icon || "📌")}</span>`;

    const isInterested = interestedIds.has(ev.id);

    card.innerHTML = `
      <div class="card-hero${heroImg ? "" : " no-img"}${soldOut ? " soldout" : ""}">
        ${heroInner}
        <div class="hero-grad"></div>
        <div class="hero-top">
          <div class="hero-badges">${statusBadge}</div>
          ${whenPill}
        </div>
        <div class="hero-foot">
          <h3 class="card-title">${heroImg ? "" : `<span class="title-emoji">${esc(ev.icon || "📌")}</span> `}${esc(cardTitle)}</h3>
        </div>
      </div>
      <div class="card-body card-click">
        <div class="card-pillrow">
          ${audiencePill}
          ${ev.accessLine ? `<span class="access-pill">${esc(ev.accessLine.replace(/^👥\s*קהל ייעודי:\s*/, ""))}</span>` : ""}
          ${(ev.totalOccurrences || 1) > 1 ? `<button class="series-pill" onclick="event.stopPropagation();window.openEventModal(${ev.id},null,{expandSeries:true})">🔁 ${ev.totalOccurrences} ${ev.umbrella_slug ? "בתוכנית" : "מופעים"}</button>` : ""}
          ${locText ? `<span class="loc-pill">${locText}</span>` : ""}
          ${ev.distanceLabel ? `<span class="dist-pill${ev.requiresCar ? " car" : ""}">${esc(ev.distanceLabel)}</span>` : ""}
        </div>
        ${umbrellaHtml}
        ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ""}
      </div>
      <div class="card-detail">
        ${buildDetail(ev, isInterested, opts)}
      </div>
    `;

    // Body tap → EXPAND the card inline (toggle .open), not a separate modal
    // window. (The modal is still used for map popups / deep links / series
    // navigation.) Hero: an image opens the lightbox (zoom); an image-less
    // gradient hero just toggles the card too.
    card.querySelector(".card-body")?.addEventListener("click", () => card.classList.toggle("open"));
    // Clicking the EXPANDED area collapses the card too — except interactive
    // controls (buttons/links/tags) and the description text itself (so reading
    // / using "קרא עוד" doesn't close it).
    card.querySelector(".card-detail")?.addEventListener("click", (e) => {
      // Any tap on the expanded area collapses the card (like tapping the
      // collapsed card) — except interactive controls (buttons/links/tags).
      if (e.target.closest("button, a, input, .tag-pill")) return;
      card.classList.remove("open");
    });
    const heroEl = card.querySelector(".card-hero");
    if (ev.image) {
      heroEl?.addEventListener("click", () => openLightbox(ev.image, ev.name));
    } else {
      heroEl?.addEventListener("click", () => card.classList.toggle("open"));
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
    // No "watch tickets" on a series parent — following one occurrence is
    // meaningless. Only on a single event/occurrence that's actually sold out.
    const isSeriesParent = (ev.totalOccurrences || 1) > 1 && !opts.hideOccurrences;
    const soldOut = !isSeriesParent && ev.ticketsLeft != null && ev.ticketsLeft <= 0;
    if (soldOut) {
      const watching = watchedIds.has(ev.id);
      parts.push(`<div class="watch-block">
        <div class="watch-q">🎫 אזל — רוצה שנעדכן אותך כשמתפנים כרטיסים? (זמינות מהאתר וגם כרטיסים יד שנייה)</div>
        <button class="btn btn-watch${watching ? " active" : ""}" onclick="event.stopPropagation();window.toggleWatch(this,${ev.id})">${watching ? "🔔 עוקבים — נעדכן אותך" : "🔔 כן, עדכנו אותי"}</button>
      </div>`);
    }

    // 2) Description — clamped to 3 lines, with a קרא עוד ↔ סגור toggle.
    // On a series parent whose occurrences have DIFFERENT descriptions, the
    // representative's blurb is misleading → omit it (each occurrence shows
    // its own inside).
    // Umbrella parent → prefer the programme's own description; else for a
    // multi-description series omit it (each occurrence shows its own inside).
    const parentDesc = (isSeriesParent && ev.umbrellaDescription) ? ev.umbrellaDescription : null;
    const descText = parentDesc || ev.description;
    const hideParentDesc = isSeriesParent && !parentDesc && ev.seriesMultiDesc;
    if (descText && !hideParentDesc) {
      const descHtml = linkifyPhones(esc(descText).replace(/\n/g, "<br>"));
      const isLong = descText.length > 140;
      parts.push(`<div class="desc-wrap">
        <div class="card-description${isLong ? " clamped" : ""}">${descHtml}</div>
        ${isLong ? `<button class="desc-readmore" onclick="event.stopPropagation();window.toggleDesc(this)">קרא עוד</button>` : ""}
      </div>`);
    }

    // 4) Related set → compact list; each row opens a popup. Works for both a
    //    same-name series AND an umbrella program (rows show titles when the
    //    items differ). Grouped by the same seriesKey the count uses.
    if (!opts.hideOccurrences && (ev.totalOccurrences || 1) > 1) {
      const word = ev.umbrella_slug ? "בתוכנית" : "מופעים";
      // Show ALL occurrences (the list includes the representative now).
      parts.push(`<button class="series-btn" onclick="window.showSeries(this,${ev.id})">🔁 כל ה־${ev.totalOccurrences} ${word} ▾</button>`);
      parts.push(`<div class="occ-list"></div>`);
    }

    // 5) Quiet "hide" entry → opens the suppression sheet. Shown for events
    //    that ARE for you (so you can refine your feed). NOT shown for
    //    non-matching events in כללי mode — those are already filtered out of
    //    בשבילי, so there's nothing to suppress.
    // Quiet actions row: hide (refine feed) + report (data-quality). Report is
    // shown for every event; hide only for matching ones.
    const quiet = [];
    if (ev.forMe !== false) {
      quiet.push(`<button class="hide-link" onclick="event.stopPropagation();window.openSuppressSheet(${ev.id})">🙈 אל תראה לי אירועים כאלה</button>`);
    }
    quiet.push(`<button class="report-link" onclick="event.stopPropagation();window.openReportSheet(${ev.id})">🚩 דיווח על בעיה</button>`);
    parts.push(`<div class="card-quiet-row">${quiet.join("")}</div>`);

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
    const expanding = desc.classList.contains("clamped");
    if (expanding) btn._scrollBefore = window.scrollY; // remember where we were
    const clamped = desc.classList.toggle("clamped");
    btn.textContent = clamped ? "קרא עוד" : "סגור";
    // Collapsing → return to the scroll position we had when we expanded.
    if (clamped && btn._scrollBefore != null) {
      requestAnimationFrame(() => window.scrollTo({ top: btn._scrollBefore, behavior: "instant" }));
    }
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
  // opts.hideOccurrences — suppress the "עוד N מהסדרה" button (used when the
  //   modal was opened from within a series list, to prevent an infinite loop).
  // opts.parentId — when set, "← חזרה" reopens the parent event instead of
  //   closing the modal (used for occurrence→series-representative navigation).
  window.openEventModal = async function (eventId, preloaded, opts = {}) {
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
      overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.classList.remove("open"); document.body.style.overflow = ""; } });
    }
    // Wire back button: if called with a parentId, navigate back to the parent;
    // otherwise close the modal. Replace the listener each open so it captures
    // the current opts (avoids stale closure from a previous call).
    const backBtn = overlay.querySelector(".event-modal-back");
    const newBack = backBtn.cloneNode(true); // removes old listener
    backBtn.replaceWith(newBack);
    // "חזרה" simply closes the floating modal — no reload/re-fetch of a parent
    // (which used to bounce back to the series representative with everything
    // collapsed). The user returns to exactly the list/card they came from.
    newBack.addEventListener("click", () => {
      overlay.classList.remove("open");
      document.body.style.overflow = "";
    });

    const body = overlay.querySelector(".event-modal-body");
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
    _lastModalEvId = String(eventId);
    const renderInto = (ev) => {
      if (!ev) { body.innerHTML = `<div class="card-description" style="padding:16px">האירוע לא נמצא.</div>`; return; }
      body.innerHTML = "";
      // Date header — identical to the sticky date-headers in the catalog list,
      // placed ABOVE the card (not inside it).
      if (ev.dateHe || ev.date) {
        const hdr = document.createElement("div");
        hdr.className = "date-header";
        hdr.style.position = "static";
        hdr.style.marginBottom = "12px";
        hdr.textContent = ev.dateHe || ev.date;
        body.appendChild(hdr);
      }
      const card = buildCard(ev, { hideOccurrences: !!opts.hideOccurrences });
      card.classList.add("open");
      body.appendChild(card);
      // Opened via the series pill → expand the occurrences immediately
      // (one tap to see the series, no extra "עוד N מהסדרה" click).
      if (opts.expandSeries) {
        const sb = card.querySelector(".series-btn");
        if (sb) window.showSeries(sb, ev.id);
      }
    };
    // Card taps pass the already-loaded event (with totalOccurrences) → render instantly.
    if (preloaded) { renderInto(preloaded); return; }
    body.innerHTML = `<div class="card-description" style="padding:16px">טוען…</div>`;
    try {
      // Deep-link opens the modal at load time, BEFORE loadEvents() has resolved
      // ensureInitData() — so INIT_DATA may still be "" here → ensure it first,
      // otherwise the /event fetch 401s and shows "לא נמצא".
      if (!INIT_DATA) INIT_DATA = await ensureInitData();
      // Opening a single occurrence (hideOccurrences) doesn't need the series
      // count → skip the slow server-side getAllEvents scan with noseries=1.
      const qp = { initData: INIT_DATA, id: eventId };
      if (opts.hideOccurrences) qp.noseries = "1";
      const res = await fetch(`${API_PREFIX}/event?${new URLSearchParams(qp)}`);
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
            <a class="ss-profile" href="profile.html">⚙️ לכוונון מלא בפרופיל</a>
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
    // Prefer the already-loaded event (tags/location/audience are all we need) —
    // avoids a slow /event round-trip that recomputes the whole series size.
    const cached = eventsById.get(eventId) || eventsById.get(Number(eventId));
    ov.classList.add("open");
    document.body.style.overflow = "hidden";

    let ev = cached || null;
    if (!ev) {
      try { ev = (await (await fetch(`${API_PREFIX}/event?${new URLSearchParams({ initData: INIT_DATA, id: eventId })}`)).json()).event; }
      catch (_) { ev = null; }
    }
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
    // Any of the 7 audience_t values (same set as profile/search) is suppressible.
    const AUD_EMOJI = { "תינוקות": "👶", "ילדים": "🧒", "נוער": "🎒", "מבוגרים": "🧑", "לכל המשפחה": "👨‍👩‍👧", "הורים": "🤱", "ותיקים": "🌷" };
    if (ev.audience && AUD_EMOJI[ev.audience]) {
      groups.push(`<div class="ss-group"><div class="ss-glabel">לפי קהל</div><div class="ss-chips">
        <button class="ss-chip" data-kind="audience" data-val="${esc(ev.audience)}">${AUD_EMOJI[ev.audience]} ${esc(ev.audience)}</button></div></div>`);
    }
    // Travel-time opt-out — when we know the drive time, offer to cap the
    // profile's max drive distance just under this event's (e.g. 12 → 11 דק').
    const cachedEv = eventsById.get(eventId) || eventsById.get(Number(eventId)) || {};
    const driveMin = Number(cachedEv.driveMinutes);
    if (Number.isFinite(driveMin) && driveMin > 1) {
      groups.push(`<div class="ss-group"><div class="ss-glabel">לפי זמן נסיעה</div><div class="ss-chips">
        <button class="ss-chip" data-kind="toofar" data-min="${driveMin}">🚗 רחוק מדי (${driveMin} דק' נסיעה)</button></div></div>`);
    }
    body.innerHTML = groups.join("");

    const ssReport = ov.querySelector(".ss-report");
    if (ssReport) ssReport.onclick = () => { close(); window.openReportSheet(eventId); };
    ov.querySelector(".ss-apply").onclick = async () => {
      const sel = [...body.querySelectorAll(".ss-chip.sel")];
      const applyBtn = ov.querySelector(".ss-apply");
      applyBtn.disabled = true; applyBtn.textContent = "מחיל…";
      const tagsToHide = sel.filter((c) => c.dataset.kind === "tag").map((c) => c.dataset.val);
      const patch = {};
      if (tagsToHide.length) patch.add_suppressed_labels = tagsToHide;
      const audChip = sel.find((c) => c.dataset.kind === "audience");
      if (audChip) patch.remove_audience = audChip.dataset.val;
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
      try {
        await Promise.allSettled(jobs);
      } finally {
        // Always restore the button, even if close()/fade throws — otherwise it
        // sticks on "מחיל…".
        applyBtn.disabled = false; applyBtn.textContent = "החל סינון";
      }
      tg?.HapticFeedback?.notificationOccurred?.("success");
      close();
      fadeOutCard(eventId);
      // Refresh so the new filters take effect across the list. Suppress
      // changed the profile → invalidate the scope cache so it refetches.
      scopeCache = { sig: "", me: null, all: null };
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
    if (t <= 0) return `<span class="sr-tk sold">🎫 אזל</span>`;
    if (t <= 9) return `<span class="sr-tk low">🔥 ${t} אחרונים</span>`;
    return `<span class="sr-tk ok">🎫 ${t} כרטיסים</span>`;
  }

  // 📅 "עוד X מהסדרה" → a compact date list. Each row opens that date as a
  // popup (no nested inline expansion).
  window.showSeries = async function (btn, eventId) {
    const box = btn.closest(".card-detail")?.querySelector(".occ-list");
    if (!box) return;
    if (box.dataset.loaded === "1") { box.hidden = !box.hidden; return; }
    btn.disabled = true;
    // Show a spinner until the occurrences arrive.
    box.hidden = false;
    box.innerHTML = `<div class="occ-loading"><span class="occ-spinner"></span></div>`;
    try {
      const res = await fetch(`${API_PREFIX}/occurrences?${new URLSearchParams({ initData: INIT_DATA, id: eventId })}`);
      const list = (await res.json()).occurrences || [];
      // Show titles only when the items are DIFFERENT events (umbrella program);
      // for a same-name series the title is redundant → keep rows minimal.
      const varied = new Set(list.map((o) => o.name)).size > 1;
      // Show the venue per row only when occurrences span DIFFERENT places.
      const variedLoc = new Set(list.map((o) => o.location || "")).size > 1;
      // Show a short description per row only when the children's descriptions
      // actually DIFFER (an umbrella of distinct events) — for a same-name
      // series the description is identical, so it'd be noise.
      const variedDesc = new Set(list.map((o) => (o.description || "").trim())).size > 1;
      if (!list.length) { box.innerHTML = `<div class="occ-empty">אין עוד מופעים.</div>`; }
      else {
        // Group occurrences under a shared date header (like the main list) so
        // the date is pulled OUT of every individual row.
        let html = "", lastDate = null;
        for (const o of list) {
          if ((o.dateHe || "") !== lastDate) {
            lastDate = o.dateHe || "";
            html += `<div class="occ-date-header">🗓️ ${esc(lastDate)}</div>`;
          }
          const rawTime = (o.timeHe || "").trim();
          const lines = [];
          let top;
          if (varied) { // umbrella program — the event name is primary
            top = `<span class="sr-title">${esc(o.icon || "📌")} ${esc(o.name || "")}</span>`;
            if (rawTime) lines.push(`<span class="sr-nowrap">🕒 ${esc(rawTime)}</span>`);
          } else {       // same-name series — the time (date is in the header)
            top = rawTime
              ? `<span class="sr-when">🕒 ${esc(rawTime)}</span>`
              : `<span class="sr-when">${esc(o.dateHe || "")}</span>`;
          }
          const tk = seriesTicketText(o.ticketsLeft);
          if (tk) lines.push(tk);
          if (variedLoc && o.location) lines.push(`📍 ${esc(o.location)}`);
          const metaHtml = lines.length
            ? `<span class="sr-meta">${lines.map((l) => `<span class="sr-line">${l}</span>`).join("")}</span>` : "";
          const descHtml = (variedDesc && o.description)
            ? `<span class="sr-desc">${esc(o.description)}</span>` : "";
          html += `<button class="series-row${o.forMe ? " forme" : ""}" onclick="window.openEventModal(${o.id},null,{hideOccurrences:true,parentId:${eventId}})"${o.forMe ? ' title="בשבילך"' : ""}>
            <span class="sr-body">
              <span class="sr-top">${top}</span>
              ${metaHtml}
              ${descHtml}
            </span>
            <span class="sr-go">›</span>
          </button>`;
        }
        box.innerHTML = html;
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
          <div class="map-popup-meta">📅 ${esc(ev.dateHe || ev.date)}${ev.timeHe ? " · " + esc(ev.timeHe) : ""}${ev.distanceLabel ? " · " + esc(ev.distanceLabel) : ""}${(ev.totalOccurrences || 1) > 1 ? ` · 🔁 ${ev.totalOccurrences} ${ev.umbrella_slug ? "בתוכנית" : "מופעים"}` : ""}</div>
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
    // Sort is meaningful only for the list — hide its button on the map.
    if (sortToggleBtn) sortToggleBtn.style.display = view === "map" ? "none" : "";
    // Float the active-filters bar above the fullscreen map so filters stay visible.
    document.getElementById("activeFiltersBar")?.classList.toggle("over-map", view === "map");
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
    // Range chips (next week / two weeks / 30 days) use an EXPLICIT date window
    // rather than a server preset → clear the preset so dateTo/dateFrom apply.
    const isoOffset = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
    const RANGES = {
      nextweek: [isoOffset(7), isoOffset(14)],
      "2weeks": [isoOffset(0), isoOffset(14)],
      next30: [isoOffset(0), isoOffset(30)],
    };
    if (RANGES[chip.dataset.date]) {
      const [from, to] = RANGES[chip.dataset.date];
      serverSearch.date_preset = "";
      loadEvents({ dateFrom: from, dateTo: to });
    } else {
      serverSearch.date_preset = DATE_PRESET_MAP[chip.dataset.date] || "upcoming";
      loadEvents();
    }
  });

  // ── New search-hub chips (audience / activity / options / scope) ──────
  function multiToggle(barId, dataAttr, arr) {
    const bar = document.getElementById(barId);
    bar?.addEventListener("click", (e) => {
      const chip = e.target.closest(`.chip[data-${dataAttr}]`);
      if (!chip) return;
      const val = chip.dataset[dataAttr];
      if (val === "all") {
        // "הכל" = no audience filter. Clear every selection.
        arr.length = 0;
        bar.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        return;
      }
      const i = arr.indexOf(val);
      if (i >= 0) { arr.splice(i, 1); chip.classList.remove("active"); }
      else { arr.push(val); chip.classList.add("active"); }
      // Picking a specific value clears "הכל"; "הכל" re-activates when empty.
      const allChip = bar.querySelector(`.chip[data-${dataAttr}="all"]`);
      if (allChip) allChip.classList.toggle("active", arr.length === 0);
    });
  }
  multiToggle("audienceFilterBar", "aud", serverSearch.audiences);
  multiToggle("activityFilterBar", "act", serverSearch.activity_types);
  multiToggle("tagFilterBar", "tag", serverSearch.tags); // interest-tag filter (chips built per profile)
  multiToggle("communityFilterBar", "comm", serverSearch.communities); // my-communities filter
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

  // ── Autocomplete search (token-based) ─────────────────────────────────
  // Typing shows suggestions drawn ONLY from our loaded events — event names,
  // tags, and venues. Picking one adds a removable token; plain text never
  // filters on its own.
  const searchSuggest = document.getElementById("searchSuggest");
  const searchClear = document.getElementById("searchClear");
  const TYPE_ICON = { name: "🎫", program: "📋", tag: "🏷️", place: "📍" };
  const TYPE_LABEL = { name: "אירוע", program: "תוכנית", tag: "תגית", place: "מיקום" };

  function buildSuggestions(q) {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const seen = new Set();      // dedupe by type+value
    const out = [];
    const add = (type, value) => {
      if (!value) return;
      const key = type + "|" + value;
      if (seen.has(key)) return;
      if (!value.toLowerCase().includes(needle)) return;
      // already an active token? skip.
      if (searchTokens.some((t) => t.type === type && t.value === value)) return;
      seen.add(key);
      out.push({ type, value });
    };
    for (const e of allEvents) {
      add("name", e.name);
      add("program", e.umbrella_title); // parent/umbrella programme title (e.g. "קיץ של בלונים")
      (e.tags || []).forEach((t) => add("tag", t));
      if (e.location && !isCityWide(e.location)) add("place", e.location);
    }
    // tags + places first (they group many events), then names; cap the list.
    out.sort((a, b) => (a.type === "name") - (b.type === "name"));
    return out.slice(0, 12);
  }
  function renderSuggestions(list) {
    if (!list.length) { searchSuggest.hidden = true; searchSuggest.innerHTML = ""; return; }
    searchSuggest.innerHTML = list.map((s, i) =>
      `<button class="suggest-item" data-i="${i}"><span class="suggest-ico">${TYPE_ICON[s.type]}</span><span class="suggest-val">${esc(s.value)}</span><span class="suggest-type">${TYPE_LABEL[s.type]}</span></button>`
    ).join("");
    searchSuggest._list = list;
    searchSuggest.hidden = false;
  }
  function addToken(tok) {
    searchTokens.push(tok);
    searchInput.value = "";
    searchSuggest.hidden = true;
    searchClear.hidden = true;
    searchInput.blur(); // dismiss the keyboard on selection
    applyFilters();
  }
  let st = null;
  searchInput.addEventListener("input", () => {
    searchClear.hidden = !searchInput.value;
    clearTimeout(st);
    st = setTimeout(() => renderSuggestions(buildSuggestions(searchInput.value)), 150);
  });
  searchSuggest.addEventListener("click", (e) => {
    const btn = e.target.closest(".suggest-item");
    if (!btn) return;
    const tok = searchSuggest._list?.[parseInt(btn.dataset.i, 10)];
    if (tok) addToken(tok);
  });
  // Enter dismisses the keyboard; if there's exactly one suggestion, pick it.
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const list = searchSuggest._list || [];
      if (!searchSuggest.hidden && list.length === 1) addToken(list[0]);
      else searchInput.blur();
    }
  });
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    searchClear.hidden = true;
    searchSuggest.hidden = true;
    searchInput.focus();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) searchSuggest.hidden = true;
  });
  document.getElementById("keywordInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
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
    restoreCatalogState(); // returning from profile → restore filters + scroll
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
