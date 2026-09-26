import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"

const meta = {
  title: "UI/Tabs",
  component: Tabs,
  render: () => (
    <Tabs defaultValue="traces" className="w-96">
      <TabsList aria-label="Trace detail sections">
        <TabsTrigger value="traces">Traces</TabsTrigger>
        <TabsTrigger value="evaluations">Evaluations</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="traces" className="pt-4 text-sm">
        18 traces captured today.
      </TabsContent>
      <TabsContent value="evaluations" className="pt-4 text-sm">
        3 evaluator runs are complete.
      </TabsContent>
      <TabsContent value="settings" className="pt-4 text-sm">
        Configure capture and retention.
      </TabsContent>
    </Tabs>
  ),
} satisfies Meta<typeof Tabs>

export default meta
type Story = StoryObj<typeof meta>

export const SwitchPanels: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("tab", { name: "Evaluations" }))
    await expect(
      canvas.getByText("3 evaluator runs are complete.")
    ).toBeVisible()
  },
}

export const Underline: Story = {
  render: () => (
    <Tabs defaultValue="auto" className="w-full max-w-md">
      <div className="border-b border-border">
        <TabsList variant="underline" aria-label="Setup method">
          <TabsTrigger value="auto">Auto</TabsTrigger>
          <TabsTrigger value="manual">Manual</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="auto" className="pt-4 text-sm">
        Set up with your coding agent.
      </TabsContent>
      <TabsContent value="manual" className="pt-4 text-sm">
        Configure your application manually.
      </TabsContent>
    </Tabs>
  ),
}
