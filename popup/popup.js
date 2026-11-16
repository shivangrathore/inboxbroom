const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => browser.runtime.sendMessage({ type, ...extra });

let busy = false;
let settings = null;
let lastScan = null;

const ACTION_LABEL = (r) => (r.action === "label" ? `→ ${r.label || "Cleaned"}` : r.action === "delete" ? "→ Trash" : "→ Archive");

function setStatus(text, kind = "") {
  $("statusText").textContent = text;
  $("status").className = `status ${kind}`;
  $("dot").className = `dot ${kind}`;
}
function setBusy(b) {
  busy = b;
  $("scan").classList.toggle("hidden", b);
  $("clean").classList.toggle("hidden", b);
  $("stop").classList.toggle("hidden", !b);
  if (b) setStatus($("statusText").textContent, "running");
}
function friendlyError(e) {
  const m = e?.message || String(e);
  if (m === "NO_GMAIL_TAB") return "Open Gmail in a tab first.";
  if (m === "Already running") return "A run is already in progress in the Gmail tab.";
  return m;
}
const selectedRuleIds = () => [...settings.rules.filter((r) => r.enabled).map((r) => r.id), ...(settings.retentionEnabled ? ["retention"] : [])];

function renderRules(counts = {}) {
  const root = $("rules");
  root.innerHTML = "";
  for (const r of settings.rules) {
    const div = document.createElement("div");
    div.className = `rule${r.enabled ? "" : " off"}`;
    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!r.enabled;
    cb.onchange = async () => {
      r.enabled = cb.checked;
      div.classList.toggle("off", !r.enabled);
      await send("saveSettings", { patch: { rules: settings.rules } });
    };
    sw.append(cb, document.createElement("span"));
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = r.name;
    name.title = r.query;
    const meta = document.createElement("div");
    meta.className = "meta";
    const c = counts[r.id];
    meta.innerHTML = "";
    if (c != null) {
      const b = document.createElement("span");
      b.className = "count";
      b.textContent = c;
      meta.append(b, document.createTextNode(` to clean · `));
    }
    meta.append(document.createTextNode(`${r.type === "ai" ? "AI" : "search"} ${ACTION_LABEL(r)}`));
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = r.type === "ai" ? "AI" : "bulk";
    div.append(sw, name, pill, meta);
    root.appendChild(div);
  }
  // retention pseudo-rule
  const ret = Object.entries(settings.retention || {}).filter(([, d]) => Number(d) > 0);
  if (ret.length) {
    const div = document.createElement("div");
    div.className = `rule${settings.retentionEnabled ? "" : " off"}`;
    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!settings.retentionEnabled;
    cb.onchange = async () => {
      settings.retentionEnabled = cb.checked;
      div.classList.toggle("off", !cb.checked);
      await send("saveSettings", { patch: { retentionEnabled: cb.checked } });
    };
    sw.append(cb, document.createElement("span"));
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = "Expire inbox mail (archive = keep)";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = ret.map(([l, d]) => `${l === "*" ? "other" : l} ${d}d`).join(" · ") + " → Trash";
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = "bulk";
    div.append(sw, name, pill, meta);
    root.appendChild(div);
  }
}

function renderHistory(history) {
  const ul = $("historyList");
  ul.innerHTML = "";
  $("historyText").textContent = history[0] ? `last: ${new Date(history[0].at).toLocaleString()} · ${history[0].total} cleaned` : "none yet";
  for (const h of history.slice(0, 8)) {
    const li = document.createElement("li");
    li.textContent = `${new Date(h.at).toLocaleString()} – ${h.total} cleaned (${(h.summary || []).map((s) => `${s.count} ${s.rule}`).join(", ")})`;
    ul.appendChild(li);
  }
}

function smallBtn(text, title, onclick) {
  const b = document.createElement("button");
  b.className = "btn sm";
  b.textContent = text;
  b.title = title;
  b.onclick = async (e) => {
    e.stopPropagation();
    b.disabled = true;
    await onclick(b);
  };
  return b;
}

function itemRow(it, r) {
  const li = document.createElement("li");
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = it.sender || it.email;
  who.title = it.email;
  const ctl = document.createElement("div");
  ctl.className = "ctl";

  if (r.rule.type === "ai") {
    const badge = document.createElement("span");
    badge.className = `badge ${it.junk ? "junk" : "keep"}`;
    badge.textContent = `${it.junk ? "junk" : "keep"}${it.score != null ? " " + it.score : ""}`;
    badge.title = it.source === "sender" ? "decided from sender history" : it.source === "manual" ? "your override" : "AI score";
    ctl.appendChild(
      smallBtn(it.junk ? "keep" : "junk", "Flip this verdict", async (b) => {
        it.junk = !it.junk;
        await send("aiCacheSet", { id: it.id, junk: it.junk });
        badge.className = `badge ${it.junk ? "junk" : "keep"}`;
        badge.textContent = it.junk ? "junk" : "keep";
        b.textContent = it.junk ? "keep" : "junk";
        b.disabled = false;
      })
    );
    ctl.appendChild(
      smallBtn("always junk", `Always clean mail from ${it.email}`, async (b) => {
        await send("senderSet", { email: it.email, verdict: "junk" });
        b.textContent = "✓ sender";
      })
    );
    ctl.appendChild(badge);
  }
  if (it.email) {
    ctl.appendChild(
      smallBtn("keep sender", `Never touch mail from ${it.email}`, async (b) => {
        await send("addAllowlist", { entries: [it.email] });
        if (r.rule.type === "ai") await send("senderSet", { email: it.email, verdict: "keep" });
        b.textContent = "✓ kept";
      })
    );
  }
  const subj = document.createElement("div");
  subj.className = "subj";
  subj.textContent = it.subject || "(no subject)";
  subj.title = it.snippet || "";
  li.append(who, ctl, subj);
  if (it.reason) {
    const why = document.createElement("div");
    why.className = "why";
    why.textContent = it.reason;
    li.appendChild(why);
  }
  return li;
}

