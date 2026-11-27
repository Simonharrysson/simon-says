import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

// An MCP call runs AS THE USER: a Supabase client whose requests carry a short-lived JWT for the
// user, signed with the project's JWT secret (HS256), so PostgREST applies every RLS policy exactly
// as for the web app (the same mechanism as clientAs() in test/local-supabase.ts). Never the
// service role for tool reads.
//
// Shared code asks the client who is signed in (db.auth.getUser(): myRole, listMyForetag); a
// header-only client has no auth session, so getUser() answers with the user the grant was
// resolved to (loaded with auth.admin.getUserById for this very request).

/** Lifetime of the minted JWT: one MCP request (Förbered möte's Google batches included). */
export const USER_JWT_TTL_S = 300;

export function mintUserJwt(user: Pick<User, "id" | "email">, secret: string, now = new Date()): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: user.id, email: user.email ?? "", role: "authenticated", aud: "authenticated", iat, exp: iat + USER_JWT_TTL_S });
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export function userClient(opts: { url: string; anonKey: string; jwtSecret: string; user: User }): SupabaseClient {
  const jwt = mintUserJwt(opts.user, opts.jwtSecret);
  const db = createClient(opts.url, opts.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const user = opts.user;
  // Only identity: every read and write still goes to PostgREST with the user's JWT.
  db.auth.getUser = (async () => ({ data: { user }, error: null })) as typeof db.auth.getUser;
  return db;
}
