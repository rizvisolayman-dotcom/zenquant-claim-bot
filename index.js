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
let lastActionTime = null;
let lastActionStatus = 'Kono action hoyni';
let lastInjectionTime = null;    // last SUCCESSFUL injection time
let lastClaimAmount = null;      // last SUCCESSFUL claim amount
let isClaiming = false;
let pendingLogin = {};
let autoClaimChatId = null;
let hasActiveOrder = false;      // true when an order is counting down
let activeOrderCountdown = 0;    // receive_times from the latest active order

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

api.interceptors.request.use(async cfg => {
  if (authToken) cfg.headers.Authorization = 'Bearer ' + authToken;
  // Random 1-3 sec delay before each API call to look human
  await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
  return cfg;
});

const app = express();
app.get('/', (req, res) => res.send('ZenQuant Claim Bot v2 is running.'));
app.listen(process.env.PORT || 3000, () => console.log('Web server started.'));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function isOwner(msg) { return String(msg.chat.id) === String(OWNER_ID); }
function isLoggedIn() { return !!(creds.phone && creds.password); }
function maskPhone(p) { return p ? p.slice(0, 3) + '****' + p.slice(-2) : ''; }
async function refreshActiveOrder() {
  if (!isLoggedIn()) return;
  try {
    for (const t of [0, 2, 1]) {
      const dealRes = await apiGetDealList(1, 5, t);
      if (dealRes.success && dealRes.data.length) {
        for (const o of dealRes.data) {
          // Debug: log any order found regardless of status
          console.log(`[refresh] type=${t} status=${o.status} sn=${(o.ordersn||'').slice(-8)} receive_times=${o.receive_times} profit=${o.profit}`);
          if (Number(o.status) === 1) {
            const cd = Number(o.receive_times || 0);
            if (cd > 0) {
              hasActiveOrder = true;
              activeOrderCountdown = cd;
              nextClaimTime = new Date(Date.now() + (cd * 1000) + BUFFER_MS);
              creds.nextClaimAt = nextClaimTime.toISOString();
              saveCredentials(creds);
              return;
            }
          }
        }
      } else {
        console.log(`[refresh] type=${t} no data or empty: success=${dealRes.success} len=${dealRes.data.length}`);
      }
    }
    hasActiveOrder = false;
    activeOrderCountdown = 0;
  } catch (_) {}
}

function formatCountdown(sec) {
  if (!sec || sec <= 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  let r = '';
  if (h > 0) r += h + 'h ';
  if (m > 0) r += m + 'm ';
  r += s + 's';
  return r;
}

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
    const body = res.data;
    if (body?.success) return { success: true, msg: '', data: body };
    const code = body?.code || '';
    const msg = body?.msg || body?.message || `code ${code}`;
    return { success: false, msg, data: body };
  } catch (e) {
    const body = e.response?.data;
    const code = body?.code || '';
    const msg = body?.msg || body?.message || e.message || `code ${code}`;
    return { success: false, msg, data: body };
  }
}

