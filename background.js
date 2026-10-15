// background.js — 服务工作者:翻译代理 + 工具栏按钮开关 + badge 状态。
// 翻译调用统一走这里:host_permissions 已授权 translate.googleapis.com(无 CORS),
// 自定义 OpenAI 兼容 API 走 optional_host_permissions(设置页保存时按需授权)。
// 安全:翻译请求不接受调用方传入的任何 URL / Key,一律读取本地设置。
// badge:绿色「开」/灰色「关」显示当前标签页的字幕翻译开关状态。

'use strict';

// ---------- 设置 ----------

const DEFAULT_SETTINGS = {
  engine: 'google',
  customBaseUrl: '',
  customApiKey: '',
  customModel: '',
  showOriginal: true,
  fontSize: 20,
  enabled: true,
  asrApiKey: '',    // 语音识别:新版豆包语音控制台签发的 API Key(火山方舟的 Key 不通用)
  asrLanguage: 'ja-JP', // 识别语言;留空 = 自动检测
  translateChat: true,  // 直播聊天评论翻译
};

let settings = null; // 设置缓存(SW 常被回收,首次使用时从 storage 读)

async function getSettings() {
  if (settings) return settings;
  const { settings: saved } = await chrome.storage.local.get('settings');
  settings = Object.assign({}, DEFAULT_SETTINGS, saved || {});
  return settings;
}

// 设置页保存后刷新缓存
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue || {});
  }
});

// ---------- 消息处理 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'translate' || msg.type === 'testTranslate') {
    // 异步翻译,return true 保持消息通道;priority='low' 走聊天低优先级队列
    translateText(msg.text, msg.priority)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === 'asrStart') {
    startAsr(sender.tab && sender.tab.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === 'asrStop') {
    stopAsr().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'asrChunkResult') {
    // 来自 offscreen 文档的识别结果:sender.tab 不存在,结果转发用 asrTabId
    handleAsrChunkResult(msg)
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === 'asrTest') {
    // 设置页「测试识别」:静音音频走一次完整 WS 识别,探测 Key 有效性
    testAsrKey()
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
});

// ---------- 翻译实现 ----------

const MAX_TEXT_LEN = 6000;      // 单次翻译文本上限(防滥用)
const GOOGLE_CHUNK_LEN = 4500;  // Google 接口单请求字符上限(~5000)
const GOOGLE_MIN_INTERVAL = 350; // Google 请求最小间隔(ms),防限流
const GOOGLE_FETCH_TIMEOUT = 8000; // 单次请求超时(ms)
const GOOGLE_BACKOFF = [1500]; // 429/503 退避(ms):只重试一次,保证单条最坏 ~17 秒内返回
// 注意:内容脚本侧有 20 秒无响应判失败,SW 单条耗时必须小于它,否则重试会雪崩
const FETCH_TIMEOUT = 12000;    // 单次请求超时(ms):防止连接挂起把翻译队列永久卡死

let lastGoogleCall = 0;
let googleBusy = Promise.resolve(); // 高优先级链(字幕翻译)
let chatBusy = Promise.resolve();   // 低优先级链(直播聊天翻译,不与字幕抢速)

