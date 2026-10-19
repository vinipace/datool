"use client"

import { createContext, useContext } from "react"
import { tracerApi } from "./api"

export type TraceReadApi = Pick<
  typeof tracerApi.traces,
  "overview" | "payload" | "span" | "spans" | "scores"
>
export const TraceReadApiContext = createContext<TraceReadApi>(tracerApi.traces)
export const useTraceReadApi = () => useContext(TraceReadApiContext)
