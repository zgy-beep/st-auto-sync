const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const crypto = require('node:crypto');
const atomicWriter = require('../st-plugin/server/atomicWriter');

console.log('=== 运行 AtomicWriter 双写竞态防护测试 ===');

const testDir = path.join(__dirname, 'temp_atomic_test');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const targetFile = path.join(testDir, 'test_chat.jsonl');

async function testConcurrentWrites() {
  console.log('--- 测试 1: 并发互斥排队 ---');
  fs.writeFileSync(targetFile, 'INITIAL\n');

  // 并发派发 5 个写任务
  const promises = [];
  for (let i = 1; i <= 5; i++) {
    promises.push(
      atomicWriter.safeWrite(targetFile, Buffer.from(`WRITE_${i}\n`))
    );
  }

  await Promise.all(promises);
  const finalContent = fs.readFileSync(targetFile, 'utf8');
  assert.strictEqual(finalContent, 'WRITE_5\n', '所有写入必须互斥排队，最终为最后一次完成写入');
  console.log('✅ 测试 1 通过：互斥锁排队正常！');
}

async function testCheckBeforeWriteConflict() {
  console.log('--- 测试 2: Check-Before-Write 竞态冲突保护 ---');
  fs.writeFileSync(targetFile, 'OLD_BASE\n');
  const baseHash = crypto.createHash('sha256').update(Buffer.from('OLD_BASE\n')).digest('hex');

  // 模拟：在网络下载期间，ST 主进程向磁盘写入了用户的新输入 'USER_TYPING_JUST_NOW\n'
  fs.writeFileSync(targetFile, 'USER_TYPING_JUST_NOW\n');

  let conflictCaught = false;

  // 插件准备写入 Hub 的权威版本 'HUB_AUTHORITATIVE\n'
  await atomicWriter.safeWrite(
    targetFile,
    Buffer.from('HUB_AUTHORITATIVE\n'),
    baseHash, // 传入下载前的旧哈希
    (localBuf, hubBuf) => {
      // 冲突保护回调：将本地新打的内容与 Hub 内容拼接保留
      conflictCaught = true;
      return Buffer.concat([hubBuf, localBuf]);
    }
  );

  assert.strictEqual(conflictCaught, true, '必须成功捕获到 Check-Before-Write 竞态');
  const result = fs.readFileSync(targetFile, 'utf8');
  assert.ok(result.includes('USER_TYPING_JUST_NOW'), '用户刚打下的新内容绝对不能丢失！');
  assert.ok(result.includes('HUB_AUTHORITATIVE'), 'Hub 权威内容也必须包含');
  console.log('✅ 测试 2 通过：Check-Before-Write 成功防御了双写竞态，零丢失！');
}

async function run() {
  try {
    await testConcurrentWrites();
    await testCheckBeforeWriteConflict();
    console.log('🎉🎉 AtomicWriter 竞态防护测试全部通过！');
  } finally {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
