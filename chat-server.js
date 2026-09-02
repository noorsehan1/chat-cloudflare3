// ==================== CHAT-SERVER-HIBERNATION-NO-PING.JS ====================
// VERSION: Auto-generated with timestamp
// DEPLOY: Auto-generated

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

function generateVersion() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const timestamp = now.getTime();
  const buildId = Math.random().toString(36).substring(2, 8).toUpperCase();
  
  return {
    version: `${year}${month}${day}.${hours}${minutes}${seconds}`,
    timestamp: timestamp,
    deployDate: now.toISOString(),
    buildId: buildId,
    environment: "production",
    fullVersion: `v${year}${month}${day}-${hours}${minutes}${seconds}-${buildId}`
  };
}

const DEPLOY_VERSION = generateVersion();
const SERVER_VERSION = DEPLOY_VERSION.fullVersion;

export class ChatServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ctx = state;
    this.closing = false;
    this.isDestroyed = false;
    this._startTime = Date.now();
    
    this._version = SERVER_VERSION;
    this._deployInfo = DEPLOY_VERSION;
    this._deployTime = DEPLOY_VERSION.deployDate;
    
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
    
    this._autoResetOnDeploy().then(() => {});
  }

  async _autoResetOnDeploy() {
    try {
      const storedVersion = await this.ctx.storage.get("lastDeployVersion");
      
      if (storedVersion !== this._version) {
        this._roomsDataCache = {};
        this._userSeatDataCache = {};
        this.currentNumber = 1;
        this._onlineUsers.clear();
        this._userCounts = {};
        for (const room of ROOMS) {
          this._userCounts[room] = 0;
        }
        
        await this.ctx.storage.delete("roomsData");
        await this.ctx.storage.delete("userSeatData");
        await this.ctx.storage.delete("currentNumber");
        await this.ctx.storage.delete("userCounts");
        await this.ctx.storage.delete("onlineUsers");
        await this.ctx.storage.delete("lastReset");
        
        await this.ctx.storage.put("lastDeployVersion", this._version);
        await this.ctx.storage.put("lastDeployTime", this._deployTime);
        await this.ctx.storage.put("lastReset", Date.now());
        
        if (!this.closing && !this.isDestroyed) {
          await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        }
        
        const resetMessage = JSON.stringify(["serverReset", `Server di-reset pada: ${new Date().toLocaleString()}`]);
        const webSockets = this._getActiveWebSockets();
        for (const ws of webSockets) {
          try {
            if (ws.readyState === 1) {
              ws.send(resetMessage);
              ws.close(1000, "Server reset - deploy baru");
            }
          } catch(e) {}
        }
        
        this._refreshRoomClients(true);
      } else {
        await this._restoreAllState();
      }
      
    } catch(e) {
      await this._restoreAllState();
    }
  }

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
      
      updates.lastDeployVersion = this._version;
      updates.lastDeployTime = this._deployTime;
      
      const userCounts = {};
      let totalUsers = 0;
      for (const room of ROOMS) {
        const roomData = this._roomsDataCache[room];
        const count = roomData?.seats ? Object.keys(roomData.seats).length : 0;
        userCounts[room] = count;
        totalUsers += count;
      }
      this._userCounts = userCounts;
      updates.userCounts = userCounts;
      
      this._onlineUsers.clear();
      for (const [username] of Object.entries(this._userSeatDataCache)) {
        this._onlineUsers.add(username);
      }
      updates.onlineUsers = Array.from(this._onlineUsers);
      
      if (Object.keys(updates).length > 0) {
        await this.ctx.storage.put(updates);
      }
      
      return {
        roomsData: this._roomsDataCache,
        userSeatData: this._userSeatDataCache,
        currentNumber: this.currentNumber,
        userCounts: this._userCounts,
        onlineUsers: Array.from(this._onlineUsers)
      };
      
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
        
        if (lastDeployVersion !== this._version) {
          // version changed
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

  async _removeUserFromAllRooms(username) {
    if (!username) return false;
    
    let removed = false;
    
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
    
    if (this._userSeatDataCache[username]) {
      delete this._userSeatDataCache[username];
      removed = true;
    }
    
    if (this._onlineUsers.has(username)) {
      this._onlineUsers.delete(username);
      removed = true;
    }
    
    if (removed) {
      await this._saveToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber
      );
    }
    
    return removed;
  }

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
        await this._saveToStorage(undefined, undefined, undefined);
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
          await this._saveToStorage(undefined, undefined, undefined);
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
    
    this.broadcast(roomName, ["removeKursi", roomName, seat]);
    await this.updateRoomCount(roomName);
    await this._deleteRoomIfEmpty(roomName);
    
    return true;
  }

  async _updateKursi(roomName, seat, data) {
    const roomData = this._roomsDataCache[roomName];
    if (!roomData || !roomData.seats || !roomData.seats[seat]) return false;
    
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
    roomData.points[seat] = { x: x || 0, y: y || 0, fast: !!fast };
    
    await this._saveToStorage(this._roomsDataCache, undefined, undefined);
    return true;
  }

  async _deleteUserSeat(username) {
    delete this._userSeatDataCache[username];
    await this._saveToStorage(undefined, this._userSeatDataCache, undefined);
    this._onlineUsers.delete(username);
    await this._saveToStorage(undefined, undefined, undefined);
  }

  async _deleteRoomIfEmpty(roomName) {
    const roomData = this._roomsDataCache[roomName];
    if (!roomData) return;
    
    const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
    const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
    
    if (!hasSeats && !hasPoints) {
      delete this._roomsDataCache[roomName];
      await this._saveToStorage(this._roomsDataCache, undefined, undefined);
    }
  }

  async _cleanupDuplicateUser(username) {
    if (!username) return false;
    
    let removed = false;
    const foundSeats = [];
    
    for (const [roomName, roomData] of Object.entries(this._roomsDataCache)) {
      if (!roomData || !roomData.seats) continue;
      for (const [seat, data] of Object.entries(roomData.seats)) {
        if (data && data.namauser === username) {
          foundSeats.push({ room: roomName, seat: parseInt(seat), roomData });
        }
      }
    }
    
    if (foundSeats.length > 1) {
      const keep = foundSeats[0];
      for (let i = 1; i < foundSeats.length; i++) {
        const { room, seat, roomData } = foundSeats[i];
        delete roomData.seats[seat];
        if (roomData.points) {
          delete roomData.points[seat];
        }
        this.broadcast(room, ["removeKursi", room, seat]);
        removed = true;
      }
      
      await this._saveToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber
      );
    }
    
    return removed;
  }

  // ============================================================
  // HANDLE JOIN - FIX TOTAL: SEMUA USER KEHILANGAN DATA
  // ============================================================
  async _handleJoin(ws, roomName) {
    if (!ws || !ws.username || !roomName || !ROOMS_SET.has(roomName) || this.closing || this.isDestroyed) {
      return false;
    }
    
    const username = ws.username;
    const seatInfo = this._userSeatDataCache[username];
    const isMulti = seatInfo ? (seatInfo.isMulti || false) : false;
    
    // 1. CLEANUP DUPLIKAT
    await this._cleanupDuplicateUser(username);
    
    // 2. CARI DAN HAPUS USER DARI SEMUA ROOM - FIX UNTUK SEMUA USER
    let oldRoom = null;
    let oldSeat = null;
    let oldRoomData = null;
    
    // CEK DARI CACHE USER SEAT DATA (UNTUK SEMUA USER)
    const seatInfoCache = this._userSeatDataCache[username];
    if (seatInfoCache && seatInfoCache.room) {
      oldRoom = seatInfoCache.room;
      oldSeat = seatInfoCache.seat;
      oldRoomData = this._roomsDataCache[oldRoom];
      
      // VERIFIKASI: Pastikan data benar-benar ada di room
      if (oldRoomData && oldRoomData.seats && oldRoomData.seats[oldSeat]) {
        // Data ditemukan di cache
      } else {
        // Cache tidak valid, reset
        oldRoom = null;
        oldSeat = null;
        oldRoomData = null;
        delete this._userSeatDataCache[username];
      }
    }
    
    // JIKA TIDAK DITEMUKAN DI CACHE, CEK SEMUA ROOM
    if (!oldRoom) {
      for (const [roomNameKey, roomData] of Object.entries(this._roomsDataCache)) {
        if (!roomData || !roomData.seats) continue;
        for (const [seat, data] of Object.entries(roomData.seats)) {
          // CEK: data.namauser ATAU data kosong dengan seatInfo di cache
          const isUserHere = 
            (data && data.namauser === username) ||
            (seatInfoCache && parseInt(seat) === seatInfoCache.seat && roomNameKey === seatInfoCache.room);
          
          if (isUserHere) {
            oldRoom = roomNameKey;
            oldSeat = parseInt(seat);
            oldRoomData = roomData;
            break;
          }
        }
        if (oldRoom) break;
      }
    }
    
    // 3. HAPUS DARI ROOM LAMA - TERMASUK HAPUS DARI CACHE DAN STORAGE
    if (oldRoom && oldSeat !== null && oldRoomData) {
      // HAPUS DARI ROOM
      delete oldRoomData.seats[oldSeat];
      if (oldRoomData.points) {
        delete oldRoomData.points[oldSeat];
      }
      
      // HAPUS DARI CACHE USER SEAT DATA
      if (this._userSeatDataCache[username]) {
        delete this._userSeatDataCache[username];
      }
      
      // HAPUS DARI ONLINE USERS
      if (this._onlineUsers.has(username)) {
        this._onlineUsers.delete(username);
      }
      
      // HAPUS ROOM JIKA KOSONG
      const hasSeats = oldRoomData.seats && Object.keys(oldRoomData.seats).length > 0;
      const hasPoints = oldRoomData.points && Object.keys(oldRoomData.points).length > 0;
      if (!hasSeats && !hasPoints) {
        delete this._roomsDataCache[oldRoom];
      }
      
      // BROADCAST HAPUS KURSI
      this.broadcast(oldRoom, ["removeKursi", oldRoom, oldSeat]);
      await this.updateRoomCount(oldRoom);
      
      // HAPUS DARI ROOM CLIENTS
      for (const [room, clients] of this.roomClients) {
        if (clients.has(ws)) {
          clients.delete(ws);
        }
      }
    }
    
    // 4. SIMPAN KE STORAGE - PASTIKAN DATA TERHAPUS DI STORAGE
    await this._saveToStorage(
      this._roomsDataCache,
      this._userSeatDataCache,
      this.currentNumber
    );
    
    // 5. TAMBAHKAN KE ROOM BARU
    let newRoomData = this._roomsDataCache[roomName];
    if (!newRoomData) {
      newRoomData = { seats: {}, points: {}, muted: false, number: 1 };
      this._roomsDataCache[roomName] = newRoomData;
    }
    
    const seatCount = Object.keys(newRoomData.seats).length;
    if (seatCount >= C.MAX_SEATS) {
      this.safeSend(ws, ["roomFull", roomName]);
      return false;
    }
    
    let newSeat = null;
    for (let s = 1; s <= C.MAX_SEATS; s++) {
      if (!newRoomData.seats[s]) {
        newSeat = s;
        break;
      }
    }
    
    if (!newSeat) {
      this.safeSend(ws, ["roomFull", roomName]);
      return false;
    }
    
    // ============================================================
    // ✅ KURSI KOSONG - TANPA DATA (SAMA UNTUK SEMUA USER)
    // ============================================================
    newRoomData.seats[newSeat] = {};
    
    // 6. SIMPAN KE STORAGE
    await this._saveToStorage(
      this._roomsDataCache,
      this._userSeatDataCache,
      this.currentNumber
    );
    
    // 7. UPDATE WEBSOCKET
    ws.serializeAttachment({
      username: username,
      room: roomName,
      seat: newSeat,
      isMulti: isMulti,
      multiRoom: isMulti ? roomName : null,
      multiSeat: isMulti ? newSeat : null,
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
    ws._multiSeat = isMulti ? newSeat : null;
    ws._closing = false;
    
    this._refreshRoomClients(true);
    
    // 8. KIRIM RESPONSE
    this.safeSend(ws, ["rooMasuk", newSeat, roomName]);
    this.safeSend(ws, ["numberKursiSaya", newSeat]);
    this.safeSend(ws, ["muteTypeResponse", newRoomData.muted || false, roomName]);
    this.safeSend(ws, ["serverVersion", this._version, this._deployTime]);
    
    const count = Object.keys(newRoomData.seats).length;
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
  }

  async _cleanupUserOnDisconnect(ws) {
    try {
      const username = ws.username || ws._cachedUsername;
      if (!username) return;
      
      const isMulti = ws._isMulti || false;
      const seatInfo = this._userSeatDataCache[username];
      const isMultiFromCache = seatInfo ? (seatInfo.isMulti || false) : false;
      
      if (isMulti || isMultiFromCache) {
        for (const [room, clients] of this.roomClients) {
          if (clients.has(ws)) {
            clients.delete(ws);
          }
        }
        this._refreshRoomClients(true);
        return;
      }
      
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
      
      this._refreshRoomClients(true);
      
    } catch(e) {}
  }

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
      }
    } catch(e) {}
  }

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
    } catch(e) {}
  }

  async webSocketClose(ws, code, reason, wasClean) {
    if (!ws) return;
    try {
      const isMulti = ws._isMulti || false;
      const username = ws._cachedUsername || ws.username;
      const seatInfo = username ? this._userSeatDataCache[username] : null;
      const isMultiFromCache = seatInfo ? (seatInfo.isMulti || false) : false;
      
      if (isMulti || isMultiFromCache) {
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
    } catch(e) {}
  }

  async webSocketError(ws, error) {
    if (!ws) return;
    try {
      const isMulti = ws._isMulti || false;
      const username = ws._cachedUsername || ws.username;
      const seatInfo = username ? this._userSeatDataCache[username] : null;
      const isMultiFromCache = seatInfo ? (seatInfo.isMulti || false) : false;
      
      if (isMulti || isMultiFromCache) {
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
    } catch(e) {}
  }

  async _handleSetId(ws, username, isNewUser) {
    if (!ws || !username || typeof username !== 'string' || username.length === 0 || this.closing || this.isDestroyed) {
      try { if (ws?.readyState === 1) ws.close(1000, "Invalid username"); } catch(e) {}
      return;
    }
    
    if (ws.readyState !== 1) return;
    
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
        
        case "setIdTarget2": {
          const username = args[0];
          const isNewUser = args[1];
          
          if (username) {
            const seatInfo = this._userSeatDataCache[username];
            
            if (seatInfo && seatInfo.isMulti && !isNewUser) {
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
              
              const roomClients = this.roomClients.get(seatInfo.room);
              if (roomClients) {
                roomClients.add(ws);
              }
              
              this.safeSend(ws, ["serverVersion", this._version, this._deployTime]);
              this._refreshRoomClients(true);
              return;
            }
            
            await this._removeUserFromAllRooms(username);
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
          
          roomData.seats[seat] = {};
          
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
          await this._saveToStorage(undefined, undefined, undefined);
          
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
      
      if (lastDeployVersion !== this._version) {
        // version changed
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
      
      await this._saveToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber
      );
      
      if (!this.closing && !this.isDestroyed) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        if (!existingAlarm) {
          this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        }
      }
      
    } catch(e) {} finally {
      this._isRestoring = false;
    }
  }

  async resetAllData() {
    const timestamp = Date.now();
    
    try {
      const multiUsersData = {};
      const multiUsersSeatInfo = {};
      
      for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
        if (seatInfo && seatInfo.isMulti) {
          multiUsersData[username] = seatInfo;
          
          const roomData = this._roomsDataCache[seatInfo.room];
          if (roomData && roomData.seats && roomData.seats[seatInfo.seat]) {
            multiUsersSeatInfo[seatInfo.room] = multiUsersSeatInfo[seatInfo.room] || {};
            multiUsersSeatInfo[seatInfo.room][seatInfo.seat] = roomData.seats[seatInfo.seat];
          }
        }
      }
      
      this._roomsDataCache = {};
      this._userSeatDataCache = {};
      this.currentNumber = 1;
      this._onlineUsers.clear();
      this._userCounts = {};
      for (const room of ROOMS) {
        this._userCounts[room] = 0;
      }
      
      for (const [username, seatInfo] of Object.entries(multiUsersData)) {
        this._userSeatDataCache[username] = seatInfo;
        this._onlineUsers.add(username);
        
        const roomName = seatInfo.room;
        const seatNumber = seatInfo.seat;
        
        if (!this._roomsDataCache[roomName]) {
          this._roomsDataCache[roomName] = { seats: {}, points: {}, muted: false, number: 1 };
        }
        
        if (multiUsersSeatInfo[roomName] && multiUsersSeatInfo[roomName][seatNumber]) {
          this._roomsDataCache[roomName].seats[seatNumber] = multiUsersSeatInfo[roomName][seatNumber];
        }
        
        this._userCounts[roomName] = (this._userCounts[roomName] || 0) + 1;
      }
      
      await this.ctx.storage.delete("roomsData");
      await this.ctx.storage.delete("userSeatData");
      await this.ctx.storage.delete("currentNumber");
      await this.ctx.storage.delete("userCounts");
      await this.ctx.storage.delete("onlineUsers");
      
      await this._saveToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber
      );
      
      await this.ctx.storage.put("lastDeployVersion", this._version);
      await this.ctx.storage.put("lastDeployTime", this._deployTime);
      await this.ctx.storage.put("lastReset", timestamp);
      
      const resetMessage = JSON.stringify(["serverReset", "Server di-reset pada: " + new Date(timestamp).toLocaleString()]);
      const multiResetMessage = JSON.stringify(["serverResetMulti", "Server di-reset, data multi user tetap dipertahankan"]);
      
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          if (ws.readyState === 1) {
            const isMulti = ws._isMulti || false;
            if (isMulti) {
              ws.send(multiResetMessage);
              ws.send(JSON.stringify(["serverVersion", this._version, this._deployTime]));
            } else {
              ws.send(resetMessage);
              ws.close(1000, "Server reset - " + timestamp);
            }
          }
        } catch(e) {}
      }
      
      this._refreshRoomClients(true);
      
      if (!this.closing && !this.isDestroyed) {
        await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      }
      
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
          environment: this._deployInfo.environment,
          versionTimestamp: this._deployInfo.timestamp,
          lastReset: await this.ctx.storage.get("lastReset") || null,
          roomsDataKeys: Object.keys(this._roomsDataCache),
          userSeatDataKeys: Object.keys(this._userSeatDataCache)
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
          timestamp: this._deployInfo.timestamp,
          versionNumber: this._deployInfo.version,
          fullVersion: this._version
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
      return new Response("Internal Server Error", { status: 500 });
    }
  }

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
