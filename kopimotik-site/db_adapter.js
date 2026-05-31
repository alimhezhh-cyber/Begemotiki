/* ============================================================
 *  db_adapter.js — мост между состоянием приложения КопиМотик
 *  (объект `data`, как в kopimotik.jsx) и SQL-базой (schema_*).
 *
 *  Работает с любым драйвером, у которого есть:
 *    prepare(sql).get(...p) / .all(...p) / .run(...p)  и  exec(sql)
 *  Подходит: node:sqlite (DatabaseSync), better-sqlite3, sql.js (обёртка).
 *
 *  loadData(db, userId) -> data        // собрать состояние из SQL
 *  saveData(db, data, userId)          // сохранить состояние в SQL
 * ============================================================ */

const uid = () => "id-" + Math.random().toString(36).slice(2, 10);
const levelFromXp = (xp) => Math.floor((xp || 0) / 100) + 1;
const bool = (v) => (v ? 1 : 0);

function loadData(db, userId) {
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  const fp = get("SELECT * FROM financial_profiles WHERE user_id=?", userId) || {};
  const debts = all("SELECT id,title,monthly_payment AS monthly,balance,rate FROM debts WHERE user_id=?", userId);
  const goals = all("SELECT id,title,target_amount AS amount,months,saved FROM goals WHERE user_id=?", userId);
  const plan = get("SELECT * FROM purchase_plans WHERE user_id=? AND is_active=1 ORDER BY created_at DESC LIMIT 1", userId);
  const prog = get("SELECT * FROM user_progress WHERE user_id=?", userId) || {};
  const cos = get("SELECT palette,hat,accessory FROM user_cosmetics WHERE user_id=?", userId) || { palette: "mood", hat: "none", accessory: "none" };
  const st = get("SELECT * FROM user_settings WHERE user_id=?", userId) || {};
  const cks = all("SELECT * FROM checkins WHERE user_id=? ORDER BY check_date", userId);
  const lessons = all("SELECT lesson_id,acked,shown_on FROM user_lessons WHERE user_id=?", userId);
  const chs = all("SELECT challenge_id,progress,claimed,completed_at FROM user_challenges WHERE user_id=?", userId);
  const exp = all("SELECT id,amount,note,category,em,source,created_at AS date FROM expenses WHERE user_id=? ORDER BY created_at", userId);

  const checkins = {}, scores = {};
  for (const c of cks) {
    checkins[c.check_date] = { score: c.score, status: c.status, impulse: c.impulse_level, pdn: c.pdn, free: c.free_balance, cushion: c.cushion_months };
    scores[c.check_date] = c.score;
  }
  const challenges = {};
  for (const c of chs) challenges[c.challenge_id] = { progress: c.progress, claimed: !!c.claimed, completedAt: c.completed_at };

  return {
    profile: {
      income: fp.income || 0, mandatoryExpenses: fp.mandatory_expenses || 0, creditPayments: fp.credit_payments || 0,
      savings: fp.savings || 0, incomeStability: fp.income_stability || "stable", impulseLevel: fp.impulse_level || 0,
      debts, living: { rent: fp.living_rent || 0, food: fp.living_food || 0, other: fp.living_other || 0 },
    },
    plan: plan
      ? { price: plan.price, payment: plan.payment_type, monthlyPayment: plan.monthly_payment, rate: plan.rate, term: plan.term, title: plan.title, on: !!plan.is_active }
      : { price: 0, payment: "credit", monthlyPayment: 0, rate: 0, term: 0, title: "", on: false },
    goals,
    xp: prog.xp || 0, streak: prog.streak || 0, cleanStreak: prog.clean_streak || 0,
    bestCleanStreak: prog.best_clean_streak || 0, lastCheckIn: prog.last_check_in || "",
    checkins, scores,
    cosmetics: { palette: cos.palette, hat: cos.hat, accessory: cos.accessory },
    challenges,
    learn: {
      tips: lessons.map((l) => l.lesson_id),
      acked: lessons.some((l) => l.acked),
      tipDay: lessons.map((l) => l.shown_on).filter(Boolean).sort().pop() || "",
      remindAt: st.money_remind_at || "",
    },
    flags: { onboard: !!st.flag_onboard, checkin: !!st.flag_checkin, purchase: !!st.flag_purchase },
    expenses: exp.map((e) => ({ id: e.id, amount: e.amount, note: e.note, category: e.category, em: e.em, source: e.source, date: e.date })),
    onboarded: !!fp.onboarded,
  };
}

