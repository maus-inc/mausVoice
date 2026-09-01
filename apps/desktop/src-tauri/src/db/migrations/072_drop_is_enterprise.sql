-- Enterprise is removed in 0.1.6. Drop the is_enterprise preference column;
-- it is no longer read or written anywhere.
ALTER TABLE user_preferences DROP COLUMN is_enterprise;
