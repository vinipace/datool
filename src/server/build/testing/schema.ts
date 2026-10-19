import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import type {
  CopilotProposalStatus,
  CopilotTargetKind,
  SimulationCaseStatus,
  SimulationConfigSnapshot,
  SimulationDefinition,
  SimulationMessage,
  SimulationRunStatus,
  SimulationVerdict,
  ToolMock,
} from "@/src/lib/build/testing"

const projects = pgTable("project", { id: text("id").primaryKey() })

const projectColumns = () => ({
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
})

export const buildTestDefinitions = pgTable(
  "build_test_definitions",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
    name: text("name").notNull(),
    definitionJson: jsonb("definition_json")
      .$type<SimulationDefinition>()
      .notNull(),
    status: text("status").$type<"active" | "archived">().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("build_test_definitions_project_id_id_idx").on(
      t.projectId,
      t.id
    ),
    uniqueIndex("build_test_definitions_project_agent_name_idx").on(
      t.projectId,
      t.agentId,
      t.name
    ),
    index("build_test_definitions_project_agent_idx").on(
      t.projectId,
      t.agentId,
      t.updatedAt
    ),
  ]
)

export const buildTestDefinitionRevisions = pgTable(
  "build_test_definition_revisions",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    definitionId: text("definition_id").notNull(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
    definitionJson: jsonb("definition_json")
      .$type<SimulationDefinition>()
      .notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("build_test_definition_revisions_project_id_id_idx").on(
      t.projectId,
      t.id
    ),
    uniqueIndex(
      "build_test_definition_revisions_project_definition_revision_idx"
    ).on(t.projectId, t.definitionId, t.revision),
    index("build_test_definition_revisions_project_definition_idx").on(
      t.projectId,
      t.definitionId,
      t.revision
    ),
  ]
)

export const buildTestToolMocks = pgTable(
  "build_test_tool_mocks",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    definitionId: text("definition_id").notNull(),
    mockJson: jsonb("mock_json").$type<ToolMock>().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("build_test_tool_mocks_project_id_id_idx").on(
      t.projectId,
      t.id
    ),
    index("build_test_tool_mocks_project_definition_idx").on(
      t.projectId,
      t.definitionId,
      t.createdAt
    ),
  ]
)

export const buildTestRuns = pgTable(
  "build_test_runs",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    definitionId: text("definition_id").notNull(),
    status: text("status").$type<SimulationRunStatus>().notNull(),
    requestedCases: integer("requested_cases").notNull(),
    completedCases: integer("completed_cases").notNull().default(0),
    passedCases: integer("passed_cases").notNull().default(0),
    failedCases: integer("failed_cases").notNull().default(0),
    noVerdictCases: integer("no_verdict_cases").notNull().default(0),
    infraErrorCases: integer("infra_error_cases").notNull().default(0),
    configSnapshotJson: jsonb("config_snapshot_json")
      .$type<SimulationConfigSnapshot>()
      .notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    error: text("error"),
    requestedBy: text("requested_by"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => [
    uniqueIndex("build_test_runs_project_id_id_idx").on(t.projectId, t.id),
    index("build_test_runs_project_definition_idx").on(
      t.projectId,
      t.definitionId,
      t.createdAt
    ),
    index("build_test_runs_claim_idx").on(
      t.projectId,
      t.status,
      t.leaseExpiresAt
    ),
  ]
)

export const buildTestCases = pgTable(
  "build_test_cases",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    runId: text("run_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    repeatIndex: integer("repeat_index").notNull(),
    variantKey: text("variant_key").notNull(),
    model: text("model").notNull(),
    status: text("status").$type<SimulationCaseStatus>().notNull(),
    transcriptJson: jsonb("transcript_json")
      .$type<SimulationMessage[]>()
      .notNull(),
    observedActionsJson: jsonb("observed_actions_json").notNull(),
    verdictJson: jsonb("verdict_json").$type<SimulationVerdict | null>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => [
    uniqueIndex("build_test_cases_project_id_id_idx").on(t.projectId, t.id),
    uniqueIndex("build_test_cases_project_run_variant_idx").on(
      t.projectId,
      t.runId,
      t.ordinal,
      t.variantKey
    ),
    index("build_test_cases_project_run_idx").on(
      t.projectId,
      t.runId,
      t.ordinal
    ),
    index("build_test_cases_claim_idx").on(
      t.projectId,
      t.status,
      t.leaseExpiresAt
    ),
  ]
)

export const buildCopilotProposals = pgTable(
  "build_copilot_proposals",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    agentId: text("agent_id").notNull(),
    targetKind: text("target_kind").$type<CopilotTargetKind>().notNull(),
    targetId: text("target_id"),
    status: text("status").$type<CopilotProposalStatus>().notNull(),
    baseRevision: integer("base_revision").notNull(),
    request: text("request").notNull(),
    sourceSnapshotJson: jsonb("source_snapshot_json").notNull(),
    proposedValueJson: jsonb("proposed_value_json").notNull(),
    diffJson: jsonb("diff_json").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdBy: text("created_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
    approvedBy: text("approved_by"),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("build_copilot_proposals_project_id_id_idx").on(
      t.projectId,
      t.id
    ),
    index("build_copilot_proposals_project_agent_idx").on(
      t.projectId,
      t.agentId,
      t.createdAt
    ),
    index("build_copilot_proposals_status_idx").on(
      t.projectId,
      t.status,
      t.createdAt
    ),
  ]
)

export const buildCopilotAudit = pgTable(
  "build_copilot_audit",
  {
    id: text("id").primaryKey(),
    ...projectColumns(),
    proposalId: text("proposal_id").notNull(),
    event: text("event").notNull(),
    actorId: text("actor_id"),
    payloadJson: jsonb("payload_json").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    uniqueIndex("build_copilot_audit_project_id_id_idx").on(t.projectId, t.id),
    index("build_copilot_audit_project_proposal_idx").on(
      t.projectId,
      t.proposalId,
      t.createdAt
    ),
  ]
)

export const buildTestingSchema = {
  buildTestDefinitions,
  buildTestDefinitionRevisions,
  buildTestToolMocks,
  buildTestRuns,
  buildTestCases,
  buildCopilotProposals,
  buildCopilotAudit,
}

export type BuildTestingSchema = typeof buildTestingSchema
