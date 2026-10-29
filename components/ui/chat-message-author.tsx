import { UserAvatarImage } from "./user-avatar"

/** Sender identity stays outside the bubble in both customer and inbox chats. */
export function ChatMessageAuthor({
  name,
  image,
}: {
  name: string
  image: string | null
}) {
  return (
    <div className="mb-1.5 inline-flex max-w-full items-center gap-2 text-xs font-semibold text-foreground">
      <UserAvatarImage name={name} image={image} />
      <span className="min-w-0 truncate">{name}</span>
    </div>
  )
}
