import Ajv from "ajv"
// App schemas are independent documents. Revalidating or replacing a manifest
// with the same $id must not collide with a previous app/revision in this process.
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
  addUsedSchema: false,
})
export function validateSchema(
  schema: Record<string, unknown>,
  value: unknown
) {
  const validate = ajv.compile(schema)
  if (!validate(value)) throw new Error(ajv.errorsText(validate.errors))
}
export function checkSchema(schema: Record<string, unknown>) {
  ajv.compile(schema)
}
