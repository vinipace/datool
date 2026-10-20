import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import type {
  ActionDefinition,
  AgentConfiguration,
  ProcedureDefinition,
  WidgetDefinition,
} from "@/src/lib/build/contracts"

// The project table is owned by the tracer/application schema. Keeping a tiny
// reference here lets this catalog stay independent without duplicating that
// schema's exports in the database type.
const projects = pgTable("project", { id: text("id").primaryKey() })

const projectColumns = () => ({
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
})

export const buildAgents = pgTable(
  "build_agents",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull(),
    currentRevision: integer("current_revision").notNull(),
    appliedRevision: integer("applied_revision").notNull(),
    currentConfigJson: jsonb("current_config_json")
      .$type<AgentConfiguration>()
      .notNull(),
    appliedConfigJson: jsonb("applied_config_json")
      .$type<AgentConfiguration>()
      .notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
  },
  (t) => [
    uniqueIndex("build_agents_project_id_id_idx").on(t.projectId, t.id),
    uniqueIndex("build_agents_project_slug_idx").on(t.projectId, t.slug),
    index("build_agents_project_status_idx").on(
      t.projectId,
      t.status,
      t.updatedAt
    ),
  ]
)

export const buildAgentRevisions = pgTable(
  "build_agent_revisions",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
    state: text("state").notNull(),
    configJson: jsonb("config_json").$type<AgentConfiguration>().notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("build_agent_revisions_project_id_id_idx").on(
      t.projectId,
      t.id
    ),
    uniqueIndex("build_agent_revisions_project_agent_revision_idx").on(
      t.projectId,
      t.agentId,
      t.revision
    ),
    index("build_agent_revisions_project_agent_created_idx").on(
      t.projectId,
      t.agentId,
      t.createdAt
    ),
    foreignKey({
      columns: [t.projectId, t.agentId],
      foreignColumns: [buildAgents.projectId, buildAgents.id],
      name: "build_agent_revisions_project_agent_fk",
    }).onDelete("cascade"),
  ]
)

export const buildActions = pgTable(
  "build_actions",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    agentId: text("agent_id").notNull(),
    slug: text("slug").notNull(),
    revision: integer("revision").notNull(),
    definitionJson: jsonb("definition_json")
      .$type<ActionDefinition>()
      .notNull(),
    encryptedHeaders: text("encrypted_headers"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("build_actions_project_id_id_idx").on(t.projectId, t.id),
    uniqueIndex("build_actions_project_agent_slug_idx").on(
      t.projectId,
      t.agentId,
      t.slug
    ),
    index("build_actions_project_agent_idx").on(
      t.projectId,
      t.agentId,
      t.updatedAt
    ),
    foreignKey({
      columns: [t.projectId, t.agentId],
      foreignColumns: [buildAgents.projectId, buildAgents.id],
      name: "build_actions_project_agent_fk",
    }).onDelete("cascade"),
  ]
)

export const buildActionRevisions = pgTable(
  "build_action_revisions",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    actionId: text("action_id").notNull(),
    agentId: text("agent_id").notNull(),
    slug: text("slug").notNull(),
    revision: integer("revision").notNull(),
    definitionJson: jsonb("definition_json")
      .$type<ActionDefinition>()
      .notNull(),
    encryptedHeaders: text("encrypted_headers"),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("build_action_revisions_project_id_id_idx").on(
      t.projectId,
      t.id
    ),
    uniqueIndex("build_action_revisions_project_action_revision_idx").on(
      t.projectId,
      t.actionId,
      t.revision
    ),
    foreignKey({
      columns: [t.projectId, t.actionId],
      foreignColumns: [buildActions.projectId, buildActions.id],
      name: "build_action_revisions_project_action_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.agentId],
      foreignColumns: [buildAgents.projectId, buildAgents.id],
      name: "build_action_revisions_project_agent_fk",
    }).onDelete("cascade"),
  ]
)

