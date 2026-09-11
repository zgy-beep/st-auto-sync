const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const { authMiddleware } = require('../hub-server/src/auth');
const RoomManager = require('../hub-server/src/roomManager');
const StorageManager = require('../hub-server/src/storage');
const OplogManager = require('../hub-server/src/oplog');
const SyncClient = require('../st-plugin/server/syncClient');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TEST_PORT = 9878;
const TEST_BASE = path.join(__dirname, 'temp_version_env');
const HUB_DATA = path.join(TEST_BASE, 'hub_data');
const CLIENT_DIR = path.join(TEST_BASE, 'client_st');
const PLUGIN_DIR = path.join(TEST_BASE, 'plugin');

function pickArchiveFiles(root) {
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(root);
  return found;
}

async function runVersionHistoryTest() {
  console.log('=== 开始 ST-Auto-Sync 备份版本 / 回滚 测试 ===');

  if (fs.existsSync(TEST_BASE)) {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  }
  fs.mkdirSync(HUB_DATA, { recursive: true });
  fs.mkdirSync(CLIENT_DIR, { recursive: true });
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });

  // ---------------------------------------------------------------- 测试用 Hub
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const roomManager = new RoomManager();
  const storageManager = new StorageManager(HUB_DATA);
  const oplogManager = new OplogManager(HUB_DATA);

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  app.post('/api/manifest/diff', authMiddleware, (req, res) => {
    res.json({ success: true, ...storageManager.diffManifest(req.userKey, req.body.manifest || {}) });
  });

  // 与 hub-server/src/index.js 保持一致:覆盖前留存历史版本
  app.post('/api/files/upload', authMiddleware, (req, res) => {
    const { path: relPath, contentBase64, mtime } = req.body;
    const deviceId = req.headers['x-device-id'] || 'http-client';
    storageManager.snapshotVersion(req.userKey, relPath, deviceId);

    const buffer = Buffer.from(contentBase64, 'base64');
    const fileMeta = storageManager.saveFile(req.userKey, relPath, buffer, mtime);
    const entry = oplogManager.append(req.userKey, {
      type: 'file_updated',
      payload: fileMeta,
      deviceId
    });
    roomManager.broadcast(req.userKey, null, { type: 'file_updated', seq: entry.seq, file: fileMeta });
    res.json({ success: true, file: fileMeta });
  });

  app.get('/api/files/download', authMiddleware, (req, res) => {
    const file = storageManager.readFile(req.userKey, req.query.path);
    if (!file) return res.status(404).send('Not found');
    res.send(file.buffer);
  });

  app.get('/api/backups', authMiddleware, (req, res) => {
    res.json({ success: true, files: storageManager.summarizeBackups(req.userKey) });
  });

  app.get('/api/versions', authMiddleware, (req, res) => {
    res.json({
      success: true,
      path: req.query.path,
      versions: storageManager.listVersions(req.userKey, req.query.path)
    });
  });

  app.get('/api/versions/download', authMiddleware, (req, res) => {
    const version = storageManager.readVersion(req.userKey, req.query.path, req.query.version);
    if (!version) return res.status(404).json({ success: false, error: 'Version not found' });
    res.send(version.buffer);
  });

  wss.on('connection', (ws) => {
    const client = { ws, userKey: null, deviceId: null, authenticated: false };
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth') {
        client.userKey = require('../hub-server/src/auth').hashToken(msg.token);
        client.deviceId = msg.deviceId;
        client.authenticated = true;
        roomManager.join(client.userKey, client);
        ws.send(JSON.stringify({ type: 'auth_success', deviceId: client.deviceId }));
      }
    });
    ws.on('close', () => {
      if (client.authenticated) roomManager.leave(client);
    });
  });

  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`[Backup] 测试 Hub 已启动: http://127.0.0.1:${TEST_PORT}`);

  let client = null;

  try {
    client = new SyncClient(CLIENT_DIR, PLUGIN_DIR);
    client.updateConfig({
      hubUrl: `http://127.0.0.1:${TEST_PORT}`,
      token: 'backup-test-token',
      mode: 'polling',
      syncInterval: 3600,
      deviceName: 'PC-Client'
    });

    // 注意:不要用 settings.json 做测试样本 —— 它是白名单过滤文件(sanitizeSettings),
    // 过滤后内容恒为 {},差异永远为 0,测不出覆盖流程。这里用普通的 worlds 分类文件。
    const WORLD_REL = 'worlds/测试世界.json';
    fs.mkdirSync(path.join(CLIENT_DIR, 'worlds'), { recursive: true });
    const settingsPath = path.join(CLIENT_DIR, 'worlds', '测试世界.json');

    // 1) v1 首次上传(Hub 之前没有这个文件,不会产生历史版本)
    fs.writeFileSync(settingsPath, JSON.stringify({ version: 1, name: '第一版' }), 'utf8');
    await client.performSync('test-upload-v1');

    const firstVersions = await client.listHubVersions(WORLD_REL);
    assert.strictEqual(firstVersions.versions.length, 0, '首次上传不该产生历史版本');
    console.log('✅ [1/6] 首次上传不产生历史版本(符合预期)');

    // 2) v2 覆盖 → 应保留 v1
    fs.writeFileSync(settingsPath, JSON.stringify({ version: 2, name: '第二版' }), 'utf8');
    await sleep(200);
    await client.performSync('test-upload-v2');

    // 3) v3 覆盖 → 应保留 v1、v2
    fs.writeFileSync(settingsPath, JSON.stringify({ version: 3, name: '第三版' }), 'utf8');
    await sleep(200);
    await client.performSync('test-upload-v3');

    const versions = (await client.listHubVersions(WORLD_REL)).versions;
    assert.ok(versions.length >= 2, `覆盖两次后应至少有 2 个历史版本,实际 ${versions.length}`);
    console.log(`✅ [2/6] 覆盖后自动留存历史版本: ${versions.length} 份`);

    // 新旧排序:第一个是最近的
    assert.ok(versions[0].timestamp >= versions[versions.length - 1].timestamp, '版本应按时间倒序');

    // 逐个下载,核对留存的内容(应为覆盖前的 v1 与 v2)
    const retained = [];
    for (const v of versions) {
      const raw = await client.downloadRawFromHub(
        `/api/versions/download?path=${encodeURIComponent(WORLD_REL)}&version=${encodeURIComponent(v.id)}`
      );
      retained.push({ timestamp: v.timestamp, version: JSON.parse(raw.toString('utf8')).version });
    }
    const retainedVersions = retained.map((r) => r.version);
    assert.ok(retainedVersions.includes(1), `应留存覆盖前的 v1,实际留存 ${JSON.stringify(retainedVersions)}`);
    assert.ok(retainedVersions.includes(2), `应留存覆盖前的 v2,实际留存 ${JSON.stringify(retainedVersions)}`);
    assert.strictEqual(versions[versions.length - 1].timestamp, Math.min(...retained.map((r) => r.timestamp)), '最老的版本应排在最后');
    console.log('✅ [3/6] 历史版本内容可下载且新旧排序正确');
    console.log(`      └ 留存内容: ${retainedVersions.join(', ')} (新 → 旧)`);

    // 4) 备份总览
    const backups = await client.listHubBackups();
    const entry = backups.files.find((f) => f.path === WORLD_REL);
    assert.ok(entry, '备份总览里应包含 settings.json');
    assert.ok(entry.versions >= 2, '备份总览应统计版本数量');
    assert.ok(entry.latestTimestamp > 0, '备份总览应带最近时间');
    assert.ok(entry.latestDevice && entry.latestDevice !== 'unknown', '备份总览应记录来源设备');
    console.log(`✅ [4/6] 备份总览正确: ${entry.path} 有 ${entry.versions} 个版本,来源设备 ${entry.latestDevice}`);

    // 5) 回滚到最早版本:本机当前内容应被另存
    const beforeRollback = fs.readFileSync(settingsPath, 'utf8');
    const rollbackRes = await client.restoreVersion(WORLD_REL, versions[versions.length - 1].id);
    assert.strictEqual(rollbackRes.archivedLocalCopy, true, '回滚前应另存本机旧文件');
    const afterRollback = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(afterRollback.version, 1, '回滚后本机文件应指回 v1');
    const archivedFiles = pickArchiveFiles(path.join(CLIENT_DIR, '.stsync', 'restore-backup'));
    assert.ok(archivedFiles.length >= 1, '回滚前的本机文件应能在 .stsync/restore-backup 找到');
    const archivedMatches = archivedFiles.some((f) => fs.readFileSync(f, 'utf8') === beforeRollback);
    assert.ok(archivedMatches, '另存的文件内容应与回滚前的本机内容一致');
    console.log('✅ [5/6] 单文件回滚成功,且本机旧文件已另存可追溯');

    // 6) 全量恢复:本机改成乱七八糟的内容,应以 Hub 为准复原,并把垃圾内容另存
    const hubLatest = (await client.downloadRawFromHub(`/api/files/download?path=${encodeURIComponent(WORLD_REL)}`)).toString('utf8');
    fs.writeFileSync(settingsPath, 'LOCAL-JUNK-SHOULD-BE-ARCHIVED', 'utf8');
    const restoreRes = await client.restoreFromHub();
    assert.strictEqual(restoreRes.success, true);
    assert.ok(restoreRes.restored >= 1, '全量恢复应至少拉取 1 个文件');
    assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), hubLatest, '全量恢复后本机内容应等于 Hub 上的最新内容');
    const junkFiles = pickArchiveFiles(path.join(CLIENT_DIR, '.stsync', 'restore-backup'));
    assert.ok(junkFiles.some((f) => fs.readFileSync(f, 'utf8') === 'LOCAL-JUNK-SHOULD-BE-ARCHIVED'), '被覆盖的本机垃圾内容应另存');
    console.log(`✅ [6/6] 全量恢复成功: 拉取 ${restoreRes.restored} 个文件,另存 ${restoreRes.archived} 个本机旧文件`);

    console.log('\n🎉 备份版本 / 回滚 测试全部通过');
  } finally {
    try { client?.disconnect?.(); } catch (_) {}
    await new Promise((resolve) => server.close(resolve));
  }
}

runVersionHistoryTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ 测试失败:', err);
    process.exit(1);
  });
