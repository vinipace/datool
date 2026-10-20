import {
  BookOpen,
  FlaskConical,
  ChartNoAxesCombined,
  FileText,
  Database,
  UserRoundCheck,
  ListChecks,
  MessagesSquare,
  PanelsTopLeft,
  Play,
  Plug,
  Radio,
  Settings,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react"

export type BuildTab = {
  id: string
  label: string
  icon: LucideIcon
  description: string
  group: "Build" | "Activity" | "Manage" | "Hidden"
}

/**
 * Keep stable ids for deep links and saved drafts while presenting sections
 * in a smaller, task-oriented hierarchy.
 */
export const agentBuildTabs: BuildTab[] = [
  { id: "test", label: "Test", icon: FlaskConical, description: "Datasets and evaluations for this agent", group: "Manage" },
  {
    id: "overview",
    label: "Analytics",
    icon: ChartNoAxesCombined,
    description: "Activity and customer experience",
    group: "Manage",
  },
  {
    id: "instructions",
    label: "Instructions",
    icon: FileText,
    description: "Behavior and model",
    group: "Build",
  },
  {
    id: "guardrails",
    label: "Guardrails",
    icon: ShieldCheck,
    description: "Safety, usage and abuse limits",
    group: "Build",
  },
  {
    id: "knowledge",
    label: "Data sources",
    icon: BookOpen,
    description: "Sources your agent can use",
    group: "Build",
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: Plug,
    description: "Connect apps your agent can use",
    group: "Build",
  },
  {
    id: "actions",
    label: "Actions",
    icon: Wrench,
    description: "Things the agent can do",
    group: "Build",
  },
  {
    id: "procedures",
    label: "Skills",
    icon: ListChecks,
    description: "Reusable instructions for specific tasks",
    group: "Build",
  },
  {
    id: "widgets",
    label: "Widgets",
    icon: PanelsTopLeft,
    description: "Interactive responses",
    group: "Build",
  },
  {
    id: "conversations",
    label: "Conversations",
    icon: MessagesSquare,
    description: "Conversations with this agent",
    group: "Activity",
  },
  {
    id: "leads",
    label: "Leads",
    icon: UserRoundCheck,
    description: "Leads captured by this agent",
    group: "Activity",
  },
  {
    id: "collected-data",
    label: "Collected data",
    icon: Database,
    description: "Fields collected in this agent’s conversations",
    group: "Activity",
  },
  {
    id: "channels",
    label: "Channels",
    icon: Radio,
    description: "Where customers reach you",
    group: "Manage",
  },
  {
    id: "playground",
    label: "Playground",
    icon: Play,
    description: "Try the applied agent",
    group: "Hidden",
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    description: "Identity, appearance and revision history",
    group: "Manage",
  },
]
