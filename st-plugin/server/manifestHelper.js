const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class ManifestHelper {
  constructor(dataRootDir) {
    this.dataRootDir = dataRootDir;
    // 内存哈希缓存：fullPath -> { mtime, size, hash }
    this.hashCache = new Map();
  }

  setDataRootDir(dir) {
    this.dataRootDir = dir;
  }

  calculateHash(filePath, stat) {
    const cached = this.hashCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
      return cached.hash;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      this.hashCache.set(filePath, {
        mtime: stat.mtimeMs,
        size: stat.size,
        hash
      });
      return hash;
    } catch (err) {
      console.warn(`[ManifestHelper] Failed to read ${filePath}:`, err.message);
      return null;
    }
  }

  /**
   * settings.json 细粒度白名单过滤
   * 仅同步无害的逻辑预设，坚决排除主题、字号、本地端口等 UI 布局项
   */
  static sanitizeSettings(rawJson) {
    if (!rawJson || typeof rawJson !== 'object') return {};
    const whitelistKeys = [
      'main_api',
      'api_server',
      'preset',
      'context',
      'instruct',
      'world_info',
      'quick_reply_slots'
    ];

    const cleaned = {};
    for (const key of whitelistKeys) {
      if (typeof rawJson[key] !== 'undefined') {
        cleaned[key] = rawJson[key];
      }
    }
    return cleaned;
  }

  /**
   * 扫描指定允许的子目录
   * @param {Object} options
   * @param {Array<string>} options.syncCategories - 允许同步的文件夹类别，如 ['chats', 'characters', 'worlds', 'context', 'instruct']
   * @param {boolean} options.syncSettings - 是否同步 settings.json
   */
  generateLocalManifest(options = {}) {
    const syncCategories = options.syncCategories || ['chats', 'characters', 'worlds', 'context', 'instruct'];
    const syncSettings = Boolean(options.syncSettings);

    const manifest = {};
    if (!fs.existsSync(this.dataRootDir)) {
      return manifest;
    }

    const walk = (currentDir, relativePrefix) => {
      if (!fs.existsSync(currentDir)) return;
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.posix.join(relativePrefix, entry.name);

        if (entry.name.startsWith('.') || entry.name.endsWith('.tmp') || entry.name.endsWith('.bak')) {
          continue;
        }

        if (entry.isDirectory()) {
          walk(fullPath, relPath);
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          const hash = this.calculateHash(fullPath, stat);
          if (hash) {
            manifest[relPath] = {
              path: relPath,
              size: stat.size,
              mtime: stat.mtimeMs,
              hash
            };
          }
        }
      }
    };

    // 扫描所选子目录
    for (const cat of syncCategories) {
      const catDir = path.join(this.dataRootDir, cat);
      if (fs.existsSync(catDir)) {
        walk(catDir, cat);
      }
    }

    // 检查 settings.json
    if (syncSettings) {
      const settingsPath = path.join(this.dataRootDir, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const stat = fs.statSync(settingsPath);
        const hash = this.calculateHash(settingsPath, stat);
        if (hash) {
          manifest['settings.json'] = {
            path: 'settings.json',
            size: stat.size,
            mtime: stat.mtimeMs,
            hash
          };
        }
      }
    }

    return manifest;
  }
}

module.exports = ManifestHelper;
