import { NextRequest, NextResponse } from "next/server";
import { attachSessionCookie, stripAuthjsSessionCookies } from "@/lib/auth/session";
import { signOutToAnonymous } from "@/lib/auth/sign-out";
import { handleApiError } from "@/lib/errors";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const session = await signOutToAnonymous();
    const accept = request.headers.get("accept") || "";
    const wantsJson =
      accept.includes("application/json") ||
      request.headers.get("content-type")?.includes("application/json");

    const response = wantsJson
      ? NextResponse.json({ ok: true, signedIn: false })
      : NextResponse.redirect(new URL("/", request.url), 303);

    attachSessionCookie(response, session);
    stripAuthjsSessionCookies(response);
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
