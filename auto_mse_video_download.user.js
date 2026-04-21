// ==UserScript==
// @name         auto_mse_video_download
// @name:zh-CN   自动缓存MSE视频
// @namespace    https://greasyfork.org/zh-CN/users/135090
// @version      1.0.1
// @description  MSE视频缓存下载功能,支持央视网,共产党员网,A站,B站等
// @author       zwb
// @match        https://*.ipanda.com/*V*.shtml*
// @match        https://*.cctv.cn/*V*.shtml*
// @match        https://*.cctv.com/*V*.shtml*
// @match        https://*.12371.cn/*V*.shtml*
// @match        https://*.bilibili.com/video/*
// @match        https://*.acfun.cn/v/ac*
// @license      LGPL
// @run-at       document-start
// @grant        GM_notification
// @downloadURL https://update.greasyfork.org/scripts/500166/auto_mse_video_download.user.js
// @updateURL https://update.greasyfork.org/scripts/500166/auto_mse_video_download.meta.js
// ==/UserScript==

(function() {
    'use strict';

    const DEBUG = false;

    function log(...args) {
        if (DEBUG) console.log('[MSE-Cache]', ...args);
    }

    function error(...args) {
        console.error('[MSE-Cache]', ...args);
    }

    // ==================== 保存原始函数 ====================
    const originalMethods = {
        addSourceBuffer: MediaSource.prototype.addSourceBuffer,
        endOfStream: MediaSource.prototype.endOfStream,
        createObjectURL: URL.createObjectURL
    };

    // ==================== 数据结构 ====================
    const mediaSourceMap = new Map();
    let currentMediaInfo = null;

    // ==================== 工具函数 ====================
    
    // 统一文件扩展名判断逻辑
    const mimeToExtension = {
        // 视频格式
        'video/mp4': 'm4v',
        'video/x-m4v': 'm4v',
        'video/quicktime': 'mov',
        'video/x-msvideo': 'avi',
        'video/x-ms-wmv': 'wmv',
        'video/x-matroska': 'mkv',
        'video/webm': 'webm',
        'video/ogg': 'ogv',
        
        // 音频格式
        'audio/mpeg': 'mp3',
        'audio/mp4': 'm4a',
        'audio/x-m4a': 'm4a',
        'audio/aac': 'aac',
        'audio/flac': 'flac',
        'audio/ogg': 'oga',
        'audio/webm': 'weba',
        'audio/wav': 'wav',
        'audio/x-wav': 'wav',
        
        // 包含codecs的常见格式
        'video/mp4; codecs="avc1': 'mp4',
        'video/mp4; codecs="hvc1': 'mp4',
        'video/mp4; codecs="hev1': 'mp4',
        'video/mp4; codecs="vp09': 'mp4',
        'video/webm; codecs="vp8': 'webm',
        'video/webm; codecs="vp9': 'webm',
        'video/webm; codecs="av1': 'webm',
        'audio/mp4; codecs="mp4a': 'm4a',
        'audio/webm; codecs="opus': 'weba',
        'audio/webm; codecs="vorbis': 'weba',
    };

    // 获取文件扩展名
    function getFileExtension(mimeType) {
        if (!mimeType) return 'bin';
        
        // 转换为小写进行比较
        const mimeLower = mimeType.toLowerCase();
        
        // 精确匹配
        for (const [key, ext] of Object.entries(mimeToExtension)) {
            if (mimeLower.includes(key.toLowerCase())) {
                return ext;
            }
        }
        
        // 通过MIME类型提取扩展名
        const mimeMatch = mimeLower.match(/\/(?:x-)?([a-z0-9]+)/);
        if (mimeMatch) {
            return mimeMatch[1];
        }
        
        return 'bin';
    }

    // 解析媒体信息
    function parseMediaInfo(mimeCodecs) {
        const mediaInfo = { 
            type: 'unknown', 
            format: 'unknown', 
            codecs: '',
            mimeCodecs: mimeCodecs
        };
        
        try {
            const tmpArr = mimeCodecs.split(';');
            const typeInfo = tmpArr[0].trim().split('/');
            
            if (typeInfo.length >= 2) {
                mediaInfo.type = typeInfo[0];
                mediaInfo.format = typeInfo[1];
            }
            
            if (tmpArr[1]) {
                const codecMatch = tmpArr[1].match(/codecs\s*=\s*["']?([^"']+)["']?/i);
                if (codecMatch) {
                    mediaInfo.codecs = codecMatch[1].trim();
                }
            }
        } catch (e) {
            error('解析媒体信息失败:', e);
        }
        
        return mediaInfo;
    }

    // 生成文件名
    function generateFilename(mediaInfo, title) {
        const baseTitle = title || document.title || 'mse_video';
        const cleanTitle = baseTitle.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '_');
        
        const ext = getFileExtension(mediaInfo.mimeCodecs);
        
        // 根据媒体类型和格式确定最终扩展名
        let finalExt = ext;
        if (mediaInfo.type === 'video') {
            if  (ext === 'mp4' || mediaInfo.format === 'mp4') {
                finalExt = 'm4v';
            } else if (ext === 'webm') {
                finalExt = 'webm';
            } else if (ext === 'ogg') {
                finalExt = 'ogv';
            }
        } else if (mediaInfo.type === 'audio') {
            if (ext === 'mp4' || mediaInfo.format === 'mp4') {
                finalExt = 'm4a';
            } else if (ext === 'webm') {
                finalExt = 'weba';
            } else if (ext === 'ogg') {
                finalExt = 'oga';
            }
        }
        
        return `${cleanTitle}.${finalExt}`;
    }

    // 下载 Blob
    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        log(`下载完成: ${filename}, 大小: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
    }

    // ==================== MSE 代理 ====================

    // 代理 MediaSource 的 addSourceBuffer 方法
    function proxyAddSourceBuffer() {
        MediaSource.prototype.addSourceBuffer = new Proxy(originalMethods.addSourceBuffer, {
            apply(target, ctx, args) {
                const mimeCodecs = args[0] || '';
                log('addSourceBuffer 被调用:', mimeCodecs);

                // 获取或创建 MediaSource 信息
                let mediaSourceInfo = mediaSourceMap.get(ctx);
                if (!mediaSourceInfo) {
                    mediaSourceInfo = {
                        mediaSource: ctx,
                        createTime: Date.now(),
                        sourceBuffers: [],
                        endOfStream: false,
                        hasDownload: false,
                        autoDownload: true,
                        mediaUrl: ctx.__objURL__ || null
                    };
                    mediaSourceMap.set(ctx, mediaSourceInfo);
                }

                const sourceBuffer = target.apply(ctx, args);
                const mediaInfo = parseMediaInfo(mimeCodecs);

                // 存储 SourceBuffer 信息
                const sourceBufferItem = {
                    mimeCodecs: mimeCodecs,
                    mediaInfo: mediaInfo,
                    originAppendBuffer: sourceBuffer.appendBuffer,
                    bufferData: [],
                    hasData: false,
                    size: 0
                };

                mediaSourceInfo.sourceBuffers.push(sourceBufferItem);

                // 代理 appendBuffer 方法
                sourceBuffer.appendBuffer = new Proxy(sourceBufferItem.originAppendBuffer, {
                    apply(bufTarget, bufCtx, bufArgs) {
                        const buffer = bufArgs[0];
                        if (buffer && buffer.byteLength) {
                            // 存储数据
                            sourceBufferItem.bufferData.push(buffer);
                            sourceBufferItem.hasData = true;
                            sourceBufferItem.size += buffer.byteLength;
                        }
                        return bufTarget.apply(bufCtx, bufArgs);
                    }
                });

                return sourceBuffer;
            }
        });
    }

    // 代理 MediaSource 的 endOfStream 方法
    function proxyEndOfStream() {
        MediaSource.prototype.endOfStream = new Proxy(originalMethods.endOfStream, {
            apply(target, ctx, args) {
                const mediaSourceInfo = mediaSourceMap.get(ctx);
                if (mediaSourceInfo) {
                    mediaSourceInfo.endOfStream = true;
                    log('媒体流加载完成，可以下载了');
                    if (mediaSourceInfo.autoDownload && !mediaSourceInfo.hasDownload) {
                        setTimeout(() => downloadMediaSource(mediaSourceInfo), 500);
                    }
                }
                return target.apply(ctx, args);
            }
        });
    }

    // 代理 URL.createObjectURL
    function proxyCreateObjectURL() {
        URL.createObjectURL = new Proxy(originalMethods.createObjectURL, {
            apply(target, ctx, args) {
                const object = args[0];
                const objectURL = target.apply(ctx, args);

                if (object instanceof MediaSource) {
                    object.__objURL__ = objectURL;
                    
                    const mediaSourceInfo = mediaSourceMap.get(object);
                    if (mediaSourceInfo) {
                        mediaSourceInfo.mediaUrl = objectURL;
                    }
                    log('创建 ObjectURL:', objectURL);
                }
                return objectURL;
            }
        });
    }

    // ==================== 下载功能 ====================

    function downloadMediaSource(mediaSourceInfo) {
        if (!mediaSourceInfo || mediaSourceInfo.hasDownload) return false;

        const hasValidData = mediaSourceInfo.sourceBuffers.some(sb => sb.hasData);
        if (!hasValidData) {
            error('没有捕获到媒体数据');
            alert('没有捕获到媒体数据，请确保视频已经播放');
            return false;
        }

        let successCount = 0;
        let totalSize = 0;

        for (const sourceBuffer of mediaSourceInfo.sourceBuffers) {
            if (!sourceBuffer.hasData || sourceBuffer.bufferData.length === 0) continue;

            const blob = new Blob(sourceBuffer.bufferData, { type: sourceBuffer.mimeCodecs });
            const filename = generateFilename(sourceBuffer.mediaInfo, currentMediaInfo?.title);
            
            log(`准备下载: ${filename}, 类型: ${sourceBuffer.mimeCodecs}, 大小: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
            
            downloadBlob(blob, filename);
            
            successCount++;
            totalSize += blob.size;

            // 清理内存
            sourceBuffer.bufferData = [];
            sourceBuffer.size = 0;
        }

        if (successCount > 0) {
            mediaSourceInfo.hasDownload = true;
            if (location.hostname.includes("cctv")){
                const videos = document.querySelectorAll('video');
                for (const video of videos) {
                    if (!video.paused) {
                        video.pause();
                        log('暂停视频');
                    }
                }
            }
            log(`下载完成: ${successCount} 个文件`);
            if (typeof GM_notification !== 'undefined') {
                GM_notification({
                    title: 'MSE 视频缓存完成',
                    text: `已保存 ${successCount} 个文件，共 ${(totalSize / 1024 / 1024).toFixed(2)} MB`,
                    timeout: 5000
                });
            }
        } else {
            alert('下载失败，没有有效的媒体数据');
        }
        return successCount > 0;
    }

    // ==================== UI 界面 ====================

    function createControlPanel() {
        const panel = document.createElement('div');
        panel.id = 'mse-cache-panel';
        panel.innerHTML = `
        <div style="
            position: fixed; top: 20px; right: 20px; z-index: 10000;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.2);
            color: white; font-family: system-ui, -apple-system, sans-serif;
            overflow: hidden; transition: all 0.3s ease;
        ">
            <div id="mse-cache-header" style="
                padding: 12px 16px; cursor: pointer;
                display: flex; align-items: center; gap: 8px; user-select: none;
            ">
                <span style="font-size: 18px;">&#128190;</span>
                <span style="font-weight: 500;">MSE 缓存工具</span>
                <span id="mse-status" style="
                    background: rgba(255,255,255,0.2); border-radius: 20px;
                    padding: 2px 8px; font-size: 11px;
                ">未检测</span>
                <span style="margin-left: 8px;">▼</span>
            </div>
            <div id="mse-cache-content" style="
                padding: 12px 16px; border-top: 1px solid rgba(255,255,255,0.2);
                display: none; flex-direction: column; gap: 10px; min-width: 260px;
            ">
                <div style="font-size: 12px; color: rgba(255,255,255,0.8);">&#128202; 捕获的媒体流:</div>
                <div id="mse-stream-list" style="
                    max-height: 200px; overflow-y: auto; font-size: 12px;
                    background: rgba(0,0,0,0.2); border-radius: 6px; padding: 8px;
                ">
                    <div style="color: rgba(255,255,255,0.6);">暂无数据</div>
                </div>
                <button id="mse-download-btn" style="
                    background: #4CAF50; border: none; color: white;
                    padding: 8px 16px; border-radius: 6px; cursor: pointer;
                    font-weight: 500; transition: all 0.2s;
                ">&#11015;&#65039; 下载捕获的视频</button>
                <button id="mse-auto-download-btn" style="
                    background: #2196F3; border: none; color: white;
                    padding: 8px 16px; border-radius: 6px; cursor: pointer;
                    font-weight: 500; transition: all 0.2s;
                ">&#9989; 自动下载已开启</button>
                <button id="mse-clear-btn" style="
                    background: #f44336; border: none; color: white;
                    padding: 8px 16px; border-radius: 6px; cursor: pointer;
                    font-weight: 500; transition: all 0.2s;
                ">&#128465;&#65039; 清空缓存数据</button>
            </div>
        </div>
        `;

        document.body.appendChild(panel);

        const header = document.getElementById('mse-cache-header');
        const content = document.getElementById('mse-cache-content');
        const downloadBtn = document.getElementById('mse-download-btn');
        const autoDownloadBtn = document.getElementById('mse-auto-download-btn');
        const clearBtn = document.getElementById('mse-clear-btn');
        const statusSpan = document.getElementById('mse-status');
        const streamList = document.getElementById('mse-stream-list');

        let expanded = false;
        header.addEventListener('click', () => {
            expanded = !expanded;
            content.style.display = expanded ? 'flex' : 'none';
            header.querySelector('span:last-child').textContent = expanded ? '▲' : '▼';
        });

        let lastDisplayedSize = -1;

        function updateStatus() {
            let totalSize = 0;
            let streams = [];

            for (const info of mediaSourceMap.values()) {
                for (const sb of info.sourceBuffers) {
                    if (sb.size > 0) {
                        totalSize += sb.size;
                        streams.push({
                            type: sb.mediaInfo.type || 'unknown',
                            format: sb.mediaInfo.format || 'unknown',
                            size: sb.size
                        });
                    }
                }
            }

            if (totalSize > 0) {
                if (totalSize !== lastDisplayedSize) {
                    const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
                    statusSpan.textContent = `已缓存 ${sizeMB} MB`;
                    statusSpan.style.background = '#4CAF50';
                    
                    let listHtml = '';
                    streams.forEach(s => {
                        listHtml += `<div style="margin-bottom: 6px;">${s.type === 'video' ? '🎬' : '🎵'} ${s.type}/${s.format}: ${(s.size / 1024 / 1024).toFixed(2)} MB</div>`;
                    });
                    streamList.innerHTML = listHtml;
                    
                    lastDisplayedSize = totalSize;
                }
            } else {
                if (lastDisplayedSize !== 0) {
                    statusSpan.textContent = '等待数据...';
                    statusSpan.style.background = 'rgba(255,255,255,0.2)';
                    streamList.innerHTML = '<div style="color: rgba(255,255,255,0.6);">暂无数据</div>';
                    lastDisplayedSize = 0;
                }
            }
        }

        downloadBtn.addEventListener('click', () => {
            let hasData = false;
            for (const info of mediaSourceMap.values()) {
                if (info.sourceBuffers.some(sb => sb.hasData)) {
                    hasData = true;
                    downloadMediaSource(info);
                }
            }
            if (!hasData) {
                alert('没有捕获到媒体数据，请确保视频已经开始播放');
            }
        });

        autoDownloadBtn.addEventListener('click', () => {
            for (const info of mediaSourceMap.values()) {
                info.autoDownload = !info.autoDownload;
            }
            const enabled = Array.from(mediaSourceMap.values())[0]?.autoDownload ?? false;
            autoDownloadBtn.textContent = enabled ? '✅ 自动下载已开启' : '❌ 自动下载已关闭';
            autoDownloadBtn.style.background = enabled ? '#4CAF50' : '#FF9800';
        });

        clearBtn.addEventListener('click', () => {
            for (const info of mediaSourceMap.values()) {
                for (const sb of info.sourceBuffers) {
                    sb.bufferData = [];
                    sb.size = 0;
                    sb.hasData = false;
                }
            }
            lastDisplayedSize = -1;
            updateStatus();
            alert('缓存数据已清空');
        });

        setInterval(updateStatus, 1000);
        return panel;
    }

    // ==================== 辅助功能 ====================

    function updateMediaTitle() {
        const video = document.querySelector('video');
        if (video && !video.paused && video.currentTime > 0) {
            const title = video.getAttribute('data-title') || video.getAttribute('title') || document.title;
            if (title && title !== currentMediaInfo?.title) {
                currentMediaInfo = { title };
                log('检测到播放中的视频:', title);
            }
        }
    }

    // ==================== 初始化 ====================

    function init() {
        log('MSE 缓存工具启动');
        proxyAddSourceBuffer();
        proxyEndOfStream();
        proxyCreateObjectURL();
        createControlPanel();
        
        setInterval(updateMediaTitle, 2000);
        log('MSE 缓存工具已就绪');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();