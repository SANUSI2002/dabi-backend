// Per-tenant counters (e.g. lab accession numbers). One upsert: the row lock it takes serializes
// concurrent callers of the SAME tenant and name only, and the number is only consumed if the
// surrounding transaction commits — so there are no gaps from failed requests and no duplicates.
export async function nextSequence(tx, context, name) {
  const [row] = await tx.$queryRaw`
    INSERT INTO "emr_sequences" ("organization_id", "name", "value")
    VALUES (${context.organizationId}, ${name}, 1)
    ON CONFLICT ("organization_id", "name") DO UPDATE SET "value" = "emr_sequences"."value" + 1
    RETURNING "value"`;
  return Number(row.value);
}
