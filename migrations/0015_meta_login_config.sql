ALTER TABLE meta_settings ADD COLUMN login_config_id text CHECK (login_config_id IS NULL OR login_config_id ~ '^[0-9]+$');
