// Display names for the staff behind clinical entries (who called, recorded, signed…). Runs inside
// the request's tenant transaction: the EMR role may read only users' id and full_name.

/** id → display name for the given user ids (unknown ids are simply absent). */
export async function userNameMap(tx, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const users = unique.length ? await tx.$queryRaw`SELECT "id", "full_name" AS "name" FROM "users" WHERE "id" = ANY(${unique}::text[])` : [];
  return new Map(users.map((user) => [user.id, user.name]));
}

/** Adds `<as>` — the display name of the user in `field` — to each row (null when unknown). */
export async function withUserNames(tx, rows, field, as) {
  const names = await userNameMap(tx, rows.map((row) => row[field]));
  return rows.map((row) => ({ ...row, [as]: names.get(row[field]) ?? null }));
}
