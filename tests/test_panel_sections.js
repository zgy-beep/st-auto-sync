// 面板分区回归测试:确认"需要 Hub"和"不依赖 Hub"的功能在界面上被明确区分,
// 且分区改造没有把任何原有控件弄丢(jsdom 真渲染插件面板)。
// 若未安装 jsdom(可选开发依赖),脚本会跳过而不是报错。
const path = require('node:path');
const fs = require('node:fs');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  console.log('⚠️ 未安装 jsdom(可选开发依赖),跳过分区回归测试。');
  process.exit(0);
}

const assert = require('node:assert');
const CODE = fs.readFileSync(path.join(__dirname, '..', 'st-plugin', 'public', 'index.js'), 'utf8');

console.log('=== 运行面板分区 / 控件完整性回归测试(jsdom) ===');

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div id="extensions_settings2" class="flex1 wide50p"></div>
</body></html>`, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });

const { window } = dom;
window.console = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
window.EventSource = class { constructor() {} close() {} };
window.toastr = { success: () => {}, error: () => {}, info: () => {}, warning: () => {} };
window.alert = () => {};
window.confirm = () => true;
window.SillyTavern = {
  getContext: () => ({ settings: {}, secrets: {}, saveSettingsDebounced: () => {} }),
};
window.fetch = async (url) => {
  const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
  if (String(url).includes('/cloud-profile')) return json({ success: true, profile: null });
  if (String(url).includes('/status')) return json({ success: true, connected: false, lastError: null, config: { hubUrl: '', token: '', mode: 'realtime', deviceName: '' } });
  if (String(url).includes('/backups')) return json({ success: true, files: [] });
  return json({ success: true });
};

const script = window.document.createElement('script');
script.textContent = CODE;
window.document.body.appendChild(script);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(2200);
  const doc = window.document;
  const panel = doc.getElementById('st-sync-settings-panel');
  assert.ok(panel, '插件面板应已挂载');
  const text = panel.textContent;

  // 1) 三个分区标题按顺序出现
  const titles = Array.from(panel.querySelectorAll('.st-sync-group-title, .st-sync-cloud-header'))
    .map((el) => el.textContent.replace(/\s+/g, ' ').trim());
  assert.ok(text.includes('① 多端同步'), '缺少「① 多端同步」分区标题');
  assert.ok(text.includes('② 备份与恢复'), '缺少「② 备份与恢复」分区标题');
  assert.ok(text.includes('③ ☁️ 云酒馆配置中心'), '缺少「③ 云酒馆配置中心」分区标题');
  assert.ok(titles.length >= 3, `分区标题数量异常:${titles.length}`);
  console.log('✅ 测试 1 通过:三个功能分区(多端同步 / 备份与恢复 / 云酒馆配置中心)都有独立标题');

  // 2) 依赖标记:两组需要 Hub、一组明确"无需 Hub"
  const hubBadges = panel.querySelectorAll('.st-sync-dep-badge.st-sync-dep-hub');
  const localBadges = panel.querySelectorAll('.st-sync-dep-badge.st-sync-dep-local');
  assert.strictEqual(hubBadges.length, 2, `应有 2 个「需要 Hub」标记(多端同步 / 备份与恢复),实际 ${hubBadges.length}`);
  assert.strictEqual(localBadges.length, 1, `应有 1 个「无需 Hub」标记,实际 ${localBadges.length}`);
  assert.ok(localBadges[0].textContent.includes('无需 Hub'), '云配置中心的标记文案应为「无需 Hub」');
  assert.ok(text.includes('不需要 Hub 地址、Token 或隧道'), '云配置中心应写明不依赖 Hub/Token/隧道');
  console.log('✅ 测试 2 通过:依赖关系在界面上标清楚了(2 组需要 Hub / 1 组无需 Hub)');

  // 3) 分区之间用分隔线隔开
  const dividers = panel.querySelectorAll('.st-sync-divider');
  assert.ok(dividers.length >= 2, `分区之间应有分隔线,实际 ${dividers.length}`);
  console.log(`✅ 测试 3 通过:分区之间有明显分隔(${dividers.length} 条分隔线)`);

  // 4) 原有控件一个都不能少(分区改造别把功能弄丢)
  const requiredIds = [
    'st-sync-hub-url', 'st-sync-token', 'st-sync-dev-name', 'st-sync-interval-val',
    'sync-env', 'sync-cat-chats', 'sync-cat-chars', 'sync-cat-worlds', 'sync-cat-presets', 'sync-cat-personas',
    'st-sync-save-btn', 'st-sync-now-btn',
    'st-sync-restore-btn', 'st-sync-backups-btn', 'st-sync-backups-panel',
    'st-sync-cloud-save-btn', 'st-sync-cloud-load-btn', 'st-sync-auto-hydrate-chk', 'st-sync-cloud-badge',
  ];
  const missing = requiredIds.filter((id) => !doc.getElementById(id));
  assert.deepStrictEqual(missing, [], `分区改造后丢失了控件:${missing.join(', ')}`);
  assert.strictEqual(panel.querySelectorAll('input[name="st-sync-mode"]').length, 3, '三种同步模式的单选项应保留');
  console.log(`✅ 测试 4 通过:${requiredIds.length} 个原有控件 + 模式单选全部保留`);

  // 5) 云配置中心那一块不能被误标成依赖 Hub
  const cloudBox = panel.querySelector('.st-sync-cloud-profile-box');
  assert.ok(cloudBox, '云配置中心区块应存在');
  assert.strictEqual(cloudBox.querySelectorAll('.st-sync-dep-hub').length, 0, '云配置中心区块里不应出现「需要 Hub」标记');
  assert.strictEqual(cloudBox.querySelectorAll('.st-sync-dep-local').length, 1, '云配置中心区块应带「无需 Hub」标记');
  console.log('✅ 测试 5 通过:云配置中心区块内部只带「无需 Hub」标记,不会和同步功能混淆');

  console.log('\n🎉 面板分区 / 控件完整性回归测试全部通过');
  process.exit(0);
})().catch((err) => {
  console.error('\n❌ 面板分区测试失败:', err.message);
  process.exit(1);
});
