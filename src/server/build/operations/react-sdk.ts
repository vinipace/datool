import { registerBuildOperation } from "../api"
import {
  sdkChatInputSchema,
  sdkChatResultSchema,
  sdkFileResultSchema,
  sdkTaskResultSchema,
  sdkFileInputSchema,
  sdkTaskInputSchema,
} from "@/src/lib/build/react-sdk"
import { sdkChat } from "../sdk-chat"
import { sdkFiles } from "../sdk-files"
import { sdkTasks } from "../sdk-tasks"

registerBuildOperation({
  name: "build_sdk_chat",
  description:
    "Open, poll or message a React SDK conversation using identity and drive supplied by the authenticated application server. Never take another user or workspace from browser input. workspaceName is display-only. Start with request.action=session; use its conversationId for messages/send. Send retries reuse the same requestId UUID. Results can be pending; poll messages for completion.",
  scopes: ["build:run"],
  schema: sdkChatInputSchema,
  outputSchema: sdkChatResultSchema,
  execute: sdkChat,
  idempotency: "none",
  openWorld: true,
})
registerBuildOperation({
  name: "build_sdk_files",
  description:
    "List, read, write, create directories or delete files in an application's isolated drive. File transfers are bounded to 256 KiB and directory listings to 500 entries. Read/write content uses base64; the SDK encodes/decodes it. Paths are relative to the drive; traversal and symlinks are rejected. Deletes never recurse. Creating a drive records its agent and workspace for Sandbox; no chat session is required.",
  scopes: ["build:write", "build:run"],
  schema: sdkFileInputSchema,
  outputSchema: sdkFileResultSchema,
  destructive: true,
  execute: sdkFiles,
  idempotency: "none",
  openWorld: true,
  maxInputBytes: 512 * 1024,
})
registerBuildOperation({
  name: "build_sdk_tasks",
  description:
    "Manage proactive tasks within a server-authenticated SDK conversation. Create through this operation, not build_create_scheduled_task, for per-user tasks. Tasks and queued runs retain the original connection, user scope, drive and conversation, including dashboard-triggered runs. Changed or missing bindings fail closed. Updates cannot rebind a task. Current file contents are read at execution. Supply idempotencyKey and current expectedRevision when required by the request action.",
  scopes: ["build:read", "build:write", "build:run"],
  schema: sdkTaskInputSchema,
  outputSchema: sdkTaskResultSchema,
  destructive: true,
  execute: sdkTasks,
  idempotency: "required",
  openWorld: true,
})
