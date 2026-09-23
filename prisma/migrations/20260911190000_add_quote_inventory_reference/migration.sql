ALTER TABLE "pharmacy_quote_items" ADD COLUMN "inventory_item_id" TEXT;
CREATE INDEX "pharmacy_quote_items_inventory_item_id_idx" ON "pharmacy_quote_items"("inventory_item_id");
ALTER TABLE "pharmacy_quote_items" ADD CONSTRAINT "pharmacy_quote_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "pharmacy_inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
