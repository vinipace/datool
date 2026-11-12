import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const projectStatus = pgEnum("project_status", [
  "active",
  "paused",
  "done",
])
export const projects = pgTable("projects", {
  id: text().primaryKey(),
  name: text().notNull(),
  status: projectStatus().notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})
