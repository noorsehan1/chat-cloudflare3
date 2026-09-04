// ==================== CHAT-SERVER-FULL.js ====================
// VERSION: 10.9.0 - FULL COMPATIBLE WITH ANDROID CLIENT

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
  // ============ CONSTRUCTOR ============
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ctx = state;
    this.closing = false;
    this.isDestroyed = false;
    this._startTime = Date.now();
    this._isRefreshing = false;
    this._isRestoring = false;
    this._isNumberUpdating = false;
    
    this._roomsDataCache = {};
    this._userSeatDataCache = {};
    this.currentNumber = 1;
    this._kursiNumber = {};
    
    this._restoreAllState().catch(() => {});
  }

  // ============ WEBSOCKET MANAGEMENT ============

  _getActiveWebSockets() {
    try {
      return this.ctx.getWebSockets();
    } catch(e) {
      return [];
    }
  }

  // ============ HELPER FUNCTIONS ============

  _getRoomCount(roomName) {
    try {
      const roomData = this._roomsDataCache[roomName];
      return roomData?.seats ? Object.keys(roomData.seats).length : 0;
    } catch(e) {
      return 0;
    }
  }

  _getOnlineUsers() {
    try {
      return Object.keys(this._userSeatDataCache);
    } catch(e) {
      return [];
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

  // ============ SINKRONISASI CACHE DAN STORAGE ============

  async _syncData(type, identifier1, identifier2, data) {
    try {
      switch(type) {
        case 'seat': {
          const roomName = identifier1;
          const seat = identifier2;
          
          if (!this._roomsDataCache[roomName]) {
            this._roomsDataCache[roomName] = { seats: {}, points: {}, muted: false };
          }
          this._roomsDataCache[roomName].seats[seat] = data;
          
          const key = `${roomName}_seat_${seat}`;
          await this.ctx.storage.put(key, data);
          break;
        }
        
        case 'point': {
          const roomName = identifier1;
          const seat = identifier2;
          
          if (!this._roomsDataCache[roomName]) {
            this._roomsDataCache[roomName] = { seats: {}, points: {}, muted: false };
          }
          if (!this._roomsDataCache[roomName].points) {
            this._roomsDataCache[roomName].points = {};
          }
          this._roomsDataCache[roomName].points[seat] = data;
          
          const key = `point_${roomName}_seat_${seat}`;
          await this.ctx.storage.put(key, data);
          break;
        }
        
        case 'kursiNumber': {
          const roomName = identifier1;
          const seat = identifier2;
          const number = data;
          
          const cacheKey = `${roomName}-${seat}`;
          this._kursiNumber[cacheKey] = number;
          
          const key = `kursiNumber_${roomName}_seat_${seat}`;
          await this.ctx.storage.put(key, number);
          break;
        }
        
        case 'user': {
          const username = identifier1;
          const seatInfo = identifier2;
          
          this._userSeatDataCache[username] = seatInfo;
          
          const key = `user_${username}`;
          await this.ctx.storage.put(key, seatInfo);
          break;
        }
        
        case 'muted': {
          const roomName = identifier1;
          const muted = identifier2;
          
          if (!this._roomsDataCache[roomName]) {
            this._roomsDataCache[roomName] = { seats: {}, points: {}, muted: false };
          }
          this._roomsDataCache[roomName].muted = muted;
          
          const key = `muted_${roomName}`;
          await this.ctx.storage.put(key, muted);
          break;
        }
      }
      return true;
    } catch(e) {
      return false;
    }
  }

  async _unsyncData(type, identifier1, identifier2) {
    try {
      switch(type) {
        case 'seat': {
          const roomName = identifier1;
          const seat = identifier2;
          
          if (this._roomsDataCache[roomName] && this._roomsDataCache[roomName].seats) {
            delete this._roomsDataCache[roomName].seats[seat];
          }
          
          const key = `${roomName}_seat_${seat}`;
          await this.ctx.storage.delete(key);
          break;
        }
        
        case 'point': {
          const roomName = identifier1;
          const seat = identifier2;
          
          if (this._roomsDataCache[roomName] && this._roomsDataCache[roomName].points) {
            delete this._roomsDataCache[roomName].points[seat];
          }
          
          const key = `point_${roomName}_seat_${seat}`;
          await this.ctx.storage.delete(key);
          break;
        }
        
        case 'kursiNumber': {
          const roomName = identifier1;
          const seat = identifier2;
          
          const cacheKey = `${roomName}-${seat}`;
          delete this._kursiNumber[cacheKey];
          
          const key = `kursiNumber_${roomName}_seat_${seat}`;
          await this.ctx.storage.delete(key);
          break;
        }
        
        case 'user': {
          const username = identifier1;
          
          delete this._userSeatDataCache[username];
          
          const key = `user_${username}`;
          await this.ctx.storage.delete(key);
          break;
        }
        
        case 'muted': {
          const roomName = identifier1;
          
          if (this._roomsDataCache[roomName]) {
            delete this._roomsDataCache[roomName].muted;
          }
          
          const key = `muted_${roomName}`;
          await this.ctx.storage.delete(key);
          break;
        }
      }
      return true;
    } catch(e) {
      return false;
    }
  }

  // ============ CORE: UPDATE CACHE + STORAGE ============

  async _saveToStorage(roomsData, userSeatData, currentNumber, kursiNumber) {
    try {
      const updates = {};
      if (roomsData !== undefined) {
        this._roomsDataCache = roomsData;
        updates.roomsData = roomsData;
      }
      if (userSeatData !== undefined) {
        this._userSeatDataCache = userSeatData;
        updates.userSeatData = userSeatData;
      }
      if (currentNumber !== undefined) {
        this.currentNumber = currentNumber;
        updates.currentNumber = currentNumber;
      }
      if (kursiNumber !== undefined) {
        this._kursiNumber = kursiNumber;
        updates.kursiNumber = kursiNumber;
      }
      
      if (Object.keys(updates).length > 0) {
        await this.ctx.storage.put(updates);
      }
      return true;
      
    } catch(e) {
      try {
        const storage = await this.ctx.storage.get(["roomsData", "userSeatData", "currentNumber", "kursiNumber"]);
        if (storage.roomsData !== undefined) this._roomsDataCache = storage.roomsData;
        if (storage.userSeatData !== undefined) this._userSeatDataCache = storage.userSeatData;
        if (storage.currentNumber !== undefined) this.currentNumber = storage.currentNumber;
        if (storage.kursiNumber !== undefined) this._kursiNumber = storage.kursiNumber;
      } catch(err) {}
      return false;
    }
  }

  // ============ USER COUNT MANAGEMENT ============

  async _updateUserCounts() {
    try {
      const counts = {};
      let totalUsers = 0;
      
      for (const room of ROOMS) {
        const count = this._getRoomCount(room);
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

  // ============ STORAGE OPERATIONS ============

  async _loadFromStorage() {
    try {
      if (Object.keys(this._roomsDataCache).length === 0 && 
          Object.keys(this._userSeatDataCache).length === 0) {
        const roomsData = await this.ctx.storage.get("roomsData") || {};
        const userSeatData = await this.ctx.storage.get("userSeatData") || {};
        const currentNumber = await this.ctx.storage.get("currentNumber") || 1;
        const kursiNumber = await this.ctx.storage.get("kursiNumber") || {};
        
        this._roomsDataCache = roomsData;
        this._userSeatDataCache = userSeatData;
        this.currentNumber = currentNumber;
        this._kursiNumber = kursiNumber;
      }
      
      return {
        roomsData: this._roomsDataCache,
        userSeatData: this._userSeatDataCache,
        currentNumber: this.currentNumber,
        kursiNumber: this._kursiNumber
      };
    } catch(e) {
      return { 
        roomsData: {}, 
        userSeatData: {}, 
        currentNumber: 1,
        kursiNumber: {}
      };
    }
  }

  // ============ USER MANAGEMENT ============

  _isUsernameExists(username) {
    try {
      if (!username) return false;
      return this._userSeatDataCache.hasOwnProperty(username);
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
      
      await this._syncData('user', username, null, seatInfo);
      
      await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      
      return true;
    } catch(e) {
      return false;
    }
  }

  async _removeUserFromAllRooms(username) {
    if (!username) return false;
    
    let removed = false;
    
    try {
      const roomsToRemove = [];
      
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        if (!roomData || !roomData.seats) continue;
        
        let seatToRemove = null;
        for (const [seat, data] of Object.entries(roomData.seats)) {
          if (data && data.namauser === username) {
            seatToRemove = parseInt(seat);
            break;
          }
        }
        
        if (seatToRemove !== null) {
          roomsToRemove.push({ roomName, seat: seatToRemove });
        }
      }
      
      for (const { roomName, seat } of roomsToRemove) {
        await this._unsyncData('seat', roomName, seat);
        await this._unsyncData('kursiNumber', roomName, seat);
        await this._unsyncData('point', roomName, seat);
        
        removed = true;
        
        this.broadcast(roomName, ["removeKursi", roomName, seat]);
        await this.updateRoomCount(roomName);
        await this._deleteRoomIfEmpty(roomName);
      }
      
      if (this._userSeatDataCache[username]) {
        await this._unsyncData('user', username, null);
        removed = true;
      }
      
      if (removed) {
        await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
        await this._updateUserCounts();
      }
      
      return removed;
    } catch(e) {
      return removed;
    }
  }

  async _forceCleanupMultiUser(username) {
    if (!username) return false;
    
    try {
      const roomsToClean = [];
      
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        if (!roomData || !roomData.seats) continue;
        
        for (const [seat, data] of Object.entries(roomData.seats)) {
          if (data && data.namauser === username) {
            roomsToClean.push({ roomName, seat: parseInt(seat) });
          }
        }
      }
      
      for (const { roomName, seat } of roomsToClean) {
        await this._unsyncData('seat', roomName, seat);
        await this._unsyncData('kursiNumber', roomName, seat);
        await this._unsyncData('point', roomName, seat);
        
        this.broadcast(roomName, ["removeKursi", roomName, seat]);
        await this.updateRoomCount(roomName);
        await this._deleteRoomIfEmpty(roomName);
      }
      
      if (this._userSeatDataCache[username]) {
        await this._unsyncData('user', username, null);
      }
      
      await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      await this._updateUserCounts();
      
      return true;
    } catch(e) {
      return false;
    }
  }

  async _isUserInAnyRoom(username) {
    if (!username) return null;
    
    try {
      const seatInfo = this._userSeatDataCache[username];
      if (seatInfo && seatInfo.room) {
        const roomData = this._roomsDataCache[seatInfo.room];
        if (roomData && roomData.seats) {
          for (const [seat, data] of Object.entries(roomData.seats)) {
            if (data && data.namauser === username) {
              return { 
                room: seatInfo.room, 
                seat: parseInt(seat), 
                isMulti: seatInfo.isMulti || false 
              };
            }
          }
        }
        
        const webSockets = this._getActiveWebSockets();
        let hasWS = false;
        for (const ws of webSockets) {
          try {
            const uname = ws._cachedUsername || ws.username || ws.deserializeAttachment()?.username;
            if (uname === username && ws.readyState === 1) {
              hasWS = true;
              break;
            }
          } catch(e) {}
        }
        
        if (!hasWS && !seatInfo.isMulti) {
          await this._unsyncData('user', username, null);
          await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
        }
      }
      
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        if (!roomData || !roomData.seats) continue;
        for (const [seat, data] of Object.entries(roomData.seats)) {
          if (data && data.namauser === username) {
            const isMulti = this._userSeatDataCache[username]?.isMulti || false;
            const seatInfo = { 
              room: roomName, 
              seat: parseInt(seat), 
              isMulti: isMulti
            };
            await this._syncData('user', username, null, seatInfo);
            await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
            return { room: roomName, seat: parseInt(seat), isMulti: isMulti };
          }
        }
      }
      
      return null;
    } catch(e) {
      return null;
    }
  }

  async _removeUserFromRoom(username, roomName) {
    if (!username || !roomName) return false;
    
    try {
      const roomData = this._roomsDataCache[roomName];
      if (!roomData || !roomData.seats) return false;
      
      let seat = null;
      for (const [s, data] of Object.entries(roomData.seats)) {
        if (data && data.namauser === username) {
          seat = parseInt(s);
          break;
        }
      }
      
      if (!seat) return false;
      
      await this._unsyncData('seat', roomName, seat);
      await this._unsyncData('kursiNumber', roomName, seat);
      await this._unsyncData('point', roomName, seat);
      await this._unsyncData('user', username, null);
      
      await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      await this._updateUserCounts();
      
      this.broadcast(roomName, ["removeKursi", roomName, seat]);
      await this.updateRoomCount(roomName);
      await this._deleteRoomIfEmpty(roomName);
      
      return true;
    } catch(e) {
      return false;
    }
  }

  // ============ UPDATE KURSI ============

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
      
      await this._syncData('seat', roomName, seat, seatData);
      await this._syncData('kursiNumber', roomName, seat, data.number || 0);
      
      return true;
    } catch(e) {
      return false;
    }
  }

  async _updatePoint(roomName, seat, x, y, fast) {
    try {
      const pointData = { x: x || 0, y: y || 0, fast: !!fast };
      await this._syncData('point', roomName, seat, pointData);
      
      return true;
    } catch(e) {
      return false;
    }
  }

  async _deleteUserSeat(username) {
    try {
      await this._unsyncData('user', username, null);
      await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      await this._updateUserCounts();
      return true;
    } catch(e) {
      return false;
    }
  }

  async _deleteRoomIfEmpty(roomName) {
    try {
      const roomData = this._roomsDataCache[roomName];
      if (!roomData) return;
      
      const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
      const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
      
      if (!hasSeats && !hasPoints) {
        const keys = await this.ctx.storage.list({ prefix: `kursiNumber_${roomName}_seat_` });
        for (const key of keys) {
          const parts = key.split('_');
          const seat = parseInt(parts[3]);
          await this._unsyncData('kursiNumber', roomName, seat);
        }
        
        await this._unsyncData('muted', roomName, null);
        
        delete this._roomsDataCache[roomName];
        await this._updateUserCounts();
      }
    } catch(e) {}
  }

  // ============ JOIN HANDLING ============

  async _handleJoin(ws, roomName) {
    if (!ws || !ws.username || !roomName || !ROOMS_SET.has(roomName) || this.closing || this.isDestroyed) {
      return false;
    }
    
    const username = ws.username;
    
    try {
      await this._removeUserFromAllRooms(username);
      
      if (this._userSeatDataCache[username]) {
        await this._unsyncData('user', username, null);
      }
      
      ws._isMulti = false;
      ws._multiRoom = null;
      ws._multiSeat = null;
      
      let roomData = this._roomsDataCache[roomName];
      if (!roomData) {
        roomData = { seats: {}, points: {}, muted: false, number: 1 };
        this._roomsDataCache[roomName] = roomData;
      }
      
      let seat = null;
      if (Object.keys(roomData.seats).length >= C.MAX_SEATS) {
        this.safeSend(ws, ["roomFull", roomName]);
        return false;
      }
      
      for (let s = 1; s <= C.MAX_SEATS; s++) {
        if (!roomData.seats[s]) {
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
        namauser: "",
        color: "",
        itembawah: 0,
        itematas: 0,
        vip: 0,
        viptanda: 0
      };
      await this._syncData('seat', roomName, seat, emptySeatData);
      await this._unsyncData('kursiNumber', roomName, seat);
      await this._syncData('kursiNumber', roomName, seat, seat);
      await this._unsyncData('point', roomName, seat);
      
      const seatInfo = {
        room: roomName,
        seat: seat,
        isMulti: false,
        multiRoom: null,
        multiSeat: null
      };
      await this._syncData('user', username, null, seatInfo);
      
      await this._updateWebSocketRoom(ws, roomName, username, seat, false);
      
      this.safeSend(ws, ["rooMasuk", seat, roomName]);
      this.safeSend(ws, ["numberKursiSaya", seat]);
      this.safeSend(ws, ["muteTypeResponse", roomData.muted || false, roomName]);
      
      const count = Object.keys(roomData.seats).length;
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
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        if (!roomData || !roomData.seats) continue;
        for (const [seat, data] of Object.entries(roomData.seats)) {
          if (data && data.namauser === username) {
            hasSeat = true;
            break;
          }
        }
        if (hasSeat) break;
      }
      
      if (isMulti && hasSeat) {
        await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
        return;
      }
      
      if (!hasSeat) {
        await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
        
        if (this._userSeatDataCache[username]) {
          await this._unsyncData('user', username, null);
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
      const count = this._getRoomCount(room);
      
      const counts = {};
      for (const r of ROOMS) {
        counts[r] = this._getRoomCount(r);
      }
      await this.ctx.storage.put("userCounts", counts);
      
      this.broadcast(room, ["roomUserCount", room, count]);
      return count;
    } catch(e) { return 0; }
  }

  async sendAllStateTo(ws, room, excludeSelf = false) {
    if (!ws || !ws.username) return;
    try {
      if (ws.readyState !== 1 || ws._closing) return;
    } catch(e) { return; }
    
    try {
      const roomData = this._roomsDataCache[room];
      if (!roomData) return;
      
      const allSeats = roomData.seats || {};
      const allPoints = roomData.points || {};
      
      const userSeat = this._userSeatDataCache[ws.username];
      const selfSeat = userSeat?.seat;
      
      const count = Object.keys(allSeats).length;
      this.safeSend(ws, ["roomUserCount", room, count]);
      
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

  // ============ UPDATE NUMBER ============

  async _updateNumber() {
    if (this._isNumberUpdating || this.closing || this.isDestroyed) return;
    this._isNumberUpdating = true;
    try {
      this.currentNumber = this.currentNumber < C.MAX_NUMBER ? this.currentNumber + 1 : 1;
      
      await this._saveToStorage(undefined, undefined, this.currentNumber, undefined);
      
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
      
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        if (!roomData || !roomData.seats) continue;
        for (const [seat, data] of Object.entries(roomData.seats)) {
          if (data && data.namauser) {
            usersWithSeats.add(data.namauser);
          }
        }
      }
      
      let changed = false;
      
      for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
        if (seatInfo.isMulti) {
          const roomData = this._roomsDataCache[seatInfo.room];
          if (roomData && roomData.seats) {
            let found = false;
            for (const [seat, data] of Object.entries(roomData.seats)) {
              if (data && data.namauser === username) {
                found = true;
                break;
              }
            }
            
            if (!found) {
              await this._unsyncData('user', username, null);
              changed = true;
            }
          }
        }
      }
      
      for (const username of usersWithSeats) {
        if (!this._userSeatDataCache[username]) {
          for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
            if (!roomData || !roomData.seats) continue;
            for (const [seat, data] of Object.entries(roomData.seats)) {
              if (data && data.namauser === username) {
                const seatInfo = {
                  room: roomName,
                  seat: parseInt(seat),
                  isMulti: true,
                  multiRoom: roomName,
                  multiSeat: parseInt(seat)
                };
                await this._syncData('user', username, null, seatInfo);
                changed = true;
                break;
              }
            }
            if (this._userSeatDataCache[username]) break;
          }
        }
      }
      
      for (const username of connectedUsers) {
        const seatInfo = this._userSeatDataCache[username];
        if (seatInfo && !seatInfo.isMulti && !usersWithSeats.has(username)) {
          await this._unsyncData('user', username, null);
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

  async _cleanupStorage() {
    try {
      const storage = await this._loadFromStorage();
      const roomsData = storage.roomsData || {};
      const userSeatData = storage.userSeatData || {};
      const kursiNumber = storage.kursiNumber || {};
      
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
      
      for (const [roomName, roomData] of Object.entries(roomsData)) {
        if (!roomData || !roomData.seats) continue;
        for (const [seat, data] of Object.entries(roomData.seats)) {
          if (data && data.namauser) {
            usersWithSeats.add(data.namauser);
          }
        }
      }
      
      for (const [username, seatInfo] of Object.entries(userSeatData)) {
        if (!seatInfo || !seatInfo.room) {
          await this._unsyncData('user', username, null);
          changed = true;
          continue;
        }
        
        if (!usersWithSeats.has(username)) {
          if (!seatInfo.isMulti) {
            await this._unsyncData('user', username, null);
            changed = true;
          } else if (!connectedUsers.has(username)) {
            await this._unsyncData('user', username, null);
            changed = true;
          }
        } else {
          if (!seatInfo.isMulti) {
            seatInfo.isMulti = true;
            await this._syncData('user', username, null, seatInfo);
            changed = true;
          }
        }
      }
      
      for (const key of Object.keys(kursiNumber)) {
        const [roomName, seat] = key.split('-');
        if (!roomsData[roomName] || !roomsData[roomName].seats || !roomsData[roomName].seats[parseInt(seat)]) {
          await this._unsyncData('kursiNumber', roomName, parseInt(seat));
          changed = true;
        }
      }
      
      for (const [roomName, roomData] of Object.entries(roomsData)) {
        const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
        const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
        
        if (!hasSeats && !hasPoints) {
          delete roomsData[roomName];
          changed = true;
        }
      }
      
      if (changed) {
        await this._saveToStorage(roomsData, userSeatData, storage.currentNumber, kursiNumber);
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
      await this._removeUserFromAllRooms(username);
      
      if (this._userSeatDataCache[username]) {
        await this._unsyncData('user', username, null);
      }
      
      await this._saveToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber,
        this._kursiNumber
      );
      await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      
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
        // ============ CHAT EVENTS ============
        
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
                this._userSeatDataCache[username] = {
                  ...currentSeat,
                  _lastSeen: Date.now(),
                  _wsId: ws._wsId || null
                };
                await this._syncData('user', username, null, this._userSeatDataCache[username]);
                await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
              }
            } catch(e) {}
            return;
          }
          
          if (username) {
            await this._removeUserFromAllRooms(username);
          }
          
          await this._handleSetId(ws, username, isNewUser);
          break;
        }
        
        case "isInRoom": {
          const userSeat = this._userSeatDataCache[ws.username];
          const isInRoom = userSeat && userSeat.room ? true : false;
          this.safeSend(ws, ["inRoomStatus", isInRoom]);
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
          
          await this._forceCleanupMultiUser(multiUsername);
          
          ws._isMulti = true;
          ws._multiRoom = multiRoomname;
          ws._multiSeat = null;
          
          let roomData = this._roomsDataCache[multiRoomname];
          if (!roomData) {
            roomData = { seats: {}, points: {}, muted: false, number: 1 };
            this._roomsDataCache[multiRoomname] = roomData;
          }
          
          let seat = null;
          
          const seatCount = Object.keys(roomData.seats).length;
          if (seatCount >= C.MAX_SEATS) {
            this.safeSend(ws, ["multiJoinError", "Room penuh"]);
            break;
          }
          
          for (let s = 1; s <= C.MAX_SEATS; s++) {
            if (!roomData.seats[s]) {
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
            namauser: "",
            color: "",
            itembawah: 0,
            itematas: 0,
            vip: 0,
            viptanda: 0
          };
          await this._syncData('seat', multiRoomname, seat, emptySeatData);
          await this._unsyncData('kursiNumber', multiRoomname, seat);
          await this._syncData('kursiNumber', multiRoomname, seat, seat);
          await this._unsyncData('point', multiRoomname, seat);
          
          const seatInfo = {
            room: multiRoomname,
            seat: seat,
            isMulti: true,
            multiRoom: multiRoomname,
            multiSeat: seat
          };
          await this._syncData('user', multiUsername, null, seatInfo);
          
          await this._updateWebSocketRoom(ws, multiRoomname, multiUsername, seat, true);
          
          const webSockets = this._getActiveWebSockets();
          for (const wsKey of webSockets) {
            if (wsKey === ws) continue;
            try {
              const uname = wsKey._cachedUsername || 
                            wsKey.username || 
                            wsKey.deserializeAttachment()?.username;
              if (uname === multiUsername && wsKey.readyState === 1) {
                await this._updateWebSocketRoom(wsKey, multiRoomname, multiUsername, seat, true);
              }
            } catch(e) {}
          }
          
          this.safeSend(ws, ["rooMasukMulti", seat, multiRoomname]);
          this.broadcast(multiRoomname, ["roomUserCount", multiRoomname, Object.keys(roomData.seats).length]);
          
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
            for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
              if (!roomData || !roomData.seats) continue;
              for (const [seat, data] of Object.entries(roomData.seats)) {
                if (data && data.namauser === targetUsername) {
                  userSeat = { 
                    room: roomName, 
                    seat: parseInt(seat), 
                    isMulti: true 
                  };
                  break;
                }
              }
              if (userSeat) break;
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
          await this._syncData('user', targetUsername, null, seatInfo);
          
          const webSockets = this._getActiveWebSockets();
          let foundAny = false;
          
          for (const wsKey of webSockets) {
            try {
              const uname = wsKey._cachedUsername || 
                            wsKey.username || 
                            wsKey.deserializeAttachment()?.username;
              
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
            await this._forceCleanupMultiUser(targetUsername);
            
            const webSockets = this._getActiveWebSockets();
            for (const wsKey of webSockets) {
              try {
                const uname = wsKey._cachedUsername || 
                              wsKey.username || 
                              wsKey.deserializeAttachment()?.username;
                if (uname === targetUsername) {
                  wsKey._isMulti = false;
                  wsKey._multiRoom = null;
                  wsKey._multiSeat = null;
                  wsKey._cachedRoom = null;
                  wsKey._cachedSeat = null;
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
        
        case "forceCleanupMulti": {
          const targetUsername = args[0];
          
          if (!targetUsername) {
            this.safeSend(ws, ["forceCleanupError", "Username tidak boleh kosong"]);
            break;
          }
          
          try {
            const result = await this._forceCleanupMultiUser(targetUsername);
            this.safeSend(ws, ["forceCleanupResult", targetUsername, result]);
          } catch(e) {
            this.safeSend(ws, ["forceCleanupError", e.message]);
          }
          break;
        }
        
        case "updateKursi": {
          const [kursiRoom, kursiSeat, kursiNoimg, kursiName, kursiColor, kursiBawah, kursiAtas, kursiVip, kursiVt] = args;
          
          const updated = await this._updateKursi(kursiRoom, kursiSeat, {
            noimageUrl: kursiNoimg || "",
            namauser: kursiName || "",
            color: kursiColor || "",
            itembawah: kursiBawah || 0,
            itematas: kursiAtas || 0,
            vip: kursiVip || 0,
            viptanda: kursiVt || 0,
            number: kursiSeat
          });
          
          if (updated) {
            const roomData = this._roomsDataCache[kursiRoom];
            const updatedSeat = roomData?.seats?.[kursiSeat];
            if (updatedSeat) {
              this.broadcast(kursiRoom, ["kursiBatchUpdate", kursiRoom, [[kursiSeat, updatedSeat]]]);
            }
          }
          break;
        }
        
        case "chat": {
          const [chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor] = args;
          if (!chatMsg || !ROOMS_SET.has(chatRoom)) break;
          
          const userSeat = this._userSeatDataCache[chatUser];
          if (!userSeat || userSeat.room !== chatRoom) {
            break;
          }
          
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
          
          const roomData = this._roomsDataCache[removeRoom];
          let username = null;
          if (roomData && roomData.seats && roomData.seats[removeSeat]) {
            username = roomData.seats[removeSeat].namauser;
          }
          
          if (username) {
            await this._removeUserFromAllRooms(username);
          }
          break;
        }
        
        case "resetRoom": {
          const resetRoomName = args[0];
          if (resetRoomName && ROOMS_SET.has(resetRoomName)) {
            const roomData = this._roomsDataCache[resetRoomName];
            if (roomData) {
              const seats = Object.keys(roomData.seats);
              for (const seat of seats) {
                await this._unsyncData('seat', resetRoomName, parseInt(seat));
                await this._unsyncData('kursiNumber', resetRoomName, parseInt(seat));
                await this._unsyncData('point', resetRoomName, parseInt(seat));
              }
              delete this._roomsDataCache[resetRoomName];
              await this._updateUserCounts();
            }
            this.broadcast(resetRoomName, ["resetRoom", resetRoomName]);
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
                  const uname = wsKey._cachedUsername || 
                                wsKey.username || 
                                wsKey.deserializeAttachment()?.username;
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
                  const uname = wsKey._cachedUsername || 
                                wsKey.username || 
                                wsKey.deserializeAttachment()?.username;
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
          try {
            const counts = {};
            for (const room of ROOMS) {
              counts[room] = this._getRoomCount(room);
            }
            
            // Format untuk client Java: array of objects dengan roomName dan userCount
            const result = Object.entries(counts).map(([roomName, userCount]) => ({ 
              roomName: roomName,
              userCount: userCount 
            }));
            
            // Kirim sebagai JSON string
            this.safeSend(ws, ["allRoomsUserCount", JSON.stringify(result)]);
          } catch(e) {
            this.safeSend(ws, ["allRoomsUserCount", "[]"]);
          }
          break;
        }
        
        case "getRoomUserCount": {
          const roomName = args[0];
          if (roomName && ROOMS_SET.has(roomName)) {
            const count = this._getRoomCount(roomName);
            this.safeSend(ws, ["roomUserCount", roomName, count]);
          } else {
            this.safeSend(ws, ["roomUserCount", roomName || "", 0]);
          }
          break;
        }
        
        case "setMuteType": {
          const [muteVal, muteRoom] = args;
          if (!muteRoom || !ROOMS_SET.has(muteRoom)) break;
          
          const roomData = this._roomsDataCache[muteRoom];
          if (roomData) {
            roomData.muted = !!muteVal;
            await this._syncData('muted', muteRoom, null, !!muteVal);
          }
          
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
            const roomData = this._roomsDataCache[getMuteRoom];
            this.safeSend(ws, ["muteTypeResponse", roomData?.muted || false, getMuteRoom]);
          }
          break;
        }
        
        case "onDestroy": {
          const username = ws.username || ws._cachedUsername;
          if (username) {
            await this._removeUserFromAllRooms(username);
          }
          break;
        }
        
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
      const keys = await this.ctx.storage.list({ prefix: "" });
      
      this._roomsDataCache = {};
      this._userSeatDataCache = {};
      this._kursiNumber = {};
      
      for (const key of keys) {
        const value = await this.ctx.storage.get(key);
        
        if (key.includes("_seat_") && !key.startsWith("kursiNumber_") && !key.startsWith("point_") && !key.startsWith("user_") && !key.startsWith("muted_")) {
          const parts = key.split('_seat_');
          const roomName = parts[0];
          const seat = parseInt(parts[1]);
          
          if (!this._roomsDataCache[roomName]) {
            this._roomsDataCache[roomName] = { seats: {}, points: {}, muted: false };
          }
          this._roomsDataCache[roomName].seats[seat] = value;
        } else if (key.startsWith("point_")) {
          const parts = key.split('_');
          const roomName = parts[1];
          const seat = parseInt(parts[3]);
          
          if (!this._roomsDataCache[roomName]) {
            this._roomsDataCache[roomName] = { seats: {}, points: {}, muted: false };
          }
          if (!this._roomsDataCache[roomName].points) {
            this._roomsDataCache[roomName].points = {};
          }
          this._roomsDataCache[roomName].points[seat] = value;
        } else if (key.startsWith("kursiNumber_")) {
          const parts = key.split('_');
          const roomName = parts[1];
          const seat = parseInt(parts[3]);
          this._kursiNumber[`${roomName}-${seat}`] = value;
        } else if (key.startsWith("user_")) {
          const username = key.replace("user_", "");
          this._userSeatDataCache[username] = value;
        } else if (key.startsWith("muted_")) {
          const roomName = key.replace("muted_", "");
          if (!this._roomsDataCache[roomName]) {
            this._roomsDataCache[roomName] = { seats: {}, points: {}, muted: false };
          }
          this._roomsDataCache[roomName].muted = value;
        }
      }
      
      const currentNumber = await this.ctx.storage.get("currentNumber") || 1;
      this.currentNumber = currentNumber;
      
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        if (!roomData || !roomData.seats) continue;
        
        for (const [seat, data] of Object.entries(roomData.seats)) {
          if (!data || !data.namauser) continue;
          
          const username = data.namauser;
          
          if (!this._userSeatDataCache[username]) {
            this._userSeatDataCache[username] = {
              room: roomName,
              seat: parseInt(seat),
              isMulti: true,
              multiRoom: roomName,
              multiSeat: parseInt(seat)
            };
            await this._syncData('user', username, null, this._userSeatDataCache[username]);
          }
        }
      }
      
      for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
        if (!seatInfo || !seatInfo.room) {
          await this._unsyncData('user', username, null);
          continue;
        }
        const roomData = this._roomsDataCache[seatInfo.room];
        if (!roomData || !roomData.seats || !roomData.seats[seatInfo.seat]) {
          await this._unsyncData('user', username, null);
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
      
      await this._updateUserCounts();
      
      await this._saveToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber,
        this._kursiNumber
      );
      await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      
      if (!this.closing && !this.isDestroyed) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        if (!existingAlarm) {
          this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        }
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
      const keys = await this.ctx.storage.list({ prefix: "" });
      for (const key of keys) {
        await this.ctx.storage.delete(key);
      }
      
      this._roomsDataCache = {};
      this._userSeatDataCache = {};
      this.currentNumber = 1;
      this._kursiNumber = {};
      
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
          status.rooms[room] = this._getRoomCount(room);
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
    
    this._roomsDataCache = {};
    this._userSeatDataCache = {};
    this._kursiNumber = {};
  }
}

export default ChatServer;
