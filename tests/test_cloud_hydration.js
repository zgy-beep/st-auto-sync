// 云母版自动注水的"真前端"回归测试
// 直接 require 插件前端模块(它导出了 applyCloudProfile / checkAndHydrateCloudProfile),
// 用 jsdom 提供 window/document/localStorage,不靠"自己写个 Map 模拟"来证明自己。
// 若未安装 jsdom(可选开发依赖),脚本会跳过而不是报错。
const path = require('node:path');
const fs = require('node:fs');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  console.log('⚠️ 未安装 jsdom(可选开发依赖),跳过云母版前端注水测试。');
  console.log('   安装方式:npm install(devDependencies 里已声明 jsdom)');
  process.exit(0);
}

const assert = require('node:assert');
const MODULE_PATH = path.join(__dirname, '..', 'st-plugin', 'public', 'index.js');

console.log('=== 运行云母版自动注水前端回归测试(jsdom + 真实前端模块) ===');

const PROFILE = {
  version: '1.0.0',
  updated_at: 1789000000000,
  updated_by: 'Desktop-PC',
  settings: {
    main_api: 'openai',
    api_server_openai: 'https://api.deepseek.com/v1',
    model_openai: 'deepseek-chat',
    preset: 'My-Preset',
  },
  summary: { main_api: 'openai', model: 'deepseek-chat', preset: 'My-Preset', has_secrets: true },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeBrowser({ preLocalStorage = {}, ctxSettings = {}, profile = PROFILE } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <input id="api_key_openai" type="password" value="" />
    <select id="model_openai_select"></select>
  </body></html>`, { url: 'http://localhost/' });

  const w = dom.window;
  w.__ST_TEST_SKIP_INIT = true;
  w.console = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
  w.toastr = { success: () => {}, error: () => {}, info: () => {}, warning: () => {} };
  w.alert = () => {};
  w.confirm = () => true;

  for (const [k, v] of Object.entries(preLocalStorage)) w.localStorage.setItem(k, v);

  const stats = { saves: 0, profileRequests: 0, toasts: [] };
  w.toastr.success = (m) => stats.toasts.push(m);

  w.SillyTavern = {
    getContext: () => ({
      settings: ctxSettings,
      secrets: {},
      saveSettingsDebounced: () => { stats.saves += 1; },
    }),
  };

  w.fetch = async (url) => {
    const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
    if (String(url).includes('/cloud-profile')) {
      stats.profileRequests += 1;
      return json({ success: true, profile });
    }
    return json({ success: true });
  };

  return { dom, w, stats, ctxSettings };
}

function activate(browser) {
  global.window = browser.w;
  global.document = browser.w.document;
  global.localStorage = browser.w.localStorage;
  global.fetch = browser.w.fetch;
  // 模块里用 new Event('input') 去联动 DOM 控件:必须用 jsdom 的 Event,
  // 否则 jsdom 元素会拒绝 Node 原生 Event 对象
  global.Event = browser.w.Event;
  global.CustomEvent = browser.w.CustomEvent;
  global.MouseEvent = browser.w.MouseEvent;
  global.navigator = browser.w.navigator;
}

// 模块只加载一次(内部无 per-browser 状态,状态都存在各自 window 的 localStorage 里)
{
  const bootstrap = makeBrowser();
  activate(bootstrap);
  global.window.__ST_TEST_SKIP_INIT = true;
}
const frontend = require(MODULE_PATH);
const MARK = 'st_auto_sync_hydrated_v1';

(async () => {
  assert.ok(typeof frontend.checkAndHydrateCloudProfile === 'function', '前端模块应导出 checkAndHydrateCloudProfile');
  assert.ok(typeof frontend.applyCloudProfile === 'function', '前端模块应导出 applyCloudProfile');

  // 1) 全新浏览器(没有标记、也没有任何配置):应自动注水并打标记
  const fresh = makeBrowser();
  activate(fresh);
  await frontend.checkAndHydrateCloudProfile();
  await sleep(400);
  assert.ok(fresh.stats.saves > 0, '全新浏览器首次访问应触发注水');
  assert.strictEqual(fresh.ctxSettings.api_server_openai, 'https://api.deepseek.com/v1', '母版环境应注入');
  assert.strictEqual(fresh.ctxSettings.model_openai, 'deepseek-chat', '母版模型应注入');
  assert.strictEqual(fresh.w.localStorage.getItem(MARK), 'true', '注水后必须打上本机标记');
  console.log('✅ 测试 1 通过:全新浏览器首次访问自动注水并打上本机标记');

  // 2) 同一浏览器再次打开:不再注水,本机自己的微调不会被覆盖
  const returning = makeBrowser({
    preLocalStorage: { [MARK]: 'true' },
    ctxSettings: { api_server_openai: 'https://api.deepseek.com/v1', model_openai: '我自己改的模型' },
  });
  activate(returning);
  await frontend.checkAndHydrateCloudProfile();
  await sleep(400);
  assert.strictEqual(returning.stats.saves, 0, '已注水的浏览器不应再次注水');
  assert.strictEqual(returning.ctxSettings.model_openai, '我自己改的模型', '本机自己改的模型不能被母版覆盖回去');
  console.log('✅ 测试 2 通过:已注水的浏览器刷新页面不再重复注水(不会覆盖本机调整)');

  // 3) 母版更新后也不会自动覆盖(默认行为:标记为布尔值,只有手动点「从云端载入母版」才更新)
  const afterUpdate = makeBrowser({
    profile: { ...PROFILE, updated_at: PROFILE.updated_at + 3600000, settings: { ...PROFILE.settings, model_openai: '母版新模型' } },
    preLocalStorage: { [MARK]: 'true' },
    ctxSettings: { model_openai: '我自己改的模型' },
  });
  activate(afterUpdate);
  await frontend.checkAndHydrateCloudProfile();
  await sleep(400);
  assert.strictEqual(afterUpdate.ctxSettings.model_openai, '我自己改的模型', '母版更新不应自动覆盖本机(避免又把用户调整冲掉)');
  console.log('✅ 测试 3 通过:母版更新不会自动覆盖本机(要更新需手动点「从云端载入母版」)');

  // 4) 密钥不落浏览器:localStorage 无密钥类键、页面输入框不被填
  activate(fresh);
  const keyInStorage = fresh.w.localStorage.getItem('api_key_openai');
  assert.ok(keyInStorage === null || keyInStorage === undefined || keyInStorage === '', `API Key 不得写进 localStorage(实际:${keyInStorage})`);
  assert.strictEqual(fresh.w.document.getElementById('api_key_openai').value, '', 'API Key 不得写进页面输入框');
  const leakedKeys = [];
  for (let i = 0; i < fresh.w.localStorage.length; i += 1) {
    const k = fresh.w.localStorage.key(i);
    if (/api_key|secret|token|password/i.test(k)) leakedKeys.push(k);
  }
  assert.deepStrictEqual(leakedKeys, [], `localStorage 里不该有密钥类键:${leakedKeys.join(',')}`);
  console.log('✅ 测试 4 通过:密钥保持服务端托管,不落浏览器 localStorage / 输入框');

  // 5) 手动载入母版:显式调用时才覆盖本机(密钥同样不落浏览器)
  const manual = makeBrowser({ preLocalStorage: { [MARK]: 'true' }, ctxSettings: { model_openai: '旧模型' } });
  activate(manual);
  await frontend.applyCloudProfile(PROFILE, false);
  await sleep(300);
  assert.strictEqual(manual.ctxSettings.model_openai, 'deepseek-chat', '手动载入应覆盖本机设置');
  assert.ok(manual.w.localStorage.getItem('api_key_openai') === null, '手动载入也不该把密钥写进 localStorage');
  console.log('✅ 测试 5 通过:手动「从云端载入母版」仍可用,且密钥不落浏览器');

  console.log('\n🎉 云母版自动注水前端回归测试全部通过');
  process.exit(0);
})().catch((err) => {
  console.error('\n❌ 云母版注水测试失败:', err.message);
  process.exit(1);
});
