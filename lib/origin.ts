import { getEnv } from "@/lib/env";

/**
 * The app's public origin, from APP_URL (never from the request's Host header, which a client
 * controls). Dev: APP_URL=http://localhost:3000.
 */
export function appOrigin(appUrl: string = getEnv().APP_URL): string {
  return new URL(appUrl).origin;
}
