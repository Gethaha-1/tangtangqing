ALTER TABLE `trip_expenses` ADD COLUMN `fuel_unit_price_x10000` integer CHECK (`fuel_unit_price_x10000` IS NULL OR `fuel_unit_price_x10000` BETWEEN 1 AND 9999999);--> statement-breakpoint
ALTER TABLE `trip_expenses` ADD COLUMN `fuel_volume_ml` integer CHECK (`fuel_volume_ml` IS NULL OR `fuel_volume_ml` BETWEEN 1 AND 100000000);--> statement-breakpoint
CREATE TRIGGER `trip_expenses_fuel_metadata_insert_check`
BEFORE INSERT ON `trip_expenses`
FOR EACH ROW
WHEN NOT (
	(NEW.`fuel_unit_price_x10000` IS NULL AND NEW.`fuel_volume_ml` IS NULL) OR
	(NEW.`category_id` = 'fuel' AND
	 NEW.`fuel_unit_price_x10000` IS NOT NULL AND NEW.`fuel_volume_ml` IS NOT NULL AND
	 NEW.`fuel_unit_price_x10000` BETWEEN 1 AND 9999999 AND NEW.`fuel_volume_ml` BETWEEN 1 AND 100000000)
)
BEGIN
	SELECT RAISE(ABORT, 'trip_expenses_fuel_metadata_check');
END;--> statement-breakpoint
CREATE TRIGGER `trip_expenses_fuel_metadata_update_check`
BEFORE UPDATE OF `category_id`, `fuel_unit_price_x10000`, `fuel_volume_ml` ON `trip_expenses`
FOR EACH ROW
WHEN NOT (
	(NEW.`fuel_unit_price_x10000` IS NULL AND NEW.`fuel_volume_ml` IS NULL) OR
	(NEW.`category_id` = 'fuel' AND
	 NEW.`fuel_unit_price_x10000` IS NOT NULL AND NEW.`fuel_volume_ml` IS NOT NULL AND
	 NEW.`fuel_unit_price_x10000` BETWEEN 1 AND 9999999 AND NEW.`fuel_volume_ml` BETWEEN 1 AND 100000000)
)
BEGIN
	SELECT RAISE(ABORT, 'trip_expenses_fuel_metadata_check');
END;
