/* Inbox Broom – background
 * Settings, Gmail-tab plumbing, auto-clean alarm, local-LLM (Ollama) classification,
 * sender memory, AI log.
 * All DOM work happens in content.js inside the Gmail tab.
 */

const ALARM_NAME = "auto-clean";
const DEFAULTS_VERSION = 12;

const DEFAULT_AI_PROMPT = `You triage a personal Gmail inbox for {{persona}}. For each email decide a verdict: "junk" (safe to remove unread) or "keep", plus a confidence 0-100.

JUNK = bulk mail: marketing, promotions, sales, coupons, "price drop", loyalty coins/points, newsletters, product announcements, feature updates, "we miss you", re-engagement, surveys, webinar/course/coach/influencer pitches, social-network notifications (LinkedIn, Instagram, Quora, X, Facebook, Reddit digests), app engagement nudges ("you appeared in N searches", "someone viewed your profile"), job-board digests, community digests, GitHub/Discord/Slack marketing (not repo activity), event invites from brands, free-trial-ending pitches, investment-app marketing, "complete your profile".
Bulk mail often fakes intimacy: uses the recipient's first name, says "I", "my team", "we're live", "episode", "link inside", "I'm sorry", "last chance". If the sender is a brand, newsletter, creator or influencer address (noreply@, hello@, team@, news@ …) it is still bulk mail. But if the From is a named individual at a personal or company address (e.g. priya@somecompany.com, rahul.mehta@gmail.com) and the text reads like a one-to-one message, it is a real person: keep, even if that company also sends marketing.

KEEP = a human wrote this to the recipient personally; login / security / new-device / OTP alerts from Google, Microsoft, Apple, GitHub, banks or any service (these are NEVER bulk even though they are automated); replies in a thread; receipts, invoices, order/delivery/refund updates; bills and payment confirmations; bank, UPI, card, tax, government, legal notices; OTP, login, security, password or account changes; appointments, bookings, tickets, travel; job applications, recruiter conversations, client/freelance/Upwork/Fiverr messages; university/school; medical; anything that asks for a decision, a reply or money; domain/hosting/SaaS billing, outages, quota or expiry warnings for services the person actually uses; CI failures, PR reviews, repo activity.

An automated or noreply address proves nothing: banks, brokers, registrars, couriers and schools all send from noreply@. Judge by what the mail is about. Transactional mail from a marketing-heavy sender (order updates, statements, reports about the person's own account, expiry/renewal warnings, account activation, certificates, support tickets) is KEEP.

Every KEEP email MUST get exactly one label from the allowed label list in the user message (the person's own Gmail labels first, then the suggested ones). Pick the label whose name best describes the mail. Guide for the suggested names: Finance = banks, brokers, demat/trading statements, credit score/CIBIL, cards, payments, invoices, tax; Orders = shopping, shipping, delivery, food, returns; Support = support tickets, service requests, customer care threads; Security = OTP, login, authentication, Aadhaar/e-KYC, account changes; Dev = GitHub, CI, hosting, domains, cloud, SaaS tooling, form responses; Work = clients, freelance platforms, recruiters, job applications, colleagues; Travel = bookings, tickets, hotels, rides; Government = tax department, UIDAI, municipal, legal; Personal = a human writing one-to-one that fits nowhere else. Use "Other" only if truly nothing fits. For JUNK always use "Other". Lean towards junk for anything mass-sent with no personal consequence; the person can restore it.`;

const FEW_SHOT = `Examples:
- Re'equil <noreply@reequil.com> "You've earned 498.99 Coins" → junk
- Iman Gadzhi <iman@imangadzhi.com> "Alex, my team told me not to do this" → junk (creator pitch pretending to be personal)
- Google Shopping "Price drop – Nillkin MagSafe case" → junk
- LinkedIn "You appeared in 9 searches this week" → junk
- Ollama <hello@ollama.com> "Beam's free period on Ollama ends this weekend" → junk (product pitch)
- GitHub <noreply@github.com> "[repo] CI failed on main" → keep
- Amazon.in <order-update@amazon.in> "Your package has been delivered" → keep
- HDFC Bank "OTP for your transaction" → keep
- Sam Mehta <sam.mehta@gmail.com> "Re: invoice for October" → keep
- Upwork "New message from client about Flask project" → keep
- Hostinger "Your domain example.com expires in 7 days" → keep
- Notion <team@notion.so> "Introducing Notion Mail" → junk
- Upwork <donotreply@upwork.com> "Jobs you may like: Flask developer" → junk (job-board digest)
- Google <no-reply@accounts.google.com> "Security alert" → keep
- Priya <priya@somestartup.co> "Quick question about the proposal" → keep (named person, one-to-one)
- TOI Top 10 / TOI Evening Brief / The Times of India "Your daily dose of news" → junk (news digest)
- Interesting Facts "What animal sleeps the least?" → junk
- Anveshan "Hi Alex, please share your thoughts about our A2 Desi Cow Ghee" → junk (review request)
- LinkedIn "Papigen is hiring for a Gen AI role" / LinkedIn Job Alerts → junk
- Google Analytics "Your performance report for Oct 20 – Nov 16" → junk (automated report, low value)
- Zerodha "How to add instruments to the marketwatch? (Ticket #543887)" → keep (support thread)
- services <…demat…> "Transactions In Your Demat Account" → keep
- Groww "Report: Daily Margin Statement" → keep (statement)
- Shiprocket "Alex, your Supply6 order has been packed!" → keep (order update)
- CIBIL "Attention! CIBIL Enquiry ALERT" / Experian "credit profile was accessed" → keep
- Roar "Your Roar card is now active" → keep (account activation)
- aadhaar "Aadhaar XXXX 6948: Authentication Successful" → keep
Label examples: Demat/Groww/Zerodha statements → Finance; CIBIL/Experian/CRIF → Finance; Amazon/Shiprocket/Supply6 shipping → Orders; Zerodha/IFB support ticket → Support; OTP/Aadhaar auth/card activated → Security; GitHub run failed / Google Forms responses → Dev; Upwork client / recruiter → Work; Airbnb/IRCTC → Travel; Income Tax intimation → Government`;

