// ==================== CHAT-SERVER-HIBERNATION-NO-PING.JS ====================
// VERSION: 9.3.15 - AUTO VERSION WITH TIMESTAMP
// DEPLOY: 2026-09-02 14:30:00 UTC

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

// ============================================================
// AUTO VERSION GENERATOR
// ============================================================
const DEPLOY_VERSION = {
  version: "9.3.15",
  timestamp: Date.now(),
  deployDate: new Date().toISOString(),
  buildId: Math.random().toString(36).substring(2, 8).toUpperCase(),
  environment: process.env.ENVIRONMENT || "production"
};

// GENERATE UNIQUE VERSION PER DEPLOY
const SERVER_VERSION = `v${DEPLOY_VERSION.version}-${DEPLOY_VERSION.buildId}-${DEPLOY_VERSION.timestamp}`;

export class ChatServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ctx = state;
    this.closing = false;
    this.isDestroyed = false;
    this._startTime = Date.now();
    
    // VERSION INFO
    this._version = SERVER_VERSION;
    this._deployInfo = DEPLOY_VERSION;
    this._deployTime = new Date().toISOString();
    
    this.roomClients = new Map();
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    this._roomsDataCache = {};
    this._userSeatDataCache = {};
    this.currentNumber = 1;
    
    this._onlineUsers = new Set();
    this._userCounts = {};
    for (const room of ROOMS) {
      this._userCounts[room] = 0;
    }
    
    this._isNumberUpdating = false;
    this._isRestoring = false;
    this._lastRefreshTime = 0;
    
    // LOG DEPLOY
    console.log(`[${this._deployTime}] Server deployed: ${this._version}`);
    console.log(`[${this._deployTime}] Build ID: ${this._deployInfo.buildId}`);
    console.log(`[${this._deployTime}] Environment: ${this._deployInfo.environment}`);
    
    this._restoreAllState().then(() => {});
  }

  // ============ WEBSOCKET MANAGEMENT ============

  _getActiveWebSockets() {
    try {
      return this.ctx.getWebSockets();
    } catch(e) {
      return [];
    }
  }

  _refreshRoomClients(force = false) {
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    const webSockets = this._getActiveWebSockets();
    for (const ws of webSockets) {
      try {
        let room = ws._cachedRoom;
        let username = ws._cachedUsername;
        
        if (!room || !username) {
          const attachment = ws.deserializeAttachment();
          if (attachment && attachment.username && attachment.room) {
            room = attachment.room;
            username = attachment.username;
            ws._cachedRoom = room;
            ws._cachedUsername = username;
          }
        }
        
        if (room && username) {
          const roomClients = this.roomClients.get(room);
          if (roomClients) {
            roomClients.add(ws);
          }
        }
      } catch(e) {}
    }
  }

  // ============ CORE: UPDATE CACHE + STORAGE ============

  async _saveToStorage(roomsData, userSeatData, currentNumber) {
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
      
      // SIMPAN VERSION JUGA
      updates.lastDeployVersion = this._version;
      updates.lastDeployTime = this._deployTime;
      
      if (Object.keys(updates).length > 0) {
        await this.ctx.storage.put(updates);
      }
    } catch(e) {
      try {
        const storage = await this.ctx.storage.get(["roomsData", "userSeatData", "currentNumber"]);
        if (storage.roomsData !== undefined) this._roomsDataCache = storage.roomsData;
        if (storage.userSeatData !== undefined) this._userSeatDataCache = storage.userSeatData;
        if (storage.currentNumber !== undefined) this.currentNumber = storage.currentNumber;
      } catch(err) {}
      throw e;
    }
  }

  // ============ USER COUNT MANAGEMENT ============

  async _updateUserCounts() {
    try {
      const newCounts = {};
      let totalUsers = 0;
      
      for (const room of ROOMS) {
        const roomData = this._roomsDataCache[room];
        const count = roomData?.seats ? Object.keys(roomData.seats).length : 0;
        newCounts[room] = count;
        totalUsers += count;
      }
      
      this._userCounts = newCounts;
      this._onlineUsers.clear();
      for (const [username] of Object.entries(this._userSeatDataCache)) {
        this._onlineUsers.add(username);
      }
      
      await this.ctx.storage.put({
        userCounts: this._userCounts,
        onlineUsers: Array.from(this._onlineUsers),
        lastDeployVersion: this._version,
        lastDeployTime: this._deployTime
      });
      
      return { counts: newCounts, total: totalUsers };
    } catch(e) {
      return { counts: this._userCounts, total: this._onlineUsers.size };
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
        const userCounts = await this.ctx.storage.get("userCounts") || {};
        const onlineUsers = await this.ctx.storage.get("onlineUsers") || [];
        const lastDeployVersion = await this.ctx.storage.get("lastDeployVersion") || "unknown";
        const lastDeployTime = await this.ctx.storage.get("lastDeployTime") || "unknown";
        
        this._roomsDataCache = roomsData;
        this._userSeatDataCache = userSeatData;
        this.currentNumber = currentNumber;
        this._userCounts = userCounts;
        this._onlineUsers = new Set(onlineUsers);
        
        // LOG STORAGE VERSION
        console.log(`[${this._deployTime}] Storage version: ${lastDeployVersion}`);
        console.log(`[${this._deployTime}] Storage deploy time: ${lastDeployTime}`);
        console.log(`[${this._deployTime}] Current version: ${this._version}`);
        
        // CEK APAKAH ADA PERUBAHAN VERSION
        if (lastDeployVersion !== this._version) {
          console.log(`[${this._deployTime}] VERSION CHANGED: ${lastDeployVersion} -> ${this._version}`);
        }
      }
      
      return {
        roomsData: this._roomsDataCache,
        userSeatData: this._userSeatDataCache,
        currentNumber: this.currentNumber,
        userCounts: this._userCounts,
        onlineUsers: Array.from(this._onlineUsers),
        lastDeployVersion: this._version,
        lastDeployTime: this._deployTime
      };
    } catch(e) {
      return { 
        roomsData: {}, 
        userSeatData: {}, 
        currentNumber: 1,
        userCounts: {},
        onlineUsers: [],
        lastDeployVersion: this._version,
        lastDeployTime: this._deployTime
      };
    }
  }

  // ============ USER MANAGEMENT ============

  _isUsernameExists(username) {
    if (!username) return false;
    return this._onlineUsers.has(username) || 
           this._userSeatDataCache.hasOwnProperty(username);
  }

  _isMultiUser(username) {
    if (!username) return false;
    const seatInfo = this._userSeatDataCache[username];
    if (seatInfo && seatInfo.isMulti) {
      return true;
    }
    const webSockets = this._getActiveWebSockets();
    for (const ws of webSockets) {
      try {
        const uname = ws._cachedUsername || ws.username || ws.deserializeAttachment()?.username;
        if (uname === username && ws._isMulti) {
          return true;
        }
      } catch(e) {}
    }
    return false;
  }

  _isUserOnline(username) {
    if (!username) return false;
    
    const seatInfo = this._userSeatDataCache[username];
    if (!seatInfo) return false;
    
    if (seatInfo.isMulti) {
      const roomData = this._roomsDataCache[seatInfo.room];
      if (roomData && roomData.seats && roomData.seats[seatInfo.seat]) {
        return roomData.seats[seatInfo.seat].namauser === username;
      }
      return false;
    }
    
    const webSockets = this._getActiveWebSockets();
    for (const ws of webSockets) {
      try {
        const uname = ws._cachedUsername || ws.username || ws.deserializeAttachment()?.username;
        if (uname === username && ws.readyState === 1 && !ws._isMulti) {
          return true;
        }
      } catch(e) {}
    }
    
    return false;
  }

  // ========================================
  // HAPUS SEMUA DATA USER DARI SEMUA ROOM
  // (UNTUK PINDAH ROOM - SEMUA USER)
  // ========================================
  async _removeUserFromAllRooms(username) {
    if (!username) return false;
    
    let removed = false;
    
    // 1. HAPUS DARI SEMUA ROOM (CACHE)
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
        // DELETE data kursi
        delete roomData.seats[seatToRemove];
        if (roomData.points) {
          delete roomData.points[seatToRemove];
        }
        removed = true;
        
        this.broadcast(roomName, ["removeKursi", roomName, seatToRemove]);
        await this.updateRoomCount(roomName);
        await this._deleteRoomIfEmpty(roomName);
      }
    }
    
    // 2. HAPUS DARI USER SEAT DATA (CACHE)
    if (this._userSeatDataCache[username]) {
      delete this._userSeatDataCache[username];
      removed = true;
    }
    
    // 3. HAPUS DARI ONLINE USERS (CACHE)
    if (this._onlineUsers.has(username)) {
      this._onlineUsers.delete(username);
      removed = true;
    }
    
    // 4. SIMPAN KE STORAGE (DATA SUDAH DI-DELETE)
    if (removed) {
      await this._saveToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber
      );
      await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
      await this._updateUserCounts();
    }
    
    return removed;
  }

  // CLEANUP KHUSUS MULTI - HANYA HAPUS WS (UNTUK DISCONNECT)
  async _cleanupMultiWebSocket(username) {
    if (!username) return false;
    
    try {
      const webSockets = this._getActiveWebSockets();
      let removed = false;
      
      for (const ws of webSockets) {
        try {
          const uname = ws._cachedUsername || ws.username || ws.deserializeAttachment()?.username;
          if (uname === username && ws._isMulti) {
            for (const [room, clients] of this.roomClients) {
              if (clients.has(ws)) {
                clients.delete(ws);
                removed = true;
              }
            }
            
            if (ws.readyState === 1) {
              ws.close(1000, "Multi cleanup");
            }
          }
        } catch(e) {}
      }
      
      this._refreshRoomClients(true);
      return removed;
    } catch(e) {
      console.error("Cleanup multi WS error:", e);
      return false;
    }
  }

  async _isUserInAnyRoom(username) {
    if (!username) return null;
    
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
      if (!seatInfo.isMulti) {
        delete this._userSeatDataCache[username];
        await this._saveToStorage(undefined, this._userSeatDataCache, undefined);
        this._onlineUsers.delete(username);
        await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
      }
    }
    
    for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
      if (!roomData || !roomData.seats) continue;
      for (const [seat, data] of Object.entries(roomData.seats)) {
        if (data && data.namauser === username) {
          this._userSeatDataCache[username] = { 
            room: roomName, 
            seat: parseInt(seat), 
            isMulti: false 
          };
          await this._saveToStorage(undefined, this._userSeatDataCache, undefined);
          this._onlineUsers.add(username);
          await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
          return { room: roomName, seat: parseInt(seat), isMulti: false };
        }
      }
    }
    
    return null;
  }

  _isUserMulti(username) {
    if (!username) return false;
    const seatInfo = this._userSeatDataCache[username];
    return seatInfo ? (seatInfo.isMulti || false) : false;
  }

  async _removeUserFromRoom(username, roomName) {
    if (!username || !roomName) return false;
    
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
    
    delete roomData.seats[seat];
    if (roomData.points) {
      delete roomData.points[seat];
    }
    delete this._userSeatDataCache[username];
    this._onlineUsers.delete(username);
    
    await this._saveToStorage(
      this._roomsDataCache,
      this._userSeatDataCache,
      this.currentNumber
    );
    await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
    
    await this._updateUserCounts();
    
    this.broadcast(roomName, ["removeKursi", roomName, seat]);
    await this.updateRoomCount(roomName);
    await this._deleteRoomIfEmpty(roomName);
    
    return true;
  }

  async _updateKursi(roomName, seat, data) {
    const roomData = this._roomsDataCache[roomName];
    if (!roomData || !roomData.seats || !roomData.seats[seat]) return false;
    
    // REPLACE data kursi
    roomData.seats[seat] = {
      noimageUrl: data.noimageUrl || "",
      namauser: data.namauser || "",
      color: data.color || "",
      itembawah: data.itembawah || 0,
      itematas: data.itematas || 0,
      vip: data.vip || 0,
      viptanda: data.viptanda || 0
    };
    
    await this._saveToStorage(this._roomsDataCache, undefined, undefined);
    return true;
  }

  async _updatePoint(roomName, seat, x, y, fast) {
    const roomData = this._roomsDataCache[roomName];
    if (!roomData || !roomData.seats || !roomData.seats[seat]) return false;
    
    if (!roomData.points) roomData.points = {};
    // REPLACE data points
    roomData.points[seat] = { x: x || 0, y: y || 0, fast: !!fast };
    
    await this._saveToStorage(this._roomsDataCache, undefined, undefined);
    return true;
  }

  async _deleteUserSeat(username) {
    delete this._userSeatDataCache[username];
    await this._saveToStorage(undefined, this._userSeatDataCache, undefined);
    this._onlineUsers.delete(username);
    await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
    await this._updateUserCounts();
  }

  async _deleteRoomIfEmpty(roomName) {
    const roomData = this._roomsDataCache[roomName];
    if (!roomData) return;
    
    const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
    const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
    
    if (!hasSeats && !hasPoints) {
      // DELETE room
      delete this._roomsDataCache[roomName];
      await this._saveToStorage(this._roomsDataCache, undefined, undefined);
      await this._updateUserCounts();
    }
  }

  // ============ JOIN HANDLING ============

  // ========================================
  // HANDLE JOIN - PINDAH ROOM
  // FIX: MULTI USER - STORAGE DAN CACHE SINKRON
  // VERSION: 9.3.13
  // ========================================
  async _handleJoin(ws, roomName) {
    if (!ws || !ws.username || !roomName || !ROOMS_SET.has(roomName) || this.closing || this.isDestroyed) {
      return false;
    }
    
    const username = ws.username;
    
    // CEK APAKAH USER ADALAH MULTI USER
    const seatInfo = this._userSeatDataCache[username];
    const isMulti = seatInfo ? (seatInfo.isMulti || false) : false;
    
    // ============================================================
    // 1. CARI DATA USER DI SEMUA ROOM
    // ============================================================
    let oldRoom = null;
    let oldSeat = null;
    
    for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
      if (!roomData || !roomData.seats) continue;
      for (const [seat, data] of Object.entries(roomData.seats)) {
        if (data && data.namauser === username) {
          oldRoom = roomName;
          oldSeat = parseInt(seat);
          break;
        }
      }
      if (oldRoom) break;
    }
    
    // ============================================================
    // 2. HAPUS DARI ROOM LAMA
    // ============================================================
    if (isMulti && oldRoom && oldSeat !== null) {
      // MULTI USER: HANYA HAPUS DARI ROOM LAMA
      const oldRoomData = this._roomsDataCache[oldRoom];
      if (oldRoomData && oldRoomData.seats && oldRoomData.seats[oldSeat]) {
        // HAPUS DARI ROOM LAMA
        delete oldRoomData.seats[oldSeat];
        if (oldRoomData.points) {
          delete oldRoomData.points[oldSeat];
        }
        
        // ✅ SIMPAN KE STORAGE
        await this._saveToStorage(this._roomsDataCache, undefined, undefined);
        
        // BROADCAST
        this.broadcast(oldRoom, ["removeKursi", oldRoom, oldSeat]);
        await this.updateRoomCount(oldRoom);
        await this._deleteRoomIfEmpty(oldRoom);
      }
      
      // ✅ HAPUS DARI roomClients
      for (const [room, clients] of this.roomClients) {
        if (clients.has(ws)) {
          clients.delete(ws);
        }
      }
      
      // ✅ PERTAHANKAN _userSeatDataCache DAN _onlineUsers UNTUK MULTI
      
    } else if (!isMulti && oldRoom && oldSeat !== null) {
      // USER BIASA: HAPUS DARI SEMUA ROOM
      await this._removeUserFromAllRooms(username);
    }
    
    // ============================================================
    // 3. TAMBAHKAN KE ROOM BARU
    // ============================================================
    let roomData = this._roomsDataCache[roomName];
    if (!roomData) {
      roomData = { seats: {}, points: {}, muted: false, number: 1 };
      this._roomsDataCache[roomName] = roomData;
      await this._saveToStorage(this._roomsDataCache, undefined, undefined);
    }
    
    let seat = null;
    
    const seatCount = Object.keys(roomData.seats).length;
    if (seatCount >= C.MAX_SEATS) {
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
    
    roomData.seats[seat] = {
      noimageUrl: "",
      namauser: username,
      color: "",
      itembawah: 0,
      itematas: 0,
      vip: 0,
      viptanda: 0
    };
    
    // ✅ SIMPAN KE STORAGE
    await this._saveToStorage(this._roomsDataCache, undefined, undefined);
    
    // ✅ UPDATE USER SEAT DATA
    const newSeatInfo = { 
      room: roomName, 
      seat: seat, 
      isMulti: isMulti
    };
    this._userSeatDataCache[username] = newSeatInfo;
    await this._saveToStorage(undefined, this._userSeatDataCache, undefined);
    
    // ✅ UPDATE ONLINE USERS
    this._onlineUsers.add(username);
    await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
    
    // ✅ UPDATE USER COUNTS
    await this._updateUserCounts();
    
    // ============================================================
    // 4. UPDATE WEBSOCKET PROPERTIES
    // ============================================================
    ws.serializeAttachment({
      username: username,
      room: roomName,
      seat: seat,
      isMulti: isMulti,
      multiRoom: isMulti ? roomName : null,
      multiSeat: isMulti ? seat : null,
      seatInfo: newSeatInfo,
      serverVersion: this._version,
      serverDeploy: this._deployTime
    });
    
    ws._cachedRoom = roomName;
    ws._cachedUsername = username;
    ws.username = username;
    ws.room = roomName;
    ws.roomname = roomName;
    ws.idtarget = username;
    ws._isMulti = isMulti;
    ws._multiRoom = isMulti ? roomName : null;
    ws._multiSeat = isMulti ? seat : null;
    ws._closing = false;
    
    // ============================================================
    // 5. REFRESH ROOM CLIENTS
    // ============================================================
    this._refreshRoomClients(true);
    
    // ============================================================
    // 6. KIRIM RESPONSE
    // ============================================================
    this.safeSend(ws, ["rooMasuk", seat, roomName]);
    this.safeSend(ws, ["numberKursiSaya", seat]);
    this.safeSend(ws, ["muteTypeResponse", roomData.muted || false, roomName]);
    this.safeSend(ws, ["serverVersion", this._version, this._deployTime]);
    
    const count = Object.keys(roomData.seats).length;
    this.safeSend(ws, ["roomUserCount", roomName, count]);
    this.broadcast(roomName, ["roomUserCount", roomName, count]);
    
    // KIRIM STATE ROOM
    setTimeout(() => {
      try {
        if (ws && ws.readyState === 1) {
          this.sendAllStateTo(ws, roomName, true);
        }
      } catch(e) {}
    }, 1000);
    
    return true;
  }

  // ============ CLEANUP ============

  async _cleanupUserOnDisconnect(ws) {
    try {
      const username = ws.username || ws._cachedUsername;
      if (!username) return;
      
      const isMulti = ws._isMulti || false;
      const seatInfo = this._userSeatDataCache[username];
      const isMultiFromCache = seatInfo ? (seatInfo.isMulti || false) : false;
      
      if (isMulti || isMultiFromCache) {
        console.log(`Multi user ${username} disconnected, keeping data`);
        
        for (const [room, clients] of this.roomClients) {
          if (clients.has(ws)) {
            clients.delete(ws);
          }
        }
        
        this._refreshRoomClients(true);
        return;
      }
      
      console.log(`Non-multi user ${username} disconnected, removing all data`);
      
      await this._removeUserFromAllRooms(username);
      
      if (this._userSeatDataCache[username]) {
        delete this._userSeatDataCache[username];
      }
      
      if (this._onlineUsers.has(username)) {
        this._onlineUsers.delete(username);
      }
      
      await this._saveToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber
      );
      
      await this._updateUserCounts();
      await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
      this._refreshRoomClients(true);
      
    } catch(e) {
      console.error("Cleanup user error:", e);
    }
  }

  // ============ BROADCAST ============

  _broadcastToRoom(room, msgStr) {
    if (this.closing || this.isDestroyed || !room) return;
    
    this._refreshRoomClients(false);
    
    const clients = this.roomClients.get(room);
    if (!clients || clients.size === 0) return;
    
    const clientArray = Array.from(clients);
    const toRemove = new Set();
    
    for (const ws of clientArray) {
      if (!ws) { toRemove.add(ws); continue; }
      
      try {
        const wsRoom = ws._cachedRoom || ws.room || ws.roomname;
        if (wsRoom !== room) {
          toRemove.add(ws);
          continue;
        }
        
        if (ws.readyState === 1 && !ws._closing) {
          ws.send(msgStr);
        } else {
          toRemove.add(ws);
        }
      } catch(e) { toRemove.add(ws); }
    }
    
    if (toRemove.size > 0) {
      for (const ws of toRemove) {
        try { clients.delete(ws); } catch(e) {}
      }
    }
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
      const roomData = this._roomsDataCache[room];
      if (!roomData || !roomData.seats) return 0;
      const count = Object.keys(roomData.seats).length;
      
      this._userCounts[room] = count;
      await this.ctx.storage.put("userCounts", this._userCounts);
      
      this.broadcast(room, ["roomUserCount", room, count]);
      return count;
    } catch(e) { return 0; }
  }

  async sendAllStateTo(ws, room, excludeSelf = false) {
    if (!ws || !ws.username) return;
    try {
      if (ws.readyState !== 1 || ws._closing) return;
    } catch(e) { return; }
    
    const roomData = this._roomsDataCache[room];
    if (!roomData) return;
    
    try {
      const allSeats = roomData.seats || {};
      const allPoints = roomData.points || {};
      
      const userSeat = this._userSeatDataCache[ws.username];
      const selfSeat = userSeat?.seat;
      
      const count = Object.keys(allSeats).length;
      this.safeSend(ws, ["roomUserCount", room, count]);
      this.safeSend(ws, ["serverVersion", this._version, this._deployTime]);
      
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

  // ============ ALARM / NUMBER UPDATER ============

  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    await this._updateNumber();
    await this._cleanupStorage();
    await this._cleanupOrphanedUsers();
    
    if (!this.closing && !this.isDestroyed) {
      this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
    }
  }

  async _updateNumber() {
    if (this._isNumberUpdating || this.closing || this.isDestroyed) return;
    this._isNumberUpdating = true;
    try {
      this.currentNumber = this.currentNumber < C.MAX_NUMBER ? this.currentNumber + 1 : 1;
      
      await this._saveToStorage(undefined, undefined, this.currentNumber);
      
      const storage = await this._loadFromStorage();
      const roomsData = storage.roomsData || {};
      let changed = false;
      
      for (const [roomName, roomData] of Object.entries(roomsData)) {
        if (roomData) {
          roomData.number = this.currentNumber;
          changed = true;
        }
      }
      
      if (changed) {
        await this._saveToStorage(roomsData, undefined, undefined);
      }
      
      const numberMsg = JSON.stringify(["currentNumber", this.currentNumber]);
      
      this._refreshRoomClients(true);
      for (const [room, clients] of this.roomClients) {
        if (clients && clients.size > 0) {
          this._broadcastToRoom(room, numberMsg);
        }
      }
      
    } catch(e) {
      const storage = await this.ctx.storage.get(["currentNumber", "roomsData"]);
      if (storage.currentNumber !== undefined) this.currentNumber = storage.currentNumber;
      if (storage.roomsData !== undefined) this._roomsDataCache = storage.roomsData;
    } finally {
      this._isNumberUpdating = false;
    }
  }

  async _cleanupStorage() {
    try {
      const storage = await this._loadFromStorage();
      const roomsData = storage.roomsData || {};
      const userSeatData = storage.userSeatData || {};
      
      let changed = false;
      
      const connectedUsers = new Set();
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          const uname = ws._cachedUsername || ws.username || ws.deserializeAttachment()?.username;
          if (uname) {
            connectedUsers.add(uname);
          }
        } catch(e) {}
      }
      
      for (const [username, seatInfo] of Object.entries(userSeatData)) {
        if (!seatInfo || !seatInfo.room) {
          delete userSeatData[username];
          changed = true;
          continue;
        }
        
        if (seatInfo.isMulti) {
          continue;
        }
        
        if (!connectedUsers.has(username)) {
          delete userSeatData[username];
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
        await this._saveToStorage(roomsData, userSeatData, storage.currentNumber);
      }
      
    } catch(e) {}
  }

  async _cleanupOrphanedUsers() {
    try {
      const connectedUsers = new Set();
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          const uname = ws._cachedUsername || ws.username || ws.deserializeAttachment()?.username;
          if (uname) {
            connectedUsers.add(uname);
          }
        } catch(e) {}
      }
      
      const usersToRemove = [];
      for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
        if (seatInfo && seatInfo.isMulti) {
          console.log(`Skipping multi user ${username} from cleanup`);
          continue;
        }
        
        if (!connectedUsers.has(username)) {
          usersToRemove.push(username);
        }
      }
      
      for (const username of usersToRemove) {
        await this._removeUserFromAllRooms(username);
      }
      
      if (usersToRemove.length > 0) {
        await this._saveToStorage(
          this._roomsDataCache,
          this._userSeatDataCache,
          this.currentNumber
        );
        await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
        await this._updateUserCounts();
      }
    } catch(e) {
      console.error("Cleanup orphaned users error:", e);
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
        
        if (attachment.seatInfo) {
          this._userSeatDataCache[attachment.username] = attachment.seatInfo;
        }
      }
      
      await this.handleMessage(ws, message);
    } catch(e) {
      console.error("WebSocket message error:", e);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    if (!ws) return;
    console.log(`WebSocket closed: ${ws._cachedUsername || 'unknown'}, code: ${code}`);
    try {
      const isMulti = ws._isMulti || false;
      const username = ws._cachedUsername || ws.username;
      const seatInfo = username ? this._userSeatDataCache[username] : null;
      const isMultiFromCache = seatInfo ? (seatInfo.isMulti || false) : false;
      
      if (isMulti || isMultiFromCache) {
        console.log(`Multi user ${username} WebSocket closed, keeping data`);
        
        for (const [room, clients] of this.roomClients) {
          if (clients.has(ws)) {
            clients.delete(ws);
          }
        }
        
        this._refreshRoomClients(true);
        return;
      }
      
      await this._cleanupUserOnDisconnect(ws);
      
      for (const [room, clients] of this.roomClients) {
        if (clients.has(ws)) {
          clients.delete(ws);
        }
      }
      
      this._refreshRoomClients(true);
    } catch(e) {
      console.error("WebSocket close error:", e);
    }
  }

  async webSocketError(ws, error) {
    if (!ws) return;
    console.error(`WebSocket error for ${ws._cachedUsername || 'unknown'}:`, error);
    try {
      const isMulti = ws._isMulti || false;
      const username = ws._cachedUsername || ws.username;
      const seatInfo = username ? this._userSeatDataCache[username] : null;
      const isMultiFromCache = seatInfo ? (seatInfo.isMulti || false) : false;
      
      if (isMulti || isMultiFromCache) {
        console.log(`Multi user ${username} WebSocket error, keeping data`);
        
        for (const [room, clients] of this.roomClients) {
          if (clients.has(ws)) {
            clients.delete(ws);
          }
        }
        
        this._refreshRoomClients(true);
        return;
      }
      
      await this._cleanupUserOnDisconnect(ws);
      
      for (const [room, clients] of this.roomClients) {
        if (clients.has(ws)) {
          clients.delete(ws);
        }
      }
      
      this._refreshRoomClients(true);
    } catch(e) {
      console.error("WebSocket error cleanup:", e);
    }
  }

  // ============ HANDLE SET ID ============

  async _handleSetId(ws, username, isNewUser) {
    if (!ws || !username || typeof username !== 'string' || username.length === 0 || this.closing || this.isDestroyed) {
      try { if (ws?.readyState === 1) ws.close(1000, "Invalid username"); } catch(e) {}
      return;
    }
    
    if (ws.readyState !== 1) return;
    
    // ✅ LANGSUNG SETOR WS TANPA REMOVE
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
    
    ws.serializeAttachment({ 
      username: username,
      serverVersion: this._version,
      serverDeploy: this._deployTime
    });
    
    if (isNewUser) { 
      this.safeSend(ws, ["joinroomawal"]); 
      this.safeSend(ws, ["serverVersion", this._version, this._deployTime]);
    } else { 
      this.safeSend(ws, ["needJoinRoom"]); 
      this.safeSend(ws, ["serverVersion", this._version, this._deployTime]);
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
        
        case "getServerVersion":
          this.safeSend(ws, ["serverVersion", this._version, this._deployTime, this._deployInfo]);
          break;
        
        // ============================================================
        // setIdTarget2 - FIX MULTI USER
        // ============================================================
        case "setIdTarget2": {
          const username = args[0];
          const isNewUser = args[1];
          
          if (username) {
            const seatInfo = this._userSeatDataCache[username];
            
            // KHUSUS MULTI + isNewUser=false: SETOR WS AJA, LANGSUNG RETURN
            if (seatInfo && seatInfo.isMulti && !isNewUser) {
              // SETOR WS TANPA HAPUS DATA
              ws.username = username;
              ws.idtarget = username;
              ws.room = seatInfo.room;
              ws.roomname = seatInfo.room;
              ws._closing = false;
              ws._isMulti = true;
              ws._multiRoom = seatInfo.room;
              ws._multiSeat = seatInfo.seat;
              ws._cachedUsername = username;
              ws._cachedRoom = seatInfo.room;
              
              ws.serializeAttachment({
                username: username,
                room: seatInfo.room,
                seat: seatInfo.seat,
                isMulti: true,
                multiRoom: seatInfo.room,
                multiSeat: seatInfo.seat,
                seatInfo: seatInfo,
                serverVersion: this._version,
                serverDeploy: this._deployTime
              });
              
              // TAMBAHKAN KE roomClients
              const roomClients = this.roomClients.get(seatInfo.room);
              if (roomClients) {
                roomClients.add(ws);
              }
              
              // ✅ HANYA needJoinRoom (TANPA EVENT TAMBAHAN LAIN)
              this.safeSend(ws, ["serverVersion", this._version, this._deployTime]);
              
              this._refreshRoomClients(true);
              return;  // ← LANGSUNG RETURN
            }
            
            // USER BIASA: HAPUS DATA DULU
            await this._removeUserFromAllRooms(username);
          }
          
          // USER BIASA: SETOR WS
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
          
          await this._removeUserFromAllRooms(multiUsername);
          
          let roomData = this._roomsDataCache[multiRoomname];
          if (!roomData) {
            roomData = { seats: {}, points: {}, muted: false, number: 1 };
            this._roomsDataCache[multiRoomname] = roomData;
            await this._saveToStorage(this._roomsDataCache, undefined, undefined);
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
          
          roomData.seats[seat] = {
            noimageUrl: "",
            namauser: multiUsername,
            color: "",
            itembawah: 0,
            itematas: 0,
            vip: 0,
            viptanda: 0
          };
          
          await this._saveToStorage(this._roomsDataCache, undefined, undefined);
          
          const seatInfo = { 
            room: multiRoomname, 
            seat: seat, 
            isMulti: true,
            multiRoom: multiRoomname,
            multiSeat: seat
          };
          this._userSeatDataCache[multiUsername] = seatInfo;
          await this._saveToStorage(undefined, this._userSeatDataCache, undefined);
          
          this._onlineUsers.add(multiUsername);
          await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
          await this._updateUserCounts();
          
          ws.serializeAttachment({
            username: multiUsername,
            room: multiRoomname,
            seat: seat,
            isMulti: true,
            multiRoom: multiRoomname,
            multiSeat: seat,
            seatInfo: seatInfo,
            serverVersion: this._version,
            serverDeploy: this._deployTime
          });
          
          ws._cachedUsername = multiUsername;
          ws._cachedRoom = multiRoomname;
          ws.username = multiUsername;
          ws.idtarget = multiUsername;
          ws.room = multiRoomname;
          ws.roomname = multiRoomname;
          ws._isMulti = true;
          ws._multiRoom = multiRoomname;
          ws._multiSeat = seat;
          
          const webSockets = this._getActiveWebSockets();
          for (const wsKey of webSockets) {
            if (wsKey === ws) continue;
            try {
              const uname = wsKey._cachedUsername || 
                            wsKey.username || 
                            wsKey.deserializeAttachment()?.username;
              if (uname === multiUsername && wsKey.readyState === 1) {
                wsKey.serializeAttachment({
                  username: multiUsername,
                  room: multiRoomname,
                  seat: seat,
                  isMulti: true,
                  multiRoom: multiRoomname,
                  multiSeat: seat,
                  seatInfo: seatInfo,
                  serverVersion: this._version,
                  serverDeploy: this._deployTime
                });
                wsKey._cachedUsername = multiUsername;
                wsKey._cachedRoom = multiRoomname;
                wsKey.username = multiUsername;
                wsKey.idtarget = multiUsername;
                wsKey.room = multiRoomname;
                wsKey.roomname = multiRoomname;
                wsKey._isMulti = true;
                wsKey._multiRoom = multiRoomname;
                wsKey._multiSeat = seat;
                wsKey._closing = false;
              }
            } catch(e) {}
          }
          
          this._refreshRoomClients(true);
          
          this.safeSend(ws, ["rooMasukMulti", seat, multiRoomname]);
          this.safeSend(ws, ["serverVersion", this._version, this._deployTime]);
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
          
          this._userSeatDataCache[targetUsername] = {
            room: roomName,
            seat: seatNumber,
            isMulti: true,
            multiRoom: roomName,
            multiSeat: seatNumber
          };
          await this._saveToStorage(undefined, this._userSeatDataCache, undefined);
          
          const webSockets = this._getActiveWebSockets();
          let foundAny = false;
          
          for (const wsKey of webSockets) {
            try {
              const uname = wsKey._cachedUsername || 
                            wsKey.username || 
                            wsKey.deserializeAttachment()?.username;
              
              if (uname === targetUsername && wsKey.readyState === 1) {
                wsKey.serializeAttachment({
                  username: targetUsername,
                  room: roomName,
                  seat: seatNumber,
                  isMulti: true,
                  multiRoom: roomName,
                  multiSeat: seatNumber,
                  seatInfo: { 
                    room: roomName, 
                    seat: seatNumber, 
                    isMulti: true,
                    multiRoom: roomName,
                    multiSeat: seatNumber
                  },
                  serverVersion: this._version,
                  serverDeploy: this._deployTime
                });
                
                wsKey._cachedUsername = targetUsername;
                wsKey._cachedRoom = roomName;
                wsKey.username = targetUsername;
                wsKey.idtarget = targetUsername;
                wsKey.room = roomName;
                wsKey.roomname = roomName;
                wsKey._isMulti = true;
                wsKey._multiRoom = roomName;
                wsKey._multiSeat = seatNumber;
                wsKey._closing = false;
                
                foundAny = true;
                
                this.safeSend(wsKey, ["activeChangedMulti", targetUsername, seatNumber, roomName]);
                this.safeSend(wsKey, ["serverVersion", this._version, this._deployTime]);
                
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
          this._refreshRoomClients(true);
          
          break;
        }
        
        case "exitMulti": {
          const targetUsername = args[0];
          
          if (!targetUsername) {
            this.safeSend(ws, ["exitMultiError", "Username tidak boleh kosong"]);
            break;
          }
          
          try {
            const seatInfo = this._userSeatDataCache[targetUsername];
            const isMulti = seatInfo ? (seatInfo.isMulti || false) : false;
            
            if (!isMulti) {
              this.safeSend(ws, ["exitMultiError", `${targetUsername} bukan user multi`]);
              break;
            }
            
            for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
              if (!roomData || !roomData.seats) continue;
              
              let seatToRemove = null;
              for (const [seat, data] of Object.entries(roomData.seats)) {
                if (data && data.namauser === targetUsername) {
                  seatToRemove = parseInt(seat);
                  break;
                }
              }
              
              if (seatToRemove !== null) {
                delete roomData.seats[seatToRemove];
                if (roomData.points) {
                  delete roomData.points[seatToRemove];
                }
                
                this.broadcast(roomName, ["removeKursi", roomName, seatToRemove]);
                await this.updateRoomCount(roomName);
                await this._deleteRoomIfEmpty(roomName);
              }
            }
            
            if (this._userSeatDataCache[targetUsername]) {
              delete this._userSeatDataCache[targetUsername];
            }
            
            if (this._onlineUsers.has(targetUsername)) {
              this._onlineUsers.delete(targetUsername);
            }
            
            await this._saveToStorage(
              this._roomsDataCache,
              this._userSeatDataCache,
              this.currentNumber
            );
            await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
            await this._updateUserCounts();
            
            const webSockets = this._getActiveWebSockets();
            for (const wsKey of webSockets) {
              try {
                const uname = wsKey._cachedUsername || 
                              wsKey.username || 
                              wsKey.deserializeAttachment()?.username;
                if (uname === targetUsername && wsKey.readyState === 1) {
                  delete wsKey._isMulti;
                  delete wsKey._multiRoom;
                  delete wsKey._multiSeat;
                  delete wsKey._cachedRoom;
                  delete wsKey._cachedUsername;
                  delete wsKey.room;
                  delete wsKey.roomname;
                  delete wsKey.idtarget;
                  delete wsKey.username;
                  
                  wsKey.serializeAttachment({});
                  
                  this.safeSend(wsKey, ["exitMultiSuccess", targetUsername, null, null]);
                }
              } catch(e) {}
            }
            
            this._refreshRoomClients(true);
            
            this.safeSend(ws, ["exitMultiSuccess", targetUsername, null, null]);
            
          } catch(e) {
            this.safeSend(ws, ["exitMultiError", e.message]);
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
            viptanda: kursiVt || 0
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
          let isOnline = false;
          
          if (onlineTarget) {
            const userSeat = this._userSeatDataCache[onlineTarget];
            
            if (userSeat) {
              if (userSeat.isMulti) {
                const roomData = this._roomsDataCache[userSeat.room];
                if (roomData && roomData.seats && roomData.seats[userSeat.seat]) {
                  if (roomData.seats[userSeat.seat].namauser === onlineTarget) {
                    isOnline = true;
                  }
                }
              } else {
                const webSockets = this._getActiveWebSockets();
                for (const wsKey of webSockets) {
                  try {
                    const uname = wsKey._cachedUsername || 
                                  wsKey.username || 
                                  wsKey.deserializeAttachment()?.username;
                    if (uname === onlineTarget && wsKey.readyState === 1 && !wsKey._isMulti) {
                      isOnline = true;
                      break;
                    }
                  } catch(e) {}
                }
              }
            }
          }
          
          this.safeSend(ws, ["userOnlineStatus", onlineTarget, isOnline, onlineCallback || ""]);
          break;
        }
        
        case "getOnlineUsers": {
          const users = [];
          for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
            if (!seatInfo) continue;
            
            if (seatInfo.isMulti) {
              const roomData = this._roomsDataCache[seatInfo.room];
              if (roomData && roomData.seats && roomData.seats[seatInfo.seat]) {
                if (roomData.seats[seatInfo.seat].namauser === username) {
                  users.push(username);
                }
              }
            } else {
              const webSockets = this._getActiveWebSockets();
              for (const wsKey of webSockets) {
                try {
                  const uname = wsKey._cachedUsername || 
                                wsKey.username || 
                                wsKey.deserializeAttachment()?.username;
                  if (uname === username && wsKey.readyState === 1 && !wsKey._isMulti) {
                    users.push(username);
                    break;
                  }
                } catch(e) {}
              }
            }
          }
          this.safeSend(ws, ["allOnlineUsers", users]);
          break;
        }
        
        case "getAllRoomsUserCount": {
          const counts = {};
          for (const room of ROOMS) {
            const roomData = this._roomsDataCache[room];
            counts[room] = roomData?.seats ? Object.keys(roomData.seats).length : 0;
          }
          this.safeSend(ws, ["allRoomsUserCount", Object.entries(counts)]);
          break;
        }
        
        case "getRoomUserCount": {
          const roomName = args[0];
          if (roomName && ROOMS_SET.has(roomName)) {
            const roomData = this._roomsDataCache[roomName];
            const count = roomData?.seats ? Object.keys(roomData.seats).length : 0;
            this.safeSend(ws, ["roomUserCount", roomName, count]);
          }
          break;
        }
        
        case "setMuteType": {
          const [muteVal, muteRoom] = args;
          if (!muteRoom || !ROOMS_SET.has(muteRoom)) break;
          
          const roomData = this._roomsDataCache[muteRoom];
          if (roomData) {
            roomData.muted = !!muteVal;
            await this._saveToStorage(this._roomsDataCache, undefined, undefined);
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
    } catch(e) {}
  }

  // ============ RESTORE STATE ============

  async _restoreAllState() {
    if (this._isRestoring) return;
    this._isRestoring = true;
    
    try {
      const roomsData = await this.ctx.storage.get("roomsData") || {};
      const userSeatData = await this.ctx.storage.get("userSeatData") || {};
      const currentNumber = await this.ctx.storage.get("currentNumber") || 1;
      const userCounts = await this.ctx.storage.get("userCounts") || {};
      const onlineUsers = await this.ctx.storage.get("onlineUsers") || [];
      const lastDeployVersion = await this.ctx.storage.get("lastDeployVersion") || "unknown";
      const lastDeployTime = await this.ctx.storage.get("lastDeployTime") || "unknown";
      
      this._roomsDataCache = roomsData;
      this._userSeatDataCache = userSeatData;
      this.currentNumber = currentNumber;
      this._userCounts = userCounts;
      this._onlineUsers = new Set(onlineUsers);
      
      // LOG VERSION INFO
      console.log(`[${this._deployTime}] Storage version: ${lastDeployVersion}`);
      console.log(`[${this._deployTime}] Storage deploy time: ${lastDeployTime}`);
      console.log(`[${this._deployTime}] Current version: ${this._version}`);
      
      if (lastDeployVersion !== this._version) {
        console.log(`[${this._deployTime}] ⚠️ VERSION CHANGED: ${lastDeployVersion} -> ${this._version}`);
      }
      
      for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
        if (!seatInfo || !seatInfo.room) {
          if (!seatInfo?.isMulti) {
            delete this._userSeatDataCache[username];
            this._onlineUsers.delete(username);
          }
          continue;
        }
        const roomData = this._roomsDataCache[seatInfo.room];
        if (!roomData || !roomData.seats || !roomData.seats[seatInfo.seat]) {
          if (!seatInfo.isMulti) {
            delete this._userSeatDataCache[username];
            this._onlineUsers.delete(username);
          }
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
              
              ws.serializeAttachment({
                username: attachment.username,
                room: roomName,
                seat: seatNumber,
                isMulti: isMulti,
                multiRoom: attachment.multiRoom || roomName,
                multiSeat: attachment.multiSeat || seatNumber,
                seatInfo: userSeat,
                serverVersion: this._version,
                serverDeploy: this._deployTime
              });
              
              this._onlineUsers.add(attachment.username);
            }
          }
        } catch(e) {}
      }
      
      this._refreshRoomClients(true);
      await this._updateUserCounts();
      
      await this._saveToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber
      );
      await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
      
      if (!this.closing && !this.isDestroyed) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        if (!existingAlarm) {
          this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        }
      }
      
    } catch(e) {
      console.error("Restore state error:", e);
    } finally {
      this._isRestoring = false;
    }
  }

  // ============ RESET ALL DATA ============
  // FIX: RESET HANYA UNTUK USER BIASA, MULTI USER TETAP
  // VERSION: 9.3.14

  async resetAllData() {
    const timestamp = Date.now();
    
    try {
      // ✅ 1. KUMPULKAN DATA MULTI USER YANG HARUS DI-PERTAHANKAN
      const multiUsersData = {};
      const multiUsersSeatInfo = {};
      
      for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
        if (seatInfo && seatInfo.isMulti) {
          // SIMPAN DATA MULTI USER
          multiUsersData[username] = seatInfo;
          
          // SIMPAN JUGA DATA KURSI MULTI USER
          const roomData = this._roomsDataCache[seatInfo.room];
          if (roomData && roomData.seats && roomData.seats[seatInfo.seat]) {
            multiUsersSeatInfo[seatInfo.room] = multiUsersSeatInfo[seatInfo.room] || {};
            multiUsersSeatInfo[seatInfo.room][seatInfo.seat] = roomData.seats[seatInfo.seat];
          }
        }
      }
      
      // ✅ 2. RESET DATA NON-MULTI
      this._roomsDataCache = {};
      this._userSeatDataCache = {};
      this.currentNumber = 1;
      this._onlineUsers.clear();
      this._userCounts = {};
      for (const room of ROOMS) {
        this._userCounts[room] = 0;
      }
      
      // ✅ 3. KEMBALIKAN DATA MULTI USER
      for (const [username, seatInfo] of Object.entries(multiUsersData)) {
        this._userSeatDataCache[username] = seatInfo;
        this._onlineUsers.add(username);
        
        // KEMBALIKAN DATA KURSI MULTI USER
        const roomName = seatInfo.room;
        const seatNumber = seatInfo.seat;
        
        if (!this._roomsDataCache[roomName]) {
          this._roomsDataCache[roomName] = { seats: {}, points: {}, muted: false, number: 1 };
        }
        
        if (multiUsersSeatInfo[roomName] && multiUsersSeatInfo[roomName][seatNumber]) {
          this._roomsDataCache[roomName].seats[seatNumber] = multiUsersSeatInfo[roomName][seatNumber];
        }
        
        // UPDATE USER COUNTS
        this._userCounts[roomName] = (this._userCounts[roomName] || 0) + 1;
      }
      
      // ✅ 4. SIMPAN KE STORAGE
      await this.ctx.storage.delete("roomsData");
      await this.ctx.storage.delete("userSeatData");
      await this.ctx.storage.delete("currentNumber");
      await this.ctx.storage.delete("userCounts");
      await this.ctx.storage.delete("onlineUsers");
      
      // SIMPAN DATA MULTI USER
      if (Object.keys(this._roomsDataCache).length > 0) {
        await this.ctx.storage.put("roomsData", this._roomsDataCache);
      }
      if (Object.keys(this._userSeatDataCache).length > 0) {
        await this.ctx.storage.put("userSeatData", this._userSeatDataCache);
      }
      await this.ctx.storage.put("currentNumber", this.currentNumber);
      await this.ctx.storage.put("userCounts", this._userCounts);
      await this.ctx.storage.put("onlineUsers", Array.from(this._onlineUsers));
      
      // SIMPAN VERSION
      await this.ctx.storage.put("lastDeployVersion", this._version);
      await this.ctx.storage.put("lastDeployTime", this._deployTime);
      
      // ✅ 5. KIRIM PESAN RESET KE SEMUA USER (KECUALI MULTI)
      const resetMessage = JSON.stringify(["serverReset", "Server di-reset pada: " + new Date(timestamp).toLocaleString()]);
      const multiResetMessage = JSON.stringify(["serverResetMulti", "Server di-reset, data multi user tetap dipertahankan"]);
      
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          if (ws.readyState === 1) {
            const isMulti = ws._isMulti || false;
            if (isMulti) {
              // MULTI USER: KIRIM PESAN KHUSUS
              ws.send(multiResetMessage);
              ws.send(JSON.stringify(["serverVersion", this._version, this._deployTime]));
            } else {
              // USER BIASA: KIRIM PESAN RESET + CLOSE
              ws.send(resetMessage);
              ws.close(1000, "Server reset - " + timestamp);
            }
          }
        } catch(e) {}
      }
      
      // ✅ 6. REFRESH ROOM CLIENTS
      this._refreshRoomClients(true);
      
      // ✅ 7. SET ALARM
      if (!this.closing && !this.isDestroyed) {
        await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      }
      
      await this.ctx.storage.put("lastReset", timestamp);
      
      return {
        success: true,
        message: "Reset data berhasil, multi user tetap dipertahankan",
        multiUsersKept: Object.keys(multiUsersData),
        timestamp: timestamp,
        resetTime: new Date(timestamp).toLocaleString(),
        serverVersion: this._version,
        deployTime: this._deployTime
      };
      
    } catch(e) {
      return {
        success: false,
        error: e.message,
        timestamp: timestamp,
        serverVersion: this._version
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
      
      if (url.pathname === "/cleanup-multi" && req.method === "POST") {
        try {
          const body = await req.json();
          const username = body.username;
          
          if (!username) {
            return new Response(JSON.stringify({ error: "Username required" }), {
              status: 400,
              headers: { "Content-Type": "application/json" }
            });
          }
          
          const result = await this._cleanupMultiWebSocket(username);
          
          return new Response(JSON.stringify({
            success: result,
            username: username,
            message: "Multi WebSocket cleaned, data preserved",
            timestamp: Date.now(),
            serverVersion: this._version
          }), {
            status: result ? 200 : 404,
            headers: { "Content-Type": "application/json" }
          });
        } catch(e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
      
      if (url.pathname === "/status") {
        const webSockets = this._getActiveWebSockets();
        const status = {
          activeConnections: webSockets.length,
          rooms: this._userCounts,
          totalUsers: this._onlineUsers.size,
          currentNumber: this.currentNumber,
          isClosing: this.closing,
          isDestroyed: this.isDestroyed,
          uptime: Date.now() - this._startTime,
          serverVersion: this._version,
          deployTime: this._deployTime,
          buildId: this._deployInfo.buildId,
          environment: this._deployInfo.environment
        };
        return new Response(JSON.stringify(status), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      if (url.pathname === "/version") {
        return new Response(JSON.stringify({
          version: this._version,
          deployTime: this._deployTime,
          buildId: this._deployInfo.buildId,
          environment: this._deployInfo.environment,
          timestamp: Date.now()
        }), {
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
      
      server.serializeAttachment({
        serverVersion: this._version,
        serverDeploy: this._deployTime
      });
      
      this._refreshRoomClients(true);
      
      return new Response(null, { 
        status: 101, 
        webSocket: client
      });
      
    } catch(e) {
      console.error("Fetch error:", e);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // ============ DESTROY ============

  async destroy() {
    if (this.isDestroyed) return;
    this.closing = true;
    this.isDestroyed = true;
    
    await this._cleanupStorage();
    
    const webSockets = this._getActiveWebSockets();
    for (const ws of webSockets) {
      if (ws?.readyState === 1) {
        try { ws.send(JSON.stringify(["serverShutdown", "Server shutting down", this._version])); } catch(e) {}
        try { ws.close(1000, "Shutdown - " + this._version); } catch(e) {}
      }
    }
    
    this.roomClients.clear();
    this._onlineUsers.clear();
    
    try {
      await this.ctx.storage.deleteAlarm();
    } catch(e) {}
  }
}

export default ChatServer;
