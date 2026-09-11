const assert = require('node:assert');
const {
  mergeChatJsonl,
  appendSingleMessage,
  parseJsonl,
  isSameLogicalMessage
} = require('../st-plugin/server/chatMerger');

console.log('=== 运行 ChatMerger 2.0 深度边界测试 ===');

// 基础头部
const header = { user_name: 'Player', character_name: 'Alice', chat_metadata: {} };
const msgUser1 = { name: 'Player', is_user: true, send_date: 1000, mes: '你好，爱丽丝！' };

// -------------------------------------------------------------
// 测试 1：Swipe 重新生成合并测试（同一槽位不同候选，不能膨胀！）
// -------------------------------------------------------------
console.log('--- 测试 1: Swipe 重新生成合并 ---');
// PC 上的 AI 回复 (第一版)
const aiMsg_v1 = {
  name: 'Alice',
  is_user: false,
  send_date: 2000,
  mes: '你好！我是爱丽丝，今天想聊些什么？',
  swipe_id: 0,
  swipes: ['你好！我是爱丽丝，今天想聊些什么？']
};

// 手机上的同一条 AI 回复（在手机端点击了 Swipe 重新生成）
const aiMsg_v2 = {
  name: 'Alice',
  is_user: false,
  send_date: 2100,
  mes: '嗨！好久不见，今天过得好吗？',
  swipe_id: 1,
  swipes: ['你好！我是爱丽丝，今天想聊些什么？', '嗨！好久不见，今天过得好吗？']
};

const pcJsonl_swipe = [JSON.stringify(header), JSON.stringify(msgUser1), JSON.stringify(aiMsg_v1)].join('\n');
const phoneJsonl_swipe = [JSON.stringify(header), JSON.stringify(msgUser1), JSON.stringify(aiMsg_v2)].join('\n');

const resSwipe = mergeChatJsonl(pcJsonl_swipe, phoneJsonl_swipe);
const itemsSwipe = parseJsonl(resSwipe.mergedContent);

// 验证：总条数必须是 2 条（1条User，1条AI），绝不能变成 3 条！
assert.strictEqual(itemsSwipe.length, 3, '包含头部和2条消息，不得重复追加！');
const mergedAiMsg = itemsSwipe[2];
assert.strictEqual(mergedAiMsg.mes, '嗨！好久不见，今天过得好吗？', '应该激活更新的回复');
assert.strictEqual(mergedAiMsg.swipes.length, 2, 'swipes 候选列表应该完整包含两版的回复');
console.log('✅ 测试 1 通过：Swipe 重新生成正确保留在同一槽位，候选列表成功合并！');

// -------------------------------------------------------------
// 测试 2：错别字微调编辑测试（原位修改，不能重复插入！）
// -------------------------------------------------------------
console.log('--- 测试 2: 错别字微调编辑 ---');
const msgEditBefore = { name: 'Player', is_user: true, send_date: 3000, mes: '明天星期把我们去公园。' }; // 错别字“星期把”
const msgEditAfter = { name: 'Player', is_user: true, send_date: 3050, mes: '明天星期八我们去公园。' };  // 修正后的字

const docBefore = [JSON.stringify(header), JSON.stringify(msgEditBefore)].join('\n');
const docAfter = [JSON.stringify(header), JSON.stringify(msgEditAfter)].join('\n');

const resEdit = mergeChatJsonl(docBefore, docAfter);
const itemsEdit = parseJsonl(resEdit.mergedContent);

assert.strictEqual(itemsEdit.length, 2, '微调编辑后总数依然为1条消息');
assert.strictEqual(itemsEdit[1].mes, '明天星期八我们去公园。', '内容应无损更新为最新编辑版本');
console.log('✅ 测试 2 通过：微调编辑就地更新，未发生重复膨胀！');

// -------------------------------------------------------------
// 测试 3：离线真正分叉合并测试（两端各自长出新的独立对话）
// -------------------------------------------------------------
console.log('--- 测试 3: 离线分叉时序无损串联 ---');
const forkCommon = [JSON.stringify(header), JSON.stringify(msgUser1), JSON.stringify(aiMsg_v1)];

// PC 离线追加
const pcMsgExtra = { name: 'Player', is_user: true, send_date: 4000, mes: '今晚吃火锅怎么样？' };
// 手机离线追加
const phoneMsgExtra = { name: 'Player', is_user: true, send_date: 3500, mes: '明天我们去爬山吗？' };

const pcFork = [...forkCommon, JSON.stringify(pcMsgExtra)].join('\n');
const phoneFork = [...forkCommon, JSON.stringify(phoneMsgExtra)].join('\n');

const resFork = mergeChatJsonl(pcFork, phoneFork);
const itemsFork = parseJsonl(resFork.mergedContent);

// 应该有：header(0) + user1(1) + ai1(2) + phoneMsgExtra(3, 时间3500) + pcMsgExtra(4, 时间4000) = 5
assert.strictEqual(itemsFork.length, 5, '分叉对话双方均不得丢失');
assert.strictEqual(itemsFork[3].mes, '明天我们去爬山吗？', '按时间排在前面');
assert.strictEqual(itemsFork[4].mes, '今晚吃火锅怎么样？', '按时间排在后面');
console.log('✅ 测试 3 通过：真正分叉各端的离线对话按时间戳完美串联，无任何数据丢失！');

console.log('🎉🎉 ChatMerger 2.0 所有边界与真实场景测试 100% 通过！');
