import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Bot, Braces, Wrench } from "lucide-react"
import { KindIcon } from "./kind-icon"

function KindIconGallery() {
  return (
    <div className="flex items-center gap-4">
      <KindIcon icon={Bot} label="Agent" />
      <KindIcon icon={Braces} label="Function" />
      <KindIcon icon={Wrench} label="Tool" />
      <KindIcon icon={Braces} />
    </div>
  )
}

const meta = {
  title: "UI/KindIcon",
  component: KindIcon,
  render: () => <KindIconGallery />,
} satisfies Meta<typeof KindIcon>

export default meta
type Story = StoryObj<typeof KindIconGallery>

export const LabeledAndDecorative: Story = {}