const DEFAULT_SETTINGS = {
  rules: [
    {
      id: "promotions",
      type: "query",
      name: "Promotions tab",
      query: "category:promotions -is:starred -is:important",
      action: "delete",
      inboxOnly: true,
      enabled: true,
    },
    {
      id: "social",
      type: "query",
      name: "Social tab",
      query: "category:social -is:starred -is:important",
      action: "delete",
      inboxOnly: true,
      enabled: true,
    },
    {
      id: "ai-primary",
      type: "ai",
      name: "AI triage of the rest of the inbox",
      // no -is:important here: Gmail flags shipping/support/forms as important; those are labeled but never deleted
      query: "in:inbox -is:starred -category:promotions -category:social",
      action: "delete",
      inboxOnly: true,
      maxPages: 10,
      enabled: true,
    },
    {
      id: "otp",
      type: "query",
      name: "OTPs & login alerts older than 7 days",
      query:
        'older_than:7d -is:starred subject:("otp" OR "one time password" OR "one-time password" OR "verification code" OR "security code" OR "login code" OR "sign-in code" OR "confirmation code" OR "your code is" OR "2fa" OR "two-factor" OR "two factor" OR "new sign-in" OR "new login" OR "login alert" OR "security alert" OR "new device" OR "password reset" OR "reset your password" OR "verify your email" OR "email verification" OR "magic link" OR "login link" OR "sign in to" OR "authentication successful" OR "login successful" OR "logged in" OR "e-kyc")',
      action: "delete",
      inboxOnly: true,
      enabled: true,
    },
    {
      id: "unsubscribe",
      type: "query",
      name: "Anything with an unsubscribe link, older than 30 days",
      query: "in:inbox unsubscribe older_than:30d -is:starred -is:important",
      action: "delete",
      inboxOnly: true,
      enabled: false,
    },
  ],
  allowlist: [],
  autoClean: false,
  autoIntervalHours: 24,
  returnToInbox: true,
  ai: {
    provider: "ollama", // ollama | openai | anthropic
    endpoint: "http://127.0.0.1:11434",
    model: "qwen3:4b",
    // cloud providers (only used when provider != ollama). Key stays in extension storage on this machine.
    openaiEndpoint: "https://api.openai.com/v1",
    openaiKey: "",
    openaiModel: "gpt-4o-mini",
    anthropicKey: "",
    anthropicModel: "claude-opus-5-5",
    prompt: DEFAULT_AI_PROMPT,
    batchSize: 12,
    keepAlive: "1m",
    threshold: 60, // score >= threshold -> junk
    senderMemory: true, // auto-decide senders after repeated consistent verdicts
    heuristics: true, // add automated-sender / marketing-words hints for the model
    persona: "a software developer / freelancer in India", // who the inbox belongs to; shapes what counts as junk
    unsubscribe: true, // read Gmail "Manage subscriptions" on preview and let the AI suggest what to drop
    labeling: true, // AI picks a label for kept mail from your existing Gmail labels
    suggestedLabels: ["Finance", "Orders", "Support", "Security", "Dev", "Work", "Travel", "Government", "Personal"], // created on first use if missing
    ignoreLabels: ["Notes", "Cleaned"], // existing labels the AI must not use
  },
  // label style: "auto" copies the style of your existing labels ("[Finance]" → "[{name}]"), or set "{name}" / "[{name}]" / "@{name}" …
  labelFormat: "auto",
  // per taxonomy label: Gmail color name and sidebar visibility (show | hide | unread = show if unread)
  labelStyle: {
    Finance: { color: "yellow", show: "show" },
    Security: { color: "red", show: "show" },
    Orders: { color: "orange", show: "show" },
    Work: { color: "purple", show: "show" },
    Dev: { color: "blue", show: "unread" },
    Support: { color: "green", show: "unread" },
    Travel: { color: "blue", show: "unread" },
    Government: { color: "gray", show: "unread" },
    Personal: { color: "pink", show: "unread" },
  },
  // Inbox expiry in days per label, "*" = anything else in the inbox. Inbox-only: archived mail is never touched,
  // starred/important never touched. 0 / missing = keep in inbox forever.
  retention: { Security: 7, Orders: 30, Dev: 30, Support: 45, Work: 60, Personal: 60, Finance: 90, Government: 90, Travel: 120, "*": 90 },
  retentionEnabled: true,
  history: [],
  defaultsVersion: DEFAULTS_VERSION,
};

const normLabel = (l) => String(l || "").trim().replace(/^\[|\]$/g, "").replace(/^[@#!]/, "").toLowerCase();
function detectFormat(existing) {
  const user = (existing || []).filter(Boolean);
  if (!user.length) return "{name}";
  const br = user.filter((l) => /^\[.+\]$/.test(l)).length;
  return br * 2 >= user.length ? "[{name}]" : "{name}";
}
function labelFormatFor(settings, existing) {
  const f = settings.labelFormat && settings.labelFormat !== "auto" ? settings.labelFormat : detectFormat(existing);
  return f.includes("{name}") ? f : "{name}";
}
/** real Gmail label name for a taxonomy name: an existing label with the same core, else the formatted name */
function resolveLabel(name, existing, fmt) {
  const hit = (existing || []).find((l) => normLabel(l) === normLabel(name));
  return hit || fmt.replace("{name}", name);
}
// Gmail search: quote names that contain brackets/spaces
const labelQueryName = (l) => (/[\s\[\]@#!]/.test(l.trim()) ? `"${l.trim()}"` : l.trim());

function retentionRules(settings, existing = []) {
  if (!settings.retentionEnabled) return [];
  const fmt = labelFormatFor(settings, existing);
  const entries = Object.entries(settings.retention || {}).filter(([, d]) => Number(d) > 0).map(([l, d]) => [l === "*" ? "*" : resolveLabel(l, existing, fmt), d]);
  const labeled = entries.filter(([l]) => l !== "*");
  const rules = labeled.map(([label, d]) => ({
    id: `retention:${label}`,
    type: "query",
    synthetic: true,
    name: `Inbox: ${label} older than ${Number(d)} days`,
    query: `label:${labelQueryName(label)} older_than:${Number(d)}d -is:starred -is:important`,
    action: "delete",
    inboxOnly: true,
    enabled: true,
  }));
  const star = entries.find(([l]) => l === "*");
  if (star) {
    const excl = labeled.length ? ` -{${labeled.map(([l]) => `label:${labelQueryName(l)}`).join(" ")}}` : "";
    rules.push({
      id: "retention:*",
      type: "query",
      synthetic: true,
      name: `Inbox: anything else older than ${Number(star[1])} days`,
      query: `older_than:${Number(star[1])}d -is:starred -is:important${excl}`,
      action: "delete",
      inboxOnly: true,
      enabled: true,
    });
  }
  return rules;
}

// queries of older default rule versions -> upgraded silently if the user never edited them
const LEGACY_QUERIES = {
  promotions: ["category:promotions older_than:7d -is:starred -is:important"],
  social: ["category:social older_than:7d -is:starred"],
  "ai-primary": ["in:inbox category:primary older_than:1d -is:starred -is:important", "in:inbox -is:starred -is:important -category:promotions -category:social"],
  unsubscribe: ["in:inbox unsubscribe older_than:30d -is:starred -is:important -category:primary"],
  otp: [
    'older_than:7d -is:starred subject:("otp" OR "one time password" OR "one-time password" OR "verification code" OR "security code" OR "login code" OR "sign-in code" OR "confirmation code" OR "your code is" OR "2fa" OR "two-factor" OR "two factor" OR "new sign-in" OR "new login" OR "login alert" OR "security alert" OR "new device" OR "password reset" OR "reset your password" OR "verify your email" OR "email verification" OR "magic link" OR "login link" OR "sign in to")',
  ],
};

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  s.ai = { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) };
  if (/^https?:\/\/localhost:11434\/?$/.test(s.ai.endpoint || "")) s.ai.endpoint = "http://127.0.0.1:11434";
  if (JSON.stringify(s.ai.suggestedLabels) === JSON.stringify(["Finance", "Orders", "Work", "Dev", "Security", "Personal"])) s.ai.suggestedLabels = DEFAULT_SETTINGS.ai.suggestedLabels;
  return s;
}

async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ settings: next });
  await syncAlarm(next);
  return next;
}