// 带超时的 fetch:代理/网络把连接挂起时,超时后走重试,而不是永远等下去
async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function translateText(text, priority) {
  if (typeof text !== 'string') throw new Error('翻译内容必须是文本');
  text = text.trim();
  if (!text) throw new Error('翻译内容为空');
  if (text.length > MAX_TEXT_LEN) throw new Error('文本过长');
  const s = await getSettings();
  if (s.engine === 'custom') {
    if (!s.customBaseUrl || !s.customApiKey || !s.customModel) {
      throw new Error('请先在设置页填写 API Base URL / Key / 模型名');
    }
    return customTranslate(s, text);
  }
  return googleTranslate(text, priority === 'low');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 字幕走 googleBusy(高优先级),聊天走 chatBusy(低优先级);
// 两条链共享 lastGoogleCall 节流时间戳,保证总速率受控且字幕优先
function googleTranslate(text, lowPriority) {
  const run = (lowPriority ? chatBusy : googleBusy).then(async () => {
    const chunks = chunkBySentence(text, GOOGLE_CHUNK_LEN);
    const parts = [];
    for (const chunk of chunks) {
      const wait = lastGoogleCall + GOOGLE_MIN_INTERVAL - Date.now();
      if (wait > 0) await sleep(wait);
      lastGoogleCall = Date.now();
      parts.push(await googleRequest(chunk));
    }
    return parts.join('');
  });
  if (lowPriority) chatBusy = run.catch(() => {});   // 错误不断链,后续请求继续执行
  else googleBusy = run.catch(() => {});
  return run;
}

// 按句边界切成 ≤maxLen 的块(日语句子分隔符:。!?…、换行)
function chunkBySentence(text, maxLen) {
  const sentences = text.match(/[^。!?！？…\n]+[。!?！？…]?|\n+/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > maxLen && cur) {
      chunks.push(cur);
      cur = s;
      // 单句仍超长:硬切
      while (cur.length > maxLen) {
        chunks.push(cur.slice(0, maxLen));
        cur = cur.slice(maxLen);
      }
    } else {
      cur += s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function googleRequest(chunk) {
  // 源语言按文本特征判断:英文字母占多数 → 英译中,否则日译中。
  // (sl=auto 会把含汉字的日语句子误判成中文而原样返回,不如自己判断)
  const asciiCount = (chunk.match(/[a-zA-Z]/g) || []).length;
  const sl = asciiCount > chunk.length * 0.5 ? 'en' : 'ja';
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + sl + '&tl=zh-CN&dt=t&q=' + encodeURIComponent(chunk);
  for (let attempt = 0; attempt <= GOOGLE_BACKOFF.length; attempt++) {
    if (attempt > 0) await sleep(GOOGLE_BACKOFF[attempt - 1]);
    let res;
    try {
      res = await fetchWithTimeout(url, null, GOOGLE_FETCH_TIMEOUT);
    } catch (e) {
      if (attempt < GOOGLE_BACKOFF.length) continue; // 网络错误/超时,退避重试
      throw new Error('网络不通或请求超时,无法访问 Google 翻译(请检查代理)');
    }
    if (res.status === 429 || res.status === 503) continue; // 限流,退避重试
    if (!res.ok) throw new Error(`Google 翻译服务错误(${res.status})`);
    const data = await res.json();
    const text = (data[0] || []).map((it) => (it && it[0]) || '').join('');
    if (!text) {
      if (attempt < GOOGLE_BACKOFF.length) continue;
      throw new Error('Google 翻译返回为空');
    }
    return text;
  }
  throw new Error('Google 翻译暂时限流,稍后自动重试');
}

async function customTranslate(s, text) {
  const base = s.customBaseUrl.trim().replace(/\/+$/, '');
  const url = /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + s.customApiKey.trim(),
      },
      body: JSON.stringify({
        model: s.customModel.trim(),
        messages: [
          { role: 'system', content: '你是字幕翻译。把日语或英语字幕翻译成简体中文。只输出译文,不要解释,不要附原文。' },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
      }),
    }, FETCH_TIMEOUT);
  } catch (e) {
    throw new Error('网络不通、请求超时或该 API 不允许浏览器跨域,请在设置页点「保存」授权域名');
  }
  if (res.status === 401) throw new Error('API Key 无效,请检查设置');
  if (res.status === 404) throw new Error('接口未找到,请检查 Base URL / 模型名');
  if (!res.ok) throw new Error(`API 错误(${res.status})`);
  const data = await res.json();
  const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!out) throw new Error('API 返回为空,请检查模型名');
  return String(out).trim();
}

// ---------- 实时语音识别(ASR,火山流式识别大模型) ----------

const ASR_RESOURCE_ID = 'volc.seedasr.sauc.duration'; // 流式识别 2.0 资源 ID
const ASR_WS_RULE_ID = 991; // DNR 会话规则 id(给 WS 握手注入鉴权头)

