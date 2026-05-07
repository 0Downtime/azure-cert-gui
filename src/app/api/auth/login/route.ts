import { NextRequest, NextResponse } from "next/server";
import { AuthError, beginOidcSignIn, oidcStateCookieName, setAuthCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const signIn = await beginOidcSignIn(request);
    const response = NextResponse.redirect(signIn.redirectUrl);
    setAuthCookie(response, oidcStateCookieName, signIn.stateCookie, request, 10 * 60);
    return response;
  } catch (error) {
    if (error instanceof AuthError) {
      return new NextResponse(error.message, { status: error.status });
    }
    throw error;
  }
}
