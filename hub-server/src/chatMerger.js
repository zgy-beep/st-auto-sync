const crypto = require('node:crypto');

/**
 * 判断一行是否为 SillyTavern 的文件头部元数据
 */
function isHeaderMetadata(item) {
  if (!item || typeof item !== 'object') return false;
  return (item.user_name || item.character_name || item.chat_metadata) && typeof item.mes === 'undefined';
}

/**
 * 解析 .jsonl 文本
 */
function parseJsonl(content) {
  if (!content || typeof content !== 'string') return [];
  const lines = content.split('\n');
  const results = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch (_) {}
  }
  return results;
}

/**
 * 序列化为 .jsonl 文本
 */
function stringifyJsonl(items) {
  if (!Array.isArray(items)) return '';
  return items.map((obj) => JSON.stringify(obj)).join('\n') + '\n';
}

/**
 * 为消息生成确定性唯一 ID (mid)
 */
function generateMid(prefix = 'msg_') {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * 为候选回复生成唯一 ID (sid)
 */
function generateSid(prefix = 'sid_') {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

/**
 * 确保每条消息均具备 mid 与结构化 Swipe 候选 sid
 */
function ensureMessageIdentifiers(msg, parentMid = null) {
  if (!msg || typeof msg !== 'object' || isHeaderMetadata(msg)) return msg;

  // 1. 确保永久消息槽位身份 mid
  if (!msg.mid) {
    if (msg.uid) msg.mid = msg.uid;
    else if (msg.id) msg.mid = String(msg.id);
    else msg.mid = generateMid();
  }

  // 2. 因果链引用
  if (!msg.parent_mid && parentMid) {
    msg.parent_mid = parentMid;
  }

  // 3. 结构化 Swipe Candidate SIDs
  const swipes = Array.isArray(msg.swipes) ? msg.swipes : [msg.mes || ''];
  if (!msg.extra || typeof msg.extra !== 'object') {
    msg.extra = {};
  }

  if (!Array.isArray(msg.extra.swipe_sids) || msg.extra.swipe_sids.length !== swipes.length) {
    msg.extra.swipe_sids = swipes.map(() => generateSid());
  }

  const activeIndex = typeof msg.swipe_id === 'number' && msg.swipe_id >= 0 && msg.swipe_id < swipes.length
    ? msg.swipe_id
    : 0;

  msg.extra.active_sid = msg.extra.swipe_sids[activeIndex];
  msg.swipe_id = activeIndex;

  return msg;
}

/**
 * 计算 2-gram 文本相似度 (Dice 系数)
 */
function calculateTextSimilarity(strA, strB) {
  if (strA === strB) return 1.0;
  if (!strA || !strB) return 0.0;
  const a = String(strA).trim();
  const b = String(strB).trim();
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) {
    return (a.includes(b) || b.includes(a)) ? 0.7 : 0.0;
  }

  const getBigrams = (str) => {
    const bag = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const bg = str.slice(i, i + 2);
      bag.set(bg, (bag.get(bg) || 0) + 1);
    }
    return bag;
  };

  const bagA = getBigrams(a);
  const bagB = getBigrams(b);

  let intersection = 0;
  let total = 0;
  for (const [bg, count] of bagA) {
    total += count;
    if (bagB.has(bg)) {
      intersection += Math.min(count, bagB.get(bg));
    }
  }
  for (const count of bagB.values()) {
    total += count;
  }
  return (2.0 * intersection) / total;
}

/**
 * 2.2 全序胜者仲裁规则 (Winner Arbitration)
 * 优先级：hub_seq -> lamport -> 操作类型(手动编辑 > 自动Swipe) -> deviceId 字典序
 */
function determineWinner(msgA, msgB) {
  // 1. Hub 权威版本号裁决
  const seqA = msgA.hub_seq || 0;
  const seqB = msgB.hub_seq || 0;
  if (seqA !== seqB) {
    return seqA > seqB ? msgA : msgB;
  }

  // 2. Lamport 逻辑时钟裁决
  const lamportA = msgA.lamport || msgA.send_date || 0;
  const lamportB = msgB.lamport || msgB.send_date || 0;
  if (lamportA !== lamportB) {
    return lamportA > lamportB ? msgA : msgB;
  }

  // 3. 操作类型加权：手动编辑 (is_manual_edit) > 自动生成
  const editA = Boolean(msgA.extra?.is_manual_edit);
  const editB = Boolean(msgB.extra?.is_manual_edit);
  if (editA !== editB) {
    return editA ? msgA : msgB;
  }

  // 4. deviceId 确定性字典序兜底（杜绝振荡）
  const devA = String(msgA.extra?.author_device || 'dev_a');
  const devB = String(msgB.extra?.author_device || 'dev_b');
  return devA >= devB ? msgA : msgB;
}

/**
 * 合并同槽位消息并进行 Swipe Candidate 结构化去重与 sid 显式重映射
 */
