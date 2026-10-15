CREATE TABLE `recording_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`mode` text NOT NULL,
	`options_json` text NOT NULL,
	`pauses_json` text DEFAULT '[]' NOT NULL,
	`temp_dir` text NOT NULL,
	`title` text,
	`recording_id` text,
	`error` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`active_duration_ms` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `recording_sessions` (`status`);--> statement-breakpoint
CREATE TABLE `recording_tags` (
	`recording_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`recording_id`, `tag_id`),
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`file_path` text NOT NULL,
	`thumbnail_path` text,
	`status` text NOT NULL,
	`error` text,
	`duration_ms` integer,
	`width` integer,
	`height` integer,
	`fps` real,
	`file_size` integer,
	`video_codec` text,
	`audio_codec` text,
	`has_audio` integer DEFAULT false NOT NULL,
	`has_camera` integer DEFAULT false NOT NULL,
	`session_id` text,
	`source_recording_id` text,
	`trim_start_ms` integer,
	`trim_end_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recordings_created_idx` ON `recordings` (`created_at`);--> statement-breakpoint
CREATE INDEX `recordings_session_idx` ON `recordings` (`session_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`file_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`start_offset_ms` real,
	`bytes_written` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `recording_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tracks_session_idx` ON `source_tracks` (`session_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);