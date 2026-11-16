const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => browser.runtime.sendMessage({ type, ...extra });

let busy = false;
let settings = null;

const ACTION_LABEL = (r) => (r.action === "label" ? `→ ${r.label || "Cleaned"}` : r.action === "delete" ? "→ Trash" : "→ Archive");
const COLOR_HEX = { red: "#fb4c2f", orange: "#ffad47", yellow: "#fad165", green: "#16a766", teal: "#43d692", blue: "#4a86e8", purple: "#a479e2", pink: "#f691b3", gray: "#cccccc", brown: "#ac2e00" };

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}
function setStatus(text, kind = "") {
  $("statusText").textContent = text;
  $("status").className = `card status ${kind}`;
  $("dot").className = `dot ${kind === "running" ? "busy" : kind === "error" ? "bad" : kind === "ok" ? "ok" : ""}`;
  $("bar").classList.toggle("hidden", kind !== "running");
}
function setBusy(b) {
  busy = b;
  $("scan").classList.toggle("hidden", b);
  $("stop").classList.toggle("hidden", !b);
  $("clean").disabled = b;
  $("createLabels").disabled = b;
}
function friendlyError(e) {
  const m = e?.message || String(e);
  if (m === "NO_GMAIL_TAB") return "Open Gmail in a tab first.";
  if (m === "Already running") return "A run is already in progress in the Gmail tab.";
  return m;
}
const selectedRuleIds = () => [...settings.rules.filter((r) => r.enabled).map((r) => r.id), ...(settings.retentionEnabled ? ["retention"] : [])];

function showPage(name) {
  for (const p of document.querySelectorAll(".page")) p.classList.toggle("hidden", p.id !== `page-${name}`);
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.page === name);
  try { localStorage.setItem("tab", name); } catch {}
}

function toggleRow({ on, title, meta, pill, onchange, off }) {
  const row = document.createElement("div");
  row.className = `row rule-row${on ? "" : " off"}`;
  const sw = document.createElement("label");
  sw.className = "switch";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = on;
  cb.onchange = () => {
    row.classList.toggle("off", !cb.checked);
    onchange(cb.checked);
  };
  sw.append(cb, document.createElement("span"));
  const grow = document.createElement("div");
  grow.className = "grow";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = title;
  const m = document.createElement("div");
  m.className = "meta";
  m.textContent = meta;
  grow.append(t, m);
  row.append(sw, grow);
  if (pill) {
    const p = document.createElement("span");
    p.className = "pill";
    p.textContent = pill;
    row.appendChild(p);
  }
  return row;
}

function renderRules() {
  const root = $("rules");
  root.innerHTML = "";
  for (const r of settings.rules) {
    root.appendChild(
      toggleRow({
        on: !!r.enabled,
        title: r.name,
        meta: `${r.type === "ai" ? "AI" : "search"} ${ACTION_LABEL(r)} · ${r.query}`,
        pill: r.type === "ai" ? "AI" : "bulk",
        onchange: async (v) => {
          r.enabled = v;
          await send("saveSettings", { patch: { rules: settings.rules } });
        },
      })
    );
  }
  const ret = Object.entries(settings.retention || {}).filter(([, d]) => Number(d) > 0);
  if (ret.length) {
    root.appendChild(
      toggleRow({
        on: !!settings.retentionEnabled,
        title: "Expire inbox mail (archive = keep)",
        meta: ret.map(([l, d]) => `${l === "*" ? "other" : l} ${d}d`).join(" · ") + " → Trash",
        pill: "bulk",
        onchange: async (v) => {
          settings.retentionEnabled = v;
          await send("saveSettings", { patch: { retentionEnabled: v } });
        },
      })
    );
  }
}

