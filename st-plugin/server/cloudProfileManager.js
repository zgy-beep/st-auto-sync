const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
   * 读取云端固化的母版配置
   */
  getProfile() {
    if (!fs.existsSync(this.profilePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(this.profilePath, 'utf8');
      return JSON.parse(raw);
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
    const sanitizedSettings = ManifestHelper.sanitizeSettings(profileData.settings || profileData);

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

    const profile = {
      version: '1.0.0',
      updated_at: Date.now(),
      updated_by: meta.deviceName || meta.deviceId || 'Web-Browser',
      settings: sanitizedSettings,
      secrets: secrets || {},
      summary: {
        main_api: sanitizedSettings.main_api || 'openai',
        model: sanitizedSettings.model_openai || sanitizedSettings.openai_model || '(未指定)',
        preset: sanitizedSettings.preset || '(默认)',
        context: sanitizedSettings.context || '(默认)',
        instruct: sanitizedSettings.instruct || '(默认)'
      }
    };

    // 3. 落盘固化母版
    fs.writeFileSync(this.profilePath, JSON.stringify(profile, null, 2), 'utf8');

    // 4. 同步更新服务端本地的 secrets.json（若包含新 Key）
    if (secrets && typeof secrets === 'object' && Object.keys(secrets).length > 0) {
      const secretsPath = path.join(this.stDataDir, 'secrets.json');
      try {
        let existingSecrets = {};
        if (fs.existsSync(secretsPath)) {
          try { existingSecrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8')); } catch (_) {}
        }
        const mergedSecrets = { ...existingSecrets, ...secrets };
        fs.writeFileSync(secretsPath, JSON.stringify(mergedSecrets, null, 2), 'utf8');
      } catch (err) {
        console.warn('[CloudProfileManager] Failed to persist secrets.json:', err.message);
      }
    }

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
