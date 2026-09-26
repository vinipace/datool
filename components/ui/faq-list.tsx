import type { ReactNode } from "react"

export function FAQList({
  items,
}: {
  items: { id: string; question: string; content: ReactNode }[]
}) {
  return (
    <div className="divide-y divide-border border-y border-border">
      {items.map((item) => (
        <details key={item.id} id={item.id} className="group py-1">
          <summary className="cursor-pointer rounded-md py-5 pr-3 text-lg font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {item.question}
          </summary>
          <div className="max-w-3xl pb-6 leading-relaxed text-foreground-muted">
            {item.content}
          </div>
        </details>
      ))}
    </div>
  )
}
