/* km_invest.js — «Изобилие»: бегемотик будит спящие накопления.
 *
 * Триггер — финансовый индекс (тот же, что на шкале «Мотика»). Когда индекс
 * высокий (по умолчанию >= 85), подушка набрана, долги под контролем, а деньги
 * простаивают — Мотик объедается и «чуть не лопается»: SVG-бегемотик раздувается,
 * рядом пузырь и карточка «Твои накопления спят». Карточка и идея во вкладке
 * «Цели» ведут в отдельный раздел «Разбудить деньги» — спокойный ликбез про
 * инфляцию, варианты (вклад → счёт → облигации → фонды → ИИС), наглядную прикидку
 * роста и кнопку, которая РЕАЛЬНО создаёт цель «Инвесткопилка».
 *
 * indexScore() повторяет формулу индекса из бандла (pl()), чтобы порог совпадал
 * со шкалой. Арифметика и публичные действия — в window.KmInvest.
 *
 * Важно: Мотик будит деньги — он не советует конкретный продукт и не обещает
 * доходность. Все проценты в прикидке — иллюстрация, не гарантия.
 */
(function () {
  "use strict";

  var TRIGGER = 85;     // индекс, с которого Мотик начинает будить накопления
  var BURST   = 92;     // индекс «вот-вот лопну»
  var RATE    = 0.10;   // иллюстративная доходность для прикидки (НЕ обещание)
  var INFL    = 0.08;   // иллюстративная инфляция для прикидки потерь

  // ---------- помощники ----------
  function num(x) { var n = Number(x); return isFinite(n) ? n : 0; }
  // значение сессии/записи в хранилище приходит JSON-кодированным (как пишет приложение через fe)
  function parseMaybe(v) { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch (e) { return v; } }
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
  function debtBalance(p) {
    var d = p && p.debts;
    if (Array.isArray(d)) return d.reduce(function (s, x) { return s + num(x && x.balance); }, 0);
    return 0;
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

  // ---------- индекс (копия формулы pl() из бандла) ----------
  function indexScore(profile) {
    var p = profile || {};
    var income = Math.max(num(p.income), 0);
    var mandatory = Math.max(num(p.mandatoryExpenses), 0);
    var payments = Math.max(debtMonthly(p), 0);
    var savings = Math.max(num(p.savings), 0);
    var balance = 0, d = p.debts;
    if (Array.isArray(d)) for (var i = 0; i < d.length; i++) {
      var b = num(d[i] && d[i].balance), mo = num(d[i] && d[i].monthly);
      balance += b > 0 ? b : (mo > 0 ? mo * 18 : 0);     // остаток не указан — оцениваем по платежу
    }
    var obligations = mandatory + payments;                         // обязательные траты + платежи по долгу
    var free = income - obligations;                                // месячный остаток
    var target = p.incomeStability === "unstable" ? 6 : (p.incomeStability === "variable" ? 4 : 3);

    // Устойчивость: денежный поток + запас. Ключевая идея — большой профицит
    // сам по себе защищает, поэтому при доходе, сильно превышающем обязательства,
    // отдельная подушка перестаёт быть обязательной (доход её замещает).
    var margin = income > 0 ? free / income : (free < 0 ? -1 : 0);
    var cashFlow = clamp(margin / 0.25, 0, 1);                      // 0 в ноль, 1 при профиците от 25%
    var cushionMonths = savings / Math.max(obligations, 1);         // на сколько месяцев хватит накоплений
    var cushion = clamp(cushionMonths / target, 0, 1);              // запас относительно цели (3/4/6 мес.)
    var coverage = income / Math.max(obligations, 1);               // во сколько раз доход больше обязательств
    var relief = clamp((coverage - 2) / (12 - 2), 0, 1);            // доход >> трат — подушка уже не нужна
    var buffer = Math.max(cushion, relief);
    var resilience = clamp(0.55 * cashFlow + 0.45 * buffer, 0, 1);

    // Безопасность долга: подъёмность платежей (ПДН) и общая долговая нагрузка.
    var dsr = income > 0 ? payments / income * 100 : (payments > 0 ? 999 : 0);   // ПДН %
    var dti = income > 0 ? balance / (income * 12) : (balance > 0 ? 99 : 0);     // долг / годовой доход
    var payScore = clamp(1 - dsr / 65, 0, 1);
    var levScore = clamp(1 - Math.max(0, dti - 2) / 8, 0, 1);                    // мягко, после 2 годовых доходов
    var debtSafety = 0.65 * payScore + 0.35 * levScore;

    // Итог: ведёт устойчивость, долг весомо влияет. Стабильность дохода и дисциплина
    // трат — мягкие поправки, но они ГАСНУТ по мере роста устойчивости: если человек
    // финансово неуязвим (доход кратно больше обязательств или собрана подушка),
    // эти второстепенные флаги уже не тянут балл вниз. Жизнь «в минус» снижает итог.
    var core = 0.70 * resilience + 0.30 * debtSafety;
    var stabMult = ({ stable: 1, variable: 0.94, unstable: 0.88 }[p.incomeStability]) || 0.94;
    var discMult = 1 - clamp(num(p.impulseLevel) / 3, 0, 1) * 0.12;              // импульсивные траты
    var softMult = stabMult * discMult;
    var effSoft = softMult + (1 - softMult) * resilience;                        // поправки гаснут при высокой устойчивости
    var deficitMult = free >= 0 ? 1 : clamp(1 + free / Math.max(income, 1), 0.4, 1);
    return Math.round(clamp(100 * core * effSoft * deficitMult, 0, 100));
  }

  function metrics(profile) {
    var p = profile || {};
    var income = num(p.income), mandatory = num(p.mandatoryExpenses), credit = debtMonthly(p), savings = num(p.savings);
    var free = income - mandatory - credit;
    var cushion = mandatory > 0 ? Math.min(savings / mandatory, 12) : (savings > 0 ? 12 : 0);
    var pdn = income > 0 ? credit / income * 100 : (credit > 0 ? 999 : 0);
    var target = cushionTarget(p);
    var idleLump = mandatory > 0 ? Math.max(0, savings - target * mandatory) : Math.max(0, savings);
    var monthlyFree = Math.max(0, free);
    var idx = indexScore(p);

    var byFlow = monthlyFree > 0 ? monthlyFree * 0.3 : Infinity;
    var byLump = idleLump > 0 ? idleLump / 12 : Infinity;
    var base = Math.min(byFlow, byLump);
    if (!isFinite(base)) base = monthlyFree * 0.3;
    var suggestMonthly = Math.max(0, Math.round(base / 500) * 500);
    if (suggestMonthly === 0 && monthlyFree > 0) suggestMonthly = Math.max(1000, Math.round(monthlyFree * 0.2 / 500) * 500);

    return {
      index: idx, income: income, mandatory: mandatory, credit: credit, savings: savings,
      free: free, cushion: cushion, pdn: pdn, target: target,
      idleLump: idleLump, monthlyFree: monthlyFree, suggestMonthly: suggestMonthly,
      level: idx >= BURST ? 2 : (idx >= TRIGGER ? 1 : 0)
    };
  }

  // совместимость: level по профилю
  function level(profile) { return metrics(profile).level; }

  // ---------- прикидка роста (иллюстрация, не обещание) ----------
  // Будущая стоимость разовой суммы P через years лет под годовую ставку r.
  function fvLump(P, years, r) { return num(P) * Math.pow(1 + r, years); }
  // Будущая стоимость регулярных взносов C/мес через years лет (помесячная капитализация).
  function fvContrib(C, years, r) {
    C = num(C); if (C <= 0) return 0;
    var i = r / 12, n = years * 12;
    return i === 0 ? C * n : C * (Math.pow(1 + i, n) - 1) / i;
  }
  // Что станет с деньгами: разовый излишек + ежемесячный взнос, по горизонтам.
  function projection(m, horizons) {
    horizons = horizons || [1, 3, 5];
    var lump = num(m && m.idleLump), monthly = num(m && m.suggestMonthly);
    return horizons.map(function (y) {
      var contributed = lump + monthly * 12 * y;
      var grown = fvLump(lump, y, RATE) + fvContrib(monthly, y, RATE);
      return { years: y, contributed: contributed, grown: grown, gain: Math.max(0, grown - contributed) };
    });
  }
  // Сколько разовый излишек тихо теряет к инфляции за год.
  function inflationLoss(m) { return num(m && m.idleLump) * INFL; }

  // ---------- параметры авто-цели «Инвесткопилка» ----------
  function investGoalSpec(m) {
    m = m || {};
    var monthly = num(m.suggestMonthly);
    if (monthly <= 0) monthly = 5000;
    var amount = Math.max(roundTo(monthly * 12, 1000), 12000);  // ~год взносов
    return { title: "Инвесткопилка", amount: amount, months: 12, monthly: monthly };
  }

  window.KmInvest = {
    num: num, money: money, months: months,
    indexScore: indexScore, metrics: metrics, level: level, cushionTarget: cushionTarget,
    projection: projection, inflationLoss: inflationLoss, investGoalSpec: investGoalSpec,
    TRIGGER: TRIGGER, BURST: BURST, RATE: RATE, INFL: INFL
    // openWakeMoney / createInvestGoal добавляются ниже (после DOM-проверки)
  };

  // ===================================================================
  if (typeof document === "undefined" || !document.createElement || !document.body) return;

  var ENTRY_MOTIK = "km-invest-motik";
  var ENTRY_GOALS = "km-invest-goals";
  var ENTRY_CREDIT = "km-invest-credit";
  var ENTRY_HOME = "km-invest-home";
  var SHEET_ID    = "km-wm-sheet";

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function injectStyles() {
    if (document.getElementById("km-invest-styles")) return;
    var css = [
      "@keyframes km-inv-pop{0%,100%{transform:translateY(0) scale(1)}45%{transform:translateY(-2px) scale(1.04)}70%{transform:translateY(0) scale(.985)}}",
      "@keyframes km-inv-zzz{0%{opacity:.25;transform:translateY(2px)}50%{opacity:1;transform:translateY(-2px)}100%{opacity:.25;transform:translateY(2px)}}",
      "@keyframes km-inv-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}",
      // «распирание» самого бегемотика
      "@keyframes km-inv-burst2{0%,100%{transform:scale(1.13) rotate(-1deg)}50%{transform:scale(1.19) rotate(1deg)}}",
      "@keyframes km-inv-burst1{0%,100%{transform:scale(1.07)}50%{transform:scale(1.11)}}",
      ".km-inv-wrap{animation:km-inv-rise .35s ease both;margin-top:10px;display:flex;flex-direction:column;gap:10px}",

      ".km-inv-bubble{position:relative;align-self:center;max-width:300px;background:var(--brand-bg,#E3F5EB);",
      "border:1.5px solid var(--brand,#16A06A);color:var(--brand-d,#0C7C50);border-radius:16px;padding:10px 14px;",
      "font-family:'Nunito',sans-serif;font-weight:800;font-size:13.5px;line-height:1.35;text-align:center;box-shadow:var(--shadow-sm,0 2px 8px rgba(20,48,37,.08))}",
      ".km-inv-bubble.pop{animation:km-inv-pop 2.6s ease-in-out infinite}",
      ".km-inv-bubble:before{content:'';position:absolute;top:-9px;left:50%;transform:translateX(-50%) rotate(45deg);",
      "width:15px;height:15px;background:var(--brand-bg,#E3F5EB);border-left:1.5px solid var(--brand,#16A06A);border-top:1.5px solid var(--brand,#16A06A)}",
      ".km-inv-bubble .em{font-size:16px;margin-right:3px}",

      ".km-inv-card{background:var(--surface,#fff);border:1px solid var(--line,#DCEDE0);border-radius:22px;padding:16px 16px 14px;box-shadow:var(--shadow,0 8px 24px rgba(20,48,37,.10))}",
      ".km-inv-head{display:flex;align-items:center;gap:12px}",
      ".km-inv-icon{flex-shrink:0;width:46px;height:46px;border-radius:14px;background:var(--brand-bg,#E3F5EB);display:flex;align-items:center;justify-content:center}",
      ".km-inv-title{font-family:'Fredoka',sans-serif;font-weight:600;font-size:17px;color:var(--ink,#143025);line-height:1.1}",
      ".km-inv-sub{font-family:'Nunito',sans-serif;font-weight:700;font-size:12.5px;color:var(--muted,#6E8A78);margin-top:2px}",
      ".km-inv-badge{margin-left:auto;flex-shrink:0;font-family:'Nunito',sans-serif;font-weight:800;font-size:11px;padding:5px 10px;border-radius:999px;background:var(--calm-bg,#E3F5EB);color:var(--calm,#16A06A);white-space:nowrap}",

      ".km-inv-stat{margin-top:12px;background:var(--bg,#EAF5EC);border:1px solid var(--line,#DCEDE0);border-radius:14px;padding:11px 13px;display:flex;align-items:baseline;justify-content:space-between;gap:10px}",
      ".km-inv-stat .lab{font-family:'Nunito',sans-serif;font-weight:800;font-size:12.5px;color:var(--muted,#6E8A78)}",
      ".km-inv-stat .val{font-family:'Fredoka',sans-serif;font-weight:600;font-size:18px;color:var(--brand-d,#0C7C50)}",

      ".km-inv-text{font-family:'Nunito',sans-serif;font-weight:600;font-size:13.5px;color:var(--ink,#143025);line-height:1.5;margin:12px 2px 0}",
      ".km-inv-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}",
      ".km-inv-chip{font-family:'Nunito',sans-serif;font-weight:800;font-size:12px;padding:6px 11px;border-radius:999px;background:var(--bg2,#D6EEDC);color:var(--ink,#143025);border:1px solid var(--line,#DCEDE0)}",
      ".km-inv-zzz{display:inline-block;margin-left:1px;color:var(--brand,#16A06A);font-weight:900}",
      ".km-inv-zzz span{display:inline-block;animation:km-inv-zzz 1.8s ease-in-out infinite}",
      ".km-inv-zzz span:nth-child(2){animation-delay:.25s}.km-inv-zzz span:nth-child(3){animation-delay:.5s}",

      ".km-inv-btn{margin-top:14px;width:100%;border:none;border-radius:16px;cursor:pointer;",
      "font-family:'Fredoka',sans-serif;font-weight:600;font-size:15.5px;padding:14px 16px;color:#fff;",
      "background:linear-gradient(135deg,var(--brand,#16A06A),var(--brand-d,#0C7C50));display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 10px 22px -12px rgba(12,124,80,.8)}",
      ".km-inv-btn:active{transform:translateY(1px)}",
      // вторичная кнопка-ссылка (контур)
      ".km-inv-btn2{margin-top:9px;width:100%;border:1.5px solid var(--brand,#16A06A);border-radius:16px;cursor:pointer;background:transparent;",
      "font-family:'Fredoka',sans-serif;font-weight:600;font-size:14.5px;padding:11px 16px;color:var(--brand-d,#0C7C50);display:flex;align-items:center;justify-content:center;gap:7px}",
      ".km-inv-btn2:active{transform:translateY(1px)}",
      ".km-inv-note{font-family:'Nunito',sans-serif;font-weight:700;font-size:11px;color:var(--muted,#6E8A78);line-height:1.45;margin:10px 2px 0;text-align:center}",

      ".km-inv-idea{background:linear-gradient(135deg,var(--brand-bg,#E3F5EB),var(--bg2,#D6EEDC));border:1.5px solid var(--brand,#16A06A);",
      "border-radius:20px;padding:15px 16px;animation:km-inv-rise .35s ease both;margin-bottom:12px}",
      ".km-inv-idea .ttl{display:flex;align-items:center;gap:9px;font-family:'Fredoka',sans-serif;font-weight:600;font-size:16px;color:var(--brand-d,#0C7C50)}",
      ".km-inv-idea .bd{font-family:'Nunito',sans-serif;font-weight:600;font-size:13.5px;color:var(--ink,#143025);line-height:1.5;margin-top:7px}",
      ".km-inv-idea .sug{font-family:'Nunito',sans-serif;font-weight:800;font-size:13px;color:var(--brand-d,#0C7C50);margin-top:8px}",

      // =================== раздел «Разбудить деньги» ===================
      "@keyframes km-wm-fade{from{opacity:0}to{opacity:1}}",
      "@keyframes km-wm-up{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:translateY(0)}}",
      ".km-wm-back{position:fixed;inset:0;z-index:99999;background:rgba(15,42,30,.46);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);animation:km-wm-fade .2s ease both;display:flex;justify-content:center;align-items:flex-end}",
      "@media (min-width:600px){.km-wm-back{align-items:center;padding:20px}}",
      ".km-wm-sheet{position:relative;width:100%;max-width:560px;max-height:94vh;overflow:hidden;display:flex;flex-direction:column;",
      "background:var(--bg,#EAF5EC);border-radius:26px 26px 0 0;box-shadow:0 -18px 50px -20px rgba(12,60,40,.6);animation:km-wm-up .34s cubic-bezier(.2,.7,.2,1) both}",
      "@media (min-width:600px){.km-wm-sheet{border-radius:26px;max-height:90vh}}",
      ".km-wm-grip{position:absolute;top:9px;left:50%;transform:translateX(-50%);width:42px;height:5px;border-radius:99px;background:rgba(20,60,40,.18)}",
      ".km-wm-top{flex-shrink:0;display:flex;align-items:center;gap:11px;padding:20px 18px 13px;background:linear-gradient(180deg,var(--brand-bg,#E3F5EB),rgba(227,245,235,0));}",
      ".km-wm-emoji{flex-shrink:0;width:46px;height:46px;border-radius:15px;background:#fff;display:flex;align-items:center;justify-content:center;font-size:25px;box-shadow:var(--shadow-sm,0 5px 16px -10px rgba(20,60,40,.4))}",
      ".km-wm-h{font-family:'Fredoka',sans-serif;font-weight:600;font-size:21px;color:var(--ink,#143025);line-height:1.05}",
      ".km-wm-hs{font-family:'Nunito',sans-serif;font-weight:700;font-size:12.5px;color:var(--muted,#6E8A78);margin-top:2px}",
      ".km-wm-x{margin-left:auto;flex-shrink:0;width:38px;height:38px;border-radius:12px;border:none;cursor:pointer;background:rgba(20,60,40,.07);color:var(--ink,#143025);font-size:21px;line-height:1;display:flex;align-items:center;justify-content:center}",
      ".km-wm-x:active{transform:translateY(1px)}",
      ".km-wm-body{overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 16px 20px;display:flex;flex-direction:column;gap:13px}",

      ".km-wm-c{background:var(--surface,#fff);border:1px solid var(--line,#DCEDE0);border-radius:20px;padding:15px 15px 14px;box-shadow:var(--shadow,0 8px 24px rgba(20,48,37,.10))}",
      ".km-wm-c.hero{background:linear-gradient(140deg,#fff,var(--brand-bg,#E3F5EB))}",
      ".km-wm-lead{font-family:'Nunito',sans-serif;font-weight:700;font-size:13.5px;color:var(--ink,#143025);line-height:1.5}",
      ".km-wm-lead b{font-weight:900;color:var(--brand-d,#0C7C50)}",
      ".km-wm-kpis{display:flex;gap:10px;margin-top:13px}",
      ".km-wm-kpi{flex:1;background:var(--bg,#EAF5EC);border:1px solid var(--line,#DCEDE0);border-radius:14px;padding:10px 11px;text-align:center}",
      ".km-wm-kpi .l{font-family:'Nunito',sans-serif;font-weight:800;font-size:10.5px;color:var(--muted,#6E8A78);letter-spacing:.02em;line-height:1.2}",
      ".km-wm-kpi .v{font-family:'Fredoka',sans-serif;font-weight:600;font-size:17px;color:var(--brand-d,#0C7C50);margin-top:3px;line-height:1.05}",
      ".km-wm-kpi .v.warn{color:var(--danger,#E5594E)}",

      ".km-wm-sect{font-family:'Fredoka',sans-serif;font-weight:600;font-size:16px;color:var(--ink,#143025);display:flex;align-items:center;gap:8px;margin:3px 2px 0}",
      ".km-wm-p{font-family:'Nunito',sans-serif;font-weight:600;font-size:13px;color:var(--ink,#143025);line-height:1.5;margin:9px 1px 0}",
      ".km-wm-p.muted{color:var(--muted,#6E8A78);font-weight:700}",

      // прикидка роста
      ".km-wm-proj{display:flex;gap:9px;margin-top:13px}",
      ".km-wm-pcard{flex:1;background:linear-gradient(160deg,var(--brand-bg,#E3F5EB),var(--bg2,#D6EEDC));border:1px solid var(--line,#DCEDE0);border-radius:15px;padding:11px 9px;text-align:center}",
      ".km-wm-pcard .yr{font-family:'Nunito',sans-serif;font-weight:900;font-size:11px;color:var(--brand-d,#0C7C50);text-transform:uppercase;letter-spacing:.03em}",
      ".km-wm-pcard .amt{font-family:'Fredoka',sans-serif;font-weight:600;font-size:16px;color:var(--ink,#143025);margin-top:4px;line-height:1.05}",
      ".km-wm-pcard .gain{font-family:'Nunito',sans-serif;font-weight:800;font-size:10.5px;color:var(--calm,#1FB573);margin-top:2px}",

      // лестница вариантов
      ".km-wm-lad{display:flex;flex-direction:column;gap:9px;margin-top:12px}",
      ".km-wm-step{display:flex;gap:11px;align-items:flex-start;background:var(--bg,#EAF5EC);border:1px solid var(--line,#DCEDE0);border-radius:14px;padding:11px 12px}",
      ".km-wm-step .rk{flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:30px;padding-top:1px}",
      ".km-wm-dots{letter-spacing:1px;font-size:10px;line-height:1}",
      ".km-wm-rl{font-family:'Nunito',sans-serif;font-weight:800;font-size:8.5px;color:var(--muted,#6E8A78);text-transform:uppercase;letter-spacing:.02em}",
      ".km-wm-step .nm{font-family:'Fredoka',sans-serif;font-weight:600;font-size:14px;color:var(--ink,#143025);line-height:1.15}",
      ".km-wm-step .ds{font-family:'Nunito',sans-serif;font-weight:600;font-size:12px;color:var(--muted,#6E8A78);line-height:1.4;margin-top:2px}",

      // правила
      ".km-wm-rules{list-style:none;margin:11px 0 0;padding:0;display:flex;flex-direction:column;gap:9px}",
      ".km-wm-rules li{position:relative;padding-left:25px;font-family:'Nunito',sans-serif;font-weight:600;font-size:12.5px;color:var(--ink,#143025);line-height:1.45}",
      ".km-wm-rules li:before{content:'';position:absolute;left:4px;top:6px;width:8px;height:8px;border-radius:99px;background:var(--brand,#16A06A)}",
      ".km-wm-rules li b{font-weight:900;color:var(--brand-d,#0C7C50)}",

      // словарик
      ".km-wm-gl{margin-top:11px;display:flex;flex-direction:column;gap:8px}",
      ".km-wm-gl .row{display:flex;gap:9px;font-family:'Nunito',sans-serif;font-size:12px;line-height:1.4}",
      ".km-wm-gl .t{flex-shrink:0;font-weight:900;color:var(--brand-d,#0C7C50);min-width:96px}",
      ".km-wm-gl .d{font-weight:600;color:var(--ink,#143025)}",

      ".km-wm-cta{position:relative}",
      ".km-wm-foot{font-family:'Nunito',sans-serif;font-weight:700;font-size:11px;color:var(--muted,#6E8A78);line-height:1.45;text-align:center;margin:2px 6px 0}",
      ".km-wm-tag{display:inline-block;font-family:'Nunito',sans-serif;font-weight:800;font-size:10.5px;color:var(--brand-d,#0C7C50);background:var(--brand-bg,#E3F5EB);border:1px solid var(--line,#DCEDE0);border-radius:999px;padding:3px 9px;margin-top:10px}",

      "@media (min-width:600px){.km-inv-bubble{max-width:360px}}",
      "@media (max-width:360px){.km-inv-title{font-size:16px}.km-inv-stat .val{font-size:16px}.km-wm-h{font-size:19px}.km-wm-kpi .v{font-size:15px}.km-wm-pcard .amt{font-size:14px}}"
    ].join("");
    var s = document.createElement("style");
    s.id = "km-invest-styles";
    s.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(s);
  }

  function coinsZzzSvg() {
    return '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0C7C50" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<ellipse cx="9" cy="15" rx="6" ry="2.4"/><path d="M3 15v3c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4v-3"/>' +
      '<path d="M3 12.5c0 1.3 2.7 2.4 6 2.4"/><path d="M14.5 4.5h4l-4 4h4" stroke-width="1.7"/></svg>';
  }

  // ---------- активная вкладка / якоря ----------
  function activeTabText() {
    var on = document.querySelector(".km-tabbar .km-tab.on, .km-tab.on");
    return on ? (on.textContent || "").trim() : "";
  }
  function isMotikTab() {
    if (/Мотик/i.test(activeTabText())) return true;
    var ps = document.querySelectorAll(".km-page p, .km-page .km-muted");
    for (var i = 0; i < ps.length; i++) if (/упитаннее Мотик/i.test(ps[i].textContent || "")) return true;
    return false;
  }
  function isGoalsTab() { return /^Цели$/i.test(activeTabText()); }
  // мы на вкладке «Светофор» (там показан сам индекс)
  function isCreditTab() {
    if (/Светофор/i.test(activeTabText())) return true;
    var hs = document.querySelectorAll("h2.km-display");
    for (var i = 0; i < hs.length; i++) if (/Кредитный светофор/i.test(hs[i].textContent || "")) return true;
    return false;
  }
  // карточка со шкалой индекса (svg-кольцо) — под неё вставляем точку входа
  function creditAnchorCard() {
    var page = document.querySelector(".km-page");
    if (!page) return null;
    var cards = page.querySelectorAll(".km-card");
    for (var i = 0; i < cards.length; i++) {
      var svg = cards[i].querySelector('svg[viewBox="0 0 200 200"]');
      if (svg && svg.querySelector("[stroke-dashoffset],[stroke-dasharray]")) return cards[i];
    }
    return cards.length ? cards[0] : null;
  }

  // мы на вкладке «Главная» (там «Твой диагноз» и сам бегемотик)
  function isHomeTab() {
    if (/Главн/i.test(activeTabText())) return true;
    var hs = document.querySelectorAll("h2.km-display");
    for (var i = 0; i < hs.length; i++) if (/Твой диагноз/i.test(hs[i].textContent || "")) return true;
    return false;
  }
  // якорь на «Главной» — карточка со шкалой индекса (svg-кольцо), советы ставим прямо под ней
  function homeAnchorCard() {
    var page = document.querySelector(".km-page");
    if (!page) return null;
    var cards = page.querySelectorAll(".km-card");
    for (var i = 0; i < cards.length; i++) {
      var svg = cards[i].querySelector('svg[viewBox="0 0 200 200"]');
      if (svg && svg.querySelector("[stroke-dashoffset],[stroke-dasharray]")) return cards[i];
    }
    return null;
  }

  function motikMascotCard() {
    var page = document.querySelector(".km-page");
    if (!page) return null;
    var cards = page.querySelectorAll(".km-card");
    for (var i = 0; i < cards.length; i++) if (cards[i].querySelector('svg[viewBox="0 0 200 200"]')) return cards[i];
    return null;
  }
  // бегемотик = svg без кольца-индикатора (у шкалы есть stroke-dashoffset)
  function hippoSvg(card) {
    if (!card) return null;
    var svgs = card.querySelectorAll("svg");
    for (var i = 0; i < svgs.length; i++) {
      if (!svgs[i].querySelector("[stroke-dashoffset],[stroke-dasharray]")) return svgs[i];
    }
    return svgs.length ? svgs[svgs.length - 1] : null;
  }

  // ---------- «распирание» бегемотика ----------
  var burstEl = null;
  function applyBurst(el, lvl) {
    if (!el) return;
    el.style.transformOrigin = "50% 86%";
    el.style.overflow = "visible";
    el.style.animation = (lvl >= 2 ? "km-inv-burst2 2.4s" : "km-inv-burst1 2.8s") + " ease-in-out infinite";
    if (el.parentElement) el.parentElement.style.overflow = "visible";
    burstEl = el;
  }
  function clearBurst() {
    if (burstEl) {
      try { burstEl.style.animation = ""; burstEl.style.transform = ""; burstEl.style.transformOrigin = ""; } catch (e) {}
    }
    burstEl = null;
  }

  // ---------- карточки на вкладках ----------
  function buildMotik(m) {
    var wrap = document.createElement("div");
    wrap.className = "km-inv-wrap";
    wrap.setAttribute("data-km", ENTRY_MOTIK);
    var burst = m.level >= 2;

    var bubble = burst
      ? '<span class="em">\uD83E\uDEE7</span>Уф, я сейчас лопну! Деньги застоялись \u2014 разбуди их!'
      : '<span class="em">\uD83D\uDE0B</span>Я объелся: деньги копятся без дела \u2014 пора их пристроить.';

    var idleLine = "";
    if (m.idleLump > 0)
      idleLine = '<div class="km-inv-stat"><span class="lab">Лежит без дела сверх подушки</span><span class="val">' + money(m.idleLump) + '</span></div>';
    else if (m.monthlyFree > 0)
      idleLine = '<div class="km-inv-stat"><span class="lab">Свободно каждый месяц</span><span class="val">' + money(m.monthlyFree) + '</span></div>';

    var badge = burst ? "\uD83E\uDEC3 вот-вот лопну" : "\uD83D\uDE0B объелся";

    wrap.innerHTML =
      '<div class="km-inv-bubble' + (burst ? " pop" : "") + '">' + bubble + '</div>' +
      '<div class="km-inv-card">' +
        '<div class="km-inv-head">' +
          '<div class="km-inv-icon">' + coinsZzzSvg() + '</div>' +
          '<div><div class="km-inv-title">Твои накопления спят ' +
            '<span class="km-inv-zzz"><span>z</span><span>z</span><span>z</span></span></div>' +
            '<div class="km-inv-sub">Индекс ' + m.index + '\u00A0\u00B7 подушка ' + months(m.cushion) + '\u00A0мес.</div></div>' +
          '<div class="km-inv-badge">' + badge + '</div>' +
        '</div>' +
        idleLine +
        '<div class="km-inv-text">Деньги, которые просто лежат, тихо тают к инфляции. ' +
          'Вклад, накопительный счёт или фонды дают им работу. Загляни в раздел \u2014 спокойно, по шагам.</div>' +
        '<button class="km-inv-btn" type="button">\uD83E\uDDA6 Разбудить деньги</button>' +
        '<button class="km-inv-btn2" type="button">\u2728 Сразу создать цель «Инвесткопилка»</button>' +
        '<div class="km-inv-note">Мотик будит твои деньги, а не советует конкретный продукт ' +
          'и не обещает доходность. Решение \u2014 за тобой.</div>' +
      '</div>';

    var b1 = wrap.querySelectorAll(".km-inv-btn")[0];
    if (b1) b1.addEventListener("click", function () { openWakeMoney(m); });
    var b2 = wrap.querySelector(".km-inv-btn2");
    if (b2) b2.addEventListener("click", function () { createInvestGoal(m); });
    return wrap;
  }

  function buildGoalsIdea(m) {
    var card = document.createElement("div");
    card.className = "km-inv-idea";
    card.setAttribute("data-km", ENTRY_GOALS);
    var spec = investGoalSpec(m);
    var sug = m.suggestMonthly > 0
      ? "Например, откладывай " + money(m.suggestMonthly) + "/мес в «Инвесткопилку» \u2014 пусть деньги растут, а не спят."
      : "Заведи отдельную цель под вклад или фонды, чтобы излишек не лежал без дела.";
    card.innerHTML =
      '<div class="ttl">\uD83D\uDCB8 Заставь деньги работать</div>' +
      '<div class="bd">Индекс ' + m.index + ' \u2014 финансы в полном порядке, и есть свободные деньги. ' +
        'Самое время для цели, которая не про трату, а про рост.</div>' +
      '<div class="sug">' + sug + '</div>' +
      '<button class="km-inv-btn" type="button" style="margin-top:13px">\u2795 Создать цель «Инвесткопилка»</button>' +
      '<button class="km-inv-btn2" type="button">\uD83E\uDDA6 Как разбудить деньги \u2192</button>';
    var b1 = card.querySelector(".km-inv-btn");
    if (b1) b1.addEventListener("click", function () { createInvestGoal(m); });
    var b2 = card.querySelector(".km-inv-btn2");
    if (b2) b2.addEventListener("click", function () { openWakeMoney(m); });
    return card;
  }

  // точка входа на вкладке «Светофор» — прямо под шкалой индекса
  function buildCredit(m) {
    var card = document.createElement("div");
    card.className = "km-inv-idea";
    card.setAttribute("data-km", ENTRY_CREDIT);
    var burst = m.level >= 2;
    var idle = m.idleLump > 0
      ? "Сейчас сверх подушки без дела лежит " + money(m.idleLump) + "."
      : (m.monthlyFree > 0 ? "Каждый месяц остаётся свободным " + money(m.monthlyFree) + "." : "");
    var head = burst
      ? "Индекс " + m.index + " \u2014 финансы крепкие, подушка есть, а часть денег простаивает. Пора их будить."
      : "Индекс " + m.index + " \u2014 финансы под контролем, подушка собрана. Лишние деньги пока просто лежат.";
    card.innerHTML =
      '<div class="ttl">\uD83E\uDDA6 Финансы в порядке \u2014 разбуди деньги</div>' +
      '<div class="bd">' + head + (idle ? ' ' + idle : '') + '</div>' +
      '<div class="sug">Деньги, которые лежат, тихо тают к инфляции. Вклад, накопительный счёт или фонды дают им работу \u2014 спокойно и по шагам.</div>' +
      '<button class="km-inv-btn" type="button" style="margin-top:13px">\uD83E\uDDA6 Разбудить деньги</button>' +
      '<button class="km-inv-btn2" type="button">\u2728 Создать цель «Инвесткопилка»</button>';
    var b1 = card.querySelector(".km-inv-btn");
    if (b1) b1.addEventListener("click", function () { openWakeMoney(m); });
    var b2c = card.querySelector(".km-inv-btn2");
    if (b2c) b2c.addEventListener("click", function () { createInvestGoal(m); });
    return card;
  }

  // конкретные советы по инвестициям (на основе метрик)
  function investTips(m) {
    var tips = [];
    tips.push("Подушка на месте \u2014 это главное. Дальше излишек можно спокойно пускать в работу.");
    if (m.idleLump > 0)
      tips.push("Без дела лежит " + money(m.idleLump) + " \u2014 за год это около " + money(inflationLoss(m)) +
        " потерь к инфляции. Перенеси их на вклад или накопительный счёт.");
    if (m.suggestMonthly > 0) {
      var p5 = projection(m, [5])[0];
      tips.push("Откладывай " + money(m.suggestMonthly) + "/мес в фонды или ОФЗ \u2014 за 5 лет это \u2248 " +
        money(p5.grown) + " (иллюстрация при ~" + Math.round(RATE * 100) + "%).");
    }
    tips.push("Не клади всё в одно: раскинь по корзинам \u2014 счёт, вклад, ОФЗ, фонды. Больше доходность \u2014 больше риск.");
    return tips.slice(0, 4);
  }

  // блок «бегемотик даёт советы» на «Главной», рядом с диагнозом
  // пузырь над карточкой советов — свой совет почти для каждого индекса
  function homeBubble(m) {
    var idx = m.index, em, flavor;
    if (idx >= 97) { em = "\uD83E\uDEC3"; flavor = "Уф, я аж растолстел! Индекс " + idx + " \u2014 финансы в шоколаде."; }
    else if (idx >= 92) { em = "\uD83E\uDEC3"; flavor = "Индекс " + idx + " \u2014 я вот-вот лопну от сытости, всё под контролем."; }
    else if (idx >= 88) { em = "\uD83D\uDE0B"; flavor = "Индекс " + idx + " \u2014 я сыт и доволен, подушка набрана."; }
    else { em = "\uD83D\uDE0A"; flavor = "Индекс " + idx + " \u2014 дела идут хорошо, появляется излишек."; }
    var tips = [
      "Лишние деньги пора пристроить \u2014 не давай им таять к инфляции.",
      "Самое время заставить излишек работать на тебя.",
      "Перенеси простаивающие деньги на вклад или накопительный счёт.",
      "Раскинь излишек по корзинам: счёт, вклад, ОФЗ, фонды.",
      "Часть свободного можно увести в фонды \u2014 спокойно и по шагам.",
      "Зафиксируй привычку: фикс-сумма с каждой зарплаты в работу.",
      "Подушку не трогаем \u2014 в работу идёт только излишек."
    ];
    var tip = tips[((idx % tips.length) + tips.length) % tips.length];
    return '<span class="em">' + em + '</span>' + flavor + ' ' + tip;
  }

  function buildHome(m) {
    var wrap = document.createElement("div");
    wrap.className = "km-inv-wrap";
    wrap.setAttribute("data-km", ENTRY_HOME);
    var burst = m.level >= 2;
    var bubble = homeBubble(m);
    var tips = investTips(m).map(function (t) { return '<li>' + t + '</li>'; }).join("");
    var badge = burst ? "\uD83E\uDEC3 растолстел" : "\uD83D\uDE0B объелся";
    wrap.innerHTML =
      '<div class="km-inv-bubble' + (burst ? " pop" : "") + '">' + bubble + '</div>' +
      '<div class="km-inv-card">' +
        '<div class="km-inv-head">' +
          '<div class="km-inv-icon">' + coinsZzzSvg() + '</div>' +
          '<div><div class="km-inv-title">Советы Мотика по инвестициям</div>' +
            '<div class="km-inv-sub">Индекс ' + m.index + '\u00A0\u00B7 подушка ' + months(m.cushion) + '\u00A0мес.</div></div>' +
          '<div class="km-inv-badge">' + badge + '</div>' +
        '</div>' +
        '<ul class="km-wm-rules" style="margin-top:13px">' + tips + '</ul>' +
        '<button class="km-inv-btn" type="button">\uD83E\uDDA6 Разбудить деньги</button>' +
        '<button class="km-inv-btn2" type="button">\u2728 Создать цель «Инвесткопилка»</button>' +
        '<div class="km-inv-note">Мотик будит твои деньги, а не советует конкретный продукт ' +
          'и не обещает доходность. Решение \u2014 за тобой.</div>' +
      '</div>';
    var b1 = wrap.querySelector(".km-inv-btn");
    if (b1) b1.addEventListener("click", function () { openWakeMoney(m); });
    var b2 = wrap.querySelector(".km-inv-btn2");
    if (b2) b2.addEventListener("click", function () { createInvestGoal(m); });
    return wrap;
  }
  // =====================================================================
  var prevOverflow = null;
  var keyHandler = null;

  function ladderHtml() {
    var steps = [
      { nm: "Накопительный счёт", risk: 1, rl: "тихо", ds: "Процент каждый месяц, деньги под рукой и их можно снять в любой момент." },
      { nm: "Банковский вклад", risk: 1, rl: "тихо", ds: "Ставка обычно выше счёта, но деньги «заморожены» на срок. С страховкой АСВ." },
      { nm: "Облигации (ОФЗ)", risk: 2, rl: "средне", ds: "Даёшь в долг государству или компании \u2014 платят купоны по графику." },
      { nm: "Фонды (БПИФ/ETF)", risk: 2, rl: "средне", ds: "Одной покупкой берёшь корзину активов \u2014 широкая диверсификация без ручного отбора." },
      { nm: "ИИС", risk: 2, rl: "по составу", ds: "Счёт с налоговыми льготами для длинного горизонта \u2014 риск зависит от того, что внутри." }
    ];
    return steps.map(function (s) {
      var on = s.risk, dots = "";
      for (var i = 0; i < 3; i++) dots += i < on ? "\u25CF" : "\u25CB";
      return '<div class="km-wm-step">' +
        '<div class="rk"><span class="km-wm-dots" style="color:var(--brand,#16A06A)">' + dots + '</span>' +
          '<span class="km-wm-rl">' + s.rl + '</span></div>' +
        '<div><div class="nm">' + esc(s.nm) + '</div><div class="ds">' + s.ds + '</div></div>' +
      '</div>';
    }).join("");
  }

  function projHtml(m) {
    var rows = projection(m, [1, 3, 5]);
    return rows.map(function (r) {
      var yl = r.years === 1 ? "1 год" : (r.years < 5 ? r.years + " года" : r.years + " лет");
      return '<div class="km-wm-pcard"><div class="yr">' + yl + '</div>' +
        '<div class="amt">' + money(r.grown) + '</div>' +
        '<div class="gain">+' + money(r.gain) + '</div></div>';
    }).join("");
  }

  function buildSheet(m) {
    var back = document.createElement("div");
    back.className = "km-wm-back";
    back.id = SHEET_ID;
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    back.setAttribute("aria-label", "Разбудить деньги");

    var spec = investGoalSpec(m);
    var infl = inflationLoss(m);
    var p5 = projection(m, [5])[0];

    // KPI «спит» — разовый излишек или свободно/мес
    var sleeping = m.idleLump > 0
      ? { l: "Лежит без дела", v: money(m.idleLump), warn: false }
      : { l: "Свободно/мес", v: money(m.monthlyFree), warn: false };
    var inflKpi = m.idleLump > 0
      ? { l: "Тает за год", v: "\u2212" + money(infl), warn: true }
      : { l: "В год", v: money(m.suggestMonthly * 12), warn: false };

    var leadTop = m.level >= 2
      ? "Индекс <b>" + m.index + "</b> \u2014 Мотик вот-вот лопнет от сытости. Финансы крепкие, подушка есть, а часть денег простаивает."
      : "Индекс <b>" + m.index + "</b> \u2014 финансы в порядке, подушка собрана. Лишние деньги пока просто лежат.";

    back.innerHTML =
      '<div class="km-wm-sheet">' +
        '<div class="km-wm-grip"></div>' +
        '<div class="km-wm-top">' +
          '<div class="km-wm-emoji">\uD83E\uDDA6</div>' +
          '<div><div class="km-wm-h">Разбудить деньги</div>' +
            '<div class="km-wm-hs">Излишек \u2192 в работу, спокойно и по шагам</div></div>' +
          '<button class="km-wm-x" type="button" aria-label="Закрыть">\u00D7</button>' +
        '</div>' +
        '<div class="km-wm-body">' +

          // hero
          '<div class="km-wm-c hero">' +
            '<div class="km-wm-lead">' + leadTop + '</div>' +
            '<div class="km-wm-kpis">' +
              '<div class="km-wm-kpi"><div class="l">' + sleeping.l + '</div><div class="v">' + sleeping.v + '</div></div>' +
              '<div class="km-wm-kpi"><div class="l">' + inflKpi.l + '</div><div class="v' + (inflKpi.warn ? " warn" : "") + '">' + inflKpi.v + '</div></div>' +
              '<div class="km-wm-kpi"><div class="l">Подушка</div><div class="v">' + months(m.cushion) + '\u00A0мес</div></div>' +
            '</div>' +
            '<div class="km-wm-tag">\uD83D\uDCA1 деньги под подушкой не трогаем \u2014 это безопасность</div>' +
          '</div>' +

          // почему
          '<div class="km-wm-c">' +
            '<div class="km-wm-sect">\uD83D\uDCA4 Почему деньги «спят»</div>' +
            '<div class="km-wm-p">Наличные и остаток на карте не растут, а цены \u2014 да. ' +
              'При инфляции ~' + Math.round(INFL * 100) + '% то, что сегодня стоит 100\u00A0\u20BD, через год будет стоить дороже, ' +
              'а твои деньги останутся теми же. Получается тихий минус каждый год.</div>' +
            (m.idleLump > 0
              ? '<div class="km-wm-p muted">Прикидка: ' + money(m.idleLump) + ' без дела теряют около <b style="color:var(--danger,#E5594E)">' + money(infl) + '</b> покупательной способности за год.</div>'
              : '<div class="km-wm-p muted">Даже небольшой регулярный взнос со временем обгоняет инфляцию \u2014 за счёт сложного процента.</div>') +
          '</div>' +

          // прикидка роста
          '<div class="km-wm-c">' +
            '<div class="km-wm-sect">\uD83C\uDF31 Если деньги работают</div>' +
            '<div class="km-wm-p">Пример: ' +
              (m.idleLump > 0 ? 'разовый излишек ' + money(m.idleLump) + ' плюс ' : '') +
              money(m.suggestMonthly) + '/мес под ~' + Math.round(RATE * 100) + '% годовых. Вот как это могло бы расти:</div>' +
            '<div class="km-wm-proj">' + projHtml(m) + '</div>' +
            '<div class="km-wm-p muted">Цифры \u2014 иллюстрация при ~' + Math.round(RATE * 100) + '% в год, а не обещание. ' +
              'Реальная доходность колеблется и бывает отрицательной. Зелёным \u2014 рост сверх вложенного.</div>' +
          '</div>' +

          // лестница вариантов
          '<div class="km-wm-c">' +
            '<div class="km-wm-sect">\uD83E\uDE9C От тихого к растущему</div>' +
            '<div class="km-wm-p muted">Слева направо растёт и возможная доходность, и риск. ' +
              'Точки \u2014 примерный уровень риска.</div>' +
            '<div class="km-wm-lad">' + ladderHtml() + '</div>' +
          '</div>' +

          // правила
          '<div class="km-wm-c">' +
            '<div class="km-wm-sect">\uD83E\uDDED Несколько правил</div>' +
            '<ul class="km-wm-rules">' +
              '<li><b>Сначала подушка.</b> Инвестируем только то, что не понадобится в ближайшие 1\u20132 года.</li>' +
              '<li><b>Риск = доходность.</b> Больше обещанного процента \u2014 больше шанс потерять. «Без риска и быстро» \u2014 почти всегда обман.</li>' +
              '<li><b>Раскладывай по корзинам.</b> Не вкладывай всё в одно \u2014 диверсификация сглаживает просадки.</li>' +
              '<li><b>Думай вдолгую.</b> Время и регулярность работают лучше попыток угадать момент.</li>' +
            '</ul>' +
          '</div>' +

          // словарик
          '<div class="km-wm-c">' +
            '<div class="km-wm-sect">\uD83D\uDCD6 Коротко о словах</div>' +
            '<div class="km-wm-gl">' +
              '<div class="row"><span class="t">Купон</span><span class="d">регулярная выплата по облигации \u2014 как процент по вкладу.</span></div>' +
              '<div class="row"><span class="t">Диверсификация</span><span class="d">«не класть все яйца в одну корзину» \u2014 разные активы вместе.</span></div>' +
              '<div class="row"><span class="t">Сложный процент</span><span class="d">доход начинает приносить доход \u2014 рост ускоряется со временем.</span></div>' +
              '<div class="row"><span class="t">Ликвидность</span><span class="d">как быстро можно превратить актив обратно в деньги без потерь.</span></div>' +
            '</div>' +
          '</div>' +

          // CTA
          '<div class="km-wm-cta">' +
            '<button class="km-inv-btn" type="button" style="margin-top:0">\u2728 Создать цель «Инвесткопилка»</button>' +
            '<div class="km-wm-foot">Создам цель на ' + money(spec.amount) + ' за ' + spec.months + '\u00A0мес ' +
              '(\u2248 ' + money(spec.monthly) + '/мес). Сумму и срок потом легко поправить. ' +
              'Мотик будит деньги \u2014 не советует продукт и не обещает доход.</div>' +
          '</div>' +

        '</div>' +
      '</div>';

    // обработчики
    var x = back.querySelector(".km-wm-x");
    if (x) x.addEventListener("click", closeWakeMoney);
    back.addEventListener("click", function (e) { if (e.target === back) closeWakeMoney(); });
    var cta = back.querySelector(".km-wm-cta .km-inv-btn");
    if (cta) cta.addEventListener("click", function () { closeWakeMoney(); createInvestGoal(m); });

    return back;
  }

  function openWakeMoney(m) {
    if (document.getElementById(SHEET_ID)) return;
    injectStyles();
    if (!m) { m = cache.profile ? metrics(cache.profile) : metrics({}); }
    var sheet = buildSheet(m);
    document.body.appendChild(sheet);
    try { prevOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; } catch (e) {}
    keyHandler = function (e) { if (e.key === "Escape" || e.keyCode === 27) closeWakeMoney(); };
    document.addEventListener("keydown", keyHandler);
    var x = sheet.querySelector(".km-wm-x");
    if (x) try { x.focus(); } catch (e) {}
  }

  function closeWakeMoney() {
    var n = document.getElementById(SHEET_ID);
    if (n && n.parentNode) n.parentNode.removeChild(n);
    try { document.body.style.overflow = prevOverflow || ""; } catch (e) {}
    if (keyHandler) { document.removeEventListener("keydown", keyHandler); keyHandler = null; }
  }

  // =====================================================================
  // Создание цели «Инвесткопилка» — заполняем форму приложения и сабмитим.
  // Запасной путь: пишем цель прямо в хранилище и перезагружаем страницу.
  // =====================================================================
  function clickTab(re) {
    var tabs = document.querySelectorAll(".km-tabbar .km-tab, .km-tab");
    for (var i = 0; i < tabs.length; i++)
      if (re.test((tabs[i].textContent || "").trim())) { tabs[i].click(); return true; }
    return false;
  }
  function btnByText(re, mustEnabled) {
    var nodes = document.querySelectorAll(".km-page button, button.km-btn, button");
    for (var i = 0; i < nodes.length; i++) {
      var b = nodes[i];
      if (!re.test((b.textContent || "").trim())) continue;
      if (mustEnabled && b.disabled) continue;
      return b;
    }
    return null;
  }
  function setNativeValue(el, value) {
    try {
      var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) { try { el.value = value; } catch (e2) {} }
  }

  var creating = false;
  // Открываем форму создания цели с подсказками — НЕ отправляем автоматически.
  // Сумму и срок пользователь видит и может изменить, затем сам жмёт «Добавить цель».
  function createInvestGoal(m) {
    if (creating) return;
    if (!m) m = cache.profile ? metrics(cache.profile) : metrics({});
    var spec = investGoalSpec(m);
    creating = true;

    var phase = "tab", tries = 0, total = 0;
    var timer = setInterval(function () {
      total++;
      if (total > 80) { clearInterval(timer); creating = false; return; } // ~8с — страховка

      if (phase === "tab") {
        if (!isGoalsTab()) clickTab(/^Цели$/i);
        if (isGoalsTab()) { phase = "open"; tries = 0; }
        else if (++tries > 12) { clearInterval(timer); creating = false; }
        return;
      }

      var titleIn = document.querySelector(".km-page input.km-textin, input.km-textin");
      if (phase === "open") {
        if (titleIn) { phase = "fill"; tries = 0; return; }
        var openBtn = btnByText(/^\+?\s*Цель$/i, false);   // кнопка «Цель» открывает форму
        if (openBtn) openBtn.click();
        if (++tries > 16) { clearInterval(timer); creating = false; } // не открылось — пользователь уже на «Целях», нажмёт «+ Цель» сам
        return;
      }

      if (phase === "fill") {
        if (!titleIn) { if (++tries > 16) { phase = "open"; tries = 0; } return; }
        // подставляем подсказки только в пустые поля; ничего не отправляем
        if (!titleIn.value) setNativeValue(titleIn, spec.title);
        var amtIn = document.querySelector(".km-page .km-inwrap input.km-input, .km-inwrap input.km-input, .km-page input.km-input");
        if (amtIn) {
          var cur = parseInt(String(amtIn.value).replace(/[^\d]/g, ""), 10) || 0;
          if (cur <= 0) setNativeValue(amtIn, spec.amount);
        }
        var rng = document.querySelector('.km-page input[type=range], input[type=range]');
        if (rng && (rng.value === "" || rng.value === rng.getAttribute("value") || rng.value === "6")) setNativeValue(rng, spec.months);
        clearInterval(timer); creating = false;
        toast("Подставил сумму и срок \u2014 поменяй при желании и нажми «Добавить цель»");
        return;
      }
    }, 100);
  }

  // запасной путь: пишем цель прямо в хранилище и перезагружаем
  function fallbackWrite(spec) {
    if (!window.storage) return;
    Promise.resolve()
      .then(function () { return window.storage.get("km:session"); })
      .then(function (sess) {
        var name = sess && parseMaybe(sess.value);
        if (!name) return null;
        return window.storage.get("km:user:" + name).then(function (rec) { return { name: name, rec: rec }; });
      })
      .then(function (ctx) {
        if (!ctx || !ctx.rec || !ctx.rec.value) return;
        var u = parseMaybe(ctx.rec.value);
        if (!u || typeof u !== "object") return;
        if (!Array.isArray(u.goals)) u.goals = [];
        // не плодим дубликаты
        for (var i = 0; i < u.goals.length; i++) {
          if (((u.goals[i] && u.goals[i].title) || "").trim().toLowerCase() === spec.title.toLowerCase()) return;
        }
        u.goals.push({
          id: Math.random().toString(36).slice(2, 9),
          title: spec.title, amount: spec.amount, months: spec.months, saved: 0
        });
        return window.storage.set("km:user:" + ctx.name, JSON.stringify(u)).then(function () {
          toast("Цель «Инвесткопилка» создана \uD83D\uDCB8");
          setTimeout(function () { try { location.reload(); } catch (e) {} }, 350);
        });
      })
      .catch(function () {});
  }

  // лёгкий тост (если в приложении свой — не мешаем, просто всплываем поверх)
  function toast(text) {
    try {
      var t = document.createElement("div");
      t.textContent = text;
      t.style.cssText = "position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:100000;" +
        "background:var(--brand-d,#0C7C50);color:#fff;font-family:'Nunito',sans-serif;font-weight:800;font-size:13.5px;" +
        "padding:11px 16px;border-radius:14px;box-shadow:0 12px 30px -12px rgba(12,60,40,.7);max-width:90%;text-align:center;" +
        "animation:km-wm-up .3s ease both";
      document.body.appendChild(t);
      setTimeout(function () { try { t.style.transition = "opacity .3s"; t.style.opacity = "0"; } catch (e) {} }, 2200);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
    } catch (e) {}
  }

  // экспортируем действия
  window.KmInvest.openWakeMoney = openWakeMoney;
  window.KmInvest.closeWakeMoney = closeWakeMoney;
  window.KmInvest.createInvestGoal = createInvestGoal;

  // ---------- профиль (троттлинг + кэш) ----------
  var cache = { profile: null, at: 0, pending: false };
  function refreshProfile() {
    if (cache.pending || Date.now() - cache.at < 2500) return;
    cache.pending = true;
    Promise.resolve()
      .then(function () { return window.storage.get("km:session"); })
      .then(function (sess) { var name = sess && parseMaybe(sess.value); return name ? window.storage.get("km:user:" + name) : null; })
      .then(function (rec) {
        cache.at = Date.now(); cache.pending = false;
        if (!rec || !rec.value) { cache.profile = null; return; }
        try { var u = parseMaybe(rec.value); cache.profile = (u && u.profile) || null; } catch (e) { cache.profile = null; }
      })
      .catch(function () { cache.pending = false; cache.at = Date.now(); });
  }

  function remove(attr) { var n = document.querySelector('[data-km="' + attr + '"]'); if (n && n.parentNode) n.parentNode.removeChild(n); }

  function sync() {
    if (!window.storage) return;
    injectStyles();
    refreshProfile();

    var p = cache.profile;
    var m = p ? metrics(p) : null;
    var onHome = isHomeTab();
    var fire = m && m.level >= 1;

    // карточку на вкладке «Мотик» больше не показываем; на всякий случай убираем, если осталась от прежней версии
    remove(ENTRY_MOTIK);

    // Главная: карточка советов строго ПОД карточкой диагноза «Что говорит КопиМотик» (и держим её там при ре-рендерах)
    if (onHome && fire) {
      var anchorH = homeAnchorCard();
      if (anchorH) {
        var existsH = document.querySelector('[data-km="' + ENTRY_HOME + '"]');
        if (!existsH || existsH._lvl !== m.level || anchorH.nextSibling !== existsH) {
          remove(ENTRY_HOME);
          var hblock = buildHome(m); hblock._lvl = m.level;
          anchorH.parentNode.insertBefore(hblock, anchorH.nextSibling);
        }
      } else {
        remove(ENTRY_HOME);
      }
    } else {
      remove(ENTRY_HOME);
    }

    // Цели: идея инвест-цели
    if (isGoalsTab() && fire) {
      var page = document.querySelector(".km-page");
      var existsG = document.querySelector('[data-km="' + ENTRY_GOALS + '"]');
      if (page && (!existsG || existsG._lvl !== m.level || !page.contains(existsG))) {
        remove(ENTRY_GOALS);
        var idea = buildGoalsIdea(m); idea._lvl = m.level;
        var first = page.firstElementChild;
        if (first && first.nextElementSibling) page.insertBefore(idea, first.nextElementSibling);
        else page.insertBefore(idea, page.firstChild);
      }
    } else {
      remove(ENTRY_GOALS);
    }

    // «Светофор»: карточку больше не показываем; убираем, если осталась
    remove(ENTRY_CREDIT);
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
