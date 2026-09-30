const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'court_booking_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 }
}));

// 確保 bookings 資料表包含 is_paid 欄位
db.run(`ALTER TABLE bookings ADD COLUMN is_paid INTEGER DEFAULT 0`, (err) => {});

const TIME_SLOTS = [
  '08:00-09:00', '09:00-10:00', '10:00-11:00', '11:00-12:00',
  '12:00-13:00', '13:00-14:00', '14:00-15:00', '15:00-16:00',
  '16:00-17:00', '17:00-18:00', '18:00-19:00', '19:00-20:00',
  '20:00-21:00', '21:00-22:00'
];

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ success: false, error: '未授權存取，請先登入管理者帳號' });
}

// 計算單一時段費用的輔助函數
function calculateSlotPrice(dateStr, timeSlotStr) {
  try {
    const selectedDate = new Date(dateStr);
    const dayOfWeek = selectedDate.getDay(); // 0 是週日，6 是週六
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    
    const startHour = parseInt(timeSlotStr.split(':')[0], 10);

    if (isWeekend) {
      return 600; // 週末全天尖峰
    } else {
      if (startHour >= 8 && startHour < 18) {
        return 400; // 平日離峰 08:00-18:00
      } else {
        return 600; // 平日尖峰 18:00-22:00
      }
    }
  } catch (e) {
    return 400; // 預設值
  }
}

// 查詢可用時段
app.get('/api/available-slots', (req, res) => {
  try {
    const date = req.query.date;
    const sport_type = req.query.sport_type || req.query.court_type || req.query.type;

    if (!date || !sport_type) return res.status(400).json({ error: '請選擇日期與球類項目' });

    const query = `SELECT court_id, time_slot, sport_type FROM bookings WHERE booking_date = ?`;

    db.all(query, [date], (err, rows) => {
      if (err) return res.status(500).json({ error: '資料庫查詢失敗' });
      const bookingRows = rows || [];
      const result = TIME_SLOTS.map(slot => {
        const slotBookings = bookingRows.filter(r => r.time_slot === slot);
        const hasConflict = slotBookings.some(r => r.sport_type !== sport_type);
        if (hasConflict) return { time_slot: slot, available: false, remaining_courts: 0, reason: '已預約其他球類' };
        const availableCount = 3 - slotBookings.length;
        return { time_slot: slot, available: availableCount > 0, remaining_courts: availableCount };
      });
      return res.json({ date, sport_type, slots: result });
    });
  } catch (err) {
    res.status(500).json({ error: '伺服器處理請求時發生錯誤' });
  }
});

// 提交預約
app.post('/api/book', (req, res) => {
  try {
    const { date, time_slots, name, phone } = req.body;
    const sport_type = req.body.sport_type || req.body.court_type || req.body.type;
    const selectedSlots = Array.isArray(time_slots) ? time_slots : (req.body.time_slot ? [req.body.time_slot] : []);

    if (!date || selectedSlots.length === 0 || !sport_type || !name || !phone) {
      return res.status(400).json({ error: '請填寫所有欄位並至少選擇一個時段！' });
    }

    const placeholders = selectedSlots.map(() => '?').join(',');
    const checkQuery = `SELECT time_slot, court_id, sport_type FROM bookings WHERE booking_date = ? AND time_slot IN (${placeholders})`;

    db.all(checkQuery, [date, ...selectedSlots], (err, rows) => {
      if (err) return res.status(500).json({ error: '預約處理失敗' });

      const bookingList = rows || [];
      const assignedBookings = [];

      for (const slot of selectedSlots) {
        const slotBookings = bookingList.filter(r => r.time_slot === slot);
        if (slotBookings.some(r => r.sport_type !== sport_type)) {
          return res.status(400).json({ error: `時段 ${slot} 已被其他球類佔用！` });
        }
        if (slotBookings.length >= 3) {
          return res.status(400).json({ error: `時段 ${slot} 已全部額滿！` });
        }

        const bookedCourtIds = slotBookings.map(r => r.court_id);
        let assignedCourtId = null;
        for (let id = 1; id <= 3; id++) {
          if (!bookedCourtIds.includes(id)) {
            assignedCourtId = id;
            break;
          }
        }
        if (!assignedCourtId) return res.status(400).json({ error: `時段 ${slot} 場地分配失敗` });

        assignedBookings.push({ slot, courtId: assignedCourtId });
      }

      const insertQuery = `INSERT INTO bookings (court_id, booking_date, time_slot, sport_type, user_name, user_phone, is_paid) VALUES (?, ?, ?, ?, ?, ?, 0)`;
      let completedCount = 0;
      let hasError = false;

      assignedBookings.forEach(({ slot, courtId }) => {
        db.run(insertQuery, [courtId, date, slot, sport_type, name, phone], function(insertErr) {
          if (insertErr && !hasError) {
            hasError = true;
            return res.status(500).json({ error: '部份時段預約失敗，請重新再試' });
          }
          completedCount++;
          if (completedCount === assignedBookings.length && !hasError) {
            res.json({ success: true, message: `預約成功！共成功預約 ${assignedBookings.length} 個時段。` });
          }
        });
      });
    });
  } catch (err) {
    res.status(500).json({ error: '預約提交失敗' });
  }
});

// 管理者登入
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: '請輸入帳密' });

  const query = `SELECT * FROM admins WHERE username = ? AND password = ?`;
  db.get(query, [username, password], (err, admin) => {
    if (admin) {
      req.session.isAdmin = true;
      return res.json({ success: true, message: '登入成功！' });
    } else {
      return res.status(401).json({ success: false, message: '帳號或密碼錯誤！' });
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

// 取得「今日及未來」預約紀錄（並附加計算每筆金額）
app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const now = new Date();
  const today = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];

  const query = `SELECT * FROM bookings WHERE booking_date >= ? ORDER BY booking_date ASC, time_slot ASC, court_id ASC`;

  db.all(query, [today], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: '資料庫查詢失敗' });
    
    // 計算每筆紀錄的金額
    const bookingsWithPrice = (rows || []).map(b => ({
      ...b,
      price: calculateSlotPrice(b.booking_date, b.time_slot)
    }));

    res.json({ success: true, bookings: bookingsWithPrice });
  });
});

// 更新付款狀態
app.patch('/api/admin/bookings/payment', requireAdmin, (req, res) => {
  const { ids, is_paid } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ success: false, error: '參數無效' });

  const placeholders = ids.map(() => '?').join(',');
  const query = `UPDATE bookings SET is_paid = ? WHERE id IN (${placeholders})`;

  db.run(query, [is_paid ? 1 : 0, ...ids], function(err) {
    if (err) return res.status(500).json({ success: false, error: '更新失敗' });
    res.json({ success: true, message: '付款狀態已更新' });
  });
});

// 刪除預約
app.delete('/api/admin/bookings', requireAdmin, (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ success: false, error: '參數無效' });

  const placeholders = ids.map(() => '?').join(',');
  const query = `DELETE FROM bookings WHERE id IN (${placeholders})`;

  db.run(query, [...ids], function(err) {
    if (err) return res.status(500).json({ success: false, error: '刪除失敗' });
    res.json({ success: true, message: '預約已成功取消' });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 伺服器啟動於 http://localhost:${PORT}`);
});