async function apiGetDealDetail(ordersn, type) {
  try {
    const res = await api.get('/getDealDetail', { params: { ordersn, type: type || 0 } });
    return { success: !!res.data?.success, data: res.data?.data || res.data, raw: res.data, msg: res.data?.msg || '' };
  } catch (e) { return { success: false, data: null, raw: null, msg: e.message }; }
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

bot.onText(/\/start/, async (msg) => {
  await refreshActiveOrder();
  const lines = ['🤖 *ZenQuant Auto Claim Bot*', ''];
  if (isLoggedIn()) {
    lines.push('✅ *Login:* Active');
    if (creds.name) lines.push(`👤 *Name:* ${creds.name}`);
    lines.push(`📱 *Phone:* ${maskPhone(creds.phone)}`);
    if (lastInjectionTime) {
      lines.push(`💉 *Last Injection:* ${lastInjectionTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`);
    }
    if (hasActiveOrder && nextClaimTime) {
      const remainingMs = Math.max(0, nextClaimTime.getTime() - Date.now());
      const remainingSec = Math.floor(remainingMs / 1000);
      if (remainingMs > 0) lines.push(`⏳ *Countdown:* ${formatCountdown(remainingSec)}`);
      lines.push(`🔜 *Next Claim:* ${nextClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`);
    } else if (nextClaimTime) {
      lines.push(`🔜 *Next Retry:* ${nextClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`);
    }
  } else {
    lines.push('❌ *Login:* Kora nai');
  }
  lines.push('', '📌 /help — sob command dekhte');
  bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown', ...mainMenu() });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '📚 *Available Commands*\n\n' +
    '/start — Bot restart\n' +
    '/login — ZenQuant account login\n' +
    '/logout — Logout\n' +
    '/status — Account status + next claim time\n' +
    '/claim — Claim available profit\n' +
    '/confirm — Confirm injection (PLUS+)\n' +
    '/history — Order history\n' +
    '/help — Ei message',
    { parse_mode: 'Markdown', ...mainMenu() }
  );
});

bot.onText(/\/login/, (msg) => { startLoginFlow(msg.chat.id); });
bot.onText(/\/logout/, (msg) => { doLogout(msg.chat.id); });
bot.onText(/\/status/, (msg) => { sendStatus(msg.chat.id).catch(() => {}); });
bot.onText(/\/claim/, (msg) => {
  if (!isLoggedIn()) return bot.sendMessage(msg.chat.id, '❌ Age /login diye login korun.');
  runClaim(msg.chat.id, true);
});
bot.onText(/\/confirm/, (msg) => {
  if (!isLoggedIn()) return bot.sendMessage(msg.chat.id, '❌ Age /login diye login korun.');
  runConfirm(msg.chat.id);
});
bot.onText(/\/history/, (msg) => {
  if (!isLoggedIn()) return bot.sendMessage(msg.chat.id, '❌ Age /login diye login korun.');
  runHistory(msg.chat.id);
});

bot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const state = pendingLogin[msg.chat.id];
  if (!state) return;
  if (state.step === 'phone') {
    const phone = msg.text.trim();
    if (!/^\d{6,15}$/.test(phone))
      return bot.sendMessage(msg.chat.id, '❌ Sotik phone number din (jemon: 17XXXXXXXX)');
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
  bot.sendMessage(chatId, '📱 Country code chara phone number din (jemon: 17XXXXXXXX):');
}

function doLogout(chatId) {
  autoClaimOn = false; autoClaimChatId = null; hasActiveOrder = false; activeOrderCountdown = 0;
  lastInjectionTime = null; lastClaimAmount = null;
  if (claimTimer) { clearTimeout(claimTimer); claimTimer = null; }
  creds = { phone: null, password: null, token: null, name: null, nextClaimAt: null, autoClaimOn: false };
  authToken = null; nextClaimTime = null;
  saveCredentials(creds);
  bot.sendMessage(chatId, '🚪 Logout hoyeche.', mainMenu());
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;
  function requireLogin() {
    if (!isLoggedIn()) {
      bot.sendMessage(chatId, '❌ Age /login diye login korun.', mainMenu());
      return false;
    }
    return true;
  }
  try {
    if (action === 'login_start') { startLoginFlow(chatId); return bot.answerCallbackQuery(query.id); }
    if (action === 'logout') { doLogout(chatId); return bot.answerCallbackQuery(query.id); }
    if (action === 'toggle') {
      if (!requireLogin()) return bot.answerCallbackQuery(query.id);
      if (autoClaimOn) turnOff(chatId); else turnOn(chatId);
      return bot.answerCallbackQuery(query.id);
    }
    if (action === 'claim_now') {
      if (!requireLogin()) return bot.answerCallbackQuery(query.id);
      await bot.answerCallbackQuery(query.id, { text: 'Claim shuru hocche...' });
      return await runClaim(chatId, true);
    }
    if (action === 'confirm_inject') {
      if (!requireLogin()) return bot.answerCallbackQuery(query.id);
      await bot.answerCallbackQuery(query.id, { text: 'Injection shuru hocche...' });
      return await runConfirm(chatId);
    }
    if (action === 'history') {
      if (!requireLogin()) return bot.answerCallbackQuery(query.id);
      await bot.answerCallbackQuery(query.id, { text: 'Order history...' });
      return await runHistory(chatId);
    }
    if (action === 'status') { await sendStatus(chatId); return bot.answerCallbackQuery(query.id); }
    bot.answerCallbackQuery(query.id);
  } catch (e) {
    console.error('Callback query error:', e);
    bot.sendMessage(chatId, '❌ Error: ' + e.message).catch(() => {});
  }
});

