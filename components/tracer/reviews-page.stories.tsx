import {
  checkCollectionPanel,
  checkCompactCollectionPanel,
} from "../../.storybook/collection-panel-checks"
import { getRouter, useParams } from "@storybook/nextjs-vite/navigation.mock"
import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import { traceHandlers } from "../../.storybook/scenarios/traces/handlers"
import {
  traceRow,
  traceDetail,
  traceOverview,
  traceSpans,
  envelope,
  list,
} from "../../.storybook/scenarios/traces/fixtures"
import type {
  CreateReviewSession,
  RecordReview,
  ReviewSelection,
  UpdateReviewSession,
  ReviewItemDetail,
  ReviewSessionDetail,
} from "@/src/lib/tracer/reviews"
import type {
  HumanScore,
  HumanScoreCollectionSnapshot,
} from "@/src/lib/tracer/human-scores"
import { humanScoreValueLabel } from "@/src/lib/tracer/human-scores"
import { columnWorkerSource } from "@/src/lib/tracer/column-worker-source"
import { ReviewsPage, ReviewSessionPage } from "./reviews-page"
import { ReviewSessionRoute } from "./review-session-route"
const fields = {
  revision: 1,
  description: "",
  archived: false,
  createdAt: "2026-09-13T12:00:00Z",
  updatedAt: "2026-09-13T12:00:00Z",
}
const definitions: HumanScore[] = [
  {
    ...fields,
    id: "numeric",
    name: "Completeness",
    type: "numeric",
    min: 1,
    max: 5,
    step: 1,
  },
  {
    ...fields,
    id: "single",
    name: "Answer quality",
    type: "categorical",
    multiple: false,
    options: [
      { value: "bad", label: "Needs work" },
      { value: "good", label: "Accurate" },
    ],
  },
  {
    ...fields,
    id: "multiple",
    name: "Issues found",
    type: "categorical",
    multiple: true,
    options: [
      { value: "units", label: "Wrong units" },
      { value: "location", label: "Wrong location" },
      { value: "none", label: "No issues" },
    ],
  },
  {
    ...fields,
    id: "text",
    name: "Suggested response",
    type: "text",
    maxLength: 4000,
  },
]
const collection: HumanScoreCollectionSnapshot = {
  ...fields,
  id: "collection",
  name: "Weather criteria",
  scoreIds: definitions.map((score) => score.id),
  scores: definitions,
}
const session: ReviewSessionDetail = {
  id: "review-storybook",
  number: 354,
  name: "Support prompt quality",
  prompt: "Check the response against the captured evidence.",
  assigneeUserId: "reviewer",
  assigneeName: "Alex Morgan",
  reviewers: [{ id: "reviewer", name: "Alex Morgan", image: null }],
  createdBy: "reviewer",
  createdAt: fields.createdAt,
  updatedAt: fields.updatedAt,
  revision: 1,
  traceCount: 1,
  reviewedCount: 0,
  skippedCount: 0,
  status: "pending",
  collectionId: collection.id,
  collection,
  items: [
    {
      id: "review-item",
      sessionId: "review-storybook",
      traceId: traceRow.id,
      traceName: traceRow.name,
      ordinal: 0,
      notes: "",
      revision: 0,
      reviewedAt: null,
      skippedAt: null,
      reviewedBy: null,
    },
  ],
}
let currentSession: ReviewSessionDetail
let items: Map<string, ReviewItemDetail>
let titleWrites: UpdateReviewSession[]
let creates: CreateReviewSession[]
let writes: RecordReview[]
let failSave = false
let collectionDelay = 0
function reset() {
  currentSession = structuredClone(session)
  writes = []
  titleWrites = []
  creates = []
  failSave = false
  collectionDelay = 0
  items = new Map(
    currentSession.items.map((item) => [
      item.id,
      {
        ...item,
        definitions,
        annotations: [],
        scores: [],
        previousItemId: null,
        nextItemId: null,
      },
    ])
  )
}
reset()
function record(body: RecordReview, item: ReviewItemDetail): ReviewItemDetail {
  const scores =
    body.scores?.map((score, index) => {
      const definition = definitions.find(
        (definition) => definition.id === score.humanScoreId
      )!
      return {
        id: `score-${index}`,
        itemId: item.id,
        traceId: item.traceId,
        scorerId: null,
        scorerRevision: null,
        humanScoreId: definition.id,
        definition,
        name: definition.name,
        value: score.value,
        comment: score.comment ?? "",
        reviewerId: "reviewer",
        reviewerName: "Alex Morgan",
        reviewerImage: null,
        source: "human" as const,
        updatedAt: fields.updatedAt,
      }
    }) ?? item.scores
  const complete =
    scores.length === definitions.length &&
    scores.every((score) => score.value !== null)
  return {
    ...item,
    notes: body.notes ?? item.notes,
    annotations: body.annotations?.map((entry) => ({ ...entry, author: { id: "reviewer", name: "Alex Morgan", image: null }, createdAt: fields.createdAt, updatedAt: fields.updatedAt })) ?? item.annotations,
    revision: body.expectedRevision + 1,
    scores,
    reviewedAt: complete ? fields.updatedAt : null,
    reviewedBy: complete ? "reviewer" : null,
  }
}
const handlers = [
  http.post("/api/reviews", async ({ request }) => {
    const body = (await request.json()) as CreateReviewSession
    creates.push(body)
    return HttpResponse.json(
      envelope({
        ...currentSession,
        id: "created-review",
        number: 355,
        name: body.name?.trim() || "Untitled Review",
      })
    )
  }),
  http.get(`/api/reviews/${session.id}/table`, () =>
    HttpResponse.json(
      envelope({
        ...currentSession,
        scoreColumns: [
          ...new Map(
            [
              ...(currentSession.collection?.scores ?? []),
              ...currentSession.items.flatMap(
                (item) =>
                  items.get(item.id)?.scores.map((score) => score.definition) ??
                  []
              ),
            ].map((score) => [
              score.id,
              { id: score.id, name: score.name, type: score.type },
            ])
          ).values(),
        ],
        scores: currentSession.items.flatMap(
          (item) =>
            items.get(item.id)?.scores.map((score) => ({
              itemId: score.itemId,
              humanScoreId: score.humanScoreId,
              value: score.value,
              valueLabel:
                score.value === null
                  ? null
                  : humanScoreValueLabel(score.definition, score.value),
            })) ?? []
        ),
        traces: currentSession.items.map((item) => ({
          ...traceRow,
          id: item.traceId,
          name: item.traceName,
        })),
      })
    )
  ),
  http.patch(`/api/reviews/${session.id}`, async ({ request }) => {
    const body = (await request.json()) as UpdateReviewSession
    titleWrites.push(body)
    if (body.collectionId !== undefined && collectionDelay)
      await delay(collectionDelay)
    if (failSave)
      return HttpResponse.json(
        { error: { message: "Unable to rename session. Try again." } },
        { status: 503 }
      )
    currentSession = {
      ...currentSession,
      name: body.name?.trim() ?? currentSession.name,
      ...(body.collectionId !== undefined
        ? {
            collectionId: body.collectionId,
            collection: body.collectionId ? collection : null,
          }
        : {}),
      reviewers:
        body.reviewerUserIds?.map((id) => ({
          id,
          name: id === "reviewer" ? "Alex Morgan" : "Jamie Lee",
          image: null,
        })) ?? currentSession.reviewers,
      revision: currentSession.revision + 1,
    }
    return HttpResponse.json(envelope(currentSession))
  }),
  http.patch(`/api/reviews/${session.id}/items`, async ({ request }) => {
    const body = (await request.json()) as ReviewSelection
    if (failSave)
      return HttpResponse.json(
        { error: { message: "Selection changed. Refresh and try again." } },
        { status: 409 }
      )
    const ids = new Set(body.items.map((item) => item.id))
    currentSession.items = currentSession.items.flatMap((item) => {
      if (!ids.has(item.id)) return [item]
      if (body.action === "remove") {
        items.delete(item.id)
        return []
      }
      const saved = {
        ...item,
        skippedAt: body.action === "skip" ? fields.updatedAt : null,
        revision: item.revision + 1,
      }
      items.set(item.id, { ...items.get(item.id)!, ...saved })
      return [saved]
    })
    currentSession.revision++
    currentSession.traceCount = currentSession.items.length
    currentSession.skippedCount = currentSession.items.filter(
      (item) => item.skippedAt
    ).length
    currentSession.reviewedCount = currentSession.items.filter(
      (item) => item.reviewedAt && !item.skippedAt
    ).length
    currentSession.status =
      currentSession.reviewedCount + currentSession.skippedCount ===
      currentSession.traceCount
        ? "completed"
        : "pending"
    return HttpResponse.json(envelope(currentSession))
  }),
  http.get("/api/human-scores", () =>
    HttpResponse.json(
      envelope({ scores: definitions, collections: [collection] })
    )
  ),
  http.put("/api/reviews/:id/items/:itemId", async ({ request, params }) => {
    const body = (await request.json()) as RecordReview
    writes.push(body)
    if (failSave)
      return HttpResponse.json(
        { error: { message: "Unable to save. Try again." } },
        { status: 503 }
      )
    const item = items.get(String(params.itemId))!
    if (item.revision !== body.expectedRevision)
      return HttpResponse.json(
        { error: { message: "Conflict" } },
        { status: 409 }
      )
    const saved = record(body, item)
    items.set(item.id, saved)
    currentSession.items = currentSession.items.map((row) =>
      row.id === saved.id ? saved : row
    )
    currentSession.reviewedCount = currentSession.items.filter(
      (row) => row.reviewedAt
    ).length
    currentSession.status =
      currentSession.reviewedCount === currentSession.traceCount
        ? "completed"
        : currentSession.reviewedCount
          ? "in_progress"
          : "pending"
    return HttpResponse.json(envelope(saved))
  }),
  http.get("/api/reviews", () =>
    HttpResponse.json(
      envelope({ items: [currentSession], total: 1, nextCursor: null })
    )
  ),
  http.get("/api/reviews/options", () =>
    HttpResponse.json(
      envelope({
        members: [
          {
            id: "reviewer",
            name: "Alex Morgan",
            email: "alex@example.test",
            image: null,
          },
          {
            id: "jamie",
            name: "Jamie Lee",
            email: "jamie@example.test",
            image: null,
          },
        ],
        currentUserId: "reviewer",
      })
    )
  ),
  http.get("/api/reviews/:id/items/:itemId", ({ params }) =>
    HttpResponse.json(envelope(items.get(String(params.itemId))))
  ),
  http.get(`/api/reviews/${session.id}`, () =>
    HttpResponse.json(envelope(currentSession))
  ),
  http.get("/api/traces/second-trace", () =>
    HttpResponse.json(envelope(traceDetail))
  ),
  http.get("/api/traces/second-trace/overview", () =>
    HttpResponse.json(envelope(traceOverview))
  ),
  http.get("/api/traces/second-trace/payload", () =>
    HttpResponse.json(envelope(traceRow))
  ),
  http.get("/api/traces/second-trace/spans", () =>
    HttpResponse.json(envelope(list(traceSpans)))
  ),
  http.get("/api/traces/second-trace/spans/:spanId/detail", () =>
    HttpResponse.json(envelope(traceSpans[0]))
  ),
  http.get("/api/traces/second-trace/scores", () =>
    HttpResponse.json(envelope(list([])))
  ),
  ...traceHandlers,
]
const meta = {
  title: "Tracer/ReviewsPage",
  beforeEach: reset,
  component: ReviewsPage,
  parameters: {
    layout: "fullscreen",
    msw: { handlers },
    nextjs: {
      navigation: { pathname: `${storybookProject.prefix}/reviews`, query: {} },
    },
  },
  render: () => (
    <StorybookProjectFrame title="Reviews">
      <ReviewsPage />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof ReviewsPage>
export default meta
type Story = StoryObj<typeof meta>
export const Collection: Story = {
  play: async ({ canvasElement }) => {
    await checkCollectionPanel(canvasElement, "Reviews")
    await expect(
      within(canvasElement).findByText(session.name)
    ).resolves.toBeVisible()
  },
}
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/reviews", () =>
          HttpResponse.json(envelope({ items: [], total: 0, nextCursor: null }))
        ),
        ...handlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("No review sessions yet")
    ).resolves.toBeVisible()
  },
}
export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/reviews", () =>
          HttpResponse.json(
            { error: { message: "Unable to load review sessions" } },
            { status: 503 }
          )
        ),
        ...handlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Unable to load review sessions")
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "New session" })
    ).toBeEnabled()
    await expect(
      canvas.queryByText("No review sessions yet")
    ).not.toBeInTheDocument()
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/reviews", async () => {
          await delay("infinite")
          return HttpResponse.json(envelope({ items: [] }))
        }),
        ...handlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Loading reviews")
    ).resolves.toBeVisible()
  },
}
export const CreateSession: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "New session" }))
    const dialog = within(await within(document.body).findByRole("dialog"))
    await expect(dialog.getByLabelText("Session name")).toHaveValue(
      "Untitled Review"
    )
    await userEvent.clear(dialog.getByLabelText("Session name"))
    await userEvent.type(
      dialog.getByLabelText("Session name"),
      "New prompt review"
    )
    await userEvent.click(
      await dialog.findByRole("checkbox", { name: new RegExp(traceRow.name) })
    )
    await expect(
      dialog.getByRole("button", { name: "Create session" })
    ).toBeEnabled()
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(
        within(document.body).queryByRole("dialog")
      ).not.toBeInTheDocument()
    )
  },
}

