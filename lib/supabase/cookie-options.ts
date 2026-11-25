/**
 * Session cookie options for every Supabase server client (route handlers, server components,
 * proxy). httpOnly: no browser Supabase client exists, so JS never reads the session cookie.
 * Secure in production, so the session never travels over plain http; dev (http://localhost)
 * keeps working.
 */
export function sessionCookieOptions(nodeEnv: string | undefined = process.env.NODE_ENV) {
  return { httpOnly: true, secure: nodeEnv === "production", sameSite: "lax" as const };
}
