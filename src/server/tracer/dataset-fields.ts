import {
  assertDatasetItemSchemas,
  assertDatasetSchemas,
} from "@/src/lib/tracer/dataset-schemas"
import type { DatasetFieldSchemas } from "@/src/lib/tracer/contracts"
import { validation } from "./errors"

export function validateDatasetSchemas(schemas: DatasetFieldSchemas) {
  try {
    assertDatasetSchemas(schemas)
  } catch (error) {
    throw validation(
      error instanceof Error ? error.message : "Invalid dataset schemas."
    )
  }
}

export function validateDatasetItem(
  schemasJson: string,
  item: Parameters<typeof assertDatasetItemSchemas>[1]
) {
  try {
    assertDatasetItemSchemas(JSON.parse(schemasJson), item)
  } catch (error) {
    throw validation(
      error instanceof Error
        ? error.message
        : "Dataset row does not match its schemas."
    )
  }
}
