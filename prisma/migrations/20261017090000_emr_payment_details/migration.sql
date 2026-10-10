-- What the cashier records with a payment, beside the amount and method: the date on the transfer,
-- POS slip or cheque (which can differ from when it was entered), the account the money went into,
-- and a note. Written once with the payment; the EMR role may insert them but never change them
-- (its UPDATE grant on emr_payments stays limited to reversal columns).
ALTER TABLE "emr_payments"
  ADD COLUMN "transaction_date" DATE,
  ADD COLUMN "receiving_account" VARCHAR(60),
  ADD COLUMN "notes" VARCHAR(500);
