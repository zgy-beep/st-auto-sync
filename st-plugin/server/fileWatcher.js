const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

/**
 * 4.1 LocalFileWatcher (带 .stsync/ 旁车 meta 的双阶高性能文件监听器)
 */
class LocalFileWatcher {
  constructor(stDataDir, onFileChangeCallback) {
    this.stDataDir = stDataDir;
    this.onFileChangeCallback = onFileChangeCallback;
    this.watchers = [];
    this.debounceTimers = new Map();
    this.suppressPaths = new Set();
    this.stSyncDir = path.join(stDataDir, '.stsync');

    if (!fs.existsSync(this.stSyncDir)) {
      try { fs.mkdirSync(this.stSyncDir, { recursive: true }); } catch (_) {}
    }
  }

  getMetaPath(relPath) {
    const safeName = relPath.replace(/[\/\\]/g, '__') + '.meta';
    return path.join(this.stSyncDir, safeName);
  }

  readMeta(relPath) {
    const metaPath = this.getMetaPath(relPath);
    if (fs.existsSync(metaPath)) {
      try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (_) {}
    }
    return null;
  }

  writeMeta(relPath, meta) {
    try {
      fs.writeFileSync(this.getMetaPath(relPath), JSON.stringify(meta), 'utf8');
    } catch (_) {}
  }

  suppressPath(relPath, durationMs = 3000) {
    this.suppressPaths.add(relPath);
    setTimeout(() => {
      this.suppressPaths.delete(relPath);
    }, durationMs);
  }

  start(categories = ['chats', 'characters', 'worlds', 'context', 'instruct']) {
    this.stop();

    for (const cat of categories) {
      const targetDir = path.join(this.stDataDir, cat);
      if (!fs.existsSync(targetDir)) {
        try { fs.mkdirSync(targetDir, { recursive: true }); } catch (_) {}
      }

      try {
        const watcher = fs.watch(targetDir, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          if (filename.startsWith('.') || filename.endsWith('.tmp') || filename.endsWith('.bak')) {
            return;
          }

          const relPath = path.posix.join(cat, filename.replace(/\\/g, '/'));
          if (this.suppressPaths.has(relPath)) return;

          // 第一阶段（零 IO 快速初筛）
          const fullPath = path.join(this.stDataDir, relPath);
          if (!fs.existsSync(fullPath)) {
            // 文件删除
            this.onFileChangeCallback(relPath, 'delete', null);
            return;
          }

          let stat;
          try {
            stat = fs.statSync(fullPath);
          } catch (_) {
            return;
          }

          const prevMeta = this.readMeta(relPath);

          // 若大小与时间均完全无变化，0 耗时跳过
          if (prevMeta && prevMeta.file_size === stat.size && prevMeta.mtime === stat.mtimeMs) {
            return;
          }

          // 第二阶段：高效分类捕获
          // 若为纯追加且文件变大
          let appendOnlyChunk = null;
          if (prevMeta && stat.size > prevMeta.file_size && relPath.endsWith('.jsonl')) {
            const addedBytes = stat.size - prevMeta.file_size;
            if (addedBytes < 65536) { // 64KB 以内的日常追加，直接定位偏移量读取新增内容
              try {
                const fd = fs.openSync(fullPath, 'r');
                const buf = Buffer.alloc(addedBytes);
                fs.readSync(fd, buf, 0, addedBytes, prevMeta.file_size);
                fs.closeSync(fd);
                appendOnlyChunk = buf.toString('utf8');
              } catch (_) {}
            }
          }

          // 防抖 600ms
          if (this.debounceTimers.has(relPath)) {
            clearTimeout(this.debounceTimers.get(relPath));
          }

          this.debounceTimers.set(
            relPath,
            setTimeout(() => {
              this.debounceTimers.delete(relPath);
              if (fs.existsSync(fullPath)) {
                const currentStat = fs.statSync(fullPath);
                // 更新旁车 meta
                this.writeMeta(relPath, {
                  file_size: currentStat.size,
                  mtime: currentStat.mtimeMs,
                  updated_at: Date.now()
                });
                this.onFileChangeCallback(relPath, eventType, appendOnlyChunk);
              }
            }, 600)
          );
        });

        this.watchers.push(watcher);
      } catch (err) {
        console.warn(`[FileWatcher] Failed to watch ${cat}:`, err.message);
      }
    }
  }

  stop() {
    for (const watcher of this.watchers) {
      try { watcher.close(); } catch (_) {}
    }
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}

module.exports = LocalFileWatcher;
