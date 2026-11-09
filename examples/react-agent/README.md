# Next.js React SDK example

A local app with embedded chat, a company-context file editor, and one-time or recurring briefings.

From the repository root:

```sh
bun install
bun run build:packages
cp examples/react-agent/.env.example examples/react-agent/.env.local
# Fill in a Datool project API key and enabled React SDK connection ID.
bun --cwd examples/react-agent dev
```

Open http://localhost:3010. Datool must be running separately, including its Build worker and Eve runtime. Enable a local Sandbox on the chosen agent. The key needs `build:read`, `build:write`, and `build:run`.

1. Review the company context, edit it, and save your changes to the drive.
2. Ask the chat to read it and suggest next steps.
3. Open **Scheduled tasks**, then **In 1 minute**. The briefing arrives in chat without another user message.
4. Switch between Acme Studio and Orbit Labs to test separate conversations, files, and tasks.

Each workspace loads its saved `context/company.md` before connecting the chat. On first use, a missing file is created with workspace-specific sample context; existing files (including empty files) are preserved. Task refreshes leave unsaved edits alone. Switching workspaces loads its file, tasks, and conversation together.

`lib/datool.ts` simulates authentication using two named demo workspaces. It is intentionally a local sample, with the development server bound to loopback. Replace `demoAuth` with your real session provider before deploying. Datool credentials stay in `.env.local`, which is ignored by Git. The catch-all endpoint uses `createDatoolHandler`; file and task controls call `createDatoolClient` from server routes.