function mergeMessageSlot(msgA, msgB) {
  const winner = determineWinner(msgA, msgB);
  const loser = winner === msgA ? msgB : msgA;

  const base = { ...loser, ...winner };

  // 汇总两端的 Candidate (文本与 sid 对应)
  const candidates = []; // Array of { sid, text }
  const seenTexts = new Set();
  const seenSids = new Set();

  const addCandidatesFrom = (msg) => {
    const textList = Array.isArray(msg.swipes) ? msg.swipes : [msg.mes || ''];
    const sidList = Array.isArray(msg.extra?.swipe_sids) ? msg.extra.swipe_sids : [];

    for (let i = 0; i < textList.length; i++) {
      const text = textList[i];
      const sid = sidList[i] || generateSid();
      // 避免雷同文本重复加入，同时记录 sid
      if (!seenTexts.has(text) && !seenSids.has(sid)) {
        seenTexts.add(text);
        seenSids.add(sid);
        candidates.push({ sid, text });
      }
    }
  };

  // 胜者优先加入
  addCandidatesFrom(winner);
  addCandidatesFrom(loser);

  // 确定胜出的 active_sid
  let winnerActiveSid = winner.extra?.active_sid;
  let winnerActiveText = winner.mes || '';

  // 找到对应的候选
  let targetIndex = candidates.findIndex((c) => c.sid === winnerActiveSid || c.text === winnerActiveText);
  if (targetIndex === -1) {
    targetIndex = 0;
  }

  const activeCandidate = candidates[targetIndex];

  base.mes = activeCandidate.text;
  base.swipes = candidates.map((c) => c.text);
  base.extra = {
    ...(base.extra || {}),
    swipe_sids: candidates.map((c) => c.sid),
    active_sid: activeCandidate.sid
  };
  // 显式重映射下标
  base.swipe_id = targetIndex;

  return base;
}

/**
 * 3.1 因果分叉判定启发式算法 (OR-2 规则)
 * 满足任意 2 项即触发因果分叉保护：
 * 1. 双端公共祖先之后均有用户输入 (is_user === true)
 * 2. 任一端新增轮次 >= 2 轮
 * 3. 字符长度/Token跨度超过阈值 (>= 150 字)
 * 4. 文本相似度 < 0.65
 */
function isCausalFork(localMsgs, incomingMsgs) {
  if (localMsgs.length === 0 || incomingMsgs.length === 0) {
    return false;
  }

  // 明确排除项：如果两端均只有 1 条 AI 消息，属于同一提示词的不同重生成，强制合流进 Swipe
  if (localMsgs.length === 1 && incomingMsgs.length === 1 &&
      !localMsgs[0].is_user && !incomingMsgs[0].is_user) {
    return false;
  }

  let hitCount = 0;

  // 条件 1: 双端公共祖先之后均有用户主动输入
  const localHasUser = localMsgs.some((m) => m.is_user);
  const incomingHasUser = incomingMsgs.some((m) => m.is_user);
  if (localHasUser && incomingHasUser) hitCount++;

  // 条件 2: 任一端新增交互回合 >= 2
  if (localMsgs.length >= 2 || incomingMsgs.length >= 2) hitCount++;

  // 条件 3: 字符跨度超过阈值
  const totalCharsLocal = localMsgs.reduce((acc, m) => acc + (m.mes || '').length, 0);
  const totalCharsIncoming = incomingMsgs.reduce((acc, m) => acc + (m.mes || '').length, 0);
  if (totalCharsLocal >= 150 || totalCharsIncoming >= 150) hitCount++;

  // 条件 4: 首条差异消息相似度 < 0.65
  const sim = calculateTextSimilarity(localMsgs[0].mes, incomingMsgs[0].mes);
  if (sim < 0.65) hitCount++;

  return hitCount >= 2;
}

/**
 * ChatMerger 4.1 核心合并算法
 */
