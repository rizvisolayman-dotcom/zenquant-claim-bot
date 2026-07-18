const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const COUNTRY_CODE = process.env.COUNTRY_CODE || '880';

const API_BASE = 'https://api.zenquantai.com/api';
const api = axios.create({ baseURL: API_BASE });
let authToken = null;

const DATA_DIR = path.join(__dirname, 'data');
const CRED_FILE = path.join(DATA_DIR, 'credentials.json');

let autoClaimOn = false;
let claimTimer = null;
let lastClaimTime = null;
let lastClaimStatus = 'Kono claim hoyni ekhono';
let isClaiming = false;
let pendingLogin = {};

function loadCredentials() {
  try {
    if (fs.existsSync(CRED_FILE)) {
      return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Credential load error:', e.message);
  }
  return { phone: null, password: null, token: null, autoClaimOn: false };
}

function saveCredentials(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(data, null, 2));
}

let creds = loadCredentials();
autoClaimOn = !!creds.autoClaimOn;
if (creds.token) authToken = creds.token;

const app = express();
app.get('/', (req, res) => res.send('ZenQuant Claim Bot v2 is running.'));
app.listen(process.env.PORT || 3000, () => {
  console.log('Web server started.');
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function isOwner(msg) {
  return String(msg.chat.id) === String(OWNER_ID);
}

function isLoggedIn() {
  return !!(creds.phone && creds.password);
}

function maskPhone(phone) {
  if (!phone) return '';
  return phone.slice(0, 3) + '****' + phone.slice(-2);
}

async function apiLogin(phone, password) {
  const res = await api.post('/login', {
    phone,
    phone_code: COUNTRY_CODE,
    password,
    type: 'mobile',
  });
  if (res.data && res.data.success) {
    const token = res.data.accessToken || res.data.data;
    return { success: true, token };
  }
  const msg = res.data?.msg || res.data?.message || 'Login failed';
  return { success: false, error: msg };
}

api.interceptors.request.use(config => {
  if (authToken) {
    config.headers.Authorization = 'Bearer ' + authToken;
  }
  return config;
});

async function apiClaim() {
  if (!authToken) return { success: false, error: 'Not logged in' };
  try {
    const res = await api.post('/createOrder', {
      type: 0,
      price: 0,
      minuteIndex: 0,
      is_new: 1,
    });
    if (res.data && res.data.success) {
      return { success: true, data: res.data };
    }
    return { success: false, error: res.data?.msg || 'Claim failed' };
  } catch (e) {
    return { success: false, error: e.response?.data?.msg || e.message };
  }
}

function mainMenu() {
  const buttons = [];
  if (isLoggedIn()) {
    buttons.push([{ text: autoClaimOn ? '🟢 Auto Claim: ON' : '🔴 Auto Claim: OFF', callback_data: 'toggle' }]);
    buttons.push([{ text: '⚡ Ekhoni Claim Koro', callback_data: 'claim_now' }]);
    buttons.push([{ text: '📊 Status', callback_data: 'status' }]);
    buttons.push([{ text: '🚪 Logout', callback_data: 'logout' }]);
  } else {
    buttons.push([{ text: '🔑 Login Koro', callback_data: 'login_start' }]);
  }
  return { reply_markup: { inline_keyboard: buttons } };
}

bot.onText(/\/start/, (msg) => {
  if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, 'Apni authorized na.');
  const status = isLoggedIn() ? `Logged in ✅ (Phone: ${maskPhone(creds.phone)})` : 'Login kora nai ❌';
  bot.sendMessage(msg.chat.id, `ZenQuant Auto Claim Bot v2\n\n${status}`, mainMenu());
});

bot.onText(/\/login/, (msg) => {
  if (!isOwner(msg)) return;
  startLoginFlow(msg.chat.id);
});

bot.onText(/\/logout/, (msg) => {
  if (!isOwner(msg)) return;
  doLogout(msg.chat.id);
});

bot.onText(/\/status/, (msg) => {
  if (!isOwner(msg)) return;
  sendStatus(msg.chat.id);
});

bot.onText(/\/claim/, (msg) => {
  if (!isOwner(msg)) return;
  if (!isLoggedIn()) return bot.sendMessage(msg.chat.id, '❌ Age /login diye login korun.');
  runClaim(msg.chat.id, true);
});

bot.on('message', (msg) => {
  if (!isOwner(msg)) return;
  if (!msg.text || msg.text.startsWith('/')) return;

  const state = pendingLogin[msg.chat.id];
  if (!state) return;

  if (state.step === 'phone') {
    const phone = msg.text.trim();
    if (!/^\d{6,15}$/.test(phone)) {
      bot.sendMessage(msg.chat.id, '❌ Sotik phone number din (country code chara, jemon: 1713882071)');
      return;
    }
    state.phone = phone;
    state.step = 'password';
    bot.sendMessage(msg.chat.id, '🔒 Ekhon password din:');
  } else if (state.step === 'password') {
    const password = msg.text.trim();
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    bot.sendMessage(msg.chat.id, '⏳ Login hocche...');

    apiLogin(state.phone, password).then(result => {
      delete pendingLogin[msg.chat.id];
      if (result.success) {
        creds.phone = state.phone;
        creds.password = password;
        creds.token = result.token;
        authToken = result.token;
        saveCredentials(creds);
        bot.sendMessage(msg.chat.id, '✅ Login successful!', mainMenu());
      } else {
        bot.sendMessage(msg.chat.id, `❌ Login failed: ${result.error}`, mainMenu());
      }
    });
  }
});

function startLoginFlow(chatId) {
  pendingLogin[chatId] = { step: 'phone' };
  bot.sendMessage(chatId, '📱 Country code chara phone number din (jemon: 1713882071):');
}

function doLogout(chatId) {
  autoClaimOn = false;
  if (claimTimer) {
    clearTimeout(claimTimer);
    claimTimer = null;
  }
  creds = { phone: null, password: null, token: null, autoClaimOn: false };
  authToken = null;
  saveCredentials(creds);
  bot.sendMessage(chatId, '🚪 Logout hoyeche.', mainMenu());
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  if (String(chatId) !== String(OWNER_ID)) {
    return bot.answerCallbackQuery(query.id, { text: 'Authorized na.' });
  }

  if (query.data === 'login_start') {
    startLoginFlow(chatId);
  } else if (query.data === 'logout') {
    doLogout(chatId);
  } else if (query.data === 'toggle') {
    if (!isLoggedIn()) {
      bot.answerCallbackQuery(query.id, { text: 'Age login korun.' });
      return;
    }
    if (autoClaimOn) turnOff(chatId);
    else turnOn(chatId);
  } else if (query.data === 'claim_now') {
    if (!isLoggedIn()) {
      bot.answerCallbackQuery(query.id, { text: 'Age login korun.' });
      return;
    }
    bot.answerCallbackQuery(query.id, { text: 'Claim shuru hocche...' });
    runClaim(chatId, true);
    return;
  } else if (query.data === 'status') {
    sendStatus(chatId);
  }

  bot.answerCallbackQuery(query.id);
});

