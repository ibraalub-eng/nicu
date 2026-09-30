/* =========================================================
   المصادقة — تسجيل الدخول والجلسة
   يعمل فوق واجهة db.auth الموحدة — لا يعرف المحرك المستخدم
   (Supabase / SQLite / Firebase) ولا يستدعيه مباشرة.
   ========================================================= */
(function (global) {
  'use strict';

  var ready = !!(global.db && global.db.isReady && global.db.isReady());
  var auth = {
    online: ready,
    session: null,
    profile: null,

    init: function () {
      if (!ready) return Promise.reject(new Error(setupError()));
      return global.db.auth.init().then(function (res) {
        auth.session = res.session;
        return auth.loadProfile();
      });
    },

    loadProfile: function () {
      if (!auth.session) { auth.profile = null; return Promise.resolve(null); }
      var uid = auth.session.user.id;
      return global.db.profiles.me(uid).then(function (p) {
        auth.profile = p;
        return p;
      });
    },

    login: function (email, password) {
      if (!ready) return Promise.reject(new Error(setupError()));
      return global.db.auth.login(email, password).then(function (res) {
        auth.session = res.session;
        return auth.loadProfile();
      }).catch(function (err) {
        throw new Error(arabicAuthError(err.message));
      });
    },

    logout: function () {
      if (!ready) return Promise.resolve();
      /* المحول يعيد { refreshToken, sessionId } ليُستخدم في إبطال صف الجلسة
         (sessions_revoke) — يُمرَّر كما هو إلى db.revokeSession وليس من هنا */
      return global.db.auth.logout().then(function (res) {
        auth.session = null;
        auth.profile = null;
        return res && (res.refreshToken || res.accessToken || res.sessionId) ? res : null;
      });
    },

    onChange: function (handler) {
      if (!ready) return;
      global.db.auth.onChange(function (session) {
        auth.session = session;
        if (session) {
          auth.loadProfile().then(function () { handler(session); });
        } else {
          auth.profile = null;
          handler(null);
        }
      });
    },

    isAdmin: function () {
      return !!auth.profile &&
        (auth.profile.role === 'admin' || auth.profile.role === 'super_admin');
    },

    /* مدير المنصة: يدير المنظمات نفسها ويُنشئ مديريها */
    isSuperAdmin: function () {
      return !!auth.profile && auth.profile.role === 'super_admin';
    },

    /* مراقب: اطلاع على كل الخدمات + الإحصاءات، بلا كتابة */
    isViewer: function () {
      return !!auth.profile && auth.profile.role === 'viewer';
    },

    /* صلاحيات الخدمات:
       servicesAllowed() تعيد null = كل الخدمات، أو مصفوفة الخدمات المسموحة */
    servicesAllowed: function () {
      if (!auth.profile) return null;
      if (auth.profile.role === 'staff' && auth.profile.service_access === 'limited') {
        return auth.profile.services || [];
      }
      return null;   // المديرون والمراقب: كل الخدمات
    },

    /* هل لي الاطلاع على هذه الخدمة؟ */
    canViewService: function (svc) {
      var allowed = auth.servicesAllowed();
      return allowed === null || allowed.indexOf(svc) !== -1;
    },

    /* هل لي الكتابة في هذه الخدمة؟ (المراقب لا، والمحصور ضمن خدماته)
       (013) إعداد «التعديل متاح لكل الموظفين» المفعّل من إدارة المنظمة
       يفتح الكتابة في كل الخدمات — مطابق لcan_write_service في RLS */
    canWriteService: function (svc) {
      if (!auth.profile) return false;
      if (auth.profile.role === 'viewer') return false;
      if (auth.isAdmin()) return true;
      if (auth.canEditRecords()) return true;
      return auth.canViewService(svc);
    },

    /* هل لي تعديل سجلات المنظمة كافّة في كل الخدمات؟
       (013) — إعداد على مستوى المنظمة يفعّله مديرها: كل موظفي المنظمة
       يعدّلون كل السجلات بلا حصر خدمة. المراقب مستثنى دائماً.
       يملؤها app.js عند تحميل إعدادات المنظمة (auth.staffEditAll). */
    staffEditAll: false,
    canEditRecords: function () {
      return !!auth.profile && auth.profile.role === 'staff' && auth.staffEditAll;
    },

    /* اسم منظمة المستخدم الحالية (من العلاقة orgs) */
    orgName: function () {
      if (!auth.profile || !auth.profile.orgs) return '';
      return auth.profile.orgs.name || '';
    },

    orgId: function () {
      return auth.profile ? auth.profile.org_id : null;
    },

    /* كود منظمة المستخدم (يُستخدم في بناء بريد موظفيها: الرقم@الكود.ps) */
    orgCode: function () {
      if (!auth.profile || !auth.profile.orgs) return '';
      return auth.profile.orgs.code || '';
    },

    displayName: function () {
      if (!auth.session) return '';
      if (auth.profile && auth.profile.full_name) return auth.profile.full_name;
      return auth.session.user.email || '';
    }
  };

  function setupError() {
    return global.db.problems.length
      ? global.db.problems[0]
      : 'تعذّر الاتصال بالخادم.';
  }

  function arabicAuthError(msg) {
    var m = String(msg);
    if (/Invalid login credentials/i.test(m)) return 'بيانات الدخول غير صحيحة: اسم المستخدم/البريد أو كلمة المرور أو اختيار المنظمة — تحقق منها وأعد المحاولة.';
    if (/Only an anonymous user can be re-assigned/i.test(m)) return 'مفتاح anon في js/config.js لا يطابق مفتاح المشروع — انسخه من: لوحة Supabase ← Project Settings ← API.';
    if (/Email not confirmed/i.test(m))        return 'لم يتم تفعيل البريد بعد. تواصل مع مدير النظام.';
    if (/Signups not allowed|not allowed/i.test(m)) return 'التسجيل الذاتي مغلق. الحسابات يُنشئها مدير النظام فقط.';
    if (/User already registered/i.test(m))    return 'هذا البريد مسجّل مسبقاً.';
    if (/Password should be/i.test(m))         return 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.';
    if (/Email address .* invalid/i.test(m))   return 'صيغة البريد الإلكتروني غير صحيحة.';
    if (/rate limit|too many/i.test(m))        return 'محاولات كثيرة جداً. انتظر قليلاً ثم أعد المحاولة.';

    /* أخطاء الشبكة/المصادقة: نُبقي السبب الأصلي صريحاً بدل رسالة عامة مضلّلة */
    if (/fetch|network|Failed to fetch|Load failed/i.test(m)) {
      return 'تعذّر الاتصال بخادم قاعدة البيانات. تحقق من الإنترنت ومن إعدادات js/config.js.';
    }
    return m;
  }

  global.auth = auth;
})(window);
