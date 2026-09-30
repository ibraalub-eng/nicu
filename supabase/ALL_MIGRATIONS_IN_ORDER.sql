-- ============================================================
--  NICU — دليل الترحيل الكامل بترتيب التنفيذ (2026-09-30)
--  شغّله في: Supabase > SQL Editor > New query > Run — مرة واحدة
--  (كل قسم آمن للتشغيل المتكرر)
-- ============================================================
--  الوضع الحي المؤكد بالفحص: الجداول records وprofiles موجودة،
--  لكن مفقود: orgs / sessions / record_audit / دوال المساعدة /
--  أعمدة وRPCs الترحيلات 015→016d. هذا الملف يجمع كل شيء بالترتيب.
--  بعد التشغيل: أعِد تحميل التطبيق (Ctrl+Shift+R) واختبر «السجلات».
-- ============================================================

\echo '===== 1/6: الأساس المفقود (orgs + دوال + record_audit + sessions) ====='

-- ⚠️ ملاحظة: نفّذ الأقسام كملفات منفصلة بالترتيب إن لم يدعم محرر
--    Supabase أمر \echo؛ المحتوى أدناه منسوخ كاملاً من الملفات:

-- ============================================================
-- [1] supabase/000_baseline_missing.sql
-- ============================================================
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

create or replace function public.my_org_id()
returns uuid language sql stable security definer
set search_path = public as $$
  select org_id from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (select 1 from public.profiles
                  where id = auth.uid() and role in ('admin','super_admin'));
$$;

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

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='profiles' and column_name='org_id') then
    alter table public.profiles add column org_id uuid;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='profiles' and column_name='role') then
    alter table public.profiles add column role text not null default 'staff';
  end if;
end $$;

-- ============================================================
-- [2] supabase/015_edit_window_72h.sql  (الأعمدة + النافذة + RPC اعتماد)
-- ============================================================
alter table public.records add column if not exists approved_at timestamptz;
alter table public.records add column if not exists approved_by uuid references auth.users(id);

create or replace function public.staff_edit_window_open(rec public.records)
returns boolean language sql stable security definer
set search_path = public as $$
  select rec.approved_at is null
     and rec.updated_at > now() - interval '72 hours'
$$;

-- ============================================================
-- [3] supabase/016_soft_delete.sql
-- ============================================================
alter table public.records add column if not exists deleted_at timestamptz;
alter table public.records add column if not exists deleted_by uuid references auth.users(id);
create index if not exists records_deleted_idx on public.records (deleted_at) where deleted_at is not null;

-- ============================================================
-- [4] supabase/016b_pending_count.sql
-- ============================================================
create or replace function public.pending_approve_count()
returns integer language sql stable security definer
set search_path = public as $$
  select count(*)::int
    from public.records
   where org_id = public.my_org_id()
     and deleted_at is null
     and approved_at is null
     and public.is_admin();
$$;
grant execute on function public.pending_approve_count() to authenticated;

-- ============================================================
-- [5] supabase/017_admin_functions.sql  (034): دوال الإدارة المفقودة
-- ============================================================
alter table public.orgs add column if not exists report_name text;

