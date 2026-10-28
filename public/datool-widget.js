/*! Datool Build: SPDX-License-Identifier: Elastic-2.0. See /licenses/Elastic-2.0.txt. */
;(function () {
  "use strict"

  var script = document.currentScript
  var dataset = script && script.dataset ? script.dataset : {}
  var channelId = dataset.channelId || dataset.datoolChannel
  if (!channelId) return

  var previous = window.DatoolWidget
  if (previous && typeof previous.destroy === "function") previous.destroy()

  var sourceUrl =
    script && script.src ? new URL(script.src, window.location.href) : null
  function safeHttpUrl(value) {
    try {
      var url = new URL(value, window.location.href)
      if (url.protocol !== "http:" && url.protocol !== "https:") return null
      return url.href.replace(/\/$/, "")
    } catch (_error) {
      return null
    }
  }
  var sourceOrigin =
    sourceUrl &&
    (sourceUrl.protocol === "http:" || sourceUrl.protocol === "https:")
      ? sourceUrl.origin
      : window.location.origin
  var baseUrl =
    safeHttpUrl(dataset.baseUrl || sourceOrigin) || window.location.origin
  var stateKey = "datool:launcher:" + baseUrl + ":" + channelId
  function saveOpen(opened) {
    try {
      window.sessionStorage.setItem(stateKey, opened ? "open" : "closed")
    } catch (_) {
      /* Optional browser storage. */
    }
  }
  var wasOpen = false
  try {
    wasOpen = window.sessionStorage.getItem(stateKey) === "open"
  } catch (_) {
    /* Optional browser storage. */
  }
  var disposed = false
  var settings = {}
  var launcher = {}
  var host = document.createElement("div")
  host.setAttribute("data-datool-widget", channelId)
  host.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483000;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"

  var frame = document.createElement("iframe")
  frame.title = dataset.title || "Customer support chat"
  // Warm the UI and signed session before the launcher is opened.
  frame.loading = "eager"
  frame.allow = "clipboard-write"
  frame.setAttribute("aria-hidden", "true")
  var context = dataset.context
  var chatUrl =
    baseUrl + "/chat/" + encodeURIComponent(channelId) + "?embed=1&preload=1"
  if (dataset.shopifyProxy) chatUrl += "&shopify=1"
  if (context) chatUrl += "&context=" + encodeURIComponent(context)
  if (window.location.origin)
    chatUrl += "&origin=" + encodeURIComponent(window.location.origin)
  frame.src = chatUrl
  frame.style.cssText =
    "display:none;width:min(400px,calc(100vw - 32px));height:min(680px,calc(100vh - 96px));margin-bottom:12px;border:1px solid ButtonBorder;border-radius:14px;background:Canvas;box-shadow:0 12px 40px color-mix(in srgb, CanvasText 18%, transparent);"

  var button = document.createElement("button")
  button.type = "button"
  button.textContent = dataset.buttonLabel || "Chat"
  button.setAttribute("aria-label", dataset.buttonLabel || "Open chat")
  button.style.cssText =
    "display:block;margin-left:auto;border:1px solid ButtonBorder;border-radius:999px;background:ButtonFace;color:ButtonText;padding:10px 16px;font:600 14px/1 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer;box-shadow:0 4px 16px color-mix(in srgb, CanvasText 18%, transparent);"

  function notifyVisibility() {
    if (frame.contentWindow)
      frame.contentWindow.postMessage(
        {
          type: "datool:chat:visibility",
          visible: frame.style.display !== "none",
        },
        new URL(baseUrl).origin
      )
  }

  function notifyVisibility() {
    if (frame.contentWindow) frame.contentWindow.postMessage({
      type: "datool:chat:visibility",
      visible: frame.style.display !== "none"
    }, frameOrigin);
  }

  function open() {
    if (disposed) return
    saveOpen(true)
    frame.style.display = "block"
    frame.setAttribute("aria-hidden", "false")
    renderLauncher(true)
    notifyVisibility()
  }

  function close() {
    if (disposed) return
    saveOpen(false)
    frame.style.display = "none"
    frame.setAttribute("aria-hidden", "true")
    renderLauncher(false)
    notifyVisibility()
  }

  function toggle() {
    if (frame.style.display === "none") open()
    else close()
  }

  function destroy() {
    disposed = true
    window.removeEventListener("message", onMessage)
    host.remove()
    if (window.DatoolWidget && window.DatoolWidget.channelId === channelId)
      delete window.DatoolWidget
  }

  var sessionStorageKey = "datool:visitor:" + baseUrl + ":" + channelId
  function readStored(key) {
    try {
      return JSON.parse(window.localStorage.getItem(key) || "null")
    } catch (_) {
      return null
    }
  }
  function storeValue(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch (_) {
      /* Storage can be disabled. */
    }
  }
  var browserCredential = readStored(sessionStorageKey + ":shopify-browser")
  var identityRequest = Promise.resolve()
  var verifiedVisitorId = null
  function onMessage(event) {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== new URL(baseUrl).origin
    )
      return
    if (
      event.data &&
      event.data.type === "datool:chat:session-save" &&
      !dataset.shopifyProxy
    ) {
      storeValue(sessionStorageKey, event.data.session)
    }
    if (
      event.data &&
      event.data.type === "datool:chat:session-request" &&
      typeof event.data.requestId === "string"
    ) {
      var input = event.data
      identityRequest = identityRequest
        .catch(function () {})
        .then(async function () {
          var result
          try {
            if (dataset.shopifyProxy) {
              browserCredential =
                readStored(sessionStorageKey + ":shopify-browser") ||
                browserCredential
              var proxy = new URL(dataset.shopifyProxy, window.location.origin)
              if (
                proxy.origin !== window.location.origin ||
                proxy.search ||
                proxy.hash
              )
                throw new Error("Invalid store session endpoint.")
              var response = await fetch(
                proxy.href.replace(/\/$/, "") +
                  "/" +
                  encodeURIComponent(channelId),
                {
                  method: "POST",
                  credentials: "same-origin",
                  cache: "no-store",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    origin: window.location.origin,
                    browserToken: browserCredential || undefined,
                    conversationId: input.conversationId,
                    newConversation: input.newConversation === true,
                    challengeToken: input.challengeToken,
                  }),
                }
              )
              var payload = await response.json()
              if (payload.error) {
                verifiedVisitorId = null
                result = { error: payload.error, shopify: true }
              } else if (!response.ok || !payload.data)
                throw new Error("Could not verify your store session.")
              else {
                browserCredential = payload.data.browserToken
                storeValue(
                  sessionStorageKey + ":shopify-browser",
                  browserCredential
                )
                delete payload.data.browserToken
                verifiedVisitorId = payload.data.visitorId
                result = { session: payload.data, shopify: true }
              }
            } else
              result = {
                session: readStored(sessionStorageKey),
                shopify: false,
              }
          } catch (_) {
            verifiedVisitorId = null
            result = {
              error: {
                message:
                  "Could not verify your store session. Please refresh the page.",
              },
            }
          }
          if (!disposed)
            frame.contentWindow.postMessage(
              Object.assign(
                {
                  type: "datool:chat:session-response",
                  requestId: input.requestId,
                },
                result
              ),
              new URL(baseUrl).origin
            )
        })
    }
    if (event.data && event.data.type === "datool:shopify:cart-request") {
      var cartInput = event.data
      if (typeof cartInput.requestId !== "string") return
      executeCart(cartInput).then(function (result) {
        if (!disposed)
          frame.contentWindow.postMessage(
            {
              type: "datool:shopify:cart-response",
              requestId: cartInput.requestId,
              result: result,
            },
            new URL(baseUrl).origin
          )
      })
    }
    if (event.data && event.data.type === "datool:chat:close") close()
    // Replay clicks that happened before the iframe finished hydrating.
    if (event.data && event.data.type === "datool:chat:ready")
      notifyVisibility()
    if (
      event.data &&
      event.data.type === "datool:chat:navigate" &&
      typeof event.data.href === "string"
    ) {
      try {
        var destination = new URL(event.data.href)
        if (
          destination.origin !== window.location.origin ||
          destination.username ||
          destination.password ||
          !/^https?:$/.test(destination.protocol)
        )
          return
        saveOpen(frame.style.display !== "none")
        window.location.assign(destination.href)
      } catch (_) {
        /* Ignore invalid navigation messages. */
      }
    }
  }

  function cartRoot() {
    var root =
      window.Shopify && window.Shopify.routes && window.Shopify.routes.root
    if (typeof root !== "string" || !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(root))
      throw new Error("Open this chat on the store to use its cart.")
    return new URL(root, window.location.origin).href
  }
  function cartCommand(value) {
    if (!value || typeof value !== "object")
      throw new Error("Invalid cart command.")
    var validQuantity = function (quantity, minimum) {
      return Number.isInteger(quantity) && quantity >= minimum && quantity <= 99
    }
    if (value.operation === "read") return { operation: "read" }
    if (
      value.operation === "complete_order" &&
      typeof value.snapshotId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value.snapshotId
      )
    )
      return { operation: "complete_order", snapshotId: value.snapshotId }
    if (
      value.operation === "add" &&
      Array.isArray(value.items) &&
      value.items.length > 0 &&
      value.items.length <= 20
    ) {
      var items = value.items.map(function (item) {
        if (
          !item ||
          typeof item.variantId !== "string" ||
          !/^[1-9][0-9]{0,15}$/.test(item.variantId) ||
          !Number.isSafeInteger(Number(item.variantId)) ||
          !validQuantity(item.quantity, 1)
        )
          throw new Error("Invalid cart item.")
        return { id: item.variantId, quantity: item.quantity }
      })
      return { operation: "add", body: { items: items } }
    }
    if (
      value.operation === "set" &&
      typeof value.lineKey === "string" &&
      value.lineKey.length > 0 &&
      value.lineKey.length <= 256 &&
      validQuantity(value.quantity, 0)
    )
      return {
        operation: "set",
        body: { id: value.lineKey, quantity: value.quantity },
      }
    throw new Error("Invalid cart command.")
  }
  function cartSnapshot(value, root) {
    function integer(number) {
      if (!Number.isSafeInteger(number) || number < 0)
        throw new Error("Invalid cart response.")
      return number
    }
    if (
      !value ||
      typeof value.currency !== "string" ||
      !/^[A-Z]{3}$/.test(value.currency) ||
      !Array.isArray(value.items)
    )
      throw new Error("Invalid cart response.")
    return {
      currency: value.currency,
      totalPrice: integer(value.total_price),
      itemCount: integer(value.item_count),
      items: value.items.slice(0, 100).map(function (item) {
        var url = new URL(item.url, window.location.origin)
        var variantId = String(item.variant_id)
        if (
          url.origin !== window.location.origin ||
          url.username ||
          url.password ||
          url.protocol !== "https:" ||
          typeof item.key !== "string" ||
          item.key.length > 256 ||
          !/^[1-9][0-9]{0,15}$/.test(variantId)
        )
          throw new Error("Invalid cart item.")
        return {
          lineKey: item.key,
          variantId: variantId,
          title: String(item.product_title || item.title || "Item").slice(
            0,
            300
          ),
          quantity: integer(item.quantity),
          finalLinePrice: integer(item.final_line_price),
          url: url.href,
        }
      }),
      truncated: value.items.length > 100,
      requiresStoreCheckout: value.items.some(function (item) {
        return Boolean(
          item.selling_plan_allocation ||
          (item.properties && Object.keys(item.properties).length) ||
          item.has_components ||
          item.parent_relationship
        )
      }),
      cartUrl: root + "cart",
      checkoutUrl: root + "checkout",
    }
  }
  async function readCartData(root) {
    var response = await fetch(root + "cart.js", {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error("Could not read your cart.")
    return response.json()
  }
  async function readCart(root) {
    return cartSnapshot(await readCartData(root), root)
  }
  var purchasePrefix = "datool:purchase:" + baseUrl + ":" + channelId + ":"
  async function cartTokenHash(value) {
    if (
      typeof value.token !== "string" ||
      !value.token ||
      value.token.length > 4096
    )
      throw new Error("Missing cart identity.")
    var digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value.token)
    )
    return Array.from(new Uint8Array(digest), function (byte) {
      return byte.toString(16).padStart(2, "0")
    }).join("")
  }
  async function capturePurchaseCart(root, visitorId) {
    var raw = await readCartData(root)
    var cart = cartSnapshot(raw, root)
    if (!cart.truncated && !cart.requiresStoreCheckout && cart.items.length) {
      try {
        for (var i = window.localStorage.length - 1; i >= 0; i--) {
          var key = window.localStorage.key(i)
          if (key && key.indexOf(purchasePrefix) === 0) {
            var old = readStored(key)
            if (old && old.expiresAt <= Date.now())
              window.localStorage.removeItem(key)
          }
        }
        var id = crypto.randomUUID()
        var expiresAt = Date.now() + 30 * 86400000
        window.localStorage.setItem(
          purchasePrefix + id,
          JSON.stringify({
            visitorId: visitorId,
            expiresAt: expiresAt,
            tokenHash: await cartTokenHash(raw),
            items: cart.items.map(function (item) {
              return {
                lineKey: item.lineKey,
                variantId: item.variantId,
                quantity: item.quantity,
              }
            }),
          })
        )
        cart.purchaseSnapshot = { id: id, expiresAt: expiresAt }
      } catch (_) {
        // Checkout remains available without optional automatic cart cleanup.
      }
    }
    return cart
  }
  async function executeCart(input) {
    var uncertain = {
      status: "uncertain",
      message:
        "The cart change may have completed. Open your cart to check before trying again.",
    }
    try {
      if (
        !dataset.shopifyProxy ||
        !verifiedVisitorId ||
        input.visitorId !== verifiedVisitorId
      )
        throw new Error("Verify your store session before using the cart.")
      var root = cartRoot()
      var command = cartCommand(input.command)
      if (command.operation === "read")
        return {
          status: "completed",
          cart: await capturePurchaseCart(root, input.visitorId),
        }
      if (
        typeof input.operationId !== "string" ||
        !/^[a-zA-Z0-9_-]{16,120}$/.test(input.operationId) ||
        !Number.isFinite(input.expiresAt) ||
        input.expiresAt <= Date.now() ||
        input.expiresAt >
          Date.now() +
            (command.operation === "complete_order" ? 30 * 86400000 : 3600000)
      )
        throw new Error(
          "This cart request expired. Ask the assistant for a new one."
        )
      if (!window.navigator.locks)
        throw new Error("Use the store's cart directly in this browser.")
      var receiptPrefix = "datool:cart:" + baseUrl + ":" + channelId + ":"
      var receiptKey = receiptPrefix + input.operationId
      var fingerprint = JSON.stringify({
        visitor: input.visitorId,
        command: command,
      })
      return await window.navigator.locks.request(
        receiptPrefix + "cart",
        async function () {
          // A persisted pre-dispatch receipt prevents a lost response or page reload from replaying a write.
          // Expired requests cannot execute again, so their receipts may be removed safely.
          for (var i = window.localStorage.length - 1; i >= 0; i--) {
            var key = window.localStorage.key(i)
            if (key && key.indexOf(receiptPrefix) === 0) {
              var stale = readStored(key)
              if (stale && stale.expiresAt <= Date.now())
                window.localStorage.removeItem(key)
            }
          }
          if (
            input.visitorId !== verifiedVisitorId ||
            input.expiresAt <= Date.now()
          )
            throw new Error("Cart request expired.")
          var receipt = readStored(receiptKey)
          if (receipt) {
            if (receipt.fingerprint !== fingerprint)
              throw new Error("This cart request has already been used.")
            if (receipt.status !== "completed") return uncertain
            return { status: "completed", cart: await readCart(root) }
          }
          var purchase
          var cleanupBody
          if (command.operation === "complete_order") {
            purchase = readStored(purchasePrefix + command.snapshotId)
            // Another device (or cleared storage) does not own the original cart.
            if (!purchase || purchase.visitorId !== input.visitorId)
              return { status: "completed", cart: await readCart(root) }
            if (
              purchase.expiresAt !== input.expiresAt ||
              !Array.isArray(purchase.items) ||
              purchase.items.length > 100 ||
              (purchase.operationId &&
                purchase.operationId !== input.operationId)
            )
              throw new Error("This purchase belongs to a different cart.")
            var currentRaw = await readCartData(root)
            var current = cartSnapshot(currentRaw, root)
            var updates = Object.create(null)
            // A completed Shopify checkout may already have replaced the cart.
            // Never clear a new cart, or lines whose keys/options have changed.
            if (purchase.tokenHash === (await cartTokenHash(currentRaw))) {
              if (current.truncated)
                throw new Error("Cart changed; review it in the store.")
              purchase.items.forEach(function (bought) {
                var line = current.items.find(function (item) {
                  return (
                    item.lineKey === bought.lineKey &&
                    item.variantId === bought.variantId
                  )
                })
                if (
                  line &&
                  Number.isSafeInteger(bought.quantity) &&
                  bought.quantity > 0
                )
                  updates[line.lineKey] = Math.max(
                    0,
                    line.quantity - bought.quantity
                  )
              })
            }
            cleanupBody = { updates: updates }
          }
          if (
            input.visitorId !== verifiedVisitorId ||
            input.expiresAt <= Date.now()
          )
            throw new Error("Your store session changed.")
          var pending = {
            fingerprint: fingerprint,
            status: "pending",
            expiresAt: input.expiresAt,
          }
          // Unlike optional chat persistence, writes require durable replay protection.
          window.localStorage.setItem(receiptKey, JSON.stringify(pending))
          try {
            if (purchase) {
              purchase.operationId = input.operationId
              window.localStorage.setItem(
                purchasePrefix + command.snapshotId,
                JSON.stringify(purchase)
              )
            }
            var endpoint = "cart/change.js"
            if (command.operation === "add") endpoint = "cart/add.js"
            if (command.operation === "complete_order")
              endpoint = "cart/update.js"
            var response = null
            if (!cleanupBody || Object.keys(cleanupBody.updates).length) {
              response = await fetch(root + endpoint, {
                method: "POST",
                credentials: "same-origin",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(cleanupBody || command.body),
                signal: AbortSignal.timeout(15000),
              })
            }
            // Even an inventory error can partially change quantities. Never infer no side effects.
            if (response && !response.ok) return uncertain
            pending.status = "completed"
            window.localStorage.setItem(receiptKey, JSON.stringify(pending))
            var cart = await readCart(root)
            window.dispatchEvent(
              new CustomEvent("datool:cart:updated", { detail: cart })
            )
            return { status: "completed", cart: cart }
          } catch (_) {
            return uncertain
          }
        }
      )
    } catch (_) {
      return {
        status: "failed",
        message:
          "The cart request could not be completed. Refresh the chat or open the store's cart.",
      }
    }
  }

  button.addEventListener("click", toggle)
  window.addEventListener("message", onMessage)
  host.appendChild(frame)
  host.appendChild(button)
  function renderLauncher(opened) {
    button.replaceChildren()
    var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    icon.setAttribute("width", "24")
    icon.setAttribute("height", "24")
    icon.setAttribute("viewBox", "0 0 24 24")
    icon.setAttribute("fill", "none")
    icon.setAttribute("stroke", "currentColor")
    icon.setAttribute("stroke-width", "2")
    icon.setAttribute("aria-hidden", "true")
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute(
      "d",
      opened ? "M6 6l12 12M6 18L18 6" : launcher.iconPath || ""
    )
    icon.appendChild(path)
    if (!opened && launcher.iconUrl) {
      var image = document.createElement("img")
      image.src = launcher.iconUrl
      image.alt = ""
      image.referrerPolicy = "no-referrer"
      image.style.cssText = "width:24px;height:24px;object-fit:contain"
      button.appendChild(image)
    } else {
      button.appendChild(icon)
    }
    var label = opened
      ? dataset.closeLabel
      : dataset.buttonLabel || launcher.label
    if (label) button.appendChild(document.createTextNode(label))
    button.setAttribute(
      "aria-label",
      opened
        ? launcher.closeLabel || "Close chat"
        : label || launcher.openLabel || "Open chat"
    )
    button.setAttribute("aria-expanded", String(opened))
  }
  fetch(
    baseUrl +
      "/api/build-public/" +
      encodeURIComponent(channelId) +
      "/appearance",
    { credentials: "omit", cache: "no-store" }
  )
    .then(function (response) {
      if (!response.ok) throw new Error("Chat unavailable")
      return response.json()
    })
    .then(function (result) {
      if (disposed) return
      settings = result.data.appearance
      launcher = result.data.launcher
      var left = settings.position === "left"
      var offsetX = Number(settings.offsetX) || 0
      var offsetY = Number(settings.offsetY) || 0
      host.style.right = left ? "auto" : "min(" + offsetX + "px, 5vw)"
      host.style.left = left ? "min(" + offsetX + "px, 5vw)" : "auto"
      host.style.bottom = "min(" + offsetY + "px, 10vh)"
      frame.style.borderRadius =
        ({ square: 0, small: 8, medium: 16, large: 24 }[settings.radius] || 0) +
        "px"
      frame.style.width =
        "min(400px, calc(100vw - min(" + offsetX * 2 + "px, 10vw) - 8px))"
      frame.style.height =
        "min(680px, calc(100dvh - min(" + offsetY + "px, 10vh) - 84px))"
      button.style.cssText =
        "display:flex;align-items:center;justify-content:center;gap:8px;min-width:56px;min-height:56px;padding:14px;border:0;border-radius:999px;cursor:pointer;box-shadow:0 4px 16px color-mix(in srgb, CanvasText 18%, transparent);"
      button.style.marginLeft = left ? "0" : "auto"
      button.style.marginRight = left ? "auto" : "0"
      button.style.background = launcher.color
      var hex = launcher.color.slice(1)
      var luminance =
        parseInt(hex.slice(0, 2), 16) * 0.299 +
        parseInt(hex.slice(2, 4), 16) * 0.587 +
        parseInt(hex.slice(4, 6), 16) * 0.114
      button.style.color = luminance > 150 ? "#151518" : "#ffffff"
      button.style.fontFamily =
        settings.fontFamily === "serif"
          ? "Georgia,serif"
          : settings.fontFamily === "inter"
            ? "Inter,system-ui,sans-serif"
            : "system-ui,sans-serif"
      button.style.fontSize = settings.fontSize + "px"
      frame.title = dataset.title || settings.displayName + " chat"
      renderLauncher(frame.style.display !== "none")
      ;(document.body || document.documentElement).appendChild(host)
    })
    .catch(function () {
      /* Paused, unavailable or disallowed channels stay hidden. */
    })
  window.DatoolWidget = {
    channelId: channelId,
    open: open,
    close: close,
    toggle: toggle,
    destroy: destroy,
  }
  if (dataset.open === "true" || dataset.open === "1" || wasOpen) open()
})()