async function migrate() {
  const s = await getSettings();
  const v = s.defaultsVersion || 1;
  if (v < DEFAULTS_VERSION) {
    const defs = Object.fromEntries(DEFAULT_SETTINGS.rules.map((r) => [r.id, r]));
    s.rules = s.rules.map((r) => {
      const d = defs[r.id];
      if (!d) return r;
      const out = { ...r };
      if (v < 2 && out.action === "archive") out.action = "delete";
      if (v < 4 && d.action === "label" && (out.action === "delete" || out.action === "archive")) {
        out.action = "label";
        out.label = d.label;
      }
      if (out.inboxOnly === undefined) out.inboxOnly = true;
      if (!out.type) out.type = d.type;
      if (v < 7 && out.action === "label" && d.action === "delete") out.action = "delete";
      if ((LEGACY_QUERIES[r.id] || []).includes(out.query)) {
        out.query = d.query;
        out.name = d.name;
        if (d.maxPages) out.maxPages = d.maxPages;
      }
      return out;
    });
    if (v < 8 && JSON.stringify(s.retention) === JSON.stringify({ Orders: 30, Security: 7, Support: 45, Dev: 30, Travel: 120 })) s.retention = { ...DEFAULT_SETTINGS.retention };
    if (v < 12 && (!s.ai.prompt || !s.ai.prompt.trim())) {
      // a Save from a half-loaded settings page blanked these; restore defaults
      for (const k of ["prompt", "senderMemory", "heuristics", "unsubscribe", "labeling", "persona", "suggestedLabels", "ignoreLabels"]) s.ai[k] = DEFAULT_SETTINGS.ai[k];
    }
    if (v < 11) {
      // labels copied from sender memory before it required a majority: forget them so the model re-labels
      const cache = await getAiCache();
      for (const c of Object.values(cache)) if (c && c.source === "sender" && c.label && !c.manual) delete c.label;
      await browser.storage.local.set({ aiCache: cache });
    }
    if (v < 10) {
      const stats = await getSenderStats();
      for (const st of Object.values(stats)) if (st && !st.labelManual) delete st.label;
      await browser.storage.local.set({ senderStats: stats });
    }
    const have = new Set(s.rules.map((r) => r.id));
    for (const d of DEFAULT_SETTINGS.rules) if (!have.has(d.id)) s.rules.push({ ...d });
    s.defaultsVersion = DEFAULTS_VERSION;
  }
  await browser.storage.local.set({ settings: s });
  return s;
}

const getStore = async (key, fallback) => (await browser.storage.local.get(key))[key] || fallback;
const getAiCache = () => getStore("aiCache", {});
const getSenderStats = () => getStore("senderStats", {});

// ---------------------------------------------------------------- gmail tab

async function findGmailTab({ create = false } = {}) {
  const tabs = await browser.tabs.query({ url: "https://mail.google.com/*" });
  if (tabs.length) return tabs.find((t) => t.active) || tabs[0];
  if (!create) return null;
  return browser.tabs.create({ url: "https://mail.google.com/mail/u/0/#inbox" });
}

async function applyPlan(plan) {
  const settings = await getSettings();
  const tab = await findGmailTab({ create: true });
  if (!tab) throw new Error("NO_GMAIL_TAB");
  await browser.tabs.update(tab.id, { active: true });
  await browser.storage.local.set({ applyResult: null });
  return browser.__tabSend(tab.id, { type: "apply", plan, allowlist: settings.allowlist, returnToInbox: settings.returnToInbox }); // { started: true }
}

async function onApplyFinished(res) {
  const s = await getSettings();
  const entry = { at: Date.now(), total: res.total, summary: res.summary };
  await browser.storage.local.set({
    settings: { ...s, history: [entry, ...(s.history || [])].slice(0, 50) },
    lastPreview: null,
    applyResult: { at: Date.now(), ...res },
  });
}

