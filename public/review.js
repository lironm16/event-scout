(function () {
  const tg = window.Telegram?.WebApp || null;
  try { tg?.ready(); tg?.expand(); } catch (_) {}
  const API_PREFIX = "/miniapp";

  function parseInitDataFromLocation() {
    for (const raw of [location.hash.slice(1), location.search.slice(1)]) {
      const v = new URLSearchParams(raw).get("tgWebAppData");
      if (v) return v;
    }
    return "";
  }
  let INIT_DATA = (tg && tg.initData) || parseInitDataFromLocation() || "";

  const qs = new URLSearchParams(location.search);
  const eventId = qs.get("ev") || qs.get("eventId");

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let chosen = 0;

  function toast(msg) {
    const t = $("rvToast"); if (!t) return;
    t.textContent = msg; t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1800);
  }

  function paintStars(n) {
    document.querySelectorAll(".rv-star").forEach((s) => {
      s.classList.toggle("on", Number(s.dataset.v) <= n);
    });
    $("rvSubmit").disabled = !(n >= 1);
  }

  function starBar(n) { return "★".repeat(n) + "☆".repeat(5 - n); }

  function renderOthers(agg) {
    const box = $("rvOthers");
    $("rvAggTitle").textContent = agg.count
      ? `ביקורות — ⭐ ${agg.average} (${agg.count})`
      : "ביקורות";
    if (!agg.reviews || !agg.reviews.length) {
      box.innerHTML = '<div class="rv-empty">אין עדיין ביקורות — היו הראשונים!</div>';
      return;
    }
    box.innerHTML = agg.reviews.map((r) => `
      <div class="rv-review">
        <div class="rv-r-head"><span class="rv-r-stars">${starBar(r.stars)}</span><span>${esc(r.name || (r.mine ? "את/ה" : "אנונימי"))}</span></div>
        ${r.note ? `<div class="rv-r-note">${esc(r.note)}</div>` : ""}
      </div>`).join("");
  }

  async function loadEvent() {
    try {
      const r = await fetch(`${API_PREFIX}/event?${new URLSearchParams({ initData: INIT_DATA, id: eventId, noseries: "1", includeArchived: "1" })}`);
      const ev = (await r.json()).event;
      if (ev) {
        $("rvEventName").textContent = ev.name || "האירוע";
        $("rvEventMeta").textContent = [ev.dateHe, ev.location].filter(Boolean).join(" · ");
      } else {
        $("rvEventName").textContent = "האירוע";
      }
    } catch (_) { $("rvEventName").textContent = "האירוע"; }
  }

  async function loadReviews() {
    try {
      const r = await fetch(`${API_PREFIX}/reviews?${new URLSearchParams({ initData: INIT_DATA, eventId })}`);
      const agg = await r.json();
      if (agg.mine) { chosen = agg.mine.stars; paintStars(chosen); if (agg.mine.note) $("rvNote").value = agg.mine.note; }
      renderOthers(agg);
    } catch (_) { renderOthers({ count: 0, reviews: [] }); }
  }

  document.querySelectorAll(".rv-star").forEach((s) => {
    s.addEventListener("click", () => { chosen = Number(s.dataset.v); paintStars(chosen); try { tg?.HapticFeedback?.selectionChanged?.(); } catch (_) {} });
  });

  $("rvSubmit").addEventListener("click", async () => {
    if (chosen < 1) return;
    $("rvSubmit").disabled = true;
    try {
      const r = await fetch(`${API_PREFIX}/review`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: INIT_DATA, eventId, stars: chosen, note: $("rvNote").value.trim() }),
      });
      if (!r.ok) throw new Error(r.status);
      const agg = await r.json();
      renderOthers(agg);
      try { tg?.HapticFeedback?.notificationOccurred?.("success"); } catch (_) {}
      toast("✅ תודה על הדירוג!");
    } catch (err) {
      const msg = /401/.test(String(err.message)) ? "פג תוקף — סגרי ופתחי מחדש" : "השליחה נכשלה — נסי שוב";
      toast(msg);
      $("rvSubmit").disabled = false;
    }
  });

  $("rvClose").addEventListener("click", (e) => {
    e.preventDefault();
    try { tg?.close?.(); } catch (_) {}
    location.href = "index.html" + location.search + location.hash;
  });
  try { tg?.BackButton?.show?.(); tg?.BackButton?.onClick?.(() => { try { tg.close(); } catch (_) {} }); } catch (_) {}

  (async () => {
    if (!eventId) { $("rvLoading").textContent = "לא צוין אירוע."; return; }
    await Promise.all([loadEvent(), loadReviews()]);
    $("rvLoading").hidden = true;
    $("rvBody").hidden = false;
  })();
})();
