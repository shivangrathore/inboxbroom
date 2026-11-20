const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => browser.__send({ type, ...extra });
let defaultPrompt = "";


const GMAIL_COLOR_NAMES = ["", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray", "brown"];
function styleRow(label, st = {}) {
  const tr = document.createElement("tr");
  tr.dataset.label = label;
  tr.innerHTML = `<td></td><td><select class="sc"></select></td><td><select class="sv"><option value="">leave</option><option value="show">show (pinned)</option><option value="unread">show if unread</option><option value="hide">hide (under More)</option></select></td>`;
  tr.querySelector("td").textContent = label;
  const sc = tr.querySelector(".sc");
  for (const c of GMAIL_COLOR_NAMES) sc.appendChild(new Option(c || "leave", c));
  sc.value = st.color || "";
  tr.querySelector(".sv").value = st.show || "";
  return tr;
}
function readLabelStyle() {
  const out = {};
  for (const tr of document.querySelectorAll("#labelStyle tbody tr")) {
    const color = tr.querySelector(".sc").value;
    const show = tr.querySelector(".sv").value;
    if (color || show) out[tr.dataset.label] = { ...(color ? { color } : {}), ...(show ? { show } : {}) };
  }
  return out;
}
function retentionRow(label = "", days = "") {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><input type="text" class="rl" placeholder="Orders" title='"*" = anything else in the inbox'></td><td><input type="number" class="rd" min="0" max="3650"></td><td><button class="btn icon del" title="Remove">✕</button></td>`;
  tr.querySelector(".rl").value = label;
  tr.querySelector(".rd").value = days;
  tr.querySelector(".del").onclick = () => tr.remove();
  return tr;
}
function readRetention() {
  const out = {};
  for (const tr of document.querySelectorAll("#retention tbody tr")) {
    const l = tr.querySelector(".rl").value.trim();
    const d = Number(tr.querySelector(".rd").value) || 0;
    if (l) out[l] = d;
  }
  return out;
}

function ruleRow(rule = {}) {
  const card = document.createElement("div");
  card.className = "rule";
  card.dataset.id = rule.id || `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  card.innerHTML = `
    <div class="rule-row">
      <label class="switch sm" title="Enabled"><input type="checkbox" class="on"><span></span></label>
      <div class="rule-main">
        <div class="rule-name"></div>
        <div class="rule-q mono"></div>
      </div>
      <span class="badge rule-type"></span>
      <span class="rule-act"></span>
      <button class="btn icon edit" title="Edit rule" aria-label="Edit rule"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg></button>
    </div>
    <div class="rule-editor hidden">
      <div class="ed-grid">
        <div class="field"><label>Name</label><input type="text" class="name" placeholder="Rule name"></div>
        <div class="field"><label>Type</label><select class="type"><option value="query">Bulk: act on everything the search returns</option><option value="ai">AI: score each mail, act on junk, label the rest</option></select></div>
        <div class="field"><label>Action</label><select class="action"><option value="delete">Delete (Trash, 30-day undo)</option><option value="archive">Archive</option><option value="label">Label + archive</option></select></div>
        <div class="field lab-wrap"><label>Label</label><input type="text" class="label" placeholder="Label name" spellcheck="false"></div>
        <div class="field span2"><label>Gmail search</label><textarea class="query" rows="1" spellcheck="false" placeholder="e.g. category:promotions -is:starred"></textarea></div>
      </div>
      <div class="ed-foot">
        <label class="opt"><span class="switch sm"><input type="checkbox" class="inbox"><span></span></span><span>Inbox only</span><span class="muted">· archived mail is never touched</span></label>
        <label class="opt pages-wrap"><span>Pages to scan</span><input type="number" class="pages" min="1" max="40"></label>
        <button class="btn sm danger-outline del">Remove rule</button>
      </div>
    </div>`;
  const q = (sel) => card.querySelector(sel);
  q(".on").checked = rule.enabled !== false;
  q(".type").value = rule.type === "ai" ? "ai" : "query";
  q(".name").value = rule.name || "";
  q(".query").value = rule.query || "";
  q(".action").value = rule.action === "trash" ? "delete" : rule.action || "delete";
  q(".label").value = rule.label || "";
  q(".inbox").checked = rule.inboxOnly !== false;
  q(".pages").value = rule.maxPages || 10;
  const grow = () => { const t = q(".query"); t.style.height = "auto"; t.style.height = Math.max(40, t.scrollHeight + 2) + "px"; };
  const sync = () => {
    const ai = q(".type").value === "ai";
    const act = q(".action").value;
    q(".pages-wrap").classList.toggle("hidden", !ai);
    q(".lab-wrap").classList.toggle("hidden", act !== "label");
    q(".rule-name").textContent = q(".name").value.trim() || "Untitled rule";
    q(".rule-q").textContent = q(".query").value.trim().replace(/\s+/g, " ") || "no search yet";
    const tb = q(".rule-type");
    tb.textContent = ai ? "AI" : "Bulk";
    tb.className = `badge rule-type ${ai ? "label" : "neutral"}`;
    const ab = q(".rule-act");
    ab.textContent = act === "delete" ? "Trash" : act === "label" ? `Label ${q(".label").value.trim() || "…"}` : "Archive";
    ab.className = `rule-act ${act === "delete" ? "act-del" : "act-keep"}`;
    card.classList.toggle("off", !q(".on").checked);
  };
  for (const el of card.querySelectorAll("input, select, textarea")) el.addEventListener("input", sync);
  for (const el of card.querySelectorAll("select, .on")) el.addEventListener("change", sync);
  q(".query").addEventListener("input", grow);
  q(".on").addEventListener("click", (e) => e.stopPropagation());
  q(".rule-row").addEventListener("click", (e) => {
    if (e.target.closest(".switch")) return;
    const open = q(".rule-editor").classList.toggle("hidden");
    card.classList.toggle("open", !open);
    if (!open) { grow(); q(".name").focus(); }
  });
  q(".del").onclick = () => card.remove();
  sync();
  return card;
}

function readRules() {
  return [...document.querySelectorAll("#rulesList .rule")]
    .map((c) => ({
      id: c.dataset.id,
      type: c.querySelector(".type").value,
      enabled: c.querySelector(".on").checked,
      name: c.querySelector(".name").value.trim() || c.querySelector(".query").value.trim(),
      query: c.querySelector(".query").value.trim().replace(/\s+/g, " "),
      action: c.querySelector(".action").value,
      label: c.querySelector(".label").value.trim() || "Cleaned",
      inboxOnly: c.querySelector(".inbox").checked,
      maxPages: Math.max(1, Number(c.querySelector(".pages").value) || 10),
    }))
    .filter((r) => r.query);
}

let loadedOk = false;
for (const c of document.querySelectorAll("#oaPresets .chip")) c.onclick = () => { $("oaEndpoint").value = c.dataset.url; if (!$("oaModel").value.trim() || $("oaModel").dataset.preset) { $("oaModel").value = c.dataset.model; $("oaModel").dataset.preset = "1"; } };
$("oaModel")?.addEventListener("input", () => delete $("oaModel").dataset.preset);

async function loadInner() {
  const s = await send("getSettings");
  const rulesRoot = document.querySelector("#rulesList");
  rulesRoot.innerHTML = "";
  for (const r of s.rules) rulesRoot.appendChild(ruleRow(r));
  $("allowlist").value = (s.allowlist || []).join("\n");
  $("labelFormat").value = s.labelFormat || "[{name}]";
  const sb = document.querySelector("#labelStyle tbody");
  sb.innerHTML = "";
  for (const l of [...new Set([...(s.ai.suggestedLabels || []), ...Object.keys(s.labelStyle || {})])]) sb.appendChild(styleRow(l, s.labelStyle?.[l]));
  for (const b of document.querySelectorAll("#themeSeg button")) b.classList.toggle("active", (s.theme || "system") === b.dataset.v);
  $("retentionEnabled").checked = s.retentionEnabled !== false;
  const rb = document.querySelector("#retention tbody");
  rb.innerHTML = "";
  const labelsForRet = [...new Set([...(s.ai.suggestedLabels || []), ...Object.keys(s.retention || {}).filter((k) => k !== "*"), "*"])];
  for (const l of labelsForRet) rb.appendChild(retentionRow(l, s.retention?.[l] || ""));
  $("returnToInbox").checked = s.returnToInbox !== false;
  $("autoClean").checked = !!s.autoClean;
  $("autoInterval").value = s.autoIntervalHours || 24;
  $("aiProvider").value = s.ai.provider || "ollama";
  $("oaEndpoint").value = s.ai.openaiEndpoint || "https://api.openai.com/v1";
  $("oaKey").value = s.ai.openaiKey || "";
  $("oaModel").value = s.ai.openaiModel || "gpt-4o-mini";
  $("anKey").value = s.ai.anthropicKey || "";
  $("anModel").value = s.ai.anthropicModel || "claude-opus-5-5";
  $("anBatch").value = s.ai.batchSize;
  syncProvider();
  $("aiEndpoint").value = s.ai.endpoint;
  $("aiModel").value = s.ai.model;
  $("aiBatch").value = s.ai.batchSize;
  $("aiKeepAlive").value = s.ai.keepAlive || "1m";
  $("aiThreshold").value = s.ai.threshold ?? 60;
  $("thrVal").textContent = $("aiThreshold").value;
  $("aiSenderMemory").checked = s.ai.senderMemory !== false;
  $("aiHeuristics").checked = s.ai.heuristics !== false;
  $("aiPersona").value = s.ai.persona || "";
  $("aiUnsub").checked = s.ai.unsubscribe !== false;
  $("aiLabeling").checked = s.ai.labeling !== false;
  $("aiSuggested").value = (s.ai.suggestedLabels || []).join(", ");
  $("aiIgnore").value = (s.ai.ignoreLabels || []).join(", ");
  $("aiPrompt").value = s.ai.prompt;
  if (!defaultPrompt) defaultPrompt = s.ai.prompt;
}

function syncProvider() {
  const p = $("aiProvider").value;
  $("provOllama").classList.toggle("hidden", p !== "ollama");
  $("provOpenai").classList.toggle("hidden", p !== "openai");
  $("provAnthropic").classList.toggle("hidden", p !== "anthropic");
}
$("aiProvider").onchange = syncProvider;

/** Cloud providers live on arbitrary hosts: ask Firefox for that origin once,
 * plus (Firefox) consent to send mail text there unless the endpoint is on this machine. */
async function ensureHostPermission(ai) {
  let url = null;
  if (ai.provider === "openai") { try { url = new URL(ai.openaiEndpoint); } catch {} }
  if (ai.provider === "anthropic") url = new URL("https://api.anthropic.com");
  if (!url) return true;
  const req = { origins: [url.origin + "/*"] };
  if (!browser.__isChromium && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) req.data_collection = ["personalCommunications"];
  if (await browser.permissions.contains(req)) return true;
  return browser.permissions.request(req);
}

function readAi() {
  return {
    provider: $("aiProvider").value,
    openaiEndpoint: $("oaEndpoint").value.trim() || "https://api.openai.com/v1",
    openaiKey: $("oaKey").value.trim(),
    openaiModel: $("oaModel").value.trim() || "gpt-4o-mini",
    anthropicKey: $("anKey").value.trim(),
    anthropicModel: $("anModel").value.trim() || "claude-opus-5-5",
    endpoint: $("aiEndpoint").value.trim() || "http://127.0.0.1:11434",
    model: $("aiModel").value.trim() || "qwen3:4b",
    batchSize: Math.max(1, Math.min(30, Number($("aiProvider").value === "anthropic" ? $("anBatch").value : $("aiBatch").value) || 12)),
    keepAlive: $("aiKeepAlive").value.trim() || "1m",
    threshold: Number($("aiThreshold").value) || 60,
    senderMemory: $("aiSenderMemory").checked,
    heuristics: $("aiHeuristics").checked,
    persona: $("aiPersona").value.trim() || "a person",
    unsubscribe: $("aiUnsub").checked,
    labeling: $("aiLabeling").checked,
    suggestedLabels: $("aiSuggested").value.split(",").map((x) => x.trim()).filter(Boolean),
    ignoreLabels: $("aiIgnore").value.split(",").map((x) => x.trim()).filter(Boolean),
    prompt: $("aiPrompt").value.trim() || defaultPrompt,
  };
}

async function load() {
  $("save").disabled = true;
  try {
    await loadInner();
    loadedOk = true;
    $("save").disabled = false;
  } catch (e) {
    console.error("[Inbox Broom] settings load failed", e);
    $("saved").textContent = `Settings failed to load (${e.message}). Saving is disabled; reload the page.`;
  }
}

async function save() {
  if (!loadedOk) return;
  const aiNow = readAi();
  if (aiNow.provider !== "ollama") ensureHostPermission(aiNow).catch(() => {});
  await send("saveSettings", {
    patch: {
      rules: readRules(),
      allowlist: $("allowlist").value.split("\n").map((l) => l.trim()).filter(Boolean),
      returnToInbox: $("returnToInbox").checked,
      labelFormat: $("labelFormat").value.trim() || "[{name}]",
      labelStyle: readLabelStyle(),
      theme: document.querySelector("#themeSeg button.active")?.dataset.v || "system",
      retentionEnabled: $("retentionEnabled").checked,
      retention: readRetention(),
      autoClean: $("autoClean").checked,
      autoIntervalHours: Math.max(1, Number($("autoInterval").value) || 24),
      ai: readAi(),
    },
  });
  $("saved").textContent = "Saved.";
  setTimeout(() => ($("saved").textContent = ""), 2000);
}

$("aiThreshold").oninput = () => ($("thrVal").textContent = $("aiThreshold").value);
$("addRetention").onclick = () => document.querySelector("#retention tbody").appendChild(retentionRow());
$("addRule").onclick = () => {
  const c = ruleRow({ type: "query", action: "delete", enabled: true });
  document.querySelector("#rulesList").appendChild(c);
  c.querySelector(".rule-row").click();
};
$("save").onclick = save;
$("aiReset").onclick = () => ($("aiPrompt").value = defaultPrompt);
$("aiCacheClear").onclick = async () => {
  await send("aiCacheClear");
  $("aiResult").textContent = "Verdict cache and sender memory cleared.";
};
$("aiExport").onclick = async () => {
  const log = await send("aiLogGet");
  const stats = await send("senderStats");
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), log, senderStats: stats }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  await browser.downloads.download({ url, filename: "gmail-cleaner-ai-log.json", saveAs: false });
  $("aiResult").textContent = `Exported ${log.length} classified mail(s) to Downloads/gmail-cleaner-ai-log.json`;
};
const toolError = (e) =>
  e.message === "NO_GMAIL_TAB"
    ? "Open Gmail in a tab first."
    : /receiving end|Could not establish/i.test(e.message)
      ? "Gmail tab isn't responding. Reload the Gmail tab (F5) and try again."
      : e.message;
