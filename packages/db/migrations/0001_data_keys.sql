CREATE TABLE `data_keys` (
	`version` integer PRIMARY KEY NOT NULL,
	`wrapped_key` blob NOT NULL,
	`nonce` blob NOT NULL,
	`created_at` integer NOT NULL
);
