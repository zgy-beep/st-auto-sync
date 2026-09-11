const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

// 引入组件
const { hashToken, authMiddleware } = require('../hub-server/src/auth');
const RoomManager = require('../hub-server/src/roomManager');
const StorageManager = require('../hub-server/src/storage');
const OplogManager = require('../hub-server/src/oplog');
const SyncClient = require('../st-plugin/server/syncClient');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runE2ETest() {
  console.log('=== 开始 ST-Auto-Sync 端到端双端联调模拟测试 ===');

  const TEST_PORT = 9876;
  const TEST_BASE = path.join(__dirname, 'temp_test_env');
  const HUB_DATA = path.join(TEST_BASE, 'hub_data');
  const CLIENT_A_DIR = path.join(TEST_BASE, 'clientA_st');
  const CLIENT_B_DIR = path.join(TEST_BASE, 'clientB_st');
  const PLUGIN_A_DIR = path.join(TEST_BASE, 'pluginA');
  const PLUGIN_B_DIR = path.join(TEST_BASE, 'pluginB');

  // 清理并创建测试目录
  if (fs.existsSync(TEST_BASE)) {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  }
  fs.mkdirSync(HUB_DATA, { recursive: true });
  fs.mkdirSync(CLIENT_A_DIR, { recursive: true });
  fs.mkdirSync(CLIENT_B_DIR, { recursive: true });
  fs.mkdirSync(PLUGIN_A_DIR, { recursive: true });
  fs.mkdirSync(PLUGIN_B_DIR, { recursive: true });

  // 1. 启动独立测试用 Hub Server
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

  app.post('/api/files/upload', authMiddleware, (req, res) => {
    const { path: relPath, contentBase64, mtime } = req.body;
    const buffer = Buffer.from(contentBase64, 'base64');
    const fileMeta = storageManager.saveFile(req.userKey, relPath, buffer, mtime);
    const entry = oplogManager.append(req.userKey, {
      type: 'file_updated',
      payload: fileMeta,
      deviceId: req.headers['x-device-id']
    });
    roomManager.broadcast(req.userKey, null, { type: 'file_updated', seq: entry.seq, file: fileMeta });
    res.json({ success: true, file: fileMeta });
  });

  app.get('/api/files/download', authMiddleware, (req, res) => {
    const file = storageManager.readFile(req.userKey, req.query.path);
    if (!file) return res.status(404).send('Not found');
    res.send(file.buffer);
  });

  wss.on('connection', (ws) => {
    const client = { ws, userKey: null, deviceId: null, deviceName: null, authenticated: false };
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth') {
        const userKey = hashToken(msg.token);
        client.authenticated = true;
        client.deviceId = msg.deviceId;
        client.deviceName = msg.deviceName;
        roomManager.join(userKey, client);
        ws.send(JSON.stringify({ type: 'auth_success', userKey, deviceId: client.deviceId }));
      } else if (msg.type === 'chat_append') {
        const entry = oplogManager.append(client.userKey, {
          type: 'chat_append',
          payload: msg.payload,
          deviceId: client.deviceId
        });
        roomManager.broadcast(client.userKey, client, {
          type: 'chat_append',
          seq: entry.seq,
          senderDeviceId: client.deviceId,
          payload: msg.payload
        });
      }
    });
    ws.on('close', () => {
      if (client.authenticated) roomManager.leave(client);
    });
  });

  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`[E2E] 测试 Hub Server 已在端口 ${TEST_PORT} 启动`);

  let clientA = null;
  let clientB = null;

  try {
    // 2. 准备 Client A (PC) 的初始数据：创建角色卡与一段对话
    const aCharsDir = path.join(CLIENT_A_DIR, 'characters');
    const aChatsDir = path.join(CLIENT_A_DIR, 'chats');
    fs.mkdirSync(aCharsDir, { recursive: true });
    fs.mkdirSync(aChatsDir, { recursive: true });

    fs.writeFileSync(path.join(aCharsDir, 'Alice.png'), 'FAKE_IMAGE_DATA_FOR_ALICE');
    const initialChat = [
      JSON.stringify({ user_name: 'Player', character_name: 'Alice' }),
      JSON.stringify({ name: 'Player', is_user: true, send_date: 1000, mes: '第一句对话' }),
      JSON.stringify({ name: 'Alice', is_user: false, send_date: 2000, mes: '你好！我是爱丽丝。' })
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(aChatsDir, 'Alice - 2026-09-11.jsonl'), initialChat, 'utf8');

    // 3. 准备 Client A (PC 端) 配置
    clientA = new SyncClient(CLIENT_A_DIR, PLUGIN_A_DIR);
    clientA.updateConfig({
      hubUrl: `http://localhost:${TEST_PORT}`,
      token: 'secret-token-888',
      mode: 'realtime',
      deviceName: 'PC-Client'
    });

    // 等待 Client A 自动连接并完成 startup-sync
    await sleep(1500);
    const syncResA = await clientA.performSync('manual-test');
    console.log('[E2E] Client A 状态检查 (已自动完成同步):', syncResA);
    assert.strictEqual(syncResA.success, true);

    // 4. 初始化 Client B (手机 Termux 端，初始为空)
    clientB = new SyncClient(CLIENT_B_DIR, PLUGIN_B_DIR);
    clientB.updateConfig({
      hubUrl: `http://localhost:${TEST_PORT}`,
      token: 'secret-token-888',
      mode: 'realtime',
      deviceName: 'Phone-Termux'
    });

    // 等待 Client B 自动连接并完成 startup-sync (拉取远端文件)
    await sleep(2000);

    // 验证 Client B 本地文件内容
    const bChar = fs.readFileSync(path.join(CLIENT_B_DIR, 'characters', 'Alice.png'), 'utf8');
    assert.strictEqual(bChar, 'FAKE_IMAGE_DATA_FOR_ALICE');
    const bChat = fs.readFileSync(path.join(CLIENT_B_DIR, 'chats', 'Alice - 2026-09-11.jsonl'), 'utf8');
    assert.ok(bChat.includes('你好！我是爱丽丝。'));
    console.log('✅ [E2E 阶段1] 全量资产同步与哈希校验通过！');

    // 5. 测试【实时同屏联动】：Client A 发送一条实时消息，Client B 即时捕获并追加
    let clientBReceivedEvent = null;
    clientB.addUiListener((event, payload) => {
      if (event === 'chat_updated') {
        clientBReceivedEvent = payload;
      }
    });

    const liveMsg = {
      name: 'Player',
      is_user: true,
      send_date: 3000,
      mes: '这是电脑端实时发送的一句新话！'
    };

    console.log('[E2E] Client A 正在发送实时消息...');
    clientA.onLocalChatSent('chats/Alice - 2026-09-11.jsonl', 'Alice', liveMsg);

    // 等待 WebSocket 广播推送
    await sleep(1000);

    assert.ok(clientBReceivedEvent, 'Client B 必须触发 chat_updated 前端通知事件！');
    assert.strictEqual(clientBReceivedEvent.characterName, 'Alice');

    // 检查 Client B 的本地文件是否已经被成功追加写入该消息
    const bChatUpdated = fs.readFileSync(path.join(CLIENT_B_DIR, 'chats', 'Alice - 2026-09-11.jsonl'), 'utf8');
    assert.ok(bChatUpdated.includes('这是电脑端实时发送的一句新话！'), 'Client B 本地聊天记录必须包含新消息');
    console.log('✅ [E2E 阶段2] 实时 WebSocket 毫秒级同屏热更新测试通过！');

    // 6. 测试【离线断网与 Hub 权威集中合并】：
    // Client B 离线（模拟在地铁没有网络），并在手机上追加了一句 AI 回复：
    clientB.stop();
    const phoneOfflineMsg = JSON.stringify({
      name: 'Alice',
      is_user: false,
      send_date: 3500,
      mes: '手机在离线时保存的记录。'
    }) + '\n';
    fs.appendFileSync(path.join(CLIENT_B_DIR, 'chats', 'Alice - 2026-09-11.jsonl'), phoneOfflineMsg);

    // 手机重新上线并触发同步（提交 Commit 到 Hub 仲裁）
    clientB.start();
    await sleep(800);
    const syncResAfterRejoin = await clientB.performSync('manual-rejoin');
    console.log('[E2E] 离线合并同步结果:', syncResAfterRejoin);

    // Client A 从 Hub 接收权威裁决结果
    await clientA.performSync('manual-pull');

    // 验证 Client B 和 Client A 的最终聊天文件完全一致收敛
    const finalChatA = fs.readFileSync(path.join(CLIENT_A_DIR, 'chats', 'Alice - 2026-09-11.jsonl'), 'utf8');
    const finalChatB = fs.readFileSync(path.join(CLIENT_B_DIR, 'chats', 'Alice - 2026-09-11.jsonl'), 'utf8');
    assert.ok(finalChatA.includes('手机在离线时保存的记录。'), '电脑端必须通过Hub权威收敛获取到手机端记录');
    assert.strictEqual(finalChatA, finalChatB, '双端最终内容必须严格一致收敛！');
    console.log('✅ [E2E 阶段3] 离线断网增量集中仲裁与双端严格一致收敛通过！');

    console.log('🎉🎉 恭喜！端到端全链路自动化联调测试 100% 全部通过！');
    process.exit(0);
  } finally {
    // 释放资源，关闭文件句柄
    if (clientA) clientA.stop();
    if (clientB) clientB.stop();
    server.close();
    wss.close();
    await sleep(200);
    try {
      if (fs.existsSync(TEST_BASE)) {
        fs.rmSync(TEST_BASE, { recursive: true, force: true });
      }
    } catch (_) {}
  }
}

runE2ETest().catch((err) => {
  console.error('❌ E2E 测试失败:', err);
  process.exit(1);
});
