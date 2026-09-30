/* =========================================================
   إعدادات الاتصال بـ Supabase
   القيم من: Supabase Dashboard > Project Settings > API
   المفتاح العام (publishable / anon) آمن للنشر في الواجهة،
   حماية البيانات تعتمد على سياسات RLS داخل قاعدة البيانات.
   ========================================================= */

window.NICU_CONFIG = {
  // ⚠️ إلزامي: انسخ رابط المشروع (Project URL) من
  //    Supabase Dashboard > Project Settings > API  وضعه هنا
  //    الصيغة: https://<project-ref>.supabase.co
  //    ملاحظة: المفتاح وحده لا يكفي — تحتاج رابط المشروع أيضاً.
  SUPABASE_URL: 'https://rpyuewupupkjqvzehqlz.supabase.co',

  SUPABASE_ANON_KEY: 'sb_publishable_Rf79UA-FPhiAQZ9gCqbGJg_wNuTZ4kH',

  // محرك قاعدة البيانات: 'supabase' (الافتراضي) | 'sqlite' | 'firebase'
  // التفاصيل في DATA_LAYER.md
  DB_ADAPTER: 'supabase',

  // اسم المنظّم الذي يظهر في الترويسة
  ORG_NAME: 'وحدة العناية المركزة لحديثي الولادة'
};
