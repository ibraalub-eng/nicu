/* =========================================================
   طبقة البيانات — واجهة موحدة (Facade) مستقلة عن المحرك
   =========================================================
   لا يعرف هذا الملف أي تفاصيل عن Supabase أو SQLite أو Firebase.
   يختار المحوّل من NICU_CONFIG.DB_ADAPTER (الافتراضي: supabase)،
   يتحقق من اكتمال العقد، ويعرض نفس الواجهة للتطبيق.

   لإضافة محرك جديد:
     1) أنشئ js/adapter-<name>.js يسجّل نفسه في DB_ADAPTERS.<name>
        محققاً نفس الدوال (العقد الكامل في DATA_LAYER.md).
     2) في js/config.js ضع: DB_ADAPTER: '<name>'
   لا يتغير شيء في app.js أو auth.js.
   ========================================================= */
(function (global) {
  'use strict';

  var cfg = global.NICU_CONFIG || {};
  var ADAPTER_NAME = String(cfg.DB_ADAPTER || 'supabase').toLowerCase();

  /* عقد المحول: كل مفتاح يجب أن يكون موجوداً بنوعه */
  var CONTRACT = {
    name:        'string',
    problem:     'object',     /* مصفوفة رسائل مشاكل الإقلاع (فارغة = سليم) */
    isFileProtocol: 'boolean',
    storageKind: 'string',     /* 'local' | 'memory' */
    COLUMNS:     'object',     /* مخطط الأعمدة من NICU.COLUMNS */
    FIELDS:      'object',
    isReady:     'function',
    auth:        'object',
    records:     'object',
    profiles:    'object',
    orgs:        'object',
    audit:       'object',
    sessions:    'object',
    revokeSession: 'function'
  };

  var SUB_CONTRACTS = {
    auth:     ['init', 'login', 'logout', 'onChange', 'updatePassword'],
    records:  ['page', 'all', 'findDuplicate', 'create', 'update', 'remove', 'restore', 'approve', 'unapprove', 'pendingCount', 'approveAll', 'subscribe'],
    profiles: ['me', 'list', 'create', 'setRole', 'updateName'],
    orgs:     ['list', 'create', 'saveBranding', 'saveRequiredFields', 'saveStaffEditAll', 'overview', 'resolveForUsername'],
    audit:    ['recent'],
    sessions: ['list', 'signOutUser', 'signOutUserAll']
  };

  function validateAdapter(adapter) {
    var problems = [];
    Object.keys(CONTRACT).forEach(function (key) {
      var expected = CONTRACT[key];
      var actual = typeof adapter[key];
      var ok = (expected === 'object') ? (actual === 'object' || actual === 'function')
                                       : actual === expected;
      if (!ok) problems.push('المحول "' + ADAPTER_NAME + '" ينقصه: ' + key + ' (' + expected + ')');
    });
    Object.keys(SUB_CONTRACTS).forEach(function (group) {
      (SUB_CONTRACTS[group] || []).forEach(function (fn) {
        if (typeof adapter[group][fn] !== 'function') {
          problems.push('المحول "' + ADAPTER_NAME + '": ' + group + '.' + fn + ' غير معرّفة');
        }
      });
    });
    return problems;
  }

  /* اختيار المحول */
  var factory = global.DB_ADAPTERS && global.DB_ADAPTERS[ADAPTER_NAME];
  var problems = [];

  if (!factory) {
    problems.push('محول قاعدة البيانات "' + ADAPTER_NAME + '" غير محمّل. ' +
                  'المتوفر: ' + Object.keys(global.DB_ADAPTERS || {}).join(', '));
    var nicu = global.NICU || {};
    var db = {
      name: ADAPTER_NAME,
      problems: problems,
      isReady: function () { return false; },
      isFileProtocol: false,
      storageKind: 'memory',
      COLUMNS: nicu.COLUMNS || [],
      FIELDS: nicu.FIELDS || [],
      auth: {}, records: {}, profiles: {}, orgs: {}, audit: {}, sessions: {},
      revokeSession: function () { return Promise.resolve(); }
    };
    global.db = db;
    return;
  }

  var adapter;
  try {
    adapter = factory();
  } catch (e) {
    problems.push('فشل تهيئة المحول "' + ADAPTER_NAME + '": ' + e.message);
    adapter = null;
  }

  if (adapter) {
    problems = problems.concat(validateAdapter(adapter));
  }

  var isBroken = problems.length > 0 || !adapter;

  /* الواجهة العامة للتطبيق — ثابتة مهما كان المحرك */
  global.db = {
    name: adapter ? adapter.name : ADAPTER_NAME,
    problems: isBroken ? problems : (adapter.problems || []),

    isReady: function () { return !isBroken && adapter.isReady(); },

    isFileProtocol: adapter ? adapter.isFileProtocol : false,
    storageKind: adapter ? adapter.storageKind : 'memory',
    sessionWillSurviveReload: adapter ? adapter.storageKind === 'local' : false,

    /* مخطط المجال — للتقارير والتصدير */
    COLUMNS: adapter ? adapter.COLUMNS : (global.NICU ? global.NICU.COLUMNS : []),
    FIELDS: adapter ? adapter.FIELDS : (global.NICU ? global.NICU.FIELDS : []),

    auth: adapter ? adapter.auth : {},
    records: adapter ? adapter.records : {},
    profiles: adapter ? adapter.profiles : {},
    orgs: adapter ? adapter.orgs : {},
    audit: adapter ? adapter.audit : {},
    sessions: adapter ? adapter.sessions : {},

    /* إبطال صف الجلسة عند الخروج — يفوّض للمحول */
    revokeSession: function (refreshToken) {
      if (!adapter) return Promise.resolve();
      return adapter.revokeSession(refreshToken);
    }
  };
})(window);
