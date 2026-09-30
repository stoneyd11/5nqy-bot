// Applies settings-driven visual themes without touching provider DOM logic.
(() => {
  "use strict";
  const apply = (theme) => {
    const value = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.nqyTheme = value;
  };
  try {
    chrome.storage.local.get("nqSettings", (r) => apply(r?.nqSettings?.theme));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.nqSettings?.newValue) apply(changes.nqSettings.newValue.theme);
    });
  } catch { apply("dark"); }
})();
