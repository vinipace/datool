import type { AgentAppearance } from "@/src/lib/build/contracts"

export const agentAvatarColors = {
  orange: {
    label: "Orange",
    className: "bg-avatar-orange",
    preview: "bg-avatar-orange/20 [&_[data-bubble]]:bg-avatar-orange",
    artwork: "text-avatar-orange",
    lightInk: false,
  },
  violet: {
    label: "Violet",
    className: "bg-avatar-violet",
    preview: "bg-avatar-violet/20 [&_[data-bubble]]:bg-avatar-violet",
    artwork: "text-avatar-violet",
    lightInk: false,
  },
  blue: {
    label: "Blue",
    className: "bg-avatar-blue",
    preview: "bg-avatar-blue/20 [&_[data-bubble]]:bg-avatar-blue",
    artwork: "text-avatar-blue",
    lightInk: false,
  },
  green: {
    label: "Green",
    className: "bg-avatar-green",
    preview: "bg-avatar-green/20 [&_[data-bubble]]:bg-avatar-green",
    artwork: "text-avatar-green",
    lightInk: false,
  },
  rose: {
    label: "Rose",
    className: "bg-avatar-rose",
    preview: "bg-avatar-rose/20 [&_[data-bubble]]:bg-avatar-rose",
    artwork: "text-avatar-rose",
    lightInk: false,
  },
  yellow: {
    label: "Yellow",
    className: "bg-avatar-yellow",
    preview: "bg-avatar-yellow/20 [&_[data-bubble]]:bg-avatar-yellow",
    artwork: "text-avatar-yellow",
    lightInk: false,
  },
  coral: {
    label: "Coral",
    className: "bg-avatar-coral",
    preview: "bg-avatar-coral/20 [&_[data-bubble]]:bg-avatar-coral",
    artwork: "text-avatar-coral",
    lightInk: false,
  },
  lime: {
    label: "Lime",
    className: "bg-avatar-lime",
    preview: "bg-avatar-lime/20 [&_[data-bubble]]:bg-avatar-lime",
    artwork: "text-avatar-lime",
    lightInk: false,
  },
  cyan: {
    label: "Cyan",
    className: "bg-avatar-cyan",
    preview: "bg-avatar-cyan/20 [&_[data-bubble]]:bg-avatar-cyan",
    artwork: "text-avatar-cyan",
    lightInk: false,
  },
  teal: {
    label: "Teal",
    className: "bg-avatar-teal",
    preview: "bg-avatar-teal/20 [&_[data-bubble]]:bg-avatar-teal",
    artwork: "text-avatar-teal",
    lightInk: false,
  },
  cobalt: {
    label: "Cobalt",
    className: "bg-avatar-cobalt",
    preview: "bg-avatar-cobalt/20 [&_[data-bubble]]:bg-avatar-cobalt",
    artwork: "text-avatar-cobalt",
    lightInk: true,
  },
  magenta: {
    label: "Magenta",
    className: "bg-avatar-magenta",
    preview: "bg-avatar-magenta/20 [&_[data-bubble]]:bg-avatar-magenta",
    artwork: "text-avatar-magenta",
    lightInk: false,
  },
  scarlet: {
    label: "Scarlet",
    className: "bg-avatar-scarlet",
    preview: "bg-avatar-scarlet/20 [&_[data-bubble]]:bg-avatar-scarlet",
    artwork: "text-avatar-scarlet",
    lightInk: false,
  },
  midnight: {
    label: "Midnight",
    className: "bg-avatar-midnight",
    preview: "bg-avatar-midnight/20 [&_[data-bubble]]:bg-avatar-midnight",
    artwork: "text-avatar-midnight",
    lightInk: true,
  },
} satisfies Record<
  AgentAppearance["avatarColor"],
  {
    label: string
    className: string
    artwork: string
    lightInk: boolean
    preview: string
  }
>
