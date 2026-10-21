import type { ProcedureDefinition } from "./contracts"

export type SkillTemplate = {
  id: string
  category: "Support" | "E-commerce" | "Billing" | "Sales"
  name: string
  description: string
  trigger: string
  steps: string[]
  suggestedActions: string[]
}

export const skillTemplates: SkillTemplate[] = [
  {
    id: "support-hours",
    category: "Support",
    name: "Live agent availability by hours",
    description:
      "Check support hours, then offer a live handoff or collect a request for follow-up.",
    trigger:
      "The customer asks to speak with a person or needs help that requires the support team.",
    steps: [
      "Check the approved support schedule and time zone in your knowledge. If the schedule is missing, do not guess whether support is open.",
      "During support hours, ask for a short summary and use a connected handoff action. Only confirm the transfer after the action succeeds.",
      "Outside support hours, explain when support returns only if that schedule is known. Ask for a summary and the customer's preferred contact details, then use a connected ticket or lead action.",
      "If no suitable action is connected, explain the limitation and share an approved support contact from your knowledge. Do not claim a ticket or transfer was created.",
    ],
    suggestedActions: ["Hand off to support", "Create a support request"],
  },
  {
    id: "live-agent",
    category: "Support",
    name: "Live agent availability",
    description:
      "Connect a customer to your team and offer a follow-up when nobody is available.",
    trigger:
      "The customer requests a human agent or the issue cannot be resolved from approved knowledge.",
    steps: [
      "Acknowledge the request and ask for a short description of the issue if it is not already in the conversation.",
      "Use a connected handoff action. Use the action result to explain whether the transfer was accepted; do not promise immediate availability.",
      "If a handoff is unavailable or fails, ask whether the customer would like a follow-up. Collect only the necessary contact details and use a connected ticket or lead action.",
      "If neither action is available, share an approved support contact. Never invent a ticket number, agent availability or response time.",
    ],
    suggestedActions: ["Hand off to support", "Create a support request"],
  },
  {
    id: "product-exchange",
    category: "E-commerce",
    name: "Product exchange",
    description:
      "Check the exchange policy, confirm the replacement, and help the customer with the next step.",
    trigger:
      "The customer wants to exchange a product for another size, variant or item.",
    steps: [
      "Ask for the order reference and the account details required by the connected order lookup. Follow your business's verification policy before revealing order information.",
      "Look up the order with a connected action. If no matching order is found, ask the customer to check the details; do not reveal information from another order.",
      "Check the exchange window, item condition and stock using the approved policy and available actions. If any required information is missing, offer a support handoff instead of assuming eligibility.",
      "If eligible, explain any confirmed price or delivery differences, ask the customer to confirm the replacement, then use the connected exchange action. Confirm success only from the action result.",
      "If ineligible or the action fails, explain the reason supported by the policy and offer a connected support handoff.",
    ],
    suggestedActions: [
      "Look up an order",
      "Exchange an item",
      "Hand off to support",
    ],
  },
  {
    id: "order-refund",
    category: "E-commerce",
    name: "Order refund",
    description:
      "Check your refund policy and guide an eligible request back to the original payment method.",
    trigger:
      "The customer wants their money back for an order they already paid for.",
    steps: [
      "Ask for the order reference and the account details required by the connected lookup action. Follow your business's verification policy before revealing order information.",
      "Use a connected order lookup. If no matching order is found, ask the customer to double-check their details.",
      "Check the order against the approved refund window, item conditions and payment policy. Do not assume a refund window, amount or processing time when the policy is missing.",
      "If eligible, ask which items should be refunded and why. Explain the confirmed amount and destination, get the customer's confirmation, then use the connected refund action.",
      "Only confirm a refund after the action succeeds. Quote a processing time only when supplied by the policy or action result. If ineligible, unavailable or failed, offer a connected support handoff for review.",
    ],
    suggestedActions: [
      "Look up an order",
      "Refund an order",
      "Hand off to support",
    ],
  },
  {
    id: "billing-dispute",
    category: "Billing",
    name: "Billing dispute",
    description:
      "Find the disputed charge, collect the relevant details, and route it to your billing team.",
    trigger:
      "The customer reports an unexpected, duplicate or incorrect charge.",
    steps: [
      "Ask for the invoice or charge reference and the verification details required by your billing policy. Never ask for full payment card details or passwords.",
      "Use a connected invoice lookup and confirm the date, currency and amount of the matching charge without exposing another customer's billing information.",
      "Ask what seems incorrect and collect a concise explanation. If the charge cannot be found, ask the customer to verify the reference.",
      "Use a connected billing review or support handoff action with the charge reference and explanation. Do not promise a refund or reverse a charge unless an authorized action confirms it.",
      "Explain the next step and share a case reference only if the action returns one.",
    ],
    suggestedActions: ["Look up an invoice", "Create a billing review"],
  },
  {
    id: "lead-meeting",
    category: "Sales",
    name: "Collect lead & book a meeting",
    description:
      "Capture a prospect's needs and contact details, then help them choose a meeting time.",
    trigger:
      "The visitor wants a demo, a sales conversation or a meeting with your team.",
    steps: [
      "Ask what the visitor wants to achieve. Collect their name, work email and any company details required by your connected lead action, explaining how your team will use them.",
      "Use the connected form, widget or lead action. Do not ask again for details already provided in the conversation.",
      "If a calendar action is connected, ask for the visitor's time zone and preferred times, then check actual availability. Offer only slots returned by that action.",
      "Ask the visitor to confirm a slot and use the connected booking action. Confirm the date, time zone and meeting link only after the action succeeds.",
      "If scheduling is not connected or the booking fails, offer an approved scheduling link or confirm a follow-up only after the lead action succeeds. Never invent a calendar booking.",
    ],
    suggestedActions: [
      "Collect a lead or show a form",
      "Check calendar availability",
      "Book a meeting",
    ],
  },
]

export function skillFromTemplate(
  template: SkillTemplate
): ProcedureDefinition {
  return {
    name: template.name,
    description: template.description,
    enabled: false,
    trigger: { type: "intent", value: template.trigger },
    instructions: template.steps
      .map((step, index) => `${index + 1}. ${step}`)
      .join("\n\n"),
    steps: [],
    variables: {},
    branches: [],
    actionRefs: [],
  }
}