function ReviewStoryRoute({ initialTraceId }: { initialTraceId?: string }) {
  const [traceId, setTraceId] = React.useState(initialTraceId)
  React.useLayoutEffect(() => {
    const router = getRouter()
    const paths = [initialTraceId]
    let position = 0
    const destination = (url: string) => {
      const segment = url.split("/reviews/")[1]?.split("/")[1]
      return segment ? decodeURIComponent(segment) : undefined
    }
    router.push.mockImplementation((url) => {
      paths.splice(position + 1, paths.length, destination(url))
      position++
      setTraceId(paths[position])
    })
    router.replace.mockImplementation((url) => {
      paths[position] = destination(url)
      setTraceId(paths[position])
    })
    router.back.mockImplementation(() => {
      position = Math.max(0, position - 1)
      setTraceId(paths[position])
    })
    router.forward.mockImplementation(() => {
      position = Math.min(paths.length - 1, position + 1)
      setTraceId(paths[position])
    })
    return () => {
      for (const method of [
        router.push,
        router.replace,
        router.back,
        router.forward,
      ])
        method.mockReset()
    }
  }, [initialTraceId])
  return (
    <StorybookProjectFrame
      title="Review session"
      breadcrumbs={[
        { label: "Reviews", href: `${storybookProject.prefix}/reviews` },
        ...(traceId
          ? [{
              label: `#${session.number}`,
              href: `${storybookProject.prefix}/reviews/${session.number}`,
            }]
          : []),
      ]}
    >
      <ReviewSessionPage sessionId={session.id} traceId={traceId} />
    </StorybookProjectFrame>
  )
}
const player = () => <ReviewStoryRoute />
export const Player: Story = {
  render: player,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Start" })
    )
    const picker = await canvas.findByRole("combobox", { name: "Human Scores" })
    await expect(picker).toBeVisible()
    await expect(
      canvas.queryByRole("group", { name: "Score editors" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByRole("radio", { name: "Needs work" })
    ).toBeVisible()
    await expect(canvas.getByRole("radio", { name: "Accurate" })).toBeVisible()
    await expect(
      canvas.getByRole("checkbox", { name: "Wrong units" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("checkbox", { name: "Wrong location" })
    ).toBeVisible()
    await expect(
      canvas.queryByRole("combobox", { name: "Answer quality value" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByRole("button", { name: "Remove Answer quality" })
    ).toHaveAttribute("aria-disabled", "true")
    const slider = canvas.getByRole("slider", {
      name: "Completeness value slider",
    })
    slider.focus()
    await userEvent.keyboard("{Home}")
    await expect(
      canvas.getByRole("spinbutton", { name: "Completeness value" })
    ).toHaveValue(1)
    await userEvent.clear(
      canvas.getByRole("spinbutton", { name: "Completeness value" })
    )
    await userEvent.type(
      canvas.getByRole("spinbutton", { name: "Completeness value" }),
      "4"
    )
    await userEvent.click(canvas.getByRole("radio", { name: "Needs work" }))
    await userEvent.keyboard("{ArrowDown}")
    await expect(canvas.getByRole("radio", { name: "Accurate" })).toBeChecked()
    await userEvent.click(canvas.getByRole("checkbox", { name: "Wrong units" }))
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Wrong location" })
    )
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Suggested response answer" }),
      "Please check the city and units."
    )
    await expect(canvas.findByText("All changes saved")).resolves.toBeVisible()
    await waitFor(() =>
      expect(writes.at(-1)?.scores?.map((score) => score.value)).toEqual([
        4,
        "good",
        ["units", "location"],
        "Please check the city and units.",
      ])
    )
    await userEvent.click(canvas.getByRole("button", { name: "Finish review" }))
    await expect(getRouter().push).toHaveBeenLastCalledWith(
      `${storybookProject.prefix}/reviews/354`,
      { scroll: false }
    )
    await expect(
      within(document.body).findByText("Review saved")
    ).resolves.toBeVisible()
  },
}
export const EditorAvatars: Story = {
  render: player,
  beforeEach: () => {
    reset()
    const item = items.get("review-item")!
    const saved = record(
      {
        expectedRevision: 0,
        scores: definitions.map((definition) => ({
          humanScoreId: definition.id,
          humanScoreRevision: 1,
          value: null,
        })),
      },
      item
    )
    saved.scores[0].reviewerImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><text x="3" y="20">AM</text></svg>')}`
    saved.scores[1].reviewerImage = saved.scores[0].reviewerImage
    saved.scores[0].comment = "Keep this existing review comment."
    saved.scores[2].reviewerId = "jamie"
    saved.scores[2].reviewerName = "Jamie Chen"
    saved.scores[2].source = "mcp"
    saved.scores[3].reviewerId = null
    saved.scores[3].reviewerName = null
    items.set(item.id, saved)
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Start" })
    )
    const editors = within(
      await canvas.findByRole("group", { name: "Score editors" })
    )
    await expect(editors.getAllByRole("button")).toHaveLength(3)
    const alex = editors.getByRole("button", { name: "Edited by Alex Morgan" })
    await waitFor(() => expect(alex.querySelector("img")).toBeVisible())
    await expect(editors.getByText("JC")).toBeVisible()
    await expect(editors.getByText("FM")).toBeVisible()
    alex.focus()
    await expect(
      within(document.body).findByRole("tooltip")
    ).resolves.toHaveTextContent("Edited by Alex Morgan")
    await userEvent.keyboard("{Escape}")
    await userEvent.hover(
      editors.getByRole("button", { name: "Edited by Jamie Chen via MCP" })
    )
    await expect(
      within(document.body).findByRole("tooltip")
    ).resolves.toHaveTextContent("Edited by Jamie Chen via MCP")
    await expect(canvas.queryByText(/Last saved by/)).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("textbox", { name: "Comment" })
    ).not.toBeInTheDocument()
    await userEvent.type(
      canvas.getByRole("spinbutton", { name: "Completeness value" }),
      "4"
    )
    await waitFor(() =>
      expect(
        writes.at(-1)?.scores?.find((score) => score.humanScoreId === "numeric")
          ?.comment
      ).toBe("Keep this existing review comment.")
    )
  },
}

