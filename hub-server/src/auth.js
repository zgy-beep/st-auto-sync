const crypto = require('node:crypto');

/**
 * 校验并生成租户唯一哈希标识
 * 将用户配置的 Token 转化为安全租户 UUID，用于数据目录物理隔离
 * @param {string} token - 用户配置的同步秘钥
 * @returns {string} 租户唯一标识
 */
function hashToken(token) {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('Invalid token: Token must be a non-empty string');
  }
  const clean = token.trim();
  const digest = crypto.createHash('sha256').update(clean).digest('hex');
  // 规整为 UUID 格式 (8-4-4-4-12)
  return `t_${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

/**
 * 恒定时间比较两个字符串 (防时序侧信道攻击)
 */
function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Express 鉴权中间件
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.headers['x-sync-token']) {
    token = req.headers['x-sync-token'].trim();
  } else if (req.query && req.query.token) {
    token = req.query.token.trim();
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Authentication failed: Missing Authorization token'
    });
  }

  try {
    req.userKey = hashToken(token);
    req.rawToken = token;
    next();
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
}

module.exports = {
  hashToken,
  constantTimeEquals,
  authMiddleware
};
