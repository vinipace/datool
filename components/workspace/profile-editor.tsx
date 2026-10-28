"use client"

import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { UserAvatarImage } from "@/components/ui/user-avatar"
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { AccountMenuUser } from "./account-menu"

export function ProfileEditor({
  user,
  onSaved,
  onClose,
  onCloseAutoFocus,
}: {
  user: AccountMenuUser
  onSaved: (user: AccountMenuUser) => void
  onClose: () => void
  onCloseAutoFocus: () => void
}) {
  const [saved, setSaved] = useState(user)
  const [name, setName] = useState(user.name)
  const [photo, setPhoto] = useState<string | null | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState(false)
  const preview = photo === undefined ? (saved.image ?? null) : photo
  const dirty = name.trim() !== saved.name || photo !== undefined
  const busy = pending || reading

  async function choosePhoto(file: File | undefined) {
    if (!file) return
    setError("")
    setSuccess(false)
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    ) {
      setError("Choose a JPG, PNG or WebP photo up to 5 MB.")
      return
    }
    setReading(true)
    try {
      const source = URL.createObjectURL(file)
      let value: string
      try {
        const image = new Image()
        image.src = source
        await image.decode()
        if (image.naturalWidth * image.naturalHeight > 25_000_000)
          throw new Error("Choose a photo smaller than 25 megapixels.")
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 256
        const context = canvas.getContext("2d")
        if (!context) throw new Error("Unable to read this photo.")
        const side = Math.min(image.naturalWidth, image.naturalHeight)
        context.drawImage(
          image,
          (image.naturalWidth - side) / 2,
          (image.naturalHeight - side) / 2,
          side,
          side,
          0,
          0,
          256,
          256
        )
        value = canvas.toDataURL("image/webp", 0.85)
      } finally {
        URL.revokeObjectURL(source)
      }
      setPhoto(value)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to read this photo."
      )
    } finally {
      setReading(false)
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || !dirty || !name.trim()) return
    setPending(true)
    setError("")
    setSuccess(false)
    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          ...(photo !== undefined ? { photo } : {}),
        }),
      })
      const result = await response.json()
      if (!response.ok || !result.data)
        throw new Error(
          result.error?.message || "Unable to save your profile. Try again."
        )
      setSaved(result.data)
      setName(result.data.name)
      setPhoto(undefined)
      setSuccess(true)
      onSaved(result.data)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save your profile. Try again."
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <DialogContent
      showCloseButton={!busy}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        onCloseAutoFocus()
      }}
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault()
      }}
      onInteractOutside={(event) => {
        if (busy) event.preventDefault()
      }}
    >
      <DialogHeader>
        <DialogTitle>Profile</DialogTitle>
        <DialogDescription>
          Your name and photo appear to teammates and customers when you reply.
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-5" onSubmit={(event) => void save(event)}>
        <div className="flex items-center gap-4">
          <UserAvatarImage
            name={name || user.email}
            image={preview}
            size="lg"
          />
          <div className="min-w-0 flex-1 space-y-2">
            <label htmlFor="profile-photo" className="text-sm font-medium">
              Photo
            </label>
            <Input
              id="profile-photo"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              aria-describedby="profile-photo-help"
              onChange={(event) => {
                void choosePhoto(event.target.files?.[0])
                event.target.value = ""
              }}
            />
            <p
              id="profile-photo-help"
              className="text-xs text-foreground-muted"
            >
              JPG, PNG or WebP, up to 5 MB.
            </p>
            {preview && (
              <Button
                type="button"
                variant="ghost-subtle"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setPhoto(null)
                  setSuccess(false)
                  setError("")
                }}
              >
                Remove photo
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <label htmlFor="profile-name" className="text-sm font-medium">
            Name
          </label>
          <Input
            id="profile-name"
            value={name}
            maxLength={160}
            required
            autoComplete="name"
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value)
              setSuccess(false)
              setError("")
            }}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="profile-email" className="text-sm font-medium">
            Email
          </label>
          <Input id="profile-email" value={user.email} readOnly />
        </div>
        {error && (
          <Notice variant="error" role="alert">
            {error}
          </Notice>
        )}
        {success && (
          <Notice variant="success" role="status">
            Profile saved.
          </Notice>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            {success ? "Done" : "Cancel"}
          </Button>
          <Button
            type="submit"
            loading={pending}
            disabled={reading || !dirty || !name.trim()}
          >
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
