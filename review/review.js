const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => browser.runtime.sendMessage({ type, ...extra });

let preview = null; // { at, results, labels, subscriptions }
let settings = null;
let labels = [];
const state = { search: "", rule: "", verdict: "", group: "", label: null };
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => send("previewSave", { preview }), 200);
}
const coreOf = (l) => String(l || "").replace(/^\[|\]$/g, "").replace(/^[@#!]/, "").trim().toLowerCase();
const aiItems = () => preview.results.filter((r) => r.rule.type === "ai").flatMap((r) => r.items);
const isSel = (x) => x.sel !== false;

function stats() {
  let del = 0, keep = 0, lab = 0, bulk = 0;
  for (const r of preview.results) {
    if (r.rule.type === "ai") {
      for (const it of r.items) {
        if (it.junk && isSel(it)) del++;
        else if (!it.junk) {
          keep++;
          if (it.label && isSel(it)) lab++;
        }
      }
    } else if (isSel(r)) bulk += r.count;
  }
  const subs = Array.isArray(preview.subscriptions) ? preview.subscriptions : [];
  const unsub = subs.filter((x) => (x.sel === undefined ? x.unsubscribe : x.sel)).length;
  return { del, keep, lab, bulk, unsub, hasSubs: subs.length > 0 };
}

function renderSummary() {
  const s = stats();
  const root = $("summary");
  root.innerHTML = "";
  const tiles = [
    [s.bulk + s.del, "to delete", "danger"],
    [s.lab, "to label", "lab"],
    [s.keep - s.lab, "kept, no label", ""],
  ];
  if (s.hasSubs) tiles.push([s.unsub, "to unsubscribe", "danger"]);
  for (const [n, t, cls] of tiles) {
    const d = document.createElement("div");
    d.className = `stat ${cls}`;
    d.innerHTML = `<b></b><span></span>`;
    d.querySelector("b").textContent = n;
    d.querySelector("span").textContent = t;
    root.appendChild(d);
  }
  const parts = [`Delete ${s.bulk + s.del}`, `Label ${s.lab}`];
  if (s.hasSubs) parts.push(`Unsubscribe ${s.unsub}`);
  $("confirm").textContent = parts.join(" · ");
  $("confirm").disabled = s.bulk + s.del + s.lab + s.unsub === 0;

  // label pills (kept mail only)
  const counts = new Map();
  for (const it of aiItems()) if (!it.junk) counts.set(it.label || "", (counts.get(it.label || "") || 0) + 1);
  const pills = $("labelPills");
  pills.innerHTML = "";
  for (const [l, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const p = document.createElement("span");
    p.className = `pill${l ? "" : " none"}${state.label === l ? " active" : ""}`;
    p.textContent = `${l || "no label"} · ${n}`;
    p.title = "Click to filter";
    p.onclick = () => {
      state.label = state.label === l ? null : l;
      render();
    };
    pills.appendChild(p);
  }
}

function matches(it) {
  if (state.verdict === "junk" && !it.junk) return false;
  if (state.verdict === "keep" && it.junk) return false;
  if (state.label !== null && (it.junk || (it.label || "") !== state.label)) return false;
  if (state.search) {
    const q = state.search.toLowerCase();
    if (!`${it.sender} ${it.email} ${it.subject} ${it.reason || ""} ${it.label || ""}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

function labelSelect(it) {
  const sel = document.createElement("select");
  sel.className = "lab";
  sel.appendChild(new Option("— no label —", ""));
  for (const l of labels) sel.appendChild(new Option(l, l));
  if (it.label && !labels.includes(it.label)) sel.appendChild(new Option(it.label, it.label));
  sel.value = it.label || "";
  sel.onchange = async () => {
    it.label = sel.value;
    it.sel = true;
    if (it.email) await send("senderSet", { email: it.email, label: it.label });
    renderSummary();
    save();
  };
  return sel;
}

function smallBtn(text, title, fn) {
  const b = document.createElement("button");
  b.className = "btn sm";
  b.textContent = text;
  b.title = title;
  b.onclick = async () => {
    b.disabled = true;
    await fn(b);
  };
  return b;
}

function itemRow(it, r) {
  const tr = document.createElement("tr");
  if (!isSel(it)) tr.classList.add("off");
  const c = document.createElement("td");
  c.className = "c";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = isSel(it);
  cb.title = "Include in confirm";
  cb.onchange = () => {
    it.sel = cb.checked;
    tr.classList.toggle("off", !cb.checked);
    renderSummary();
    save();
  };
  c.appendChild(cb);

  const who = document.createElement("td");
  who.className = "who";
  who.textContent = it.sender || it.email;
  who.title = it.email;

  const subj = document.createElement("td");
  subj.className = "subj";
  subj.innerHTML = `<span></span> <small></small>`;
  subj.querySelector("span").textContent = it.subject || "(no subject)";
  subj.querySelector("small").textContent = it.snippet ? `– ${it.snippet}` : "";
  subj.title = `${it.subject}\n${it.snippet || ""}\n\nAI: ${it.reason || ""}`;

  const date = document.createElement("td");
  date.className = "date";
  date.textContent = (it.date || "").replace(/,.*$/, "");

  const v = document.createElement("td");
  v.className = "v";
  const badge = document.createElement("span");
  badge.className = `badge ${it.junk ? "junk" : "keep"}`;
  badge.textContent = it.junk ? `delete${it.score != null ? " " + it.score : ""}` : "keep";
  badge.title = `${it.reason || ""}${it.source ? ` (${it.source})` : ""}\nClick to flip`;
  badge.onclick = async () => {
    it.junk = !it.junk;
    it.sel = true;
    await send("aiCacheSet", { id: it.id, junk: it.junk });
    render();
    save();
  };
  v.appendChild(badge);

  const lab = document.createElement("td");
  lab.className = "lab";
  if (!it.junk) lab.appendChild(labelSelect(it));

  const act = document.createElement("td");
  act.className = "act";
  if (it.email) {
    act.appendChild(
      smallBtn(it.junk ? "always delete" : "always keep", `Remember this for every mail from ${it.email}`, async () => {
        await send("senderSet", { email: it.email, verdict: it.junk ? "junk" : "keep", label: it.label || undefined });
        if (!it.junk) await send("addAllowlist", { entries: [it.email] });
        for (const x of aiItems()) if (x.email === it.email) { x.junk = it.junk; x.sel = true; if (!it.junk && !x.label) x.label = it.label; }
        render();
        save();
      })
    );
    if (!it.junk && it.label) {
      act.appendChild(
        smallBtn("label sender", `Apply "${it.label}" to all kept mail from ${it.email}`, async () => {
          for (const x of aiItems()) if (x.email === it.email && !x.junk) { x.label = it.label; x.sel = true; }
          await send("senderSet", { email: it.email, label: it.label });
          render();
          save();
        })
      );
    }
  }
  tr.append(c, who, subj, date, v, lab, act);
  return tr;
}

function groupHead(title, sub, list, colSpan) {
  const h = document.createElement("tr");
  h.className = "group-head";
  h.innerHTML = `<td class="c"><input type="checkbox"></td><td colspan="${colSpan}"><span></span><span class="n"></span></td>`;
  h.querySelector("span").textContent = title;
  h.querySelector(".n").textContent = sub;
  const gcb = h.querySelector("input");
  gcb.checked = list.every(isSel);
  gcb.onchange = () => {
    for (const x of list) x.sel = gcb.checked;
    render();
    save();
  };
  return h;
}

function renderSubscriptions(main) {
  const subs = preview.subscriptions;
  if (!subs || subs.error || !subs.length) {
    if (subs?.error) {
      const b = document.createElement("div");
      b.className = "banner";
      b.textContent = `Unsubscribe suggestions unavailable: ${subs.error}`;
      main.appendChild(b);
    }
    return;
  }
  const box = document.createElement("details");
  box.className = "rule";
  box.open = true;
  const sum = document.createElement("summary");
  const n = subs.filter((x) => (x.sel === undefined ? x.unsubscribe : x.sel)).length;
  sum.innerHTML = `<b>Subscriptions</b><span class="q">Gmail → Manage subscriptions</span><span class="n danger"></span>`;
  sum.querySelector(".n").textContent = `${n} to unsubscribe · ${subs.length} senders`;
  box.appendChild(sum);
  const list = subs
    .filter((x) => {
      if (state.verdict === "junk" && !x.unsubscribe) return false;
      if (state.verdict === "keep" && x.unsubscribe) return false;
      if (state.search && !`${x.name} ${x.email} ${x.reason || ""} ${(x.subjects || []).join(" ")}`.toLowerCase().includes(state.search.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => b.unsubscribe - a.unsubscribe || (b.count || 0) - (a.count || 0));
  const t = document.createElement("table");
  t.innerHTML = `<thead><tr><th class="c"></th><th class="who">Sender</th><th>Recent subjects</th><th class="date">Mails</th><th class="v">AI</th><th>Reason</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const x of list) {
    const tr = document.createElement("tr");
    const on = x.sel === undefined ? x.unsubscribe : x.sel;
    if (!on) tr.classList.add("off");
    const c = document.createElement("td");
    c.className = "c";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    cb.onchange = () => {
      x.sel = cb.checked;
      tr.classList.toggle("off", !cb.checked);
      renderSummary();
      save();
    };
    c.appendChild(cb);
    const who = document.createElement("td");
    who.className = "who";
    who.textContent = x.name || x.email;
    who.title = x.email;
    const subj = document.createElement("td");
    subj.className = "subj";
    subj.textContent = (x.subjects || []).join(" · ") || "—";
    const cnt = document.createElement("td");
    cnt.className = "date";
    cnt.textContent = x.count ?? "";
    const v = document.createElement("td");
    v.className = "v";
    const badge = document.createElement("span");
    badge.className = `badge ${x.unsubscribe ? "junk" : "keep"}`;
    badge.textContent = x.unsubscribe ? "unsubscribe" : "keep";
    badge.onclick = () => {
      x.unsubscribe = !x.unsubscribe;
      x.sel = x.unsubscribe;
      render();
      save();
    };
    v.appendChild(badge);
    const why = document.createElement("td");
    why.className = "why";
    why.textContent = x.status ? `${x.status}${x.error ? ": " + x.error : ""}` : x.reason || "";
    tr.append(c, who, subj, cnt, v, why);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  box.appendChild(t);
  main.appendChild(box);
}

function render() {
  renderSummary();
  const main = $("main");
  main.innerHTML = "";
  let any = false;
  if (!state.rule) renderSubscriptions(main);

  for (const r of preview.results) {
    if (state.rule && r.rule.id !== state.rule) continue;
    const isAi = r.rule.type === "ai";
    const items = isAi ? r.items.filter(matches).sort((a, b) => b.junk - a.junk || (b.score || 0) - (a.score || 0)) : r.items;
    const junkN = isAi ? r.items.filter((i) => i.junk && isSel(i)).length : r.count;
    if (isAi && !items.length && (state.search || state.label !== null || state.verdict)) continue;

    const box = document.createElement("details");
    box.className = "rule";
    box.open = isAi ? true : r.count > 0;
    const sum = document.createElement("summary");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isSel(r);
    cb.title = "Include this rule";
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => {
      r.sel = cb.checked;
      if (isAi) for (const it of r.items) it.sel = cb.checked;
      render();
      save();
    };
    const b = document.createElement("b");
    b.textContent = r.rule.name;
    const q = document.createElement("span");
    q.className = "q";
    q.textContent = r.query;
    q.title = r.query;
    const n = document.createElement("span");
    n.className = `n${junkN ? " danger" : ""}`;
    n.textContent = isAi ? `${junkN} to delete · ${r.items.filter((i) => !i.junk).length} kept` : `${r.count} → ${r.rule.action === "delete" ? "Trash" : r.rule.action}`;
    sum.append(cb, b, q, n);
    box.appendChild(sum);
    for (const w of r.warnings || []) {
      const d = document.createElement("div");
      d.className = "bulknote";
      d.textContent = w;
      box.appendChild(d);
    }

    if (!isAi) {
      if (r.items.length) {
        const t = document.createElement("table");
        for (const it of r.items.slice(0, 15)) {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td class="c"></td><td class="who"></td><td class="subj"></td><td class="date"></td>`;
          tr.querySelector(".who").textContent = it.sender || it.email;
          tr.querySelector(".subj").textContent = it.subject;
          tr.querySelector(".date").textContent = (it.date || "").replace(/,.*$/, "");
          t.appendChild(tr);
        }
        const note = document.createElement("div");
        note.className = "bulknote";
        note.textContent = r.count > 15 ? `Newest 15 of ${r.count} shown; all ${r.count} are affected.` : "";
        box.append(t, note);
      } else {
        const note = document.createElement("div");
        note.className = "bulknote";
        note.textContent = "Nothing matches right now.";
        box.appendChild(note);
      }
      main.appendChild(box);
      any = true;
      continue;
    }

    const t = document.createElement("table");
    t.innerHTML = `<thead><tr><th class="c"></th><th class="who">From</th><th>Subject</th><th class="date">Date</th><th class="v">Verdict</th><th class="lab">Label</th><th class="act"></th></tr></thead>`;
    const tb = document.createElement("tbody");
    if (state.group) {
      const keyOf = (it) => (state.group === "sender" ? it.email : it.junk ? "— to delete —" : it.label || "— no label —");
      const groups = new Map();
      for (const it of items) (groups.get(keyOf(it)) || groups.set(keyOf(it), []).get(keyOf(it))).push(it);
      for (const [k, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
        const title = state.group === "sender" ? list[0].sender || k : k;
        const sub = state.group === "sender" ? `${k} · ${list.length}` : `${list.length}`;
        tb.appendChild(groupHead(title, sub, list, 6));
        for (const it of list) tb.appendChild(itemRow(it, r));
      }
    } else for (const it of items) tb.appendChild(itemRow(it, r));
    if (!items.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="7" class="bulknote">Nothing matches the current filter.</td>`;
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    box.appendChild(t);
    main.appendChild(box);
    any = true;
  }
  if (!any) main.innerHTML = `<div class="empty">Nothing matches the current filter.</div>`;
}

function buildPlan() {
  const plan = { bulk: [], ai: [] };
  for (const r of preview.results) {
    if (!isSel(r)) continue;
    if (r.rule.type !== "ai") {
      if (r.count > 0) plan.bulk.push({ rule: r.rule });
      continue;
    }
    const deleteIds = [];
    const labelsMap = {};
    for (const it of r.items) {
      if (!isSel(it)) continue;
      if (it.junk) deleteIds.push(it.id);
      else if (it.label) (labelsMap[it.label] = labelsMap[it.label] || []).push(it.id);
    }
    if (deleteIds.length || Object.keys(labelsMap).length)
      plan.ai.push({ rule: r.rule, query: r.query, deleteIds, labels: labelsMap, maxPages: Math.max(10, (r.rule.maxPages || 10) + 2) });
  }
  plan.unsubscribe = (Array.isArray(preview.subscriptions) ? preview.subscriptions : []).filter((x) => (x.sel === undefined ? x.unsubscribe : x.sel)).map((x) => x.email);
  return plan;
}

async function confirmPlan() {
  const s = stats();
  const plan = buildPlan();
  const msg = `Delete ${s.bulk + s.del} conversation(s) (Trash, recoverable 30 days), label ${s.lab}${s.hasSubs ? `, unsubscribe from ${s.unsub} sender(s)` : ""}?`;
  if (!confirm(msg)) return;
  $("confirm").disabled = true;
  $("rescan").disabled = true;
  $("progress").textContent = "Working in the Gmail tab…";
  try {
    const res = await send("apply", { plan });
    const warns = res.summary.filter((x) => x.warn).map((x) => x.warn);
    const un = res.unsubscribe || [];
    const unDone = un.filter((u) => u.status === "done" || u.status === "clicked").length;
    const needSite = un.filter((u) => u.status === "needs-website");
    const labeled = res.summary.reduce((n, x) => n + (x.labeled || 0), 0);
    $("progress").textContent = `Done: ${res.total} deleted, ${labeled} labeled${s.hasSubs ? `, ${unDone} unsubscribed` : ""}.` + (warns.length ? ` Warnings: ${warns.join(" | ")}` : "");
    $("summary").innerHTML = "";
    $("labelPills").innerHTML = "";
    $("confirm").textContent = "Done";
    const left = document.createElement("div");
    left.className = "empty";
    left.innerHTML = `<p>Cleaned. Run Preview again for another pass.</p>`;
    if (needSite.length) {
      const p = document.createElement("p");
      p.textContent = `These senders need a website visit to unsubscribe: ${needSite.map((u) => u.email).join(", ")}`;
      left.appendChild(p);
    }
    const failed = un.filter((u) => !["done", "clicked", "needs-website"].includes(u.status));
    if (failed.length) {
      const p = document.createElement("p");
      p.textContent = `Could not unsubscribe: ${failed.map((u) => `${u.email} (${u.status})`).join(", ")}`;
      left.appendChild(p);
    }
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
    await send("run", { mode: "scan", openReview: false });
    await load();
    $("progress").textContent = "";
  } catch (e) {
    $("progress").textContent = `Error: ${e.message}`;
  } finally {
    $("rescan").disabled = false;
  }
}

async function load() {
  settings = await send("getSettings");
  preview = await send("previewGet");
  if (!preview) {
    $("main").innerHTML = `<div class="empty">No preview yet. Click the toolbar icon → Preview.</div>`;
    $("meta").textContent = "";
    $("summary").innerHTML = "";
    $("labelPills").innerHTML = "";
    $("confirm").disabled = true;
    return;
  }
  const byCore = new Map();
  for (const l of preview.labels || []) if (!byCore.has(coreOf(l))) byCore.set(coreOf(l), l);
  for (const l of settings.ai.suggestedLabels || []) if (!byCore.has(coreOf(l))) byCore.set(coreOf(l), l);
  labels = [...byCore.values()].sort((a, b) => a.localeCompare(b));
  $("meta").textContent = `previewed ${new Date(preview.at).toLocaleString()}${preview.stopped ? " (stopped early)" : ""} · ${preview.labels?.length || 0} Gmail labels`;
  const rf = $("ruleFilter");
  const cur = rf.value;
  rf.innerHTML = `<option value="">All rules</option>`;
  for (const r of preview.results) rf.appendChild(new Option(r.rule.name, r.rule.id));
  rf.value = cur;
  render();
}

$("search").oninput = () => { state.search = $("search").value.trim(); render(); };
$("ruleFilter").onchange = () => { state.rule = $("ruleFilter").value; render(); };
$("verdictFilter").onchange = () => { state.verdict = $("verdictFilter").value; render(); };
$("groupBy").onchange = () => { state.group = $("groupBy").value; render(); };
$("confirm").onclick = confirmPlan;
$("rescan").onclick = rescan;
let lastAt = null;
browser.storage.onChanged.addListener((ch) => {
  if (ch.progress?.newValue?.text) $("progress").textContent = ch.progress.newValue.text;
  if (ch.lastPreview && ch.lastPreview.newValue && ch.lastPreview.newValue.at !== lastAt) {
    lastAt = ch.lastPreview.newValue.at;
    load();
    $("progress").textContent = "";
  }
});
load().then(() => (lastAt = preview?.at || null));
