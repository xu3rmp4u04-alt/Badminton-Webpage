const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const db = require('./database');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'court_booking_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 }
}));

// 確保資料庫有必要欄位
db.run(`ALTER TABLE bookings ADD COLUMN is_paid INTEGER DEFAULT 0`, (err) => {});
db.run(`ALTER TABLE bookings ADD COLUMN created_at TEXT`, (err) => {});
db.run(`ALTER TABLE bookings ADD COLUMN price INTEGER`, (err) => {}); // 支援自訂價格欄位

const TIME_SLOTS = [
  '08:00-09:00', '09:00-10:00', '10:00-11:00', '11:00-12:00',
  '12:00-13:00', '13:00-14:00', '14:00-15:00', '15:00-16:00',
  '16:00-17:00', '17:00-18:00', '18:00-19:00', '19:00-20:00',
  '20:00-21:00', '21:00-22:00'
];

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ success: false, error: '未授權存取' });
}

function calculateSlotPrice(dateStr, timeSlotStr) {
  try {
    const selectedDate = new Date(dateStr);
    const dayOfWeek = selectedDate.getDay(); 
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    const startHour = parseInt(timeSlotStr.split(':')[0], 10);

    if (isWeekend) return 600; 
    return (startHour >= 8 && startHour < 18) ? 400 : 600;
  } catch (e) {
    return 400; 
  }
}

function getFormattedTimestamp() {
  const now = new Date();
  const twTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const year = twTime.getFullYear();
  const month = String(twTime.getMonth() + 1).padStart(2, '0');
  const day = String(twTime.getDate()).padStart(2, '0');
  const hours = String(twTime.getHours()).padStart(2, '0');
  const minutes = String(twTime.getMinutes()).padStart(2, '0');
  const seconds = String(twTime.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

app.get('/api/available-slots', (req, res) => {
  const date = req.query.date;
  const sport_type = req.query.sport_type || req.query.court_type || req.query.type;
  if (!date || !sport_type) return res.status(400).json({ error: '請選擇日期與球類' });

  db.all(`SELECT court_id, time_slot, sport_type FROM bookings WHERE booking_date = ?`, [date], (err, rows) => {
    if (err) return res.status(500).json({ error: '查詢失敗' });
    const bookingRows = rows || [];
    const result = TIME_SLOTS.map(slot => {
      const slotBookings = bookingRows.filter(r => r.time_slot === slot);
      const hasConflict = slotBookings.some(r => r.sport_type !== sport_type);
      if (hasConflict) return { time_slot: slot, available: false, remaining_courts: 0 };
      const availableCount = 3 - slotBookings.length;
      return { time_slot: slot, available: availableCount > 0, remaining_courts: availableCount };
    });
    res.json({ date, sport_type, slots: result });
  });
});

let idleTimer = null;
const IDLE_LIMIT = 10 * 60 * 1000;
let needsAlert = false; 

function sendPing() {
  needsAlert = true; 
  const appUrl = process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT;
  http.get(`${appUrl}/api/admin/check-auth`, (res) => {}).on('error', (err) => {});
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    sendPing();
    resetIdleTimer();
  }, IDLE_LIMIT);
}

app.get('/api/admin/check-alert', requireAdmin, (req, res) => {
  if (needsAlert) {
    needsAlert = false;
    return res.json({ showAlert: true });
  }
  res.json({ showAlert: false });
});

