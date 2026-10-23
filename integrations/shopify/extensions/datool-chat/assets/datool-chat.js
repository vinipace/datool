;(() => {
  const mount = document.querySelector("[data-datool-embed]")
  if (
    !mount ||
    window.DatoolWidget ||
    document.querySelector("script[data-datool-shopify]")
  )
    return
  try {
    const base = new URL(mount.dataset.baseUrl)
    const channelId = mount.dataset.channelId
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      !/^[a-f0-9-]{36}$/.test(channelId || "")
    )
      return
    const script = document.createElement("script")
    script.src = new URL("/datool-widget.js", base).href
    script.dataset.baseUrl = base.origin
    script.dataset.channelId = channelId
    script.dataset.shopifyProxy = mount.dataset.shopifyProxy
    script.dataset.datoolShopify = "true"
    script.defer = true
    document.body.appendChild(script)
  } catch {
    /* Invalid public configuration must not interrupt the storefront. */
  }
})()
