// Applies the theme setting (system | light | dark) to <html data-theme>. Loaded in <head> on every page.
(async () => {
  try {
    const apply = (t) => { if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
    const { settings } = await browser.storage.local.get("settings");
    apply(settings?.theme);
    browser.storage.onChanged.addListener((ch) => { if (ch.settings?.newValue) apply(ch.settings.newValue.theme); });
  } catch {}
})();
