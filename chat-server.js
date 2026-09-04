// ==================== CHAT-SERVER.JS ====================
// VERSION: 8.0.0 - FULL HIBERNATION OPTIMIZED
// REAL-TIME SYNC: CACHE + STORAGE
// SEMUA PERUBAHAN LANGSUNG SYNC KE STORAGE DAN CACHE

const C = {
  MAX_SEATS: 45,
  MAX_GLOBAL_CONNECTIONS: 150,
  MAX_MESSAGE_SIZE: 5000,
  NUMBER_INTERVAL_MS: 900000, // 15 MENIT
  MAX_NUMBER: 6,
  BATCH_SIZE: 20,
  LOCK_TIMEOUT: 5000,
  MAX_EVENT_QUEUE: 100,
  MAX_PROCESS_TIME_MS: 500,
  USER_JOIN_LOCK_TIMEOUT: 10000,
  STORAGE_CACHE_TTL: 1000, // 1 DETIK (LEBIH CEPAT UNTUK REAL-TIME)
  MAX_ATTACHMENT_SIZE: 16384,
};

const ROOMS = [
  "LowCard", "Quiz", "Gacor", "General", "LOVE BIRDS", "Birthday Party",
  "Sweet Memories", "Lounge Talk", "Noxxeliverothcifsa", "BESTIES",
  "Happy Vibes", "The Chatter Room"
];

const ROOMS_SET = new Set(ROOMS);

// ==================== CHAT SERVER ====================
export class ChatServer {
  constructor(state, env) {
    console.log('[CONSTRUCTOR] Initializing ChatServer...');
    
    this.state = state;
    this.env = env;
    this.ctx = state;
    this.closing = false;
    this.isDestroyed = false;
    this._startTime = Date.now();
    this._initialized = false;
    this._initializing = false;
    
    // ========== WEBSOCKET MEMORY STATE ==========
    this.wsSet = new Set();
    this.userConnections = new Map();
    this.roomClients = new Map();
    this.wsActiveMulti = new Map();
    
    // ========== PROCESSING ==========
    this._processingMessages = new Set();
    this._cleaningUp = new Set();
    this._eventQueue = [];
    this._isProcessingQueue = false;
    this._pendingTimeouts = new Set();
    
    // ========== LOCKS ==========
    this._joinLocks = new Map();
    this._kursiLocks = new Map();
    this._userJoinLock = new Map();
    
    // ========== NUMBER ==========
    this.currentNumber = 1;
    this._isNumberUpdating = false;
    
    // ========== STORAGE CACHE (REAL-TIME SYNC) ==========
    this._storageCache = {
      roomsData: {},
      userSeatData: {},
      currentNumber: 1,
      lastUpdate: 0
    };
    this._storageCacheTime = 0;
    this._storageCacheTTL = C.STORAGE_CACHE_TTL;
    this._isCacheDirty = false;
    this._cacheSyncTimeout = null;
    
    // ========== INIT ROOMS ==========
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    // ========== SCHEDULE INITIALIZATION ==========
    // Jangan panggil langsung di constructor, schedule untuk next tick
    this._scheduleInitialization();
  }

  // ============================================================
  // ✅ INITIALIZATION (DIPANGGIL SETELAH CONSTRUCTOR)
  // ============================================================
  
  _scheduleInitialization() {
    // Schedule di microtask queue agar getWebSockets() tersedia
    Promise.resolve().then(async () => {
      if (!this._initialized && !this._initializing && !this.closing && !this.isDestroyed) {
        await this.initialize();
      }
    }).catch(err => {
      console.error('[INIT] Error during scheduled init:', err.message);
    });
  }

  async initialize() {
    if (this._initialized || this._initializing || this.closing || this.isDestroyed) {
      return;
    }
    
    this._initializing = true;
    console.log('[INIT] Starting initialization...');
    
    try {
      // 1. LOAD DARI STORAGE
      await this._loadFromStorage(true); // Force load
      
      // 2. RESTORE WEBSOCKETS
      await this._restoreWebSockets();
      
      // 3. SET ALARM
      if (!this.closing && !this.isDestroyed) {
        await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        console.log('[INIT] Alarm scheduled');
      }
      
      this._initialized = true;
      console.log('[INIT] Initialization complete');
      
    } catch (err) {
      console.error('[INIT] Failed:', err.message);
      // Retry after 5 seconds
      setTimeout(() => {
        if (!this._initialized && !this.closing && !this.isDestroyed) {
          console.log('[INIT] Retrying initialization...');
          this.initialize();
        }
      }, 5000);
    } finally {
      this._initializing = false;
    }
  }

  // ============================================================
  // ✅ STORAGE OPERATIONS (REAL-TIME SYNC)
  // ============================================================

  async _loadFromStorage(force = false) {
    const now = Date.now();
    
    // Return cache jika masih valid dan tidak force
    if (!force && this._storageCache && (now - this._storageCacheTime) < this._storageCacheTTL) {
      console.log('[STORAGE] Using cache (age:', now - this._storageCacheTime, 'ms)');
      return this._storageCache;
    }
    
    console.log('[STORAGE] Loading from storage... (force:', force, ')');
    
    try {
      // Ambil semua data sekaligus untuk performance
      const entries = await this.ctx.storage.get([
        "roomsData",
        "userSeatData", 
        "currentNumber"
      ]);
      
      const roomsData = entries?.roomsData || {};
      const userSeatData = entries?.userSeatData || {};
      const currentNumber = entries?.currentNumber || 1;
      
      // Update cache
      this._storageCache = {
        roomsData,
        userSeatData,
        currentNumber,
        lastUpdate: now
      };
      this._storageCacheTime = now;
      this._isCacheDirty = false;
      
      console.log('[STORAGE] Loaded:', {
        rooms: Object.keys(roomsData).length,
        users: Object.keys(userSeatData).length,
        number: currentNumber
      });
      
      return this._storageCache;
      
    } catch (err) {
      console.error('[STORAGE] Load error:', err.message);
      // Return cache jika ada, atau default
      return this._storageCache || { roomsData: {}, userSeatData: {}, currentNumber: 1 };
    }
  }

  async _saveToStorage(roomsData, userSeatData, currentNumber, syncCache = true) {
    try {
      console.log('[STORAGE] Saving...');
      
      const updates = {};
      if (roomsData !== undefined) updates.roomsData = roomsData;
      if (userSeatData !== undefined) updates.userSeatData = userSeatData;
      if (currentNumber !== undefined) updates.currentNumber = currentNumber;
      
      // Simpan ke storage
      await this.ctx.storage.put(updates);
      
      // Update cache
      if (syncCache) {
        if (roomsData !== undefined) this._storageCache.roomsData = roomsData;
        if (userSeatData !== undefined) this._storageCache.userSeatData = userSeatData;
        if (currentNumber !== undefined) this._storageCache.currentNumber = currentNumber;
        this._storageCache.lastUpdate = Date.now();
        this._storageCacheTime = Date.now();
        this._isCacheDirty = false;
      }
      
      console.log('[STORAGE] Saved successfully');
      
    } catch (err) {
      console.error('[STORAGE] Save error:', err.message);
      this._isCacheDirty = true;
      // Retry after delay
      this._scheduleCacheSync();
    }
  }

