`schema-2022-10-07.json` is the unmodified official OpenAPI 3.1 document schema:
https://spec.openapis.org/oas/3.1/schema/2022-10-07

The tests validate document structure and compile every generated input schema
using JSON Schema 2020-12. They also resolve all local references, including
recursive JSON values. The test binds the document schema's dynamic dialect
extension point to its default subschema because Ajv does not support that nested
dynamic anchor. This does not change the expected document structure.
