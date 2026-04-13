/* global window, document */

function $(sel, root = document) {
  return root.querySelector(sel);
}

function $all(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeData() {
  const d = window.DELEXO_LINKS;
  if (!d || !d.profile || !Array.isArray(d.categories)) {
    throw new Error("Missing window.DELEXO_LINKS (did you include ../data/links.js?)");
  }
  return d;
}

function flattenItems(data) {
  const out = [];
  for (const cat of data.categories) {
    for (const item of cat.items || []) {
      out.push({ ...item, categoryId: cat.id, categoryLabel: cat.label });
    }
  }
  return out;
}

function itemHtml(item) {
  const comingSoon = !!item.comingSoon || !item.url;
  const badge = comingSoon ? `<span class="badge">Coming soon</span>` : "";
  const img = item.image
    ? `<img alt="" loading="lazy" decoding="async" src="../${escapeHtml(
        item.image
      )}" style="width:40px;height:40px;border-radius:12px;object-fit:cover;border:1px solid rgba(255,255,255,.14)"/>`
    : "";
  const right = comingSoon ? `<span class="muted mono">—</span>` : `<span class="muted mono">↗</span>`;

  const href = comingSoon ? "#" : escapeHtml(item.url);
  const attrs = comingSoon ? `aria-disabled="true" data-coming-soon="true"` : `target="_blank" rel="noreferrer"`;

  return `
    <a class="button" href="${href}" ${attrs}>
      ${img}
      <span style="flex:1;min-width:0;text-align:left">
        <span style="display:flex;align-items:center;gap:10px;justify-content:space-between">
          <span style="font-weight:650;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.title)}</span>
          ${badge}
        </span>
        <span class="muted" style="display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.categoryLabel)}</span>
      </span>
      <span aria-hidden="true">${right}</span>
    </a>
  `;
}

function renderCategoryList(rootSel, opts = {}) {
  const data = normalizeData();
  const root = $(rootSel);
  if (!root) return;
  const { categoryId } = opts;
  const cats = categoryId ? data.categories.filter((c) => c.id === categoryId) : data.categories;
  root.innerHTML = cats
    .map(
      (cat) => `
      <section class="card" aria-label="${escapeHtml(cat.label)}">
        <div class="cardHeader">
          <div>
            <h2>${escapeHtml(cat.label)}</h2>
            <p class="meta">${escapeHtml(String((cat.items || []).length))} items</p>
          </div>
        </div>
        <div class="cardBody" style="display:flex;flex-direction:column;gap:10px">
          ${(cat.items || []).map(itemHtml).join("")}
        </div>
      </section>
    `
    )
    .join("");
}

function setupCopyHandle(btnSel, text) {
  const btn = $(btnSel);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.setAttribute("data-state", "copied");
      btn.querySelector("[data-label]").textContent = "Copied";
      window.setTimeout(() => {
        btn.removeAttribute("data-state");
        btn.querySelector("[data-label]").textContent = "Copy handle";
      }, 1100);
    } catch {
      // ignore
    }
  });
}

function setupSearch(inputSel, listSel) {
  const input = $(inputSel);
  const list = $(listSel);
  if (!input || !list) return;

  const data = normalizeData();
  const items = flattenItems(data);

  function render(query) {
    const q = query.trim().toLowerCase();
    const filtered = !q
      ? items
      : items.filter((it) => (it.title || "").toLowerCase().includes(q) || (it.categoryLabel || "").toLowerCase().includes(q));

    list.innerHTML = filtered.map(itemHtml).join("");
    const empty = $("#emptyState");
    if (empty) empty.style.display = filtered.length ? "none" : "block";
  }

  input.addEventListener("input", () => render(input.value));
  render("");
}

function setupCommandPalette() {
  const palette = $("#palette");
  const palInput = $("#paletteInput");
  const palList = $("#paletteList");
  const openBtn = $("#openPalette");
  const closeBtn = $("#closePalette");
  if (!palette || !palInput || !palList) return;

  const data = normalizeData();
  const items = flattenItems(data).filter((it) => !it.comingSoon && it.url);

  function open() {
    palette.setAttribute("data-open", "true");
    palInput.value = "";
    render("");
    palInput.focus();
  }
  function close() {
    palette.removeAttribute("data-open");
  }
  function render(q) {
    const qq = q.trim().toLowerCase();
    const filtered = !qq
      ? items.slice(0, 12)
      : items
          .filter((it) => (it.title || "").toLowerCase().includes(qq) || (it.categoryLabel || "").toLowerCase().includes(qq))
          .slice(0, 12);

    palList.innerHTML = filtered
      .map(
        (it) => `
        <button class="palItem" type="button" data-url="${escapeHtml(it.url)}">
          <span style="font-weight:650">${escapeHtml(it.title)}</span>
          <span class="muted" style="font-size:12px">${escapeHtml(it.categoryLabel)}</span>
        </button>
      `
      )
      .join("");
  }

  palette.addEventListener("click", (e) => {
    if (e.target === palette) close();
  });
  closeBtn?.addEventListener("click", close);
  openBtn?.addEventListener("click", open);
  palInput.addEventListener("input", () => render(palInput.value));
  palList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-url]");
    const url = btn?.getAttribute("data-url");
    if (url) window.open(url, "_blank", "noreferrer");
    close();
  });

  document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    const isK = key === "k";
    const meta = e.metaKey || e.ctrlKey;
    if (meta && isK) {
      e.preventDefault();
      open();
    }
    if (key === "escape") close();
  });
}

function setupFileFriendlyExternalLinks() {
  // Prevent “#” navigation for coming-soon.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-coming-soon]");
    if (a) e.preventDefault();
  });
}

window.DelexoUI = {
  $,
  $all,
  normalizeData,
  renderCategoryList,
  setupCopyHandle,
  setupSearch,
  setupCommandPalette,
  setupFileFriendlyExternalLinks,
};