async function sendStatus(chatId) {
  await refreshActiveOrder();
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
  if (lastInjectionTime) {
    lines.push(`💉 *Last Injection:* ${lastInjectionTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`);
  }
  if (lastClaimAmount) {
    lines.push(`💰 *Last Claim:* $${lastClaimAmount}`);
  }
  lines.push(`📌 *Status:* ${lastActionStatus}`);
  if (hasActiveOrder && nextClaimTime) {
    const remainingMs = Math.max(0, nextClaimTime.getTime() - Date.now());
    const remainingSec = Math.floor(remainingMs / 1000);
    const countdownStr = remainingMs > 0 ? formatCountdown(remainingSec) : '✅ Ready!';
    lines.push(`⏳ *Countdown:* ${countdownStr}`);
    lines.push(`🔜 *Next Claim:* ${nextClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`);
  } else if (nextClaimTime) {
    lines.push(`🔜 *Next Retry:* ${nextClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`);
  } else {
    lines.push(`🔜 *Next:* N/A`);
  }
  lines.push('', '📌 /help — sob command dekhte');
  bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown', ...mainMenu() });
}

function turnOn(chatId) {
  if (!isLoggedIn()) return bot.sendMessage(chatId, '❌ Age /login diye login korun.', mainMenu());
  if (autoClaimOn) return bot.sendMessage(chatId, 'Already ON ache.', mainMenu());
  autoClaimOn = true;
  autoClaimChatId = chatId;
  creds.autoClaimOn = true;
  saveCredentials(creds);

  // API theke active order check korbo (memory state reset hoye geleo)
  refreshActiveOrder().then(() => {
    if (hasActiveOrder && nextClaimTime && nextClaimTime > Date.now()) {
      const remainingMs = Math.max(0, nextClaimTime.getTime() - Date.now());
      const remainingSec = Math.floor(remainingMs / 1000);
      bot.sendMessage(chatId, `🟢 Auto Claim ON. Active order ase, countdown: ${formatCountdown(remainingSec)} baki.`, mainMenu());
    } else {
      bot.sendMessage(chatId, '🟢 Auto Claim ON. Prothom cycle ekhoni shuru hocche...', mainMenu());
      autoCycle(chatId);
    }
    scheduleNext();
  });
}

function turnOff(chatId) {
  autoClaimOn = false; creds.autoClaimOn = false; saveCredentials(creds);
  if (claimTimer) { clearTimeout(claimTimer); claimTimer = null; }
  bot.sendMessage(chatId, '🔴 Auto Claim OFF.', mainMenu());
}

function scheduleNext() {
  if (claimTimer) clearTimeout(claimTimer);
  if (!autoClaimOn || !autoClaimChatId) return;
  if (nextClaimTime) {
    const delay = Math.max(0, nextClaimTime.getTime() - Date.now());
    claimTimer = setTimeout(() => { autoCycle(autoClaimChatId); scheduleNext(); }, delay);
  } else {
    claimTimer = setTimeout(() => { autoCycle(autoClaimChatId); scheduleNext(); }, CLAIM_INTERVAL_MS);
  }
}

