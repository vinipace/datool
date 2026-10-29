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
    summary: "Recommends products and closes sales in the chat.",
    Icon: MessageCircle,
  },
  {
    href: "/agents/website-sales",
    name: "Sales on your website",
    summary: "A chat widget that helps visitors find and buy.",
    Icon: ShoppingBag,
  },
  {
    href: "/agents/whatsapp-support",
    name: "Support on WhatsApp",
    summary: "Answers from your policies and checks your systems.",
    Icon: LifeBuoy,
  },
  {
    href: "/agents/website-support",
    name: "Support on your website",
    summary: "A help widget that troubleshoots and hands off.",
    Icon: CircleHelp,
  },
  {
    href: "/agents/product-guidance",
    name: "Product guide",
    summary: "Onboards and guides users inside your app.",
    Icon: Compass,
  },
]

export const getAgentPage = (href: string) =>
  agentPages.find((page) => page.href === href)
