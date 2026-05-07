import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireOperatorAccessForRequest, requireViewerAccessForRequest } from "@/lib/auth";
import { getRefreshStatus, startAzureRefresh } from "@/lib/refresh-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireViewerAccessForRequest(request);
    return NextResponse.json(getRefreshStatus());
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireOperatorAccessForRequest(request);
    return NextResponse.json(startAzureRefresh());
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
