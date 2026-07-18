const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const COUNTRY_CODE = process.env.COUNTRY_CODE || '880';
const API_BASE = 'https://api.zenquantai.com/api';

// 3 hours 2 minutes (2 min buffer so we never call before the order actually matures)
const BUFFER_MS = 2 * 60 * 1000;
const CLAIM_INTERVAL_MS = 3 * 60 * 60 * 1000 + BUFFER_MS;

const api = axios.create({ baseURL: API_BASE });
let authToken = null;
const DATA_DIR = path.join(__dirname, 'data');
const CRED_FILE = path.join(DATA_DIR, 'credentials.json');

let autoClaimOn = false;
let claimTimer = null;
let nextClaimTime = null;
let lastClaimTime = null;
let lastClaimStatus = 'Kono claim hoyni ekhono';
let isClaiming = false;
let pendingLogin = {};

function loadCredentials() {
  try {
    if (fs.existsSync(CRED_FILE))
      return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
  } catch (e) { console.error('Credential load error:', e.message); }
  return { phone: null, password: null, token: null, name: null, nextClaimAt: null, autoClaimOn: false };
}
function saveCredentials(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(data, null, 2));
}

let creds = loadCredentials();
autoClaimOn = !!creds.autoClaimOn;
if (creds.token) authToken = creds.token;
if (creds.nextClaimAt) nextClaimTime = new Date(creds.nextClaimAt);

api.interceptors.request.use(cfg => {
  if (authToken) cfg.headers.Authorization = 'Bearer ' + authToken;
  return cfg;
});

const app = express();
app.get('/', (req, res) => res.send('ZenQuant Claim Bot v2 is running.'));
app.listen(process.env.PORT || 3000, () => console.log('Web server started.'));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function isOwner(msg) { return String(msg.chat.id) === String(OWNER_ID); }
function isLoggedIn() { return !!(creds.phone && creds.password); }
function maskPhone(p) { return p ? p.slice(0, 3) + '****' + p.slice(-2) : ''; }

async function apiLogin(phone, password) {
  try {
    const res = await api.post('/login', { phone, phone_code: COUNTRY_CODE, password, type: 'mobile' });
    if (res.data?.success) return { success: true, token: res.data.accessToken || res.data.data };
    return { success: false, error: res.data?.msg || 'Login failed' };
  } catch (e) { return { success: false, error: e.response?.data?.msg || e.message }; }
}

async function apiGetInfo() {
  try {
    const res = await api.post('/get_info', {});
    if (res.data?.success) return res.data.data || res.data;
  } catch (_) {}
  return null;
}

async function apiClaimProfit() {
  try {
    const res = await api.post('/receiveProfit', {});
    return { success: !!res.data?.success, msg: res.data?.msg || '', data: res.data };
  } catch (e) { return { success: false, msg: e.message }; }
}

async function apiCreateOrder(type, price, minuteIndex) {
  try {
    const res = await api.post('/createOrder', { type, price, minuteIndex: minuteIndex || 0, is_new: 1 });
    return { success: !!res.data?.success, msg: res.data?.msg || '', data: res.data };
  } catch (e) { return { success: false, msg: e.response?.data?.msg || e.message }; }
}

async function apiGetDealList(page, size, type) {
  try {
    const params = { page: page || 1, size: size || 20 };
    if (type !== undefined && type !== null) params.type = type;
    const res = await api.get('/getDealList', { params });
    const raw = res.data;
    let list = null;
    if (raw?.success && Array.isArray(raw?.data?.list)) list = raw.data.list;
    else if (raw?.success && Array.isArray(raw?.data)) list = raw.data;
    else if (raw?.success && Array.isArray(raw?.list)) list = raw.list;
    else if (Array.isArray(raw?.data?.records)) list = raw.data.records;
    return { success: !!list, data: list || [], raw, msg: raw?.msg || '' };
  } catch (e) { return { success: false, data: [], raw: null, msg: e.message }; }
}

async function apiGetDealInfo() {
  try {
    const res = await api.get('/getDealInfo', {});
    return { success: !!res.data?.success, data: res.data?.data || res.data, msg: res.data?.msg || '' };
  } catch (e) { return { success: false, data: null, msg: e.message }; }
}

