const assert = require('node:assert');
const {
  mergeChatJsonl,
  ensureMessageIdentifiers,
  parseJsonl
} = require('../st-plugin/server/chatMerger');

console.log('=== 运行 ST-Auto-Sync 4.1 深度合规性硬核测试 ===');

const header = { user_name: 'User', character_name: 'Alice', chat_metadata: {} };

// -------------------------------------------------------------
// 测试 1：编辑后删除场景（验证 mid 识别，杜绝因内容改变而复活）
// -------------------------------------------------------------
console.log('--- 测试 1: 编辑后删除（mid 墓碑彻底消灭复活 bug） ---');
const msgBase = ensureMessageIdentifiers({
  name: 'User',
  is_user: true,
  send_date: 1000,
  mes: '明天晚上去吃烤肉'
});
const targetMid = msgBase.mid;

// 手机端持有该消息的未编辑旧副本
const phoneJsonl = [JSON.stringify(header), JSON.stringify(msgBase)].join('\n');

// PC 端：先将内容编辑为“明天晚上去吃火锅吧”，随后删除了该消息！
const pcTombstone = {
  mid: targetMid,
  deleted_at: 1500,
  delete_seq: 10,
  deleted_by: 'PC-Windows'
};
const pcHeaderWithTb = {
  ...header,
  chat_metadata: {
    tombstones: [pcTombstone]
  }
};
// PC 端由于删除了该消息，内容为空列表
const pcJsonl = [JSON.stringify(pcHeaderWithTb)].join('\n');

const resEditDelete = mergeChatJsonl(pcJsonl, phoneJsonl);
const itemsEditDelete = parseJsonl(resEditDelete.mergedContent);

// 核心断言：虽然手机端持有的是不同文本内容的旧版本，但由于 mid 命中墓碑，必须彻底剔除！
assert.strictEqual(itemsEditDelete.length, 1, '被删除的消息绝不能因文本不同而被复活！');
assert.strictEqual(itemsEditDelete[0].chat_metadata.tombstones[0].mid, targetMid, '墓碑必须被完整继承持久化');
console.log('✅ 测试 1 通过：编辑后删除场景下，消息被精准剔除，彻底杜绝复活！');

// -------------------------------------------------------------
// 测试 2：内容相同消息删除场景（验证唯一 ID 防误杀）
// -------------------------------------------------------------
console.log('--- 测试 2: 连续相同文本删除（mid 隔离防误杀） ---');
const msgOk1 = ensureMessageIdentifiers({ name: 'User', is_user: true, send_date: 2000, mes: '好的' });
const msgOk2 = ensureMessageIdentifiers({ name: 'User', is_user: true, send_date: 2100, mes: '好的' });

assert.notStrictEqual(msgOk1.mid, msgOk2.mid, '相同文本的消息必须分配不同的永久 mid');

// 删除第一条 msgOk1
const tbOk1 = { mid: msgOk1.mid, deleted_at: 2200, delete_seq: 11 };
const headerWithTb2 = {
  ...header,
  chat_metadata: { tombstones: [tbOk1] }
};
const docAll = [JSON.stringify(headerWithTb2), JSON.stringify(msgOk1), JSON.stringify(msgOk2)].join('\n');

const resDuplicate = mergeChatJsonl(docAll, JSON.stringify(header));
const itemsDuplicate = parseJsonl(resDuplicate.mergedContent);

assert.strictEqual(itemsDuplicate.length, 2, '包含头部和剩下的一条“好的”');
assert.strictEqual(itemsDuplicate[1].mid, msgOk2.mid, '留下来的必须是第二条 msgOk2');
console.log('✅ 测试 2 通过：连续相同文本中仅目标消息被删除，另一条完好保留！');

// -------------------------------------------------------------
// 测试 3：Swipe 雷同文本重映射测试（彻底杜绝 indexOf 漂移）
// -------------------------------------------------------------
console.log('--- 测试 3: Swipe 雷同文本下标显式重映射（防 indexOf 漂移） ---');
const sid1 = 'sid_first_001';
const sid2 = 'sid_middle_002';
const sid3 = 'sid_third_003';

// 候选1和候选3的文本完全相同，但 sid 不同！当前用户激活的是第 3 条 (index 2)
const aiMsgDuplicateText = {
  name: 'Alice',
  is_user: false,
  send_date: 3000,
  mes: '完全一模一样的回复',
  swipe_id: 2,
  swipes: ['完全一模一样的回复', '不一样的中间回复', '完全一模一样的回复'],
  extra: {
    swipe_sids: [sid1, sid2, sid3],
    active_sid: sid3
  }
};

