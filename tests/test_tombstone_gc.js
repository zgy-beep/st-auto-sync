const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const TombstoneGCManager = require('../hub-server/src/tombstoneGC');

console.log('=== 运行 Tombstone 30天独立生命周期与 Device ACK 测试 ===');

const testDir = path.join(__dirname, 'temp_gc_test');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const gcManager = new TombstoneGCManager(testDir);
const userKey = 't_test_user_uuid';

async function runGCTest() {
  const now = Date.now();
  const DAY_MS = 24 * 3600 * 1000;

  // 1. 注册两台设备：PC (活跃) 和 手机 (活跃)
  gcManager.recordDeviceAck(userKey, 'PC-Client', 100);
  gcManager.recordDeviceAck(userKey, 'Phone-Client', 100);

  // 构造 2 个墓碑：
  // tb1: 35天前删除，delete_seq = 80
  const tb1 = { mid: 'msg_old_deleted', deleted_at: now - 35 * DAY_MS, delete_seq: 80 };
  // tb2: 5天前删除，delete_seq = 105
  const tb2 = { mid: 'msg_recent_deleted', deleted_at: now - 5 * DAY_MS, delete_seq: 105 };

  // 场景 1: tb1 满足 30天且 seq <= 100，应该被成功物理回收；tb2 未满30天保留
  const res1 = gcManager.purgeEligibleTombstones(userKey, [tb1, tb2]);
  assert.strictEqual(res1.purgedCount, 1, 'tb1 应该被物理清除');
  assert.strictEqual(res1.retained.length, 1);
  assert.strictEqual(res1.retained[0].mid, 'msg_recent_deleted');
  console.log('✅ 测试 1 通过：超期且已获全员 ACK 的墓碑被准确清理！');

  // 场景 2: 模拟一台老设备 iPad 离线了 40 天（变成了 Stale 设备）
  // 它的 last_sync_seq 卡在 50
  const map = gcManager.deviceRegistry.get(userKey);
  map.set('iPad-Old', {
    last_sync_seq: 50,
    last_seen_at: now - 40 * DAY_MS,
    is_stale: false
  });

  // 构造 tb3: 32天前删除，delete_seq = 70
  // 如果 iPad 没有被剔除，minAck 将是 50 < 70，导致 tb3 永远无法回收（死锁！）
  const tb3 = { mid: 'msg_stale_target', deleted_at: now - 32 * DAY_MS, delete_seq: 70 };

  const res2 = gcManager.purgeEligibleTombstones(userKey, [tb3]);
  // 核心断言：iPad 离线超 30 天自动标记为 Stale，不再参与 ACK 阻塞，tb3 必须被成功回收！
  assert.strictEqual(res2.purgedCount, 1, 'Stale 设备不得阻塞墓碑 GC 回收！');
  assert.strictEqual(res2.retained.length, 0);
  console.log('✅ 测试 2 通过：Stale 设备被自动排除，彻底破除 GC 死锁难题！');

  console.log('🎉🎉 Tombstone GC 核心算法测试全部通过！');
}

runGCTest()
  .then(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
