// Supabase Edge Function: new-user
// ---------------------------------------------------------------------------
// ينشئ حساب مستخدم جديد — للأداريين فقط.
// لا يمكن استدعاء supabase.auth.admin.* من المتصفح، لأن ذلك يتطلب مفتاح
// service_role الذي يجب ألّا يُنشر أبداً. لذلك يعمل هذا الإجراء على الخادم
// ويتحقق من صلاحية المتصل قبل التنفيذ.
//
// البريد الإلكتروني للموظف لا يُرسل من المتصفح — يُبنى على الخادم من:
//     رقم_الهوية @ كود_المنظمة . ps      مثال: 402219876@pfbs.ps
// الكود يُقرأ من جدول المنظمات نفسه، فلا يمكن تزييفه من الطلب.
//
// النشر:  supabase functions deploy new-user
// ---------------------------------------------------------------------------

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// (026) super_admin هنا لمدير المنصة ينشئ مديرَي منصّة آخرين (بقرار من الواجهة:
// الخيار ظاهر لـ super_admin فقط، والخدمات لا تنطبق عليه)
const ALLOWED_ROLES = ["admin", "staff", "viewer", "super_admin"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMAIL_DOMAIN_SUFFIX = ".ps";

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function fail(message: string, status = 400, code?: string) {
  return reply({ error: message, code }, status);
}

/** يستخدم في التحقق من orgId قبل أي استعلام — لا استعلامات بقيم ملفوقة */
function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** رقم هوية الموظف: 5–15 رقماً (يتيح للهويات المحلية والأجنبية) */
// (022) اسم المستخدم: حروف إنجليزية صغيرة وأرقام (ونقطة/شرطة_) 3–20 —
// يقبل الأرقام القديمة (هوية 5–15 رقماً ضمن نفس النطاق) وحروف المستخدمين الجدد
function validateEmployeeId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const value = v.trim();
  return /^[a-z0-9._-]{3,20}$/.test(value) ? value : null;
}

/** بناء البريد من رقم الهوية وكود المنظمة */
function buildEmail(employeeId: string, orgCode: string): string {
  return `${employeeId}@${orgCode}${EMAIL_DOMAIN_SUFFIX}`.toLowerCase();
}

/** الخدمات المعروفة في النظام — يُقبل منها فقط */
const KNOWN_SERVICES = ["NICU", "Consultations", "SCBU", "B.F"];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return fail("Method not allowed", 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!url || !anonKey || !serviceKey) {
    return fail("إعدادات الخادم غير مكتملة", 500, "missing_env");
  }

  // ---- 1. authenticate the caller with the caller's own token ----
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return fail("يجب تسجيل الدخول", 401, "no_session");

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: callerData, error: callerErr } = await asCaller.auth.getUser();
  if (callerErr || !callerData?.user) {
    return fail("جلسة غير صالحة، أعد تسجيل الدخول", 401, "bad_session");
  }
  const callerId = callerData.user.id;

  // ---- 2. only admins may proceed (scoped to their org) ----
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("role, org_id")
    .eq("id", callerId)
    .maybeSingle();

  if (profileErr || !profile) {
    return fail("الملف الشخصي غير موجود", 403, "no_profile");
  }
  const callerIsSuper = profile.role === "super_admin";
  const callerIsAdmin = callerIsSuper || profile.role === "admin";
  if (!callerIsAdmin) return fail("هذه العملية للأداريين فقط", 403, "not_admin");

  // ---- 3. parse request ----
  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail("طلب غير صالح", 400, "bad_json");
  }
  const action = String(body?.action || "");
  const orgId =
    callerIsSuper && isUuid(String(body?.orgId || ""))
      ? String(body.orgId)
      : (profile.org_id ? String(profile.org_id) : "");
  if (!orgId) return fail("المنظمة غير معروفة", 400, "org_required");

  // ---- 4. dispatch ----
  if (action === "create") return doCreate(body, admin, orgId, callerIsSuper, callerId);
  if (action === "reset-password") return doResetPassword(body, admin, orgId, callerIsSuper);
  if (action === "sign-out") return doSignOut(body, admin, orgId, callerIsSuper, callerId);
  if (action === "sign-out-all") return doSignOutAll(body, admin, orgId, callerIsSuper, callerId);
  return fail("إجراء غير معروف", 400, "unknown_action");
});

/** تحقق من أن المستخدم الهدف ضمن منظمة المتصل (أو المتصل مدير المنصة) */
async function ensureSameOrg(admin: any, orgId: string, callerIsSuper: boolean, userId: string): Promise<string | null> {
  if (callerIsSuper) return null;
  const { data: target } = await admin
    .from("profiles")
    .select("org_id")
    .eq("id", userId)
    .maybeSingle();
  if (!target) return null;
  return target.org_id === orgId ? null : "لا يمكنك التصرف على مستخدم من منظمة أخرى";
}

