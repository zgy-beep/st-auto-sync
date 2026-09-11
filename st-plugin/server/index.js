const path = require('node:path');
const fs = require('node:fs');
const SyncClient = require('./syncClient');

let syncClientInstance = null;

/**
 * SillyTavern 服务端插件元信息。
 * ST 1.15+ 的插件加载器要求模块导出 info 对象（id/name/description 均为字符串），
 * 否则会以 "Failed to load plugin module; plugin info not found" 拒绝加载。
 */
const info = {
  id: 'st-auto-sync',
  name: 'ST-Auto-Sync 多端同步',
  description: 'Relays chats, characters, lorebooks and presets between SillyTavern devices through a self-hosted hub.',
};

/**
 * 探测 SillyTavern 的数据存储根目录
 */
function detectStDataDir() {
  const currentDir = process.cwd();
  const candidates = [
    path.join(currentDir, 'data', 'default-user'),
    path.join(currentDir, 'data'),
    path.join(currentDir, 'public')
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }

  // 兜底创建
  const defaultDir = path.join(currentDir, 'data', 'default-user');
  if (!fs.existsSync(defaultDir)) {
    try { fs.mkdirSync(defaultDir, { recursive: true }); } catch (_) {}
  }
  return defaultDir;
}

/**
 * SillyTavern 服务端插件标准初始化入口
 * @param {import('express').Router} router 
 */
function init(router) {
  const stDataDir = detectStDataDir();
  const pluginDir = __dirname;

  console.log('[ST-Auto-Sync] Initializing server plugin...');
  console.log(`[ST-Auto-Sync] Target SillyTavern data directory: ${stDataDir}`);

  syncClientInstance = new SyncClient(stDataDir, pluginDir);
  syncClientInstance.start();

  // 维护 SSE 连接池给前端推送热重载信号
  const sseClients = new Set();

  syncClientInstance.addUiListener((event, payload) => {
    const data = JSON.stringify({ event, payload });
    for (const res of sseClients) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch (_) {}
    }
  });

  // 1. SSE 实时事件流路由
  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);

    // 初始状态
    res.write(`data: ${JSON.stringify({ event: 'connected', payload: syncClientInstance.getStatus() })}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  // 2. 获取状态
  router.get('/status', (req, res) => {
    res.json({
      success: true,
      dataDir: stDataDir,
      ...syncClientInstance.getStatus()
    });
  });

  // 3. 更新配置
  router.post('/config', (req, res) => {
    try {
      syncClientInstance.updateConfig(req.body);
      res.json({
        success: true,
        ...syncClientInstance.getStatus()
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4. 手动触发同步
  router.post('/sync', async (req, res) => {
    try {
      const result = await syncClientInstance.performSync('manual');
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4.1 备份总览:Hub 上有历史版本的文件
  router.get('/backups', async (req, res) => {
    try {
      const result = await syncClientInstance.listHubBackups();
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4.2 某文件的历史版本列表
  router.get('/versions', async (req, res) => {
    try {
      const relPath = req.query.path;
      if (!relPath) {
        return res.status(400).json({ success: false, error: 'Missing path param' });
      }
      const result = await syncClientInstance.listHubVersions(relPath);
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4.3 全量从 Hub 恢复(只拉不推,覆盖前另存本机旧文件)
  router.post('/restore', async (req, res) => {
    try {
      const result = await syncClientInstance.restoreFromHub();
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4.4 回滚到某个历史版本
  router.post('/restore-version', async (req, res) => {
    try {
      const { path: relPath, versionId } = req.body || {};
      if (!relPath || !versionId) {
        return res.status(400).json({ success: false, error: 'Missing path or versionId' });
      }
      const result = await syncClientInstance.restoreVersion(relPath, versionId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 5. 前端发送消息拦截上报
  router.post('/chat-event', (req, res) => {
    const { chatFile, characterName, message } = req.body || {};
    if (chatFile && message) {
      syncClientInstance.onLocalChatSent(chatFile, characterName, message);
    }
    res.json({ success: true });
  });

  console.log('[ST-Auto-Sync] Plugin server routes registered successfully.');
}

module.exports = {
  info,
  init,
  getSyncClient: () => syncClientInstance
};
