import { NextRequest, NextResponse } from "next/server";
import type { AzureEnvironmentSettings } from "@/types";
import { AuthError, requireAdminAccessForRequest, requireViewerAccessForRequest } from "@/lib/auth";
import { getAzureSettingsResponse, saveAzureEnvironmentConfiguration } from "@/lib/azure-environment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireViewerAccessForRequest(request);
    return NextResponse.json(await getAzureSettingsResponse(false));
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireAdminAccessForRequest(request);
    const body = (await request.json()) as Partial<AzureEnvironmentSettings>;
    return NextResponse.json(
      await saveAzureEnvironmentConfiguration(
        {
          tenantId: clean(body.tenantId),
          subscriptionIds: cleanArray(body.subscriptionIds),
          keyVaultResourceIds: cleanArray(body.keyVaultResourceIds),
          cloudName: clean(body.cloudName),
          includeGraphOwners: body.includeGraphOwners !== false,
          includeGraphOwnerDirectory: body.includeGraphOwnerDirectory !== false,
          includeKeyVaultVersions: body.includeKeyVaultVersions === true
        },
        actor
      )
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "InvalidAzureSettingsPayload" }, { status: 400 });
    }
    throw error;
  }
}

function clean(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function cleanArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}
