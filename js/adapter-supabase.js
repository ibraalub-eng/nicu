/* =========================================================
   محول Supabase — تنفيذ عقد طبقة البيانات (db.js)
   =========================================================
   هذا الملف هو "المحول" الوحيد الذي يعرف تفاصيل Supabase:
   إن أردت SQLite أو Firebase أنشئ adapter-sqlite.js /
   adapter-firebase.js بنفس الدوال المسماة أدناه وسجّله في
   DB_ADAPTERS — لا يتغير شيء في app.js أو auth.js.
   العقد الكامل موثق في DATA_LAYER.md.
   ========================================================= */
(function (global) {
  'use strict';

  var cfg = global.NICU_CONFIG || {};

  /* ---------- فحص الإقلاع الخاص بـ Supabase ---------- */
  function checkBoot() {
    if (!global.supabase || typeof global.supabase.createClient !== 'function') {
      return 'مكتبة Supabase غير محمّلة. تأكد من وجود الملف: js/vendor/supabase.min.js';
    }
    var url = String(cfg.SUPABASE_URL || '');
    var key = String(cfg.SUPABASE_ANON_KEY || '');
    if (!url || !key) {
      return 'الإعدادات غير مملؤة. افتح js/config.js وضع رابط المشروع والمفتاح العام.';
    }
    if (/YOUR|your-project|xxxx/i.test(url) || /YOUR|your-anon|xxxx/i.test(key)) {
      return 'الإعدادات ما زالت قيماً تجريبية. افتح js/config.js وضع بيانات مشروعك الحقيقية.';
    }
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)/i.test(url)) {
      return 'رابط المشروع في js/config.js غير صالح. يجب أن يبدأ بـ https://xxx.supabase.co';
    }
    return null;
  }

  /* مخزن الجلسة: localStorage إن تاح، وإلا الذاكرة (file://) */
  function makeStorage() {
    try {
      var probe = '__nicu_probe__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return { store: global.localStorage, kind: 'local' };
    } catch (e) {
      var mem = {};
      return {
        kind: 'memory',
        store: {
          getItem: function (k) {
            return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
          },
          setItem: function (k, v) { mem[k] = String(v); },
          removeItem: function (k) { delete mem[k]; }
        }
      };
    }
  }

  /* =========================================================
     المصنع: ينشئ العميل ويعيد كائن المحول الكامل
     ========================================================= */
  function createAdapter() {

    var problem = checkBoot();
    var storage = makeStorage();
    var isFileProtocol = !!(global.location && global.location.protocol === 'file:');
    var client = problem ? null : global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: storage.store
      }
    });

    var COLUMNS = (global.NICU && global.NICU.COLUMNS) || [];
    var FIELDS = (global.NICU && global.NICU.FIELDS) || [];
    var NUMERIC = { weight: 'weight', gestAge: 'gest_age', treatmentDays: 'treatment_days' };

    /* ---------- أدوات ---------- */
    function unwrap(res) {
      if (res.error) throw new Error(res.error.message);
      return res.data;
    }

    function toPayload(data, userId, isNew) {
      var row = {};
      COLUMNS.forEach(function (c) {
        var v = data[c.field];
        if (c.field === 'seqNo') {
          if (v === '' || v === null) return;
          row[c.db] = Number(v);
          return;
        }
        if (v === '' || v === null) { row[c.db] = null; return; }
        row[c.db] = NUMERIC[c.field] !== undefined ? Number(v) : v;
      });
      if (userId) {
        row.updated_by = userId;
        if (isNew) row.created_by = userId;
      }
      return row;
    }

    function toForm(row) {
      var out = {};
      COLUMNS.forEach(function (c) { out[c.field] = row[c.db] !== null ? row[c.db] : ''; });
      out.id = row.id;
      out.createdBy = row.created_by;
      out.createdAt = row.created_at;
      out.updatedAt = row.updated_at;
      out.approvedAt = row.approved_at;    /* (015) ختم اعتماد المدير */
      out.approvedBy = row.approved_by;
      out.deletedAt = row.deleted_at;      /* (016) ختم الحذف الناعم */
      out.deletedBy = row.deleted_by;
      out.orgId = row.org_id;
      return out;
    }

    var SEARCH_FIELDS = [
      { field: 'childName',  db: 'child_name'  },
      { field: 'motherName', db: 'mother_name' },
      { field: 'fatherName', db: 'father_name' },
      { field: 'childId',    db: 'child_id'    },
      { field: 'motherId',   db: 'mother_id'   },
      { field: 'phone',      db: 'phone'       }
    ];

    function searchVariants(q) {
      var v = [q];
      if (/[اأإآى]/.test(q)) {
        v.push(q.replace(/أ/g, 'ا').replace(/إ/g, 'ا').replace(/آ/g, 'ا').replace(/ى/g, 'ي'));
      }
      if (/ة/.test(q)) v.push(q.replace(/ة/g, 'ه'));
      return v.filter(function (s, i) { return v.indexOf(s) === i; });
    }

    function applyDateRange(query, dateFilter) {
      var f = dateFilter || {};
      var col = f.dateField === 'discharge' ? 'discharge_date' : 'admit_date';
      if (f.from) query = query.gte(col, f.from);
      if (f.to)   query = query.lte(col, f.to);
      return query;
    }

    function applyFilters(query, filters) {
      /* (016) عرض المحذوفات: 'only' = السلة للمدير، غيره يرى غير المحذوف فقط */
      if (filters.deleted === 'only') query = query.not('deleted_at', 'is', null);
      else query = query.is('deleted_at', null);
      /* (016b) «بانتظار الاعتماد فقط» — للمدير */
      if (filters.pending)  query = query.is('approved_at', null);
      if (filters.orgId)   query = query.eq('org_id', filters.orgId);
      if (filters.service) query = query.eq('service', filters.service);
      if (filters.services && filters.services.length) query = query.in('service', filters.services);
      if (filters.month)   query = query.eq('month', filters.month);
      if (filters.mine)    query = query.eq('created_by', filters.userId);
      query = applyDateRange(query, filters.dateFilter);
      var q = String(filters.q || '').trim();
      if (q) {
        var groups = searchVariants(q).map(function (v) {
          return SEARCH_FIELDS.map(function (f) { return f.db + '.ilike."%' + v + '%"'; }).join(',');
        });
        query = query.or(groups.join(','));
      }
      return query;
    }

    function invoke(fn, body) {
      return client.functions.invoke(fn, { body: body }).then(function (res) {
        if (res.error) throw tagged(new Error(adminError(res.error)), 'transport');
        var data = res.data || {};
        if (data.error) throw tagged(new Error(data.error), data.code);
        return data;
      });
    }

    function tagged(err, code) { err.code = code; return err; }

    /* فكّ مُعرّف الجلسة (sid) من التوكن (JWT) — بدون مكتبات خارجية.
       GoTrue الحديث يضع sid في التوكن، وهو مُعرّف الصف في auth.sessions. */
    function jwtSid(jwt) {
      if (!jwt) return null;
      var b64 = String(jwt).split('.')[1];
      if (!b64) return null;
      try {
        var p = JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/')));
        return p.sid || p.session_id || null;
      } catch (e) { return null; }
    }

    function adminError(err) {
      var m = String(err.message || err);
      if (/Functions|not found|404/i.test(m)) {
        return 'خدمة إنشاء الحسابات غير منشورة. نفّذ: supabase functions deploy new-user';
      }
      if (/JWT|session|401|403/i.test(m)) return 'انتهت الجلسة أو الصلاحية. أعد تسجيل الدخول.';
      if (/fetch|network/i.test(m))       return 'تعذّر الاتصال بالخادم.';
      /* (027) FunctionsHttpError: استخرج نص الخطأ العربي من جسم الاستجابة */
      if (err && err.context && typeof err.context.json === 'object') {
        var c = err.context.json;
        if (c && c.error) return c.error;
      }
      if (/non-2xx status code/i.test(m)) {
        return 'رفضت الخدمة العملية (حالة ' + (err && err.context && err.context.status ? err.context.status : 'غير معروفة') +
               '). الأسباب الشائعة: اسم المستخدم مستخدم مسبقاً أو خارج النطاق، أو جلسة منتهية — أعد تسجيل الدخول وحاول مجدداً.';
      }
      return m;
    }

    /* =========================================================
       العقد — الأقسام الخمسة
       ========================================================= */

    /* ---------- 1. auth ---------- */
    var auth = {
      init: function () {
        return client.auth.getSession().then(function (res) {
          return { session: res.data.session };
        });
      },
      login: function (email, password) {
        return client.auth.signInWithPassword({ email: email, password: password })
          .then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return { session: res.data.session };
          });
      },
      /* يعيد { refreshToken, sessionId } — يستخدمه adapter.revokeSession داخلياً.
         sessionId مُعرّف الجلسة في auth.sessions (يُستخرج من sid في التوكن) —
         لأنه الطريقة الموثوقة للتعريف في GoTrue الحديث. */
      logout: function () {
        var s = null, rt = null, sid = null;
        try {
          s = client.auth.session;
          rt = s ? s.refresh_token : null;
          sid = jwtSid(s ? s.access_token : null);
        } catch (e) {}
        /* (036) لا نفشل أبداً: الخروج يجب أن يعمل محلياً حتى لو رفض الخادم
           إبطال الجلسة (403/شبكة) — نلتقط الخطأ ونكمل بالتنظيف المحلي. */
        return client.auth.signOut()
          .catch(function () {})
          .then(function () { return { refreshToken: rt, sessionId: sid }; });
      },
      onChange: function (handler) {
        client.auth.onAuthStateChange(function (event, session) {
          if (event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') return;
          handler(session);
        });
      },
      updatePassword: function (userId, password) {
        return invoke('new-user', { action: 'reset-password', userId: userId, password: password });
      }
    };

    /* ---------- 2. records ---------- */
    var records = {
      page: function (filters, from, limit) {
        var query = client
          .from('records')
          .select('*', { count: 'exact' })
          .order('seq_no', { ascending: true, nullsFirst: false })
          .order('admit_date', { ascending: false })
          .range(from, from + limit - 1);
        query = applyFilters(query, filters);
        return query.then(function (res) {
          if (res.error) throw new Error(res.error.message);
          return { rows: (res.data || []).map(toForm), total: res.count || 0 };
        });
      },
      all: function (filters) {
        var query = client
          .from('records')
          .select('*')
          .order('seq_no', { ascending: true, nullsFirst: false })
          .order('admit_date', { ascending: false });
        query = applyFilters(query, filters);
        return query.then(function (res) { return unwrap(res).map(toForm); });
      },

      findDuplicate: function (data, excludeId) {
        var query = client
          .from('records')
          .select('id, seq_no, child_name, mother_name, admit_date')
          .eq('child_name', data.childName)
          .eq('mother_name', data.motherName)
          .eq('admit_date', data.admitDate)
          .limit(1);
        if (excludeId) query = query.neq('id', excludeId);
        return query.then(function (res) {
          if (res.error) throw new Error(res.error.message);
          return res.data && res.data.length ? res.data[0] : null;
        });
      },

      create: function (data, userId) {
        if (!userId) return Promise.reject(new Error('تعذّر تحديد المستخدم الحالي. أعد تسجيل الدخول.'));
        return client.from('records')
          .insert(toPayload(data, userId, true))
          .select('id').single()
          .then(function (res) { return unwrap(res).id; });
      },

      /* (015-OL) تحديث بقفل تفاؤلي: نمرر updated_at الذي رآه المستخدم،
         ورفض التحديث تلقائياً من القاعدة إذا تغيّر السجل بعدها.
         نتيجة التعارض: صفوف صفرية مع بلا خطأ (Supabase) — نميزها صراحة،
         ونلتقط أيضاً PGRST116 إن صار خطأ single() مستقبلاً. */
      update: function (id, data, userId, expectedUpdatedAt) {
        var query = client.from('records').update(toPayload(data, userId, false));
        if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
        return query
          .eq('id', id)
          .select('updated_at')
          .then(function (res) {
            if (res.error) {
              if (res.error.code === 'PGRST116') {
                var e = new Error('سجل تغيّر أثناء عملك — أعد التحميل.');
                e.code = 'CONFLICT';
                throw e;
              }
              throw new Error(res.error.message);
            }
            if (!res.data || !res.data.length) {
              var c = new Error('سجل تغيّر أثناء عملك — أعد التحميل.');
              c.code = 'CONFLICT';
              throw c;
            }
            return res.data[0].updated_at;
          });
      },

      /* (016) الحذف الناعم عبر RPC — يختم deleted_at ولا يمسح الصف */
      remove: function (id) {
        return client.rpc('soft_delete_record', { rec_id: id }).then(unwrap);
      },

      /* (016) استعادة من السلة — للمدير خلال 30 يوماً */
      restore: function (id) {
        return client.rpc('restore_record', { rec_id: id }).then(unwrap);
      },

      /* (016b) عدد «بانتظار الاعتماد» في منظمة المدير — لشارة الترويسة */
      pendingCount: function () {
        return client.rpc('pending_approve_count').then(unwrap);
      },

      /* (016c) اعتماد كل سجلات «بانتظار الاعتماد» في المنظمة دفعة واحدة —
         يعيد عدد السجلات المُعتمدة (لرسالة التوست) */
      approveAll: function () {
        return client.rpc('admin_approve_all_pending').then(unwrap);
      },

      /* (015) اعتماد السجل — للمدير: بعده لا يعدّله الموظف إطلاقاً */
      approve: function (id) {
        return client.rpc('admin_approve_record', { rec_id: id }).then(unwrap);
      },

      /* (015) إلغاء الاعتماد — للمدير: يفتح التعديل مجدداً */
      unapprove: function (id) {
        return client.rpc('admin_unapprove_record', { rec_id: id }).then(unwrap);
      },

      subscribe: function (onChange) {
        return client
          .channel('records-changes')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'records' }, onChange)
          .subscribe();
      }
    };

    /* ---------- 3. profiles ---------- */
    var profiles = {
      me: function (userId) {
        return client
          .from('profiles')
          .select('id, full_name, email, role, org_id, service_access, services, orgs(name, code)')
          .eq('id', userId).single()
          .then(function (res) {
            if (res.error) {
              return { id: userId, full_name: '', email: '', role: 'staff', org_id: null,
                       service_access: 'all', services: [], orgs: { name: '', code: '' } };
            }
            return res.data;
          });
      },

      list: function (orgId) {
        var query = client
          .from('profiles')
          .select('id, full_name, email, role, org_id, service_access, services, created_at, orgs(name, code)')
          .order('full_name', { ascending: true });
        if (orgId) query = query.eq('org_id', orgId);
        return query.then(unwrap);
      },

      create: function (payload) {
        return invoke('new-user', {
          action: 'create',
          fullName: payload.fullName,
          employeeId: payload.employeeId,
          password: payload.password,
          role: payload.role,
          orgId: payload.orgId || null,
          services: payload.services || []
        });
      },

      setRole: function (targetId, role, services) {
        var svc = (role === 'staff' && Array.isArray(services) && services.length) ? services : null;
        return client.rpc('admin_set_role', {
          target: targetId, new_role: role, new_services: svc
        }).then(unwrap);
      },

      updateName: function (userId, fullName) {
        return client.from('profiles').update({ full_name: fullName }).eq('id', userId).then(unwrap);
      }
    };

    /* ---------- 4. orgs ---------- */
    var orgs = {
      list: function () {
        return client
          .from('orgs')
          .select('id, name, code, logo_url, report_note, required_fields, created_at')
          .order('name', { ascending: true })
          .then(unwrap);
      },

      /* قبل تسجيل الدخول: المنظمات المرشحة لرقم هوية (شاشة الدخول تُكمل الكود
         تلقائياً، وتظهر قائمة إن وُجد أكثر من منظمة لنفس الرقم) */
      resolveForUsername: function (username) {
        return client
          .rpc('resolve_orgs_for_username', { username: String(username || '').trim() })
          .then(unwrap);
      },

      /* إعدادات الحقول الإلزامية/المخفية لكل منظمة (011) */
      saveRequiredFields: function (orgId, fields) {
        return client.rpc('admin_set_required_fields', {
          org: orgId,
          p_fields: fields || {}
        }).then(unwrap);
      },

      requiredFields: function (orgId) {
        return client.rpc('org_required_fields', { org: orgId }).then(unwrap);
      },

      /* «التعديل متاح لكل الموظفين» — إعداد على مستوى المنظمة (013) */
      saveStaffEditAll: function (orgId, all) {
        return client.rpc('admin_set_staff_edit_all', {
          org: orgId,
          p_all: !!all
        }).then(unwrap);
      },

      staffEditAll: function (orgId) {
        return client.rpc('org_staff_edit_all', { org: orgId }).then(unwrap);
      },

      create: function (name, code) {
        return client.rpc('super_create_org', { org_name: name, org_code: code }).then(unwrap);
      },
      saveBranding: function (orgId, logoUrl, reportName, note) {
        return client.rpc('admin_set_report_branding', {
          org: orgId,
          p_logo_url: logoUrl || null,
          p_report_name: reportName || null,
          p_note: note || null
        }).then(unwrap);
      },
      overview: function () {
        return client
          .from('org_overview')
          .select('id, name, code, users_count, records_count, active_count, created_at')
          .order('name', { ascending: true })
          .then(unwrap);
      }
    };

    /* ---------- 5. audit + sessions ---------- */
    var audit = {
      recent: function (limit, orgId) {
        var query = client
          .from('record_audit')
          .select('*')
          .order('at', { ascending: false })
          .limit(limit || 50);
        if (orgId) query = query.eq('org_id', orgId);
        return query.then(unwrap);
      }
    };

    var sessions = {
      list: function (limit, orgId) {
        var query = client
          .from('sessions')
          .select('id, user_id, email, device, ip, created_at, last_seen_at, revoked_at, profiles(full_name)')
          .order('created_at', { ascending: false })
          .limit(limit || 50);
        if (orgId) query = query.eq('org_id', orgId);
        return query.then(unwrap);
      },
      signOutUser: function (sessionId) {
        return invoke('new-user', { action: 'sign-out', sessionId: sessionId });
      },
      signOutUserAll: function (userId) {
        return invoke('new-user', { action: 'sign-out-all', userId: userId });
      }
    };

    /* =========================================================
       الكائن المُعاد — هذا هو العقد
       ========================================================= */
    return {
      name: 'supabase',
      problem: problem ? [problem] : [],
      isFileProtocol: isFileProtocol,
      storageKind: storage.kind,
      COLUMNS: COLUMNS,
      FIELDS: FIELDS,

      isReady: function () { return !problem; },

      auth: auth,
      records: records,
      profiles: profiles,
      orgs: orgs,
      audit: audit,
      sessions: sessions,

      /* محولات أخرى تحقق نفس السلوك: إبطال جلسة في طبقة الجلسات
         لديها (باستخدام refreshToken المعاد من auth.logout) —
         بلا استثناء إن لم يجد الصف. يقبل سلسلة (قديم) أو
         { refreshToken, sessionId } من auth.logout الحديث. */
      revokeSession: function (payload) {
        if (!payload || !client) return Promise.resolve();
        var arg;
        if (typeof payload === 'string') {
          arg = { token: payload };
        } else {
          arg = {
            token: payload.refreshToken || payload.token || '',
            session_id: payload.sessionId || null
          };
        }
        if (!arg.token && !arg.session_id) return Promise.resolve();
        return client.rpc('sessions_revoke', arg).catch(function () {});
      }
    };
  }

  global.DB_ADAPTERS = global.DB_ADAPTERS || {};
  global.DB_ADAPTERS.supabase = createAdapter;
})(window);