/** Starts a run in the Gmail tab and returns immediately. The content script reports back with "scanFinished" / "runFinished". */
async function runInGmail(mode, { focus = false, create = false, ruleIds = null, rescore = false } = {}) {
  const settings = await getSettings();
  const tab = await findGmailTab({ create });
  if (!tab) throw new Error("NO_GMAIL_TAB");
  if (focus) {
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  let rules = settings.rules.filter((r) => r.enabled);
  if (ruleIds) rules = settings.rules.filter((r) => ruleIds.includes(r.id));
  const known = await getStore("knownLabels", []);
  if (!ruleIds || ruleIds.includes("retention")) rules = [...rules, ...retentionRules(settings, known)];
  const cache = await getAiCache();
  const fmt = labelFormatFor(settings, known);
  const excludeLabels = [...new Set([...(settings.ai.suggestedLabels || []).map((l) => resolveLabel(l, known, fmt)), ...Object.values(cache).map((c) => c.label).filter(Boolean)])];
  const payload = {
    type: "run",
    mode,
    rules,
    allowlist: settings.allowlist,
    returnToInbox: settings.returnToInbox,
    aiCache: cache,
    excludeLabels,
    rescore,
    subscriptions: mode === "scan" && settings.ai.unsubscribe !== false,
  };
  let lastErr;
  for (let i = 0; i < 30; i++) {
    try {
      return await browser.__tabSend(tab.id, payload); // content replies { started: true } at once
    } catch (e) {
      lastErr = e;
      if (!/receiving end|Could not establish/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr || new Error("Gmail tab did not respond");
}

async function openReviewTab() {
  const url = browser.runtime.getURL("review/review.html");
  const tabs = await browser.tabs.query({ url });
  if (tabs.length) await browser.tabs.update(tabs[0].id, { active: true });
  else await browser.tabs.create({ url });
}

/** Called by the content script when a scan finishes: enrich subscriptions, store the preview, open the review tab. */
async function onScanFinished(res, { openReview = true } = {}) {
  if (Array.isArray(res.labels) && res.labels.length) await browser.storage.local.set({ knownLabels: res.labels });
  let subscriptions = res.subscriptions || null;
  if (Array.isArray(subscriptions) && subscriptions.length) {
    await browser.storage.local.set({ progress: { text: `AI reviewing ${subscriptions.length} subscriptions…`, at: Date.now(), running: true } });
    try {
      subscriptions = await aiSuggestUnsubscribe(subscriptions);
    } catch (e) {
      subscriptions = { error: e.message };
    }
    await browser.storage.local.set({ progress: { text: "", at: Date.now(), running: false } });
  }
  await browser.storage.local.set({ lastPreview: { at: Date.now(), results: res.results, labels: res.labels || [], subscriptions, stopped: res.stopped } });
  if (openReview) await openReviewTab();
}

// ---------------------------------------------------------------- heuristics

const AUTOMATED_LOCAL = /^(no-?reply|noreply|donotreply|do-not-reply|newsletter|news|marketing|promo|promotions|offers|deals|hello|hi|hey|info|team|updates|notifications?|notify|mailer|email|mail|digest|community|events|campaign|insights|learn|growth|engage|care|contact|support-noreply)\b/i;
const MARKETING_WORDS = /(\b\d{1,3}\s?%\s?off\b|\bsale\b|\bdeal|\boffer|\bdiscount|\bcoupon|\bvoucher|\bcashback|\bfree\b|\bbonus|\bwebinar|\bmasterclass|\bworkshop|\bcourse|\bepisode|\bnewsletter|\bdigest|\bweekly|\bintroducing|\bannouncing|\bnew feature|\blaunch|\blimited time|\blast chance|\bending soon|\bhurry|\bdon'?t miss|\bunlock|\bexclusive|\bearn\b|\bcoins|\bpoints|\brewards?\b|\bwe miss you|\bprice drop|\bbest sellers?|\btrending|\brecommended for you|\byou appeared|\bviewed your|\bconnect with|\bjoin us|\bregister now|\bwe'?re live|\blink inside|\bsurvey|\bfeedback|\brate your|\btop picks|\bhandpicked|\bcurated|\bflash|\bmega|\bfestive|\bdiwali|\bblack friday|\bcyber monday|\bbig billion|\bprime day|🔥|🎉|🎁|⚡|💥|🚀|✨|😍|🤑)/i;
const STRONG_KEEP = /(\botp\b|\bone[- ]time password|\bverification code|\bsecurity (alert|code)|\bnew (sign[- ]in|login|device)|\bsign[- ]in attempt|\bpassword (reset|changed)|\binvoice|\breceipt|\bcontract note|\bintimation|\bstatement|\bmargin\b|\bcredit (score|profile|report)|\benquiry alert|\bcertificate|\bnow active|\bexpir(es|ing|y) (in|on)|\brenew(al)? (due|reminder|notice)|\bitinerary|\bboarding pass|\breservation|\bbooking (confirmed|confirmation)|\border (confirmed|placed|shipped|delivered)|\bhas been delivered|\bpayment (received|failed|due|successful)|\brefund|\bdebited|\bcredited|\bpayslip|\boffer letter|\binterview)/i;
const KEEP_WORDS = /(\botp\b|\bone[- ]time password|\bverification code|\bverify\b|\binvoice|\breceipt|\border (confirmed|placed|shipped|delivered|update)|\bdelivered\b|\bshipped\b|\bpayment (received|failed|due|successful)|\brefund|\bstatement|\btransaction|\bdebited|\bcredited|\bcontract note|\bbooking|\bticket|\bitinerary|\bappointment|\binterview|\bapplication|\boffer letter|\bsalary|\bpayslip|\btax|\bgst\b|\bitr\b|\bpan\b|\baadhaar|\bpassword (reset|changed)|\bsecurity alert|\bnew (sign[- ]in|login|device)|\bsuspicious|\bexpir(es|ing|y) (in|on)|\brenew(al)? (due|reminder)|\bdomain\b|\bssl\b|\bdowntime|\boutage|\bincident|\bquota|\busage limit|\bbuild (failed|passed)|\bci\b|\bpull request|\bmerged|\bre:|\bfwd:)/i;

function hintsFor(m) {
  const h = [];
  const local = (m.email || "").split("@")[0];
  const domain = (m.email || "").split("@")[1] || "";
  if (AUTOMATED_LOCAL.test(local)) h.push("automated sender address");
  if (/^(gmail|yahoo|outlook|hotmail|proton|icloud)\./i.test(domain) && !AUTOMATED_LOCAL.test(local)) h.push("personal mailbox domain");
  const text = `${m.subject} ${m.snippet}`;
  const mk = text.match(MARKETING_WORDS);
  if (mk) h.push(`marketing words: "${mk[0]}"`);
  const sk = text.match(STRONG_KEEP);
  if (sk) h.push(`strong transactional words: "${sk[0]}"`);
  else {
    const kp = text.match(KEEP_WORDS);
    if (kp) h.push(`transactional words: "${kp[0]}"`);
  }
  if (/^(re|fwd?):/i.test(m.subject || "")) h.push("thread reply");
  if (m.important) h.push("Gmail marked it important");
  // firstname / firstname.lastname style local part, not automated -> probably a specific person
  if (!AUTOMATED_LOCAL.test(local) && /^[a-z]+([._-][a-z]+)?\d{0,3}$/i.test(local) && !/^(hello|hi|hey|info|team|news|sales|contact|office|admin|billing|orders?|shop|store|care|help|service|jobs|careers|alerts?|accounts?|security|mailer|digest)$/i.test(local))
    h.push("named individual sender");
  return h;
}

/** Deterministic score nudge from hints: automated+marketing pushes up, transactional pulls down. */
function heuristicAdjust(hints) {
  let d = 0;
  const auto = hints.includes("automated sender address");
  const mk = hints.some((h) => h.startsWith("marketing words"));
  const kp = hints.some((h) => h.startsWith("transactional words"));
  const strong = hints.some((h) => h.startsWith("strong transactional"));
  const reply = hints.includes("thread reply");
  const personal = hints.includes("personal mailbox domain");
  const person = hints.includes("named individual sender");
  if (strong) d -= 40; // transactional signal dominates: no marketing bonus
  else {
    if (auto && mk) d += 15;
    else if (mk) d += 8;
    if (kp) d -= 15;
  }
  if (reply || personal) d -= 25;
  if (person) d -= 20;
  if (hints.includes("Gmail marked it important")) d -= 20;
  return d;
}

// ---------------------------------------------------------------- ollama

const withPersona = (ai, text) => text.replace(/\{\{persona\}\}/g, ai.persona || DEFAULT_SETTINGS.ai.persona);

function stripThink(s) {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function extractJson(s) {
  s = stripThink(s);
  try {
    return JSON.parse(s);
  } catch {}
  const m = s.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  throw new Error("Model did not return valid JSON");
}

const resultSchema = (labels) => ({
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          verdict: { type: "string", enum: ["junk", "keep"] },
          confidence: { type: "integer" },
          label: { type: "string", enum: [...labels, "Other"] },
          reason: { type: "string" },
        },
        required: ["n", "verdict", "confidence", "label", "reason"],
      },
    },
  },
  required: ["results"],
});

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          verdict: { type: "string", enum: ["junk", "keep"] },
          confidence: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["n", "verdict", "confidence", "reason"],
      },
    },
  },
  required: ["results"],
};

