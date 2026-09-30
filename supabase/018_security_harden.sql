-- ============================================================
--  018 — تحصين الأمان: إغلاق فجوة «EXECUTE للمجهول»
--  الخلفية (كشف حي 2026-09-30):
--    1. دوال security definer بلا revoke من العام تظل قابلة
--       للتنفيذ من أي مجهول (امتياز EXECUTE الافتراضي لـ PUBLIC)
--       رغم منح «to authenticated» الظاهر في الملفات.
--    2. حارس «caller not in (...)» لا يشتعل حين caller = NULL
--       (مجهول) لأن المقارنة تقيّم NULL وتسقط بصمت — ثبت حياً أن
--       admin_set_required_fields / admin_set_staff_edit_all /
--       admin_set_report_branding نفّذت تحديثاً فعلياً لمجهول (204)،
--       وadmin_approve_all_pending / purge_deleted_records كذلك.
--  العلاج هنا (idempotent — آمن للتكرار):
--    A. revoke execute ... from public لكل دوال الإدارة ثم إعادة
--       المنح لـ authenticated صراحة.
--    B. حراسة «caller is null or ...» في كل الدوال المحمية.
--    C. pending_approve_count تُقيَّد بـ is_admin() في WHERE.
--    D. purge_deleted_records: مدير فقط عبر HTTP، ومتاحة
--       داخلياً (pg_cron) حيث لا توجد ترويسات طلب.
--    E. resolve_orgs_for_username تبقى عامة عمداً (تحتاجها شاشة
--       الدخول قبل المصادقة) — منحة صريحة لـ anon + authenticated.
--  ملاحظة: لا تمس my_org_id/is_admin — تستخدمها سياسات RLS
--  ويجب أن تبقى قابلة للتنفيذ من كل الأدوار (آمنتان بذاتهما).
-- ============================================================

-- ---------- A+B. الدوال الإدارية: حارس NULL + منح صريح ----------

