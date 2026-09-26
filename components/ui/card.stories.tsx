import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Button } from "./button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card"

const meta = {
  title: "UI/Card",
  component: Card,
  render: () => (
    <Card className="w-96">
      <CardHeader>
        <CardTitle>Trace retention</CardTitle>
        <CardDescription>
          Keep detailed invocation data available for your team.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-foreground-muted">
        Traces are retained for 30 days on this project.
      </CardContent>
      <CardFooter>
        <Button size="sm">Manage retention</Button>
        <Button size="sm" variant="ghost-muted">
          Learn more
        </Button>
      </CardFooter>
    </Card>
  ),
} satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const ContentOnly: Story = {
  render: () => (
    <Card className="w-80">
      <CardContent className="pt-5 text-sm">
        No traces have been captured yet.
      </CardContent>
    </Card>
  ),
}
