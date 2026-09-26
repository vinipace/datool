"use client"
import { createContext, useContext } from "react"
export const ProjectScope = createContext<{ projectId: string; organizationId: string } | null>(null)
export const useProjectScope = () => useContext(ProjectScope)
