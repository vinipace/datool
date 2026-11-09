import { registerBuildOperation } from "../api"
import {
  sdkChatInputSchema,
  sdkFileInputSchema,
  sdkTaskInputSchema,
} from "@/src/lib/build/react-sdk"
import { sdkChat } from "../sdk-chat"
import { sdkFiles } from "../sdk-files"
import { sdkTasks } from "../sdk-tasks"

registerBuildOperation({
  name: "build_sdk_chat",
  description:
    "Open, read or message a React SDK conversation scoped to a server-authenticated user and application drive.",
  scopes: ["build:run"],
  schema: sdkChatInputSchema,
  execute: sdkChat,
  idempotency: "none",
  openWorld: true,
})
registerBuildOperation({
  name: "build_sdk_files",
  description:
    "List, read, write, create directories or delete files in an application's isolated drive. File transfers are bounded to 256 KiB and directory listings to 500 entries. Deletes never recurse.",
  scopes: ["build:write", "build:run"],
  schema: sdkFileInputSchema,
  execute: sdkFiles,
  idempotency: "none",
  openWorld: true,
  maxInputBytes: 512 * 1024,
})
registerBuildOperation({
  name: "build_sdk_tasks",
  description:
    "Manage proactive tasks within a server-authenticated SDK conversation. Runs use its drive and deliver results into that conversation.",
  scopes: ["build:read", "build:write", "build:run"],
  schema: sdkTaskInputSchema,
  execute: sdkTasks,
  idempotency: "required",
  openWorld: true,
})
