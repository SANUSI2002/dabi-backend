// Display names for the staff behind clinical entries (who called, recorded, signed…). Runs inside
// the request's tenant transaction: the EMR role may read only users' id and full_name.

/** Adds `<as>` — the display name of the user in `field` — to each row (null when unknown). */
export async function withUserNames(tx, rows, field, as) {
  const ids = [...new Set(rows.map((row) => row[field]).filter(Boolean))];
  const users = ids.length ? await tx.$queryRaw`SELECT "id", "full_name" AS "name" FROM "users" WHERE "id" = ANY(${ids}::text[])` : [];
  const names = new Map(users.map((user) => [user.id, user.name]));
  return rows.map((row) => ({ ...row, [as]: names.get(row[field]) ?? null }));
}
