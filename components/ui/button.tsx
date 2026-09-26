import type * as React from "react"
import { LoaderCircle } from "lucide-react"
import { Slot, Slottable } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      shape: {
        circle: "rounded-full",
      },
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        marketing:
          "bg-marketing-primary text-marketing-primary-foreground hover:bg-marketing-primary-hover focus-visible:ring-marketing-signal",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-border bg-background text-foreground hover:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        "scorer-llm":
          "bg-scorer-llm text-scorer-llm-foreground hover:bg-scorer-llm/90",
        "scorer-library": "bg-selection text-selection-foreground hover:bg-selection/90",
        "scorer-javascript":
          "bg-scorer-javascript text-scorer-javascript-foreground hover:bg-scorer-javascript/90",
        "scorer-python":
          "bg-scorer-python text-scorer-python-foreground hover:bg-scorer-python/90",
        ghost: "text-foreground hover:bg-muted",
        "ghost-muted":
          "text-foreground-muted hover:bg-muted hover:text-foreground",
        "ghost-subtle":
          "text-foreground-muted hover:bg-muted hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        "responsive-sm": "size-8 gap-1.5 p-0 xl:w-auto xl:px-3 xl:has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        xl: "h-12 rounded-xl px-8 text-lg has-[>svg]:px-6",
        "2xl": "h-16 gap-3 rounded-xl px-8 text-2xl has-[>svg]:px-6",
        icon: "size-9",

        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    // The quieter token meets contrast for large text; smaller controls keep
    // the standard muted foreground.
    compoundVariants: [
      { variant: "ghost-subtle", size: "2xl", class: "text-foreground-subtle" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    loading?: boolean
  }

function Button({
  className,
  variant,
  size,
  shape,
  asChild = false,
  loading = false,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size, shape, className }))}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <LoaderCircle aria-hidden="true" className="animate-spin" />
      ) : null}
      <Slottable>{children}</Slottable>
    </Comp>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants, type ButtonProps }
