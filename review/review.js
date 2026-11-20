const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => browser.__send({ type, ...extra });

let preview = null;
let settings = null;
let labels = [];
let selectedId = null;
const state = { search: "", rule: "", verdict: "", group: "", label: null };
let saveTimer = null;

const coreOf = (l) => String(l || "").replace(/^\[|\]$/g, "").replace(/^[@#!]/, "").trim().toLowerCase();
const isSel = (x) => x.sel !== false;
const aiItems = () => preview.results.filter((r) => r.rule.type === "ai").flatMap((r) => r.items);
const initials = (s) => (s || "?").replace(/[^a-z0-9 ]/gi, " ").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("") || "?";
const hue = (s) => { let h = 0; for (const c of s || "") h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => send("previewSave", { preview }), 200);
}
function toast(t) {
  const el = $("toast");
  el.textContent = t;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2000);
}

function stats() {
  let del = 0, keep = 0, lab = 0, bulk = 0;
  for (const r of preview.results) {
    if (r.rule.type === "ai") {
      for (const it of r.items) {
        if (it.junk && isSel(it)) del++;
        else if (!it.junk) { keep++; if (it.label && isSel(it)) lab++; }
      }
    } else if (isSel(r)) bulk += r.count;
  }
  const subs = Array.isArray(preview.subscriptions) ? preview.subscriptions : [];
  const unsub = subs.filter((x) => (x.sel === undefined ? x.unsubscribe : x.sel)).length;
  return { del, keep, lab, bulk, unsub, hasSubs: subs.length > 0 };
}

function chip(text, { active = false, cls = "", onclick, n } = {}) {
  const c = document.createElement("button");
  c.className = `chip ${cls}${active ? " active" : ""}`;
  c.textContent = text;
  if (n != null) {
    const s = document.createElement("span");
    s.className = "n";
    s.textContent = n;
    c.appendChild(s);
  }
  if (onclick) c.onclick = onclick;
  return c;
}
function statChip(n, text, cls) {
  const c = document.createElement("span");
  c.className = `chip stat ${cls}`;
  c.innerHTML = `<b></b><span></span>`;
  c.querySelector("b").textContent = n;
  c.querySelector("span").textContent = text;
  return c;
}

function renderFilters() {
  const s = stats();
  const sum = $("summary");
  sum.innerHTML = "";
  sum.appendChild(statChip(s.bulk + s.del, "to delete", "danger"));
  sum.appendChild(statChip(s.lab, "to label", "label"));
  sum.appendChild(statChip(s.keep - s.lab, "kept, no label", ""));
  if (s.hasSubs) sum.appendChild(statChip(s.unsub, "to unsubscribe", "danger"));
  const parts = [`Delete ${s.bulk + s.del}`, `Label ${s.lab}`];
  if (s.hasSubs) parts.push(`Unsubscribe ${s.unsub}`);
  $("confirm").textContent = parts.join(" · ");
  $("confirm").disabled = s.bulk + s.del + s.lab + s.unsub === 0;

  const rc = $("ruleChips");
  rc.innerHTML = "";
  const l1 = document.createElement("span"); l1.className = "lbl"; l1.textContent = "Show"; rc.appendChild(l1);
  rc.appendChild(chip("Everything", { active: !state.verdict, onclick: () => { state.verdict = ""; render(); } }));
  rc.appendChild(chip("To delete", { active: state.verdict === "junk", cls: "danger", onclick: () => { state.verdict = state.verdict === "junk" ? "" : "junk"; render(); } }));
  rc.appendChild(chip("To keep", { active: state.verdict === "keep", onclick: () => { state.verdict = state.verdict === "keep" ? "" : "keep"; render(); } }));
  const sep = document.createElement("span"); sep.className = "lbl"; sep.textContent = "· Rule"; rc.appendChild(sep);
  rc.appendChild(chip("All", { active: !state.rule, onclick: () => { state.rule = ""; render(); } }));
  for (const r of preview.results) rc.appendChild(chip(r.rule.name, { active: state.rule === r.rule.id, onclick: () => { state.rule = state.rule === r.rule.id ? "" : r.rule.id; render(); } }));

  const lc = $("labelChips");
  lc.innerHTML = "";
  const counts = new Map();
  for (const it of aiItems()) if (!it.junk) counts.set(it.label || "", (counts.get(it.label || "") || 0) + 1);
  if (counts.size) {
    const l2 = document.createElement("span"); l2.className = "lbl"; l2.textContent = "Labels"; lc.appendChild(l2);
    for (const [l, n] of [...counts].sort((a, b) => b[1] - a[1])) lc.appendChild(chip(l || "no label", { n, active: state.label === l, onclick: () => { state.label = state.label === l ? null : l; render(); } }));
  }
}

