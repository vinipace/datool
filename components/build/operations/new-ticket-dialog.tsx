"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { Select } from "@/components/ui/select"
import { useMutation, useRemote } from "@/components/tracer/hooks"
import { asList, buildApi } from "./build-api"
import { FormLabel } from "./build-page"

type Agent = { id: string; name: string }
type Contact = { id: string; displayName?: string; email?: string }

export function NewTicketDialog({
  initialAgentId,
  onClose,
  onCreated,
}: {
  initialAgentId?: string
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [subject, setSubject] = React.useState("")
  const [agentId, setAgentId] = React.useState(initialAgentId ?? "")
  const [contact, setContact] = React.useState<ComboboxOption | undefined>()
  const [contactSearch, setContactSearch] = React.useState("")
  const [priority, setPriority] = React.useState("normal")
  const [requestId] = React.useState(() => crypto.randomUUID())
  const conversationRef = React.useRef<{ id: string; agentId: string } | null>(
    null
  )
  const ticketRequest = React.useRef<{ signature: string; key: string } | null>(
    null
  )
  const create = useMutation()
  const agents = useRemote(
    (signal) =>
      buildApi.call("build_list_agents", {}, signal).then(asList<Agent>),
    []
  )
  const contacts = useRemote(
    (signal) =>
      buildApi
        .call(
          "build_list_contacts",
          { search: contactSearch, limit: 30 },
          signal
        )
        .then(asList<Contact>),
    [contactSearch]
  )
  const selectedAgent = agentId || agents.data?.[0]?.id || ""
  const contactOptions = (contacts.data ?? []).map((item) => ({
    value: item.id,
    label: item.displayName || item.email || "Unnamed customer",
    description: item.email,
  }))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!subject.trim() || !selectedAgent) return
    try {
      const ticket = await create.run(async () => {
        let conversation = conversationRef.current
        if (!conversation || conversation.agentId !== selectedAgent) {
          const result = await buildApi.call<{ id: string }>(
            "build_create_conversation",
            {
              agentId: selectedAgent,
              channel: "web",
              externalConversationId: `inbox:${requestId}:${selectedAgent}`,
            },
            { idempotencyKey: `${requestId}:conversation:${selectedAgent}` }
          )
          conversation = { id: result.id, agentId: selectedAgent }
          conversationRef.current = conversation
        }
        const input = {
          conversationId: conversation.id,
          channel: "web",
          subject: subject.trim(),
          contactId: contact?.value,
          priority,
        }
        const signature = JSON.stringify(input)
        if (ticketRequest.current?.signature !== signature)
          ticketRequest.current = { signature, key: crypto.randomUUID() }
        return buildApi.call<{ id: string }>("build_create_ticket", input, {
          idempotencyKey: ticketRequest.current.key,
        })
      })
      onCreated(ticket.id)
    } catch {
      // Retain the draft and conversation identity so a retry cannot duplicate it.
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>
            Track a customer request with your team. Creating a ticket does not
            send a message.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <FormLabel label="Subject">
            <Input
              autoFocus
              required
              maxLength={500}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              disabled={create.isPending}
              placeholder="What does the customer need?"
            />
          </FormLabel>
          <FormLabel label="Agent">
            <Select
              value={selectedAgent}
              onChange={(event) => setAgentId(event.target.value)}
              disabled={agents.isLoading || create.isPending}
            >
              {!agents.data?.length ? (
                <option value="">
                  {agents.isLoading ? "Loading agents…" : "No agents available"}
                </option>
              ) : null}
              {agents.data?.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </Select>
          </FormLabel>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">
              Customer{" "}
              <span className="font-normal text-foreground-muted">
                (optional)
              </span>
            </p>
            <Combobox
              label="Ticket customer"
              placeholder="Search customers…"
              value={contact?.value ?? ""}
              selectedOption={contact}
              options={[{ value: "", label: "No customer" }, ...contactOptions]}
              onSearchChange={setContactSearch}
              onValueChange={(value) =>
                setContact(contactOptions.find((item) => item.value === value))
              }
              disabled={create.isPending}
              className="w-full"
            />
          </div>
          <FormLabel label="Priority">
            <Select
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              disabled={create.isPending}
            >
              {["low", "normal", "high", "urgent"].map((value) => (
                <option key={value} value={value}>
                  {value[0].toUpperCase() + value.slice(1)}
                </option>
              ))}
            </Select>
          </FormLabel>
          {agents.error || contacts.error ? (
            <Notice variant="error">
              {agents.error?.message ?? contacts.error?.message}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  agents.refresh()
                  contacts.refresh()
                }}
              >
                Retry
              </Button>
            </Notice>
          ) : null}
          {!agents.isLoading && !agents.error && !agents.data?.length ? (
            <Notice>Create an agent before opening a ticket.</Notice>
          ) : null}
          {create.error ? (
            <Notice variant="error">{create.error.message}</Notice>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={create.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={create.isPending}
              disabled={!subject.trim() || !selectedAgent}
            >
              Create ticket
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
