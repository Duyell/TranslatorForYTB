// offscreen/offscreen.js — 实时语音识别(ASR)的音频采集与识别端。
// 职责:
//   1. 用 chromeMediaSource 约束消费 SW 传来的标签页音频 streamId,
//      重采样为 16kHz 单声道 PCM;
//   2. 每 CHUNK_SECONDS 秒开一条火山流式识别 WebSocket 会话
//      (bigmodel_nostream 模式:音频帧流式发送 + 末帧触发返回,支持日语),
//      识别文本经 background 转发给内容脚本。
// 鉴权:浏览器 WebSocket 无法自定义握手头,鉴权头(X-Api-Key 等)由 background
// 通过 declarativeNetRequest 会话规则注入握手请求。
// 生命周期:SW 用 chrome.offscreen.createDocument 创建本页;停止时 SW 关闭本页。
// 协议格式见火山官方文档「流式语音识别」(4 字节头 + 大端长度 + payload)。

'use strict';

const CHUNK_SECONDS = 7; // 每个识别分块的音频时长(秒):越大延迟越高、切词越少
const WS_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const SAMPLE_RATE = 16000;

let audioCtx = null;
let source = null;
let processor = null;
let playback = null;      // 捕获音频的回放元素(见 startCapture 内的说明)
let pcmChunks = [];       // Int16 采样累积缓冲
let timer = null;
let busy = false;         // 上一块还在识别时跳过本次(音频会并入下一块)
let language = 'ja-JP';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'asrInit') {
    language = msg.language || 'ja-JP';
    startCapture(msg.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 异步响应
  }
  if (msg && msg.type === 'asrTestRun') {
    // 设置页「测试识别 Key」:用 1 秒静音跑一次完整会话
    runSession(new Uint8Array(SAMPLE_RATE * 2), msg.language || 'ja-JP')
      .then((r) => sendResponse({ ok: !r.error, text: r.error ? '' : 'Key 有效 ✓', error: r.error }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

async function startCapture(streamId) {
  // 消费 SW 申请的标签页音频流(chromeMediaSource 约束仅在扩展页可用)
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // 统一重采样到 16kHz(火山只收 16k),AudioContext 自动完成 48k→16k
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  source = audioCtx.createMediaStreamSource(stream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  source.connect(processor);
  processor.connect(audioCtx.destination); // 不接 destination 部分浏览器不回调

  // 关键:tabCapture 捕获时 Chrome 会静音标签页,必须把音频播回扬声器,
  // 否则用户听不到任何声音。tabCapture 权限的扩展不受自动播放策略限制。
  playback = new Audio();
  playback.srcObject = stream;
  playback.play().catch(() => { /* 播放被拒时至少识别还能工作 */ });

  // Float32(-1..1) → Int16 PCM
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    pcmChunks.push(pcm);
  };

  // 每 7 秒把累积的 PCM 送去识别;启动后 3 秒先送一小块,首条字幕更快出
  timer = setInterval(flushChunk, CHUNK_SECONDS * 1000);
  setTimeout(flushChunk, 3000);
}

// 取出累积 PCM,合并成 Uint8Array 送识别(上一块未完成则跳过,音频自然并入下一块)
function flushChunk() {
  if (busy || !pcmChunks.length) return;
  const total = pcmChunks.reduce((n, c) => n + c.length, 0);
  if (total < SAMPLE_RATE * 2) return; // 少于 2 秒不送
  let pcm = new Int16Array(total);
  let offset = 0;
  for (const c of pcmChunks) { pcm.set(c, offset); offset += c.length; }
  pcmChunks = [];

  // 缓冲过长只留最后 30 秒(识别会话意外变慢时防止积压失控)
  const MAX_KEEP = SAMPLE_RATE * 30;
  if (pcm.length > MAX_KEEP) pcm = pcm.subarray(pcm.length - MAX_KEEP);

  // 静音检测:主播长时间不说话时缓冲里大部分是静音,
  // 只送有效语音段,否则几十秒静音会拖慢识别甚至超时丢结果
  const speech = trimSilence(pcm);
  if (!speech || speech.length < SAMPLE_RATE * 0.4) return; // 无有效语音(或过短)不送

  busy = true;
  console.log('[YTSUB-ASR] 发送音频块:' + Math.round(speech.length / SAMPLE_RATE * 10) / 10 + ' 秒');
  runSession(new Uint8Array(speech.buffer, speech.byteOffset, speech.byteLength), language)
    .then((r) => {
      busy = false;
      console.log('[YTSUB-ASR] 识别会话结束: text=' + JSON.stringify((r.text || '').slice(0, 30)) + ' error=' + (r.error || '').slice(0, 60));
      // 结果(或错误)交给 background 转发给内容脚本
      chrome.runtime.sendMessage({ type: 'asrChunkResult', text: r.text || '', error: r.error || '' })
        .catch(() => { /* SW 未就绪,丢这一块 */ });
    })
    .catch(() => { busy = false; });
}

// 按 20ms 帧的能量裁剪静音:返回第一个有效帧到最后一个有效帧之间的音频
// (前后各留 200ms 边距);全程静音返回 null
function trimSilence(pcm) {
  const frameLen = SAMPLE_RATE / 50; // 20ms
  const energies = [];
  for (let i = 0; i < pcm.length; i += frameLen) {
    const end = Math.min(i + frameLen, pcm.length);
    let sum = 0;
    for (let j = i; j < end; j++) sum += pcm[j] * pcm[j];
    energies.push(Math.sqrt(sum / (end - i)));
  }
  // 阈值取全局最大能量的 4%,下限 300(覆盖底噪)
  let maxE = 0;
  for (const e of energies) if (e > maxE) maxE = e;
  const threshold = Math.max(300, maxE * 0.04);
  let first = -1;
  let last = -1;
  for (let i = 0; i < energies.length; i++) {
    if (energies[i] >= threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null; // 全程静音
  const pad = 10; // 前后各留 10 帧(200ms)边距
  first = Math.max(0, first - pad);
  last = Math.min(energies.length - 1, last + pad);
  return pcm.subarray(first * frameLen, (last + 1) * frameLen);
}

// ---------- 火山流式识别协议 ----------

// 客户端帧:4 字节头 + 4 字节大端 payload 长度 + payload(无 sequence 字段)
// 头字节: [0]=0x11(协议v1|头长4) [1]=(消息类型<<4)|flags [2]=(序列化<<4)|压缩 [3]=0x00
function buildFullClient(payloadJson) {
  const payload = new TextEncoder().encode(payloadJson);
  const buf = new Uint8Array(8 + payload.length);
  buf[0] = 0x11; buf[1] = 0x10; buf[2] = 0x10; buf[3] = 0x00; // full client request, JSON, 无压缩
  new DataView(buf.buffer).setUint32(4, payload.length);       // 大端
  buf.set(payload, 8);
  return buf;
}

function buildAudio(pcm, isLast) {
  const buf = new Uint8Array(8 + pcm.length);
  buf[0] = 0x11; buf[1] = isLast ? 0x22 : 0x20; buf[2] = 0x00; buf[3] = 0x00; // audio-only,末帧 flags=2
  new DataView(buf.buffer).setUint32(4, pcm.length);
  buf.set(pcm, 8);
  return buf;
}

// 解析服务端响应帧:4 字节头;flags∈{1,2,3} 带 4 字节 sequence;
// type 0x9 = 识别结果(JSON)/ 0xF = 错误帧(4B 错误码 + 4B 长度 + 文本)
function parseServerFrames(bytes) {
  const out = [];
  let off = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  while (off + 4 <= bytes.length) {
    const type = bytes[off + 1] >> 4;
    const flags = bytes[off + 1] & 0x0f;
    off += 4;
    if (flags === 1 || flags === 2 || flags === 3) off += 4; // sequence
    if (type === 0xf) {
      if (off + 8 > bytes.length) break;
      const code = view.getUint32(off);
      const size = view.getUint32(off + 4);
      off += 8;
      out.push({ error: true, code, msg: new TextDecoder().decode(bytes.subarray(off, off + size)) });
      off += size;
    } else {
      if (off + 4 > bytes.length) break;
      const size = view.getUint32(off);
      off += 4;
      if (off + size > bytes.length) break;
      try {
        out.push({ json: JSON.parse(new TextDecoder().decode(bytes.subarray(off, off + size))) });
      } catch { /* 忽略无法解析的帧 */ }
      off += size;
    }
  }
  return out;
}

// 一次识别会话:开 WS → 全量请求 → 音频帧(200ms 一帧)→ 末帧 → 收集结果
// 返回 {text, error}:text 为最后一个非空识别文本,error 为服务端错误信息
function runSession(pcmBytes, lang) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* 忽略 */ }
      resolve(result);
    };

    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    const received = [];

    ws.onopen = () => {
      try {
        const req = {
          user: { uid: 'translator-for-browser' },
          audio: { format: 'pcm', sample_rate: SAMPLE_RATE, rate: SAMPLE_RATE, bits: 16, channel: 1, language: lang || 'ja-JP' },
          request: {
            reqid: crypto.randomUUID(),
            sequence: 1,
            model_name: 'bigmodel',
            enable_punc: true,
            enable_itn: true,
            show_utterances: true,
          },
        };
        ws.send(buildFullClient(JSON.stringify(req)));
        const frameSize = SAMPLE_RATE * 2 / 5; // 200ms 一帧(单包 100~200ms 性能最优)
        for (let i = 0; i < pcmBytes.length; i += frameSize) {
          ws.send(buildAudio(pcmBytes.subarray(i, i + frameSize), false));
        }
        ws.send(buildAudio(new Uint8Array(0), true)); // 末帧(负包)触发返回
      } catch (err) {
        finish({ text: '', error: String(err) });
      }
    };

    ws.onmessage = (e) => { received.push(new Uint8Array(e.data)); };
    ws.onclose = () => { finish(collectResult(received)); };
    ws.onerror = () => { finish({ text: '', error: '连接语音识别服务失败(网络/鉴权)' }); };
    setTimeout(() => finish(collectResult(received)), 25000); // 兜底超时(长语音段识别较慢)
  });
}

function collectResult(received) {
  if (!received.length) return { text: '', error: '' };
  const all = new Uint8Array(received.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of received) { all.set(c, offset); offset += c.length; }
  const frames = parseServerFrames(all);
  let lastText = '';
  let error = '';
  for (const f of frames) {
    if (f.error) {
      error = '识别服务错误(' + f.code + '): ' + f.msg.slice(0, 120);
    } else if (f.json && f.json.result && f.json.result.text) {
      lastText = f.json.result.text;
    }
  }
  return { text: lastText.trim(), error };
}

// 页面被关闭时清理
window.addEventListener('pagehide', () => {
  if (timer) clearInterval(timer);
  if (playback) { try { playback.pause(); playback.srcObject = null; } catch { /* 忽略 */ } }
  if (source) { try { source.disconnect(); } catch { /* 忽略 */ } }
  if (audioCtx) { try { audioCtx.close(); } catch { /* 忽略 */ } }
});
