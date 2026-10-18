const http = require('http');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// ============ 数据库 ============
const db = new DatabaseSync('restaurant.db');

// ---- 表1：菜品表 ----
db.exec(`
  CREATE TABLE IF NOT EXISTS menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    stock INTEGER NOT NULL
  )
`);

// ---- 表2：账号表 ----
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL
  )
`);

// ---- 表3：订单表 ----
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dish_name TEXT NOT NULL,
    price INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'preparing',
    created_at TEXT NOT NULL
  )
`);

// ---- 初始化 ----
const menuCount = db.prepare('SELECT COUNT(*) AS c FROM menu').get();
if (menuCount.c === 0) {
  const insert = db.prepare('INSERT INTO menu (name, price, stock) VALUES (?, ?, ?)');
  insert.run('宫保鸡丁', 28, 10);
  insert.run('鱼香肉丝', 24, 0);
  insert.run('麻婆豆腐', 18, 15);
  insert.run('回锅肉', 32, 5);
  insert.run('番茄蛋汤', 12, 8);
  console.log('✅ 菜品表已初始化（5 道菜）');
}

const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get();
if (userCount.c === 0) {
  const insert = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)');
  insert.run('boss',  '123456', 'admin');
  insert.run('staff1', '123456', 'staff');
  insert.run('staff2', '123456', 'staff');
  console.log('✅ 账号表已初始化（boss / staff1 / staff2，密码都是 123456）');
}

// ============ 登录会话 ============
// 内存 token 表：token → { username, role }
// 真实系统用 Redis/JWT，这里用内存 Map 理解原理
// 注意：服务器重启后所有 token 失效，需要重新登录
const tokens = new Map();

// 读取 POST 请求体（JSON）
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

// ============ HTTP 服务器 ============
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://localhost:3000');
  const path = urlObj.pathname;

  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${path}`);

  // CORS：允许跨域 + 允许自定义请求头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  // CORS 预检：浏览器发跨域 POST 前，会先发 OPTIONS 试探，直接放行
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---------- 顾客接口 ----------

  if (path === '/api/menu') {
    const rows = db.prepare('SELECT name, price, stock FROM menu').all();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(rows));

  } else if (path === '/api/order') {
    const name = urlObj.searchParams.get('name');
    const dish = db.prepare('SELECT price, stock FROM menu WHERE name = ?').get(name);

    if (dish && dish.stock > 0) {
      db.prepare('UPDATE menu SET stock = stock - 1 WHERE name = ?').run(name);
      const now = new Date().toLocaleString('zh-CN');
      const result = db.prepare(
        'INSERT INTO orders (dish_name, price, status, created_at) VALUES (?, ?, ?, ?)'
      ).run(name, dish.price, 'preparing', now);

      const orderId = Number(result.lastInsertRowid);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, message: `下单成功！取餐号 #${orderId}`, orderId }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: '已售罄或菜品不存在' }));
    }

  // ---------- 登录接口 ----------

  } else if (path === '/api/login' && req.method === 'POST') {
    // 1. 读请求体，拿到用户名密码
    const body = await readBody(req);
    const { username, password } = body;

    // 2. 查数据库验证（Java 对照：SELECT + PreparedStatement）
    const user = db.prepare(
      'SELECT * FROM users WHERE username = ? AND password = ?'
    ).get(username, password);

    // 3. 验证通过 → 发 token（门票）
    if (user) {
      const token = crypto.randomUUID();  // 随机门票
      tokens.set(token, { username: user.username, role: user.role });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, token, username: user.username, role: user.role }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: '用户名或密码错误' }));
    }

  // ---------- 验证 token 的演示接口 ----------

  } else if (path === '/api/whoami') {
    const token = req.headers['authorization'];  // 从请求头拿门票
    const info = tokens.get(token);

    if (info) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, ...info }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: '未登录或登录已过期' }));
    }

  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 页面不存在');
  }
});

server.listen(3000, () => {
  console.log('餐厅后端已启动（登录版），监听 http://localhost:3000');
});
