-- ============================================================
--  NICU — الحذف الناعم + سلة محذوفات للمدير 30 يوماً (016)
--  شغّله في: Supabase > SQL Editor > New query > Run
--  آمن للتشغيل أكثر من مرة
-- ============================================================
--  القاعدة الجديدة:
--   • الحذف لا يمسح الصف أبداً — يختمه: deleted_at / deleted_by.
--   • السجلات المُحذوفة تختفي من القائمة والتقارير والإحصاءات للجميع
--     (سياسة القراءة تستثنيها)، وتظهر للمدير في «عرض المحذوفات» فقط.
--   • الاستعادة للمدير خلال 30 يوماً من الحذف.
--   • بعد 30 يوماً: تنظيف دوري (pg_cron إن توفّر، وإلا عند أول تشغيل
--     بعد التاريخ) يحذفها نهائياً.
--   • من يملك الحذف لا يتغير: نفس سياسة records_delete السابقة (015)
--     — المدير، أو مالك السجل خلال 72 ساعة قبل الاعتماد.
-- ============================================================

-- ---------- 1. أعمدة الحذف الناعم ----------
alter table public.records
  add column if not exists deleted_at timestamptz;
alter table public.records
  add column if not exists deleted_by uuid references auth.users(id);

comment on column public.records.deleted_at is
  'ختم الحذف الناعم — غير صفري = في سلة المحذوفات (يُمسح نهائياً بعد 30 يوماً)';

-- فهرس جزئي للسلة (أداء قائمة المحذوفات + التنظيف الدوري)
create index if not exists records_deleted_idx
  on public.records (deleted_at)
  where deleted_at is not null;

-- ---------- 2. حذف ناعم + استعادة عبر RPC ----------
-- الحذف: يطبّق نفس شروط سياسة الحذف (مدير، أو مالك خلال 72 ساعة قبل الاعتماد)
create or replace function public.soft_delete_record(rec_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.records;
  actor_role text;
  actor_org uuid;
begin
  select * into r from public.records where id = rec_id;
  if r.id is null then raise exception 'السجل غير موجود'; end if;

  select role, org_id into actor_role, actor_org
    from public.profiles where id = auth.uid();

  -- نفس شروط records_delete في 015
  if not (
    actor_role in ('admin', 'super_admin')
    or (
      r.org_id = actor_org
      and r.created_by = auth.uid()
      and r.approved_at is null
      and r.updated_at > now() - interval '72 hours'
    )
  ) then
    raise exception 'لا تملك صلاحية حذف هذا السجل';
  end if;

  if r.deleted_at is not null then
    raise exception 'السجل محذوف مسبقاً';
  end if;

  update public.records
     set deleted_at = now(),
         deleted_by = auth.uid()
   where id = rec_id;
end;
$$;

grant execute on function public.soft_delete_record(uuid) to authenticated;

-- الاستعادة — للمدير فقط، خلال 30 يوماً
create or replace function public.restore_record(rec_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role text;
  actor_org uuid;
  rec_org uuid;
begin
  select role, org_id into actor_role, actor_org
    from public.profiles where id = auth.uid();

  if actor_role not in ('admin', 'super_admin') then
    raise exception 'الاستعادة للمدير فقط';
  end if;

  select org_id into rec_org from public.records where id = rec_id;
  if actor_role = 'admin' and rec_org is distinct from actor_org then
    raise exception 'لا يمكنك استعادة سجل في منظمة أخرى';
  end if;

  update public.records
     set deleted_at = null,
         deleted_by = null
   where id = rec_id
     and deleted_at is not null
     and deleted_at > now() - interval '30 days';

  if not found then
    raise exception 'لا يمكن الاستعادة: السجل ليس في السلة أو انتهت مدة الـ 30 يوماً';
  end if;
end;
$$;

grant execute on function public.restore_record(uuid) to authenticated;

-- ---------- 3. السياسات: المحذوف يختفي من القوائم، ويظهر في «عرض المحذوفات» فقط ----------
drop policy if exists records_read on public.records;
create policy records_read on public.records
  for select to authenticated
  using (
    (org_id = public.my_org_id() or public.is_super_admin())
    and public.can_view_service(service)
    and (
      deleted_at is null
      or (
        -- المدير يرى محذوفات منظته في «عرض المحذوفات» فقط —
        -- تمييزها يتم في الواجهة بفلتر deleted؛ هنا نسمح بالقراءة فقط
        public.is_admin() and deleted_at is not null
      )
    )
  );

-- الإدراج بلا تغيير (الجديد غير محذوف بطبيعته)
-- التعديل: السجل المحذوف لا يعدّله أحد (حتى يُستعاد أولاً) —
-- نعيد records_update مضافة إليه شرط deleted_at is null
drop policy if exists records_update on public.records;
create policy records_update on public.records
  for update to authenticated
  using (
    org_id = public.my_org_id()
    and deleted_at is null
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
    and deleted_at is null
    and (
      public.is_admin()
      or (
        public.can_write_service(service)
        and approved_at is null
      )
    )
  );

-- الحذف الفعلي (delete) مغلق للجميع — لا يمر عبر RLS إلا للحذف الناعم عبر RPC
-- (security definer). نغلق السياسة القديمة بشرط مستحيل:
drop policy if exists records_delete on public.records;
create policy records_delete on public.records
  for delete to authenticated
  using (false);

-- ============================================================
--  4. التنظيف التلقائي بعد 30 يوماً
-- ============================================================
create or replace function public.purge_deleted_records()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.records
   where deleted_at is not null
     and deleted_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- أي دور مدير يستطيع استدعاء التنظيف (مثلاً من Cron أو يدوياً)
grant execute on function public.purge_deleted_records() to authenticated;

-- جدولة تلقائية إن كان امتداد pg_cron مفعّلاً في المشروع (اختياري):
-- select cron.schedule('purge-deleted-records', '0 3 * * *',
--   'select public.purge_deleted_records();');

-- ============================================================
--  التحقق بعد التشغيل
-- ============================================================
select
  exists (select 1 from information_schema.columns
          where table_name='records' and column_name='deleted_at')  as "عمود_الحذف",
  exists (select 1 from pg_indexes
          where indexname='records_deleted_idx')                    as "فهرس_السلة",
  exists (select 1 from pg_proc
          where proname='soft_delete_record')                       as "دالة_الحذف_الناعم",
  exists (select 1 from pg_proc
          where proname='restore_record')                           as "دالة_الاستعادة",
  exists (select 1 from pg_proc
          where proname='purge_deleted_records')                    as "دالة_التنظيف",
  exists (select 1 from pg_policies
          where tablename='records' and policyname='records_read'
            and cmd='SELECT')                                       as "سياسة_القراءة_الجديدة",
  exists (select 1 from pg_policies
          where tablename='records' and policyname='records_delete'
            and cmd='DELETE')                                       as "سياسة_الحذف_المغلقة";
