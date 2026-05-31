/* km_debt.js — «Разбор долгов»: советник + калькулятор досрочного погашения.
 *
 * Надстройка в духе km_goals.js / km_moto.js: не трогает бандл, схему и адаптер,
 * читает данные пользователя через window.storage (km:session -> km:user:<логин>).
 * Точка входа — карточка внутри вкладки «Светофор», вшивается в .km-page.
 *
 * Арифметика — в window.KmDebt, DOM-часть включается только в браузере. Долги
 * без остатка (поле необязательное) тоже учитываются: и в нагрузке, и в списке
 * приоритета, и в калькуляторе — остаток можно вписать прямо там.
 */
(function () {
  var root = (typeof window !== "undefined") ? window : (typeof globalThis !== "undefined" ? globalThis : this);

  // ---------------------------------------------------------------- helpers
  function num(v) { var n = +v; return isFinite(n) ? n : 0; }

  // настоящий долг — у которого есть платёж ИЛИ остаток
  function isRealDebt(d) { d = d || {}; return num(d.monthly) > 0 || num(d.balance) > 0; }

  // сумма ежемесячных платежей по долгам (а если их нет — общий creditPayments)
  function debtMonthly(p) {
    p = p || {};
    var list = p.debts || [];
    var s = 0;
    for (var i = 0; i < list.length; i++) s += num(list[i].monthly);
    if (s <= 0) s = num(p.creditPayments); // запасной путь: плоское поле из онбординга
    return s;
  }

  // суммарный ИЗВЕСТНЫЙ остаток по долгам (часть долгов может быть без остатка)
  function totalBalance(p) {
    var list = (p && p.debts) || [];
    var s = 0;
    for (var i = 0; i < list.length; i++) s += num(list[i].balance);
    return s;
  }

  // сколько настоящих долгов
  function debtCount(p) {
    var list = (p && p.debts) || [], c = 0;
    for (var i = 0; i < list.length; i++) if (isRealDebt(list[i])) c++;
    return c;
  }
  // у скольких долгов не задан остаток (а платёж есть)
  function missingBalanceCount(p) {
    var list = (p && p.debts) || [], c = 0;
    for (var i = 0; i < list.length; i++) {
      var d = list[i] || {};
      if (num(d.monthly) > 0 && num(d.balance) <= 0) c++;
    }
    return c;
  }
  // есть ли вообще долги (по платежам, остаткам или плоскому creditPayments)
  function hasDebts(p) { return debtCount(p) > 0 || totalBalance(p) > 0 || debtMonthly(p) > 0; }

  // месячный «расход» (для подушки в месяцах): обязательное + жильё + платежи по долгам
  function monthlyBurn(p) {
    p = p || {};
    var liv = p.living || {};
    return num(p.mandatoryExpenses) + num(liv.rent) + num(liv.food) + num(liv.other) + debtMonthly(p);
  }

  // свободный остаток в месяц = доход − обязательное − жильё − платежи по долгам
  function freeBalance(p) {
    p = p || {};
    var liv = p.living || {};
    return num(p.income) - num(p.mandatoryExpenses) - num(liv.rent) - num(liv.food) - num(liv.other) - debtMonthly(p);
  }

  // сколько месяцев расходов покрывает подушка
  function cushionMonths(p) {
    var burn = monthlyBurn(p);
    if (burn <= 0) return num(p.savings) > 0 ? Infinity : 0;
    return num(p.savings) / burn;
  }

  // целевой размер подушки (мес): нестабильный доход → 6, плавающий → 4, иначе 3
  function cushionTargetMonths(p) {
    var s = p && p.incomeStability;
    if (s === "unstable") return 6;
    if (s === "variable") return 4;
    return 3;
  }

  // деньги «сверх подушки», которые не страшно бросить на досрочку
  function surplusOverCushion(p) {
    var target = cushionTargetMonths(p) * monthlyBurn(p);
    return Math.max(0, num(p.savings) - target);
  }

  // долговая нагрузка (ПДН): доля дохода на платежи по кредитам
  function debtBurden(p) {
    var inc = num(p && p.income);
    if (inc <= 0) return 0;
    return debtMonthly(p) / inc;
  }

  // режим: 'none' (долгов нет), 'pit' (яма), 'normal'
  function situation(p) {
    if (!hasDebts(p)) return "none";
    var pdn = debtBurden(p);
    var cush = cushionMonths(p);
    if (pdn > 0.5 || (pdn > 0.35 && cush < 1)) return "pit";
    return "normal";
  }

  /* Помесячная симуляция аннуитета с возможной доплатой (extra) и разовым
   * платежом сейчас (lump). Возвращает срок в месяцах и переплату %.
   * Без комиссий/страховок — учебная модель. */
  function simulate(balance, annualRatePct, payment, extra, lump) {
    var B = num(balance) - num(lump);
    if (B <= 0) return { months: 0, interest: 0, paid: num(lump), cleared: true };
    var i = num(annualRatePct) / 100 / 12;
    var pay = num(payment) + num(extra);
    if (pay <= 0) return { months: Infinity, interest: Infinity, paid: Infinity, neverPays: true };
    // платёж не покрывает даже проценты → долг не гасится
    if (i > 0 && pay <= B * i) return { months: Infinity, interest: Infinity, paid: Infinity, neverPays: true };
    var interest = 0, months = 0, paid = num(lump);
    while (B > 0 && months < 2400) {
      var it = B * i;
      B += it; interest += it;
      var p = pay > B ? B : pay;
      B -= p; paid += p; months++;
    }
    return { months: months, interest: interest, paid: paid, cleared: B <= 0.0001 };
  }

  // baseline (как сейчас) vs сценарий (с доплатой/разовым)
  function compare(debt, extra, lump, balanceOverride) {
    var bal = (balanceOverride != null && balanceOverride !== "") ? num(balanceOverride) : num(debt.balance);
    var base = simulate(bal, debt.rate, debt.monthly, 0, 0);
    var scen = simulate(bal, debt.rate, debt.monthly, extra, lump);
    return {
      balanceUsed: bal,
      base: base,
      scenario: scen,
      savedMonths: (isFinite(base.months) && isFinite(scen.months)) ? (base.months - scen.months) : Infinity,
      savedInterest: (isFinite(base.interest) && isFinite(scen.interest)) ? (base.interest - scen.interest) : Infinity
    };
  }

  /* Обратная задача: какую доплату/мес нужно делать, чтобы закрыть долг за
   * targetMonths (бинарный поиск). lump — учтённый разовый платёж. */
  function extraForTarget(debt, targetMonths, lump, balanceOverride) {
    targetMonths = Math.max(1, Math.round(targetMonths));
    var bal = (balanceOverride != null && balanceOverride !== "") ? num(balanceOverride) : num(debt.balance);
    var afterLump = bal - num(lump);
    if (afterLump <= 0) return 0;
    // уже укладываемся текущим платежом?
    if (simulate(bal, debt.rate, debt.monthly, 0, lump).months <= targetMonths) return 0;
    var lo = 0, hi = afterLump; // потолок: всё закрыть за месяц
    for (var k = 0; k < 60; k++) {
      var mid = (lo + hi) / 2;
      var m = simulate(bal, debt.rate, debt.monthly, mid, lump).months;
      if (m <= targetMonths) hi = mid; else lo = mid;
    }
    return Math.ceil(hi);
  }

  // сортировки приоритета (учитываем и долги без остатка)
  function order(debts, method) {
    var arr = (debts || []).filter(isRealDebt).slice();
    function hasBal(d) { return num(d.balance) > 0; }
    if (method === "snowball") {
      arr.sort(function (a, b) {
        var ab = hasBal(a), bb = hasBal(b);
        if (ab && bb) return num(a.balance) - num(b.balance); // меньший остаток вперёд
        if (ab !== bb) return ab ? -1 : 1;                    // с известным остатком — выше
        return num(b.monthly) - num(a.monthly);               // иначе по платежу
      });
    } else { // avalanche (по умолчанию): самая дорогая ставка вперёд
      arr.sort(function (a, b) {
        var dr = num(b.rate) - num(a.rate);
        if (dr !== 0) return dr;
        var ab = hasBal(a), bb = hasBal(b);
        if (ab && bb) return num(a.balance) - num(b.balance);
        if (ab !== bb) return ab ? -1 : 1;
        return num(b.monthly) - num(a.monthly);
      });
    }
    return arr;
  }

  root.KmDebt = {
    num: num, isRealDebt: isRealDebt, debtMonthly: debtMonthly, totalBalance: totalBalance,
    debtCount: debtCount, missingBalanceCount: missingBalanceCount, hasDebts: hasDebts,
    monthlyBurn: monthlyBurn, freeBalance: freeBalance, cushionMonths: cushionMonths,
    cushionTargetMonths: cushionTargetMonths, surplusOverCushion: surplusOverCushion,
    debtBurden: debtBurden, situation: situation, simulate: simulate, compare: compare,
    extraForTarget: extraForTarget, order: order
  };

  // ===================================================================== UI
  if (typeof document === "undefined") return;

  var fmtMoney = function (x) {
    if (!isFinite(x)) return "—";
    try { return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(x)) + " \u20BD"; }
    catch (e) { return Math.round(x) + " \u20BD"; }
  };
  var fmtPct = function (x) { return (Math.round(x * 1000) / 10).toString().replace(".", ",") + "%"; };
  function plural(n, one, few, many) {
    n = Math.abs(n) % 100; var n1 = n % 10;
    if (n > 10 && n < 20) return many;
    if (n1 > 1 && n1 < 5) return few;
    if (n1 === 1) return one;
    return many;
  }
  function humanMonths(m) {
    if (!isFinite(m)) return "не закроется при таком платеже";
    if (m <= 0) return "уже закрыт";
    var y = Math.floor(m / 12), mo = m % 12, parts = [];
    if (y) parts.push(y + " " + plural(y, "год", "года", "лет"));
    if (mo) parts.push(mo + " " + plural(mo, "месяц", "месяца", "месяцев"));
    return parts.join(" ") || "меньше месяца";
  }

  // мини-DOM-хелпер
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "style") n.setAttribute("style", attrs[k]);
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k.indexOf("on") === 0 && typeof attrs[k] === "function") n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    if (children != null) {
      if (!Array.isArray(children)) children = [children];
      children.forEach(function (c) {
        if (c == null || c === false) return;
        n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return n;
  }

  // маленькая иконка-гаджет (SVG gauge) под палитру бренда
  function gaugeSvg(size, color) {
    size = size || 22; color = color || "#fff";
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("width", size); s.setAttribute("height", size);
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none");
    s.setAttribute("stroke", color); s.setAttribute("stroke-width", "2.1");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    s.innerHTML = '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>';
    return s;
  }

  // ------- стили (один раз) -------
  function injectStyles() {
    if (document.getElementById("km-debt-styles")) return;
    var css = [
      /* --- точка входа внутри вкладки «Светофор» --- */
      ".km-debt-entry{position:relative;border-radius:24px;padding:2px;",
      "background:linear-gradient(135deg,var(--brand,#16A06A),var(--brand-d,#0C7C50));",
      "box-shadow:0 16px 34px -18px rgba(12,124,80,.6)}",
      ".km-debt-entry-btn{width:100%;display:flex;align-items:center;gap:13px;cursor:pointer;border:none;text-align:left;",
      "font-family:'Nunito',system-ui,sans-serif;border-radius:22px;padding:15px 16px;color:var(--ink,#143025);",
      "background:linear-gradient(135deg,#ffffff,var(--brand-bg,#E3F5EB));}",
      ".km-debt-entry-btn:active{transform:scale(.985)}",
      ".km-debt-entry .ic{flex-shrink:0;width:44px;height:44px;border-radius:14px;display:flex;align-items:center;justify-content:center;",
      "background:linear-gradient(135deg,var(--brand,#16A06A),var(--brand-d,#0C7C50));box-shadow:0 8px 18px -8px rgba(12,124,80,.7)}",
      ".km-debt-entry .tx{flex:1;min-width:0}",
      ".km-debt-entry .tx b{display:block;font-family:'Fredoka',system-ui,sans-serif;font-weight:600;font-size:17px;line-height:1.15}",
      ".km-debt-entry .tx small{display:block;color:var(--muted,#6E8A78);font-weight:700;font-size:12.5px;margin-top:2px;line-height:1.35}",
      ".km-debt-entry .arr{flex-shrink:0;color:var(--brand-d,#0C7C50);font-size:22px;font-weight:900;opacity:.7}",
      ".km-debt-entry .chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}",
      ".km-debt-entry .mini{font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;background:#fff;color:var(--brand-d,#0C7C50);border:1px solid var(--line,#DCEDE0)}",
      ".km-debt-entry .mini.warn{color:var(--tense,#EFA838);border-color:var(--tense,#EFA838)}",
      ".km-debt-entry .mini.pit{color:var(--danger,#E5594E);border-color:var(--danger,#E5594E)}",

      /* --- модалка-шит --- */
      ".km-debt-overlay{position:fixed;inset:0;z-index:9999;display:none;background:rgba(20,48,37,.46);",
      "backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);align-items:flex-end;justify-content:center}",
      ".km-debt-overlay.open{display:flex}",
      ".km-debt-sheet{width:100%;max-width:520px;max-height:94vh;overflow:auto;-webkit-overflow-scrolling:touch;",
      "background:var(--surface,#fff);color:var(--ink,#143025);font-family:'Nunito',system-ui,sans-serif;",
      "border-radius:26px 26px 0 0;padding:16px 16px calc(env(safe-area-inset-bottom,0px) + 22px);",
      "box-shadow:0 -10px 40px -16px rgba(20,60,40,.4);animation:km-debt-up .24s cubic-bezier(.22,1,.36,1)}",
      "@keyframes km-debt-up{from{transform:translateY(28px);opacity:.5}to{transform:none;opacity:1}}",
      ".km-debt-grip{width:42px;height:5px;border-radius:999px;background:var(--line,#DCEDE0);margin:2px auto 12px}",
      ".km-debt-head{display:flex;align-items:center;gap:11px;margin-bottom:4px}",
      ".km-debt-badge{flex-shrink:0;width:42px;height:42px;border-radius:13px;display:flex;align-items:center;justify-content:center;",
      "background:linear-gradient(135deg,var(--brand,#16A06A),var(--brand-d,#0C7C50));box-shadow:0 8px 18px -8px rgba(12,124,80,.7)}",
      ".km-debt-title{flex:1;font-family:'Fredoka',system-ui,sans-serif;font-weight:600;font-size:21px;letter-spacing:-.01em;line-height:1.05}",
      ".km-debt-sub{color:var(--muted,#6E8A78);font-size:13px;margin:4px 0 14px;line-height:1.4;font-weight:600}",
      ".km-debt-x{flex-shrink:0;border:none;background:var(--bg2,#D6EEDC);color:var(--ink,#143025);width:34px;height:34px;border-radius:50%;",
      "font-size:19px;cursor:pointer;line-height:1}",
      ".km-debt-x:active{transform:scale(.92)}",

      ".km-debt-snap{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:12px}",
      ".km-debt-stat{background:var(--bg,#EAF5EC);border:1px solid var(--line,#DCEDE0);border-radius:16px;padding:11px 12px}",
      ".km-debt-stat .l{font-size:11px;color:var(--muted,#6E8A78);font-weight:800;letter-spacing:.01em}",
      ".km-debt-stat .v{font-size:18px;font-weight:900;margin-top:2px;line-height:1.1}",
      ".km-debt-hint{font-size:12px;color:var(--tense,#EFA838);background:var(--tense-bg,#FBF0DA);border:1px solid var(--tense,#EFA838);",
      "border-radius:12px;padding:8px 11px;margin:-3px 0 12px;font-weight:700;line-height:1.4}",

      ".km-debt-banner{border-radius:16px;padding:12px 14px;margin-bottom:13px;font-size:13.5px;line-height:1.45}",
      ".km-debt-banner.pit{background:var(--danger-bg,#FBE5E3);border:1px solid var(--danger,#E5594E)}",
      ".km-debt-banner.ok{background:var(--brand-bg,#E3F5EB);border:1px solid var(--brand,#16A06A)}",
      ".km-debt-banner b{font-weight:900}",
      ".km-debt-banner ul{margin:7px 0 0;padding-left:18px}",
      ".km-debt-banner li{margin:4px 0}",

      ".km-debt-sec{font-family:'Fredoka',system-ui,sans-serif;font-weight:600;font-size:16px;margin:16px 0 8px;display:flex;align-items:center;justify-content:space-between;gap:10px}",
      ".km-debt-toggle{display:inline-flex;background:var(--bg2,#D6EEDC);border-radius:999px;padding:3px;flex-shrink:0}",
      ".km-debt-toggle button{border:none;background:none;font-family:'Nunito',sans-serif;font-weight:800;font-size:12px;padding:6px 12px;",
      "border-radius:999px;cursor:pointer;color:var(--muted,#6E8A78);white-space:nowrap}",
      ".km-debt-toggle button.on{background:var(--surface,#fff);color:var(--brand-d,#0C7C50);box-shadow:0 5px 16px -10px rgba(20,60,40,.5)}",

      ".km-debt-list{display:flex;flex-direction:column;gap:9px}",
      ".km-debt-item{display:flex;align-items:center;gap:11px;background:var(--bg,#EAF5EC);border:1px solid var(--line,#DCEDE0);",
      "border-radius:16px;padding:11px 13px}",
      ".km-debt-item.first{border-color:var(--brand,#16A06A);background:var(--brand-bg,#E3F5EB)}",
      ".km-debt-rank{flex-shrink:0;width:25px;height:25px;border-radius:9px;display:flex;align-items:center;justify-content:center;",
      "font-weight:900;font-size:13px;color:var(--muted,#6E8A78);background:#fff;border:1px solid var(--line,#DCEDE0)}",
      ".km-debt-item.first .km-debt-rank{background:var(--brand,#16A06A);color:#fff;border-color:var(--brand,#16A06A)}",
      ".km-debt-item .nm{font-weight:800;font-size:14px}",
      ".km-debt-item .meta{font-size:12px;color:var(--muted,#6E8A78);margin-top:2px}",
      ".km-debt-item .right{margin-left:auto;text-align:right;flex-shrink:0}",
      ".km-debt-item .right .b{font-weight:900;font-size:14px}",
      ".km-debt-item .right .u{font-size:11px;color:var(--muted,#6E8A78)}",
      ".km-debt-item .right .u.miss{color:var(--tense,#EFA838);font-weight:800}",
      ".km-debt-tag{display:inline-block;font-size:10.5px;font-weight:900;color:var(--brand-d,#0C7C50);background:#fff;",
      "border:1px solid var(--brand,#16A06A);border-radius:999px;padding:2px 8px;margin-top:5px}",

      ".km-debt-calc{background:var(--bg,#EAF5EC);border:1px solid var(--line,#DCEDE0);border-radius:18px;padding:14px;margin-top:8px}",
      ".km-debt-row{margin-bottom:12px}",
      ".km-debt-row:last-child{margin-bottom:0}",
      ".km-debt-row label{display:block;font-size:12px;font-weight:800;color:var(--muted,#6E8A78);margin-bottom:6px}",
      ".km-debt-input,.km-debt-select{width:100%;border:1px solid var(--line,#DCEDE0);border-radius:13px;padding:12px 13px;",
      "font-family:inherit;font-size:16px;font-weight:700;color:var(--ink,#143025);background:#fff;-webkit-appearance:none;appearance:none}",
      ".km-debt-input:focus,.km-debt-select:focus{outline:none;border-color:var(--brand,#16A06A);box-shadow:0 0 0 3px rgba(22,160,106,.14)}",
      ".km-debt-input.need{border-color:var(--tense,#EFA838);box-shadow:0 0 0 3px rgba(239,168,56,.16)}",
      ".km-debt-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}",
      ".km-debt-chip{border:1px solid var(--line,#DCEDE0);background:#fff;border-radius:999px;padding:7px 12px;font-family:inherit;",
      "font-size:12px;font-weight:800;color:var(--brand-d,#0C7C50);cursor:pointer}",
      ".km-debt-chip:active{transform:scale(.95)}",
      ".km-debt-ask{background:var(--tense-bg,#FBF0DA);border:1px solid var(--tense,#EFA838);border-radius:14px;padding:11px 13px;",
      "font-size:13px;font-weight:700;color:#8a5a10;line-height:1.4;margin-top:4px}",

      ".km-debt-result{background:var(--surface,#fff);border:1.5px solid var(--brand,#16A06A);border-radius:16px;padding:14px;margin-top:4px}",
      ".km-debt-result .big{font-size:13px;color:var(--muted,#6E8A78);font-weight:700}",
      ".km-debt-result .big b{display:block;font-family:'Fredoka',sans-serif;font-size:24px;font-weight:600;color:var(--brand-d,#0C7C50);margin-top:2px;line-height:1.05}",
      ".km-debt-result .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}",
      ".km-debt-result .cell .l{font-size:11px;color:var(--muted,#6E8A78);font-weight:800}",
      ".km-debt-result .cell .v{font-size:15px;font-weight:900;margin-top:1px}",
      ".km-debt-result .save{color:var(--brand,#16A06A)}",
      ".km-debt-warn{color:var(--danger,#E5594E);font-weight:800;font-size:13px;margin-top:8px;line-height:1.4}",
      ".km-debt-target{margin-top:12px}",
      ".km-debt-target .ttl{font-size:12px;font-weight:800;color:var(--muted,#6E8A78);margin-bottom:6px}",
      ".km-debt-foot{font-size:11px;color:var(--muted,#6E8A78);margin-top:16px;line-height:1.5}",

      ".km-debt-empty{text-align:center;padding:22px 8px}",
      ".km-debt-empty .em{font-size:42px}",
      ".km-debt-empty .tt{font-family:'Fredoka',sans-serif;font-weight:600;font-size:19px;margin-top:8px}",
      ".km-debt-empty .ds{color:var(--muted,#6E8A78);font-size:13.5px;margin-top:6px;line-height:1.5}",

      /* --- адаптив: на широких экранах — карточка по центру --- */
      "@media (min-width:600px){",
      ".km-debt-overlay{align-items:center;padding:24px}",
      ".km-debt-sheet{border-radius:26px;max-height:88vh;padding:20px 20px 22px}",
      ".km-debt-grip{display:none}",
      "}",
      "@media (max-width:360px){",
      ".km-debt-snap{grid-template-columns:1fr 1fr;gap:7px}",
      ".km-debt-stat .v{font-size:16px}",
      ".km-debt-result .grid{gap:8px}",
      "}"
    ].join("\n");
    var s = el("style", { id: "km-debt-styles" });
    s.appendChild(document.createTextNode(css));
    document.head.appendChild(s);
  }

  // ------- чтение данных текущего пользователя -------
  function parseMaybe(v) { try { return JSON.parse(v); } catch (e) { return v; } }
  async function readData() {
    if (!root.storage) return null;
    try {
      var s = await root.storage.get("km:session");
      if (!s || s.value == null) return null;
      var name = parseMaybe(s.value);
      if (!name) return null;
      var u = await root.storage.get("km:user:" + name);
      if (!u || u.value == null) return null;
      var data = parseMaybe(u.value);
      return { name: name, profile: (data && data.profile) || {} };
    } catch (e) { return null; }
  }

  // ------- состояние модалки -------
  var state = { method: "avalanche", debtId: null, extra: 0, lump: 0, profile: null, balances: {} };

  function statCard(label, value) {
    return el("div", { class: "km-debt-stat" }, [
      el("div", { class: "l" }, label),
      el("div", { class: "v" }, value)
    ]);
  }

  function renderInto(sheet) {
    var p = state.profile || {};
    var debts = order(p.debts, state.method);
    sheet.innerHTML = "";

    // ручка-grip + шапка
    sheet.appendChild(el("div", { class: "km-debt-grip" }));
    sheet.appendChild(el("div", { class: "km-debt-head" }, [
      el("div", { class: "km-debt-badge" }, gaugeSvg(22, "#fff")),
      el("div", { class: "km-debt-title" }, "Разбор долгов"),
      el("button", { class: "km-debt-x", onclick: close }, "\u00D7")
    ]));

    if (!hasDebts(p)) {
      sheet.appendChild(el("div", { class: "km-debt-empty" }, [
        el("div", { class: "em" }, "\uD83C\uDFCD\uFE0F"),
        el("div", { class: "tt" }, "Долгов нет — красота"),
        el("div", { class: "ds" }, "Мотик газует налегке. Если появится кредит или рассрочка — добавь её в «Светофоре», и здесь будет план, как разгрузиться быстрее всего.")
      ]));
      return;
    }

    var pdn = debtBurden(p), cush = cushionMonths(p), surplus = surplusOverCushion(p), sit = situation(p);
    var missing = missingBalanceCount(p);
    sheet.appendChild(el("div", { class: "km-debt-sub" }, "Как быстрее выбраться: с чего гасить, что это даст и сколько вкладывать."));

    // снапшот
    sheet.appendChild(el("div", { class: "km-debt-snap" }, [
      statCard("Всего по долгам", totalBalance(p) > 0 ? fmtMoney(totalBalance(p)) : "не указан"),
      statCard("Платежей в месяц", fmtMoney(debtMonthly(p))),
      statCard("Долговая нагрузка", num(p.income) > 0 ? fmtPct(pdn) + " дохода" : "—"),
      statCard("Подушка", isFinite(cush) ? (Math.round(cush * 10) / 10).toString().replace(".", ",") + " мес" : "есть")
    ]));

    if (missing > 0) {
      sheet.appendChild(el("div", { class: "km-debt-hint" },
        "У " + missing + " " + plural(missing, "долга", "долгов", "долгов") + " не указан остаток — платежи учтены, но чтобы посчитать срок и переплату, впиши остаток в калькуляторе ниже."));
    }

    // баннер режима
    if (sit === "pit") {
      sheet.appendChild(el("div", { class: "km-debt-banner pit" }, [
        el("b", null, "Нагрузка высокая — сначала стабилизируемся."),
        el("ul", null, [
          el("li", null, "Стоп на новые кредиты и рассрочки."),
          el("li", null, "Собери мини-подушку хотя бы на 0,5–1 месяц — чтобы любой сюрприз не загонял в новый долг."),
          el("li", null, "Гаси по очереди самый дорогой долг (см. ниже), остальные — минимальным платежом."),
          el("li", null, "По грабительским ставкам стоит поговорить с банком про рефинанс/реструктуризацию."),
          el("li", null, "Параллельно — урезать расходы или поднять доход; одной досрочкой из глубокой ямы не выгрести.")
        ])
      ]));
    } else {
      var msg = surplus > 0
        ? ["Сверх подушки у тебя ", el("b", null, fmtMoney(surplus)), ". Это можно разово бросить в самый дорогой долг — подставил в калькулятор кнопкой ниже."]
        : ["Подушка прежде всего. Как доберёшь её до нормы — лишнее направляй в досрочку, начиная с самой дорогой ставки."];
      sheet.appendChild(el("div", { class: "km-debt-banner ok" }, msg));
    }

    // приоритет + переключатель метода
    sheet.appendChild(el("div", { class: "km-debt-sec" }, [
      el("span", null, "С чего гасить"),
      el("div", { class: "km-debt-toggle" }, [
        el("button", {
          class: state.method === "avalanche" ? "on" : "",
          onclick: function () { state.method = "avalanche"; renderInto(sheet); }
        }, "Лавина"),
        el("button", {
          class: state.method === "snowball" ? "on" : "",
          onclick: function () { state.method = "snowball"; renderInto(sheet); }
        }, "Снежный ком")
      ])
    ]));
    sheet.appendChild(el("div", { class: "km-debt-sub", style: "margin:-4px 0 8px" },
      state.method === "avalanche"
        ? "Лавина: сначала самая высокая ставка — так меньше всего переплата."
        : "Снежный ком: сначала самый маленький остаток — быстрее закрываешь первый долг и держишь мотивацию."));

    var list = el("div", { class: "km-debt-list" });
    debts.forEach(function (d, idx) {
      var hasBal = num(d.balance) > 0;
      list.appendChild(el("div", { class: "km-debt-item" + (idx === 0 ? " first" : "") }, [
        el("div", { class: "km-debt-rank" }, String(idx + 1)),
        el("div", { style: "min-width:0" }, [
          el("div", { class: "nm" }, d.title || "Кредит"),
          el("div", { class: "meta" }, (num(d.rate) > 0 ? fmtPct(num(d.rate) / 100) + " годовых \u00B7 " : "") + "платёж " + fmtMoney(d.monthly)),
          idx === 0 ? el("div", { class: "km-debt-tag" }, state.method === "avalanche" ? "гасить первым: дороже всего" : "гасить первым: ближе всего к нулю") : null
        ]),
        el("div", { class: "right" }, hasBal
          ? [el("div", { class: "b" }, fmtMoney(d.balance)), el("div", { class: "u" }, "остаток")]
          : [el("div", { class: "b" }, "—"), el("div", { class: "u miss" }, "нет остатка")])
      ]));
    });
    sheet.appendChild(list);

    // ---- калькулятор ----
    sheet.appendChild(el("div", { class: "km-debt-sec" }, "Калькулятор досрочки"));
    if (state.debtId == null || !debts.some(function (d) { return d.id === state.debtId; })) {
      state.debtId = debts[0].id;
    }
    var calc = el("div", { class: "km-debt-calc" });

    // выбор долга
    var sel = el("select", { class: "km-debt-select" });
    debts.forEach(function (d) {
      var label = (d.title || "Кредит") + (num(d.balance) > 0 ? " — " + fmtMoney(d.balance) : " — остаток не указан");
      var o = el("option", { value: d.id }, label);
      if (d.id === state.debtId) o.setAttribute("selected", "selected");
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () { state.debtId = sel.value; renderInto(sheet); });
    calc.appendChild(el("div", { class: "km-debt-row" }, [el("label", null, "Какой долг гасим"), sel]));

    var cur = debts.filter(function (d) { return d.id === state.debtId; })[0] || debts[0];

    // фактический остаток (его можно вписать прямо тут, если в профиле он пустой)
    var balKnown = num(cur.balance) > 0;
    var balVal = (state.balances[cur.id] != null && state.balances[cur.id] !== "")
      ? state.balances[cur.id]
      : (balKnown ? String(num(cur.balance)) : "");
    var balIn = el("input", {
      class: "km-debt-input" + (!balVal ? " need" : ""), type: "number", inputmode: "numeric", min: "0",
      value: balVal, placeholder: balKnown ? "" : "впиши текущий остаток долга"
    });
    balIn.addEventListener("input", function () { state.balances[cur.id] = balIn.value; updateResult(); });
    var balRow = el("div", { class: "km-debt-row" }, [
      el("label", null, balKnown ? "Остаток долга, \u20BD" : "Остаток долга, \u20BD (в профиле не задан)"),
      balIn
    ]);
    calc.appendChild(balRow);

    // доплата в месяц
    var extraIn = el("input", { class: "km-debt-input", type: "number", inputmode: "numeric", min: "0", value: state.extra ? String(state.extra) : "", placeholder: "0" });
    extraIn.addEventListener("input", function () { state.extra = num(extraIn.value); updateResult(); });
    var extraChips = el("div", { class: "km-debt-chips" }, [1000, 3000, 5000, 10000].map(function (v) {
      return el("button", { class: "km-debt-chip", onclick: function () { state.extra = num(state.extra) + v; extraIn.value = state.extra; updateResult(); } }, "+" + fmtMoney(v));
    }).concat([
      el("button", { class: "km-debt-chip", onclick: function () { state.extra = 0; extraIn.value = ""; updateResult(); } }, "сброс")
    ]));
    calc.appendChild(el("div", { class: "km-debt-row" }, [el("label", null, "Доплачиваю сверх платежа, \u20BD/мес"), extraIn, extraChips]));

    // разовый платёж
    var lumpIn = el("input", { class: "km-debt-input", type: "number", inputmode: "numeric", min: "0", value: state.lump ? String(state.lump) : "", placeholder: "0" });
    lumpIn.addEventListener("input", function () { state.lump = num(lumpIn.value); updateResult(); });
    var lumpChipsKids = [];
    if (surplus > 0) lumpChipsKids.push(el("button", { class: "km-debt-chip", onclick: function () { state.lump = Math.round(surplus); lumpIn.value = state.lump; updateResult(); } }, "из профицита " + fmtMoney(surplus)));
    lumpChipsKids.push(el("button", { class: "km-debt-chip", onclick: function () { state.lump = 0; lumpIn.value = ""; updateResult(); } }, "сброс"));
    calc.appendChild(el("div", { class: "km-debt-row" }, [el("label", null, "Разовый платёж сейчас, \u20BD"), lumpIn, el("div", { class: "km-debt-chips" }, lumpChipsKids)]));

    var resultBox = el("div", null);
    calc.appendChild(resultBox);
    sheet.appendChild(calc);

    function effectiveBalance() {
      var ov = state.balances[cur.id];
      return (ov != null && ov !== "") ? num(ov) : num(cur.balance);
    }

    function updateResult() {
      resultBox.innerHTML = "";
      var bal = effectiveBalance();
      balIn.classList.toggle("need", !(bal > 0));

      // остаток не задан — просим вписать, без него срок/переплату не посчитать
      if (!(bal > 0)) {
        resultBox.appendChild(el("div", { class: "km-debt-ask" },
          "Чтобы посчитать срок и переплату по этому долгу, впиши его текущий остаток выше. Платёж в нагрузке уже учтён."));
        return;
      }
      if (!(num(cur.monthly) > 0) && !(num(state.extra) > 0)) {
        resultBox.appendChild(el("div", { class: "km-debt-ask" },
          "У этого долга не задан ежемесячный платёж. Добавь платёж в «Светофоре» или укажи доплату ниже, чтобы посчитать срок."));
        return;
      }

      var c = compare(cur, state.extra, state.lump, bal);
      var box = el("div", { class: "km-debt-result" });
      box.appendChild(el("div", { class: "big" }, [document.createTextNode("Закроешь за"), el("b", null, humanMonths(c.scenario.months))]));

      var grid = el("div", { class: "grid" }, [
        el("div", { class: "cell" }, [el("div", { class: "l" }, "Сейчас закрылся бы за"), el("div", { class: "v" }, humanMonths(c.base.months))]),
        el("div", { class: "cell" }, [el("div", { class: "l" }, "Быстрее на"), el("div", { class: "v save" }, isFinite(c.savedMonths) && c.savedMonths > 0 ? humanMonths(c.savedMonths) : "—")]),
        el("div", { class: "cell" }, [el("div", { class: "l" }, "Переплата сейчас"), el("div", { class: "v" }, fmtMoney(c.base.interest))]),
        el("div", { class: "cell" }, [el("div", { class: "l" }, "Сэкономишь на %"), el("div", { class: "v save" }, isFinite(c.savedInterest) && c.savedInterest > 0 ? fmtMoney(c.savedInterest) : "—")])
      ]);
      box.appendChild(grid);
      if (c.base.neverPays) box.appendChild(el("div", { class: "km-debt-warn" }, "Текущий платёж не покрывает даже проценты — без доплаты долг растёт. Подними платёж или доплачивай."));
      resultBox.appendChild(box);

      // обратная прикидка: доплата под целевой срок
      var tgt = el("div", { class: "km-debt-target" }, [el("div", { class: "ttl" }, "Хочу закрыть быстрее — сколько доплачивать:")]);
      var chips = el("div", { class: "km-debt-chips" }, [12, 24, 36].map(function (mo) {
        var need = extraForTarget(cur, mo, state.lump, bal);
        return el("button", {
          class: "km-debt-chip",
          onclick: function () { state.extra = need; extraIn.value = need || ""; updateResult(); }
        }, "за " + (mo / 12) + " " + plural(mo / 12, "год", "года", "лет") + " \u2192 +" + fmtMoney(need) + "/мес");
      }));
      tgt.appendChild(chips);
      resultBox.appendChild(tgt);
    }
    updateResult();

    sheet.appendChild(el("div", { class: "km-debt-foot" },
      "Учебная прикидка по аннуитету: без комиссий, страховок и плавающих ставок. Это не индивидуальная финансовая рекомендация — по конкретным условиям досрочного погашения уточняй в своём банке."));
  }

  // ------- открыть/закрыть -------
  var overlay, sheet;
  function ensureModal() {
    if (overlay) return;
    overlay = el("div", { class: "km-debt-overlay", onclick: function (e) { if (e.target === overlay) close(); } });
    sheet = el("div", { class: "km-debt-sheet" });
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
  }
  function onKey(e) { if (e.key === "Escape") close(); }
  async function open() {
    injectStyles(); ensureModal();
    sheet.innerHTML = "";
    sheet.appendChild(el("div", { class: "km-debt-grip" }));
    sheet.appendChild(el("div", { class: "km-debt-head" }, [
      el("div", { class: "km-debt-badge" }, gaugeSvg(22, "#fff")),
      el("div", { class: "km-debt-title" }, "Разбор долгов"),
      el("button", { class: "km-debt-x", onclick: close }, "\u00D7")
    ]));
    sheet.appendChild(el("div", { class: "km-debt-sub" }, "Считаю…"));
    overlay.classList.add("open");
    document.addEventListener("keydown", onKey);
    var d = await readData();
    state.profile = d ? d.profile : {};
    state.debtId = null; state.balances = {}; state.extra = 0; state.lump = 0;
    renderInto(sheet);
  }
  function close() { if (overlay) overlay.classList.remove("open"); document.removeEventListener("keydown", onKey); }

  // ====== точка входа во вкладке «Светофор» (а не плавающая кнопка) ======
  var ENTRY_ID = "km-debt-entry";
  var lastEntryRead = 0, cachedProfile = null;

  // мы на вкладке «Светофор», если активная кнопка таб-бара подписана «Светофор»
  function isCreditTab() {
    var on = document.querySelector(".km-tabbar .km-tab.on");
    if (on && /Светофор/.test(on.textContent || "")) return true;
    // запасной путь — по заголовку экрана
    var hs = document.querySelectorAll("h2.km-display");
    for (var i = 0; i < hs.length; i++) if (/Кредитный светофор/.test(hs[i].textContent || "")) return true;
    return false;
  }

  // карточка «Твои текущие кредиты» — вставляем точку входа сразу после неё
  function creditAnchor() {
    var cards = document.querySelectorAll(".km-page .km-card");
    for (var i = 0; i < cards.length; i++) if (/Твои текущие кредиты/.test(cards[i].textContent || "")) return cards[i];
    return null;
  }

  function entrySubtitle(p) {
    if (!p || !hasDebts(p)) return { text: "Долгов нет — но если появится кредит, тут будет план", chips: [] };
    var n = debtCount(p), pdn = debtBurden(p), sit = situation(p), miss = missingBalanceCount(p);
    var text = "План, как закрыть быстрее и меньше переплатить";
    var chips = [];
    chips.push({ t: n + " " + plural(n, "долг", "долга", "долгов"), cls: "" });
    if (num(p.income) > 0) chips.push({ t: "ПДН " + fmtPct(pdn), cls: sit === "pit" ? "pit" : "" });
    if (miss > 0) chips.push({ t: "уточни остаток", cls: "warn" });
    return { text: text, chips: chips };
  }

  function buildEntryNode() {
    var node = el("div", { id: ENTRY_ID, class: "km-debt-entry km-rise" });
    var ic = el("div", { class: "ic" }, gaugeSvg(22, "#fff"));
    var tx = el("div", { class: "tx" }, [
      el("b", null, "Разбор долгов"),
      el("small", { class: "km-debt-entry-sub" }, "Считаю…"),
      el("div", { class: "chips km-debt-entry-chips" })
    ]);
    var btn = el("button", { class: "km-debt-entry-btn", onclick: open }, [ic, tx, el("span", { class: "arr" }, "\u203A")]);
    node.appendChild(btn);
    return node;
  }

  function paintEntry(node, p) {
    var sub = node.querySelector(".km-debt-entry-sub");
    var chipsWrap = node.querySelector(".km-debt-entry-chips");
    if (!sub || !chipsWrap) return;
    var info = entrySubtitle(p);
    sub.textContent = info.text;
    chipsWrap.innerHTML = "";
    info.chips.forEach(function (c) {
      chipsWrap.appendChild(el("span", { class: "mini" + (c.cls ? " " + c.cls : "") }, c.t));
    });
  }

  function placeEntry(node) {
    var anchor = creditAnchor();
    if (anchor && anchor.parentNode) {
      if (anchor.nextSibling !== node) anchor.parentNode.insertBefore(node, anchor.nextSibling);
    } else {
      var page = document.querySelector(".km-page");
      if (page && node.parentNode !== page) page.appendChild(node);
    }
  }

  function refreshEntryData(node) {
    var now = Date.now();
    if (now - lastEntryRead < 2500 && cachedProfile) { paintEntry(node, cachedProfile); return; }
    lastEntryRead = now;
    readData().then(function (d) {
      cachedProfile = d ? d.profile : {};
      var n = document.getElementById(ENTRY_ID);
      if (n) paintEntry(n, cachedProfile);
    });
  }

  function syncEntry() {
    injectStyles();
    var node = document.getElementById(ENTRY_ID);
    if (isCreditTab()) {
      if (!node) { node = buildEntryNode(); paintEntry(node, cachedProfile || {}); }
      placeEntry(node);
      refreshEntryData(node);
    } else if (node && node.parentNode) {
      node.parentNode.removeChild(node);
    }
  }

  // следим за DOM (React перерисовывает .km-page) + лёгкий интервал
  var rafPending = false;
  function scheduleSync() {
    if (rafPending) return;
    rafPending = true;
    (root.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () { rafPending = false; syncEntry(); });
  }
  function start() {
    syncEntry();
    try {
      var mo = new MutationObserver(scheduleSync);
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
    setInterval(syncEntry, 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
