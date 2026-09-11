const fs = require('node:fs');
const path = require('node:path');

/**
 * 操作变更日志管理器 (Oplog Manager)
 * 记录客户端的实时增量操作（聊天单条追加、文件更新、文件删除）
 * 供离线客户端重新上线时执行秒级 Catch-up 补发
 */
class OplogManager {
  constructor(baseDataDir, maxEntries = 2000) {
    this.baseDataDir = baseDataDir;
    this.maxEntries = maxEntries;
    this.logs = new Map(); // userKey -> Array of { seq, type, payload, timestamp, deviceId }
    this.sequences = new Map(); // userKey -> current max seq
  }

  getUserLogPath(userKey) {
    return path.join(this.baseDataDir, 'users', userKey, 'oplog.json');
  }

  ensureLoaded(userKey) {
    if (this.logs.has(userKey)) return;

    const filePath = this.getUserLogPath(userKey);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.logs.set(userKey, parsed.entries || []);
        this.sequences.set(userKey, parsed.currentSeq || 0);
        return;
      } catch (err) {
        console.error(`[Oplog] Failed to read oplog for ${userKey}:`, err);
      }
    }

    this.logs.set(userKey, []);
    this.sequences.set(userKey, 0);
  }

  saveToDisk(userKey) {
    const filePath = this.getUserLogPath(userKey);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const data = {
      currentSeq: this.sequences.get(userKey) || 0,
      entries: this.logs.get(userKey) || []
    };

    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error(`[Oplog] Failed to persist oplog for ${userKey}:`, err);
    }
  }

  /**
   * 追加一条增量操作日志
   */
  append(userKey, { type, payload, deviceId }) {
    this.ensureLoaded(userKey);

    const nextSeq = (this.sequences.get(userKey) || 0) + 1;
    this.sequences.set(userKey, nextSeq);

    const entry = {
      seq: nextSeq,
      type, // 'chat_append' | 'file_updated' | 'file_deleted'
      payload,
      deviceId: deviceId || 'unknown',
      timestamp: Date.now()
    };

    const list = this.logs.get(userKey);
    list.push(entry);

    if (list.length > this.maxEntries) {
      list.splice(0, list.length - this.maxEntries);
    }

    this.saveToDisk(userKey);
    return entry;
  }

  /**
   * 获取某序号之后的所有增量操作
   * 若 sinceSeq 小于当前保留的最老序号，说明日志已淘汰截断，要求客户端降级做全量快照同步
   */
  getSince(userKey, sinceSeq = 0) {
    this.ensureLoaded(userKey);
    const list = this.logs.get(userKey) || [];
    const currentSeq = this.sequences.get(userKey) || 0;
    const oldestSeq = list.length > 0 ? list[0].seq : 0;

    // 如果客户端落后于最老序号，提示全量回退
    if (sinceSeq > 0 && sinceSeq < oldestSeq) {
      return {
        currentSeq,
        oldestSeq,
        requiresFullSnapshot: true,
        entries: []
      };
    }

    const filtered = list.filter((item) => item.seq > sinceSeq);
    return {
      currentSeq,
      oldestSeq,
      requiresFullSnapshot: false,
      entries: filtered
    };
  }
}

module.exports = OplogManager;
