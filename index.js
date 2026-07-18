const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const COUNTRY_CODE = process.env.COUNTRY_CODE || '880';
const API_BASE = 'https://api.zenquantai.com/api';
const CLAIM_INTERVAL_MS = 3 * 60 * 60 * 1000;

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

async function apiCreateOrder(price) {
  try {
    const res = await api.post('/createOrder', { type: 0, price, minuteIndex: 0, is_new: 1 });
    return { success: !!res.data?.success, msg: res.data?.msg || '', data: res.data };
  } catch (e) { return { success: false, msg: e.response?.data?.msg || e.message }; }
}

function mainMenu() {
  const btns = [];
  if (isLoggedIn()) {
    btns.push([{ text: autoClaimOn ? '🟢 Auto Claim: ON' : '🔴 Auto Claim: OFF', callback_data: 'toggle' }]);
    btns.push([{ text: '⚡ Ekhoni Claim Koro', callback_data: 'claim_now' }]);
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
  bot.sendMessage(chatId, '🟢 Auto Claim ON. Prothom claim ekhoni shuru hocche...', mainMenu());
  runClaim(chatId, false);
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
    claimTimer = setTimeout(() => { runClaim(OWNER_ID, false); scheduleNext(); }, delay);
  } else {
    claimTimer = setTimeout(() => { runClaim(OWNER_ID, false); scheduleNext(); }, CLAIM_INTERVAL_MS);
  }
}

if (autoClaimOn && isLoggedIn() && nextClaimTime) {
  console.log('Resuming auto claim scheduler...');
  scheduleNext();
}

async function runClaim(chatId, manual) {
  if (!isLoggedIn()) return bot.sendMessage(chatId, '❌ Age /login diye login korun.');
  if (isClaiming) return bot.sendMessage(chatId, '⏳ Ager claim ekhono cholche, wait korun.');
  isClaiming = true;
  const send = (t) => bot.sendMessage(chatId, t);

  try {
    send('⏳ Site theke info nicchi...');
    const info = await apiGetInfo();
    if (!info) { throw new Error('API response failed'); }

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

    if (profit > 0) {
      send(`⏳ Profit ($${profit}) claim korchi...`);
      const claimRes = await apiClaimProfit();
      if (!claimRes.success) throw new Error('Claim profit failed: ' + claimRes.msg);
      send(`✅ Profit claimed!`);
    } else {
      send(`ℹ️ Kono profit claim kora jay na.`);
    }

    const investAmount = balance > 10 ? balance : 10;
    send(`⏳ New order create korchi ($${investAmount}, 3h)...`);
    const orderRes = await apiCreateOrder(investAmount);
    if (!orderRes.success) {
      if (orderRes.msg.includes('1027') || orderRes.msg.includes('Injection failed')) {
        throw new Error('Injection failed. Balance thik ase?');
      }
      throw new Error('Order failed: ' + orderRes.msg);
    }

    lastClaimTime = new Date();
    nextClaimTime = new Date(Date.now() + CLAIM_INTERVAL_MS);
    creds.nextClaimAt = nextClaimTime.toISOString();
    saveCredentials(creds);
    lastClaimStatus = '✅ Success';

    send(`✅ *Claim & Reinvest successful!*
💰 Invested: $${investAmount}
⏱ Next claim: ${nextClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`);

    if (autoClaimOn) scheduleNext();

  } catch (err) {
    lastClaimTime = new Date();
    lastClaimStatus = `❌ ${err.message}`;
    send(`❌ Error: ${err.message}`);
    if (autoClaimOn) scheduleNext();
  } finally {
    isClaiming = false;
  }
}

process.on('unhandledRejection', (err) => console.error('UHR:', err.message));
process.on('uncaughtException', (err) => console.error('UCE:', err.message));
console.log('Bot v2 started.');
