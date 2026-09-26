import {
  Bot,
  Box,
  Braces,
  CircleDot,
  MessageCircle,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react"

import { ScorerIcon } from "./scorer-icon"
import { SessionIcon } from "./session-icon"
import { KindIcon } from "@/components/ui/kind-icon"
import { cn } from "@/lib/utils"
import type { TraceIconKind } from "./trace-icon-kind"

const configuration: Record<
  TraceIconKind,
  { className: string; icon: LucideIcon }
> = {
  agent: {
    className: "bg-invocation-agent text-invocation-agent-foreground",
    icon: Bot,
  },
  chat: {
    className:
      "bg-invocation-chat text-invocation-chat-foreground [&>svg]:fill-invocation-highlight/50",
    icon: MessageCircle,
  },
  code: {
    className: "bg-invocation-code text-invocation-code-foreground",
    icon: Braces,
  },
  custom: {
    className: "bg-invocation-code text-invocation-code-foreground",
    icon: Braces,
  },
  eval: {
    className: "bg-invocation-eval text-invocation-eval-foreground",
    icon: CircleDot,
  },
  function: {
    className: "bg-invocation-function text-invocation-function-foreground",
    icon: Braces,
  },
  llm: {
    className:
      "bg-invocation-llm text-invocation-llm-foreground [&>svg]:fill-invocation-llm-foreground/10",
    icon: MessageCircle,
  },
  score: {
    className: "bg-invocation-score text-invocation-score-foreground",
    icon: ScorerIcon,
  },
  task: {
    className:
      "bg-invocation-task text-invocation-task-foreground [&>svg]:fill-invocation-task-fill/20",
    icon: Box,
  },
  tool: {
    className:
      "bg-invocation-tool text-invocation-tool-foreground [&>svg]:fill-invocation-tool-foreground/10",
    icon: Wrench,
  },
  workflow: {
    className:
      "bg-invocation-workflow text-invocation-workflow-foreground [&>svg]:fill-invocation-highlight/50",
    icon: Workflow,
  },
}

export function SessionKindIcon() {
  return <KindIcon icon={SessionIcon} label="session"
    className="bg-invocation-session text-invocation-session-foreground [&>svg]:fill-invocation-session-foreground/10" />
}

export function SpanKindIcon({ kind, className }: { kind: TraceIconKind; className?: string }) {
  const { className: kindClassName, icon } = configuration[kind]
  return <KindIcon icon={icon} label={kind} className={cn(kindClassName, className)} />
}
