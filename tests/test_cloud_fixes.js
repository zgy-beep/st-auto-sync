const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const CloudProfileManager = require('../st-plugin/server/cloudProfileManager');
const StorageManager = require('../hub-server/src/storage');
const ManifestHelper = require('../st-plugin/server/manifestHelper');

console.log('=== 运行云母版 / 快照 GC / 环境合并 修复回归测试 ===');

const TEST_DIR = path.join(__dirname, 'temp_cloud_fixes');
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

// ----------------------------------------------------------------
// 1. secrets 逐键/逐条合并:不能因为某台设备少一把 Key 就整体替换
// ----------------------------------------------------------------
console.log('\n--- 1. secrets 安全合并 ---');
const sealed = CloudProfileManager.safeMergeSecrets(
  { api_key_custom: [{ id: 'A', value: 'key-A' }, { id: 'B', value: 'key-B-ONLY-ON-SERVER' }] },
  { api_key_custom: [{ id: 'A', value: 'key-A-updated' }] }
);
assert.strictEqual(sealed.api_key_custom.length, 2, '服务端独有的 B 键必须保留');
assert.strictEqual(sealed.api_key_custom.find((x) => x.id === 'A').value, 'key-A-updated', '同 id 应用新值');
assert.strictEqual(sealed.api_key_custom.find((x) => x.id === 'B').value, 'key-B-ONLY-ON-SERVER', 'B 键内容不能被抹掉');

const nested = CloudProfileManager.safeMergeSecrets(
  { proxy: { host: 'server-host', port: 8080 }, api_key_openai: 'old' },
  { proxy: { port: 9090 }, api_key_openai: '' }
);
assert.strictEqual(nested.proxy.host, 'server-host', '对象逐键合并,未提到的键保留');
assert.strictEqual(nested.proxy.port, 9090, '同键用新值');
assert.strictEqual(nested.api_key_openai, 'old', '空字符串不应覆盖已有密钥');

const scalarArr = CloudProfileManager.safeMergeSecrets({ allow: ['a', 'b'] }, { allow: ['b', 'c'] });
assert.deepStrictEqual(scalarArr.allow, ['a', 'b', 'c'], '标量数组应去重追加而非整体替换');
console.log('✅ 测试 1 通过:secrets 逐条合并,服务端已有 Key 不会被覆盖丢失');

// ----------------------------------------------------------------
// 2. 下发给浏览器的母版必须脱敏
// ----------------------------------------------------------------
console.log('\n--- 2. 母版接口脱敏 ---');
const manager = new CloudProfileManager(TEST_DIR);
manager.saveProfile({
  settings: { main_api: 'openai', api_server_openai: 'https://x.example/v1', api_key_openai: 'sk-should-not-leak' },
  secrets: { api_key_custom: [{ id: 'A', value: 'key-A' }] }
}, { deviceName: 'PC' });

const clientProfile = manager.getProfile({ forClient: true });
assert.strictEqual(clientProfile.secrets, undefined, '下发给客户端的母版不能带 secrets');
assert.strictEqual(clientProfile.settings.api_key_openai, undefined, 'settings 里的明文密钥也不能下发');
assert.strictEqual(clientProfile.summary.has_secrets, true, '应给出"服务端已托管密钥"的标记');
assert.strictEqual(clientProfile.settings.api_server_openai, 'https://x.example/v1', '非敏感设置应正常下发');

const serverProfile = manager.getProfile();
assert.ok(serverProfile.secrets && serverProfile.secrets.api_key_custom.length === 1, '服务端本地读取应保留完整 secrets');
console.log('✅ 测试 2 通过:客户端拿不到任何明文密钥,但知道服务端已托管');

