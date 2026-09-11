const fs = require('node:fs');
const path = require('node:path');
const ManifestHelper = require('./manifestHelper');

/**
 * 云酒馆服务端环境母版管理器 (Cloud Profile Master)
 * 解决云端部署下，不同设备/浏览器首次登入变白板、需重复配置 API 与预设的痛点。
 */
class CloudProfileManager {
  constructor(stDataDir) {
    this.stDataDir = stDataDir;
    this.profileDir = path.join(stDataDir, '.stsync');
    this.profilePath = path.join(this.profileDir, 'cloud_profile.json');
  }

  ensureDir() {
    if (!fs.existsSync(this.profileDir)) {
      try {
        fs.mkdirSync(this.profileDir, { recursive: true });
      } catch (_) {}
    }
  }

  /**
   * 安全合并 secrets 字典（杜绝浅展开覆盖导致 api_key_custom 数组截断丢失）
   * @param {Object} existing - 服务端现有密钥字典
   * @param {Object} incoming - 客户端或新提取的密钥字典
   */
  static safeMergeSecrets(existing = {}, incoming = {}) {
    if (!existing || typeof existing !== 'object') existing = {};
    if (!incoming || typeof incoming !== 'object') incoming = {};

    const result = Array.isArray(existing) ? [...existing] : { ...existing };

    for (const [key, incVal] of Object.entries(incoming)) {
      if (incVal === undefined || incVal === null) {
        continue;
      }
      const exVal = existing[key];

      if (!(key in existing)) {
        result[key] = incVal;
        continue;
      }

      if (Array.isArray(exVal) && Array.isArray(incVal)) {
        // 合并数组：针对 SillyTavern 的 api_key_custom 等自定义接口数组结构
        const mergedArr = [...exVal];
        for (const incItem of incVal) {
          if (incItem && typeof incItem === 'object') {
            const idProp = incItem.id ? 'id' : (incItem.url ? 'url' : (incItem.name ? 'name' : null));
            if (idProp) {
              const matchIndex = mergedArr.findIndex(x => x && x[idProp] === incItem[idProp]);
              if (matchIndex >= 0) {
                mergedArr[matchIndex] = { ...mergedArr[matchIndex], ...incItem };
              } else {
                mergedArr.push(incItem);
              }
            } else {
              const incStr = JSON.stringify(incItem);
              if (!mergedArr.some(x => JSON.stringify(x) === incStr)) {
                mergedArr.push(incItem);
              }
            }
          } else {
            // 基础标量类型数组去重追加
            if (!mergedArr.includes(incItem)) {
              mergedArr.push(incItem);
            }
          }
        }
        result[key] = mergedArr;
      } else if (
        exVal && typeof exVal === 'object' && !Array.isArray(exVal) &&
        incVal && typeof incVal === 'object' && !Array.isArray(incVal)
      ) {
        result[key] = CloudProfileManager.safeMergeSecrets(exVal, incVal);
      } else {
        // 基础数据类型：空字符串不覆盖已有有效密钥
        if (typeof incVal === 'string' && incVal.trim() === '' && typeof exVal === 'string' && exVal.trim() !== '') {
          result[key] = exVal;
        } else {
          result[key] = incVal;
        }
      }
    }

    return result;
  }

  /**
   * 客户端脱敏清洗（剔除所有私钥与明文字符串，防止向全网 Web 客户端泄露）
   */
  sanitizeForClient(profile) {
    if (!profile) return null;
    const clone = JSON.parse(JSON.stringify(profile));

    // 1. 彻底移除 secrets 对象，绝不下发给浏览器
    delete clone.secrets;

    // 2. 清洗 settings，剔除所有包含 api_key、secret、token、password 的敏感字段
    if (clone.settings && typeof clone.settings === 'object') {
      for (const key of Object.keys(clone.settings)) {
        const lower = key.toLowerCase();
        if (
          lower.startsWith('api_key') ||
          lower.includes('secret') ||
          lower.includes('token') ||
          lower.includes('password')
        ) {
          delete clone.settings[key];
        }
      }
    }

    // 3. 统计并标记服务端是否已就绪密钥，让前端可知云端已配置密钥而无需获取明文
    const hasSecrets = !!(profile.secrets && Object.keys(profile.secrets).length > 0) ||
      Object.keys(profile.settings || {}).some(k => k.startsWith('api_key_') && profile.settings[k]);

    clone.summary = {
      ...(clone.summary || {}),
      has_secrets: hasSecrets
    };

    return clone;
  }

