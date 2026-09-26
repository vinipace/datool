import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState, type PropsWithChildren } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/toast"

export function StorybookProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
      <Toaster />
    </QueryClientProvider>
  )
}