function mainMenu() {
  const btns = [];
  if (isLoggedIn()) {
    btns.push([{ text: autoClaimOn ? '🟢 Auto Claim: ON' : '🔴 Auto Claim: OFF', callback_data: 'toggle' }]);
    btns.push([{ text: '⚡ Claim Profit', callback_data: 'claim_now' }]);
    btns.push([{ text: '✅ Confirm Injection', callback_data: 'confirm_inject' }]);
    btns.push([{ text: '📖 Order History', callback_data: 'history' }]);
    btns.push([{ text: '📊 Status', callback_data: 'status' }]);
    btns.push([{ text: '🚪 Logout', callback_data: 'logout' }]);
  } else {
    btns.push([{ text: '🔑 Login Koro', callback_data: 'login_start' }]);
  }
  return { reply_markup: { inline_keyboard: btns } };
}

bot.onText(/\/start/, (msg) => {
  if (!isOwner(msg)) return;
  const lines = ['🤖 *ZenQuant Auto Claim Bot*', ''];
  if (isLoggedIn()) {
    lines.push('✅ *Login:* Active');
    if (creds.name) lines.push(`👤 *Name:* ${creds.name}`);
    lines.push(`📱 *Phone:* ${maskPhone(creds.phone)}`);
  } else {
    lines.push('❌ *Login:* Kora nai');
  }
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown', ...mainMenu() });
});

bot.onText(/\/login/, (msg) => { if (isOwner(msg)) startLoginFlow(msg.chat.id); });
bot.onText(/\/logout/, (msg) => { if (isOwner(msg)) doLogout(msg.chat.id); });
bot.onText(/\/status/, (msg) => { if (isOwner(msg)) sendStatus(msg.chat.id); });
bot.onText(/\/claim/, (msg) => {
  if (!isOwner(msg)) return;
  if (!isLoggedIn()) return bot.sendMessage(msg.chat.id, '❌ Age /login diye login korun.');
  runClaim(msg.chat.id, true);
});
bot.onText(/\/confirm/, (msg) => {
  if (!isOwner(msg)) return;
  if (!isLoggedIn()) return bot.sendMessage(msg.chat.id, '❌ Age /login diye login korun.');
  runConfirm(msg.chat.id);
});
bot.onText(/\/history/, (msg) => {
  if (!isOwner(msg)) return;
  if (!isLoggedIn()) return bot.sendMessage(msg.chat.id, '❌ Age /login diye login korun.');
  runHistory(msg.chat.id);
});

bot.on('message', (msg) => {
  if (!isOwner(msg) || !msg.text || msg.text.startsWith('/')) return;
  const state = pendingLogin[msg.chat.id];
  if (!state) return;
  if (state.step === 'phone') {
    const phone = msg.text.trim();
    if (!/^\d{6,15}$/.test(phone))
      return bot.sendMessage(msg.chat.id, '❌ Sotik phone number din (jemon: 1713882071)');
    state.phone = phone;
    state.step = 'password';
    bot.sendMessage(msg.chat.id, '🔒 Ekhon password din:');
  } else if (state.step === 'password') {
    const password = msg.text.trim();
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    bot.sendMessage(msg.chat.id, '⏳ Login hocche...');
    apiLogin(state.phone, password).then(async (result) => {
      delete pendingLogin[msg.chat.id];
      if (!result.success)
        return bot.sendMessage(msg.chat.id, `❌ Login failed: ${result.error}`, mainMenu());
      creds.phone = state.phone;
      creds.password = password;
      creds.token = result.token;
      authToken = result.token;
      try {
        const info = await apiGetInfo();
        if (info?.userinfo?.username) creds.name = info.userinfo.username;
      } catch (_) {}
      saveCredentials(creds);
      bot.sendMessage(msg.chat.id, '✅ Login successful!', mainMenu());
    });
  }
});

function startLoginFlow(chatId) {
  pendingLogin[chatId] = { step: 'phone' };
  bot.sendMessage(chatId, '📱 Country code chara phone number din (jemon: 1713882071):');
}

