/* Inbox Broom – content script
 *
 * Drives the Gmail web UI directly. Rule modes:
 *   query – bulk: search, select all matching, act (one shot for thousands)
 *   ai    – per-row: search, parse rows, ask local LLM (via background) which are junk,
 *           tick only those rows, act, page through "Older"
 * Actions: archive | delete | label (= Gmail "Move to <label>": labels AND archives)
 *
 * Element lookup: language-independent attrs first (act="7" archive, act="10" delete, role=…, gh="tm"),
 * then data-tooltip / aria-label (English), then geometry.
 */

(() => {
  if (window.__gmailCleanerLoaded) return;
  window.__gmailCleanerLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)].filter(visible);
  const q = (sel, root = document) => qa(sel, root)[0] || null;
  const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  let stopRequested = false;
  let running = false;
  let undo = null; // this clean run's undo record: { label, marked, labeled: { label: [ids] }, warn }
  const UNDO_LABEL_RE = /^Broom (undo|restored)\b/i; // our bookkeeping labels, never offered to the AI
  const labelTerm = (l) => `label:${l.trim().replace(/\s+/g, "-")}`;
  let keepAliveTimer = null;
  const keepAlive = (on) => {
    clearInterval(keepAliveTimer);
    keepAliveTimer = on ? setInterval(() => browser.__send({ type: "keepalive" }).catch(() => {}), 20000) : null;
  };

  // ------------------------------------------------------------ banner

  const banner = document.createElement("div");
  banner.id = "gic-banner";
  banner.innerHTML = `<span class="gic-text"></span><button class="gic-stop">Stop</button>`;
  banner.querySelector(".gic-stop").onclick = () => {
    stopRequested = true;
    setBanner("Stopping after current step…");
  };
  function setBanner(text, kind = "") {
    if (!banner.isConnected) document.body.appendChild(banner);
    banner.className = kind;
    banner.querySelector(".gic-text").textContent = text;
    banner.style.display = "flex";
  }
  const hideBanner = (delay = 0) => setTimeout(() => (banner.style.display = "none"), delay);
  function progress(text, kind) {
    setBanner(text, kind);
    browser.storage.local.set({ progress: { text, at: Date.now(), running } }).catch(() => {});
  }

  // ------------------------------------------------------------ dom: list

  function mainView() {
    return qa('div[role="main"]').find((m) => m.querySelector("tr.zA")) || q('div[role="main"]');
  }
  function rows() {
    return qa("tr.zA", mainView() || document);
  }
  function noResults() {
    const t = txt(mainView() || document.body);
    return /No messages matched your search|No conversations matched|Nothing in (Spam|Trash)/i.test(t) && rows().length === 0;
  }
  function pagerCount() {
    const el = q("span.Dj", mainView() || document) || q("span.Dj");
    if (!el) return null;
    const t = txt(el).replace(/[ ,]/g, "");
    const m = t.match(/of\s*(\d+)\s*$/i) || t.match(/(\d+)\s*$/);
    return m ? Number(m[1]) : null;
  }
  function readCount() {
    if (noResults()) return 0;
    const n = pagerCount();
    return n != null ? n : rows().length;
  }

  function parseRow(tr) {
    const senderEl = tr.querySelector("span[email]");
    const email = (senderEl?.getAttribute("email") || "").toLowerCase();
    const sender = senderEl?.getAttribute("name") || txt(senderEl) || email;
    const bog = tr.querySelector("span.bog") || tr.querySelector("[data-thread-id]");
    const subject = txt(bog);
    const snippet = txt(tr.querySelector("span.y2")).replace(/^-\s*/, "");
    const date = tr.querySelector("td.xW span[title]")?.getAttribute("title") || txt(tr.querySelector("td.xW"));
    const id =
      bog?.getAttribute("data-legacy-thread-id") ||
      bog?.getAttribute("data-thread-id") ||
      tr.querySelector("[data-legacy-thread-id]")?.getAttribute("data-legacy-thread-id") ||
      `h:${email}|${subject}`;
    const marker = tr.querySelector('td.WA [aria-label], [role="img"][aria-label^="Important"], [aria-label^="Important"]');
    const important = !!marker && /^important/i.test(marker.getAttribute("aria-label") || "");
    return { id, email, sender, subject, snippet, date, unread: tr.classList.contains("zE"), important };
  }
  const rowCheckbox = (tr) => tr.querySelector('[role="checkbox"]') || tr.querySelector("td.oZ-x3") || tr.firstElementChild;

  // ------------------------------------------------------------ dom: toolbar

  function toolbar() {
    const main = mainView();
    return (main && q('div[gh="tm"]', main)) || q('div[gh="tm"]');
  }

  function selectAllCheckbox() {
    const tb = toolbar();
    if (tb) {
      const c = q('[role="checkbox"]', tb);
      if (c) return c;
    }
    const r = rows();
    const top = r[0]?.getBoundingClientRect().top ?? Infinity;
    const left = r[0]?.getBoundingClientRect().left ?? 0;
    const cands = qa('[role="checkbox"]').filter((c) => {
      if (c.closest("tr.zA")) return false;
      const b = c.getBoundingClientRect();
      return b.top < top && b.top > 0 && b.left >= left - 20 && b.left < left + 200;
    });
    cands.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return cands[0] || q('[data-tooltip="Select"], [aria-label="Select"]');
  }

  const btnLabel = (b) => `${b.getAttribute("aria-label") || ""}|${b.getAttribute("data-tooltip") || ""}|${b.getAttribute("title") || ""}|${txt(b)}`;
  function toolbarButtons() {
    const tb = toolbar();
    return tb ? qa('[role="button"], button', tb) : [];
  }
  /** Strictly inside the message-list toolbar (gh="tm"). Never falls back to the whole page. */
  function toolbarButton(name) {
    const act = { Delete: "10", Archive: "7" }[name];
    const tb = toolbar();
    if (act) {
      const a = (tb && q(`div[act="${act}"]`, tb)) || q(`div[act="${act}"]`);
      if (a) return a;
    }
    if (!tb) return null;
    const re = new RegExp(`(^|\\|)\\s*${name}`, "i");
    const hit = toolbarButtons().find((b) => re.test(btnLabel(b)) && !/search/i.test(btnLabel(b)));
    if (hit) return hit;
    if (/^label/i.test(name)) {
      const drops = toolbarButtons().filter((b) => b.getAttribute("aria-haspopup") === "true" && !/move|more|snooze|task|add to|select|sort|search/i.test(btnLabel(b)));
      if (drops.length) return drops[drops.length - 1];
    }
    return null;
  }
  function toolbarDiag() {
    return toolbarButtons().map((b) => btnLabel(b).replace(/\|+$/, "").slice(0, 30) + (b.getAttribute("act") ? `#${b.getAttribute("act")}` : "")).filter(Boolean).slice(0, 25).join(" ; ");
  }

  function selectAllMatchingLink() {
    const cands = qa('span[role="link"], a, span.ya span, div.ya span', mainView() || document);
    return cands.find((el) => /^Select all\b/i.test(txt(el))) || null;
  }

  function dialog() {
    return q('div[role="alertdialog"], div[role="dialog"]');
  }
  function dialogButton(re) {
    const dlg = dialog();
    if (!dlg) return null;
    return (re.test("ok") && q('button[name="ok"]', dlg)) || qa('button, div[role="button"]', dlg).find((b) => re.test(txt(b))) || null;
  }
  const dialogOk = () => dialogButton(/^(ok|continue|yes)$/i);

  function olderButton() {
    const sel = '[role="button"][data-tooltip="Older"], [role="button"][aria-label="Older"]';
    const b = q(sel, mainView() || document) || q(sel);
    return b && b.getAttribute("aria-disabled") !== "true" ? b : null;
  }

  function click(el) {
    el.scrollIntoView({ block: "center" });
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  function typeInto(input, value) {
    // never dispatch real key events: Gmail keyboard shortcuts (Enter, ], o …) would act on the mailbox
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified", code: "" }));
  }
  function closeMenus() {
    // Escape is safe: Gmail only closes menus/dialogs on it
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
  }

  async function waitFor(fn, { timeout = 15000, interval = 150 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stopRequested) throw new Error("Stopped");
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function diag() {
    return `diag: mains=${qa('div[role="main"]').length} rows=${rows().length} toolbar=${toolbar() ? "yes" : "no"} checkboxes=${qa('[role="checkbox"]').length} act7=${qa('div[act="7"]').length} act10=${qa('div[act="10"]').length} menus=${qa('div[role="menu"]').length}`;
  }

  // ------------------------------------------------------------ labels

  function labelsFromNav() {
    const out = new Set();
    for (const a of document.querySelectorAll('a[href*="#label/"]')) {
      const m = a.getAttribute("href").match(/#label\/([^?&]+)/);
      if (m) {
        try {
          out.add(decodeURIComponent(m[1]).replace(/\+/g, " "));
        } catch {}
      }
    }
    return [...out];
  }

  /** Opens the "Labels" toolbar menu (needs a selection), reads label names, closes it. */
  async function labelsFromMenu() {
    const trs = rows();
    if (!trs.length) return [];
    const cb = rowCheckbox(trs[0]);
    click(cb);
    await sleep(300);
    let menu = null;
    try {
      menu = await openLabelMenu();
    } catch (e) {
      console.warn("[Inbox Broom] label menu:", e.message);
    }
    const names = [];
    if (menu) {
      for (const it of qa('[role="menuitemcheckbox"], [role="menuitem"]', menu)) {
        const t = txt(it);
        if (t && !/^(create new|manage labels|apply)$/i.test(t)) names.push(t.replace(/\s*\(\d+\)$/, ""));
      }
      closeMenus();
      await sleep(300);
    }
    // deselect
    await clearSelection();
    return names;
  }

  function navEl() {
    return qa('div[role="navigation"]').sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0] || null;
  }
  function sidebarCollapsed() {
    const nav = navEl();
    return !!nav && nav.getBoundingClientRect().width < 150;
  }
  /** Expand Gmail's collapsed (icon-only) sidebar. Returns a restore function. */
  async function ensureSidebarExpanded() {
    if (!sidebarCollapsed()) return async () => {};
    const burger = q('[aria-label="Main menu"], [data-tooltip="Main menu"], [aria-label="Hauptmenü"]') || qa('[role="button"]').find((b) => /main menu/i.test(b.getAttribute("aria-label") || b.getAttribute("data-tooltip") || ""));
    if (!burger) throw new Error(`sidebar is collapsed and the Main menu button was not found. ${diag()}`);
    click(burger);
    await sleep(800);
    if (sidebarCollapsed()) throw new Error("sidebar still collapsed after clicking Main menu");
    return async () => {
      click(burger);
      await sleep(400);
    };
  }

  /** Expand the sidebar "More" so hidden labels get rendered. */
  async function expandMore() {
    // Gmail has two "More" toggles (system folders, labels). Click every collapsed one.
    const cands = qa('[role="button"][aria-expanded="false"], div.n6 [role="button"], span.CJ').filter((el) => /^more( labels)?$/i.test(txt(el)) || /more/i.test(el.getAttribute("aria-label") || ""));
    let clicked = 0;
    for (const el of cands) {
      click(el.closest('[role="button"]') || el);
      clicked++;
      await sleep(500);
    }
    if (!clicked) {
      const any = qa("span, div").find((el) => /^more$/i.test(txt(el)) && el.children.length === 0 && el.getBoundingClientRect().height < 40 && el.getBoundingClientRect().height > 0);
      if (any) {
        click(any.closest('[role="button"]') || any);
        clicked++;
        await sleep(500);
      }
    }
    return clicked > 0;
  }

  /** All user labels from Settings → Labels (complete, includes hidden ones). Restores the previous view. */
  async function labelsFromSettingsPage() {
    const startHash = location.hash;
    await openLabelSettings();
    const names = [];
    for (const tr of qa("tr")) {
      if (!rowLink(tr, /^(show|hide|show if unread)$/i) || !rowLink(tr, /^(edit|remove)$/i)) continue;
      const first = tr.querySelector("td");
      let name = txt(first).replace(/\s*\(\d+\s*(conversations?|messages?)?\)\s*$/i, "").replace(/\s+\d+\s+(conversations?|unread)?.*$/i, "").trim();
      if (name && !/^(inbox|starred|snoozed|sent|drafts|spam|trash|important|all mail|scheduled|chats|categories)$/i.test(name)) names.push(name);
    }
    location.hash = startHash && !startHash.startsWith("#settings") ? startHash : "#inbox";
    await sleep(900);
    return names;
  }

  async function existingLabels({ deep = true } = {}) {
    let restore = async () => {};
    try {
      restore = await ensureSidebarExpanded();
      await expandMore();
    } catch {}
    const nav = labelsFromNav();
    await restore().catch(() => {});
    let menu = [];
    try {
      menu = await labelsFromMenu();
    } catch (e) {
      console.warn("[cleaner] label menu read failed", e.message);
    }
    let page = [];
    if (deep && menu.length === 0) {
      try {
        page = await labelsFromSettingsPage();
      } catch (e) {
        console.warn("[cleaner] settings label read failed", e.message);
      }
    }
    const all = new Map();
    for (const l of [...page, ...menu, ...nav]) if (l && !/^(inbox|starred|sent|drafts|spam|trash|important|all mail|snoozed|scheduled|chats|unread|categories|more)$/i.test(l) && !UNDO_LABEL_RE.test(l)) all.set(l.toLowerCase(), l);
    return [...all.values()];
  }

  function createLabelButton() {
    return (
      q('[role="button"][aria-label="Create new label"], [role="button"][data-tooltip="Create new label"]') ||
      q('div[role="button"][aria-label^="Create new label"]') ||
      qa('[role="button"], button').find((b) => /^create new label$/i.test(txt(b))) ||
      null
    );
  }

  /** Create a Gmail label through the sidebar "+" (or Settings → Labels) dialog. */
  async function createLabel(name) {
    let btn = createLabelButton();
    if (!btn) {
      // try the settings page, which always has a "Create new label" button
      location.hash = "#settings/labels";
      await sleep(1500);
      btn = await waitFor(createLabelButton, { timeout: 6000 });
    }
    if (!btn) throw new Error(`"Create new label" button not found. ${diag()}`);
    click(btn);
    const dlg = await waitFor(dialog, { timeout: 5000 });
    if (!dlg) throw new Error("Create label dialog did not open");
    const input = q("input[type='text'], input:not([type])", dlg) || q("input", dlg);
    if (!input) throw new Error("Label name field not found");
    typeInto(input, name);
    await sleep(200);
    const createBtn = dialogButton(/^create$/i);
    if (!createBtn) throw new Error("Create button not found");
    click(createBtn);
    await sleep(900);
    const err = dialog();
    if (err && /already exists|invalid|too long/i.test(txt(err))) {
      const cancel = dialogButton(/^(cancel|ok|close)$/i);
      if (cancel) click(cancel);
      throw new Error(txt(err).slice(0, 100));
    }
    return true;
  }

  const normLabel = (l) => String(l || "").trim().replace(/^\[|\]$/g, "").replace(/^[@#!]/, "").toLowerCase();
  function formatFor(labelFormat, existing, ours = []) {
    if (labelFormat && labelFormat !== "auto" && labelFormat.includes("{name}")) return labelFormat;
    // judge the user's own style from labels that are NOT our taxonomy (those may have been created plain by us)
    const mine = new Set(ours.map(normLabel));
    const user = existing.filter((l) => !mine.has(normLabel(l)) || /^\[.+\]$/.test(l));
    const br = user.filter((l) => /^\[.+\]$/.test(l)).length;
    return user.length && br * 2 >= user.length ? "[{name}]" : "{name}";
  }

  async function createLabels({ names, labelFormat }) {
    stopRequested = false;
    const startHash = location.hash;
    if (!location.hash.startsWith("#inbox")) {
      location.hash = "#inbox";
      await sleep(1200);
    }
    const existingList = await existingLabels();
    const fmt = formatFor(labelFormat, existingList, names);
    const existing = new Map(existingList.map((l) => [normLabel(l), l]));
    const out = { created: [], existing: [], failed: [], format: fmt };
    for (const name of names) {
      if (stopRequested) break;
      if (existing.has(normLabel(name))) {
        out.existing.push(existing.get(normLabel(name)));
        continue;
      }
      const real = fmt.replace("{name}", name);
      progress(`Creating label "${real}"…`);
      try {
        await createLabel(real);
        out.created.push(real);
        existing.set(normLabel(real), real);
      } catch (e) {
        out.failed.push({ name: real, error: e.message });
      }
    }
    out.labels = [...existing.values()];
    progress(`Labels: ${out.created.length} created, ${out.existing.length} already there${out.failed.length ? `, ${out.failed.length} failed` : ""}.`, out.failed.length ? "error" : "ok");
    hideBanner(5000);
    location.hash = startHash && !startHash.startsWith("#settings") ? startHash : "#inbox";
    return out;
  }

  // ---- Settings → Labels page: rename + visibility
  function settingsLabelRow(name) {
    const rows = qa("tr").filter((tr) => tr.querySelector("td") && rowLink(tr, /^(show|hide|show if unread|edit|remove)$/i));
    const exact = rows.find((tr) => [...tr.querySelectorAll("td, span, div")].some((el) => txt(el) === name && el.children.length <= 1));
    if (exact) return exact;
    return rows.find((tr) => txt(tr.querySelector("td")).split(/\s{2,}|\n/)[0].trim() === name) || rows.find((tr) => txt(tr).startsWith(name + " ")) || null;
  }
  function rowLink(row, re) {
    return qa('span[role="link"], a, button, div[role="button"]', row).find((el) => re.test(txt(el))) || null;
  }
  async function openLabelSettings() {
    if (!location.hash.startsWith("#settings/labels")) {
      location.hash = "#settings/labels";
      await sleep(1500);
    }
    const ok = await waitFor(() => qa("tr").some((tr) => rowLink(tr, /^(show|hide|show if unread)$/i)), { timeout: 10000 });
    if (!ok) {
      const links = qa('span[role="link"], a').map(txt).filter(Boolean).slice(0, 12);
      throw new Error(`Settings → Labels did not load (hash=${location.hash}, rows=${qa("tr").length}, links=${links.join("/")})`);
    }
  }
  async function renameLabel(from, to) {
    await openLabelSettings();
    const row = settingsLabelRow(from);
    if (!row) throw new Error(`label "${from}" not found in Settings → Labels (rows seen: ${qa("tr").filter((tr) => tr.querySelector("td")).slice(0, 12).map((tr) => txt(tr.querySelector("td")).slice(0, 25)).join(" | ")})`);
    const edit = rowLink(row, /^edit$/i);
    if (!edit) throw new Error(`no edit link for "${from}"`);
    click(edit);
    const dlg = await waitFor(dialog, { timeout: 5000 });
    if (!dlg) throw new Error("edit dialog did not open");
    const input = q("input", dlg);
    if (!input) throw new Error("name field not found");
    typeInto(input, to);
    await sleep(200);
    const save = dialogButton(/^(save|update|ok)$/i);
    if (!save) throw new Error("Save button not found");
    click(save);
    await sleep(900);
  }
  async function setLabelVisibility(name, mode) {
    await openLabelSettings();
    const row = settingsLabelRow(name);
    if (!row) throw new Error(`label "${name}" not found in Settings → Labels (rows seen: ${qa("tr").filter((tr) => tr.querySelector("td")).slice(0, 12).map((tr) => txt(tr.querySelector("td")).slice(0, 25)).join(" | ")})`);
    const re = mode === "hide" ? /^hide$/i : mode === "unread" ? /^show if unread$/i : /^show$/i;
    // the first group of links is "In label list", the second "In message list"; take the first match
    const link = rowLink(row, re);
    if (!link) return false; // already in that state (Gmail renders the active one as plain text)
    click(link);
    await sleep(500);
    return true;
  }

  // ---- sidebar ⋮ menu: color
  const GMAIL_COLORS = {
    red: [251, 76, 47], orange: [255, 173, 71], yellow: [250, 209, 101], green: [22, 167, 102], teal: [67, 214, 146],
    blue: [74, 134, 232], purple: [164, 121, 226], pink: [246, 145, 179], gray: [204, 204, 204], brown: [172, 46, 0],
  };
  function rgbOf(el) {
    const bg = getComputedStyle(el).backgroundColor || "";
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null;
    return [+m[1], +m[2], +m[3]];
  }
  function navLabelRow(name) {
    const a = qa('a[href*="#label/"]').find((x) => {
      const m = x.getAttribute("href").match(/#label\/([^?&]+)/);
      let n = "";
      try { n = decodeURIComponent(m?.[1] || "").replace(/\+/g, " "); } catch {}
      return n === name || txt(x) === name;
    });
    if (!a) return null;
    // climb to the row that owns the ⋮ options button (Gmail: div.TO inside div.aim)
    let el = a;
    for (let i = 0; i < 8 && el && el !== document.body; i++) {
      el = el.parentElement;
      if (el && (el.querySelector(".pM") || el.querySelector('[role="button"]') || el.classList.contains("TO") || el.classList.contains("aim"))) return el;
    }
    return a.closest(".TO, .aim, div[role='treeitem'], tr") || a.parentElement;
  }
  async function setLabelColor(name, colorName, { keepSidebar = false } = {}) {
    const target = GMAIL_COLORS[colorName];
    if (!target) return false;
    if (!location.hash.startsWith("#inbox")) {
      location.hash = "#inbox";
      await sleep(1200);
    }
    const restoreSidebar = keepSidebar ? async () => {} : await ensureSidebarExpanded();
    if (keepSidebar && sidebarCollapsed()) await ensureSidebarExpanded();
    let row = navLabelRow(name);
    if (!row) {
      await expandMore();
      row = await waitFor(() => navLabelRow(name), { timeout: 3000 });
    }
    if (!row) {
      await restoreSidebar();
      throw new Error(`label "${name}" not visible in the sidebar even after expanding More (nav width ${Math.round(navEl()?.getBoundingClientRect().width || 0)}px). Sidebar labels seen: ${labelsFromNav().slice(0, 15).join(", ")}`);
    }
    closeMenus();
    await sleep(250);
    row.scrollIntoView({ block: "center" });
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await sleep(300);
    const dots =
      row.querySelector(".pM") ||
      [...row.querySelectorAll('[role="button"]')].find((b) => /options|more|menu/i.test(b.getAttribute("aria-label") || b.getAttribute("data-tooltip") || "")) ||
      row.querySelector('[role="button"]:not([aria-label*="Create"])');
    if (!dots) throw new Error(`no options button on "${name}" row (buttons: ${[...row.querySelectorAll('[role="button"]')].map((b) => b.getAttribute("aria-label") || b.getAttribute("data-tooltip") || txt(b) || b.className.slice(0, 20)).join(" | ") || "none"}; row tag ${row.tagName}.${String(row.className).slice(0, 30)})`);
    let menu = null;
    for (let attempt = 0; attempt < 2 && !menu; attempt++) {
      click(dots);
      menu = await waitFor(() => qa('div[role="menu"]').find((m) => /label colou?r/i.test(txt(m))), { timeout: 3000 });
      if (!menu) {
        closeMenus();
        await sleep(400);
        row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await sleep(200);
      }
    }
    if (!menu) throw new Error(`label menu did not open (visible menus: ${qa('div[role="menu"]').map((m) => txt(m).slice(0, 60)).join(" || ") || "none"})`);
    const colorItem = qa('[role="menuitem"]', menu).find((it) => /label colou?r/i.test(txt(it))) || qa("div, span", menu).find((it) => /^(a\s*)?label colou?r$/i.test(txt(it)));
    if (!colorItem) throw new Error(`"Label color" item not found (items: ${qa('[role="menuitem"]', menu).map(txt).slice(0, 12).join(" | ")})`);
    colorItem.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    click(colorItem);
    await sleep(500);
    const sub = await waitFor(() => qa('div[role="menu"]').find((m) => m !== menu && !menu.contains(m) && /remove colou?r|custom colou?r/i.test(txt(m))), { timeout: 3000 });
    const scope = sub || document;
    const swatches = qa('[role="menuitem"], [role="menuitem"] *, div, span', scope).filter((el) => {
      if (menu.contains(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 10 && r.width <= 40 && r.height >= 10 && r.height <= 40 && rgbOf(el);
    });
    if (!swatches.length) throw new Error(`color palette not found (submenu: ${sub ? txt(sub).slice(0, 60) : "none"}; menus: ${qa('div[role="menu"]').length})`);
    let best = null, bd = Infinity;
    for (const sw of swatches) {
      const c = rgbOf(sw);
      const d = Math.hypot(c[0] - target[0], c[1] - target[1], c[2] - target[2]);
      if (d < bd) { bd = d; best = sw; }
    }
    click(best.closest('[role="menuitem"]') || best);
    await sleep(700);
    if (dialog()) {
      const ok = dialogOk();
      if (ok) click(ok);
    }
    closeMenus();
    await restoreSidebar();
    return true;
  }

  /** Create missing labels, rename to the chosen format, then: show all → color all → final visibility. */
  async function organizeLabels({ names, labelFormat, style }) {
    stopRequested = false;
    running = true;
    const startHash = location.hash;
    const created = await createLabels({ names, labelFormat });
    const fmt = created.format;
    const report = { ...created, renamed: [], colored: [], visibility: [], errors: created.failed.map((f) => `${f.name}: ${f.error}`) };
    const current = new Map(created.labels.map((l) => [normLabel(l), l]));

    // Phase A: rename plain names to the chosen style (Settings → Labels, one visit)
    for (const name of names) {
      if (stopRequested) break;
      const real = current.get(normLabel(name));
      if (!real) continue;
      const want = fmt.replace("{name}", name);
      if (real !== want && normLabel(real) === normLabel(name)) {
        progress(`Renaming "${real}" → "${want}"…`);
        try {
          await renameLabel(real, want);
          report.renamed.push(`${real} → ${want}`);
          current.set(normLabel(name), want);
        } catch (e) {
          report.errors.push(`rename ${real}: ${e.message}`);
        }
      }
    }

    const targets = names.map((name) => ({ name, real: current.get(normLabel(name)), st: style?.[name] || {} })).filter((t) => t.real);
    const toColor = targets.filter((t) => t.st.color);

    // Phase B: make every label we need to color visible (one Settings visit)
    if (toColor.length && !stopRequested) {
      progress(`Showing ${toColor.length} label(s) in the sidebar so they can be colored…`);
      for (const t of toColor) {
        if (stopRequested) break;
        try {
          await setLabelVisibility(t.real, "show");
        } catch (e) {
          report.errors.push(`show ${t.real}: ${e.message}`);
        }
      }
      location.hash = "#inbox";
      await sleep(1500);
    }

    // Phase C: color everything in one sidebar session
    if (toColor.length && !stopRequested) {
      let restoreSidebar = async () => {};
      try {
        restoreSidebar = await ensureSidebarExpanded();
      } catch (e) {
        report.errors.push(`sidebar: ${e.message}`);
      }
      await expandMore().catch(() => {});
      for (const t of toColor) {
        if (stopRequested) break;
        progress(`Coloring "${t.real}" ${t.st.color}…`);
        try {
          if (await setLabelColor(t.real, t.st.color, { keepSidebar: true })) report.colored.push(`${t.real}: ${t.st.color}`);
        } catch (e) {
          report.errors.push(`color ${t.real}: ${e.message}`);
        }
      }
      await restoreSidebar().catch(() => {});
    }

    // Phase D: final visibility for every label (one Settings visit)
    for (const t of targets) {
      if (stopRequested) break;
      if (!t.st.show) continue;
      try {
        await setLabelVisibility(t.real, t.st.show);
        report.visibility.push(`${t.real}: ${t.st.show}`);
      } catch (e) {
        report.errors.push(`visibility ${t.real}: ${e.message}`);
      }
    }

    report.labels = [...current.values()];
    running = false;
    await browser.storage.local.set({ lastToolReport: { at: Date.now(), tool: "organizeLabels", ...report }, knownLabels: report.labels }).catch(() => {});
    progress(`Labels organized: ${report.created.length} created, ${report.renamed.length} renamed, ${report.colored.length} colored${report.errors.length ? `, ${report.errors.length} error(s)` : ""}.`, report.errors.length ? "error" : "ok");
    hideBanner(6000);
    location.hash = startHash && !startHash.startsWith("#settings") ? startHash : "#inbox";
    return report;
  }

  async function clearSelection() {
    const cb = selectAllCheckbox();
    if (!cb) return;
    if (cb.getAttribute("aria-checked") !== "false") {
      click(cb);
      await sleep(250);
      if (cb.getAttribute("aria-checked") === "true") {
        click(cb);
        await sleep(250);
      }
    }
    for (const tr of rows()) {
      const c = rowCheckbox(tr);
      if (c.getAttribute && c.getAttribute("aria-checked") === "true") click(c);
    }
  }

  const labelMenuOpen = () => qa('div[role="menu"]').find((m) => m.querySelector("input") && /label/i.test(txt(m)) && !/move to/i.test(txt(m).slice(0, 20)));

  /** Opens Gmail's "Label as" menu for the current selection. Works with both toolbars:
   *  advanced (Labels button) and simplified (⋮ More → Label as ▸). Returns the menu element with the search input. */
  async function openLabelMenu() {
    if (!(await waitFor(toolbar, { timeout: 4000 }))) throw new Error(`message-list toolbar not found. ${diag()}`);
    const direct = toolbarButton("Label");
    if (direct) {
      click(direct);
      const m = await waitFor(labelMenuOpen, { timeout: 4000 });
      if (m) return m;
      closeMenus();
      await sleep(300);
    }
    const more = toolbarButton("More") || toolbarButtons().find((b) => b.getAttribute("aria-haspopup") === "true" && /^(\|)*\s*(more|options)/i.test(btnLabel(b)) && !/search/i.test(btnLabel(b)));
    if (!more) throw new Error(`Neither a "Labels" button nor a "More" (⋮) button in the toolbar. Toolbar buttons: ${toolbarDiag()}. ${diag()}`);
    click(more);
    const menu = await waitFor(() => qa('div[role="menu"]').find((m) => /label as/i.test(txt(m))), { timeout: 4000 });
    if (!menu) throw new Error(`"More" menu did not open or has no "Label as" (menus: ${qa('div[role="menu"]').map((m) => txt(m).slice(0, 50)).join(" || ") || "none"})`);
    const item = qa('[role="menuitem"]', menu).find((it) => /^label as/i.test(txt(it))) || qa("div, span", menu).find((it) => /^label as$/i.test(txt(it)));
    if (!item) throw new Error('"Label as" item not found in More menu');
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await sleep(300);
    let sub = labelMenuOpen();
    if (!sub) {
      click(item);
      sub = await waitFor(labelMenuOpen, { timeout: 4000 });
    }
    if (!sub) throw new Error(`"Label as" submenu did not open (menus: ${qa('div[role="menu"]').map((m) => txt(m).slice(0, 40)).join(" || ")})`);
    return sub;
  }

  /** Gmail "Label as" menu → tick label → Apply. Keeps mail where it is. Creates the label if missing; remove unticks it instead. */
  async function labelAs(label, { remove = false } = {}) {
    const menu = await openLabelMenu();
    typeInto(menu.querySelector("input"), label);
    await sleep(600);
    const items = () => qa('[role="menuitemcheckbox"], [role="menuitem"], [role="option"]', menu);
    const exact = items().find((it) => txt(it).replace(/\s*\(\d+\)$/, "").toLowerCase() === label.toLowerCase());
    if (exact) {
      if (!remove) {
        if (exact.getAttribute("aria-checked") !== "true") click(exact);
      } else if (exact.getAttribute("aria-checked") !== "false") {
        click(exact);
        await sleep(200);
        if (exact.getAttribute("aria-checked") === "true") click(exact); // was mixed: the second click clears it
      }
      await sleep(400);
      // classic menu shows an Apply button after ticking; the simplified submenu applies immediately
      const apply = qa('[role="button"], div.J-N, button', menu).find((b) => /^apply$/i.test(txt(b)));
      if (apply) click(apply);
      else if (labelMenuOpen()) closeMenus();
    } else if (remove) {
      closeMenus();
      throw new Error(`label "${label}" not in the Label as menu`);
    } else {
      const create = items().find((it) => /create new/i.test(txt(it)));
      if (!create) throw new Error(`Label "${label}" not found and no "Create new". ${diag()}`);
      click(create);
      const dlg = await waitFor(dialog, { timeout: 5000 });
      if (!dlg) throw new Error("New label dialog did not open");
      const nameInput = q("input", dlg);
      if (nameInput && nameInput.value !== label) typeInto(nameInput, label);
      await sleep(200);
      const createBtn = dialogButton(/^create$/i);
      if (!createBtn) throw new Error("Create button not found");
      click(createBtn);
    }
    const ok = await waitFor(dialogOk, { timeout: 1500 });
    if (ok) click(ok);
    await sleep(900);
    await clearSelection();
  }

  // ------------------------------------------------------------ subscriptions (Gmail "Manage subscriptions")

  function unsubButtons() {
    return qa('[role="button"], button').filter((b) => /^unsubscribe$/i.test(txt(b)) && !b.closest('[role="dialog"], [role="alertdialog"]'));
  }

  function subscriptionRowOf(btn) {
    let el = btn;
    for (let i = 0; i < 10 && el && el !== document.body; i++) {
      el = el.parentElement;
      if (!el) break;
      const t = txt(el);
      if (el.querySelector("[email]") || /[\w.+-]+@[\w-]+\.[\w.-]+/.test(t)) {
        // stop at the smallest ancestor that has sender info but only ONE unsubscribe button
        if (el.querySelectorAll('[role="button"], button').length < 6 || [...el.querySelectorAll('[role="button"], button')].filter((b) => /^unsubscribe$/i.test(txt(b))).length === 1)
          return el;
      }
    }
    return btn.parentElement?.parentElement || btn.parentElement;
  }

  function parseSubscriptionRow(row) {
    const t = txt(row);
    const emailEl = row.querySelector("[email]");
    const email = (emailEl?.getAttribute("email") || (t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [""])[0]).toLowerCase();
    const name = emailEl?.getAttribute("name") || emailEl?.getAttribute("title") || t.replace(email, "").replace(/unsubscribe/i, "").replace(/\d[\d,]*\s*(emails?|messages?|mails?).*$/i, "").trim().slice(0, 60) || email;
    const cm = t.replace(/,/g, "").match(/(\d+)\s*(emails?|messages?|mails?)/i);
    return { email, name, count: cm ? Number(cm[1]) : null, text: t.slice(0, 200) };
  }

  /** Gmail's sidebar link to "Manage subscriptions" (hidden under "More" by default). */
  function subscriptionsNavLink() {
    return [...document.querySelectorAll('div[role="navigation"] a[href]')].find((a) => [txt(a), a.getAttribute("aria-label") || ""].some((t) => /^manage subscriptions/i.test(t))) || null;
  }

  const SUBS_HASH = "#sub"; // Gmail "Manage subscriptions" (sidebar → More)

  /** Go to a view and wait for its Unsubscribe buttons. */
  async function showSubscriptions(hash) {
    const before = unsubButtons().length;
    location.hash = hash;
    await sleep(1200);
    return !!(await waitFor(() => unsubButtons().length && (unsubButtons().length !== before || location.hash === hash), { timeout: 10000 }));
  }

  /** Opens "Manage subscriptions". Returns true, or why it could not. */
  async function openSubscriptions() {
    let ok = await showSubscriptions(SUBS_HASH);
    if (!ok) {
      // Gmail may have moved it: take the address from the sidebar link
      let link = subscriptionsNavLink();
      if (!link) {
        await expandMore();
        closeMenus(); // in case a toolbar "More" menu opened instead
        link = await waitFor(subscriptionsNavLink, { timeout: 3000 });
      }
      const hash = (link?.getAttribute("href") || "").match(/#.+$/)?.[0];
      if (hash && hash !== SUBS_HASH) ok = await showSubscriptions(hash);
    }
    if (!ok) return `Gmail "Manage subscriptions" (${SUBS_HASH}) showed no Unsubscribe buttons.`;
    // let the list finish rendering / lazy-load
    let last = -1;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const n = unsubButtons().length;
      if (n === last) break;
      last = n;
      window.scrollTo(0, document.body.scrollHeight);
      const main = mainView();
      if (main) main.scrollTop = main.scrollHeight;
    }
    return true;
  }

  async function listSubscriptions() {
    const opened = await openSubscriptions();
    if (opened !== true) throw new Error(opened);
    const seen = new Map();
    for (const b of unsubButtons()) {
      const row = subscriptionRowOf(b);
      const p = parseSubscriptionRow(row);
      if (p.email && !seen.has(p.email)) seen.set(p.email, p);
    }
    return [...seen.values()];
  }

  /** After clicking an Unsubscribe button or link: answer Gmail's dialog. Returns the outcome status. */
  async function confirmUnsubscribe() {
    const dlg = await waitFor(dialog, { timeout: 4000 });
    if (!dlg) {
      // some rows unsubscribe instantly
      await sleep(800);
      return "clicked";
    }
    const confirmBtn = dialogButton(/^unsubscribe$/i);
    if (confirmBtn) {
      click(confirmBtn);
      await sleep(900);
      // follow-up dialog (e.g. "Move to trash?") – decline politely
      if (dialog()) {
        const no = dialogButton(/^(no thanks|cancel|not now|close|done|ok)$/i);
        if (no) click(no);
        else closeMenus();
        await sleep(400);
      }
      return "done";
    }
    const site = dialogButton(/go to website|visit|open/i);
    const cancel = dialogButton(/^(cancel|close|no thanks|not now)$/i);
    if (cancel) click(cancel);
    else closeMenus();
    await sleep(400);
    return site ? "needs-website" : "no-confirm";
  }

  // the "Unsubscribe" link Gmail shows next to the sender of an open message; never a link inside the mail body
  function headerUnsubLink() {
    const main = mainView() || document;
    const ok = (el) => /^unsubscribe$/i.test(txt(el)) && !el.closest('.a3s, a[href], [role="dialog"], [role="alertdialog"]');
    return qa('[role="link"], [role="button"]', main).filter(ok).pop() || qa("span", main).filter(ok).pop() || null;
  }

  /** Open the sender's newest mail and use the Unsubscribe link in its header. */
  async function unsubscribeViaMessage(email) {
    await openSearch(`from:(${email})`);
    const tr = rows().find((r) => parseRow(r).email === email) || rows()[0];
    if (!tr) return "not-found";
    click(tr.querySelector("span.bog") || tr);
    await waitFor(() => !rows().length || headerUnsubLink(), { timeout: 8000 }); // thread view open
    const link = headerUnsubLink() || (await waitFor(headerUnsubLink, { timeout: 2500 }));
    if (!link) return "no-link";
    click(link);
    return confirmUnsubscribe();
  }

  /** Unsubscribe each email: on Gmail's subscriptions page when it exists (via "page"), else from the sender's latest mail. */
  async function unsubscribeMany(emails, via = "page") {
    const out = [];
    let rest = emails;
    if (via === "page" && (await openSubscriptions()) === true) {
      rest = [];
      for (const email of emails) {
        if (stopRequested) break;
        progress(`Unsubscribing ${email}…`);
        const btn = unsubButtons().find((b) => parseSubscriptionRow(subscriptionRowOf(b)).email === email);
        if (!btn) {
          rest.push(email);
          continue;
        }
        click(btn);
        out.push({ email, status: await confirmUnsubscribe() });
      }
    }
    for (const email of rest) {
      if (stopRequested) break;
      progress(`Unsubscribing ${email} from its latest mail…`);
      try {
        out.push({ email, status: await unsubscribeViaMessage(email) });
      } catch (e) {
        out.push({ email, status: "error", error: e.message });
      }
    }
    return out;
  }

  // ------------------------------------------------------------ navigation

  function snapshot() {
    const r = rows();
    return `${pagerCount()}|${r.length}|${r[0] ? parseRow(r[0]).id : ""}|${noResults()}`;
  }

  async function waitSettled(before) {
    await sleep(700);
    await waitFor(() => snapshot() !== before || rows().length || noResults(), { timeout: 12000 });
    let last = snapshot();
    for (let i = 0; i < 30; i++) {
      await sleep(450);
      const cur = snapshot();
      if (cur === last && (rows().length || noResults())) break;
      last = cur;
    }
  }

  async function openSearch(query) {
    const target = "#search/" + encodeURIComponent(query);
    const before = snapshot();
    if (location.hash === target) {
      location.hash = "#inbox";
      await sleep(400);
    }
    location.hash = target;
    await waitSettled(before);
  }

  async function nextPage() {
    const b = olderButton();
    if (!b) return false;
    const before = snapshot();
    click(b);
    await waitSettled(before);
    return snapshot() !== before;
  }

  function buildQuery(rule, allowlist, excludeLabels, restoredLabel) {
    let s = rule.query.trim();
    // safety: never touch archived mail unless the rule explicitly opts out
    if (rule.inboxOnly !== false && !/\bin:(inbox|anywhere|all)\b/i.test(s)) s = `in:inbox ${s}`;
    const list = (allowlist || []).map((x) => x.trim()).filter(Boolean);
    if (list.length) s += ` -from:(${list.join(" OR ")})`;
    // AI rules skip mail that already carries one of the labels we assign (handled by retention instead)
    if (rule.type === "ai" && excludeLabels?.length) s += ` -{${excludeLabels.map(labelTerm).join(" ")}}`;
    // mail you brought back with Undo stays out of every rule
    if (restoredLabel) s += ` -${labelTerm(restoredLabel)}`;
    return s;
  }

  // ------------------------------------------------------------ actions

  async function waitSelectionCleared() {
    await waitFor(() => {
      const c = selectAllCheckbox();
      return !c || c.getAttribute("aria-checked") !== "true";
    }, { timeout: 20000 });
    await sleep(1000);
  }

  /** Gmail "Move to" → label. Labels + archives. Creates the label on first use. */
  async function moveToLabel(label) {
    const btn = await waitFor(() => toolbarButton("Move to"), { timeout: 6000 });
    if (!btn) throw new Error(`"Move to" button not found. Toolbar buttons: ${toolbarDiag()}. ${diag()}`);
    click(btn);
    const menu = await waitFor(() => qa('div[role="menu"]').find((m) => m.querySelector("input")), { timeout: 5000 });
    if (!menu) throw new Error(`"Move to" menu did not open. ${diag()}`);
    const input = menu.querySelector("input");
    typeInto(input, label);
    await sleep(600);
    const items = () => qa('[role="menuitem"], [role="menuitemcheckbox"], [role="option"], div.J-N', menu);
    const exact = items().find((it) => txt(it).toLowerCase() === label.toLowerCase() || txt(it).toLowerCase().endsWith("/" + label.toLowerCase().split("/").pop()) && txt(it).toLowerCase().includes(label.toLowerCase()));
    if (exact) {
      click(exact);
    } else {
      const create = items().find((it) => /create new/i.test(txt(it)));
      if (!create) throw new Error(`Label "${label}" not in "Move to" menu and no "Create new" entry. ${diag()}`);
      click(create);
      const dlg = await waitFor(dialog, { timeout: 5000 });
      if (!dlg) throw new Error("New label dialog did not open");
      const nameInput = q("input", dlg);
      if (nameInput && txt(nameInput) !== label && nameInput.value !== label) typeInto(nameInput, label);
      await sleep(200);
      const createBtn = dialogButton(/^create$/i);
      if (!createBtn) throw new Error("Create button not found in new label dialog");
      click(createBtn);
    }
    // bulk confirm, if Gmail asks
    const ok = await waitFor(dialogOk, { timeout: 2500 });
    if (ok) click(ok);
    await waitSelectionCleared();
  }

  async function fireAction(rule) {
    const action = rule.action;
    if (action === "label") {
      const label = (rule.label || "Cleaned").trim();
      try {
        await moveToLabel(label);
        return;
      } catch (e) {
        // fall back to plain archive so the run still cleans; surface the warning
        rule.__warn = `Label "${label}" failed (${e.message}); archived instead.`;
        closeMenus();
        await sleep(300);
      }
    }
    const btnName = action === "delete" ? "Delete" : "Archive";
    const btn = await waitFor(() => toolbarButton(btnName), { timeout: 6000 });
    if (!btn) throw new Error(`${btnName} button not found. ${diag()}`);
    click(btn);
    const ok = await waitFor(dialogOk, { timeout: 2500 });
    if (ok) click(ok);
    await waitSelectionCleared();
  }

  /** Tick every row, then Gmail's "Select all N conversations". */
  async function selectAllMatching() {
    const cb = await waitFor(selectAllCheckbox, { timeout: 5000 });
    if (!cb) throw new Error(`Select-all checkbox not found. ${diag()}`);
    if (cb.getAttribute("aria-checked") !== "true") click(cb);
    const checked = await waitFor(() => cb.getAttribute("aria-checked") === "true" || qa('tr.zA [role="checkbox"][aria-checked="true"]').length, { timeout: 4000 });
    if (!checked) {
      for (const tr of rows()) click(rowCheckbox(tr));
      await sleep(400);
    }
    await sleep(400);
    const link = selectAllMatchingLink();
    if (link) {
      click(link);
      await sleep(600);
    }
  }

  /** Tag the selection with this run's undo label before it is trashed or archived. A failure only costs the undo. */
  async function markForUndo(rule, select) {
    if (!undo?.label || undo.warn || rule.action === "label") return;
    try {
      await select();
      await labelAs(undo.label);
      undo.marked = true;
    } catch (e) {
      undo.warn = `Undo label failed, the rest of this run cannot be undone: ${e.message}`;
      closeMenus();
      await sleep(300);
      await clearSelection();
    }
  }
  const noteLabeled = (label, ids) => {
    if (undo) (undo.labeled[label] = undo.labeled[label] || []).push(...ids);
  };

  async function bulkAction(rule) {
    await markForUndo(rule, selectAllMatching);
    await selectAllMatching();
    await fireAction(rule);
  }

  async function rowAction(trs, rule) {
    // select by thread id: labeling for undo re-renders the rows
    const ids = new Set(trs.map((tr) => parseRow(tr).id));
    const select = async () => {
      for (const [id, list] of rowsById()) {
        if (!ids.has(id)) continue;
        for (const tr of list) {
          const cb = rowCheckbox(tr);
          if (cb.getAttribute && cb.getAttribute("aria-checked") === "true") continue;
          click(cb);
          await sleep(60);
        }
      }
      await sleep(400);
    };
    await markForUndo(rule, select);
    await select();
    await fireAction(rule);
  }

  async function moveToInbox() {
    const direct = await waitFor(() => toolbarButton("Move to Inbox"), { timeout: 3000 });
    if (!direct) return moveToLabel("Inbox");
    click(direct);
    const ok = await waitFor(dialogOk, { timeout: 2500 });
    if (ok) click(ok);
    await waitSelectionCleared();
  }

  /** Settings → Labels → remove. Mail keeps its place, only the label goes. False if it was already gone. */
  async function deleteLabel(name) {
    await openLabelSettings();
    const row = settingsLabelRow(name);
    if (!row) return false;
    const rm = rowLink(row, /^remove$/i);
    if (!rm) throw new Error(`no remove link for "${name}"`);
    click(rm);
    if (!(await waitFor(dialog, { timeout: 5000 }))) throw new Error("remove label dialog did not open");
    const del = dialogButton(/^(delete|remove|ok)$/i);
    if (!del) throw new Error("Delete button not found in the remove label dialog");
    click(del);
    await sleep(900);
    return true;
  }

  /** Take a label off specific threads: search the label, tick those rows page by page, untick it in "Label as". */
  async function unlabelIds(label, ids) {
    const todo = new Set(ids);
    const done = [];
    const query = labelTerm(label);
    await openSearch(query);
    for (let i = 0; i < 20 && todo.size && !stopRequested && rows().length; i++) {
      const hit = [...rowsById()].filter(([id]) => todo.has(id));
      if (!hit.length) {
        if (!(await nextPage())) break;
        continue;
      }
      for (const [, list] of hit) for (const tr of list) if (rowCheckbox(tr).getAttribute?.("aria-checked") !== "true") click(rowCheckbox(tr));
      await sleep(300);
      await labelAs(label, { remove: true });
      for (const [id] of hit) {
        todo.delete(id);
        done.push(id);
      }
      await openSearch(query); // unlabeled rows drop out of the results
    }
    return done;
  }

  /** Delete expired undo labels. Returns the ones that are gone. */
  async function dropUndoLabels(labels) {
    const gone = [];
    for (const l of labels || []) {
      if (stopRequested) break;
      progress(`Removing expired undo label "${l}"…`);
      try {
        await deleteLabel(l);
        gone.push(l);
      } catch (e) {
        console.warn("[Inbox Broom] undo label not removed:", l, e.message);
      }
    }
    return gone;
  }

  const undoReport = () => (undo && (undo.marked || Object.keys(undo.labeled).length) ? { label: undo.marked ? undo.label : null, labeled: undo.labeled, warn: undo.warn || null } : null);

  /**
   * Undo a run: tag its trashed/archived mail "Broom restored" (rules skip that label, so the next run leaves it),
   * move it back to the Inbox, delete the run's undo label, and take its AI labels off again.
   */
  async function undoRun({ at, label, labeled, restoredLabel }) {
    if (running) throw new Error("Already running");
    running = true;
    keepAlive(true);
    stopRequested = false;
    const startHash = location.hash;
    const out = { at, restored: 0, unlabeled: 0, unlabeledIds: [], labelDropped: false, warnings: [] };
    try {
      for (const { label: l, ids } of labeled || []) {
        if (stopRequested) break;
        progress(`Undo: removing "${l}" from ${ids.length} mail(s)…`);
        try {
          const done = await unlabelIds(l, ids);
          out.unlabeled += done.length;
          out.unlabeledIds.push(...done);
        } catch (e) {
          out.warnings.push(`"${l}" not removed: ${e.message}`);
          closeMenus();
          await clearSelection();
        }
      }
      if (label && !stopRequested) {
        const query = `in:anywhere -in:inbox ${labelTerm(label)}`;
        await openSearch(query);
        const total = readCount();
        for (let pass = 0; pass < 10 && readCount() > 0 && !stopRequested; pass++) {
          progress(`Undo: moving ${readCount()} conversation(s) back to the Inbox…`);
          await selectAllMatching();
          await labelAs(restoredLabel);
          await selectAllMatching();
          await moveToInbox();
          await openSearch(query);
        }
        out.restored = total - readCount();
        if (readCount() === 0 && !stopRequested) {
          try {
            await deleteLabel(label);
            out.labelDropped = true;
          } catch (e) {
            out.warnings.push(`Undo label "${label}" not removed: ${e.message}`);
          }
        }
      }
      if (stopRequested) out.error = "Stopped";
      progress(`Undone: ${out.restored} back in the Inbox, ${out.unlabeled} unlabeled.${out.warnings.length ? ` ${out.warnings.join(" | ")}` : ""}`, out.warnings.length ? "error" : "ok");
      location.hash = startHash && !/^#(search|settings)/.test(startHash) ? startHash : "#inbox";
      hideBanner(6000);
    } catch (e) {
      out.error = e.message;
      progress(`Undo error: ${e.message}`, "error");
      console.error("[Inbox Broom]", e, diag());
      hideBanner(10000);
    } finally {
      running = false;
      keepAlive(false);
      browser.storage.local.set({ progress: { text: "", at: Date.now(), running: false } }).catch(() => {});
    }
    await browser.__send({ type: "undoFinished", ...out }).catch(() => {});
    return out;
  }

  // ------------------------------------------------------------ rules

  async function runQueryRule(rule, query, mode, entry) {
    await openSearch(query);
    entry.count = readCount();
    entry.items = rows().slice(0, 40).map(parseRow);
    if (mode !== "clean" || entry.count === 0) return;
    for (let pass = 0; pass < 20 && !stopRequested; pass++) {
      progress(`Cleaning: ${rule.name} – ${readCount()} left (${rule.action})…`);
      await bulkAction(rule);
      await openSearch(query);
      if (readCount() === 0) break;
    }
    entry.done = entry.count - readCount();
  }

  async function runAiRule(rule, query, mode, entry, ctx) {
    await openSearch(query);
    entry.count = readCount();
    const maxPages = Math.max(1, Number(rule.maxPages) || 10);
    const cache = ctx.aiCache || {};
    let page = 0;
    const seenIds = new Set();
    while (page < maxPages && !stopRequested) {
      page++;
      const trs = rows();
      if (!trs.length) break;
      const parsed = trs.map(parseRow);
      if (parsed.every((p) => seenIds.has(p.id))) break;
      parsed.forEach((p) => seenIds.add(p.id));
      const uniq = new Map();
      for (const p of parsed) if (!uniq.has(p.id)) uniq.set(p.id, p);

      const needsLabel = (c) => ctx.labels?.length && !c.junk && !c.label && !c.labeled && !c.manual;
      const toAsk = [...uniq.values()].filter((p) => !(p.id in cache) || needsLabel(cache[p.id]) || (cache[p.id].manual !== true && mode === "scan" && ctx.rescore));
      progress(`${mode === "scan" ? "Previewing" : "Cleaning"}: ${rule.name} – page ${page}/${maxPages}, AI checking ${toAsk.length} mail(s)…`);
      if (toAsk.length) {
        const verdicts = await browser.__send({ type: "aiClassify", items: toAsk, rule, labels: ctx.labels });
        if (verdicts?.error) throw new Error(verdicts.error);
        const merged = {};
        const importantIds = new Set(toAsk.filter((p) => p.important).map((p) => p.id));
        for (const v of verdicts) {
          if (v.junk && importantIds.has(v.id) && v.source !== "manual") {
            v.junk = false;
            v.reason = `${v.reason || ""} – kept: Gmail marked it important`.replace(/^ – /, "");
          }
          const prev = cache[v.id];
          const relabelOnly = prev && !prev.junk && !prev.label && !v.junk;
          merged[v.id] = cache[v.id] = relabelOnly
            ? { ...prev, label: v.label || "", at: Date.now() }
            : { junk: !!v.junk, score: v.score, reason: v.reason || "", source: v.source, label: v.label || "", at: Date.now() };
        }
        ctx.aiCache = cache;
        browser.runtime.sendMessage({ type: "aiCacheMerge", entries: merged }).catch(() => {});
      }
      const junkTrs = [];
      const labelGroups = new Map();
      const listed = new Set();
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i];
        const v = cache[p.id] || { junk: false, reason: "", score: 0 };
        if (!listed.has(p.id)) {
          listed.add(p.id);
          entry.items.push({ ...p, junk: v.junk, reason: v.reason, score: v.score, source: v.source, label: v.label || "", page });
          if (!v.junk && v.label && !v.labeled) (labelGroups.get(v.label) || labelGroups.set(v.label, []).get(v.label)).push(p.id);
        }
        if (v.junk) junkTrs.push(trs[i]);
      }
      if (mode === "clean" && labelGroups.size) {
        for (const [label, ids] of labelGroups) {
          if (stopRequested) break;
          progress(`Labeling ${ids.length} mail(s) as "${label}" (page ${page})…`);
          const byId = rowsById();
          const lt = ids.flatMap((id) => byId.get(id) || []);
          if (!lt.length) continue;
          try {
            for (const tr of lt) {
              click(rowCheckbox(tr));
              await sleep(50);
            }
            await sleep(300);
            await labelAs(label);
            noteLabeled(label, ids);
            entry.labeled = (entry.labeled || 0) + lt.length;
            const merged = {};
            for (const id of ids) if (cache[id]) merged[id] = cache[id] = { ...cache[id], labeled: true };
            browser.runtime.sendMessage({ type: "aiCacheMerge", entries: merged }).catch(() => {});
          } catch (e) {
            entry.warnings.push(`Label "${label}" failed: ${e.message}`);
            await clearSelection();
          }
        }
      }
      if (mode === "clean" && junkTrs.length) {
        progress(`Cleaning: ${rule.name} – ${rule.action} ${junkTrs.length} of ${parsed.length} on page ${page}…`);
        await rowAction(junkTrs, rule);
        entry.done += junkTrs.length;
        await openSearch(query);
        let guard = 0;
        while (rows().length && rows().map(parseRow).every((p) => seenIds.has(p.id)) && guard++ < maxPages) {
          if (!(await nextPage())) break;
        }
        continue;
      }
      if (!(await nextPage())) break;
    }
  }

  async function run({ mode, rules, allowlist, returnToInbox, aiCache, rescore, subscriptions, excludeLabels, undoLabel, dropLabels, restoredLabel }) {
    if (running) throw new Error("Already running");
    running = true;
    keepAlive(true);
    stopRequested = false;
    undo = mode === "clean" && undoLabel ? { label: undoLabel, marked: false, labeled: {}, warn: null } : null;
    const startHash = location.hash;
    const results = [];
    const ctx = { aiCache: aiCache || {}, rescore: !!rescore, labels: [] };
    let total = 0;
    try {
      if (rules.some((r) => r.type === "ai")) {
        progress("Reading your Gmail labels…");
        if (!location.hash.startsWith("#inbox")) {
          location.hash = "#inbox";
          await sleep(1200);
        }
        ctx.labels = await existingLabels();
      }
      for (const rule of rules) {
        if (stopRequested) break;
        const query = buildQuery(rule, allowlist, excludeLabels, restoredLabel);
        progress(`${mode === "scan" ? "Previewing" : "Cleaning"}: ${rule.name}…`);
        const entry = { rule, query, count: 0, done: 0, items: [], warnings: [] };
        if (rule.type === "ai") await runAiRule(rule, query, mode, entry, ctx);
        else await runQueryRule(rule, query, mode, entry);
        if (rule.__warn) entry.warnings.push(rule.__warn);
        total += entry.done;
        results.push(entry);
      }
      let subs = null;
      if (mode === "scan" && subscriptions && !stopRequested) {
        progress("Reading Gmail subscriptions…");
        try {
          subs = await listSubscriptions();
        } catch (e) {
          subs = { error: e.message };
        }
      }
      const droppedLabels = mode === "clean" ? await dropUndoLabels(dropLabels) : [];
      const matched = results.reduce((n, r) => n + (r.rule.type === "ai" ? r.items.filter((i) => i.junk).length : r.count), 0);
      progress(mode === "scan" ? `Preview done: ${matched} to clean.` : `Done: ${total} conversation(s) cleaned.`, "ok");
      if (returnToInbox) location.hash = startHash && !startHash.startsWith("#search/") ? startHash : "#inbox";
      hideBanner(4000);
      const out = {
        mode,
        results,
        labels: ctx.labels,
        subscriptions: subs,
        total,
        stopped: stopRequested,
        summary: results.map((r) => ({ rule: r.rule.name, action: r.rule.action, count: r.done })),
        undo: undoReport(),
        droppedLabels,
      };
      if (mode === "scan") await browser.__send({ type: "scanFinished", ...out }).catch((e) => progress(`Error saving preview: ${e.message}`, "error"));
      else await browser.__send({ type: "runFinished", ...out }).catch(() => {});
      return out;
    } catch (e) {
      progress(`Error: ${e.message}`, "error");
      console.error("[Inbox Broom]", e, diag());
      hideBanner(10000);
      browser.storage.local.set({ runError: { at: Date.now(), mode, message: e.message } }).catch(() => {});
      throw e;
    } finally {
      running = false;
      keepAlive(false);
      browser.storage.local.set({ progress: { text: "", at: Date.now(), running: false } }).catch(() => {});
    }
  }

  /** id → [rows]. With conversation view off, several rows can share one thread id. */
  function rowsById() {
    const map = new Map();
    for (const tr of rows()) {
      const id = parseRow(tr).id;
      (map.get(id) || map.set(id, []).get(id)).push(tr);
    }
    return map;
  }

  /**
   * plan = {
   *   bulk: [{ rule }],                                  // bulk rules to execute fully (action from rule)
   *   ai:   [{ rule, query, deleteIds: [], labels: { "Label": [ids] }, maxPages }],
   * }
   */
  async function apply({ plan, allowlist, returnToInbox, undoLabel, dropLabels, restoredLabel }) {
    if (running) throw new Error("Already running");
    running = true;
    keepAlive(true);
    stopRequested = false;
    undo = undoLabel ? { label: undoLabel, marked: false, labeled: {}, warn: null } : null;
    const startHash = location.hash;
    const summary = [];
    let total = 0;
    try {
      // unsubscribe first: the per-mail route needs the sender's mail before it goes to Trash
      let unsub = [];
      if ((plan.unsubscribe || []).length && !stopRequested) {
        try {
          unsub = await unsubscribeMany(plan.unsubscribe, plan.unsubscribeVia);
        } catch (e) {
          unsub = plan.unsubscribe.map((email) => ({ email, status: "error", error: e.message }));
        }
      }
      for (const b of plan.bulk || []) {
        if (stopRequested) break;
        const rule = b.rule;
        const query = buildQuery(rule, allowlist, null, restoredLabel);
        const entry = { rule, query, count: 0, done: 0, items: [] };
        progress(`Cleaning: ${rule.name}…`);
        await runQueryRule(rule, query, "clean", entry);
        total += entry.done;
        summary.push({ rule: rule.name, action: rule.action, count: entry.done });
      }
      for (const a of plan.ai || []) {
        if (stopRequested) break;
        const rule = a.rule;
        const query = a.query || buildQuery(rule, allowlist, null, restoredLabel);
        const del = new Set(a.deleteIds || []);
        const labelOf = new Map();
        for (const [label, ids] of Object.entries(a.labels || {})) for (const id of ids) labelOf.set(id, label);
        const pending = new Set([...del, ...labelOf.keys()]);
        let done = 0, labeled = 0, warn = null;
        await openSearch(query);
        for (let page = 1; page <= (a.maxPages || 20) && pending.size && !stopRequested; page++) {
          // 1) labels first (rows stay in place)
          const groups = new Map();
          for (const [id] of rowsById()) {
            const l = labelOf.get(id);
            if (l && pending.has(id)) (groups.get(l) || groups.set(l, []).get(l)).push(id);
          }
          for (const [label, ids] of groups) {
            if (stopRequested) break;
            const byId = rowsById();
            const trs = ids.flatMap((id) => byId.get(id) || []);
            progress(`Labeling ${trs.length} mail(s) as "${label}" (page ${page})…`);
            if (!trs.length) continue;
            try {
              for (const tr of trs) {
                click(rowCheckbox(tr));
                await sleep(50);
              }
              await sleep(300);
              await labelAs(label);
              ids.forEach((id) => pending.delete(id));
              noteLabeled(label, ids);
              labeled += trs.length;
              browser.runtime.sendMessage({ type: "aiCacheMerge", entries: Object.fromEntries(ids.map((id) => [id, { junk: false, label, labeled: true, at: Date.now() }])) }).catch(() => {});
            } catch (e) {
              warn = `Label "${label}" failed: ${e.message}`;
              await clearSelection();
              ids.forEach((id) => pending.delete(id));
            }
          }
          // 2) deletions on this page
          const byId = rowsById();
          const delTrs = [...byId].filter(([id]) => del.has(id) && pending.has(id)).flatMap(([, trs]) => trs);
          if (delTrs.length) {
            progress(`Deleting ${delTrs.length} mail(s) (page ${page})…`);
            await rowAction(delTrs, { action: rule.action === "archive" ? "archive" : "delete" });
            for (const [id] of byId) if (del.has(id)) pending.delete(id);
            done += delTrs.length;
            await openSearch(query);
            // skip pages that have nothing pending
            let guard = 0;
            while (rows().length && ![...rowsById().keys()].some((id) => pending.has(id)) && guard++ < 20) if (!(await nextPage())) break;
            continue;
          }
          if (!(await nextPage())) break;
        }
        total += done;
        summary.push({ rule: rule.name, action: rule.action, count: done, labeled, warn, skipped: pending.size });
      }
      const droppedLabels = await dropUndoLabels(dropLabels);
      const unsubDone = unsub.filter((u) => u.status === "done" || u.status === "clicked").length;
      progress(`Done: ${total} deleted, ${summary.reduce((n, x) => n + (x.labeled || 0), 0)} labeled, ${unsubDone} unsubscribed.`, "ok");
      if (returnToInbox) location.hash = startHash && !/^#(search|settings)/.test(startHash) ? startHash : "#inbox";
      hideBanner(4000);
      const out = { total, summary, unsubscribe: unsub, stopped: stopRequested, undo: undoReport(), droppedLabels };
      await browser.__send({ type: "applyFinished", ...out }).catch((e) => progress(`Error saving result: ${e.message}`, "error"));
      return out;
    } catch (e) {
      progress(`Error: ${e.message}`, "error");
      console.error("[Inbox Broom]", e, diag());
      hideBanner(10000);
      browser.__send({ type: "applyFinished", total: 0, summary: [], unsubscribe: [], error: e.message }).catch(() => {});
      throw e;
    } finally {
      running = false;
      keepAlive(false);
      browser.storage.local.set({ progress: { text: "", at: Date.now(), running: false } }).catch(() => {});
    }
  }

  browser.__onMessage((msg) => {
    if (msg.type === "run") {
      if (running) throw new Error("Already running");
      run(msg).catch(() => {});
      return { started: true };
    }
    if (msg.type === "apply") {
      if (running) throw new Error("Already running");
      apply(msg).catch(() => {});
      return { started: true };
    }
    if (msg.type === "stop") {
      stopRequested = true;
      return true;
    }
    if (msg.type === "undo") {
      if (running) throw new Error("Already running");
      undoRun(msg).catch(() => {});
      return { started: true };
    }
    if (msg.type === "ping") return { running };
    if (msg.type === "diag") return diag();
    if (msg.type === "createLabels") return createLabels(msg);
    if (msg.type === "organizeLabels") return organizeLabels(msg);
    if (msg.type === "listLabels") {
      stopRequested = false;
      return existingLabels();
    }
    return null;
  });
})();