if (autoClaimOn && isLoggedIn() && nextClaimTime && autoClaimChatId) {
  console.log('Resuming auto claim scheduler...');
  scheduleNext();
}

async function autoCycle(chatId) {
  const claimed = await runClaim(chatId, false, true);
  if (claimed) {
    // Random delay 25-35 sec to avoid bot detection
    const delay = 25000 + Math.floor(Math.random() * 11000);
    await new Promise((r) => setTimeout(r, delay));
    await runConfirm(chatId, true);
  } else {
    // No profit to claim — maybe countdown still running, schedule next
    if (!nextClaimTime || nextClaimTime <= Date.now()) {
      nextClaimTime = new Date(Date.now() + CLAIM_INTERVAL_MS);
      creds.nextClaimAt = nextClaimTime.toISOString();
      saveCredentials(creds);
    }
  }
}

async function runClaim(chatId, manual, isAuto) {
  if (!isLoggedIn()) { bot.sendMessage(chatId, '❌ Age /login diye login korun.'); return false; }
  if (isClaiming) { bot.sendMessage(chatId, '⏳ Ager claim ekhono cholche, wait korun.'); return false; }
  isClaiming = true;
  let didClaim = false;
  const send = (t) => bot.sendMessage(chatId, t);

  try {
    send('⏳ Site theke info nicchi...');
    const info = await apiGetInfo();
    if (!info) throw new Error('API response failed');

    const u = info.userinfo || {};
    if (u.username && u.username !== creds.name) {
      creds.name = u.username; saveCredentials(creds);
    }

    const balance = Number(u.available_balance || 0);
    const total = Number(u.total_balance || 0);

    // Profit check: userinfo fields + active order from deal list
    let profit = Number(u.one_profit || 0) + Number(u.two_profit || 0) + Number(u.three_profit || 0)
      + Number(u.recharge_one_profit || 0) + Number(u.recharge_two_profit || 0) + Number(u.recharge_three_profit || 0);

    // If userinfo doesn't have profit fields, check active order's profit
    if (profit === 0) {
      await refreshActiveOrder();
      if (hasActiveOrder) {
        try {
          for (const t of [0, 2, 1]) {
            const dealRes = await apiGetDealList(1, 5, t);
            if (dealRes.success && dealRes.data.length) {
              for (const o of dealRes.data) {
                if (Number(o.status) === 1) {
                  profit = Number(o.profit || 0);
                  if (profit > 0) {
                    send(`🔍 Order profit found: $${profit} (type=${t})`);
                  }
                  break;
                }
              }
              if (profit > 0) break;
            }
          }
        } catch (_) {}
      }
      if (profit === 0 && hasActiveOrder) {
        send(`🔍 Active order found but profit=0. Check /history for raw data.`);
      }
    }

    send(`📊 *Account Info*
👤 Name: ${u.username || creds.name || 'N/A'}
💰 Balance: $${balance}
📦 Total: $${total}
💵 Claimable Profit: $${profit}`);

    if (hasActiveOrder && activeOrderCountdown > 0 && profit === 0) {
      send(`⏳ Active order countdown: ${formatCountdown(activeOrderCountdown)} baki.`);
    }

    if (profit > 0) {
      didClaim = true;
      send(`⏳ Profit ($${profit}) claim korchi...`);
      const claimRes = await apiClaimProfit();
      if (!claimRes.success) throw new Error('Claim profit failed: ' + (claimRes.msg || JSON.stringify(claimRes.data).substring(0, 100)));
      hasActiveOrder = false; activeOrderCountdown = 0;
      lastClaimAmount = profit;
      lastActionStatus = `✅ Claimed $${profit}`;
      send(`✅ *Profit claimed!*
💰 Amount: $${profit}`);
    } else if (!hasActiveOrder) {
      lastActionStatus = 'ℹ️ Kono profit nei, kono active order o nei';
      send(`ℹ️ Kono profit claim kora jay na. Active order o nei.`);
    }

    lastActionTime = new Date();

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
    console.error('runClaim error:', err);
    lastActionTime = new Date();
    lastActionStatus = `❌ ${err.message}`;
    send(`❌ Error: ${err.message}`);
  } finally {
    isClaiming = false;
  }
  return didClaim;
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

    const amount = Math.floor(balance);

    if (amount < 1) {
      hasActiveOrder = false; activeOrderCountdown = 0;
      lastActionStatus = `ℹ️ Balance kom ($${balance}), injection skip`;
      nextClaimTime = new Date(Date.now() + CLAIM_INTERVAL_MS);
      creds.nextClaimAt = nextClaimTime.toISOString();
      saveCredentials(creds);
      send(`ℹ️ Balance kom ($${balance}). 1 dollar na hole injection hobe na.
🔜 পরের চেষ্টা: ${nextClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`);
      return;
    }

    send(`⏳ PLUS+ injection create korchi $${amount} (balance: $${balance})...`);
    const order1 = await apiCreateOrder(2, amount, 0);
    if (!order1.success) {
      hasActiveOrder = false; activeOrderCountdown = 0;
      throw new Error('PLUS+ injection failed: ' + (order1.msg || JSON.stringify(order1.data).substring(0, 100)));
    }

    lastActionTime = new Date();
    lastInjectionTime = new Date();
    lastActionStatus = `✅ Injected $${amount}`;

    // Receive_times from site = actual countdown in seconds
    let countdownSec = 0;
    let orderSn = '';
    try {
      await new Promise(r => setTimeout(r, 3000));
      const dealRes = await apiGetDealList(1, 5, 0);
      if (dealRes.success && dealRes.data.length) {
        const latest = dealRes.data[0];
        orderSn = latest.ordersn || '';
        if (latest.receive_times > 0) countdownSec = Number(latest.receive_times);
      }
    } catch (_) {}

    if (countdownSec > 0) {
      hasActiveOrder = true;
      activeOrderCountdown = countdownSec;
      nextClaimTime = new Date(Date.now() + (countdownSec * 1000) + BUFFER_MS);
    } else {
      hasActiveOrder = true;
      activeOrderCountdown = 10800; // 3h fallback
      nextClaimTime = new Date(Date.now() + CLAIM_INTERVAL_MS);
    }

    creds.nextClaimAt = nextClaimTime.toISOString();
    saveCredentials(creds);

    send(`✅ *Injection successful!*
━━━━━━━━━━━━━━━━
➕ PLUS+: $${amount} (3H)
⏳ Countdown: ${formatCountdown(activeOrderCountdown)} + 2min buffer
━━━━━━━━━━━━━━━━
🔜 Next claim: ${nextClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`);

  } catch (err) {
    console.error('runConfirm error:', err);
    hasActiveOrder = false; activeOrderCountdown = 0;
    lastActionStatus = `❌ ${err.message}`;
    // Retry in 30 min on failure
    nextClaimTime = new Date(Date.now() + 30 * 60 * 1000);
    creds.nextClaimAt = nextClaimTime.toISOString();
    saveCredentials(creds);
    send(`❌ Error: ${err.message}
🔜 Next retry: ${nextClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`);
  } finally {
    isClaiming = false;
  }
}

