ALTER TABLE `fleet_settings` ADD `business_json` text DEFAULT '{}' NOT NULL CHECK (json_valid(`business_json`) AND json_type(`business_json`) = 'object');--> statement-breakpoint
ALTER TABLE `trips` ADD `business_json` text DEFAULT '{}' NOT NULL CHECK (json_valid(`business_json`) AND json_type(`business_json`) = 'object');
