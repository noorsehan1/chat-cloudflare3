// ==================== CHAT-SERVER-REAL-TIME-STORAGE.JS ====================
// VERSION: Auto-generated with timestamp
// DEPLOY: Auto-generated
// SUPPORTS CLOUDFLARE HIBERNATION

const C = {
  MAX_SEATS: 45,
  MAX_GLOBAL_CONNECTIONS: 150,
  MAX_MESSAGE_SIZE: 5000,
  NUMBER_INTERVAL_MS: 900000,
  MAX_NUMBER: 6,
  // Interval untuk menyimpan state ke storage (5 detik)
  STATE_PERSIST_INTERVAL_MS: 5000,
  // Hibernation timeout (30 detik)
  HIBERNATION_TIMEOUT_MS: 30000,
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
    
    // Flag untuk hibernasi
    this._isHibernating = false;
    this._lastActivityTime = Date.now();
    this._hibernationTimer = null;
    this._persistTimer = null;
    this._isRestoring = false;
    
    this._version = SERVER_VERSION;
    this._deployInfo = DEPLOY_VERSION;
    this._deployTime = DEPLOY_VERSION.deployDate;
    
    this.roomClients = new Map();
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    this.currentNumber = 1;
    this._onlineUsers = new Set();
    this._userCounts = {};
    for (const room of ROOMS) {
      this._userCounts[room] = 0;
    }
    
    this._isNumberUpdating = false;
    this._lastRefreshTime = 0;
    
    // Data untuk hibernasi
    this._roomsDataCache = null;
    this._userSeatDataCache = null;
    this._lastPersistTime = 0;
    
    // Inisialisasi dari storage
    this._initFromStorage().then(() => {
      this._startHibernationTimer();
      this._startPersistTimer();
    });
    this._autoResetOnDeploy().then(() => {});
  }

  // ============================================================
  // HIBERNATION MANAGEMENT
  // ============================================================
  
  _startHibernationTimer() {
    if (this._hibernationTimer) {
      clearTimeout(this._hibernationTimer);
    }
    
    this._hibernationTimer = setTimeout(() => {
      this._checkHibernation();
    }, C.HIBERNATION_TIMEOUT_MS);
  }

  _resetHibernationTimer() {
    this._lastActivityTime = Date.now();
    if (this._isHibernating) {
      this._wakeFromHibernation();
    }
    this._startHibernationTimer();
  }

  async _checkHibernation() {
    if (this.closing || this.isDestroyed) return;
    
    const now = Date.now();
    const inactiveTime = now - this._lastActivityTime;
    
    // Cek apakah tidak ada aktivitas dan tidak ada koneksi aktif
    const webSockets = this._getActiveWebSockets();
    const hasActiveConnections = webSockets.some(ws => ws.readyState === 1);
    
    if (inactiveTime > C.HIBERNATION_TIMEOUT_MS && !hasActiveConnections && !this._isHibernating) {
      await this._enterHibernation();
    } else if (hasActiveConnections) {
      this._lastActivityTime = now;
      this._startHibernationTimer();
    } else {
      this._startHibernationTimer();
    }
  }

  async _enterHibernation() {
    if (this._isHibernating || this.closing || this.isDestroyed) return;
    
    console.log('Entering hibernation mode...');
    this._isHibernating = true;
    
    // Simpan semua state ke storage sebelum hibernasi
    await this._persistStateToStorage();
    
    // Bersihkan memory yang tidak perlu
    this._roomsDataCache = null;
    this._userSeatDataCache = null;
    
    // Hapus timer persist
    if (this._persistTimer) {
      clearInterval(this._persistTimer);
      this._persistTimer = null;
    }
    
    // Batalkan alarm jika ada
    try {
      await this.ctx.storage.deleteAlarm();
    } catch(e) {}
    
    // Simpan flag hibernasi
    await this.ctx.storage.put("_hibernating", true);
    await this.ctx.storage.put("_hibernationStart", Date.now());
  }

  async _wakeFromHibernation() {
    if (!this._isHibernating) return;
    
    console.log('Waking from hibernation...');
    this._isHibernating = false;
    this._lastActivityTime = Date.now();
    
    // Restore state dari storage
    await this._restoreFromStorage();
    
    // Hapus flag hibernasi
    await this.ctx.storage.delete("_hibernating");
    await this.ctx.storage.delete("_hibernationStart");
    
    // Restart timers
    this._startPersistTimer();
    this._startHibernationTimer();
    
    // Set alarm
    if (!this.closing && !this.isDestroyed) {
      try {
        await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      } catch(e) {}
    }
    
    // Refresh room clients
    this._refreshRoomClients(true);
  }

  async _persistStateToStorage() {
    try {
      // Kumpulkan data dari memory
      const roomsData = await this._getRoomsData();
      const userSeatData = await this._getUserSeatData();
      
      // Simpan ke storage dengan atomic write
      await this.ctx.storage.put({
        "_persist_roomsData": roomsData,
        "_persist_userSeatData": userSeatData,
        "_persist_currentNumber": this.currentNumber,
        "_persist_userCounts": this._userCounts,
        "_persist_onlineUsers": Array.from(this._onlineUsers),
        "_persist_timestamp": Date.now()
      });
      
      this._lastPersistTime = Date.now();
      
    } catch(e) {
      console.error('Failed to persist state:', e);
    }
  }

  async _restoreFromStorage() {
    try {
      const persisted = await this.ctx.storage.get([
        "_persist_roomsData",
        "_persist_userSeatData",
        "_persist_currentNumber",
        "_persist_userCounts",
        "_persist_onlineUsers"
      ]);
      
      if (persisted && persisted["_persist_roomsData"]) {
        // Restore rooms data
        await this.ctx.storage.put("roomsData", persisted["_persist_roomsData"]);
        await this.ctx.storage.put("userSeatData", persisted["_persist_userSeatData"]);
        await this.ctx.storage.put("currentNumber", persisted["_persist_currentNumber"] || 1);
        await this.ctx.storage.put("userCounts", persisted["_persist_userCounts"] || {});
        await this.ctx.storage.put("onlineUsers", persisted["_persist_onlineUsers"] || []);
        
        // Update memory
        this.currentNumber = persisted["_persist_currentNumber"] || 1;
        this._userCounts = persisted["_persist_userCounts"] || {};
        this._onlineUsers = new Set(persisted["_persist_onlineUsers"] || []);
        
        // Hapus data persist
        await this.ctx.storage.delete([
          "_persist_roomsData",
          "_persist_userSeatData",
          "_persist_currentNumber",
          "_persist_userCounts",
          "_persist_onlineUsers",
          "_persist_timestamp"
        ]);
        
        console.log('State restored from hibernation');
      }
      
    } catch(e) {
      console.error('Failed to restore from hibernation:', e);
    }
  }

  _startPersistTimer() {
    if (this._persistTimer) {
      clearInterval(this._persistTimer);
    }
    
    this._persistTimer = setInterval(() => {
      if (!this._isHibernating && !this.closing && !this.isDestroyed) {
        this._persistStateToStorage();
      }
    }, C.STATE_PERSIST_INTERVAL_MS);
  }

  // ============================================================
  // AUTO RESET ON DEPLOY
  // ============================================================
  async _autoResetOnDeploy() {
    try {
      // Cek apakah sedang hibernasi
      const isHibernating = await this.ctx.storage.get("_hibernating");
      if (isHibernating) {
        this._isHibernating = true;
        await this._wakeFromHibernation();
        return;
      }
      
      const storedVersion = await this.ctx.storage.get("lastDeployVersion");
      
      if (storedVersion !== this._version) {
        // HAPUS SEMUA DATA DI STORAGE
        await this.ctx.storage.delete("roomsData");
        await this.ctx.storage.delete("userSeatData");
        await this.ctx.storage.delete("currentNumber");
        await this.ctx.storage.delete("userCounts");
        await this.ctx.storage.delete("onlineUsers");
        await this.ctx.storage.delete("lastReset");
        
        // Hapus data persist
        await this.ctx.storage.delete([
          "_persist_roomsData",
          "_persist_userSeatData",
          "_persist_currentNumber",
          "_persist_userCounts",
          "_persist_onlineUsers",
          "_persist_timestamp",
          "_hibernating",
          "_hibernationStart"
        ]);
        
        // RESET MEMORY
        this.currentNumber = 1;
        this._onlineUsers.clear();
        this._userCounts = {};
        for (const room of ROOMS) {
          this._userCounts[room] = 0;
        }
        for (const room of ROOMS) {
          this.roomClients.set(room, new Set());
        }
        
        // SIMPAN VERSION BARU
        await this.ctx.storage.put("lastDeployVersion", this._version);
        await this.ctx.storage.put("lastDeployTime", this._deployTime);
        await this.ctx.storage.put("lastReset", Date.now());
        
        // SET ALARM
        if (!this.closing && !this.isDestroyed) {
          await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        }
        
        // KIRIM NOTIF KE SEMUA WEBSOCKET
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
      }
      
    } catch(e) {
      console.error('Auto reset on deploy error:', e);
    }
  }

  // ============================================================
  // INITIALIZE FROM STORAGE
  // ============================================================
  async _initFromStorage() {
    if (this._isRestoring) return;
    this._isRestoring = true;
    
    try {
      // Cek apakah ada data persist dari hibernasi
      const persistedTimestamp = await this.ctx.storage.get("_persist_timestamp");
      const isHibernating = await this.ctx.storage.get("_hibernating");
      
      if (isHibernating) {
        this._isHibernating = true;
        await this._wakeFromHibernation();
        this._isRestoring = false;
        return;
      }
      
      // Load data normal
      const roomsData = await this.ctx.storage.get("roomsData") || {};
      const userSeatData = await this.ctx.storage.get("userSeatData") || {};
      const currentNumber = await this.ctx.storage.get("currentNumber") || 1;
      const userCounts = await this.ctx.storage.get("userCounts") || {};
      const onlineUsers = await this.ctx.storage.get("onlineUsers") || [];
      
      this.currentNumber = currentNumber;
      this._userCounts = userCounts;
      this._onlineUsers = new Set(onlineUsers);
      
      // Restore WebSocket attachments
      const webSockets = this.ctx.getWebSockets();
      for (const ws of webSockets) {
        try {
          const attachment = ws.deserializeAttachment();
          if (attachment && attachment.username) {
            const userSeat = userSeatData[attachment.username];
            if (userSeat) {
              ws.username = attachment.username;
              ws.room = userSeat.room;
              ws.roomname = userSeat.room;
              ws.idtarget = attachment.username;
              ws._closing = false;
              ws._isMulti = userSeat.isMulti || false;
              ws._multiRoom = userSeat.isMulti ? userSeat.room : null;
              ws._multiSeat = userSeat.isMulti ? userSeat.seat : null;
              ws._cachedUsername = attachment.username;
              ws._cachedRoom = userSeat.room;
              
              ws.serializeAttachment({
                username: attachment.username,
                room: userSeat.room,
                seat: userSeat.seat,
                isMulti: userSeat.isMulti || false,
                multiRoom: userSeat.isMulti ? userSeat.room : null,
                multiSeat: userSeat.isMulti ? userSeat.seat : null,
                seatInfo: userSeat,
                serverVersion: this._version,
                serverDeploy: this._deployTime
              });
            }
          }
        } catch(e) {}
      }
      
      this._refreshRoomClients(true);
      
      if (!this.closing && !this.isDestroyed) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        if (!existingAlarm) {
          this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        }
      }
      
    } catch(e) {
      console.error('Init from storage error:', e);
    } finally {
      this._isRestoring = false;
    }
  }

  // ============================================================
  // GET DATA FROM STORAGE (dengan caching)
  // ============================================================
  async _getRoomsData() {
    // Gunakan cache jika tersedia dan tidak hibernasi
    if (this._roomsDataCache && !this._isHibernating) {
      return this._roomsDataCache;
    }
    const data = await this.ctx.storage.get("roomsData") || {};
    if (!this._isHibernating) {
      this._roomsDataCache = data;
    }
    return data;
  }

  async _getUserSeatData() {
    if (this._userSeatDataCache && !this._isHibernating) {
      return this._userSeatDataCache;
    }
    const data = await this.ctx.storage.get("userSeatData") || {};
    if (!this._isHibernating) {
      this._userSeatDataCache = data;
    }
    return data;
  }

  async _getCurrentNumber() {
    return await this.ctx.storage.get("currentNumber") || 1;
  }

  async _getUserCounts() {
    return await this.ctx.storage.get("userCounts") || {};
  }

  async _getOnlineUsers() {
    return await this.ctx.storage.get("onlineUsers") || [];
  }

  // ============================================================
  // SAVE TO STORAGE
  // ============================================================
  async _saveToStorage(roomsData, userSeatData, currentNumber) {
    // Reset hibernation timer karena ada aktivitas
    this._resetHibernationTimer();
    
    try {
      const updates = {};
      
      if (roomsData !== undefined) {
        updates.roomsData = roomsData;
        this._roomsDataCache = roomsData;
      }
      
      if (userSeatData !== undefined) {
        updates.userSeatData = userSeatData;
        this._userSeatDataCache = userSeatData;
      }
      
      if (currentNumber !== undefined) {
        this.currentNumber = currentNumber;
        updates.currentNumber = currentNumber;
      }
      
      updates.lastDeployVersion = this._version;
      updates.lastDeployTime = this._deployTime;
      
      const currentRoomsData = roomsData || await this._getRoomsData();
      const userCounts = {};
      let totalUsers = 0;
      for (const room of ROOMS) {
        const roomData = currentRoomsData[room];
        const count = roomData?.seats ? Object.keys(roomData.seats).length : 0;
        userCounts[room] = count;
        totalUsers += count;
      }
      this._userCounts = userCounts;
      updates.userCounts = userCounts;
      
      const currentUserSeatData = userSeatData || await this._getUserSeatData();
      const onlineUsers = Object.keys(currentUserSeatData);
      this._onlineUsers = new Set(onlineUsers);
      updates.onlineUsers = onlineUsers;
      
      if (Object.keys(updates).length > 0) {
        await this.ctx.storage.put(updates);
        this._lastPersistTime = Date.now();
      }
      
      return {
        roomsData: currentRoomsData,
        userSeatData: currentUserSeatData,
        currentNumber: this.currentNumber,
        userCounts: this._userCounts,
        onlineUsers: onlineUsers
      };
      
    } catch(e) {
      throw e;
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

  // ============================================================
  // HANDLE JOIN - FIX MULTI USER
  // ============================================================
  async _handleJoin(ws, roomName) {
    if (!ws || !ws.username || !roomName || !ROOMS_SET.has(roomName) || this.closing || this.isDestroyed) {
      return false;
    }
    
    // Reset hibernation timer
    this._resetHibernationTimer();
    
    const username = ws.username;
    
    // 1. GET DATA LANGSUNG DARI STORAGE
    let roomsData = await this._getRoomsData();
    let userSeatData = await this._getUserSeatData();
    const currentNumber = await this._getCurrentNumber();
    this.currentNumber = currentNumber;
    
    const seatInfo = userSeatData[username];
    const isMulti = seatInfo ? (seatInfo.isMulti || false) : false;
    
    // 2. CLEANUP DUPLIKAT - PERBAIKAN UNTUK MULTI USER
    let oldRoom = null;
    let oldSeat = null;
    
    // CEK DARI USER SEAT DATA (UNTUK SEMUA USER)
    if (seatInfo && seatInfo.room) {
      oldRoom = seatInfo.room;
      oldSeat = seatInfo.seat;
    }
    
    // JIKA TIDAK DITEMUKAN, CEK DARI WEBSOCKET (UNTUK MULTI USER)
    if (!oldRoom) {
      if (ws._isMulti && ws._multiRoom && ws._multiSeat) {
        oldRoom = ws._multiRoom;
        oldSeat = ws._multiSeat;
      }
    }
    
    // JIKA TIDAK DITEMUKAN, CEK SEMUA ROOM (UNTUK USER NORMAL)
    if (!oldRoom) {
      for (const [roomNameKey, roomData] of Object.entries(roomsData)) {
        if (!roomData || !roomData.seats) continue;
        for (const [seat, data] of Object.entries(roomData.seats)) {
          const isUserHere = 
            (data && data.namauser === username) ||
            (seatInfo && parseInt(seat) === seatInfo.seat && roomNameKey === seatInfo.room);
          
          if (isUserHere) {
            oldRoom = roomNameKey;
            oldSeat = parseInt(seat);
            break;
          }
        }
        if (oldRoom) break;
      }
    }
    
    // 3. HAPUS DARI ROOM LAMA DI STORAGE
    if (oldRoom && oldSeat !== null && roomsData[oldRoom]) {
      const roomData = roomsData[oldRoom];
      
      // HAPUS KURSI
      delete roomData.seats[oldSeat];
      if (roomData.points) {
        delete roomData.points[oldSeat];
      }
      
      // HAPUS DARI USER SEAT DATA
      if (userSeatData[username]) {
        delete userSeatData[username];
      }
      
      // HAPUS DARI ONLINE USERS
      if (this._onlineUsers.has(username)) {
        this._onlineUsers.delete(username);
      }
      
      // HAPUS ROOM JIKA KOSONG
      const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
      const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
      if (!hasSeats && !hasPoints) {
        delete roomsData[oldRoom];
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
    
    // 4. SIMPAN PERUBAHAN KE STORAGE
    await this._saveToStorage(roomsData, userSeatData, this.currentNumber);
    
    // 5. TAMBAHKAN KE ROOM BARU DI STORAGE
    let newRoomData = roomsData[roomName];
    if (!newRoomData) {
      newRoomData = { seats: {}, points: {}, muted: false, number: 1 };
      roomsData[roomName] = newRoomData;
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
    
    // KURSI KOSONG
    newRoomData.seats[newSeat] = {};
    
    // 6. UPDATE USER SEAT DATA DI STORAGE
    userSeatData[username] = {
      room: roomName,
      seat: newSeat,
      isMulti: isMulti,
      multiRoom: isMulti ? roomName : null,
      multiSeat: isMulti ? newSeat : null
    };
    
    // 7. SIMPAN KE STORAGE
    await this._saveToStorage(roomsData, userSeatData, this.currentNumber);
    
    // 8. UPDATE WEBSOCKET
    ws.serializeAttachment({
      username: username,
      room: roomName,
      seat: newSeat,
      isMulti: isMulti,
      multiRoom: isMulti ? roomName : null,
      multiSeat: isMulti ? newSeat : null,
      seatInfo: userSeatData[username],
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
    
    // 9. KIRIM RESPONSE
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

  // ... (metode lainnya sama seperti sebelumnya, dengan penambahan _resetHibernationTimer() di setiap operasi)

  // ============================================================
  // WEBSOCKET EVENTS - dengan reset hibernation
  // ============================================================
  async webSocketMessage(ws, message) {
    if (!ws || ws._closing || this.closing || this.isDestroyed) return;
    
    // Reset hibernation timer karena ada aktivitas
    this._resetHibernationTimer();
    
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
          const userSeatData = await this._getUserSeatData();
          userSeatData[attachment.username] = attachment.seatInfo;
          await this._saveToStorage(undefined, userSeatData, undefined);
        }
      }
      
      await this.handleMessage(ws, message);
    } catch(e) {}
  }

  // ============================================================
  // ALARM
  // ============================================================
  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    // Jangan jalankan alarm jika hibernasi
    if (this._isHibernating) {
      return;
    }
    
    // Reset hibernation timer
    this._resetHibernationTimer();
    
    await this._updateNumber();
    await this._cleanupStorage();
    
    if (!this.closing && !this.isDestroyed) {
      this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
    }
  }

  // ============================================================
  // DESTROY - dengan persist terakhir
  // ============================================================
  async destroy() {
    if (this.isDestroyed) return;
    this.closing = true;
    this.isDestroyed = true;
    
    // Persist state terakhir sebelum destroy
    await this._persistStateToStorage();
    
    // Hapus timers
    if (this._hibernationTimer) {
      clearTimeout(this._hibernationTimer);
      this._hibernationTimer = null;
    }
    if (this._persistTimer) {
      clearInterval(this._persistTimer);
      this._persistTimer = null;
    }
    
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

  // ============================================================
  // FETCH - dengan penanganan hibernasi
  // ============================================================
  async fetch(req) {
    if (this.closing || this.isDestroyed) {
      return new Response("Shutting down", { status: 503 });
    }
    
    // Jika hibernasi, wake up
    if (this._isHibernating) {
      await this._wakeFromHibernation();
    }
    
    // Reset hibernation timer
    this._resetHibernationTimer();
    
    try {
      const url = new URL(req.url);
      
      // ... (semua endpoint sama seperti sebelumnya)
      
      const upgrade = req.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        return new Response("Chat Server - Real-time Storage", { 
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
}

export default ChatServer;