export const SaveError: Story = {
  render: player,
  beforeEach: () => {
    reset()
    failSave = true
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Start" })
    )
    await userEvent.click(
      await canvas.findByRole("radio", { name: "Needs work" })
    )
    await expect(
      canvas.findByText("Unable to save. Try again.")
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("radio", { name: "Needs work" })
    ).toBeChecked()
    failSave = false
    collectionDelay = 0
    await userEvent.click(canvas.getByRole("button", { name: "Retry save" }))
    await expect(canvas.findByText("All changes saved")).resolves.toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Finish review" })
    ).toBeDisabled()
  },
}
export const NavigationAndNotes: Story = {
  render: player,
  beforeEach: () => {
    reset()
    const second = {
      ...session.items[0],
      id: "second",
      traceId: "second-trace",
      ordinal: 1,
      traceName: "Second trace",
    }
    currentSession = {
      ...currentSession,
      traceCount: 2,
      items: [session.items[0], second],
    }
    items.get("review-item")!.nextItemId = "second"
    items.set("second", {
      ...second,
      annotations: [],
      definitions,
      scores: [],
      previousItemId: "review-item",
      nextItemId: null,
    })
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Start" })
    )
    await expect(getRouter().push).toHaveBeenLastCalledWith(
      `${storybookProject.prefix}/reviews/354/${traceRow.id}`,
      { scroll: false }
    )
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "Wrong units" })
    )
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Review notes" }),
      "First line\nSecond line\nThird line"
    )
    const notes = canvas.getByRole("textbox", { name: "Review notes" })
    expect(notes.getBoundingClientRect().height).toBeGreaterThan(40)
    await userEvent.click(canvas.getByRole("button", { name: "Next trace" }))
    await expect(canvas.findByText("2/2")).resolves.toBeVisible()
    await expect(getRouter().push).toHaveBeenLastCalledWith(
      `${storybookProject.prefix}/reviews/354/second-trace`,
      { scroll: false }
    )
    await expect(
      canvas.findByRole("textbox", { name: "Review notes" })
    ).resolves.toHaveValue("")
    await React.act(async () => getRouter().back())
    await expect(canvas.findByText("1/2")).resolves.toBeVisible()
    await expect(
      canvas.findByRole("checkbox", { name: "Wrong units" })
    ).resolves.toBeChecked()
    await expect(
      canvas.getByRole("textbox", { name: "Review notes" })
    ).toHaveValue("First line\nSecond line\nThird line")
    await expect(
      canvas.getByRole("separator", { name: "Resize review scores" })
    ).toBeVisible()
    await React.act(async () => getRouter().forward())
    await expect(canvas.findByText("2/2")).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Previous trace" }))
    await expect(canvas.findByText("1/2")).resolves.toBeVisible()
  },
}
export const TraceDeepLink: Story = {
  render: () => <ReviewStoryRoute initialTraceId={traceRow.id} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("1/1")).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Start" })
    ).not.toBeInTheDocument()
    await expect(getRouter().replace).toHaveBeenCalledWith(
      `${storybookProject.prefix}/reviews/354/${traceRow.id}`,
      { scroll: false }
    )
    await expect(
      within(canvas.getByRole("navigation", { name: "Breadcrumb" }))
        .getByRole("link", { name: `#${session.number}` })
    ).toHaveAttribute(
      "href",
      `${storybookProject.prefix}/reviews/354`
    )
    await expect(
      canvasElement.querySelector('[aria-current="page"]')
    ).toHaveTextContent(traceRow.name)
  },
}
export const RouteDeepLink: Story = {
  beforeEach: () => {
    const previousParams = useParams.getMockImplementation()
    useParams.mockReturnValue({ traceId: traceRow.id })
    return () => {
      if (previousParams) useParams.mockImplementation(previousParams)
      else useParams.mockReset()
    }
  },
  render: () => (
    <StorybookProjectFrame title="Review session">
      <ReviewSessionRoute sessionId={session.id} />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("1/1")).resolves.toBeVisible()
    await expect(
      canvas.findByRole("combobox", { name: "Human Scores" })
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Start" })
    ).not.toBeInTheDocument()
  },
}
export const UnknownReviewTrace: Story = {
  render: () => <ReviewStoryRoute initialTraceId="not-in-session" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("This trace is not in this review session.")
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("combobox", { name: "Human Scores" })
    ).not.toBeInTheDocument()
  },
}
export const SkippedReviewTrace: Story = {
  ...UnknownReviewTrace,
  render: () => <ReviewStoryRoute initialTraceId={traceRow.id} />,
  beforeEach: () => {
    reset()
    currentSession.items[0].skippedAt = fields.createdAt
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("This trace is skipped.")
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("combobox", { name: "Human Scores" })
    ).not.toBeInTheDocument()
  },
}
export const LibraryUnavailable: Story = {
  render: player,
  parameters: {
    msw: {
      handlers: [
        http.get("/api/human-scores", () =>
          HttpResponse.json(
            { error: { message: "Human Score library unavailable" } },
            { status: 503 }
          )
        ),
        ...handlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Start" })
    )
    await expect(
      canvas.findByText("Human Score library unavailable")
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("combobox", { name: "Human Scores" })
    ).not.toBeInTheDocument()
  },
}

export const NarrowCollection: Story = {
  parameters: Collection.parameters,
  render: () => (
    <div className="w-[375px] max-w-full">
      <StorybookProjectFrame title="Reviews">
        <ReviewsPage />
      </StorybookProjectFrame>
    </div>
  ),
  play: async ({ canvasElement }) => {
    await checkCompactCollectionPanel(canvasElement, "Reviews")
  },
}

export const SessionTable: Story = {
  render: player,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("textbox", { name: "Review name" })
    ).resolves.toHaveValue(session.name)
    await expect(
      canvas.findByRole("cell", { name: "Pending" })
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("columnheader", { name: "Review status" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("columnheader", { name: "Reviewed at" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("columnheader", { name: "Input" })
    ).toBeInTheDocument()
    const header = canvas.getByRole("banner", { name: "Page controls" })
    await expect(
      within(header).queryByRole("button", { name: "Display" })
    ).not.toBeInTheDocument()
    const controls = within(
      canvas.getByRole("group", { name: "Review session controls" })
    )
    await userEvent.click(
      await controls.findByRole("button", { name: "Display" })
    )
    const menu = within(await within(document.body).findByRole("menu"))
    await expect(
      menu.getByRole("menuitemcheckbox", { name: "Review status" })
    ).toBeVisible()
    await expect(
      menu.getByRole("menuitemcheckbox", { name: "Reviewed at" })
    ).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(
        controls.getByRole("button", { name: "Display" })
      ).toHaveFocus()
    )
  },
}
export const RenameSession: Story = {
  render: player,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = await canvas.findByRole("textbox", { name: "Review name" })
    await userEvent.clear(input)
    await userEvent.type(input, "Unsaved name{Escape}")
    await expect(input).toHaveValue(session.name)
    await expect(currentSession.name).toBe(session.name)
    await userEvent.clear(input)
    await userEvent.type(input, "Weekly support review{Enter}")
    await waitFor(() =>
      expect(currentSession.name).toBe("Weekly support review")
    )
    await waitFor(() =>
      expect(canvas.getByRole("textbox", { name: "Review name" })).toHaveValue(
        "Weekly support review"
      )
    )
  },
}
export const RenameFailure: Story = {
  render: player,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    failSave = true
    const input = await canvas.findByRole("textbox", { name: "Review name" })
    await userEvent.clear(input)
    await userEvent.type(input, "Keep this draft{Enter}")
    await expect(
      canvas.findByText("Unable to rename session. Try again.")
    ).resolves.toBeVisible()
    await expect(input).toHaveValue("Keep this draft")
    await expect(currentSession.name).toBe(session.name)
  },
}
export const SkipAndRestore: Story = {
  render: player,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "Select all visible traces" })
    )
    await expect(
      canvas.queryByRole("button", { name: "Edit session" })
    ).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Skip" }))
    await expect(
      canvas.findByRole("cell", { name: "Skipped" })
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Start" })
    ).toBeDisabled()
    await expect(currentSession.items[0].reviewedAt).toBeNull()
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Select all visible traces" })
    )
    await userEvent.click(canvas.getByRole("button", { name: "Restore" }))
    await expect(
      canvas.findByRole("cell", { name: "Pending" })
    ).resolves.toBeVisible()
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Start" })).toBeEnabled()
    )
  },
}
export const RemoveSelection: Story = {
  render: player,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "Select all visible traces" })
    )
    await userEvent.click(canvas.getByRole("button", { name: "Remove" }))
    let dialog = within(await within(document.body).findByRole("alertdialog"))
    await waitFor(() =>
      expect(dialog.getByText(/The original traces will be kept/)).toBeVisible()
    )
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }))
    await expect(currentSession.traceCount).toBe(1)
    await userEvent.click(canvas.getByRole("button", { name: "Remove" }))
    dialog = within(await within(document.body).findByRole("alertdialog"))
    await userEvent.click(dialog.getByRole("button", { name: "Remove" }))
    await expect(
      canvas.findByText("This session has no traces.")
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Start" })
    ).toBeDisabled()
  },
}
export const SelectionFailure: Story = {
  render: player,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    failSave = true
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "Select all visible traces" })
    )
    await userEvent.click(canvas.getByRole("button", { name: "Remove" }))
    const dialog = within(await within(document.body).findByRole("alertdialog"))
    await userEvent.click(dialog.getByRole("button", { name: "Remove" }))
    await waitFor(() =>
      expect(dialog.getByText("Selection changed. Refresh and try again.")).toBeVisible()
    )
    await expect(currentSession.traceCount).toBe(1)
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }))
    await expect(
      canvas.getByRole("checkbox", { name: "Select all visible traces" })
    ).toBeChecked()
  },
}
export const SessionNarrow: Story = {
  render: () => <div className="h-svh w-[320px]">{player()}</div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("textbox", { name: "Review name" })
    const controls = canvas.getByRole("group", {
      name: "Review session controls",
    })
    await expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "Select all visible traces" })
    )
    await expect(canvas.getByRole("button", { name: "Skip" })).toBeVisible()
    await expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth)
  },
}
export const ReviewersNarrow: Story = {
  ...SessionNarrow,
  beforeEach: () => {
    reset()
    currentSession.reviewers = [
      { id: "reviewer", name: "Alex Morgan", image: null },
      { id: "jamie", name: "Jamie Lee", image: null },
      { id: "sam", name: "Sam Chen", image: null },
      { id: "robin", name: "Robin Hayes", image: null },
    ]
  },
}
export const SessionLoading: Story = {
  render: player,
  parameters: {
    msw: {
      handlers: [
        http.get(`/api/reviews/${session.id}/table`, async () => {
          await delay("infinite")
          return HttpResponse.json(envelope(session))
        }),
        ...handlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Loading review session")
    ).resolves.toBeVisible()
  },
}
export const SessionError: Story = {
  render: player,
  parameters: {
    msw: {
      handlers: [
        http.get(`/api/reviews/${session.id}/table`, () =>
          HttpResponse.json(
            { error: { message: "Unable to load review session" } },
            { status: 503 }
          )
        ),
        ...handlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Unable to load review session")
    ).resolves.toBeVisible()
  },
}

export const SessionStatuses: Story = {
  render: player,
  beforeEach: () => {
    currentSession.items = ["Pending", "Reviewed", "Skipped"].map(
      (status, ordinal) => ({
        ...session.items[0],
        id: `review-item-${ordinal}`,
        traceId: `trace-${ordinal}`,
        ordinal,
        traceName: [
          "Answer customer question",
          "Research topic",
          "Summarize document",
        ][ordinal],
        reviewedAt: status === "Reviewed" ? fields.updatedAt : null,
        skippedAt: status === "Skipped" ? fields.updatedAt : null,
      })
    )
    currentSession.traceCount = 3
    currentSession.reviewedCount = 1
    currentSession.skippedCount = 1
    currentSession.status = "in_progress"
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    for (const status of ["Pending", "Reviewed", "Skipped"])
      await expect(
        canvas.findByRole("cell", { name: status })
      ).resolves.toBeVisible()
  },
}

export const ScoreColumns: Story = {
  render: player,
  beforeEach: () => {
    reset()
    const first = currentSession.items[0]
    const rated = record(
      {
        expectedRevision: 0,
        scores: definitions.map((definition, index) => ({
          humanScoreId: definition.id,
          humanScoreRevision: 1,
          value: [
            4,
            "good",
            ["units", "location"],
            "Use the current forecast.",
          ][index] as number | string | string[],
        })),
      },
      items.get(first.id)!
    )
    const percentage: HumanScore = {
      ...fields,
      id: "confidence",
      name: "Confidence",
      type: "numeric",
      min: 0,
      max: 1,
      step: 0.01,
    }
    rated.scores.push({
      ...rated.scores[0],
      id: "confidence-score",
      humanScoreId: percentage.id,
      definition: percentage,
      name: percentage.name,
      value: 0.34,
    })
    items.set(first.id, rated)
    const pending = {
      ...first,
      id: "pending-item",
      traceId: "pending-trace",
      traceName: "Unreviewed trace",
    }
    currentSession.items = [rated, pending]
    currentSession.traceCount = 2
    currentSession.reviewedCount = 1
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = within(
      await canvas.findByRole("row", {
        name: `Review ${traceRow.name}, Reviewed`,
      })
    )
    for (const name of [
      "Completeness",
      "Answer quality",
      "Issues found",
      "Suggested response",
      "Confidence",
    ])
      await expect(
        canvas.getByRole("columnheader", { name: new RegExp(name) })
      ).toBeVisible()
    for (const value of [
      "4",
      "Accurate",
      "Wrong units, Wrong location",
      "Use the current forecast.",
      "34%",
    ])
      await expect(row.getByText(value, { exact: true })).toBeInTheDocument()
    const bar = row
      .getByText("34%", { exact: true })
      .parentElement!.querySelector("[style]")!
    await expect(
      bar.getBoundingClientRect().width /
        bar.parentElement!.getBoundingClientRect().width
    ).toBeCloseTo(0.34, 2)
    const icon = row
      .getByText("Reviewed", { exact: true })
      .querySelector('[aria-label="Reviewed"]')
    await expect(icon).toHaveClass("bg-status-success")
    await expect(row.getByText("Reviewed", { exact: true })).toHaveClass(
      "text-success"
    )
    const pending = within(
      canvas.getByRole("row", { name: "Review Unreviewed trace, Pending" })
    )
    await expect(pending.queryByText("Accurate")).not.toBeInTheDocument()
  },
}

export const BlankTitleReverts: Story = {
  render: player,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    let input = await canvas.findByRole("textbox", { name: "Review name" })
    await userEvent.clear(input)
    await userEvent.tab()
    await expect(input).toHaveValue(session.name)
    await expect(titleWrites).toHaveLength(0)
    await userEvent.clear(input)
    await userEvent.type(input, "   {Enter}")
    await expect(input).toHaveValue(session.name)
    await expect(titleWrites).toHaveLength(0)
    // Revert to the most recently saved title, including after a rename.
    await userEvent.clear(input)
    await userEvent.type(input, "Updated review{Enter}")
    await waitFor(() => expect(currentSession.name).toBe("Updated review"))
    await waitFor(() =>
      expect(canvas.getByRole("textbox", { name: "Review name" })).toBeEnabled()
    )
    input = canvas.getByRole("textbox", { name: "Review name" })
    await userEvent.clear(input)
    await userEvent.type(input, "  {Enter}")
    await expect(input).toHaveValue("Updated review")
    await expect(titleWrites).toHaveLength(1)
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}
export const TitleAndControls: Story = {
  render: player,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = await canvas.findByRole("textbox", { name: "Review name" })
    await expect(canvas.getByText(`#${session.number}`)).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Refresh" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByRole("button", { name: "Display" })
    ).toHaveTextContent("")
    const play = await canvas.findByRole("button", { name: "Start" })
    const titleBox = input.getBoundingClientRect()
    const buttonBox = play.getBoundingClientRect()
    await expect(buttonBox.left).toBeGreaterThan(titleBox.right)
    await expect(buttonBox.top + buttonBox.height / 2).toBeCloseTo(
      titleBox.top + titleBox.height / 2,
      0
    )
    await waitFor(() =>
      expect(getRouter().replace).toHaveBeenCalledWith(
        `${storybookProject.prefix}/reviews/354`,
        { scroll: false }
      )
    )
    await userEvent.click(canvas.getByRole("button", { name: "More actions" }))
    await expect(
      await within(document.body).findByRole("menuitem", {
        name: "Refresh",
      })
    ).toBeVisible()
    await userEvent.keyboard("{Escape}")
  },
}

