import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import { isSafeHttpUrl } from "@/src/lib/build/urls"

type Node = {
  type: string
  value?: string
  url?: string
  identifier?: string
  alt?: string
  ordered?: boolean
  start?: number | null
  children?: Node[]
}
const parser = unified().use(remarkParse).use(remarkGfm)

/** Render Markdown as WhatsApp text, preserving code and links as separate blocks. */
export function whatsappText(
  text: string,
  link: (url: string, label: string) => string = (url) => url
) {
  const root = parser.parse(text) as Node
  const definitions = new Map<string, string>()
  const collect = (node: Node) => {
    if (node.type === "definition" && node.identifier && node.url)
      definitions.set(node.identifier.toLowerCase(), node.url)
    node.children?.forEach(collect)
  }
  collect(root)
  function render(node: Node, links?: string[]): string {
    const children = () =>
      (node.children ?? []).map((child) => render(child, links)).join("")
    switch (node.type) {
      case "root":
        return (node.children ?? [])
          .map((child) => render(child))
          .filter(Boolean)
          .join("\n\n")
      case "paragraph": {
        const urls: string[] = []
        const body = (node.children ?? [])
          .map((child) => render(child, urls))
          .join("")
          .replace(/\n([.,;!?])(?=\s|$)/g, "$1\n")
          .split("\n")
          .map((line) => line.trim())
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
        return [body, ...new Set(urls)].filter(Boolean).join("\n")
      }
      case "text":
        return node.value ?? ""
      case "strong":
      case "heading":
        return `*${children()}*`
      case "emphasis":
        // Single-asterisk emphasis is also the native WhatsApp bold syntax.
        return `*${children()}*`
      case "delete":
        return `~${children()}~`
      case "inlineCode":
        return `\`${node.value ?? ""}\``
      case "code":
        return `\`\`\`\n${node.value ?? ""}\n\`\`\``
      case "break":
        return "\n"
      case "blockquote":
        return (node.children ?? [])
          .map((child) => render(child))
          .join("\n")
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")
      case "list":
        return (node.children ?? [])
          .map(
            (item, i) =>
              `${node.ordered ? `${(node.start ?? 1) + i}.` : "•"} ${render(item)}`
          )
          .join("\n\n")
      case "listItem":
        return (node.children ?? []).map((child) => render(child)).join("\n")
      case "link":
      case "linkReference":
      case "image":
      case "imageReference": {
        const label = node.type.startsWith("image")
          ? (node.alt ?? "")
          : children()
        const url =
          node.url ?? definitions.get((node.identifier ?? "").toLowerCase())
        if (!url || !isSafeHttpUrl(url)) return label
        const destination = link(url, label)
        if (links) {
          if (label === url) return `\n${destination}\n`
          links.push(destination)
          return label
        }
        return label && label !== url ? `${label}\n${destination}` : destination
      }
      case "table":
        return (node.children ?? [])
          .map((row) =>
            (row.children ?? []).map((child) => render(child)).join(" — ")
          )
          .join("\n")
      case "tableCell":
        return children()
      case "thematicBreak":
        return ""
      case "definition":
      case "html":
        return ""
      default:
        return children()
    }
  }
  return render(root).trim()
}