const docSwipe = [JSON.stringify(header), JSON.stringify(aiMsgDuplicateText)].join('\n');
const resSwipe = mergeChatJsonl(docSwipe, JSON.stringify(header));
const mergedSwipeAi = parseJsonl(resSwipe.mergedContent)[1];

console.log('激活的 sid:', mergedSwipeAi.extra.active_sid);
console.log('计算出的 swipe_id:', mergedSwipeAi.swipe_id);

// 核心断言：如果用了 indexOf(mes)，必定会匹配到 index 0！但我们用了 sid 重映射，必须精准指向 index 2（或对应 sid3 的位置）
assert.strictEqual(mergedSwipeAi.extra.active_sid, sid3, '选中的必须是第3条的 sid');
assert.strictEqual(mergedSwipeAi.extra.swipe_sids[mergedSwipeAi.swipe_id], sid3, 'swipe_id 必须精准指向 sid3！');
console.log('✅ 测试 3 通过：雷同文本 Swipe 完美反查重映射，彻底杜绝下标漂移！');

// -------------------------------------------------------------
// 测试 4：OR-2 启发式因果分叉与 DAG 血缘元数据测试
// -------------------------------------------------------------
console.log('--- 测试 4: OR-2 启发式因果分叉与深度限制保护 ---');
const commonRoot = [
  JSON.stringify(header),
  JSON.stringify(ensureMessageIdentifiers({ name: 'User', is_user: true, send_date: 100, mes: '开始' }))
];

// PC 展开分支 A (2 轮对话，满足 OR-2)
const pcFork = [
  ...commonRoot,
  JSON.stringify(ensureMessageIdentifiers({ name: 'User', is_user: true, send_date: 200, mes: '讨论A主题' })),
  JSON.stringify(ensureMessageIdentifiers({ name: 'Alice', is_user: false, send_date: 300, mes: '关于A的分析' }))
].join('\n');

// 手机展开分支 B (2 轮对话，满足 OR-2)
const phoneFork = [
  ...commonRoot,
  JSON.stringify(ensureMessageIdentifiers({ name: 'User', is_user: true, send_date: 250, mes: '讨论B主题' })),
  JSON.stringify(ensureMessageIdentifiers({ name: 'Alice', is_user: false, send_date: 350, mes: '关于B的分析' }))
].join('\n');

const resFork1 = mergeChatJsonl(pcFork, phoneFork, { chatFile: 'Alice.jsonl', deviceId: 'Phone-Termux' });

assert.strictEqual(resFork1.hasCausalFork, true, '必须检测出因果分叉');
assert.strictEqual(resFork1.requiresManualResolution, false, '1级分支不触发人工队列');
assert.strictEqual(resFork1.branchMetadata.depth, 1, '初始分支深度为 1');
assert.strictEqual(resFork1.branchMetadata.forked_by_device, 'Phone-Termux');
assert.strictEqual(resFork1.branchMetadata.parent_chat_file, 'Alice.jsonl');

// 模拟深度已达到 2 级时再次分叉
const headerDepth2 = {
  ...header,
  chat_metadata: {
    branch_metadata: { depth: 2 }
  }
};
const pcDepth2 = pcFork.replace(JSON.stringify(header), JSON.stringify(headerDepth2));
const phoneDepth2 = phoneFork.replace(JSON.stringify(header), JSON.stringify(headerDepth2));

const resDepthLimit = mergeChatJsonl(pcDepth2, phoneDepth2, { chatFile: 'Alice.jsonl' });

// 核心断言：深度超过 2 时，严禁静默丢弃，必须返回 requiresManualResolution = true 转入人工合并队列！
assert.strictEqual(resDepthLimit.hasCausalFork, true);
assert.strictEqual(resDepthLimit.requiresManualResolution, true, '深度达到2时必须转入人工合并队列');
assert.ok(resDepthLimit.forkContent, '双方版本必须均被完整保留在结果中，不可静默丢弃！');
console.log('✅ 测试 4 通过：OR-2 启发式分叉与深度超限人工队列防护生效，零数据丢失！');

console.log('🎉🎉🎉 ST-Auto-Sync 4.1 所有硬核核心技术用例全部 100% 完美通过！');
