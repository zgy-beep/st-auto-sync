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
}

module.exports = StorageManager;
