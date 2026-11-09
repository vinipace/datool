# @datool/react

Embed a Datool agent in your React app. Your server authenticates every request and selects the application's drive; the browser never receives a Datool API key.

Requires React 18.2+ and Node 22.18+ for the server handler.

```sh
npm install @datool/react @datool/sdk
```

In Datool, open your agent's **Channels → React SDK**, enable the connection, and copy its connection ID. Create a project API key with `build:run`. Enable **Sandbox** if you want a drive.

## Your server

```ts
// app/api/datool/route.ts (Next.js App Router)
// An optional catch-all app/api/datool/[[...datool]]/route.ts also works.
import { createDatoolHandler } from "@datool/react/server"
import { auth } from "@/lib/auth" // Your app's authentication

export const POST = createDatoolHandler({
  apiKey: process.env.DATOOL_API_KEY!,
  projectId: process.env.DATOOL_PROJECT_ID!,
  connectionId: process.env.DATOOL_CONNECTION_ID!,
  async config({ req }) {
    const { orgId, userId } = await auth(req)
    if (!orgId || !userId) return new Response(null, { status: 401 })
    return { userId, drive: `drive_${orgId}` }
  },
})
```

The handler is a standard `(Request) => Promise<Response>` function, usable with other Node servers. Next.js App Router uses a named `POST` export. For self-hosted Datool, pass `baseUrl` (HTTPS, or HTTP on localhost).

`config` runs on every request, including polling. Authenticate there and derive identity from your session, never from untrusted request fields. An optional `workspaceName` in the server config gives that workspace a readable label in Datool’s Sandbox and Scheduled tasks pages. It is a display label and does not change authorization. A drive name creates a persistent drive scoped to this connection and sandbox provider. Users with the same drive share files, while their conversations and tasks stay separate. Files are mounted at `/workspace`. Other static drives configured on the agent are excluded from SDK conversations.

Returning only `{ drive: \`drive_${orgId}\` }`is supported: a signed, HttpOnly cookie supplies a browser-local visitor identity. Return a stable`userId`for continuity across devices and for server-created proactive tasks. Omitting`drive` creates a chat without an application drive.

## Your React app

```tsx
"use client"
import { DatoolChat } from "@datool/react"
import "@datool/react/styles.css"

export function Assistant() {
  return <DatoolChat endpoint="/api/datool" title="Your assistant" />
}
```

The endpoint must be on the app's origin. Optional props: `threadId` (default `default`), `welcomeMessage`, `placeholder`, `className`, `style`, and `pollingInterval` (default 3000 ms, minimum 1000 ms). Change `threadId` for a separate conversation. For an in-app identity switch, remount the component with a React `key` derived from the authenticated user/organization so old content clears immediately.

The component loads history, submits messages, and polls for completed replies and proactive updates. It pauses polling in hidden tabs. It renders text replies; streamed tokens, widgets, attachments, and push notifications are not included. Earlier messages load on demand. Customize the stylesheet's `--datool-*` properties or supply your own scoped CSS.

## Proactive agents

Use `createDatoolClient` from `@datool/sdk/agents` on your server. Select the same `connectionId`, `userId`, `drive`, and `threadId` to write files, message the agent, and manage scheduled tasks for this chat. See the [agent SDK guide](https://www.trydatool.com/docs/guides/react-sdk).

Scheduled runs continue without an open browser when Datool's Build worker and agent runtime are running. Their replies appear on the chat's next poll or reconnect. The React endpoint exposes chat only; file and task management stays in your authenticated server code.
