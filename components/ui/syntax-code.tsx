import * as React from "react"
import Prism from "prismjs"
import "prismjs/components/prism-json"
import "prismjs/components/prism-yaml"
import { cn } from "@/lib/utils"

// Presentation grammar also highlights incomplete filter suggestions.
const filterGrammar: Prism.Grammar = {
  string: { pattern: /(["'])(?:\\[\s\S]|(?!\1)[^\\])*\1/, greedy: true },
  operator: [
    /!=|<=|>=|[=<>:]/,
    { pattern: /(\s)contains(?=\s|$)/, lookbehind: true },
  ],
  number: /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/i,
  boolean: /\b(?:true|false|null)\b/,
  property: /[a-zA-Z_$][\w$-]*/,
  punctuation: /\./,
}

function renderTokens(tokens: (string | Prism.Token)[]): React.ReactNode {
  return tokens.map((token, index) =>
    typeof token === "string" ? (
      token
    ) : (
      <span
        key={index}
        className={["token", token.type, ...[token.alias ?? []].flat()].join(
          " "
        )}
      >
        {typeof token.content === "string"
          ? token.content
          : renderTokens(
              Array.isArray(token.content) ? token.content : [token.content]
            )}
      </span>
    )
  )
}

/** Tokenize structured values without injecting captured content as HTML. */
export function SyntaxCode({
  text,
  language,
  className,
}: {
  text: string
  language: "json" | "yaml" | "filter" | "javascript"
  className?: string
}) {
  return (
    <code
      className={cn("syntax-code font-mono whitespace-pre-wrap", className)}
      data-language={language}
    >
      {renderTokens(
        Prism.tokenize(
          text,
          language === "filter" ? filterGrammar : Prism.languages[language]
        )
      )}
    </code>
  )
}
