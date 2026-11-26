import type { NextRequest } from "next/server";
import { localeFromCookieHeader, type Locale } from "./config";
import { translator, type Translator } from "./translator";

/**
 * The language of a route handler's answer: the caller's `lang` cookie, read from the Request
 * (not next/headers, so handlers called directly in tests answer in Swedish).
 */
export function requestLocale(request: Request | NextRequest | null | undefined): Locale {
  return localeFromCookieHeader(request?.headers.get("cookie"));
}

/** A translator for a route handler's user-facing messages (`api.*`). */
export function apiT(request: Request | NextRequest | null | undefined): Translator {
  return translator(requestLocale(request));
}
