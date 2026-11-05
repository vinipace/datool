import {
  CircleHelp,
  Compass,
  LifeBuoy,
  MessageCircle,
  ShoppingBag,
} from "lucide-react"

// The five agent landing pages, shared by the navigation and the home page.
export const agentPages = [
  {
    href: "/agents/whatsapp-sales",
    name: "Sales on WhatsApp",
    summary: "Answer product questions and guide shoppers to checkout.",
    Icon: MessageCircle,
  },
  {
    href: "/agents/website-sales",
    name: "Sales on your website",
    summary: "Help shoppers choose before they leave your store.",
    Icon: ShoppingBag,
  },
  {
    href: "/agents/whatsapp-support",
    name: "Support on WhatsApp",
    summary: "Handle repeat questions and check connected order data.",
    Icon: LifeBuoy,
  },
  {
    href: "/agents/website-support",
    name: "Support on your website",
    summary: "Walk customers through a fix, then hand off with context.",
    Icon: CircleHelp,
  },
  {
    href: "/agents/product-guidance",
    name: "Product guide",
    summary: "Help users finish the task they signed up for.",
    Icon: Compass,
  },
]

export const getAgentPage = (href: string) =>
  agentPages.find((page) => page.href === href)
