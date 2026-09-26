import type { JsonValue } from "./contracts"

/** Only explicit image values are previews; ordinary URL fields remain JSON. */
export function imageValue(
  value: JsonValue
): { url: string; alt: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const image = value.type === "image" ? value : value.image
  if (!image || typeof image !== "object" || Array.isArray(image)) return null
  if (typeof image.url !== "string" || !isImageUrl(image.url)) return null
  return {
    url: image.url,
    alt: typeof image.alt === "string" ? image.alt : "Generated image",
  }
}

export function isImageUrl(value: string): boolean {
  if (
    /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    return true
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password
  } catch {
    return false
  }
}
