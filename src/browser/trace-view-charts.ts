import * as charts from "recharts"
import * as shared from "../../components/ui/chart"
// This separate script reuses the React instance installed by the core runtime.
window.__datoolTraceCharts = { ...charts, ...shared }
