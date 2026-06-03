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

    const aF = field("הגיל שלי");
    singleSelect(aF, OPTIONS.ageRanges, (x) => x.id, (x) => x.label, STATE.age_range,
      (id) => { STATE.age_range = id; });
    card.appendChild(aF);
    root.appendChild(card);
  }

  function renderKids(root) {
    const card = section("👶 ילדים");
    const list = el("div", "pf-kids");
    function drawKid(kid, idx) {
      const k = el("div", "pf-kid");
      const head = el("div", "pf-kid-head");
      head.appendChild(el("span", "pf-kid-n", `ילד/ה ${idx + 1}`));
      const rm = el("button", "pf-remove", "🗑️ הסר");
      rm.type = "button";
      rm.addEventListener("click", () => { STATE.kids.splice(idx, 1); redrawKids(); });
      head.appendChild(rm);
      k.appendChild(head);

      const nameI = el("input", "pf-input");
      nameI.type = "text"; nameI.placeholder = "שם"; nameI.value = kid.name || "";
      nameI.addEventListener("input", () => { kid.name = nameI.value; });
      k.appendChild(nameI);

      const bF = field("תאריך לידה");
      const bI = el("input", "pf-input");
      bI.type = "date"; bI.value = kid.birth_date || "";
      bI.addEventListener("change", () => { kid.birth_date = bI.value || null; });
      bF.appendChild(bI); k.appendChild(bF);

      const gF = field("מגדר");
      singleSelect(gF, OPTIONS.genders, (x) => x.id, (x) => x.label, kid.gender,
        (id) => { kid.gender = id; });
      k.appendChild(gF);

      const sF = field("שלב התפתחותי");
      const sRow = chipRow();
      kid.stages = Array.isArray(kid.stages) ? kid.stages : [];
      OPTIONS.devStages.forEach((s) => {
        sRow.appendChild(chip(s.label, kid.stages.includes(s.id), (on) => {
          if (on) { if (!kid.stages.includes(s.id)) kid.stages.push(s.id); }
          else kid.stages = kid.stages.filter((x) => x !== s.id);
        }));
      });
      sF.appendChild(sRow); k.appendChild(sF);
      list.appendChild(k);
    }
    function redrawKids() { list.innerHTML = ""; STATE.kids.forEach(drawKid); }
    redrawKids();
    card.appendChild(list);

    const add = el("button", "pf-add", "➕ הוסף ילד/ה");
    add.type = "button";
    add.addEventListener("click", () => {
      STATE.kids.push({ name: "", birth_date: null, gender: null, stages: [] });
      redrawKids();
    });
    card.appendChild(add);
    root.appendChild(card);
  }

  function renderLocation(root) {
    const card = section("📍 מיקום ומרחק");
    const aF = field("כתובת הבית");
    const aI = el("input", "pf-input");
    aI.type = "text"; aI.placeholder = "רחוב, עיר";
    aI.value = STATE.constraints.home_address || "";
    aI.addEventListener("input", () => { STATE.constraints.home_address = aI.value; });
    aF.appendChild(aI); card.appendChild(aF);

    const mF = field("איך מגיעים");
    const mRow = chipRow();
    STATE.constraints.location_modes = STATE.constraints.location_modes || [];
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
        // reflect mutual exclusion of "any" visually on next render is overkill; keep simple
      }));
    });
    mF.appendChild(mRow); card.appendChild(mF);

    const wF = field("דקות הליכה מקסימום");
    const wI = el("input", "pf-input");
    wI.type = "number"; wI.min = "1"; wI.max = "60"; wI.placeholder = "למשל 15";
    wI.value = STATE.constraints.max_walking_minutes ?? "";
    wI.addEventListener("input", () => {
      const n = parseInt(wI.value, 10);
      STATE.constraints.max_walking_minutes = Number.isFinite(n) ? n : null;
    });
    wF.appendChild(wI); card.appendChild(wF);
    root.appendChild(card);
  }

  function renderAvailability(root) {
    const card = section("🕒 זמינות");
    const note = el("p", "pf-hint", "מתי בדרך כלל פנויים? (משאירים ריק = כל הזמנים)");
    card.appendChild(note);
    const row = chipRow();
    const selected = new Set(availabilitySlotIds(STATE.constraints.availability));
    OPTIONS.timeSlots.forEach((s) => {
      row.appendChild(chip(s.label, selected.has(s.id), (on) => {
        if (on) selected.add(s.id); else selected.delete(s.id);
        STATE.constraints.availability = buildAvailability([...selected]);
      }));
    });
    card.appendChild(row);
    root.appendChild(card);
  }
  function availabilitySlotIds(av) {
    const ids = [];
    const blocks = av?.blocks || [];
    OPTIONS.timeSlots.forEach((s) => {
      if (blocks.some((b) => b.start === s.start && b.end === s.end)) ids.push(s.id);
    });
    return ids;
  }
  function buildAvailability(slotIds) {
    if (!slotIds.length) return null;
    const days = [0, 1, 2, 3, 4, 5, 6];
    const blocks = slotIds
      .map((id) => OPTIONS.timeSlots.find((s) => s.id === id))
      .filter(Boolean)
      .map((s) => ({ days, start: s.start, end: s.end }));
    return { preset: "custom", blocks };
  }

  function renderTopics(root) {
    const card = section("⭐ תחומי עניין");
    const row = chipRow();
    const sel = new Set(STATE.topic_ids || []);
    OPTIONS.topics.forEach((t) => {
      row.appendChild(chip(`${t.emoji || ""} ${t.label}`.trim(), sel.has(t.id), (on) => {
        if (on) sel.add(t.id); else sel.delete(t.id);
        STATE.topic_ids = [...sel];
      }));
    });
    card.appendChild(row);
    root.appendChild(card);
  }

  function renderAudiences(root) {
    const card = section("🎯 קהלי יעד");
    card.appendChild(el("p", "pf-hint", "ריק = הכל (לא מצמצמים לפי קהל)"));
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
    card.appendChild(el("p", "pf-hint", "כברירת מחדל חברים בכולן — כבו מה שלא רלוונטי"));
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
    function removableList(titleText, items, removedArr) {
      if (!items || !items.length) return;
      card.appendChild(el("div", "pf-sub-title", titleText));
      const wrap = el("div", "pf-chips");
      items.forEach((name) => {
        const b = el("button", "pf-chip removable", `${name} ✕`);
        b.type = "button";
        b.addEventListener("click", () => {
          if (!removedArr.includes(name)) removedArr.push(name);
          b.remove();
        });
        wrap.appendChild(b);
      });
      card.appendChild(wrap);
    }
    removableList("תגיות שלא להציג", STATE.suppressed_labels, removedLabels);
    removableList("מקומות שלא להציג", STATE.suppressed_locations, removedLocations);
    removableList("סדרות חוזרות שלא להציג", STATE.known_series, removedSeries);

    // toggles
    function toggle(labelText, val, onChange) {
      const wrap = el("label", "pf-toggle");
      const cb = el("input");
      cb.type = "checkbox"; cb.checked = !!val;
      cb.addEventListener("change", () => onChange(cb.checked));
      wrap.appendChild(cb);
      wrap.appendChild(el("span", null, labelText));
      card.appendChild(wrap);
    }
    toggle("אל תראו לי אירועי ילדים/תינוקות/נוער", STATE.suppress_child_audiences,
      (v) => { STATE.suppress_child_audiences = v; });
    toggle("אל תראו לי אירועים אונליין", STATE.suppress_online_events,
      (v) => { STATE.suppress_online_events = v; });
    root.appendChild(card);
  }

  function render() {
    const root = document.getElementById("pf-root");
    root.innerHTML = "";
    renderDetails(root);
    renderKids(root);
    renderLocation(root);
    renderAvailability(root);
    renderTopics(root);
    renderAudiences(root);
    renderCommunities(root);
    renderSuppressions(root);
  }

  // ── save ──────────────────────────────────────────────────────────
  function buildPatch() {
    return {
      first_name: STATE.first_name,
      gender: STATE.gender,
      age_range: STATE.age_range,
      kids: STATE.kids,
      topic_ids: STATE.topic_ids,
      audience_chip_ids: STATE.audience_chip_ids,
      communities: STATE.communities,
      constraints: STATE.constraints,
      suppress_child_audiences: STATE.suppress_child_audiences,
      suppress_online_events: STATE.suppress_online_events,
      remove_suppressed_labels: removedLabels,
      remove_known_series: removedSeries,
      remove_suppressed_locations: removedLocations,
    };
  }
  async function save() {
    try {
      tg?.HapticFeedback?.impactOccurred?.("light");
      const res = await fetch(`${API_PREFIX}/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: INIT_DATA, patch: buildPatch() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
      const updated = await res.json();
      applyPayload(updated);
      render();
      toast("✅ נשמר");
      tg?.HapticFeedback?.notificationOccurred?.("success");
    } catch (err) {
      toast("⚠️ שמירה נכשלה — נסו שוב");
      tg?.HapticFeedback?.notificationOccurred?.("error");
    }
  }

  function applyPayload(payload) {
    STATE = payload.profile;
    OPTIONS = payload.options;
    removedLabels = []; removedSeries = []; removedLocations = [];
  }

  function wireSaveButton() {
    const btn = document.getElementById("pf-save");
    if (tg?.MainButton) {
      tg.MainButton.setText("שמירה");
      tg.MainButton.show();
      tg.MainButton.onClick(save);
    } else {
      btn.hidden = false;
      btn.addEventListener("click", save);
    }
  }

  // ── boot ──────────────────────────────────────────────────────────
  async function boot() {
    INIT_DATA = readInitData();
    const root = document.getElementById("pf-root");
    if (!INIT_DATA) {
      root.innerHTML = '<div class="pf-error">פתחו את הפרופיל מתוך טלגרם — מהכפתור «📋 פרופיל» בבוט.</div>';
      return;
    }
    try {
      const res = await fetch(`${API_PREFIX}/profile?${new URLSearchParams({ initData: INIT_DATA })}`);
      if (!res.ok) throw new Error(res.status);
      applyPayload(await res.json());
      render();
      wireSaveButton();
    } catch (err) {
      root.innerHTML = '<div class="pf-error">לא הצלחנו לטעון את הפרופיל. סגרו ופִתחו שוב מהבוט.</div>';
    }
  }

  boot();
})();