async function runHistory(chatId) {
  if (!isLoggedIn()) return bot.sendMessage(chatId, '❌ Age /login diye login korun.');
  const send = (t, o) => bot.sendMessage(chatId, t, o || {});
  try {
    // Try ALL possible endpoints and log everything
    const allAttempts = [
      { method: 'GET', url: '/getDealList', params: { page: 1, size: 20, type: 0 } },
      { method: 'GET', url: '/getDealList', params: { page: 1, size: 20, type: 1 } },
      { method: 'GET', url: '/getDealList', params: { page: 1, size: 20, type: 2 } },
      { method: 'GET', url: '/getDealList', params: { page: 1, size: 20 } },
      { method: 'POST', url: '/getDealList', data: { page: 1, size: 20, type: 0 } },
      { method: 'POST', url: '/getDealList', data: { page: 1, size: 20 } },
      { method: 'GET', url: '/getDealDetail', params: { ordersn: '0', type: 0 } },
      { method: 'GET', url: '/getProfitList', params: { page: 1, size: 20 } },
      { method: 'POST', url: '/getDealList', data: { page: 1, size: 999 } },
    ];

    const results = [];
    for (const a of allAttempts) {
      try {
        let res;
        if (a.method === 'GET') res = await api.get(a.url, { params: a.params });
        else res = await api.post(a.url, a.data);
        const b = res.data;
        const snippet = JSON.stringify(b).substring(0, 200);
        results.push(`🔹 ${a.method} ${a.url}: ${snippet}`);
        console.log(`[history] ${a.method} ${a.url} =>`, JSON.stringify(b).substring(0, 500));
      } catch (e) {
        const errMsg = e.response?.data ? JSON.stringify(e.response.data).substring(0, 100) : e.message;
        results.push(`🔸 ${a.method} ${a.url}: ❌ ${errMsg}`);
        console.log(`[history] ${a.method} ${a.url} ERROR:`, errMsg);
      }
    }

    // Send all results to user (no Markdown to avoid parse errors from special chars in JSON)
    const msg = results.join('\n');
    for (let i = 0; i < msg.length; i += 3500) {
      await send('📖 History Debug:\n' + msg.substring(i, i + 3500));
    }

    // Now try to parse the first successful GET /getDealList response for a nicer view
    const dealRes = await api.get('/getDealList', { params: { page: 1, size: 20, type: 0 } }).catch(() => null);
    if (dealRes?.data) {
      const b = dealRes.data;
      let orders = [];
      if (Array.isArray(b?.data?.list)) orders = b.data.list;
      else if (Array.isArray(b?.data)) orders = b.data;
      else if (Array.isArray(b?.list)) orders = b.list;
      else if (Array.isArray(b?.records)) orders = b.records;

      if (orders.length) {
        const lines = ['📋 Order List:'];
        for (const [idx, order] of orders.entries()) {
          if (idx === 0) {
            const fields = Object.entries(order).map(([k, v]) => `${k}=${String(v).substring(0, 25)}`).join(', ');
            lines.push('Fields: ' + fields);
          }
          const amount = Number(order.amount || order.price || order.money || 0);
          const typeIdx = Number(order.deal_type ?? order.type ?? -1);
          const typeName = ['Regular', 'Closed', 'PLUS+', 'Phoenix'][typeIdx] || `T${typeIdx}`;
          const sMap = { 1: '⚡Active', 2: '⏳Redeem', 3: '✅Done', 4: '⏹Stop' };
          const status = sMap[order.status] || `S${order.status}`;
          const sn = (order.ordersn || order.orderNo || order.orderno || '').toString().slice(-8);
          const startTime = order.time || '';
          lines.push(`#${sn} ${typeName} $${amount} ${status} 🕐${startTime}`);
        }
        lines.push(`\nTotal: ${orders.length} orders`);
        await send(lines.join('\n'), { ...mainMenu() });
      } else {
        await send('ℹ️ Kono order nei (getDealList empty).', { ...mainMenu() });
      }
    }
  } catch (e) {
    console.error('runHistory error:', e);
    await send('❌ History error: ' + (e.response?.data ? JSON.stringify(e.response.data).substring(0, 500) : e.message), mainMenu());
  }
}

process.on('unhandledRejection', (err) => console.error('UHR:', err.message));
process.on('uncaughtException', (err) => console.error('UCE:', err.message));
console.log('Bot v2 started.');