  _scheduleCacheSync() {
    if (this._cacheSyncTimeout) {
      clearTimeout(this._cacheSyncTimeout);
    }
    
    this._cacheSyncTimeout = setTimeout(async () => {
      if (this._isCacheDirty && !this.closing && !this.isDestroyed) {
        console.log('[STORAGE] Syncing dirty cache...');
        await this._saveToStorage(
          this._storageCache.roomsData,
          this._storageCache.userSeatData,
          this._storageCache.currentNumber,
          true
        );
      }
      this._cacheSyncTimeout = null;
    }, 1000);
  }

  // ============================================================
  // ✅ ROOM DATA OPERATIONS (REAL-TIME)
  // ============================================================

  async _getRoomData(roomName) {
    await this._loadFromStorage();
    return this._storageCache.roomsData[roomName] || null;
  }

  async _getUserSeat(username) {
    await this._loadFromStorage();
    return this._storageCache.userSeatData[username] || null;
  }

  async _updateRoomData(roomName, updater) {
    await this._loadFromStorage();
    
    const roomsData = this._storageCache.roomsData || {};
    
    if (!roomsData[roomName]) {
      roomsData[roomName] = { 
        seats: {}, 
        points: {}, 
        muted: false, 
        number: 1 
      };
    }
    
    // Apply update
    updater(roomsData[roomName]);
    
    // Simpan ke storage & update cache
    await this._saveToStorage(roomsData, undefined, undefined, true);
    
    // Broadcast perubahan
    this._broadcastRoomUpdate(roomName);
    
    return roomsData[roomName];
  }

  async _updateUserSeat(username, updater) {
    await this._loadFromStorage();
    
    const userSeatData = this._storageCache.userSeatData || {};
    
    if (!userSeatData[username]) {
      userSeatData[username] = {};
    }
    
    updater(userSeatData[username]);
    
    // Hapus jika kosong
    if (Object.keys(userSeatData[username]).length === 0) {
      delete userSeatData[username];
    }
    
    // Simpan ke storage & update cache
    await this._saveToStorage(undefined, userSeatData, undefined, true);
    
    return userSeatData[username];
  }

  async _deleteUserSeat(username) {
    await this._loadFromStorage();
    
    const userSeatData = this._storageCache.userSeatData || {};
    delete userSeatData[username];
    
    await this._saveToStorage(undefined, userSeatData, undefined, true);
  }

  async _deleteRoomIfEmpty(roomName) {
    const roomData = await this._getRoomData(roomName);
    if (!roomData) return;
    
    const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
    const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
    
    if (!hasSeats && !hasPoints) {
      const roomsData = this._storageCache.roomsData || {};
      delete roomsData[roomName];
      
      await this._saveToStorage(roomsData, undefined, undefined, true);
      
      console.log(`[DELETE] Room "${roomName}" deleted from storage (empty)`);
    }
  }

  // ============================================================
  // ✅ WEBSOCKET RESTORE (HIBERNATION)
  // ============================================================

  async _restoreWebSockets() {
    console.log('[RESTORE] Restoring WebSockets...');
    
    try {
      const webSockets = this.ctx.getWebSockets();
      console.log(`[RESTORE] Found ${webSockets.length} WebSockets`);
      
      let restored = 0;
      
      for (const ws of webSockets) {
        try {
          const attachment = ws.deserializeAttachment();
          
          if (!attachment || !attachment.username) {
            console.log('[RESTORE] Skipping WebSocket without username');
            continue;
          }
          
          const username = attachment.username;
          const userSeat = await this._getUserSeat(username);
          
          if (!userSeat) {
            console.log(`[RESTORE] User "${username}" not in storage, skipping`);
            continue;
          }
          
          // Restore state
          ws.username = username;
          ws.idtarget = username;
          ws.room = userSeat.room;
          ws.roomname = userSeat.room;
          ws._closing = false;
          ws._restored = true;
          
          // Simpan attachment terbaru
          ws.serializeAttachment({
            username: username,
            seatInfo: userSeat,
            restored: true,
            restoredAt: Date.now()
          });
          
          // Add to room clients
          const roomClients = this.roomClients.get(userSeat.room);
          if (roomClients) roomClients.add(ws);
          
          // Add to user connections
          let conns = this.userConnections.get(username);
          if (!conns) conns = new Set();
          conns.add(ws);
          this.userConnections.set(username, conns);
          
          // Add to wsSet
          this.wsSet.add(ws);
          
          restored++;
          console.log(`[RESTORE] Restored user "${username}" in room "${userSeat.room}" seat ${userSeat.seat}`);
          
        } catch (err) {
          console.error('[RESTORE] Error restoring WebSocket:', err.message);
        }
      }
      
      console.log(`[RESTORE] Successfully restored ${restored} WebSockets`);
      
    } catch (err) {
      console.error('[RESTORE] Error:', err.message);
    }
  }

  // ============================================================
  // ✅ BROADCAST (REAL-TIME)
  // ============================================================

  _broadcastRoomUpdate(roomName) {
    // Broadcast bahwa ada perubahan di room
    const msg = JSON.stringify(["roomDataUpdated", roomName, Date.now()]);
    this._broadcastToRoom(roomName, msg);
  }

  _broadcastToRoom(room, msgStr) {
    if (this.closing || this.isDestroyed || !room) return;
    
    const clients = this.roomClients.get(room);
    if (!clients || clients.size === 0) return;
    
    const clientArray = Array.from(clients);
    const toRemove = new Set();
    
    console.log(`[BROADCAST] Sending to ${clientArray.length} clients in "${room}"`);
    
    for (let i = 0; i < clientArray.length; i += C.BATCH_SIZE) {
      const batch = clientArray.slice(i, Math.min(i + C.BATCH_SIZE, clientArray.length));
      
      for (const ws of batch) {
        if (!ws) { toRemove.add(ws); continue; }
        
        const wsRoom = ws.room || ws.roomname;
        if (wsRoom !== room) {
          toRemove.add(ws);
          continue;
        }
        
        try {
          if (ws.readyState === 1 && !ws._closing && !this._cleaningUp.has(ws)) {
            ws.send(msgStr);
          } else {
            toRemove.add(ws);
          }
        } catch (err) {
          console.error('[BROADCAST] Error sending to client:', err.message);
          toRemove.add(ws);
        }
      }
    }
    
    // Cleanup dead connections
    if (toRemove.size > 0) {
      console.log(`[BROADCAST] Removing ${toRemove.size} dead connections`);
      for (const ws of toRemove) {
        try {
          clients.delete(ws);
          if (ws && !this._cleaningUp.has(ws)) {
            this.cleanup(ws);
          }
        } catch (err) {
          console.error('[BROADCAST] Cleanup error:', err.message);
        }
      }
    }
  }

  broadcast(room, msg) {
    if (this.closing || this.isDestroyed || !room || !msg) return;
    try {
      const msgStr = JSON.stringify(msg);
      this._broadcastToRoom(room, msgStr);
    } catch (err) {
      console.error('[BROADCAST] Error:', err.message);
    }
  }

  // ============================================================
  // ✅ SAFE SEND
  // ============================================================

  safeSend(ws, msg) {
    if (!ws) return false;
    
    try {
      if (ws.readyState !== 1 || ws._closing || this._cleaningUp.has(ws) || 
          this.closing || this.isDestroyed) {
        return false;
      }
      
      ws.send(JSON.stringify(msg));
      return true;
      
    } catch (err) {
      console.error('[SAFE SEND] Error:', err.message);
      this.cleanup(ws);
      return false;
    }
  }

