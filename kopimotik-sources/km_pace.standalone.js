/* km_pace.js — «Темп целей»: проверка реалистичности целей.
 *
 * Живёт во вкладке «Цели». Берёт профиль и список целей через window.storage,
 * считает свободный остаток в месяц (доход − обязательные − платежи по долгам)
 * и для каждой цели — сколько нужно откладывать в месяц, чтобы успеть в срок,
 * какую долю свободных денег это съедает и реально ли это вообще.
 *
 * Пока подушка не собрана (а отдельной цели на неё нет) — мягко предлагает
 * сделать её целью №1. Это зеркало km_invest, который включается наоборот —
 * когда подушка уже набрана и деньги простаивают.
 *
 * Арифметика — в window.KmPace (metrics).
 */
(function () {
  "use strict";

  // ---------- помощники ----------
  function num(x) { var n = Number(x); return isFinite(n) ? n : 0; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function money(x) {
    var n = Math.round(num(x)), sign = n < 0 ? "-" : ""; n = Math.abs(n);
    return sign + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0") + "\u00A0\u20BD";
  }
  function months(x) { var r = Math.round(num(x) * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); }
  function roundTo(x, step) { return Math.max(0, Math.round(num(x) / step) * step); }

  function debtMonthly(p) {
    var d = p && p.debts;
    if (Array.isArray(d) && d.length) return d.reduce(function (s, x) { return s + num(x && x.monthly); }, 0);
    return num(p && p.creditPayments);
  }
  function cushionTarget(p) {
    try {
      if (window.KmDebt && typeof window.KmDebt.cushionTargetMonths === "function") {
        var t = window.KmDebt.cushionTargetMonths(p);
        if (isFinite(t) && t > 0) return t;
      }
    } catch (e) {}
    var st = p && p.incomeStability;
    if (st === "unstable") return 6;
    if (st === "variable") return 4;
    return 3;
  }

  var CUSHION_RE = /\u043f\u043e\u0434\u0443\u0448|\u0440\u0435\u0437\u0435\u0440\u0432|\u0447[\u0451\u0435]\u0440\u043d|emergenc/i; // подушк|резерв|чёрн|emergency

  // оценка одной цели
  function goalPace(g, free) {
    var target = num(g.amount), saved = num(g.saved);
    var monthsPlan = Math.max(Math.round(num(g.months)) || 6, 1);
    var remaining = Math.max(target - saved, 0);
    var progress = target > 0 ? clamp(saved / target * 100, 0, 100) : 0;
    var rawNeed = remaining > 0 ? remaining / monthsPlan : 0;
    var need = remaining > 0 ? Math.max(roundTo(rawNeed, 100), 100) : 0; // не округляем в ноль
    var share = remaining <= 0 ? 0 : (free > 0 ? need / free : Infinity);

    var key, label;
    if (remaining <= 0) { key = "done"; label = "\u0433\u043e\u0442\u043e\u0432\u043e"; }
    else if (free <= 0) { key = "none"; label = "\u043d\u0435\u0442 \u0441\u0432\u043e\u0431\u043e\u0434\u043d\u044b\u0445"; }
    else if (share <= 0.25) { key = "easy"; label = "\u043b\u0435\u0433\u043a\u043e"; }
    else if (share <= 0.5) { key = "real"; label = "\u0440\u0435\u0430\u043b\u044c\u043d\u043e"; }
    else if (share <= 1) { key = "tight"; label = "\u043d\u0430\u043f\u0440\u044f\u0436\u0451\u043d\u043d\u043e"; }
    else { key = "hard"; label = "\u043d\u0435 \u0442\u044f\u043d\u0435\u0448\u044c"; }

    return {
      title: (g.title || "\u0426\u0435\u043b\u044c"), target: target, saved: saved, remaining: remaining,
      monthsPlan: monthsPlan, need: need, share: share, progress: progress,
      key: key, label: label, isCushion: CUSHION_RE.test(g.title || "")
    };
  }

  function metrics(profile, goals) {
    var p = profile || {};
    var income = num(p.income), mandatory = num(p.mandatoryExpenses), payments = debtMonthly(p), savings = num(p.savings);
    var free = income - mandatory - payments;
    var list = Array.isArray(goals) ? goals : [];
    var active = list.filter(function (g) { return num(g.amount) > 0; });
    var paces = active.map(function (g) { return goalPace(g, free); });
    var open = paces.filter(function (x) { return x.remaining > 0; });
    var totalNeed = open.reduce(function (s, x) { return s + x.need; }, 0);
    var shareAll = free > 0 ? totalNeed / free : (totalNeed > 0 ? Infinity : 0);

    var cushionMonths = mandatory > 0 ? savings / mandatory : (savings > 0 ? 12 : 0);
    var target = cushionTarget(p);
    var hasCushionGoal = active.some(function (g) { return CUSHION_RE.test(g.title || ""); });
    var needCushion = cushionMonths < target * 0.95 && !hasCushionGoal;
    var cushionGap = Math.max(target * mandatory - savings, 0);

    return {
      free: free, income: income, mandatory: mandatory, savings: savings,
      paces: paces, open: open, totalNeed: totalNeed, shareAll: shareAll,
      cushionMonths: cushionMonths, target: target, needCushion: needCushion, cushionGap: cushionGap
    };
  }

  window.KmPace = { num: num, money: money, months: months, goalPace: goalPace, metrics: metrics, cushionTarget: cushionTarget };

  // ===================================================================
  if (typeof document === "undefined" || !document.createElement || !document.body) return;

  var ENTRY = "km-pace";

  function injectStyles() {
    if (document.getElementById("km-pace-styles")) return;
    var css = [
      "@keyframes km-pace-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}",
      ".km-pace-wrap{animation:km-pace-rise .35s ease both;display:flex;flex-direction:column;gap:12px;margin-bottom:12px}",

      ".km-pace-card{background:var(--surface,#fff);border:1px solid var(--line,#DCEDE0);border-radius:22px;padding:16px 16px 14px;box-shadow:var(--shadow,0 8px 24px rgba(20,48,37,.10))}",
      ".km-pace-head{display:flex;align-items:center;gap:10px}",
      ".km-pace-head .em{font-size:20px}",
      ".km-pace-title{font-family:'Fredoka',sans-serif;font-weight:600;font-size:17px;color:var(--ink,#143025);line-height:1.1}",
      ".km-pace-free{margin-left:auto;text-align:right;flex-shrink:0}",
      ".km-pace-free .l{font-family:'Nunito',sans-serif;font-weight:800;font-size:10.5px;color:var(--muted,#6E8A78);letter-spacing:.02em}",
      ".km-pace-free .v{font-family:'Fredoka',sans-serif;font-weight:600;font-size:16px;color:var(--brand-d,#0C7C50);line-height:1.05}",
      ".km-pace-free .v.neg{color:var(--danger,#E5594E)}",

      ".km-pace-goal{margin-top:12px;background:var(--bg,#EAF5EC);border:1px solid var(--line,#DCEDE0);border-radius:16px;padding:11px 13px}",
      ".km-pace-goal .top{display:flex;align-items:center;gap:8px}",
      ".km-pace-goal .nm{font-family:'Fredoka',sans-serif;font-weight:600;font-size:14.5px;color:var(--ink,#143025);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".km-pace-chip{margin-left:auto;flex-shrink:0;font-family:'Nunito',sans-serif;font-weight:800;font-size:11px;padding:4px 9px;border-radius:999px;white-space:nowrap}",
      ".km-pace-chip.easy,.km-pace-chip.real,.km-pace-chip.done{background:var(--brand-bg,#E3F5EB);color:var(--brand,#16A06A)}",
      ".km-pace-chip.tight{background:var(--tense-bg,#FBF0DA);color:#9a6410}",
      ".km-pace-chip.hard,.km-pace-chip.none{background:#FBE6E3;color:var(--danger,#E5594E)}",
      ".km-pace-bar{height:7px;border-radius:99px;background:var(--bg2,#D6EEDC);margin-top:9px;overflow:hidden}",
      ".km-pace-bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--brand,#16A06A),var(--brand-d,#0C7C50))}",
      ".km-pace-meta{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:8px}",
      ".km-pace-meta .need{font-family:'Nunito',sans-serif;font-weight:700;font-size:12.5px;color:var(--ink,#143025)}",
      ".km-pace-meta .need b{font-family:'Fredoka',sans-serif;font-weight:600;color:var(--brand-d,#0C7C50)}",
      ".km-pace-meta .sub{font-family:'Nunito',sans-serif;font-weight:700;font-size:11.5px;color:var(--muted,#6E8A78);text-align:right;flex-shrink:0}",

      ".km-pace-sum{margin-top:13px;padding-top:12px;border-top:1px dashed var(--line,#DCEDE0);font-family:'Nunito',sans-serif;font-weight:700;font-size:12.5px;color:var(--ink,#143025);line-height:1.45}",
      ".km-pace-sum b{font-weight:900;color:var(--brand-d,#0C7C50)}",
      ".km-pace-sum.warn b{color:var(--danger,#E5594E)}",

      ".km-pace-cush{background:linear-gradient(135deg,var(--tense-bg,#FBF0DA),#FCF6E6);border:1.5px solid var(--tense,#EFA838);border-radius:20px;padding:15px 16px;animation:km-pace-rise .35s ease both}",
      ".km-pace-cush .ttl{display:flex;align-items:center;gap:9px;font-family:'Fredoka',sans-serif;font-weight:600;font-size:16px;color:#8a5a10}",
      ".km-pace-cush .bd{font-family:'Nunito',sans-serif;font-weight:600;font-size:13.5px;color:var(--ink,#143025);line-height:1.5;margin-top:7px}",
      ".km-pace-cush .bd b{font-weight:900;color:#8a5a10}",
      ".km-pace-btn{margin-top:13px;width:100%;border:none;border-radius:16px;cursor:pointer;font-family:'Fredoka',sans-serif;font-weight:600;font-size:15px;padding:13px 16px;color:#fff;background:linear-gradient(135deg,#EFA838,#D98E1F);display:flex;align-items:center;justify-content:center;gap:8px}",
      ".km-pace-btn:active{transform:translateY(1px)}",

      "@media (max-width:360px){.km-pace-title{font-size:16px}.km-pace-goal .nm{font-size:13.5px}}"
    ].join("");
    var s = document.createElement("style");
    s.id = "km-pace-styles";
    s.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(s);
  }

  // ---------- активная вкладка ----------
  function activeTabText() {
    var on = document.querySelector(".km-tabbar .km-tab.on, .km-tab.on");
    return on ? (on.textContent || "").trim() : "";
  }
  function isGoalsTab() { return /^\u0426\u0435\u043b\u0438$/i.test(activeTabText()); } // Цели

  // ---------- открыть форму добавления цели (как в km_invest) ----------
  function findByText(selectors, re) {
    for (var s = 0; s < selectors.length; s++) {
      var nodes = document.querySelectorAll(selectors[s]);
      for (var i = 0; i < nodes.length; i++) if (re.test((nodes[i].textContent || "").trim())) return nodes[i];
    }
    return null;
  }
  function setNativeValue(el, value) {
    try {
      var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) { try { el.value = value; } catch (e2) {} }
  }
  function openAddGoal(title) {
    var btn = findByText([".km-btn", "button"], /\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u0446\u0435\u043b\u044c|\u041d\u043e\u0432\u0430\u044f \u0446\u0435\u043b\u044c/i); // Добавить цель|Новая цель
    if (btn) btn.click();
    var tries = 0, timer = setInterval(function () {
      tries++;
      var input = document.querySelector(".km-page input.km-textin, .km-page textarea.km-textin, .km-page input[type=text]");
      if (input) { setNativeValue(input, title); clearInterval(timer); }
      else if (tries > 12) clearInterval(timer);
    }, 60);
  }

  // ---------- сборка карточек ----------
  function buildCushion(m) {
    var card = document.createElement("div");
    card.className = "km-pace-cush";
    var gapLine = m.cushionGap > 0
      ? "\u0421\u0435\u0439\u0447\u0430\u0441 \u043f\u043e\u0434\u0443\u0448\u043a\u0430 \u2014 <b>" + months(m.cushionMonths) + "\u00A0\u043c\u0435\u0441.</b> \u0438\u0437 " + m.target +
        ". \u0427\u0442\u043e\u0431\u044b \u0437\u0430\u043a\u0440\u044b\u0442\u044c \u0446\u0435\u043b\u044c, \u043d\u0443\u0436\u043d\u043e \u0435\u0449\u0451 <b>" + money(m.cushionGap) + "</b>."
      : "\u041f\u043e\u0434\u0443\u0448\u043a\u0430 \u043f\u043e\u043a\u0430 \u043d\u0435 \u0441\u043e\u0431\u0440\u0430\u043d\u0430.";
    card.innerHTML =
      '<div class="ttl">\uD83D\uDEE1\uFE0F \u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u2014 \u043f\u043e\u0434\u0443\u0448\u043a\u0430</div>' +
      '<div class="bd">' + gapLine + ' \u042d\u0442\u043e \u0446\u0435\u043b\u044c \u2116\u00A01: \u043e\u043d\u0430 \u0432\u0430\u0436\u043d\u0435\u0435 \u043e\u0441\u0442\u0430\u043b\u044c\u043d\u044b\u0445, \u043f\u043e\u0442\u043e\u043c\u0443 \u0447\u0442\u043e \u0437\u0430\u0449\u0438\u0449\u0430\u0435\u0442 \u043e\u0442 \u043d\u043e\u0432\u044b\u0445 \u0434\u043e\u043b\u0433\u043e\u0432, \u0435\u0441\u043b\u0438 \u0447\u0442\u043e-\u0442\u043e \u043f\u043e\u0439\u0434\u0451\u0442 \u043d\u0435 \u0442\u0430\u043a.</div>' +
      '<button class="km-pace-btn" type="button">\u2795 \u0421\u0434\u0435\u043b\u0430\u0442\u044c \u043f\u043e\u0434\u0443\u0448\u043a\u0443 \u0446\u0435\u043b\u044c\u044e</button>';
    var btn = card.querySelector(".km-pace-btn");
    if (btn) btn.addEventListener("click", function () { openAddGoal("\u0424\u0438\u043d\u0430\u043d\u0441\u043e\u0432\u0430\u044f \u043f\u043e\u0434\u0443\u0448\u043a\u0430"); });
    return card;
  }

  function buildPace(m) {
    var card = document.createElement("div");
    card.className = "km-pace-card";

    var rows = m.paces.map(function (x) {
      var sub, need;
      if (x.remaining <= 0) {
        need = "\u0426\u0435\u043b\u044c \u0437\u0430\u043a\u0440\u044b\u0442\u0430 \uD83C\uDF89";
        sub = money(x.target);
      } else {
        need = "\u041d\u0430\u0434\u043e <b>" + money(x.need) + "/\u043c\u0435\u0441</b>";
        if (m.free > 0 && isFinite(x.share)) sub = Math.round(x.share * 100) + "% \u0441\u0432\u043e\u0431\u043e\u0434\u043d\u043e\u0433\u043e \u00B7 \u0441\u0440\u043e\u043a " + x.monthsPlan + "\u00A0\u043c\u0435\u0441.";
        else sub = "\u0441\u0440\u043e\u043a " + x.monthsPlan + "\u00A0\u043c\u0435\u0441.";
      }
      return '<div class="km-pace-goal">' +
        '<div class="top"><div class="nm">' + esc(x.title) + '</div>' +
        '<div class="km-pace-chip ' + x.key + '">' + x.label + '</div></div>' +
        '<div class="km-pace-bar"><i style="width:' + Math.max(x.progress, 2) + '%"></i></div>' +
        '<div class="km-pace-meta"><div class="need">' + need + '</div><div class="sub">' + sub + '</div></div>' +
        '</div>';
    }).join("");

    var sumClass = "km-pace-sum", sumText;
    if (m.open.length === 0) {
      sumText = "\u0412\u0441\u0435 \u0446\u0435\u043b\u0438 \u0437\u0430\u043a\u0440\u044b\u0442\u044b \u2014 \u043a\u0440\u0430\u0441\u0430\u0432\u0447\u0438\u043a! \u041c\u043e\u0436\u043d\u043e \u0441\u0442\u0430\u0432\u0438\u0442\u044c \u043d\u043e\u0432\u0443\u044e.";
    } else if (m.free <= 0) {
      sumClass += " warn";
      sumText = "\u0421\u0432\u043e\u0431\u043e\u0434\u043d\u044b\u0445 \u0434\u0435\u043d\u0435\u0433 \u0441\u0435\u0439\u0447\u0430\u0441 \u043d\u0435\u0442 \u2014 \u0446\u0435\u043b\u0438 \u043f\u0440\u0438\u0434\u0451\u0442\u0441\u044f \u043f\u0440\u0438\u0442\u043e\u0440\u043c\u043e\u0437\u0438\u0442\u044c. \u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u043e\u0441\u0432\u043e\u0431\u043e\u0434\u0438 \u043e\u0441\u0442\u0430\u0442\u043e\u043a: \u043c\u0435\u043d\u044c\u0448\u0435 \u0442\u0440\u0430\u0442 \u0438\u043b\u0438 \u043c\u0435\u043d\u044c\u0448\u0435 \u043f\u043b\u0430\u0442\u0435\u0436\u0435\u0439.";
    } else {
      var pct = Math.round(m.shareAll * 100);
      if (m.shareAll <= 1) {
        sumText = "\u041d\u0430 \u0432\u0441\u0435 \u0446\u0435\u043b\u0438 \u043d\u0443\u0436\u043d\u043e <b>" + money(m.totalNeed) + "/\u043c\u0435\u0441</b> \u2014 \u044d\u0442\u043e " + pct +
          "% \u0442\u0432\u043e\u0435\u0433\u043e \u0441\u0432\u043e\u0431\u043e\u0434\u043d\u043e\u0433\u043e \u043e\u0441\u0442\u0430\u0442\u043a\u0430. \u0418\u0434\u0451\u0448\u044c \u0432 \u0433\u0440\u0430\u0444\u0438\u043a\u0435.";
      } else {
        sumClass += " warn";
        sumText = "\u041d\u0430 \u0432\u0441\u0435 \u0446\u0435\u043b\u0438 \u0441\u0440\u0430\u0437\u0443 \u043d\u0443\u0436\u043d\u043e <b>" + money(m.totalNeed) + "/\u043c\u0435\u0441</b>, \u0430 \u0441\u0432\u043e\u0431\u043e\u0434\u043d\u043e \u0442\u043e\u043b\u044c\u043a\u043e " + money(m.free) +
          ". \u041b\u0443\u0447\u0448\u0435 \u0440\u0430\u0441\u0442\u044f\u043d\u0443\u0442\u044c \u0441\u0440\u043e\u043a\u0438 \u0438\u043b\u0438 \u043e\u0441\u0442\u0430\u0432\u0438\u0442\u044c 1\u20132 \u0433\u043b\u0430\u0432\u043d\u044b\u0435 \u0446\u0435\u043b\u0438.";
      }
    }

    card.innerHTML =
      '<div class="km-pace-head"><span class="em">\uD83C\uDFAF</span>' +
        '<div class="km-pace-title">\u0422\u0435\u043c\u043f \u0446\u0435\u043b\u0435\u0439</div>' +
        '<div class="km-pace-free"><div class="l">\u0421\u0412\u041e\u0411\u041e\u0414\u041d\u041e/\u041c\u0415\u0421</div>' +
          '<div class="v' + (m.free < 0 ? " neg" : "") + '">' + money(m.free) + '</div></div>' +
      '</div>' +
      rows +
      '<div class="' + sumClass + '">' + sumText + '</div>';
    return card;
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---------- профиль + цели (троттлинг + кэш) ----------
  var cache = { profile: null, goals: null, at: 0, pending: false };
  function refresh() {
    if (cache.pending || Date.now() - cache.at < 2500) return;
    cache.pending = true;
    Promise.resolve()
      .then(function () { return window.storage.get("km:session"); })
      .then(function (sess) { var name = sess && sess.value; return name ? window.storage.get("km:user:" + name) : null; })
      .then(function (rec) {
        cache.at = Date.now(); cache.pending = false;
        if (!rec || !rec.value) { cache.profile = null; cache.goals = null; return; }
        try { var u = JSON.parse(rec.value); cache.profile = (u && u.profile) || null; cache.goals = (u && u.goals) || []; }
        catch (e) { cache.profile = null; cache.goals = null; }
      })
      .catch(function () { cache.pending = false; cache.at = Date.now(); });
  }

  function remove() { var n = document.querySelector('[data-km="' + ENTRY + '"]'); if (n && n.parentNode) n.parentNode.removeChild(n); }

  function sync() {
    if (!window.storage) return;
    injectStyles();
    refresh();

    if (!isGoalsTab() || !cache.profile) { remove(); return; }

    var m = metrics(cache.profile, cache.goals);
    var hasGoals = m.paces.length > 0;
    if (!hasGoals && !m.needCushion) { remove(); return; }

    // ключ состояния — чтобы перерисовывать только при изменениях
    var sig = JSON.stringify({
      f: Math.round(m.free), n: m.needCushion, g: m.cushionGap,
      p: m.paces.map(function (x) { return [x.title, x.need, x.key, Math.round(x.progress)]; })
    });

    var page = document.querySelector(".km-page");
    if (!page) return;
    var exists = document.querySelector('[data-km="' + ENTRY + '"]');
    if (exists && exists._sig === sig && page.contains(exists)) return;

    remove();
    var wrap = document.createElement("div");
    wrap.className = "km-pace-wrap";
    wrap.setAttribute("data-km", ENTRY);
    wrap._sig = sig;
    if (m.needCushion) wrap.appendChild(buildCushion(m));
    if (hasGoals) wrap.appendChild(buildPace(m));

    // вставляем сразу под первым блоком страницы (как km_invest)
    var first = page.firstElementChild;
    if (first && first.nextElementSibling) page.insertBefore(wrap, first.nextElementSibling);
    else page.insertBefore(wrap, first ? first.nextSibling : page.firstChild);
  }

  function start() {
    injectStyles(); sync();
    var scheduled = false;
    function schedule() {
      if (scheduled) return; scheduled = true;
      (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () { scheduled = false; sync(); });
    }
    try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    setInterval(sync, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
