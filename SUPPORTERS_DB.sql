-- Run this in Supabase SQL editor.
-- Supports: accumulated totals, unique donor identity by email, notes.

create table if not exists supporters (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  note text,
  social_url text,
  total_cents integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- If the table already exists, run this once:
alter table supporters add column if not exists social_url text;

create table if not exists donations (
  id uuid primary key default gen_random_uuid(),
  supporter_id uuid references supporters(id) on delete cascade,
  amount_cents integer not null,
  stripe_payment_intent_id text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists supporters_total_idx on supporters(total_cents desc);

