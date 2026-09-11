const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 计算文件 Buffer 的 SHA-256
 */
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 4.2 本地双写竞态四重防护原子写入器 (AtomicWriter)
 */
class AtomicWriter {
  constructor() {
    // filePath -> Promise queue
    this.fileQueues = new Map();
  }

  /**
   * 进程内文件级互斥排他锁 (Mutex Queue)
   */
  async acquireLock(filePath, task) {
    const prevTask = this.fileQueues.get(filePath) || Promise.resolve();
    const currentTask = prevTask
      .catch(() => {})
      .then(async () => {
        return await task();
      });

    this.fileQueues.set(filePath, currentTask);
    return currentTask;
  }

  /**
   * 带 Windows EPERM/EBUSY 指数退避重试的原子重命名
   */
  async atomicRenameWithRetry(tmpPath, targetPath, maxRetries = 5) {
    let delay = 25;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        fs.renameSync(tmpPath, targetPath);
        return true;
      } catch (err) {
        if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempt < maxRetries) {
          // Windows 句柄锁定重试
          await sleep(delay);
          delay *= 2;
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * 4.2 Check-Before-Write 保护性落盘
   * @param {string} targetPath - 目标文件路径
   * @param {Buffer} newContentBuffer - 准备写入的权威数据
   * @param {string} baseHashBeforeDownload - 准备下载前记录的本地哈希
   * @param {Function} onConflictResolve - 若检测到本地哈希变化时的回调 (localDiskBuffer, newContentBuffer)
   */
  async safeWrite(targetPath, newContentBuffer, baseHashBeforeDownload = null, onConflictResolve = null) {
    return this.acquireLock(targetPath, async () => {
      let finalBuffer = newContentBuffer;

      // 1. Check-Before-Write 校验
      if (fs.existsSync(targetPath) && baseHashBeforeDownload) {
        const currentDiskBuffer = fs.readFileSync(targetPath);
        const currentDiskHash = sha256(currentDiskBuffer);

        if (currentDiskHash !== baseHashBeforeDownload) {
          console.warn(`[AtomicWriter] Race condition detected on ${targetPath}! Local disk changed during download.`);
          if (typeof onConflictResolve === 'function') {
            // 触发保护性合并
            finalBuffer = onConflictResolve(currentDiskBuffer, newContentBuffer);
          }
        }
      }

      // 2. 写入临时文件
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tmpPath = path.join(dir, `.${path.basename(targetPath)}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
      fs.writeFileSync(tmpPath, finalBuffer);

      // 3. 原子重命名替换
      await this.atomicRenameWithRetry(tmpPath, targetPath);

      // 清理残留（若有）
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }

      return {
        success: true,
        hash: sha256(finalBuffer),
        size: finalBuffer.length
      };
    });
  }
}

module.exports = new AtomicWriter();
