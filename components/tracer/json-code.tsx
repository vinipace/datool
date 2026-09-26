import { SyntaxCode } from "@/components/ui/syntax-code"

/** Render tokens as React text nodes, never as injected HTML. */
export function JsonCode({ text }: { text: string }) {
  return <SyntaxCode text={text} language="json" />
}
