import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireAdminAccessForRequest, requireViewerAccessForRequest } from "@/lib/auth";
import { getAzureLoginStatus, startAzureDeviceLogin } from "@/lib/azure-environment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireViewerAccessForRequest(request);
    return NextResponse.json(getAzureLoginStatus());
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdminAccessForRequest(request);
    const body = (await request.json().catch(() => ({}))) as { tenantId?: unknown; cloudName?: unknown };
    return NextResponse.json(
      await startAzureDeviceLogin({
        tenantId: typeof body.tenantId === "string" ? body.tenantId : null,
        cloudName: typeof body.cloudName === "string" ? body.cloudName : null
      })
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
