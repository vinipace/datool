# Custom fields

Custom fields and custom columns are the same resource. Definitions are stored in Datool's PostgreSQL `custom_fields` registry and are available across traces, evals, playgrounds, and browsers using that Datool server. Each table keeps its selection and ordering separately.

Add custom field / Add Column opens a searchable combobox of registered definitions, with an option to create a new field. Selecting an existing field reuses its ID. Repeated selection does not add another column. Names are unique ignoring case; an identical definition submitted with the same name reuses the existing field, while conflicting definitions require a different name. Editing updates the shared definition. Removing a column removes it from that table, retaining the registered field.

Existing browser-local column definitions are imported when a table loads. Stored definitions win over stale copies of the same ID. Existing local selections remain available if the registry is unavailable; failed explicit saves display an error. Other open browser windows refresh the registry when focused. Existing saved views resolve field IDs through the registry.

`GET /api/custom-fields` lists definitions. `POST /api/custom-fields` accepts `{ field: { id, name, code, mode, format }, overwrite?: boolean }`; the default imports or reuses a definition, and `overwrite: true` edits an existing ID. Writes use the existing local-mutation checks. WebMCP column edits await registry persistence before reporting success; deletion removes only the table selection.
