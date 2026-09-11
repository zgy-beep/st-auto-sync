const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class StorageManager {
  constructor(baseDataDir) {
    this.baseDataDir = baseDataDir;
    this.manifestCache = new Map(); // userKey -> { lastScanTime, manifest }
  }

  getUserFilesDir(userKey) {
    const dir = path.join(this.baseDataDir, 'users', userKey, 'files');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * 防止路径穿越安全校验
   */
  resolveSafePath(userKey, relativePath) {
    const userRoot = path.resolve(this.getUserFilesDir(userKey));
    // 统一替换 Windows 反斜杠
    const normalized = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
    const targetPath = path.resolve(userRoot, normalized);

    if (!targetPath.startsWith(userRoot)) {
      throw new Error(`Security Exception: Access denied to path outside user root: ${relativePath}`);
    }
    return targetPath;
  }

  /**
   * 计算单文件的 SHA-256 哈希
   */
  calculateFileHash(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  }

  /**
   * 递归扫描用户目录，生成 Manifest 清单
   */
  scanUserManifest(userKey, forceRefresh = false) {
    const cache = this.manifestCache.get(userKey);
    const now = Date.now();

    if (!forceRefresh && cache && now - cache.lastScanTime < 5000) {
      return cache.manifest;
    }

    const rootDir = this.getUserFilesDir(userKey);
    const manifest = {};

    const walk = (currentDir, relativePrefix = '') => {
      if (!fs.existsSync(currentDir)) return;
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.posix.join(relativePrefix, entry.name);

        // 忽略临时文件、隐藏文件
        if (entry.name.startsWith('.') || entry.name.endsWith('.tmp') || entry.name.endsWith('.bak')) {
          continue;
        }

        if (entry.isDirectory()) {
          walk(fullPath, relPath);
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          manifest[relPath] = {
            path: relPath,
            size: stat.size,
            mtime: stat.mtimeMs,
            hash: this.calculateFileHash(fullPath)
          };
        }
      }
    };

    walk(rootDir, '');
    this.manifestCache.set(userKey, { lastScanTime: now, manifest });
    return manifest;
  }

  /**
   * 比对客户端和远端 Manifest，生成增量同步任务
   * @param {string} userKey 
   * @param {Object} clientManifest - { [relPath]: { size, mtime, hash } }
   * @returns {Object} { need_upload: Array, need_download: Array }
   */
  diffManifest(userKey, clientManifest = {}) {
    const serverManifest = this.scanUserManifest(userKey, true);
    const need_upload = [];
    const need_download = [];

    const allPaths = new Set([
      ...Object.keys(clientManifest),
      ...Object.keys(serverManifest)
    ]);

    for (const p of allPaths) {
      const clientItem = clientManifest[p];
      const serverItem = serverManifest[p];

      if (clientItem && !serverItem) {
        // 客户端有，服务端没有 -> 上传
        need_upload.push(p);
      } else if (!clientItem && serverItem) {
        // 服务端有，客户端没有 -> 下载
        need_download.push(p);
      } else if (clientItem && serverItem) {
        // 两端都有，比对哈希
        if (clientItem.hash !== serverItem.hash) {
          // 哈希不同，看修改时间判断先后
          if (clientItem.mtime > serverItem.mtime) {
            need_upload.push(p);
          } else {
            need_download.push(p);
          }
        }
      }
    }

    return {
      server_manifest: serverManifest,
      need_upload,
      need_download
    };
  }

  /**
   * 保存上传的文件
   */
  saveFile(userKey, relativePath, buffer, mtime = null) {
    const targetPath = this.resolveSafePath(userKey, relativePath);
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(targetPath, buffer);
    if (mtime) {
      try {
        const timeSec = mtime / 1000;
        fs.utimesSync(targetPath, timeSec, timeSec);
      } catch (_) {}
    }

    // 更新缓存
    this.manifestCache.delete(userKey);
    const stat = fs.statSync(targetPath);
    return {
      path: relativePath,
      size: stat.size,
      mtime: stat.mtimeMs,
      hash: this.calculateFileHash(targetPath)
    };
  }

  /**
   * 读取文件内容
   */
  readFile(userKey, relativePath) {
    const targetPath = this.resolveSafePath(userKey, relativePath);
    if (!fs.existsSync(targetPath)) {
      return null;
    }
    return {
      fullPath: targetPath,
      buffer: fs.readFileSync(targetPath)
    };
  }

  /**
   * 删除文件
   */
  deleteFile(userKey, relativePath) {
    const targetPath = this.resolveSafePath(userKey, relativePath);
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
      this.manifestCache.delete(userKey);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 版本历史(备份/回滚)
  //   users/<userKey>/.versions/<relPath>/<时间戳>__<设备>__<短哈希>
  //   放在 files/ 的同级目录,因此不会被 manifest 扫描到。
  // ---------------------------------------------------------------------------

  getUserVersionsDir(userKey) {
    const dir = path.join(this.baseDataDir, 'users', userKey, '.versions');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  resolveSafeVersionDir(userKey, relativePath) {
    const root = path.resolve(this.getUserVersionsDir(userKey));
    const normalized = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
    const dir = path.resolve(root, normalized);
    if (dir !== root && !dir.startsWith(root + path.sep)) {
      throw new Error(`Security Exception: Access denied to version path outside user root: ${relativePath}`);
    }
    return dir;
  }

  /**
   * 覆盖/删除之前,把当前版本留一份历史(供回滚)
   * @returns {Object|null} 版本元信息
   */
  snapshotVersion(userKey, relativePath, deviceId = 'unknown') {
    const current = this.readFile(userKey, relativePath);
    if (!current) return null;

    const hash = crypto.createHash('sha256').update(current.buffer).digest('hex');
    const dir = this.resolveSafeVersionDir(userKey, relativePath);
    fs.mkdirSync(dir, { recursive: true });

    const stamp = Date.now();
    const safeDevice = String(deviceId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
    const fileName = `${stamp}__${safeDevice}__${hash.slice(0, 8)}`;
    const targetPath = path.join(dir, fileName);

    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(current.fullPath, targetPath);
    }

    this.pruneVersions(userKey, relativePath);

    return {
      id: fileName,
      path: relativePath,
      timestamp: stamp,
      deviceId: safeDevice,
      hash,
      size: current.buffer.length
    };
  }

  /**
   * 列出某文件的历史版本(新 → 旧)
   */
  listVersions(userKey, relativePath) {
    const dir = this.resolveSafeVersionDir(userKey, relativePath);
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir)
      .map((name) => {
        const fullPath = path.join(dir, name);
        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch (_) {
          return null;
        }
        if (!stat.isFile()) return null;
        const [stampRaw, deviceRaw, hashShort] = name.split('__');
        const timestamp = Number(stampRaw) || stat.mtimeMs;
        return {
          id: name,
          timestamp,
          deviceId: deviceRaw || 'unknown',
          hashShort: hashShort || '',
          size: stat.size
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 读取指定历史版本内容
   */
  readVersion(userKey, relativePath, versionId) {
    const dir = this.resolveSafeVersionDir(userKey, relativePath);
    const safeId = path.basename(String(versionId || ''));
    const fullPath = path.resolve(dir, safeId);
    if (!fullPath.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(fullPath)) {
      return null;
    }
    return { fullPath, buffer: fs.readFileSync(fullPath) };
  }

  /**
   * 汇总所有有历史版本的条目(给前端"备份列表"用)
   */
  summarizeBackups(userKey) {
    const root = this.getUserVersionsDir(userKey);
    const result = [];

    const walk = (currentDir, relativePrefix = '') => {
      if (!fs.existsSync(currentDir)) return;
      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.posix.join(relativePrefix, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, relPath);
          continue;
        }
        // 版本文件名形如 <时间戳>__<设备>__<短哈希>,据此还原它属于哪个文件
        const versionDirRel = path.posix.dirname(relPath);
        const targetRel = versionDirRel === '.' ? entry.name : versionDirRel;
        const [stampRaw, deviceRaw] = entry.name.split('__');
        let stat = null;
        try {
          stat = fs.statSync(fullPath);
        } catch (_) {
          continue;
        }
        result.push({
          path: targetRel,
          versionId: entry.name,
          timestamp: Number(stampRaw) || stat.mtimeMs,
          deviceId: deviceRaw || 'unknown',
          size: stat.size
        });
      }
    };

    walk(root, '');

    // 按文件聚合
    const byPath = new Map();
    for (const item of result) {
      const bucket = byPath.get(item.path) || { path: item.path, versions: 0, latestTimestamp: 0, latestDevice: 'unknown' };
      bucket.versions += 1;
      if (item.timestamp > bucket.latestTimestamp) {
        bucket.latestTimestamp = item.timestamp;
        bucket.latestDevice = item.deviceId;
      }
      byPath.set(item.path, bucket);
    }

    return Array.from(byPath.values()).sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  }

  /**
   * 每个文件最多保留 N 个历史版本
   */
  pruneVersions(userKey, relativePath, keep = Number(process.env.MAX_VERSIONS_PER_FILE || 20)) {
    const dir = this.resolveSafeVersionDir(userKey, relativePath);
    const versions = this.listVersions(userKey, relativePath);
    for (const stale of versions.slice(keep)) {
      try {
        fs.unlinkSync(path.join(dir, stale.id));
      } catch (_) {}
    }
  }
}

module.exports = StorageManager;
