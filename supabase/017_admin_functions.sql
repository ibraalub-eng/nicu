-- ============================================================
--  NICU — دوال الإدارة المفقودة (017) + عمود report_name
--  شغّله في: Supabase > SQL Editor > New query > Run
--  آمن للتشغيل أكثر من مرة
-- ============================================================
--  اكتُشفت حياً (2026-09-30): 7 دوال يعتمد عليها التطبيق غير
--  موجودة في القاعدة الحية (حُذفت مع المخطط القديم):
--    admin_set_role, admin_set_required_fields, org_required_fields,
--    admin_set_staff_edit_all, org_staff_edit_all,
--    admin_set_report_branding, super_create_org, resolve_orgs_for_username
--  + عمود orgs.report_name (تسمية التقرير المخصصة).
--  الدوال security definer بحراسة: مدير المنظمة في منظته فقط،
--  ومدير المنصة في أي مكان.
-- ============================================================

-- ---------- 0. عمود report_name ----------
alter table public.orgs add column if not exists report_name text;

-- ---------- 1. admin_set_role ----------
-- تغيير صلاحية مستخدم (مدير في منظته، مدير المنصة في أي مكان).
-- super_admin لا يُمنح إلا من مدير منصة.
create or replace function public.admin_set_role(
  target uuid, new_role text, new_services text[] default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller text; caller_org uuid; target_org uuid;
begin
  select role, org_id into caller, caller_org
    from public.profiles where id = auth.uid();

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

-- ---------- 2. إعدادات حقول المنظمة ----------
create or replace function public.admin_set_required_fields(
  org uuid, p_fields jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller text; caller_org uuid;
begin
  select role, org_id into caller, caller_org
    from public.profiles where id = auth.uid();

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
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(required_fields, '{}'::jsonb) from public.orgs where id = org;
$$;
grant execute on function public.org_required_fields(uuid) to authenticated;

-- ---------- 3. مفتاح «التعديل متاح لكل الموظفين» (013) ----------
create or replace function public.admin_set_staff_edit_all(org uuid, p_all boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller text; caller_org uuid;
begin
  select role, org_id into caller, caller_org
    from public.profiles where id = auth.uid();

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
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(staff_edit_all, false) from public.orgs where id = org;
$$;
grant execute on function public.org_staff_edit_all(uuid) to authenticated;

-- ---------- 4. تخصيص ترويسة التقارير ----------
create or replace function public.admin_set_report_branding(
  org uuid, p_logo_url text, p_report_name text, p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller text; caller_org uuid;
begin
  select role, org_id into caller, caller_org
    from public.profiles where id = auth.uid();

  if caller not in ('admin', 'super_admin') then
    raise exception 'هذه العملية للأداريين فقط';
  end if;
  if caller = 'admin' and org is distinct from caller_org then
    raise exception 'لا يمكنك تعديل إعدادات منظمة أخرى';
  end if;

  update public.orgs
     set logo_url = p_logo_url,
         report_name = p_report_name,
         report_note = p_note
   where id = org;
end;
$$;
grant execute on function public.admin_set_report_branding(uuid, text, text, text) to authenticated;

-- ---------- 5. إنشاء منظمة (مدير المنصة) ----------
create or replace function public.super_create_org(org_name text, org_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  caller text; new_id uuid;
begin
  select role into caller from public.profiles where id = auth.uid();
  if caller <> 'super_admin' then
    raise exception 'إنشاء المنظمات لمدير المنصة فقط';
  end if;

  org_code := lower(btrim(org_code));
  if org_code !~ '^[a-z0-9]{2,20}$' then
    raise exception 'الكود: 2–20 حرفاً إنجليزياً صغيراً أو رقماً';
  end if;

  insert into public.orgs (name, code)
  values (btrim(org_name), org_code)
  returning id into new_id;

  return new_id;
end;
$$;
grant execute on function public.super_create_org(text, text) to authenticated;

-- ---------- 6. حل كود المنظمة عند تسجيل الدخول ----------
-- اسم المستخدم نفسه قد يكون مستخدماً في أكثر من منظمة — نعيد القائمة.
create or replace function public.resolve_orgs_for_username(username text)
returns table (id uuid, name text, code text)
language sql
stable
security definer
set search_path = public
as $$
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
--  التحقق
-- ============================================================
select
  (select count(*) from pg_proc
    where proname in ('admin_set_role','admin_set_required_fields','org_required_fields',
                      'admin_set_staff_edit_all','org_staff_edit_all',
                      'admin_set_report_branding','super_create_org',
                      'resolve_orgs_for_username')) = 8 as "الدوال_الثمانية",
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='orgs'
             and column_name='report_name') as "عمود_تسمية_التقرير";