function doLogout(chatId) {
  autoClaimOn = false;
  if (claimTimer) { clearTimeout(claimTimer); claimTimer = null; }
  creds = { phone: null, password: null, token: null, name: null, nextClaimAt: null, autoClaimOn: false };
  authToken = null; nextClaimTime = null;
  saveCredentials(creds);
  bot.sendMessage(chatId, '🚪 Logout hoyeche.', mainMenu());
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  if (String(chatId) !== String(OWNER_ID))
    return bot.answerCallbackQuery(query.id, { text: 'Authorized na.' });
  const action = query.data;
  if (action === 'login_start') startLoginFlow(chatId);
  else if (action === 'logout') doLogout(chatId);
  else if (action === 'toggle') {
    if (!isLoggedIn()) return bot.answerCallbackQuery(query.id, { text: 'Age login korun.' });
    if (autoClaimOn) turnOff(chatId); else turnOn(chatId);
  } else if (action === 'claim_now') {
    if (!isLoggedIn()) return bot.answerCallbackQuery(query.id, { text: 'Age login korun.' });
    bot.answerCallbackQuery(query.id, { text: 'Claim shuru hocche...' });
    runClaim(chatId, true);
  } else if (action === 'confirm_inject') {
    if (!isLoggedIn()) return bot.answerCallbackQuery(query.id, { text: 'Age login korun.' });
    bot.answerCallbackQuery(query.id, { text: 'Injection shuru hocche...' });
    runConfirm(chatId);
  } else if (action === 'history') {
    if (!isLoggedIn()) return bot.answerCallbackQuery(query.id, { text: 'Age login korun.' });
    bot.answerCallbackQuery(query.id, { text: 'Order history...' });
    runHistory(chatId);
  } else if (action === 'status') sendStatus(chatId);
  bot.answerCallbackQuery(query.id);
});

function sendStatus(chatId) {
  const lines = ['📊 *Status*', ''];
  if (isLoggedIn()) {
    lines.push('✅ *Login:* Active');
    if (creds.name) lines.push(`👤 *Name:* ${creds.name}`);
    lines.push(`📱 *Phone:* ${maskPhone(creds.phone)}`);
  } else {
    lines.push('❌ *Login:* Kora nai');
  }
  lines.push('');
  lines.push(`🔄 *Auto Claim:* ${autoClaimOn ? 'ON' : 'OFF'}`);
  lines.push(`⏱ *Last Claim:* ${lastClaimTime ? lastClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' }) : 'Kono din na'}`);
  lines.push(`📌 *Result:* ${lastClaimStatus}`);
  const nextStr = nextClaimTime
    ? nextClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })
    : 'N/A';
  lines.push(`🔜 *Next Claim:* ${nextStr}`);
  bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown', ...mainMenu() });
}

function turnOn(chatId) {
  if (!isLoggedIn()) return bot.sendMessage(chatId, '❌ Age /login diye login korun.', mainMenu());
  if (autoClaimOn) return bot.sendMessage(chatId, 'Already ON ache.', mainMenu());
  autoClaimOn = true;
  creds.autoClaimOn = true;
  saveCredentials(creds);
  bot.sendMessage(chatId, '🟢 Auto Claim ON. Prothom cycle (claim + confirm injection) ekhoni shuru hocche...', mainMenu());
  autoCycle(chatId);
  scheduleNext();
}

function turnOff(chatId) {
  autoClaimOn = false; creds.autoClaimOn = false; saveCredentials(creds);
  if (claimTimer) { clearTimeout(claimTimer); claimTimer = null; }
  bot.sendMessage(chatId, '🔴 Auto Claim OFF.', mainMenu());
}

function scheduleNext() {
  if (claimTimer) clearTimeout(claimTimer);
  if (!autoClaimOn) return;
  if (nextClaimTime) {
    const delay = Math.max(0, nextClaimTime.getTime() - Date.now());
    claimTimer = setTimeout(() => { autoCycle(OWNER_ID); scheduleNext(); }, delay);
  } else {
    claimTimer = setTimeout(() => { autoCycle(OWNER_ID); scheduleNext(); }, CLAIM_INTERVAL_MS);
  }
}

if (autoClaimOn && isLoggedIn() && nextClaimTime) {
  console.log('Resuming auto claim scheduler...');
  scheduleNext();
}

// Full unattended cycle: claim profit -> wait a moment -> confirm injection.
// Used by the scheduler and by "Auto Claim: ON" so nobody has to tap the
// Confirm Injection button by hand.
async function autoCycle(chatId) {
  await runClaim(chatId, false, true);
  await new Promise((r) => setTimeout(r, 5000)); // small buffer before re-injecting
  await runConfirm(chatId, true);
}