export const SelectReviewers: Story = {
  render: player,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    const picker = await canvas.findByRole("combobox", {
      name: "Reviewers",
    })
    await waitFor(() => expect(picker).toBeEnabled())
    await userEvent.click(picker)
    await userEvent.type(
      await body.findByRole("combobox", { name: "Search reviewers" }),
      "jamie@example.test"
    )
    await userEvent.click(
      await body.findByRole("option", { name: /Jamie Lee/ })
    )
    await waitFor(() =>
      expect(currentSession.reviewers.map((reviewer) => reviewer.id)).toEqual([
        "reviewer",
        "jamie",
      ])
    )
    await expect(titleWrites[0]).toMatchObject({
      reviewerUserIds: ["reviewer", "jamie"],
      expectedRevision: 1,
    })
    await waitFor(() =>
      expect(picker).toHaveAttribute(
        "aria-description",
        "Alex Morgan, Jamie Lee"
      )
    )
    await userEvent.keyboard("{Escape}")
  },
}

export const ReviewerSaveFailure: Story = {
  render: player,
  beforeEach: () => {
    reset()
    failSave = true
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    const picker = await canvas.findByRole("combobox", {
      name: "Reviewers",
    })
    await waitFor(() => expect(picker).toBeEnabled())
    await userEvent.click(picker)
    await userEvent.click(
      await body.findByRole("option", { name: /Jamie Lee/ })
    )
    await expect(
      await body.findByText("Couldn’t update reviewers")
    ).toBeVisible()
    await expect(picker).toHaveAttribute("aria-description", "Alex Morgan")
    await userEvent.keyboard("{Escape}")
  },
}
export const CreateUntitledReview: Story = {
  play: async ({ canvasElement }) => {
    getRouter().push.mockClear()
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "New session" }))
    const dialog = within(await within(document.body).findByRole("dialog"))
    await expect(
      dialog.getByRole("textbox", { name: "Session name" })
    ).toHaveValue("Untitled Review")
    await userEvent.click(
      await dialog.findByRole("checkbox", { name: new RegExp(traceRow.name) })
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Create session" })
    )
    await waitFor(() => expect(creates).toHaveLength(1))
    await expect(creates[0].name).toBe("Untitled Review")
    await waitFor(() =>
      expect(getRouter().push).toHaveBeenCalledWith(
        `${storybookProject.prefix}/reviews/355`
      )
    )
  },
}

