import {
  shopifyReturnQuoteSchema,
  shopifyExchangeHoldPlanSchema,
  type ShopifyExchangeHoldPlan,
  type ShopifyReturnQuote,
} from "@/src/lib/build/shopify-return"
import { sql } from "drizzle-orm"
import type { BuildContext } from "../context"
import { TracerError } from "@/src/server/tracer/errors"
import {
  shopifyOrderQuoteSchema,
  type ShopifyOrderQuote,
} from "@/src/lib/build/shopify-order"
import {
  shopifyActionSettingsSchema,
  type ShopifyActionSettings,
} from "@/src/lib/build/shopify"
import type { ShopifyShopper } from "./shopify-identity"
import { ShopifyWriteUncertainError } from "./shopify-mutation"

export type ShopifyOrderOperation = {
  id: string
  status:
    | "pending"
    | "draft"
    | "checkout_ready"
    | "placed"
    | "uncertain"
    | "needs_review"
    | "failed"
  draftOrderId: string | null
  orderId: string | null
  quote: ShopifyOrderQuote
  settings: ShopifyActionSettings
  updatedAt: Date
  revision: number
}

export type ShopifyReturnOperation = {
  id: string
  status:
    | "pending"
    | "return_created"
    | "processing"
    | "return_processed"
    | "uncertain"
    | "needs_review"
    | "failed"
  returnId: string | null
  processingStarted: boolean
  holdPlan: ShopifyExchangeHoldPlan | null
  quote: ShopifyReturnQuote
  settings: ShopifyActionSettings
  updatedAt: Date
  revision: number
}

const unresolvedMessage =
  "The previous order's outcome is unresolved. Use Check checkout to recover its status before creating another order."

/** Commerce state is owned by the verified conversation, never a model-supplied shop or customer ID. */
export class ShopifyOperationStore {
  constructor(
    private context: BuildContext,
    private connectionId: string,
    private conversationId: string,
    private shopper: ShopifyShopper
  ) {}

  private scope() {
    return sql`project_id=${this.context.projectId} AND connection_id=${this.connectionId}::uuid
      AND conversation_id=${this.conversationId}`
  }

  async assertNoUnresolved() {
    const result = await this.context.database.execute(sql`
      SELECT 1 FROM build_shopify_order_operations WHERE ${this.scope()} AND kind='order'
      AND status IN ('pending','draft','uncertain','needs_review') LIMIT 1
    `)
    if (result.rows.length)
      throw new TracerError("VALIDATION_ERROR", unresolvedMessage)
  }

