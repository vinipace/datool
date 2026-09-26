import { authApiError } from "@/src/server/auth/errors"
import { revokeOrganizationKey } from "@/src/server/auth/key-management"
export const runtime = "nodejs"
export async function DELETE(
  request: Request,
  context: { params: Promise<{ organizationId: string; keyId: string }> }
) {
  try {
    const { organizationId, keyId } = await context.params
    return Response.json({
      data: await revokeOrganizationKey(request, organizationId, keyId),
    })
  } catch (error) {
    return authApiError(error)
  }
}