export const ChangeCollectionOptimistically: Story = {
  render: player,
  beforeEach: () => {
    reset()
    collectionDelay = 700
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    const picker = await canvas.findByRole("combobox", {
      name: "Human Score collection",
    })
    await waitFor(() => expect(picker).toBeEnabled())
    await userEvent.click(picker)
    await userEvent.click(
      await body.findByRole("option", { name: "No collection" })
    )
    await expect(picker).toHaveTextContent("No collection")
    await expect(currentSession.collectionId).toBe(collection.id)
    await expect(
      canvas.queryByRole("columnheader", { name: "Forecast accuracy" })
    ).not.toBeInTheDocument()
    await waitFor(() => expect(picker).toBeEnabled())
    await expect(currentSession.collectionId).toBeNull()
    await userEvent.click(picker)
    await userEvent.click(
      await body.findByRole("option", { name: /Weather criteria/ })
    )
    await expect(picker).toHaveTextContent("Weather criteria")
    await expect(currentSession.collectionId).toBeNull()
    await waitFor(() => expect(picker).toBeEnabled())
    await expect(currentSession.collectionId).toBe(collection.id)
    await expect(titleWrites.map((write) => write.expectedRevision)).toEqual([
      1, 2,
    ])
  },
}

export const CollectionSaveRollback: Story = {
  render: player,
  beforeEach: () => {
    reset()
    failSave = true
    collectionDelay = 700
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    const picker = await canvas.findByRole("combobox", {
      name: "Human Score collection",
    })
    await waitFor(() => expect(picker).toBeEnabled())
    await userEvent.click(picker)
    await userEvent.click(
      await body.findByRole("option", { name: "No collection" })
    )
    await expect(picker).toHaveTextContent("No collection")
    await expect(
      await body.findByText("Couldn’t update collection")
    ).toBeVisible()
    await waitFor(() => expect(picker).toHaveTextContent("Weather criteria"))
    await expect(currentSession.collectionId).toBe(collection.id)
  },
}