function saveData(db, data, userId) {
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const p = data.profile || {}, c = data.cosmetics || {}, f = data.flags || {}, ln = data.learn || {};
  db.exec("BEGIN");
  try {
    run(`INSERT INTO financial_profiles
         (user_id,income,mandatory_expenses,credit_payments,savings,income_stability,impulse_level,living_rent,living_food,living_other,onboarded)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET income=excluded.income,mandatory_expenses=excluded.mandatory_expenses,
           credit_payments=excluded.credit_payments,savings=excluded.savings,income_stability=excluded.income_stability,
           impulse_level=excluded.impulse_level,living_rent=excluded.living_rent,living_food=excluded.living_food,
           living_other=excluded.living_other,onboarded=excluded.onboarded`,
      userId, p.income || 0, p.mandatoryExpenses || 0, p.creditPayments || 0, p.savings || 0,
      p.incomeStability || "stable", p.impulseLevel || 0,
      (p.living && p.living.rent) || 0, (p.living && p.living.food) || 0, (p.living && p.living.other) || 0, bool(data.onboarded));

    run("DELETE FROM debts WHERE user_id=?", userId);
    for (const d of p.debts || [])
      run("INSERT INTO debts (id,user_id,title,monthly_payment,balance,rate) VALUES (?,?,?,?,?,?)",
        d.id || uid(), userId, d.title || "", d.monthly || 0, d.balance || 0, d.rate || 0);

    run("DELETE FROM goals WHERE user_id=?", userId);
    for (const g of data.goals || [])
      run("INSERT INTO goals (id,user_id,title,target_amount,months,saved,status) VALUES (?,?,?,?,?,?,?)",
        g.id || uid(), userId, g.title || "", g.amount || 0, g.months || 6, g.saved || 0, g.status || "active");

    run("UPDATE purchase_plans SET is_active=0 WHERE user_id=?", userId);
    if (data.plan && data.plan.on)
      run("INSERT INTO purchase_plans (id,user_id,title,price,payment_type,monthly_payment,rate,term,is_active) VALUES (?,?,?,?,?,?,?,?,1)",
        uid(), userId, data.plan.title || "", data.plan.price || 0, data.plan.payment || "credit",
        data.plan.monthlyPayment || 0, data.plan.rate || 0, data.plan.term || 0);

    run(`INSERT INTO user_progress (user_id,xp,level,streak,clean_streak,best_clean_streak,last_check_in)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET xp=excluded.xp,level=excluded.level,streak=excluded.streak,
           clean_streak=excluded.clean_streak,best_clean_streak=excluded.best_clean_streak,last_check_in=excluded.last_check_in`,
      userId, data.xp || 0, levelFromXp(data.xp), data.streak || 0, data.cleanStreak || 0, data.bestCleanStreak || 0, data.lastCheckIn || null);

    run(`INSERT INTO user_cosmetics (user_id,palette,hat,accessory) VALUES (?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET palette=excluded.palette,hat=excluded.hat,accessory=excluded.accessory`,
      userId, c.palette || "mood", c.hat || "none", c.accessory || "none");

    run(`INSERT INTO user_settings (user_id,money_remind_at,flag_onboard,flag_checkin,flag_purchase) VALUES (?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET money_remind_at=excluded.money_remind_at,flag_onboard=excluded.flag_onboard,
           flag_checkin=excluded.flag_checkin,flag_purchase=excluded.flag_purchase`,
      userId, ln.remindAt || null, bool(f.onboard), bool(f.checkin), bool(f.purchase));

    run("DELETE FROM checkins WHERE user_id=?", userId);
    for (const [date, ck] of Object.entries(data.checkins || {}))
      run("INSERT INTO checkins (id,user_id,check_date,score,status,impulse_level,pdn,free_balance,cushion_months) VALUES (?,?,?,?,?,?,?,?,?)",
        uid(), userId, date, ck.score ?? (data.scores && data.scores[date]) ?? null, ck.status || null,
        ck.impulse ?? null, ck.pdn ?? null, ck.free ?? null, ck.cushion ?? null);

    run("DELETE FROM user_lessons WHERE user_id=?", userId);
    for (const t of ln.tips || [])
      run("INSERT INTO user_lessons (user_id,lesson_id,acked,shown_on) VALUES (?,?,?,?)", userId, t, bool(ln.acked), ln.tipDay || null);

    run("DELETE FROM user_challenges WHERE user_id=?", userId);
    for (const [cid, ch] of Object.entries(data.challenges || {}))
      run("INSERT INTO user_challenges (user_id,challenge_id,progress,claimed,completed_at) VALUES (?,?,?,?,?)",
        userId, cid, ch.progress || 0, bool(ch.claimed), ch.completedAt || null);

    run("DELETE FROM expenses WHERE user_id=?", userId);
    for (const e of data.expenses || [])
      run("INSERT INTO expenses (id,user_id,amount,note,category,em,source,created_at) VALUES (?,?,?,?,?,?,?,?)",
        e.id || uid(), userId, e.amount || 0, e.note || "", e.category || "", e.em || "", e.source || "text", e.date || new Date().toISOString());

    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

module.exports = { loadData, saveData, levelFromXp, uid };
