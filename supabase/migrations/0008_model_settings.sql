-- Which build models the model picker offers. A singleton row (id is always true), edited from
-- the main key's Settings > Models page; an empty array means "no settings saved yet", which the
-- app reads as "offer every buildable model" rather than an empty picker.
create table if not exists app_settings (
  id boolean primary key default true,
  enabled_models text[] not null default array[]::text[],
  updated_at timestamptz not null default now(),
  constraint app_settings_singleton check (id)
);

-- Only the server (service role) reads or writes this.
alter table app_settings enable row level security;
