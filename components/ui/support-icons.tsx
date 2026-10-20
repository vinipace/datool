"use client"

import { createLucideIcon } from "lucide-react"

export const TicketFilledIcon = createLucideIcon("ticket-filled", [
  [
    "path",
    {
      d: "M4 4h16a3 3 0 0 1 3 3v2a1 1 0 0 1-1 1a2 2 0 0 0 0 4a1 1 0 0 1 1 1v2a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3v-2a1 1 0 0 1 1-1a2 2 0 0 0 0-4a1 1 0 0 1-1-1V7a3 3 0 0 1 3-3ZM12 4h2v4h-2ZM12 10h2v4h-2ZM12 16h2v4h-2Z",
      fill: "currentColor",
      fillRule: "evenodd",
      stroke: "none",
      key: "ticket",
    },
  ],
])

export const ConversationsFilledIcon = createLucideIcon("messages-square-filled", [
  [
    "path",
    {
      d: "M4 1a3 3 0 0 0-3 3v10.286a1.71 1.71 0 0 0 2.919 1.209l2.202-2.202A1 1 0 0 1 6.828 13H14a3 3 0 0 0 3-3V4a3 3 0 0 0-3-3H4Z",
      fill: "currentColor",
      stroke: "none",
      key: "front",
    },
  ],
  [
    "path",
    {
      d: "M19 8h1a3 3 0 0 1 3 3v10.286a1.71 1.71 0 0 1-2.919 1.209l-2.202-2.202a1 1 0 0 0-.707-.293H10a3 3 0 0 1-3-3v-2h7a5 5 0 0 0 5-5V8Z",
      fill: "currentColor",
      stroke: "none",
      key: "back",
    },
  ],
])
