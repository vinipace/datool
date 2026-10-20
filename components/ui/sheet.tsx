"use client"

import { DialogContent, type DialogContentProps } from "./dialog"

export {
  Dialog as Sheet,
  DialogClose as SheetClose,
  DialogDescription as SheetDescription,
  DialogFooter as SheetFooter,
  DialogHeader as SheetHeader,
  DialogTitle as SheetTitle,
  DialogTrigger as SheetTrigger,
} from "./dialog"

/** Right-side workspace for forms, sharing the app's focus and overlay behavior. */
export function SheetContent(props: Omit<DialogContentProps, "variant">) {
  return <DialogContent variant="side-sheet" {...props} />
}