// ----------------------------------------------------------------
// 3. 快照 GC:users/ 里有杂散文件时不再整体中断
// ----------------------------------------------------------------
console.log('\n--- 3. 快照 GC 健壮性 ---');
const HUB = path.join(TEST_DIR, 'hub');
fs.mkdirSync(path.join(HUB, 'users', 'tenant_a', '.versions', 'worlds', 'W.json'), { recursive: true });
fs.mkdirSync(path.join(HUB, 'users', 'tenant_a', '.versions', 'worlds', 'Keep.json'), { recursive: true });
const oldStamp = Date.now() - 70 * 24 * 3600 * 1000;
const freshStamp = Date.now() - 2 * 24 * 3600 * 1000;
const expiredVersion = path.join(HUB, 'users', 'tenant_a', '.versions', 'worlds', 'W.json', `${oldStamp}__PC__abc`);
const freshVersion = path.join(HUB, 'users', 'tenant_a', '.versions', 'worlds', 'Keep.json', `${freshStamp}__PC__def`);
fs.writeFileSync(expiredVersion, 'old');
fs.writeFileSync(freshVersion, 'fresh');
fs.writeFileSync(path.join(HUB, 'users', 'stray-file.txt'), 'oops'); // 杂散文件(hub 的清理循环必须跳过它)

const sm = new StorageManager(HUB);
let aborted = null;
let totalRemoved = 0;
try {
  for (const entry of fs.readdirSync(path.join(HUB, 'users'))) {
    const st = fs.statSync(path.join(HUB, 'users', entry));
    if (!st.isDirectory()) continue;
    totalRemoved += sm.cleanExpiredVersions(entry);
  }
} catch (err) {
  aborted = err.message;
}
assert.strictEqual(aborted, null, `清理循环不该被杂散文件打断:${aborted}`);
assert.strictEqual(totalRemoved, 1, '过期快照仍应被清掉');
assert.strictEqual(fs.existsSync(expiredVersion), false, '过期快照应被删除');
assert.strictEqual(fs.existsSync(freshVersion), true, '未过期快照必须保留');
assert.strictEqual(
  fs.existsSync(path.join(HUB, 'users', 'tenant_a', '.versions', 'worlds', 'W.json')),
  false,
  '清空后的版本目录应被回收(设计行为)'
);

// 清理不存在的租户时不能抛错、也不该创建目录
assert.strictEqual(sm.cleanExpiredVersions('tenant_not_exists'), 0);
assert.strictEqual(fs.existsSync(path.join(HUB, 'users', 'tenant_not_exists')), false, 'GC 不该为不存在的租户创建目录');
console.log('✅ 测试 3 通过:GC 跳过杂散文件、正常清理过期快照、不创建多余目录');

// ----------------------------------------------------------------
// 4. 环境同步:对象型配置逐键深合并,保留本机独有的键
// ----------------------------------------------------------------
console.log('\n--- 4. patchLocalSettings 深合并 ---');
const local = {
  theme: 'Mobile', font_size: 13,
  context: { story_string: '手机自己的模板', phone_only_key: 'keep-me' },
  instruct: { enabled: false },
  stop_sequence: ['local-only']
};
const remote = {
  main_api: 'openai', api_server_openai: 'https://x.example/v1',
  context: { story_string: '桌面模板', chat_start: '{{greeting}}' },
  instruct: { enabled: true, system_prompt: 'desktop' },
  stop_sequence: ['remote-only']
};
const merged = ManifestHelper.patchLocalSettings(local, remote);

assert.strictEqual(merged.theme, 'Mobile', '本机 UI 保留');
assert.strictEqual(merged.main_api, 'openai', '远端标量注入');
assert.strictEqual(merged.context.story_string, '桌面模板', '远端值优先');
assert.strictEqual(merged.context.phone_only_key, 'keep-me', '本机独有的嵌套键必须保留(旧实现会被整体替换)');
assert.strictEqual(merged.context.chat_start, '{{greeting}}', '远端新增的嵌套键注入');
assert.strictEqual(merged.instruct.system_prompt, 'desktop', '嵌套对象逐键合并');
assert.deepStrictEqual(merged.stop_sequence, ['remote-only'], '数组仍以远端为准');
console.log('✅ 测试 4 通过:嵌套对象逐键合并,本机独有配置不再被整体替换');

fs.rmSync(TEST_DIR, { recursive: true, force: true });
console.log('\n🎉 云母版 / GC / 深合并 修复回归测试全部通过');