create or replace function public.admin_set_role(
  target uuid, new_role text, new_services text[] default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  caller text; caller_org uuid; target_org uuid;
begin
  select role, org_id into caller, caller_org from public.profiles where id = auth.uid();
  if caller not in ('admin', 'super_admin') then
    raise exception 'هذه العملية للأداريين فقط';
  end if;
  select org_id into target_org from public.profiles where id = target;
  if caller = 'admin' and target_org is distinct from caller_org then
    raise exception 'لا يمكنك التصرف على مستخدم من منظمة أخرى';
  end if;
  if caller = 'admin' and new_role = 'super_admin' then
    raise exception 'صلاحية مدير المنصة لمدير المنصة فقط';
  end if;
  if new_role not in ('admin', 'staff', 'viewer', 'super_admin') then
    raise exception 'دور غير صالح';
  end if;
  update public.profiles
     set role = new_role,
         service_access = case when new_role = 'staff' and coalesce(array_length(new_services, 1), 0) > 0
                               then 'limited' else 'all' end,
         services = case when new_role = 'staff' then new_services else null end
   where id = target;
end;
$$;
grant execute on function public.admin_set_role(uuid, text, text[]) to authenticated;

create or replace function public.admin_set_required_fields(org uuid, p_fields jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare caller text; caller_org uuid;
begin
  select role, org_id into caller, caller_org from public.profiles where id = auth.uid();
  if caller not in ('admin', 'super_admin') then
    raise exception 'هذه العملية للأداريين فقط';
  end if;
  if caller = 'admin' and org is distinct from caller_org then
    raise exception 'لا يمكنك تعديل إعدادات منظمة أخرى';
  end if;
  update public.orgs set required_fields = p_fields where id = org;
end;
$$;
grant execute on function public.admin_set_required_fields(uuid, jsonb) to authenticated;

create or replace function public.org_required_fields(org uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(required_fields, '{}'::jsonb) from public.orgs where id = org;
$$;
grant execute on function public.org_required_fields(uuid) to authenticated;

create or replace function public.admin_set_staff_edit_all(org uuid, p_all boolean)
returns void language plpgsql security definer set search_path = public as $$
declare caller text; caller_org uuid;
begin
  select role, org_id into caller, caller_org from public.profiles where id = auth.uid();
  if caller not in ('admin', 'super_admin') then
    raise exception 'هذه العملية للأداريين فقط';
  end if;
  if caller = 'admin' and org is distinct from caller_org then
    raise exception 'لا يمكنك تعديل إعدادات منظمة أخرى';
  end if;
  update public.orgs set staff_edit_all = p_all where id = org;
end;
$$;
grant execute on function public.admin_set_staff_edit_all(uuid, boolean) to authenticated;

create or replace function public.org_staff_edit_all(org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(staff_edit_all, false) from public.orgs where id = org;
$$;
grant execute on function public.org_staff_edit_all(uuid) to authenticated;

create or replace function public.admin_set_report_branding(
  org uuid, p_logo_url text, p_report_name text, p_note text
)
returns void language plpgsql security definer set search_path = public as $$
declare caller text; caller_org uuid;
begin
  select role, org_id into caller, caller_org from public.profiles where id = auth.uid();
  if caller not in ('admin', 'super_admin') then
    raise exception 'هذه العملية للأداريين فقط';
  end if;
  if caller = 'admin' and org is distinct from caller_org then
    raise exception 'لا يمكنك تعديل إعدادات منظمة أخرى';
  end if;
  update public.orgs
     set logo_url = p_logo_url, report_name = p_report_name, report_note = p_note
   where id = org;
end;
$$;
grant execute on function public.admin_set_report_branding(uuid, text, text, text) to authenticated;

create or replace function public.super_create_org(org_name text, org_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare caller text; new_id uuid;
begin
  select role into caller from public.profiles where id = auth.uid();
  if caller <> 'super_admin' then
    raise exception 'إنشاء المنظمات لمدير المنصة فقط';
  end if;
  org_code := lower(btrim(org_code));
  if org_code !~ '^[a-z0-9]{2,20}$' then
    raise exception 'الكود: 2–20 حرفاً إنجليزياً صغيراً أو رقماً';
  end if;
  insert into public.orgs (name, code) values (btrim(org_name), org_code)
  returning id into new_id;
  return new_id;
end;
$$;
grant execute on function public.super_create_org(text, text) to authenticated;

create or replace function public.resolve_orgs_for_username(username text)
returns table (id uuid, name text, code text)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.code
    from public.orgs o
   where exists (
     select 1 from public.profiles p
      where p.org_id = o.id
        and p.email like lower(btrim(username)) || '@' || o.code || '%'
   )
   order by o.name;
$$;
grant execute on function public.resolve_orgs_for_username(text) to authenticated;

-- ============================================================
-- [6] supabase/016d_approve_all_audit.sql
-- ============================================================
alter table public.record_audit add column if not exists cnt int;
alter table public.record_audit add column if not exists batch_kind text;

create or replace function public.admin_approve_all_pending()
returns integer language plpgsql security definer
set search_path = public as $$
declare
  actor_role text; actor_org uuid; n int;
begin
  select role, org_id into actor_role, actor_org
    from public.profiles where id = auth.uid();

  if actor_role not in ('admin', 'super_admin') then
    raise exception 'الاعتماد للمدير فقط';
  end if;

  update public.records
     set approved_at = now(),
         approved_by = auth.uid()
   where org_id = public.my_org_id()
     and deleted_at is null
     and approved_at is null;

  get diagnostics n = row_count;

  if n > 0 then
    insert into public.record_audit (user_id, org_id, action, batch_kind, cnt)
    values (auth.uid(),
            coalesce(public.my_org_id(), actor_org),
            'approve_all', 'approve_all', n);
  end if;

  return n;
end;
$$;
grant execute on function public.admin_approve_all_pending() to authenticated;

-- ============================================================
-- [7] دوال الاعتماد الفردي والحذف الناعم والاستعادة
--     (تعريفات كاملة من 015/016 — النسخ المتبقية منها بعد الحذف الخارجي)
-- ============================================================
create or replace function public.admin_approve_record(rec_id uuid)
returns void language plpgsql security definer
set search_path = public as $$
declare
  actor_role text; actor_org uuid; rec_org uuid;
begin
  select role, org_id into actor_role, actor_org
    from public.profiles where id = auth.uid();

  if actor_role not in ('admin', 'super_admin') then
    raise exception 'الاعتماد للمدير فقط';
  end if;

  select org_id into rec_org from public.records where id = rec_id;
  if actor_role = 'admin' and rec_org is distinct from actor_org then
    raise exception 'لا يمكنك اعتماد سجل في منظمة أخرى';
  end if;

  update public.records
     set approved_at = now(), approved_by = auth.uid()
   where id = rec_id;
end;
$$;
grant execute on function public.admin_approve_record(uuid) to authenticated;

create or replace function public.admin_unapprove_record(rec_id uuid)
returns void language plpgsql security definer
set search_path = public as $$
declare
  actor_role text; rec_org uuid;
begin
  select role into actor_role from public.profiles where id = auth.uid();

  if actor_role not in ('admin', 'super_admin') then
    raise exception 'إلغاء الاعتماد للمدير فقط';
  end if;

  select org_id into rec_org from public.records where id = rec_id;
  if actor_role = 'admin' and rec_org is distinct from actor_org then
    raise exception 'لا يمكنك تعديل سجل في منظمة أخرى';
  end if;

  update public.records
     set approved_at = null, approved_by = null
   where id = rec_id;
end;
$$;
grant execute on function public.admin_unapprove_record(uuid) to authenticated;

create or replace function public.soft_delete_record(rec_id uuid)
returns void language plpgsql security definer
set search_path = public as $$
declare
  actor_role text; actor_org uuid; rec_org uuid;
begin
  select role, org_id into actor_role, actor_org
    from public.profiles where id = auth.uid();

  select org_id into rec_org from public.records where id = rec_id;

  if actor_role in ('admin','super_admin') then
    if actor_role = 'admin' and rec_org is distinct from actor_org then
      raise exception 'لا يمكنك حذف سجل في منظمة أخرى';
    end if;
  else
    -- الموظف: سجله فقط + خلال نافذة 72 ساعة + غير معتمد
    if rec_org is distinct from actor_org
       or not exists (select 1 from public.records
                       where id = rec_id
                         and created_by = auth.uid()
                         and approved_at is null
                         and updated_at > now() - interval '72 hours') then
      raise exception 'لا يمكنك حذف هذا السجل';
    end if;
  end if;

  update public.records
     set deleted_at = now(), deleted_by = auth.uid()
   where id = rec_id and deleted_at is null;
end;
$$;
grant execute on function public.soft_delete_record(uuid) to authenticated;

create or replace function public.restore_record(rec_id uuid)
returns void language plpgsql security definer
set search_path = public as $$
declare
  actor_role text; actor_org uuid; rec_org uuid;
begin
  select role, org_id into actor_role, actor_org
    from public.profiles where id = auth.uid();

  if actor_role not in ('admin','super_admin') then
    raise exception 'الاستعادة للمدير فقط';
  end if;

  select org_id into rec_org from public.records where id = rec_id;
  if actor_role = 'admin' and rec_org is distinct from actor_org then
    raise exception 'لا يمكنك استعادة سجل في منظمة أخرى';
  end if;

  update public.records
     set deleted_at = null, deleted_by = null
   where id = rec_id
     and deleted_at is not null
     and deleted_at > now() - interval '30 days';
end;
$$;
grant execute on function public.restore_record(uuid) to authenticated;


-- ============================================================
-- [9] supabase/018_security_harden.sql  (037): تحصين الأمان
--     سحب EXECUTE الافتراضي من العام على دوال الإدارة
--     (امتياز EXECUTE الافتراضي لـ PUBLIC كان يتيح التنفيذ
--     المجهول رغم منح authenticated) + حراسة caller is null
--     في كل الحارس + تقييد العدّاد بـ is_admin + التنظيف
--     للمدير عبر HTTP ومتاح داخلياً لـ pg_cron.
--     التفاصيل الكاملة والتحقق النهائي في 018_security_harden.sql
--     — شغّله مباشرة أو شغّل هذا الملف كاملاً ثم 018.
-- ============================================================

-- ============================================================
-- التحقق النهائي
-- ============================================================
select
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='records' and column_name='approved_at') as "015 أعمدة",
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='records' and column_name='deleted_at') as "016 أعمدة",
  exists (select 1 from pg_proc where proname='pending_approve_count')                  as "عدّاد",
  exists (select 1 from pg_proc where proname='admin_approve_all_pending')              as "اعتماد الكل",
  exists (select 1 from pg_proc where proname='soft_delete_record')                     as "حذف ناعم",
  exists (select 1 from pg_proc where proname='restore_record')                         as "استعادة",
  (select count(*) from pg_proc
    where proname in ('admin_set_role','admin_set_required_fields','org_required_fields',
                      'admin_set_staff_edit_all','org_staff_edit_all',
                      'admin_set_report_branding','super_create_org',
                      'resolve_orgs_for_username')) = 8                                  as "دوال الإدارة 8",
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='orgs' and column_name='report_name') as "تسمية التقرير",
  exists (select 1 from information_schema.tables
           where table_schema='public' and table_name='orgs')                           as "orgs",
  exists (select 1 from information_schema.tables
           where table_schema='public' and table_name='record_audit')                   as "التدقيق",
  exists (select 1 from information_schema.tables
           where table_schema='public' and table_name='sessions')                       as "الجلسات";
