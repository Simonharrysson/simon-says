import type { NextRequest } from "next/server";
import { localeFromCookieHeader, type Locale } from "./config";
import { messages } from "./messages";
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

/**
 * A message from lib code that answers in Swedish (lib/meetings/start.ts, lib/formats/
 * stadgar-file.ts): the same text in `locale` when the api catalog has it (looked up by its
 * Swedish value), else unchanged. lib/i18n/messages.test.ts checks those lib texts are in the
 * catalog, so a reworded message can't silently stay Swedish.
 */
export function localizeMessage(message: string, locale: Locale): string {
  if (locale === "sv") return message;
  const sv = messages.sv.api as Record<string, unknown>;
  const key = Object.keys(sv).find((k) => sv[k] === message);
  const out = key ? (messages[locale].api as Record<string, unknown>)[key] : undefined;
  return typeof out === "string" ? out : message;
}
