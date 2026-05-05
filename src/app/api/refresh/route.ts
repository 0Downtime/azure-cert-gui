import { NextResponse } from "next/server";
import { getRefreshStatus, startAzureRefresh } from "@/lib/refresh-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(getRefreshStatus());
}

export function POST() {
  return NextResponse.json(startAzureRefresh());
}
