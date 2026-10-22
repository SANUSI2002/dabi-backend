-- Drug categories and drug classes become the organization's own lists (Settings → Master Data, kept by
-- the pharmacy; seeded on first use). A formulary item's category is now a code on the drug-categories
-- list: the categories the old fixed list wrote as names are turned into their codes, and the starter
-- formulary's items get the categories new organizations start with.

UPDATE "emr_formulary_items" SET "category" = CASE "category"
  WHEN 'Analgesics & Antipyretics' THEN 'ANALGESIC'
  WHEN 'Antibiotics' THEN 'ANTIBIOTIC'
  WHEN 'Antimalarials' THEN 'ANTIMALARIAL'
  WHEN 'Antiprotozoals' THEN 'ANTIPROTOZOAL'
  WHEN 'IV Fluids & Electrolytes' THEN 'FLUIDS'
  WHEN 'Vitamins & Supplements' THEN 'VITAMIN'
  WHEN 'Opioid Analgesics' THEN 'OPIOID'
  WHEN 'Other' THEN 'OTHER'
  ELSE "category" END
WHERE "category" IN ('Analgesics & Antipyretics', 'Antibiotics', 'Antimalarials', 'Antiprotozoals', 'IV Fluids & Electrolytes', 'Vitamins & Supplements', 'Opioid Analgesics', 'Other');

UPDATE "emr_formulary_items" SET "category" = CASE "code"
  WHEN 'PARA500' THEN 'ANALGESIC' WHEN 'IBU400' THEN 'ANALGESIC' WHEN 'DICLO75_INJ' THEN 'ANALGESIC'
  WHEN 'AMOX500' THEN 'ANTIBIOTIC' WHEN 'AMOXCLAV625' THEN 'ANTIBIOTIC' WHEN 'CEFTRI1G_INJ' THEN 'ANTIBIOTIC' WHEN 'METRO400' THEN 'ANTIBIOTIC' WHEN 'CIPRO500' THEN 'ANTIBIOTIC'
  WHEN 'AL20_120' THEN 'ANTIMALARIAL' WHEN 'METF500' THEN 'ANTIDIABETIC' WHEN 'INS_SOL' THEN 'ANTIDIABETIC' WHEN 'AMLO5' THEN 'ANTIHYPERTENSIVE'
  WHEN 'OMEP20' THEN 'GASTROINTESTINAL' WHEN 'PRED5' THEN 'CORTICOSTEROID' WHEN 'FESO4_200' THEN 'HAEMATINIC' WHEN 'ZINC20' THEN 'VITAMIN'
  WHEN 'ORS' THEN 'FLUIDS' WHEN 'SALB_INH' THEN 'RESPIRATORY' WHEN 'TRAM50' THEN 'OPIOID' WHEN 'MORPH10_INJ' THEN 'OPIOID'
  END
WHERE "category" IS NULL AND "code" IN ('PARA500', 'IBU400', 'DICLO75_INJ', 'AMOX500', 'AMOXCLAV625', 'CEFTRI1G_INJ', 'METRO400', 'CIPRO500', 'AL20_120', 'METF500', 'INS_SOL', 'AMLO5', 'OMEP20', 'PRED5', 'FESO4_200', 'ZINC20', 'ORS', 'SALB_INH', 'TRAM50', 'MORPH10_INJ');

CREATE INDEX "emr_formulary_items_category_idx" ON "emr_formulary_items" ("organization_id", "category");
