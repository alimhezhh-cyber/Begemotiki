#!/usr/bin/env node
/* server.js — КопиМотик на сервере.
 *
 * Раздаёт само приложение (public/index.html) и предоставляет маленький
 * REST API для window.storage, который пишет в РЕАЛЬНУЮ базу SQLite через
 * db_adapter.js. Несколько человек могут заходить по сети — у каждого свой
 * аккаунт и свои данные, всё хранится в одном файле kopimotik.sqlite.
 *
 * Зависимостей нет: используется встроенный node:sqlite (Node >= 22.5).
 * Если установлен better-sqlite3 — он будет использован автоматически
 * (быстрее и без пометки "experimental"), но это НЕ обязательно.
 *
 * Запуск:   node server.js
 * Порт:     PORT=8080 node server.js        (по умолчанию 3000)
 * Файл БД:  KM_DB=/путь/к/база.sqlite node server.js
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const adapter = require("./db_adapter.js"); // { loadData, saveData, levelFromXp, uid }

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.KM_DB || path.join(__dirname, "kopimotik.sqlite");
const PUBLIC = path.join(__dirname, "public");
const SCHEMA = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

// ---------- открываем БД: better-sqlite3, иначе встроенный node:sqlite ----------
let db, driver;
try {
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
  driver = "better-sqlite3";
} catch (e) {
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(DB_PATH);
  driver = "node:sqlite";
}
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(SCHEMA); // схема идемпотентна (IF NOT EXISTS) — создаст таблицы при первом запуске

// ---------- хранилище ключей ----------
const USER_RE = /^km:user:(.+)$/;
const dbUserId = (u) => "u_" + u;

const kvGetStmt = db.prepare("SELECT value FROM app_kv WHERE key=?");
const kvSetStmt = db.prepare(
  "INSERT INTO app_kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
);
const kvDelStmt = db.prepare("DELETE FROM app_kv WHERE key=?");
const kvKeysStmt = db.prepare("SELECT key FROM app_kv");
const usersStmt = db.prepare("SELECT user_id FROM financial_profiles");

function kvGet(key) {
  const m = key.match(USER_RE);
  if (m) return JSON.stringify(adapter.loadData(db, dbUserId(m[1]))); // данные пользователя из таблиц
  const row = kvGetStmt.get(key);
  return row ? row.value : null;
}

function kvSet(key, value) {
  const m = key.match(USER_RE);
  if (m) { adapter.saveData(db, JSON.parse(value), dbUserId(m[1])); return; }
  if (key === "km:users") {
    // список аккаунтов общий: МЕРЖИМ, чтобы одновременные регистрации не затирали друг друга
    let cur = {}; try { const r = kvGetStmt.get(key); if (r) cur = JSON.parse(r.value) || {}; } catch (_) {}
    let inc = {}; try { inc = JSON.parse(value) || {}; } catch (_) {}
    kvSetStmt.run(key, JSON.stringify(Object.assign(cur, inc)));
    return;
  }
  kvSetStmt.run(key, value);
}

function kvList(prefix) {
  const keys = [];
  for (const r of kvKeysStmt.all()) keys.push(r.key);
  for (const r of usersStmt.all()) keys.push("km:user:" + String(r.user_id).replace(/^u_/, ""));
  return prefix ? keys.filter((k) => k.indexOf(prefix) === 0) : keys;
}

// ---------- HTTP ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  // защита от выхода за пределы public/
  const filePath = path.normalize(path.join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA-фолбэк: всё неизвестное отдаём как index.html
      return fs.readFile(path.join(PUBLIC, "index.html"), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end("Not found"); }
        res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(idx);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function readBody(req, cb) {
  let buf = ""; let tooBig = false;
  req.on("data", (c) => { buf += c; if (buf.length > 5 * 1024 * 1024) { tooBig = true; req.destroy(); } });
  req.on("end", () => cb(tooBig ? null : buf));
  req.on("error", () => cb(null));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  try {
    if (p === "/healthz") return sendJson(res, 200, { ok: true, driver: driver });

    if (p === "/api/kv") {
      if (req.method === "GET") {
        const key = u.searchParams.get("key") || "";
        if (!key) return sendJson(res, 400, { error: "key required" });
        return sendJson(res, 200, { key: key, value: kvGet(key) });
      }
      if (req.method === "POST") {
        return readBody(req, (raw) => {
          if (raw == null) return sendJson(res, 413, { error: "body too large / read error" });
          let body; try { body = JSON.parse(raw || "{}"); } catch (_) { return sendJson(res, 400, { error: "bad json" }); }
          if (typeof body.key !== "string" || typeof body.value !== "string")
            return sendJson(res, 400, { error: "key/value must be strings" });
          try { kvSet(body.key, body.value); return sendJson(res, 200, { key: body.key, value: body.value }); }
          catch (e) { console.error("kvSet", body.key, e); return sendJson(res, 500, { error: String(e && e.message || e) }); }
        });
      }
      if (req.method === "DELETE") {
        const key = u.searchParams.get("key") || "";
        if (!key) return sendJson(res, 400, { error: "key required" });
        try {
          const m = key.match(USER_RE);
          if (m) {
            const uid = dbUserId(m[1]);
            db.exec("BEGIN");
            for (const t of ["financial_profiles", "debts", "goals", "purchase_plans", "user_progress",
                             "user_cosmetics", "user_settings", "checkins", "user_lessons", "user_challenges", "expenses"])
              db.prepare("DELETE FROM " + t + " WHERE user_id=?").run(uid);
            db.exec("COMMIT");
          } else kvDelStmt.run(key);
          return sendJson(res, 200, { key: key, deleted: true });
        } catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} return sendJson(res, 500, { error: String(e) }); }
      }
      res.writeHead(405); return res.end("Method not allowed");
    }

    if (p === "/api/kv-list" && req.method === "GET") {
      const prefix = u.searchParams.get("prefix") || "";
      return sendJson(res, 200, { keys: kvList(prefix) });
    }

    // всё остальное — статика приложения
    return serveStatic(res, req.url);
  } catch (e) {
    console.error("server error", e);
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs))
    for (const ni of ifs[name] || [])
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
  return out;
}

server.listen(PORT, HOST, () => {
  console.log("КопиМотик · сервер запущен (драйвер: " + driver + ")");
  console.log("  База данных: " + DB_PATH);
  console.log("  Локально:    http://localhost:" + PORT);
  for (const ip of lanIPs()) console.log("  По сети:     http://" + ip + ":" + PORT + "   (для других устройств в той же сети)");
  console.log("Остановить: Ctrl+C");
});
