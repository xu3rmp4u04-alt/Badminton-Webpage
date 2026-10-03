const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 💡 Supabase 設定
// ==========================================
const SUPABASE_URL = 'https://jcnnbopcglsinvjewzpq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY; 
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'court_booking_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 }
}));

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

function getTodayDateStr() {
  const now = new Date();
  const twTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const year = twTime.getFullYear();
  const month = String(twTime.getMonth() + 1).padStart(2, '0');
  const day = String(twTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

app.get('/api/available-slots', async (req, res) => {
  const date = req.query.date;
  const sport_type = req.query.sport_type || req.query.court_type || req.query.type;
  if (!date || !sport_type) return res.status(400).json({ error: '請選擇日期與球類' });

  const { data: rows, error } = await db
    .from('bookings')
    .select('court_id, time_slot, sport_type')
    .eq('booking_date', date);

  if (error) return res.status(500).json({ error: '查詢失敗' });
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

app.get('/api/my-bookings', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) {
    return res.status(400).json({ success: false, error: '請輸入手機號碼' });
  }

  const todayStr = getTodayDateStr();

  const { data: rows, error } = await db
    .from('bookings')
    .select('*')
    .eq('user_phone', phone)
    .gte('booking_date', todayStr)
    .order('booking_date', { ascending: true })
    .order('time_slot', { ascending: true });

  if (error) {
    return res.status(500).json({ success: false, error: '查詢失敗' });
  }
  res.json({ success: true, bookings: rows || [] });
});

// 防呆背景機制
let antiSleepTimer = null;
let isTestDataExist = false; 
const ANTI_SLEEP_INTERVAL = 10 * 60 * 1000;

async function runAntiSleepDatabaseToggle() {
  const testDate = '2026-10-01';
  const testSlot = '08:00-09:00';
  const testName = '測試用';
  const testPhone = '0912345678';
  const testSport = '羽球';

  if (!isTestDataExist) {
    const createdAt = getFormattedTimestamp();
    const defaultPrice = 400;
    
    const { data: countRows } = await db
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('booking_date', testDate)
      .eq('time_slot', testSlot);

    const { data: courts } = await db
      .from('bookings')
      .select('court_id')
      .eq('booking_date', testDate)
      .eq('time_slot', testSlot);

    const usedCourts = (courts || []).map(c => c.court_id);
    let targetCourt = 1;
    for (let i = 1; i <= 3; i++) {
      if (!usedCourts.includes(i)) { targetCourt = i; break; }
    }

    const { error: insertErr } = await db
      .from('bookings')
      .insert([{
        court_id: targetCourt,
        booking_date: testDate,
        time_slot: testSlot,
        sport_type: testSport,
        user_name: testName,
        user_phone: testPhone,
        is_paid: 0,
        created_at: createdAt,
        price: defaultPrice
      }]);

    if (!insertErr) {
      console.log('🔄 [防呆機制] 已自動【新增】測試預約資料');
      isTestDataExist = true; 
    } else {
      console.log('❌ [防呆機制] 新增失敗:', insertErr.message);
    }
  } else {
    const { error } = await db
      .from('bookings')
      .delete()
      .eq('user_name', '測試用')
      .eq('booking_date', testDate)
      .eq('time_slot', testSlot);

    if (!error) {
      console.log('🔄 [防呆機制] 已自動【刪除】測試預約資料');
      isTestDataExist = false; 
    } else {
      console.log('❌ [防呆機制] 刪除失敗:', error.message);
    }
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

app.post('/api/book', async (req, res) => {
  const { date, time_slots, name, phone } = req.body;
  const sport_type = req.body.sport_type || req.body.court_type || req.body.type;
  const selectedSlots = Array.isArray(time_slots) ? time_slots : (req.body.time_slot ? [req.body.time_slot] : []);

  if (!date || selectedSlots.length === 0 || !sport_type || !name || !phone) {
    return res.status(400).json({ error: '請填寫完整資訊' });
  }

  const { data: rows, error } = await db
    .from('bookings')
    .select('time_slot, court_id, sport_type')
    .eq('booking_date', date)
    .in('time_slot', selectedSlots);

  if (error) return res.status(500).json({ error: '處理失敗' });

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
  const insertPayloads = assignedBookings.map(({ slot, courtId }) => ({
    court_id: courtId,
    booking_date: date,
    time_slot: slot,
    sport_type: sport_type,
    user_name: name,
    user_phone: phone,
    is_paid: 0,
    created_at: createdAt,
    price: calculateSlotPrice(date, slot)
  }));

  const { error: insertErr } = await db
    .from('bookings')
    .insert(insertPayloads);

  if (insertErr) {
    return res.status(500).json({ error: '寫入失敗' });
  }

  resetActivityTrigger(); 
  res.json({ success: true, message: '預約成功！' });
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  
  const { data: admins, error } = await db
    .from('admins')
    .select('*')
    .eq('username', username)
    .eq('password', password);

  console.log('🔍 登入嘗試 - 帳號:', username);
  console.log('🔍 資料庫查詢結果:', admins);
  console.log('🔍 資料庫錯誤訊息:', error);

  if (error || !admins || admins.length === 0) {
    return res.status(401).json({ success: false, message: '帳號或密碼錯誤', debug: error });
  }

  req.session.isAdmin = true;
  res.json({ success: true, message: '登入成功' });
});

app.get('/api/admin/check-auth', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.isAdmin) });
});

// 💡 補上管理員前端輪詢所需的 check-alert 路由
app.get('/api/admin/check-alert', (req, res) => {
  res.json({ showAlert: false });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  const todayStr = getTodayDateStr();
  
  const { data: rows, error } = await db
    .from('bookings')
    .select('*')
    .gte('booking_date', todayStr)
    .order('booking_date', { ascending: true })
    .order('time_slot', { ascending: true })
    .order('court_id', { ascending: true });

  if (error) return res.status(500).json({ success: false, error: '查詢失敗' });
  
  const bookings = (rows || []).map(b => ({
    ...b,
    price: (b.price !== null && b.price !== undefined) ? b.price : calculateSlotPrice(b.booking_date, b.time_slot)
  }));

  res.json({ success: true, bookings });
});

app.patch('/api/admin/bookings/price', requireAdmin, async (req, res) => {
  const { id, price } = req.body;
  if (id === undefined || price === undefined) {
    return res.status(400).json({ success: false, error: '參數無效' });
  }

  const { error } = await db
    .from('bookings')
    .update({ price })
    .eq('id', id);

  if (error) return res.status(500).json({ success: false, error: '更新失敗' });
  res.json({ success: true });
});

app.patch('/api/admin/bookings/payment', requireAdmin, async (req, res) => {
  const { ids, is_paid } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ success: false, error: '參數無效' });

  const { error } = await db
    .from('bookings')
    .update({ is_paid: is_paid ? 1 : 0 })
    .in('id', ids);

  if (error) return res.status(500).json({ success: false, error: '更新失敗' });
  res.json({ success: true });
});

app.delete('/api/admin/bookings', requireAdmin, async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ success: false, error: '參數無效' });

  const { error } = await db
    .from('bookings')
    .delete()
    .in('id', ids);

  if (error) return res.status(500).json({ error: '刪除失敗' });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🚀 伺服器啟動於 http://localhost:${PORT}`);
  resetAntiSleepTimer(); 
});