function renderResults(results, mode) {
  const root = $("results");
  root.innerHTML = "";
  const counts = {};
  for (const r of results) {
    const junkItems = r.rule.type === "ai" ? r.items.filter((i) => i.junk) : r.items;
    const keptItems = r.rule.type === "ai" ? r.items.filter((i) => !i.junk) : [];
    const n = mode === "clean" ? r.done : r.rule.type === "ai" ? junkItems.length : r.count;
    counts[r.rule.id] = n;
    const card = document.createElement("details");
    card.className = "card";
    card.open = mode === "scan" && n > 0;
    const sum = document.createElement("summary");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = r.rule.name;
    const nn = document.createElement("span");
    nn.className = "n";
    nn.textContent = mode === "clean" ? `${r.done} cleaned` : r.rule.type === "ai" ? `${junkItems.length} junk · ${keptItems.length} kept` : `${r.count}`;
    sum.append(t, nn);
    card.appendChild(sum);
    for (const w of r.warnings || []) {
      const d = document.createElement("div");
      d.className = "warn";
      d.textContent = w;
      card.appendChild(d);
    }
    if (mode === "scan" && r.items.length) {
      const ul = document.createElement("ul");
      ul.className = "items";
      const shown = junkItems.slice(0, 50);
      for (const it of shown) ul.appendChild(itemRow(it, r));
      card.appendChild(ul);
      const more = document.createElement("div");
      more.className = "more";
      const restJunk = (r.rule.type === "ai" ? junkItems.length : r.count) - shown.length;
      if (restJunk > 0) more.append(Object.assign(document.createElement("span"), { className: "muted", textContent: `… ${restJunk} more. ` }));
      if (keptItems.length) {
        const showKept = document.createElement("button");
        showKept.className = "link";
        showKept.textContent = `show ${keptItems.length} kept`;
        showKept.onclick = () => {
          for (const it of keptItems) ul.appendChild(itemRow(it, r));
          showKept.remove();
        };
        more.appendChild(showKept);
      }
      if (more.childNodes.length) card.appendChild(more);
    }
    root.appendChild(card);
  }
  renderRules(mode === "scan" ? counts : {});
}

async function runMode(mode) {
  const ruleIds = selectedRuleIds();
  if (!ruleIds.length) return setStatus("Turn on at least one rule.", "error");
  if (mode === "scan") {
    setBusy(true);
    setStatus("Previewing… the review page opens when done.", "running");
    try {
      await send("run", { mode: "scan", ruleIds });
      setStatus("Preview ready in the review tab.", "ok");
      window.close();
    } catch (e) {
      setStatus(friendlyError(e), "error");
    } finally {
      setBusy(false);
    }
    return;
  }
  if (mode === "clean") {
    const active = settings.rules.filter((r) => ruleIds.includes(r.id));
    const hasDelete = active.some((r) => r.action === "delete");
    if (!confirm(`Clean with ${active.length} rule(s) now?` + (hasDelete ? "\n\nSome rules move mail to Trash (purged after 30 days)." : "") + "\n\nTip: Preview first."))
      return;
  }
  setBusy(true);
  $("results").innerHTML = "";
  setStatus(mode === "scan" ? "Previewing… watch the Gmail tab." : "Cleaning… watch the Gmail tab.", "running");
  try {
    const res = await send("run", { mode, ruleIds });
    if (mode === "scan") lastScan = res;
    renderResults(res.results, mode);
    const total = mode === "scan" ? res.results.reduce((n, r) => n + (r.rule.type === "ai" ? r.items.filter((i) => i.junk).length : r.count), 0) : res.total;
    setStatus(
      (mode === "scan" ? `${total} conversation(s) would be cleaned.` : `Cleaned ${total} conversation(s).`) + (res.stopped ? " Stopped early." : ""),
      "ok"
    );
    settings = await send("getSettings");
    renderHistory(settings.history || []);
  } catch (e) {
    setStatus(friendlyError(e), "error");
  } finally {
    setBusy(false);
  }
}

async function refresh() {
  settings = await send("getSettings");
  renderRules();
  renderHistory(settings.history || []);
  const pv = await send("previewGet");
  $("review").classList.toggle("hidden", !pv);
  const st = await send("status");
  if (!st.hasTab) setStatus("No Gmail tab open. Preview/Clean will open one.");
  if (st.running) {
    const { progress } = await browser.storage.local.get("progress");
    setBusy(true);
    setStatus(progress?.text || "Running…", "running");
  } else {
    setBusy(false);
    if (st.hasTab) setStatus("Ready.");
  }
}

$("scan").onclick = () => runMode("scan");
$("review").onclick = () => send("openReview").then(() => window.close());
$("clean").onclick = () => runMode("clean");
$("stop").onclick = () => send("stop");
$("openOptions").onclick = () => browser.runtime.openOptionsPage();
$("historyBtn").onclick = () => $("historyList").classList.toggle("hidden");
browser.storage.onChanged.addListener((ch) => {
  if (ch.progress?.newValue?.text && busy) setStatus(ch.progress.newValue.text, "running");
});
refresh();
