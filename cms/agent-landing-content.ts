import type { AgentLanding, Faq } from "@/payload-types"

/** An agent question before it is stored in the FAQs collection. */
export type AgentFAQ = { slug: string; question: string; answer: string }
type AgentLandingBase = Omit<
  AgentLanding,
  "id" | "createdAt" | "updatedAt" | "faq"
>
export type AgentLandingContent = AgentLandingBase & {
  faq: { title: string; items: AgentFAQ[] }
}
/** A published agent landing, or its seed content when the CMS is off. */
export type AgentLandingView = AgentLandingBase & {
  faq: { title: string; items: (number | Faq | AgentFAQ)[] }
}
type Feature = AgentLandingContent["features"]["items"][number]

export const agentLandingPath = (slug: string) => `/agents/${slug}`

const whatsapp = (agent: string) => ({
  number: "551151995330",
  message: `Hi! I'd like a personalized demo of Datool's ${agent}.`,
})
const cta = {
  title: "See it with your products.",
  description:
    "Message us on WhatsApp. We'll build your demo on your own content.",
  label: "Request a demo on WhatsApp",
}

// Bento tiles shared across pages; each page picks the ones that fit its story.
const feature = {
  whatsapp: {
    title: "Lives in your WhatsApp.",
    text: "Your business number, answered in seconds, day and night.",
    visual: "whatsapp",
    size: "large",
  },
  website: {
    title: "A widget on every page.",
    text: "A chat bubble on your site and a hosted help page.",
    visual: "website",
    size: "large",
  },
  catalog: {
    title: "Recommends from your catalog.",
    text: "Stock, sizes and prices from your own store data.",
    visual: "catalog",
    size: "wide",
  },
  handoff: {
    title: "Hands off with context.",
    text: "Your team gets a summary, not a transcript.",
    visual: "handoff",
    size: "regular",
  },
  knowledge: {
    title: "Answers from your docs.",
    text: "Policies and help articles, not guesses.",
    visual: "knowledge",
    size: "regular",
  },
  actions: {
    title: "Acts on your systems.",
    text: "Looks up orders, opens tickets and calls your APIs.",
    visual: "actions",
    size: "wide",
  },
  widgets: {
    title: "Forms in the chat.",
    text: "Collects sizes, addresses and order numbers up front.",
    visual: "widgets",
    size: "regular",
  },
  leads: {
    title: "Captures leads.",
    text: "Names, numbers and intent saved to contacts.",
    visual: "leads",
    size: "regular",
  },
  campaigns: {
    title: "WhatsApp campaigns.",
    text: "Restocks and drops for opted-in customers.",
    visual: "campaigns",
    size: "regular",
  },
  guardrails: {
    title: "Guardrails.",
    text: "Topics it avoids. Promises it won't make.",
    visual: "guardrails",
    size: "regular",
  },
  analytics: {
    title: "Tested before it ships.",
    text: "Replay real conversations as tests, then track what it resolves.",
    visual: "analytics",
    size: "wide",
  },
} satisfies Record<string, Feature>

