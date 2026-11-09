import { DatoolError } from "@datool/sdk/agents"
import type { Workspace } from "./datool"

export const companyContextPath = "context/company.md"
const samples: Record<Workspace, string> = {
  acme: `# Company context

Acme Studio builds software for independent teams.
Our priority this week is launching the customer portal.

## Current work
- Finish onboarding and invite the first 10 customers.
- Collect feedback from the pilot group.
- Prepare a short weekly progress update.
`,
  orbit: `# Company context

Orbit Labs builds analytics software for research laboratories.
Our priority this week is launching a sensor-data pilot with three labs.

## Current work
- Validate the sensor imports with the pilot labs.
- Prepare the data-quality dashboard for the research teams.
- Collect feedback before expanding the pilot.
`,
}

export async function loadCompanyContext(
  files: {
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<unknown>
  },
  workspace: Workspace
) {
  try {
    return await files.read(companyContextPath)
  } catch (error) {
    // Only seed an absent demo file. Empty files and other read failures
    // must never be replaced with sample content.
    if (
      !(error instanceof DatoolError) ||
      ![400, 404].includes(error.status) ||
      error.message !== "File or directory not found."
    )
      throw error
    const content = samples[workspace]
    await files.write(companyContextPath, content)
    return content
  }
}

// A remount (including React's development checks) can start a second load
// while the aborted request still holds the drive lease on the server.
// Share only in-flight work, never cached content, and keep scopes separate.
export function createCompanyContextLoader() {
  const loads = new Map<string, Promise<string>>()
  return (
    scope: string,
    ...args: Parameters<typeof loadCompanyContext>
  ): Promise<string> => {
    const existing = loads.get(scope)
    if (existing) return existing
    const load = loadCompanyContext(...args).finally(() => loads.delete(scope))
    loads.set(scope, load)
    return load
  }
}
