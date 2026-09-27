-- The GitHub account connected from the main key's Settings > GitHub page: login, avatar, when it was
-- connected, and its token encrypted by the server (AES-256-GCM). Only the server (service role) reads
-- this table, and only main-key sessions ever get to use the token.
alter table app_settings add column if not exists github jsonb;
