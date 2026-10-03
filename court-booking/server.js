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
db.run(`ALTER TABLE bookings ADD COLUMN price INTEGER`, (err) => {}); 

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

// 取得台灣當前日期字串 (YYYY-MM-DD)
function getTodayDateStr() {
  const now = new Date();
  const twTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const year = twTime.getFullYear();
  const month = String(twTime.getMonth() + 1).padStart(2, '0');
  const day = String(twTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

// ==========================================
// 💡 新增：根據手機號碼查詢未來的預約紀錄
// ==========================================
app.get('/api/my-bookings', (req, res) => {
  const phone = req.query.phone;
  if (!phone) {
    return res.status(400).json({ success: false, error: '請輸入手機號碼' });
  }

  const todayStr = getTodayDateStr();

  db.all(
    `SELECT * FROM bookings WHERE user_phone = ? AND booking_date >= ? ORDER BY booking_date ASC, time_slot ASC`,
    [phone, todayStr],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, error: '查詢失敗' });
      }
      res.json({ success: true, bookings: rows || [] });
    }
  );
});

// ==========================================
// 💡 防呆資料交替機制 (10分鐘循環)
// ==========================================
let antiSleepTimer = null;
let isTestDataExist = false; 
const ANTI_SLEEP_INTERVAL = 10 * 60 * 1000; // 10 分鐘

function runAntiSleepDatabaseToggle() {
  const testDate = '2026-10-01';
  const testSlot = '08:00-09:00';
  const testName = '測試用';
  const testPhone = '0912345678';
  const testSport = '羽球';

  if (!isTestDataExist) {
    const createdAt = getFormattedTimestamp();
    const defaultPrice = 400;
    
    db.get(`SELECT COUNT(*) as count FROM bookings WHERE booking_date = ? AND time_slot = ?`, [testDate, testSlot], (err, row) => {
      if (!err && row && row.count >= 3) {
        db.run(`DELETE FROM bookings WHERE user_name = '測試用' AND booking_date = ? AND time_slot = ?`, [testDate, testSlot], () => {});
      }

      db.all(`SELECT court_id FROM bookings WHERE booking_date = ? AND time_slot = ?`, [testDate, testSlot], (err, courts) => {
        const usedCourts = (courts || []).map(c => c.court_id);
        let targetCourt = 1;
        for (let i = 1; i <= 3; i++) {
          if (!usedCourts.includes(i)) { targetCourt = i; break; }
        }

        db.run(
          `INSERT INTO bookings (court_id, booking_date, time_slot, sport_type, user_name, user_phone, is_paid, created_at, price) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [targetCourt, testDate, testSlot, testSport, testName, testPhone, createdAt, defaultPrice],
          (insertErr) => {
            if (!insertErr) {
              console.log('🔄 [防呆機制] 已自動【新增】測試預約資料');
              isTestDataExist = true; 
            } else {
              console.log('❌ [防呆機制] 新增失敗:', insertErr.message);
            }
          }
        );
      });
    });

  } else {
    db.run(`DELETE FROM bookings WHERE user_name = '測試用' AND booking_date = ? AND time_slot = ?`, [testDate, testSlot], (err) => {
      if (!err) {
        console.log('🔄 [防呆機制] 已自動【刪除】測試預約資料');
        isTestDataExist = false; 
      } else {
        console.log('❌ [防呆機制] 刪除失敗:', err.message);
      }
    });
  }
}

function resetAntiSleepTimer() {
  if (antiSleepTimer) clearInterval(antiSleepTimer);
  antiSleepTimer = setInterval(() => {
    runAntiSleepDatabaseToggle();
  }, ANTI_SLEEP_INTERVAL);
}

function resetActivityTrigger() {
  resetAntiSleepTimer();
}
// ==========================================

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
          resetActivityTrigger(); 
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
  const todayStr = getTodayDateStr();
  
  db.all(`SELECT * FROM bookings WHERE booking_date >= ? ORDER BY booking_date ASC, time_slot ASC, court_id ASC`, [todayStr], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: '查詢失敗' });
    
    const bookings = (rows || []).map(b => ({
      ...b,
      price: (b.price !== null && b.price !== undefined) ? b.price : calculateSlotPrice(b.booking_date, b.time_slot)
    }));

    res.json({ success: true, bookings });
  });
});

app.patch('/api/admin/bookings/price', requireAdmin, (req, res) => {
  const { id, price } = req.body;
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
    if (err) return res.status(500).json({ error: '刪除失敗' });
    res.json({ success: true });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 伺服器啟動於 http://localhost:${PORT}`);
  resetAntiSleepTimer(); 
});