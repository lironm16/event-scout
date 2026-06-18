/* Profile editor Mini App — profile.js */
(function () {
  "use strict";

  const API_PREFIX = "/miniapp";
  const tg = window.Telegram?.WebApp || null;
  let INIT_DATA = "";
  let STATE = null; // working copy of payload.profile
  let OPTIONS = null;
  let removedLabels = [];
  let removedSeries = [];
  let removedLocations = [];
  let pristinePayload = null; // deep clone of the last-loaded payload (for cancel)
  let baselineSig = "";       // signature of the pristine savable state (for dirty)

  // ── init data (same bootstrap as the catalog app) ─────────────────
  function parseInitDataFromLocation() {
    for (const raw of [location.hash.slice(1), location.search.slice(1)]) {
      if (!raw) continue;
      const data = new URLSearchParams(raw).get("tgWebAppData");
      if (data) return data;
    }
    return "";
  }
  function readInitData() {
    if (tg) {
      try { tg.ready(); tg.expand(); } catch (_) {}
      return tg.initData || parseInitDataFromLocation();
    }
    return parseInitDataFromLocation();
  }
  // Telegram's SDK may not have populated tg.initData on the very first
  // tick (especially right after a tunnel redirect). Poll briefly before
  // giving up, exactly like the catalog (ensureInitData).
  async function ensureInitData(maxWaitMs = 1500) {
    const deadline = Date.now() + maxWaitMs;
    do {
      const v = readInitData();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 60));
    } while (Date.now() < deadline);
    return readInitData();
  }

  // ── tiny DOM helpers ──────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function section(title) {
    const card = el("section", "pf-card");
    card.appendChild(el("h2", "pf-card-title", title));
    return card;
  }
  function chip(label, selected, onToggle) {
    const b = el("button", "pf-chip" + (selected ? " on" : ""), label);
    b.type = "button";
    b.addEventListener("click", () => {
      const now = !b.classList.contains("on");
      b.classList.toggle("on", now);
      onToggle(now);
    });
    return b;
  }
  function chipRow() { return el("div", "pf-chips"); }
  function field(labelText) {
    const wrap = el("div", "pf-field");
    wrap.appendChild(el("label", "pf-label", labelText));
    return wrap;
  }
  function toast(msg) {
    const t = document.getElementById("pf-toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ── single-select chip group ──────────────────────────────────────
  function singleSelect(parent, items, getId, getLabel, currentId, onPick) {
    const row = chipRow();
    const buttons = [];
    items.forEach((it) => {
      const id = getId(it);
      const b = el("button", "pf-chip" + (id === currentId ? " on" : ""), getLabel(it));
      b.type = "button";
      b.addEventListener("click", () => {
        const turningOff = b.classList.contains("on");
        buttons.forEach((x) => x.classList.remove("on"));
        if (!turningOff) b.classList.add("on");
        onPick(turningOff ? null : id);
      });
      buttons.push(b);
      row.appendChild(b);
    });
    parent.appendChild(row);
  }

  // ── helpers: kid gender labels + date (dd/mm/yyyy) + age ──────────
  const KID_GENDERS = [
    { id: "male", label: "בן" },
    { id: "female", label: "בת" },
  ];
  function toDisplayDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
  }
  function parseDisplayDate(s) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || "").trim());
    if (!m) return null;
    const [, dd, mm, yyyy] = m;
    const mo = +mm, d = +dd;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${yyyy}-${mm}-${dd}`;
  }
  function ageYears(iso) {
    if (!iso) return null;
    const b = new Date(iso);
    if (isNaN(b.getTime())) return null;
    const now = new Date();
    let a = now.getFullYear() - b.getFullYear();
    const md = now.getMonth() - b.getMonth();
    if (md < 0 || (md === 0 && now.getDate() < b.getDate())) a--;
    return a;
  }
  function ageMonths(iso) {
    if (!iso) return null;
    const b = new Date(iso);
    if (isNaN(b.getTime())) return null;
    const now = new Date();
    let m = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
    if (now.getDate() < b.getDate()) m -= 1;
    return m < 0 ? null : m;
  }
  // Age-implied default readiness level for a stage (mirrors lib/devStages).
  function defaultLevel(stage, months) {
    if (months == null || months < stage.fromM) return "na";
    if (months <= stage.toM) return "during";
    return "established";
  }

  // ── sections ──────────────────────────────────────────────────────
  function renderDetails(root) {
    const card = section("👤 פרטים");
    const nameF = field("שם");
    const input = el("input", "pf-input");
    input.type = "text";
    input.value = STATE.first_name || "";
    input.placeholder = "שם פרטי";
    input.addEventListener("input", () => { STATE.first_name = input.value; });
    nameF.appendChild(input);
    card.appendChild(nameF);

    const gF = field("מגדר");
    singleSelect(gF, OPTIONS.genders, (x) => x.id, (x) => x.label, STATE.gender,
      (id) => { STATE.gender = id; });
    card.appendChild(gF);
    root.appendChild(card);
  }

  function renderKids(root) {
    const card = section("👶 ילדים");
    const list = el("div", "pf-kids");
    function drawKid(kid, idx) {
      const k = el("div", "pf-kid" + (kid._open ? " open" : ""));
      const head = el("div", "pf-kid-head");
      const titleBtn = el("button", "pf-kid-toggle");
      titleBtn.type = "button";
      const headAge = ageYears(kid.birth_date);
      const summary =
        (kid.name && kid.name.trim()) ||
        (headAge != null ? `${headAge} שנים` : `ילד ${idx + 1}`);
      titleBtn.appendChild(el("span", "pf-kid-caret", kid._open ? "▾" : "▸"));
      titleBtn.appendChild(el("span", "pf-kid-n", summary));
      titleBtn.addEventListener("click", () => { kid._open = !kid._open; redrawKids(); });
      head.appendChild(titleBtn);
      const rm = el("button", "pf-remove", "🗑️ הסר");
      rm.type = "button";
      rm.addEventListener("click", () => { STATE.kids.splice(idx, 1); redrawKids(); });
      head.appendChild(rm);
      k.appendChild(head);

      if (!kid._open) { list.appendChild(k); return; }

      const nameI = el("input", "pf-input");
      nameI.type = "text"; nameI.placeholder = "שם (לא חובה)"; nameI.value = kid.name || "";
      nameI.addEventListener("input", () => { kid.name = nameI.value; });
      k.appendChild(nameI);

      const bF = field("תאריך לידה");
      bF.querySelector(".pf-label").appendChild(el("span", "pf-req", " *"));
      const bI = el("input", "pf-input");
      bI.type = "date"; bI.max = new Date().toISOString().slice(0, 10);
      bI.value = kid.birth_date || "";
      bI.addEventListener("change", () => {
        kid.birth_date = /^\d{4}-\d{2}-\d{2}$/.test(bI.value) ? bI.value : null;
        // Stages depend on age → re-render when the date is committed.
        redrawKids();
      });
      bF.appendChild(bI); k.appendChild(bF);

      const gF = field("מגדר");
      singleSelect(gF, KID_GENDERS, (x) => x.id, (x) => x.label, kid.gender,
        (id) => { kid.gender = id; });
      k.appendChild(gF);

      // Developmental readiness — per stage RELEVANT to the kid's age, a
      // 4-level selector (עדיין לא רלוונטי / לפני / בתהליך / מבוסס). Defaults to
      // the age-implied level; the parent overrides only when the kid differs.
      kid.dev_stages = (kid.dev_stages && typeof kid.dev_stages === "object") ? kid.dev_stages : {};
      const months = ageMonths(kid.birth_date);
      const levels = OPTIONS.devLevels || [];
      const M = 4; // months of margin (mirror lib/devStages.relevantStagesForAge)
      const relevant = (OPTIONS.devStages || []).filter(
        (s) => months == null || (months >= s.fromM - M && months <= s.toM + M),
      );
      if (relevant.length && levels.length) {
        const sF = field("שלבי התפתחות");
        // Compact table: one row per stage, the 4 levels as columns with a
        // single shared header row — far more readable than a pile of long
        // wrapping pills. Long level names are abbreviated in the header.
        const SHORT = { na: "לא רלוונטי", before: "לפני", during: "בתהליך", established: "מבוסס" };
        const table = el("div", "pf-devtable");
        // header: empty corner + level columns
        table.appendChild(el("div", "pf-devtable-corner"));
        levels.forEach((lv) => {
          const h = el("div", "pf-devtable-h", SHORT[lv.id] || lv.label);
          h.title = lv.label;
          table.appendChild(h);
        });
        // one row per relevant stage
        relevant.forEach((s) => {
          table.appendChild(el("div", "pf-devtable-stage", s.label));
          const cur = kid.dev_stages[s.id] || defaultLevel(s, months);
          const cells = [];
          levels.forEach((lv) => {
            const cell = el("button", "pf-devtable-cell" + (lv.id === cur ? " on" : ""));
            cell.type = "button";
            cell.setAttribute("aria-label", `${s.label}: ${lv.label}`);
            cell.title = lv.label;
            cell.addEventListener("click", () => {
              kid.dev_stages[s.id] = lv.id;
              cells.forEach((c) => c.el.classList.toggle("on", c.id === lv.id));
            });
            cells.push({ el: cell, id: lv.id });
            table.appendChild(cell);
          });
        });
        sF.appendChild(table);
        k.appendChild(sF);
      }
      list.appendChild(k);
    }
    function redrawKids() { list.innerHTML = ""; STATE.kids.forEach(drawKid); }
    redrawKids();
    card.appendChild(list);

    const add = el("button", "pf-add", "➕ הוסף ילד");
    add.type = "button";
    add.addEventListener("click", () => {
      STATE.kids.push({ name: "", birth_date: null, gender: null, stages: [], _open: true });
      redrawKids();
    });
    card.appendChild(add);
    root.appendChild(card);
  }

  function renderLocation(root) {
    const card = section("📍 מיקום ומרחק");
    const aF = field("כתובת הבית");
    const aWrap = el("div", "pf-autocomplete");
    const aI = el("input", "pf-input");
    aI.type = "text"; aI.placeholder = "רחוב, עיר"; aI.autocomplete = "off";
    aI.value = STATE.constraints.home_address || "";
    const sug = el("div", "pf-suggestions");
    let acTimer = null;
    aI.addEventListener("input", () => {
      STATE.constraints.home_address = aI.value;
      clearTimeout(acTimer);
      const q = aI.value.trim();
      if (q.length < 2) { sug.innerHTML = ""; sug.style.display = "none"; return; }
      acTimer = setTimeout(async () => {
        try {
          const res = await fetch(`${API_PREFIX}/places?${new URLSearchParams({ initData: INIT_DATA, q })}`);
          const list = (await res.json()).suggestions || [];
          sug.innerHTML = "";
          if (!list.length) { sug.style.display = "none"; return; }
          list.forEach((s) => {
            const item = el("button", "pf-suggest-item", s);
            item.type = "button";
            item.addEventListener("click", () => {
              aI.value = s; STATE.constraints.home_address = s;
              sug.innerHTML = ""; sug.style.display = "none";
            });
            sug.appendChild(item);
          });
          sug.style.display = "block";
        } catch (_) { sug.style.display = "none"; }
      }, 300);
    });
    aWrap.appendChild(aI); aWrap.appendChild(sug);
    aF.appendChild(aWrap); card.appendChild(aF);

    // Online events — checked = show them (default). Stored inverted as
    // suppress_online_events.
    const onWrap = el("label", "pf-toggle");
    const onCb = el("input");
    onCb.type = "checkbox";
    onCb.checked = !STATE.suppress_online_events;
    onCb.addEventListener("change", () => { STATE.suppress_online_events = !onCb.checked; });
    onWrap.appendChild(onCb);
    onWrap.appendChild(el("span", null, "אירועים אונליין"));
    card.appendChild(onWrap);

    const mF = field("העדפות מרחק לאירועים");
    const mRow = chipRow();
    const distWrap = el("div", "pf-dist");
    STATE.constraints.location_modes = STATE.constraints.location_modes || [];

    function minutesField(label, key, def, min = 5, max = 60) {
      if (STATE.constraints[key] == null) STATE.constraints[key] = def;
      const cur = STATE.constraints[key];
      const f = field(label);
      // A <select> renders as a native scroll-wheel picker on mobile and gives
      // every single minute (not coarse slider steps).
      const sel = el("select", "pf-input pf-select");
      const vals = [];
      for (let n = min; n <= max; n++) vals.push(n);
      if (cur != null && !vals.includes(cur)) { vals.push(cur); vals.sort((a, b) => a - b); }
      for (const n of vals) {
        const o = el("option", null, `${n} דק׳`);
        o.value = String(n);
        if (n === cur) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => { STATE.constraints[key] = parseInt(sel.value, 10); });
      f.appendChild(sel);
      return f;
    }
    function redrawDist() {
      distWrap.innerHTML = "";
      const modes = STATE.constraints.location_modes;
      if (modes.includes("walk")) {
        distWrap.appendChild(minutesField("מרחק הליכה מקסימלי", "max_walking_minutes", 15, 5, 120));
      }
      if (modes.includes("drive")) {
        distWrap.appendChild(minutesField("מרחק נסיעה מקסימלי", "max_drive_minutes", 10, 5, 120));
      }
    }

    OPTIONS.locationModes.forEach((m) => {
      mRow.appendChild(chip(m.label, STATE.constraints.location_modes.includes(m.id), (on) => {
        let modes = STATE.constraints.location_modes;
        if (m.id === "any") { modes = on ? ["any"] : []; }
        else {
          modes = modes.filter((x) => x !== "any");
          if (on) { if (!modes.includes(m.id)) modes.push(m.id); }
          else modes = modes.filter((x) => x !== m.id);
        }
        STATE.constraints.location_modes = modes;
        redrawDist();
      }));
    });
    mF.appendChild(mRow); card.appendChild(mF);
    card.appendChild(distWrap);
    redrawDist();
    root.appendChild(card);
  }

  function renderTopics(root) {
    const card = section("🏷️ תגיות עניין");

    // Unified tag display: "wanted" (green) and "don't show" (red) together.
    STATE.interest_tags = STATE.interest_tags || [];
    const tagsWrap = el("div", "pf-chips");
    tagsWrap.style.marginTop = "8px";
    function redrawTags() {
      tagsWrap.innerHTML = "";
      // 👍 wanted tags — green, ✕ removes.
      STATE.interest_tags.forEach((name) => {
        const b = el("button", "pf-chip on", `👍 ${name} ✕`);
        b.type = "button";
        b.addEventListener("click", () => {
          STATE.interest_tags = STATE.interest_tags.filter((x) => x !== name);
          redrawTags();
        });
        tagsWrap.appendChild(b);
      });
      // 🚫 not-to-show tags — red, ✕ un-suppresses. Combines already-saved
      // suppressed_labels with session-only add_suppress.
      const unwanted = [
        ...(STATE.suppressed_labels || []).filter((n) => !removedLabels.includes(n)),
        ...STATE.add_suppress,
      ];
      unwanted.forEach((name) => {
        const b = el("button", "pf-chip removable", `🚫 ${name} ✕`);
        b.type = "button";
        b.addEventListener("click", () => {
          if (STATE.add_suppress.includes(name)) {
            STATE.add_suppress = STATE.add_suppress.filter((x) => x !== name);
          } else if (!removedLabels.includes(name)) {
            removedLabels.push(name);
          }
          redrawTags();
        });
        tagsWrap.appendChild(b);
      });
    }
    redrawTags();
    card.appendChild(tagsWrap);

    const more = el("button", "pf-add", "➕ בחרו מתוך כל התגיות");
    more.type = "button";
    more.addEventListener("click", () => openTagPicker(redrawTags));
    card.appendChild(more);
    root.appendChild(card);
  }

  // ── Full-tag picker popup (want / don't-want) ─────────────────────
  let LABELS_CACHE = null;
  async function openTagPicker(onChange) {
    const overlay = el("div", "pf-modal-backdrop");
    const sheet = el("div", "pf-modal");
    const head = el("div", "pf-modal-head");
    head.appendChild(el("span", "pf-card-title", "כל התגיות"));
    const close = el("button", "filter-sheet-close", "✕");
    close.type = "button";
    close.addEventListener("click", () => { document.body.removeChild(overlay); onChange?.(); });
    head.appendChild(close);
    sheet.appendChild(head);

    // mode toggle
    let mode = "want";
    const modeRow = el("div", "pf-chips");
    const wantBtn = el("button", "pf-chip on", "👍 מעניין במיוחד");
    const dontBtn = el("button", "pf-chip", "🚫 לא מעניין אותי");
    [wantBtn, dontBtn].forEach((b) => (b.type = "button"));
    wantBtn.addEventListener("click", () => { mode = "want"; wantBtn.classList.add("on"); dontBtn.classList.remove("on"); });
    dontBtn.addEventListener("click", () => { mode = "dont"; dontBtn.classList.add("on"); wantBtn.classList.remove("on"); });
    modeRow.appendChild(wantBtn); modeRow.appendChild(dontBtn);
    sheet.appendChild(modeRow);

    const search = el("input", "pf-input");
    search.type = "search"; search.placeholder = "סינון תגיות…";
    sheet.appendChild(search);

    const listWrap = el("div", "pf-modal-list");
    sheet.appendChild(listWrap);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) { document.body.removeChild(overlay); onChange?.(); }
    });

    if (!LABELS_CACHE) {
      listWrap.textContent = "טוען…";
      try {
        const res = await fetch(`${API_PREFIX}/labels?${new URLSearchParams({ initData: INIT_DATA })}`);
        LABELS_CACHE = (await res.json()).labels || [];
      } catch (_) { LABELS_CACHE = []; }
    }
    function isUnwanted(name) {
      return (STATE.suppressed_labels || []).includes(name) || STATE.add_suppress.includes(name);
    }
    function draw() {
      const q = search.value.trim();
      listWrap.innerHTML = "";
      LABELS_CACHE
        .filter((n) => !q || n.includes(q))
        .slice(0, 200)
        .forEach((name) => {
          const wanted = STATE.interest_tags.includes(name);
          const unwanted = isUnwanted(name);
          const cls = "pf-chip" + (wanted ? " on" : "") + (unwanted ? " removable" : "");
          const b = el("button", cls, name);
          b.type = "button";
          b.addEventListener("click", () => {
            if (mode === "want") {
              if (STATE.interest_tags.includes(name)) STATE.interest_tags = STATE.interest_tags.filter((x) => x !== name);
              else { STATE.interest_tags.push(name); STATE.add_suppress = STATE.add_suppress.filter((x) => x !== name); }
            } else {
              if ((STATE.suppressed_labels || []).includes(name)) return; // already suppressed
              if (STATE.add_suppress.includes(name)) STATE.add_suppress = STATE.add_suppress.filter((x) => x !== name);
              else { STATE.add_suppress.push(name); STATE.interest_tags = STATE.interest_tags.filter((x) => x !== name); }
            }
            draw();
          });
          listWrap.appendChild(b);
        });
    }
    search.addEventListener("input", draw);
    draw();
  }

  function renderAudiences(root) {
    const card = section("🎯 קהלי יעד");
    const row = chipRow();
    const sel = new Set(STATE.audience_chip_ids || []);
    OPTIONS.audiences.forEach((a) => {
      row.appendChild(chip(`${a.emoji || ""} ${a.label}`.trim(), sel.has(a.id), (on) => {
        if (on) sel.add(a.id); else sel.delete(a.id);
        STATE.audience_chip_ids = [...sel];
      }));
    });
    card.appendChild(row);
    root.appendChild(card);
  }

  function renderCommunities(root) {
    const card = section("🏳️ קהילות");
    const row = chipRow();
    STATE.communities = STATE.communities || {};
    OPTIONS.communities.forEach((c) => {
      const isMember = STATE.communities[c.key] !== "not-member"; // default member
      row.appendChild(chip(c.label, isMember, (on) => {
        STATE.communities[c.key] = on ? "member" : "not-member";
      }));
    });
    card.appendChild(row);
    root.appendChild(card);
  }

  function renderSuppressions(root) {
    const card = section("🔕 השתקות");
    const _base = card.childElementCount;
    function removableList(titleText, items, removedArr) {
      if (!items || !items.length) return;
      card.appendChild(el("div", "pf-sub-title", titleText));
      const wrap = el("div", "pf-chips");
      items.forEach((item) => {
        // item is a plain string (e.g. series) OR { key, name } (venues —
        // show the readable name, remove by key).
        const label = typeof item === "string" ? item : (item.name || item.key);
        const rmVal = typeof item === "string" ? item : item.key;
        const b = el("button", "pf-chip removable", `${label} ✕`);
        b.type = "button";
        b.addEventListener("click", () => {
          if (!removedArr.includes(rmVal)) removedArr.push(rmVal);
          b.remove();
        });
        wrap.appendChild(b);
      });
      card.appendChild(wrap);
    }
    // Suppressed tags are now shown/managed in the "תחומי עניין" section.
    removableList("מקומות שלא להציג", STATE.suppressed_locations, removedLocations);
    removableList("סדרות חוזרות שלא להציג", STATE.known_series, removedSeries);

    // (Removed the "אל תראו לי אירועי ילדים/תינוקות/נוער" toggle — child-event
    // visibility is owned solely by the 🎯 קהלי יעד selector now.) Only show
    // the section when it actually has suppressions.
    if (card.childElementCount > _base) root.appendChild(card);
  }

  function render() {
    const root = document.getElementById("pf-root");
    root.innerHTML = "";
    // Frequently-tuned settings first; rarely-changed ones (ילדים, כתובת) go
    // to the bottom.
    renderDetails(root);
    renderTopics(root);
    renderAudiences(root);
    renderCommunities(root);
    // ── rarely changed ──
    renderKids(root);
    renderLocation(root);
    renderSuppressions(root);
  }

  // ── save ──────────────────────────────────────────────────────────
  function buildPatch() {
    return {
      first_name: STATE.first_name,
      gender: STATE.gender,
      kids: STATE.kids,
      topic_ids: STATE.topic_ids,
      interest_tags: STATE.interest_tags,
      audience_chip_ids: STATE.audience_chip_ids,
      communities: STATE.communities,
      constraints: STATE.constraints,
      suppress_online_events: STATE.suppress_online_events,
      add_suppressed_labels: STATE.add_suppress,
      remove_suppressed_labels: removedLabels,
      remove_known_series: removedSeries,
      remove_suppressed_locations: removedLocations,
    };
  }
  async function save() {
    // Birth date is required for any kid row that has data; drop empty rows.
    STATE.kids = (STATE.kids || []).filter(
      (k) => k.name || k.birth_date || (k.dev_stages && Object.keys(k.dev_stages).length),
    );
    if (STATE.kids.some((k) => !k.birth_date)) {
      toast("לכל ילד צריך תאריך לידה");
      return;
    }
    try {
      // Haptics throw synchronously on unsupported clients (Telegram Desktop);
      // unguarded here it would abort the save before the POST even fired.
      try { tg?.HapticFeedback?.impactOccurred?.("light"); } catch (_) {}
      const res = await fetch(`${API_PREFIX}/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: INIT_DATA, patch: buildPatch() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
      const updated = await res.json();
      writeProfileCache(updated); // keep the instant-render cache current
      applyPayload(updated);
      render();
      refreshDirty();
      // Tell the catalog its results are now stale (profile changed) so it
      // refetches on return instead of re-rendering its cached payload.
      try { sessionStorage.setItem("catalog_dirty", "1"); } catch (_) {}
      toast("✅ נשמר");
      try { tg?.HapticFeedback?.notificationOccurred?.("success"); } catch (_) {}
    } catch (err) {
      toast("⚠️ שמירה נכשלה — נסו שוב");
      try { tg?.HapticFeedback?.notificationOccurred?.("error"); } catch (_) {}
    }
  }

  function applyPayload(payload) {
    // Keep a pristine deep clone so "ביטול" can fully revert local edits.
    pristinePayload = JSON.parse(JSON.stringify(payload));
    STATE = payload.profile;
    OPTIONS = payload.options;
    STATE.interest_tags = STATE.interest_tags || [];
    STATE.add_suppress = []; // session-only "don't want" adds
    removedLabels = []; removedSeries = []; removedLocations = [];
    baselineSig = savableSig();
  }

  // ── dirty tracking ────────────────────────────────────────────────
  // Signature of everything that would be persisted. Transient UI-only
  // fields (kid row expand state, prefixed with "_") are excluded so
  // expanding/collapsing a kid doesn't count as a change.
  function savableSig() {
    if (!STATE) return "";
    const kids = (STATE.kids || []).map((k) => {
      const o = {};
      for (const key of Object.keys(k)) if (!key.startsWith("_")) o[key] = k[key];
      return o;
    });
    return JSON.stringify({ ...buildPatch(), kids });
  }
  function isDirty() { return savableSig() !== baselineSig; }
  function refreshDirty() {
    const actions = document.getElementById("pf-actions");
    if (actions) actions.classList.toggle("show", isDirty());
  }
  function cancel() {
    if (!pristinePayload) return;
    applyPayload(JSON.parse(JSON.stringify(pristinePayload)));
    render();
    refreshDirty();
    toast("השינויים בוטלו");
  }

  let _wired = false;
  function wireSaveButton() {
    // In-page animated bar (not the native MainButton) so save + cancel share
    // one row that slides up only when there are unsaved changes.
    if (tg?.MainButton) { try { tg.MainButton.hide(); } catch (_) {} }
    if (_wired) { refreshDirty(); return; } // idempotent — listeners attach once
    _wired = true;
    document.getElementById("pf-save").addEventListener("click", save);
    document.getElementById("pf-cancel").addEventListener("click", cancel);
    // Recompute dirtiness after any interaction. Most edits happen via
    // input/change/click on STATE-bound controls (which bubble to document);
    // defer to a microtask so the control's own handler mutates STATE first.
    const onEdit = () => setTimeout(refreshDirty, 0);
    document.addEventListener("input", onEdit, true);
    document.addEventListener("change", onEdit, true);
    document.addEventListener("click", onEdit, true);
    refreshDirty();
  }

  // ── boot ──────────────────────────────────────────────────────────
  const PROFILE_CACHE_KEY = "profilePayload_v1";
  function readProfileCache() { try { return JSON.parse(sessionStorage.getItem(PROFILE_CACHE_KEY) || "null"); } catch (_) { return null; } }
  function writeProfileCache(p) { try { sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(p)); } catch (_) {} }
  async function boot() {
    const root = document.getElementById("pf-root");
    // 1) Paint instantly from the cached payload — no waiting on the network.
    let painted = false;
    const cached = readProfileCache();
    if (cached) {
      try { applyPayload(JSON.parse(JSON.stringify(cached))); render(); wireSaveButton(); painted = true; } catch (_) {}
    }
    // 2) Revalidate in the background; re-render only if the server differs and
    //    the user hasn't started editing (so we never clobber unsaved edits).
    INIT_DATA = await ensureInitData();
    if (!INIT_DATA) {
      if (!painted) root.innerHTML = '<div class="pf-error">פתחו את הפרופיל מתוך טלגרם — מהכפתור «📋 פרופיל» בבוט.</div>';
      return;
    }
    try {
      const res = await fetch(`${API_PREFIX}/profile?${new URLSearchParams({ initData: INIT_DATA })}`);
      if (!res.ok) throw new Error(res.status);
      const payload = await res.json();
      writeProfileCache(payload);
      const changed = JSON.stringify(payload) !== JSON.stringify(cached);
      if (!painted || (changed && !isDirty())) {
        applyPayload(payload);
        render();
        wireSaveButton();
      }
    } catch (err) {
      if (!painted) root.innerHTML = '<div class="pf-error">לא הצלחנו לטעון את הפרופיל. סגרו ופִתחו שוב מהבוט.</div>';
    }
  }

  // ── Overlay open/close (in-page, no reload) ───────────────────────────
  // The profile is embedded in index.html as #profileOverlay and opened from
  // the 👤 header button. boot() runs once (cache-first → instant); later opens
  // just reveal the already-rendered overlay.
  let _booted = false;
  const overlayEl = () => document.getElementById("profileOverlay");
  window.openProfileOverlay = function () {
    const ov = overlayEl(); if (!ov) return;
    ov.hidden = false;
    document.body.classList.add("profile-open");
    try { tg?.BackButton?.show?.(); } catch (_) {}
    if (!_booted) { _booted = true; boot(); }
  };
  window.closeProfileOverlay = function () {
    const ov = overlayEl(); if (ov) ov.hidden = true;
    document.body.classList.remove("profile-open");
    try { tg?.BackButton?.hide?.(); } catch (_) {}
    // Let the catalog refresh itself if a save marked it dirty (home/interests
    // changed → results should update).
    try { window.dispatchEvent(new CustomEvent("profile:closed")); } catch (_) {}
  };
  if (overlayEl()) {
    // Embedded in index.html → wait for the 👤 button (openProfileOverlay).
    // Back affordances act only while the overlay is open.
    document.getElementById("pfBack")?.addEventListener("click", (e) => { e.preventDefault(); window.closeProfileOverlay(); });
    try { tg?.BackButton?.onClick?.(() => { const ov = overlayEl(); if (ov && !ov.hidden) window.closeProfileOverlay(); }); } catch (_) {}
  } else {
    // Standalone profile.html (fallback for old links) — boot immediately;
    // its inline script already wires the back link + native BackButton.
    boot();
  }
})();