let asrTabId = null; // 正在采集音频的目标标签页 id

// 浏览器 WebSocket 无法自定义握手头 → 用 DNR 会话规则给 openspeech 的 WS
// 握手请求注入 X-Api-Key / X-Api-Resource-Id 鉴权头
async function applyAsrDnrRules() {
  const s = await getSettings();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ASR_WS_RULE_ID],
    addRules: [{
      id: ASR_WS_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'X-Api-Key', operation: 'set', value: s.asrApiKey.trim() },
          { header: 'X-Api-Resource-Id', operation: 'set', value: ASR_RESOURCE_ID },
        ],
      },
      condition: {
        urlFilter: '||openspeech.bytedance.com',
        resourceTypes: ['websocket'],
      },
    }],
  });
}

async function removeAsrDnrRules() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ASR_WS_RULE_ID] });
  } catch { /* 规则本就不存在 */ }
}

// 内容脚本请求开启 ASR:注入鉴权规则 → 申请标签页音频流 → 建 offscreen 文档消费
async function startAsr(tabId) {
  if (tabId == null) throw new Error('无法确定目标标签页');
  const s = await getSettings();
  if (!s.asrApiKey) throw new Error('未配置语音识别 API Key(设置页 → 语音识别)');
  if (asrTabId === tabId && (await hasOffscreen())) return; // 已在运行
  await stopAsr(); // 先清掉上一轮(切换标签/重启采集)
  await applyAsrDnrRules();
  // Chrome 116+:SW 可带 targetTabId 直接申请流,无需用户手势
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    console.log('[YTSUB] startAsr(自动路径) 申请流:成功');
  } catch (err) {
    console.log('[YTSUB] startAsr(自动路径) 申请流:失败 —', err.message || String(err));
    throw new Error('无法捕获标签页音频: ' + (err.message || String(err)));
  }
  await createOffscreen();
  const resp = await chrome.runtime.sendMessage({ type: 'asrInit', streamId, language: s.asrLanguage || 'ja-JP' });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || '音频采集启动失败');
  asrTabId = tabId;
}

async function stopAsr() {
  asrTabId = null;
  await removeAsrDnrRules();
  try { await chrome.offscreen.closeDocument(); } catch { /* 已关闭 */ }
}

async function hasOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function createOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '采集标签页音频用于实时语音识别(无字幕时的兜底方案)',
  });
}

// offscreen 每 7 秒发来一块识别结果 → 转发给内容脚本
async function handleAsrChunkResult(msg) {
  const tabId = asrTabId;
  if (tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'asrResult', text: msg.text || '', error: msg.error || '' });
    } catch { /* 标签已关闭 */ }
  }
  return { ok: true };
}

// 设置页「测试识别」:让 offscreen 用 1 秒静音跑一次完整识别会话,
// 静音无文本无错误 = Key 有效;有错误帧 = Key/资源有问题
async function testAsrKey() {
  const s = await getSettings();
  if (!s.asrApiKey) throw new Error('请先填写语音识别 API Key');
  const wasRunning = await hasOffscreen();
  await applyAsrDnrRules();
  try {
    if (!wasRunning) await createOffscreen();
    const resp = await chrome.runtime.sendMessage({ type: 'asrTestRun', language: s.asrLanguage || 'ja-JP' });
    if (!resp) throw new Error('语音识别服务无响应');
    if (!resp.ok) {
      const err = resp.error || '未知错误';
      if (/45000030|not granted/.test(err)) throw new Error('Key 有效但未开通「流式语音识别-大模型」服务,请到豆包语音控制台开通');
      if (/401|403|Invalid/.test(err)) throw new Error('Key 无效或不是豆包语音控制台签发的 Key');
      throw new Error(err);
    }
    return { ok: true, text: resp.text || 'Key 有效 ✓' };
  } finally {
    if (!wasRunning) await stopAsr(); // 测试完把 offscreen 关掉(除非 ASR 本来就在跑)
  }
}

