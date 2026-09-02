-- Recruiters landing on recruiter_onboarding.html right after the signup
-- magic link were being shown "We're having trouble loading your profile"
-- because the SELECT (and, for the self-heal fallback added alongside
-- this migration, INSERT/UPDATE) RLS policies a signed-in recruiter needs
-- for their own row were missing or incomplete. These are safe to re-run:
-- each drops-then-recreates its own named policy, so this doesn't collide
-- with whatever policies already exist under other names.

drop policy if exists "recruiters can view their own row" on recruiters;
create policy "recruiters can view their own row"
  on recruiters for select
  using (auth_user_id = auth.uid());

drop policy if exists "recruiters can insert their own row" on recruiters;
create policy "recruiters can insert their own row"
  on recruiters for insert
  with check (auth_user_id = auth.uid());

drop policy if exists "recruiters can update their own row" on recruiters;
create policy "recruiters can update their own row"
  on recruiters for update
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- Same pattern for companies, which mirrors the recruiters flow
-- (onboarding.html) and relies on the same kind of own-row access.

drop policy if exists "companies can view their own row" on companies;
create policy "companies can view their own row"
  on companies for select
  using (auth_user_id = auth.uid());

drop policy if exists "companies can insert their own row" on companies;
create policy "companies can insert their own row"
  on companies for insert
  with check (auth_user_id = auth.uid());

drop policy if exists "companies can update their own row" on companies;
create policy "companies can update their own row"
  on companies for update
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());
