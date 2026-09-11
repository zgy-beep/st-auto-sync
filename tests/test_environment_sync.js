const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ManifestHelper = require('../st-plugin/server/manifestHelper');

console.log('=== 运行 ST-Auto-Sync 开箱即聊（免重配）与 UI 隔离测试 ===');

// 1. 测试 sanitizeSettings 白名单过滤与 UI 隔离
const mockDesktopSettings = {
  theme: 'Midnight-Dark',
  font_size: 18,
  zoom: 1.2,
  movingUI: true,
  port: 8000,
  listen: true,
  custom_gui_styles: { button_radius: 12 },
  // 核心发消息必用配置
  main_api: 'openai',
  api_server_openai: 'https://api.deepseek.com/v1',
  api_key_openai: 'sk-abcdef123456',
  model_openai: 'deepseek-chat',
  openai_model: 'deepseek-chat',
  preset: 'Default-Roleplay',
  context: 'Story-Context',
  instruct: 'Alpaca',
  temp: 0.85,
  max_tokens: 4096,
  top_p: 0.95,
  stream: true,
  world_info: ['Eldoria_Lore'],
  persona_selected: 'Traveler'
};

const sanitized = ManifestHelper.sanitizeSettings(mockDesktopSettings);

// 验证所有 UI 与机器专有项均被彻底剔除
assert.strictEqual(sanitized.theme, undefined, 'UI 主题必须被剔除');
assert.strictEqual(sanitized.font_size, undefined, 'UI 字号必须被剔除');
assert.strictEqual(sanitized.zoom, undefined, 'UI 缩放比例必须被剔除');
assert.strictEqual(sanitized.movingUI, undefined, '移动端 UI 布局必须被剔除');
assert.strictEqual(sanitized.port, undefined, '本地监听端口必须被剔除');
assert.strictEqual(sanitized.listen, undefined, '本地网络绑定必须被剔除');
assert.strictEqual(sanitized.custom_gui_styles, undefined, '自定义界面样式必须被剔除');

// 验证发消息所需的环境配置 100% 完整保留
assert.strictEqual(sanitized.main_api, 'openai');
assert.strictEqual(sanitized.api_server_openai, 'https://api.deepseek.com/v1');
assert.strictEqual(sanitized.api_key_openai, 'sk-abcdef123456');
assert.strictEqual(sanitized.model_openai, 'deepseek-chat');
assert.strictEqual(sanitized.preset, 'Default-Roleplay');
assert.strictEqual(sanitized.temp, 0.85);
assert.strictEqual(sanitized.max_tokens, 4096);
assert.strictEqual(sanitized.stream, true);
assert.strictEqual(sanitized.persona_selected, 'Traveler');

console.log('✅ 测试 1 通过：API / Key / 模型 / 预设白名单提取精准，UI 布局配置被完整剥离！');

// 2. 测试 patchLocalSettings 手机端合并验证（保留手机自身 UI，注入远端 API）
const mockMobileExistingSettings = {
  theme: 'Mobile-Compact-OLED',
  font_size: 14,
  zoom: 0.9,
  movingUI: false,
  // 手机端之前未配置或配置了过期的 key
  main_api: 'kobold',
  api_server_openai: ''
};

const mergedPhoneSettings = ManifestHelper.patchLocalSettings(mockMobileExistingSettings, sanitized);

// 手机本地 UI 属性未被破坏
assert.strictEqual(mergedPhoneSettings.theme, 'Mobile-Compact-OLED', '手机端自身暗黑/微缩主题未被覆盖');
assert.strictEqual(mergedPhoneSettings.font_size, 14, '手机端字号未被覆盖');
assert.strictEqual(mergedPhoneSettings.zoom, 0.9, '手机端缩放未被覆盖');
assert.strictEqual(mergedPhoneSettings.movingUI, false, '手机端 movingUI 设置保留');

// 手机端成功继承了电脑端的 API、Key 与模型配置，实现安装即聊
assert.strictEqual(mergedPhoneSettings.main_api, 'openai', '主 API 成功注入');
assert.strictEqual(mergedPhoneSettings.api_server_openai, 'https://api.deepseek.com/v1', '反代地址成功注入');
assert.strictEqual(mergedPhoneSettings.api_key_openai, 'sk-abcdef123456', 'API Key 成功注入');
assert.strictEqual(mergedPhoneSettings.preset, 'Default-Roleplay', '生成预设成功注入');

console.log('✅ 测试 2 通过：手机端本地 UI 完整保留，远端 API / 模型环境无缝打补丁！');

// 3. 测试 generateLocalManifest 对 secrets.json 与 settings.json 的扫描
const tempTestDir = path.join(__dirname, 'temp_manifest_env_test');
if (fs.existsSync(tempTestDir)) {
  fs.rmSync(tempTestDir, { recursive: true, force: true });
}
fs.mkdirSync(tempTestDir, { recursive: true });

fs.writeFileSync(path.join(tempTestDir, 'secrets.json'), JSON.stringify({ api_keys: { openai: 'secret-key-123' } }));
fs.writeFileSync(path.join(tempTestDir, 'settings.json'), JSON.stringify(mockDesktopSettings));

const helper = new ManifestHelper(tempTestDir);
const manifest = helper.generateLocalManifest({ syncEnvironment: true });

assert.ok(manifest['secrets.json'], 'secrets.json 必须在清单中');
assert.ok(manifest['settings.json'], 'settings.json 必须在清单中');
assert.ok(manifest['secrets.json'].hash, 'secrets.json 必须具有有效哈希');
assert.ok(manifest['settings.json'].hash, 'settings.json 必须具有有效哈希');

fs.rmSync(tempTestDir, { recursive: true, force: true });
console.log('✅ 测试 3 通过：secrets.json 与核心设置项自动纳入同步清单！');

console.log('🎉🎉 开箱即聊环境同步与 UI 隔离测试全部通过！');