// Each question has its own FAQ page, so it reads without the agent page.
const faq = {
  whatsappNumber: {
    slug: "which-whatsapp-number-does-an-agent-use",
    question: "Which WhatsApp number does a Datool agent use?",
    answer:
      "Your business's own WhatsApp number, connected in Datool. Customers keep messaging the number they already know.",
  },
  websiteInstall: {
    slug: "how-do-i-add-an-agent-to-my-website",
    question: "How do I add a Datool agent to my website?",
    answer:
      "Add the chat widget to your site or link to the hosted help page. You choose its position and appearance.",
  },
  catalog: {
    slug: "how-does-a-sales-agent-know-my-products",
    question: "How does a sales agent know my products?",
    answer:
      "You connect your catalog as a data source. It recommends only from what you've connected, so it never suggests something you don't sell.",
  },
  checkout: {
    slug: "can-customers-buy-inside-the-chat",
    question: "Can customers buy inside the chat?",
    answer:
      "It sends checkout links from your store, and it can call your own APIs for things like order lookups.",
  },
  answers: {
    slug: "where-does-a-support-agent-get-its-answers",
    question: "Where does a support agent get its answers?",
    answer:
      "From the help articles, policies and data sources you connect. It can also call your own APIs to look up orders or accounts.",
  },
  handoff: {
    slug: "what-happens-when-an-agent-cannot-solve-something",
    question: "What happens when an agent can't solve something?",
    answer:
      "It hands the conversation to your team in the inbox, with a summary and everything it already collected.",
  },
  team: {
    slug: "does-an-ai-agent-replace-my-team",
    question: "Does an AI agent replace my team?",
    answer:
      "No. It takes the repetitive conversations so your team spends its time on the ones that need a person.",
  },
  control: {
    slug: "can-i-control-what-an-agent-says",
    question: "Can I control what an agent says?",
    answer:
      "Yes. You write its instructions, choose its data sources and set guardrails for topics it should avoid. You can test it on real conversations before it goes live.",
  },
  start: {
    slug: "how-do-i-get-started-with-an-agent",
    question: "How do I get started with an agent?",
    answer:
      "Request a demo on WhatsApp. We set it up with your own content so you can see real answers before you decide.",
  },
  productInstall: {
    slug: "how-does-a-product-guide-get-into-my-app",
    question: "How does a product guide get into my app?",
    answer:
      "You add the chat widget to your app, then define the actions it can run there and the APIs it can call.",
  },
  productActions: {
    slug: "can-a-product-guide-click-things-for-users",
    question: "Can a product guide click things for users?",
    answer:
      "It can run client-side actions you define, such as opening a page or highlighting an element, and call your APIs.",
  },
  productData: {
    slug: "can-a-product-guide-use-each-users-data",
    question: "Can a product guide use each user's own data?",
    answer:
      "Yes, through the APIs you connect. It looks up the account it's helping, so answers fit that user instead of a generic article.",
  },
} satisfies Record<string, AgentFAQ>
export const agentFaqContent: AgentFAQ[] = Object.values(faq)

const supportGuardrails: Feature = {
  ...feature.guardrails,
  text: "Refunds and exceptions stay with your team.",
}

