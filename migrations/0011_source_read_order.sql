CREATE SEQUENCE social_item_source_read_seq MAXVALUE 9007199254740991;
ALTER TABLE social_items ADD COLUMN source_read_version bigint NOT NULL DEFAULT 0;
