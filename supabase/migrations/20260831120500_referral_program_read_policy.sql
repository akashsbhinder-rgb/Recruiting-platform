-- Lets a recruiter count/see (only) the recruiters who used their referral
-- code -- needed for the "Recruiters referred" stat in the Refer & earn
-- tab, which otherwise comes back empty under RLS since a recruiter can
-- normally only read their own row.
create policy "recruiters can see who they referred"
  on recruiters for select
  using (
    referred_by_code is not null
    and referred_by_code = (select referral_code from recruiters r2 where r2.auth_user_id = auth.uid())
  );
