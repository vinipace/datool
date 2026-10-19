import { createRoot } from "react-dom/client"
import { TraceExplorer } from "@/components/plugins/trace-explorer"
import { McpExplorerHost } from "./host"

const host = new McpExplorerHost()
createRoot(document.getElementById("root")!).render(
  <TraceExplorer host={host} />
)
void host.connect()
