const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => browser.runtime.sendMessage({ type, ...extra });
let defaultPrompt = "";

function ruleRow(rule = {}) {
  const tr = document.createElement("tr");
  tr.dataset.id = rule.id || `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  tr.innerHTML = `
    <td><input type="checkbox" class="on" ${rule.enabled !== false ? "checked" : ""}></td>
    <td><select class="type"><option value="query">Bulk</option><option value="ai">AI</option></select></td>
    <td><input type="text" class="name" placeholder="Name"></td>
    <td class="q"><input type="text" class="query" placeholder="category:promotions" spellcheck="false"></td>
    <td><select class="action"><option value="label">Label + archive</option><option value="archive">Archive</option><option value="delete">Delete</option></select></td>
    <td><input type="text" class="label" placeholder="Cleaned/Promo" spellcheck="false"></td>
    <td><input type="checkbox" class="inbox" ${rule.inboxOnly !== false ? "checked" : ""}></td>
    <td><input type="number" class="pages" min="1" max="40"></td>
    <td><button class="small danger del" title="Remove">✕</button></td>`;
  tr.querySelector(".type").value = rule.type === "ai" ? "ai" : "query";
  tr.querySelector(".name").value = rule.name || "";
  tr.querySelector(".query").value = rule.query || "";
  tr.querySelector(".action").value = rule.action === "trash" ? "delete" : rule.action || "label";
  tr.querySelector(".label").value = rule.label || "";
  tr.querySelector(".pages").value = rule.maxPages || 10;
  const sync = () => {
    tr.querySelector(".pages").disabled = tr.querySelector(".type").value !== "ai";
    tr.querySelector(".label").disabled = tr.querySelector(".action").value !== "label";
  };
  tr.querySelector(".type").onchange = sync;
  tr.querySelector(".action").onchange = sync;
  sync();
  tr.querySelector(".del").onclick = () => tr.remove();
  return tr;
}

function readRules() {
  return [...document.querySelectorAll("#rules tbody tr")]
    .map((tr) => ({
      id: tr.dataset.id,
      type: tr.querySelector(".type").value,
      enabled: tr.querySelector(".on").checked,
      name: tr.querySelector(".name").value.trim() || tr.querySelector(".query").value.trim(),
      query: tr.querySelector(".query").value.trim(),
      action: tr.querySelector(".action").value,
      label: tr.querySelector(".label").value.trim() || "Cleaned",
      inboxOnly: tr.querySelector(".inbox").checked,
      maxPages: Math.max(1, Number(tr.querySelector(".pages").value) || 10),
    }))
    .filter((r) => r.query);
}

function retentionRow(label = "", days = "") {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><input type="text" class="rl" placeholder="Orders" title='"*" = anything else in the inbox'></td><td><input type="number" class="rd" min="0" max="3650" style="width:6em"></td><td><button class="small danger del">✕</button></td>`;
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

async function load() {
  const s = await send("getSettings");
  const tbody = document.querySelector("#rules tbody");
  tbody.innerHTML = "";
  for (const r of s.rules) tbody.appendChild(ruleRow(r));
  $("allowlist").value = (s.allowlist || []).join("\n");
  $("retentionEnabled").checked = s.retentionEnabled !== false;
  const rb = document.querySelector("#retention tbody");
  rb.innerHTML = "";
  const labelsForRet = [...new Set([...(s.ai.suggestedLabels || []), ...Object.keys(s.retention || {}).filter((k) => k !== "*"), "*"])];
  for (const l of labelsForRet) rb.appendChild(retentionRow(l, s.retention?.[l] || ""));
  $("returnToInbox").checked = s.returnToInbox !== false;
  $("autoClean").checked = !!s.autoClean;
  $("autoInterval").value = s.autoIntervalHours || 24;
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

function readAi() {
  return {
    endpoint: $("aiEndpoint").value.trim() || "http://127.0.0.1:11434",
    model: $("aiModel").value.trim() || "qwen3:4b",
    batchSize: Math.max(1, Math.min(30, Number($("aiBatch").value) || 12)),
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
  await send("saveSettings", {
    patch: {
      rules: readRules(),
      allowlist: $("allowlist").value.split("\n").map((l) => l.trim()).filter(Boolean),
      returnToInbox: $("returnToInbox").checked,
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
$("addRule").onclick = () => document.querySelector("#rules tbody").appendChild(ruleRow({ type: "query", action: "label" }));
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
$("aiTest").onclick = async () => {
  $("aiResult").textContent = "Testing…";
  await save();
  const r = await send("aiTest");
  if (!r.ok) return ($("aiResult").textContent = `Failed: ${r.error}`);
  const v = r.verdicts.map((x) => `${x.id === "a" ? "Zara sale" : "Invoice reply"} → ${x.score}`).join(", ");
  $("aiResult").textContent = `OK (${r.model}, ${r.ms} ms): ${v}`;
};

load();