app.post('/api/book', (req, res) => {
  const { date, time_slots, name, phone } = req.body;
  const sport_type = req.body.sport_type || req.body.court_type || req.body.type;
  const selectedSlots = Array.isArray(time_slots) ? time_slots : (req.body.time_slot ? [req.body.time_slot] : []);

  if (!date || selectedSlots.length === 0 || !sport_type || !name || !phone) {
    return res.status(400).json({ error: '請填寫完整資訊' });
  }

  const placeholders = selectedSlots.map(() => '?').join(',');
  db.all(`SELECT time_slot, court_id, sport_type FROM bookings WHERE booking_date = ? AND time_slot IN (${placeholders})`, [date, ...selectedSlots], (err, rows) => {
    if (err) return res.status(500).json({ error: '處理失敗' });

    const bookingList = rows || [];
    const assignedBookings = [];

    for (const slot of selectedSlots) {
      const slotBookings = bookingList.filter(r => r.time_slot === slot);
      if (slotBookings.some(r => r.sport_type !== sport_type) || slotBookings.length >= 3) {
        return res.status(400).json({ error: `時段 ${slot} 已額滿或衝突` });
      }
      const bookedCourtIds = slotBookings.map(r => r.court_id);
      let assignedCourtId = null;
      for (let id = 1; id <= 3; id++) {
        if (!bookedCourtIds.includes(id)) { assignedCourtId = id; break; }
      }
      if (!assignedCourtId) return res.status(400).json({ error: '場地分配失敗' });
      assignedBookings.push({ slot, courtId: assignedCourtId });
    }

    const createdAt = getFormattedTimestamp();
    let completedCount = 0;
    let hasError = false;

    assignedBookings.forEach(({ slot, courtId }) => {
      const defaultPrice = calculateSlotPrice(date, slot);
      db.run(`INSERT INTO bookings (court_id, booking_date, time_slot, sport_type, user_name, user_phone, is_paid, created_at, price) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`, 
        [courtId, date, slot, sport_type, name, phone, createdAt, defaultPrice], function(insertErr) {
        if (insertErr && !hasError) {
          hasError = true;
          return res.status(500).json({ error: '寫入失敗' });
        }
        completedCount++;
        if (completedCount === assignedBookings.length && !hasError) {
          resetIdleTimer();
          res.json({ success: true, message: '預約成功！' });
        }
      });
    });
  });
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM admins WHERE username = ? AND password = ?`, [username, password], (err, admin) => {
    if (admin) {
      req.session.isAdmin = true;
      res.json({ success: true, message: '登入成功' });
    } else {
      res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
    }
  });
});

app.get('/api/admin/check-auth', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.isAdmin) });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const now = new Date();
  const today = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];

  db.all(`SELECT * FROM bookings WHERE booking_date >= ? ORDER BY booking_date ASC, time_slot ASC, court_id ASC`, [today], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: '查詢失敗' });
    
    const bookings = (rows || []).map(b => ({
      ...b,
      price: (b.price !== null && b.price !== undefined) ? b.price : calculateSlotPrice(b.booking_date, b.time_slot)
    }));

    res.json({ success: true, bookings });
  });
});

// 💡 更新價格 API：將傳入的新總金額平均分配更新到該筆訂單的所有相關 id 中
app.patch('/api/admin/bookings/price', requireAdmin, (req, res) => {
  const { id, price } = req.body; // 這裡前端傳過來的其實是一個 id 或我們要更新的對象
  if (id === undefined || price === undefined) {
    return res.status(400).json({ success: false, error: '參數無效' });
  }

  db.run(`UPDATE bookings SET price = ? WHERE id = ?`, [price, id], function(err) {
    if (err) return res.status(500).json({ success: false, error: '更新失敗' });
    res.json({ success: true });
  });
});

app.patch('/api/admin/bookings/payment', requireAdmin, (req, res) => {
  const { ids, is_paid } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ success: false, error: '參數無效' });

  const placeholders = ids.map(() => '?').join(',');
  db.run(`UPDATE bookings SET is_paid = ? WHERE id IN (${placeholders})`, [is_paid ? 1 : 0, ...ids], function(err) {
    if (err) return res.status(500).json({ success: false, error: '更新失敗' });
    res.json({ success: true });
  });
});

app.delete('/api/admin/bookings', requireAdmin, (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ success: false, error: '參數無效' });

  const placeholders = ids.map(() => '?').join(',');
  db.run(`DELETE FROM bookings WHERE id IN (${placeholders})`, [...ids], function(err) {
    if (err) return res.status(500).json({ success: false, error: '刪除失敗' });
    res.json({ success: true });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 伺服器啟動於 http://localhost:${PORT}`);
  resetIdleTimer();
});