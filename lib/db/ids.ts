const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a UUID string (so bad ids give 404 instead of a Postgres cast error). */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
