import { randomUUID } from "node:crypto"
import type { Pool } from "pg"
import sharp from "sharp"
import { z } from "zod"
import { TracerError } from "@/src/server/tracer/errors"

const profileInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    photo: z
      .string()
      .max(7 * 1024 * 1024)
      .nullable()
      .optional(),
  })
  .strict()

export async function saveProfile(
  database: Pool,
  userId: string,
  value: unknown,
  origin: string
) {
  const input = profileInput.parse(value)
  let photo: Buffer | null | undefined
  if (typeof input.photo === "string") {
    try {
      const match =
        /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
          input.photo
        )
      if (!match) throw new Error("Invalid photo")
      const source = Buffer.from(match[1], "base64")
      if (source.length > 5 * 1024 * 1024) throw new Error("Photo too large")
      const image = sharp(source, {
        limitInputPixels: 25_000_000,
        failOn: "error",
      })
      const metadata = await image.metadata()
      if (
        !["jpeg", "png", "webp"].includes(metadata.format ?? "") ||
        (metadata.pages ?? 1) > 1
      )
        throw new Error("Unsupported photo")
      photo = await image
        .rotate()
        .resize(256, 256, { fit: "cover" })
        .webp({ quality: 80 })
        .toBuffer()
      if (photo.length > 262144) throw new Error("Photo too large")
    } catch {
      throw new TracerError(
        "VALIDATION_ERROR",
        "Choose a valid JPG, PNG or WebP photo up to 5 MB and 25 megapixels.",
        { status: 400 }
      )
    }
  } else if (input.photo === null) photo = null

  const client = await database.connect()
  try {
    await client.query("BEGIN")
    const current = await client.query<{ image: string | null }>(
      'SELECT image FROM "user" WHERE id=$1 FOR UPDATE',
      [userId]
    )
    if (!current.rows[0])
      throw new TracerError("UNAUTHORIZED", "Sign in to edit your profile.", {
        status: 401,
      })
    let image = current.rows[0].image
    if (photo !== undefined) {
      const photoId = photo ? randomUUID() : null
      image = photoId ? `${origin}/api/profile/photos/${photoId}` : null
      await client.query(
        `INSERT INTO user_profile (user_id, photo_id, photo) VALUES ($1,$2,$3)
        ON CONFLICT (user_id) DO UPDATE SET photo_id=EXCLUDED.photo_id, photo=EXCLUDED.photo`,
        [userId, photoId, photo]
      )
    } else {
      await client.query(
        "INSERT INTO user_profile (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
        [userId]
      )
    }
    const saved = await client.query<{
      name: string
      image: string | null
      email: string
    }>(
      'UPDATE "user" SET name=$2, image=$3, "updatedAt"=now() WHERE id=$1 RETURNING name,image,email',
      [userId, input.name, image]
    )
    await client.query("COMMIT")
    return saved.rows[0]
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