// Seeds the "agent-landings" collection and renders each page until an editor publishes it.
export const agentLandingContent: Record<string, AgentLandingContent> = {
  "whatsapp-sales": {
    title: "AI sales agent for WhatsApp",
    slug: "whatsapp-sales",
    channel: "whatsapp",
    whatsapp: whatsapp("AI sales agent for WhatsApp"),
    hero: {
      title: "Sell on WhatsApp.",
      accent: "Even at midnight.",
      description:
        "An AI agent that answers every WhatsApp message, recommends from your catalog and closes the sale in the chat.",
      primaryLabel: "Request a demo",
      scrollLabel: "Follow one customer",
    },
    story: {
      contact: "Ana",
      assistant: "Stride",
      site: "stride.shop",
      chapters: [
        {
          time: "Tuesday, 11:40 pm",
          title: "Ana messages at midnight.",
          text: "Your team is asleep. Your WhatsApp isn't.",
          messages: [
            {
              from: "customer",
              text: "Hi! Running shoes for a half marathon? Wide feet, around R$ 600.",
            },
          ],
        },
        {
          time: "Tuesday, 11:40 pm",
          title: "It asks before it sells.",
          text: "Two questions, not a quiz.",
          messages: [
            {
              from: "agent",
              text: "Happy to help! Road or trail? And what size do you usually wear?",
            },
            { from: "customer", text: "Road. Size 38." },
          ],
        },
        {
          time: "Tuesday, 11:41 pm",
          title: "It knows your catalog.",
          text: "Only what's in stock, in her size, at today's price.",
          messages: [
            {
              from: "agent",
              text: "These three fit wide feet and come in 38:",
              showProducts: true,
            },
          ],
        },
        {
          time: "Tuesday, 11:42 pm",
          title: "It handles the doubt.",
          text: "Answers from your product details and return policy.",
          messages: [
            {
              from: "customer",
              text: "Is the Stride Max good for long runs? My last pair hurt after 15 km.",
            },
            {
              from: "agent",
              text: "It has the widest toe box and the most cushioning of the three. And you can return it within 30 days, even after running in it.",
            },
          ],
        },
        {
          time: "Tuesday, 11:44 pm",
          title: "She pays without leaving the chat.",
          text: "No search page. No abandoned cart.",
          messages: [
            { from: "customer", text: "Ok, I'll take the Stride Max." },
            {
              from: "agent",
              text: "Great choice. Pay with Pix or card here: stride.com.br/checkout/48213",
            },
            { from: "event", text: "Order #48213 paid · R$ 579" },
          ],
        },
        {
          time: "Thursday",
          title: "Where's my order?",
          text: "Answered from your store and carrier data.",
          messages: [
            { from: "customer", text: "Is my order arriving today?" },
            {
              from: "agent",
              text: "Yes. It's out for delivery and should arrive before 6 pm.",
            },
          ],
        },
        {
          time: "Saturday",
          title: "Some things need a person.",
          text: "Your team takes over with the full story. Ana repeats nothing.",
          messages: [
            {
              from: "customer",
              text: "They're a bit tight. Can I swap for a 39?",
            },
            {
              from: "event",
              text: "Handed to Marina · order and summary attached",
            },
            {
              from: "human",
              text: "Hi Ana, Marina here. Your 39 ships Monday. Keep the 38 until it arrives.",
            },
          ],
        },
        {
          time: "Next month",
          title: "And she comes back.",
          text: "Opted-in campaigns reach her where she already talks to you.",
          messages: [
            {
              from: "agent",
              text: "Hi Ana! The Tempo Glide you looked at is 15% off this week, in size 39.",
            },
            { from: "customer", text: "Send me the link!" },
            {
              from: "agent",
              text: "Here you go: stride.com.br/checkout/tempo-glide-39",
            },
          ],
        },
      ],
      products: [
        { name: "Stride Max", price: "R$ 579", tone: "leaf" },
        { name: "Tempo Glide", price: "R$ 529", tone: "lilac" },
        { name: "Trail Flex", price: "R$ 599", tone: "peach" },
      ],
    },
    features: {
      title: "Everything behind that chat.",
      accent: "Built in.",
      items: [
        feature.whatsapp,
        feature.catalog,
        feature.handoff,
        feature.knowledge,
        feature.actions,
        feature.leads,
        feature.campaigns,
        feature.guardrails,
        feature.widgets,
        feature.analytics,
      ],
    },
    faq: {
      title: "Questions",
      items: [
        faq.whatsappNumber,
        faq.catalog,
        faq.checkout,
        faq.team,
        faq.control,
        faq.start,
      ],
    },
    cta,
    seo: {
      title: "AI sales agent for WhatsApp",
      description:
        "An AI agent that answers every WhatsApp message, recommends products from your catalog, sends checkout links and hands off to your team with full context.",
    },
  },

  "website-sales": {
    title: "AI sales agent for your website",
    slug: "website-sales",
    channel: "web",
    whatsapp: whatsapp("AI sales agent for websites"),
    hero: {
      title: "Every visitor helped.",
      accent: "Like your best salesperson.",
      description:
        "A chat widget on your store that answers product questions, recommends the right fit and gets shoppers to checkout.",
      primaryLabel: "Request a demo",
      scrollLabel: "Follow one visitor",
    },
    story: {
      contact: "Bruno",
      assistant: "Casa Nove",
      site: "casanove.com.br/sofas",
      chapters: [
        {
          time: "Wednesday, 2:15 pm",
          title: "Bruno is comparing sofas.",
          text: "Six minutes on the page. One question away from leaving.",
          messages: [
            {
              from: "customer",
              text: "Will the Aurora 3-seater fit a 2.4 m wall?",
            },
          ],
        },
        {
          time: "Wednesday, 2:15 pm",
          title: "It answers with real specs.",
          text: "Dimensions, materials and stock from your catalog.",
          messages: [
            {
              from: "agent",
              text: "Yes. It's 2.18 m wide, so you'd have 11 cm on each side.",
            },
          ],
        },
        {
          time: "Wednesday, 2:16 pm",
          title: "It hears what he didn't ask.",
          text: "A cat changes which sofa is right.",
          messages: [
            { from: "customer", text: "I have a cat. Is linen a bad idea?" },
            {
              from: "agent",
              text: "Linen snags easily. These three use a scratch-resistant fabric:",
              showProducts: true,
            },
          ],
        },
        {
          time: "Wednesday, 2:18 pm",
          title: "It removes the last doubt.",
          text: "Your return policy, quoted at the right moment.",
          messages: [
            {
              from: "customer",
              text: "What if the green looks wrong in my living room?",
            },
            {
              from: "agent",
              text: "You have 30 days to return it, and we pick it up for free.",
            },
          ],
        },
        {
          time: "Wednesday, 2:19 pm",
          title: "He checks out.",
          text: "From question to order without opening another tab.",
          messages: [
            { from: "customer", text: "Ok. The Lumen in moss green." },
            {
              from: "agent",
              text: "Added to your cart. Checkout is one click away.",
            },
            { from: "event", text: "Order #7731 paid · R$ 4.290" },
          ],
        },
        {
          time: "Wednesday, 2:21 pm",
          title: "It gets the details right.",
          text: "Delivery details collected in the chat, saved to his order.",
          messages: [
            {
              from: "agent",
              text: "Which floor do you live on, and is there an elevator?",
            },
            { from: "customer", text: "8th floor. Small elevator." },
          ],
        },
        {
          time: "Wednesday, 2:22 pm",
          title: "Delivery needs a person.",
          text: "Your team gets the order, the building and the conversation.",
          messages: [
            { from: "customer", text: "Can you deliver on Saturday?" },
            {
              from: "event",
              text: "Handed to Carla · order and building details attached",
            },
            {
              from: "human",
              text: "Hi Bruno, Carla here. Saturday works. We'll bring it unassembled for the elevator.",
            },
          ],
        },
      ],
      products: [
        { name: "Lumen", price: "R$ 4.290", tone: "leaf" },
        { name: "Aurora Pro", price: "R$ 4.890", tone: "lilac" },
        { name: "Rio", price: "R$ 3.650", tone: "peach" },
      ],
    },
    features: {
      title: "Everything behind that widget.",
      accent: "Built in.",
      items: [
        feature.website,
        feature.catalog,
        feature.knowledge,
        feature.handoff,
        feature.actions,
        feature.widgets,
        feature.leads,
        { ...feature.guardrails, size: "wide" },
        feature.analytics,
      ],
    },
    faq: {
      title: "Questions",
      items: [
        faq.websiteInstall,
        faq.catalog,
        faq.checkout,
        faq.team,
        faq.control,
        faq.start,
      ],
    },
    cta,
    seo: {
      title: "AI sales agent for your website",
      description:
        "A chat widget that answers product questions, recommends from your catalog and gets shoppers to checkout, with a handoff to your team.",
    },
  },

  "whatsapp-support": {
    title: "AI support agent for WhatsApp",
    slug: "whatsapp-support",
    channel: "whatsapp",
    whatsapp: whatsapp("AI support agent for WhatsApp"),
    hero: {
      title: "Support on WhatsApp.",
      accent: "Solved in the chat.",
      description:
        "An AI agent that answers on WhatsApp from your policies, checks your systems and brings in your team when it should.",
      primaryLabel: "Request a demo",
      scrollLabel: "Follow one customer",
    },
    story: {
      contact: "Lucas",
      assistant: "Stride",
      site: "stride.shop",
      chapters: [
        {
          time: "Monday, 9:12 am",
          title: "Lucas can't find his package.",
          text: "He messages the number on his receipt.",
          messages: [
            {
              from: "customer",
              text: "It says delivered, but nothing's here. Order #50771.",
            },
          ],
        },
        {
          time: "Monday, 9:12 am",
          title: "It checks before it answers.",
          text: "Order and carrier data, not a canned reply.",
          messages: [
            {
              from: "event",
              text: "Looked up order #50771 · delivered 8:40 am to front desk",
            },
            {
              from: "agent",
              text: "The carrier left it at your building's front desk at 8:40. Could you check there?",
            },
          ],
        },
        {
          time: "Monday, 11:05 am",
          title: "It keeps the thread.",
          text: "Two hours later, nothing to explain again.",
          messages: [
            { from: "customer", text: "Front desk doesn't have it." },
            {
              from: "agent",
              text: "Sorry about that. I'll open a claim with the carrier.",
            },
          ],
        },
        {
          time: "Monday, 11:06 am",
          title: "It asks once.",
          text: "Everything the claim needs, collected in one go.",
          messages: [
            {
              from: "agent",
              text: "Is your address still Rua Harmonia, 120, apt 42?",
            },
            { from: "customer", text: "Yes, that's it." },
            { from: "event", text: "Claim CLM-2291 opened" },
          ],
        },
        {
          time: "Wednesday",
          title: "Policies, not guesses.",
          text: "Answers come from your own return and replacement rules.",
          messages: [
            { from: "customer", text: "Can I just get a replacement?" },
            {
              from: "agent",
              text: "Yes. Lost packages get a free replacement under our policy. It ships today.",
            },
          ],
        },
        {
          time: "Wednesday",
          title: "It knows when to step back.",
          text: "Frustration goes to a person, with the whole story attached.",
          messages: [
            {
              from: "customer",
              text: "This is the second time this happened.",
            },
            {
              from: "event",
              text: "Handed to Rafael · priority, history attached",
            },
            {
              from: "human",
              text: "Lucas, Rafael here. I'm sorry. Your next shipping is on us, and I'll track this one myself.",
            },
          ],
        },
        {
          time: "Friday",
          title: "It closes the loop.",
          text: "The conversation ends when the problem does.",
          messages: [
            {
              from: "agent",
              text: "Your replacement was delivered at 10:20. Is everything ok?",
            },
            { from: "customer", text: "All good. Thanks!" },
            { from: "event", text: "Ticket closed" },
          ],
        },
      ],
      products: [],
    },
    features: {
      title: "Support that scales.",
      accent: "Without the queue.",
      items: [
        feature.whatsapp,
        feature.actions,
        feature.knowledge,
        feature.handoff,
        supportGuardrails,
        feature.widgets,
        feature.analytics,
      ],
    },
    faq: {
      title: "Questions",
      items: [
        faq.whatsappNumber,
        faq.answers,
        faq.handoff,
        faq.team,
        faq.control,
        faq.start,
      ],
    },
    cta: { ...cta, title: "See it with your policies." },
    seo: {
      title: "AI support agent for WhatsApp",
      description:
        "An AI support agent on WhatsApp that answers from your policies, looks up orders in your systems and hands off to your team with full context.",
    },
  },

  "website-support": {
    title: "AI support agent for your website",
    slug: "website-support",
    channel: "web",
    whatsapp: whatsapp("AI support agent for websites"),
    hero: {
      title: "Answers before tickets.",
      accent: "Right on your website.",
      description:
        "A help widget that troubleshoots, checks orders and warranties, and hands exceptions to your team.",
      primaryLabel: "Request a demo",
      scrollLabel: "Follow one customer",
    },
    story: {
      contact: "Sofia",
      assistant: "Volt help",
      site: "volt.com.br/help",
      chapters: [
        {
          time: "Sunday, 8:30 pm",
          title: "Sofia's headphones won't pair.",
          text: "Sunday night. Your support team is off.",
          messages: [
            {
              from: "customer",
              text: "My Volt Air won't connect to my laptop.",
            },
          ],
        },
        {
          time: "Sunday, 8:30 pm",
          title: "It asks the right question.",
          text: "The fix depends on the device, so it checks first.",
          messages: [
            {
              from: "agent",
              text: "Sorry about that. Which laptop are you using?",
            },
            { from: "customer", text: "A MacBook Air." },
          ],
        },
        {
          time: "Sunday, 8:31 pm",
          title: "It troubleshoots step by step.",
          text: "One instruction at a time, from your help center.",
          messages: [
            {
              from: "agent",
              text: "Let's reset them. Hold the power button for 10 seconds, until the light blinks white.",
            },
            { from: "customer", text: "Done. Still nothing." },
          ],
        },
        {
          time: "Sunday, 8:33 pm",
          title: "It checks the warranty.",
          text: "Order data, not a form asking for it.",
          messages: [
            {
              from: "event",
              text: "Looked up order #31190 · bought 4 months ago",
            },
            {
              from: "agent",
              text: "Your Volt Air is under warranty until March. I can start a replacement.",
            },
          ],
        },
        {
          time: "Sunday, 8:34 pm",
          title: "It collects what's needed.",
          text: "A form in the chat, not an email thread.",
          messages: [
            { from: "customer", text: "Yes, please." },
            {
              from: "agent",
              text: "Please confirm your shipping address in the form below.",
            },
            {
              from: "event",
              text: "Address confirmed · replacement requested",
            },
          ],
        },
        {
          time: "Sunday, 8:36 pm",
          title: "Exceptions go to your team.",
          text: "Refunds stay a human decision, with the case already built.",
          messages: [
            {
              from: "customer",
              text: "Actually, could I get a refund instead?",
            },
            {
              from: "event",
              text: "Handed to Nina · warranty, steps tried and order attached",
            },
          ],
        },
        {
          time: "Monday, 9:05 am",
          title: "Monday starts solved.",
          text: "Your team picks up a ready case, not a new ticket.",
          messages: [
            {
              from: "human",
              text: "Hi Sofia, Nina here. Your refund is approved. You'll see it within 3 business days.",
            },
            { from: "customer", text: "Perfect, thank you!" },
          ],
        },
      ],
      products: [],
    },
    features: {
      title: "Support that scales.",
      accent: "Without the queue.",
      items: [
        feature.website,
        feature.actions,
        feature.knowledge,
        feature.handoff,
        supportGuardrails,
        feature.widgets,
        feature.analytics,
      ],
    },
    faq: {
      title: "Questions",
      items: [
        faq.websiteInstall,
        faq.answers,
        faq.handoff,
        faq.team,
        faq.control,
        faq.start,
      ],
    },
    cta: { ...cta, title: "See it with your help center." },
    seo: {
      title: "AI support agent for your website",
      description:
        "A help widget that troubleshoots from your help center, checks orders and warranties, and hands exceptions to your team with full context.",
    },
  },

  "product-guidance": {
    title: "AI product guidance agent",
    slug: "product-guidance",
    channel: "app",
    whatsapp: whatsapp("AI product guidance agent"),
    hero: {
      title: "Every user onboarded.",
      accent: "Right inside your product.",
      description:
        "An AI agent that lives in your app, answers from your docs and shows users exactly where to click.",
      primaryLabel: "Request a demo",
      scrollLabel: "Follow one user",
    },
    story: {
      contact: "Julia",
      assistant: "Ledgerly guide",
      site: "app.ledgerly.com",
      chapters: [
        {
          time: "Day 1",
          title: "Julia just signed up.",
          text: "No onboarding call. No 40-page help center.",
          messages: [
            {
              from: "customer",
              text: "How do I bring in my bank transactions?",
            },
          ],
        },
        {
          time: "Day 1",
          title: "It shows, not tells.",
          text: "The guide points at the exact button in your UI.",
          messages: [
            {
              from: "agent",
              text: "Click Import in the top right. I've highlighted it for you.",
              highlight: true,
            },
            { from: "event", text: "Julia connected her bank account" },
          ],
        },
        {
          time: "Day 1",
          title: "It explains the screen.",
          text: "Your product's words, explained in hers.",
          messages: [
            { from: "customer", text: "What does Unreconciled mean?" },
            {
              from: "agent",
              text: "Transactions from your bank that aren't matched to a record yet. You have 12, mostly card payments.",
            },
          ],
        },
        {
          time: "Day 3",
          title: "It knows her account.",
          text: "Answers use her own data, not a generic article.",
          messages: [
            {
              from: "customer",
              text: "Why doesn't my report match my bank balance?",
            },
            {
              from: "agent",
              text: "Two transactions from March 2 aren't categorized yet. Want me to open them?",
            },
          ],
        },
        {
          time: "Day 3",
          title: "It does the clicks for her.",
          text: "Actions run in your product, when she asks.",
          messages: [
            { from: "customer", text: "Yes, please." },
            { from: "event", text: "Opened 2 uncategorized transactions" },
          ],
        },
        {
          time: "Day 7",
          title: "It grows with her team.",
          text: "New questions as she uses more of the product.",
          messages: [
            { from: "customer", text: "How do I invite my accountant?" },
            {
              from: "agent",
              text: "Go to Settings → Members. I've opened it. Pick the Viewer role so he only sees reports.",
            },
            { from: "event", text: "Opened Settings → Members" },
          ],
        },
        {
          time: "Day 12",
          title: "Some questions are for sales.",
          text: "Upgrade intent goes to your team, with usage attached.",
          messages: [
            {
              from: "customer",
              text: "Can we add five more seats and SSO?",
            },
            {
              from: "event",
              text: "Handed to Pedro · account and usage summary attached",
            },
            {
              from: "human",
              text: "Hi Julia, Pedro here. SSO is on the Business plan. I'll send you a quote today.",
            },
          ],
        },
      ],
      products: [],
    },
    features: {
      title: "A guide inside your app.",
      accent: "Not a link to the docs.",
      items: [
        {
          title: "Lives in your product.",
          text: "Answers, guidance and actions where users already work.",
          visual: "inproduct",
          size: "large",
        },
        {
          title: "Points at the right button.",
          text: "Client-side actions highlight what users need next.",
          visual: "spotlight",
          size: "wide",
        },
        { ...feature.knowledge, text: "Your help center, without the search." },
        {
          ...feature.actions,
          title: "Acts in your app.",
          text: "Runs client-side actions and calls your APIs.",
          size: "regular",
        },
        {
          ...feature.handoff,
          text: "Sales and support get the account and the conversation.",
        },
        {
          ...feature.guardrails,
          text: "Billing changes and deletions stay with your team.",
        },
        {
          ...feature.analytics,
          text: "Replay real sessions as tests, then track what it resolves.",
        },
      ],
    },
    faq: {
      title: "Questions",
      items: [
        faq.productInstall,
        faq.productActions,
        faq.productData,
        faq.team,
        faq.control,
        faq.start,
      ],
    },
    cta: { ...cta, title: "See it inside your product." },
    seo: {
      title: "AI product guidance agent inside your app",
      description:
        "An in-product AI agent that onboards users, points at the right button, acts in your app and hands upgrade intent to your team.",
    },
  },
}

export const agentLandingSlugs = Object.keys(agentLandingContent)

export function whatsappHref({
  number,
  message,
}: AgentLandingContent["whatsapp"]) {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`
}

// Brazilian numbers read as +55 11 5199-5330; other countries keep the raw digits.
export function formatWhatsappNumber(number: string) {
  const brazil = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(number)
  return brazil ? `+55 ${brazil[1]} ${brazil[2]}-${brazil[3]}` : `+${number}`
}
