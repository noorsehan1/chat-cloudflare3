// ==================== CHAT-SERVER-FULL.js ====================
// VERSION: 10.8.1 - FIXED JOIN ROOM

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
    
    // ✅ Inisialisasi cache
    this._roomsDataCache = {};
    this._userSeatDataCache = {};
    this.currentNumber = 1;
    this._kursiNumber = {};
    
    // ✅ RESTORE: Load dari storage dulu, baru inisialisasi room
    this._restoreAllState().catch(() => {});
  }

  // ============ INITIALIZE ALL ROOMS ============
  
  _initializeAllRooms() {
    let changed = false;
    for (const room of ROOMS) {
      if (!this._roomsDataCache[room]) {
        this._roomsDataCache[room] = {
          seats: {},
          points: {},
          muted: false,
          number: 1
        };
        changed = true;
        console.log(`[INIT] Room ${room} created in cache`);
      }
    }
    return changed;
  }

  // ============ VALIDATION ============

  _isValidRoom(roomName) {
    return roomName && ROOMS_SET.has(roomName);
  }

  _isValidSeat(seatNumber) {
    return typeof seatNumber === 'number' && seatNumber >= 1 && seatNumber <= C.MAX_SEATS;
  }

  _getSeatKey(roomName, seatNumber) {
    return `${roomName}-${seatNumber}`;
  }

  // ============ CORE SYNC: STORAGE = CACHE ============

  // ✅ SYNC: Cache → Storage
  async _syncToStorage(roomsData, userSeatData, currentNumber, kursiNumber) {
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
        console.log(`[SYNC] Cache → Storage:`, Object.keys(updates));
      }
      return true;
    } catch(e) {
      console.error(`[SYNC ERROR]`, e.message);
      return false;
    }
  }

  // ✅ SYNC: Storage → Cache
  async _syncFromStorage() {
    try {
      const storage = await this.ctx.storage.get([
        "roomsData", 
        "userSeatData", 
        "currentNumber", 
        "kursiNumber"
      ]);
      
      // ✅ Load dari storage jika ada
      if (storage.roomsData !== undefined && Object.keys(storage.roomsData).length > 0) {
        this._roomsDataCache = storage.roomsData;
        console.log(`[SYNC] Loaded roomsData from storage (${Object.keys(this._roomsDataCache).length} rooms)`);
      } else {
        // ✅ Jika storage kosong, inisialisasi room
        console.log(`[SYNC] Storage empty, initializing rooms...`);
        this._initializeAllRooms();
        // ✅ Simpan ke storage
        await this._syncToStorage(this._roomsDataCache, undefined, undefined, undefined);
      }
      
      if (storage.userSeatData !== undefined) {
        this._userSeatDataCache = storage.userSeatData;
        console.log(`[SYNC] Loaded userSeatData from storage (${Object.keys(this._userSeatDataCache).length} users)`);
      }
      
      if (storage.currentNumber !== undefined) {
        this.currentNumber = storage.currentNumber;
        console.log(`[SYNC] Loaded currentNumber: ${this.currentNumber}`);
      }
      
      if (storage.kursiNumber !== undefined) {
        this._kursiNumber = storage.kursiNumber;
        console.log(`[SYNC] Loaded kursiNumber from storage (${Object.keys(this._kursiNumber).length} entries)`);
      }
      
      // ✅ Pastikan semua room ada
      const changed = this._initializeAllRooms();
      if (changed) {
        await this._syncToStorage(this._roomsDataCache, undefined, undefined, undefined);
      }
      
      return {
        roomsData: this._roomsDataCache,
        userSeatData: this._userSeatDataCache,
        currentNumber: this.currentNumber,
        kursiNumber: this._kursiNumber
      };
    } catch(e) {
      console.error(`[SYNC FROM STORAGE ERROR]`, e.message);
      // ✅ Jika error, inisialisasi room
      this._initializeAllRooms();
      await this._syncToStorage(this._roomsDataCache, undefined, undefined, undefined);
      return {
        roomsData: this._roomsDataCache,
        userSeatData: this._userSeatDataCache,
        currentNumber: this.currentNumber,
        kursiNumber: this._kursiNumber
      };
    }
  }

  // ============ RESTORE ============

  async _restoreAllState() {
    if (this._isRestoring) return;
    this._isRestoring = true;
    
    console.log(`[RESTORE] Starting restore...`);
    
    try {
      // ✅ 1. Load dari storage
      await this._syncFromStorage();
      
      // ✅ 2. Pastikan semua room ada (sudah dilakukan di _syncFromStorage)
      
      // ✅ 3. Restore WebSocket connections
      const webSockets = this.ctx.getWebSockets();
      console.log(`[RESTORE] Found ${webSockets.length} active WebSockets`);
      
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
              
              console.log(`[RESTORE] Restored WebSocket for ${attachment.username} in ${roomName} seat ${seatNumber}`);
            }
          }
        } catch(e) {
          console.error(`[RESTORE] WebSocket restore error:`, e.message);
        }
      }
      
      // ✅ 4. Update user counts
      await this._updateUserCounts();
      
      // ✅ 5. Set alarm
      if (!this.closing && !this.isDestroyed) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        if (!existingAlarm) {
          await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
          console.log(`[RESTORE] Alarm set`);
        }
      }
      
      console.log(`[RESTORE] Restore completed successfully`);
      console.log(`[RESTORE] Rooms: ${Object.keys(this._roomsDataCache).join(', ')}`);
      
    } catch(e) {
      console.error(`[RESTORE] Restore failed:`, e.message);
    } finally {
      this._isRestoring = false;
    }
  }

  // ============ WAKE UP ============

  async wakeUp() {
    console.log(`[WAKE UP] ChatServer waking up...`);
    await this._restoreAllState();
    
    const wakeMessage = JSON.stringify(["serverWakeUp", "Server is awake"]);
    const webSockets = this._getActiveWebSockets();
    for (const ws of webSockets) {
      try {
        if (ws.readyState === 1) {
          ws.send(wakeMessage);
        }
      } catch(e) {}
    }
    
    console.log(`[WAKE UP] Notified ${webSockets.length} clients`);
  }

  // ============ JOIN HANDLING ============

  async _handleJoin(ws, roomName) {
    console.log(`[JOIN] Attempting join: ${ws?.username} to ${roomName}`);
    
    // ✅ Validasi
    if (!ws) {
      console.error(`[JOIN] WebSocket is null`);
      return false;
    }
    
    if (!ws.username) {
      console.error(`[JOIN] Username is null`);
      return false;
    }
    
    if (!roomName) {
      console.error(`[JOIN] Room name is null`);
      return false;
    }
    
    if (!this._isValidRoom(roomName)) {
      console.error(`[JOIN] Invalid room: ${roomName}`);
      this.safeSend(ws, ["error", `Room ${roomName} tidak valid`]);
      return false;
    }
    
    if (this.closing || this.isDestroyed) {
      console.error(`[JOIN] Server is closing or destroyed`);
      return false;
    }
    
    const username = ws.username;
    
    try {
      // ✅ 1. Pastikan room ada di cache
      if (!this._roomsDataCache[roomName]) {
        console.log(`[JOIN] Room ${roomName} not in cache, initializing...`);
        this._initializeAllRooms();
        await this._syncToStorage(this._roomsDataCache, undefined, undefined, undefined);
      }
      
      // ✅ 2. Hapus user dari semua room
      await this._removeUserFromAllRooms(username);
      
      // ✅ 3. Sync dari storage
      await this._syncFromStorage();
      
      // ✅ 4. Hapus sisa data di cache
      if (this._userSeatDataCache[username]) {
        delete this._userSeatDataCache[username];
      }
      
      // ✅ 5. Bersihkan kursi number yang tersisa
      for (const key of Object.keys(this._kursiNumber)) {
        const [room, seat] = key.split('-');
        if (this._roomsDataCache[room]?.seats?.[parseInt(seat)]?.namauser === username) {
          delete this._kursiNumber[key];
        }
      }
      
      // ✅ 6. Sync perubahan
      await this._syncToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber,
        this._kursiNumber
      );
      
      // ✅ 7. Ambil room data
      const roomData = this._roomsDataCache[roomName];
      if (!roomData) {
        console.error(`[JOIN] Room data not found after init: ${roomName}`);
        this._initializeAllRooms();
        await this._syncToStorage(this._roomsDataCache, undefined, undefined, undefined);
        return false;
      }
      
      console.log(`[JOIN] Room data found: ${roomName}, seats: ${Object.keys(roomData.seats).length}`);
      
      // ✅ 8. Cek kapasitas
      if (Object.keys(roomData.seats).length >= C.MAX_SEATS) {
        console.log(`[JOIN] Room ${roomName} is full`);
        this.safeSend(ws, ["roomFull", roomName]);
        return false;
      }
      
      // ✅ 9. Cari seat kosong
      let seat = null;
      for (let s = 1; s <= C.MAX_SEATS; s++) {
        if (!roomData.seats[s]) {
          seat = s;
          break;
        }
      }
      
      if (!seat) {
        console.log(`[JOIN] No available seat in ${roomName}`);
        this.safeSend(ws, ["roomFull", roomName]);
        return false;
      }
      
      console.log(`[JOIN] Found empty seat: ${seat} in ${roomName}`);
      
      // ✅ 10. Assign seat
      roomData.seats[seat] = {};
      const key = this._getSeatKey(roomName, seat);
      this._kursiNumber[key] = seat;
      
      if (roomData.points && roomData.points[seat]) {
        delete roomData.points[seat];
      }
      
      // ✅ 11. Sync ke storage
      await this._syncToStorage(this._roomsDataCache, undefined, undefined, this._kursiNumber);
      
      // ✅ 12. Update WebSocket
      await this._updateWebSocketRoom(ws, roomName, username, seat, false);
      
      // ✅ 13. Kirim response
      this.safeSend(ws, ["rooMasuk", seat, roomName]);
      this.safeSend(ws, ["numberKursiSaya", seat]);
      this.safeSend(ws, ["muteTypeResponse", roomData.muted || false, roomName]);
      
      const count = Object.keys(roomData.seats).length;
      this.safeSend(ws, ["roomUserCount", roomName, count]);
      this.broadcast(roomName, ["roomUserCount", roomName, count]);
      
      // ✅ 14. Kirim state room setelah delay
      setTimeout(() => {
        try {
          if (ws && ws.readyState === 1) {
            this.sendAllStateTo(ws, roomName, true);
          }
        } catch(e) {}
      }, 1000);
      
      // ✅ 15. Sync verifikasi
      await this._syncFromStorage();
      
      console.log(`[JOIN] ✅ ${username} successfully joined ${roomName} seat ${seat}`);
      return true;
      
    } catch(e) {
      console.error(`[JOIN ERROR] ${e.message}`, e.stack);
      this.safeSend(ws, ["error", `Join failed: ${e.message}`]);
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
      
      this._userSeatDataCache[username] = seatInfo;
      
      await this._syncToStorage(undefined, this._userSeatDataCache, undefined, undefined);
      await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      
      console.log(`[WS UPDATE] ${username} updated to room ${roomName} seat ${seat}`);
      return true;
    } catch(e) {
      console.error(`[WS UPDATE ERROR]`, e.message);
      return false;
    }
  }

  // ============ REMOVE USER FROM ALL ROOMS ============

  async _removeUserFromAllRooms(username) {
    if (!username) return false;
    
    let removed = false;
    let roomsAffected = [];
    
    try {
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
          
          const key = this._getSeatKey(roomName, seatToRemove);
          if (this._kursiNumber[key]) {
            delete this._kursiNumber[key];
          }
          
          removed = true;
          roomsAffected.push(roomName);
          this.broadcast(roomName, ["removeKursi", roomName, seatToRemove]);
        }
      }
      
      if (this._userSeatDataCache[username]) {
        delete this._userSeatDataCache[username];
      }
      
      if (removed) {
        await this._syncToStorage(
          this._roomsDataCache,
          this._userSeatDataCache,
          this.currentNumber,
          this._kursiNumber
        );
        await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
        await this._updateUserCounts();
        await this._syncFromStorage();
      }
      
      return removed;
    } catch(e) {
      console.error(`[REMOVE USER ERROR]`, e.message);
      return removed;
    }
  }

  // ============ OTHER FUNCTIONS ============

  _getActiveWebSockets() {
    try {
      return this.ctx.getWebSockets();
    } catch(e) {
      return [];
    }
  }

  _getRoomCount(roomName) {
    try {
      if (!this._isValidRoom(roomName)) return 0;
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

  broadcast(room, msg) {
    if (this.closing || this.isDestroyed || !room || !msg) return;
    try {
      const msgStr = JSON.stringify(msg);
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          if (ws.readyState !== 1 || ws._closing) continue;
          let wsRoom = ws._cachedRoom || ws.room || ws.roomname;
          if (wsRoom === room) {
            ws.send(msgStr);
          }
        } catch(e) {}
      }
    } catch(e) {}
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
    } catch(e) {
      console.error(`[SEND STATE ERROR]`, e.message);
    }
  }

  // ============ ALARM ============

  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    console.log(`[ALARM] Running scheduled tasks...`);
    
    try {
      await this._syncFromStorage();
      await this._updateNumber();
      await this._checkMultiUsers();
      await this._cleanupStorage();
      await this._syncToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber,
        this._kursiNumber
      );
    } catch(e) {
      console.error(`[ALARM ERROR]`, e.message);
    }
    
    if (!this.closing && !this.isDestroyed) {
      try {
        await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      } catch(e) {}
    }
  }

  async _updateNumber() {
    if (this._isNumberUpdating || this.closing || this.isDestroyed) return;
    this._isNumberUpdating = true;
    
    try {
      this.currentNumber = this.currentNumber < C.MAX_NUMBER ? this.currentNumber + 1 : 1;
      await this._syncToStorage(undefined, undefined, this.currentNumber, undefined);
      
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
      console.error(`[NUMBER ERROR]`, e.message);
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
        if (!seatInfo || !seatInfo.room) {
          delete this._userSeatDataCache[username];
          changed = true;
          continue;
        }
        
        if (!usersWithSeats.has(username) && !seatInfo.isMulti) {
          delete this._userSeatDataCache[username];
          changed = true;
        }
      }
      
      if (changed) {
        await this._syncToStorage(undefined, this._userSeatDataCache, undefined, undefined);
        await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      }
    } catch(e) {
      console.error(`[MULTI CHECK ERROR]`, e.message);
    }
  }

  async _cleanupStorage() {
    try {
      await this._syncFromStorage();
      
      let changed = false;
      const webSockets = this._getActiveWebSockets();
      const connectedUsers = new Set();
      
      for (const ws of webSockets) {
        try {
          const uname = ws._cachedUsername || ws.username || ws.deserializeAttachment()?.username;
          if (uname && ws.readyState === 1) {
            connectedUsers.add(uname);
          }
        } catch(e) {}
      }
      
      for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
        if (!connectedUsers.has(username) && !seatInfo.isMulti) {
          delete this._userSeatDataCache[username];
          changed = true;
        }
      }
      
      for (const key of Object.keys(this._kursiNumber)) {
        const [roomName, seat] = key.split('-');
        if (!this._roomsDataCache[roomName] || 
            !this._roomsDataCache[roomName].seats || 
            !this._roomsDataCache[roomName].seats[parseInt(seat)]) {
          delete this._kursiNumber[key];
          changed = true;
        }
      }
      
      if (changed) {
        await this._syncToStorage(
          this._roomsDataCache,
          this._userSeatDataCache,
          this.currentNumber,
          this._kursiNumber
        );
      }
    } catch(e) {
      console.error(`[CLEANUP ERROR]`, e.message);
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
      console.error(`[WS MESSAGE ERROR]`, e.message);
    }
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
          await this._syncToStorage(undefined, this._userSeatDataCache, undefined, undefined);
        }
        return;
      }
      
      if (hasSeat && !isMulti) {
        await this.ctx.storage.put("onlineUsers", this._getOnlineUsers());
      }
    } catch(e) {
      console.error(`[CLEANUP DISCONNECT ERROR]`, e.message);
    } finally {
      ws._isCleaningUp = false;
    }
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
        delete this._userSeatDataCache[username];
      }
      
      await this._syncToStorage(
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
    } catch(e) {
      console.error(`[SET ID ERROR]`, e.message);
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
      console.error(`[HANDLE MESSAGE ERROR]`, e.message);
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
                await this._syncToStorage(undefined, this._userSeatDataCache, undefined, undefined);
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
        
        case "joinRoom":
          console.log(`[EVENT] joinRoom: ${args[0]}`);
          await this._handleJoin(ws, args[0]);
          break;
        
        default:
          console.log(`[EVENT] Unknown: ${evt}`);
          this.safeSend(ws, ["error", `Unknown event: ${evt}`]);
          break;
      }
    } catch(e) {
      console.error(`[EVENT ERROR]`, e.message);
    }
  }

  // ============ RESET ALL DATA ============

  async resetAllData() {
    const timestamp = Date.now();
    
    try {
      console.log(`[RESET] Starting reset...`);
      
      this._roomsDataCache = {};
      this._userSeatDataCache = {};
      this.currentNumber = 1;
      this._kursiNumber = {};
      
      this._initializeAllRooms();
      
      await this.ctx.storage.delete("roomsData");
      await this.ctx.storage.delete("userSeatData");
      await this.ctx.storage.delete("currentNumber");
      await this.ctx.storage.delete("userCounts");
      await this.ctx.storage.delete("onlineUsers");
      await this.ctx.storage.delete("kursiNumber");
      
      await this._syncToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber,
        this._kursiNumber
      );
      
      const resetMessage = JSON.stringify(["serverReset", "Server di-reset pada: " + new Date(timestamp).toLocaleString()]);
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          if (ws.readyState === 1) {
            ws.send(resetMessage);
            ws.close(1000, "Server reset - " + timestamp);
          }
        } catch(e) {}
      }
      
      if (!this.closing && !this.isDestroyed) {
        await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      }
      
      await this.ctx.storage.put("lastReset", timestamp);
      
      return {
        success: true,
        message: "Semua data berhasil direset",
        timestamp: timestamp,
        resetTime: new Date(timestamp).toLocaleString()
      };
    } catch(e) {
      console.error(`[RESET ERROR]`, e.message);
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
      
      if (url.pathname === "/wake") {
        await this.wakeUp();
        return new Response("Server woke up", { status: 200 });
      }
      
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
          uptime: Date.now() - this._startTime,
          cacheSize: {
            roomsData: Object.keys(this._roomsDataCache).length,
            userSeatData: Object.keys(this._userSeatDataCache).length,
            kursiNumber: Object.keys(this._kursiNumber).length
          }
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
        return new Response("Chat Server", { 
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
      console.error(`[FETCH ERROR]`, e.message);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // ============ DESTROY ============

  async destroy() {
    if (this.isDestroyed) return;
    this.closing = true;
    this.isDestroyed = true;
    
    console.log(`[DESTROY] Shutting down...`);
    
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
    
    console.log(`[DESTROY] Shutdown complete`);
  }
}

export default ChatServer;
