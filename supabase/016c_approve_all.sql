-- ============================================================
--  NICU — اعتماد الكل دفعة واحدة (ملحق 016b/015)
--  شغّله في: Supabase > SQL Editor > New query > Run
--  آمن للتشغيل أكثر من مرة
-- ============================================================
--  دالة تعتمد كل سجلات «بانتظار الاعتماد» في منظمة المدير
--  بنفس قواعد admin_approve_record (015) لكن دفعة واحدة،
--  وتعيد عدد السجلات التي اعتُمدت (لرسالة التوست).
-- ============================================================

create or replace function public.admin_approve_all_pending()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role text;
  n int;
begin
  select role into actor_role
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
  return n;
end;
$$;

grant execute on function public.admin_approve_all_pending() to authenticated;

-- ============================================================
--  التحقق
-- ============================================================
select exists (select 1 from pg_proc
               where proname = 'admin_approve_all_pending') as "دالة_اعتماد_الكل";
