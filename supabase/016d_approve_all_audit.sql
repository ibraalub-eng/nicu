-- ============================================================
--  NICU — توثيق الاعتماد الدفعي في جدول التدقيق (ملحق 016c/015)
--  شغّله في: Supabase > SQL Editor > New query > Run
--  آمن للتشغيل أكثر من مرة
-- ============================================================
--  الجديد:
--   1) عمودان إضافيان في record_audit لتوثيق العمليات الجماعية:
--        cnt        = عدد السجلات المتأثرة (NULL = عملية فردية)
--        batch_kind = نوع الدفعة ('approve_all' حالياً)
--   2) إعادة تعريف admin_approve_all_pending() بحيث تكتب صف
--      تدقيق واحد بعدد السجلات المُعتمدة وهوية المنفّذ (auth.uid()
--      تُخزّن في user_id، والاسم يُستنتج من profiles عند العرض).
--      صف واحد للدفعة كلها (وليس صفاً لكل سجل) — سجل الحقول
--      الفردية يتولاه زر الاعتماد الفردي كالسابق.
-- ============================================================

-- ---------- 1. بنية record_audit (تحصين استباقي) ----------
alter table public.record_audit
  add column if not exists cnt int;
alter table public.record_audit
  add column if not exists batch_kind text;

comment on column public.record_audit.cnt is
  'عدد السجلات المتأثرة في العمليات الجماعية — NULL للعمليات الفردية';
comment on column public.record_audit.batch_kind is
  'نوع الدفعة: approve_all (اعتماد الكل) — NULL للعمليات الفردية';

-- ---------- 2. دالة الاعتماد الدفعي مع التوثيق ----------
create or replace function public.admin_approve_all_pending()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role text;
  actor_org  uuid;
  n int;
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

  -- توثيق الدفعة: صف واحد بعدد السجلات وهوية المنفّذ
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
--  التحقق
-- ============================================================
select exists (select 1 from pg_proc
               where proname = 'admin_approve_all_pending') as "دالة_اعتماد_الكل",
       (select count(*) from information_schema.columns
        where table_schema = 'public'
          and table_name = 'record_audit'
          and column_name in ('cnt','batch_kind')) = 2 as "عمودا_التوثيق";