export const OutputAnnotations: Story = {
  render: player,
  beforeEach: () => {
    const key = "datool:trace-inspector:section:output"
    const saved = localStorage.getItem(key)
    localStorage.removeItem(key)
    return () => {
      if (saved === null) localStorage.removeItem(key)
      else localStorage.setItem(key, saved)
    }
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole("button", { name: "Start" }))
    await userEvent.click(await canvas.findByRole("button", { name: "Overview" }))
    await waitFor(() => expect(canvasElement.querySelector('[data-annotation-field="output"] [data-annotation-content]')).toBeVisible())
    const output = canvasElement.querySelector<HTMLElement>('[data-annotation-field="output"] [data-annotation-content]')!
    const quote = output.textContent!
    const range = document.createRange()
    range.selectNodeContents(output)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.mouseUp(output)
    await userEvent.click(await within(document.body).findByRole("button", { name: "Comment on selection" }))
    await userEvent.type(canvas.getByRole("textbox", { name: "Annotation comment" }), "This needs evidence from the tool.")
    await userEvent.click(canvas.getByRole("button", { name: "Add comment" }))
    await waitFor(() => expect(writes.some((write) => write.annotations?.[0]?.reference.exact === quote)).toBe(true))
    await waitFor(() => expect(canvas.getByRole("article", { name: "Annotation comment 1" })).toHaveTextContent("Alex Morgan"))
    expect(writes.find((write) => write.annotations?.length)?.annotations?.[0]?.reference.spanId).toBe("span-storybook-root")
    const outputSection = canvasElement.querySelector('[data-annotation-field="output"]')!.closest("details")!
    await userEvent.click(outputSection.querySelector("summary")!)
    await waitFor(() => expect(localStorage.getItem("datool:trace-inspector:section:output")).toBe("closed"))
    await userEvent.click(canvas.getByRole("button", { name: "Details" }))
    await userEvent.click(canvas.getByRole("button", { name: "View annotation reference 1" }))
    await waitFor(() => expect(canvasElement.querySelector('[data-annotation-field="output"] [data-annotation-content]')).toBeVisible())
    expect(localStorage.getItem("datool:trace-inspector:section:output")).toBe("closed")
    await waitFor(() => expect([...CSS.highlights.values()].some((highlight) => highlight.size > 0)).toBe(true))
    await userEvent.click(canvas.getByRole("button", { name: "Delete annotation comment 1" }))
    await waitFor(() => expect(writes.at(-1)?.annotations).toEqual([]))
    expect(canvas.queryByRole("article", { name: "Annotation comment 1" })).not.toBeInTheDocument()
  },
}