  /**
   * 读取云端固化的母版配置
   * @param {Object} options - { forClient: boolean } 是否脱敏下发给客户端
   */
  getProfile(options = {}) {
    if (!fs.existsSync(this.profilePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(this.profilePath, 'utf8');
      const profile = JSON.parse(raw);
      if (options && options.forClient) {
        return this.sanitizeForClient(profile);
      }
      return profile;
    } catch (err) {
      console.warn('[CloudProfileManager] Failed to parse cloud_profile.json:', err.message);
      return null;
    }
  }

  /**
   * 保存或更新云端母版配置
   * @param {Object} profileData - 前端当前调好的 API / Key / 预设环境数据
   * @param {Object} meta - 客户端设备信息
   */
  saveProfile(profileData = {}, meta = {}) {
    this.ensureDir();

    // 1. 过滤清洗核心配置（严格剔除特定设备的 theme/font_size/movingUI 等 UI 外观）
    const rawSettings = profileData.settings || profileData;
    const sanitizedSettings = ManifestHelper.sanitizeSettings(rawSettings);

    // 2. 提取并同步 secrets.json (API Key 字典)
    let secrets = profileData.secrets || null;
    if (!secrets) {
      // 尝试从本地数据目录读取已有 secrets
      const secretsCandidates = [
        path.join(this.stDataDir, 'secrets.json'),
        path.join(this.stDataDir, '..', 'secrets.json')
      ];
      for (const p of secretsCandidates) {
        if (fs.existsSync(p)) {
          try {
            secrets = JSON.parse(fs.readFileSync(p, 'utf8'));
            break;
          } catch (_) {}
        }
      }
    }
    if (!secrets || typeof secrets !== 'object') {
      secrets = {};
    }

    // 补齐前端 settings 中可能直接携带的 api_key_* 键值
    for (const [k, v] of Object.entries(rawSettings)) {
      if (k.startsWith('api_key_') && typeof v === 'string' && v.trim()) {
        secrets[k] = v.trim();
      }
    }

    // 3. 同步安全合并至服务端本地 secrets.json（若包含新 Key，绝不截断现有 key）
    const secretsPath = path.join(this.stDataDir, 'secrets.json');
    let effectiveSecrets = secrets;
    try {
      let existingSecrets = {};
      if (fs.existsSync(secretsPath)) {
        try { existingSecrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8')); } catch (_) {}
      }
      effectiveSecrets = CloudProfileManager.safeMergeSecrets(existingSecrets, secrets);
      if (Object.keys(effectiveSecrets).length > 0) {
        fs.writeFileSync(secretsPath, JSON.stringify(effectiveSecrets, null, 2), 'utf8');
      }
    } catch (err) {
      console.warn('[CloudProfileManager] Failed to persist secrets.json:', err.message);
    }

    const hasSecrets = Object.keys(effectiveSecrets || {}).length > 0;

    const profile = {
      version: '1.0.0',
      updated_at: Date.now(),
      updated_by: meta.deviceName || meta.deviceId || 'Web-Browser',
      settings: sanitizedSettings,
      secrets: effectiveSecrets,
      summary: {
        main_api: sanitizedSettings.main_api || 'openai',
        model: sanitizedSettings.model_openai || sanitizedSettings.openai_model || '(未指定)',
        preset: sanitizedSettings.preset || '(默认)',
        context: sanitizedSettings.context || '(默认)',
        instruct: sanitizedSettings.instruct || '(默认)',
        has_secrets: hasSecrets
      }
    };

    // 4. 落盘固化母版文件 (保存在服务端受保护的 .stsync 目录内)
    fs.writeFileSync(this.profilePath, JSON.stringify(profile, null, 2), 'utf8');

    console.log(`[CloudProfileManager] Cloud master profile persisted successfully by [${profile.updated_by}].`);
    return profile;
  }

  /**
   * 直接从服务端现有的 settings.json 与 secrets.json 中抓取当前环境生成母版
   */
  captureCurrentServerEnvironment(meta = {}) {
    const settingsPath = path.join(this.stDataDir, 'settings.json');
    let rawSettings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        rawSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (_) {}
    }

    const secretsPath = path.join(this.stDataDir, 'secrets.json');
    let rawSecrets = {};
    if (fs.existsSync(secretsPath)) {
      try {
        rawSecrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
      } catch (_) {}
    }

    return this.saveProfile({
      settings: rawSettings,
      secrets: rawSecrets
    }, meta);
  }
}

module.exports = CloudProfileManager;
