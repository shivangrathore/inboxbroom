/* Gmail Inbox Cleaner – content script
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
    return { id, email, sender, subject, snippet, date, unread: tr.classList.contains("zE") };
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

  function toolbarButton(name) {
    const act = { Delete: "10", Archive: "7" }[name];
    const scope = toolbar() || document;
    return (
      (act && (q(`div[act="${act}"]`, scope) || q(`div[act="${act}"]`))) ||
      q(`[role="button"][data-tooltip^="${name}"]`, scope) ||
      q(`[role="button"][aria-label^="${name}"]`, scope) ||
      q(`[role="button"][data-tooltip^="${name}"]`) ||
      q(`[role="button"][aria-label^="${name}"]`)
    );
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
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: value.slice(-1) }));
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
    const btn = await waitFor(() => toolbarButton("Label"), { timeout: 4000 });
    if (!btn) {
      click(cb);
      return [];
    }
    click(btn);
    const menu = await waitFor(() => qa('div[role="menu"]').find((m) => m.querySelector("input")), { timeout: 4000 });
    const names = [];
    if (menu) {
      for (const it of qa('[role="menuitemcheckbox"], [role="menuitem"]', menu)) {
        const t = txt(it);
        if (t && !/^(create new|manage labels|apply)$/i.test(t)) names.push(t.replace(/\s*\(\d+\)$/, ""));
      }
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(300);
    }
    // deselect
    await clearSelection();
    return names;
  }

  async function existingLabels() {
    const nav = labelsFromNav();
    let menu = [];
    try {
      menu = await labelsFromMenu();
    } catch (e) {
      console.warn("[cleaner] label menu read failed", e.message);
    }
    const all = new Map();
    for (const l of [...menu, ...nav]) if (l && !/^(inbox|starred|sent|drafts|spam|trash|important|all mail|snoozed|scheduled|chats|unread|categories)$/i.test(l)) all.set(l.toLowerCase(), l);
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

  async function createLabels(names) {
    const startHash = location.hash;
    if (!location.hash.startsWith("#inbox")) {
      location.hash = "#inbox";
      await sleep(1200);
    }
    const existing = new Set((await existingLabels()).map((l) => l.toLowerCase()));
    const out = { created: [], existing: [], failed: [] };
    for (const name of names) {
      if (stopRequested) break;
      if (existing.has(name.toLowerCase())) {
        out.existing.push(name);
        continue;
      }
      progress(`Creating label "${name}"…`);
      try {
        await createLabel(name);
        out.created.push(name);
        existing.add(name.toLowerCase());
      } catch (e) {
        out.failed.push({ name, error: e.message });
      }
    }
    progress(`Labels: ${out.created.length} created, ${out.existing.length} already there${out.failed.length ? `, ${out.failed.length} failed` : ""}.`, out.failed.length ? "error" : "ok");
    hideBanner(5000);
    location.hash = startHash && !startHash.startsWith("#settings") ? startHash : "#inbox";
    return out;
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

  /** Gmail "Labels" menu → tick label → Apply. Keeps mail where it is. Creates the label if missing. */
  async function labelAs(label) {
    const btn = await waitFor(() => toolbarButton("Label"), { timeout: 6000 });
    if (!btn) throw new Error(`"Labels" button not found. ${diag()}`);
    click(btn);
    const menu = await waitFor(() => qa('div[role="menu"]').find((m) => m.querySelector("input")), { timeout: 5000 });
    if (!menu) throw new Error(`"Labels" menu did not open. ${diag()}`);
    typeInto(menu.querySelector("input"), label);
    await sleep(600);
    const items = () => qa('[role="menuitemcheckbox"], [role="menuitem"], [role="option"]', menu);
    const exact = items().find((it) => txt(it).replace(/\s*\(\d+\)$/, "").toLowerCase() === label.toLowerCase());
    if (exact) {
      if (exact.getAttribute("aria-checked") !== "true") click(exact);
      await sleep(300);
      const apply = qa('[role="button"], div.J-N, button', menu).find((b) => /^apply$/i.test(txt(b)));
      if (apply) click(apply);
      else menu.querySelector("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
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

  async function openSubscriptions() {
    const before = unsubButtons().length;
    location.hash = "#subscriptions";
    await sleep(1200);
    await waitFor(() => unsubButtons().length && (unsubButtons().length !== before || location.hash.includes("subscriptions")), { timeout: 10000 });
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
    return unsubButtons().length > 0;
  }

  async function listSubscriptions() {
    if (!(await openSubscriptions())) throw new Error('Gmail "Manage subscriptions" page not found (no Unsubscribe buttons). Your Gmail may not have it yet.');
    const seen = new Map();
    for (const b of unsubButtons()) {
      const row = subscriptionRowOf(b);
      const p = parseSubscriptionRow(row);
      if (p.email && !seen.has(p.email)) seen.set(p.email, p);
    }
    return [...seen.values()];
  }

  /** Click Unsubscribe for each email on the subscriptions page. Returns per-email outcome. */
  async function unsubscribeMany(emails) {
    const out = [];
    if (!(await openSubscriptions())) throw new Error('"Manage subscriptions" page not found');
    for (const email of emails) {
      if (stopRequested) break;
      progress(`Unsubscribing ${email}…`);
      const btn = unsubButtons().find((b) => parseSubscriptionRow(subscriptionRowOf(b)).email === email);
      if (!btn) {
        out.push({ email, status: "not-found" });
        continue;
      }
      click(btn);
      const dlg = await waitFor(dialog, { timeout: 4000 });
      if (!dlg) {
        // some rows unsubscribe instantly
        await sleep(800);
        out.push({ email, status: "clicked" });
        continue;
      }
      const confirmBtn = dialogButton(/^unsubscribe$/i);
      if (confirmBtn) {
        click(confirmBtn);
        await sleep(900);
        // follow-up dialog (e.g. "Move to trash?") – decline politely
        const d2 = dialog();
        if (d2) {
          const no = dialogButton(/^(no thanks|cancel|not now|close|done|ok)$/i);
          if (no) click(no);
          else document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          await sleep(400);
        }
        out.push({ email, status: "done" });
      } else {
        const site = dialogButton(/go to website|visit|open/i);
        const cancel = dialogButton(/^(cancel|close|no thanks|not now)$/i);
        if (cancel) click(cancel);
        else document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(400);
        out.push({ email, status: site ? "needs-website" : "no-confirm" });
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

  function buildQuery(rule, allowlist, excludeLabels) {
    let s = rule.query.trim();
    // safety: never touch archived mail unless the rule explicitly opts out
    if (rule.inboxOnly !== false && !/\bin:(inbox|anywhere|all)\b/i.test(s)) s = `in:inbox ${s}`;
    const list = (allowlist || []).map((x) => x.trim()).filter(Boolean);
    if (list.length) s += ` -from:(${list.join(" OR ")})`;
    // AI rules skip mail that already carries one of the labels we assign (handled by retention instead)
    if (rule.type === "ai" && excludeLabels?.length) s += ` -{${excludeLabels.map((l) => `label:${l.trim().replace(/\s+/g, "-")}`).join(" ")}}`;
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
    if (!btn) throw new Error(`"Move to" button not found. ${diag()}`);
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
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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

  async function bulkAction(rule) {
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
    await fireAction(rule);
  }

  async function rowAction(trs, rule) {
    for (const tr of trs) {
      const cb = rowCheckbox(tr);
      if (cb.getAttribute && cb.getAttribute("aria-checked") === "true") continue;
      click(cb);
      await sleep(60);
    }
    await sleep(400);
    await fireAction(rule);
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

      const toAsk = parsed.filter((p) => !(p.id in cache) || cache[p.id].manual !== true && mode === "scan" && ctx.rescore);
      progress(`${mode === "scan" ? "Previewing" : "Cleaning"}: ${rule.name} – page ${page}/${maxPages}, AI checking ${toAsk.length} mail(s)…`);
      if (toAsk.length) {
        const verdicts = await browser.runtime.sendMessage({ type: "aiClassify", items: toAsk, rule, labels: ctx.labels });
        if (verdicts?.error) throw new Error(verdicts.error);
        const merged = {};
        for (const v of verdicts) merged[v.id] = cache[v.id] = { junk: !!v.junk, score: v.score, reason: v.reason || "", source: v.source, label: v.label || "", at: Date.now() };
        ctx.aiCache = cache;
        browser.runtime.sendMessage({ type: "aiCacheMerge", entries: merged }).catch(() => {});
      }
      const junkTrs = [];
      const labelGroups = new Map();
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i];
        const v = cache[p.id] || { junk: false, reason: "", score: 0 };
        entry.items.push({ ...p, junk: v.junk, reason: v.reason, score: v.score, source: v.source, label: v.label || "", page });
        if (v.junk) junkTrs.push(trs[i]);
        else if (v.label && !v.labeled) (labelGroups.get(v.label) || labelGroups.set(v.label, []).get(v.label)).push(p.id);
      }
      if (mode === "clean" && labelGroups.size) {
        for (const [label, ids] of labelGroups) {
          if (stopRequested) break;
          progress(`Labeling ${ids.length} mail(s) as "${label}" (page ${page})…`);
          const byId = rowsById();
          const lt = ids.map((id) => byId.get(id)).filter(Boolean);
          if (!lt.length) continue;
          try {
            for (const tr of lt) {
              click(rowCheckbox(tr));
              await sleep(50);
            }
            await sleep(300);
            await labelAs(label);
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

  async function run({ mode, rules, allowlist, returnToInbox, aiCache, rescore, subscriptions, excludeLabels }) {
    if (running) throw new Error("Already running");
    running = true;
    stopRequested = false;
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
        const query = buildQuery(rule, allowlist, excludeLabels);
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
      };
      browser.runtime.sendMessage({ type: "runFinished", ...out }).catch(() => {});
      return out;
    } catch (e) {
      progress(`Error: ${e.message}`, "error");
      console.error("[Gmail Inbox Cleaner]", e, diag());
      hideBanner(10000);
      throw e;
    } finally {
      running = false;
      browser.storage.local.set({ progress: { text: "", at: Date.now(), running: false } }).catch(() => {});
    }
  }

  function rowsById() {
    const map = new Map();
    for (const tr of rows()) map.set(parseRow(tr).id, tr);
    return map;
  }

  /**
   * plan = {
   *   bulk: [{ rule }],                                  // bulk rules to execute fully (action from rule)
   *   ai:   [{ rule, query, deleteIds: [], labels: { "Label": [ids] }, maxPages }],
   * }
   */
  async function apply({ plan, allowlist, returnToInbox }) {
    if (running) throw new Error("Already running");
    running = true;
    stopRequested = false;
    const startHash = location.hash;
    const summary = [];
    let total = 0;
    try {
      for (const b of plan.bulk || []) {
        if (stopRequested) break;
        const rule = b.rule;
        const query = buildQuery(rule, allowlist);
        const entry = { rule, query, count: 0, done: 0, items: [] };
        progress(`Cleaning: ${rule.name}…`);
        await runQueryRule(rule, query, "clean", entry);
        total += entry.done;
        summary.push({ rule: rule.name, action: rule.action, count: entry.done });
      }
      for (const a of plan.ai || []) {
        if (stopRequested) break;
        const rule = a.rule;
        const query = a.query || buildQuery(rule, allowlist);
        const del = new Set(a.deleteIds || []);
        const labelOf = new Map();
        for (const [label, ids] of Object.entries(a.labels || {})) for (const id of ids) labelOf.set(id, label);
        const pending = new Set([...del, ...labelOf.keys()]);
        let done = 0, labeled = 0, warn = null;
        await openSearch(query);
        for (let page = 1; page <= (a.maxPages || 20) && pending.size && !stopRequested; page++) {
          // 1) labels first (rows stay in place)
          const groups = new Map();
          for (const [id, tr] of rowsById()) {
            const l = labelOf.get(id);
            if (l && pending.has(id)) (groups.get(l) || groups.set(l, []).get(l)).push(id);
          }
          for (const [label, ids] of groups) {
            if (stopRequested) break;
            progress(`Labeling ${ids.length} mail(s) as "${label}" (page ${page})…`);
            const byId = rowsById();
            const trs = ids.map((id) => byId.get(id)).filter(Boolean);
            if (!trs.length) continue;
            try {
              for (const tr of trs) {
                click(rowCheckbox(tr));
                await sleep(50);
              }
              await sleep(300);
              await labelAs(label);
              ids.forEach((id) => pending.delete(id));
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
          const delTrs = [...byId].filter(([id]) => del.has(id) && pending.has(id)).map(([, tr]) => tr);
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
      let unsub = [];
      if ((plan.unsubscribe || []).length && !stopRequested) {
        try {
          unsub = await unsubscribeMany(plan.unsubscribe);
        } catch (e) {
          unsub = plan.unsubscribe.map((email) => ({ email, status: "error", error: e.message }));
        }
      }
      const unsubDone = unsub.filter((u) => u.status === "done" || u.status === "clicked").length;
      progress(`Done: ${total} deleted, ${summary.reduce((n, x) => n + (x.labeled || 0), 0)} labeled, ${unsubDone} unsubscribed.`, "ok");
      if (returnToInbox) location.hash = startHash && !startHash.startsWith("#search/") ? startHash : "#inbox";
      hideBanner(4000);
      return { total, summary, unsubscribe: unsub, stopped: stopRequested };
    } catch (e) {
      progress(`Error: ${e.message}`, "error");
      console.error("[Gmail Inbox Cleaner]", e, diag());
      hideBanner(10000);
      throw e;
    } finally {
      running = false;
      browser.storage.local.set({ progress: { text: "", at: Date.now(), running: false } }).catch(() => {});
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "run") return run(msg);
    if (msg.type === "apply") return apply(msg);
    if (msg.type === "createLabels") return createLabels(msg.names || []);
    if (msg.type === "listLabels") return existingLabels();
    if (msg.type === "stop") {
      stopRequested = true;
      return Promise.resolve(true);
    }
    if (msg.type === "ping") return Promise.resolve({ running });
    if (msg.type === "diag") return Promise.resolve(diag());
  });
})();
