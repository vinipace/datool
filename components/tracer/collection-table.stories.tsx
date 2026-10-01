import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { traceRows } from "../../.storybook/scenarios/traces/fixtures"
import { UserAvatarImage } from "../ui/user-avatar"
import { collectionTable } from "./collection-table-styles"
import { PercentageCell } from "./percentage-cell"
import {
  CollectionRow,
  CollectionRowSelection,
  CollectionSelectAll,
  CollectionTable,
  CollectionTableBody,
} from "./collection-table"

function CollectionTableExample() {
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const allChecked = selected.size === traceRows.length
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <StorybookProjectFrame title="Trace table">
      <div className="min-h-0 flex-1">
        <CollectionTable
          selectionActions={<span>{selected.size} selected</span>}
          columnIds={["name", "status", "reviewer", "score"]}
          widths={[260, 160, 160, 120]}
        >
          <caption className="sr-only">Trace rows</caption>
          <thead className={collectionTable.head}>
            <tr>
              <th className="px-3" scope="col">
                <CollectionSelectAll
                  checked={allChecked}
                  disabled={false}
                  label="Select all trace rows"
                  onChange={() =>
                    setSelected(
                      allChecked
                        ? new Set()
                        : new Set(traceRows.map((row) => row.id))
                    )
                  }
                  partial={selected.size > 0 && !allChecked}
                />
              </th>
              <th className={collectionTable.heading} scope="col">
                Name
              </th>
              <th className={collectionTable.heading} scope="col">
                Status
              </th>
              <th className={collectionTable.heading} scope="col">
                Reviewer
              </th>
              <th className={collectionTable.heading} scope="col">
                Score
              </th>
            </tr>
          </thead>
          <CollectionTableBody rows={traceRows}>
            {(trace, index) => (
              <CollectionRow key={trace.id} rowLabel={trace.name}>
                <CollectionRowSelection
                  checked={selected.has(trace.id)}
                  index={index}
                  label={`Select ${trace.name}`}
                  onChange={() => toggle(trace.id)}
                />
                <td className={collectionTable.cell}>{trace.name}</td>
                <td className={collectionTable.cell}>{trace.status}</td>
                <td className={collectionTable.cell}>
                  <span className="flex items-center gap-2">
                    <UserAvatarImage name="Alex" image={null} />
                    Alex
                  </span>
                </td>
                <td className={collectionTable.cell}>
                  <PercentageCell value={index === 0 ? 0.34 : 0.45} />
                </td>
              </CollectionRow>
            )}
          </CollectionTableBody>
        </CollectionTable>
      </div>
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/CollectionTable",
  component: CollectionTable,
  parameters: { layout: "fullscreen" },
  render: () => <CollectionTableExample />,
} satisfies Meta<typeof CollectionTable>

export default meta
type Story = StoryObj<typeof CollectionTableExample>

export const TableAndCardControls: Story = {
  name: "Display modes",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const all = canvas.getByRole("checkbox", { name: "Select all trace rows" })
    await expect(all.closest("th")).not.toBeNull()
    await expect(canvas.getAllByRole("checkbox", { name: "Select all trace rows" })).toHaveLength(1)
    await userEvent.click(all)
    await expect(all).toBeChecked()
    await expect(canvas.getByText(`${traceRows.length} selected`)).toBeVisible()
    await userEvent.click(canvas.getByRole("checkbox", { name: `Select ${traceRows[0].name}` }))
    await expect(all).toBePartiallyChecked()
    await userEvent.click(all)
    await userEvent.click(all)
    await expect(canvas.getByText("0 selected")).toBeVisible()
    await userEvent.click(
      await canvas.findByRole("button", { name: "Display" })
    )
    await expect(
      body.getByRole("menuitemradio", { name: "Card" })
    ).toBeVisible()
    await expect(body.getByRole("menuitemradio", { name: "Compact" })).toBeChecked()
    await userEvent.click(body.getByRole("menuitemradio", { name: "Tall" }))
    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    await expect(body.getByRole("menuitemradio", { name: "Tall" })).toBeChecked()
    await userEvent.click(body.getByRole("menuitemradio", { name: "Card" }))
    await expect(canvas.getByLabelText("Collection cards scroll area")).toBeVisible()
    const cardSelectAll = canvas.getByRole("checkbox", { name: "Select all trace rows" })
    await expect(cardSelectAll.closest("th")).toBeNull()
    await userEvent.click(cardSelectAll)
    await expect(canvas.getByText(`${traceRows.length} selected`)).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    await userEvent.click(body.getByRole("menuitemradio", { name: "Compact" }))
    await expect(canvas.getByLabelText("Collection table scroll area")).toBeVisible()
    const restoredSelectAll = canvas.getByRole("checkbox", { name: "Select all trace rows" })
    await expect(restoredSelectAll.closest("th")).not.toBeNull()
    await expect(restoredSelectAll).toBeChecked()
    await userEvent.click(restoredSelectAll)
    for (const row of canvasElement.querySelectorAll("tbody tr.collection-table-row")) {
      await expect(row.getBoundingClientRect().height).toBe(40)
      for (const content of row.querySelectorAll('[data-slot="user-avatar"], [data-slot="percentage-cell"]')) {
        const cell = content.closest("td")!
        const clip = cell.firstElementChild!.getBoundingClientRect()
        const bounds = content.getBoundingClientRect()
        await expect(bounds.top).toBeGreaterThanOrEqual(clip.top)
        await expect(bounds.bottom).toBeLessThanOrEqual(clip.bottom)
      }
      const textCell = row.querySelectorAll("td")[1].firstElementChild!
      await expect(textCell.getBoundingClientRect().height).toBe(20)
    }
  },
}
