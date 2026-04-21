// ==UserScript==
// @name         MSE_Video_Catcher
// @name:zh-CN   MSE视频缓存工具
// @namespace    https://greasyfork.org/zh-CN/users/135090
// @version      0.3.3
// @description  智能拦截MSE明文分片，缓存完自动下载
// @author       zwb
// @match        https://*.ipanda.com/*V*.shtml*
// @match        https://*.cctv.cn/*V*.shtml*
// @match        https://*.cctv.com/*V*.shtml*
// @match        https://*.12371.cn/*V*.shtml*
// @match        https://*.bilibili.com/video/*
// @match        https://*.acfun.cn/v/ac*
// @match        https://www.douyin.com/video/*
// @grant        none
// @run-at       document-start
// @license      LGPL-3
// @downloadURL https://update.greasyfork.org/scripts/438368/MSE_Video_Catcher.user.js
// @updateURL https://update.greasyfork.org/scripts/438368/MSE_Video_Catcher.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const S = {
        mode: null,
        chunks: [],
        totalBytes: 0,
        isCaching: false,
        isDone: false,
        hasMSE: false,
        videoEl: null,
        audioSrcCreated: false,
        recorder: null,
        recChunks: [],
        startTime: 0,
        origRate: 1,
        origVol: 1,
        origMuted: false,
        hasAudioStream: false,
        audioChunks: [],
        audioTotalBytes: 0,
        audioMimeType: null,
    };

    const fmtB = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(2) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';

    function bufPct(v) {
        if (!v || !isFinite(v.duration) || v.duration <= 0) return 0;
        try {
            const b = v.buffered;
            if (!b.length) return 0;
            let t = 0;
            for (let i = 0; i < b.length; i++) t += b.end(i) - b.start(i);
            return Math.min(100, t / v.duration * 100);
        } catch (e) {  console.info(e); return 0;}
    }

    function parseBoxesWithSidx(u8) {
        const out = [];
        let off = 0;
        const end = u8.length;
        while (off < end) {
            if (off + 8 > end) { out.push({ type: '_partial', data: u8.slice(off) }); break; }
            const dv = new DataView(u8.buffer, u8.byteOffset + off, Math.min(end - off, 16));
            let sz = dv.getUint32(0);
            const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
            if (sz === 1) {
                if (off + 16 > end) { out.push({ type: '_partial', data: u8.slice(off) }); break; }
                sz = dv.getUint32(8) * 4294967296 + new DataView(u8.buffer, u8.byteOffset + off + 12, 4).getUint32(0);
            } else if (sz === 0) { sz = end - off; }
            if (sz < 8 || off + sz > end) { out.push({ type: '_partial', data: u8.slice(off) }); break; }
            out.push({ type, data: u8.slice(off, off + sz), offset: off, size: sz });
            off += sz;
        }
        return out;
    }

    function makeFtyp() {
        return new Uint8Array([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6F,0x6D,0,0,0,0,0x69,0x73,0x6F,0x6D,0x69,0x73,0x6F,0x32,0x6D,0x70,0x34,0x31]);
    }

    function rebuildAudioFile(audioChunks, mimeType) {
        if (!audioChunks || !audioChunks.length) return null;
        let fileExtension = 'm4a', blobType = 'audio/mp4';
        if (mimeType.includes('mp3')) { fileExtension = 'mp3'; blobType = 'audio/mpeg'; }
        else if (mimeType.includes('aac')) { fileExtension = 'aac'; blobType = 'audio/aac'; }
        else if (mimeType.includes('webm')) { fileExtension = 'weba'; blobType = 'audio/webm'; }
        else if (mimeType.includes('ogg')) { fileExtension = 'ogg'; blobType = 'audio/ogg'; }
        const totalSize = audioChunks.reduce((s, c) => s + c.length, 0);
        const result = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of audioChunks) { result.set(chunk, offset); offset += chunk.length; }
        return { blob: new Blob([result], { type: blobType }), extension: fileExtension };
    }

    function rebuildAudioMP4WithSidx(audioChunks) { return rebuildAudioFile(audioChunks, 'audio/mp4'); }

    function rebuildMP4WithSidx(chunks) {
        let ftyp = null, moov = null, tail = null;
        const frags = [], sidxBoxes = [];
        for (let i = 0; i < chunks.length; i++) {
            let data = chunks[i];
            if (tail) { const m = new Uint8Array(tail.length + data.length); m.set(tail, 0); m.set(data, tail.length); data = m; tail = null; }
            const boxes = parseBoxesWithSidx(data);
            for (const b of boxes) {
                if (b.type === '_partial') { tail = b.data; continue; }
                switch (b.type) {
                    case 'ftyp': if (!ftyp) ftyp = b.data; break;
                    case 'moov': if (!moov) moov = b.data; break;
                    case 'moof': case 'mdat': case 'emsg': case 'styp': frags.push(b); break;
                    case 'sidx': sidxBoxes.push({ data: b.data }); break;
                }
            }
        }
        if (!ftyp) ftyp = makeFtyp();
        const parts = [ftyp];
        if (moov) parts.push(moov);
        for (const sidx of sidxBoxes) parts.push(sidx.data);
        for (const frag of frags) parts.push(frag.data);
        const total = parts.reduce((s, p) => s + p.length, 0);
        if (total < 1024) return null;
        return new Blob(parts, { type: 'video/mp4' });
    }

    // MSE拦截器
    try {
        const origAddSB = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function (mime) {
            S.hasMSE = true;
            if (mime.includes('audio') || mime.includes('Audio')) {
                S.hasAudioStream = true;
                S.audioMimeType = mime;
                S.audioChunks = S.audioChunks || [];
                S.audioTotalBytes = S.audioTotalBytes || 0;
            }
            const sb = origAddSB.call(this, mime);
            const origEOS = MediaSource.prototype.endOfStream;
            this.endOfStream = function (arg) { schedDL('mse', 'MediaSource.endOfStream'); return origEOS.call(this, arg); };
            const origApp = sb.appendBuffer;
            const origAA = sb.appendBufferAsync;
            const isAudio = mime.includes('audio') || mime.includes('Audio');
            sb.appendBuffer = function (buf) {
                if (buf && buf.byteLength > 0) {
                    if (isAudio) { S.audioChunks.push(new Uint8Array(buf).slice(0)); S.audioTotalBytes += buf.byteLength; }
                    else { S.chunks.push(new Uint8Array(buf).slice(0)); S.totalBytes += buf.byteLength; }
                    S.isCaching = true;
                }
                return origApp.call(this, buf);
            };
            if (origAA) {
                sb.appendBufferAsync = function (buf) {
                    if (buf && buf.byteLength > 0) {
                        if (isAudio) { S.audioChunks.push(new Uint8Array(buf).slice(0)); S.audioTotalBytes += buf.byteLength; }
                        else { S.chunks.push(new Uint8Array(buf).slice(0)); S.totalBytes += buf.byteLength; }
                        S.isCaching = true;
                    }
                    return origAA.call(this, buf);
                };
            }
            return sb;
        };
    } catch (e) {
        console.info(e);
    }

    let _at = null;
    function schedDL(mode, reason) { if (S.isDone) return; clearTimeout(_at); _at = setTimeout(() => autoDL(mode, reason), 1000); }
    function autoDL(mode, reason) {
        if (S.isDone) return;
        S.isDone = true; S.isCaching = false;
        if (location.hostname.includes("cctv") || location.hostname.includes("12371") ){
            document.querySelectorAll("video").forEach(video => video.pause());
        }
        notify(reason+'.缓存完成，正在自动下载…');
        refreshUI();
        setTimeout(() => { finishDL(mode); restorePlay(); }, 400);
    }
    function bindEvents(v) {
        v.addEventListener('ended', () => { if (S.isCaching && !S.isDone) schedDL(S.mode || 'mse', '播放结束'); }, { once: true });
        let lp = 0;
        const pid = setInterval(() => {
            if (S.isDone || !S.isCaching) { clearInterval(pid); return; }
            const p = bufPct(v);
            if (p > lp) lp = p;
            if (p >= 99.5 && isFinite(v.duration) && v.duration > 0) {
                schedDL(S.mode || 'mse', '缓冲完成'); clearInterval(pid);
            }
        }, 1000);
    }
    function restorePlay() {
        const v = S.videoEl; if (!v) return;
        try { v.pause(); v.volume = S.origVol; v.muted = true; v.playbackRate = S.origRate; v.pause(); } catch (e) { v.pause();console.info(e); }
    }

    function createPanel() {
        if (document.getElementById('tm-p')) return;
        const d = document.createElement('div');
        d.id = 'tm-p';
        d.innerHTML = `<div id="tm-box" style="position:fixed;right:20px;top:20px;z-index:2147483647;background:#bababa;color:#333;border:1px solid #333;border-radius:8px;padding:14px 18px;width:220px;font-family:monospace;font-size:12px;">
            <div style="margin-bottom:10px;font-weight:bold;">视频缓存器</div>
            <div id="tm-mode" style="color:#555;margin-bottom:8px;font-size:11px;">点击按钮开始</div>
            <div style="display:flex;gap:12px;">
                <div><span style="color:#666;">切片</span><br><b id="tm-sc">0</b></div>
                <div><span style="color:#666;">体积</span><br><b id="tm-sb">0 B</b></div>
            </div>
            <div style="margin-top:10px;display:flex;gap:8px;">
                <button id="tm-go" style="flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;background:#333;color:#eee;font-size:12px;">开始缓存</button>
                <button id="tm-kill" style="padding:6px 12px;border:1px solid #444;border-radius:4px;cursor:pointer;background:transparent;color:#888;font-size:12px;display:none;">取消</button>
            </div>
        </div>`;
        document.body.appendChild(d);
        document.getElementById('tm-go').onclick = handleStart;
        document.getElementById('tm-kill').onclick = handleCancel;
        setInterval(refreshUI, 500);
    }

    function refreshUI() {
        const sc = document.getElementById('tm-sc'), sb = document.getElementById('tm-sb');
        const mode = document.getElementById('tm-mode'), go = document.getElementById('tm-go'), kill = document.getElementById('tm-kill');
        if (!sc) return;
        const totalChunks = S.chunks.length + (S.audioChunks?.length || 0);
        const totalSize = S.totalBytes + (S.audioTotalBytes || 0);
        sc.textContent = S.mode === 'record' ? S.recChunks.length : totalChunks;
        sb.textContent = fmtB(S.mode === 'record' ? S.recChunks.reduce((s, c) => s + c.size, 0) : totalSize);
        const modeMap = { direct: '直链下载', blob: 'Blob提取', mse: S.hasAudioStream ? '音视频分离' : 'MSE重组', record: '实时录制' };
        mode.textContent = modeMap[S.mode] || '点击按钮开始';
        if (S.isDone) { go.textContent = '已完成'; go.style.opacity = '.5'; go.style.pointerEvents = 'none'; kill.style.display = 'none'; }
        else if (S.isCaching) { go.textContent = '缓存中…'; go.style.opacity = '.5'; go.style.pointerEvents = 'none'; kill.style.display = 'block'; }
        else { go.textContent = '开始缓存'; go.style.opacity = '1'; go.style.pointerEvents = 'auto'; kill.style.display = 'none'; }
    }

    function handleStart() {
        const v = findV(); if (!v) { notify('未找到video标签'); return; }
        S.videoEl = v; S.chunks = []; S.totalBytes = 0; S.recChunks = []; S.isDone = false; S.mode = null; S.startTime = Date.now();
        let src = v.src || v.currentSrc;
        if (src && !src.startsWith('blob:')) {
            S.mode = 'direct'; S.isDone = true; notify('发现直链'); refreshUI(); dl(src, 'video_direct'); return;
        }
        if (src && src.startsWith('blob:') && !S.hasMSE) {
            S.mode = 'blob'; S.isCaching = true; refreshUI(); notify('提取Blob…');
            fetch(src).then(r => r.blob()).then(blob => {
                S.totalBytes = blob.size; S.isDone = true; S.isCaching = false; refreshUI(); dl(URL.createObjectURL(blob), 'video_blob');
            }).catch(() => { notify('Blob失败，尝试录制'); startRec(v); });
            return;
        }
        if (S.hasMSE || S.chunks.length > 0) {
            S.mode = 'mse'; S.isCaching = true; refreshUI(); v.muted = true; v.playbackRate = 8; return;
        }
        if (v.readyState >= 2) { notify('启动录制'); startRec(v); }
        else { notify('请先播放视频'); }
    }

    function handleCancel() {
        S.isCaching = false; S.isDone = false; S.chunks = []; S.recChunks = []; S.totalBytes = 0; S.startTime = 0; S.mode = null;
        if (S.recorder && S.recorder.state !== 'inactive') S.recorder.stop();
        restorePlay(); notify('已取消'); refreshUI();
    }

    function finishDL(mode) {
        const tt = document.title.replaceAll(" ", "_");
        if (mode === 'mse' && (S.chunks.length > 0 || S.audioChunks?.length > 0)) {
            if (S.chunks.length > 0) {
                const videoBlob = rebuildMP4WithSidx(S.chunks);
                if (videoBlob) dl(URL.createObjectURL(videoBlob), tt, 'm4v');
            }
            if (S.audioChunks?.length > 0) {
                setTimeout(() => {
                    const audioInfo = rebuildAudioMP4WithSidx(S.audioChunks);
                    if (audioInfo?.blob) dl(URL.createObjectURL(audioInfo.blob), tt, audioInfo.extension);
                    else {
                        const totalSize = S.audioChunks.reduce((s, c) => s + c.length, 0);
                        const combined = new Uint8Array(totalSize);
                        let offset = 0;
                        for (const chunk of S.audioChunks) { combined.set(chunk, offset); offset += chunk.length; }
                        dl(URL.createObjectURL(new Blob([combined], { type: S.audioMimeType || 'audio/mp4' })), tt, S.audioMimeType?.includes('webm') ? 'weba' : 'm4a');
                    }
                    S.audioChunks = []; S.audioTotalBytes = 0; S.audioMimeType = null;
                }, 1000);
            }
            S.chunks = []; S.totalBytes = 0; S.isCaching = false; S.hasAudioStream = false;
        }
    }

    async function startRec(v) {
        S.mode = 'record'; S.isCaching = true; S.videoEl = v; S.startTime = Date.now();
        try {
            let stream = v.captureStream ? v.captureStream() : v.mozCaptureStream();
            try {
                if (!S.audioSrcCreated) {
                    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    const src = audioCtx.createMediaElementSource(v);
                    const dest = audioCtx.createMediaStreamDestination();
                    src.connect(dest); src.connect(audioCtx.destination);
                    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
                    S.audioSrcCreated = true;
                }
            } catch (e) {console.info(e);}
            let mime = 'video/webm;codecs=vp9,opus';
            if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm;codecs=vp8,opus';
            if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm';
            const rec = new MediaRecorder(stream, { mimeType: mime });
            S.recorder = rec;
            rec.ondataavailable = e => { if (e.data?.size > 0) S.recChunks.push(e.data); };
            rec.onstop = () => {
                const blob = new Blob(S.recChunks, { type: 'video/webm' });
                S.isDone = true; S.isCaching = false; refreshUI();
                dl(URL.createObjectURL(blob), 'video_recorded', 'webm');
                restorePlay();
            };
            rec.start(1000); v.muted = true; v.play().catch(() => {});
            bindEvents(v); notify('录制已开始');
        } catch (err) { notify('录制失败: ' + err.message); restorePlay(); S.isCaching = false; refreshUI(); }
    }

    function dl(url, prefix, ext = 'mp4') {
        const a = document.createElement('a');
        a.href = url; a.download = `${prefix}.${ext}`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    function notify(msg) {
        const n = document.createElement('div');
        n.textContent = msg;
        n.style.cssText = 'position:fixed;right:20px;bottom:30px;z-index:2147483647;padding:10px 16px;background:#bababa;color:#ccc;border:1px solid #333;border-radius:6px;font-size:12px;font-family:monospace;';
        document.body.appendChild(n);
        setTimeout(() => { n.style.opacity = '0'; n.style.transition = 'opacity .3s'; setTimeout(() => n.remove(), 400); }, 3000);
    }

    function findV() {
        const vs = document.querySelectorAll('video'); if (!vs.length) return null;
        let best = null, ba = 0;
        for (const v of vs) { const a = v.offsetWidth * v.offsetHeight; if (a > ba) { ba = a; best = v; } }
        return best || vs[0];
    }

    function init() { if (!document.getElementById('tm-p')) createPanel(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 50));
    else setTimeout(init, 50);
    setTimeout(() => { if (!document.body) return; new MutationObserver(() => { if (!document.getElementById('tm-p')) init(); }).observe(document.body, { childList: true, subtree: true }); }, 0);
})();
