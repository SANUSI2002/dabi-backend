-- Vendor categories and letter-template categories become the organization's own lists (Settings →
-- Master Data; the values used until now are the starter items). The services check each value; the
-- database keeps the rest of each check and widens the columns to a list item's 120 characters.
ALTER TABLE "acct_vendors" DROP CONSTRAINT "acct_vendors_check";
ALTER TABLE "acct_vendors" ADD CONSTRAINT "acct_vendors_check" CHECK (length(btrim("category")) > 0 AND "payment_terms_days" BETWEEN 0 AND 365);
ALTER TABLE "acct_vendors" ALTER COLUMN "category" TYPE VARCHAR(120);

ALTER TABLE "platform_letter_templates" DROP CONSTRAINT "platform_letter_templates_values_check";
ALTER TABLE "platform_letter_templates" ADD CONSTRAINT "platform_letter_templates_values_check" CHECK (length(btrim("category")) > 0 AND "key" ~ '^[a-z0-9][a-z0-9-]{1,59}$');
ALTER TABLE "platform_letter_templates" ALTER COLUMN "category" TYPE VARCHAR(120);
