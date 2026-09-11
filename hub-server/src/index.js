const http = require('node:http');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { hashToken, authMiddleware } = require('./auth');
const RoomManager = require('./roomManager');
const StorageManager = require('./storage');
const OplogManager = require('./oplog');

const PORT = process.env.PORT || 8765;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const roomManager = new RoomManager();
const storageManager = new StorageManager(DATA_DIR);
const oplogManager = new OplogManager(DATA_DIR);

// 基础中间件
app.use(cors());
// 支持最大 100MB 请求体（用于角色卡、背景图等文件上传）
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '100mb' }));

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: Date.now()
  });
});

// 验证 Token 接口
app.post('/api/auth/verify', authMiddleware, (req, res) => {
  const onlineDevices = roomManager.getOnlineDevices(req.userKey);
  res.json({
    success: true,
    userKey: req.userKey,
    onlineCount: onlineDevices.length,
    devices: onlineDevices
  });
});

// 获取服务端完整 Manifest
app.get('/api/manifest', authMiddleware, (req, res) => {
  try {
    const force = req.query.refresh === 'true';
    const manifest = storageManager.scanUserManifest(req.userKey, force);
    res.json({ success: true, manifest });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 对比客户端与服务端 Manifest (Diff 计算)
app.post('/api/manifest/diff', authMiddleware, (req, res) => {
  try {
    const clientManifest = req.body.manifest || {};
    const diffResult = storageManager.diffManifest(req.userKey, clientManifest);
    res.json({ success: true, ...diffResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const { mergeChatJsonl } = require('./chatMerger');

// 上传单个文件 (Hub 作为集中权威仲裁者)
app.post('/api/files/upload', authMiddleware, (req, res) => {
  try {
    const { path: relPath, contentBase64, mtime } = req.body;
    if (!relPath || typeof contentBase64 !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing path or contentBase64' });
    }

    let buffer = Buffer.from(contentBase64, 'base64');
    const deviceId = req.headers['x-device-id'] || 'http-client';

    // 覆盖之前先把当前版本存为历史(供"备份/回滚"使用)
    const snapshot = storageManager.snapshotVersion(req.userKey, relPath, deviceId);
    if (snapshot) {
      console.log(`[Hub Backup] Snapshot kept for ${relPath} (device=${snapshot.deviceId}, size=${snapshot.size})`);
    }

    // 核心重构：如果是聊天记录且服务端已有旧版本，由 Hub 集中执行权威合并！
    if (relPath.endsWith('.jsonl')) {
      const existingFile = storageManager.readFile(req.userKey, relPath);
      if (existingFile) {
        const serverJsonl = existingFile.buffer.toString('utf8');
        const incomingJsonl = buffer.toString('utf8');
        const mergeResult = mergeChatJsonl(serverJsonl, incomingJsonl);

        if (mergeResult.hasCausalFork) {
          // 产生因果分叉：保护性另存为新分支！
          const ext = path.extname(relPath);
          const baseName = path.basename(relPath, ext);
          const forkRelPath = path.posix.join(
            path.dirname(relPath).replace(/\\/g, '/'),
            `${baseName} (冲突分支-来自${deviceId})${ext}`
          );

          storageManager.saveFile(req.userKey, forkRelPath, Buffer.from(mergeResult.forkContent, 'utf8'), Date.now());
          console.log(`[Hub Arbiter] Causal fork detected! Created branch file: ${forkRelPath}`);

          // 广播分支文件
          const forkEntry = oplogManager.append(req.userKey, {
            type: 'file_updated',
            payload: { path: forkRelPath, isForkBranch: true },
            deviceId
          });
          roomManager.broadcast(req.userKey, null, {
            type: 'file_updated',
            seq: forkEntry.seq,
            file: { path: forkRelPath }
          });
        }

        // 主分支保存为权威合并结果
        buffer = Buffer.from(mergeResult.mergedContent, 'utf8');
      }
    }

    const fileMeta = storageManager.saveFile(req.userKey, relPath, buffer, mtime);

    // 记录到 Oplog (全局单调递增 seq)
    const oplogEntry = oplogManager.append(req.userKey, {
      type: 'file_updated',
      payload: { path: relPath, size: fileMeta.size, hash: fileMeta.hash, mtime: fileMeta.mtime },
      deviceId
    });

    // 广播权威文件变动通知给同一房间的所有在线客户端
    roomManager.broadcast(req.userKey, null, {
      type: 'file_updated',
      seq: oplogEntry.seq,
      file: fileMeta
    });

    res.json({ success: true, file: fileMeta, seq: oplogEntry.seq });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 下载单个文件
app.get('/api/files/download', authMiddleware, (req, res) => {
  try {
    const relPath = req.query.path;
    if (!relPath) {
      return res.status(400).json({ success: false, error: 'Missing path param' });
    }

    const file = storageManager.readFile(req.userKey, relPath);
    if (!file) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(relPath))}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(file.buffer);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 删除单个文件
app.delete('/api/files/delete', authMiddleware, (req, res) => {
  try {
    const relPath = req.query.path;
    if (!relPath) {
      return res.status(400).json({ success: false, error: 'Missing path param' });
    }

    // 删除前也留一份历史,避免误删无法找回
    storageManager.snapshotVersion(req.userKey, relPath, req.headers['x-device-id'] || 'http-client');

    const deleted = storageManager.deleteFile(req.userKey, relPath);
    if (deleted) {
      const oplogEntry = oplogManager.append(req.userKey, {
        type: 'file_deleted',
        payload: { path: relPath },
        deviceId: req.headers['x-device-id'] || 'http-client'
      });

      roomManager.broadcast(req.userKey, null, {
        type: 'file_deleted',
        seq: oplogEntry.seq,
        path: relPath
      });
    }

    res.json({ success: true, deleted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取增量操作日志 (Catch-up)
app.get('/api/oplog', authMiddleware, (req, res) => {
  try {
    const sinceSeq = parseInt(req.query.since_seq || '0', 10);
    const result = oplogManager.getSince(req.userKey, sinceSeq);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 查看当前在线设备
app.get('/api/devices', authMiddleware, (req, res) => {
  const devices = roomManager.getOnlineDevices(req.userKey);
  res.json({ success: true, devices });
});

// ==========================================
// 备份 / 历史版本 API
// ==========================================

// 1) 备份总览:哪些文件有历史版本
app.get('/api/backups', authMiddleware, (req, res) => {
  try {
    const files = storageManager.summarizeBackups(req.userKey);
    res.json({ success: true, files, maxVersionsPerFile: Number(process.env.MAX_VERSIONS_PER_FILE || 20) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2) 某个文件的历史版本列表
app.get('/api/versions', authMiddleware, (req, res) => {
  try {
    const relPath = req.query.path;
    if (!relPath) {
      return res.status(400).json({ success: false, error: 'Missing path param' });
    }
    res.json({ success: true, path: relPath, versions: storageManager.listVersions(req.userKey, relPath) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3) 下载指定历史版本内容(原始字节)
app.get('/api/versions/download', authMiddleware, (req, res) => {
  try {
    const relPath = req.query.path;
    const versionId = req.query.version;
    if (!relPath || !versionId) {
      return res.status(400).json({ success: false, error: 'Missing path or version param' });
    }

    const version = storageManager.readVersion(req.userKey, relPath, versionId);
    if (!version) {
      return res.status(404).json({ success: false, error: 'Version not found' });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Version-Id', path.basename(String(versionId)));
    res.send(version.buffer);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// WebSocket 实时中继分发逻辑
// ==========================================
wss.on('connection', (ws) => {
  const client = {
    ws,
    userKey: null,
    deviceId: null,
    deviceName: null,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    authenticated: false
  };

  // 10秒内未完成认证直接断开
  const authTimeout = setTimeout(() => {
    if (!client.authenticated) {
      ws.close(4001, 'Authentication Timeout');
    }
  }, 10000);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }

    // 1. 认证握手
    if (msg.type === 'auth') {
      try {
        const userKey = hashToken(msg.token);
        clearTimeout(authTimeout);
        client.authenticated = true;
        client.deviceId = msg.deviceId || 'device-' + Math.random().toString(36).slice(2, 8);
        client.deviceName = msg.deviceName || 'Anonymous Device';
        client.lastHeartbeat = Date.now();

        roomManager.join(userKey, client);

        ws.send(JSON.stringify({
          type: 'auth_success',
          userKey,
          deviceId: client.deviceId,
          serverTime: Date.now()
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'auth_error', message: err.message }));
        ws.close(4003, 'Invalid Token');
      }
      return;
    }

    if (!client.authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }

    // 2. 心跳保活
    if (msg.type === 'ping') {
      client.lastHeartbeat = Date.now();
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      return;
    }

    // 3. 聊天消息实时增量推送
    if (msg.type === 'chat_append') {
      const { chatFile, characterName, message } = msg.payload || {};
      if (!chatFile || !message) return;

      // 记录到 Oplog
      const entry = oplogManager.append(client.userKey, {
        type: 'chat_append',
        payload: { chatFile, characterName, message },
        deviceId: client.deviceId
      });

      // 广播给房间内的其它设备（排除发送者自身）
      roomManager.broadcast(client.userKey, client, {
        type: 'chat_append',
        seq: entry.seq,
        senderDeviceId: client.deviceId,
        payload: { chatFile, characterName, message },
        timestamp: entry.timestamp
      });
      return;
    }

    // 4. 其它类型广播（如正在输入状态、会话切换通知等）
    if (msg.type === 'typing' || msg.type === 'chat_switched') {
      roomManager.broadcast(client.userKey, client, {
        type: msg.type,
        senderDeviceId: client.deviceId,
        payload: msg.payload,
        timestamp: Date.now()
      });
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (client.authenticated) {
      roomManager.leave(client);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WebSocket Error] Device [${client.deviceId}]:`, err.message);
  });
});

// 心跳定时清理断开死连接 (每 30 秒)
setInterval(() => {
  const now = Date.now();
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.ping();
    }
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===================================================`);
  console.log(`🚀 ST-Auto-Sync Hub Server running on port ${PORT}`);
  console.log(`📂 Data directory: ${DATA_DIR}`);
  console.log(`🌐 HTTP API: http://localhost:${PORT}`);
  console.log(`⚡ WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`===================================================`);
});
