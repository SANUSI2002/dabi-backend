-- Policy categories, helpdesk ticket types and recruitment sources become the organization's own lists
-- (Settings → Master Data; the values used until now are the starter items). The services check each
-- value against the list; the database keeps the rest of each check and widens the columns to a list
-- item's 120 characters.
ALTER TABLE "wf_policies" DROP CONSTRAINT "wf_policies_category_check";
ALTER TABLE "wf_policies" ADD CONSTRAINT "wf_policies_category_check" CHECK (length(btrim("category")) > 0);
ALTER TABLE "wf_policies" ALTER COLUMN "category" TYPE VARCHAR(120);

ALTER TABLE "wf_tickets" DROP CONSTRAINT "wf_tickets_values_check";
ALTER TABLE "wf_tickets" ADD CONSTRAINT "wf_tickets_values_check" CHECK (
  length(btrim("type")) > 0 AND "assigning_type" IN ('Individual', 'Department', 'Job Position') AND
  "priority" BETWEEN 1 AND 3 AND "status" IN ('New', 'In Progress', 'On Hold', 'Resolved') AND (("status" = 'Resolved') = ("resolved_at" IS NOT NULL))
);
ALTER TABLE "wf_tickets" ALTER COLUMN "type" TYPE VARCHAR(120);

ALTER TABLE "wf_candidates" DROP CONSTRAINT "wf_candidates_values_check";
ALTER TABLE "wf_candidates" ADD CONSTRAINT "wf_candidates_values_check" CHECK (
  length(btrim("source")) > 0 AND "rating" BETWEEN 0 AND 5 AND ("canceled" = false OR "cancel_reason" IS NOT NULL) AND NOT ("hired" AND "canceled")
);
ALTER TABLE "wf_candidates" ALTER COLUMN "source" TYPE VARCHAR(120);
