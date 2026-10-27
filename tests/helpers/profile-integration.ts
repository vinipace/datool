import { strict as assert } from "node:assert"
import { makeSignature } from "better-auth/crypto"
import sharp from "sharp"
import { getAuth } from "../../lib/auth"
import { db, analyticsDb } from "../../lib/db"
import { POST } from "../../app/api/profile/route"
import { GET as getPhoto } from "../../app/api/profile/photos/[photoId]/route"

const base = process.env.BETTER_AUTH_URL!
const auth = getAuth()
try {
  const context = await auth.$context
  const account = async (name: string) => {
    const user = await context.internalAdapter.createUser(
      { name, email: `${name}@example.test`, emailVerified: true },
      { method: "oauth" }
    )
    const session = await context.internalAdapter.createSession(user.id)
    assert(session)
    const signature = await makeSignature(session.token, context.secret)
    return {
      user,
      cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
    }
  }
  const owner = await account("owner")
  const other = await account("other")
  const save = (body: unknown, cookie = owner.cookie, origin = base) =>
    POST(
      new Request(`${base}/api/profile`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    )
  const read = () =>
    auth.api.getSession({ headers: new Headers({ cookie: owner.cookie }) })
  assert.equal((await save({ name: "Denied" }, "")).status, 401)
  assert.equal(
    (await save({ name: "Denied" }, owner.cookie, "https://evil.test")).status,
    403
  )
  for (const invalid of [
    { name: " " },
    { name: "a".repeat(161) },
    { name: "Impersonation", userId: other.user.id },
    { name: "Invalid", photo: "data:image/png;base64,YmFk" },
    { name: "Remote", photo: "https://example.test/photo.png" },
  ])
    assert.equal((await save(invalid)).status, 400)
  assert.equal(
    (await save({ name: "Too big", photo: "x".repeat(7 * 1024 * 1024) }))
      .status,
    413
  )
  const png = await sharp({
    create: { width: 500, height: 300, channels: 3, background: "#345678" },
  })
    .png()
    .toBuffer()
  const response = await save({
    name: "  Support Alice  ",
    photo: `data:image/png;base64,${png.toString("base64")}`,
  })
  assert.equal(response.status, 200, await response.clone().text())
  const { data: saved } = await response.json()
  assert.equal(saved.name, "Support Alice")
  assert.equal(saved.email, owner.user.email)
  const photoId = new URL(saved.image).pathname.split("/").at(-1)!
  const fetchPhoto = () =>
    getPhoto(new Request(saved.image), { params: Promise.resolve({ photoId }) })
  const photoResponse = await fetchPhoto()
  assert.equal(photoResponse.status, 200)
  assert.equal(photoResponse.headers.get("content-type"), "image/webp")
  const metadata = await sharp(
    Buffer.from(await photoResponse.arrayBuffer())
  ).metadata()
  assert.equal(metadata.width, 256)
  assert.equal(metadata.height, 256)
  assert.equal(metadata.exif, undefined)
  assert.equal((await read())?.user.name, saved.name)
  assert.equal((await read())?.user.image, saved.image)
  assert.equal(
    (
      await auth.api.getSession({
        headers: new Headers({ cookie: other.cookie }),
      })
    )?.user.name,
    "other"
  )

  await db.query(
    'INSERT INTO account (id,"userId","accountId","providerId","createdAt","updatedAt") VALUES ($1,$2,$3,\'google\',now(),now())',
    [crypto.randomUUID(), owner.user.id, "google-owner"]
  )
  const provider = context.socialProviders.find((p) => p.id === "google")!
  const token = `e30.${Buffer.from(JSON.stringify({ sub: "google-owner", email: owner.user.email, email_verified: true, name: "Google Name", picture: "https://example.test/google.png" })).toString("base64url")}.signature`
  provider.validateAuthorizationCode = async () => ({ idToken: token })
  async function googleLogin() {
    const signIn = await auth.handler(
      new Request(`${base}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "/",
          disableRedirect: true,
        }),
      })
    )
    assert.equal(signIn.status, 200)
    const state = new URL((await signIn.json()).url).searchParams.get("state")!
    const result = await auth.handler(
      new Request(
        `${base}/api/auth/callback/google?code=fixture&state=${encodeURIComponent(state)}`,
        {
          headers: {
            cookie: signIn.headers
              .getSetCookie()
              .map((c) => c.split(";")[0])
              .join("; "),
          },
        }
      )
    )
    assert.equal(result.status, 302)
    assert.equal(result.headers.get("location"), "/")
  }
  await googleLogin()
  assert.equal((await read())?.user.name, "Support Alice")
  assert.equal((await read())?.user.image, saved.image)
  const renamed = await save({ name: "Alice Team" })
  assert.equal(renamed.status, 200)
  assert.equal((await read())?.user.image, saved.image)
  const removed = await save({ name: "Alice Team", photo: null })
  assert.equal(removed.status, 200)
  assert.equal((await read())?.user.image, null)
  assert.equal((await fetchPhoto()).status, 404)
  await googleLogin()
  assert.equal((await read())?.user.name, "Alice Team")
  assert.equal((await read())?.user.image, null)
  console.log("PASS profile persistence, photos, isolation, and Google sign-in")
} finally {
  await Promise.all([db.end(), analyticsDb.end()])
}
