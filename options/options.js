const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => browser.runtime.sendMessage({ type, ...extra });
let defaultPrompt = "";

function ruleRow(rule = {}) {
  const card = document.createElement("div");
  card.className = "rule-card";
  card.dataset.id = rule.id || `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  card.innerHTML = `
    <div class="rc-top">
      <label class="switch" title="Enabled"><input type="checkbox" class="on"><span></span></label>
      <input type="text" class="name" placeholder="Rule name">
      <select class="type" title="Rule type"><option value="query">Bulk</option><option value="ai">AI</option></select>
      <select class="action" title="Action"><option value="delete">Delete (Trash)</option><option value="archive">Archive</option><option value="label">Label + archive</option></select>
      <input type="text" class="label" placeholder="Label name" spellcheck="false">
      <button class="btn icon del" title="Remove rule">✕</button>
    </div>
    <textarea class="query" rows="2" spellcheck="false" placeholder="Gmail search, e.g. category:promotions -is:starred"></textarea>
    <div class="rc-bottom">
      <label class="inline"><input type="checkbox" class="inbox"> Inbox only (forces <code>in:inbox</code>)</label>
      <label class="inline pages-wrap">Pages to scan <input type="number" class="pages" min="1" max="40"></label>
      <span class="small muted hint"></span>
    </div>`;
  card.querySelector(".on").checked = rule.enabled !== false;
  card.querySelector(".type").value = rule.type === "ai" ? "ai" : "query";
  card.querySelector(".name").value = rule.name || "";
  card.querySelector(".query").value = rule.query || "";
  card.querySelector(".action").value = rule.action === "trash" ? "delete" : rule.action || "delete";
  card.querySelector(".label").value = rule.label || "";
  card.querySelector(".inbox").checked = rule.inboxOnly !== false;
  card.querySelector(".pages").value = rule.maxPages || 10;
  const sync = () => {
    const ai = card.querySelector(".type").value === "ai";
    card.querySelector(".pages-wrap").classList.toggle("hidden", !ai);
    card.querySelector(".label").classList.toggle("hidden", card.querySelector(".action").value !== "label");
    card.querySelector(".hint").textContent = ai ? "AI: scores each mail; junk is removed, kept mail is labeled." : "Bulk: everything the search returns gets the action.";
    card.classList.toggle("off", !card.querySelector(".on").checked);
  };
  card.querySelector(".type").onchange = sync;
  card.querySelector(".action").onchange = sync;
  card.querySelector(".on").onchange = sync;
  sync();
  card.querySelector(".del").onclick = () => card.remove();
  return card;
}

function readRules() {
  return [...document.querySelectorAll("#rules .rule-card")]
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

async function load() {
  const s = await send("getSettings");
  const rulesRoot = document.querySelector("#rules");
  rulesRoot.innerHTML = "";
  for (const r of s.rules) rulesRoot.appendChild(ruleRow(r));
  $("allowlist").value = (s.allowlist || []).join("\n");
  $("labelFormat").value = s.labelFormat || "auto";
  const sb = document.querySelector("#labelStyle tbody");
  sb.innerHTML = "";
  for (const l of [...new Set([...(s.ai.suggestedLabels || []), ...Object.keys(s.labelStyle || {})])]) sb.appendChild(styleRow(l, s.labelStyle?.[l]));
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

/** Cloud providers live on arbitrary hosts: ask Firefox for that origin once. */
async function ensureHostPermission(ai) {
  let origin = null;
  if (ai.provider === "openai") { try { origin = new URL(ai.openaiEndpoint).origin + "/*"; } catch {} }
  if (ai.provider === "anthropic") origin = "https://api.anthropic.com/*";
  if (!origin) return true;
  if (await browser.permissions.contains({ origins: [origin] })) return true;
  return browser.permissions.request({ origins: [origin] });
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

async function save() {
  const aiNow = readAi();
  if (aiNow.provider !== "ollama") ensureHostPermission(aiNow).catch(() => {});
  await send("saveSettings", {
    patch: {
      rules: readRules(),
      allowlist: $("allowlist").value.split("\n").map((l) => l.trim()).filter(Boolean),
      returnToInbox: $("returnToInbox").checked,
      labelFormat: $("labelFormat").value.trim() || "auto",
      labelStyle: readLabelStyle(),
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
  document.querySelector("#rules").appendChild(c);
  c.querySelector(".name").focus();
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
$("toolListLabels").onclick = async () => {
  $("toolResult").textContent = "Reading…";
  try {
    const l = await send("listLabels");
    $("toolResult").textContent = l.length ? `${l.length} labels: ${l.join(", ")}` : "No labels found.";
  } catch (e) {
    $("toolResult").textContent = e.message === "NO_GMAIL_TAB" ? "Open Gmail in a tab first." : e.message;
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
    $("toolResult").textContent = e.message === "NO_GMAIL_TAB" ? "Open Gmail in a tab first." : e.message;
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
    $("toolResult").textContent = e.message === "NO_GMAIL_TAB" ? "Open Gmail in a tab first." : e.message;
  }
};
$("aiTest").onclick = async () => {
  $("aiResult").textContent = "Testing…";
  const ai = readAi();
  if (!(await ensureHostPermission(ai))) return ($("aiResult").textContent = "Permission to contact that host was declined.");
  await save();
  const r = await send("aiTest");
  if (!r.ok) return ($("aiResult").textContent = `Failed: ${r.error}`);
  const v = r.verdicts.map((x) => `${x.id === "a" ? "Zara sale" : "Invoice reply"} → ${x.score}`).join(", ");
  $("aiResult").textContent = `OK (${r.model}, ${r.ms} ms): ${v}`;
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
  $("chkGmail").className = `check ${gm ? "ok" : "bad"}`;
  $("chkGmail").querySelector("span:not(.dot)").textContent = gm ? "Open and reachable." : "No Gmail tab open. Open mail.google.com.";
  const s = await send("getSettings");
  const r = await send("aiTest").catch((e) => ({ ok: false, error: e.message }));
  $("chkOllama").className = `check ${r.ok ? "ok" : "bad"}`;
  $("chkOllama").querySelector("span:not(.dot)").textContent = r.ok ? `${r.model} answered in ${r.ms} ms.` : `${r.error}`;
  if (gm) {
    try {
      const labels = await send("listLabels");
      const want = (s.ai.suggestedLabels || []).map((l) => l.toLowerCase());
      const have = labels.map((l) => l.replace(/^\[|\]$/g, "").toLowerCase());
      const missing = want.filter((w) => !have.includes(w));
      $("chkLabels").className = `check ${missing.length ? "bad" : "ok"}`;
      $("chkLabels").querySelector("span:not(.dot)").textContent = missing.length ? `Missing: ${missing.join(", ")}` : `All ${want.length} present (${labels.length} labels total).`;
    } catch (e) {
      $("chkLabels").querySelector("span:not(.dot)").textContent = "Could not read labels (reload the Gmail tab?).";
    }
  }
}
$("chkOllamaBtn").onclick = () => $("aiTest").click();
$("chkLabelsBtn").onclick = () => $("toolOrganizeLabels").click();

load().then(setupChecks);

// side nav: plain anchors; highlight on click
for (const a of document.querySelectorAll("#nav a")) a.addEventListener("click", () => document.querySelectorAll("#nav a").forEach((x) => x.classList.toggle("active", x === a)));
