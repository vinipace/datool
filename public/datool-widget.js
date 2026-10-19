/*! Datool Build: SPDX-License-Identifier: Elastic-2.0. See /licenses/Elastic-2.0.txt. */
(function () {
  "use strict";

  var script = document.currentScript;
  var dataset = script && script.dataset ? script.dataset : {};
  var channelId = dataset.channelId || dataset.datoolChannel;
  if (!channelId) return;

  var previous = window.DatoolWidget;
  if (previous && typeof previous.destroy === "function") previous.destroy();

  var sourceUrl = script && script.src ? new URL(script.src, window.location.href) : null;
  function safeHttpUrl(value) {
    try {
      var url = new URL(value, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.href.replace(/\/$/, "");
    } catch (_error) {
      return null;
    }
  }
  var sourceOrigin = sourceUrl && (sourceUrl.protocol === "http:" || sourceUrl.protocol === "https:")
    ? sourceUrl.origin
    : window.location.origin;
  var baseUrl = safeHttpUrl(dataset.baseUrl || sourceOrigin) || window.location.origin;
  var disposed = false;
  var settings = {};
  var launcher = {};
  var host = document.createElement("div");
  host.setAttribute("data-datool-widget", channelId);
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";

  var frame = document.createElement("iframe");
  frame.title = dataset.title || "Customer support chat";
  frame.loading = "lazy";
  frame.allow = "clipboard-write";
  frame.setAttribute("aria-hidden", "true");
  var context = dataset.context;
  var chatUrl = baseUrl + "/chat/" + encodeURIComponent(channelId) + "?embed=1";
  if (context) chatUrl += "&context=" + encodeURIComponent(context);
  if (window.location.origin) chatUrl += "&origin=" + encodeURIComponent(window.location.origin);
  frame.src = chatUrl;
  frame.style.cssText = "display:none;width:min(400px,calc(100vw - 32px));height:min(680px,calc(100vh - 96px));margin-bottom:12px;border:1px solid ButtonBorder;border-radius:14px;background:Canvas;box-shadow:0 12px 40px color-mix(in srgb, CanvasText 18%, transparent);";

  var button = document.createElement("button");
  button.type = "button";
  button.textContent = dataset.buttonLabel || "Chat";
  button.setAttribute("aria-label", dataset.buttonLabel || "Open chat");
  button.style.cssText = "display:block;margin-left:auto;border:1px solid ButtonBorder;border-radius:999px;background:ButtonFace;color:ButtonText;padding:10px 16px;font:600 14px/1 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer;box-shadow:0 4px 16px color-mix(in srgb, CanvasText 18%, transparent);";

  function open() {
    frame.style.display = "block";
    frame.setAttribute("aria-hidden", "false");
    renderLauncher(true);
  }

  function close() {
    frame.style.display = "none";
    frame.setAttribute("aria-hidden", "true");
    renderLauncher(false);
  }

  function toggle() {
    if (frame.style.display === "none") open();
    else close();
  }

  function destroy() {
    disposed = true;
    window.removeEventListener("message", onMessage);
    host.remove();
    if (window.DatoolWidget && window.DatoolWidget.channelId === channelId) delete window.DatoolWidget;
  }

  function onMessage(event) {
    if (event.source !== frame.contentWindow || event.origin !== new URL(baseUrl).origin) return;
    if (event.data && event.data.type === "datool:chat:close") close();
  }

  button.addEventListener("click", toggle);
  window.addEventListener("message", onMessage);
  host.appendChild(frame);
  host.appendChild(button);
  function renderLauncher(opened) {
    button.replaceChildren();
    var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("width", "24"); icon.setAttribute("height", "24"); icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none"); icon.setAttribute("stroke", "currentColor"); icon.setAttribute("stroke-width", "2"); icon.setAttribute("aria-hidden", "true");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", opened ? "M6 6l12 12M6 18L18 6" : launcher.iconPath || "");
    icon.appendChild(path);
    if (!opened && launcher.iconUrl) {
      var image = document.createElement("img"); image.src = launcher.iconUrl; image.alt = ""; image.referrerPolicy = "no-referrer"; image.style.cssText = "width:24px;height:24px;object-fit:contain"; button.appendChild(image);
    } else { button.appendChild(icon); }
    var label = opened ? dataset.closeLabel : (dataset.buttonLabel || launcher.label);
    if (label) button.appendChild(document.createTextNode(label));
    button.setAttribute("aria-label", opened ? launcher.closeLabel || "Close chat" : (label || launcher.openLabel || "Open chat"));
    button.setAttribute("aria-expanded", String(opened));
  }
  fetch(baseUrl + "/api/build-public/" + encodeURIComponent(channelId) + "/appearance", { credentials: "omit", cache: "no-store" })
    .then(function (response) { if (!response.ok) throw new Error("Chat unavailable"); return response.json(); })
    .then(function (result) {
      if (disposed) return;
      settings = result.data.appearance;
      launcher = result.data.launcher;
      var left = settings.position === "left";
      var offsetX = Number(settings.offsetX) || 0;
      var offsetY = Number(settings.offsetY) || 0;
      host.style.right = left ? "auto" : "min(" + offsetX + "px, 5vw)";
      host.style.left = left ? "min(" + offsetX + "px, 5vw)" : "auto";
      host.style.bottom = "min(" + offsetY + "px, 10vh)";
      frame.style.borderRadius = ({ square: 0, small: 8, medium: 16, large: 24 }[settings.radius] || 0) + "px";
      frame.style.width = "min(400px, calc(100vw - min(" + (offsetX * 2) + "px, 10vw) - 8px))";
      frame.style.height = "min(680px, calc(100dvh - min(" + offsetY + "px, 10vh) - 84px))";
      button.style.cssText = "display:flex;align-items:center;justify-content:center;gap:8px;min-width:56px;min-height:56px;padding:14px;border:0;border-radius:999px;cursor:pointer;box-shadow:0 4px 16px color-mix(in srgb, CanvasText 18%, transparent);";
      button.style.marginLeft = left ? "0" : "auto";
      button.style.marginRight = left ? "auto" : "0";
      button.style.background = launcher.color;
      var hex = launcher.color.slice(1);
      var luminance = parseInt(hex.slice(0,2),16) * .299 + parseInt(hex.slice(2,4),16) * .587 + parseInt(hex.slice(4,6),16) * .114;
      button.style.color = luminance > 150 ? "#151518" : "#ffffff";
      button.style.fontFamily = settings.fontFamily === "serif" ? "Georgia,serif" : settings.fontFamily === "inter" ? "Inter,system-ui,sans-serif" : "system-ui,sans-serif";
      button.style.fontSize = settings.fontSize + "px";
      frame.title = dataset.title || settings.displayName + " chat";
      renderLauncher(frame.style.display !== "none");
      (document.body || document.documentElement).appendChild(host);
    }).catch(function () { /* Paused, unavailable or disallowed channels stay hidden. */ });
  window.DatoolWidget = { channelId: channelId, open: open, close: close, toggle: toggle, destroy: destroy };
  if (dataset.open === "true" || dataset.open === "1") open();
})();
