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

// -------------------------------------------------------------
// 1. 测试未固化时 getProfile 返回 null
// -------------------------------------------------------------
assert.strictEqual(manager.getProfile(), null, '初始状态下未固化母版应返回 null');
console.log('✅ 测试 1 通过：未固化时返回 null 正确');

// -------------------------------------------------------------
// 2. 测试 Bug ①：安全合并 secrets 杜绝 api_key_custom 数组截断与已有私钥丢失
// -------------------------------------------------------------
const serverExistingSecrets = {
  api_key_openai: 'sk-server-openai-original',
  api_key_custom: [
    { id: 'custom-openai', value: 'sk-custom-openai-v1', url: 'https://openai.example.com' },
    { id: 'custom-claude', value: 'sk-custom-claude-original', url: 'https://claude.example.com' }
  ],
  api_keys: {
    gemini: 'sk-gemini-server-key',
    anthropic: 'sk-anthropic-server-key'
  }
};
fs.writeFileSync(path.join(TEST_DIR, 'secrets.json'), JSON.stringify(serverExistingSecrets, null, 2), 'utf8');

// 客户端仅修改了 custom-openai 并新增了 deepseek，未包含 custom-claude
const clientIncomingEnvironment = {
  settings: {
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
    api_key_custom: [
      { id: 'custom-openai', value: 'sk-custom-openai-v2' },
      { id: 'custom-deepseek', value: 'sk-deepseek-new' }
    ],
    api_keys: {
      anthropic: 'sk-anthropic-server-key-updated'
    }
  }
};

const savedProfile = manager.saveProfile(clientIncomingEnvironment, {
  deviceName: 'My-Desktop-PC'
});

assert.ok(savedProfile, '固化母版返回值必须存在');
assert.strictEqual(savedProfile.version, '1.0.0');
assert.strictEqual(savedProfile.updated_by, 'My-Desktop-PC');
assert.strictEqual(savedProfile.settings.theme, undefined, 'PC 端大屏主题必须被剔除');
assert.strictEqual(savedProfile.settings.font_size, undefined, 'PC 端大字号必须被剔除');

// 检查落盘的 secrets.json：验证 Bug ① 彻底修复
const secretsOnDisk = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'secrets.json'), 'utf8'));
assert.strictEqual(secretsOnDisk.api_key_openai, 'sk-deepseek-test-key-123456', '更新的 OpenAI 密钥写入正确');
assert.strictEqual(secretsOnDisk.api_keys.gemini, 'sk-gemini-server-key', '未被提及的 gemini 密钥被安全保留，未被抹去！');
assert.strictEqual(secretsOnDisk.api_keys.anthropic, 'sk-anthropic-server-key-updated', 'anthropic 密钥更新正确');

// 验证 api_key_custom 数组合并
const customArr = secretsOnDisk.api_key_custom;
assert.strictEqual(customArr.length, 3, 'api_key_custom 数组合并后应为 3 项，原有项不得截断丢失！');
const claudeItem = customArr.find(x => x.id === 'custom-claude');
assert.ok(claudeItem, 'custom-claude 必须依然完好存在');
assert.strictEqual(claudeItem.value, 'sk-custom-claude-original');
const openaiItem = customArr.find(x => x.id === 'custom-openai');
assert.strictEqual(openaiItem.value, 'sk-custom-openai-v2', 'custom-openai 成功更新');
const deepseekItem = customArr.find(x => x.id === 'custom-deepseek');
assert.strictEqual(deepseekItem.value, 'sk-deepseek-new', 'custom-deepseek 成功追加');

console.log('✅ 测试 2 通过：Bug ① 修复验证成功！safeMergeSecrets 确保 api_key_custom 数组增量更新，服务端现有密钥零丢失！');

// -------------------------------------------------------------
// 3. 测试 Bug ③：脱敏下发与防私钥泄漏 (forClient: true)
// -------------------------------------------------------------
const clientSafeProfile = manager.getProfile({ forClient: true });
assert.strictEqual(clientSafeProfile.secrets, undefined, '下发给客户端的母版中绝不可包含 secrets 对象！');
assert.strictEqual(clientSafeProfile.settings.api_key_openai, undefined, '下发给客户端的母版 settings 中绝不可包含 api_key_*！');
assert.strictEqual(clientSafeProfile.settings.main_api, 'openai', '非敏感配置 main_api 正常下发');
assert.strictEqual(clientSafeProfile.settings.api_server_openai, 'https://api.deepseek.com/v1', '反代地址正常下发');
assert.strictEqual(clientSafeProfile.settings.model_openai, 'deepseek-chat', '模型正常下发');
assert.strictEqual(clientSafeProfile.settings.preset, 'My-Roleplay-Preset', '预设正常下发');
assert.strictEqual(clientSafeProfile.summary.has_secrets, true, 'summary 标识服务端已具备密钥');

console.log('✅ 测试 3 通过：Bug ③ 修复验证成功！服务端下发母版实现严格脱敏，绝不向网络泄露私钥！');

// -------------------------------------------------------------
// 4. 测试 Bug ② & Bug ④：真实前端 DOM / 存储环境注水与循环注水防抖测试
// -------------------------------------------------------------
// 构建真实轻量 DOM / Web 环境
const mockStorage = new Map();
const mockLocalStorage = {
  getItem: (k) => (mockStorage.has(k) ? mockStorage.get(k) : null),
  setItem: (k, v) => mockStorage.set(k, String(v)),
  removeItem: (k) => mockStorage.delete(k),
  clear: () => mockStorage.clear(),
  key: (i) => Array.from(mockStorage.keys())[i] || null,
  get length() { return mockStorage.size; }
};