$("toolListLabels").onclick = async () => {
  $("toolResult").textContent = "Reading…";
  try {
    const l = await send("listLabels");
    $("toolResult").textContent = l.length ? `${l.length} labels: ${l.join(", ")}` : "No labels found.";
  } catch (e) {
    $("toolResult").textContent = toolError(e);
  }
};
$("toolCreateLabels").onclick = async () => {
  await save();
  $("toolResult").textContent = "Creating… watch the Gmail tab.";
  try {
    const r = await send("createLabels");
    $("toolResult").textContent =
      `Created: ${r.created.join(", ") || "none"}. Already existed: ${r.existing.join(", ") || "none"}.` +
      (r.failed.length ? ` Failed: ${r.failed.map((f) => `${f.name} (${f.error})`).join("; ")}` : "");
  } catch (e) {
    $("toolResult").textContent = toolError(e);
  }
};
$("toolOrganizeLabels").onclick = async () => {
  await save();
  $("toolResult").textContent = "Organizing… watch the Gmail tab (it will visit Settings → Labels).";
  try {
    const r = await send("organizeLabels");
    $("toolResult").style.whiteSpace = "pre-wrap";
    $("toolResult").textContent = describeReport({ at: Date.now(), ...r });
  } catch (e) {
    $("toolResult").textContent = toolError(e);
  }
};
$("aiTest").onclick = async () => {
  $("aiResult").className = "alert"; $("aiResult").textContent = "Testing…";
  const ai = readAi();
  if (!(await ensureHostPermission(ai))) { $("aiResult").className = "alert danger"; $("aiResult").textContent = "Permission to contact that host was declined."; return; }
  await save();
  const r = await send("aiTest");
  const box = $("aiResult");
  box.classList.remove("hidden");
  if (!r.ok) { box.className = "alert danger"; box.textContent = `Connection failed: ${r.error}`; return; }
  const v = r.verdicts.map((x) => `${x.id === "a" ? "Zara sale" : "Invoice reply"} → ${x.score}`).join(", ");
  box.className = "alert"; box.textContent = `Connected to ${r.model} in ${r.ms} ms. Sample: ${v}`;
};

