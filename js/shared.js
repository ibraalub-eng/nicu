/* =========================================================
   أدوات مشتركة — NICU
   ثوابت ومساعدات تُستخدم في أكثر من مكان (app.js / التقرير).
   ملف مساعد بلا اعتماديات — يُحمَّل قبل app.js.
   ========================================================= */
(function (global) {
  'use strict';

  var NICU = {};

  /* الأشهر كما تُخزَّن في القاعدة (إنجليزية) + عربية للعرض */
  NICU.MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                 'July', 'August', 'September', 'October', 'November', 'December'];

  NICU.MONTHS_AR = {
    January: 'يناير', February: 'فبراير', March: 'مارس', April: 'أبريل',
    May: 'مايو', June: 'يونيو', July: 'يوليو', August: 'أغسطس',
    September: 'سبتمبر', October: 'أكتوبر', November: 'نوفمبر', December: 'ديسمبر'
  };

  NICU.SERVICES = ['NICU', 'Consultations', 'SCBU', 'B.F'];

  NICU.SERVICE_AR = {
    'NICU': 'العناية المركزة', 'Consultations': 'استشارات',
    'SCBU': 'وحدة رعاية حديثي الولادة', 'B.F': 'رعاية حديثي الولادة'
  };

  NICU.SERVICE_SHORT = { NICU: 'NICU', Consultations: 'استشارات', SCBU: 'SCBU', 'B.F': 'B.F' };

  /* yyyy-mm للشهر الحالي — يستخدم في "دخول هذا الشهر" */
  NICU.currentYM = function () {
    var now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  };

  /* تجميع إحصاءات KPI من صفوف السجلات — كانت مكررة في 3 مواضع (renderStats/
     compareKpis/report summary) وأُحالت إلى هنا */
  NICU.computeKpis = function (rows) {
    var ym = NICU.currentYM();
    var k = { total: rows.length, month: 0, active: 0, daysSum: 0, daysN: 0 };
    rows.forEach(function (r) {
      if (r.admitDate && String(r.admitDate).indexOf(ym) === 0) k.month++;
      if (!r.dischargeDate) k.active++;
      if (r.treatmentDays !== '' && r.treatmentDays !== null) {
        k.daysSum += Number(r.treatmentDays) || 0;
        k.daysN++;
      }
    });
    k.avgDays = k.daysN ? Math.round(k.daysSum / k.daysN * 10) / 10 : 0;
    return k;
  };

  /* تجميع حسب عمود — يعيد مصفوفة [label, count] مرتبة تنازلياً */
  NICU.groupCount = function (rows, keyFn) {
    var by = {};
    rows.forEach(function (r) {
      var v = keyFn(r);
      if (v) by[v] = (by[v] || 0) + 1;
    });
    return Object.keys(by)
      .sort(function (a, b) { return by[b] - by[a]; })
      .map(function (k) { return [k, by[k]]; });
  };

  /* ---------- مخطط البيانات المشترك (domain schema) ----------
     تعريف أعمدة السجل مستقل عن محرك التخزين — كل محول (supabase/sqlite/
     firebase) يترجم هذا التعريف إلى صيغته. field = اسم حقل النموذج،
     db = اسم العمود في المحرك الحالي. */
  NICU.COLUMNS = [
    { label: '#',                      field: 'seqNo',         db: 'seq_no' },
    { label: "Child's Name",           field: 'childName',     db: 'child_name' },
    { label: "Child's ID",             field: 'childId',       db: 'child_id' },
    { label: "Mother's Full Name",     field: 'motherName',    db: 'mother_name' },
    { label: "Mother's ID",            field: 'motherId',      db: 'mother_id' },
    { label: "Father's Full Name",     field: 'fatherName',    db: 'father_name' },
    { label: "Father's ID",            field: 'fatherId',      db: 'father_id' },
    { label: 'Gender',                 field: 'gender',        db: 'gender' },
    { label: 'DOB',                    field: 'dob',           db: 'dob' },
    { label: 'Visit/Admission date',   field: 'admitDate',     db: 'admit_date' },
    { label: 'Discharge date',         field: 'dischargeDate', db: 'discharge_date' },
    { label: 'Month',                  field: 'month',         db: 'month' },
    { label: 'Received Service',       field: 'service',       db: 'service' },
    { label: 'Neonate/Pedeatric',      field: 'category',      db: 'category' },
    { label: 'Weight',                 field: 'weight',        db: 'weight' },
    { label: 'Gestational Age',        field: 'gestAge',       db: 'gest_age' },
    { label: 'Twin?',                  field: 'twin',          db: 'twin' },
    { label: 'Cause of Admission & Status', field: 'cause',     db: 'cause' },
    { label: 'Referring entity',       field: 'referrer',      db: 'referrer' },
    { label: 'Disability',             field: 'disability',    db: 'disability' },
    { label: 'Location',               field: 'location',      db: 'location' },
    { label: 'Phone Number',           field: 'phone',         db: 'phone' },
    { label: 'Treatment Days',         field: 'treatmentDays', db: 'treatment_days' }
  ];

  NICU.FIELDS = NICU.COLUMNS.filter(function (c) { return c.field !== 'seqNo'; })
                            .map(function (c) { return c.field; });

  global.NICU = NICU;

  /* ---------- الوضع الليلي/النهاري (فاتح/داكن/تلقائي) ----------
     يُحلّ دائماً إلى سمة صريحة data-theme على <html> حتى تعمل
     قواعد CSS المبنية على السمة (والتلقائي يتبع نظام الجهاز) */
  var THEME_KEY = 'nicuTheme';

  /* (019b) انتقال ناعم للألوان عند التبديل فقط — لا عند الإقلاع،
     ويُعطَّل كلياً لمن يفضّل تقليل الحركة على جهازه */
  var FADE_CLASS = 'theme-fade';
  var FADE_MS = 280;
  var fadeTimer = null;

  function reducedMotion() {
    return !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function systemDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme(opts) {
    var o = opts || {};
    var pref = 'auto';
    try { pref = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) {}
    var eff = (pref === 'auto') ? (systemDark() ? 'dark' : 'light') : pref;
    var html = document.documentElement;
    var changed = html.getAttribute('data-theme') !== eff;
    html.setAttribute('data-theme', eff);
    /* انتقال لوني قصير فقط عند تغيّر فعلي، بتفعيل المستخدم، وبلا reduced-motion */
    if (changed && o.animate && !reducedMotion()) {
      html.classList.add(FADE_CLASS);
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(function () {
        html.classList.remove(FADE_CLASS);
      }, FADE_MS);
    }
  }

  /* تُستدعى من أزرار التبديل في app.js — تبديل صريح = مع انتقال */
  NICU.setThemePrefAnimated = function (pref) {
    try { localStorage.setItem(THEME_KEY, pref); } catch (e) {}
    applyTheme({ animate: true });
  };

  NICU.themePref = function () {
    try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; }
  };

  /* تفضيل التالي في الدوران: تلقائي ← فاتح ← داكن ← تلقائي … */
  NICU.themeNext = ['auto', 'light', 'dark', 'auto'];

  NICU.setThemePref = function (pref) {
    try { localStorage.setItem(THEME_KEY, pref); } catch (e) {}
    applyTheme();   /* بلا انتقال: للاستدعاءات البرمجية والإقلاع */
  };

  if (window.matchMedia && window.matchMedia.addEventListener) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  }

  applyTheme();
})(window);
