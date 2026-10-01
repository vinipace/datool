"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { Notice } from "@/components/ui/notice"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogFooter,
} from "@/components/ui/dialog"
import { collectionTable } from "@/components/tracer/collection-table-styles"

export function UiReference() {
  const [checked, setChecked] = useState(false)
  return (
    <main className="min-h-svh bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto grid max-w-5xl gap-6">
        <header>
          <h1 className="text-xl font-semibold">UI reference</h1>
          <p className="mt-2 text-sm text-foreground-muted">
            Development reference for the Traces visual standard. Examples use
            local state only.
          </p>
        </header>
        <Card>
          <CardHeader>
            <CardTitle>Controls</CardTitle>
            <CardDescription>
              Tab through controls to review focus. Hover each button to review
              feedback.
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-4 grid gap-4">
            <div className="flex flex-wrap gap-2">
              <Button>Primary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
              <Button disabled>Disabled</Button>
              <Button loading>Loading</Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm">
                Name
                <Input placeholder="Integration name" />
              </label>
              <label className="grid gap-2 text-sm">
                Disabled field
                <Input disabled placeholder="Unavailable" />
              </label>
              <label className="grid gap-2 text-sm">
                Invalid field
                <Input
                  invalid
                  defaultValue="Invalid example"
                  aria-describedby="invalid-help"
                />
                <span id="invalid-help" className="text-xs text-destructive">
                  Enter a valid value.
                </span>
              </label>
              <label className="grid content-start gap-2 text-sm">
                Expiration
                <Select defaultValue="90">
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </Select>
              </label>
              <label className="grid gap-2 text-sm sm:col-span-2">
                Notes
                <Textarea placeholder="Optional notes" />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-5">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={checked} onCheckedChange={setChecked} />
                Example switch
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox />
                Example checkbox
              </label>
            </div>
          </CardContent>
        </Card>
        <section
          aria-label="Feedback states"
          className="grid gap-3 sm:grid-cols-2"
        >
          <Notice variant="info" title="Information">
            Integration settings are scoped to your organization.
          </Notice>
          <Notice variant="success" title="Success">
            Your changes were saved.
          </Notice>
          <Notice variant="warning" title="Refresh delayed">
            Previously loaded rows remain visible.
          </Notice>
          <Notice variant="error" title="Unable to load" role="alert">
            Try again after checking your connection.
          </Notice>
        </section>
        <section className="min-w-0" aria-label="Table reference">
          <h2 className="mb-3 text-base font-semibold">Trace table surfaces</h2>
          <div className="overflow-x-auto">
            <table className={`${collectionTable.table} min-w-[480px]`}>
              <thead className={collectionTable.head}>
                <tr>
                  <th className={collectionTable.heading}>Trace</th>
                  <th className={collectionTable.heading}>Status</th>
                  <th className={collectionTable.heading}>Latency</th>
                </tr>
              </thead>
              <tbody>
                <tr className={collectionTable.row} tabIndex={0}>
                  <td className={collectionTable.cell}>Document summary</td>
                  <td className={`${collectionTable.cell} text-success`}>Completed</td>
                  <td className={`${collectionTable.cell} text-foreground-muted`}>
                    1.2s
                  </td>
                </tr>
                <tr className={collectionTable.row} data-selected="true" tabIndex={0}>
                  <td className={collectionTable.cell}>Selected trace</td>
                  <td className={collectionTable.cell}>Completed</td>
                  <td className={collectionTable.cell}>850ms</td>
                </tr>
                <tr className={collectionTable.row} tabIndex={0}>
                  <td className={collectionTable.cell}>Failed request</td>
                  <td className={`${collectionTable.cell} text-destructive`}>Error</td>
                  <td className={collectionTable.cell}>
                    <span data-empty="true">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="py-6 text-center text-sm text-foreground-muted">
            Empty state: No matching traces. Try changing the filter.
          </p>
        </section>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" className="justify-self-start">
              Open example dialog
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>Example dialog</DialogTitle>
            <DialogDescription>
              Check focus trapping, Escape, the overlay and mobile sizing. This
              example does not save data.
            </DialogDescription>
            <label className="grid gap-2 text-sm">
              Example name
              <Input placeholder="Example" />
            </label>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button>Done</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  )
}
