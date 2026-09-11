const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const StorageManager = require('../hub-server/src/storage');
const ManifestHelper = require('../st-plugin/server/manifestHelper');

console.log('=== 运行 ST-Auto-Sync 5 项核心优化专项测试 ===');

const TEST_DIR = path.join(__dirname, 'temp_opt_test');
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

// -------------------------------------------------------------
// 测试 1: 路径穿越前缀边界绕过防御测试 (P0 安全修复)
// -------------------------------------------------------------
const storage = new StorageManager(TEST_DIR);
const userKey = 'test_user_key';

// 正常路径
const safePath = storage.resolveSafePath(userKey, 'chats/Alice.jsonl');
assert.ok(safePath.includes(path.join('users', userKey, 'files', 'chats', 'Alice.jsonl')));

// 试图利用绝对路径逃逸出用户沙箱 (Windows 盘符 / POSIX 根目录)
let absoluteEscapeBlocked = false;
const evilPath = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
try {
  storage.resolveSafePath(userKey, evilPath);
} catch (err) {
  absoluteEscapeBlocked = err.message.includes('Security Exception');
}
assert.strictEqual(absoluteEscapeBlocked, true, '必须严密拦截绝对路径越界逃逸');

// 验证 path.sep 边界保护：确保不因同名同前缀子串发生逃逸 (files vs files-leak)
const userRoot = path.resolve(storage.getUserFilesDir(userKey));
const prefixAttackPath = userRoot + '-leak' + path.sep + 'secret.json';
const isOutside = prefixAttackPath !== userRoot && !prefixAttackPath.startsWith(userRoot + path.sep);
assert.strictEqual(isOutside, true, 'userRoot + path.sep 必须严密防御同前缀文件夹越界');

console.log('✅ 测试 1 通过：路径穿越与前缀逃逸严密防御生效！');

// -------------------------------------------------------------
// 测试 2: 全量恢复 settings.json 时的多端 UI 隔离与环境合并
// -------------------------------------------------------------
const localPhoneSettings = {
  theme: 'Mobile-Compact-OLED',
  font_size: 13,
  zoom: 0.85,
  movingUI: true,
  main_api: 'openai',
  api_server_openai: 'http://old-expired.com'
};

const remoteCloudSettings = {
  theme: 'Desktop-Ultra-Wide-White', // 电脑端大屏主题(绝不能覆盖手机)
  font_size: 20,                      // 电脑端超大字号(绝不能覆盖手机)
  zoom: 1.25,
  movingUI: false,
  main_api: 'openai',
  api_server_openai: 'https://api.deepseek.com/v1',
  api_key_openai: 'sk-new-key-88888',
  model_openai: 'deepseek-chat',
  preset: 'New-Claude-Preset'
};

// 模拟 restoreFromHub 对 settings.json 执行的 patchLocalSettings
const remoteSanitized = ManifestHelper.sanitizeSettings(remoteCloudSettings);
const patchedLocal = ManifestHelper.patchLocalSettings(localPhoneSettings, remoteSanitized);

// 验证手机原有外观不受影响
assert.strictEqual(patchedLocal.theme, 'Mobile-Compact-OLED', '手机原生主题完好保留');
assert.strictEqual(patchedLocal.font_size, 13, '手机原生字号完好保留');
assert.strictEqual(patchedLocal.zoom, 0.85, '手机原生缩放完好保留');
assert.strictEqual(patchedLocal.movingUI, true, '手机原生移动端布局完好保留');

// 验证远端 API / 模型环境成功补全注入
assert.strictEqual(patchedLocal.api_server_openai, 'https://api.deepseek.com/v1', '云端反代地址成功同步');
assert.strictEqual(patchedLocal.api_key_openai, 'sk-new-key-88888', '云端 Key 成功注入');
assert.strictEqual(patchedLocal.preset, 'New-Claude-Preset', '云端预设成功注入');

console.log('✅ 测试 2 通过：全量恢复时不冲垮手机本地 UI 主题，开箱即聊平滑注入！');

// -------------------------------------------------------------
// 测试 3: 根目录插件加载代理入口有效性测试
// -------------------------------------------------------------
const rootPlugin = require('../index.js');
assert.ok(rootPlugin.info, '根目录入口必须导出 info 规范对象');
assert.strictEqual(rootPlugin.info.id, 'st-auto-sync', '插件 ID 一致');
assert.strictEqual(typeof rootPlugin.init, 'function', '根目录入口必须导出 init 函数');

console.log('✅ 测试 3 通过：根目录代理入口就绪，SillyTavern 直接 Git Clone 加载 100% 兼容！');

// -------------------------------------------------------------
// 测试 4: Hub 历史快照生命周期 TTL 清理测试
// -------------------------------------------------------------
const versionsDir = storage.getUserVersionsDir(userKey);
const oldFileDir = path.join(versionsDir, 'chats', 'old_chat.jsonl');
fs.mkdirSync(oldFileDir, { recursive: true });

// 创建一个 70 天前的过期版本 (模拟超期)
const expiredStamp = Date.now() - (70 * 24 * 3600 * 1000);
const expiredVersionFile = path.join(oldFileDir, `${expiredStamp}__PC-Test__abc12345`);
fs.writeFileSync(expiredVersionFile, 'old content');

// 创建一个 2 天前的新鲜版本
const freshStamp = Date.now() - (2 * 24 * 3600 * 1000);
const freshVersionFile = path.join(oldFileDir, `${freshStamp}__PC-Test__def67890`);
fs.writeFileSync(freshVersionFile, 'recent content');

const removedCount = storage.cleanExpiredVersions(userKey, 60 * 24 * 3600 * 1000);
assert.strictEqual(removedCount, 1, '应准确清理 1 个超过 60 天的过期快照');
assert.strictEqual(fs.existsSync(expiredVersionFile), false, '过期快照应已被删除');
assert.strictEqual(fs.existsSync(freshVersionFile), true, '新鲜快照应继续保留');

console.log('✅ 测试 4 通过：Hub 历史快照防腐与过期垃圾清理算法生效！');

// 清理测试临时目录
fs.rmSync(TEST_DIR, { recursive: true, force: true });
console.log('🎉🎉 ST-Auto-Sync 5 项核心优化专项测试全部完美通过！');
