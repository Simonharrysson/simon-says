// Pure: is this auth user still allowed to use their MCP tokens?
/** A deleted or banned account gets no access, whatever its tokens say. */
export function usableUser<U extends { banned_until?: string | null; deleted_at?: string | null }>(user: U, now = new Date()): U | null {
  if (user.deleted_at) return null;
  if (user.banned_until && Date.parse(user.banned_until) > now.getTime()) return null;
  return user;
}
