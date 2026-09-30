-- ============================================================
--  NICU — عدّاد «بانتظار الاعتماد» (ملحق 016/015)
--  شغّله في: Supabase > SQL Editor > New query > Run
--  آمن للتشغيل أكثر من مرة
-- ============================================================
--  دالة سريعة تعيد عدد سجلات منظمة المستخدم غير المعتمدة (النشطة
--  غير المحذوفة) — تُستخدم في شارة الترويسة للمدير.
-- ============================================================

create or replace function public.pending_approve_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
    from public.records
   where org_id = public.my_org_id()
     and deleted_at is null
     and approved_at is null
     and public.is_admin();
$$;

grant execute on function public.pending_approve_count() to authenticated;

-- ============================================================
--  التحقق
-- ============================================================
select exists (select 1 from pg_proc
               where proname='pending_approve_count') as "دالة_العدّاد";
