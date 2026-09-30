/* =========================================================
   NICU Beneficiaries — واجهة التطبيق
   يعتمد على: window.auth (المصادقة) و window.db (Supabase)
   ========================================================= */
(function (global) {
  'use strict';

  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var FIELDS = global.db.FIELDS;
  var COLUMNS = global.db.COLUMNS;

  var form        = $('#beneficiaryForm');
  var recordsBody = $('#recordsBody');
  var authScreen  = $('#authScreen');
  var app         = $('#app');
  var netAlert    = $('#netAlert');

  /* صفحة السجلات الحالية: يجلب عرض الجدول صفحة من الخادم فقط
     (default 25) بدل تحميل كل السجلات دفعة واحدة. cache يمسك
     صفحة العرض الحالية، وtotalCount يأتي من count الخادم. */
  var cache = [];
  var totalCount = 0;
  var pageNo = 0;
  var pageSize = 25;
  var pageTimer = null;      // تأخير جلب الصفحة (كتابة البحث)
  var refreshTimer = null;   // مهجور بعد الترقيم — أُبقي الاسم للتوافق
  var editingId = null;
  var editingUpdatedAt = null;   /* (015-OL) ختم updated_at عند بدء التعديل — للقفل التفاؤلي */

  /* منظمة العرض الحالية لمدير المنصة:
     null = منظمتُه (وضع كامل الصلاحيات)، uuid = يطّلع على منظمة أخرى (قراءة فقط). */
  var activeOrgId = null;
  var activeOrgName = '';

  /* ---------- التبويبات ---------- */
  var TABS = [
    /* (024) عاد «بيانات المستفيد» أول التابات (الترتيب الأصلي)، ثم السجلات
       فالإحصاءات فالإدارة — مطابق لترتيب DOM في شريط التابات */
    { tab: '#tabForm',    pane: '#paneForm' },
    { tab: '#tabRecords', pane: '#paneRecords' },
    { tab: '#tabStats',   pane: '#paneStats' },
    { tab: '#tabAdmin',   pane: '#paneAdmin' }
  ];
  var activeTab = 'paneForm';

  function visibleTabs() {
    return TABS.filter(function (t) { return !$(t.tab).hidden; });
  }

  function selectTab(paneId, focus) {
    var target = null;
    TABS.forEach(function (t) {
      var isOn = t.pane === paneId;
      var tabEl = $(t.tab), paneEl = $(t.pane);
      if (isOn) target = tabEl;
      tabEl.classList.toggle('is-active', isOn);
      tabEl.setAttribute('aria-selected', isOn ? 'true' : 'false');
      tabEl.tabIndex = isOn ? 0 : -1;
      paneEl.hidden = !isOn;
      paneEl.classList.toggle('is-active', isOn);
    });
    if (!target) return;           // القسم المطلوب غير متاح (مثل الإدارة لمُدخّل بيانات)
    activeTab = paneId;
    if (focus) target.focus();
    // إعادة ضبط تمرير القسم حتى لا يبدأ من منتصفه
    var pane = $(target.getAttribute('aria-controls'));
    if (pane) pane.scrollTop = 0;
    try { global.sessionStorage.setItem('nicuTab', paneId); } catch (e) {}
  }

  function setAdminTabVisible(on) {
    $('#tabAdmin').hidden = !on;
    $('#paneAdmin').hidden = !on || (activeTab !== 'paneAdmin');
    if (!on && activeTab === 'paneAdmin') selectTab('paneForm');
  }

  function setStatsTabVisible(on) {
    $('#tabStats').hidden = !on;
    $('#paneStats').hidden = !on || (activeTab !== 'paneStats');
    if (!on && activeTab === 'paneStats') selectTab('paneForm');
  }

  TABS.forEach(function (t) {
    $(t.tab).addEventListener('click', function () { selectTab(t.pane); });
  });

  /* تنقّل بلوحة المفاتيح بين التبويبات (WAI-ARIA) */
  $('.tabbar').addEventListener('keydown', function (e) {
    var keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (keys.indexOf(e.key) === -1) return;
    var list = visibleTabs();
    if (!list.length) return;
    var i = list.findIndex(function (t) { return t.pane === activeTab; });
    e.preventDefault();
    if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = list.length - 1;
    else i = (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    selectTab(list[i].pane, true);
  });

  /* ==================== أدوات مساعدة ==================== */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== null) n.textContent = text;
    return n;
  }

  function ar(str) {
    return String(str)
      .replace(/\d/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'[d]; })
      .replace(/\./g, '٫');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var p = String(iso).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso;
  }

  function fmtStamp(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function diffDays(a, b) {
    return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
  }

  /* تطبيع النص العربي للبحث: توحيد الهمزات/الألف/الياء/التاء المربوطة
     وإزالة التشكيل والأرقام العربية تبدّل إلى لاتينية، حتى يجد البحث
     «احمد» و«أحمد» و«إحمد» معاً. */
  function normAr(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\u064B-\u0652\u0640]/g, '')      // التشكيل والتطويل
      .replace(/[\u0622\u0623\u0625\u0627]/g, '\u0627') // آأإا -> ا
      .replace(/\u0649/g, '\u064A')                // ى -> ي
      .replace(/\u0629/g, '\u0647')                // ة -> ه
      .replace(/[\u0624]/g, '\u0648')              // ؤ -> و
      .replace(/[\u0626]/g, '\u064A')              // ئ -> ي
      .replace(/[٠-٩]/g, function (d) {
        return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d));
      })
      .replace(/\s+/g, ' ');
  }

  var toastTimer;
  function toast(msg, kind) {
    var box = $('#toast');
    box.textContent = msg;
    box.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.className = 'toast'; }, 3200);
  }

  function showNetError(msg) {
    netAlert.textContent = msg;
    netAlert.hidden = !msg;
  }

  function busy(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    btn.style.opacity = on ? '.6' : '';
  }

  /* ==================== أدوات التقارير (دخول/خروج) ====================
     تغيير نطاق التقرير يعيد جلب القائمة كاملة من الخادم */
  ['#reportDateField', '#reportFrom', '#reportTo'].forEach(function (sel) {
    $(sel).addEventListener('change', function () { fetchPage(true); });
  });
  $('#btnReportClear').addEventListener('click', function () {
    $('#reportFrom').value = '';
    $('#reportTo').value = '';
    fetchPage(true);
  });

  /* ==================== تكييف الواجهة مع صلاحيات الخدمات ==================== */
  /* فلتر الخدمة: للموظف المحصور تُعرض خدماته فقط، والنموذج يُحصر بها.
     موظف خدمة واحدة: الخدمة تُحدَّد تلقائياً ويُقفل الحقل — لا اختيار يدوي. */
  function applyServicePermissions() {
    var allowed = global.auth.servicesAllowed();
    var filterSvc = $('#filterService');
    var formSvc = form ? form.elements['service'] : null;

    if (allowed !== null) {
      /* إظهار خدمات الموظف فقط في الفلتر */
      Array.prototype.forEach.call(filterSvc.options, function (opt) {
        if (opt.value !== '') opt.hidden = allowed.indexOf(opt.value) === -1;
      });
      if (allowed.length && allowed.indexOf(filterSvc.value) === -1) filterSvc.value = '';

      /* النموذج: خيارات غير مصرّحة معطّلة */
      if (formSvc) {
        Array.prototype.forEach.call(formSvc.options, function (opt) {
          if (opt.value !== '') opt.disabled = allowed.indexOf(opt.value) === -1;
        });

        /* خدمة واحدة فقط: تُحدَّد تلقائياً ويُقفل الحقل — العنوان يوضح السبب */
        if (allowed.length === 1) {
          formSvc.value = allowed[0];
          formSvc.disabled = true;
          formSvc.title = 'تعمل على خدمة واحدة محددة من إدارة المنظمة — تُحدَّد تلقائياً';
        }
      }
    } else {
      Array.prototype.forEach.call(filterSvc.options, function (opt) { opt.hidden = false; });
      if (formSvc) {
        Array.prototype.forEach.call(formSvc.options, function (opt) { opt.disabled = false; });
        formSvc.disabled = false;
        formSvc.title = '';
      }
    }
  }

  /* ==================== الصلاحيات ==================== */
  var SERVICE_LABELS = global.NICU.SERVICE_SHORT;

  function canEdit(rec) {
    /* مدير المنصة أثناء مطالعة منظمة أخرى: قراءة فقط — RLS يرفض الكتابة أيضاً */
    if (viewingOtherOrg()) return false;
    if (global.auth.isViewer()) return false;   // المراقب: اطلاع فقط
    /* (016) السجل المحذوف لا يعدّله أحد حتى يُستعاد */
    if (rec && rec.deletedAt) return false;
    if (global.auth.isAdmin()) return true;
    /* (013) إعداد «التعديل متاح لكل الموظفين» المفعّل من مدير المنظمة:
       كل موظفي المنظمة يعدّلون سجلاتها كلها في كل الخدمات
       (والقراءة موسّعة في RLS أيضاً — وإلا لم يروا ما لا يعدّلونه). */
    if (global.auth.canEditRecords()) return true;
    /* الموظف (بعد 012 + 015): يعدّل أي سجل ضمن خدماته المسموحة،
       بشرط: غير معتمد + خلال نافذة 72 ساعة من آخر تحديث.
       RLS (015) يفرض الشيء نفسه إن حاول تجاوز الواجهة. */
    return rec && global.auth.canWriteService(rec.service) && editWindowOpen(rec);
  }

  /* الحذف أضيق من التعديل: للمالك أو المدير فقط — حماية البيانات */
  function canDelete(rec) {
    if (viewingOtherOrg()) return false;
    if (global.auth.isViewer()) return false;
    if (global.auth.isAdmin()) return true;
    /* (015) الموظف يحذف سجله خلال نافذة 72 ساعة قبل الاعتماد فقط
       (RLS يفرض الشيء نفسه) */
    return rec
      && rec.createdBy === global.auth.session.user.id
      && editWindowOpen(rec);
  }

  /* ==================== (015) نافذة التعديل 72 ساعة + الاعتماد ====================
     الموظف يعدّل السجل فقط إذا: غير معتمد + خلال 72 ساعة من آخر تحديث.
     الاعتماد (من المدير) يغلق التعديل نهائياً حتى إلغاء الاعتماد.
     المدير يتجاوز القيدين دائماً. القاعدة (015) تفرض الشيء نفسه. */
  var EDIT_WINDOW_HOURS = 72;

  function editWindowOpen(rec) {
    if (!rec) return false;
    if (rec.approvedAt) return false;   /* معتمد = مقفول للموظف */
    if (!rec.updatedAt) return true;
    var ageMs = Date.now() - new Date(rec.updatedAt).getTime();
    return ageMs < EDIT_WINDOW_HOURS * 3600 * 1000;
  }

  /* حالة السجل للعرض في الجدول */
  function approvalTag(rec) {
    if (rec.approvedAt) return { text: 'معتمد', cls: 'tag-ok' };
    if (!editWindowOpen(rec)) return { text: 'انتهت المدة', cls: 'tag-expired' };
    return null;
  }

  function approveRecord(id, on) {
    var op = on ? global.db.records.approve(id) : global.db.records.unapprove(id);
    return op.then(function () {
      toast(on ? 'تم اعتماد السجل — لن يقبل التعديل من الموظفين.'
               : 'أُلغي الاعتماد — السجل قابل للتعديل مجدداً.', 'ok');
      return refresh();
    }).catch(function (err) {
      toast('تعذّر تنفيذ الاعتماد: ' + err.message, 'err');
    });
  }

  /* (016c) «اعتماد الكل»: للمدير في فلتر بانتظار الاعتماد فقط —
     RPC واحد يعتمد كل معلّق المنظمة ويعيد العدد؛ ثم refresh يجدد
     الجدول والشارة معاً */
  function approveAllPending() {
    return global.db.records.approveAll().then(function (n) {
      n = Number(n) || 0;
      toast(n > 0 ? 'تم اعتماد ' + ar(n) + ' سجل — لن تقبل بالتعديل من الموظفين.'
                  : 'لا توجد سجلات بانتظار الاعتماد.', 'ok');
      return refresh();
    }).catch(function (err) {
      toast('تعذّر اعتماد الكل: ' + err.message, 'err');
    });
  }

  /* ==================== قراءة/كتابة النموذج ==================== */
  function readForm() {
    var out = {};
    FIELDS.forEach(function (f) {
      var node = form.elements[f];
      out[f] = node ? node.value.trim() : '';
    });
    return out;
  }

  function fillForm(data) {
    FIELDS.forEach(function (f) {
      if (form.elements[f]) form.elements[f].value = data[f] !== null ? data[f] : '';
    });
    syncAuto();
  }

  function setError(name, msg) {
    var slot = $('.err[data-for="' + name + '"]');
    var input = form.elements[name];
    if (slot) slot.textContent = msg || '';
    if (input && input.closest('.field')) {
      input.closest('.field').classList.toggle('invalid', !!msg);
    }
    /* إتاحة الخطأ لقارئات الشاشة (A11y) */
    if (input) {
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  function clearErrors() {
    $$('.err', form).forEach(function (s) { s.textContent = ''; });
    $$('.field.invalid', form).forEach(function (f) { f.classList.remove('invalid'); });
    $$('[aria-invalid]', form).forEach(function (i) { i.removeAttribute('aria-invalid'); });
  }

  function validate(d) {
    clearErrors();
    var first = null;
    function bad(n, m) { setError(n, m); if (!first) first = n; }

    /* الإلزامية ديناميكية حسب إعدادات المنظمة — المخفي يُتجاهل تماماً */
    FIELDS.forEach(function (f) {
      var st = fieldState(f);
      if (st === 'hidden') { d[f] = ''; return; }
      if (st === 'required' && !d[f]) bad(f, 'هذا الحقل إلزامي (إعدادات المنظمة).');
    });
    d.month = monthOf(d.admitDate);   // الشهر مشتق دائماً من تاريخ الدخول

    if (d.admitDate && d.dischargeDate) {
      if (d.dischargeDate < d.admitDate) {
        bad('dischargeDate', 'تاريخ الخروج لا يمكن أن يسبق تاريخ الدخول.');
      } else if (diffDays(d.admitDate, d.dischargeDate) > 365) {
        bad('dischargeDate', 'المدة غير منطقية (أكثر من سنة).');
      }
    }

    if (d.dob && d.admitDate && d.dob > d.admitDate) {
      bad('dob', 'تاريخ الميلاد لا يمكن أن يكون بعد تاريخ الدخول.');
    }

    if (d.dob && d.admitDate && d.dob <= d.admitDate &&
        d.category !== 'N' && d.category !== 'P') {
      bad('category', 'التصنيف لم يُحسب — راجع تاريخ الميلاد وتاريخ الدخول.');
    }

    if (d.phone && !/^[0-9+\-\s()]{7,20}$/.test(d.phone)) {
      bad('phone', 'رقم الهاتف غير صالح.');
    }

    if (d.weight && (Number(d.weight) < 0.3 || Number(d.weight) > 20)) {
      bad('weight', 'الوزن يجب أن يكون بين 0.3 و 20 كجم.');
    }

    if (d.gestAge && (Number(d.gestAge) < 20 || Number(d.gestAge) > 45)) {
      bad('gestAge', 'العمر الحملي يجب أن يكون بين 20 و 45 أسبوعاً.');
    }

    if (d.treatmentDays && (Number(d.treatmentDays) < 0 || Number(d.treatmentDays) > 999)) {
      bad('treatmentDays', 'مدة العلاج المحسوبة غير منطقية — راجع تاريخي الدخول والخروج.');
    }

    if (first) {
      if (form.elements[first]) form.elements[first].focus();
      $('#formAlert').textContent = 'يرجى تصحيح الحقول المميزة بالأحمر.';
      $('#formAlert').hidden = false;
      return false;
    }

    $('#formAlert').hidden = true;
    return true;
  }

  /* تحذير التكرار: يُفحص على الخادم (نفس الطفل + الأم + تاريخ الدخول)
     لأن السجل المطابق قد يكون خارج الصفحة الحالية. */
  function isDuplicate(data) {
    return global.db.records.findDuplicate(data, editingId);
  }

  function defaultMonth() { /* مهجورة: الشهر يُحسب من تاريخ الدخول عند الحفظ */ }

  function today() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function syncDays() {
    var a = form.elements.admitDate.value;
    var d = form.elements.dischargeDate.value;
    var box = form.elements.treatmentDays;
    var hint = $('#treatmentDaysHint');

    function clear(msg) {
      box.value = '';
      hint.textContent = msg;
    }

    if (!a) return clear('يُملأ تلقائياً بعد إدخال تاريخ الدخول');

    if (d) {
      if (d < a) return clear('تاريخ الخروج قبل تاريخ الدخول — لا يمكن الحساب');
      var n = diffDays(a, d) + 1;
      box.value = n;
      hint.textContent = 'من ' + fmtDate(a) + ' إلى ' + fmtDate(d) + ' = ' + ar(n) + ' يوم';
      return;
    }

    var t = today();
    if (t < a) return clear('تاريخ الدخول في المستقبل — لا يمكن الحساب');

    var e = diffDays(a, t) + 1;
    box.value = e;
    hint.textContent = 'ما زال في العناية — من ' + fmtDate(a) + ' حتى اليوم = ' + ar(e) + ' يوم';
  }

  /* التصنيف محسوب تلقائياً — نفس منطق عمود Neonate/Pedeatric في Excel:
       =IF(OR(ISBLANK(J5),ISBLANK(I5)),"---",IF(J5-I5<=28,"N","P"))
     حيث I = تاريخ الميلاد (dob) و J = تاريخ الزيارة/الدخول (admitDate). */
  function syncCategory() {
    var dob = form.elements.dob.value;
    var adm = form.elements.admitDate.value;
    var box = form.elements.category;
    var hint = $('#categoryHint');

    if (!dob || !adm) {
      box.value = '';
      hint.textContent = dob
        ? 'يُملأ تلقائياً بعد إدخال تاريخ الدخول'
        : 'أدخل تاريخ الميلاد وتاريخ الدخول لحساب التصنيف';
      return;
    }
    if (dob > adm) {
      box.value = '';
      hint.textContent = 'تاريخ الميلاد بعد تاريخ الدخول — لا يمكن الحساب';
      return;
    }

    var days = diffDays(dob, adm);
    var n = days <= 28;
    box.value = n ? 'N' : 'P';
    hint.textContent = 'عمر الطفل عند الدخول = ' + ar(days) + ' يوم ← ' +
      (n ? 'N — خديج (Neonate)' : 'P — أطفال (Pedeatric)');
  }

  /* الشهر لم يعد حقلاً في النموذج — يُحسب تلقائياً من تاريخ الدخول
     عند الحفظ (كما كان منع الأخطاء: تاريخ مارس وشهر "January"). */
  function monthOf(admitDate) {
    if (!admitDate) return '';
    var d = new Date(admitDate + 'T00:00:00');
    return isNaN(d) ? '' : global.NICU.MONTHS[d.getMonth()];
  }

  function syncAuto() {
    syncDays();
    syncCategory();
  }

  var resetting = false;

  function clearFields() {
    FIELDS.forEach(function (f) {
      if (form.elements[f]) form.elements[f].value = '';
    });
  }

  function resetForm() {
    if (resetting) return;
    resetting = true;

    clearFields();
    clearErrors();
    $('#formAlert').hidden = true;
    editingId = null;
    editingUpdatedAt = null;
    $('#editingBadge').hidden = true;
    $('#ownerBadge').hidden = true;
    $('#btnSave').textContent = 'حفظ السجل';
    $('#btnCancelEdit').hidden = true;
    syncAuto();

    /* موظف خدمة واحدة: أعد تثبيت الخدمة التلقائية بعد التفريغ */
    var allowedSvcs = global.auth.servicesAllowed();
    if (allowedSvcs !== null && allowedSvcs.length === 1 && form.elements.service) {
      form.elements.service.value = allowedSvcs[0];
      form.elements.service.disabled = true;
    }

    resetting = false;
  }

  /* ==================== جلب وعرض السجلات ==================== */
  /* (016) وضع «عرض المحذوفات» — للمدير فقط */
  var showDeleted = false;

  function currentFilters() {
    return {
      q: normAr($('#searchBox').value.trim()),
      service: $('#filterService').value,
      mine: $('#filterMine').value === 'mine',
      /* (016b) «بانتظار الاعتماد» — للمدير فقط، ومعطّل داخل سلة المحذوفات */
      pending: !showDeleted && !!($('#filterPending') && $('#filterPending').value === 'pending'),
      userId: global.auth.session.user.id,
      deleted: (showDeleted && global.auth.isAdmin()) ? 'only' : 'active',
      /* نطاق التقارير: حسب تاريخ الدخول (افتراضي) أو تاريخ الخروج */
      dateFilter: {
        dateField: $('#reportDateField').value,
        from: $('#reportFrom').value || null,
        to: $('#reportTo').value || null
      },
      /* عند التبديل لمشاهدة منظمة أخرى: طلب سجلاتها تحديداً.
         "mine" بلا معنى هناك — نلغيه كي لا يُفرّغ الجدول. */
      orgId: activeOrgId || undefined
    };
  }

  /* هل يعرض المستخدم الآن بيانات منظمة غير منظته؟ */
  function viewingOtherOrg() {
    return !!activeOrgId;
  }

  /* (016b) شارة «بانتظار الاعتماد» في بطاقة السجلات — لمدير المنظمة فقط.
     RPC واحد يرجع العدد؛ تُستدعى عند الدخول/التحديث/تبديل المنظمة. */
  function loadPendingBadge() {
    var b = $('#pendingBadge');
    if (!b) return;
    if (!global.auth.isAdmin() || viewingOtherOrg() || showDeleted) { b.hidden = true; return; }
    global.db.records.pendingCount().then(function (n) {
      n = Number(n) || 0;
      b.textContent = 'بانتظار الاعتماد: ' + ar(n);
      b.hidden = n <= 0;
    }).catch(function () { /* شارة ثانوية — فشلها لا يعطّل التطبيق */ });
  }

  /* صفوف هيكلية أثناء تحميل السجلات — بدل الجدول الفارغ/المتأخر */
  function skeletonRows(n) {
    recordsBody.textContent = '';
    for (var i = 0; i < n; i++) {
      var tr = el('tr');
      for (var c = 0; c < 8; c++) {
        var td = el('td');
        var bar = document.createElement('span');
        bar.className = 'skel';
        td.appendChild(bar);
        tr.appendChild(td);
      }
      recordsBody.appendChild(tr);
    }
    var es = $('#emptyState');
    if (es) es.hidden = true;
  }

  function fetchPage(resetPage) {
    if (resetPage) pageNo = 0;
    var from = pageNo * pageSize;
    skeletonRows(8);

    return global.db.records.page(currentFilters(), from, pageSize)
      .then(function (res) {
        cache = res.rows;
        totalCount = res.total;
        render();
        showNetError('');
      })
      .catch(function (err) {
        showNetError('تعذّر تحميل السجلات: ' + err.message);
      });
  }

  /* refresh: إعادة جلب الصفحة الحالية (حفظ/حذف/Realtime).
     opts.resetPage: العودة للصفحة الأولى (بعد حفظ جديد مثلاً).
     الإحصاءات تُحدَّث فقط إن كان تبويبها مفتوحاً. */
  function refresh(opts) {
    var o = opts || {};
    return fetchPage(o.resetPage).then(function () {
      loadPendingBadge();   /* (016b) عدّاد بانتظار الاعتماد (يشمل approveRecord عبر refresh) */
      if ((global.auth.isAdmin() || global.auth.isViewer()) && !$('#tabStats').hidden) return loadStats();
    });
  }

  function debouncedRefresh() {
    /* بعد الترقيم: الأحداث المتكررة (Realtime) تعيد جلب الصفحة الحالية فقط */
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { fetchPage(false); }, 300);
  }

  function visible() {
    return cache;   // التصفية تتم في الخادم — الصفحة جاهزة للعرض
  }

  function nameOf(userId) {
    if (userId === global.auth.session.user.id) return 'أنا';
    return creatorNames[userId] || 'مستخدم آخر';
  }

  /* أسماء المنشئين تُحمَّل مرة واحدة لكل جلسة بدل كل رسم للجدول.
     أداء: كانت profiles.list تُستدعى عند كل تحديث للسجلات للمديرين. */
  var creatorNames = {};
  var creatorNamesLoaded = false;

  function loadCreatorNames() {
    if (!global.auth.isAdmin() || creatorNamesLoaded) return Promise.resolve();
    return global.db.profiles.list().then(function (list) {
      var map = {};
      list.forEach(function (p) { map[p.id] = p.full_name || p.id.slice(0, 6); });
      creatorNames = map;
      creatorNamesLoaded = true;
      render();
    }).catch(function () {});
  }

  function totalPages() {
    return Math.max(1, Math.ceil(totalCount / pageSize));
  }

  function renderPager() {
    /* تحديث في المكان — #pageInfo/btnPrev/btnNext أبناء ثابتون في HTML:
       مسح #pager يمحوهم فيفشل الوصول إليهم بعدها (كان سبب قطع render) */
    var pages = totalPages();
    setText('pageInfo',
      'صفحة ' + ar(pageNo + 1) + ' من ' + ar(pages) +
      ' — ' + ar(totalCount) + ' سجل');

    var prev = $('#btnPrev'), next = $('#btnNext');
    if (prev) prev.disabled = pageNo <= 0;
    if (next) next.disabled = pageNo >= pages - 1;
    var box = $('#pager');
    if (box) box.hidden = totalCount === 0;
  }

  /* كتابة آمنة في عنصر بالمعرف — لا تُسقط render كله إن غاب العنصر */
  function setText(id, text) {
    var n = document.getElementById(id);
    if (n) n.textContent = text;
  }

  function render() {
    var list = visible();
    recordsBody.textContent = '';
    setText('recordCount', ar(totalCount));
    setText('tabCount', ar(totalCount));
    $('#emptyState').hidden = list.length > 0;
    renderPager();

    /* (016c) زر «اعتماد الكل» يظهر للمدير في فلتر بانتظار الاعتماد فقط */
    var approveAllBtn = $('#btnApproveAll');
    if (approveAllBtn) approveAllBtn.hidden =
      !(global.auth.isAdmin() && !viewingOtherOrg() && !showDeleted &&
        $('#filterPending') && $('#filterPending').value === 'pending');

    list.forEach(function (r) {
      var seq = r.seqNo || '—';
      var tr = el('tr');
      if (r.id) tr.dataset.id = r.id;

      tr.appendChild(el('td', null, ar(seq)));
      tr.appendChild(el('td', null, r.childName || '—'));
      tr.appendChild(el('td', null, r.motherName || '—'));

      var svc = el('td');
      svc.appendChild(el('span', 'tag', r.service || '—'));
      tr.appendChild(svc);

      tr.appendChild(el('td', null, fmtDate(r.admitDate)));

      var dur = el('td');
      if (r.treatmentDays !== '' && r.treatmentDays !== null) {
        dur.appendChild(document.createTextNode(ar(r.treatmentDays) + ' يوم'));
        if (!r.dischargeDate) {
          dur.appendChild(el('span', 'tag tag-cont', 'مستمر'));
        }
      } else {
        dur.textContent = '—';
      }
      tr.appendChild(dur);

      tr.appendChild(el('td', 'muted', nameOf(r.createdBy)));

      /* (015) شارة الحالة: معتمد / انتهت المدة */
      var st = approvalTag(r);
      if (st) tr.appendChild(el('td', null)).appendChild(el('span', 'tag ' + st.cls, st.text));
      else tr.appendChild(el('td', 'muted', '—'));

      var actions = el('td');

      /* (016) في وضع المحذوفات: الاستعادة بدل كل الأزرار — للمدير فقط */
      if (showDeleted && global.auth.isAdmin()) {
        var rst = el('button', 'icon-btn', 'استعادة');
        rst.type = 'button';
        rst.title = 'إعادة السجل إلى القائمة المعتادة';
        rst.addEventListener('click', function () { restoreRecord(r.id); });
        actions.appendChild(rst);
        tr.appendChild(actions);
        recordsBody.appendChild(tr);
        return;
      }

      if (canEdit(r)) {
        var edit = el('button', 'icon-btn', 'تعديل');
        edit.type = 'button';
        edit.addEventListener('click', function () { startEdit(r.id); });
        actions.appendChild(edit);

        /* الحذف أضيق من التعديل: للمالك أو المدير فقط (canDelete) */
        if (canDelete(r)) {
          var del = el('button', 'icon-btn danger', 'حذف');
          del.type = 'button';
          del.addEventListener('click', function () { remove(r.id); });
          actions.appendChild(del);
        }
      } else {
        actions.appendChild(el('span', 'muted', '—'));
      }

      /* (015) زرا الاعتماد/إلغاء الاعتماد — للمدير فقط (حتى أثناء عرض منظمة أخرى لا) */
      if (global.auth.isAdmin() && !viewingOtherOrg() && !(showDeleted && global.auth.isAdmin())) {
        var ap = el('button', 'icon-btn', r.approvedAt ? 'إلغاء الاعتماد' : 'اعتماد');
        ap.type = 'button';
        ap.title = r.approvedAt
          ? 'إلغاء الاعتماد يفتح السجل للتعديل من الموظفين مجدداً'
          : 'الاعتماد يمنع تعديل السجل من الموظفين نهائياً';
        ap.addEventListener('click', function () {
          if (r.approvedAt || global.confirm(
            'اعتماد السجل يمنع تعديله من الموظفين نهائياً (تصلح أن تعدّله أنت دائماً).\nهل تريد الاعتماد؟'
          )) approveRecord(r.id, !r.approvedAt);
        });
        actions.appendChild(ap);
      }

      tr.appendChild(actions);

      recordsBody.appendChild(tr);
    });
  }

  /* ==================== إضافة / تعديل / حذف ==================== */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (viewingOtherOrg()) {
      toast('أنت تطّلع على منظمة أخرى — الحفظ يعمل في منظمتك فقط. عد إلى "منظمتي".', 'err');
      return;
    }
    var data = readForm();
    if (!validate(data)) return;

    var btn = $('#btnSave');
    busy(btn, true);

    /* فحص التكرار على الخادم أولاً (استعلام خفيف) ثم الحفظ */
    isDuplicate(data)
      .then(function (dup) {
        if (dup && !global.confirm(
          'يوجد سجل بنفس اسم الطفل واسم الأم وتاريخ الدخول' +
          (dup.seq_no ? ' (رقم ' + ar(dup.seq_no) + ')' : '') + '.\n' +
          'هل تريد حفظه كسجل جديد على أي حال؟'
        )) return null;

        var me = global.auth.session.user.id;
        var op = editingId
          ? global.db.records.update(editingId, data, me, editingUpdatedAt)
          : global.db.records.create(data, me);
        /* (033) أخطاء شائعة برسائل عربية واضحة بدل العبء التقني */
        op = op.catch(function (err) {
          var m = String(err && err.message || '');
          if (/approved_at|deleted_at/i.test(m)) {
            throw new Error('مخطط قاعدة البيانات قديم — شغّل ترحيلات 015/016 (ALL_MIGRATIONS_IN_ORDER.sql) ثم أعد المحاولة.');
          }
          if (err && err.code === 'CONFLICT') throw err;   // برسالتها العربية الجاهزة
          throw err;
        });

        return op.then(function (newStamp) {
          /* (015-OL) نجاح التعديل: ختم جديد يستخدم في أي تعديل لاحق لنفس الجلسة */
          if (editingId && newStamp) editingUpdatedAt = newStamp;
          toast(editingId ? 'تم تحديث السجل.' : 'تم حفظ السجل بنجاح.', 'ok');
          resetForm();
          return refresh({ resetPage: !editingId });
        });
      })
      .catch(function (err) {
        if (err && err.code === 'CONFLICT') {
          /* (015-OL) تعارض أجهزة: حدّث القائمة والنموذج بالحالة الأخيرة، وأبقِ
             التعديل مفتوحاً فيمتنع المستخدم من الكتابة فوق زميله */
          editingUpdatedAt = null;
          toast('تعارض: سجل تغيّر أثناء عملك — تم جلب أحدث نسخة، راجعها وأعد الحفظ.', 'err');
          return refresh().then(function () {
            if (editingId) {
              var fresh = cache.filter(function (r) { return r.id === editingId; })[0];
              if (fresh) {
                fillForm(fresh);
                editingUpdatedAt = fresh.updatedAt || null;
              } else {
                resetForm();   /* حُذف السجل من زميله أثناء عملك */
              }
            }
          });
        }
        toast('فشل الحفظ: ' + err.message, 'err');
      })
      .then(function () {
        busy(btn, false);
      });
  });

  form.addEventListener('reset', function (e) {
    e.preventDefault();
    resetForm();
  });

  $('#btnReset').addEventListener('click', resetForm);
  $('#btnCancelEdit').addEventListener('click', resetForm);

  ['admitDate', 'dischargeDate'].forEach(function (id) {
    form.elements[id].addEventListener('change', syncAuto);
  });

  form.elements.dob.addEventListener('change', syncCategory);

  /* البحث والتصفية يذهبان إلى الخادم (debounce لكتابة البحث) */
  $('#searchBox').addEventListener('input', function () {
    clearTimeout(pageTimer);
    pageTimer = setTimeout(function () { fetchPage(true); }, 300);
  });

  ['filterService', 'filterMine', 'filterPending'].forEach(function (id) {
    $('#' + id).addEventListener('change', function () { fetchPage(true); });
  });

  $('#btnPrev').addEventListener('click', function () {
    if (pageNo > 0) { pageNo--; fetchPage(false); }
  });

  $('#btnNext').addEventListener('click', function () {
    if (pageNo < totalPages() - 1) { pageNo++; fetchPage(false); }
  });

  $('#pageSize').addEventListener('change', function () {
    pageSize = Number($('#pageSize').value) || 25;
    fetchPage(true);
  });

  function startEdit(id) {
    var rec = cache.filter(function (r) { return r.id === id; })[0];
    if (!rec || !canEdit(rec)) return;

    editingId = id;
    editingUpdatedAt = rec.updatedAt || null;   /* (015-OL) ختم الحفظ الذي رآه المستخدم */
    fillForm(rec);
    $('#editingBadge').hidden = false;
    $('#btnSave').textContent = 'تحديث السجل';
    $('#btnCancelEdit').hidden = false;
    $('#ownerBadge').textContent = 'سجل ' + (rec.seqNo || '—');
    $('#ownerBadge').hidden = false;

    // التعديل من جدول السجلات: انتقل إلى تبويب النموذج وإلا بدا الزر بلا أثر
    selectTab('paneForm');
    if (form.scrollIntoView) {
      try { form.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      catch (err) { form.scrollIntoView(); }
    }
    form.elements.childName.focus();
  }

  function remove(id) {
    var rec = cache.filter(function (r) { return r.id === id; })[0];
    if (!rec || !canDelete(rec)) return;
    if (!global.confirm('حذف سجل «' + (rec.childName || '') + '»؟\nيبقى في سلة المحذوفات قابلاً للاستعادة من المدير لمدة 30 يوماً.')) return;

    global.db.records.remove(id).then(function () {
      toast('تم نقل السجل إلى المحذوفات — يمكن للمدير استعادته خلال 30 يوماً.', 'ok');
      if (editingId === id) resetForm();
      statsLoaded = false;   // إجماليات الإحصاءات تغيّرت
      return refresh();
    }).catch(function (err) {
      toast('فشل الحذف: ' + err.message, 'err');
    });
  }

  /* (016) استعادة سجل من سلة المحذوفات — للمدير */
  function restoreRecord(id) {
    var rec = cache.filter(function (r) { return r.id === id; })[0];
    if (!rec || !global.auth.isAdmin()) return;
    global.db.records.restore(id).then(function () {
      toast('تمت استعادة السجل.', 'ok');
      statsLoaded = false;
      return refresh();
    }).catch(function (err) {
      toast('تعذّرت الاستعادة: ' + err.message, 'err');
    });
  }

  /* ==================== التصدير ==================== */
  function csvCell(v) {
    var s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function stamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* التصدير يجلب كل السجلات المطابقة للتصفية من الخادم —
     لا الصفحة الحالية فقط (تصدير 25 صفاً كان سيضلل المستخدم). */
  $('#btnExportCsv').addEventListener('click', function () {
    busy($('#btnExportCsv'), true);
    global.db.records.all(currentFilters()).then(function (list) {
      if (!list.length) { toast('لا توجد سجلات للتصدير.', 'err'); return; }

      var lines = [COLUMNS.map(function (c) { return csvCell(c.label); }).join(',')];
      list.forEach(function (r, i) {
        lines.push(COLUMNS.map(function (c) {
          var v = c.field === 'seqNo' ? (r.seqNo || i + 1) : r[c.field];
          // نطابق Excel: خانة فارغة في قاعدة البيانات تظهر "---" عند التصدير
          if (c.field === 'category' && (v === '' || v === null)) v = '---';
          return csvCell(v);
        }).join(','));
      });

      download(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }),
               'NICU-beneficiaries-' + stamp() + '.csv');

      var n = list.length, total = totalCount;
      $('#exportNote').textContent = n === total
        ? 'تم تصدير كل السجلات (' + ar(n) + ')'
        : 'تم تصدير ' + ar(n) + ' من ' + ar(total) + ' سجل (حسب التصفية)';
      toast('تم التصدير.', 'ok');
    }).catch(function (err) {
      toast('فشل التصدير: ' + err.message, 'err');
    }).then(function () {
      busy($('#btnExportCsv'), false);
    });
  });

  $('#btnExportJson').addEventListener('click', function () {
    busy($('#btnExportJson'), true);
    global.db.records.all(currentFilters()).then(function (list) {
      if (!list.length) { toast('لا توجد سجلات.', 'err'); return; }
      download(new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' }),
               'NICU-backup-' + stamp() + '.json');
      toast('تم إنشاء النسخة الاحتياطية (' + ar(list.length) + ' سجل).', 'ok');
    }).catch(function (err) {
      toast('فشل التصدير: ' + err.message, 'err');
    }).then(function () {
      busy($('#btnExportJson'), false);
    });
  });

  /* ==================== لوحة المدير ==================== */
  function adminAlert(msg) {
    var box = $('#adminAlert');
    box.textContent = msg || '';
    box.hidden = !msg;
  }

  function loadAdmin() {
    if (!global.auth.isAdmin()) return;
    var isSuper = global.auth.isSuperAdmin();

    /* مدير المنصة أثناء عرض منظمة أخرى: يرى كل شيء، وتُعطَّل نماذج الكتابة —
       الإنشاء والتعديل يعملان في منظمتك فقط (والـ RLS يرفض أي تجاوز) */
    var readOnly = viewingOtherOrg();
    ['#newUserForm', '#newOrgForm'].forEach(function (sel) {
      var f = $(sel);
      if (!f) return;
      $$('input, select, button[type="submit"]', f).forEach(function (el2) {
        el2.disabled = readOnly;
      });
    });
    $('#nuOrgField').hidden = !isSuper;
    var settingsBtn = $('#btnFieldsSettings');
    if (settingsBtn) settingsBtn.hidden = readOnly;
    /* (035) تخصيص الترويسة: متاح لمدير المنصة حتى أثناء عرض منظمة أخرى */
    var brandingBtn = $('#btnBrandingSettings');
    if (brandingBtn) brandingBtn.hidden = false;

    /* (013) مفتاح «التعديل متاح لكل الموظفين» — يُزامَن من دالة مشتركة
       لأن القيمة قد تصل من loadFieldSettings قبل أو بعد هذا السطر */
    syncStaffEditToggle();

    /* (016) مفتاح «عرض المحذوفات» — للمدير في منظته فقط */
    var delBox = $('#deletedToggleBox');
    var delChk = $('#chkDeleted');
    if (delBox && delChk) {
      delBox.hidden = readOnly;
      if (readOnly) {
        delChk.checked = false;
        showDeleted = false;
      }
    }

    /* (016b) فلتر وشارة «بانتظار الاعتماد» — مدير في منظته فقط */
    var pendSel = $('#filterPending');
    var pendBadge = $('#pendingBadge');
    if (pendSel) pendSel.hidden = readOnly || showDeleted;
    if (pendBadge) pendBadge.hidden = readOnly || showDeleted;

    /* عند التبديل: فريق المنظمة المختارة؛ وإلا فريق المنظمة */
    global.db.profiles.list(activeOrgId || undefined).then(function (list) {
      var meId = global.auth.session.user.id;
      var usersBody = $('#usersBody');
      usersBody.textContent = '';
      $('#usersEmpty').hidden = (list || []).length > 0;

      (list || []).forEach(function (p) {
        var tr = el('tr');
        var nameCell = el('td');
        nameCell.appendChild(document.createTextNode(p.full_name || '—'));
        if (isSuper && p.orgs && p.orgs.name) {
          nameCell.appendChild(el('span', 'org-tag', p.orgs.name));
        }
        tr.appendChild(nameCell);

        /* (021)(022) اسم المستخدم = الجزء قبل @ في بريد الدخول —
           البريد كاملاً كتلميح، و«—» لو غاب البريد (حسابات قديمة) */
        var idCell = el('td', 'muted id-num', '—');
        if (p.email && p.email.indexOf('@') > 0) {
          idCell.textContent = p.email.split('@')[0];
          idCell.dir = 'ltr';
          idCell.title = p.email;
        }
        tr.appendChild(idCell);
        if (p.email) tr.title = p.email;

        var td = el('td');
        var sel = document.createElement('select');
        sel.className = 'role-select';
        sel.setAttribute('aria-label', 'صلاحية ' + (p.full_name || ''));

        var roles = [['staff', 'مُدخِل بيانات'], ['admin', 'مدير']];
        roles.push(['viewer', 'مراقب']);
        if (isSuper) roles.push(['super_admin', 'مدير المنصة']);
        roles.forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o[0];
          opt.textContent = o[1];
          if (p.role === o[0]) opt.selected = true;
          sel.appendChild(opt);
        });

        if (p.id === meId) {
          sel.disabled = true;
          sel.title = 'لا يمكنك تغيير صلاحيتك بنفسك';
        } else {
          sel.addEventListener('change', function () {
            adminAlert('');
            /* عند إعادة تعيين موظف محصور: نمرر خدماته الحالية حفاظاً عليها */
            var keepServices = (p.role === 'staff' && p.service_access === 'limited') ? (p.services || []) : [];
            global.db.profiles.setRole(p.id, sel.value, keepServices)
              .then(function () {
                toast('تم تحديث الصلاحية.', 'ok');
                return loadAdmin();
              })
              .catch(function (err) {
                adminAlert('تعذّر تغيير الصلاحية: ' + err.message);
                sel.value = p.role;
              });
          });
        }

        td.appendChild(sel);
        tr.appendChild(td);

        /* عمود الخدمات المسموحة — للموظف المحصور نص + زر تعديل للمدير */
        var svcTd = el('td', 'muted', '—');
        if (p.role === 'staff' && p.service_access === 'limited' && p.services && p.services.length) {
          svcTd.textContent = '';
          svcTd.appendChild(document.createTextNode(
            p.services.map(function (s) { return SERVICE_LABELS[s] || s; }).join('، ')
          ));
        } else if (p.role !== 'staff') {
          svcTd.textContent = 'كل الخدمات';
        }
        /* زر تعديل خدمات الموظف القائم — للمدير ولا يعمل على نفسه */
        if (p.id !== meId && p.role === 'staff') {
          svcTd.appendChild(el('span', null, ' '));
          var editSvc = el('button', 'icon-btn', 'تعديل الخدمات');
          editSvc.type = 'button';
          editSvc.title = 'تعديل الخدمات المسموحة لهذا الموظف';
          editSvc.addEventListener('click', function () { askEditServices(p); });
          svcTd.appendChild(editSvc);
        }
        tr.appendChild(svcTd);

        var act = el('td');
        if (p.id === meId) {
          act.appendChild(el('span', 'muted', '—'));
        } else {
          var rp = el('button', 'icon-btn', 'كلمة مرور جديدة');
          rp.type = 'button';
          rp.addEventListener('click', function () { askResetPassword(p); });
          act.appendChild(rp);
        }
        tr.appendChild(act);

        usersBody.appendChild(tr);
      });
    }).catch(function (err) {
      /* (020) RLS قد يمنع قراءة الفريق (سياسة غير مطبقة بعد) — رسالة داخلية
         بدل كسر القسم، والجدول يُظهر حالة فارغة مع «—» */
      var ub = $('#usersBody');
      if (ub) ub.textContent = '';
      var ue = $('#usersEmpty');
      if (ue) {
        ue.textContent = 'قائمة المستخدمين غير متاحة الآن — تأكد من تطبيق سياسات RLS على profiles.';
        ue.hidden = false;
      }
    });

    /* الجلسات النشطة — تتبع المنظمة المعروضة نفسها */
    loadSessions();

    global.db.audit.recent(50, activeOrgId || undefined).then(function (rows) {
      var body = $('#auditBody');
      body.textContent = '';
      rows = rows || [];
      $('#auditEmpty').hidden = rows.length > 0;

      var names = { insert: 'إضافة', update: 'تعديل', delete: 'حذف', approve_all: 'اعتماد الكل' };
      rows.forEach(function (a) {
        var tr = el('tr');
        var c1 = el('td');
        c1.appendChild(el('span', 'tag tag-' + a.action, names[a.action] || a.action));
        tr.appendChild(c1);
        /* (016d) العمليات الجماعية: بدل اسم الطفل يُعرض عدد السجلات المتأثرة.
           (020) مخطط قديم بلا cnt/batch_kind؟ تُعرض «—» بدل فشل القسم كله */
        tr.appendChild(el('td', null,
          a.batch_kind != null ? ar(a.cnt || 0) + ' سجل'
          : (a.child_name != null ? a.child_name : '—')));
        tr.appendChild(el('td', 'muted', a.user_name || '—'));
        tr.appendChild(el('td', 'muted', fmtStamp(a.at)));
        body.appendChild(tr);
      });
    }).catch(function (err) {
      /* (020) عزل الفشل: سجل النشاط لا يكسر بقية لوحة المدير */
      var ab = $('#auditBody');
      if (ab) ab.textContent = '';
      var ae = $('#auditEmpty');
      if (ae) {
        ae.textContent = 'سجل النشاط غير متاح الآن — تأكد من جدول record_audit وأعمدته.';
        ae.hidden = false;
      }
    });
  }

  function nuError(name, msg) {
    var slot = $('.err[data-for="nu' + name + '"]');
    if (slot) slot.textContent = msg || '';
  }

  function clearNuErrors() {
    $$('.new-user-grid .err').forEach(function (s) { s.textContent = ''; });
  }

  function bindNewUserForm() {
    var form2 = $('#newUserForm');
    if (!form2) return;

    /* مدير المنصة يختار المنظمة عند إنشاء مستخدم؛ المدير العادي لمنظمته تلقائياً */
    var isSuper2 = global.auth.isSuperAdmin();
    $('#nuOrgField').hidden = !isSuper2;
    /* (026) خيار «مدير المنصة» ظاهر لمدير المنصة حصراً — ليضيف مديرَي منصّة آخرين */
    var roleSuperOpt = $('#nuRoleSuper');
    if (roleSuperOpt) roleSuperOpt.hidden = !isSuper2;

    /* مربعات الخدمات تظهر عند اختيار «مُدخِل بيانات» فقط */
    var svcField = $('#nuServicesField');
    $('#nuRole').addEventListener('change', function () {
      svcField.hidden = this.value !== 'staff';
    });

    /* بريد الدخول يُبنى من اسم المستخدم وكود المنظمة: user@code.ps —
       معاينة حية أثناء الكتابة، والحساب الفعلي يتم في الخادم. */
    function updateEmailPreview() {
      var prev = $('#nuEmailPreview');
      if (!prev) return;
      var id = $('#nuEmpId').value.trim();
      var code = activeOrgCode();
      if (id && code)      prev.textContent = 'بريد الدخول: ' + id + '@' + code + '.ps';
      else if (id)         prev.textContent = 'أكمل اختيار المنظمة لمعرفة بريد الدخول.';
      else                 prev.textContent = '';
    }
    $('#nuEmpId').addEventListener('input', updateEmailPreview);
    $('#nuOrg').addEventListener('change', updateEmailPreview);

    form2.addEventListener('submit', function (e) {
      e.preventDefault();
      clearNuErrors();
      adminAlert('');

      var fullName   = $('#nuName').value.trim();
      var employeeId = $('#nuEmpId').value.trim();
      var password   = $('#nuPassword').value;
      var role       = $('#nuRole').value;
      var orgId      = $('#nuOrg').value || null;
      var isSuper    = global.auth.isSuperAdmin();
      var firstBad   = null;

      /* الخدمات المختارة (للموظف المحصور فقط) */
      var services = [];
      $$('#nuServices input[type="checkbox"]').forEach(function (cb) {
        if (cb.checked) services.push(cb.value);
      });
      if (role !== 'staff') services = [];

      function bad(f, m) { nuError(f, m); if (!firstBad) firstBad = f; }

      if (fullName.length < 2) bad('Name', 'الاسم الكامل مطلوب.');
      /* (022) اسم المستخدم: حروف إنجليزية صغيرة وأرقام (ونقطة/شرطة_) 3–20 —
         بدل «رقم هوية» بالأرقام حصراً */
      if (!/^[a-z0-9._-]{3,20}$/.test(employeeId)) {
        bad('EmpId', 'اسم المستخدم: 3–20 حرفاً إنجليزياً صغيراً أو رقماً (والنقطة أو الشرطة _ مسموحة) بلا فراغات.');
      }
      if (password.length < 8) bad('Password', 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.');
      if (role !== 'admin' && role !== 'staff' && !(isSuper && role === 'super_admin')) {
        bad('Role', 'اختر صلاحية صحيحة.');
      }
      if (isSuper && !orgId) bad('Org', 'اختر المنظمة.');

      if (firstBad) {
        var node = $('#nu' + firstBad);
        if (node) node.focus();
        return;
      }

      var btn = $('#btnNewUser');
      busy(btn, true);

      global.db.profiles.create({ fullName: fullName, employeeId: employeeId, password: password, role: role, orgId: orgId, services: services })
        .then(function () {
          ['nuName', 'nuEmpId', 'nuPassword'].forEach(function (id) { $('#' + id).value = ''; });
          updateEmailPreview();
          toast('تم إنشاء حساب «' + fullName + '».', 'ok');
          return loadAdmin();
        })
        .catch(function (err) {
          if (err && err.code === 'email_taken') {
            nuError('EmpId', 'اسم المستخدم مستخدم مسبقاً لهذه المنظمة.');
          } else if (err && err.code === 'org_code_missing') {
            adminAlert(err.message);
          } else {
            adminAlert('تعذّر إنشاء الحساب: ' + err.message);
          }
        })
        .then(function () { busy(btn, false); });
    });
  }

  /* تعديل خدمات موظف قائم: قائمة مرقمة يدخلها المدير (نفس نمط askResetPassword)
     مثال: 1,3 = NICU + SCBU — أو فارغ = كل الخدمات */
  function askEditServices(profile) {
    var all = ['NICU', 'Consultations', 'SCBU', 'B.F'];
    var menu = all.map(function (s, i) {
      return (i + 1) + ' = ' + (SERVICE_LABELS[s] || s);
    }).join('\n');

    var current = (profile.services || []).map(function (s) {
      return all.indexOf(s) + 1;
    }).join(',');

    var answer = window.prompt(
      'الخدمات المسموحة لـ «' + (profile.full_name || profile.email) + '»\n' +
      menu +
      '\n\nأدخل أرقام الخدمات مفصولة بفواصل (مثال: 1,3) — أو اتركه فارغاً لكل الخدمات:',
      current
    );
    if (answer === null) return;   /* إلغاء */

    var chosen = answer.trim()
      ? answer.split(',').map(function (x) { return parseInt(x.trim(), 10); })
          .filter(function (n) { return n >= 1 && n <= all.length; })
          .map(function (n) { return all[n - 1]; })
          .filter(function (v, i, a) { return a.indexOf(v) === i; })
      : [];

    adminAlert('');
    global.db.profiles.setRole(profile.id, 'staff', chosen)
      .then(function () {
        toast(chosen.length
          ? 'تم تحديث الخدمات: ' + chosen.map(function (s) { return SERVICE_LABELS[s] || s; }).join('، ')
          : 'تم الاعتماد: كل الخدمات مسموحة.', 'ok');
        return loadAdmin();
      })
      .catch(function (err) {
        adminAlert('تعذّر تحديث الخدمات: ' + err.message);
      });
  }

  function askResetPassword(profile) {
    var next = window.prompt(
      'كلمة المرور الجديدة لـ «' + (profile.full_name || profile.email) + '»\n' +
      '8 أحرف على الأقل.'
    );
    if (next === null) return;

    if (next.length < 8) {
      adminAlert('كلمة المرور يجب أن تكون 8 أحرف على الأقل.');
      return;
    }

    adminAlert('');
    global.db.profiles.resetPassword(profile.id, next)
      .then(function () { toast('تم تحديث كلمة المرور.', 'ok'); })
      .catch(function (err) { adminAlert('تعذّر تحديث كلمة المرور: ' + err.message); });
  }

  /* ==================== إدارة الجلسات (للمديرين) ====================
     عرض آخر عمليات تسجيل الدخول للفريق وإنهاء أي جلسة فوراً.
     تُحمَّل مع تبويب الإدارة، وتتحدث مع كل refresh. */

  function currentSessionToken() {
    return (global.auth.session && global.auth.session.access_token) || null;
  }

  function deviceLabel(row) {
    if (row.device) return row.device;
    return row.ip || 'جهاز غير معروف';
  }

  function renderSessions(rows) {
    var body = $('#sessionsBody');
    body.textContent = '';
    $('#sessionsEmpty').hidden = rows.length > 0;

    var myToken = currentSessionToken();

    rows.forEach(function (s) {
      var tr = el('tr');

      var who = el('td');
      who.appendChild(document.createTextNode((s.profiles && s.profiles.full_name) || s.email || '—'));
      if (s.email) who.title = s.email;
      tr.appendChild(who);

      tr.appendChild(el('td', 'muted', deviceLabel(s)));
      tr.appendChild(el('td', 'muted', fmtStamp(s.last_seen_at || s.created_at)));

      var st = el('td');
      if (s.revoked_at) {
        st.appendChild(el('span', 'tag tag-session-revoked', 'منتهية'));
      } else if (myToken && s.id === myToken) {
        st.appendChild(el('span', 'tag tag-session-current', 'هذه الجلسة'));
      } else {
        st.appendChild(el('span', 'tag tag-insert', 'نشطة'));
      }
      tr.appendChild(st);

      var act = el('td');
      if (s.revoked_at) {
        act.appendChild(el('span', 'muted', '—'));
      } else if (myToken && s.id === myToken) {
        act.appendChild(el('span', 'muted', 'جلستك الحالية'));
      } else {
        var btn = el('button', 'icon-btn danger', 'إنهاء الجلسة');
        btn.type = 'button';
        btn.addEventListener('click', function () {
          adminAlert('');
          busy(btn, true);
          global.db.sessions.signOutUser(s.id)
            .then(function () {
              toast('تم إنهاء الجلسة.', 'ok');
              return renderSessionsPromise();
            })
            .catch(function (err) {
              adminAlert('تعذّر إنهاء الجلسة: ' + err.message);
            })
            .then(function () { busy(btn, false); });
        });
        act.appendChild(btn);
      }
      tr.appendChild(act);

      body.appendChild(tr);
    });
  }

  function renderSessionsPromise() {
    return loadSessions();
  }

  function loadSessions() {
    if (!global.auth.isAdmin()) return Promise.resolve();
    return global.db.sessions.list(50, activeOrgId || undefined)
      .then(renderSessions)
      .catch(function (err) {
        /* الجدول بلا بيانات إن لم يُطبَّق الترحيل 008 بعد — بلا انهيار */
        $('#sessionsBody').textContent = '';
        $('#sessionsEmpty').hidden = false;
        if (!/relation|schema cache|does not exist/i.test(String(err.message))) {
          adminAlert('تعذّر تحميل الجلسات: ' + err.message);
        }
      });
  }

  $('#btnRefreshSessions').addEventListener('click', loadSessions);

  /* ==================== (016c) اعتماد الكل — دفعي للمدير ==================== */
  var approveAllBtn = $('#btnApproveAll');
  if (approveAllBtn) approveAllBtn.addEventListener('click', function () {
    if (!global.auth.isAdmin() || viewingOtherOrg() || showDeleted) return;
    global.confirm(
      'سيتم اعتماد كل سجلات «بانتظار الاعتماد» في منظمتك دفعة واحدة.\n' +
      'بعد الاعتماد لا يستطيع الموظفون تعديلها (تصلح أنت لتعديلها دائماً).\n' +
      'هل تريد المتابعة؟'
    ) && approveAllPending();
  });

  /* ==================== (016) عرض المحذوفات — مفتاح المدير ==================== */
  $('#chkDeleted').addEventListener('change', function () {
    showDeleted = this.checked;
    if (showDeleted && editingId) resetForm();   /* نهاية أي تعديل جارٍ قبل دخول السلة */
    /* (016b) فلتر «بانتظار الاعتماد» لا معنى له داخل السلة */
    var fp = $('#filterPending');
    if (fp) fp.hidden = showDeleted;
    toast(showDeleted
      ? 'عرض سلة المحذوفات — الـ زر «استعادة» يُعيد السجل إلى القائمة.'
      : 'عودة إلى عرض السجلات النشطة.', 'ok');
    fetchPage(true).then(loadPendingBadge);
  });

  /* ==================== لوحة الإحصاءات (للمديرين) ====================
     كل الحسابات تتم من الكاش المحمّل بالفعل — بلا استعلامات إضافية،
     وتُعاد الرسمة عند كل تحديث للسجلات (refresh / Realtime).
     الثوابت العربية (أشهر/خدمات) في js/shared.js — NICU.MONTHS_AR/SERVICE_AR */
  var MONTHS_AR = global.NICU.MONTHS_AR;
  var SERVICE_AR = global.NICU.SERVICE_AR;

  function statsFiltered() {
    var from = $('#statsFrom').value;
    var to = $('#statsTo').value;
    return cacheStats.filter(function (r) {
      if (!r.admitDate) return false;
      if (from && r.admitDate < from) return false;
      if (to && r.admitDate > to) return false;
      return true;
    });
  }

  function statsEl(id) { return document.getElementById(id); }

  function hbarChart(container, pairs, opts) {
    container.textContent = '';
    var o = opts || {};
    var max = 0;
    pairs.forEach(function (p) { if (p[1] > max) max = p[1]; });
    if (!pairs.length || max === 0) {
      if (o.emptyEl) o.emptyEl.hidden = false;
      return;
    }
    if (o.emptyEl) o.emptyEl.hidden = true;

    pairs.forEach(function (p, i) {
      var row = el('div', 'hbar');
      var lbl = el('span', 'hbar-label', p[0]);
      lbl.title = p[0];
      row.appendChild(lbl);

      var track = el('div', 'hbar-track');
      var fill = el('div', 'hbar-fill' + (o.alternate && i % 2 ? ' alt' : ''));
      fill.style.width = Math.round(p[1] / max * 100) + '%';
      track.appendChild(fill);
      row.appendChild(track);

      row.appendChild(el('span', 'hbar-value', ar(p[1])));
      container.appendChild(row);
    });
  }

  function donutChart(donut, legend, pairs, emptyEl) {
    donut.textContent = '';
    legend.textContent = '';
    var total = pairs.reduce(function (s, p) { return s + p[1]; }, 0);
    if (!pairs.length || total === 0) {
      donut.style.background = '';
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    // تلوين الدائرة بنِسَب CSS conic-gradient ثم بناء المفتاح
    var stops = [];
    var acc = 0;
    var colors = ['var(--brand)', 'var(--accent)'];
    pairs.forEach(function (p, i) {
      var pct = p[1] / total * 100;
      stops.push(colors[i % 2] + ' ' + acc.toFixed(2) + '% ' + (acc + pct).toFixed(2) + '%');
      acc += pct;

      var item = el('div', 'legend-item');
      item.appendChild(el('span', 'legend-swatch c' + ((i % 2) + 1)));
      item.appendChild(document.createTextNode(
        p[0] + ' — ' + ar(p[1]) + ' (' + ar(Math.round(pct)) + '%)'
      ));
      legend.appendChild(item);
    });
    donut.style.background = 'conic-gradient(' + stops.join(', ') + ')';
  }

  function renderStats() {
    /* يظهر للمراقب أيضاً */
    if (global.auth.isAdmin() || global.auth.isViewer()) $('#statsPanel').hidden = false;

    var rows = statsFiltered();

    /* البطاقات الأربع — المنطق الموحّد في js/shared.js */
    var k = global.NICU.computeKpis(rows);

    $('#kpiTotal').textContent = ar(k.total);
    $('#kpiThisMonth').textContent = ar(k.month);
    $('#kpiActive').textContent = ar(k.active);
    $('#kpiAvgDays').textContent = ar(k.avgDays);

    /* حسب الشهر — الأعمدة بترتيب الشهور لا حسب التكرار */
    var byMonth = {};
    rows.forEach(function (r) {
      var m = r.month;
      if (m) byMonth[m] = (byMonth[m] || 0) + 1;
    });
    var monthPairs = global.NICU.MONTHS.map(function (en) {
      return [global.NICU.MONTHS_AR[en] || en, byMonth[en] || 0];
    }).filter(function (p) { return p[1] > 0; });
    hbarChart(statsEl('chartMonth'), monthPairs, { emptyEl: statsEl('chartMonthEmpty') });

    /* حسب الخدمة */
    var byService = {};
    rows.forEach(function (r) {
      var s = r.service;
      if (s) byService[s] = (byService[s] || 0) + 1;
    });
    var servicePairs = Object.keys(byService)
      .sort(function (a, b) { return byService[b] - byService[a]; })
      .map(function (s) { return [(SERVICE_AR[s] || s) + ' (' + s + ')', byService[s]]; });
    hbarChart(statsEl('chartService'), servicePairs,
              { emptyEl: statsEl('chartServiceEmpty'), alternate: true });

    /* حسب التصنيف: N = خديج، P = أطفال */
    var nCount = 0, pCount = 0;
    rows.forEach(function (r) {
      if (r.category === 'N' || r.category === 'Neonate') nCount++;
      else if (r.category === 'P' || r.category === 'Pedeatric') pCount++;
    });
    donutChart(statsEl('chartCategory'), statsEl('chartCategoryLegend'),
               [['N — حديثو الولادة', nCount], ['P — الأطفال', pCount]],
               statsEl('chartCategoryEmpty'));
  }

  /* الإحصاءات تُحسب من صفحة الجدول الحالية؟ لا — تحتاج كل السجلات.
     تُحمّل مرة عند فتح التبويب أول مرة، وتُحدَّث عند كل refresh فقط
     إن كان التبويب مفتوحاً — صفر تكلفة لبقية الاستخدام. */
  var statsLoaded = false;

  function loadStats() {
    /* الإحصاءات للمديرين وللمراقب (اطلاع + تقارير) */
    if (!global.auth.isAdmin() && !global.auth.isViewer()) return Promise.resolve();
    /* إحصاءات المنظمة المعروضة حالياً (orgId يمرر عبر currentFilters نفسه) */
    return global.db.records.all(currentFilters())
      .then(function (all) {
        cacheStats = all;
        statsLoaded = true;
        renderStats();
      })
      .catch(function () {});
  }

  /* renderStats يقرأ من cacheStats (كل السجلات) لا من صفحة العرض */
  var cacheStats = [];

  $('#tabStats').addEventListener('click', function () {
    if (!statsLoaded) loadStats();
  });

  $('#statsFrom').addEventListener('change', renderStats);
  $('#statsTo').addEventListener('change', renderStats);
  $('#btnStatsClear').addEventListener('click', function () {
    $('#statsFrom').value = '';
    $('#statsTo').value = '';
    renderStats();
  });

  /* ==================== مقارنة المنظمات (مدير المنصة) ====================
     تجمع إحصاءات كل المنظمات جنباً إلى جنب في جدول واحد (كل صف مؤشر
     وكل عمود منظمة) + بطاقة ملخص لكل منظمة بمخططاتها المصغرة.
     القراءة عبر المنظمات مسموحة لـ super_admin من RLS (005)،
     والأعداد السريعة من view org_overview.
     ملاحظة: تُبنى من org_overview + records.all لكل منظمة،
     لذا لا تتأثر بتصفية التاريخ في أعلى تبويب الإحصاءات. */

  var COMPARE_ROWS = [
    { key: 'users',   label: 'عدد المستخدمين',        num: true  },
    { key: 'total',   label: 'إجمالي السجلات',        num: true  },
    { key: 'month',   label: 'دخول هذا الشهر',        num: true  },
    { key: 'active',  label: 'قيد العناية الآن',      num: true  },
    { key: 'avgDays', label: 'متوسط أيام العلاج',     num: false },
    { key: 'topService', label: 'أكثر خدمة طلباً',    num: false }
  ];

  var compareLoaded = false;

  /* مقارنة أعداد الشهور بين كل المنظمات — تُلحق في نفس الجدول بعد صف فاصل */
  function appendCompareMonthRows(stats) {
    stats.forEach(function (s) {
      s.byMonth = {};
      s.rows.forEach(function (r) {
        if (r.month) s.byMonth[r.month] = (s.byMonth[r.month] || 0) + 1;
      });
    });

    var body = $('#compareBody');
    var tr = el('tr', 'compare-divider');
    var td = el('td', null, 'أعداد المستفيدين حسب الشهر');
    td.colSpan = stats.length + 1;
    tr.appendChild(td);
    body.appendChild(tr);

    global.NICU.MONTHS.forEach(function (m) {
      var sum = stats.reduce(function (t, s) { return t + (s.byMonth[m] || 0); }, 0);
      if (!sum) return;   // شهر بلا أي سجلات في كل المنظمات لا يُعرض

      var row = el('tr');
      row.appendChild(el('td', 'row-label', MONTHS_AR[m] || m));
      stats.forEach(function (s) {
        row.appendChild(el('td', null, ar(s.byMonth[m] || 0)));
      });
      body.appendChild(row);
    });
  }

  function renderCompare(stats) {
    $('#compareLoading').hidden = true;
    $('#compareError').hidden = true;

    if (!stats.length) {
      $('#compareEmpty').hidden = false;
      $('#compareCharts').hidden = true;
      return;
    }
    $('#compareEmpty').hidden = true;

    /* --- الجدول: كل صف مؤشر وكل عمود منظمة --- */
    var head = $('#compareHead');
    head.textContent = '';
    head.appendChild(el('th', 'row-label', 'المؤشر'));
    stats.forEach(function (s) {
      head.appendChild(el('th', null, s.name));
    });

    var body = $('#compareBody');
    body.textContent = '';
    COMPARE_ROWS.forEach(function (row) {
      var tr = el('tr');
      tr.appendChild(el('td', 'row-label', row.label));
      stats.forEach(function (s) {
        var v = s.kpi[row.key];
        if (v === null || v === '') {
          tr.appendChild(el('td', 'muted', '—'));
        } else {
          tr.appendChild(el('td', null, row.num ? ar(v) : String(v)));
        }
      });
      body.appendChild(tr);
    });

    appendCompareMonthRows(stats);

    /* --- بطاقة ملخص لكل منظمة --- */
    var grid = $('#compareCharts');
    grid.textContent = '';
    grid.hidden = false;

    var maxTotal = 0;
    stats.forEach(function (s) { if (s.kpi.total > maxTotal) maxTotal = s.kpi.total; });

    stats.forEach(function (s, i) {
      var card = el('div', 'compare-card');
      var h = el('h3', 'sub-head', s.name);
      h.title = s.name;
      card.appendChild(h);

      var kpis = el('div', 'compare-kpis');
      kpis.appendChild(el('span', 'compare-big', ar(s.kpi.total)));
      kpis.appendChild(el('span', 'compare-cap', 'إجمالي السجلات'));
      kpis.appendChild(el('span', 'compare-big accent', ar(s.kpi.active)));
      kpis.appendChild(el('span', 'compare-cap', 'قيد العناية'));
      card.appendChild(kpis);

      if (s.code) {
        card.appendChild(el('div', 'compare-users', 'الكود: ' + s.code));
      }

      if (s.kpi.users !== null) {
        var u = el('div', 'compare-users', 'المستخدمون: ' + ar(s.kpi.users));
        card.appendChild(u);
      }

      if (maxTotal > 0) {
        var chart = el('div', 'hbar-chart');
        var bar = el('div', 'hbar');
        bar.appendChild(el('span', 'hbar-label', 'الإجمالي'));
        var track = el('div', 'hbar-track');
        var fill = el('div', 'hbar-fill' + (i % 2 ? ' alt' : ''));
        fill.style.width = Math.round(s.kpi.total / maxTotal * 100) + '%';
        track.appendChild(fill);
        bar.appendChild(track);
        bar.appendChild(el('span', 'hbar-value', ar(s.kpi.total)));
        chart.appendChild(bar);
        card.appendChild(chart);
      }

      var byService = {};
      s.rows.forEach(function (r) {
        if (r.service) byService[r.service] = (byService[r.service] || 0) + 1;
      });
      var pairs = Object.keys(byService)
        .sort(function (a, b) { return byService[b] - byService[a]; })
        .slice(0, 3)
        .map(function (sv) { return [(SERVICE_AR[sv] || sv) + ' (' + sv + ')', byService[sv]]; });
      var chartEl = el('div', 'hbar-chart');
      hbarChart(chartEl, pairs, null);
      card.appendChild(chartEl);

      /* (028) حُذف card.appendChild(chart) المكرر خارج الشرط — كان يرمي
         TypeError «parameter 1 is not of type 'Node'» عندما تكون كل
         المنظمات فارغة (maxTotal = 0 ← chart غير معرف بسبب hoisting) */
      grid.appendChild(card);
    });
  }

  function loadCompare() {
    if (!global.auth.isSuperAdmin()) return Promise.resolve();
    if (viewingOtherOrg()) return Promise.resolve();

    $('#comparePanel').hidden = false;
    $('#compareEmpty').hidden = true;
    $('#compareError').hidden = true;
    $('#compareLoading').hidden = false;
    $('#compareCharts').hidden = true;

    return global.db.orgs.overview().then(function (overview) {
      return Promise.all(overview.map(function (o) {
        return global.db.records.all({ orgId: o.id })
          .then(function (rows) {
            var k = global.NICU.computeKpis(rows);
            k.users = o.users_count;
            return {
              id: o.id,
              name: o.name,
              code: o.code,
              rows: rows,
              kpi: k
            };
          })
          .catch(function () {
            /* منظمة تفشل (شبكة مثلاً) لا تُسقط اللوحة كلها —
               تُعرض بأصفار وعلامة تنبيه في الاسم. */
            return {
              id: o.id,
              name: o.name + ' ⚠',
              code: o.code,
              rows: [],
              kpi: { users: o.users_count, total: 0, month: 0, active: 0, avgDays: 0 }
            };
          });
      }));
    }).then(function (stats) {
      compareLoaded = true;
      renderCompare(stats);
    }).catch(function (err) {
      $('#compareLoading').hidden = true;
      $('#compareCharts').hidden = true;
      var box = $('#compareError');
      box.textContent = 'تعذّر تحميل المقارنة: ' + (err && err.message ? err.message : 'خطأ غير معروف');
      box.hidden = false;
    });
  }

  $('#tabStats').addEventListener('click', function () {
    if (!statsLoaded) loadStats();
    if (!compareLoaded) loadCompare();
  });

  /* ==================== إدارة المنظمات (مدير المنصة) ==================== */
  /* كاش قائمة المنظمات — يُستخدم لمعرفة كود المنظمة المعروضة
     عند بناء معاينة بريد الموظف الجديد */
  var orgsCache = [];

  /* حالة الكشف التلقائي لكود المنظمة في شاشة الدخول (مشتركة بين bindAuth
     وleaveApp): الأكواد المرشحة لرقم الهوية + الكود الوحيد المتوقع تلقائياً */
  var loginResolved = null;
  var loginAutoCode = '';
  var loginResolveTimer = null;

  /* كود المنظمة الحالية: منظمة المستخدم من ملفه، أو المنظمة المعروضة من الكاش.
     يعيد '' إن لم يتوفر كود — والمعاينة تُخفي البريد حينها. */
  function activeOrgCode() {
    if (viewingOtherOrg()) {
      for (var i = 0; i < orgsCache.length; i++) {
        if (orgsCache[i].id === activeOrgId) return orgsCache[i].code || '';
      }
      return '';
    }
    return global.auth.orgCode() || '';
  }

  function loadOrgs() {
    if (!global.auth.isSuperAdmin()) return Promise.resolve();

    return global.db.orgs.list().then(function (orgList) {
      orgsCache = orgList || [];
      /* قائمة اختيار المنظمة في نموذج إنشاء المستخدم */
      var nuOrg = $('#nuOrg');
      var current = nuOrg.value;
      nuOrg.textContent = '';
      nuOrg.appendChild(new Option('— اختر المنظمة —', ''));
      orgList.forEach(function (o) {
        nuOrg.appendChild(new Option(o.name, o.id));
      });
      if (current) nuOrg.value = current;

      /* جدول المنظمات مع عدد المستخدمين والسجلات لكل منظمة */
      return Promise.all([
        global.db.profiles.list().catch(function () { return []; }),
        global.db.records.all({ q: '', service: '', month: '', mine: false }).catch(function () { return []; })
      ]).then(function (results) {
        var users = results[0], recs = results[1];
        var userCount = {}, recCount = {};
        users.forEach(function (p) {
          if (p.org_id) userCount[p.org_id] = (userCount[p.org_id] || 0) + 1;
        });
        recs.forEach(function (r) {
          if (r.orgId) recCount[r.orgId] = (recCount[r.orgId] || 0) + 1;
        });

        var body = $('#orgsBody');
        body.textContent = '';
        $('#orgsEmpty').hidden = orgList.length > 0;

        orgList.forEach(function (o) {
          var tr = el('tr');
          tr.appendChild(el('td', null, o.name));
          tr.appendChild(el('td', 'muted', o.code || '—'));
          tr.appendChild(el('td', null, ar(userCount[o.id] || 0)));
          tr.appendChild(el('td', null, ar(recCount[o.id] || 0)));
          tr.appendChild(el('td', 'muted', fmtStamp(o.created_at)));
          body.appendChild(tr);
        });
      });
    }).catch(function (err) {
      adminAlert('تعذّر تحميل المنظمات: ' + err.message);
    });
  }

  function bindNewOrgForm() {
    var f = $('#newOrgForm');
    if (!f) return;

    f.addEventListener('submit', function (e) {
      e.preventDefault();
      adminAlert('');
      var name = $('#noName').value.trim();
      var code = $('#noCode').value.trim().toLowerCase();
      var nameSlot = $('.err[data-for="noName"]');
      var codeSlot = $('.err[data-for="noCode"]');
      if (nameSlot) nameSlot.textContent = '';
      if (codeSlot) codeSlot.textContent = '';

      var bad = false;
      if (name.length < 2) {
        if (nameSlot) nameSlot.textContent = 'اسم المنظمة مطلوب.';
        bad = true;
      }
      /* الكود أساس بريد موظفي المنظمة: الرقم@الكود.ps */
      if (!/^[a-z0-9]{2,20}$/.test(code)) {
        if (codeSlot) codeSlot.textContent = 'الكود: 2–20 حرفاً إنجليزياً صغيراً أو رقماً بلا فراغات.';
        bad = true;
      }
      if (bad) return;

      var btn = $('#btnNewOrg');
      busy(btn, true);
      global.db.orgs.create(name, code).then(function () {
        $('#noName').value = '';
        $('#noCode').value = '';
        toast('تم إنشاء منظمة «' + name + '» بكود ' + code + '.', 'ok');
        return loadOrgs();
      }).catch(function (err) {
        /* رسالة القاعدة (تكرار الكود مثلاً) تُعرض بجانب حقل الكود */
        if (codeSlot) codeSlot.textContent = err.message;
      }).then(function () {
        busy(btn, false);
      });
    });
  }

  /* ==================== مبدّل المنظمات (023) ====================
     لمدير النظام (super_admin) حصراً: يتنقل بين كل المنظمات ويطّلع على
     بياناتها قراءةً. مدير المنظمة (admin) وموظفها لا يران إطلاقاً —
     نطاقهم منظمتهم فقط، والحماية النهائية بسياسات RLS على الخادم. */
  function populateOrgSwitcher() {
    var sel = $('#orgSwitcher');
    if (!sel) return Promise.resolve();
    if (!global.auth.isSuperAdmin()) { sel.hidden = true; return Promise.resolve(); }

    return global.db.orgs.list().then(function (orgList) {
      orgsCache = orgList || [];
      sel.textContent = '';

      /* منظمته أولاً — الوضع الافتراضي بكل الصلاحيات */
      var mineId = global.auth.orgId();
      sel.appendChild(new Option('منظمتي (' + (global.auth.orgName() || 'بدون اسم') + ')', ''));
      orgList.forEach(function (o) {
        if (o.id !== mineId) sel.appendChild(new Option(o.name, o.id));
      });

      /* يظهر فقط مع وجود منظمة أخرى واحدة على الأقل للانتقال إليها */
      sel.hidden = orgList.length === 0;
      sel.value = activeOrgId || '';
      applyHeaderLogo();
    }).catch(function () { sel.hidden = true; });
  }

  function applyOrgBanner() {
    var banner = $('#orgViewBanner');
    var chip = $('#userOrg');
    if (viewingOtherOrg()) {
      banner.hidden = false;
      chip.textContent = activeOrgName || 'منظمة أخرى';
      chip.hidden = false;
    } else {
      banner.hidden = true;
      chip.textContent = global.auth.orgName() || '';
      chip.hidden = !global.auth.orgName();
    }
  }

  /* شعار المنظمة في الهيدر — من نفس تخصيص الترويسة المحفوظ (مرة واحدة لكل منظمة) */
  function applyHeaderLogo() {
    var img = $('#headerLogo');
    var fb = $('#brandFallback');
    var target = viewingOtherOrg() ? (activeOrgId || null) : (global.auth.orgId() || null);
    var url = '';
    for (var i = 0; i < orgsCache.length; i++) {
      if (orgsCache[i].id === target) { url = orgsCache[i].logo_url || ''; break; }
    }
    if (url) {
      img.src = url;
      img.hidden = false;
      fb.hidden = true;
    } else {
      img.src = '';
      img.hidden = true;
      fb.hidden = false;
    }
  }

  function switchOrg(orgId) {
    /* (023) حماية مزدوجة: الواجهة + الخادم (RLS) — مدير المنظمة لا يجاوز */
    if (!global.auth.isSuperAdmin()) return;
    activeOrgId = orgId || null;
    activeOrgName = '';

    if (activeOrgId) {
      var sel = $('#orgSwitcher');
      activeOrgName = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
    }

    applyOrgBanner();
    applyHeaderLogo();
    pageNo = 0;
    editingId = null;
    editingUpdatedAt = null;
    resetForm();
    statsLoaded = false;   // إحصاءات المنظمة المختارة مختلفة
    compareLoaded = false; // المقارنة تجمع كل المنظمات من جديد
    loadFieldSettings();   // إعدادات الحقول تختلف بين المنظمات

    /* (016b) إعادة ضبط فلتر الاعتماد قبل جلب صفحة المنظمة الجديدة */
    var fpReset = $('#filterPending');
    if (fpReset) fpReset.value = '';

    fetchPage(true).then(function () {
      loadPendingBadge();     /* (016b) الشارة تختفي في وضع المنظمة الأخرى */
      if (global.auth.isAdmin()) {
        loadAdmin();          // فريق المنظمة المختارة
        loadSessions();       // جلسات المنظمة المختارة
        if (!viewingOtherOrg()) loadOrgs();   // إعادة جدول المنظمات لتحديث الأعداد
        /* الإحصاءات والمقارنة: تُعاد دائماً إن كان التبويب مفتوحاً —
           مدير المنصة يرى إحصاءات أي منظمة ينتقل إليها فوراً */
        if (!$('#tabStats').hidden) loadStats();
        if (global.auth.isSuperAdmin()) {
          if (viewingOtherOrg()) $('#comparePanel').hidden = true;
          else if (!$('#tabStats').hidden) loadCompare();
        }
      }
    });
  }

  $('#orgSwitcher').addEventListener('change', function () {
    /* (023) مستمع المبدّل: الحارس داخل switchOrg يمنع غير مدير النظام */
    switchOrg(this.value);
  });

  /* ==================== المصادقة: الواجهة ==================== */
  function authMsg(msg) {
    var e = $('#authAlert');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  function bindAuth() {
    /* شاشة الدخول ببساطة: أدخل اسم المستخدم ويُحلّ كود المنظمة تلقائياً
       (user@code.ps):
         • رمز واحد ← يُستخدم تلقائياً (حقل الكود مخفي — لا حاجة لكتابته)
         • أكواد متعددة لنفس الرقم (تعارض) ← تظهر قائمة اختيار
         • لا نتيجة ← يظهر حقل الكود اليدوي (حساب قديم/لم يُنشأ بعد)
       التوافق مع الحسابات القديمة (بريد يدوي): كتابة بريد كامل في حقل
       اسم المستخدم تُخفي حقل الكود وتبني البريد كما هو. */
    var isEmailInput = function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); };

    function currentCode() {
      var id = $('#loginEmpId').value.trim();
      if (isEmailInput(id)) return '';
      if (loginResolved && loginResolved.length === 1) return loginAutoCode;
      if (loginResolved && loginResolved.length > 1) {
        var sel = $('#loginOrgCodeSel');
        return sel ? String(sel.value || '').trim().toLowerCase() : '';
      }
      return $('#loginOrgCode').value.trim().toLowerCase();
    }

    function updateLoginPreview() {
      var v = $('#loginEmpId').value.trim();
      var prev = $('#loginEmailPreview');
      if (!prev) return;
      if (isEmailInput(v)) {
        prev.textContent = 'دخول بالبريد المباشر: ' + v;
        $('#loginCodeField').hidden = true;
        return;
      }
      $('#loginCodeField').hidden = false;
      var code = currentCode();
      if (code) prev.textContent = 'بريد دخولك: ' + v + '@' + code + '.ps';
      else if (loginResolved && loginResolved.length > 1) prev.textContent = 'اختر كود المنظمة من القائمة.';
      else prev.textContent = 'يُبنى بريدك: اسم-المستخدم@كود المنظمة.ps';
    }

    function applyLoginResolution(list) {
      var inp = $('#loginOrgCode');
      var sel = $('#loginOrgCodeSel');
      var note = $('#loginOrgCodeNote');
      loginResolved = list || [];
      loginAutoCode = loginResolved.length === 1 ? (String(loginResolved[0].code || '')) : '';
      if (sel) {
        sel.textContent = '';
        if (loginResolved.length > 1) {
          sel.appendChild(new Option('— اختر كود المنظمة —', ''));
          loginResolved.forEach(function (o) {
            var label = o.code + (o.name ? ' — ' + o.name : '');
            sel.appendChild(new Option(label, o.code));
          });
          sel.hidden = false;
        } else {
          sel.hidden = true;
        }
      }
      var orgCodeLabel = $('#loginOrgCodeLabel');
      if (inp) {
        /* الحقل مخفي افتراضياً — يُظهر فقط عند التضارب:
           لا نتيجة للرقم في القاعدة، أو أكثر من منظمة لنفس الرقم */
        inp.hidden = loginResolved.length > 0;
        if (loginResolved.length > 0) inp.value = '';
      }
      /* التسمية تظهر فقط حين يُعرض الحقل/القائمة فعلاً */
      if (orgCodeLabel) orgCodeLabel.hidden = loginResolved.length === 1;
      if (note) {
        if (loginResolved.length === 1) note.textContent = 'حُدّد تلقائياً — لا حاجة لكتابته.';
        else if (loginResolved.length > 1) note.textContent = 'يوجد أكثر من منظمة بهذا الرقم — اختر من القائمة.';
        else note.textContent = '';
      }
      updateLoginPreview();
    }

    function fallbackManual() {
      var inp = $('#loginOrgCode');
      var lbl = $('#loginOrgCodeLabel');
      var sel = $('#loginOrgCodeSel');
      var note = $('#loginOrgCodeNote');
      loginResolved = null;
      loginAutoCode = '';
      if (sel) { sel.textContent = ''; sel.hidden = true; }
      if (inp) inp.hidden = false;
      if (lbl) lbl.hidden = false;
      if (note) note.textContent = '';
      updateLoginPreview();
    }

    function lookupOrgCodes() {
      var v = $('#loginEmpId').value.trim();
      if (!v || isEmailInput(v)) return;
      clearTimeout(loginResolveTimer);
      loginResolveTimer = setTimeout(function () {
        if (!global.db || !global.db.orgs || typeof global.db.orgs.resolveForUsername !== 'function') {
          fallbackManual();
          return;
        }
        global.db.orgs.resolveForUsername(v)
          .then(applyLoginResolution)
          .catch(fallbackManual); /* القاعدة غير جاهزة/الدالة غائبة → حقل يدوي */
      }, 300);
    }

    $('#loginEmpId').addEventListener('input', function () {
      lookupOrgCodes();
      updateLoginPreview();
    });
    $('#loginOrgCode').addEventListener('input', updateLoginPreview);
    var orgSel = $('#loginOrgCodeSel');
    if (orgSel) orgSel.addEventListener('change', updateLoginPreview);

    $('#loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      authMsg('');
      var id = $('#loginEmpId').value.trim();
      var emailErr = $('#loginEmpIdErr');
      emailErr.hidden = true;

      var doLogin = function () {
        /* تعارض أكواد: لا بد من اختيار من القائمة */
        if (loginResolved && loginResolved.length > 1) {
          var chosen = orgSel ? String(orgSel.value || '').trim() : '';
          if (!chosen) {
            emailErr.textContent = 'اختر كود منظمتك من القائمة.';
            emailErr.hidden = false;
            return;
          }
        }

        /* بريد مباشر (حسابات قديمة) أو بناء الرقم@الكود.ps */
        var email = isEmailInput(id) ? id.toLowerCase()
                  : id + '@' + currentCode() + '.ps';

        if (!isEmailInput(email)) {
          emailErr.textContent = 'أدخل اسم مستخدمك (واختر المنظمة من القائمة عند التعارض)، أو بريدك الكامل إن كان حسابك قديماً.';
          emailErr.hidden = false;
          return;
        }

        var btn = $('#btnLogin');
        busy(btn, true);
        global.auth
          .login(email, $('#loginPassword').value)
          .then(function () { return enterApp(); })
          .catch(function (err) { authMsg(err.message); })
          .then(function () { busy(btn, false); });
      };

      /* ضغط Enter قبل اكتمال الكشف (300مللي) → نستكشف فوراً ثم نكمل.
         الخادم غير جاهز أو الدالة غائبة → نكمل بالحقل اليدوي. */
      if (!isEmailInput(id) && loginResolved === null &&
          global.db && global.db.orgs && typeof global.db.orgs.resolveForUsername === 'function') {
        global.db.orgs.resolveForUsername(id)
          .then(function (list) { applyLoginResolution(list); doLogin(); })
          .catch(function () { fallbackManual(); doLogin(); });
        return;
      }
      doLogin();
    });
  }

  function enterApp() {
    authScreen.hidden = true;
    app.hidden = false;

    $('#userName').textContent = global.auth.displayName();
    var isAdmin = global.auth.isAdmin();
    var isSuper = global.auth.isSuperAdmin();
    var isViewer = global.auth.isViewer();
    var allowed = global.auth.servicesAllowed();

    var roleLabel = isSuper ? 'مدير المنصة'
                  : isAdmin ? 'مدير'
                  : isViewer ? 'مراقب'
                  : 'مُدخِل بيانات';
    /* شارة الخدمات المحصورة: مثال «مُدخِل بيانات — NICU، SCBU» */
    if (allowed !== null) {
      roleLabel += ' — ' + allowed.map(function (s) { return SERVICE_LABELS[s] || s; }).join('، ');
    }
    $('#userRole').textContent = roleLabel;
    $('#userRole').className = 'role-tag ' + (isAdmin ? 'admin' : 'staff');

    var orgEl = $('#userOrg');
    var orgName = global.auth.orgName();
    orgEl.textContent = orgName;
    orgEl.hidden = !orgName;

    $('#adminPanel').hidden = !isAdmin;
    $('#statsPanel').hidden = !(isAdmin || isViewer);
    $('#orgsSection').hidden = !isSuper || viewingOtherOrg();
    $('#comparePanel').hidden = !isSuper || viewingOtherOrg();
    setAdminTabVisible(isAdmin);
    setStatsTabVisible(isAdmin || isViewer);
    applyOrgBanner();
    applyServicePermissions();   // حصر فلتر الخدمة والنموذج بصلاحيات الموظف
    try {
      var last = global.sessionStorage.getItem('nicuTab');
      /* paneAdmin وpaneStats للمديرين فقط — لا تُستعد لمستخدم عادي */
      if (last && (isAdmin || (last !== 'paneAdmin' && last !== 'paneStats'))) selectTab(last);
    } catch (e) {}

    resetForm();
    return refresh().then(function () {
      /* ترويسة التقارير + كاش المنظمات: لكل الأدوار (تُعرض في التقرير
         المطبوع لكل أعضاء المنظمة) — أما جدول إدارة المنظمات فللمدير العام */
      loadOrgBranding();
      loadFieldSettings();   /* الحقول الإلزامية/المخفية لمنظمة المستخدم */
      applyHeaderLogo();
      var fBtn = $('#btnFieldsSettings');
      if (fBtn) fBtn.hidden = !isAdmin;
      var bBtn = $('#btnBrandingSettings');
      if (bBtn) bBtn.hidden = !isAdmin;   /* (035) لمدير المنصة أيضاً */
      loadPendingBadge();   /* (016b) شارة «بانتظار الاعتماد» بعد أول تحميل */
      if (isAdmin) {
        loadCreatorNames();
        loadAdmin();
        if (isSuper) {
          loadOrgs();
          populateOrgSwitcher();
          loadCompare();        // لوحة مقارنة المنظمات لمدير المنصة
        }
      }
    });
  }

  /* تحميل بيانات ترويسة منظمة المستخدم فقط (بلا جدول إدارة المنظمات)
     — يملأ orgsCache لغير مدير المنصة كي يعرض التقرير التخصيص المحفوظ */
  function loadOrgBranding() {
    return global.db.orgs.list().then(function (orgList) {
      orgsCache = orgList || [];
    }).catch(function () { /* بلا ترويسة — التقرير يعمل بالاسم الافتراضي */ });
  }

  function leaveApp() {
    app.hidden = true;
    authScreen.hidden = false;
    editingId = null;
    editingUpdatedAt = null;
    showDeleted = false;
    var delChk = $('#chkDeleted');
    if (delChk) delChk.checked = false;
    cache = [];
    cacheStats = [];
    statsLoaded = false;
    compareLoaded = false;
    totalCount = 0;
    pageNo = 0;
    activeOrgId = null;
    activeOrgName = '';
    creatorNames = {};
    orgsCache = [];
    clearTimeout(loginResolveTimer);
    loginResolved = null;
    loginAutoCode = '';
    $('#loginPassword').value = '';
    $('#loginEmpId').value = '';
    $('#loginOrgCode').value = '';
    $('#loginOrgCode').hidden = true;
    var loginLbl = $('#loginOrgCodeLabel');
    if (loginLbl) loginLbl.hidden = true;
    var loginSel = $('#loginOrgCodeSel');
    if (loginSel) { loginSel.textContent = ''; loginSel.hidden = true; }
    var loginNote = $('#loginOrgCodeNote');
    if (loginNote) loginNote.textContent = '';
    $('#loginEmpIdErr').hidden = true;
    $('#loginEmailPreview').textContent = 'يُبنى بريدك: الرقم@كود المنظمة.ps';
    $('#loginCodeField').hidden = false;
    $('#adminPanel').hidden = true;
    $('#statsPanel').hidden = true;
    $('#comparePanel').hidden = true;
    setAdminTabVisible(false);
    setStatsTabVisible(false);
    selectTab('paneForm');
  }

  $('#btnLogout').addEventListener('click', function () {
    if (totalCount > 0 && !global.confirm(
      'لديك ' + ar(totalCount) + ' سجل في القائمة. الخروج لا يحذف شيئاً. متابعة؟'
    )) return;

    global.auth.logout().then(function (token) {
      /* تحديث صف الجلسة في لوحة المديرين (بصمت — عبر واجهة المحول) */
      if (token) {
        try { global.db.revokeSession(token); } catch (e) {}
      }
      leaveApp();
      toast('تم تسجيل الخروج.');
    }).catch(function () {
      /* (036) الخروج محلياً دائماً حتى لو فشل إبطال الجلسة على الخادم */
      leaveApp();
      toast('تم تسجيل الخروج.');
    });
  });

  /* ==================== التقرير المخصص بترويسة المنظمة ==================== */

  var REPORT_COLUMNS = [
    { field: 'seqNo',        label: '#' },
    { field: 'childName',    label: 'اسم الطفل' },
    { field: 'childId',      label: 'رقم الهوية' },
    { field: 'motherName',   label: 'اسم الأم' },
    { field: 'gender',       label: 'الجنس' },
    { field: 'admitDate',    label: 'تاريخ الدخول' },
    { field: 'dischargeDate', label: 'تاريخ الخروج' },
    { field: 'service',      label: 'الخدمة' },
    { field: 'treatmentDays', label: 'أيام العلاج' },
    { field: 'cause',        label: 'سبب الدخول والحالة' }
  ];

  /* بيانات الترويسة للمنظمة المعروضة (من الكاش أو من ملف المستخدم) */
  function reportBranding() {
    var b = {
      name: global.auth.orgName() || 'منظمة',
      code: global.auth.orgCode() || '',
      logoUrl: '',
      note: ''
    };
    if (viewingOtherOrg()) {
      for (var i = 0; i < orgsCache.length; i++) {
        if (orgsCache[i].id === activeOrgId) {
          b.name = orgsCache[i].report_name || orgsCache[i].name || b.name;   /* (035) التسمية المخصصة أولاً */
          b.code = orgsCache[i].code || '';
          b.logoUrl = orgsCache[i].logo_url || '';
          b.note = orgsCache[i].report_note || '';
          break;
        }
      }
    } else if (orgsCache.length) {
      /* منظمتي — كاش المدير يحتوي أعمدة التخصيص */
      var mineId = global.auth.orgId();
      for (var j = 0; j < orgsCache.length; j++) {
        if (orgsCache[j].id === mineId) {
          b.name = orgsCache[j].report_name || b.name;   /* (035) التسمية المخصصة أولاً */
          b.logoUrl = orgsCache[j].logo_url || '';
          b.note = orgsCache[j].report_note || '';
          break;
        }
      }
    }
    return b;
  }

  function reportDateLabel(f) {
    var field = (f && f.dateField === 'discharge') ? 'الخروج' : 'الدخول';
    var from = (f && f.from) || '';
    var to = (f && f.to) || '';
    if (from && to) return 'من ' + from + ' إلى ' + to + ' (حسب تاريخ ' + field + ')';
    if (from) return 'من ' + from + ' فما بعد (حسب تاريخ ' + field + ')';
    if (to) return 'حتى ' + to + ' (حسب تاريخ ' + field + ')';
    return 'كل الفترات';
  }

  /* ---------- (031) تحكم أعمدة التقرير ----------
     حالة الاختيار تُحفظ محلياً (nicuReportCols) وتُستعاد عند الفتح،
     والأساسيات = العمود الخمسة المعروضة تاريخياً كأزرار سريعة. */
  var RP_COLS_KEY = 'nicuReportCols';
  var RP_BASIC = ['seqNo', 'childName', 'motherName', 'service', 'admitDate'];
  var rpColsSel = {};   // field -> true/false

  function rpColsLoad() {
    try {
      var saved = JSON.parse(global.localStorage.getItem(RP_COLS_KEY) || '{}');
      REPORT_COLUMNS.forEach(function (c) {
        rpColsSel[c.field] = (typeof saved[c.field] === 'boolean') ? saved[c.field] : true;
      });
    } catch (e) {
      REPORT_COLUMNS.forEach(function (c) { rpColsSel[c.field] = true; });
    }
  }

  function rpColsSave() {
    try { global.localStorage.setItem(RP_COLS_KEY, JSON.stringify(rpColsSel)); } catch (e) {}
  }

  function rpColsSelected() {
    return REPORT_COLUMNS.filter(function (c) { return rpColsSel[c.field]; });
  }

  function rpColsRender() {
    var wrap = $('#rpCols');
    wrap.textContent = '';
    REPORT_COLUMNS.forEach(function (c) {
      var chip = el('button', 'report-col-chip' + (rpColsSel[c.field] ? ' on' : ''), c.label);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', rpColsSel[c.field] ? 'true' : 'false');
      chip.addEventListener('click', function () {
        /* عمود واحد محدد على الأقل دائماً */
        if (rpColsSel[c.field] && rpColsSelected().length === 1) {
          toast('عمود واحد على الأقل مطلوب للتقرير.', 'err');
          return;
        }
        rpColsSel[c.field] = !rpColsSel[c.field];
        rpColsSave();
        rpColsRender();
        buildReport();
      });
      wrap.appendChild(chip);
    });
    var n = rpColsSelected().length;
    $('#rpColsCount').textContent = ar(n) + ' من ' + ar(REPORT_COLUMNS.length) + ' عمود';
  }

  function openReportBuilder() {
    var b = reportBranding();
    var logo = $('#rpLogo');
    if (b.logoUrl) { logo.src = b.logoUrl; logo.hidden = false; }
    else { logo.hidden = true; }
    $('#rpOrgName').textContent = b.name;
    $('#rpNote').textContent = b.note || '';
    $('#rpTitle').value = $('#rpTitle').value || 'تقرير المستفيدين';

    /* خيارات الخدمة في النافذة: خدماتي فقط إن كنت محصوراً */
    var sel = $('#rpService');
    sel.textContent = '';
    sel.appendChild(new Option('كل الخدمات', ''));
    var allowed = global.auth.servicesAllowed();
    var list = (allowed === null)
      ? ['NICU', 'Consultations', 'SCBU', 'B.F']
      : allowed;
    list.forEach(function (s) { sel.appendChild(new Option(SERVICE_LABELS[s] || s, s)); });

    rpColsLoad();
    rpColsRender();
    buildReport();
    $('#reportBuilder').hidden = false;
  }

  function buildReport() {
    var filters = currentFilters();
    /* نافذة التقرير لها فلاترها المستقلة */
    filters.dateFilter = {
      dateField: $('#rpDateField').value,
      from: $('#rpFrom').value || null,
      to: $('#rpTo').value || null
    };
    filters.service = $('#rpService').value;

    var cols = rpColsSelected();
    var head = $('#rpHead');
    head.textContent = '';
    cols.forEach(function (c) {
      head.appendChild(el('th', null, c.label));
    });

    $('#rpMeta').textContent = $('#rpTitle').value.trim() + ' — ' + reportDateLabel(filters.dateFilter);

    global.db.records.all(filters).then(function (rows) {
      var body = $('#rpBody');
      body.textContent = '';
      $('#rpEmpty').hidden = rows.length > 0;

      rows.forEach(function (r) {
        var tr = el('tr');
        cols.forEach(function (c) {
          var v = c.field === 'seqNo' ? r.seqNo : r[c.field];
          tr.appendChild(el('td', null, (v === null || v === '') ? '—' : String(v)));
        });
        body.appendChild(tr);
      });

      $('#rpCount').textContent = 'عدد السجلات: ' + ar(rows.length);
    }).catch(function (err) {
      toast('تعذّر بناء التقرير: ' + err.message, 'err');
    });
  }

  function printReport() {
    /* (031) اتجاه الطباعة: تلقائي = أفقي عند تعدد الأعمدة (≥7) */
    var mode = $('#rpOrientation').value;
    var cols = rpColsSelected().length;
    var orient = mode === 'auto' ? (cols >= 7 ? 'landscape' : 'portrait') : mode;
    document.body.setAttribute('data-print-orient', orient);

    document.body.classList.add('printing-report');
    var restore = function () {
      document.body.classList.remove('printing-report');
      document.body.removeAttribute('data-print-orient');
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
    /* احتياط لعدم إطلاق afterprint في بعض المتصفحات */
    setTimeout(restore, 3000);
  }

  $('#btnCustomReport').addEventListener('click', openReportBuilder);
  $('#btnReportClose').addEventListener('click', function () { $('#reportBuilder').hidden = true; });
  $('#btnReportClose2').addEventListener('click', function () { $('#reportBuilder').hidden = true; });

  /* (031) أزرار الأعمدة السريعة + إعادة البناء عند تغيير الاتجاه */
  $('#rpColsAll').addEventListener('click', function () {
    REPORT_COLUMNS.forEach(function (c) { rpColsSel[c.field] = true; });
    rpColsSave(); rpColsRender(); buildReport();
  });
  $('#rpColsBasic').addEventListener('click', function () {
    REPORT_COLUMNS.forEach(function (c) {
      rpColsSel[c.field] = RP_BASIC.indexOf(c.field) !== -1;
    });
    rpColsSave(); rpColsRender(); buildReport();
  });
  $('#rpOrientation').addEventListener('change', function () {
    /* التغيير يسري عند الطباعة التالية — لا حاجة لإعادة بناء */
  });
  ['#rpDateField', '#rpFrom', '#rpTo', '#rpService'].forEach(function (sel) {
    $(sel).addEventListener('change', buildReport);
  });
  $('#rpTitle').addEventListener('input', buildReport);
  $('#btnReportPrint').addEventListener('click', printReport);

  /* تخصيص الترويسة — من لوحة الإدارة (المدير + مدير المنصة في أي منظمة يعرضها) */
  $('#btnBrandingSettings').addEventListener('click', function () {
    if (!global.auth.isAdmin()) return;
    var b = reportBranding();
    $('#brLogo').value = b.logoUrl;
    $('#brName').value = b.name;
    $('#brNote').value = b.note;
    $('#brandingError').hidden = true;
    $('#brandingDialog').hidden = false;
  });

  $('#btnBrandingClose').addEventListener('click', function () { $('#brandingDialog').hidden = true; });
  $('#btnBrandingCancel').addEventListener('click', function () { $('#brandingDialog').hidden = true; });

  $('#btnBrandingSave').addEventListener('click', function () {
    var err = $('#brandingError');
    err.hidden = true;
    var orgId = activeOrgId || global.auth.orgId();
    var btn = $('#btnBrandingSave');
    busy(btn, true);
    global.db.orgs.saveBranding(orgId, $('#brLogo').value.trim(), $('#brName').value.trim(), $('#brNote').value.trim())
      .then(function () {
        /* تحديث الكاش المحلي ليتغير التقرير فوراً */
        var target = activeOrgId || global.auth.orgId();
        for (var i = 0; i < orgsCache.length; i++) {
          if (orgsCache[i].id === target) {
            orgsCache[i].logo_url = $('#brLogo').value.trim();
            orgsCache[i].report_note = $('#brNote').value.trim();
          }
        }
        $('#brandingDialog').hidden = true;
        toast('تم حفظ تخصيص الترويسة.', 'ok');
        openReportBuilder();   /* إعادة البناء بالترويسة الجديدة */
      })
      .catch(function (e) {
        err.textContent = e.message;
        err.hidden = false;
      })
      .then(function () { busy(btn, false); });
  });

  /* إغلاق النوافذ بزر Escape */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    $('#reportBuilder').hidden = true;
    $('#brandingDialog').hidden = true;
    $('#fieldsDialog').hidden = true;   /* (017) اتساق إغلاق نوافذ الإعدادات */
  });

  /* ==================== إعدادات حقول النموذج (لكل منظمة) ====================
     مدير المنظمة يحدد لكل حقل: required | optional | hidden.
     المدخل يرى النموذج بهذا الشكل، والتحقق يطابقه ديناميكياً.
     الإعدادات تُحمَّل من المنظمة وتُطبَّق عند الدخول/التبديل. */

  var requiredFieldsMap = {};   /* { field: 'required'|'optional'|'hidden' } */

  /* الحقول الأساسية لا يمكن إخفاؤها (صمم النموذج يعتمدها) */
  var ALWAYS_FIELDS = ['childName', 'motherName', 'gender', 'service', 'admitDate'];

  function fieldState(field) {
    var st = requiredFieldsMap[field];
    if (st === 'required' || st === 'hidden') return st;
    /* الافتراضي من النموذج الأصلي: الحقول ذات req * إلزامية، والباقي اختياري */
    if (!st) {
      var input = form ? form.elements[field] : null;
      if (input && input.closest && input.closest('.field')) {
        return input.closest('.field').querySelector('.req') ? 'required' : 'optional';
      }
      return ALWAYS_FIELDS.indexOf(field) !== -1 ? 'required' : 'optional';
    }
    return 'optional';
  }

  /* تطبيق الإعدادات على DOM النموذج */
  function applyFieldSettings() {
    if (!form) return;
    FIELDS.forEach(function (f) {
      var input = form.elements[f];
      if (!input) return;
      var wrap = input.closest('.field');
      if (!wrap) return;

      var st = fieldState(f);
      wrap.hidden = (st === 'hidden');
      input.required = (st === 'required');

      /* النجمة: إظهارها للإلزامي فقط */
      var req = wrap.querySelector('.req');
      if (req) req.hidden = (st !== 'required');
    });
  }

  /* (013) تطبيق «التعديل متاح لكل الموظفين» على الواجهة:
     الموظف المحصور يرى خدمات المنظمة كلها في الفلتر والنموذج،
     وتُلغى قفل خدمته الواحدة. يُستدعى بعد كل تحميل/تبديل للإعدادات. */
  function applyStaffEditAll() {
    if (!global.auth.canEditRecords()) return;
    var filterSvc = $('#filterService');
    var formSvc = form ? form.elements['service'] : null;
    if (filterSvc) {
      Array.prototype.forEach.call(filterSvc.options, function (opt) { opt.hidden = false; });
    }
    if (formSvc) {
      Array.prototype.forEach.call(formSvc.options, function (opt) { opt.disabled = false; });
      formSvc.disabled = false;
      formSvc.title = '';
    }
  }

  /* (013) مزامنة مفتاح «التعديل متاح لكل الموظفين» في لوحة الإدارة:
     يُستدعى من loadAdmin ومن loadFieldSettings — أياً وصل أولاً */
  function syncStaffEditToggle() {
    var box = $('#staffEditAllBox');
    var chk = $('#chkStaffEditAll');
    var isAdmin = global.auth.isAdmin();
    var inMyOrg = !viewingOtherOrg();
    if (box && chk) {
      box.hidden = !isAdmin || !inMyOrg;
      chk.checked = !!global.auth.staffEditAll;
    }
    /* (030) بطاقة «إعدادات المنظمة» (زرا حقول النموذج وترويسة التقارير):
       كانت hidden في HTML بلا كاشف — فلا يرى المدير زر التخصيص إطلاقاً.
       تظهر لمدير المنظمة في منظته، وتُخفى لغيره وفي وضع منظمة أخرى. */
    var settingsBox = $('#settingsActionsBox');
    if (settingsBox) settingsBox.hidden = !isAdmin;
    /* (035) زر تخصيص الترويسة لمدير المنصة أيضاً — يخصص ترويسة أي منظمة يعرضها
       (حتى في وضع القراءة فقط)، بينما حقول النموذج تبقى لمنظمة المدير فقط */
    var brandingBtnSync = $('#btnBrandingSettings');
    if (brandingBtnSync) brandingBtnSync.hidden = !isAdmin;
    var fieldsBtnSync = $('#btnFieldsSettings');
    if (fieldsBtnSync) fieldsBtnSync.hidden = !isAdmin || !inMyOrg;
  }

  function loadFieldSettings() {
    var orgId = activeOrgId || global.auth.orgId();
    requiredFieldsMap = {};
    if (!orgId) {
      applyFieldSettings();
      applyStaffEditAll();   /* (013) بلا منظمة — الافتراضي */
      return Promise.resolve();
    }
    return global.db.orgs.requiredFields(orgId).then(function (map) {
      requiredFieldsMap = map || {};
      applyFieldSettings();
      /* (013) جلب مفتاح «التعديل متاح لكل الموظفين» ثم تطبيقه على الواجهة */
      return global.db.orgs.staffEditAll(orgId).then(function (all) {
        global.auth.staffEditAll = !!all;
        applyStaffEditAll();
        syncStaffEditToggle();
      });
    }).catch(function () {
      applyFieldSettings();   /* بلا إعدادات — الافتراضي */
      global.auth.staffEditAll = false;
      applyStaffEditAll();
      syncStaffEditToggle();
    });
  }

  /* ---------- نافذة تحرير المدير ---------- */
  var FIELD_LABELS = {};
  (global.db.COLUMNS || []).forEach(function (c) { FIELD_LABELS[c.field] = c.label; });

  /* (017) ترتيب ثابت معروض للحالات في البطاقة */
  var FIELD_STATES_AR = { required: 'إلزامي', optional: 'اختياري', hidden: 'مخفي' };

  function openFieldsDialog() {
    if (!global.auth.isAdmin()) return;
    var list = $('#fieldsList');
    list.textContent = '';

    /* (017) عدّادات مباشرة أعلى القائمة تتجدد مع كل تغيير */
    var cnt = { required: 0, optional: 0, hidden: 0 };
    FIELDS.forEach(function (f) { cnt[fieldState(f)]++; });
    var counters = el('div', 'fields-counters');
    var cntSpans = {};
    [['required', 'إلزامي'], ['optional', 'اختياري'], ['hidden', 'مخفي']].forEach(function (o) {
      var s = el('span', 'field-cnt field-cnt-' + o[0], o[1] + ': ' + ar(cnt[o[0]]));
      cntSpans[o[0]] = s;
      counters.appendChild(s);
    });
    list.appendChild(counters);

    function updateCounters() {
      var c = { required: 0, optional: 0, hidden: 0 };
      FIELDS.forEach(function (f) { c[fieldState(f)]++; });
      [['required', 'إلزامي'], ['optional', 'اختياري'], ['hidden', 'مخفي']].forEach(function (o) {
        cntSpans[o[0]].textContent = o[1] + ': ' + ar(c[o[0]]);
      });
    }

    /* (017) الأساسية أولاً ثم فرز عربي طبيعي (localeCompare) بدل ترتيب الإنجليزية */
    var ordered = FIELDS.slice().sort(function (a, b) {
      var ca = ALWAYS_FIELDS.indexOf(a) !== -1 ? 0 : 1;
      var cb = ALWAYS_FIELDS.indexOf(b) !== -1 ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return String(FIELD_LABELS[a] || a).localeCompare(String(FIELD_LABELS[b] || b), 'ar');
    });

    ordered.forEach(function (f) {
      var st = fieldState(f);
      var isCore = ALWAYS_FIELDS.indexOf(f) !== -1;
      var row = el('div', 'field-row' + (st === 'hidden' ? ' is-hidden' : '') + (st === 'required' ? ' is-required' : ''));
      var meta = el('div', 'field-meta');
      meta.appendChild(el('span', 'field-name', FIELD_LABELS[f] || f));
      /* (017) وسم حالة سريع القراءة + شارة «أساسي» للحقول المحمية */
      meta.appendChild(el('span', 'field-badge ' + st, FIELD_STATES_AR[st] || st));
      if (isCore) meta.appendChild(el('span', 'field-badge core', 'أساسي'));
      var sel = el('select', 'field-state');
      [['optional', 'اختياري'], ['required', 'إلزامي'], ['hidden', 'مخفي']].forEach(function (o) {
        var opt = new Option(o[1], o[0]);
        if (isCore && o[0] === 'hidden') opt.disabled = true;
        sel.appendChild(opt);
      });
      sel.value = st;
      if (isCore) {
        sel.disabled = true;
        sel.title = 'حقل أساسي لا يمكن إخفاؤه';
      }
      sel.addEventListener('change', function () {
        requiredFieldsMap[f] = sel.value;
        applyFieldSettings();
        row.classList.toggle('is-hidden', sel.value === 'hidden');
        row.classList.toggle('is-required', sel.value === 'required');
        row.querySelector('.field-badge:not(.core)').textContent = FIELD_STATES_AR[sel.value];
        updateCounters();
      });
      row.appendChild(meta);
      row.appendChild(sel);
      list.appendChild(row);
    });

    $('#fieldsError').hidden = true;
    $('#fieldsDialog').hidden = false;
  }

  /* (013) حفظ مفتاح «التعديل متاح لكل الموظفين» — إعداد على مستوى المنظمة */
  $('#chkStaffEditAll').addEventListener('change', function () {
    var chk = this;
    var on = chk.checked;
    var orgId = activeOrgId || global.auth.orgId();
    if (on && !global.confirm(
      'سيصبح كل سجلات المنظمة قابلة للاطلاع والتعديل من كل الموظفين في كل الخدمات.\n' +
      'الحذف يبقى للمدير أو مالك السجل. هل تريد المتابعة؟'
    )) {
      chk.checked = false;
      return;
    }
    global.db.orgs.saveStaffEditAll(orgId, on).then(function () {
      global.auth.staffEditAll = on;
      toast(on
        ? 'تم التفعيل: كل الموظفين يطّلعون ويعدّلون سجلات المنظمة كلها.'
        : 'تم الإيقاف: عاد التعديل محصوراً بخدمات كل موظف.', 'ok');
      applyStaffEditAll();      /* فتح خدمات الفلتر والنموذج فوراً */
      return fetchPage(true);   /* إعادة الجلب — نطاق الاطلاع تغيّر */
    }).catch(function (err) {
      chk.checked = !on;
      adminAlert('تعذّر حفظ الإعداد: ' + err.message);
    }).then(function () {
      /* عند الإيقاف: استعادة قصر الواجهة فوراً (حصر الخدمة في الفلتر/النموذج) */
      if (!on) applyServicePermissions();
    });
  });

  $('#btnFieldsSettings').addEventListener('click', openFieldsDialog);
  $('#btnFieldsClose').addEventListener('click', function () { $('#fieldsDialog').hidden = true; });
  $('#btnFieldsCancel').addEventListener('click', function () {
    loadFieldSettings();   /* استعادة المحفوظ */
    $('#fieldsDialog').hidden = true;
  });

  $('#btnFieldsSave').addEventListener('click', function () {
    var orgId = activeOrgId || global.auth.orgId();
    var btn = $('#btnFieldsSave');
    var err = $('#fieldsError');
    err.hidden = true;
    busy(btn, true);
    global.db.orgs.saveRequiredFields(orgId, requiredFieldsMap)
      .then(function () {
        $('#fieldsDialog').hidden = true;
        toast('تم حفظ إعدادات الحقول.', 'ok');
      })
      .catch(function (e) {
        err.textContent = e.message;
        err.hidden = false;
      })
      .then(function () { busy(btn, false); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $('#fieldsDialog').hidden = true;
  });

  /* ==================== (019) الوضع الليلي/النهاري ====================
   زران متزامنان (ترويسة التطبيق + شاشة الدخول) يدوران: تلقائي ← فاتح ← داكن.
   المحرك في shared.js (NICU.setThemePref/themePref/themeNext)؛
   هنا الواجهة فقط + تحديث theme-color ليتوافق إطار متصفح الجوال مع الثيم. */
  var THEME_META = { auto: 'تلقائي', light: 'فاتح', dark: 'داكن' };
  var THEME_ICON = { auto: '☾', light: '☀', dark: '🌙' };
  var THEME_COLOR = { light: '#0b7285', dark: '#10171c' };

  function themeButtonLabel() {
    var pref = global.NICU.themePref();
    return THEME_ICON[pref] + ' ' + THEME_META[pref];
  }

  function syncThemeButtons() {
    var pref = global.NICU.themePref();
    var label = themeButtonLabel();
    ['#btnTheme', '#btnThemeAuth'].forEach(function (sel) {
      var b = $(sel);
      if (!b) return;
      b.textContent = label;
      b.title = pref === 'auto'
        ? 'الوضع: تلقائي (يتبع إعداد جهازك) — اضغط للفاتح'
        : pref === 'light' ? 'الوضع: فاتح — اضغط للداكن'
        : 'الوضع: داكن — اضغط للعودة إلى التلقائي';
    });
    var meta = document.querySelector('meta[name="theme-color"]');
    var eff = document.documentElement.getAttribute('data-theme');
    if (meta) meta.setAttribute('content', THEME_COLOR[eff] || THEME_COLOR.light);
  }

  function cycleTheme() {
    var cur = global.NICU.themePref();
    var i = global.NICU.themeNext.indexOf(cur);
    var next = global.NICU.themeNext[(i + 1) % global.NICU.themeNext.length];
    /* (019b) بتفعيل المستخدم: انتقال ناعم — (تُتجاهل داخلياً مع reduced-motion) */
    global.NICU.setThemePrefAnimated(next);
    syncThemeButtons();
    toast('الوضع: ' + THEME_META[next] + (next === 'auto' ? ' (يتبع جهازك)' : ''), 'ok');
  }

  ['#btnTheme', '#btnThemeAuth'].forEach(function (sel) {
    var b = $(sel);
    if (b) b.addEventListener('click', cycleTheme);
  });

  /* التسمية عند الإقلاع + مزامنة تلقائية عند تحول النظام بين الفاتح والداكن */
  syncThemeButtons();
  if (window.matchMedia) {
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeButtons);
    } catch (e) {}
  }

  /* ==================== التشغيل ==================== */
  function start() {
    if (!global.db.isReady()) {
      authScreen.hidden = true;
      app.hidden = false;
      showNetError(
        'لم يتم إعداد الاتصال: راجع رسائل المشاكل أعلاه واعدادات js/config.js، ' +
        'وشغّل ترحيلات قاعدة البيانات بالترتيب (supabase/MIGRATIONS.md).'
      );
      return;
    }

    bindAuth();
    bindNewUserForm();
    bindNewOrgForm();

    global.db.records.subscribe(function () { debouncedRefresh(); });

    global.auth.init()
      .then(function () {
        if (global.auth.session) return enterApp();
        authScreen.hidden = false;
      })
      .catch(function (err) {
        authScreen.hidden = false;
        authMsg(err.message || 'تعذّر الاتصال بالخادم.');
      });

    global.auth.onChange(function (session) {
      if (session) enterApp();
      else leaveApp();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window);