  // ============================================================
  // ✅ REMOVE USER (REAL-TIME)
  // ============================================================

  async _removeUserFromRoom(username, roomName) {
    if (!username || !roomName) return false;
    
    console.log(`[REMOVE] Removing "${username}" from "${roomName}"`);
    
    const roomData = await this._getRoomData(roomName);
    if (!roomData || !roomData.seats) return false;
    
    // Cari seat user
    let seat = null;
    for (const [s, data] of Object.entries(roomData.seats)) {
      if (data && data.namauser === username) {
        seat = parseInt(s);
        break;
      }
    }
    
    if (!seat) {
      console.log(`[REMOVE] User "${username}" not found in "${roomName}"`);
      return false;
    }
    
    // Hapus dari seats dan points
    delete roomData.seats[seat];
    if (roomData.points) {
      delete roomData.points[seat];
    }
    
    // Update storage
    await this._updateRoomData(roomName, (data) => {
      data.seats = roomData.seats;
      data.points = roomData.points || {};
    });
    
    // Hapus user seat
    await this._deleteUserSeat(username);
    
    // Broadcast
    this.broadcast(roomName, ["removeKursi", roomName, seat]);
    await this.updateRoomCount(roomName);
    
    // Hapus room jika kosong
    await this._deleteRoomIfEmpty(roomName);
    
    console.log(`[REMOVE] User "${username}" removed from "${roomName}" seat ${seat}`);
    return true;
  }

  // ============================================================
  // ✅ UPDATE ROOM COUNT (REAL-TIME)
  // ============================================================

  async updateRoomCount(room) {
    if (this.closing || this.isDestroyed || !room) return 0;
    
    try {
      const roomData = await this._getRoomData(room);
      if (!roomData || !roomData.seats) return 0;
      
      const count = Object.keys(roomData.seats).length;
      this.broadcast(room, ["roomUserCount", room, count]);
      
      return count;
      
    } catch (err) {
      console.error('[UPDATE COUNT] Error:', err.message);
      return 0;
    }
  }

  // ============================================================
  // ✅ SEND ALL STATE (REAL-TIME)
  // ============================================================