export const InputAnnotations: Story = {
  render: player,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole("button", { name: "Start" }))
    await userEvent.click(await canvas.findByRole("button", { name: "Overview" }))
    const selector = '[data-annotation-field="input"] [data-annotation-content]'
    await waitFor(() => expect(canvasElement.querySelector(selector)).toBeVisible())
    const input = canvasElement.querySelector<HTMLElement>(selector)!
    const quote = input.textContent!
    const range = document.createRange()
    range.selectNodeContents(input)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.mouseUp(input)
    await userEvent.click(await within(document.body).findByRole("button", { name: "Comment on selection" }))
    await userEvent.type(canvas.getByRole("textbox", { name: "Annotation comment" }), "Clarify the requested invoice.")
    await userEvent.click(canvas.getByRole("button", { name: "Add comment" }))
    await waitFor(() => expect(writes.at(-1)?.annotations?.[0]?.reference.field).toBe("input"))
    expect(writes.at(-1)?.annotations?.[0]?.reference.exact).toBe(quote)
    const comment = canvas.getByRole("article", { name: "Annotation comment 1" })
    await waitFor(() => expect(comment).toHaveTextContent("Alex Morgan"))
    expect(comment).toHaveTextContent("Input")
    await userEvent.click(input.closest("details")!.querySelector("summary")!)
    expect(input).not.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "View annotation reference 1" }))
    await waitFor(() => expect(canvasElement.querySelector(selector)).toBeVisible())
    await waitFor(() => expect([...CSS.highlights.values()].some(highlight => [...highlight].some(range =>
      (range.startContainer.parentElement?.closest('[data-annotation-field="input"]'))
    ))).toBe(true))
    expect([...CSS.highlights.values()].some(highlight => [...highlight].some(range =>
      (range.startContainer.parentElement?.closest('[data-annotation-field="output"]'))
    ))).toBe(false)
    await userEvent.click(canvas.getByRole("button", { name: "Delete annotation comment 1" }))
    await waitFor(() => expect(writes.at(-1)?.annotations).toEqual([]))
  },
}

