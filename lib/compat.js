/* Cross-browser shim: Firefox (MV2, `browser.*` promises) and Chromium (MV3, `chrome.*`).
 * Loaded first in every context: background, content script, popup, options, review. */
(() => {
  const g = globalThis;
  if (typeof g.browser === "undefined" && typeof g.chrome !== "undefined") g.browser = g.chrome;
  const b = g.browser;
  if (!b) return;
  b.__isChromium = typeof g.chrome !== "undefined" && !!g.chrome.runtime && !(g.chrome.runtime.getBrowserInfo);

  /** Register an async message handler. Uses sendResponse + `return true`, which both browsers support. */
  b.__onMessage = (handler) => {
    b.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      let r;
      try {
        r = handler(msg, sender);
      } catch (e) {
        sendResponse({ __err: e?.message || String(e) });
        return false;
      }
      if (r && typeof r.then === "function") {
        r.then((v) => sendResponse(v === undefined ? null : v), (e) => sendResponse({ __err: e?.message || String(e) }));
        return true;
      }
      sendResponse(r === undefined ? null : r);
      return false;
    });
  };
  const unwrap = (r) => {
    if (r && typeof r === "object" && r.__err) throw new Error(r.__err);
    return r;
  };
  /** runtime.sendMessage that rethrows handler errors. */
  b.__send = async (msg) => unwrap(await b.runtime.sendMessage(msg));
  /** tabs.sendMessage that rethrows handler errors. */
  b.__tabSend = async (tabId, msg) => unwrap(await b.tabs.sendMessage(tabId, msg));
  /** browserAction (MV2) or action (MV3). */
  b.__action = () => b.action || b.browserAction;
})();
