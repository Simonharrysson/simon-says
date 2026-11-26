import { NextResponse, type NextRequest } from "next/server";
import { appOrigin } from "@/lib/origin";
import { unsubscribe } from "@/lib/summaries/unsubscribe";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * One-click unsubscribe (RFC 8058): the mail client POSTs `List-Unsubscribe=One-Click` to the
 * List-Unsubscribe URL of a summary e-mail. No sign-in, no cookie: the signed token in `?t=` is the
 * proof. 200 when done (also when it was already done), 400 for a bad link.
 */
export async function POST(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("t");
  try {
    if (!(await unsubscribe(token))) return new NextResponse("Länken fungerar inte.", { status: 400, headers: noStore });
  } catch (e) {
    console.error(`unsubscribe: ${(e as Error).message}`.slice(0, 200));
    return new NextResponse("Något gick fel. Försök igen.", { status: 500, headers: noStore });
  }
  return new NextResponse("Du får inga fler sammanfattningar.", { status: 200, headers: noStore });
}

/** A GET (a person, or a mail scanner following the header) changes nothing: it shows the confirm page. */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("t") ?? "";
  const url = new URL("/sammanfattning/avsluta", appOrigin());
  if (token) url.searchParams.set("t", token);
  return NextResponse.redirect(url, { status: 303, headers: noStore });
}