function sendStatus(chatId) {
  const nextClaim = autoClaimOn && lastClaimTime
    ? new Date(lastClaimTime.getTime() + 3 * 60 * 60 * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })
    : 'N/A';

  const text =
    `📊 *Status*\n\n` +
    `Login: ${isLoggedIn() ? '✅ ' + maskPhone(creds.phone) : '❌ Login kora nai'}\n` +
    `Auto Claim: ${autoClaimOn ? '🟢 ON' : '🔴 OFF'}\n` +
    `Last Claim: ${lastClaimTime ? lastClaimTime.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' }) : 'Kono din na'}\n` +
    `Last Result: ${lastClaimStatus}\n` +
    `Next Claim (approx): ${nextClaim}`;

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...mainMenu() });
}

function turnOn(chatId) {
  if (!isLoggedIn()) {
    bot.sendMessage(chatId, '❌ Age /login diye login korun.', mainMenu());
    return;
  }
  if (autoClaimOn) {
    bot.sendMessage(chatId, 'Already ON ache.', mainMenu());
    return;
  }
  autoClaimOn = true;
  creds.autoClaimOn = true;
  saveCredentials(creds);
  bot.sendMessage(chatId, '🟢 Auto Claim ON kora holo. Prothom claim ekhoni shuru hocche.', mainMenu());
  runClaim(chatId, false);
  scheduleNext();
}

function turnOff(chatId) {
  autoClaimOn = false;
  creds.autoClaimOn = false;
  saveCredentials(creds);
  if (claimTimer) {
    clearTimeout(claimTimer);
    claimTimer = null;
  }
  bot.sendMessage(chatId, '🔴 Auto Claim OFF kora holo.', mainMenu());
}

function scheduleNext() {
  if (claimTimer) clearTimeout(claimTimer);
  if (!autoClaimOn) return;
  claimTimer = setTimeout(() => {
    runClaim(OWNER_ID, false);
    scheduleNext();
  }, 3 * 60 * 60 * 1000);
}

if (autoClaimOn && isLoggedIn()) {
  console.log('Auto claim was ON, resuming...');
  scheduleNext();
}

async function runClaim(chatId, manual) {
  if (!isLoggedIn()) {
    bot.sendMessage(chatId, '❌ Age /login diye login korun.');
    return;
  }
  if (isClaiming) {
    bot.sendMessage(chatId, '⏳ Ager claim ekhono cholche, wait korun.');
    return;
  }
  isClaiming = true;
  bot.sendMessage(chatId, '⏳ Claim hocche...');

  try {
    const result = await apiClaim();
    lastClaimTime = new Date();
    if (result.success) {
      lastClaimStatus = '✅ Success';
      bot.sendMessage(chatId, '✅ Claim successful hoyeche!');
    } else {
      lastClaimStatus = `❌ ${result.error}`;
      bot.sendMessage(chatId, `❌ Error: ${result.error}`);
    }
  } catch (err) {
    lastClaimTime = new Date();
    lastClaimStatus = `❌ Error: ${err.message}`;
    bot.sendMessage(chatId, `❌ Error hoyeche: ${err.message}`);
  } finally {
    isClaiming = false;
  }
}

console.log('Bot v2 started.');
