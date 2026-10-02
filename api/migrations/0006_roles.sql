ALTER TABLE carbon_units ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'moderator', 'member'));
UPDATE carbon_units SET role = 'moderator' WHERE is_admin = 1;