function mergeChatJsonl(localJsonl, incomingJsonl, options = {}) {
  const localItems = parseJsonl(localJsonl);
  const incomingItems = parseJsonl(incomingJsonl);

  // 1. 提取头部与墓碑 Tombstones
  let headerMeta = null;
  const localMsgs = [];
  const incomingMsgs = [];
  const tombstones = new Map(); // mid -> { deleted_at, delete_seq, deleted_by }

  const collectItems = (items, targetArr) => {
    let lastMid = null;
    for (const item of items) {
      if (isHeaderMetadata(item)) {
        headerMeta = { ...(headerMeta || {}), ...item };
        const tbs = item.chat_metadata?.tombstones;
        if (Array.isArray(tbs)) {
          tbs.forEach((tb) => {
            if (tb && tb.mid) tombstones.set(tb.mid, tb);
          });
        }
      } else {
        const enriched = ensureMessageIdentifiers(item, lastMid);
        lastMid = enriched.mid;
        targetArr.push(enriched);
      }
    }
  };

  collectItems(localItems, localMsgs);
  collectItems(incomingItems, incomingMsgs);

  // 显式传入的外部新删除墓碑
  if (Array.isArray(options.deletedTombstones)) {
    options.deletedTombstones.forEach((tb) => tombstones.set(tb.mid, tb));
  }

  // 过滤墓碑 (Tombstone Wins: 凡命中的 mid 一律剔除)
  const cleanLocal = localMsgs.filter((m) => !tombstones.has(m.mid));
  const cleanIncoming = incomingMsgs.filter((m) => !tombstones.has(m.mid));

  // 2. 阶段一：基于 mid 寻找最长公共前缀 (LCP)
  let prefixLen = 0;
  const mergedPrefix = [];

  const minLen = Math.min(cleanLocal.length, cleanIncoming.length);
  while (prefixLen < minLen) {
    const a = cleanLocal[prefixLen];
    const b = cleanIncoming[prefixLen];

    // 同槽位判定：mid 相同，或同一角色的合法 Swipe 更新
    if (a.mid === b.mid || (a.is_user === b.is_user && a.name === b.name && calculateTextSimilarity(a.mes, b.mes) >= 0.65)) {
      mergedPrefix.push(mergeMessageSlot(a, b));
      prefixLen++;
    } else {
      break;
    }
  }

  // 3. 阶段二：检查分叉
  const remainingLocal = cleanLocal.slice(prefixLen);
  const remainingIncoming = cleanIncoming.slice(prefixLen);

  if (isCausalFork(remainingLocal, remainingIncoming)) {
    // 触发因果分支保护
    const currentDepth = (headerMeta?.chat_metadata?.branch_metadata?.depth) || 0;
    
    // 超限深度检查 (> 2 级严禁静默丢弃，转入人工合并队列)
    if (currentDepth >= 2) {
      return {
        hasCausalFork: true,
        requiresManualResolution: true, // 冻结自动合并，转入人工队列
        depthExceeded: true,
        mergedContent: stringifyJsonl([headerMeta, ...cleanLocal]),
        forkContent: stringifyJsonl([headerMeta, ...cleanIncoming]),
        tombstones: Array.from(tombstones.values())
      };
    }

    const parentChatFile = options.chatFile || 'chat.jsonl';
    const forkBranchId = 'br_' + crypto.randomUUID().slice(0, 8);
    const forkedFromMid = mergedPrefix.length > 0 ? mergedPrefix[mergedPrefix.length - 1].mid : null;

    const mainHeader = JSON.parse(JSON.stringify(headerMeta || {}));
    const forkHeader = JSON.parse(JSON.stringify(headerMeta || {}));

    if (!forkHeader.chat_metadata) forkHeader.chat_metadata = {};
    forkHeader.chat_metadata.branch_metadata = {
      branch_id: forkBranchId,
      parent_chat_file: parentChatFile,
      forked_from_mid: forkedFromMid,
      forked_at: Date.now(),
      forked_by_device: options.deviceId || 'remote-device',
      depth: currentDepth + 1
    };

    return {
      hasCausalFork: true,
      requiresManualResolution: false,
      branchMetadata: forkHeader.chat_metadata.branch_metadata,
      mergedContent: stringifyJsonl([mainHeader, ...mergedPrefix, ...remainingLocal]),
      forkContent: stringifyJsonl([forkHeader, ...mergedPrefix, ...remainingIncoming]),
      tombstones: Array.from(tombstones.values())
    };
  }

  // 4. 单向追加或纯合流
  const allMessages = [...mergedPrefix, ...remainingLocal, ...remainingIncoming];

  if (!headerMeta) headerMeta = {};
  if (!headerMeta.chat_metadata) headerMeta.chat_metadata = {};
  headerMeta.chat_metadata.tombstones = Array.from(tombstones.values());

  return {
    hasCausalFork: false,
    requiresManualResolution: false,
    mergedContent: stringifyJsonl([headerMeta, ...allMessages]),
    forkContent: null,
    tombstones: Array.from(tombstones.values()),
    addedCount: remainingIncoming.length,
    totalCount: allMessages.length
  };
}

/**
 * 追加单条实时消息
 */
function appendSingleMessage(localJsonl, singleMessage) {
  if (!singleMessage || typeof singleMessage !== 'object') {
    return { content: localJsonl, appended: false };
  }

  const items = parseJsonl(localJsonl);
  const target = ensureMessageIdentifiers(singleMessage);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isHeaderMetadata(item)) continue;

    if (item.mid === target.mid) {
      return { content: localJsonl, appended: false };
    }

    // 末尾 Swipe 候选合并
    if (i === items.length - 1 && !item.is_user && !target.is_user) {
      items[i] = mergeMessageSlot(item, target);
      return { content: stringifyJsonl(items), appended: true, updatedSlot: true };
    }
  }

  items.push(target);
  return {
    content: stringifyJsonl(items),
    appended: true
  };
}

module.exports = {
  isHeaderMetadata,
  generateMid,
  generateSid,
  ensureMessageIdentifiers,
  calculateTextSimilarity,
  determineWinner,
  mergeMessageSlot,
  isCausalFork,
  mergeChatJsonl,
  appendSingleMessage,
  parseJsonl,
  stringifyJsonl
};