async function doCreate(
  body: any,
  admin: any,
  orgId: string,
  callerIsSuper: boolean,
  callerId: string,
) {
  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  if (!fullName) return fail("الاسم الكامل مطلوب", 400, "missing_name");

  const employeeId = validateEmployeeId(body.employeeId);
  if (!employeeId) return fail("اسم المستخدم: 3–20 حرفاً إنجليزياً صغيراً أو رقماً (والنقطة أو الشرطة _ مسموحة)", 400, "bad_employee_id");

  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8) return fail("كلمة المرور يجب أن تكون 8 أحرف على الأقل", 400, "bad_password");

  const role = String(body.role || "");
  if (!ALLOWED_ROLES.includes(role)) return fail("دور غير صالح", 400, "bad_role");

  // orgId إلزامية لمدير المنصة، ومدير المنظمة يعمل على منظمته فقط (السطر أعلاه)
  if (callerIsSuper && !isUuid(String(body.orgId || ""))) {
    return fail("orgId مطلوب لمدير المنصة", 400, "org_required");
  }

  // الخدمات تُقبل فقط للموظف المحصور (staff) وتُنقّى من القائمة المعروفة
  let services: string[] = [];
  if (role === "staff" && Array.isArray(body.services)) {
    services = (body.services as unknown[])
      .filter((s: unknown) => typeof s === "string" && KNOWN_SERVICES.includes(s))
      .filter((s, i, a) => a.indexOf(s) === i);
  }

  // الكود يُقرأ من القاعدة — لا يُقبل من الطلب، فلا يمكن تزييف البريد
  const { data: org, error: orgErr } = await admin
    .from("orgs")
    .select("code")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr || !org?.code) {
    return fail("لا يمكن إنشاء البريد: كود المنظمة غير معروف", 400, "org_code_missing");
  }

  const email = buildEmail(employeeId, org.code);

  // فحص التكرار قبل الإنشاء — رسالة أوضح وأسرع
  const { data: dup } = await admin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (dup?.id) return fail("اسم المستخدم مستخدم مسبقاً لهذه المنظمة", 409, "email_taken");

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, employee_id: employeeId },
  });
  if (created.error) {
    if (/already been registered|already registered|duplicate/i.test(String(created.error.message))) {
      return fail("اسم المستخدم مستخدم مسبقاً لهذه المنظمة", 409, "email_taken");
    }
    return fail("تعذّر إنشاء الحساب: " + created.error.message, 500, "create_failed");
  }

  const userId = created.data.user.id;

  // صف البروفايل: upsert يتحمل وُجود مشغّل تلقائي أنشأ الصف قبل هذه النقطة
  const serviceAccess = role === "staff" ? (services.length ? "limited" : "all") : "all";
  const ups = await admin.from("profiles").upsert(
    {
      id: userId,
      email,
      full_name: fullName,
      org_id: orgId,
      role,
      service_access: serviceAccess,
      services: role === "staff" ? services : null,
    },
    { onConflict: "id" },
  );
  if (ups.error) return fail("تعذّر حفظ الملف: " + ups.error.message, 500, "profile_failed");

  return reply({ ok: true, id: userId, email });
}

async function doResetPassword(
  body: any,
  admin: any,
  orgId: string,
  callerIsSuper: boolean,
) {
  const userId = String(body?.userId || "");
  if (!isUuid(userId)) return fail("مُعرّف غير صالح", 400, "bad_user_id");

  const conflict = await ensureSameOrg(admin, orgId, callerIsSuper, userId);
  if (conflict) return fail(conflict, 403, "forbidden");

  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8) return fail("كلمة المرور يجب أن تكون 8 أحرف على الأقل", 400, "bad_password");

  const res = await admin.auth.admin.updateUserById(userId, { password });
  if (res.error) return fail(res.error.message, 500, "reset_failed");
  return reply({ ok: true });
}

async function doSignOut(
  body: any,
  admin: any,
  orgId: string,
  callerIsSuper: boolean,
  callerId: string,
) {
  const sessionId = String(body?.sessionId || "");
  if (!isUuid(sessionId)) return fail("جلسة غير صالحة", 400, "bad_session_id");

  const { data: s } = await admin
    .from("sessions")
    .select("id, user_id, org_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!s?.id) return reply({ ok: true, revoked: 0 }); // الجلسة غير موجودة — لا تُفشل

  if (!callerIsSuper && s.org_id !== orgId) {
    return fail("لا يمكنك إنهاء جلسة من منظمة أخرى", 403, "forbidden");
  }

  const rev = await admin.rpc("admin_revoke_session", { session_id: sessionId, actor: callerId });
  if (rev.error && !/function public\.admin_revoke_session/.test(String(rev.error.message))) {
    return fail(rev.error.message, 500, "revoke_failed");
  }
  if (s.user_id) {
    await admin.auth.admin.signOut(s.user_id).catch(() => {});
  }
  return reply({ ok: true, revoked: 1 });
}

async function doSignOutAll(
  body: any,
  admin: any,
  orgId: string,
  callerIsSuper: boolean,
  callerId: string,
) {
  const userId = String(body?.userId || "");
  if (!isUuid(userId)) return fail("مُعرّف غير صالح", 400, "bad_user_id");

  const conflict = await ensureSameOrg(admin, orgId, callerIsSuper, userId);
  if (conflict) return fail(conflict, 403, "forbidden");

  const rev = await admin.rpc("admin_revoke_user_sessions", { target_user: userId, actor: callerId });
  const count = rev.data && typeof rev.data === "number" ? rev.data : 0;
  if (rev.error && !/function public\.admin_revoke_user_sessions/.test(String(rev.error.message))) {
    return fail(rev.error.message, 500, "revoke_failed");
  }

  await admin.auth.admin.signOut(userId).catch(() => {});
  return reply({ ok: true, count });
}