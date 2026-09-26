import { BookOpen, Code2, Layers, Rocket, Server, Terminal } from "lucide-react"
import { productIcons } from "@/components/product-icons"

export const docsIcons = {
  ...productIcons,
  reference: BookOpen,
  sdk: Code2,
  concepts: Layers,
  quickstart: Rocket,
  hosting: Server,
  cli: Terminal,
} as const
