-- Refer & earn program: each recruiter gets a shareable referral_code,
-- and a new recruiter's signup can carry the referred_by_code of whoever
-- sent them. referral_bonuses tracks the 15% cut a referrer earns on the
-- FIRST placement fee their referred recruiter gets paid for -- the
-- unique(referred_recruiter_id) constraint is what enforces "first only".

alter table recruiters
  add column if not exists referral_code text,
  add column if not exists referred_by_code text;

create unique index if not exists recruiters_referral_code_key
  on recruiters (referral_code) where referral_code is not null;

create table if not exists referral_bonuses (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references recruiters(id) on delete cascade,
  referred_recruiter_id uuid not null references recruiters(id) on delete cascade,
  placement_id uuid not null references placements(id) on delete cascade,
  pct numeric not null,
  amount numeric not null,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (referred_recruiter_id)
);

alter table referral_bonuses enable row level security;

create policy "recruiters view their own referral bonuses"
  on referral_bonuses for select
  using (referrer_id in (select id from recruiters where auth_user_id = auth.uid()));
