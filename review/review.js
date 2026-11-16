const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => browser.runtime.sendMessage({ type, ...extra });

let preview = null; // { at, results, labels }
let settings = null;
let labels = [];
const state = { search: "", rule: "", verdict: "", group: false };

function save() {
  return send("previewSave", { preview });
}

function stats() {
  let del = 0, keep = 0, lab = 0, bulk = 0;
  for (const r of preview.results) {
    if (r.rule.type === "ai") {
      for (const it of r.items) {
        if (it.junk && it.sel !== false) del++;
        else if (!it.junk) {
          keep++;
          if (it.label && it.sel !== false) lab++;
        }
      }
    } else if (r.sel !== false) bulk += r.count;
  }
  const unsub = (preview.subscriptions && Array.isArray(preview.subscriptions) ? preview.subscriptions : []).filter((x) => x.sel === undefined ? x.unsubscribe : x.sel).length;
  return { del, keep, lab, bulk, unsub };
}

function renderSummary() {
  const s = stats();
  $("summary").innerHTML = "";
  for (const [n, t] of [
    [s.bulk, "bulk delete (Promotions/Social…)"],
    [s.del, "AI junk to delete"],
    [s.lab, "to label"],
    [s.keep, "kept in inbox"],
    [s.unsub, "to unsubscribe"],
  ]) {
    const d = document.createElement("div");
    d.className = "stat" + (t.includes("delete") || t.includes("unsubscribe") ? " danger" : "");
    d.innerHTML = `<b></b><span></span>`;
    d.querySelector("b").textContent = n;
    d.querySelector("span").textContent = t;
    $("summary").appendChild(d);
  }
  $("confirm").textContent = `Delete ${s.bulk + s.del} · Label ${s.lab} · Unsubscribe ${s.unsub}`;
  $("confirm").disabled = s.bulk + s.del + s.lab + s.unsub === 0;
}

