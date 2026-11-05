import {
  Activity,
  Bell,
  BookOpenCheck,
  Bot,
  Box,
  ClipboardCheck,
  Cpu,
  Database,
  FlaskConical,
  FileChartColumn,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  MessagesSquare,
  Play,
  Plug,
  Settings,
  Workflow,
  Users,
  Ticket,
  Megaphone,
  House,
  type LucideIcon,
} from "lucide-react"
import { ScorerIcon } from "@/components/tracer/scorer-icon"
import { SessionIcon } from "@/components/tracer/session-icon"
import {
  ConversationsFilledIcon,
  TicketFilledIcon,
} from "@/components/ui/support-icons"
import {
  HomeFilledIcon,
  TracesFilledIcon,
  DashboardFilledIcon,
  AgentFilledIcon,
  WorkflowFilledIcon,
  SessionFilledIcon,
  ReportFilledIcon,
  AlertFilledIcon,
  PlayFilledIcon,
  EvalFilledIcon,
  DatasetFilledIcon,
  ScorerFilledIcon,
  ReviewFilledIcon,
  HumanScoresFilledIcon,
} from "@/components/ui/navigation-icons"

/** Shared by the workspace and public docs navigation. */
export const productIcons = {
  home: House,
  traces: Activity,
  playground: Play,
  dashboards: LayoutDashboard,
  reports: FileChartColumn,
  agents: Bot,
  workflows: Workflow,
  sessions: SessionIcon,
  reviews: ClipboardCheck,
  humanScores: ListChecks,
  evals: FlaskConical,
  prompts: MessagesSquare,
  scorers: ScorerIcon,
  datasets: Database,
  alerts: Bell,
  settings: Settings,
  aiProviders: Cpu,
  sandboxProviders: Box,
  apiKeys: KeyRound,
  members: Users,
  mcpConnections: Plug,
  documentation: BookOpenCheck,
  buildAgents: Bot,
  buildInbox: Ticket,
  buildConversations: MessagesSquare,
  buildContacts: Users,
  buildCampaigns: Megaphone,
  buildIntegrations: Plug,
  buildTests: FlaskConical,
} as const

export const selectedProductIcons = {
  home: HomeFilledIcon,
  traces: TracesFilledIcon,
  dashboards: DashboardFilledIcon,
  agents: AgentFilledIcon,
  workflows: WorkflowFilledIcon,
  sessions: SessionFilledIcon,
  reports: ReportFilledIcon,
  alerts: AlertFilledIcon,
  playground: PlayFilledIcon,
  evals: EvalFilledIcon,
  datasets: DatasetFilledIcon,
  scorers: ScorerFilledIcon,
  reviews: ReviewFilledIcon,
  humanScores: HumanScoresFilledIcon,
  prompts: ConversationsFilledIcon,
  buildInbox: TicketFilledIcon,
  buildConversations: ConversationsFilledIcon,
} as const

const selectedIcons = new Map<LucideIcon, LucideIcon>(
  Object.entries(selectedProductIcons).map(([key, icon]) => [
    productIcons[key as keyof typeof selectedProductIcons],
    icon,
  ])
)

export function selectedProductIcon(icon: LucideIcon): LucideIcon {
  return selectedIcons.get(icon) ?? icon
}
