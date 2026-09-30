-- ============================================================
--  NICU — أساس مفقود: جداول ودوال كان يفترض وجودها قبل 015
--  شغّله في: Supabase > SQL Editor > New query > Run
--  آمن للتشغيل أكثر من مرة (idempotent)
-- ============================================================
--  السياق (اكتُشاف حي 2026-09-30): القاعدة الحية فيها records وprofiles
--  فقط — بينما تفترض الترحيلات 015/016+ وجود الجداول التالية:
--    orgs (لأن my_org_id/is_admin/orgs.requiredFields/branding...)
--    sessions (جدول الجلسات — تعتمده sessions.list)
--    record_audit (سجل النشاط — يعتمده audit.recent)
--  هذا الملف يبنيها بأقل عمود ممكن متوافقاً مع قراءة المحول،
--  ثم ترحيلات 015→016d تُطبّق فوقه.
--  ⚠️ لا يمس records/profiles إطلاقاً (موجودتان بالفعل).
-- ============================================================

-- ---------- 1. orgs ----------
create table if not exists public.orgs (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  code              text unique not null,
  logo_url          text,
  report_name       text,
  report_note       text,
  required_fields   jsonb not null default '{}'::jsonb,
  staff_edit_all    boolean not null default false,
  created_at        timestamptz not null default now()
);

-- ---------- 2. دوال مساعدة يعتمدها كل شيء ----------
create or replace function public.my_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and role in ('admin', 'super_admin')
  );
$$;

-- ---------- 3. سجل النشاط ----------
create table if not exists public.record_audit (
  id           bigserial primary key,
  user_id      uuid references auth.users(id),
  org_id       uuid,
  action       text not null,
  child_name   text,
  user_name    text,
  at           timestamptz not null default now(),
  cnt          int,
  batch_kind   text
);

-- ---------- 4. الجلسات النشطة ----------
create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id),
  org_id        uuid,
  email         text,
  device        text,
  ip            text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

-- ---------- 5. ربط profiles بمنظمة إن كان العمود ناقصاً ----------
-- profiles موجودة أصلاً؛ نتأكد فقط من عمود org_id (للمرحّل بين القواعد)
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='profiles' and column_name='org_id'
  ) then
    alter table public.profiles add column org_id uuid;
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='profiles' and column_name='role'
  ) then
    alter table public.profiles add column role text not null default 'staff';
  end if;
end $$;

-- ---------- 6. التحقق ----------
select
  exists (select 1 from information_schema.tables
           where table_schema='public' and table_name='orgs')            as "orgs",
  exists (select 1 from information_schema.tables
           where table_schema='public' and table_name='record_audit')    as "record_audit",
  exists (select 1 from information_schema.tables
           where table_schema='public' and table_name='sessions')        as "sessions",
  exists (select 1 from pg_proc where proname='my_org_id')              as "my_org_id",
  exists (select 1 from pg_proc where proname='is_admin')               as "is_admin";
