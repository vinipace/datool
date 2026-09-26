import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { ReviewerCombobox } from "./reviewer-combobox"

const reviewers = [
  { id: "alex", name: "Alex Morgan", email: "alex@example.test", image: null },
  { id: "jamie", name: "Jamie Lee", email: "jamie@example.test", image: null },
  { id: "sam", name: "Sam Chen", email: "sam@example.test", image: null },
  {
    id: "robin",
    name: "Robin Hayes",
    email: "robin@example.test",
    image: null,
  },
]
const meta = {
  title: "UI/ReviewerCombobox",
  component: ReviewerCombobox,
  args: { reviewers, value: ["alex"], onValueChange: () => {} },
  render: function Example(args) {
    const [value, setValue] = useState(args.value)
    return <ReviewerCombobox {...args} value={value} onValueChange={setValue} />
  },
} satisfies Meta<typeof ReviewerCombobox>
export default meta
type Story = StoryObj<typeof meta>

export const SearchAndSelect: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    const picker = canvas.getByRole("combobox", {
      name: "Reviewers",
    })
    await userEvent.click(picker)
    const search = await body.findByRole("combobox", {
      name: "Search reviewers",
    })
    await userEvent.type(search, "nobody")
    await expect(body.getByText("No options found.")).toBeVisible()
    await userEvent.clear(search)
    await userEvent.type(search, "jamie@example.test")
    await userEvent.keyboard("{ArrowDown}{Enter}{Escape}")
    await expect(picker).toHaveAttribute(
      "aria-description",
      "Alex Morgan, Jamie Lee"
    )
    await userEvent.click(picker)
    await userEvent.click(
      await body.findByRole("option", { name: /Alex Morgan/ })
    )
    await userEvent.keyboard("{Escape}")
    await expect(picker).toHaveAttribute("aria-description", "Jamie Lee")
    await expect(picker.querySelectorAll("button")).toHaveLength(0)
  },
}
export const ManyReviewers: Story = {
  args: { value: reviewers.map((reviewer) => reviewer.id) },
  play: async ({ canvasElement }) => {
    const picker = within(canvasElement).getByRole("combobox", {
      name: "Reviewers",
    })
    await expect(
      picker.querySelectorAll('[data-slot="user-avatar"]')
    ).toHaveLength(3)
    await expect(picker).toHaveTextContent("+1")
  },
}
export const Unassigned: Story = { args: { value: [] } }
export const Empty: Story = {
  args: { reviewers: [], value: [] },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("combobox", {
        name: "Reviewers",
      })
    )
    await expect(
      await within(document.body).findByText("No options found.")
    ).toBeVisible()
  },
}
export const Disabled: Story = { args: { disabled: true } }
