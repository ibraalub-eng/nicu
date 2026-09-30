/* =========================================================
   مساعدات مضمنة سابقاً في index.html — نُقلت لملف خارجي
   ليعمل مع defer (السكربتات المضمّنة لا تقبل defer).
   التنفيذ بعد اكتمال تحليل DOM وبعد سكربتات التطبيق —
   بالترتيب نفسه الذي كانت عليه داخل الصفحة.
   ========================================================= */
(function () {
  'use strict';

  /* ---------- 1. حارس النماذج ----------
     يمنع الإرسال الطبيعي للنموذج (index.html?) إن تعطّل أي JS.
     guard يُنادى فوراً + عند DOMContentLoaded — نفس سلوكه الأصلي. */
  (function () {
    function guard() {
      /* (036) كل النماذج — لا الاستثناءات: أي نموذج يُرسل طبيعياً (تعطّل JS
         أو زر بلا type) ينقل إلى index.html? ويضيع الجلسة. */
      Array.prototype.forEach.call(document.querySelectorAll('form'), function (f) {
        if (!f.__guarded) {
          f.__guarded = true;
          f.addEventListener('submit', function (e) { e.preventDefault(); });
        }
      });
    }
    guard();
    document.addEventListener('DOMContentLoaded', guard);
  })();
})(window);