/** Routes a chat completion to the configured provider. Returns the assistant text. */
async function llmChat(ai, messages, opts = {}) {
  if (ai.provider === "openai") return openaiChat(ai, messages, opts);
  if (ai.provider === "anthropic") return anthropicChat(ai, messages, opts);
  return ollamaChat(ai, messages, opts);
}

async function openaiChat(ai, messages, { numPredict = 1024 } = {}) {
  const base = (ai.openaiEndpoint || "https://api.openai.com/v1").replace(/\/$/, "");
  // reasoning models (o-series, qwen3, gemini thinking…) burn tokens before the JSON: give them room
  const body = { model: ai.openaiModel, messages, temperature: 0, max_tokens: Math.max(4096, numPredict * 8), response_format: { type: "json_object" } };
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${ai.openaiKey}` };
  if (/openrouter\.ai/i.test(base)) headers["HTTP-Referer"] = "https://github.com/shivangrathore/inboxbroom";
  const post = async (b) => fetch(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(b) });
  let r = await post(body);
  if (r.status === 400) {
    // some providers reject response_format; retry without
    const t = await r.text().catch(() => "");
    if (/response_format|json_object/i.test(t)) r = await post({ ...body, response_format: undefined });
    else throw new Error(`Provider 400: ${t.slice(0, 200)}`);
  }
  if (r.status === 401 || r.status === 403) throw new Error("Cloud API key rejected (401/403). Check the key in Settings → Local AI.");
  if (r.status === 404) throw new Error(`Model "${ai.openaiModel}" not found at ${base} (404).`);
  if (r.status === 429) throw new Error("Cloud provider rate limit (429). Lower the batch size or wait.");
  if (!r.ok) throw new Error(`Provider ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const j = await r.json();
  const msg = j.choices?.[0]?.message || {};
  const content = msg.content || "";
  if (!content.trim() && (msg.reasoning || msg.reasoning_content)) throw new Error("Model returned only reasoning and no answer; pick a non-reasoning model or a larger max_tokens.");
  return content;
}

