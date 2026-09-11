const assert = require('node:assert');
const {
  mergeChatJsonl,
  getMessageFingerprint,
  parseJsonl
} = require('../st-plugin/server/chatMerger');

console.log('=== 运行 ChatMerger 3.0 工业级硬伤防御测试 ===');

const headerBase = { user_name: 'Player', character_name: 'Alice', chat_metadata: {} };
const msg1 = { name: 'Player', is_user: true, send_date: 1000, mes: '第一条：你好' };
const msg2 = { name: 'Alice', is_user: false, send_date: 2000, mes: '第二条：爱丽丝在' };
const msg3 = { name: 'Player', is_user: true, send_date: 3000, mes: '第三条：我们去逛街吧' };

// -------------------------------------------------------------
// 测试 1：Tombstone 墓碑删除防复活测试
// -------------------------------------------------------------
console.log('--- 测试 1: Tombstone 墓碑机制（防止删除后被旧端复活） ---');
const deletedFp = getMessageFingerprint(msg2);

// PC 端删除了 msg2，并把其指纹写入了头部墓碑
const headerWithTombstone = {
  ...headerBase,
  chat_metadata: {
    tombstones: [deletedFp]
  }
};
// PC 端内容：只剩 msg1 和 msg3
const pcJsonl_deleted = [JSON.stringify(headerWithTombstone), JSON.stringify(msg1), JSON.stringify(msg3)].join('\n');

// 手机端（旧副本，离线未感知删除）：依然包含 msg1, msg2, msg3
const phoneJsonl_old = [JSON.stringify(headerBase), JSON.stringify(msg1), JSON.stringify(msg2), JSON.stringify(msg3)].join('\n');

const resTombstone = mergeChatJsonl(pcJsonl_deleted, phoneJsonl_old);
const itemsTombstone = parseJsonl(resTombstone.mergedContent);

// 验证：msg2 绝不能被复活！总条数必须是 2 条（msg1 和 msg3）+ 1 个 header
assert.strictEqual(itemsTombstone.length, 3, '被删除的消息绝不能复活！');
const remainingMesList = itemsTombstone.slice(1).map((m) => m.mes);
assert.ok(!remainingMesList.includes('第二条：爱丽丝在'), '已删除的第二条绝不能存在');
assert.ok(remainingMesList.includes('第一条：你好'));
assert.ok(remainingMesList.includes('第三条：我们去逛街吧'));
assert.ok(itemsTombstone[0].chat_metadata.tombstones.includes(deletedFp), '合并后的头部必须持久化墓碑指纹');
console.log('✅ 测试 1 通过：墓碑优先律生效，删除操作未被旧副本复活！');

// -------------------------------------------------------------
// 测试 2：Swipe 显式重映射测试（彻底杜绝下标漂移 bug）
// -------------------------------------------------------------
console.log('--- 测试 2: Swipe 下标显式重映射（防漂移） ---');
// 端 A: 有 2 个选项，激活的是 '选项B' (swipe_id = 1)
const aiMsg_A = {
  name: 'Alice',
  is_user: false,
  send_date: 4000,
  mes: '选项B',
  swipe_id: 1,
  swipes: ['选项A', '选项B']
};

// 端 B: 有另外的候选，并且重新排列或增加了选项C
const aiMsg_B = {
  name: 'Alice',
  is_user: false,
  send_date: 4050, // 时间更晚，激活的是 '选项C' (swipe_id = 0)
  mes: '选项C',
  swipe_id: 0,
  swipes: ['选项C', '选项A']
};

const docA = [JSON.stringify(headerBase), JSON.stringify(msg1), JSON.stringify(aiMsg_A)].join('\n');
const docB = [JSON.stringify(headerBase), JSON.stringify(msg1), JSON.stringify(aiMsg_B)].join('\n');

const resSwipe = mergeChatJsonl(docA, docB);
const itemsSwipe = parseJsonl(resSwipe.mergedContent);
const mergedAi = itemsSwipe[2];

console.log('合并后的 Swipes 数组:', mergedAi.swipes);
console.log('当前激活的 mes:', mergedAi.mes);
console.log('重映射后的 swipe_id:', mergedAi.swipe_id);

// 关键断言：swipe_id 必须精准等于 mes 在 swipes 数组中的实际位置！
assert.strictEqual(mergedAi.mes, '选项C', '时间更晚的选项C胜出');
assert.strictEqual(mergedAi.swipe_id, mergedAi.swipes.indexOf('选项C'), 'swipe_id 必须精准指向选项C');
assert.strictEqual(mergedAi.swipes[mergedAi.swipe_id], mergedAi.mes, '解引用校验：swipes[swipe_id] 必须完全等于 mes！');
console.log('✅ 测试 2 通过：Swipe 下标显式重映射完成，彻底消除漂移错乱！');

// -------------------------------------------------------------
// 测试 3：因果分支保护测试（拒绝无脑交错乱炖，另存为新分支）
// -------------------------------------------------------------
console.log('--- 测试 3: 因果分支保护（检测到深度离线分叉时，自动另存分支） ---');
const commonChat = [JSON.stringify(headerBase), JSON.stringify(msg1), JSON.stringify(msg2)];

// PC 离线开启了分支 1：问猫咪
const pcMsgUser = { name: 'Player', is_user: true, send_date: 5000, mes: '猫咪怎么养？' };
const pcMsgAi = { name: 'Alice', is_user: false, send_date: 5100, mes: '猫咪需要猫粮和水。' };
const pcBranch = [...commonChat, JSON.stringify(pcMsgUser), JSON.stringify(pcMsgAi)].join('\n');

// 手机离线开启了分支 2：问天气
const phoneMsgUser = { name: 'Player', is_user: true, send_date: 5050, mes: '明天天气如何？' };
const phoneMsgAi = { name: 'Alice', is_user: false, send_date: 5150, mes: '明天是大晴天。' };
const phoneBranch = [...commonChat, JSON.stringify(phoneMsgUser), JSON.stringify(phoneMsgAi)].join('\n');

const resFork = mergeChatJsonl(pcBranch, phoneBranch);

// 验证：算法必须识别出因果分叉，绝不强行交错插空！
assert.strictEqual(resFork.hasCausalFork, true, '必须正确检测出深度因果分叉');
assert.ok(resFork.forkContent, '必须生成独立的分叉保护内容');

const mainItems = parseJsonl(resFork.mergedContent);
const forkItems = parseJsonl(resFork.forkContent);

// 校验两套分支各自因果上下文 100% 完整无乱插
const mainMes = mainItems.slice(1).map((m) => m.mes);
const forkMes = forkItems.slice(1).map((m) => m.mes);

assert.ok(mainMes.includes('猫咪怎么养？') && mainMes.includes('猫咪需要猫粮和水。'));
assert.ok(!mainMes.includes('明天天气如何？'), '主分支内不得混入手机端的问题');

assert.ok(forkMes.includes('明天天气如何？') && forkMes.includes('明天是大晴天。'));
assert.ok(!forkMes.includes('猫咪怎么养？'), '冲突保护分支内不得混入PC端的问题');

console.log('✅ 测试 3 通过：因果分支保护机制生效，问答对完整无损，成功另存为独立分支！');

console.log('🎉🎉🎉 ChatMerger 3.0 全部工业级硬伤防御测试 100% 完美通过！');