export const buildProcedures = pgTable(
  "build_procedures",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    agentId: text("agent_id").notNull(),
    slug: text("slug").notNull(),
    revision: integer("revision").notNull(),
    definitionJson: jsonb("definition_json")
      .$type<ProcedureDefinition>()
      .notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("build_procedures_project_id_id_idx").on(t.projectId, t.id),
    uniqueIndex("build_procedures_project_agent_slug_idx").on(
      t.projectId,
      t.agentId,
      t.slug
    ),
    index("build_procedures_project_agent_idx").on(
      t.projectId,
      t.agentId,
      t.updatedAt
    ),
    foreignKey({
      columns: [t.projectId, t.agentId],
      foreignColumns: [buildAgents.projectId, buildAgents.id],
      name: "build_procedures_project_agent_fk",
    }).onDelete("cascade"),
  ]
)

export const buildProcedureRevisions = pgTable(
  "build_procedure_revisions",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    procedureId: text("procedure_id").notNull(),
    agentId: text("agent_id").notNull(),
    slug: text("slug").notNull(),
    revision: integer("revision").notNull(),
    definitionJson: jsonb("definition_json")
      .$type<ProcedureDefinition>()
      .notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("build_procedure_revisions_project_id_id_idx").on(
      t.projectId,
      t.id
    ),
    uniqueIndex("build_procedure_revisions_project_procedure_revision_idx").on(
      t.projectId,
      t.procedureId,
      t.revision
    ),
    foreignKey({
      columns: [t.projectId, t.procedureId],
      foreignColumns: [buildProcedures.projectId, buildProcedures.id],
      name: "build_procedure_revisions_project_procedure_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.agentId],
      foreignColumns: [buildAgents.projectId, buildAgents.id],
      name: "build_procedure_revisions_project_agent_fk",
    }).onDelete("cascade"),
  ]
)

export const buildWidgets = pgTable(
  "build_widgets",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    agentId: text("agent_id").notNull(),
    slug: text("slug").notNull(),
    revision: integer("revision").notNull(),
    definitionJson: jsonb("definition_json")
      .$type<WidgetDefinition>()
      .notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("build_widgets_project_id_id_idx").on(t.projectId, t.id),
    uniqueIndex("build_widgets_project_agent_slug_idx").on(
      t.projectId,
      t.agentId,
      t.slug
    ),
    index("build_widgets_project_agent_idx").on(
      t.projectId,
      t.agentId,
      t.updatedAt
    ),
    foreignKey({
      columns: [t.projectId, t.agentId],
      foreignColumns: [buildAgents.projectId, buildAgents.id],
      name: "build_widgets_project_agent_fk",
    }).onDelete("cascade"),
  ]
)

export const buildWidgetRevisions = pgTable(
  "build_widget_revisions",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    widgetId: text("widget_id").notNull(),
    agentId: text("agent_id").notNull(),
    slug: text("slug").notNull(),
    revision: integer("revision").notNull(),
    definitionJson: jsonb("definition_json")
      .$type<WidgetDefinition>()
      .notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("build_widget_revisions_project_id_id_idx").on(
      t.projectId,
      t.id
    ),
    uniqueIndex("build_widget_revisions_project_widget_revision_idx").on(
      t.projectId,
      t.widgetId,
      t.revision
    ),
    foreignKey({
      columns: [t.projectId, t.widgetId],
      foreignColumns: [buildWidgets.projectId, buildWidgets.id],
      name: "build_widget_revisions_project_widget_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.agentId],
      foreignColumns: [buildAgents.projectId, buildAgents.id],
      name: "build_widget_revisions_project_agent_fk",
    }).onDelete("cascade"),
  ]
)

/**
 * An applied agent revision owns an immutable view of the definition catalog.
 * Definition current rows are intentionally editable drafts; these snapshot
 * rows pin the exact action/procedure/widget revisions the customer runtime
 * is allowed to execute for a given agent revision.
 */
