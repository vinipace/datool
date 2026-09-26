import { expect, spyOn, userEvent, waitFor, within } from "storybook/test"

/** Exercise the shared navigation/data-control boundary in real resource stories. */
export async function checkCollectionPanel(
  canvasElement: HTMLElement,
  label: string
) {
  const canvas = within(canvasElement)
  const header = canvas.getByRole("banner", { name: "Page controls" })
  const controls = await canvas.findByRole("group", {
    name: `${label} controls`,
  })
  await expect(within(header).queryByRole("search")).not.toBeInTheDocument()
  await expect(within(header).queryByRole("textbox")).not.toBeInTheDocument()
  await expect(
    within(header).queryByRole("button", { name: "Refresh" })
  ).not.toBeInTheDocument()
  await expect(
    within(header).queryByRole("button", { name: "Display" })
  ).not.toBeInTheDocument()
  await expect(controls.getBoundingClientRect().top).toBeCloseTo(
    header.getBoundingClientRect().bottom,
    0
  )
  await expect(controls.getBoundingClientRect().height).toBeLessThan(60)
  const display = await within(controls).findByRole("button", {
    name: "Display",
  })
  await expect(canvas.getAllByRole("button", { name: "Display" })).toHaveLength(
    1
  )
  await userEvent.click(display)
  const menu = await within(canvasElement.ownerDocument.body).findByRole("menu")
  await expect(
    within(menu).getAllByRole("menuitemcheckbox").length
  ).toBeGreaterThan(0)
  await userEvent.keyboard("{Escape}")
  await expect(display).toHaveFocus()
}

export async function checkCompactCollectionPanel(
  canvasElement: HTMLElement,
  label: string
) {
  await checkCollectionPanel(canvasElement, label)
  const controls = within(canvasElement).getByRole("group", {
    name: `${label} controls`,
  })
  await expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth)
  const surface = controls.querySelector<HTMLElement>(
    '[data-slot="filter-bar-surface"]'
  )
  if (surface) {
    const input =
      within(controls).queryByRole("combobox", {
        name: "Filter expression",
      }) ?? within(controls).getByRole("textbox")
    await userEvent.click(surface.querySelector("svg")!)
    await waitFor(() => expect(input).toHaveFocus())
    await expect(surface.getBoundingClientRect().width).toBeCloseTo(
      controls.clientWidth - 24,
      0
    )
  }
  const menuTrigger = within(controls).getByRole("button", {
    name: "More actions",
  })
  await userEvent.click(menuTrigger)
  await expect(
    within(controls).queryByRole("button", { name: "Refresh" })
  ).not.toBeInTheDocument()
  const menu = await within(canvasElement.ownerDocument.body).findByRole("menu")
  await expect(
    within(menu).getByRole("menuitem", { name: "Refresh" })
  ).toBeVisible()
  if (surface)
    await expect(surface.getBoundingClientRect().width).toBeLessThan(
      controls.clientWidth - 24
    )
  await userEvent.keyboard("{Escape}")
}

/** Selection replaces normal controls, exports checked rows, and restores the same filter. */
export async function checkCollectionSelection(
  canvasElement: HTMLElement,
  label: string
) {
  const canvas = within(canvasElement)
  const controls = await canvas.findByRole("group", {
    name: `${label} controls`,
  })
  const filter = controls.querySelector("input")
  const filterValue = filter?.value
  const all = await canvas.findByRole("checkbox", { name: /^Select all/ })
  await waitFor(() => expect(all).toBeEnabled())
  const rows = canvas
    .getAllByRole("checkbox", { name: /^Select / })
    .filter((input) => input !== all)
  const first = rows[0]
  first.focus()
  await userEvent.keyboard(" ")
  await expect(first).toBeChecked()
  await expect(first).toHaveFocus()
  const selected = await within(controls).findByRole("group", {
    name: "Selected row actions",
  })
  await expect(
    within(selected).getByRole("button", {
      name: "Clear selection (1 selected)",
    })
  ).toBeVisible()
  await expect(
    within(controls).queryByRole("button", { name: "Display" })
  ).not.toBeInTheDocument()
  await expect(
    within(controls).queryByRole("button", { name: "More actions" })
  ).not.toBeInTheDocument()
  if (filter) await expect(filter).not.toBeVisible()
  await expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth)
  await expect(controls.getBoundingClientRect().height).toBeLessThan(60)

  const createUrl = spyOn(URL, "createObjectURL")
  const download = spyOn(
    HTMLAnchorElement.prototype,
    "click"
  ).mockImplementation(() => {})
  try {
    await userEvent.click(
      within(selected).getByRole("button", { name: "Export JSON" })
    )
    const blob = createUrl.mock.calls.at(-1)?.[0] as Blob
    const exported = JSON.parse(await blob.text())
    await expect(exported).toHaveLength(1)
    await expect(download).toHaveBeenCalledTimes(1)
    await expect(
      (download.mock.contexts[0] as HTMLAnchorElement).download
    ).toMatch(/^datool-selected-.+\.json$/)
  } finally {
    createUrl.mockRestore()
    download.mockRestore()
  }
  await userEvent.click(
    within(selected).getByRole("button", {
      name: "Clear selection (1 selected)",
    })
  )
  await expect(first).not.toBeChecked()
  if (filter) {
    await expect(filter).toBeVisible()
    await expect(controls.querySelector("input")).toBe(filter)
    await expect(filter).toHaveValue(filterValue)
  }
  await userEvent.click(all)
  await expect(all).toBeChecked()
  await expect(
    within(controls).getByRole("button", {
      name: `Clear selection (${rows.length} selected)`,
    })
  ).toBeVisible()
  await userEvent.click(all)
  await expect(
    within(controls).queryByRole("group", { name: "Selected row actions" })
  ).not.toBeInTheDocument()
  if (filter) await expect(filter).toBeVisible()
}
