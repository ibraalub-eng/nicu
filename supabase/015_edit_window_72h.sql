-- ============================================================
--  NICU — قصر تعديل الموظف على 72 ساعة أو قبل الاعتماد (015)
--  شغّله في: Supabase > SQL Editor > New query > Run
--  آمن للتشغيل أكثر من مرة
-- ============================================================
--  القاعدة الجديدة:
--   • الموظف (staff) يعدّل/يحذف السجل فقط إذا كان:
--       غير معتمد  و  خلال 72 ساعة من آخر تحديث/إنشاء له.
--   • بعد أن يعتمد المدير السجل (approve) يصبح غير قابل للتعديل
--     لأي موظف نهائياً — يُلغى الاعتماد بإلغاء الاعتماد فقط.
--   • فات التوقيت (72 ساعة)؟ المدير يستطيع إعادة فتح السجل بإلغاء
--     الاعتماد ثم إعادة الاعتماد بعد تصحيح الموظف — أو يعدّله بنفسه.
--   • المدير (admin/super_admin) كما هو: يعدّل ويحذف دائماً.
--   • نافذة الساعات تُحسب من updated_at (تتجدد مع كل تعديل).
-- ============================================================

-- ---------- 1. أعمدة الاعتماد ----------
alter table public.records
  add column if not exists approved_at timestamptz;
alter table public.records
  add column if not exists approved_by uuid references auth.users(id);

comment on column public.records.approved_at is
  'ختم اعتماد المدير — السجل المعتمد لا يعدّله الموظف (015)';

-- ---------- 2. دوال النافذة والاعتماد ----------
-- هل نافذة تعديل الموظف (72 ساعة) ما زالت مفتوحة لهذا السجل؟
create or replace function public.staff_edit_window_open(rec public.records)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select rec.approved_at is null
     and rec.updated_at > now() - interval '72 hours'
$$;

-- اعتماد السجل — للمدير (أو صاحب المنظمة) فقط
create or replace function public.admin_approve_record(rec_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role text;
  actor_org  uuid;
  rec_org    uuid;
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
     set approved_at = now(),
         approved_by = auth.uid()
   where id = rec_id;
end;
$$;

grant execute on function public.admin_approve_record(uuid) to authenticated;

-- إلغاء الاعتماد — للمدير فقط (يفتح التعديل مجدداً بغضّ النظر عن الـ 72 ساعة)
create or replace function public.admin_unapprove_record(rec_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role text;
  actor_org  uuid;
  rec_org    uuid;
begin
  select role, org_id into actor_role, actor_org
    from public.profiles where id = auth.uid();

  if actor_role not in ('admin', 'super_admin') then
    raise exception 'إلغاء الاعتماد للمدير فقط';
  end if;

  select org_id into rec_org from public.records where id = rec_id;
  if actor_role = 'admin' and rec_org is distinct from actor_org then
    raise exception 'لا يمكنك تعديل سجل في منظمة أخرى';
  end if;

  update public.records
     set approved_at = null,
         approved_by = null
   where id = rec_id;
end;
$$;

grant execute on function public.admin_unapprove_record(uuid) to authenticated;

-- ---------- 3. إعادة سياسة التعديل: حصر الموظف بنافذة 72 ساعة والسجلات غير المعتمدة ----------
--  ملاحظة: with check يمنع أيضاً أن يخفي الموظف الاعتماد أو يزيّف الأعمدة الجديدة
--  (لا يرسلها النموذج أصلاً، وحقل approved_* غير موجود في toPayload).
drop policy if exists records_update on public.records;
create policy records_update on public.records
  for update to authenticated
  using (
    org_id = public.my_org_id()
    and (
      public.is_admin()
      or (
        public.can_write_service(service)
        and public.staff_edit_window_open(records)
      )
    )
  )
  with check (
    org_id = public.my_org_id()
    and (
      public.is_admin()
      or (
        public.can_write_service(service)
        and approved_at is null          -- لا يمكن إنشاء/إبقاء اعتماد من موظف
      )
    )
  );

-- الحذف: نفس قصر النافذة على الموظف (كان بلا قيد زمني بعد 012)
drop policy if exists records_delete on public.records;
create policy records_delete on public.records
  for delete to authenticated
  using (
    org_id = public.my_org_id()
    and (
      public.is_admin()
      or (
        created_by = auth.uid()
        and public.staff_edit_window_open(records)
      )
    )
  );

-- ============================================================
--  التحقق بعد التشغيل
-- ============================================================
select
  exists (select 1 from information_schema.columns
          where table_name='records' and column_name='approved_at')  as "عمود_الاعتماد",
  exists (select 1 from information_schema.columns
          where table_name='records' and column_name='approved_by')  as "عمود_المعتمِد",
  exists (select 1 from pg_proc
          where proname='staff_edit_window_open')                    as "دالة_النافذة",
  exists (select 1 from pg_proc
          where proname='admin_approve_record')                      as "دالة_الاعتماد",
  exists (select 1 from pg_proc
          where proname='admin_unapprove_record')                    as "دالة_إلغاء_الاعتماد",
  exists (select 1 from pg_policies
          where tablename='records' and policyname='records_update'
            and cmd='UPDATE')                                        as "سياسة_التعديل_الجديدة",
  exists (select 1 from pg_policies
          where tablename='records' and policyname='records_delete'
            and cmd='DELETE')                                        as "سياسة_الحذف_الجديدة";