function describeReport(r) {
  if (!r) return "";
  return (
    `${new Date(r.at).toLocaleTimeString()} · format ${r.format || "?"} · created: ${(r.created || []).join(", ") || "none"} · renamed: ${(r.renamed || []).join(", ") || "none"} · ` +
    `colored: ${(r.colored || []).join(", ") || "none"} · visibility: ${(r.visibility || []).join(", ") || "none"}` +
    ((r.errors || []).length ? `\nErrors:\n• ${r.errors.join("\n• ")}` : "")
  );
}
async function setupChecks() {
  const rep = await send("lastToolReport").catch(() => null);
  if (rep) {
    $("toolResult").textContent = describeReport(rep);
    $("toolResult").style.whiteSpace = "pre-wrap";
  }
  const gm = await send("gmailTab").catch(() => false);
  $("chkGmail").className = `check card ${gm ? "ok" : "bad"}`;
  $("chkGmail").querySelector("span:not(.dot)").textContent = gm ? "Open and reachable." : "No Gmail tab open. Open mail.google.com.";
  const s = await send("getSettings");
  const r = await send("aiTest").catch((e) => ({ ok: false, error: e.message }));
  $("chkOllama").className = `check card ${r.ok ? "ok" : "bad"}`;
  $("chkOllama").querySelector("span:not(.dot)").textContent = r.ok ? `${r.model} answered in ${r.ms} ms.` : `${r.error}`;
  if (gm) {
    try {
      const labels = await send("listLabels");
      const want = (s.ai.suggestedLabels || []).map((l) => l.toLowerCase());
      const have = labels.map((l) => l.replace(/^\[|\]$/g, "").toLowerCase());
      const missing = want.filter((w) => !have.includes(w));
      $("chkLabels").className = `check card ${missing.length ? "bad" : "ok"}`;
      $("chkLabels").querySelector("span:not(.dot)").textContent = missing.length ? `Missing: ${missing.join(", ")}` : `All ${want.length} present (${labels.length} labels total).`;
    } catch (e) {
      $("chkLabels").querySelector("span:not(.dot)").textContent = "Could not read labels (reload the Gmail tab?).";
    }
  }
}
$("chkOllamaBtn").onclick = () => $("aiTest").click();
$("chkLabelsBtn").onclick = () => $("toolOrganizeLabels").click();

load().then(setupChecks);

// side nav: highlight the section nearest the top (plain scroll handler, throttled)
(() => {
  const links = [...document.querySelectorAll("#nav a")];
  const secs = links.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
  let ticking = false;
  const update = () => {
    ticking = false;
    const y = window.scrollY + 120;
    let cur = secs[0];
    for (const sec of secs) if (sec.offsetTop <= y) cur = sec;
    links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + cur.id));
  };
  window.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  for (const a of links) a.addEventListener("click", () => setTimeout(update, 50));
  update();
})();

for (const b of document.querySelectorAll("#themeSeg button")) b.onclick = () => {
  document.querySelectorAll("#themeSeg button").forEach((x) => x.classList.toggle("active", x === b));
  const t = b.dataset.v;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
};
