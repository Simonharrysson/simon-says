import { NextResponse, type NextRequest } from "next/server";
import { mcpConfigured, mcpStore } from "@/lib/mcp/deps";
import { authorize } from "@/lib/mcp/endpoints";
import { notConfigured } from "@/lib/mcp/http";
import { appOrigin } from "@/lib/origin";

// The OAuth authorization endpoint. A valid request is stored server-side and the user goes to the
// consent page /koppla/<id> (signing in first if needed); only that opaque id travels through
// the login. An unknown client or redirect URI is never redirected to (open redirect).
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!mcpConfigured()) return notConfigured();
  const origin = appOrigin();
  const outcome = await authorize(request.nextUrl.searchParams, mcpStore(), origin);
  const to =
    outcome.kind === "redirect"
      ? outcome.url
      : outcome.kind === "consent"
        ? `${origin}/koppla/${outcome.requestId}`
        : `${origin}/koppla?fel=${outcome.reason === "unknown_client" ? "klient" : "adress"}`;
  return NextResponse.redirect(to, { status: 302, headers: { "cache-control": "no-store" } });
}
