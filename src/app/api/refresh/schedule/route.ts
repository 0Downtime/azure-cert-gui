import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireOperatorAccessForRequest, requireViewerAccessForRequest } from "@/lib/auth";
import { configureRefreshSchedule, getRefreshScheduleStatus } from "@/lib/refresh-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireViewerAccessForRequest(request);
    return NextResponse.json(getRefreshScheduleStatus());
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireOperatorAccessForRequest(request);
    const body = (await request.json()) as { enabled?: unknown; intervalMinutes?: unknown };
    const enabled = body.enabled === true;
    const intervalMinutes =
      typeof body.intervalMinutes === "number"
        ? body.intervalMinutes
        : Number.parseInt(String(body.intervalMinutes ?? ""), 10);
    return NextResponse.json(
      configureRefreshSchedule({
        enabled,
        intervalMinutes,
        updatedBy: actor.displayName ?? actor.username
      })
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "InvalidSchedulePayload" }, { status: 400 });
    }
    throw error;
  }
}
