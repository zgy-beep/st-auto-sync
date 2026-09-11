const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { mergeChatJsonl, appendSingleMessage, parseJsonl, stringifyJsonl } = require('./chatMerger');
const ManifestHelper = require('./manifestHelper');
const LocalFileWatcher = require('./fileWatcher');
const atomicWriter = require('./atomicWriter');

class SyncClient {
  constructor(stDataDir, pluginDir) {
    this.stDataDir = stDataDir;
    this.pluginDir = pluginDir;
    this.configPath = path.join(pluginDir, 'config.json');

    this.manifestHelper = new ManifestHelper(stDataDir);
    this.fileWatcher = new LocalFileWatcher(stDataDir, (relPath, eventType) => {
      this.handleLocalPhysicalFileChange(relPath, eventType);
    });

    this.ws = null;
    this.timer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 2000;
    this.isSyncing = false;

    // 前端热重载回调列表
    this.uiListeners = new Set();

    this.state = {
      connected: false,
      lastSyncTime: null,
      lastError: null,
      onlineCount: 0,
      devices: []
    };

    this.loadConfig();
  }

  loadConfig() {
    const defaults = {
      hubUrl: 'http://localhost:8765',
      token: '',
      mode: 'realtime', // 'realtime' | 'interval' | 'manual'
      intervalMinutes: 10,
      syncCategories: [
        'chats',
        'characters',
        'worlds',
        'context',
        'instruct',
        'personas',
        'OpenAI Settings',
        'textgen_settings',
        'kobold_settings',
        'novelai_settings',
        'presets'
      ],
      syncEnvironment: true, // 核心体验：开箱即聊免二次配置（API/Key/模型/预设全自动同步）
      deviceId: 'dev_' + Math.random().toString(36).slice(2, 10),
      deviceName: process.platform === 'win32' ? 'PC-Windows' : 'Mobile-Device'
    };

    if (fs.existsSync(this.configPath)) {
      try {
        const fileContent = fs.readFileSync(this.configPath, 'utf8');
        this.config = { ...defaults, ...JSON.parse(fileContent) };
        return;
      } catch (err) {
        console.error('[SyncClient] Failed to read config:', err.message);
      }
    }

    this.config = defaults;
    this.saveConfig();
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (err) {
      console.error('[SyncClient] Failed to save config:', err.message);
    }
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.saveConfig();
    this.restart();
  }

  /**
   * 注册前端通知监听
   */
  addUiListener(listener) {
    this.uiListeners.add(listener);
    return () => this.uiListeners.delete(listener);
  }

  notifyUi(event, payload = {}) {
    for (const listener of this.uiListeners) {
      try {
        listener(event, payload);
      } catch (_) {}
    }
  }

  start() {
    if (!this.config.token || !this.config.hubUrl) {
      this.state.lastError = 'Hub URL or Token is not configured';
      return;
    }

    this.state.lastError = null;

    // 启动本地文件落盘监听（单一事实来源）
    this.fileWatcher.start(this.config.syncCategories);

    if (this.config.mode === 'realtime') {
      this.connectWebSocket();
    } else if (this.config.mode === 'interval') {
      this.scheduleIntervalSync();
    }
  }

  stop() {
    this.fileWatcher.stop();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.state.connected = false;
  }

  /**
   * 响应本地文件物理落盘变动（SSOT 事实来源）
   */
  async handleLocalPhysicalFileChange(relPath, eventType) {
    console.log(`[SyncClient] Detected local file write: ${relPath} (${eventType})`);

    // 1. 如果是聊天记录且处于实时模式
    if (relPath.endsWith('.jsonl') && this.config.mode === 'realtime' && this.ws && this.state.connected) {
      try {
        const fullPath = path.join(this.stDataDir, relPath);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const messages = parseJsonl(content);
          if (messages.length > 0) {
            const latestMsg = messages[messages.length - 1];
            // 发送最后一条消息增量
            this.ws.send(JSON.stringify({
              type: 'chat_append',
              payload: {
                chatFile: relPath,
                characterName: path.basename(relPath).split(' - ')[0] || '',
                message: latestMsg
              }
            }));
            return;
          }
        }
      } catch (err) {
        console.error('[SyncClient] Error reading changed chat file:', err.message);
      }
    }