function matches(it) {
  if (state.verdict === "junk" && !it.junk) return false;
  if (state.verdict === "keep" && it.junk) return false;
  if (state.label !== null && (it.junk || (it.label || "") !== state.label)) return false;
  if (state.search) {
    const q = state.search.toLowerCase();
    if (!`${it.sender} ${it.email} ${it.subject} ${it.snippet || ""} ${it.reason || ""} ${it.label || ""}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

function itemRow(it) {
  const row = document.createElement("div");
  row.className = `item${isSel(it) ? "" : " off"}${selectedId === it.id ? " active" : ""}`;
  row.dataset.id = it.id;
  const c = document.createElement("div");
  c.className = "c";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = isSel(it);
  cb.onclick = (e) => e.stopPropagation();
  cb.onchange = () => { it.sel = cb.checked; row.classList.toggle("off", !cb.checked); renderFilters(); save(); };
  c.appendChild(cb);
  const av = document.createElement("span");
  av.className = "avatar";
  av.style.background = `hsl(${hue(it.email)} 45% 45%)`;
  av.textContent = initials(it.sender || it.email);
  const who = document.createElement("div"); who.className = "who"; who.textContent = it.sender || it.email; who.title = it.email;
  const subj = document.createElement("div"); subj.className = "subj";
  subj.innerHTML = `<span></span> <small></small>`;
  subj.querySelector("span").textContent = it.subject || "(no subject)";
  subj.querySelector("small").textContent = it.snippet ? `– ${it.snippet}` : "";
  const date = document.createElement("div"); date.className = "date"; date.textContent = (it.date || "").replace(/,.*$/, "");
  const v = document.createElement("div");
  const badge = document.createElement("span");
  badge.className = `badge ${it.junk ? "junk" : "keep"}`;
  badge.textContent = it.junk ? `delete${it.score != null ? " " + it.score : ""}` : "keep";
  badge.title = `${it.reason || ""}\nClick to flip`;
  badge.onclick = async (e) => { e.stopPropagation(); it.junk = !it.junk; it.sel = true; await send("aiCacheSet", { id: it.id, junk: it.junk }); render(); save(); };
  v.appendChild(badge);
  const lab = document.createElement("div"); lab.className = "lab";
  if (!it.junk) {
    const b = document.createElement("span");
    b.className = `badge ${it.label ? "label" : "neutral"}`;
    b.textContent = it.label || "no label";
    lab.appendChild(b);
  }
  row.append(c, av, who, subj, date, v, lab);
  row.onclick = () => { selectedId = it.id; renderDetail(it); for (const r of document.querySelectorAll(".item.active")) r.classList.remove("active"); row.classList.add("active"); };
  return row;
}

function renderDetail(it) {
  const d = $("detail");
  if (!it) { d.classList.add("hidden"); return; }
  d.classList.remove("hidden");
  d.innerHTML = `<div class="card-h"><b>Details</b><button class="btn icon" id="closeDetail" title="Close">✕</button></div><div class="card-b"></div>`;
  d.querySelector("#closeDetail").onclick = () => { selectedId = null; renderDetail(null); for (const r of document.querySelectorAll(".item.active")) r.classList.remove("active"); };
  const b = d.querySelector(".card-b");
  const subject = document.createElement("div"); subject.className = "subject"; subject.textContent = it.subject || "(no subject)";
  const snippet = document.createElement("div"); snippet.className = "snippet"; snippet.textContent = it.snippet || "";
  const kv = document.createElement("div"); kv.className = "kv";
  const add = (k, v) => { const kk = document.createElement("b"); kk.textContent = k; const vv = document.createElement("span"); vv.textContent = v; kv.append(kk, vv); };
  add("From", `${it.sender || ""} <${it.email}>`);
  add("Date", it.date || "");
  add("Verdict", `${it.junk ? "delete" : "keep"}${it.score != null ? ` (score ${it.score})` : ""}${it.source ? ` · ${it.source}` : ""}`);
  add("AI reason", it.reason || "—");
  if (it.important) add("Gmail", "marked important (never deleted)");
  const f = document.createElement("div"); f.className = "field";
  const fl = document.createElement("label"); fl.textContent = "Label";
  const sel = document.createElement("select");
  sel.appendChild(new Option("— no label —", ""));
  for (const l of labels) sel.appendChild(new Option(l, l));
  if (it.label && !labels.includes(it.label)) sel.appendChild(new Option(it.label, it.label));
  sel.value = it.label || "";
  sel.disabled = !!it.junk;
  sel.onchange = async () => { it.label = sel.value; it.sel = true; if (it.email) await send("senderSet", { email: it.email, label: it.label }); render(); save(); toast(`Label set${it.email ? " and remembered for this sender" : ""}`); };
  f.append(fl, sel);
  const acts = document.createElement("div"); acts.className = "actions";
  const mk = (text, cls, title, fn) => { const x = document.createElement("button"); x.className = `btn sm ${cls}`; x.textContent = text; x.title = title; x.onclick = async () => { x.disabled = true; await fn(); }; return x; };
  acts.appendChild(mk(it.junk ? "Keep instead" : "Delete instead", it.junk ? "" : "danger-outline", "Flip this verdict", async () => { it.junk = !it.junk; it.sel = true; await send("aiCacheSet", { id: it.id, junk: it.junk }); render(); save(); }));
  if (it.email) {
    acts.appendChild(mk(it.junk ? "Always delete sender" : "Always keep sender", "outline", `Remember for every mail from ${it.email}`, async () => {
      await send("senderSet", { email: it.email, verdict: it.junk ? "junk" : "keep", label: it.label || undefined });
      if (!it.junk) await send("addAllowlist", { entries: [it.email] });
      for (const x of aiItems()) if (x.email === it.email) { x.junk = it.junk; x.sel = true; if (!it.junk && !x.label) x.label = it.label; }
      render(); save(); toast("Sender remembered");
    }));
    if (!it.junk && it.label) acts.appendChild(mk(`Label all from sender`, "outline", `Apply "${it.label}" to every kept mail from ${it.email}`, async () => {
      for (const x of aiItems()) if (x.email === it.email && !x.junk) { x.label = it.label; x.sel = true; }
      await send("senderSet", { email: it.email, label: it.label });
      render(); save(); toast(`"${it.label}" applied to ${it.sender || it.email}`);
    }));
  }
  b.append(subject, snippet, kv, f, acts);
}

function groupHead(title, sub, list) {
  const g = document.createElement("div");
  g.className = "group";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = list.every(isSel);
  cb.onchange = () => { for (const x of list) x.sel = cb.checked; render(); save(); };
  const t = document.createElement("span"); t.textContent = title;
  const n = document.createElement("span"); n.className = "n"; n.textContent = sub;
  g.append(cb, t, n);
  return g;
}

function section({ title, query, countText, danger, checked, onToggle, open }) {
  const box = document.createElement("details");
  box.className = "card sec";
  box.open = open;
  const sum = document.createElement("summary");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.title = "Include this rule";
  cb.onclick = (e) => e.stopPropagation();
  cb.onchange = () => onToggle(cb.checked);
  const b = document.createElement("b"); b.textContent = title;
  const q = document.createElement("span"); q.className = "q"; q.textContent = query || ""; q.title = query || "";
  const n = document.createElement("span"); n.className = `n${danger ? " danger" : ""}`; n.textContent = countText;
  sum.append(cb, b, q, n);
  box.appendChild(sum);
  return box;
}

function renderSubscriptions(main) {
  const subs = preview.subscriptions;
  if (!subs || !Array.isArray(subs) || !subs.length) {
    if (subs?.error) { const b = document.createElement("div"); b.className = "card banner small muted"; b.textContent = `Unsubscribe suggestions unavailable: ${subs.error}`; main.appendChild(b); }
    return;
  }
  const n = subs.filter((x) => (x.sel === undefined ? x.unsubscribe : x.sel)).length;
  const fromInbox = subs.some((x) => x.source === "inbox");
  const box = section({ title: "Subscriptions", query: fromInbox ? "Bulk senders seen in your scans" : "Gmail → Manage subscriptions", countText: `${n} to unsubscribe · ${subs.length} senders`, danger: n > 0, checked: true, onToggle: (v) => { for (const x of subs) x.sel = v; render(); save(); }, open: true });
  if (fromInbox) { const note = document.createElement("div"); note.className = "note"; note.textContent = "Gmail's Manage subscriptions page could not be read, so these come from senders the scans keep seeing. Confirm opens each one's latest mail and clicks Gmail's Unsubscribe next to the sender."; box.appendChild(note); }
  const list = subs.filter((x) => !state.search || `${x.name} ${x.email} ${x.reason || ""} ${(x.signals || []).join(" ")} ${(x.subjects || []).join(" ")}`.toLowerCase().includes(state.search.toLowerCase())).sort((a, b) => b.unsubscribe - a.unsubscribe || (b.score ?? 50) - (a.score ?? 50) || (b.count || 0) - (a.count || 0));
  for (const x of list) {
    const row = document.createElement("div");
    const on = x.sel === undefined ? x.unsubscribe : x.sel;
    row.className = `item${on ? "" : " off"}`;
    const c = document.createElement("div"); c.className = "c";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = on; cb.onclick = (e) => e.stopPropagation(); cb.onchange = () => { x.sel = cb.checked; row.classList.toggle("off", !cb.checked); renderFilters(); save(); };
    c.appendChild(cb);
    const av = document.createElement("span"); av.className = "avatar"; av.style.background = `hsl(${hue(x.email)} 45% 45%)`; av.textContent = initials(x.name || x.email);
    const who = document.createElement("div"); who.className = "who"; who.textContent = x.name || x.email; who.title = x.email;
    const subj = document.createElement("div"); subj.className = "subj";
    subj.innerHTML = `<span></span> <small></small>`;
    subj.querySelector("span").textContent = (x.signals || []).join(" · ") || x.reason || "";
    subj.querySelector("small").textContent = x.subjects?.length ? `– ${x.subjects.join(" · ")}` : "";
    subj.title = [x.reason, ...(x.subjects || [])].filter(Boolean).join("\n");
    const cnt = document.createElement("div"); cnt.className = "date"; cnt.textContent = x.count != null ? `${x.count} mails` : "";
    const v = document.createElement("div");
    const badge = document.createElement("span"); badge.className = `badge ${x.unsubscribe ? "junk" : "keep"}`; badge.textContent = x.unsubscribe ? "unsubscribe" : "keep"; badge.title = `${x.reason || ""}${x.score != null ? `\nSignal score ${x.score}${x.signals?.length ? `: ${x.signals.join(", ")}` : ""}` : ""}\nClick to flip`;
    badge.onclick = (e) => { e.stopPropagation(); x.unsubscribe = !x.unsubscribe; x.sel = x.unsubscribe; render(); save(); };
    v.appendChild(badge);
    const why = document.createElement("div"); why.className = "lab small muted"; why.textContent = x.status ? `${x.status}${x.error ? ": " + x.error : ""}` : "";
    row.append(c, av, who, subj, cnt, v, why);
    box.appendChild(row);
  }
  main.appendChild(box);
}

function render() {
  renderFilters();
  const main = $("main");
  main.innerHTML = "";
  let any = false;
  if (!state.rule) renderSubscriptions(main);
  for (const r of preview.results) {
    if (state.rule && r.rule.id !== state.rule) continue;
    const isAi = r.rule.type === "ai";
    if (!isAi) {
      if (state.verdict === "keep" || state.label !== null) continue;
      const box = section({ title: r.rule.name, query: r.query, countText: `${r.count} → ${r.rule.action === "delete" ? "Trash" : r.rule.action}`, danger: r.count > 0, checked: isSel(r), onToggle: (v) => { r.sel = v; render(); save(); }, open: r.count > 0 });
      if (r.items.length) {
        const g = document.createElement("div"); g.className = "bulk-sample";
        for (const it of r.items.slice(0, 12)) {
          const w = document.createElement("div"); w.className = "w"; w.textContent = it.sender || it.email;
          const s = document.createElement("div"); s.className = "s"; s.textContent = it.subject;
          const d = document.createElement("div"); d.className = "d"; d.textContent = (it.date || "").replace(/,.*$/, "");
          g.append(w, s, d);
        }
        box.appendChild(g);
        if (r.count > 12) { const n = document.createElement("div"); n.className = "note"; n.textContent = `Newest 12 of ${r.count} shown; all ${r.count} are affected.`; box.appendChild(n); }
      } else { const n = document.createElement("div"); n.className = "note"; n.textContent = "Nothing matches right now."; box.appendChild(n); }
      main.appendChild(box);
      any = true;
      continue;
    }
    const items = r.items.filter(matches).sort((a, b) => b.junk - a.junk || (b.score || 0) - (a.score || 0));
    const junkN = r.items.filter((i) => i.junk && isSel(i)).length;
    const box = section({ title: r.rule.name, query: r.query, countText: `${junkN} to delete · ${r.items.filter((i) => !i.junk).length} kept`, danger: junkN > 0, checked: isSel(r), onToggle: (v) => { r.sel = v; for (const it of r.items) it.sel = v; render(); save(); }, open: true });
    for (const w of r.warnings || []) { const n = document.createElement("div"); n.className = "note"; n.textContent = w; box.appendChild(n); }
    if (!items.length) { const n = document.createElement("div"); n.className = "note"; n.textContent = "Nothing matches the current filter."; box.appendChild(n); }
    else if (state.group) {
      const keyOf = (it) => (state.group === "sender" ? it.email : it.junk ? "— to delete —" : it.label || "— no label —");
      const groups = new Map();
      for (const it of items) (groups.get(keyOf(it)) || groups.set(keyOf(it), []).get(keyOf(it))).push(it);
      for (const [k, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
        box.appendChild(groupHead(state.group === "sender" ? list[0].sender || k : k, state.group === "sender" ? `${k} · ${list.length}` : `${list.length}`, list));
        for (const it of list) box.appendChild(itemRow(it));
      }
    } else for (const it of items) box.appendChild(itemRow(it));
    main.appendChild(box);
    any = true;
  }
  if (!any) main.innerHTML = `<div class="card empty">Nothing matches the current filter.</div>`;
  const cur = selectedId && aiItems().find((x) => x.id === selectedId);
  renderDetail(cur || null);
}

function buildPlan() {
  const plan = { bulk: [], ai: [] };
  for (const r of preview.results) {
    if (!isSel(r)) continue;
    if (r.rule.type !== "ai") { if (r.count > 0) plan.bulk.push({ rule: r.rule }); continue; }
    const deleteIds = [], labelsMap = {};
    for (const it of r.items) {
      if (!isSel(it)) continue;
      if (it.junk) deleteIds.push(it.id);
      else if (it.label) (labelsMap[it.label] = labelsMap[it.label] || []).push(it.id);
    }
    if (deleteIds.length || Object.keys(labelsMap).length) plan.ai.push({ rule: r.rule, query: r.query, deleteIds, labels: labelsMap, maxPages: Math.max(10, (r.rule.maxPages || 10) + 2) });
  }
  const subs = Array.isArray(preview.subscriptions) ? preview.subscriptions : [];
  plan.unsubscribe = subs.filter((x) => (x.sel === undefined ? x.unsubscribe : x.sel)).map((x) => x.email);
  plan.unsubscribeVia = subs.some((x) => x.source === "inbox") ? "message" : "page";
  return plan;
}

async function confirmPlan() {
  const s = stats();
  const plan = buildPlan();
  if (!confirm(`Delete ${s.bulk + s.del} conversation(s) (Trash, 30-day undo), label ${s.lab}${s.hasSubs ? `, unsubscribe from ${s.unsub} sender(s)` : ""}?`)) return;
  $("confirm").disabled = true;
  $("rescan").disabled = true;
  $("progress").textContent = "Working in the Gmail tab…";
  try {
    await send("apply", { plan }); // { started: true }; the result arrives through storage (applyResult)
    const res = await new Promise((resolve, reject) => {
      const onChange = (ch) => {
        if (ch.applyResult?.newValue) {
          browser.storage.onChanged.removeListener(onChange);
          const r = ch.applyResult.newValue;
          r.error ? reject(new Error(r.error)) : resolve(r);
        }
      };
      browser.storage.onChanged.addListener(onChange);
    });
    const warns = res.summary.filter((x) => x.warn).map((x) => x.warn);
    const un = res.unsubscribe || [];
    const unDone = un.filter((u) => u.status === "done" || u.status === "clicked").length;
    const needSite = un.filter((u) => u.status === "needs-website");
    const labeled = res.summary.reduce((n, x) => n + (x.labeled || 0), 0);
    $("progress").textContent = `Done: ${res.total} deleted, ${labeled} labeled${s.hasSubs ? `, ${unDone} unsubscribed` : ""}.` + (warns.length ? ` Warnings: ${warns.join(" | ")}` : "");
    ["summary", "ruleChips", "labelChips"].forEach((id) => ($(id).innerHTML = ""));
    $("confirm").textContent = "Done";
    renderDetail(null);
    const left = document.createElement("div");
    left.className = "card empty";
    left.innerHTML = `<p>Cleaned. Run Preview again for another pass.</p>`;
    if (needSite.length) { const p = document.createElement("p"); p.textContent = `Need a website visit to unsubscribe: ${needSite.map((u) => u.email).join(", ")}`; left.appendChild(p); }
    const failed = un.filter((u) => !["done", "clicked", "needs-website"].includes(u.status));
    const why = { "no-link": "Gmail shows no Unsubscribe link for it", "not-found": "no mail from it found" };
    if (failed.length) { const p = document.createElement("p"); p.textContent = `Could not unsubscribe: ${failed.map((u) => `${u.email} (${why[u.status] || u.status})`).join(", ")}`; left.appendChild(p); }
    $("main").innerHTML = "";
    $("main").appendChild(left);
    preview = null;
  } catch (e) {
    $("progress").textContent = `Error: ${e.message}`;
    $("confirm").disabled = false;
  } finally {
    $("rescan").disabled = false;
  }
}

async function rescan() {
  $("rescan").disabled = true;
  $("confirm").disabled = true;
  $("progress").textContent = "Previewing… watch the Gmail tab.";
  try {
    await browser.storage.local.set({ runError: null });
    await send("run", { mode: "scan", openReview: false }); // lastPreview change reloads this page (onChanged below)
  } catch (e) {
    $("progress").textContent = `Error: ${e.message}`;
    $("rescan").disabled = false;
  }
}

async function load() {
  settings = await send("getSettings");
  preview = await send("previewGet");
  if (!preview) {
    $("main").innerHTML = `<div class="card empty">No preview yet. Click the toolbar icon → Preview inbox.</div>`;
    $("meta").textContent = ""; ["summary", "ruleChips", "labelChips"].forEach((id) => ($(id).innerHTML = "")); $("confirm").disabled = true; renderDetail(null);
    return;
  }
  const byCore = new Map();
  for (const l of preview.labels || []) if (!byCore.has(coreOf(l))) byCore.set(coreOf(l), l);
  for (const l of settings.ai.suggestedLabels || []) if (!byCore.has(coreOf(l))) byCore.set(coreOf(l), l);
  labels = [...byCore.values()].sort((a, b) => a.localeCompare(b));
  $("meta").textContent = `previewed ${new Date(preview.at).toLocaleString()}${preview.stopped ? " (stopped early)" : ""} · ${preview.labels?.length || 0} Gmail labels`;
  render();
}

$("search").oninput = () => { state.search = $("search").value.trim(); render(); };
$("groupBy").onchange = () => { state.group = $("groupBy").value; render(); };
$("confirm").onclick = confirmPlan;
$("rescan").onclick = rescan;
let lastAt = null;
browser.storage.onChanged.addListener((ch) => {
  if (ch.progress?.newValue?.text) $("progress").textContent = ch.progress.newValue.text;
  if (ch.lastPreview?.newValue && ch.lastPreview.newValue.at !== lastAt) { lastAt = ch.lastPreview.newValue.at; load(); $("progress").textContent = ""; $("rescan").disabled = false; }
  if (ch.runError?.newValue) { $("progress").textContent = `Error: ${ch.runError.newValue.message}`; $("rescan").disabled = false; $("confirm").disabled = false; }
});
load().then(() => (lastAt = preview?.at || null));
