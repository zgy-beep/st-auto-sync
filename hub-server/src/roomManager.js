/**
 * 房间连接管理器 (Room Manager)
 * 维护在线 WebSocket 客户端连接，实现同用户多设备间的实时广播与保活
 */
class RoomManager {
  constructor() {
    // userKey -> Set<ClientSocketWrapper>
    this.rooms = new Map();
  }

  join(userKey, client) {
    if (!this.rooms.has(userKey)) {
      this.rooms.set(userKey, new Set());
    }
    this.rooms.get(userKey).add(client);
    client.userKey = userKey;

    console.log(`[Room] Device [${client.deviceId || 'unknown'}] joined room [${userKey}]. Total online: ${this.rooms.get(userKey).size}`);
    
    // 通知房间内其他设备有新设备上线
    this.broadcast(userKey, client, {
      type: 'device_presence',
      action: 'online',
      deviceId: client.deviceId,
      deviceName: client.deviceName,
      onlineCount: this.rooms.get(userKey).size,
      timestamp: Date.now()
    });
  }

  leave(client) {
    const userKey = client.userKey;
    if (!userKey || !this.rooms.has(userKey)) return;

    const room = this.rooms.get(userKey);
    room.delete(client);

    console.log(`[Room] Device [${client.deviceId || 'unknown'}] left room [${userKey}]. Remaining online: ${room.size}`);

    if (room.size === 0) {
      this.rooms.delete(userKey);
    } else {
      this.broadcast(userKey, null, {
        type: 'device_presence',
        action: 'offline',
        deviceId: client.deviceId,
        deviceName: client.deviceName,
        onlineCount: room.size,
        timestamp: Date.now()
      });
    }
  }

  /**
   * 广播消息给指定房间的客户端
   * @param {string} userKey 
   * @param {Object} senderWs - 发送者连接（传 null 则广播给所有人，否则排除发送者）
   * @param {Object} data - 要广播的 JSON 数据
   */
  broadcast(userKey, senderWs, data) {
    const room = this.rooms.get(userKey);
    if (!room || room.size === 0) return;

    const payload = JSON.stringify(data);
    for (const client of room) {
      if (client !== senderWs && client.ws && client.ws.readyState === 1 /* OPEN */) {
        try {
          client.ws.send(payload);
        } catch (err) {
          console.error(`[Room] Send failed to device [${client.deviceId}]:`, err.message);
        }
      }
    }
  }

  /**
   * 获取某房间的在线设备列表
   */
  getOnlineDevices(userKey) {
    const room = this.rooms.get(userKey);
    if (!room) return [];

    return Array.from(room).map((c) => ({
      deviceId: c.deviceId,
      deviceName: c.deviceName,
      connectedAt: c.connectedAt,
      lastHeartbeat: c.lastHeartbeat
    }));
  }
}

module.exports = RoomManager;
