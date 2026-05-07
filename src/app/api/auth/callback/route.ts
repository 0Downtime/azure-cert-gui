import { NextRequest, NextResponse } from "next/server";
import { AuthError, authCookieName, clearAuthCookies, completeOidcSignIn, setAuthCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const result = await completeOidcSignIn(request);
    const response = NextResponse.redirect(new URL(result.returnTo, request.nextUrl.origin));
    clearAuthCookies(response);
    setAuthCookie(response, authCookieName, result.sessionCookie, request, 7 * 24 * 60 * 60);
    return response;
  } catch (error) {
    if (error instanceof AuthError) {
      const response = new NextResponse(error.message, { status: error.status });
      clearAuthCookies(response);
      return response;
    }
    throw error;
  }
}