create or replace function public.admin_set_role(
  target uuid, new_role text, new_services text[] default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  caller text; caller_org uuid; target_org uuid;
begin
  select role, org_id into caller, caller_org from public.profiles where id = auth.uid();
  if caller is null or caller not in ('admin', 'super_admin') then
    raise exception 'هذه العملية للمديرين فقط';
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
revoke execute on function public.admin_set_role(uuid, text, text[]) from public;
grant execute on function public.admin_set_role(uuid, text, text[]) to authenticated;

create or replace function public.admin_set_required_fields(org uuid, p_fields jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare caller text; caller_org uuid;
begin
  select role, org_id into caller, caller_org from public.profiles where id = auth.uid();
  if caller is null or caller not in ('admin', 'super_admin') then
    raise exception 'هذه العملية للأداريين فقط';
  end if;
  if caller = 'admin' and org is distinct from caller_org then
    raise exception 'لا يمكنك تعديل إعدادات منظمة أخرى';
  end if;
  update public.orgs set required_fields = p_fields where id = org;
end;
$$;
revoke execute on function public.admin_set_required_fields(uuid, jsonb) from public;
grant execute on function public.admin_set_required_fields(uuid, jsonb) to authenticated;

create or replace function public.admin_set_staff_edit_all(org uuid, p_all boolean)
returns void language plpgsql security definer set search_path = public as $$
declare caller text; caller_org uuid;
begin
  select role, org_id into caller, caller_org from public.profiles where id = auth.uid();
  if caller is null or caller not in ('admin', 'super_admin') then
    raise exception 'هذه العملية للأداريين فقط';
  end if;
  if caller = 'admin' and org is distinct from caller_org then
    raise exception 'لا يمكنك تعديل إعدادات منظمة أخرى';
  end if;
  update public.orgs set staff_edit_all = p_all where id = org;
end;
$$;
revoke execute on function public.admin_set_staff_edit_all(uuid, boolean) from public;
grant execute on function public.admin_set_staff_edit_all(uuid, boolean) to authenticated;

create or replace function public.admin_set_report_branding(
  org uuid, p_logo_url text, p_report_name text, p_note text
)
returns void language plpgsql security definer set search_path = public as $$
declare caller text; caller_org uuid;
begin
  select role, org_id into caller, caller_org from public.profiles where id = auth.uid();
  if caller is null or caller not in ('admin', 'super_admin') then
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
revoke execute on function public.admin_set_report_branding(uuid, text, text, text) from public;
grant execute on function public.admin_set_report_branding(uuid, text, text, text) to authenticated;

create or replace function public.super_create_org(org_name text, org_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare caller text; new_id uuid;
begin
  select role into caller from public.profiles where id = auth.uid();
  if caller is null or caller <> 'super_admin' then
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
revoke execute on function public.super_create_org(text, text) from public;
grant execute on function public.super_create_org(text, text) to authenticated;

-- ---------- C. اعتماد الكل: حارس NULL + تقييد العدّاد ----------

create or replace function public.admin_approve_all_pending()
returns integer language plpgsql security definer
set search_path = public as $$
declare
  actor_role text; actor_org uuid; n int;
begin
  select role, org_id into actor_role, actor_org
    from public.profiles where id = auth.uid();

  if actor_role is null or actor_role not in ('admin', 'super_admin') then
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
revoke execute on function public.admin_approve_all_pending() from public;
grant execute on function public.admin_approve_all_pending() to authenticated;

create or replace function public.pending_approve_count()
returns bigint language sql stable security definer
set search_path = public as $$
  select count(*) from public.records
   where public.is_admin()
     and org_id = public.my_org_id()
     and deleted_at is null
     and approved_at is null;
$$;
revoke execute on function public.pending_approve_count() from public;
grant execute on function public.pending_approve_count() to authenticated;

-- ---------- D. دوال 015/016: سحب العام + منح صريح ----------
-- (حراسها الشرطية where is_admin()/my_org_id() سليمة للمجهول —
--  تعيد false/null فيسقط التحديث/الحذف بلا صفوف)

revoke execute on function public.admin_approve_record(uuid) from public;
grant execute on function public.admin_approve_record(uuid) to authenticated;
revoke execute on function public.admin_unapprove_record(uuid) from public;
grant execute on function public.admin_unapprove_record(uuid) to authenticated;
revoke execute on function public.soft_delete_record(uuid) from public;
grant execute on function public.soft_delete_record(uuid) to authenticated;
revoke execute on function public.restore_record(uuid) from public;
grant execute on function public.restore_record(uuid) to authenticated;

-- التنظيف: مدير فقط عند الاستدعاء عبر HTTP، ومتاح داخلياً (pg_cron)
create or replace function public.purge_deleted_records()
returns integer language plpgsql security definer
set search_path = public as $$
declare
  n integer;
  caller text;
begin
  select role into caller from public.profiles where id = auth.uid();
  if coalesce(current_setting('request.headers', true), '') <> '' then
    if caller is null or caller not in ('admin', 'super_admin') then
      raise exception 'التنظيف للمديرين فقط';
    end if;
  end if;
  delete from public.records
   where deleted_at is not null
     and deleted_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.purge_deleted_records() from public;
grant execute on function public.purge_deleted_records() to authenticated;

-- ---------- E. دوال القراءة/الدخول ----------

-- القارئتان: منح صريح لـ authenticated (قراءة فقط — بلا خطر)
revoke execute on function public.org_required_fields(uuid) from public;
grant execute on function public.org_required_fields(uuid) to authenticated;
revoke execute on function public.org_staff_edit_all(uuid) from public;
grant execute on function public.org_staff_edit_all(uuid) to authenticated;

-- كشف كود المنظمة عند الدخول: تبقى عامة عمداً (قبل المصادقة)
revoke execute on function public.resolve_orgs_for_username(text) from public;
grant execute on function public.resolve_orgs_for_username(text) to anon, authenticated;

-- ---------- التحقق النهائي ----------
-- كل الأعمدة يجب أن تكون صحيحة:
--   الممنوع على المجهول = false، والمسموح = true
select
  has_function_privilege('anon', 'public.admin_set_role(uuid,text,text[])', 'execute')            as "role_ممنوع_مجهول",
  has_function_privilege('anon', 'public.admin_set_report_branding(uuid,text,text,text)', 'execute') as "ترويسة_ممنوع_مجهول",
  has_function_privilege('anon', 'public.admin_approve_all_pending()', 'execute')                 as "اعتماد_الكل_ممنوع_مجهول",
  has_function_privilege('anon', 'public.purge_deleted_records()', 'execute')                     as "تنظيف_ممنوع_مجهول",
  has_function_privilege('anon', 'public.pending_approve_count()', 'execute')                     as "عداد_ممنوع_مجهول",
  has_function_privilege('anon', 'public.resolve_orgs_for_username(text)', 'execute')             as "كشف_الكود_عام_مقصود",
  has_function_privilege('authenticated', 'public.admin_set_role(uuid,text,text[])', 'execute')   as "role_متاح_للمديرين",
  has_function_privilege('authenticated', 'public.admin_set_report_branding(uuid,text,text,text)', 'execute') as "ترويسة_متاحة_للمديرين";
