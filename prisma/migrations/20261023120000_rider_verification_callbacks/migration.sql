-- Preserve signed callback intent until independent verification agrees. The provider's read
-- API may briefly lag a reversal callback; clearing the request on an older PAID read loses it.
ALTER TABLE rider_transfer_attempts ADD COLUMN last_provider_event VARCHAR(40);
