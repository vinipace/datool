import { z } from "zod"
import type { IntegrationTool } from "@/src/lib/build/integrations"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"
import { requireShopifyCustomer, type ShopifyShopper } from "./shopify-identity"
import { shopifyMutation, ShopifyWriteUncertainError } from "./shopify-mutation"

const profileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    email: z.email().max(254).optional(),
    phone: z
      .string()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .nullable()
      .optional(),
  })
  .strict()
export const shopifyAddressSchema = z
  .object({
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    address1: z.string().trim().min(1).max(200),
    address2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    provinceCode: z.string().trim().max(10).optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    zip: z.string().trim().max(20).optional(),
    phone: z
      .string()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .optional(),
  })
  .strict()
const activationSchema = z.object({ email: z.email().max(254) }).strict()

export const CUSTOMER_UPDATE = `#graphql
  mutation DatoolUpdateCustomer($input: CustomerInput!) {
    customerUpdate(input: $input) { customer { id } userErrors { field message } }
  }
`
export const CUSTOMER_DEFAULT_ADDRESS = `#graphql
  query DatoolDefaultAddress($id: ID!) {
    customer(id: $id) { id defaultAddress { id } }
  }
`
export const ADDRESS_UPDATE = `#graphql
  mutation DatoolUpdateAddress($customerId: ID!, $addressId: ID!, $address: MailingAddressInput!) {
    customerAddressUpdate(customerId: $customerId, addressId: $addressId, address: $address, setAsDefault: true) {
      address { id } userErrors { field message }
    }
  }
`
export const ADDRESS_CREATE = `#graphql
  mutation DatoolCreateAddress($customerId: ID!, $address: MailingAddressInput!) {
    customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: true) {
      address { id } userErrors { field message }
    }
  }
`
export const ACCOUNT_SETTINGS = `#graphql
  query DatoolAccountSettings {
    shop { customerAccounts customerAccountsV2 { customerAccountsVersion url } primaryDomain { url } }
  }
`
export const ACCOUNT_LOOKUP = `#graphql
  query DatoolAccountLookup($query: String!) {
    customers(first: 2, query: $query) { nodes { id defaultEmailAddress { emailAddress } state } }
  }
`
export const ACCOUNT_INVITE = `#graphql
  mutation DatoolActivateAccount($customerId: ID!) {
    customerSendAccountInviteEmail(customerId: $customerId) { customer { id } userErrors { field message } }
  }
`

export async function runShopifyCustomerTool(
  slug: string,
  input: Record<string, unknown>,
  shopper: ShopifyShopper,
  graphql: ShopifyGraphqlClient,
  beforeWrite: () => Promise<void>,
  claimInvitation: (email: string) => Promise<boolean>
) {
  if (slug === "SHOPIFY_UPDATE_PROFILE") {
    const args = profileSchema.parse(input)
    if (!Object.keys(args).length)
      throw new Error("Provide at least one profile field to update.")
    const id = requireShopifyCustomer(shopper)
    const result = await shopifyMutation<{
      customer: { id: string } | null
    }>(
      graphql,
      CUSTOMER_UPDATE,
      { input: { ...args, id } },
      "customerUpdate",
      beforeWrite
    )
    if (result.customer?.id !== id) throw new ShopifyWriteUncertainError()
    return {
      status: "updated",
      message: "Your account profile has been updated.",
    }
  }
  if (slug === "SHOPIFY_UPDATE_ADDRESS") {
    const address = shopifyAddressSchema.parse(input)
    const customerId = requireShopifyCustomer(shopper)
    const data = await shopifyData<{
      customer: { id: string; defaultAddress: { id: string } | null } | null
    }>(graphql, CUSTOMER_DEFAULT_ADDRESS, { id: customerId })
    if (data.customer?.id !== customerId)
      throw new Error("Your customer account could not be verified.")
    const addressId = data.customer.defaultAddress?.id
    const result = await shopifyMutation<{
      address: { id: string } | null
    }>(
      graphql,
      addressId ? ADDRESS_UPDATE : ADDRESS_CREATE,
      { customerId, address, ...(addressId ? { addressId } : {}) },
      addressId ? "customerAddressUpdate" : "customerAddressCreate",
      beforeWrite
    )
    if (!result.address) throw new ShopifyWriteUncertainError()
    return {
      status: "updated",
      message:
        "Your default account address has been updated. Existing orders keep their original delivery addresses.",
    }
  }
  if (slug === "SHOPIFY_ACTIVATE_ACCOUNT") {
    const { email } = activationSchema.parse(input)
    const data = await shopifyData<{
      shop: {
        customerAccounts: string
        customerAccountsV2: {
          customerAccountsVersion: string
          url: string | null
        }
        primaryDomain: { url: string }
      }
    }>(graphql, ACCOUNT_SETTINGS)
    const loginUrl = new URL("/account/login", data.shop.primaryDomain.url).href
    if (data.shop.customerAccounts === "DISABLED")
      return {
        status: "unavailable",
        message:
          "This store has disabled customer accounts. Contact the store for help.",
      }
    if (data.shop.customerAccountsV2.customerAccountsVersion !== "CLASSIC")
      return {
        status: "sign_in",
        url: loginUrl,
        message:
          "Use the store's sign-in page. New Shopify accounts use a verification code rather than an activation email.",
      }
    const result = await shopifyData<{
      customers: {
        nodes: Array<{
          id: string
          defaultEmailAddress: { emailAddress: string } | null
          state: string
        }>
      }
    }>(graphql, ACCOUNT_LOOKUP, { query: `email:${JSON.stringify(email)}` })
    const customer = result.customers.nodes.find(
      (item) =>
        item.defaultEmailAddress?.emailAddress.toLowerCase() ===
        email.toLowerCase()
    )
    if (
      customer &&
      (customer.state === "DISABLED" || customer.state === "INVITED") &&
      (await claimInvitation(email))
    )
      await shopifyMutation(
        graphql,
        ACCOUNT_INVITE,
        { customerId: customer.id },
        "customerSendAccountInviteEmail",
        beforeWrite
      )
    // Same response for missing, enabled and invited accounts avoids account enumeration.
    return {
      status: "requested",
      url: loginUrl,
      message:
        "If this email belongs to an account awaiting activation, Shopify will send an invitation. Otherwise use the store's sign-in page.",
    }
  }
  throw new Error("Unknown Shopify customer action.")
}

export const shopifyCustomerTools: IntegrationTool[] = [
  {
    slug: "SHOPIFY_UPDATE_PROFILE",
    name: "Update customer profile",
    description:
      "Update the signed-in customer's own name, email or phone after their confirmation. Never accepts a customer ID. Phone numbers use international format; null removes the account phone.",
    inputSchema: z.toJSONSchema(profileSchema),
  },
  {
    slug: "SHOPIFY_UPDATE_ADDRESS",
    name: "Update account address",
    description:
      "Update the signed-in customer's default account address after confirmation. This does not change delivery addresses on existing orders.",
    inputSchema: z.toJSONSchema(shopifyAddressSchema),
  },
  {
    slug: "SHOPIFY_ACTIVATE_ACCOUNT",
    name: "Activate customer account",
    description:
      "Request a legacy account activation email after confirmation, or provide sign-in guidance for new customer accounts. Does not disclose whether an email belongs to an existing customer.",
    inputSchema: z.toJSONSchema(activationSchema),
  },
]