const annotationField = { id: "review-test-field", name: "Trace label", code: "row.name", mode: "expression", format: "text" }

export const CustomFieldAnnotations: Story = {
  render: player,
  beforeEach: () => {
    reset()
    const previous = localStorage.getItem("datool:eval-columns:traces")
    localStorage.setItem("datool:eval-columns:traces", JSON.stringify([annotationField]))
    return () => {
      if (previous === null) localStorage.removeItem("datool:eval-columns:traces")
      else localStorage.setItem("datool:eval-columns:traces", previous)
    }
  },
  parameters: {
    msw: { handlers: [
      http.get("/api/custom-fields", () => HttpResponse.json(envelope([annotationField]))),
      http.post("/api/custom-fields", () => HttpResponse.json(envelope(annotationField))),
      http.get("/api/eval-column-worker", () => new HttpResponse(columnWorkerSource, {
        headers: { "Content-Type": "text/javascript" },
      })),
      ...handlers,
    ] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole("button", { name: "Start" }))
    await userEvent.click(await canvas.findByRole("button", { name: "Overview" }))
    const selector = '[data-annotation-field="custom"] [data-annotation-content]'
    await waitFor(() => expect(canvasElement.querySelector(selector)).toBeVisible(), { timeout: 15000 })
    const content = canvasElement.querySelector<HTMLElement>(selector)!
    const quote = content.textContent!
    expect(quote).toBe(traceRow.name)
    const range = document.createRange()
    range.selectNodeContents(content)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.mouseUp(content)
    await userEvent.click(await within(document.body).findByRole("button", { name: "Comment on selection" }))
    await userEvent.type(canvas.getByRole("textbox", { name: "Annotation comment" }), "Check the custom field.")
    await userEvent.click(canvas.getByRole("button", { name: "Add comment" }))
    await waitFor(() => expect(writes.at(-1)?.annotations?.[0]?.reference.field).toBe("custom"))
    const reference = writes.at(-1)!.annotations![0].reference
    expect(reference.customField).toMatchObject({ ...annotationField, value: quote })
    expect(reference.customField!.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(reference.spanId).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "Details" }))
    await userEvent.click(canvas.getByRole("button", { name: "View annotation reference 1" }))
    await waitFor(() => expect(canvasElement.querySelector(selector)).toBeVisible())
    await waitFor(() => expect([...CSS.highlights.values()].some(highlight => [...highlight].some(range =>
      (range.startContainer.parentElement?.closest('[data-annotation-field="custom"]'))
    ))).toBe(true))
    await userEvent.click(canvas.getByRole("button", { name: "Delete annotation comment 1" }))
    await waitFor(() => expect(writes.at(-1)?.annotations).toEqual([]))
  },
}

function seedAiReview() {
  const provenance = {
    label: "AI-labelled" as const,
    authType: "api-key" as const,
    principal: { type: "api-key" as const, id: "review-key", name: "Review agent" },
    agent: { name: "Codex", model: "test-model" },
  }
  const item = items.get("review-item")!
  item.notes = "AI finding from captured evidence."
  item.notesProvenance = provenance
  item.lastSubmission = provenance
  item.label = "AI-labelled"
  item.completionKind = "ai"
  item.humanVerified = false
  item.reviewedAt = fields.updatedAt
  item.scores = record({
    expectedRevision: 0,
    scores: definitions.map(definition => ({
      humanScoreId: definition.id, humanScoreRevision: definition.revision,
      value: definition.type === "numeric" ? 0.5 : definition.type === "text" ? "Check evidence" : definition.multiple ? [definition.options[0].value] : definition.options[0].value,
    })),
  }, item).scores.map(score => ({ ...score, source: "api", reviewerId: null, reviewerName: "Review agent", provenance }))
  currentSession.items[0] = item
  currentSession.reviewedCount = 1
  currentSession.humanReviewedCount = 0
  currentSession.aiReviewedCount = 1
  currentSession.aiLabelledCount = 1
  currentSession.status = "completed"
}

export const AiLabelledCollection: Story = {
  beforeEach: seedAiReview,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByRole("cell", { name: "0 human · 1 AI complete · 1 AI-labelled" })).resolves.toBeVisible()
  },
}

export const AiLabelledDetails: Story = {
  render: player,
  beforeEach: seedAiReview,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("cell", { name: "AI-labelled · Complete" })).resolves.toBeVisible()
    await userEvent.click(await canvas.findByRole("button", { name: "Resume review" }))
    await expect(canvas.findByText("AI-labelled. AI submissions are not human-verified dataset ground truth.")).resolves.toBeVisible()
    await expect(canvas.getByText("Notes: AI-labelled · Review agent · Codex · test-model")).toBeVisible()
    await expect(canvas.getAllByText("AI-labelled · Review agent · Codex · test-model").length).toBeGreaterThan(0)
  },
}
