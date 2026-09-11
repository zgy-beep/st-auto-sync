const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const CloudProfileManager = require('../st-plugin/server/cloudProfileManager');

console.log('=== 运行 ST-Auto-Sync 云酒馆配置中心 (Cloud Profile Master) 专项测试 ===');

const TEST_DIR = path.join(__dirname, 'temp_cloud_profile_test');
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

const manager = new CloudProfileManager(TEST_DIR);

// 1. 测试未固化时 getProfile 返回 null
assert.strictEqual(manager.getProfile(), null, '初始状态下未固化母版应返回 null');
console.log('✅ 测试 1 通过：未固化时返回 null 正确');

// 2. 模拟用户在电脑上配置好环境并提交固化
const mockBrowserEnvironment = {
  settings: {
    // 发消息必需项
    main_api: 'openai',
    api_server_openai: 'https://api.deepseek.com/v1',
    api_key_openai: 'sk-deepseek-test-key-123456',
    model_openai: 'deepseek-chat',
    openai_model: 'deepseek-chat',
    preset: 'My-Roleplay-Preset',
    context: 'Standard-Context',
    instruct: 'Default-Alpaca',
    temp: 0.75,
    max_tokens: 3000,
    // 特定设备的 UI 外观项（必须被剥离！）
    theme: 'PC-Desktop-Wide-White',
    font_size: 19,
    zoom: 1.2,
    movingUI: false
  },
  secrets: {
    api_keys: {
      openai: 'sk-deepseek-test-key-123456',
      claude: 'sk-ant-test-key'
    }
  }
};

const savedProfile = manager.saveProfile(mockBrowserEnvironment, {
  deviceName: 'My-Desktop-PC'
});

assert.ok(savedProfile, '固化母版返回值必须存在');
assert.strictEqual(savedProfile.version, '1.0.0');
assert.strictEqual(savedProfile.updated_by, 'My-Desktop-PC');
assert.strictEqual(savedProfile.settings.main_api, 'openai');
assert.strictEqual(savedProfile.settings.api_server_openai, 'https://api.deepseek.com/v1');
assert.strictEqual(savedProfile.settings.model_openai, 'deepseek-chat');
assert.strictEqual(savedProfile.settings.preset, 'My-Roleplay-Preset');

// 验证 UI 外观项已被彻底剔除
assert.strictEqual(savedProfile.settings.theme, undefined, 'PC 端大屏主题必须被剔除');
assert.strictEqual(savedProfile.settings.font_size, undefined, 'PC 端大字号必须被剔除');
assert.strictEqual(savedProfile.settings.zoom, undefined, 'PC 端缩放必须被剔除');

// 验证落盘文件存在且内容正确
const diskProfile = manager.getProfile();
assert.ok(diskProfile, '磁盘中必须成功读取 cloud_profile.json');
assert.strictEqual(diskProfile.settings.api_key_openai, 'sk-deepseek-test-key-123456');
assert.strictEqual(diskProfile.summary.main_api, 'openai');
assert.strictEqual(diskProfile.summary.model, 'deepseek-chat');

// 验证服务端 secrets.json 是否被同步更新
const secretsFile = path.join(TEST_DIR, 'secrets.json');
assert.ok(fs.existsSync(secretsFile), '服务端 secrets.json 必须同步生成');
const readSecrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
assert.strictEqual(readSecrets.api_keys.claude, 'sk-ant-test-key');

console.log('✅ 测试 2 通过：电脑端环境成功固化为云端母版，UI 隔离与 secrets 写入无误！');

// 3. 模拟手机/新设备登入云酒馆时的自动注水 (Auto-Hydration)
const mockPhoneBrowser = {
  localStorage: new Map(),
  contextSettings: {
    theme: 'Mobile-Compact-OLED',
    font_size: 13,
    movingUI: true
  }
};

// 模拟前端注水操作：将云端母版灌入手机端
for (const [k, v] of Object.entries(diskProfile.settings)) {
  mockPhoneBrowser.localStorage.set(k, String(v));
}
Object.assign(mockPhoneBrowser.contextSettings, diskProfile.settings);

// 验证手机原有 UI 依然保持原样
assert.strictEqual(mockPhoneBrowser.contextSettings.theme, 'Mobile-Compact-OLED', '手机原生暗色小屏主题完好');
assert.strictEqual(mockPhoneBrowser.contextSettings.font_size, 13, '手机原生字号完好');
assert.strictEqual(mockPhoneBrowser.contextSettings.movingUI, true, '手机原生移动端控件完好');

// 验证手机浏览器已自动就绪 API 与模型
assert.strictEqual(mockPhoneBrowser.localStorage.get('api_server_openai'), 'https://api.deepseek.com/v1');
assert.strictEqual(mockPhoneBrowser.localStorage.get('api_key_openai'), 'sk-deepseek-test-key-123456');
assert.strictEqual(mockPhoneBrowser.contextSettings.model_openai, 'deepseek-chat');
assert.strictEqual(mockPhoneBrowser.contextSettings.preset, 'My-Roleplay-Preset');

console.log('✅ 测试 3 通过：手机新设备初次打开模拟注水 100% 成功，无需输入任何配置直接开聊！');

// 4. 测试 captureCurrentServerEnvironment（直接从服务器磁盘抓取环境生成母版）
fs.writeFileSync(path.join(TEST_DIR, 'settings.json'), JSON.stringify({
  main_api: 'claude',
  claude_model: 'claude-3-5-sonnet-20241022',
  preset: 'Claude-Opus-Preset'
}));
const capturedProfile = manager.captureCurrentServerEnvironment({ deviceName: 'Server-Direct' });
assert.strictEqual(capturedProfile.settings.main_api, 'claude');
assert.strictEqual(capturedProfile.summary.preset, 'Claude-Opus-Preset');
console.log('✅ 测试 4 通过：直接抓取服务器磁盘环境生成母版正常！');

// 清理测试目录
fs.rmSync(TEST_DIR, { recursive: true, force: true });
console.log('🎉🎉 ST-Auto-Sync 云酒馆配置中心专项测试全部顺利通过！');
