/* Event catalog Mini App — app.js
 *
 * Flow:
 *   1. Init Telegram WebApp SDK (theme, expand to full screen)
 *   2. Fetch personalized events from /miniapp/events
 *   3. Render card grid with filters + search
 */

(function () {
  "use strict";

  // ── Telegram SDK setup ──────────────────────────────────────────────
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    // Apply Telegram's color scheme so CSS vars are immediately set.
    document.documentElement.style.setProperty(
      "--tg-theme-bg-color",
      tg.backgroundColor || "",
    );
  }

  // ── State ───────────────────────────────────────────────────────────
  let allEvents = [];      // full fetched list
  let visibleEvents = [];  // after client-side filter/search
  let activeAudience = "default";
  let searchQuery = "";

  // ── DOM refs ────────────────────────────────────────────────────────
  const spinner    = document.getElementById("spinner");
  const errorDiv   = document.getElementById("error");
  const catalog    = document.getElementById("catalog");
  const cardGrid   = document.getElementById("cardGrid");
  const resultsMeta = document.getElementById("resultsMeta");
  const filterBar  = document.getElementById("filterBar");
  const searchInput = document.getElementById("searchInput");
  const noResults  = document.getElementById("noResults");
  const greeting   = document.getElementById("greeting");

  // ── Fetch events ─────────────────────────────────────────────────────
  async function loadEvents() {
    const initData = tg?.initData || "";
    if (!initData) {
      showError("פתח את הקטלוג דרך הבוט בטלגרם.");
      return;
    }

    const params = new URLSearchParams({ initData });
    const url = `/miniapp/events?${params}`;

    try {
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) {
        showError(body.error || `שגיאה ${res.status}`);
        return;
      }

      if (body.profile?.firstName) {
        greeting.textContent = `שלום, ${body.profile.firstName}`;
      }

      allEvents = body.events || [];
      applyFilters();
      spinner.style.display = "none";
      catalog.style.display = "block";
    } catch (err) {
      showError("לא ניתן לטעון את האירועים כרגע. נסו שוב.");
      console.error(err);
    }
  }

  // ── Filter + search (client-side) ───────────────────────────────────
  function applyFilters() {
    const q = searchQuery.trim().toLowerCase();
    const AUDIENCE_HE = {
      family:   "לכל המשפחה",
      kids:     "ילדים",
      toddlers: "תינוקות",
      teens:    "נוער",
      parents:  "הורים",
      adults:   "מבוגרים",
    };

    visibleEvents = allEvents.filter((e) => {
      // Audience chip filter
      if (activeAudience !== "default" && activeAudience !== "all") {
        const targetHe = AUDIENCE_HE[activeAudience];
        if (targetHe && e.audience && e.audience !== targetHe && e.audience !== "לכל המשפחה") {
          return false;
        }
      }
      // Text search
      if (q) {
        const haystack = [e.name, e.location, e.category, ...(e.tags || [])]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    renderGrid();
  }

  // ── Render card grid ─────────────────────────────────────────────────
  function renderGrid() {
    cardGrid.innerHTML = "";
    const count = visibleEvents.length;
    resultsMeta.textContent = count
      ? `${count} אירועים`
      : "";
    noResults.style.display = count ? "none" : "block";

    for (const event of visibleEvents) {
      cardGrid.appendChild(buildCard(event));
    }
  }

  // ── Build a single card element ──────────────────────────────────────
  function buildCard(event) {
    const card = document.createElement("div");
    card.className = "event-card";
    card.dataset.id = event.id;

    // Image
    let imageHtml = "";
    if (event.image) {
      imageHtml = `<img class="card-image" src="${esc(event.image)}" alt="" loading="lazy" onerror="this.style.display='none'" />`;
    }

    // Meta line
    const metaParts = [];
    if (event.dateHe) metaParts.push(`📅 ${esc(event.dateHe)}`);
    if (event.timeHe) metaParts.push(`🕐 ${esc(event.timeHe)}`);
    if (event.location) metaParts.push(`📍 ${esc(event.location)}`);
    const metaHtml = metaParts.map((p) => `<span>${p}</span>`).join("");

    // Tags
    const tagsHtml = (event.tags || []).slice(0, 4)
      .map((t) => `<span class="tag-pill">${esc(t)}</span>`)
      .join("");

    // Audience line
    const audienceHtml = event.audienceLine
      ? `<div class="audience-line">${esc(event.audienceLine)}</div>`
      : "";

    card.innerHTML = `
      ${imageHtml}
      <div class="card-body">
        <div class="card-title-row">
          <span class="card-icon">${esc(event.icon || "📌")}</span>
          <span class="card-title">${esc(event.name)}</span>
        </div>
        ${audienceHtml}
        <div class="card-meta">${metaHtml}</div>
        ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ""}
      </div>
      <div class="card-detail" id="detail-${event.id}">
        ${buildDetail(event)}
      </div>
    `;

    // Toggle expand on tap
    card.addEventListener("click", () => toggleCard(card, event));

    return card;
  }

  function buildDetail(event) {
    const parts = [];

    if (event.description) {
      parts.push(
        `<div class="card-description">${esc(event.description).replace(/\n/g, "<br>")}</div>`,
      );
    }

    const actions = [];
    if (event.bookingUrl) {
      actions.push(
        `<a class="btn btn-primary" href="${esc(event.bookingUrl)}" target="_blank" rel="noopener">🔗 פרטים והרשמה</a>`,
      );
    }
    if (event.onlineUrl) {
      actions.push(
        `<a class="btn btn-secondary" href="${esc(event.onlineUrl)}" target="_blank" rel="noopener">📹 הצטרף למפגש</a>`,
      );
    }
    if (event._lat && event._lng) {
      const mapsUrl = `https://maps.google.com/?q=${event._lat},${event._lng}`;
      actions.push(
        `<a class="btn btn-secondary" href="${esc(mapsUrl)}" target="_blank" rel="noopener">🧭 ניווט</a>`,
      );
    } else if (event.location && !isCityWide(event.location)) {
      const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`;
      actions.push(
        `<a class="btn btn-secondary" href="${esc(mapsUrl)}" target="_blank" rel="noopener">🧭 ניווט</a>`,
      );
    }

    if (actions.length) {
      parts.push(`<div class="card-actions">${actions.join("")}</div>`);
    }

    return parts.join("") || "<div class='card-description'>אין פרטים נוספים.</div>";
  }

  function isCityWide(locationText) {
    const cityWide = ["ברחבי העיר", "רחבי העיר", "כלל העיר", "מספר מיקומים", "מיקומים שונים"];
    return cityWide.some((k) => locationText?.includes(k));
  }

  function toggleCard(card) {
    const wasOpen = card.classList.contains("open");
    // Close all open cards first.
    document.querySelectorAll(".event-card.open").forEach((c) => c.classList.remove("open"));
    if (!wasOpen) {
      card.classList.add("open");
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  // ── Filter chips ─────────────────────────────────────────────────────
  filterBar.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    filterBar.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    activeAudience = chip.dataset.audience;
    applyFilters();
  });

  // ── Search input ──────────────────────────────────────────────────────
  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = searchInput.value;
      applyFilters();
    }, 250);
  });

  // ── Utils ─────────────────────────────────────────────────────────────
  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showError(msg) {
    spinner.style.display = "none";
    errorDiv.style.display = "block";
    errorDiv.innerHTML = `<div class="error-banner">${esc(msg)}</div>`;
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────
  loadEvents();
})();