export const buildAgentCatalogSnapshots = pgTable(
  "build_agent_catalog_snapshots",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    agentId: text("agent_id").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("build_agent_catalog_snapshots_project_id_id_idx").on(
      t.projectId,
      t.id
    ),
    uniqueIndex("build_agent_catalog_snapshots_project_agent_revision_idx").on(
      t.projectId,
      t.agentId,
      t.agentRevision
    ),
    uniqueIndex("build_agent_catalog_snapshots_project_id_agent_idx").on(
      t.projectId,
      t.id,
      t.agentId
    ),
    foreignKey({
      columns: [t.projectId, t.agentId],
      foreignColumns: [buildAgents.projectId, buildAgents.id],
      name: "build_agent_catalog_snapshots_project_agent_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.agentId, t.agentRevision],
      foreignColumns: [
        buildAgentRevisions.projectId,
        buildAgentRevisions.agentId,
        buildAgentRevisions.revision,
      ],
      name: "build_agent_catalog_snapshots_agent_revision_fk",
    }).onDelete("restrict"),
  ]
)

export const buildAgentCatalogActions = pgTable(
  "build_agent_catalog_actions",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    catalogId: text("catalog_id").notNull(),
    actionId: text("action_id").notNull(),
    revision: integer("revision").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.projectId, t.catalogId, t.actionId],
      name: "build_agent_catalog_actions_pk",
    }),
    foreignKey({
      columns: [t.projectId, t.catalogId],
      foreignColumns: [
        buildAgentCatalogSnapshots.projectId,
        buildAgentCatalogSnapshots.id,
      ],
      name: "build_agent_catalog_actions_snapshot_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.actionId, t.revision],
      foreignColumns: [
        buildActionRevisions.projectId,
        buildActionRevisions.actionId,
        buildActionRevisions.revision,
      ],
      name: "build_agent_catalog_actions_revision_fk",
    }).onDelete("restrict"),
    index("build_agent_catalog_actions_snapshot_idx").on(
      t.projectId,
      t.catalogId
    ),
  ]
)

export const buildAgentCatalogProcedures = pgTable(
  "build_agent_catalog_procedures",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    catalogId: text("catalog_id").notNull(),
    procedureId: text("procedure_id").notNull(),
    revision: integer("revision").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.projectId, t.catalogId, t.procedureId],
      name: "build_agent_catalog_procedures_pk",
    }),
    foreignKey({
      columns: [t.projectId, t.catalogId],
      foreignColumns: [
        buildAgentCatalogSnapshots.projectId,
        buildAgentCatalogSnapshots.id,
      ],
      name: "build_agent_catalog_procedures_snapshot_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.procedureId, t.revision],
      foreignColumns: [
        buildProcedureRevisions.projectId,
        buildProcedureRevisions.procedureId,
        buildProcedureRevisions.revision,
      ],
      name: "build_agent_catalog_procedures_revision_fk",
    }).onDelete("restrict"),
    index("build_agent_catalog_procedures_snapshot_idx").on(
      t.projectId,
      t.catalogId
    ),
  ]
)

export const buildAgentCatalogWidgets = pgTable(
  "build_agent_catalog_widgets",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    catalogId: text("catalog_id").notNull(),
    widgetId: text("widget_id").notNull(),
    revision: integer("revision").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.projectId, t.catalogId, t.widgetId],
      name: "build_agent_catalog_widgets_pk",
    }),
    foreignKey({
      columns: [t.projectId, t.catalogId],
      foreignColumns: [
        buildAgentCatalogSnapshots.projectId,
        buildAgentCatalogSnapshots.id,
      ],
      name: "build_agent_catalog_widgets_snapshot_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.widgetId, t.revision],
      foreignColumns: [
        buildWidgetRevisions.projectId,
        buildWidgetRevisions.widgetId,
        buildWidgetRevisions.revision,
      ],
      name: "build_agent_catalog_widgets_revision_fk",
    }).onDelete("restrict"),
    index("build_agent_catalog_widgets_snapshot_idx").on(
      t.projectId,
      t.catalogId
    ),
  ]
)

export const buildCatalogSchema = {
  buildAgents,
  buildAgentRevisions,
  buildActions,
  buildActionRevisions,
  buildProcedures,
  buildProcedureRevisions,
  buildWidgets,
  buildWidgetRevisions,
  buildAgentCatalogSnapshots,
  buildAgentCatalogActions,
  buildAgentCatalogProcedures,
  buildAgentCatalogWidgets,
}

export type BuildCatalogSchema = typeof buildCatalogSchema