  async begin(quote: ShopifyOrderQuote, settings: ShopifyActionSettings) {
    if (quote.customerId !== this.shopper.customerId)
      throw new TracerError(
        "VALIDATION_ERROR",
        "Your customer account changed. Review the order again."
      )
    await this.context.database.transaction(async (tx) => {
      // Serialize admissions only. Never hold this transaction while calling Shopify.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shopify-order:${this.context.projectId}:${this.connectionId}:${this.conversationId}`},0))`
      )
      const previous = await tx.execute(sql`
        SELECT 1 FROM build_shopify_order_operations WHERE ${this.scope()} AND kind='order'
        AND (id=${quote.operationId}::uuid OR status IN ('pending','draft','uncertain','needs_review')) LIMIT 1
      `)
      if (previous.rows.length)
        throw new TracerError("VALIDATION_ERROR", unresolvedMessage)
      await tx.execute(sql`
        INSERT INTO build_shopify_order_operations(id,project_id,connection_id,conversation_id,customer_id,browser_session_id,quote_json,settings_json,status)
        VALUES(${quote.operationId}::uuid,${this.context.projectId},${this.connectionId}::uuid,${this.conversationId},${this.shopper.customerId},${this.shopper.browserSessionId}::uuid,${JSON.stringify(quote)}::jsonb,${JSON.stringify(settings)}::jsonb,'pending')
      `)
    })
  }

  async beginReturn(
    quote: ShopifyReturnQuote,
    settings: ShopifyActionSettings
  ) {
    if (quote.customerId !== this.shopper.customerId)
      throw new TracerError(
        "VALIDATION_ERROR",
        "Your customer account changed. Review the return again."
      )
    await this.context.database.transaction(async (tx) => {
      // A shopper can open several conversations. Serialize returns for the order,
      // not just the conversation, so they cannot spend the same return credit twice.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shopify-return:${this.context.projectId}:${this.connectionId}:${quote.input.orderId}`},0))`
      )
      const previous = await tx.execute(sql`
        SELECT 1 FROM build_shopify_order_operations
        WHERE project_id=${this.context.projectId} AND connection_id=${this.connectionId}::uuid
        AND kind='return' AND source_order_id=${quote.input.orderId}
        AND (id=${quote.operationId}::uuid OR status IN ('pending','return_created','processing','uncertain','needs_review')) LIMIT 1
      `)
      if (previous.rows.length)
        throw new TracerError(
          "VALIDATION_ERROR",
          "A return for this order is still being processed or needs review. Use Check return to recover its status before requesting another."
        )
      await tx.execute(sql`
        INSERT INTO build_shopify_order_operations(id,project_id,connection_id,conversation_id,customer_id,browser_session_id,quote_json,settings_json,status,kind,source_order_id,return_process_started)
        VALUES(${quote.operationId}::uuid,${this.context.projectId},${this.connectionId}::uuid,${this.conversationId},${this.shopper.customerId},${this.shopper.browserSessionId}::uuid,${JSON.stringify(quote)}::jsonb,${JSON.stringify(settings)}::jsonb,'pending','return',${quote.input.orderId},false)
      `)
    })
  }

  async recordReturn(id: string, returnId: string) {
    const saved = await this.context.database.execute(sql`
      UPDATE build_shopify_order_operations SET return_id=${returnId},status='return_created',reconcile_after=now(),updated_at=now(),revision=revision+1
      WHERE ${this.scope()} AND id=${id}::uuid AND kind='return' AND status='pending' RETURNING id
    `)
    if (!saved.rows.length) throw new ShopifyWriteUncertainError()
  }

  async claimReturnProcessing(quote: ShopifyReturnQuote) {
    const saved = await this.context.database.execute(sql`
      UPDATE build_shopify_order_operations SET status='processing',return_process_started=true,reconcile_after=now(),
        quote_json=${JSON.stringify(quote)}::jsonb,updated_at=now(),revision=revision+1
      WHERE ${this.scope()} AND id=${quote.operationId}::uuid AND kind='return' AND NOT return_process_started
        ${
          quote.resume
            ? sql`AND revision=${quote.resume.revision} AND return_id=${quote.resume.returnId}
            AND status IN ('return_created','uncertain','needs_review')`
            : sql`AND status='return_created' AND quote_json->>'fingerprint'=${quote.fingerprint}`
        }
      RETURNING id
    `)
    if (!saved.rows.length)
      throw new TracerError(
        "VALIDATION_ERROR",
        "This return changed or processing already started. Use Check return before continuing."
      )
  }

  async finishReturn<T extends { status: "return_processed" | "needs_review" }>(
    id: string,
    result: T & { returnId?: string },
    expectedRevision?: number
  ) {
    const saved = await this.context.database.execute(sql`
      UPDATE build_shopify_order_operations SET status=${result.status},result_json=${JSON.stringify(result)}::jsonb,
        return_id=COALESCE(${result.returnId ?? null},return_id),updated_at=now(),revision=revision+1
        ${expectedRevision === undefined ? sql`,reconcile_after=now()` : sql``}
      WHERE ${this.scope()} AND id=${id}::uuid AND kind='return'
      ${
        expectedRevision === undefined
          ? sql`AND status IN ('return_created','processing')`
          : sql`AND revision=${expectedRevision} AND status <> 'failed'
          AND (status <> 'return_processed' OR ${result.status}='return_processed')`
      }
      RETURNING id
    `)
    if (!saved.rows.length) {
      if (expectedRevision !== undefined)
        throw new TracerError(
          "VALIDATION_ERROR",
          "The return changed while checking it. Check return again for its current status."
        )
      throw new ShopifyWriteUncertainError()
    }
    return { ...result, operationId: id }
  }

  async readReturn(id?: string): Promise<ShopifyReturnOperation | null> {
    const result = await this.context.database.execute<{
      id: string
      status: ShopifyReturnOperation["status"]
      return_id: string | null
      return_process_started: boolean
      return_hold_plan: unknown
      quote_json: unknown
      settings_json: unknown
      updated_at: Date
      revision: number
    }>(sql`
      SELECT * FROM build_shopify_order_operations WHERE ${this.scope()} AND kind='return'
        AND customer_id IS NOT DISTINCT FROM ${this.shopper.customerId}
        AND (${this.shopper.customerId !== null} OR browser_session_id IS NOT DISTINCT FROM ${this.shopper.browserSessionId}::uuid)
        ${id ? sql`AND id=${id}::uuid` : sql``}
      ORDER BY created_at DESC,id DESC LIMIT 1
    `)
    const row = result.rows[0]
    return row
      ? {
          id: row.id,
          status: row.status,
          returnId: row.return_id,
          processingStarted: row.return_process_started,
          holdPlan:
            row.return_hold_plan === null
              ? null
              : shopifyExchangeHoldPlanSchema.parse(row.return_hold_plan),
          quote: shopifyReturnQuoteSchema.parse(row.quote_json),
          settings: shopifyActionSettingsSchema.parse(row.settings_json),
          updatedAt: new Date(row.updated_at),
          revision: row.revision,
        }
      : null
  }

  async recordReturnHolds(
    operation: ShopifyReturnOperation,
    plan: ShopifyExchangeHoldPlan
  ) {
    const saved = await this.context.database.execute(sql`
      UPDATE build_shopify_order_operations SET return_hold_plan=${JSON.stringify(plan)}::jsonb,revision=revision+1
      WHERE ${this.scope()} AND kind='return' AND id=${operation.id}::uuid
        AND return_id=${plan.returnId} AND revision=${operation.revision} AND return_hold_plan IS NULL
      RETURNING id
    `)
    if (!saved.rows.length)
      throw new TracerError(
        "VALIDATION_ERROR",
        "The exchange changed while recording its payment holds. Check return again."
      )
  }

  async recordDraft(id: string, draftOrderId: string) {
    const result = await this.context.database.execute(sql`
      UPDATE build_shopify_order_operations SET draft_order_id=${draftOrderId},status='draft',reconcile_after=now(),updated_at=now(),revision=revision+1
      WHERE ${this.scope()} AND id=${id}::uuid AND kind='order' AND status='pending' RETURNING id
    `)
    if (!result.rows.length) throw new ShopifyWriteUncertainError()
  }

  async finish<
    T extends {
      status:
        "checkout_ready" | "order_created" | "order_cancelled" | "needs_review"
      draftOrderId?: string
      orderId?: string
    },
  >(id: string, result: T, expectedRevision?: number) {
    let status: ShopifyOrderOperation["status"] = "needs_review"
    if (result.status === "checkout_ready") status = "checkout_ready"
    if (
      result.status === "order_created" ||
      result.status === "order_cancelled"
    )
      status = "placed"
    const saved = await this.context.database.execute(sql`
      UPDATE build_shopify_order_operations SET status=${status},result_json=${JSON.stringify(result)}::jsonb,
        draft_order_id=COALESCE(${result.draftOrderId ?? null},draft_order_id),order_id=COALESCE(${result.orderId ?? null},order_id),updated_at=now(),revision=revision+1
        ${expectedRevision === undefined ? sql`,reconcile_after=now()` : sql``}
      WHERE ${this.scope()} AND id=${id}::uuid AND kind='order'
        AND (status <> 'placed' OR ${status}='placed')
        ${expectedRevision === undefined ? sql`` : sql`AND revision=${expectedRevision}`}
      RETURNING id
    `)
    if (!saved.rows.length) {
      if (expectedRevision !== undefined)
        throw new TracerError(
          "VALIDATION_ERROR",
          "The checkout changed while checking it. Check checkout again for its current status."
        )
      throw new ShopifyWriteUncertainError()
    }
    return { ...result, operationId: id }
  }

  async fail(id: string, uncertain: boolean) {
    await this.context.database.execute(sql`
      UPDATE build_shopify_order_operations SET status=CASE WHEN ${uncertain} OR draft_order_id IS NOT NULL OR return_id IS NOT NULL THEN 'uncertain' ELSE 'failed' END,updated_at=now(),revision=revision+1
      WHERE ${this.scope()} AND id=${id}::uuid AND status IN ('pending','draft','return_created','processing')
    `)
  }

  async read(id?: string): Promise<ShopifyOrderOperation | null> {
    const result = await this.context.database.execute<{
      id: string
      status: ShopifyOrderOperation["status"]
      draft_order_id: string | null
      order_id: string | null
      quote_json: unknown
      settings_json: unknown
      updated_at: Date
      revision: number
    }>(sql`
      SELECT * FROM build_shopify_order_operations WHERE ${this.scope()} AND kind='order'
        AND customer_id IS NOT DISTINCT FROM ${this.shopper.customerId}
        AND (${this.shopper.customerId !== null} OR browser_session_id IS NOT DISTINCT FROM ${this.shopper.browserSessionId}::uuid)
        ${id ? sql`AND id=${id}::uuid` : sql``}
      ORDER BY created_at DESC,id DESC LIMIT 1
    `)
    const row = result.rows[0]
    return row
      ? {
          id: row.id,
          status: row.status,
          draftOrderId: row.draft_order_id,
          orderId: row.order_id,
          quote: shopifyOrderQuoteSchema.parse(row.quote_json),
          settings: shopifyActionSettingsSchema.parse(row.settings_json),
          updatedAt: new Date(row.updated_at),
          revision: row.revision,
        }
      : null
  }
}
