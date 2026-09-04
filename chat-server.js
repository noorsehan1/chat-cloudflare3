// ==================== CHAT-SERVER-FULL.js ====================
// VERSION: 10.6.9 - STORAGE PER KURSI (SEPERTI FIREBASE)

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
      if (!roomData || !roomData.seats) return 0;
      
      let count = 0;
      for (const [seat, data] of Object.entries(roomData.seats)) {
        if (data && data.namauser && data.namauser !== "") {
          count++;
        }
      }
      return count;
    } catch(e) {
      return 0;
    }
  }

  _getAllRoomsCount() {
    try {
      const counts = {};
      let total = 0;
      
      for (const room of ROOMS) {
        const count = this._getRoomCount(room);
        counts[room] = count;
        total += count;
      }
      
      return { counts, total };
    } catch(e) {
      return { counts: {}, total: 0 };
    }
  }

  _getOnlineUsers() {
    try {
      return Object.keys(this._userSeatDataCache);
    } catch(e) {
      return [];
    }
  }

  _getOnlineUsersWithDetails() {
    try {
      const users = [];
      for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
        if (seatInfo && seatInfo.room) {
          users.push({
            username: username,
            room: seatInfo.room,
            seat: seatInfo.seat,
            isMulti: seatInfo.isMulti || false
          });
        }
      }
      return users;
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

  // ============ CRUD PER KURSI (SEPERTI FIREBASE) ============

  // === CREATE / UPDATE (REPLACE) ===

  async _setSeatData(roomName, seat, data) {
    try {
      const key = `room_${roomName}_seat_${seat}`;
      await this.ctx.storage.put(key, data);
      
      if (!this._roomsDataCache[roomName]) {
        this._roomsDataCache[roomName] = { seats: {}, points: {}, muted: false };
      }
      this._roomsDataCache[roomName].seats[seat] = data;
      
      return true;
    } catch(e) {
      console.error(`Error saving seat data:`, e);
      return false;
    }
  }

  async _setKursiNumber(roomName, seat, number) {
    try {
      const key = `kursiNumber_${roomName}_seat_${seat}`;
      await this.ctx.storage.put(key, number);
      
      const cacheKey = `${roomName}-${seat}`;
      this._kursiNumber[cacheKey] = number;
      
      return true;
    } catch(e) {
      console.error(`Error saving kursiNumber:`, e);
      return false;
    }
  }

  async _setPointData(roomName, seat, pointData) {
    try {
      const key = `point_${roomName}_seat_${seat}`;
      await this.ctx.storage.put(key, pointData);
      
      if (!this._roomsDataCache[roomName]) {
        this._roomsDataCache[roomName] = { seats: {}, points: {}, muted: false };
      }
      if (!this._roomsDataCache[roomName].points) {
        this._roomsDataCache[roomName].points = {};
      }
      this._roomsDataCache[roomName].points[seat] = pointData;
      
      return true;
    } catch(e) {
      console.error(`Error saving point:`, e);
      return false;
    }
  }

  async _setUserData(username, seatInfo) {
    try {
      const key = `user_${username}`;
      await this.ctx.storage.put(key, seatInfo);
      
      this._userSeatDataCache[username] = seatInfo;
      
      return true;
    } catch(e) {
      console.error(`Error saving user data:`, e);
      return false;
    }
  }

  // === DELETE (HAPUS KEY LANGSUNG) ===

  async _deleteSeatData(roomName, seat) {
    try {
      const key = `room_${roomName}_seat_${seat}`;
      await this.ctx.storage.delete(key);
      
      if (this._roomsDataCache[roomName] && this._roomsDataCache[roomName].seats) {
        delete this._roomsDataCache[roomName].seats[seat];
      }
      
      return true;
    } catch(e) {
      console.error(`Error deleting seat data:`, e);
      return false;
    }
  }

  async _deleteKursiNumber(roomName, seat) {
    try {
      const key = `kursiNumber_${roomName}_seat_${seat}`;
      await this.ctx.storage.delete(key);
      
      const cacheKey = `${roomName}-${seat}`;
      delete this._kursiNumber[cacheKey];
      
      return true;
    } catch(e) {
      console.error(`Error deleting kursiNumber:`, e);
      return false;
    }
  }

  async _deletePointData(roomName, seat) {
    try {
      const key = `point_${roomName}_seat_${seat}`;
      await this.ctx.storage.delete(key);
      
      if (this._roomsDataCache[roomName] && this._roomsDataCache[roomName].points) {
        delete this._roomsDataCache[roomName].points[seat];
      }
      
      return true;
    } catch(e) {
      console.error(`Error deleting point:`, e);
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
      console.error(`Error deleting user data:`, e);
      return false;
    }
  }

  // ============ ONLINE USERS MANAGEMENT ============

  async _getOnlineUsersFromStorage() {
    try {
      const onlineUsers = await this.ctx.storage.get("onlineUsers") || [];
      return onlineUsers;
    } catch(e) {
      return [];
    }
  }

  async _addUserToOnline(username) {
    try {
      let onlineUsers = await this._getOnlineUsersFromStorage();
      if (!onlineUsers.includes(username)) {
        onlineUsers.push(username);
        await this.ctx.storage.put("onlineUsers", onlineUsers);
      }
      return onlineUsers;
    } catch(e) {
      return [];
    }
  }

  async _removeUserFromOnline(username) {
    try {
      let onlineUsers = await this._getOnlineUsersFromStorage();
      onlineUsers = onlineUsers.filter(u => u !== username);
      await this.ctx.storage.put("onlineUsers", onlineUsers);
      return onlineUsers;
    } catch(e) {
      return [];
    }
  }

  async _isUserOnlineStorage(username) {
    try {
      const onlineUsers = await this._getOnlineUsersFromStorage();
      return onlineUsers.includes(username);
    } catch(e) {
      return false;
    }
  }

  // ============ USER COUNTS MANAGEMENT ============

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
        totalUsers: totalUsers
      });
      
      for (const room of ROOMS) {
        this.broadcast(room, ["roomUserCount", room, counts[room]]);
      }
      
      const countsArray = Object.entries(counts);
      this.broadcast(ROOMS[0], ["allRoomsUserCount", countsArray]);
      
      return { counts, total: totalUsers };
    } catch(e) {
      console.error("Error updating user counts:", e);
      return { counts: {}, total: 0 };
    }
  }

  async updateRoomCount(room) {
    if (this.closing || this.isDestroyed || !room) return 0;
    
    try {
      const count = this._getRoomCount(room);
      
      const userCounts = await this.ctx.storage.get("userCounts") || {};
      userCounts[room] = count;
      await this.ctx.storage.put("userCounts", userCounts);
      
      this.broadcast(room, ["roomUserCount", room, count]);
      
      return count;
    } catch(e) {
      console.error(`Error updating room count for ${room}:`, e);
      return 0;
    }
  }

  async _deleteRoomIfEmpty(roomName) {
    try {
      const roomData = this._roomsDataCache[roomName];
      if (!roomData) return;
      
      const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
      const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
      
      if (!hasSeats && !hasPoints) {
        // Hapus semua kursiNumber di room ini
        for (const key of Object.keys(this._kursiNumber)) {
          if (key.startsWith(`${roomName}-`)) {
            delete this._kursiNumber[key];
          }
        }
        
        delete this._roomsDataCache[roomName];
        await this._updateUserCounts();
      }
    } catch(e) {
      console.error("Error deleting room if empty:", e);
    }
  }

  // ============ DELETE USER DATA TOTAL ============

  async _deleteUserDataTotal(username) {
    if (!username) return false;
    
    try {
      console.log(`🔄 Deleting all data for user: ${username}`);
      
      // 1. Cari dan hapus user dari semua room
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
          console.log(`📌 Found user in room ${roomName} seat ${seatToRemove}`);
          
          await this._deleteSeatData(roomName, seatToRemove);
          await this._deleteKursiNumber(roomName, seatToRemove);
          await this._deletePointData(roomName, seatToRemove);
          
          this.broadcast(roomName, ["removeKursi", roomName, seatToRemove]);
          await this.updateRoomCount(roomName);
          await this._deleteRoomIfEmpty(roomName);
        }
      }
      
      // 2. Hapus user data
      await this._deleteUserData(username);
      
      // 3. Hapus dari online users
      await this._removeUserFromOnline(username);
      
      // 4. Update all user counts
      await this._updateUserCounts();
      
      console.log(`✅ All data deleted for user: ${username}`);
      return true;
    } catch(e) {
      console.error(`Error deleting user data total:`, e);
      return false;
    }
  }

  // ============ UPDATE WEBSOCKET ROOM ============

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
      
      await this._setUserData(username, seatInfo);
      
      return true;
    } catch(e) {
      console.error("Error updating websocket room:", e);
      return false;
    }
  }

  // ============ JOIN HANDLING ============

  async _handleJoin(ws, roomName) {
    if (!ws || !ws.username || !roomName || !ROOMS_SET.has(roomName) || this.closing || this.isDestroyed) {
      return false;
    }
    
    const username = ws.username;
    console.log(`📥 User ${username} joining room: ${roomName}`);
    
    try {
      // 1. Hapus semua data user dari room lain
      await this._deleteUserDataTotal(username);
      
      // 2. Add user ke online users
      await this._addUserToOnline(username);
      
      let roomData = this._roomsDataCache[roomName];
      if (!roomData) {
        roomData = { seats: {}, points: {}, muted: false };
        this._roomsDataCache[roomName] = roomData;
      }
      
      // 3. Cari kursi kosong
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
      
      console.log(`🪑 Assigning seat ${seat} in room ${roomName} for user ${username}`);
      
      // 4. Simpan data per kursi
      const emptySeatData = {
        noimageUrl: "",
        namauser: "",
        color: "",
        itembawah: 0,
        itematas: 0,
        vip: 0,
        viptanda: 0
      };
      await this._setSeatData(roomName, seat, emptySeatData);
      await this._setKursiNumber(roomName, seat, seat);
      await this._deletePointData(roomName, seat);
      
      // 5. Simpan user data
      const seatInfo = {
        room: roomName,
        seat: seat,
        isMulti: false,
        multiRoom: null,
        multiSeat: null
      };
      await this._setUserData(username, seatInfo);
      
      // 6. Update websocket
      await this._updateWebSocketRoom(ws, roomName, username, seat, false);
      
      // 7. Kirim response ke client
      this.safeSend(ws, ["rooMasuk", seat, roomName]);
      this.safeSend(ws, ["numberKursiSaya", seat]);
      this.safeSend(ws, ["muteTypeResponse", roomData.muted || false, roomName]);
      
      // 8. Update room count
      const count = await this.updateRoomCount(roomName);
      this.safeSend(ws, ["roomUserCount", roomName, count]);
      
      // 9. Update all user counts
      await this._updateUserCounts();
      
      // 10. Kirim semua state ke user
      setTimeout(() => {
        try {
          if (ws && ws.readyState === 1) {
            this.sendAllStateTo(ws, roomName, true);
          }
        } catch(e) {}
      }, 1000);
      
      console.log(`✅ User ${username} joined room ${roomName} seat ${seat}`);
      return true;
    } catch(e) {
      console.error(`Error in _handleJoin:`, e);
      return false;
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
      
      await this._setSeatData(roomName, seat, seatData);
      
      if (data.number !== undefined) {
        await this._setKursiNumber(roomName, seat, data.number);
      }
      
      return true;
    } catch(e) {
      console.error(`Error updating kursi:`, e);
      return false;
    }
  }

  async _updatePoint(roomName, seat, x, y, fast) {
    try {
      const pointData = { x: x || 0, y: y || 0, fast: !!fast };
      await this._setPointData(roomName, seat, pointData);
      return true;
    } catch(e) {
      console.error(`Error updating point:`, e);
      return false;
    }
  }

  // ============ CLEANUP ON DISCONNECT ============

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
          delete this._userSeatDataCache[username];
        }
        return;
      }
      
      if (hasSeat && !isMulti) {
        await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      }
      
    } catch(e) {
      console.error("Error in _cleanupUserOnDisconnect:", e);
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

  // ============ SEND ALL STATE ============

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
      
      const allCounts = this._getAllRoomsCount();
      const countsArray = Object.entries(allCounts.counts);
      this.safeSend(ws, ["allRoomsUserCount", countsArray]);
      
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
    } catch(e) {
      console.error("Error sending all state:", e);
    }
  }

  // ============ SET ID ============

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
    } catch(e) {
      console.error("Error in _handleSetId:", e);
    }
  }

  // ============ ALARM - UPDATE NUMBER 1-6 ============

  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    try {
      await this._updateNumber();
      await this._checkMultiUsers();
      await this._cleanupStorage();
    } catch(e) {
      console.error("Error in alarm:", e);
    }
    
    if (!this.closing && !this.isDestroyed) {
      try {
        this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      } catch(e) {}
    }
  }

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
              delete this._userSeatDataCache[username];
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
                this._userSeatDataCache[username] = {
                  room: roomName,
                  seat: parseInt(seat),
                  isMulti: true,
                  multiRoom: roomName,
                  multiSeat: parseInt(seat)
                };
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
          delete this._userSeatDataCache[username];
          changed = true;
        } else if (!seatInfo && !usersWithSeats.has(username)) {
          changed = true;
        }
      }
      
      if (changed) {
        await this._updateUserCounts();
      }
      
    } catch(e) {
      console.error("Error in _checkMultiUsers:", e);
    }
  }

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
      
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        if (!roomData || !roomData.seats) continue;
        for (const [seat, data] of Object.entries(roomData.seats)) {
          if (data && data.namauser) {
            usersWithSeats.add(data.namauser);
          }
        }
      }
      
      for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
        if (!seatInfo || !seatInfo.room) {
          delete this._userSeatDataCache[username];
          changed = true;
          continue;
        }
        
        if (!usersWithSeats.has(username)) {
          if (!seatInfo.isMulti) {
            delete this._userSeatDataCache[username];
            changed = true;
          } else if (!connectedUsers.has(username)) {
            delete this._userSeatDataCache[username];
            changed = true;
          }
        }
      }
      
      for (const key of Object.keys(this._kursiNumber)) {
        const [roomName, seat] = key.split('-');
        if (!this._roomsDataCache[roomName] || !this._roomsDataCache[roomName].seats || !this._roomsDataCache[roomName].seats[parseInt(seat)]) {
          delete this._kursiNumber[key];
          changed = true;
        }
      }
      
      for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
        const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
        const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
        
        if (!hasSeats && !hasPoints) {
          delete this._roomsDataCache[roomName];
          changed = true;
        }
      }
      
      if (changed) {
        await this._updateUserCounts();
      }
      
    } catch(e) {
      console.error("Error in _cleanupStorage:", e);
    }
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
    } catch(e) {
      console.error("Error in webSocketMessage:", e);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    if (!ws) return;
    try {
      await this._cleanupUserOnDisconnect(ws);
    } catch(e) {
      console.error("Error in webSocketClose:", e);
    }
  }

  async webSocketError(ws, error) {
    if (!ws) return;
    try {
      await this._cleanupUserOnDisconnect(ws);
    } catch(e) {
      console.error("Error in webSocketError:", e);
    }
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
    } catch(e) {
      console.error("Error in handleMessage:", e);
    }
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
                this._userSeatDataCache[username] = {
                  ...currentSeat,
                  _lastSeen: Date.now(),
                  _wsId: ws._wsId || null
                };
                await this._updateUserCounts();
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
          await this._setSeatData(multiRoomname, seat, emptySeatData);
          await this._setKursiNumber(multiRoomname, seat, seat);
          await this._deletePointData(multiRoomname, seat);
          
          await this._addUserToOnline(multiUsername);
          
          const seatInfo = {
            room: multiRoomname,
            seat: seat,
            isMulti: true,
            multiRoom: multiRoomname,
            multiSeat: seat
          };
          await this._setUserData(multiUsername, seatInfo);
          
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
          await this.updateRoomCount(multiRoomname);
          await this._updateUserCounts();
          
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
          await this._setUserData(targetUsername, seatInfo);
          
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
            await this._deleteUserDataTotal(targetUsername);
            
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
          const onlineUsers = await this._getOnlineUsersFromStorage();
          this.safeSend(ws, ["allOnlineUsers", onlineUsers]);
          break;
        }
        
        case "getOnlineUsersDetails": {
          const userDetails = this._getOnlineUsersWithDetails();
          this.safeSend(ws, ["onlineUsersDetails", userDetails]);
          break;
        }
        
        case "getAllRoomsUserCount": {
          const counts = this._getAllRoomsCount();
          const countsArray = Object.entries(counts.counts);
          this.safeSend(ws, ["allRoomsUserCount", countsArray]);
          break;
        }
        
        case "getRoomUserCount": {
          const roomName = args[0];
          if (roomName && ROOMS_SET.has(roomName)) {
            const count = this._getRoomCount(roomName);
            this.safeSend(ws, ["roomUserCount", roomName, count]);
          }
          break;
        }
        
        case "getFullStatus": {
          const onlineUsers = await this._getOnlineUsersFromStorage();
          const counts = this._getAllRoomsCount();
          const userDetails = this._getOnlineUsersWithDetails();
          
          const status = {
            onlineUsers: onlineUsers,
            userDetails: userDetails,
            roomCounts: counts.counts,
            totalUsers: counts.total,
            timestamp: Date.now()
          };
          this.safeSend(ws, ["fullStatus", status]);
          break;
        }
        
        case "setMuteType": {
          const [muteVal, muteRoom] = args;
          if (!muteRoom || !ROOMS_SET.has(muteRoom)) break;
          
          const roomData = this._roomsDataCache[muteRoom];
          if (roomData) {
            roomData.muted = !!muteVal;
            await this.ctx.storage.put(`muted_${muteRoom}`, !!muteVal);
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
        
        case "onDestroy":
          break;
        
        default:
          this.safeSend(ws, ["error", `Unknown event: ${evt}`]);
          break;
      }
    } catch(e) {
      console.error("Error in _handleEventInternal:", e);
    }
  }

  // ============ RESTORE STATE ============

  async _restoreAllState() {
    if (this._isRestoring) return;
    this._isRestoring = true;
    
    try {
      const keys = await this.ctx.storage.list();
      
      this._roomsDataCache = {};
      this._userSeatDataCache = {};
      this._kursiNumber = {};
      let onlineUsers = [];
      let userCounts = {};
      
      for (const key of keys) {
        const value = await this.ctx.storage.get(key);
        
        if (key.startsWith("room_")) {
          const parts = key.split('_');
          if (parts.length >= 4) {
            const roomName = parts[1];
            const seat = parseInt(parts[3]);
            
            if (!this._roomsDataCache[roomName]) {
              this._roomsDataCache[roomName] = { seats: {}, points: {}, muted: false };
            }
            this._roomsDataCache[roomName].seats[seat] = value;
          }
        } else if (key.startsWith("point_")) {
          const parts = key.split('_');
          if (parts.length >= 4) {
            const roomName = parts[1];
            const seat = parseInt(parts[3]);
            
            if (!this._roomsDataCache[roomName]) {
              this._roomsDataCache[roomName] = { seats: {}, points: {}, muted: false };
            }
            if (!this._roomsDataCache[roomName].points) {
              this._roomsDataCache[roomName].points = {};
            }
            this._roomsDataCache[roomName].points[seat] = value;
          }
        } else if (key.startsWith("kursiNumber_")) {
          const parts = key.split('_');
          if (parts.length >= 4) {
            const roomName = parts[1];
            const seat = parseInt(parts[3]);
            const cacheKey = `${roomName}-${seat}`;
            this._kursiNumber[cacheKey] = value;
          }
        } else if (key.startsWith("user_")) {
          const username = key.replace("user_", "");
          this._userSeatDataCache[username] = value;
        } else if (key === "onlineUsers") {
          onlineUsers = value || [];
        } else if (key === "userCounts") {
          userCounts = value || {};
        } else if (key === "currentNumber") {
          this.currentNumber = value || 1;
        } else if (key.startsWith("muted_")) {
          const roomName = key.replace("muted_", "");
          if (this._roomsDataCache[roomName]) {
            this._roomsDataCache[roomName].muted = value;
          }
        }
      }
      
      // Sinkronkan onlineUsers dengan userSeatDataCache
      const cacheUsers = Object.keys(this._userSeatDataCache);
      if (onlineUsers.length !== cacheUsers.length) {
        await this.ctx.storage.put("onlineUsers", cacheUsers);
      }
      
      await this._updateUserCounts();
      
      console.log(`✅ Restored state: ${Object.keys(this._roomsDataCache).length} rooms, ${cacheUsers.length} users`);
      
    } catch(e) {
      console.error("Error in _restoreAllState:", e);
    } finally {
      this._isRestoring = false;
    }
  }

  // ============ RESET ALL DATA ============

  async resetAllData() {
    const timestamp = Date.now();
    
    try {
      this._roomsDataCache = {};
      this._userSeatDataCache = {};
      this.currentNumber = 1;
      this._kursiNumber = {};
      
      // Hapus semua data dari storage
      const keys = await this.ctx.storage.list();
      for (const key of keys) {
        await this.ctx.storage.delete(key);
      }
      
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
      await this.ctx.storage.put("currentNumber", 1);
      
      return {
        success: true,
        message: "Semua data berhasil direset",
        timestamp: timestamp,
        resetTime: new Date(timestamp).toLocaleString()
      };
      
    } catch(e) {
      console.error("Error resetting data:", e);
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
        const counts = this._getAllRoomsCount();
        const status = {
          activeConnections: webSockets.length,
          rooms: counts.counts,
          totalUsers: counts.total,
          currentNumber: this.currentNumber,
          isClosing: this.closing,
          isDestroyed: this.isDestroyed,
          uptime: Date.now() - this._startTime
        };
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
      console.error("Error in fetch:", e);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // ============ DESTROY ============

  async destroy() {
    if (this.isDestroyed) return;
    this.closing = true;
    this.isDestroyed = true;
    
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
    
    console.log("✅ Server destroyed");
  }
}

export default ChatServer;
