"use client"

import * as React from "react"
import Image from "next/image"
import {
  shopifyProductsSchema,
  shopifyProductSelectionSchema,
  type ShopifyProducts,
} from "@/src/lib/build/shopify-products"
import { Button } from "./button"
import { Input } from "./input"
import { Select } from "./select"
import { ChatLink } from "./chat-navigation"

type SelectionHandler = (
  interaction: Record<string, unknown>,
  label: string
) => void

function ProductCard({
  product,
  currency,
  onSelect,
  completed,
}: {
  product: ShopifyProducts["products"][number]
  currency: string
  onSelect?: SelectionHandler
  completed: boolean
}) {
  const id = React.useId()
  const [variantId, setVariantId] = React.useState(
    product.variants.find((variant) => variant.availableForSale)
      ?.cartVariantId ?? ""
  )
  const [quantity, setQuantity] = React.useState("1")
  const selected = product.variants.find(
    (variant) => variant.cartVariantId === variantId
  )
  const selection = shopifyProductSelectionSchema.safeParse({
    variantId,
    quantity: Number(quantity),
  })
  const price = (value: string) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      Number(value)
    )
  const link = new URL(product.url)
  if (variantId) link.searchParams.set("variant", variantId)
  return (
    <section
      aria-label={product.title}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-background p-3 text-foreground"
    >
      {product.imageUrl ? (
        <Image
          unoptimized
          src={product.imageUrl}
          alt={product.imageAlt}
          width={400}
          height={300}
          className="aspect-[4/3] w-full rounded-md object-contain"
        />
      ) : null}
      <div>
        <h3 className="text-sm font-medium">
          <ChatLink href={link.href}>{product.title}</ChatLink>
        </h3>
        {selected ? (
          <p className="mt-1 text-sm tabular-nums">{price(selected.price)}</p>
        ) : product.priceMin ? (
          <p className="mt-1 text-sm tabular-nums">
            From {price(product.priceMin)}
          </p>
        ) : null}
      </div>
      {product.variants.length ? (
        <div className="space-y-1">
          <label
            htmlFor={`${id}-variant`}
            className="text-xs text-foreground-muted"
          >
            Options
          </label>
          <Select
            id={`${id}-variant`}
            value={variantId}
            onChange={(event) => setVariantId(event.target.value)}
          >
            {!selected ? (
              <option value="">Choose an available option</option>
            ) : null}
            {product.variants.map((variant) => (
              <option
                key={variant.id}
                value={variant.cartVariantId ?? ""}
                disabled={!variant.availableForSale || !variant.cartVariantId}
              >
                {variant.title} · {price(variant.price)}
                {variant.availableForSale ? "" : " · Sold out"}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {!selected?.availableForSale ? (
        <p className="text-xs text-foreground-muted">
          {product.optionsTruncated
            ? "Check the store for more available options."
            : "Currently unavailable."}
        </p>
      ) : null}
      {product.cartInteraction ? (
        <div className="mt-auto flex items-end gap-2">
          <div className="w-20 space-y-1">
            <label
              htmlFor={`${id}-quantity`}
              className="text-xs text-foreground-muted"
            >
              Quantity
            </label>
            <Input
              id={`${id}-quantity`}
              type="number"
              min={1}
              max={99}
              step={1}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              disabled={completed}
            />
          </div>
          <Button
            type="button"
            className="min-w-0 flex-1"
            disabled={
              !onSelect ||
              completed ||
              !selected?.availableForSale ||
              !selection.success
            }
            onClick={() => {
              if (selection.success && product.cartInteraction)
                onSelect?.(
                  { ...product.cartInteraction, input: selection.data },
                  `Add ${selection.data.quantity} × ${product.title} (${selected?.title})`
                )
            }}
          >
            {completed ? "Selection sent" : "Add to cart"}
          </Button>
        </div>
      ) : null}
      <ChatLink
        href={link.href}
        className="text-xs underline underline-offset-2"
      >
        {product.optionsTruncated
          ? "See all options in the store"
          : "View product"}
      </ChatLink>
    </section>
  )
}

/** Catalog data comes from the saved tool result, not model-generated product markup. */
export function ShopifyProductsView({
  value,
  onSelect,
  completedContinuationIds,
}: {
  value: unknown
  onSelect?: SelectionHandler
  completedContinuationIds?: ReadonlySet<string>
}) {
  const parsed = shopifyProductsSchema.safeParse(value)
  if (!parsed.success) return null
  const catalog = parsed.data
  return (
    <section aria-label="Products" className="mt-2 min-w-0 space-y-3">
      <h2 className="text-sm font-medium">Products</h2>
      <p className="text-xs text-foreground-muted">{catalog.pricing}</p>
      {catalog.products.length ? (
        <div className="grid min-w-0 grid-cols-1 gap-3 @min-[28rem]/chat:grid-cols-2">
          {catalog.products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              currency={catalog.currency}
              onSelect={onSelect}
              completed={Boolean(
                product.cartInteraction &&
                completedContinuationIds?.has(
                  product.cartInteraction.continuationId
                )
              )}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-foreground-muted">
          No matching products on this page.
        </p>
      )}
      {catalog.nextCursor ? (
        <p className="text-xs text-foreground-muted">
          Ask the assistant to show more results.
        </p>
      ) : null}
    </section>
  )
}