// ---------- 工具栏按钮 ----------

const YOUTUBE_RE = /^https?:\/\/(www|m)\.youtube\.com\//i;

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && YOUTUBE_RE.test(tab.url)) {
    // 先在手势上下文里立刻申请标签页音频流(tabCapture 对时序敏感,
    // 任何 await 都可能错失授权窗口):需要授权时直接用它启动 ASR,
    // 不需要时丢弃(未消费的流会自动过期,无副作用)
    let preStreamId = null;
    try {
      preStreamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      console.log('[YTSUB] 点击预申请流:成功');
    } catch (err) {
      console.log('[YTSUB] 点击预申请流:失败 —', err.message || String(err));
    }
    let state = null;
    try { state = await chrome.tabs.sendMessage(tab.id, { type: 'getState' }); } catch { /* 未就绪 */ }
    if (state && state.enabled) {
      // 扩展已开启且语音识别等待授权时,本次点击用于「授权并启动 ASR」而不是开关
      try {
        const auth = await chrome.tabs.sendMessage(tab.id, { type: 'getAsrAuthState' });
        if (auth && auth.needsAuth) {
          await authorizeAsr(tab.id, preStreamId);
          return;
        }
      } catch { /* 未就绪,走普通开关 */ }
    }
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
      updateBadge(tab.id, resp && resp.enabled);
    } catch {
      // 内容脚本未就绪(页面刚加载):刷新 badge 即可,用户再点一次即生效
      updateBadge(tab.id);
    }
  } else {
    chrome.runtime.openOptionsPage();
  }
});

// 用户手势上下文里授权标签页音频并启动 ASR(preStreamId 为点击时预申请的流)
async function authorizeAsr(tabId, preStreamId) {
  try {
    const s = await getSettings();
    if (!s.asrApiKey) throw new Error('未配置语音识别 API Key(设置页 → 语音识别)');
    await applyAsrDnrRules();
    let streamId = preStreamId;
    if (!streamId) {
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        console.log('[YTSUB] authorizeAsr 申请流:成功');
      } catch (err) {
        // 授权状态可能晚于点击处理器生效:稍等重试一次
        console.log('[YTSUB] authorizeAsr 申请流:失败 —', err.message || String(err));
        await sleep(600);
        try {
          streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
          console.log('[YTSUB] authorizeAsr 重试申请流:成功');
        } catch (err2) {
          console.log('[YTSUB] authorizeAsr 重试申请流:失败 —', err2.message || String(err2));
          throw err2;
        }
      }
    }
    await createOffscreen();
    const resp = await chrome.runtime.sendMessage({ type: 'asrInit', streamId, language: s.asrLanguage || 'ja-JP' });
    console.log('[YTSUB] asrInit 响应:', resp ? (resp.ok ? '成功' : '失败 — ' + (resp.error || '')) : '无响应');
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || '音频采集启动失败');
    asrTabId = tabId;
    await chrome.tabs.sendMessage(tabId, { type: 'asrReady' });
    updateBadge(tabId, true);
  } catch (err) {
    console.log('[YTSUB] authorizeAsr 最终失败:', err.message || String(err));
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'asrAuthFailed', error: err.message || String(err) });
    } catch { /* 标签已关闭 */ }
  }
}

// ---------- badge ----------

async function updateBadge(tabId, enabled) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; } // 标签已关闭
  if (enabled == null) {
    if (!tab.url || !YOUTUBE_RE.test(tab.url)) {
      chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: 'getState' });
      enabled = resp ? resp.enabled : null;
    } catch {
      enabled = null; // 内容脚本不在 → 不显示 badge
    }
  }
  if (enabled == null) {
    chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  chrome.action.setBadgeText({ tabId, text: enabled ? '开' : '关' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: enabled ? '#16a34a' : '#6b7280' });
}

chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // 页面加载完成后内容脚本就绪,刷新一次 badge
  if (info.status === 'complete') updateBadge(tabId);
});