function matches(it) {
  if (state.verdict === "junk" && !it.junk) return false;
  if (state.verdict === "keep" && it.junk) return false;
  if (state.search) {
    const q = state.search.toLowerCase();
    if (!`${it.sender} ${it.email} ${it.subject} ${it.reason || ""} ${it.label || ""}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

function labelSelect(it) {
  const sel = document.createElement("select");
  sel.className = "lab";
  const none = new Option("— no label —", "");
  sel.appendChild(none);
  for (const l of labels) sel.appendChild(new Option(l, l));
  if (it.label && !labels.includes(it.label)) sel.appendChild(new Option(it.label, it.label));
  sel.value = it.label || "";
  sel.onchange = async () => {
    it.label = sel.value;
    if (it.email) await send("senderSet", { email: it.email, verdict: null, label: it.label });
    renderSummary();
    save();
  };
  return sel;
}

function itemRow(it, r) {
  const tr = document.createElement("tr");
  if (it.sel === false) tr.classList.add("off");
  const c = document.createElement("td");
  c.className = "c";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = it.sel !== false;
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
  subj.title = it.reason || "";

  const date = document.createElement("td");
  date.className = "date";
  date.textContent = (it.date || "").replace(/,.*$/, "");

  const v = document.createElement("td");
  v.className = "v";
  const badge = document.createElement("span");
  badge.className = `badge ${it.junk ? "junk" : "keep"}`;
  badge.textContent = it.junk ? `delete ${it.score ?? ""}` : "keep";
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
  const mk = (text, title, fn) => {
    const b = document.createElement("button");
    b.className = "btn sm";
    b.textContent = text;
    b.title = title;
    b.onclick = async () => {
      b.disabled = true;
      await fn(b);
    };
    return b;
  };
  if (it.email) {
    act.appendChild(
      mk(it.junk ? "always delete" : "always keep", `Remember this for ${it.email}`, async (b) => {
        await send("senderSet", { email: it.email, verdict: it.junk ? "junk" : "keep", label: it.label || undefined });
        if (!it.junk) await send("addAllowlist", { entries: [it.email] });
        // apply to all items from this sender in the preview
        for (const rr of preview.results) for (const x of rr.items) if (x.email === it.email) { x.junk = it.junk; x.sel = true; if (!it.junk) x.label = x.label || it.label; }
        render();
        save();
      })
    );
  }
  tr.append(c, who, subj, date, v, lab, act);
  return tr;
}

function renderSubscriptions(main) {
  const subs = preview.subscriptions;
  if (!subs) return;
  const box = document.createElement("div");
  box.className = "rule";
  const head = document.createElement("div");
  head.className = "head";
  const b = document.createElement("b");
  b.textContent = "Subscriptions (Gmail → Manage subscriptions)";
  head.appendChild(b);
  box.appendChild(head);
  if (subs.error) {
    const n = document.createElement("div");
    n.className = "bulknote";
    n.textContent = subs.error;
    box.appendChild(n);
    main.appendChild(box);
    return;
  }
  const list = subs.filter((x) => {
    if (state.verdict === "junk" && !x.unsubscribe) return false;
    if (state.verdict === "keep" && x.unsubscribe) return false;
    if (state.search && !`${x.name} ${x.email} ${x.reason || ""} ${(x.subjects || []).join(" ")}`.toLowerCase().includes(state.search.toLowerCase())) return false;
    return true;
  }).sort((a, b) => (b.unsubscribe - a.unsubscribe) || (b.count || 0) - (a.count || 0));
  if (!list.length) return;
  const t = document.createElement("table");
  t.innerHTML = `<thead><tr><th></th><th>Sender</th><th>Recent subjects</th><th>Mails</th><th>AI</th><th></th></tr></thead>`;
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
    cb.title = "Unsubscribe on confirm";
    cb.onchange = () => {
      x.sel = cb.checked;
      tr.classList.toggle("off", !cb.checked);
      renderSummary();
      save();
    };
    c.appendChild(cb);
    const who = document.createElement("td");
    who.className = "who";
    who.innerHTML = `<div></div><small class="muted"></small>`;
    who.querySelector("div").textContent = x.name || x.email;
    who.querySelector("small").textContent = x.email;
    const subj = document.createElement("td");
    subj.className = "subj";
    subj.textContent = (x.subjects || []).join(" · ") || "—";
    subj.title = subj.textContent;
    const cnt = document.createElement("td");
    cnt.className = "date";
    cnt.textContent = x.count ?? "";
    const v = document.createElement("td");
    v.className = "v";
    const badge = document.createElement("span");
    badge.className = `badge ${x.unsubscribe ? "junk" : "keep"}`;
    badge.textContent = x.unsubscribe ? "unsubscribe" : "keep";
    badge.title = `${x.reason || ""}\nClick to flip`;
    badge.onclick = () => {
      x.unsubscribe = !x.unsubscribe;
      x.sel = x.unsubscribe;
      render();
      save();
    };
    v.appendChild(badge);
    const why = document.createElement("td");
    why.className = "why";
    why.textContent = x.reason || "";
    if (x.status) why.textContent = `${x.status}${x.error ? ": " + x.error : ""}`;
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
  if (!state.rule) {
    renderSubscriptions(main);
    any = !!preview.subscriptions;
  }
  for (const r of preview.results) {
    if (state.rule && r.rule.id !== state.rule) continue;
    const box = document.createElement("div");
    box.className = "rule";
    const head = document.createElement("div");
    head.className = "head";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = r.sel !== false;
    cb.title = "Include this rule";
    cb.onchange = () => {
      r.sel = cb.checked;
      if (r.rule.type === "ai") for (const it of r.items) it.sel = cb.checked;
      render();
      save();
    };
    const b = document.createElement("b");
    b.textContent = r.rule.name;
    const q = document.createElement("span");
    q.className = "q";
    q.textContent = r.query;
    head.append(cb, b, q);
    box.appendChild(head);

    if (r.rule.type !== "ai") {
      const note = document.createElement("div");
      note.className = "bulknote";
      note.textContent = `${r.count} conversation(s) match → ${r.rule.action === "delete" ? "Trash" : r.rule.action}. Sample of the newest:`;
      box.appendChild(note);
      if (r.items.length) {
        const t = document.createElement("table");
        for (const it of r.items.slice(0, 15).filter(matches)) {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td class="who"></td><td class="subj"></td><td class="date"></td>`;
          tr.querySelector(".who").textContent = it.sender || it.email;
          tr.querySelector(".subj").textContent = it.subject;
          tr.querySelector(".date").textContent = (it.date || "").replace(/,.*$/, "");
          t.appendChild(tr);
        }
        box.appendChild(t);
      }
      main.appendChild(box);
      any = true;
      continue;
    }

    const items = r.items.filter(matches).sort((a, b) => (b.junk - a.junk) || (b.score || 0) - (a.score || 0));
    if (!items.length) continue;
    const t = document.createElement("table");
    t.innerHTML = `<thead><tr><th></th><th>From</th><th>Subject</th><th>Date</th><th>Verdict</th><th>Label</th><th></th></tr></thead>`;
    const tb = document.createElement("tbody");
    if (state.group) {
      const bySender = new Map();
      for (const it of items) (bySender.get(it.email) || bySender.set(it.email, []).get(it.email)).push(it);
      for (const [email, list] of [...bySender].sort((a, b) => b[1].length - a[1].length)) {
        const h = document.createElement("tr");
        h.className = "sender-head";
        h.innerHTML = `<td class="c"><input type="checkbox"></td><td colspan="6"><span></span><span class="n"></span></td>`;
        h.querySelector("span").textContent = list[0].sender || email;
        h.querySelector(".n").textContent = `${email} · ${list.length}`;
        const gcb = h.querySelector("input");
        gcb.checked = list.every((x) => x.sel !== false);
        gcb.onchange = () => {
          for (const x of list) x.sel = gcb.checked;
          render();
          save();
        };
        tb.appendChild(h);
        for (const it of list) tb.appendChild(itemRow(it, r));
      }
    } else for (const it of items) tb.appendChild(itemRow(it, r));
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
    if (r.sel === false) continue;
    if (r.rule.type !== "ai") {
      if (r.count > 0) plan.bulk.push({ rule: r.rule });
      continue;
    }
    const deleteIds = [];
    const labelsMap = {};
    for (const it of r.items) {
      if (it.sel === false) continue;
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
  const msg = `Delete ${s.bulk + s.del} conversation(s) (Trash, recoverable 30 days), label ${s.lab}, unsubscribe from ${s.unsub} sender(s)?`;
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
    $("progress").textContent = `Done: ${res.total} deleted, ${res.summary.reduce((n, x) => n + (x.labeled || 0), 0)} labeled, ${unDone} unsubscribed.` + (warns.length ? ` Warnings: ${warns.join(" | ")}` : "");
    $("summary").innerHTML = "";
    $("confirm").textContent = "Done";
    const left = document.createElement("div");
    left.className = "empty";
    left.innerHTML = `<p>Cleaned. Run Preview again from the toolbar popup for another pass.</p>`;
    if (needSite.length) {
      const p = document.createElement("p");
      p.textContent = `These senders need a website visit to unsubscribe (Gmail → Manage subscriptions → Unsubscribe → Go to website): ${needSite.map((u) => u.email).join(", ")}`;
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
    $("confirm").disabled = true;
    return;
  }
  const core = (l) => String(l).replace(/^\[|\]$/g, "").replace(/^[@#!]/, "").trim().toLowerCase();
  const byCore = new Map();
  for (const l of preview.labels || []) if (!byCore.has(core(l))) byCore.set(core(l), l);
  for (const l of settings.ai.suggestedLabels || []) if (!byCore.has(core(l))) byCore.set(core(l), l);
  labels = [...byCore.values()].sort((a, b) => a.localeCompare(b));
  $("meta").textContent = `previewed ${new Date(preview.at).toLocaleString()}${preview.stopped ? " (stopped early)" : ""} · ${preview.labels?.length || 0} Gmail labels found`;
  const rf = $("ruleFilter");
  rf.innerHTML = `<option value="">All rules</option>`;
  for (const r of preview.results) rf.appendChild(new Option(r.rule.name, r.rule.id));
  render();
}

$("search").oninput = () => { state.search = $("search").value.trim(); render(); };
$("ruleFilter").onchange = () => { state.rule = $("ruleFilter").value; render(); };
$("verdictFilter").onchange = () => { state.verdict = $("verdictFilter").value; render(); };
$("groupBySender").onchange = () => { state.group = $("groupBySender").checked; render(); };
$("confirm").onclick = confirmPlan;
$("rescan").onclick = rescan;
browser.storage.onChanged.addListener((ch) => {
  if (ch.progress?.newValue?.text) $("progress").textContent = ch.progress.newValue.text;
});
load();
