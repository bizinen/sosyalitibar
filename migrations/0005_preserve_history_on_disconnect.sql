ALTER TABLE social_items
  DROP CONSTRAINT IF EXISTS social_items_connection_id_fkey;
ALTER TABLE social_items
  ADD CONSTRAINT social_items_connection_id_fkey
  FOREIGN KEY (connection_id) REFERENCES social_connections(id) ON DELETE SET NULL;