async function runClaim(chatId, manual, isAuto) {
  if (!isLoggedIn()) return bot.sendMessage(chatId, '❌ Age /login diye login korun.');
  if (isClaiming) return bot.sendMessage(chatId, '⏳ Ager claim ekhono cholche, wait korun.');
  isClaiming = true;
  const send = (t) => bot.sendMessage(chatId, t);

  try {
    send('⏳ Site theke info nicchi...');
    const info = await apiGetInfo();
    if (!info) throw new Error('API response failed');

    const u = info.userinfo || {};
    if (u.username && u.username !== creds.name) {
      creds.name = u.username; saveCredentials(creds);
    }

    const profit = Number(u.one_profit || 0) + Number(u.two_profit || 0) + Number(u.three_profit || 0)
      + Number(u.recharge_one_profit || 0) + Number(u.recharge_two_profit || 0) + Number(u.recharge_three_profit || 0);
    const balance = Number(u.available_balance || 0);
    const total = Number(u.total_balance || 0);

    send(`📊 *Account Info*
👤 Name: ${u.username || creds.name || 'N/A'}
💰 Balance: $${balance}
📦 Total: $${total}
💵 Claimable Profit: $${profit}`);

    if (profit === 0) {
      // Debug dump so we can see the real field names from the API and fix
      // the profit calculation if it's wrong.
      const rawU = JSON.stringify(u).substring(0, 900);
      send(`🔍 Debug (profit $0 dekhale eta check koro):\n\`${rawU.replace(/[\`]/g, '')}\``);
    }

    if (profit > 0) {
      send(`⏳ Profit ($${profit}) claim korchi...`);
      const claimRes = await apiClaimProfit();
      if (!claimRes.success) throw new Error('Claim profit failed: ' + claimRes.msg);
      lastClaimStatus = '✅ Profit claimed';
      send(`✅ *Profit claimed!*
💰 Amount: $${profit}`);
    } else {
      lastClaimStatus = 'ℹ️ Kono profit nei';
      send(`ℹ️ Kono profit claim kora jay na.`);
    }

    lastClaimTime = new Date();

    if (isAuto) {
      send(`🔁 Auto mode: ekhon nijer theke *Confirm Injection* cholbe...`);
    } else {
      const confirmBtns = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Confirm Injection', callback_data: 'confirm_inject' }],
            [{ text: '📊 Status', callback_data: 'status' }]
          ]
        }
      };
      send(`Ekhon injection nite chaile *Confirm Injection* button e click korun.`, confirmBtns);
    }

  } catch (err) {
    lastClaimTime = new Date();
    lastClaimStatus = `❌ ${err.message}`;
    send(`❌ Error: ${err.message}`);
  } finally {
    isClaiming = false;
  }
}

async function runConfirm(chatId, isAuto) {
  if (!isLoggedIn()) return bot.sendMessage(chatId, '❌ Age /login diye login korun.');
  if (isClaiming) return bot.sendMessage(chatId, '⏳ Age injection shesh hok, wait korun.');
  isClaiming = true;
  const send = (t) => bot.sendMessage(chatId, t);

  try {
    send('⏳ Info nicchi...');
    const info = await apiGetInfo();
    if (!info) throw new Error('API response failed');

    const u = info.userinfo || {};
    const balance = Number(u.available_balance || 0);

    if (balance < 50) {
      // Not enough balance yet — this is normal right after a $0 profit claim.
      // Just re-arm the schedule so the next attempt happens on time.
      lastClaimStatus = `ℹ️ Balance kom ($${balance}), injection skip`;
      nextClaimTime = new Date(Date.now() + CLAIM_INTERVAL_MS);
      creds.nextClaimAt = nextClaimTime.toISOString();
      saveCredentials(creds);
      send(`ℹ️ Balance kom ($${balance}). 50 dollar na hole PLUS+ injection hobe na. পরের চেষ্টা: ${nextClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`);
      return;
    }

    send(`⏳ PLUS+ injection create korchi $50...`);
    const order1 = await apiCreateOrder(2, 50, 0); // type=2 (PLUS+), minuteIndex=0 (3h)
    if (!order1.success) throw new Error('PLUS+ injection failed: ' + order1.msg);

    lastClaimTime = new Date();
    lastClaimStatus = '✅ Injection done';

    let nextTime = new Date(Date.now() + CLAIM_INTERVAL_MS);
    try {
      const dealRes = await apiGetDealList(1, 5, 0);
      if (dealRes.success && dealRes.data.length) {
        const activeOrders = dealRes.data.filter(o => o.status === 1 || o.status === 'executing');
        for (const o of activeOrders) {
          const endField = o.sell_time || o.end_time || o.complete_time;
          if (endField) {
            const t = new Date(new Date(endField).getTime() + BUFFER_MS);
            if (t > Date.now() && t < nextTime) nextTime = t;
          }
        }
      }
    } catch (_) {}

    nextClaimTime = nextTime;
    creds.nextClaimAt = nextClaimTime.toISOString();
    saveCredentials(creds);

    send(`✅ *Injection successful!*
━━━━━━━━━━━━━━━━
➕ PLUS+: $50 (3H)
━━━━━━━━━━━━━━━━
⏱ Next claim: ${nextClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`);

  } catch (err) {
    lastClaimStatus = `❌ ${err.message}`;
    // Even on failure, keep the cycle alive so it retries in 3h2m
    if (isAuto && !nextClaimTime) {
      nextClaimTime = new Date(Date.now() + CLAIM_INTERVAL_MS);
      creds.nextClaimAt = nextClaimTime.toISOString();
      saveCredentials(creds);
    }
    send(`❌ Error: ${err.message}`);
  } finally {
    isClaiming = false;
  }
}

