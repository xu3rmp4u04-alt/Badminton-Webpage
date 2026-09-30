const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'court_booking.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('無法連線至 SQLite 資料庫:', err.message);
  } else {
    console.log('已成功連線至 SQLite 資料庫。');
  }
});

db.serialize(() => {
  // 建立預約資料表（含 is_paid 欄位）
  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      court_id INTEGER NOT NULL,
      booking_date TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      sport_type TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_phone TEXT NOT NULL,
      is_paid INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 建立管理者資料表
  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  // 檢查並自動新增預設管理者帳密 (admin / admin123)
  db.get(`SELECT * FROM admins WHERE username = 'admin'`, (err, row) => {
    if (!row) {
      db.run(`INSERT INTO admins (username, password) VALUES ('admin', 'admin123')`);
    }
  });

  // 檢查舊 table 是否有 is_paid 欄位，若沒有則動態新增
  db.run(`ALTER TABLE bookings ADD COLUMN is_paid INTEGER DEFAULT 0`, (err) => {
    // 若欄位已存在會報錯，此處忽略 error 即可
  });
});

module.exports = db;