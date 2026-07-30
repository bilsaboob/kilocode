CREATE TABLE `kilo_session_file_activity` (
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`part_id` text NOT NULL,
	`call_id` text NOT NULL,
	`tool` text NOT NULL,
	`path` text NOT NULL,
	`action` text NOT NULL,
	`time_created` integer NOT NULL,
	CONSTRAINT `kilo_session_file_activity_pk` PRIMARY KEY(`part_id`, `path`, `action`),
	CONSTRAINT `fk_kilo_session_file_activity_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `kilo_session_file_activity_session_time_idx` ON `kilo_session_file_activity` (`session_id`,`time_created`,`message_id`,`part_id`);