async function runHistory(chatId) {
  if (!isLoggedIn()) return bot.sendMessage(chatId, '❌ Age /login diye login korun.');
  try {
    const res = await api.get('/getDealList', { params: { page: 1, size: 20 } });
    const rawStr = JSON.stringify(res.data).substring(0, 600);

    const body = res.data;
    let orders = [];
    if (body?.data?.list) orders = body.data.list;
    else if (Array.isArray(body?.data)) orders = body.data;
    else if (Array.isArray(body?.list)) orders = body.list;
    else if (body?.data && typeof body.data === 'object') {
      const vals = Object.values(body.data);
      const arr = vals.find(v => Array.isArray(v));
      if (arr) orders = arr;
    }

    if (!Array.isArray(orders)) orders = [];
    if (!orders.length) {
      return bot.sendMessage(chatId, `📖 History empty\n⚙️ \`${rawStr.replace(/[`]/g, '')}\``, { ...mainMenu() });
    }

    const lines = [`📖 *Order History*`];
    const first = orders[0];
    if (first) {
      for (const [k, v] of Object.entries(first)) {
        if (k.startsWith('_')) continue;
        const val = typeof v === 'object' ? JSON.stringify(v).substring(0, 60) : String(v).substring(0, 60);
        lines.push(` ${k}: ${val}`);
      }
    }
    for (const order of orders) {
      const amount = Number(order.amount || order.price || order.money || 0);
      const t = ['Regular', 'Closed', 'PLUS+', 'Phoenix'][order.type] || `T${order.type}`;
      let status = '';
      if (order.status === 1 || order.status === 'executing') status = '⚡ Active';
      else if (order.status === 2 || order.status === 'redeeming') status = '⏳ Redeeming';
      else if (order.status === 3 || order.status === 'completed') status = '✅ Done';
      else if (order.status === 4 || order.status === 'stopped') status = '⏹ Stopped';
      else status = `S${order.status}`;
      const orderSn = order.ordersn || order.orderNo || order.orderno || order.sn || '';
      let endTimeStr = '';
      const endField = order.sell_time || order.end_time || order.complete_time || order.finish_time;
      if (endField) {
        const et = new Date(endField);
        if (!isNaN(et)) endTimeStr = `\n⌛ Ends: ${et.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`;
      }
      const createField = order.create_time || order.add_time || order.buy_time || order.start_time;
      let createStr = '';
      if (createField) {
        const ct = new Date(createField);
        if (!isNaN(ct)) createStr = `\n🕐 Created: ${ct.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`;
      }
      lines.push(`
━━━━━━━━━━━━━━━━
📌 ${orderSn.toString().slice(-8) || 'N/A'}
💵 ${t} | 💰 $${amount}
📊 ${status}${createStr}${endTimeStr}`);
    }
    lines.push(`\n━━━━━━━━━━━━━━━━\n📱 Total: ${orders.length} orders`);
    bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown', ...mainMenu() });
  } catch (e) {
    const rawErr = e.response?.data ? JSON.stringify(e.response.data).substring(0, 500) : 'no response body';
    bot.sendMessage(chatId, `❌ History error: ${e.message}\n🔍 Raw: \`${rawErr.replace(/[\`]/g, '')}\``, mainMenu());
  }
}

process.on('unhandledRejection', (err) => console.error('UHR:', err.message));
process.on('uncaughtException', (err) => console.error('UCE:', err.message));
console.log('Bot v2 started.');
