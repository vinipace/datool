/** Public origin only; never import auth or database configuration into docs. */
export function docsOrigin(request: Request) {
  return new URL(process.env.BETTER_AUTH_URL || request.url).origin
}
