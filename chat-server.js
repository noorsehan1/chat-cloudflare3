// ==================== CHAT-SERVER-FULL.js ====================
// VERSION: 11.0.0 - STORAGE PER KURSI (TANPA CACHE) - READY DEPLOY

const C = {
  MAX_SEATS: 45,
  MAX_GLOBAL_CONNECTIONS: 150,
  MAX_MESSAGE_SIZE: 5000,
  NUMBER_INTERVAL_MS: 900000,
  MAX_NUMBER: 6,
};

const ROOMS = [
  "LowCard", "Quiz", "Gacor", "General", "LOVE BIRDS", "Birthday Party",
  "Sweet Memories", "Lounge Talk", "Noxxeliverothcifsa", "BESTIES",
  "Happy Vibes", "The Chatter Room"
];

const ROOMS_SET = new Set(ROOMS);

export class ChatServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ctx = state;
    this.closing = false;
    this.isDestroyed = false;
    this._startTime = Date.now();
    this._isRestoring = false;
    this._isNumberUpdating = false;
    
    this._userSeatDataCache = {};
    this.currentNumber = 1;
    
    this._restoreAllState().catch(() => {});
  }

  _getActiveWebSockets() {
    try {
      return this.ctx.getWebSockets();
    } catch(e) {
      return [];
    }
  }

  // ============ STORAGE OPERATIONS ============

  async _getSeatData(roomName, seat) {
    try {
      const key = `${roomName}_seat_${seat}`;
      return await this.ctx.storage.get(key) || null;
    } catch(e) {
      return null;
    }
  }

  async _getAllSeats(roomName) {
    try {
      const prefix = `${roomName}_seat_`;
      const keys = await this.ctx.storage.list({ prefix });
      const seats = {};
      for (const key of keys) {
        const parts = key.split('_');
        const seatNumber = parseInt(parts[3]);
        const data = await this.ctx.storage.get(key);
        seats[seatNumber] = data;
      }
      return seats;
    } catch(e) {
      return {};
    }
  }

  async _getKursiNumber(roomName, seat) {
    try {
      const key = `kursiNumber_${roomName}_seat_${seat}`;
      return await this.ctx.storage.get(key) || null;
    } catch(e) {
      return null;
    }
  }

  async _getPointData(roomName, seat) {
    try {
      const key = `point_${roomName}_seat_${seat}`;
      return await this.ctx.storage.get(key) || null;
    } catch(e) {
      return null;
    }
  }

  async _getAllPoints(roomName) {
    try {
      const prefix = `point_${roomName}_seat_`;
      const keys = await this.ctx.storage.list({ prefix });
      const points = {};
      for (const key of keys) {
        const parts = key.split('_');
        const seatNumber = parseInt(parts[3]);
        const data = await this.ctx.storage.get(key);
        points[seatNumber] = data;
      }
      return points;
    } catch(e) {
      return {};
    }
  }

  async _getUserData(username) {
    try {
      const key = `user_${username}`;
      return await this.ctx.storage.get(key) || null;
    } catch(e) {
      return null;
    }
  }

  async _getMuteStatus(roomName) {
    try {
      const key = `mute_${roomName}`;
      return await this.ctx.storage.get(key) || false;
    } catch(e) {
      return false;
    }
  }

  async _getRoomCount(roomName) {
    try {
      const prefix = `${roomName}_seat_`;
      const keys = await this.ctx.storage.list({ prefix });
      return keys.length;
    } catch(e) {
      return 0;
    }
  }

  async _getOnlineUsers() {
    try {
      return Object.keys(this._userSeatDataCache);
    } catch(e) {
      return [];
    }
  }

  async _saveSeatData(roomName, seat, data) {
    try {
      const key = `${roomName}_seat_${seat}`;
      await this.ctx.storage.put(key, data);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _saveKursiNumber(roomName, seat, number) {
    try {
      const key = `kursiNumber_${roomName}_seat_${seat}`;
      await this.ctx.storage.put(key, number);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _savePointData(roomName, seat, pointData) {
    try {
      const key = `point_${roomName}_seat_${seat}`;
      await this.ctx.storage.put(key, pointData);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _saveUserData(username, seatInfo) {
    try {
      const key = `user_${username}`;
      await this.ctx.storage.put(key, seatInfo);
      this._userSeatDataCache[username] = seatInfo;
      return true;
    } catch(e) {
      return false;
    }
  }

  async _saveMuteStatus(roomName, muted) {
    try {
      const key = `mute_${roomName}`;
      await this.ctx.storage.put(key, muted);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _deleteSeatData(roomName, seat) {
    try {
      const key = `${roomName}_seat_${seat}`;
      await this.ctx.storage.delete(key);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _deleteKursiNumber(roomName, seat) {
    try {
      const key = `kursiNumber_${roomName}_seat_${seat}`;
      await this.ctx.storage.delete(key);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _deletePointData(roomName, seat) {
    try {
      const key = `point_${roomName}_seat_${seat}`;
      await this.ctx.storage.delete(key);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _deleteUserData(username) {
    try {
      const key = `user_${username}`;
      await this.ctx.storage.delete(key);
      delete this._userSeatDataCache[username];
      return true;
    } catch(e) {
      return false;
    }
  }

  async _deleteMuteStatus(roomName) {
    try {
      const key = `mute_${roomName}`;
      await this.ctx.storage.delete(key);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _deleteAllRoomData(roomName) {
    try {
      const seatKeys = await this.ctx.storage.list({ prefix: `${roomName}_seat_` });
      for (const key of seatKeys) {
        await this.ctx.storage.delete(key);
      }
      const numberKeys = await this.ctx.storage.list({ prefix: `kursiNumber_${roomName}_seat_` });
      for (const key of numberKeys) {
        await this.ctx.storage.delete(key);
      }
      const pointKeys = await this.ctx.storage.list({ prefix: `point_${roomName}_seat_` });
      for (const key of pointKeys) {
        await this.ctx.storage.delete(key);
      }
      await this._deleteMuteStatus(roomName);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _deleteUserDataTotal(username) {
    if (!username) return false;
    try {
      const allKeys = await this.ctx.storage.list({ prefix: '' });
      for (const key of allKeys) {
        if (!key.startsWith('room_')) continue;
        const data = await this.ctx.storage.get(key);
        if (data && data.namauser === username) {
          const parts = key.split('_');
          const roomName = parts[1];
          const seat = parseInt(parts[3]);
          await this._deleteSeatData(roomName, seat);
          await this._deleteKursiNumber(roomName, seat);
          await this._deletePointData(roomName, seat);
          this.broadcast(roomName, ["removeKursi", roomName, seat]);
          await this.updateRoomCount(roomName);
        }
      }
      await this._deleteUserData(username);
      await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      await this._updateUserCounts();
      return true;
    } catch(e) {
      return false;
    }
  }

  // ============ USER MANAGEMENT ============

  _isUsernameExists(username) {
    try {
      return this._userSeatDataCache.hasOwnProperty(username);
    } catch(e) {
      return false;
    }
  }

  _isUserOnline(username) {
    try {
      return this._userSeatDataCache.hasOwnProperty(username);
    } catch(e) {
      return false;
    }
  }

  _getUserSeat(username) {
    try {
      return this._userSeatDataCache[username] || null;
    } catch(e) {
      return null;
    }
  }

  _isUserMulti(username) {
    try {
      if (!username) return false;
      const seatInfo = this._userSeatDataCache[username];
      return seatInfo ? (seatInfo.isMulti || false) : false;
    } catch(e) {
      return false;
    }
  }

  async _updateWebSocketRoom(ws, roomName, username, seat, isMulti = false) {
    if (!ws || !roomName || !username) return false;
    try {
      const seatInfo = { 
        room: roomName, 
        seat: seat, 
        isMulti: isMulti,
        multiRoom: isMulti ? roomName : null,
        multiSeat: isMulti ? seat : null
      };
      ws.serializeAttachment({
        username: username,
        room: roomName,
        seat: seat,
        isMulti: isMulti,
        multiRoom: isMulti ? roomName : null,
        multiSeat: isMulti ? seat : null,
        seatInfo: seatInfo
      });
      ws._cachedUsername = username;
      ws._cachedRoom = roomName;
      ws._cachedSeat = seat;
      ws.username = username;
      ws.idtarget = username;
      ws.room = roomName;
      ws.roomname = roomName;
      ws._isMulti = isMulti;
      ws._multiRoom = isMulti ? roomName : null;
      ws._multiSeat = isMulti ? seat : null;
      ws._closing = false;
      await this._saveUserData(username, seatInfo);
      await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      return true;
    } catch(e) {
      return false;
    }
  }

  async _removeUserFromAllRooms(username) {
    if (!username) return false;
    return await this._deleteUserDataTotal(username);
  }

  async _isUserInAnyRoom(username) {
    if (!username) return null;
    try {
      const seatInfo = this._userSeatDataCache[username];
      if (seatInfo && seatInfo.room) {
        const seatData = await this._getSeatData(seatInfo.room, seatInfo.seat);
        if (seatData && seatData.namauser === username) {
          return { 
            room: seatInfo.room, 
            seat: seatInfo.seat, 
            isMulti: seatInfo.isMulti || false 
          };
        }
      }
      return null;
    } catch(e) {
      return null;
    }
  }

  // ============ UPDATE KURSI & POINT ============

  async _updateKursi(roomName, seat, data) {
    try {
      const seatData = {
        noimageUrl: data.noimageUrl || "",
        namauser: data.namauser || "",
        color: data.color || "",
        itembawah: data.itembawah || 0,
        itematas: data.itematas || 0,
        vip: data.vip || 0,
        viptanda: data.viptanda || 0
      };
      await this._saveSeatData(roomName, seat, seatData);
      await this._saveKursiNumber(roomName, seat, data.number || seat);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _updatePoint(roomName, seat, x, y, fast) {
    try {
      const pointData = { x: x || 0, y: y || 0, fast: !!fast };
      await this._savePointData(roomName, seat, pointData);
      return true;
    } catch(e) {
      return false;
    }
  }

  // ============ JOIN HANDLING ============

  async _handleJoin(ws, roomName) {
    if (!ws || !ws.username || !roomName || !ROOMS_SET.has(roomName) || this.closing || this.isDestroyed) {
      return false;
    }
    const username = ws.username;
    try {
      await this._deleteUserDataTotal(username);
      let seat = null;
      for (let s = 1; s <= C.MAX_SEATS; s++) {
        const existing = await this._getSeatData(roomName, s);
        if (!existing) {
          seat = s;
          break;
        }
      }
      if (!seat) {
        this.safeSend(ws, ["roomFull", roomName]);
        return false;
      }
      const emptySeatData = {
        noimageUrl: "",
        namauser: username,
        color: "",
        itembawah: 0,
        itematas: 0,
        vip: 0,
        viptanda: 0
      };
      await this._saveSeatData(roomName, seat, emptySeatData);
      await this._saveKursiNumber(roomName, seat, seat);
      await this._deletePointData(roomName, seat);
      const seatInfo = {
        room: roomName,
        seat: seat,
        isMulti: false,
        multiRoom: null,
        multiSeat: null
      };
      await this._saveUserData(username, seatInfo);
      await this._updateWebSocketRoom(ws, roomName, username, seat, false);
      const muted = await this._getMuteStatus(roomName);
      this.safeSend(ws, ["rooMasuk", seat, roomName]);
      this.safeSend(ws, ["numberKursiSaya", seat]);
      this.safeSend(ws, ["muteTypeResponse", muted, roomName]);
      const count = await this._getRoomCount(roomName);
      this.safeSend(ws, ["roomUserCount", roomName, count]);
      this.broadcast(roomName, ["roomUserCount", roomName, count]);
      setTimeout(() => {
        try {
          if (ws && ws.readyState === 1) {
            this.sendAllStateTo(ws, roomName, true);
          }
        } catch(e) {}
      }, 1000);
      return true;
    } catch(e) {
      return false;
    }
  }

  // ============ CLEANUP ============

  async _cleanupUserOnDisconnect(ws) {
    if (!ws || ws._isCleaningUp) return;
    ws._isCleaningUp = true;
    try {
      const username = ws.username || ws._cachedUsername;
      if (!username) return;
      const isMulti = ws._isMulti || false;
      let hasSeat = false;
      const allKeys = await this.ctx.storage.list({ prefix: 'room_' });
      for (const key of allKeys) {
        const data = await this.ctx.storage.get(key);
        if (data && data.namauser === username) {
          hasSeat = true;
          break;
        }
      }
      if (isMulti && hasSeat) {
        await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
        return;
      }
      if (!hasSeat) {
        await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
        if (this._userSeatDataCache[username]) {
          await this._deleteUserData(username);
        }
        return;
      }
      if (hasSeat && !isMulti) {
        await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      }
    } catch(e) {
    } finally {
      ws._isCleaningUp = false;
    }
  }

  // ============ BROADCAST ============

  _broadcastToRoom(room, msgStr) {
    if (this.closing || this.isDestroyed || !room) return;
    try {
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          if (ws.readyState !== 1 || ws._closing) continue;
          let wsRoom = ws._cachedRoom;
          if (!wsRoom) {
            try {
              const attachment = ws.deserializeAttachment();
              wsRoom = attachment?.room;
            } catch(e) {}
          }
          if (!wsRoom) {
            wsRoom = ws.room || ws.roomname;
          }
          if (wsRoom === room) {
            ws.send(msgStr);
          }
        } catch(e) {}
      }
    } catch(e) {}
  }

  broadcast(room, msg) {
    if (this.closing || this.isDestroyed || !room || !msg) return;
    try { this._broadcastToRoom(room, JSON.stringify(msg)); } catch(e) {}
  }

  safeSend(ws, msg) {
    if (!ws) return false;
    try {
      if (ws.readyState !== 1 || ws._closing || this.closing || this.isDestroyed) {
        return false;
      }
      ws.send(JSON.stringify(msg));
      return true;
    } catch(e) {
      return false;
    }
  }

  // ============ STATE MANAGEMENT ============

  async updateRoomCount(room) {
    if (this.closing || this.isDestroyed || !room) return 0;
    try {
      const count = await this._getRoomCount(room);
      const counts = {};
      for (const r of ROOMS) {
        counts[r] = await this._getRoomCount(r);
      }
      await this.ctx.storage.put("userCounts", counts);
      this.broadcast(room, ["roomUserCount", room, count]);
      return count;
    } catch(e) { return 0; }
  }

  async _updateUserCounts() {
    try {
      const counts = {};
      let totalUsers = 0;
      for (const room of ROOMS) {
        const count = await this._getRoomCount(room);
        counts[room] = count;
        totalUsers += count;
      }
      await this.ctx.storage.put({
        userCounts: counts,
        onlineUsers: this._getOnlineUsers()
      });
      return { counts, total: totalUsers };
    } catch(e) {
      return { counts: {}, total: 0 };
    }
  }

  async sendAllStateTo(ws, room, excludeSelf = false) {
    if (!ws || !ws.username) return;
    try {
      if (ws.readyState !== 1 || ws._closing) return;
    } catch(e) { return; }
    try {
      const allSeats = await this._getAllSeats(room);
      const allPoints = await this._getAllPoints(room);
      const count = Object.keys(allSeats).length;
      this.safeSend(ws, ["roomUserCount", room, count]);
      const userSeat = this._userSeatDataCache[ws.username];
      const selfSeat = userSeat?.seat;
      if (allSeats && Object.keys(allSeats).length > 0) {
        if (excludeSelf && selfSeat && allSeats[selfSeat]) {
          const filtered = { ...allSeats };
          delete filtered[selfSeat];
          if (Object.keys(filtered).length > 0) {
            this.safeSend(ws, ["allUpdateKursiList", room, filtered]);
          }
        } else {
          this.safeSend(ws, ["allUpdateKursiList", room, allSeats]);
        }
      }
      if (allPoints && Object.keys(allPoints).length > 0) {
        let filteredPoints = Object.entries(allPoints).map(([seat, point]) => ({
          seat: parseInt(seat),
          x: point.x,
          y: point.y,
          fast: point.fast ? 1 : 0
        }));
        if (excludeSelf && selfSeat) {
          filteredPoints = filteredPoints.filter(p => p.seat !== selfSeat);
        }
        if (filteredPoints.length > 0) {
          this.safeSend(ws, ["allPointsList", room, filteredPoints]);
        }
      }
    } catch(e) {}
  }

  // ============ ALARM ============

  async alarm() {
    if (this.closing || this.isDestroyed) return;
    try {
      await this._updateNumber();
      await this._checkMultiUsers();
      await this._cleanupStorage();
    } catch(e) {}
    if (!this.closing && !this.isDestroyed) {
      try {
        this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      } catch(e) {}
    }
  }

  // ============ UPDATE NUMBER 1-6 ============

  async _updateNumber() {
    if (this._isNumberUpdating || this.closing || this.isDestroyed) return;
    this._isNumberUpdating = true;
    try {
      this.currentNumber = this.currentNumber < C.MAX_NUMBER ? this.currentNumber + 1 : 1;
      await this.ctx.storage.put("currentNumber", this.currentNumber);
      const numberMsg = JSON.stringify(["currentNumber", this.currentNumber]);
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          if (ws.readyState === 1) {
            ws.send(numberMsg);
          }
        } catch(e) {}
      }
    } catch(e) {
      try {
        const storage = await this.ctx.storage.get(["currentNumber"]);
        if (storage.currentNumber !== undefined) this.currentNumber = storage.currentNumber;
      } catch(err) {}
    } finally {
      this._isNumberUpdating = false;
    }
  }

  // ============ MULTI USER CHECK ============

  async _checkMultiUsers() {
    try {
      const webSockets = this._getActiveWebSockets();
      const connectedUsers = new Set();
      const usersWithSeats = new Set();
      for (const ws of webSockets) {
        try {
          const uname = ws._cachedUsername || ws.username || ws.deserializeAttachment()?.username;
          if (uname && ws.readyState === 1) {
            connectedUsers.add(uname);
          }
        } catch(e) {}
      }
      const allKeys = await this.ctx.storage.list({ prefix: 'room_' });
      for (const key of allKeys) {
        const data = await this.ctx.storage.get(key);
        if (data && data.namauser) {
          usersWithSeats.add(data.namauser);
        }
      }
      let changed = false;
      for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
        if (seatInfo.isMulti) {
          const seatData = await this._getSeatData(seatInfo.room, seatInfo.seat);
          if (!seatData || seatData.namauser !== username) {
            await this._deleteUserData(username);
            changed = true;
          }
        }
      }
      for (const username of usersWithSeats) {
        if (!this._userSeatDataCache[username]) {
          const allKeys2 = await this.ctx.storage.list({ prefix: 'room_' });
          for (const key of allKeys2) {
            const data = await this.ctx.storage.get(key);
            if (data && data.namauser === username) {
              const parts = key.split('_');
              const roomName = parts[1];
              const seat = parseInt(parts[3]);
              const seatInfo = {
                room: roomName,
                seat: seat,
                isMulti: true,
                multiRoom: roomName,
                multiSeat: seat
              };
              await this._saveUserData(username, seatInfo);
              changed = true;
              break;
            }
          }
        }
      }
      for (const username of connectedUsers) {
        const seatInfo = this._userSeatDataCache[username];
        if (seatInfo && !seatInfo.isMulti && !usersWithSeats.has(username)) {
          await this._deleteUserData(username);
          changed = true;
        } else if (!seatInfo && !usersWithSeats.has(username)) {
          changed = true;
        }
      }
      if (changed) {
        await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      }
    } catch(e) {}
  }

  // ============ CLEANUP STORAGE ============

  async _cleanupStorage() {
    try {
      let changed = false;
      const connectedUsers = new Set();
      const usersWithSeats = new Set();
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          const uname = ws._cachedUsername || ws.username || ws.deserializeAttachment()?.username;
          if (uname && ws.readyState === 1) {
            connectedUsers.add(uname);
          }
        } catch(e) {}
      }
      const allKeys = await this.ctx.storage.list({ prefix: 'room_' });
      for (const key of allKeys) {
        const data = await this.ctx.storage.get(key);
        if (data && data.namauser) {
          usersWithSeats.add(data.namauser);
        }
      }
      for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
        if (!seatInfo || !seatInfo.room) {
          await this._deleteUserData(username);
          changed = true;
          continue;
        }
        if (!usersWithSeats.has(username)) {
          if (!seatInfo.isMulti) {
            await this._deleteUserData(username);
            changed = true;
          } else if (!connectedUsers.has(username)) {
            await this._deleteUserData(username);
            changed = true;
          }
        } else {
          if (!seatInfo.isMulti) {
            seatInfo.isMulti = true;
            await this._saveUserData(username, seatInfo);
            changed = true;
          }
        }
      }
      const roomSet = new Set();
      for (const key of allKeys) {
        const parts = key.split('_');
        if (parts.length >= 2) {
          roomSet.add(parts[1]);
        }
      }
      for (const roomName of roomSet) {
        const seatCount = await this._getRoomCount(roomName);
        const pointCount = (await this._getAllPoints(roomName)).length;
        if (seatCount === 0 && pointCount === 0) {
          await this._deleteAllRoomData(roomName);
          changed = true;
        }
      }
      if (changed) {
        await this._updateUserCounts();
      }
    } catch(e) {}
  }

  // ============ WEBSOCKET EVENT HANDLERS ============

  async webSocketMessage(ws, message) {
    if (!ws || ws._closing || this.closing || this.isDestroyed) return;
    try {
      let attachment = null;
      try {
        attachment = ws.deserializeAttachment();
      } catch(e) {}
      if (attachment && attachment.username) {
        ws.username = attachment.username;
        ws.room = attachment.room;
        ws.roomname = attachment.room;
        ws.idtarget = attachment.username;
        ws._isMulti = attachment.isMulti || false;
        ws._multiRoom = attachment.multiRoom || null;
        ws._multiSeat = attachment.multiSeat || null;
        ws._cachedUsername = attachment.username;
        ws._cachedRoom = attachment.room;
        ws._cachedSeat = attachment.seat;
        if (attachment.seatInfo) {
          this._userSeatDataCache[attachment.username] = attachment.seatInfo;
        }
      }
      await this.handleMessage(ws, message);
    } catch(e) {}
  }

  async webSocketClose(ws, code, reason, wasClean) {
    if (!ws) return;
    try {
      await this._cleanupUserOnDisconnect(ws);
    } catch(e) {}
  }

  async webSocketError(ws, error) {
    if (!ws) return;
    try {
      await this._cleanupUserOnDisconnect(ws);
    } catch(e) {}
  }

  // ============ HANDLE SET ID ============

  async _handleSetId(ws, username, isNewUser) {
    if (!ws || !username || typeof username !== 'string' || username.length === 0 || this.closing || this.isDestroyed) {
      try { if (ws?.readyState === 1) ws.close(1000, "Invalid username"); } catch(e) {}
      return;
    }
    if (ws.readyState !== 1) return;
    try {
      await this._deleteUserDataTotal(username);
      ws.username = username;
      ws.idtarget = username;
      ws.room = null;
      ws.roomname = null;
      ws._closing = false;
      ws._isMulti = false;
      ws._multiRoom = null;
      ws._multiSeat = null;
      ws._cachedUsername = username;
      ws._cachedRoom = null;
      ws._cachedSeat = null;
      ws.serializeAttachment({ 
        username: username,
        isMulti: false 
      });
      if (isNewUser) { 
        this.safeSend(ws, ["joinroomawal"]); 
      } else { 
        this.safeSend(ws, ["needJoinRoom"]); 
      }
    } catch(e) {}
  }

  // ============ HANDLE MESSAGE ============

  async handleMessage(ws, raw) {
    if (!ws) return;
    try {
      if (ws.readyState !== 1 || ws._closing || this.closing || this.isDestroyed) {
        return;
      }
    } catch(e) { return; }
    try {
      let str = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      if (str.length > C.MAX_MESSAGE_SIZE) return;
      let data;
      try { data = JSON.parse(str); } catch(e) { return; }
      if (!Array.isArray(data) || !data.length) return;
      const [evt, ...args] = data;
      if (evt === "chat" || evt === "updatePoint" || evt === "gift" || evt === "rollangak") {
        const room = args[0];
        if (room && !ROOMS_SET.has(room)) return;
      }
      await this._handleEventInternal(ws, [evt, ...args]);
    } catch(e) {}
  }

  // ============ EVENT HANDLER INTERNAL ============

  async _handleEventInternal(ws, data) {
    try {
      if (!ws || !data || !data[0]) return;
      const [evt, ...args] = data;
      switch(evt) {
        case "resetServer": {
          const result = await this.resetAllData();
          this.safeSend(ws, ["resetResult", result]);
          break;
        }
        case "getCurrentNumber":
          this.safeSend(ws, ["currentNumber", this.currentNumber]);
          break;
        case "setIdTarget2": {
          const username = args[0];
          const isNewUser = args[1];
          if (!isNewUser && this._isUserMulti(username)) {
            try {
              const currentSeat = this._userSeatDataCache[username];
              if (currentSeat) {
                currentSeat._lastSeen = Date.now();
                currentSeat._wsId = ws._wsId || null;
                await this._saveUserData(username, currentSeat);
                await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
              }
            } catch(e) {}
            return;
          }
          if (username) {
            await this._deleteUserDataTotal(username);
          }
          await this._handleSetId(ws, username, isNewUser);
          break;
        }
        case "joinRoom":
          await this._handleJoin(ws, args[0]);
          break;
        case "multiJoin": {
          const multiUsername = args[0];
          const multiRoomname = args[1];
          if (!multiUsername || !multiRoomname) {
            this.safeSend(ws, ["multiJoinError", "Username dan room harus diisi"]);
            break;
          }
          if (!ROOMS_SET.has(multiRoomname)) {
            this.safeSend(ws, ["multiJoinError", "Room tidak valid"]);
            break;
          }
          await this._deleteUserDataTotal(multiUsername);
          let seat = null;
          for (let s = 1; s <= C.MAX_SEATS; s++) {
            const existing = await this._getSeatData(multiRoomname, s);
            if (!existing) {
              seat = s;
              break;
            }
          }
          if (!seat) {
            this.safeSend(ws, ["multiJoinError", "Tidak ada kursi tersedia"]);
            break;
          }
          const emptySeatData = {
            noimageUrl: "",
            namauser: multiUsername,
            color: "",
            itembawah: 0,
            itematas: 0,
            vip: 0,
            viptanda: 0
          };
          await this._saveSeatData(multiRoomname, seat, emptySeatData);
          await this._saveKursiNumber(multiRoomname, seat, seat);
          await this._deletePointData(multiRoomname, seat);
          const seatInfo = {
            room: multiRoomname,
            seat: seat,
            isMulti: true,
            multiRoom: multiRoomname,
            multiSeat: seat
          };
          await this._saveUserData(multiUsername, seatInfo);
          await this._updateWebSocketRoom(ws, multiRoomname, multiUsername, seat, true);
          const webSockets = this._getActiveWebSockets();
          for (const wsKey of webSockets) {
            if (wsKey === ws) continue;
            try {
              const uname = wsKey._cachedUsername || wsKey.username || wsKey.deserializeAttachment()?.username;
              if (uname === multiUsername && wsKey.readyState === 1) {
                await this._updateWebSocketRoom(wsKey, multiRoomname, multiUsername, seat, true);
              }
            } catch(e) {}
          }
          this.safeSend(ws, ["rooMasukMulti", seat, multiRoomname]);
          const count = await this._getRoomCount(multiRoomname);
          this.broadcast(multiRoomname, ["roomUserCount", multiRoomname, count]);
          break;
        }
        case "setActiveMulti": {
          const targetUsername = args[0];
          if (!targetUsername) {
            this.safeSend(ws, ["activeChangedMultiError", "Username tidak boleh kosong"]);
            break;
          }
          let userSeat = this._userSeatDataCache[targetUsername];
          if (!userSeat) {
            const allKeys = await this.ctx.storage.list({ prefix: 'room_' });
            for (const key of allKeys) {
              const data = await this.ctx.storage.get(key);
              if (data && data.namauser === targetUsername) {
                const parts = key.split('_');
                const roomName = parts[1];
                const seat = parseInt(parts[3]);
                userSeat = { room: roomName, seat: seat, isMulti: true };
                break;
              }
            }
          }
          if (!userSeat) {
            this.safeSend(ws, ["activeChangedMultiError", `User ${targetUsername} tidak ditemukan`]);
            break;
          }
          const roomName = userSeat.room;
          const seatNumber = userSeat.seat;
          const seatInfo = {
            room: roomName,
            seat: seatNumber,
            isMulti: true,
            multiRoom: roomName,
            multiSeat: seatNumber
          };
          await this._saveUserData(targetUsername, seatInfo);
          const webSockets = this._getActiveWebSockets();
          let foundAny = false;
          for (const wsKey of webSockets) {
            try {
              const uname = wsKey._cachedUsername || wsKey.username || wsKey.deserializeAttachment()?.username;
              if (uname === targetUsername && wsKey.readyState === 1) {
                await this._updateWebSocketRoom(wsKey, roomName, targetUsername, seatNumber, true);
                foundAny = true;
                this.safeSend(wsKey, ["activeChangedMulti", targetUsername, seatNumber, roomName]);
                if (wsKey !== ws) {
                  this.safeSend(ws, ["activeChangedMulti", targetUsername, seatNumber, roomName]);
                }
              }
            } catch(e) {}
          }
          if (!foundAny) {
            this.safeSend(ws, ["activeChangedMulti", targetUsername, seatNumber, roomName]);
          }
          this.broadcast(roomName, ["userActiveChanged", targetUsername, seatNumber]);
          break;
        }
        case "exitMulti": {
          const targetUsername = args[0];
          if (!targetUsername) {
            this.safeSend(ws, ["exitMultiError", "Username tidak boleh kosong"]);
            break;
          }
          try {
            await this._deleteUserDataTotal(targetUsername);
            const webSockets = this._getActiveWebSockets();
            for (const wsKey of webSockets) {
              try {
                const uname = wsKey._cachedUsername || wsKey.username || wsKey.deserializeAttachment()?.username;
                if (uname === targetUsername) {
                  wsKey._isMulti = false;
                  wsKey._multiRoom = null;
                  wsKey._multiSeat = null;
                  wsKey._cachedRoom = null;
                  wsKey.room = null;
                  wsKey.roomname = null;
                  wsKey.idtarget = null;
                  wsKey.serializeAttachment({ 
                    username: targetUsername,
                    isMulti: false
                  });
                  this.safeSend(wsKey, ["exitMultiSuccess", targetUsername, null, null]);
                }
              } catch(e) {}
            }
            this.safeSend(ws, ["exitMultiSuccess", targetUsername, null, null]);
          } catch(e) {
            this.safeSend(ws, ["exitMultiError", e.message]);
          }
          break;
        }
        case "updateKursi": {
          const [kursiRoom, kursiSeat, kursiNoimg, kursiName, kursiColor, kursiBawah, kursiAtas, kursiVip, kursiVt, kursiNumber] = args;
          const updated = await this._updateKursi(kursiRoom, kursiSeat, {
            noimageUrl: kursiNoimg || "",
            namauser: kursiName || "",
            color: kursiColor || "",
            itembawah: kursiBawah || 0,
            itematas: kursiAtas || 0,
            vip: kursiVip || 0,
            viptanda: kursiVt || 0,
            number: kursiNumber || 0
          });
          if (updated) {
            const updatedSeat = await this._getSeatData(kursiRoom, kursiSeat);
            if (updatedSeat) {
              this.broadcast(kursiRoom, ["kursiBatchUpdate", kursiRoom, [[kursiSeat, updatedSeat]]]);
            }
          }
          break;
        }
        case "chat": {
          const [chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor] = args;
          if (!chatMsg || !ROOMS_SET.has(chatRoom)) break;
          const isMuted = await this._getMuteStatus(chatRoom);
          if (isMuted) {
            this.safeSend(ws, ["chatError", "Room sedang di-mute"]);
            break;
          }
          const userSeat = this._userSeatDataCache[chatUser];
          if (!userSeat || userSeat.room !== chatRoom) break;
          this._broadcastToRoom(chatRoom, JSON.stringify(["chat", chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor]));
          break;
        }
        case "updatePoint": {
          const [pointRoom, pointSeat, pointX, pointY, pointFast] = args;
          if (!pointRoom || typeof pointSeat !== 'number') break;
          const updated = await this._updatePoint(pointRoom, pointSeat, pointX, pointY, pointFast === 1);
          if (updated) {
            this._broadcastToRoom(pointRoom, JSON.stringify(["pointUpdated", pointRoom, pointSeat, pointX, pointY, pointFast]));
          }
          break;
        }
        case "removeKursiAndPoint": {
          const [removeRoom, removeSeat] = args;
          const seatData = await this._getSeatData(removeRoom, removeSeat);
          let username = null;
          if (seatData) {
            username = seatData.namauser;
          }
          if (username) {
            await this._deleteUserDataTotal(username);
          }
          break;
        }
        case "private": {
          const [privTarget, privNoimg, privMsg, privSender] = args;
          if (privTarget && privMsg) {
            const userSeat = this._userSeatDataCache[privTarget];
            if (userSeat) {
              const webSockets = this._getActiveWebSockets();
              for (const wsKey of webSockets) {
                try {
                  const uname = wsKey._cachedUsername || wsKey.username || wsKey.deserializeAttachment()?.username;
                  if (uname === privTarget && wsKey.readyState === 1) {
                    this.safeSend(wsKey, ["private", privTarget, privNoimg, privMsg, Date.now(), privSender]);
                  }
                } catch(e) {}
              }
            }
            this.safeSend(ws, ["private", privTarget, privNoimg, privMsg, Date.now(), privSender]);
          }
          break;
        }
        case "gift": {
          const [giftRoom, giftSender, giftReceiver, giftGiftName] = args;
          if (giftRoom && ROOMS_SET.has(giftRoom)) {
            const receiverSeat = this._userSeatDataCache[giftReceiver];
            if (!receiverSeat || receiverSeat.room !== giftRoom) break;
            this._broadcastToRoom(giftRoom, JSON.stringify(["gift", giftRoom, giftSender, giftReceiver, giftGiftName, Date.now()]));
          }
          break;
        }
        case "rollangak": {
          const [rollRoom, rollUser, rollAngka] = args;
          if (rollRoom && ROOMS_SET.has(rollRoom)) {
            const userSeat = this._userSeatDataCache[rollUser];
            if (!userSeat || userSeat.room !== rollRoom) break;
            this._broadcastToRoom(rollRoom, JSON.stringify(["rollangakBroadcast", rollRoom, rollUser, rollAngka]));
          }
          break;
        }
        case "sendnotif": {
          try {
            const [notifTarget, notifNoimg, notifUser, notifMsg] = args;
            if (notifTarget && notifMsg) {
              const webSockets = this._getActiveWebSockets();
              for (const wsKey of webSockets) {
                try {
                  const uname = wsKey._cachedUsername || wsKey.username || wsKey.deserializeAttachment()?.username;
                  if (uname === notifTarget && wsKey.readyState === 1) {
                    this.safeSend(wsKey, ["notif", notifNoimg, notifUser, notifMsg, Date.now()]);
                    break;
                  }
                } catch(e) {}
              }
            }
          } catch(e) {}
          break;
        }
        case "isUserOnline": {
          const [onlineTarget, onlineCallback] = args;
          const isOnline = this._isUserOnline(onlineTarget);
          this.safeSend(ws, ["userOnlineStatus", onlineTarget, isOnline, onlineCallback || ""]);
          break;
        }
        case "getOnlineUsers": {
          this.safeSend(ws, ["allOnlineUsers", this._getOnlineUsers()]);
          break;
        }
        case "getAllRoomsUserCount": {
          const counts = {};
          for (const room of ROOMS) {
            counts[room] = await this._getRoomCount(room);
          }
          this.safeSend(ws, ["allRoomsUserCount", Object.entries(counts)]);
          break;
        }
        case "getRoomUserCount": {
          const roomName = args[0];
          if (roomName && ROOMS_SET.has(roomName)) {
            const count = await this._getRoomCount(roomName);
            this.safeSend(ws, ["roomUserCount", roomName, count]);
          }
          break;
        }
        case "setMuteType": {
          const [muteVal, muteRoom] = args;
          if (!muteRoom || !ROOMS_SET.has(muteRoom)) break;
          await this._saveMuteStatus(muteRoom, !!muteVal);
          this.broadcast(muteRoom, ["muteStatusChanged", !!muteVal, muteRoom]);
          this.safeSend(ws, ["muteTypeSet", !!muteVal, true, muteRoom]);
          break;
        }
        case "modwarning": {
          const modRoom = args[0];
          if (modRoom && ROOMS_SET.has(modRoom)) {
            this.broadcast(modRoom, ["modwarning", modRoom]);
          }
          break;
        }
        case "getMuteType": {
          const getMuteRoom = args[0];
          if (getMuteRoom && ROOMS_SET.has(getMuteRoom)) {
            const muted = await this._getMuteStatus(getMuteRoom);
            this.safeSend(ws, ["muteTypeResponse", muted, getMuteRoom]);
          }
          break;
        }
        case "onDestroy":
          break;
        default:
          this.safeSend(ws, ["error", `Unknown event: ${evt}`]);
          break;
      }
    } catch(e) {}
  }

  // ============ RESTORE STATE ============

  async _restoreAllState() {
    if (this._isRestoring) return;
    this._isRestoring = true;
    try {
      const userKeys = await this.ctx.storage.list({ prefix: 'user_' });
      for (const key of userKeys) {
        const username = key.replace('user_', '');
        const data = await this.ctx.storage.get(key);
        if (data) {
          this._userSeatDataCache[username] = data;
        }
      }
      const currentNumber = await this.ctx.storage.get('currentNumber');
      if (currentNumber) {
        this.currentNumber = currentNumber;
      }
      await this._updateUserCounts();
      await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      if (!this.closing && !this.isDestroyed) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        if (!existingAlarm) {
          this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        }
      }
      const webSockets = this.ctx.getWebSockets();
      for (const ws of webSockets) {
        try {
          const attachment = ws.deserializeAttachment();
          if (attachment && attachment.username) {
            const userSeat = this._userSeatDataCache[attachment.username];
            if (userSeat) {
              const isMulti = attachment.isMulti || userSeat.isMulti || false;
              const roomName = attachment.room || userSeat.room;
              const seatNumber = attachment.seat || userSeat.seat;
              ws.username = attachment.username;
              ws.room = roomName;
              ws.roomname = roomName;
              ws.idtarget = attachment.username;
              ws._closing = false;
              ws._isMulti = isMulti;
              ws._multiRoom = attachment.multiRoom || roomName;
              ws._multiSeat = attachment.multiSeat || seatNumber;
              ws._cachedUsername = attachment.username;
              ws._cachedRoom = roomName;
              ws._cachedSeat = seatNumber;
              ws.serializeAttachment({
                username: attachment.username,
                room: roomName,
                seat: seatNumber,
                isMulti: isMulti,
                multiRoom: attachment.multiRoom || roomName,
                multiSeat: attachment.multiSeat || seatNumber,
                seatInfo: userSeat
              });
            }
          }
        } catch(e) {}
      }
      for (const ws of webSockets) {
        try {
          if (ws.readyState === 1 && ws.username && ws.room) {
            const muted = await this._getMuteStatus(ws.room);
            this.safeSend(ws, ["muteTypeResponse", muted, ws.room]);
            const count = await this._getRoomCount(ws.room);
            this.safeSend(ws, ["roomUserCount", ws.room, count]);
            this.safeSend(ws, ["currentNumber", this.currentNumber]);
            await this.sendAllStateTo(ws, ws.room, true);
          }
        } catch(e) {}
      }
    } catch(e) {
    } finally {
      this._isRestoring = false;
    }
  }

  // ============ RESET ALL DATA ============

  async resetAllData() {
    const timestamp = Date.now();
    try {
      const allKeys = await this.ctx.storage.list({ prefix: '' });
      for (const key of allKeys) {
        await this.ctx.storage.delete(key);
      }
      this._userSeatDataCache = {};
      this.currentNumber = 1;
      const resetMessage = JSON.stringify(["serverReset", "Server di-reset pada: " + new Date(timestamp).toLocaleString()]);
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          if (ws.readyState === 1) {
            ws.send(resetMessage);
          }
        } catch(e) {}
      }
      for (const ws of webSockets) {
        try {
          if (ws.readyState === 1) {
            ws.close(1000, "Server reset - " + timestamp);
          }
        } catch(e) {}
      }
      if (!this.closing && !this.isDestroyed) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        if (!existingAlarm) {
          await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        }
      }
      await this.ctx.storage.put("lastReset", timestamp);
      return {
        success: true,
        message: "Semua data berhasil direset",
        timestamp: timestamp,
        resetTime: new Date(timestamp).toLocaleString()
      };
    } catch(e) {
      return {
        success: false,
        error: e.message,
        timestamp: timestamp
      };
    }
  }

  // ============ FETCH ============

  async fetch(req) {
    if (this.closing || this.isDestroyed) {
      return new Response("Shutting down", { status: 503 });
    }
    try {
      const url = new URL(req.url);
      if (url.pathname === "/reset" && req.method === "POST") {
        const result = await this.resetAllData();
        return new Response(JSON.stringify(result), {
          status: result.success ? 200 : 500,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.pathname === "/status") {
        const webSockets = this._getActiveWebSockets();
        const status = {
          activeConnections: webSockets.length,
          rooms: {},
          totalUsers: this._getOnlineUsers().length,
          currentNumber: this.currentNumber,
          isClosing: this.closing,
          isDestroyed: this.isDestroyed,
          uptime: Date.now() - this._startTime
        };
        for (const room of ROOMS) {
          status.rooms[room] = await this._getRoomCount(room);
        }
        return new Response(JSON.stringify(status), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const upgrade = req.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        return new Response("Chat Server - No Ping/Pong", { 
          status: 200,
          headers: { "Cache-Control": "no-cache" }
        });
      }
      const currentConnections = this._getActiveWebSockets().length;
      if (currentConnections >= C.MAX_GLOBAL_CONNECTIONS) {
        return new Response("Server full", { status: 503 });
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      try {
        this.ctx.acceptWebSocket(server);
      } catch(e) {
        return new Response("WebSocket acceptance failed", { status: 500 });
      }
      server.username = null;
      server.room = null;
      server.roomname = null;
      server.idtarget = null;
      server._closing = false;
      server._wsId = Date.now() + Math.random();
      server._isMulti = false;
      server._multiRoom = null;
      server._multiSeat = null;
      server._cachedUsername = null;
      server._cachedRoom = null;
      server._cachedSeat = null;
      server._isCleaningUp = false;
      server.serializeAttachment({});
      return new Response(null, { 
        status: 101, 
        webSocket: client
      });
    } catch(e) {
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // ============ DESTROY ============

  async destroy() {
    if (this.isDestroyed) return;
    this.closing = true;
    this.isDestroyed = true;
    await this._cleanupStorage();
    try {
      await this.ctx.storage.deleteAlarm();
    } catch(e) {}
    const webSockets = this._getActiveWebSockets();
    for (const ws of webSockets) {
      if (ws?.readyState === 1) {
        try { ws.send(JSON.stringify(["serverShutdown", "Server shutting down"])); } catch(e) {}
        try { ws.close(1000, "Shutdown"); } catch(e) {}
      }
    }
    this._userSeatDataCache = {};
  }
}

export default ChatServer;