async function anthropicChat(ai, messages, { numPredict = 1024 } = {}) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const msgs = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ai.anthropicKey,
      "anthropic-version": "2026-10-21",
      "anthropic-beta": "server-side-fallback-2026-07-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: ai.anthropicModel || "claude-opus-5-5",
      max_tokens: Math.max(1024, numPredict),
      system,
      messages: msgs,
      output_config: { effort: "low" },
      fallbacks: "default",
    }),
  });
  if (r.status === 401 || r.status === 403) throw new Error("Anthropic API key rejected (401/403). Check the key in Settings → Local AI.");
  if (r.status === 404) throw new Error(`Anthropic model "${ai.anthropicModel}" not found (404).`);
  if (r.status === 429) throw new Error("Anthropic rate limit (429). Lower the batch size or wait.");
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const j = await r.json();
  if (j.stop_reason === "refusal") throw new Error(`Anthropic declined the request${j.stop_details?.category ? ` (${j.stop_details.category})` : ""}.`);
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function ollamaChat(ai, messages, { format = RESULT_SCHEMA, numPredict = 1024 } = {}) {
  const url = ai.endpoint.replace(/\/$/, "") + "/api/chat";
  const body = {
    model: ai.model,
    messages,
    stream: false,
    think: false,
    keep_alive: ai.keepAlive || "1m",
    options: { temperature: 0, num_ctx: 8192, num_predict: numPredict },
  };
  if (format) body.format = format;
  let r;
  try {
    r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`Cannot reach Ollama at ${ai.endpoint}. Is it running with OLLAMA_ORIGINS="moz-extension://*"? (${e.message})`);
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    if (r.status === 403) throw new Error(`Ollama refused (403). Start Ollama with OLLAMA_ORIGINS="moz-extension://*".`);
    if (r.status === 404) throw new Error(`Model "${ai.model}" not found. Run: ollama pull ${ai.model}`);
    throw new Error(`Ollama ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  return j.message?.content || "";
}

function parseScore(v) {
  if (!v) return null;
  if (typeof v.verdict === "string" && /^(junk|keep)$/i.test(v.verdict)) {
    let c = Number(v.confidence);
    if (Number.isNaN(c)) c = 80;
    c = Math.max(50, Math.min(100, c));
    return /^junk$/i.test(v.verdict) ? Math.round(50 + c / 2) : Math.round(50 - c / 2);
  }
  let s = v.score ?? v.junk_score ?? v.junkScore;
  if (typeof s === "string") s = parseFloat(s);
  if (typeof s === "number" && !Number.isNaN(s)) return Math.max(0, Math.min(100, s <= 1 && s > 0 && !Number.isInteger(s) ? s * 100 : s));
  const j = v.junk ?? v.is_junk ?? v.verdict ?? v.label;
  if (j === true || /^(true|junk|yes|delete|spam)$/i.test(String(j))) return 90;
  if (j === false || /^(false|keep|no)$/i.test(String(j))) return 10;
  return null;
}

async function modelScores(ai, batch, rule, labels = []) {
  try {
    return await modelScoresOnce(ai, batch, rule, labels);
  } catch (e) {
    if (batch.length === 1) {
      console.warn("[cleaner] model failed on single item, heuristics only:", e.message);
      return [{ score: null, reason: `model error: ${e.message.slice(0, 60)}`, label: "" }];
    }
    // repetition loops / malformed JSON: retry in halves
    const mid = Math.ceil(batch.length / 2);
    return [...(await modelScores(ai, batch.slice(0, mid), rule, labels)), ...(await modelScores(ai, batch.slice(mid), rule, labels))];
  }
}

function allowedLabels(ai, existing, settings) {
  const ignore = new Set((ai.ignoreLabels || []).map(normLabel));
  const fmt = labelFormatFor(settings || { labelFormat: "auto" }, existing);
  const set = new Map();
  for (const l of existing || []) if (!ignore.has(normLabel(l)) && !/^cleaned/i.test(l)) set.set(normLabel(l), l);
  for (const l of ai.suggestedLabels || []) if (!set.has(normLabel(l)) && !ignore.has(normLabel(l))) set.set(normLabel(l), fmt.replace("{name}", l));
  return [...set.values()].slice(0, 60);
}

const coreName = (l) => String(l || "").trim().replace(/^\[|\]$/g, "").replace(/^[@#!]/, "").trim();

async function modelScoresOnce(ai, batch, rule, labels) {
  // the model sees plain core names (Finance, Dev); we map back to the real Gmail label ([Finance]) afterwards
  const coreToReal = new Map();
  for (const l of labels) if (!coreToReal.has(coreName(l).toLowerCase())) coreToReal.set(coreName(l).toLowerCase(), l);
  const cores = [...new Set(labels.map((l) => coreName(l)))];
  const list = batch
    .map((m, k) => {
      const hints = ai.heuristics ? hintsFor(m).filter((h) => h !== "automated sender address") : [];
      return `${k + 1}. From: ${m.sender} <${m.email}>\n   Subject: ${m.subject}\n   Preview: ${(m.snippet || "").slice(0, 220)}${hints.length ? `\n   Hints: ${hints.join("; ")}` : ""}`;
    })
    .join("\n");
  const sys = withPersona(ai, ai.prompt || DEFAULT_AI_PROMPT) + "\n\n" + FEW_SHOT + (rule?.aiHint ? `\n\nExtra guidance from the user: ${rule.aiHint}` : "");
  const labelLine = cores.length ? `Allowed labels for KEEP mail (pick exactly one of these names, "Other" only as last resort): ${cores.map((l) => JSON.stringify(l)).join(", ")}.\n\n` : "";
  const user = `${labelLine}Classify each email. Respond ONLY with JSON: {"results":[{"n":1,"verdict":"keep","confidence":90,"label":"Finance","reason":"≤8 words"}, ...]} covering every number 1..${batch.length}.\n\n${list}`;
  const content = await llmChat(ai, [
    { role: "system", content: sys },
    { role: "user", content: user },
  ], { numPredict: 70 * batch.length + 60, format: resultSchema(cores) });
  const parsed = extractJson(content);
  const arr = Array.isArray(parsed) ? parsed : parsed.results || parsed.emails || Object.values(parsed).find(Array.isArray) || [];
  const byN = new Map(arr.map((x) => [Number(x.n ?? x.index ?? x.id), x]));
  return batch.map((m, k) => {
    const v = byN.get(k + 1) || arr[k];
    const label = coreToReal.get(coreName(v?.label).toLowerCase()) || "";
    return { score: parseScore(v), reason: String(v?.reason || "").slice(0, 140), label };
  });
}

/** Sender's remembered label: manual choice wins; otherwise a label seen ≥2 times that beats every other. */
function senderLabel(st) {
  if (!st) return "";
  if (st.labelManual) return st.labelManual;
  const counts = st.labels || {};
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return "";
  const [top, n] = sorted[0];
  const second = sorted[1]?.[1] || 0;
  return n >= 2 && n > second ? top : "";
}

async function aiClassify(items, rule, existingLabels = []) {
  const settingsAll = await getSettings();
  const { ai } = settingsAll;
  const threshold = Number(ai.threshold) || 60;
  const labels = ai.labeling ? allowedLabels(ai, existingLabels, settingsAll) : [];
  if (existingLabels?.length) await browser.storage.local.set({ knownLabels: existingLabels });
  const stats = await getSenderStats();
  const out = [];
  const toModel = [];

  for (const m of items) {
    const st = stats[m.email];
    if (ai.senderMemory && st) {
      if (st.manual === "junk") {
        out.push({ id: m.id, email: m.email, junk: true, score: 100, reason: "sender marked junk by you", source: "manual" });
        continue;
      }
      if (st.manual === "keep") {
        const l = senderLabel(st);
        if (l || !labels.length) {
          out.push({ id: m.id, email: m.email, junk: false, score: 0, reason: "sender marked keep by you", source: "manual", label: l });
          continue;
        }
      }
      if ((st.junk || 0) >= 2 && !(st.keep > 0)) {
        out.push({ id: m.id, email: m.email, junk: true, score: 95, reason: `sender junk ${st.junk}× before`, source: "sender", label: "" });
        continue;
      }
      if ((st.keep || 0) >= 3 && !(st.junk > 0)) {
        const l = senderLabel(st);
        if (l || !labels.length) {
          out.push({ id: m.id, email: m.email, junk: false, score: 5, reason: `sender kept ${st.keep}× before`, source: "sender", label: l });
          continue;
        }
      }
    }
    toModel.push(m);
  }

  const size = Math.max(1, Math.min(30, Number(ai.batchSize) || 12));
  for (let i = 0; i < toModel.length; i += size) {
    const batch = toModel.slice(i, i + size);
    const scores = await modelScores(ai, batch, rule, labels);
    batch.forEach((m, k) => {
      const hints = ai.heuristics ? hintsFor(m) : [];
      let score = scores[k].score;
      let reason = scores[k].reason;
      if (score == null) {
        // model gave nothing usable: fall back to heuristics alone
        score = 50 + heuristicAdjust(hints);
        reason = "no model verdict; heuristics only";
      } else if (ai.heuristics) {
        score = Math.max(0, Math.min(100, score + heuristicAdjust(hints)));
      }
      const junk = score >= threshold;
      const label = junk ? "" : scores[k].label || "";
      out.push({ id: m.id, email: m.email, junk, score: Math.round(score), reason, source: "model", hints, label });
      if (ai.senderMemory && m.email) {
        const st = (stats[m.email] = stats[m.email] || { junk: 0, keep: 0 });
        st[junk ? "junk" : "keep"] = (st[junk ? "junk" : "keep"] || 0) + 1;
        if (!junk && label) {
          st.labels = st.labels || {};
          st.labels[label] = (st.labels[label] || 0) + 1;
          st.label = senderLabel(st) || undefined;
        }
        st.at = Date.now();
      }
    });
  }

  await browser.storage.local.set({ senderStats: stats });
  // log for later analysis / export
  const log = await getStore("aiLog", []);
  const byId = new Map(out.map((o) => [o.id, o]));
  for (const m of items) {
    const o = byId.get(m.id);
    if (!o) continue;
    log.push({ at: Date.now(), rule: rule?.name, email: m.email, sender: m.sender, subject: m.subject, snippet: (m.snippet || "").slice(0, 220), score: o.score, junk: o.junk, label: o.label, reason: o.reason, source: o.source });
  }
  await browser.storage.local.set({ aiLog: log.slice(-3000) });
  return out;
}

const UNSUB_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer" }, unsubscribe: { type: "boolean" }, reason: { type: "string" } },
        required: ["n", "unsubscribe", "reason"],
      },
    },
  },
  required: ["results"],
};

const UNSUB_PROMPT = `You help {{persona}} prune their Gmail subscriptions. For each sender decide whether to UNSUBSCRIBE (true) or keep (false).

Unsubscribe = sender adds no value: marketing, promotions, sales, coupons, newsletters they never read, news digests, social-network notification mail, job-board digests, course/webinar/coach pitches, "we miss you", product announcements, community digests, app engagement nudges, review requests.
Keep = sender also carries things the person needs: banks, brokers, payment providers, tax/government, couriers and shops they order from (order updates share the same sender as promos), domain/hosting/SaaS they pay for, GitHub/CI, utilities, telecom, insurance, school/university, healthcare, employers, clients, recruiters they talk to, security/account alerts.
If a sender is a shop or service the person transacts with, keep (unsubscribing may also stop order mail). When in doubt, keep.`;

// senders the person likely transacts with: never auto-suggest unsubscribing (user can still tick them)
const TRANSACTIONAL_SENDER = /(bank|hdfc|icici|sbi|axis|kotak|idfc|yes ?bank|rbl|indusind|zerodha|groww|upstox|angel ?one|kite|coin|paytm|phonepe|gpay|razorpay|cashfree|stripe|paypal|cred\b|bobcard|cibil|experian|crif|equifax|amazon|flipkart|myntra|ajio|meesho|swiggy|zomato|blinkit|zepto|instamart|bigbasket|dunzo|shiprocket|delhivery|bluedart|dtdc|ekart|hostinger|godaddy|namecheap|cloudflare|aws|amazonaws|digitalocean|hetzner|vercel|netlify|github|gitlab|bitbucket|google|microsoft|apple|uidai|gov\.in|nic\.in|incometax|irctc|makemytrip|goibibo|cleartrip|airbnb|uber|ola\b|rapido|jio|airtel|vodafone|bsnl|tata ?play|lic\b|insurance|policybazaar|upwork|fiverr|toptal|freelancer|naukri|linkedin\.com\/jobs|epfo|nps|mutual ?fund|camsonline|kfintech)/i;

async function aiSuggestUnsubscribe(subs) {
  const { ai } = await getSettings();
  if (!Array.isArray(subs) || !subs.length) return subs;
  const log = await getStore("aiLog", []);
  const stats = await getSenderStats();
  const subjectsBy = {};
  for (const l of log) {
    if (!l.email) continue;
    (subjectsBy[l.email] = subjectsBy[l.email] || []);
    if (subjectsBy[l.email].length < 4 && !subjectsBy[l.email].includes(l.subject)) subjectsBy[l.email].push(l.subject);
  }
  // also match by domain for senders we saw under a different local part
  const byDomain = {};
  for (const [e, subj] of Object.entries(subjectsBy)) {
    const d = e.split("@")[1];
    if (d) (byDomain[d] = byDomain[d] || []).push(...subj);
  }
  const enriched = subs.map((sub) => {
    const d = (sub.email || "").split("@")[1];
    const subjects = (subjectsBy[sub.email] || byDomain[d] || []).slice(0, 4);
    const st = stats[sub.email];
    const transactional = TRANSACTIONAL_SENDER.test(`${sub.name} ${sub.email}`) || subjects.some((x) => STRONG_KEEP.test(x));
    return { ...sub, subjects, junkSeen: st?.junk || 0, keepSeen: st?.keep || 0, manual: st?.manual || null, transactional };
  });
  const size = 15;
  const out = [];
  for (let i = 0; i < enriched.length; i += size) {
    const batch = enriched.slice(i, i + size);
    const list = batch
      .map((m, k) => `${k + 1}. ${m.name} <${m.email}>${m.count ? ` – ${m.count} emails` : ""}${m.subjects.length ? `\n   Recent subjects: ${m.subjects.map((x) => JSON.stringify(x)).join("; ")}` : ""}${m.junkSeen || m.keepSeen ? `\n   Earlier triage: ${m.junkSeen} junk / ${m.keepSeen} keep` : ""}${m.transactional ? "\n   Hint: a service the person transacts with" : ""}`)
      .join("\n");
    try {
      const content = await llmChat(ai, [
        { role: "system", content: withPersona(ai, UNSUB_PROMPT) },
        { role: "user", content: `Decide for each sender. Respond ONLY with JSON {"results":[{"n":1,"unsubscribe":true,"reason":"≤8 words"},…]} covering 1..${batch.length}.\n\n${list}` },
      ], { format: UNSUB_SCHEMA, numPredict: 60 * batch.length + 60 });
      const arr = extractJson(content).results || [];
      const byN = new Map(arr.map((x) => [Number(x.n), x]));
      batch.forEach((m, k) => {
        const v = byN.get(k + 1);
        let unsub = !!(v && v.unsubscribe === true);
        let reason = v?.reason || (m.manual ? "your sender rule" : "no verdict");
        if (unsub && m.transactional && !m.manual) {
          unsub = false;
          reason = `${reason} – transactional sender, kept by default`;
        }
        if (m.manual === "junk") unsub = true;
        if (m.manual === "keep") unsub = false;
        out.push({ ...m, unsubscribe: unsub, reason });
      });
    } catch (e) {
      batch.forEach((m) => out.push({ ...m, unsubscribe: m.manual === "junk", reason: `model error: ${e.message.slice(0, 50)}` }));
    }
  }
  return out;
}

async function aiTest() {
  const { ai } = await getSettings();
  const t0 = Date.now();
  const sample = [
    { id: "a", sender: "Zara", email: "news@zara.com", subject: "50% off everything this weekend", snippet: "Shop the sale now" },
    { id: "b", sender: "Sam", email: "sam.mehta@gmail.com", subject: "Re: invoice for October", snippet: "Hi, attached is the corrected invoice" },
  ];
  const v = await modelScores(ai, sample);
  const model = ai.provider === "openai" ? ai.openaiModel : ai.provider === "anthropic" ? ai.anthropicModel : ai.model;
  if (v.every((x) => x.score == null)) return { ok: false, error: `${ai.provider || "ollama"} answered but returned no usable JSON (${v[0]?.reason || ""})` };
  return { ok: true, ms: Date.now() - t0, verdicts: sample.map((s, i) => ({ id: s.id, score: v[i].score })), model: `${ai.provider || "ollama"}:${model}` };
}

// ---------------------------------------------------------------- alarms

async function syncAlarm(settings) {
  await browser.alarms.clear(ALARM_NAME);
  if (settings.autoClean) {
    const periodInMinutes = Math.max(1, Number(settings.autoIntervalHours) || 24) * 60;
    browser.alarms.create(ALARM_NAME, { periodInMinutes, delayInMinutes: 2 });
  }
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  try {
    await browser.storage.local.set({ runOptions: { openReview: false, notify: true } });
    await runInGmail("clean");
    browser.__action().setBadgeText({ text: "" });
  } catch (e) {
    browser.__action().setBadgeText({ text: "!" });
    browser.__action().setBadgeBackgroundColor({ color: "#c62828" });
    browser.__action().setTitle({
      title: e.message === "NO_GMAIL_TAB" ? "Inbox Broom – auto-clean skipped: no Gmail tab open" : `Inbox Broom – auto-clean failed: ${e.message}`,
    });
  }
});

async function injectIntoOpenGmailTabs() {
  const tabs = await browser.tabs.query({ url: "https://mail.google.com/*" });
  for (const t of tabs) {
    try {
      if (browser.scripting) {
        await browser.scripting.insertCSS({ target: { tabId: t.id }, files: ["content.css"] });
        await browser.scripting.executeScript({ target: { tabId: t.id }, files: ["lib/compat.js", "content.js"] });
      } else {
        await browser.tabs.insertCSS(t.id, { file: "content.css" });
        await browser.tabs.executeScript(t.id, { file: "lib/compat.js" });
        await browser.tabs.executeScript(t.id, { file: "content.js" });
      }
    } catch (e) {
      console.warn("inject failed", t.id, e.message);
    }
  }
}

/** Is a run really in progress in the Gmail tab? Clears stale progress if not. */
async function liveStatus() {
  const tab = await findGmailTab();
  let running = false;
  if (tab) {
    try {
      running = !!(await browser.__tabSend(tab.id, { type: "ping" }))?.running;
    } catch {
      running = false;
    }
  }
  if (!running) await browser.storage.local.set({ progress: { text: "", at: Date.now(), running: false } });
  return { running, hasTab: !!tab };
}

browser.runtime.onInstalled.addListener(async () => {
  await browser.storage.local.set({ progress: { text: "", at: Date.now(), running: false } });
  syncAlarm(await migrate());
  injectIntoOpenGmailTabs();
});
browser.runtime.onStartup.addListener(async () => syncAlarm(await getSettings()));

// ---------------------------------------------------------------- messaging

browser.__onMessage(async (msg) => {
  switch (msg.type) {
    case "getSettings":
      return getSettings();
    case "saveSettings":
      return saveSettings(msg.patch);
    case "addAllowlist": {
      const s = await getSettings();
      return saveSettings({ allowlist: [...new Set([...(s.allowlist || []), ...msg.entries])] });
    }
    case "gmailTab":
      return !!(await findGmailTab());
    case "status":
      return liveStatus();
    case "run": {
      await browser.storage.local.set({ runOptions: { openReview: msg.openReview !== false } });
      return runInGmail(msg.mode, { focus: true, create: true, ruleIds: msg.ruleIds || null, rescore: !!msg.rescore }); // { started: true }
    }
    case "scanFinished": {
      const { runOptions } = await browser.storage.local.get("runOptions");
      await onScanFinished(msg, { openReview: runOptions?.openReview !== false });
      return true;
    }
    case "applyFinished":
      await onApplyFinished(msg);
      return true;
    case "keepalive":
      return true;
    case "stop": {
      const tab = await findGmailTab();
      if (tab) await browser.__tabSend(tab.id, { type: "stop" }).catch(() => {});
      return true;
    }
    case "runFinished": {
      if (msg.mode !== "clean") return true;
      const s = await getSettings();
      const entry = { at: Date.now(), total: msg.total, summary: msg.summary };
      await browser.storage.local.set({ settings: { ...s, history: [entry, ...(s.history || [])].slice(0, 50) }, cleanResult: { at: Date.now(), total: msg.total, stopped: msg.stopped } });
      const { runOptions } = await browser.storage.local.get("runOptions");
      if (runOptions?.notify && msg.total > 0) {
        browser.notifications.create({ type: "basic", iconUrl: browser.runtime.getURL("icons/icon-96.png"), title: "Inbox Broom", message: `Auto-clean handled ${msg.total} conversation(s).` });
      }
      return true;
    }
    case "aiClassify":
      try {
        return await aiClassify(msg.items, msg.rule, msg.labels || []);
      } catch (e) {
        return { error: e.message };
      }
    case "previewGet":
      return getStore("lastPreview", null);
    case "previewSave":
      await browser.storage.local.set({ lastPreview: msg.preview });
      return true;
    case "openReview":
      await openReviewTab();
      return true;
    case "apply":
      return applyPlan(msg.plan);
    case "createLabels":
    case "organizeLabels": {
      const s = await getSettings();
      const tab = await findGmailTab({ create: true });
      if (!tab) throw new Error("NO_GMAIL_TAB");
      await browser.tabs.update(tab.id, { active: true });
      const names = [...new Set([...(s.ai.suggestedLabels || []), ...Object.keys(s.retention || {}).filter((k) => k !== "*"), ...Object.keys(s.labelStyle || {})])];
      const res = await browser.__tabSend(tab.id, {
        type: msg.type,
        names,
        labelFormat: s.labelFormat || "auto",
        style: s.labelStyle || {},
      });
      if (res?.labels) await browser.storage.local.set({ knownLabels: res.labels });
      await browser.storage.local.set({ lastToolReport: { at: Date.now(), tool: msg.type, ...res } });
      return res;
    }
    case "lastToolReport":
      return getStore("lastToolReport", null);
    case "listLabels": {
      const tab = await findGmailTab();
      if (!tab) throw new Error("NO_GMAIL_TAB");
      return browser.__tabSend(tab.id, { type: "listLabels" });
    }
    case "aiCacheMerge": {
      const cache = await getAiCache();
      for (const [k, v] of Object.entries(msg.entries || {})) cache[k] = { ...(cache[k] || {}), ...v };
      const keys = Object.keys(cache);
      if (keys.length > 5000) keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0)).slice(0, keys.length - 5000).forEach((k) => delete cache[k]);
      await browser.storage.local.set({ aiCache: cache });
      return true;
    }
    case "aiCacheSet": {
      const cache = await getAiCache();
      cache[msg.id] = { junk: !!msg.junk, score: msg.junk ? 100 : 0, reason: "manual", at: Date.now(), manual: true };
      await browser.storage.local.set({ aiCache: cache });
      return true;
    }
    case "senderSet": {
      // msg.verdict: "junk" | "keep" | null
      const stats = await getSenderStats();
      const st = (stats[msg.email] = stats[msg.email] || { junk: 0, keep: 0 });
      if (msg.verdict !== undefined) st.manual = msg.verdict || undefined;
      if (msg.label !== undefined) {
        st.labelManual = msg.label || undefined;
        st.label = msg.label || senderLabel(st) || undefined;
      }
      st.at = Date.now();
      await browser.storage.local.set({ senderStats: stats });
      return true;
    }
    case "senderStats":
      return getSenderStats();
    case "aiCacheClear":
      await browser.storage.local.remove(["aiCache", "senderStats"]);
      return true;
    case "aiLogGet":
      return getStore("aiLog", []);
    case "aiLogClear":
      await browser.storage.local.remove("aiLog");
      return true;
    case "aiTest":
      try {
        return await aiTest();
      } catch (e) {
        return { ok: false, error: e.message };
      }
    default:
      throw new Error(`Unknown message: ${msg.type}`);
  }
});
