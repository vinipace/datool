import { authBaseUrl } from "@/src/server/auth/config";
import { getAuth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export async function GET(request: Request) {
  const auth = getAuth();
  const requested = new URL(request.url);
  const canonical = new URL(authBaseUrl());
  // Safari's host-only OAuth cookie must live on the same host Google returns
  // to. The installed app may open this browser bridge through a Cloud alias.
  if (
    requested.pathname === "/api/auth/expo-authorization-proxy" &&
    (request.headers.get("host") ?? requested.host).toLowerCase() !== canonical.host
  ) {
    return new Response(null, {
      status: 307,
      headers: {
        Location: new URL(requested.pathname + requested.search, canonical).toString(),
        "Cache-Control": "no-store",
      },
    });
  }
  return toNextJsHandler(auth).GET(request);
}

export async function POST(request: Request) {
  return toNextJsHandler(getAuth()).POST(request);
}
