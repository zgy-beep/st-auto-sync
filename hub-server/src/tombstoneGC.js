const fs = require('node:fs');
const path = require('node:path');

const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000; // 默认 30 天独立 TTL
const STALE_DEVICE_THRESHOLD_MS = 30 * 24 * 3600 * 1000; // 离线超 30 天标记为 Stale

/**
 * 1.3 Tombstone GC 管理器 (分代生命周期与 Device ACK 约束)
 */
class TombstoneGCManager {
  constructor(baseDataDir) {
    this.baseDataDir = baseDataDir;
    // userKey -> Map<deviceId, { last_sync_seq, last_seen_at, is_stale }>
    this.deviceRegistry = new Map();
  }

  getRegistryPath(userKey) {
    return path.join(this.baseDataDir, 'tenants', userKey, 'devices.json');
  }

  ensureLoaded(userKey) {
    if (this.deviceRegistry.has(userKey)) return;

    const filePath = this.getRegistryPath(userKey);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        const map = new Map(Object.entries(parsed));
        this.deviceRegistry.set(userKey, map);
        return;
      } catch (_) {}
    }

    this.deviceRegistry.set(userKey, new Map());
  }

  saveToDisk(userKey) {
    const filePath = this.getRegistryPath(userKey);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const map = this.deviceRegistry.get(userKey) || new Map();
    const obj = Object.fromEntries(map);
    try {
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (_) {}
  }

  /**
   * 记录设备心跳与确认的序列号 (Device ACK)
   */
  recordDeviceAck(userKey, deviceId, lastSyncSeq) {
    this.ensureLoaded(userKey);
    const map = this.deviceRegistry.get(userKey);

    const now = Date.now();
    map.set(deviceId, {
      last_sync_seq: lastSyncSeq,
      last_seen_at: now,
      is_stale: false
    });

    this.saveToDisk(userKey);
  }

  /**
   * 刷新并标记脱节设备 (Stale Devices)
   */
  refreshStaleDevices(userKey) {
    this.ensureLoaded(userKey);
    const map = this.deviceRegistry.get(userKey);
    const now = Date.now();

    for (const [deviceId, meta] of map.entries()) {
      if (now - meta.last_seen_at > STALE_DEVICE_THRESHOLD_MS) {
        meta.is_stale = true;
      }
    }
  }

  /**
   * 获取所有非 Stale 活跃设备的最小确认序列号 (Min Active ACK Seq)
   */
  getMinActiveAckSeq(userKey) {
    this.refreshStaleDevices(userKey);
    const map = this.deviceRegistry.get(userKey);

    let minSeq = Infinity;
    let activeCount = 0;

    for (const meta of map.values()) {
      if (!meta.is_stale) {
        activeCount++;
        if (meta.last_sync_seq < minSeq) {
          minSeq = meta.last_sync_seq;
        }
      }
    }

    return activeCount > 0 ? minSeq : 0;
  }

  /**
   * 执行 Tombstone GC 物理清理
   * @param {string} userKey 
   * @param {Array<Object>} tombstones - 会话当前的墓碑列表
   * @returns {{ retained: Array<Object>, purgedCount: number }}
   */
  purgeEligibleTombstones(userKey, tombstones = []) {
    if (!Array.isArray(tombstones) || tombstones.length === 0) {
      return { retained: [], purgedCount: 0 };
    }

    const minActiveAck = this.getMinActiveAckSeq(userKey);
    const now = Date.now();

    const retained = [];
    let purgedCount = 0;

    for (const tb of tombstones) {
      const isExpired = (now - (tb.deleted_at || 0)) > TOMBSTONE_TTL_MS;
      const isAckedByAllActive = (tb.delete_seq || 0) <= minActiveAck;

      // 满足三者条件才能物理剔除
      if (isExpired && isAckedByAllActive) {
        purgedCount++;
      } else {
        retained.push(tb);
      }
    }

    return {
      retained,
      purgedCount
    };
  }
}

module.exports = TombstoneGCManager;