async function renderLabels() {
  const { knownLabels = [] } = await browser.storage.local.get("knownLabels");
  const root = $("labelList");
  root.innerHTML = "";
  $("labelCount").textContent = knownLabels.length ? `${knownLabels.length} found` : "none read yet";
  if (!knownLabels.length) {
    root.innerHTML = `<div class="empty">Run a preview or Organize labels to read your Gmail labels.</div>`;
    return;
  }
  const core = (l) => l.replace(/^\[|\]$/g, "").replace(/^[@#!]/, "").toLowerCase();
  const style = settings.labelStyle || {};
  for (const l of [...knownLabels].sort((a, b) => a.localeCompare(b))) {
    const st = Object.entries(style).find(([k]) => k.toLowerCase() === core(l))?.[1];
    const row = document.createElement("div");
    row.className = "row";
    const d = document.createElement("span");
    d.className = "ldot";
    if (st?.color && COLOR_HEX[st.color]) d.style.background = COLOR_HEX[st.color];
    const grow = document.createElement("div");
    grow.className = "grow";
    grow.innerHTML = `<div class="t"></div><div class="s"></div>`;
    grow.querySelector(".t").textContent = l;
    grow.querySelector(".s").textContent = st ? `${st.color || "no color"} · ${st.show === "unread" ? "show if unread" : st.show || "sidebar unchanged"}` : "your label";
    row.append(d, grow);
    root.appendChild(row);
  }
}

function renderHistory(history) {
  const root = $("historyList");
  root.innerHTML = "";
  if (!history.length) {
    root.innerHTML = `<div class="empty">No runs yet.</div>`;
    $("lastRun").textContent = "";
    return;
  }
  const h0 = history[0];
  $("lastRun").textContent = `Last run ${new Date(h0.at).toLocaleString()} · ${h0.total} deleted`;
  for (const h of history.slice(0, 20)) {
    const row = document.createElement("div");
    row.className = "row";
    const grow = document.createElement("div");
    grow.className = "grow";
    const labeled = (h.summary || []).reduce((n, x) => n + (x.labeled || 0), 0);
    grow.innerHTML = `<div class="t"></div><div class="s"></div>`;
    grow.querySelector(".t").textContent = `${h.total} deleted${labeled ? ` · ${labeled} labeled` : ""}`;
    grow.querySelector(".s").textContent = `${new Date(h.at).toLocaleString()} · ${(h.summary || []).filter((x) => x.count).map((x) => `${x.count} ${x.rule}`).join(", ") || "nothing matched"}`;
    row.appendChild(grow);
    const warn = (h.summary || []).filter((x) => x.warn).length;
    if (warn) {
      const b = document.createElement("span");
      b.className = "badge junk";
      b.textContent = `${warn} warning${warn > 1 ? "s" : ""}`;
      row.appendChild(b);
    }
    root.appendChild(row);
  }
}

async function runMode(mode) {
  const ruleIds = selectedRuleIds();
  if (!ruleIds.length) return setStatus("Turn on at least one rule.", "error");
  if (mode === "scan") {
    setBusy(true);
    setStatus("Previewing… the review tab opens when done.", "running");
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
  const active = settings.rules.filter((r) => ruleIds.includes(r.id));
  if (!confirm(`Clean with ${active.length} rule(s) now, without review?\n\nDeleted mail goes to Trash (30-day undo).`)) return;
  setBusy(true);
  setStatus("Cleaning… watch the Gmail tab.", "running");
  try {
    const res = await send("run", { mode: "clean", ruleIds });
    setStatus(`Cleaned ${res.total} conversation(s).${res.stopped ? " Stopped early." : ""}`, "ok");
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
  renderLabels();
  const pv = await send("previewGet");
  $("review").classList.toggle("hidden", !pv);
  const st = await send("status");
  if (!st.hasTab) setStatus("No Gmail tab open. Preview will open one.", "");
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
$("clean").onclick = () => runMode("clean");
$("stop").onclick = () => send("stop");
$("review").onclick = () => send("openReview").then(() => window.close());
$("openOptions").onclick = () => browser.runtime.openOptionsPage();
$("editRules").onclick = () => browser.runtime.openOptionsPage();
$("createLabels").onclick = async () => {
  setBusy(true);
  showPage("clean");
  setStatus("Organizing labels… watch the Gmail tab.", "running");
  try {
    const r = await send("organizeLabels");
    setStatus(`Labels: ${r.created.length} created, ${r.renamed.length} renamed, ${r.colored.length} colored.` + (r.errors.length ? `\n${r.errors.length} error(s). First: ${r.errors[0]}` : ""), r.errors.length ? "error" : "ok");
    renderLabels();
  } catch (e) {
    setStatus(friendlyError(e), "error");
  } finally {
    setBusy(false);
  }
};
for (const t of document.querySelectorAll(".tab")) t.onclick = () => showPage(t.dataset.page);
browser.storage.onChanged.addListener((ch) => {
  if (ch.progress?.newValue?.text && busy) setStatus(ch.progress.newValue.text, "running");
  if (ch.knownLabels) renderLabels();
});
try { showPage(localStorage.getItem("tab") || "clean"); } catch { showPage("clean"); }
refresh();