  async sendAllStateTo(ws, room, excludeSelf = false) {
    if (!ws || !ws.username) return;
    
    try {
      if (ws.readyState !== 1 || ws._closing) return;
    } catch (err) {
      return;
    }
    
    console.log(`[SEND STATE] Sending state to "${ws.username}" in "${room}"`);
    
    const roomData = await this._getRoomData(room);
    if (!roomData) return;
    
    try {
      const allSeats = roomData.seats || {};
      const allPoints = roomData.points || {};
      
      const userSeat = await this._getUserSeat(ws.username);
      const selfSeat = userSeat?.seat;
      
      // Send count
      const count = Object.keys(allSeats).length;
      this.safeSend(ws, ["roomUserCount", room, count]);
      
      // Send seats (filtered)
      if (Object.keys(allSeats).length > 0) {
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
      
      // Send points (filtered)
      if (Object.keys(allPoints).length > 0) {
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
      
      // Send mute status
      this.safeSend(ws, ["muteTypeResponse", roomData.muted || false, room]);
      
      // Send current number
      this.safeSend(ws, ["currentNumber", this.currentNumber]);
      
    } catch (err) {
      console.error('[SEND STATE] Error:', err.message);
    }
  }

  // ============================================================
  // ✅ JOIN ROOM (REAL-TIME)
  // ============================================================

  async _handleJoin(ws, roomName) {
    if (!ws || !ws.username || !roomName || !ROOMS_SET.has(roomName) || 
        this.closing || this.isDestroyed) {
      return false;
    }
    
    const username = ws.username;
    const lockKey = `join_user_${username}`;
    
    // Lock check
    if (this._userJoinLock.has(lockKey)) {
      const lockTime = this._userJoinLock.get(lockKey);
      if (Date.now() - lockTime < C.USER_JOIN_LOCK_TIMEOUT) {
        this.safeSend(ws, ["joinInProgress", "Please wait..."]);
        return false;
      } else {
        this._userJoinLock.delete(lockKey);
      }
    }
    
    this._userJoinLock.set(lockKey, Date.now());
    
    try {
      return await this._joinInternal(ws, roomName, username);
    } finally {
      this._userJoinLock.delete(lockKey);
    }
  }

  async _joinInternal(ws, roomName, username) {
    console.log(`[JOIN] User "${username}" joining "${roomName}"`);
    
    // 1. Cek user di room lain
    const existing = await this._isUserInAnyRoom(username);
    if (existing && existing.room !== roomName) {
      console.log(`[JOIN] User in "${existing.room}", removing...`);
      await this._removeUserFromRoom(username, existing.room);
    }
    
    // 2. Load room data
    let roomData = await this._getRoomData(roomName);
    if (!roomData) {
      roomData = { seats: {}, points: {}, muted: false, number: 1 };
    }
    
    // 3. Cek user sudah di room ini
    let seat = null;
    for (const [s, data] of Object.entries(roomData.seats)) {
      if (data && data.namauser === username) {
        seat = parseInt(s);
        break;
      }
    }
    
    // 4. Tambahkan jika belum
    if (!seat) {
      const seatCount = Object.keys(roomData.seats).length;
      if (seatCount >= C.MAX_SEATS) {
        this.safeSend(ws, ["roomFull", roomName]);
        return false;
      }
      
      // Cari seat kosong
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
      
      // Assign seat
      roomData.seats[seat] = {
        noimageUrl: "",
        namauser: username,
        color: "",
        itembawah: 0,
        itematas: 0,
        vip: 0,
        viptanda: 0
      };
      
      await this._updateRoomData(roomName, (data) => {
        data.seats = roomData.seats;
        data.points = roomData.points || {};
        data.muted = roomData.muted || false;
        data.number = roomData.number || 1;
      });
      
      console.log(`[JOIN] User "${username}" assigned seat ${seat}`);
    }
    
    // 5. Save user seat
    const seatInfo = { room: roomName, seat, isMulti: false };
    await this._updateUserSeat(username, (data) => {
      Object.assign(data, seatInfo);
    });
    
    // 6. Update WebSocket
    ws.room = roomName;
    ws.roomname = roomName;
    ws.idtarget = username;
    ws._joinedAt = Date.now();
    
    // 7. Save attachment untuk hibernation
    ws.serializeAttachment({
      username: username,
      seatInfo: seatInfo,
      joinedAt: Date.now()
    });
    
    // 8. Update room clients
    for (const [otherRoom, clients] of this.roomClients) {
      if (otherRoom !== roomName && clients) {
        clients.delete(ws);
      }
    }
    const roomClients = this.roomClients.get(roomName);
    if (roomClients && !roomClients.has(ws)) {
      roomClients.add(ws);
    }
    
    this.wsActiveMulti.delete(ws);
    
    // 9. Send response
    this.safeSend(ws, ["rooMasuk", seat, roomName]);
    this.safeSend(ws, ["numberKursiSaya", seat]);
    this.safeSend(ws, ["muteTypeResponse", roomData.muted || false, roomName]);
    
    // 10. Broadcast count
    const count = Object.keys(roomData.seats).length;
    this.safeSend(ws, ["roomUserCount", roomName, count]);
    this.broadcast(roomName, ["roomUserCount", roomName, count]);
    
    // 11. Send all state (delay agar client siap)
    setTimeout(() => {
      try {
        if (ws && ws.readyState === 1 && !ws._closing) {
          this.sendAllStateTo(ws, roomName, true);
        }
      } catch (err) {
        console.error('[JOIN] Error sending state:', err.message);
      }
    }, 1000);
    
    console.log(`[JOIN] User "${username}" successfully joined "${roomName}" seat ${seat}`);
    return true;
  }

  // ============================================================
  // ✅ CHECK USER IN ANY ROOM (REAL-TIME)
  // ============================================================

  async _isUserInAnyRoom(username) {
    if (!username) return null;
    
    await this._loadFromStorage();
    const userSeatData = this._storageCache.userSeatData || {};
    const roomsData = this._storageCache.roomsData || {};
    
    // Cek di userSeatData dulu
    const seatInfo = userSeatData[username];
    if (seatInfo && seatInfo.room) {
      const roomData = roomsData[seatInfo.room];
      if (roomData && roomData.seats) {
        for (const [seat, data] of Object.entries(roomData.seats)) {
          if (data && data.namauser === username) {
            return { room: seatInfo.room, seat: parseInt(seat) };
          }
        }
      }
      // Data tidak valid, hapus
      delete userSeatData[username];
      await this._saveToStorage(undefined, userSeatData, undefined, true);
    }
    
    // Scan semua room
    for (const [roomName, roomData] of Object.entries(roomsData)) {
      if (!roomData || !roomData.seats) continue;
      for (const [seat, data] of Object.entries(roomData.seats)) {
        if (data && data.namauser === username) {
          // Update userSeatData
          userSeatData[username] = { room: roomName, seat: parseInt(seat) };
          await this._saveToStorage(undefined, userSeatData, undefined, true);
          return { room: roomName, seat: parseInt(seat) };
        }
      }
    }
    
    return null;
  }

  // ============================================================
  // ✅ ALARM (15 MENIT) - CLEANUP
  // ============================================================

  async alarm() {
    if (this.closing || this.isDestroyed) {
      console.log('[ALARM] Server closing, skipping');
      return;
    }
    
    // Tunggu init selesai
    if (!this._initialized) {
      console.log('[ALARM] Not initialized yet, skipping...');
      return;
    }
    
    console.log('[ALARM] Running scheduled tasks...');
    
    try {
      await this._updateNumber();
      await this._cleanupDeadConnections();
      await this._cleanupStaleLocks();
      await this._cleanupStorage();
      await this._syncAllState();
      
      // Schedule next alarm
      if (!this.closing && !this.isDestroyed) {
        await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        console.log('[ALARM] Next alarm scheduled');
      }
      
    } catch (err) {
      console.error('[ALARM] Error:', err.message);
      // Retry schedule
      if (!this.closing && !this.isDestroyed) {
        await this.ctx.storage.setAlarm(Date.now() + 60000);
      }
    }
  }

  async _updateNumber() {
    if (this._isNumberUpdating || this.closing || this.isDestroyed) return;
    
    this._isNumberUpdating = true;
    console.log('[NUMBER] Updating number...');
    
    try {
      this.currentNumber = this.currentNumber < C.MAX_NUMBER ? 
        this.currentNumber + 1 : 1;
      
      await this._saveToStorage(undefined, undefined, this.currentNumber, true);
      
      // Update number di semua room
      const roomsData = this._storageCache.roomsData || {};
      let changed = false;
      
      for (const roomName of Object.keys(roomsData)) {
        if (roomsData[roomName]) {
          roomsData[roomName].number = this.currentNumber;
          changed = true;
        }
      }
      
      if (changed) {
        await this._saveToStorage(roomsData, undefined, undefined, true);
      }
      
      // Broadcast ke semua room
      const numberMsg = JSON.stringify(["currentNumber", this.currentNumber]);
      for (const [room, clients] of this.roomClients) {
        if (clients && clients.size > 0) {
          this._broadcastToRoom(room, numberMsg);
        }
      }
      
      console.log(`[NUMBER] Updated to ${this.currentNumber}`);
      
    } catch (err) {
      console.error('[NUMBER] Error:', err.message);
    } finally {
      this._isNumberUpdating = false;
    }
  }

  // ============================================================
  // ✅ CLEANUP
  // ============================================================

  async _cleanupStorage() {
    console.log('[CLEANUP] Cleaning storage...');
    
    try {
      await this._loadFromStorage(true);
      const roomsData = this._storageCache.roomsData || {};
      const userSeatData = this._storageCache.userSeatData || {};
      
      let changed = false;
      
      // Hapus user seat yang tidak valid
      for (const [username, seatInfo] of Object.entries(userSeatData)) {
        if (!seatInfo || !seatInfo.room) {
          delete userSeatData[username];
          changed = true;
          continue;
        }
        
        const roomData = roomsData[seatInfo.room];
        if (!roomData || !roomData.seats || !roomData.seats[seatInfo.seat]) {
          delete userSeatData[username];
          changed = true;
          console.log(`[CLEANUP] Removed orphan user "${username}"`);
        }
      }
      
      // Hapus room kosong
      for (const [roomName, roomData] of Object.entries(roomsData)) {
        const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
        const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
        
        if (!hasSeats && !hasPoints) {
          delete roomsData[roomName];
          changed = true;
          console.log(`[CLEANUP] Removed empty room "${roomName}"`);
        }
      }
      
      if (changed) {
        await this._saveToStorage(roomsData, userSeatData, undefined, true);
        console.log('[CLEANUP] Storage cleaned');
      }
      
    } catch (err) {
      console.error('[CLEANUP] Error:', err.message);
    }
  }

  async _syncAllState() {
    console.log('[SYNC] Syncing all state...');
    
    try {
      await this._saveToStorage(
        this._storageCache.roomsData,
        this._storageCache.userSeatData,
        this._storageCache.currentNumber,
        true
      );
      console.log('[SYNC] State synced');
    } catch (err) {
      console.error('[SYNC] Error:', err.message);
    }
  }

  _cleanupDeadConnections() {
    console.log('[CLEANUP] Checking dead connections...');
    
    try {
      const toRemove = [];
      for (const ws of this.wsSet) {
        if (!ws || ws.readyState !== 1 || ws._closing) {
          toRemove.push(ws);
        }
      }
      
      if (toRemove.length > 0) {
        console.log(`[CLEANUP] Found ${toRemove.length} dead connections`);
        for (const ws of toRemove) {
          this.cleanup(ws);
        }
      }
      
    } catch (err) {
      console.error('[CLEANUP] Error:', err.message);
    }
  }

  _cleanupStaleLocks() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, time] of this._joinLocks) {
      if (now - time > C.LOCK_TIMEOUT) {
        this._joinLocks.delete(key);
        cleaned++;
      }
    }
    
    for (const [key, time] of this._kursiLocks) {
      if (now - time > C.LOCK_TIMEOUT) {
        this._kursiLocks.delete(key);
        cleaned++;
      }
    }
    