const domElements = new Map();
const createMockElement = (id) => ({
  id,
  value: '',
  dispatchEvent: () => {},
  click: () => {},
  classList: { add: () => {}, remove: () => {} },
  style: {},
  textContent: '',
  innerHTML: ''
});

const mockDocument = {
  querySelector: (sel) => {
    if (!domElements.has(sel)) domElements.set(sel, createMockElement(sel));
    return domElements.get(sel);
  },
  getElementById: (id) => {
    if (!domElements.has(id)) domElements.set(id, createMockElement(id));
    return domElements.get(id);
  },
  addEventListener: () => {}
};

const mockContext = {
  settings: {
    theme: 'Mobile-Compact-OLED',
    font_size: 13,
    movingUI: true
  },
  saveSettingsDebounced: () => {}
};

// 挂载全局环境以加载公共前端模块
global.window = {
  __ST_TEST_SKIP_INIT: true,
  toastr: { success: () => {}, info: () => {}, warning: () => {}, error: () => {} },
  SillyTavern: { getContext: () => mockContext }
};
global.document = mockDocument;
global.localStorage = mockLocalStorage;
global.Event = class { constructor(type) { this.type = type; } };

// 加载前端模块
const frontend = require('../st-plugin/public/index.js');

// 4.1 测试 applyCloudProfile: 前端注入不将私钥写入 localStorage
frontend.applyCloudProfile(clientSafeProfile, true);

// 验证非敏感配置已写入 localStorage
assert.strictEqual(mockLocalStorage.getItem('main_api'), 'openai');
assert.strictEqual(mockLocalStorage.getItem('api_server_openai'), 'https://api.deepseek.com/v1');
assert.strictEqual(mockLocalStorage.getItem('model_openai'), 'deepseek-chat');
assert.strictEqual(mockLocalStorage.getItem('preset'), 'My-Roleplay-Preset');

// 验证手机原生 UI 依然完好
assert.strictEqual(mockContext.settings.theme, 'Mobile-Compact-OLED', '手机原生主题完好保留');
assert.strictEqual(mockContext.settings.font_size, 13, '手机原生字号完好保留');
assert.strictEqual(mockContext.settings.movingUI, true, '手机原生控件完好保留');

// 验证 localStorage 绝对不含明文私钥
assert.strictEqual(mockLocalStorage.getItem('api_key_openai'), null, 'localStorage 绝不存明文密钥');
assert.strictEqual(mockLocalStorage.getItem('st_auto_sync_hydrated_v1'), 'true', '注水完成标记成功写入');

console.log('✅ 测试 4.1 通过：前端真实注水逻辑验证通过，UI 隔离完好且绝不向 localStorage 写入明文私钥！');

// 4.2 测试 checkAndHydrateCloudProfile 循环注水防护 (Bug ②)
// 模拟用户在手机上对温度参数进行了微调
mockContext.settings.temp = 0.95;
mockLocalStorage.setItem('temp', '0.95');

let fetchCount = 0;
global.fetch = async (url) => {
  if (url.includes('/cloud-profile')) {
    fetchCount++;
    return {
      ok: true,
      json: async () => ({ success: true, profile: clientSafeProfile })
    };
  }
  return { ok: false };
};

// 模拟页面刷新（此时 st_auto_sync_hydrated_v1 已经是 'true'）
frontend.checkAndHydrateCloudProfile();

assert.strictEqual(fetchCount, 0, '页面二次刷新时不应重复请求 cloud-profile！');
assert.strictEqual(mockContext.settings.temp, 0.95, '用户的本地运行时微调未被重复注水冲垮！');

// 模拟纯空白新设备打开网页（本地存储与运行时设置均为空白）
mockLocalStorage.clear();
mockContext.settings = {
  theme: 'Mobile-Compact-OLED',
  font_size: 13,
  movingUI: true
};
fetchCount = 0;
assert.strictEqual(mockLocalStorage.getItem('st_auto_sync_hydrated_v1'), null);

frontend.checkAndHydrateCloudProfile().then(() => {
  assert.strictEqual(fetchCount, 1, '纯新设备应触发一次母版注水！');
  assert.strictEqual(mockLocalStorage.getItem('st_auto_sync_hydrated_v1'), 'true', '纯新设备注水后标记写入');

  // 再次触发（模拟新设备刷新）
  frontend.checkAndHydrateCloudProfile().then(() => {
    assert.strictEqual(fetchCount, 1, '新设备刷新后不会二次请求母版！');
    console.log('✅ 测试 4.2 通过：Bug ② 修复验证成功！st_auto_sync_hydrated_v1 可靠拦截重复注水，彻底杜绝冲垮移动端设置！');

    // -------------------------------------------------------------
    // 5. 测试 captureCurrentServerEnvironment（直接从服务器磁盘抓取环境生成母版）
    // -------------------------------------------------------------
    fs.writeFileSync(path.join(TEST_DIR, 'settings.json'), JSON.stringify({
      main_api: 'claude',
      claude_model: 'claude-3-5-sonnet-20241022',
      preset: 'Claude-Opus-Preset'
    }));
    const capturedProfile = manager.captureCurrentServerEnvironment({ deviceName: 'Server-Direct' });
    assert.strictEqual(capturedProfile.settings.main_api, 'claude');
    assert.strictEqual(capturedProfile.summary.preset, 'Claude-Opus-Preset');
    console.log('✅ 测试 5 通过：直接抓取服务器磁盘环境生成母版正常！');

    // 清理测试目录
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    console.log('🎉🎉 ST-Auto-Sync 云酒馆配置中心全部 4 项缺陷修复专项测试顺利通过！');
  });
});

