import { NextResponse, type NextRequest } from "next/server";
import { recordClick } from "@/lib/growth/claim";
import { inviteIdOf } from "@/lib/growth/token";

export const dynamic = "force-dynamic";

/** The landing's beacon (0067): a browser that ran our script opened the invite. 204 either way. */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token : "";
  if (inviteIdOf(token)) {
    try {
      await recordClick(token, true);
    } catch (e) {
      console.error(`invite beacon: ${(e as Error).message}`.slice(0, 200));
    }
  }
  return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
}
