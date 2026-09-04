// ==================== CHAT-SERVER-FULL.js ====================
// VERSION: 10.8.0 - STORAGE = CACHE (FULL SYNC)

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
    
    // ✅ Inisialisasi cache kosong
    this._roomsDataCache = {};
    this._userSeatDataCache = {};
    this.currentNumber = 1;
    this._kursiNumber = {};
    
    // ✅ Inisialisasi semua room
    this._initializeAllRooms();
    
    // ✅ RESTORE: Load dari storage ke cache
    this._restoreAllState().catch(() => {});
  }

  // ============ INITIALIZE ALL ROOMS ============
  
  _initializeAllRooms() {
    for (const room of ROOMS) {
      if (!this._roomsDataCache[room]) {
        this._roomsDataCache[room] = {
          seats: {},
          points: {},
          muted: false,
          number: 1
        };
      }
    }
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

  // ✅ SYNC: Cache → Storage (Simpan ke storage)
  async _syncToStorage(roomsData, userSeatData, currentNumber, kursiNumber) {
    try {
      const updates = {};
      
      // Update cache jika ada perubahan
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
      
      // ✅ Simpan ke storage (persistent)
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

  // ✅ SYNC: Storage → Cache (Load dari storage)
  async _syncFromStorage() {
    try {
      const storage = await this.ctx.storage.get([
        "roomsData", 
        "userSeatData", 
        "currentNumber", 
        "kursiNumber"
      ]);
      
      // Load ke cache
      if (storage.roomsData !== undefined) {
        this._roomsDataCache = storage.roomsData;
        console.log(`[SYNC] Loaded roomsData from storage`);
      }
      if (storage.userSeatData !== undefined) {
        this._userSeatDataCache = storage.userSeatData;
        console.log(`[SYNC] Loaded userSeatData from storage`);
      }
      if (storage.currentNumber !== undefined) {
        this.currentNumber = storage.currentNumber;
        console.log(`[SYNC] Loaded currentNumber: ${this.currentNumber}`);
      }
      if (storage.kursiNumber !== undefined) {
        this._kursiNumber = storage.kursiNumber;
        console.log(`[SYNC] Loaded kursiNumber from storage`);
      }
      
      // ✅ Pastikan semua room ada
      this._ensureAllRoomsExist();
      
      return {
        roomsData: this._roomsDataCache,
        userSeatData: this._userSeatDataCache,
        currentNumber: this.currentNumber,
        kursiNumber: this._kursiNumber
      };
    } catch(e) {
      console.error(`[SYNC FROM STORAGE ERROR]`, e.message);
      return {
        roomsData: this._roomsDataCache,
        userSeatData: this._userSeatDataCache,
        currentNumber: this.currentNumber,
        kursiNumber: this._kursiNumber
      };
    }
  }

  // ✅ Ensure semua room dari ROOMS ada di cache
  _ensureAllRoomsExist() {
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
        console.log(`[INIT] Room ${room} created`);
      }
    }
    return changed;
  }

  // ============ RESTORE AFTER WAKE UP ============

  // ✅ RESTORE: Load semua data dari storage setelah bangun
  async _restoreAllState() {
    if (this._isRestoring) return;
    this._isRestoring = true;
    
    console.log(`[RESTORE] Starting restore from storage...`);
    
    try {
      // 1. Load dari storage ke cache
      await this._syncFromStorage();
      
      // 2. Pastikan semua room ada
      this._ensureAllRoomsExist();
      
      // 3. Restore WebSocket connections
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
              
              // Restore WebSocket state
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
      
      // 4. Update user counts
      await this._updateUserCounts();
      
      // 5. Set alarm jika belum ada
      if (!this.closing && !this.isDestroyed) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        if (!existingAlarm) {
          await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
          console.log(`[RESTORE] Alarm set`);
        }
      }
      
      console.log(`[RESTORE] Restore completed successfully`);
      
    } catch(e) {
      console.error(`[RESTORE] Restore failed:`, e.message);
    } finally {
      this._isRestoring = false;
    }
  }

  // ============ WAKE UP HANDLER ============

  // ✅ Dipanggil saat Durable Object bangun (alarm atau request)
  async wakeUp() {
    console.log(`[WAKE UP] ChatServer waking up...`);
    
    // Restore semua state dari storage
    await this._restoreAllState();
    
    // Kirim notifikasi ke semua client
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

  // ============ CORE SEAT OPERATIONS ============

  // ✅ UPDATE SEAT (Cache + Storage sync)
  async _updateSeat(roomName, seatNumber, seatData) {
    // Validasi
    if (!this._isValidRoom(roomName)) {
      console.error(`[ERROR] Invalid room: ${roomName}`);
      return false;
    }
    if (!this._isValidSeat(seatNumber)) {
      console.error(`[ERROR] Invalid seat number: ${seatNumber}`);
      return false;
    }
    
    try {
      let roomData = this._roomsDataCache[roomName];
      if (!roomData) {
        this._initializeAllRooms();
        roomData = this._roomsDataCache[roomName];
        if (!roomData) return false;
      }
      
      // 1. UPDATE cache
      roomData.seats[seatNumber] = {
        noimageUrl: seatData.noimageUrl || "",
        namauser: seatData.namauser || "",
        color: seatData.color || "",
        itembawah: seatData.itembawah || 0,
        itematas: seatData.itematas || 0,
        vip: seatData.vip || 0,
        viptanda: seatData.viptanda || 0
      };
      
      const key = this._getSeatKey(roomName, seatNumber);
      this._kursiNumber[key] = seatNumber;
      
      const username = seatData.namauser;
      if (username) {
        const isMulti = seatData.isMulti || false;
        this._userSeatDataCache[username] = {
          room: roomName,
          seat: seatNumber,
          isMulti: isMulti,
          multiRoom: isMulti ? roomName : null,
          multiSeat: isMulti ? seatNumber : null,
          lastUpdate: Date.now()
        };
      }
      
      // 2. SYNC ke storage (Cache → Storage)
      await this._syncToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        undefined,
        this._kursiNumber
      );
      
      // 3. Broadcast
      this.broadcast(roomName, ["kursiUpdated", roomName, seatNumber, roomData.seats[seatNumber]]);
      await this.updateRoomCount(roomName);
      
      console.log(`[UPDATE] Seat ${seatNumber} updated in ${roomName}`);
      return true;
      
    } catch(e) {
      console.error(`[ERROR] Update seat failed: ${e.message}`);
      return false;
    }
  }

  // ✅ UPDATE POINT (Cache + Storage sync)
  async _updatePoint(roomName, seatNumber, x, y, fast) {
    if (!this._isValidRoom(roomName) || !this._isValidSeat(seatNumber)) {
      return false;
    }
    
    try {
      const roomData = this._roomsDataCache[roomName];
      if (!roomData || !roomData.seats[seatNumber]) return false;
      
      // 1. UPDATE cache
      if (!roomData.points) roomData.points = {};
      roomData.points[seatNumber] = { x: x || 0, y: y || 0, fast: !!fast };
      
      // 2. SYNC ke storage
      await this._syncToStorage(this._roomsDataCache, undefined, undefined, undefined);
      
      // 3. Broadcast
      this.broadcast(roomName, ["pointUpdated", roomName, seatNumber, x, y, fast]);
      
      console.log(`[UPDATE] Point for seat ${seatNumber} updated in ${roomName}`);
      return true;
      
    } catch(e) {
      console.error(`[ERROR] Update point failed: ${e.message}`);
      return false;
    }
  }

  // ✅ DELETE SEAT (Cache + Storage sync)
  async _deleteSeat(roomName, seatNumber) {
    if (!this._isValidRoom(roomName) || !this._isValidSeat(seatNumber)) {
      return false;
    }
    
    try {
      const roomData = this._roomsDataCache[roomName];
      if (!roomData || !roomData.seats[seatNumber]) return false;
      
      const username = roomData.seats[seatNumber]?.namauser;
      
      // 1. DELETE dari cache
      delete roomData.seats[seatNumber];
      if (roomData.points) delete roomData.points[seatNumber];
      
      const key = this._getSeatKey(roomName, seatNumber);
      delete this._kursiNumber[key];
      
      if (username && this._userSeatDataCache[username]) {
        delete this._userSeatDataCache[username];
      }
      
      // 2. SYNC ke storage
      await this._syncToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        undefined,
        this._kursiNumber
      );
      
      // 3. Broadcast
      this.broadcast(roomName, ["removeKursi", roomName, seatNumber]);
      await this.updateRoomCount(roomName);
      
      // 4. Reset room jika kosong
      const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
      if (!hasSeats) {
        this._resetRoomToEmpty(roomName);
        await this._syncToStorage(this._roomsDataCache, undefined, undefined, undefined);
      }
      
      console.log(`[DELETE] Seat ${seatNumber} deleted from ${roomName}`);
      return true;
      
    } catch(e) {
      console.error(`[ERROR] Delete seat failed: ${e.message}`);
      return false;
    }
  }

  // ✅ RESET ROOM TO EMPTY
  _resetRoomToEmpty(roomName) {
    if (!this._isValidRoom(roomName)) return;
    
    if (this._roomsDataCache[roomName]) {
      this._roomsDataCache[roomName].seats = {};
      this._roomsDataCache[roomName].points = {};
      this._roomsDataCache[roomName].muted = false;
      this._roomsDataCache[roomName].number = 1;
      
      for (const key of Object.keys(this._kursiNumber)) {
        if (key.startsWith(`${roomName}-`)) {
          delete this._kursiNumber[key];
        }
      }
      
      console.log(`[RESET] Room ${roomName} reset to empty`);
    }
  }

  // ============ GET FUNCTIONS ============

  _getSeatData(roomName, seatNumber) {
    if (!this._isValidRoom(roomName) || !this._isValidSeat(seatNumber)) return null;
    
    const roomData = this._roomsDataCache[roomName];
    if (!roomData) return null;
    
    const key = this._getSeatKey(roomName, seatNumber);
    
    return {
      seat: roomData.seats?.[seatNumber] || null,
      point: roomData.points?.[seatNumber] || null,
      number: this._kursiNumber[key] || null,
      exists: !!roomData.seats?.[seatNumber]
    };
  }

  _getAllSeatsInRoom(roomName) {
    if (!this._isValidRoom(roomName)) return null;
    
    const roomData = this._roomsDataCache[roomName];
    if (!roomData) return null;
    
    const result = {};
    const seats = roomData.seats || {};
    const points = roomData.points || {};
    
    for (const seatKey of Object.keys(seats)) {
      const seatNum = parseInt(seatKey);
      const seatKeyStr = this._getSeatKey(roomName, seatNum);
      
      result[seatNum] = {
        ...seats[seatNum],
        point: points[seatNum] || null,
        number: this._kursiNumber[seatKeyStr] || seatNum,
        exists: true
      };
    }
    
    return result;
  }

  // ============ JOIN HANDLING ============

  async _handleJoin(ws, roomName) {
    if (!ws || !ws.username || !this._isValidRoom(roomName) || this.closing || this.isDestroyed) {
      return false;
    }
    
    const username = ws.username;
    
    try {
      // 1. Hapus user dari semua room
      await this._removeUserFromAllRooms(username);
      
      // 2. Sync dari storage
      await this._syncFromStorage();
      
      // 3. Hapus sisa data di cache
      if (this._userSeatDataCache[username]) {
        delete this._userSeatDataCache[username];
      }
      
      // 4. Bersihkan kursi number yang tersisa
      for (const key of Object.keys(this._kursiNumber)) {
        const [room, seat] = key.split('-');
        if (this._roomsDataCache[room]?.seats?.[parseInt(seat)]?.namauser === username) {
          delete this._kursiNumber[key];
        }
      }
      
      // 5. Sync perubahan
      await this._syncToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber,
        this._kursiNumber
      );
      
      // 6. Ambil room data (pasti sudah ada)
      const roomData = this._roomsDataCache[roomName];
      if (!roomData) {
        this._initializeAllRooms();
        await this._syncToStorage(this._roomsDataCache, undefined, undefined, undefined);
        return false;
      }
      
      // 7. Cek kapasitas
      if (Object.keys(roomData.seats).length >= C.MAX_SEATS) {
        this.safeSend(ws, ["roomFull", roomName]);
        return false;
      }
      
      // 8. Cari seat kosong
      let seat = null;
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
      
      // 9. Assign seat
      roomData.seats[seat] = {};
      const key = this._getSeatKey(roomName, seat);
      this._kursiNumber[key] = seat;
      
      if (roomData.points && roomData.points[seat]) {
        delete roomData.points[seat];
      }
      
      // 10. Sync ke storage
      await this._syncToStorage(this._roomsDataCache, undefined, undefined, this._kursiNumber);
      
      // 11. Update WebSocket
      await this._updateWebSocketRoom(ws, roomName, username, seat, false);
      
      // 12. Kirim response
      this.safeSend(ws, ["rooMasuk", seat, roomName]);
      this.safeSend(ws, ["numberKursiSaya", seat]);
      this.safeSend(ws, ["muteTypeResponse", roomData.muted || false, roomName]);
      
      const count = Object.keys(roomData.seats).length;
      this.safeSend(ws, ["roomUserCount", roomName, count]);
      this.broadcast(roomName, ["roomUserCount", roomName, count]);
      
      // 13. Kirim state room setelah delay
      setTimeout(() => {
        try {
          if (ws && ws.readyState === 1) {
            this.sendAllStateTo(ws, roomName, true);
          }
        } catch(e) {}
      }, 1000);
      
      // 14. Sync verifikasi
      await this._syncFromStorage();
      
      console.log(`[JOIN] ${username} joined ${roomName} seat ${seat}`);
      return true;
      
    } catch(e) {
      console.error(`[JOIN ERROR] ${e.message}`);
      return false;
    }
  }

  // ============ UPDATE USER COUNTS ============

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

  // ============ GET ACTIVE WEBSOCKETS ============

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

  // ============ BROADCAST ============

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

  // ============ ALARM ============

  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    console.log(`[ALARM] Running scheduled tasks...`);
    
    try {
      // ✅ Pastikan data sync sebelum update
      await this._syncFromStorage();
      
      await this._updateNumber();
      await this._checkMultiUsers();
      await this._cleanupStorage();
      
      // ✅ Sync setelah update
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
        console.log(`[ALARM] Next alarm set`);
      } catch(e) {}
    }
  }

  // ============ UPDATE NUMBER ============

  async _updateNumber() {
    if (this._isNumberUpdating || this.closing || this.isDestroyed) return;
    this._isNumberUpdating = true;
    
    try {
      this.currentNumber = this.currentNumber < C.MAX_NUMBER ? this.currentNumber + 1 : 1;
      
      // ✅ Sync ke storage
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
      
      console.log(`[NUMBER] Updated to ${this.currentNumber}`);
      
    } catch(e) {
      console.error(`[NUMBER ERROR]`, e.message);
    } finally {
      this._isNumberUpdating = false;
    }
  }

  // ============ CHECK MULTI USERS ============

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
      
      // Cleanup userSeatData yang tidak valid
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

  // ============ CLEANUP STORAGE ============

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
      
      // Hapus userSeatData untuk user yang tidak connected dan bukan multi
      for (const [username, seatInfo] of Object.entries(this._userSeatDataCache)) {
        if (!connectedUsers.has(username) && !seatInfo.isMulti) {
          delete this._userSeatDataCache[username];
          changed = true;
        }
      }
      
      // Hapus kursiNumber yang tidak valid
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
        console.log(`[CLEANUP] Storage cleaned up`);
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
          await this._handleJoin(ws, args[0]);
          break;
        
        case "updateKursi": {
          const [kursiRoom, kursiSeat, kursiNoimg, kursiName, kursiColor, kursiBawah, kursiAtas, kursiVip, kursiVt, kursiNumber] = args;
          
          const seatNum = parseInt(kursiSeat);
          if (isNaN(seatNum)) {
            this.safeSend(ws, ["updateKursiError", "Invalid seat number"]);
            break;
          }
          
          const updated = await this._updateSeat(kursiRoom, seatNum, {
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
            this.safeSend(ws, ["updateKursiSuccess", kursiRoom, seatNum]);
          } else {
            this.safeSend(ws, ["updateKursiError", "Failed to update seat"]);
          }
          break;
        }
        
        case "updatePoint": {
          const [pointRoom, pointSeat, pointX, pointY, pointFast] = args;
          
          const seatNum = parseInt(pointSeat);
          if (isNaN(seatNum) || !this._isValidRoom(pointRoom)) {
            this.safeSend(ws, ["updatePointError", "Invalid parameters"]);
            break;
          }
          
          const updated = await this._updatePoint(pointRoom, seatNum, pointX, pointY, pointFast === 1);
          if (updated) {
            this.safeSend(ws, ["updatePointSuccess", pointRoom, seatNum]);
          } else {
            this.safeSend(ws, ["updatePointError", "Failed to update point"]);
          }
          break;
        }
        
        case "deleteSeat": {
          const [deleteRoom, deleteSeat] = args;
          
          const seatNum = parseInt(deleteSeat);
          if (isNaN(seatNum) || !this._isValidRoom(deleteRoom)) {
            this.safeSend(ws, ["deleteSeatError", "Invalid parameters"]);
            break;
          }
          
          const deleted = await this._deleteSeat(deleteRoom, seatNum);
          if (deleted) {
            this.safeSend(ws, ["deleteSeatSuccess", deleteRoom, seatNum]);
          } else {
            this.safeSend(ws, ["deleteSeatError", "Failed to delete seat"]);
          }
          break;
        }
        
        case "getSeatData": {
          const [getRoom, getSeat] = args;
          
          const seatNum = parseInt(getSeat);
          if (isNaN(seatNum) || !this._isValidRoom(getRoom)) {
            this.safeSend(ws, ["getSeatDataError", "Invalid parameters"]);
            break;
          }
          
          const data = this._getSeatData(getRoom, seatNum);
          if (data) {
            this.safeSend(ws, ["getSeatDataResult", getRoom, seatNum, data]);
          } else {
            this.safeSend(ws, ["getSeatDataError", "Seat not found"]);
          }
          break;
        }
        
        case "getAllSeats": {
          const [getRoom] = args;
          
          if (!this._isValidRoom(getRoom)) {
            this.safeSend(ws, ["getAllSeatsError", "Invalid room"]);
            break;
          }
          
          const seats = this._getAllSeatsInRoom(getRoom);
          if (seats) {
            this.safeSend(ws, ["getAllSeatsResult", getRoom, seats]);
          } else {
            this.safeSend(ws, ["getAllSeatsError", "Room not found"]);
          }
          break;
        }
        
        case "chat": {
          const [chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor] = args;
          if (!chatMsg || !this._isValidRoom(chatRoom)) break;
          
          const userSeat = this._userSeatDataCache[chatUser];
          if (!userSeat || userSeat.room !== chatRoom) break;
          
          this.broadcast(chatRoom, ["chat", chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor]);
          break;
        }
        
        case "removeKursiAndPoint": {
          const [removeRoom, removeSeat] = args;
          
          if (!this._isValidRoom(removeRoom)) break;
          
          const seatNum = parseInt(removeSeat);
          if (isNaN(seatNum)) break;
          
          const roomData = this._roomsDataCache[removeRoom];
          let username = null;
          if (roomData && roomData.seats && roomData.seats[seatNum]) {
            username = roomData.seats[seatNum].namauser;
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
          if (giftRoom && this._isValidRoom(giftRoom)) {
            const receiverSeat = this._userSeatDataCache[giftReceiver];
            if (!receiverSeat || receiverSeat.room !== giftRoom) break;
            this.broadcast(giftRoom, ["gift", giftRoom, giftSender, giftReceiver, giftGiftName, Date.now()]);
          }
          break;
        }
        
        case "rollangak": {
          const [rollRoom, rollUser, rollAngka] = args;
          if (rollRoom && this._isValidRoom(rollRoom)) {
            const userSeat = this._userSeatDataCache[rollUser];
            if (!userSeat || userSeat.room !== rollRoom) break;
            this.broadcast(rollRoom, ["rollangakBroadcast", rollRoom, rollUser, rollAngka]);
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
            counts[room] = this._getRoomCount(room);
          }
          this.safeSend(ws, ["allRoomsUserCount", Object.entries(counts)]);
          break;
        }
        
        case "getRoomUserCount": {
          const roomName = args[0];
          if (roomName && this._isValidRoom(roomName)) {
            const count = this._getRoomCount(roomName);
            this.safeSend(ws, ["roomUserCount", roomName, count]);
          }
          break;
        }
        
        case "setMuteType": {
          const [muteVal, muteRoom] = args;
          if (!muteRoom || !this._isValidRoom(muteRoom)) break;
          
          const roomData = this._roomsDataCache[muteRoom];
          if (roomData) {
            roomData.muted = !!muteVal;
            await this._syncToStorage(this._roomsDataCache, undefined, undefined, undefined);
          }
          
          this.broadcast(muteRoom, ["muteStatusChanged", !!muteVal, muteRoom]);
          this.safeSend(ws, ["muteTypeSet", !!muteVal, true, muteRoom]);
          break;
        }

        case "modwarning": {
          const modRoom = args[0];
          if (modRoom && this._isValidRoom(modRoom)) {
            this.broadcast(modRoom, ["modwarning", modRoom]);
          }
          break;
        }

        case "getMuteType": {
          const getMuteRoom = args[0];
          if (getMuteRoom && this._isValidRoom(getMuteRoom)) {
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
      console.error(`[EVENT ERROR]`, e.message);
    }
  }

  // ============ RESET ALL DATA ============

  async resetAllData() {
    const timestamp = Date.now();
    
    try {
      console.log(`[RESET] Starting reset at ${new Date(timestamp).toISOString()}`);
      
      // Reset cache
      this._roomsDataCache = {};
      this._userSeatDataCache = {};
      this.currentNumber = 1;
      this._kursiNumber = {};
      
      this._initializeAllRooms();
      
      // Hapus storage
      await this.ctx.storage.delete("roomsData");
      await this.ctx.storage.delete("userSeatData");
      await this.ctx.storage.delete("currentNumber");
      await this.ctx.storage.delete("userCounts");
      await this.ctx.storage.delete("onlineUsers");
      await this.ctx.storage.delete("kursiNumber");
      
      // Sync ke storage
      await this._syncToStorage(
        this._roomsDataCache,
        this._userSeatDataCache,
        this.currentNumber,
        this._kursiNumber
      );
      
      // Broadcast reset
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
      
      // Set alarm
      if (!this.closing && !this.isDestroyed) {
        await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      }
      
      await this.ctx.storage.put("lastReset", timestamp);
      
      console.log(`[RESET] Reset completed successfully`);
      
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
      
      // ✅ Wake up endpoint
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
