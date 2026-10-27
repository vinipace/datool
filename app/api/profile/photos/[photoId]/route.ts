import { db } from "@/lib/db"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ photoId: string }> }
) {
  const { photoId } = await params
  if (
    !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
      photoId
    )
  )
    return new Response(null, { status: 404 })
  const result = await db.query<{ photo: Buffer }>(
    "SELECT photo FROM user_profile WHERE photo_id=$1",
    [photoId]
  )
  if (!result.rows[0]) return new Response(null, { status: 404 })
  return new Response(new Uint8Array(result.rows[0].photo), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
