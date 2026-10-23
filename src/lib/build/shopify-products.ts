import { z } from "zod"
import { isSafeHttpUrl } from "./urls"

const url = z
  .string()
  .max(2048)
  .refine((value) => isSafeHttpUrl(value) && value.startsWith("https://"))
export const shopifyProductSearchSchema = z
  .object({
    query: z.string().max(160),
    productType: z.string().trim().min(1).max(80).optional(),
    vendor: z.string().trim().min(1).max(80).optional(),
    minPrice: z.number().min(0).max(1_000_000_000).optional(),
    maxPrice: z.number().min(0).max(1_000_000_000).optional(),
    inStockOnly: z.boolean().optional(),
    after: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minPrice === undefined ||
      value.maxPrice === undefined ||
      value.minPrice <= value.maxPrice,
    "Minimum price cannot exceed maximum price."
  )

export const shopifyProductsSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  pricing: z.string().max(300),
  nextCursor: z.string().max(2048).nullable(),
  products: z
    .array(
      z.object({
        id: z.string().regex(/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/),
        title: z.string().max(300),
        description: z.string().max(2000),
        imageUrl: url.nullable(),
        imageAlt: z.string().max(300),
        priceMin: z.string().nullable(),
        priceMax: z.string().nullable(),
        url,
        optionsTruncated: z.boolean(),
        variants: z
          .array(
            z.object({
              id: z.string(),
              cartVariantId: z
                .string()
                .regex(/^[1-9][0-9]{0,15}$/)
                .nullable(),
              title: z.string().max(300),
              price: z.string().regex(/^\d+(?:\.\d+)?$/),
              availableForSale: z.boolean(),
            })
          )
          .max(100),
        cartInteraction: z
          .object({ actionId: z.string(), continuationId: z.string() })
          .optional(),
      })
    )
    .max(8),
})
export type ShopifyProducts = z.infer<typeof shopifyProductsSchema>
export const shopifyProductSelectionSchema = z
  .object({
    variantId: z.string().regex(/^[1-9][0-9]{0,15}$/),
    quantity: z.number().int().min(1).max(99),
  })
  .strict()