    // 2. 其它文件或处于非实时模式，防抖触发同步
    if (this.debounceSyncTimer) clearTimeout(this.debounceSyncTimer);
    this.debounceSyncTimer = setTimeout(() => {
      this.performSync('local-file-change');
    }, 1500);
  }

  restart() {
    this.stop();
    this.start();
  }

  scheduleIntervalSync() {
    const ms = Math.max(1, this.config.intervalMinutes) * 60 * 1000;
    this.timer = setInterval(() => {
      this.performSync('interval');
    }, ms);
    // 启动时先跑一次
    this.performSync('interval-startup');
  }

  /**
   * WebSocket 实时连接与处理
   */
  connectWebSocket() {
    if (this.ws) return;

    let wsUrl;
    try {
      const parsed = new URL(this.config.hubUrl);
      const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${wsProto}//${parsed.host}/ws`;
    } catch (e) {
      this.state.lastError = 'Invalid Hub URL format';
      return;
    }

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this.handleWsError(err);
      return;
    }

    this.ws.on('open', () => {
      console.log(`[SyncClient] WebSocket connected to ${wsUrl}. Authenticating...`);
      this.reconnectDelay = 2000;

      // 发送认证包
      this.ws.send(JSON.stringify({
        type: 'auth',
        token: this.config.token,
        deviceId: this.config.deviceId,
        deviceName: this.config.deviceName
      }));
    });

    this.ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (_) {
        return;
      }

      if (msg.type === 'auth_success') {
        this.state.connected = true;
        this.state.lastError = null;
        console.log(`[SyncClient] Authenticated successfully as ${this.config.deviceName}`);
        this.notifyUi('status_changed', this.getStatus());
        // 连上后先做一次静默增量比对
        this.performSync('startup-sync');
        return;
      }

      if (msg.type === 'device_presence') {
        this.state.onlineCount = msg.onlineCount || 1;
        this.notifyUi('presence_changed', msg);
        return;
      }

      // 实时收到聊天消息追加
      if (msg.type === 'chat_append') {
        await this.handleRemoteChatAppend(msg.payload);
        return;
      }

      // 实时收到远端文件变动通知
      if (msg.type === 'file_updated') {
        await this.handleRemoteFileUpdated(msg.file);
        return;
      }

      if (msg.type === 'file_deleted') {
        this.handleRemoteFileDeleted(msg.path);
        return;
      }
    });

    this.ws.on('close', (code, reason) => {
      this.state.connected = false;
      this.ws = null;
      console.warn(`[SyncClient] WebSocket disconnected (${code}: ${reason}). Retrying in ${this.reconnectDelay / 1000}s...`);
      this.notifyUi('status_changed', this.getStatus());

      // 自动重连
      if (this.config.mode === 'realtime') {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
          this.connectWebSocket();
        }, this.reconnectDelay);
      }
    });

    this.ws.on('error', (err) => {
      this.handleWsError(err);
    });
  }

  handleWsError(err) {
    this.state.lastError = err.message;
    this.state.connected = false;
    this.notifyUi('status_changed', this.getStatus());
  }

  /**
   * 处理远端实时广播过来的单条聊天追加
   */
  async handleRemoteChatAppend({ chatFile, characterName, message }) {
    if (!chatFile || !message) return;
    const localChatPath = path.join(this.stDataDir, chatFile);

    try {
      if (fs.existsSync(localChatPath)) {
        const raw = fs.readFileSync(localChatPath, 'utf8');
        const { content, appended } = appendSingleMessage(raw, message);
        if (appended) {
          fs.writeFileSync(localChatPath, content, 'utf8');
          console.log(`[SyncClient] Live chat message appended to ${chatFile}`);
          // 通知前端刷新当前活跃对话
          this.notifyUi('chat_updated', {
            chatFile,
            characterName,
            message
          });
        }
      } else {
        // 如果本地甚至没有该会话文件，向 Hub 下载完整会话
        await this.downloadFile(chatFile);
        this.notifyUi('chat_updated', { chatFile, characterName, message });
      }
    } catch (err) {
      console.error(`[SyncClient] Error handling live chat message:`, err.message);
    }
  }

  /**
   * 处理远端文件更新
   */
  async handleRemoteFileUpdated(fileMeta) {
    if (!fileMeta || !fileMeta.path) return;
    const localPath = path.join(this.stDataDir, fileMeta.path);

    let needDownload = true;
    if (fs.existsSync(localPath)) {
      const stat = fs.statSync(localPath);
      const localHash = this.manifestHelper.calculateHash(localPath, stat);
      if (localHash === fileMeta.hash) {
        needDownload = false;
      }
    }

    if (needDownload) {
      await this.downloadFile(fileMeta.path);
      this.notifyUi('file_synced', { path: fileMeta.path });
    }
  }

  /**
   * 处理远端文件删除
   */
  handleRemoteFileDeleted(relPath) {
    if (!relPath) return;
    const localPath = path.join(this.stDataDir, relPath);
    if (fs.existsSync(localPath)) {
      try {
        fs.unlinkSync(localPath);
        console.log(`[SyncClient] Local file deleted via remote sync: ${relPath}`);
        this.notifyUi('file_deleted', { path: relPath });
      } catch (_) {}
    }
  }

  /**
   * 客户端本地发送消息时调用：如果是实时模式，通过 WS 即时广播；如果是其它模式，防抖触发同步
   */
  onLocalChatSent(chatFile, characterName, message) {
    if (this.config.mode === 'realtime' && this.ws && this.state.connected) {
      try {
        this.ws.send(JSON.stringify({
          type: 'chat_append',
          payload: {
            chatFile,
            characterName,
            message
          }
        }));
      } catch (err) {
        console.error('[SyncClient] Failed to send live chat via WS:', err.message);
      }
    } else {
      // 延迟防抖触发
      if (this.debounceSyncTimer) clearTimeout(this.debounceSyncTimer);
      this.debounceSyncTimer = setTimeout(() => {
        this.performSync('event-message');
      }, 3000);
    }
  }

  /**
   * 核心全量/增量比对与传输逻辑
   */
  async performSync(trigger = 'manual') {
    if (this.isSyncing) {
      console.log('[SyncClient] Sync already in progress, skipping...');
      return { success: false, reason: 'Already syncing' };
    }

    if (!this.config.token || !this.config.hubUrl) {
      return { success: false, reason: 'Unconfigured' };
    }

    this.isSyncing = true;
    this.notifyUi('sync_start', { trigger });

    try {
      // 1. 生成本地清单
      const localManifest = this.manifestHelper.generateLocalManifest({
        syncCategories: this.config.syncCategories,
        syncEnvironment: this.config.syncEnvironment !== false
      });

      // 2. 向 Hub 请求 Manifest Diff
      const diffRes = await this.fetchApi('/api/manifest/diff', 'POST', {
        manifest: localManifest
      });

      if (!diffRes.success) {
        throw new Error(diffRes.error || 'Failed to diff manifest');
      }

      const { need_upload, need_download } = diffRes;
      console.log(`[SyncClient] Diff complete. Upload: ${need_upload.length}, Download: ${need_download.length}`);

      // 3. 执行文件下载
      for (const relPath of need_download) {
        await this.downloadAndMergeFile(relPath);
      }

      // 4. 执行文件上传
      for (const relPath of need_upload) {
        await this.uploadFile(relPath);
      }

      this.state.lastSyncTime = Date.now();
      this.state.lastError = null;
      this.notifyUi('sync_complete', {
        uploaded: need_upload.length,
        downloaded: need_download.length,
        time: this.state.lastSyncTime
      });

      return {
        success: true,
        uploadedCount: need_upload.length,
        downloadedCount: need_download.length
      };
    } catch (err) {
      console.error('[SyncClient] Sync failed:', err.message);
      this.state.lastError = err.message;
      this.notifyUi('sync_error', { error: err.message });
      return { success: false, error: err.message };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 下载文件：使用 atomicWriter 原子安全落盘，结合 Check-Before-Write 防双写竞态
   */
  async downloadAndMergeFile(relPath) {
    this.fileWatcher.suppressPath(relPath);

    const localPath = path.join(this.stDataDir, relPath);
    let baseHashBefore = null;
    if (fs.existsSync(localPath)) {
      try {
        baseHashBefore = crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
      } catch (_) {}
    }

    const downloadUrl = `${this.config.hubUrl.replace(/\/$/, '')}/api/files/download?path=${encodeURIComponent(relPath)}`;
    const res = await fetch(downloadUrl, {
      headers: { 'Authorization': `Bearer ${this.config.token}` }
    });

    if (!res.ok) {
      throw new Error(`Failed to download ${relPath}: HTTP ${res.status}`);
    }

    const remoteBuffer = Buffer.from(await res.arrayBuffer());

    // 1.5 核心保障：首次拉取时的历史分叉安全归档 (Fork-on-Conflict Bootstrap)
    if (relPath.endsWith('.jsonl') && fs.existsSync(localPath) && !this.migratedFiles?.has(relPath)) {
      if (!this.migratedFiles) this.migratedFiles = new Set();
      this.migratedFiles.add(relPath);

      const localRaw = fs.readFileSync(localPath, 'utf8');
      const remoteRaw = remoteBuffer.toString('utf8');

      const localItems = parseJsonl(localRaw);
      const remoteItems = parseJsonl(remoteRaw);

      // 比对双端是否存在已知的公共 mid
      const remoteMids = new Set(remoteItems.map((m) => m.mid).filter(Boolean));
      const hasCommonMid = localItems.some((m) => m.mid && remoteMids.has(m.mid));

      // 若两端均有相当数量的历史消息，但完全没有共同 mid (部署前就产生的分叉历史)
      if (localItems.length > 2 && remoteItems.length > 2 && !hasCommonMid) {
        console.warn(`[SyncClient] Pre-existing historical divergence detected on ${relPath}! Archiving local copy.`);
        const ext = path.extname(localPath);
        const base = path.basename(localPath, ext);
        const archivePath = path.join(path.dirname(localPath), `${base} (旧本地存档-来自${this.config.deviceName})${ext}`);
        
        try {
          fs.copyFileSync(localPath, archivePath);
          console.log(`[SyncClient] Local divergent history safely archived to: ${archivePath}`);
          this.notifyUi('chat_archived', {
            originalFile: relPath,
            archiveFile: path.basename(archivePath),
            deviceName: this.config.deviceName
          });
        } catch (err) {
          console.error('[SyncClient] Failed to archive divergent history:', err.message);
        }
      }
    }

    // 开箱即聊：如果是 settings.json，将远端同步的 API/模型/参数打补丁注入本地，完整保留本地 UI 主题
    let finalWriteBuffer = remoteBuffer;
    if (relPath === 'settings.json' && fs.existsSync(localPath)) {
      try {
        const localSettings = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        const remoteSanitized = JSON.parse(remoteBuffer.toString('utf8'));
        const patched = ManifestHelper.patchLocalSettings(localSettings, remoteSanitized);
        finalWriteBuffer = Buffer.from(JSON.stringify(patched, null, 2), 'utf8');
        console.log('[SyncClient] Successfully patched API/Preset environment into local settings.json');
      } catch (err) {
        console.warn('[SyncClient] Failed to patch local settings.json, using authoritative remote:', err.message);
      }
    }

    // 使用 atomicWriter 执行原子排他写入
    await atomicWriter.safeWrite(
      localPath,
      finalWriteBuffer,
      baseHashBefore,
      (currentLocalBuf, hubAuthoritativeBuf) => {
        // 若在下载期间本地刚有新打字落盘：进行纯追加保护性合并
        if (relPath.endsWith('.jsonl')) {
          console.warn(`[SyncClient] Check-Before-Write detected race on ${relPath}! Preserving local typing.`);
          const localLines = parseJsonl(currentLocalBuf.toString('utf8'));
          const hubLines = parseJsonl(hubAuthoritativeBuf.toString('utf8'));
          if (localLines.length > 0) {
            const latestLocal = localLines[localLines.length - 1];
            // 确保不丢失本地刚打的这句，追加到 Hub 权威版之后并向 Hub 重新提议
            hubLines.push(latestLocal);
            setTimeout(() => {
              this.onLocalChatSent(relPath, path.basename(relPath).split(' - ')[0] || '', latestLocal);
            }, 500);
            return Buffer.from(stringifyJsonl(hubLines), 'utf8');
          }
        }
        return hubAuthoritativeBuf;
      }
    );

    console.log(`[SyncClient] Applied authoritative file safely from Hub: ${relPath}`);
  }

  async uploadFile(relPath) {
    const localPath = path.join(this.stDataDir, relPath);
    if (!fs.existsSync(localPath)) return;

    let buffer = fs.readFileSync(localPath);
    const stat = fs.statSync(localPath);

    // 开箱即聊：上传 settings.json 时，仅上传白名单过滤后的核心 API 与预设，不上传本地主题
    if (relPath === 'settings.json') {
      try {
        const raw = JSON.parse(buffer.toString('utf8'));
        const sanitized = ManifestHelper.sanitizeSettings(raw);
        buffer = Buffer.from(JSON.stringify(sanitized, null, 2), 'utf8');
      } catch (_) {}
    }

    await this.fetchApi('/api/files/upload', 'POST', {
      path: relPath,
      contentBase64: buffer.toString('base64'),
      mtime: stat.mtimeMs
    });
  }

  async downloadFile(relPath) {
    return this.downloadAndMergeFile(relPath);
  }

  async fetchApi(endpoint, method = 'GET', body = null) {
    const url = `${this.config.hubUrl.replace(/\/$/, '')}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.config.token}`,
      'x-device-id': this.config.deviceId,
      'Content-Type': 'application/json'
    };

    const options = { method, headers };
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    return res.json();
  }

  getStatus() {
    return {
      connected: this.state.connected,
      isSyncing: this.isSyncing,
      lastSyncTime: this.state.lastSyncTime,
      lastError: this.state.lastError,
      onlineCount: this.state.onlineCount,
      config: {
        hubUrl: this.config.hubUrl,
        mode: this.config.mode,
        intervalMinutes: this.config.intervalMinutes,
        syncCategories: this.config.syncCategories,
        syncSettings: this.config.syncSettings,
        deviceId: this.config.deviceId,
        deviceName: this.config.deviceName
      }
    };
  }
}

module.exports = SyncClient;
