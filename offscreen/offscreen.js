// offscreen/offscreen.js — 实时语音识别(ASR)的音频采集端。
// 职责:用 chromeMediaSource 约束消费 SW 传来的 tab 音频 streamId,
// 把标签页声音重采样为 16kHz 单声道 PCM,每 CHUNK_SECONDS 秒封装成 WAV
// (Base64)发给 background.js 调火山引擎极速版识别。
// 生命周期:SW 通过 chrome.offscreen.createDocument 创建本页并传入 streamId;
// 停止时 SW 直接关闭本页,采集随页面销毁而结束。

'use strict';

const CHUNK_SECONDS = 7; // 每个识别分块的音频时长(秒);越大延迟越高、切词越少

let audioCtx = null;
let source = null;
let processor = null;
let pcmChunks = [];       // Int16 采样累积缓冲
let timer = null;

// 监听 SW 的启动消息(通过 runtime 消息,异步拿 streamId 后用 getUserMedia 消费)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'asrInit') {
    startCapture(msg.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 异步响应
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
  audioCtx = new AudioContext({ sampleRate: 16000 });
  source = audioCtx.createMediaStreamSource(stream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  source.connect(processor);
  processor.connect(audioCtx.destination); // 不接 destination 部分浏览器不回调

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

  // 每 7 秒把累积的 PCM 封装成 WAV 发给 SW 识别
  timer = setInterval(flushChunk, CHUNK_SECONDS * 1000);
  console.log('[YTSUB-ASR] 音频采集已启动');
}

function flushChunk() {
  if (!pcmChunks.length) return;
  const total = pcmChunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const c of pcmChunks) { pcm.set(c, offset); offset += c.length; }
  pcmChunks = [];

  // 16kHz 单声道 16bit WAV 封装(44 字节头 + PCM)
  const wav = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(wav.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt 块大小
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // 单声道
  view.setUint32(24, 16000, true);       // 采样率
  view.setUint32(28, 32000, true);       // 字节率
  view.setUint16(32, 2, true);           // 块对齐
  view.setUint16(34, 16, true);          // 位深
  writeAscii(view, 36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(wav.buffer, 44).set(pcm);

  // 二进制 → Base64 字符串(消息传输用)
  let bin = '';
  for (let i = 0; i < wav.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, wav.subarray(i, i + 0x8000));
  }
  const base64 = btoa(bin);

  chrome.runtime.sendMessage({ type: 'asrAudio', wavBase64: base64, seq: Date.now() })
    .catch(() => { /* SW 未就绪等,丢这一块,下一块继续 */ });
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// 页面被关闭时清理
window.addEventListener('pagehide', () => {
  if (timer) clearInterval(timer);
  if (source) { try { source.disconnect(); } catch { /* 忽略 */ } }
  if (audioCtx) { try { audioCtx.close(); } catch { /* 忽略 */ } }
});