    for (const [key, time] of this._userJoinLock) {
      if (now - time > C.USER_JOIN_LOCK_TIMEOUT) {
        this._userJoinLock.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[CLEANUP] Cleaned ${cleaned} stale locks`);
    }
  }

  // ============================================================
  // ✅ WEBSOCKET HANDLERS (HIBERNATION)
  // ============================================================

  async webSocketMessage(ws, msg) {
    if (!ws || ws._closing || this._cleaningUp.has(ws) || 
        this.closing || this.isDestroyed) {
      return;
    }
    
    // Pastikan DO sudah initialized
    if (!this._initialized) {
      console.log('[WS MESSAGE] Not initialized, queuing...');
      // Process after init
      setTimeout(() => {
        if (!this.closing && !this.isDestroyed) {
          this.webSocketMessage(ws, msg);
        }
      }, 100);
      return;
    }
    
    try {
      await this.handleMessage(ws, msg);
    } catch (err) {
      console.error('[WS MESSAGE] Error:', err.message);
    }
  }

  async webSocketClose(ws) {
    if (!ws) return;
    
    console.log('[WS CLOSE] WebSocket closing...');
    
    try {
      await this._cleanupUserOnDisconnect(ws);
      this.cleanup(ws);
    } catch (err) {
      console.error('[WS CLOSE] Error:', err.message);
    }
  }

  async webSocketError(ws) {
    if (!ws) return;
    
    console.log('[WS ERROR] WebSocket error');
    
    try {
      await this._cleanupUserOnDisconnect(ws);
      this.cleanup(ws);
    } catch (err) {
      console.error('[WS ERROR] Error:', err.message);
    }
  }

  // ============================================================
  // ✅ CLEANUP USER ON DISCONNECT
  // ============================================================

  async _cleanupUserOnDisconnect(ws) {
    try {
      const username = ws.username;
      const roomName = ws.room || ws.roomname;
      
      if (!username) {
        console.log('[DISCONNECT] No username, skipping cleanup');
        return;
      }
      
      console.log(`[DISCONNECT] Cleaning up user "${username}" from room "${roomName}"`);
      
      // Coba dapatkan user seat dari storage
      let userSeat = await this._getUserSeat(username);
      
      // Jika tidak ada di storage, coba scan
      if (!userSeat && roomName) {
        const roomData = await this._getRoomData(roomName);
        if (roomData && roomData.seats) {
          for (const [seat, data] of Object.entries(roomData.seats)) {
            if (data && data.namauser === username) {
              userSeat = { room: roomName, seat: parseInt(seat) };
              break;
            }
          }
        }
      }
      
      // Hapus dari storage jika ada
      if (userSeat && userSeat.room) {
        await this._removeUserFromRoom(username, userSeat.room);
      } else {
        await this._deleteUserSeat(username);
      }
      
      // Hapus dari memory
      const connections = this.userConnections.get(username);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          this.userConnections.delete(username);
        }
      }
      
      // Hapus dari room clients
      const targetRoom = roomName || userSeat?.room;
      if (targetRoom) {
        const roomClients = this.roomClients.get(targetRoom);
        if (roomClients) {
          roomClients.delete(ws);
        }
      }
      
      // Hapus dari wsActiveMulti
      this.wsActiveMulti.delete(ws);
      
      // Hapus dari wsSet
      this.wsSet.delete(ws);
      
      console.log(`[DISCONNECT] User "${username}" fully cleaned`);
      
    } catch (err) {
      console.error('[DISCONNECT] Error:', err.message);
    }
  }

  // ============================================================
  // ✅ CLEANUP WEBSOCKET (MEMORY ONLY)
  // ============================================================

  cleanup(ws) {
    if (!ws || ws._cleaning || this._cleaningUp.has(ws)) return;
    
    ws._cleaning = true;
    this._cleaningUp.add(ws);
    
    try {
      const username = ws.username;
      const room = ws.room;
      
      // Hapus dari room clients
      if (room) {
        try {
          const clients = this.roomClients.get(room);
          if (clients) clients.delete(ws);
        } catch (err) {
          // Ignore
        }
      }
      
      // Hapus dari wsActiveMulti
      try {
        const activeData = this.wsActiveMulti.get(ws);
        if (activeData?.room) {
          const clients = this.roomClients.get(activeData.room);
          if (clients) clients.delete(ws);
        }
        this.wsActiveMulti.delete(ws);
      } catch (err) {
        // Ignore
      }
      
      // Hapus dari user connections
      if (username) {
        try {
          const connections = this.userConnections.get(username);
          if (connections) {
            connections.delete(ws);
            if (connections.size === 0) {
              this.userConnections.delete(username);
            }
          }
        } catch (err) {
          // Ignore
        }
      }
      
      // Hapus dari wsSet
      try {
        this.wsSet.delete(ws);
      } catch (err) {
        // Ignore
      }
      
    } catch (err) {
      // Ignore
    } finally {
      ws._cleaning = false;
      this._cleaningUp.delete(ws);
      
      try {
        if (ws && ws.readyState === 1) {
          ws.close(1000, "Cleanup");
        }
      } catch (err) {
        // Ignore
      }
    }
  }

  // ============================================================
  // ✅ HANDLE SET ID
  // ============================================================

  async _handleSetId(ws, username, isNewUser) {
    if (!ws || !username || typeof username !== 'string' || username.length === 0 || 
        this.closing || this.isDestroyed) {
      try {
        if (ws?.readyState === 1) {
          ws.close(1000, "Invalid username");
        }
      } catch (err) {
        // Ignore
      }
      return;
    }
    
    if (ws.readyState !== 1) {
      try {
        this.cleanup(ws);
      } catch (err) {
        // Ignore
      }
      return;
    }
    
    console.log(`[SET ID] Setting username "${username}" (new: ${isNewUser})`);
    
    // Cek user di room lain
    const existing = await this._isUserInAnyRoom(username);
    if (existing) {
      console.log(`[SET ID] User "${username}" in "${existing.room}", removing...`);
      await this._removeUserFromRoom(username, existing.room);
    }
    
    // Set ws properties
    ws.username = username;
    ws.idtarget = username;
    ws.room = null;
    ws.roomname = null;
    ws._closing = false;
    ws._usernameSet = Date.now();
    
    // Save attachment
    ws.serializeAttachment({
      username: username,
      setAt: Date.now()
    });
    
    // Add to user connections
    let connections = this.userConnections.get(username);
    if (!connections) {
      connections = new Set();
      this.userConnections.set(username, connections);
    }
    if (!connections.has(ws)) {
      connections.add(ws);
    }
    
    // Add to wsSet
    if (!this.wsSet.has(ws)) {
      this.wsSet.add(ws);
    }
    
    // Send response
    if (isNewUser) {
      this.safeSend(ws, ["joinroomawal"]);
    } else {
      this.safeSend(ws, ["needJoinRoom"]);
    }
    
    console.log(`[SET ID] Username "${username}" set successfully`);
  }

  // ============================================================
  // ✅ HANDLE MESSAGE
  // ============================================================

  async handleMessage(ws, raw) {
    if (!ws) return;
    
    try {
      if (ws.readyState !== 1 || ws._closing || this._cleaningUp.has(ws) || 
          this.closing || this.isDestroyed) {
        return;
      }
    } catch (err) {
      return;
    }
    
    if (this._processingMessages.has(ws)) return;
    this._processingMessages.add(ws);
    
    try {
      let str = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      if (str.length > C.MAX_MESSAGE_SIZE) {
        console.log('[MESSAGE] Message too large:', str.length);
        return;
      }
      
      let data;
      try {
        data = JSON.parse(str);
      } catch (err) {
        console.log('[MESSAGE] Invalid JSON');
        return;
      }
      
      if (!Array.isArray(data) || !data.length) return;
      
      const [evt, ...args] = data;
      
      // Validasi room untuk event tertentu
      if (evt === "chat" || evt === "updatePoint" || evt === "gift" || evt === "rollangak") {
        const room = args[0];
        if (room && !ROOMS_SET.has(room)) {
          console.log(`[MESSAGE] Invalid room: "${room}"`);
          return;
        }
      }
      
      // Queue event
      if (this._eventQueue.length < C.MAX_EVENT_QUEUE) {
        this._eventQueue.push({ ws, data: [evt, ...args] });
        if (!this._isProcessingQueue) {
          this._processEventQueue();
        }
      } else {
        console.log('[MESSAGE] Queue full, dropping event');
      }
      
    } catch (err) {
      console.error('[MESSAGE] Error:', err.message);
    } finally {
      try {
        this._processingMessages.delete(ws);
      } catch (err) {
        // Ignore
      }
    }
  }

  _processEventQueue() {
    if (this._isProcessingQueue || this._eventQueue.length === 0) {
      return;
    }
    
    this._isProcessingQueue = true;
    const startTime = Date.now();
    let processed = 0;
    
    try {
      while (this._eventQueue.length > 0 && processed < 50) {
        if (Date.now() - startTime > C.MAX_PROCESS_TIME_MS) {
          console.log('[QUEUE] Time limit reached, pausing');
          break;
        }
        
        const item = this._eventQueue.shift();
        if (item && item.ws && item.data) {
          try {
            this._handleEventInternal(item.ws, item.data);
          } catch (err) {
            console.error('[QUEUE] Event error:', err.message);
          }
        }
        processed++;
      }
      
      // Schedule next batch if queue not empty
      if (this._eventQueue.length > 0) {
        setTimeout(() => {
          this._processEventQueue();
        }, 10);
      }
      
    } catch (err) {
      console.error('[QUEUE] Error:', err.message);
    } finally {
      this._isProcessingQueue = false;
    }
  }

  // ============================================================
  // ✅ HANDLE EVENT INTERNAL
  // ============================================================

  async _handleEventInternal(ws, data) {
    if (!ws || !data || !data[0]) return;
    
    const [evt, ...args] = data;
    
    // Log event (kecuali chat/point untuk mengurangi spam)
    if (!['chat', 'updatePoint'].includes(evt)) {
      console.log(`[EVENT] ${evt} from "${ws.username}"`);
    }
    
    try {
      switch(evt) {
        case "getCurrentNumber":
          this.safeSend(ws, ["currentNumber", this.currentNumber]);
          break;
        
        case "setIdTarget2":
          await this._handleSetId(ws, args[0], args[1]);
          break;
        
        case "joinRoom":
          await this._handleJoin(ws, args[0]);
          break;
        
        case "multiJoin": {
          const multiUsername = args[0];
          const multiRoomname = args[1];
          
          if (!multiUsername || !multiRoomname) {
            console.log('[multiJoin] Missing username or room');
            break;
          }
          
          console.log(`[multiJoin] User "${multiUsername}" joining "${multiRoomname}"`);
          
          // Cek user di room lain
          const existing = await this._isUserInAnyRoom(multiUsername);
          if (existing) {
            await this._removeUserFromRoom(multiUsername, existing.room);
          }
          
          // Load room data
          let roomData = await this._getRoomData(multiRoomname);
          if (!roomData) {
            roomData = { seats: {}, points: {}, muted: false, number: 1 };
          }
          
          // Cari seat kosong
          const seatCount = Object.keys(roomData.seats).length;
          if (seatCount >= C.MAX_SEATS) {
            this.safeSend(ws, ["roomFull", multiRoomname]);
            break;
          }
          
          let seat = null;
          for (let s = 1; s <= C.MAX_SEATS; s++) {
            if (!roomData.seats[s]) {
              seat = s;
              break;
            }
          }
          
          if (!seat) {
            this.safeSend(ws, ["roomFull", multiRoomname]);
            break;
          }
          
          // Assign seat
          roomData.seats[seat] = {
            noimageUrl: "",
            namauser: multiUsername,
            color: "",
            itembawah: 0,
            itematas: 0,
            vip: 0,
            viptanda: 0
          };
          
          await this._updateRoomData(multiRoomname, (data) => {
            data.seats = roomData.seats;
            data.points = roomData.points || {};
          });
          
          // Save user seat
          const seatInfo = { room: multiRoomname, seat, isMulti: true };
          await this._updateUserSeat(multiUsername, (data) => {
            Object.assign(data, seatInfo);
          });
          
          // Update connections
          let connections = this.userConnections.get(multiUsername);
          if (!connections) connections = new Set();
          if (!connections.has(ws)) connections.add(ws);
          this.userConnections.set(multiUsername, connections);
          
          // Save attachment
          ws.serializeAttachment({
            username: multiUsername,
            seatInfo: seatInfo,
            isMulti: true
          });
          
          // Update room clients
          for (const [otherRoom, clients] of this.roomClients) {
            if (otherRoom !== multiRoomname && clients) {
              clients.delete(ws);
            }
          }
          const roomClients = this.roomClients.get(multiRoomname);
          if (roomClients && !roomClients.has(ws)) {
            roomClients.add(ws);
          }
          
          this.wsActiveMulti.set(ws, { 
            username: multiUsername, 
            room: multiRoomname 
          });
          
          // Send response
          this.safeSend(ws, ["rooMasukMulti", seat, multiRoomname]);
          this.broadcast(multiRoomname, ["roomUserCount", multiRoomname, Object.keys(roomData.seats).length]);
          
          console.log(`[multiJoin] User "${multiUsername}" joined seat ${seat}`);
          break;
        }
        
        case "exitMulti": {
          const targetUsername = args[0];
          if (!targetUsername) break;
          
          console.log(`[exitMulti] Exiting user "${targetUsername}"`);
          
          // Cari user di storage
          let userSeat = await this._getUserSeat(targetUsername);
          
          // Fallback: scan room
          if (!userSeat) {
            const roomsData = this._storageCache.roomsData || {};
            for (const [roomName, roomData] of Object.entries(roomsData)) {
              if (!roomData || !roomData.seats) continue;
              for (const [seat, data] of Object.entries(roomData.seats)) {
                if (data && data.namauser === targetUsername) {
                  userSeat = { room: roomName, seat: parseInt(seat) };
                  break;
                }
              }
              if (userSeat) break;
            }
          }
          
          if (!userSeat) {
            console.log(`[exitMulti] User "${targetUsername}" not found`);
            await this._deleteUserSeat(targetUsername);
            this.safeSend(ws, ["exitMultiSuccess", targetUsername, null, null]);
            break;
          }
          
          const roomName = userSeat.room;
          const seatNumber = userSeat.seat;
          
          // Hapus dari storage
          await this._removeUserFromRoom(targetUsername, roomName);
          await this._deleteUserSeat(targetUsername);
          
          // Hapus dari semua websocket
          const connections = this.userConnections.get(targetUsername);
          if (connections) {
            for (const conn of connections) {
              if (conn.room) {
                const rc = this.roomClients.get(conn.room);
                if (rc) rc.delete(conn);
              }
              this.wsActiveMulti.delete(conn);
              try {
                conn.serializeAttachment({});
                conn.username = null;
                conn.room = null;
                conn.roomname = null;
                conn.idtarget = null;
              } catch (err) {
                // Ignore
              }
            }
            this.userConnections.delete(targetUsername);
          }
          
          // Hapus dari wsActiveMulti
          const toDelete = [];
          for (const [wsKey, data] of this.wsActiveMulti) {
            if (data && data.username === targetUsername) {
              toDelete.push(wsKey);
              if (data.room) {
                const rc = this.roomClients.get(data.room);
                if (rc) rc.delete(wsKey);
              }
              try {
                wsKey.serializeAttachment({});
                wsKey.username = null;
                wsKey.room = null;
                wsKey.roomname = null;
                wsKey.idtarget = null;
              } catch (err) {
                // Ignore
              }
            }
          }
          for (const wsKey of toDelete) {
            this.wsActiveMulti.delete(wsKey);
            this.wsSet.delete(wsKey);
          }
          
          // Broadcast
          this.broadcast(roomName, ["removeKursi", roomName, seatNumber]);
          await this.updateRoomCount(roomName);
          await this._deleteRoomIfEmpty(roomName);
          
          this.safeSend(ws, ["exitMultiSuccess", targetUsername, roomName, seatNumber]);
          console.log(`[exitMulti] User "${targetUsername}" exited from "${roomName}" seat ${seatNumber}`);
          break;
        }
        
        case "setActiveMulti": {
          const targetUsername = args[0];
          const userSeat = await this._getUserSeat(targetUsername);
          
          if (!userSeat) {
            console.log(`[setActiveMulti] User "${targetUsername}" not found`);
            break;
          }
          
          const roomName = userSeat.room;
          const seatNumber = userSeat.seat;
          
          // Update ws
          this.wsActiveMulti.set(ws, { 
            username: targetUsername, 
            room: roomName 
          });
          
          for (const [otherRoom, clients] of this.roomClients) {
            if (otherRoom !== roomName && clients) {
              clients.delete(ws);
            }
          }
          const roomClients = this.roomClients.get(roomName);
          if (roomClients && !roomClients.has(ws)) {
            roomClients.add(ws);
          }
          
          ws.username = targetUsername;
          ws.idtarget = targetUsername;
          ws.room = roomName;
          ws.roomname = roomName;
          
          ws.serializeAttachment({
            username: targetUsername,
            seatInfo: userSeat,
            isMulti: true
          });
          
          this.safeSend(ws, ["activeChangedMulti", targetUsername, seatNumber, roomName]);
          this.broadcast(roomName, ["userActiveChanged", targetUsername, seatNumber]);
          
          console.log(`[setActiveMulti] User "${targetUsername}" set active in "${roomName}"`);
          break;
        }
        
        case "updateKursi": {
          const [kursiRoom, kursiSeat, kursiNoimg, kursiName, kursiColor, 
                 kursiBawah, kursiAtas, kursiVip, kursiVt] = args;
          
          const lockKey = `kursi_${kursiRoom}_${kursiSeat}`;
          if (this._kursiLocks.has(lockKey)) {
            console.log(`[updateKursi] Locked, skipping`);
            break;
          }
          
          this._kursiLocks.set(lockKey, Date.now());
          
          try {
            // Update di storage
            const roomData = await this._getRoomData(kursiRoom);
            if (!roomData || !roomData.seats || !roomData.seats[kursiSeat]) {
              break;
            }
            
            roomData.seats[kursiSeat] = {
              noimageUrl: kursiNoimg || "",
              namauser: kursiName || "",
              color: kursiColor || "",
              itembawah: kursiBawah || 0,
              itematas: kursiAtas || 0,
              vip: kursiVip || 0,
              viptanda: kursiVt || 0
            };
            
            await this._updateRoomData(kursiRoom, (data) => {
              data.seats = roomData.seats;
            });
            
            // Broadcast update
            const updatedSeat = roomData.seats[kursiSeat];
            if (updatedSeat) {
              this.broadcast(kursiRoom, ["kursiBatchUpdate", kursiRoom, [[kursiSeat, updatedSeat]]]);
            }
            
          } finally {
            this._kursiLocks.delete(lockKey);
          }
          break;
        }
        
        case "chat": {
          const [chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor] = args;
          
          if (!chatMsg || !ROOMS_SET.has(chatRoom)) {
            break;
          }
          
          // Validasi user di room
          const userSeat = await this._getUserSeat(chatUser);
          if (!userSeat || userSeat.room !== chatRoom) {
            console.log(`[chat] User "${chatUser}" not in room "${chatRoom}"`);
            break;
          }
          
          // Broadcast chat
          this._broadcastToRoom(chatRoom, JSON.stringify([
            "chat", chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor
          ]));
          break;
        }
        
        case "updatePoint": {
          const [pointRoom, pointSeat, pointX, pointY, pointFast] = args;
          
          if (!pointRoom || typeof pointSeat !== 'number') {
            break;
          }
          
          // Update di storage
          const roomData = await this._getRoomData(pointRoom);
          if (!roomData || !roomData.seats || !roomData.seats[pointSeat]) {
            break;
          }
          
          if (!roomData.points) roomData.points = {};
          
          roomData.points[pointSeat] = {
            x: pointX || 0,
            y: pointY || 0,
            fast: !!pointFast
          };
          
          await this._updateRoomData(pointRoom, (data) => {
            data.points = roomData.points;
          });
          
          // Broadcast
          this._broadcastToRoom(pointRoom, JSON.stringify([
            "pointUpdated", pointRoom, pointSeat, pointX, pointY, pointFast
          ]));
          break;
        }
        
        case "removeKursiAndPoint": {
          const [removeRoom, removeSeat] = args;
          
          const roomData = await this._getRoomData(removeRoom);
          let username = null;
          
          if (roomData && roomData.seats && roomData.seats[removeSeat]) {
            username = roomData.seats[removeSeat].namauser;
          }
          
          if (username) {
            await this._removeUserFromRoom(username, removeRoom);
          }
          break;
        }
        
        case "private": {
          const [privTarget, privNoimg, privMsg, privSender] = args;
          
          if (!privTarget || !privMsg) break;
          
          // Kirim ke target
          const targetConns = this.userConnections.get(privTarget);
          if (targetConns) {
            for (const targetWs of targetConns) {
              if (targetWs?.readyState === 1) {
                this.safeSend(targetWs, ["private", privTarget, privNoimg, privMsg, Date.now(), privSender]);
                break;
              }
            }
          }
          
          // Kirim balik ke sender
          this.safeSend(ws, ["private", privTarget, privNoimg, privMsg, Date.now(), privSender]);
          break;
        }
        
        case "gift": {
          const [giftRoom, giftSender, giftReceiver, giftGiftName] = args;
          
          if (!giftRoom || !ROOMS_SET.has(giftRoom)) break;
          
          const receiverSeat = await this._getUserSeat(giftReceiver);
          if (!receiverSeat || receiverSeat.room !== giftRoom) break;
          
          this._broadcastToRoom(giftRoom, JSON.stringify([
            "gift", giftRoom, giftSender, giftReceiver, giftGiftName, Date.now()
          ]));
          break;
        }
        
        case "rollangak": {
          const [rollRoom, rollUser, rollAngka] = args;
          
          if (!rollRoom || !ROOMS_SET.has(rollRoom)) break;
          
          const userSeat = await this._getUserSeat(rollUser);
          if (!userSeat || userSeat.room !== rollRoom) break;
          
          this._broadcastToRoom(rollRoom, JSON.stringify([
            "rollangakBroadcast", rollRoom, rollUser, rollAngka
          ]));
          break;
        }
        
        case "sendnotif": {
          try {
            const [notifTarget, notifNoimg, notifUser, notifMsg] = args;
            
            if (!notifTarget || !notifMsg) break;
            
            const targetConns = this.userConnections.get(notifTarget);
            if (targetConns) {
              for (const c of targetConns) {
                if (c?.readyState === 1) {
                  this.safeSend(c, ["notif", notifNoimg, notifUser, notifMsg, Date.now()]);
                  break;
                }
              }
            }
          } catch (err) {
            console.error('[notif] Error:', err.message);
          }
          break;
        }
        
        case "isUserOnline": {
          const [onlineTarget, onlineCallback] = args;
          
          let isOnline = false;
          const userSeat = await this._getUserSeat(onlineTarget);
          
          if (userSeat) {
            const connections = this.userConnections.get(onlineTarget);
            if (connections) {
              for (const conn of connections) {
                if (conn?.readyState === 1) {
                  isOnline = true;
                  break;
                }
              }
            }
          }
          
          this.safeSend(ws, ["userOnlineStatus", onlineTarget, isOnline, onlineCallback || ""]);
          break;
        }
        
        case "getOnlineUsers": {
          const users = [];
          const userSeatData = this._storageCache.userSeatData || {};
          
          for (const [username, seatInfo] of Object.entries(userSeatData)) {
            if (seatInfo) {
              const connections = this.userConnections.get(username);
              if (connections) {
                for (const conn of connections) {
                  if (conn?.readyState === 1) {
                    users.push(username);
                    break;
                  }
                }
              }
            }
          }
          
          this.safeSend(ws, ["allOnlineUsers", users]);
          break;
        }
        
        case "getAllRoomsUserCount": {
          const counts = {};
          const roomsData = this._storageCache.roomsData || {};
          
          for (const room of ROOMS) {
            const roomData = roomsData[room];
            counts[room] = roomData?.seats ? Object.keys(roomData.seats).length : 0;
          }
          
          this.safeSend(ws, ["allRoomsUserCount", Object.entries(counts)]);
          break;
        }
        
        case "getRoomUserCount": {
          const roomName = args[0];
          
          if (roomName && ROOMS_SET.has(roomName)) {
            const roomData = await this._getRoomData(roomName);
            const count = roomData?.seats ? Object.keys(roomData.seats).length : 0;
            this.safeSend(ws, ["roomUserCount", roomName, count]);
          }
          break;
        }
        
        case "setMuteType": {
          const [muteVal, muteRoom] = args;
          
          if (!muteRoom || !ROOMS_SET.has(muteRoom)) break;
          
          await this._updateRoomData(muteRoom, (data) => {
            data.muted = !!muteVal;
          });
          
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
            const roomData = await this._getRoomData(getMuteRoom);
            this.safeSend(ws, ["muteTypeResponse", roomData?.muted || false, getMuteRoom]);
          }
          break;
        }
        
        case "onDestroy":
          this.cleanup(ws);
          break;
        
        default:
          console.log(`[EVENT] Unknown event: ${evt}`);
          this.safeSend(ws, ["error", `Unknown event: ${evt}`]);
          break;
      }
      
    } catch (err) {
      console.error('[HANDLE EVENT] Error:', err.message, err.stack);
      this.safeSend(ws, ["error", err.message]);
    }
  }

  // ============================================================
  // ✅ FETCH
  // ============================================================

  async fetch(req) {
    console.log('[FETCH] Incoming request');
    
    // Pastikan DO sudah initialized
    if (!this._initialized && !this._initializing) {
      console.log('[FETCH] Initializing...');
      await this.initialize();
    }
    
    if (this.closing || this.isDestroyed) {
      console.log('[FETCH] Server is shutting down');
      return new Response("Shutting down", { status: 503 });
    }
    
    try {
      const upgrade = req.headers.get("Upgrade");
      
      if (upgrade !== "websocket") {
        return new Response("Chat Server", { 
          status: 200,
          headers: { 
            "Cache-Control": "no-cache",
            "Content-Type": "text/plain"
          }
        });
      }
      
      // Cek limit koneksi
      if (this.wsSet.size >= C.MAX_GLOBAL_CONNECTIONS) {
        console.log('[FETCH] Server full');
        return new Response("Server full", { status: 503 });
      }
      
      // Buat WebSocket pair
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      
      // Accept WebSocket (HIBERNATION)
      try {
        this.ctx.acceptWebSocket(server);
        console.log('[FETCH] WebSocket accepted');
      } catch (err) {
        console.error('[FETCH] Accept failed:', err.message);
        return new Response("WebSocket acceptance failed", { status: 500 });
      }
      
      // Set WebSocket state
      server.username = null;
      server.room = null;
      server.roomname = null;
      server.idtarget = null;
      server._closing = false;
      server._wsId = Date.now() + Math.random();
      server._createdAt = Date.now();
      
      // Save attachment
      server.serializeAttachment({
        createdAt: Date.now()
      });
      
      // Add to wsSet
      if (!this.wsSet.has(server)) {
        this.wsSet.add(server);
      }
      
      console.log(`[FETCH] New WebSocket connection (total: ${this.wsSet.size})`);
      
      return new Response(null, { 
        status: 101, 
        webSocket: client 
      });
      
    } catch (err) {
      console.error('[FETCH] Error:', err.message, err.stack);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // ============================================================
  // ✅ DESTROY
  // ============================================================

  async destroy() {
    if (this.isDestroyed) {
      console.log('[DESTROY] Already destroyed');
      return;
    }
    
    console.log('[DESTROY] Starting destruction...');
    
    this.closing = true;
    this.isDestroyed = true;
    
    try {
      // Cleanup storage
      await this._cleanupStorage();
      
      // Sync all state
      await this._syncAllState();
      
      // Clear locks
      this._joinLocks.clear();
      this._kursiLocks.clear();
      this._userJoinLock.clear();
      
      // Clear timeouts
      for (const timeout of this._pendingTimeouts) {
        clearTimeout(timeout);
      }
      this._pendingTimeouts.clear();
      
      if (this._cacheSyncTimeout) {
        clearTimeout(this._cacheSyncTimeout);
        this._cacheSyncTimeout = null;
      }
      
      // Close all WebSockets
      const wsCopy = Array.from(this.wsSet);
      console.log(`[DESTROY] Closing ${wsCopy.length} WebSockets...`);
      
      for (const ws of wsCopy) {
        try {
          if (ws?.readyState === 1) {
            ws.send(JSON.stringify(["serverShutdown", "Server shutting down"]));
            ws.close(1000, "Shutdown");
          }
        } catch (err) {
          // Ignore
        }
        
        try {
          this.cleanup(ws);
        } catch (err) {
          // Ignore
        }
      }
      
      // Clear memory
      this.wsSet.clear();
      this.userConnections.clear();
      this.roomClients.clear();
      this.wsActiveMulti.clear();
      this._processingMessages.clear();
      this._cleaningUp.clear();
      this._eventQueue.clear();
      
      console.log('[DESTROY] Destruction complete');
      
    } catch (err) {
      console.error('[DESTROY] Error:', err.message);
    }
  }
}

// ==================== EXPORT ====================
export default ChatServer;
