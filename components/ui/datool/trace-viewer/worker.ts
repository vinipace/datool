import type {
  RootNode,
  VisibleSpan,
  WorkerRequest,
  WorkerResponse,
} from "./types"
import { addToRow } from "./util/tree"
import { matchingSpanIds, orderedSpanNodes } from "./util/span-layout"

// The most recent requestId
let requestId = 0

self.addEventListener("message", (event) => {
  const data = event.data as WorkerRequest
  requestId = Math.max(requestId, data?.requestId || 0)

  switch (data.type) {
    case "calculateSpanPositions":
      calculateSpanPositions(data.root)
      break
    case "filterSpans":
      filterSpans(data.root, data.filter)
      break
    default:
      break
  }
})

const calculateSpanPositions = (root: RootNode): void => {
  const responseId = requestId
  const placed: VisibleSpan[][] = []
  const pending = orderedSpanNodes(root)

  let lastFlushT = Date.now() - 10
  let lastFlushC = -64
  let count = 0
  const flush = (): void => {
    for (const row of placed) {
      row.sort((a, b) => a.startTime - b.startTime)
    }
    const message: WorkerResponse = {
      requestId: responseId,
      type: "setRowsResult",
      rows: placed,
      isEnd: !pending.length,
    }
    postMessage(message)
    lastFlushT = Date.now()
    lastFlushC = count
  }

  while (true) {
    const node = pending.shift()
    if (!node) {
      flush()
      return
    }
    addToRow(placed, node, 0.001)
    ++count
    if (Date.now() - lastFlushT >= 15 || count - lastFlushC >= 256) {
      flush()
    }
  }
}

const filterSpans = (root: RootNode, filter: string): void => {
  const message: WorkerResponse = {
    requestId,
    type: "updateHighlight",
    matches: matchingSpanIds(root, filter),
  }
  postMessage(message)
}
