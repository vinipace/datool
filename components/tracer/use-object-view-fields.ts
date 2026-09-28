"use client"
import { useEffect, useMemo, useState } from "react"
import type { ComputedColumn } from "@/src/lib/tracer/computed-columns"
import { fieldRow } from "@/src/lib/tracer/field-row"
import type { ObjectViewInput } from "@/src/lib/tracer/object-views"
import { callViewOperation } from "./view-library-client"
import { useColumnValues } from "./use-computed-columns"

export function useObjectViewFields(projectId: string, refs: { id: string; revision?: number }[], input: ObjectViewInput) {
  const key = projectId + JSON.stringify(refs)
  const [resolved, setResolved] = useState<{ key: string; fields: ComputedColumn[]; errors: Record<string,string> }>({ key: "", fields: [], errors: {} })
  useEffect(() => {
    const controller = new AbortController()
    const references = JSON.parse(key.slice(projectId.length)) as typeof refs
    void Promise.all(references.map(async ref => {
      try { return { id: ref.id, field: await callViewOperation<ComputedColumn>(projectId, "get_custom_field", ref, controller.signal) } }
      catch (error) { return { id: ref.id, error: String(error) } }
    })).then(results => {
      if (!controller.signal.aborted) setResolved({ key, fields: results.flatMap(result => result.field ? [result.field] : []), errors: Object.fromEntries(results.flatMap(result => result.error ? [[result.id, result.error]] : [])) })
    })
    return () => controller.abort()
  }, [key, projectId])
  const fields = useMemo(() => resolved.key === key ? resolved.fields : [], [resolved, key])
  const rows = useMemo(() => [fieldRow(input.kind, input.object)], [input.kind, input.object])
  const cells = useColumnValues(rows, fields)
  const loading = refs.length > 0 && (resolved.key !== key || fields.some(field => !cells[field.id]?.[rows[0].id]))
  return {
    loading,
    input: useMemo<ObjectViewInput>(() => {
      const values = Object.fromEntries(fields.map(field => [field.id, cells[field.id]?.[rows[0].id]?.value ?? null]))
      const fieldContext = { fieldRevisions: Object.fromEntries(fields.map(field => [field.id, field.revision])), fieldErrors: { ...resolved.errors, ...Object.fromEntries(fields.flatMap(field => {
        const error = cells[field.id]?.[rows[0].id]?.error
        return error ? [[field.id,error]] : []
      })) } }
      if (input.kind === "trace") return { ...input, fields: values, context: { ...input.context, ...fieldContext } }
      return { ...input, fields: values, context: { ...input.context, ...fieldContext } }
    }, [input, fields, cells, rows, resolved.errors]),
  }
}
