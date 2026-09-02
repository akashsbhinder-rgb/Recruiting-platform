-- "recruiters can see who they referred" (20260831120500) does a
-- `select ... from recruiters r2` inside a policy defined ON recruiters,
-- which Postgres re-evaluates against that same policy for every row it
-- touches -> infinite recursion ("infinite recursion detected in policy
-- for relation recruiters"), breaking every read of the table (candidate
-- counts, the waitlist/login screens, onboarding, everything).
--
-- Fix: look up the caller's own referral_code through a `security definer`
-- function instead. Running as the function owner bypasses RLS for that
-- one lookup, so it no longer re-enters the recruiters policy it's part of.

create or replace function my_recruiter_referral_code()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select referral_code from recruiters where auth_user_id = auth.uid()
$$;

drop policy if exists "recruiters can see who they referred" on recruiters;
create policy "recruiters can see who they referred"
  on recruiters for select
  using (
    referred_by_code is not null
    and referred_by_code = my_recruiter_referral_code()
  );
