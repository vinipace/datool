"use client"

import { shopifyCartSchema } from "@/src/lib/build/shopify-cart"
import { Button } from "./button"
import { ChatLink } from "./chat-navigation"

/** A cart snapshot is useful in both the customer chat and the read-only Inbox transcript. */
export function ShopifyCartView({ value }: { value: unknown }) {
  const parsed = shopifyCartSchema.safeParse(value)
  if (!parsed.success) return null
  const cart = parsed.data
  const amount = (value: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: cart.currency,
    }).format(value / 100)
  return (
    <section
      aria-label="Shopping cart"
      className="mt-2 w-full min-w-0 rounded-lg border border-border bg-background p-3 text-foreground"
    >
      <h2 className="text-sm font-medium">
        Your cart · {cart.itemCount} items
      </h2>
      {cart.items.length ? (
        <ul className="mt-2 divide-y divide-border">
          {cart.items.map((item) => (
            <li
              key={item.lineKey}
              className="flex items-start justify-between gap-3 py-2 text-sm"
            >
              <div className="min-w-0 break-words">
                <ChatLink href={item.url}>{item.title}</ChatLink>
                <p className="text-xs text-foreground-muted">
                  Quantity: {item.quantity}
                </p>
              </div>
              <span className="shrink-0 tabular-nums">
                {amount(item.finalLinePrice)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-3 text-sm text-foreground-muted">
          Your cart is empty.
        </p>
      )}
      {cart.truncated ? (
        <p className="text-xs text-foreground-muted">
          Open the store cart to see all items.
        </p>
      ) : null}
      <p className="flex justify-between gap-3 border-t border-border pt-2 text-sm font-medium">
        <span>Subtotal</span>
        <span className="tabular-nums">{amount(cart.totalPrice)}</span>
      </p>
      <p className="mt-1 text-xs text-foreground-muted">
        Shipping and taxes are confirmed at checkout.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" asChild>
          <ChatLink href={cart.cartUrl}>Edit cart</ChatLink>
        </Button>
        {cart.itemCount ? (
          <Button size="sm" asChild>
            <ChatLink href={cart.checkoutUrl}>Checkout</ChatLink>
          </Button>
        ) : null}
      </div>
    </section>
  )
}
