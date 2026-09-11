const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SYNC_CATEGORIES = [
  'chats',
  'characters',
  'worlds',
  'context',
  'instruct',
  'personas',
  'OpenAI Settings',
  'textgen_settings',
  'kobold_settings',
  'novelai_settings',
  'presets'
];

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
   * settings.json 开箱即聊白名单过滤
   * 同步所有发消息所必需的 API、Key、反代地址、模型名称与生成参数
   * 坚决排除 theme、fontSize、movingUI 等 UI 布局项，保证各端屏幕排版不打架
   */
  static sanitizeSettings(rawJson) {
    if (!rawJson || typeof rawJson !== 'object') return {};

    const exactWhitelist = [
      'main_api',
      'preset',
      'context',
      'instruct',
      'world_info',
      'persona_selected',
      'quick_reply_slots',
      'temp',
      'temperature',
      'max_tokens',
      'amount_gen',
      'top_p',
      'rep_pen',
      'stream'
    ];

    const prefixWhitelist = [
      'api_server_',
      'api_key_',
      'model_',
      'custom_url_',
      'openai_model',
      'claude_model'
    ];

    const cleaned = {};

    for (const [key, val] of Object.entries(rawJson)) {
      // 严格排除 UI、主题与本地网络配置
      if (
        key === 'theme' ||
        key === 'custom_gui_styles' ||
        key === 'font_size' ||
        key === 'zoom' ||
        key === 'movingUI' ||
        key === 'port' ||
        key === 'listen'
      ) {
        continue;
      }

      const matchExact = exactWhitelist.includes(key);
      const matchPrefix = prefixWhitelist.some((p) => key.startsWith(p));

      if (matchExact || matchPrefix) {
        cleaned[key] = val;
      }
    }

    return cleaned;
  }

  /**
   * 将远端权威的环境配置合并入本地 settings.json，保留本地原有的 UI 属性
   */
  static patchLocalSettings(localSettings = {}, remoteSanitized = {}) {
    const base = typeof localSettings === 'object' && localSettings !== null ? { ...localSettings } : {};
    return {
      ...base,
      ...remoteSanitized
    };
  }

  /**
   * 扫描指定允许的子目录与核心配置文件
   */
  generateLocalManifest(options = {}) {
    const syncCategories = options.syncCategories || DEFAULT_SYNC_CATEGORIES;
    const syncEnvironment = typeof options.syncEnvironment === 'boolean' ? options.syncEnvironment : true;

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

    // 1. 扫描所选子目录 (chats, characters, worlds, presets, personas 等)
    for (const cat of syncCategories) {
      const catDir = path.join(this.dataRootDir, cat);
      if (fs.existsSync(catDir)) {
        walk(catDir, cat);
      }
    }

    // 2. 开箱即聊环境配置 (secrets.json & 经过清洗的 settings.json)
    if (syncEnvironment) {
      // 密钥池 secrets.json (API Key)
      const secretsCandidates = [
        path.join(this.dataRootDir, 'secrets.json'),
        path.join(this.dataRootDir, '..', 'secrets.json')
      ];
      for (const secPath of secretsCandidates) {
        if (fs.existsSync(secPath)) {
          const stat = fs.statSync(secPath);
          const hash = this.calculateHash(secPath, stat);
          if (hash) {
            manifest['secrets.json'] = {
              path: 'secrets.json',
              size: stat.size,
              mtime: stat.mtimeMs,
              hash
            };
            break;
          }
        }
      }

      // 核心配置 settings.json (白名单过滤后参与比对)
      const settingsPath = path.join(this.dataRootDir, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          const sanitized = ManifestHelper.sanitizeSettings(raw);
          const buf = Buffer.from(JSON.stringify(sanitized), 'utf8');
          const hash = crypto.createHash('sha256').update(buf).digest('hex');

          manifest['settings.json'] = {
            path: 'settings.json',
            size: buf.length,
            mtime: fs.statSync(settingsPath).mtimeMs,
            hash
          };
        } catch (_) {}
      }
    }

    return manifest;
  }
}

module.exports = ManifestHelper;
