// ==================== CHAT-SERVER.JS ====================
// VERSION: 7.6.0 - NO LOOPS EXCEPT ALARM
// SEMUA LOOP DIHAPUS KECUALI ALARM

const C = {
  MAX_SEATS: 45,
  MAX_GLOBAL_CONNECTIONS: 150,
  MAX_MESSAGE_SIZE: 5000,
  NUMBER_INTERVAL_MS: 900000, // 15 MENIT
  MAX_NUMBER: 6,
  BATCH_SIZE: 20,
  LOCK_TIMEOUT: 5000,
  MAX_EVENT_QUEUE: 100,
  USER_JOIN_LOCK_TIMEOUT: 10000,
  
  // ========== CACHE CONFIGURATION ==========
  CACHE_TTL: {
    ROOM_DATA: 200,
    USER_SEAT: 200,
    ROOM_LIST: 500,
    ONLINE_USERS: 300,
    ROOM_COUNT: 100,
  },
  BATCH_WRITE_INTERVAL: 100,
  MAX_BATCH_SIZE: 50,
  MAX_CACHE_SIZE: 1000,
};

const ROOMS = [
  "LowCard", "Quiz", "Gacor", "General", "LOVE BIRDS", "Birthday Party",
  "Sweet Memories", "Lounge Talk", "Noxxeliverothcifsa", "BESTIES",
  "Happy Vibes", "The Chatter Room"
];

const ROOMS_SET = new Set(ROOMS);

// ==================== CACHE MANAGER ====================
class CacheManager {
  constructor(maxSize = C.MAX_CACHE_SIZE) {
    this._cache = new Map();
    this._maxSize = maxSize;
    this._stats = { hits: 0, misses: 0, writes: 0, evictions: 0 };
    // TIDAK ADA INTERVAL LOOP
  }

  get(key) {
    const entry = this._cache.get(key);
    if (!entry) {
      this._stats.misses++;
      return null;
    }
    
    if (Date.now() - entry.timestamp > entry.ttl) {
      this._cache.delete(key);
      this._stats.misses++;
      return null;
    }
    
    this._stats.hits++;
    return entry.data;
  }

  set(key, data, ttl) {
    // Hapus expired entries jika cache penuh
    if (this._cache.size >= this._maxSize) {
      this._cleanup();
      if (this._cache.size >= this._maxSize) {
        const oldestKey = this._findOldestKey();
        if (oldestKey) {
          this._cache.delete(oldestKey);
          this._stats.evictions++;
        }
      }
    }
    
    this._cache.set(key, {
      data: data,
      timestamp: Date.now(),
      ttl: ttl || 5000
    });
    this._stats.writes++;
  }

  delete(key) {
    return this._cache.delete(key);
  }

  clear() {
    this._cache.clear();
  }

  _cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this._cache) {
      if (now - entry.timestamp > entry.ttl) {
        this._cache.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }

  _findOldestKey() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this._cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    return oldestKey;
  }

  getStats() {
    const total = this._stats.hits + this._stats.misses;
    return {
      hits: this._stats.hits,
      misses: this._stats.misses,
      hitRate: total > 0 ? (this._stats.hits / total * 100).toFixed(2) + '%' : '0%',
      size: this._cache.size,
      maxSize: this._maxSize,
      writes: this._stats.writes,
      evictions: this._stats.evictions
    };
  }

  // DIPANGGIL DARI ALARM SAJA
  cleanup() {
    return this._cleanup();
  }

  destroy() {
    this._cache.clear();
  }
}

// ==================== BATCH WRITE MANAGER ====================
class BatchWriteManager {
  constructor(storage, maxBatchSize = C.MAX_BATCH_SIZE, interval = C.BATCH_WRITE_INTERVAL) {
    this.storage = storage;
    this._pendingWrites = [];
    this._writeTimeout = null;
    this._isWriting = false;
    this._maxBatchSize = maxBatchSize;
    this._interval = interval;
    this._lastBatchTime = Date.now();
    this._stats = { writes: 0, batches: 0, failed: 0, retries: 0 };
    this._retryQueue = [];
    this._maxRetries = 3;
  }

  addWrite(key, value) {
    const existingIndex = this._pendingWrites.findIndex(w => w.key === key);
    if (existingIndex !== -1) {
      this._pendingWrites[existingIndex] = { key, value, retries: 0 };
    } else {
      this._pendingWrites.push({ key, value, retries: 0 });
    }
    this._stats.writes++;
    
    // TIDAK ADA SCHEDULE LOOP - LANGSUNG FLUSH
    if (this._pendingWrites.length >= this._maxBatchSize) {
      this._flush();
    }
  }

  _scheduleFlush() {
    // DIPANGGIL DARI ALARM SAJA
    if (this._pendingWrites.length > 0) {
      this._flush();
    }
  }

  async _flush() {
    if (this._isWriting) return;
    if (this._pendingWrites.length === 0 && this._retryQueue.length === 0) return;
    
    this._isWriting = true;
    
    const allWrites = [...this._pendingWrites, ...this._retryQueue];
    this._pendingWrites = [];
    this._retryQueue = [];
    
    const groupedWrites = {};
    for (const { key, value, retries } of allWrites) {
      groupedWrites[key] = { value, retries };
    }
    
    const batchSize = Object.keys(groupedWrites).length;
    
    try {
      const writes = {};
      for (const [key, { value }] of Object.entries(groupedWrites)) {
        writes[key] = value;
      }
      
      await this.storage.put(writes);
      this._stats.batches++;
      this._lastBatchTime = Date.now();
      
    } catch(e) {
      console.error('[BATCH WRITE] Error:', e.message);
      this._stats.failed++;
      
      const retryWrites = [];
      for (const [key, { value, retries }] of Object.entries(groupedWrites)) {
        if (retries < this._maxRetries) {
          retryWrites.push({ key, value, retries: retries + 1 });
        }
      }
      
      if (retryWrites.length > 0) {
        this._stats.retries++;
        this._retryQueue.push(...retryWrites);
      }
    } finally {
      this._isWriting = false;
    }
  }

  async forceFlush() {
    if (this._pendingWrites.length > 0 || this._retryQueue.length > 0) {
      await this._flush();
    }
  }

  getStats() {
    return {
      pending: this._pendingWrites.length,
      retryQueue: this._retryQueue.length,
      batches: this._stats.batches,
      writes: this._stats.writes,
      failed: this._stats.failed,
      retries: this._stats.retries,
      isWriting: this._isWriting,
      lastBatchTime: this._lastBatchTime
    };
  }

  destroy() {
    if (this._writeTimeout) {
      clearTimeout(this._writeTimeout);
    }
    this._pendingWrites = [];
    this._retryQueue = [];
  }
}

// ==================== RATE LIMITER ====================
class RateLimiter {
  constructor() {
    this._limits = new Map();
  }

  isAllowed(key, limit = 20, window = 1000) {
    const now = Date.now();
    const userLimit = this._limits.get(key);
    
    if (!userLimit) {
      this._limits.set(key, { count: 1, reset: now + window });
      return true;
    }
    
    if (now > userLimit.reset) {
      this._limits.set(key, { count: 1, reset: now + window });
      return true;
    }
    
    if (userLimit.count < limit) {
      userLimit.count++;
      return true;
    }
    
    return false;
  }

  // DIPANGGIL DARI ALARM SAJA
  cleanup() {
    const now = Date.now();
    for (const [key, data] of this._limits) {
      if (now > data.reset) {
        this._limits.delete(key);
      }
    }
  }

  destroy() {
    this._limits.clear();
  }
}

// ==================== CHAT SERVER ====================
export class ChatServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ctx = state;
    this.closing = false;
    this.isDestroyed = false;
    this._startTime = Date.now();
    this._restored = false;
    
    // ========== WEBSOCKET ==========
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
    
    // ========== CACHE & BATCH WRITE ==========
    this._cache = new CacheManager();
    this._batchWriter = new BatchWriteManager(this.ctx.storage);
    this._rateLimiter = new RateLimiter();
    
    // ========== TIDAK ADA INTERVAL ==========
    // Semua cleanup dipanggil dari alarm
    
    // ========== INIT ROOMS ==========
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    // ========== RESTORE STATE ==========
    this._restoreAllState().then(() => {
      this._restored = true;
      console.log('[SERVER] Restored successfully');
    }).catch((e) => {
      console.error('[SERVER] Restore error:', e.message);
      this._restored = true;
    });
  }

  // ============================================================
  // ✅ STORAGE OPERATIONS WITH CACHING
  // ============================================================

  async _loadFromStorage(forceRefresh = false) {
    const cacheKey = 'full_storage';
    if (!forceRefresh) {
      const cached = this._cache.get(cacheKey);
      if (cached !== null) {
        return cached;
      }
    }
    
    try {
      const [roomsData, userSeatData, currentNumber] = await Promise.all([
        this.ctx.storage.get("roomsData"),
        this.ctx.storage.get("userSeatData"),
        this.ctx.storage.get("currentNumber")
      ]);
      
      const data = { 
        roomsData: roomsData || {}, 
        userSeatData: userSeatData || {}, 
        currentNumber: currentNumber || 1 
      };
      
      this._cache.set(cacheKey, data, C.CACHE_TTL.ROOM_LIST);
      return data;
    } catch(e) {
      console.error('[LOAD STORAGE] Error:', e.message);
      return { roomsData: {}, userSeatData: {}, currentNumber: 1 };
    }
  }

  async _getRoomData(roomName, forceRefresh = false) {
    if (!roomName) return null;
    
    const cacheKey = `room_${roomName}`;
    if (!forceRefresh) {
      const cached = this._cache.get(cacheKey);
      if (cached !== null) {
        return cached;
      }
    }
    
    const storage = await this._loadFromStorage(forceRefresh);
    const roomData = storage.roomsData[roomName] || null;
    
    if (roomData) {
      this._cache.set(cacheKey, roomData, C.CACHE_TTL.ROOM_DATA);
    }
    
    return roomData;
  }

  async _getUserSeat(username, forceRefresh = false) {
    if (!username) return null;
    
    const cacheKey = `user_${username}`;
    if (!forceRefresh) {
      const cached = this._cache.get(cacheKey);
      if (cached !== null) {
        return cached;
      }
    }
    
    const storage = await this._loadFromStorage(forceRefresh);
    const userSeat = storage.userSeatData[username] || null;
    
    if (userSeat) {
      this._cache.set(cacheKey, userSeat, C.CACHE_TTL.USER_SEAT);
    }
    
    return userSeat;
  }

  async _getRoomCount(roomName) {
    const cacheKey = `room_count_${roomName}`;
    const cached = this._cache.get(cacheKey);
    if (cached !== null) {
      return cached;
    }
    
    const roomData = await this._getRoomData(roomName);
    const count = roomData?.seats ? Object.keys(roomData.seats).length : 0;
    this._cache.set(cacheKey, count, C.CACHE_TTL.ROOM_COUNT);
    return count;
  }

  async _updateRoomData(roomName, updater) {
    this._cache.delete(`room_${roomName}`);
    this._cache.delete(`room_count_${roomName}`);
    this._cache.delete('full_storage');
    this._cache.delete('all_rooms');
    
    const storage = await this._loadFromStorage(true);
    const roomsData = storage.roomsData || {};
    
    if (!roomsData[roomName]) {
      roomsData[roomName] = { seats: {}, points: {}, muted: false, number: 1 };
    }
    
    updater(roomsData[roomName]);
    
    this._batchWriter.addWrite("roomsData", roomsData);
    this._cache.set(`room_${roomName}`, roomsData[roomName], C.CACHE_TTL.ROOM_DATA);
    
    return roomsData[roomName];
  }

  async _updateUserSeat(username, updater) {
    this._cache.delete(`user_${username}`);
    this._cache.delete(`user_room_${username}`);
    this._cache.delete('full_storage');
    
    const storage = await this._loadFromStorage(true);
    const userSeatData = storage.userSeatData || {};
    
    if (!userSeatData[username]) {
      userSeatData[username] = {};
    }
    
    updater(userSeatData[username]);
    
    if (Object.keys(userSeatData[username]).length === 0) {
      delete userSeatData[username];
    }
    
    this._batchWriter.addWrite("userSeatData", userSeatData);
    
    if (userSeatData[username]) {
      this._cache.set(`user_${username}`, userSeatData[username], C.CACHE_TTL.USER_SEAT);
    }
    
    return userSeatData[username];
  }

  async _deleteUserSeat(username) {
    this._cache.delete(`user_${username}`);
    this._cache.delete(`user_room_${username}`);
    this._cache.delete('full_storage');
    
    const storage = await this._loadFromStorage(true);
    const userSeatData = storage.userSeatData || {};
    delete userSeatData[username];
    this._batchWriter.addWrite("userSeatData", userSeatData);
  }

  async _isUserInAnyRoom(username) {
    if (!username) return null;
    
    const cacheKey = `user_room_${username}`;
    const cached = this._cache.get(cacheKey);
    if (cached !== null) {
      return cached;
    }
    
    const userSeat = await this._getUserSeat(username);
    if (userSeat && userSeat.room) {
      const roomData = await this._getRoomData(userSeat.room);
      if (roomData && roomData.seats) {
        for (const [seat, data] of Object.entries(roomData.seats)) {
          if (data && data.namauser === username) {
            const result = { room: userSeat.room, seat: parseInt(seat) };
            this._cache.set(cacheKey, result, C.CACHE_TTL.USER_SEAT);
            return result;
          }
        }
      }
    }
    
    // Fallback: full scan (hanya jika tidak ada di cache)
    const storage = await this._loadFromStorage();
    for (const [roomName, roomData] of Object.entries(storage.roomsData)) {
      if (!roomData || !roomData.seats) continue;
      for (const [seat, data] of Object.entries(roomData.seats)) {
        if (data && data.namauser === username) {
          const result = { room: roomName, seat: parseInt(seat) };
          const userSeatData = storage.userSeatData || {};
          userSeatData[username] = { room: roomName, seat: parseInt(seat) };
          this._batchWriter.addWrite("userSeatData", userSeatData);
          this._cache.set(cacheKey, result, C.CACHE_TTL.USER_SEAT);
          this._cache.set(`user_${username}`, userSeatData[username], C.CACHE_TTL.USER_SEAT);
          return result;
        }
      }
    }
    
    return null;
  }

  async _removeUserFromRoom(username, roomName) {
    if (!username || !roomName) return false;
    
    this._cache.delete(`user_${username}`);
    this._cache.delete(`user_room_${username}`);
    this._cache.delete(`room_${roomName}`);
    this._cache.delete(`room_count_${roomName}`);
    this._cache.delete('full_storage');
    
    const roomData = await this._getRoomData(roomName, true);
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
    
    const storage = await this._loadFromStorage(true);
    const roomsData = storage.roomsData || {};
    roomsData[roomName] = roomData;
    this._batchWriter.addWrite("roomsData", roomsData);
    
    const userSeatData = storage.userSeatData || {};
    delete userSeatData[username];
    this._batchWriter.addWrite("userSeatData", userSeatData);
    
    this.broadcast(roomName, ["removeKursi", roomName, seat]);
    await this.updateRoomCount(roomName);
    await this._deleteRoomIfEmpty(roomName);
    
    return true;
  }

  async _updateKursi(roomName, seat, data) {
    if (!roomName || !ROOMS_SET.has(roomName)) {
      return { success: false, error: 'Invalid room' };
    }
    
    if (typeof seat !== 'number' || seat < 1 || seat > C.MAX_SEATS) {
      return { success: false, error: 'Invalid seat number' };
    }
    
    if (!data || !data.namauser) {
      return { success: false, error: 'Username is required' };
    }
    
    const roomData = await this._getRoomData(roomName);
    if (!roomData || !roomData.seats || !roomData.seats[seat]) {
      return { success: false, error: 'Seat not found' };
    }
    
    const currentSeatData = roomData.seats[seat];
    if (currentSeatData.namauser !== data.namauser) {
      return { success: false, error: 'You do not own this seat' };
    }
    
    roomData.seats[seat] = {
      noimageUrl: data.noimageUrl || currentSeatData.noimageUrl || "",
      namauser: data.namauser || currentSeatData.namauser || "",
      color: data.color || currentSeatData.color || "",
      itembawah: typeof data.itembawah === 'number' ? data.itembawah : (parseInt(data.itembawah) || 0),
      itematas: typeof data.itematas === 'number' ? data.itematas : (parseInt(data.itematas) || 0),
      vip: typeof data.vip === 'number' ? data.vip : (parseInt(data.vip) || 0),
      viptanda: typeof data.viptanda === 'number' ? data.viptanda : (parseInt(data.viptanda) || 0)
    };
    
    await this._updateRoomData(roomName, (d) => {
      d.seats = roomData.seats;
    });
    
    return { success: true, data: roomData.seats[seat] };
  }

  async _updatePoint(roomName, seat, x, y, fast) {
    const roomData = await this._getRoomData(roomName);
    if (!roomData || !roomData.seats || !roomData.seats[seat]) return false;
    
    if (!roomData.points) roomData.points = {};
    roomData.points[seat] = { x: x || 0, y: y || 0, fast: !!fast };
    await this._updateRoomData(roomName, (d) => {
      d.points = roomData.points;
    });
    return true;
  }

  async _deleteRoomIfEmpty(roomName) {
    const roomData = await this._getRoomData(roomName, true);
    if (!roomData) return;
    
    const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
    const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
    
    if (!hasSeats && !hasPoints) {
      const storage = await this._loadFromStorage(true);
      const roomsData = storage.roomsData || {};
      delete roomsData[roomName];
      this._batchWriter.addWrite("roomsData", roomsData);
      this._cache.delete(`room_${roomName}`);
      this._cache.delete(`room_count_${roomName}`);
      this._cache.delete('full_storage');
      this._cache.delete('all_rooms');
    }
  }

  // ============================================================
  // ✅ WEBSOCKET HANDLERS
  // ============================================================
  
  async webSocketMessage(ws, msg) {
    if (!ws || ws._closing || this._cleaningUp.has(ws) || this.closing || this.isDestroyed) return;
    try { 
      await this.handleMessage(ws, msg); 
    } catch(e) {
      console.error('[WS MESSAGE] Error:', e.message);
    }
  }

  async webSocketClose(ws) { 
    if (!ws) return;
    try {
      await this._cleanupUserOnDisconnect(ws);
      this.cleanup(ws);
    } catch(e) {
      console.error('[WS CLOSE] Error:', e.message);
    }
  }

  async webSocketError(ws) { 
    if (!ws) return;
    try {
      await this._cleanupUserOnDisconnect(ws);
      this.cleanup(ws);
    } catch(e) {
      console.error('[WS ERROR] Error:', e.message);
    }
  }

  // ============================================================
  // ✅ CLEANUP USER ON DISCONNECT
  // ============================================================
  
  async _cleanupUserOnDisconnect(ws) {
    try {
      const username = ws.username;
      const roomName = ws.room || ws.roomname;
      
      if (!username) return;
      
      const isMulti = this.wsActiveMulti.has(ws);
      
      if (isMulti) {
        const connections = this.userConnections.get(username);
        if (connections) {
          connections.delete(ws);
          if (connections.size === 0) {
            this.userConnections.delete(username);
          }
        }
        
        if (roomName) {
          const roomClients = this.roomClients.get(roomName);
          if (roomClients) roomClients.delete(ws);
        } else {
          try {
            const attachment = ws.deserializeAttachment();
            if (attachment && attachment.seatInfo && attachment.seatInfo.room) {
              const roomClients = this.roomClients.get(attachment.seatInfo.room);
              if (roomClients) roomClients.delete(ws);
            }
          } catch(e) {}
        }
        
        this.wsActiveMulti.delete(ws);
        this.wsSet.delete(ws);
        return;
      }
      
      if (roomName) {
        await this._removeUserFromRoom(username, roomName);
      } else {
        const userSeat = await this._getUserSeat(username);
        if (userSeat && userSeat.room) {
          await this._removeUserFromRoom(username, userSeat.room);
        } else {
          await this._deleteUserSeat(username);
        }
      }
      
      const connections = this.userConnections.get(username);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          this.userConnections.delete(username);
        }
      }
      
      const targetRoom = roomName || (await this._getUserSeat(username))?.room;
      if (targetRoom) {
        const roomClients = this.roomClients.get(targetRoom);
        if (roomClients) {
          roomClients.delete(ws);
        }
      }
      
      this.wsActiveMulti.delete(ws);
      this.wsSet.delete(ws);
      
    } catch(e) {
      console.error('[DISCONNECT] Error:', e.message);
    }
  }

  // ============================================================
  // ✅ BROADCAST
  // ============================================================
  
  _broadcastToRoom(room, msgStr) {
    if (this.closing || this.isDestroyed || !room) return;
    const clients = this.roomClients.get(room);
    if (!clients || clients.size === 0) return;
    
    // TIDAK ADA LOOP - LANGSUNG KONVERSI ARRAY DAN KIRIM
    const clientArray = Array.from(clients);
    const toRemove = [];
    
    for (let i = 0; i < clientArray.length; i++) {
      const ws = clientArray[i];
      if (!ws) { toRemove.push(ws); continue; }
      
      const wsRoom = ws.room || ws.roomname;
      if (wsRoom !== room) {
        toRemove.push(ws);
        continue;
      }
      
      try {
        if (ws.readyState === 1 && !ws._closing && !this._cleaningUp.has(ws)) {
          ws.send(msgStr);
        } else {
          toRemove.push(ws);
        }
      } catch(e) { toRemove.push(ws); }
    }
    
    // Hapus client yang bermasalah
    for (const ws of toRemove) {
      try {
        clients.delete(ws);
        if (ws && !this._cleaningUp.has(ws)) this.cleanup(ws);
      } catch(e) {}
    }
  }

  broadcast(room, msg) {
    if (this.closing || this.isDestroyed || !room || !msg) return;
    try { this._broadcastToRoom(room, JSON.stringify(msg)); } catch(e) {}
  }

  // ============================================================
  // ✅ SAFE SEND
  // ============================================================
  
  safeSend(ws, msg) {
    if (!ws) return false;
    try {
      if (ws.readyState !== 1 || ws._closing || this._cleaningUp.has(ws) || this.closing || this.isDestroyed) {
        return false;
      }
      ws.send(JSON.stringify(msg));
      return true;
    } catch(e) {
      this.cleanup(ws);
      return false;
    }
  }

  // ============================================================
  // ✅ UPDATE ROOM COUNT
  // ============================================================
  
  async updateRoomCount(room) {
    if (this.closing || this.isDestroyed || !room) return 0;
    try {
      const count = await this._getRoomCount(room);
      this.broadcast(room, ["roomUserCount", room, count]);
      return count;
    } catch(e) { return 0; }
  }

  // ============================================================
  // ✅ SEND ALL STATE
  // ============================================================
  
  async sendAllStateTo(ws, room, excludeSelf = false) {
    if (!ws || !ws.username) return;
    try {
      if (ws.readyState !== 1 || ws._closing) return;
    } catch(e) { return; }
    
    const roomData = await this._getRoomData(room);
    if (!roomData) return;
    
    try {
      const allSeats = roomData.seats || {};
      const allPoints = roomData.points || {};
      
      const userSeat = await this._getUserSeat(ws.username);
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

  // ============================================================
  // ✅ JOIN ROOM
  // ============================================================
  
  async _handleJoin(ws, roomName) {
    if (!ws || !ws.username || !roomName || !ROOMS_SET.has(roomName) || this.closing || this.isDestroyed) {
      return false;
    }
    
    const username = ws.username;
    const lockKey = `join_user_${username}`;
    
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
    const existing = await this._isUserInAnyRoom(username);
    if (existing && existing.room !== roomName) {
      await this._removeUserFromRoom(username, existing.room);
    }
    
    let roomData = await this._getRoomData(roomName);
    if (!roomData) {
      roomData = { seats: {}, points: {}, muted: false, number: 1 };
    }
    
    let seat = null;
    for (const [s, data] of Object.entries(roomData.seats)) {
      if (data && data.namauser === username) {
        seat = parseInt(s);
        break;
      }
    }
    
    if (!seat) {
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
      
      await this._updateRoomData(roomName, (data) => {
        data.seats = roomData.seats;
        data.points = roomData.points || {};
        data.muted = roomData.muted || false;
        data.number = roomData.number || 1;
      });
    }
    
    const seatInfo = { room: roomName, seat, isMulti: false };
    await this._updateUserSeat(username, (data) => {
      Object.assign(data, seatInfo);
    });
    
    ws.room = roomName;
    ws.roomname = roomName;
    ws.idtarget = username;
    
    ws.serializeAttachment({
      username: username,
      seatInfo: seatInfo
    });
    
    for (const [otherRoom, clients] of this.roomClients) {
      if (otherRoom !== roomName && clients) {
        clients.delete(ws);
      }
    }
    const roomClients = this.roomClients.get(roomName);
    if (roomClients && !roomClients.has(ws)) roomClients.add(ws);
    
    this.wsActiveMulti.delete(ws);
    
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
  }

  // ============================================================
  // ✅ HANDLE SET ID
  // ============================================================
  
  async _handleSetId(ws, username, isNewUser) {
    if (!ws || !username || typeof username !== 'string' || username.length === 0 || this.closing || this.isDestroyed) {
      try { if (ws?.readyState === 1) ws.close(1000, "Invalid username"); } catch(e) {}
      return;
    }
    
    const userSeat = await this._getUserSeat(username);
    const isMultiUser = userSeat !== null && userSeat !== undefined;
    
    if (isMultiUser && isNewUser === false) {
      return;
    }
    
    if (isMultiUser && isNewUser === true) {
      await this._removeUserFromRoom(username, userSeat.room);
      await this._deleteUserSeat(username);
    }
    
    const existing = await this._isUserInAnyRoom(username);
    if (existing) {
      await this._removeUserFromRoom(username, existing.room);
    }
    
    ws.username = username;
    ws.idtarget = username;
    ws.room = null;
    ws.roomname = null;
    ws._closing = false;
    
    ws.serializeAttachment({ username: username });
    
    let connections = this.userConnections.get(username);
    if (!connections) { 
      connections = new Set(); 
      this.userConnections.set(username, connections); 
    }
    if (!connections.has(ws)) connections.add(ws);
    if (!this.wsSet.has(ws)) this.wsSet.add(ws);
    
    this.wsActiveMulti.delete(ws);
    
    if (isNewUser) { 
      this.safeSend(ws, ["joinroomawal"]); 
    } else { 
      this.safeSend(ws, ["needJoinRoom"]); 
    }
  }

  // ============================================================
  // ✅ HANDLE MESSAGE - TANPA LOOP
  // ============================================================
  
  async handleMessage(ws, raw) {
    if (!ws) return;
    try {
      if (ws.readyState !== 1 || ws._closing || this._cleaningUp.has(ws) || this.closing || this.isDestroyed) {
        return;
      }
    } catch(e) { return; }
    
    // Rate limiting
    const username = ws.username || 'anonymous';
    if (!this._rateLimiter.isAllowed(username, 20, 1000)) {
      this.safeSend(ws, ["rateLimit", "Too many messages"]);
      return;
    }
    
    if (this._processingMessages.has(ws)) return;
    this._processingMessages.add(ws);
    
    try {
      let str = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      if (str.length > C.MAX_MESSAGE_SIZE) return;
      
      let data;
      try { data = JSON.parse(str); } catch(e) { return; }
      if (!Array.isArray(data) || !data.length) return;
      
      const [evt, ...args] = data;
      
      // Fast path untuk chat - LANGSUNG PROSES, TANPA QUEUE
      if (evt === "chat") {
        const room = args[0];
        if (room && ROOMS_SET.has(room)) {
          await this._handleChat(ws, args);
        }
        return;
      }
      
      // Event lain diproses langsung, TANPA QUEUE
      await this._handleEventInternal(ws, data);
      
    } catch(e) {} finally {
      try { this._processingMessages.delete(ws); } catch(e) {}
    }
  }

  // ============================================================
  // ✅ FAST CHAT HANDLER - TANPA QUEUE
  // ============================================================
  
  async _handleChat(ws, args) {
    const [chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor] = args;
    if (!chatMsg || !chatRoom || !ROOMS_SET.has(chatRoom)) return;
    
    const userSeat = await this._getUserSeat(chatUser);
    if (!userSeat || userSeat.room !== chatRoom) return;
    
    this._broadcastToRoom(chatRoom, JSON.stringify(["chat", chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor]));
  }

  // ============================================================
  // ✅ CLEANUP WEBSOCKET
  // ============================================================
  
  cleanup(ws) {
    if (!ws || ws._cleaning || this._cleaningUp.has(ws)) return;
    ws._cleaning = true;
    this._cleaningUp.add(ws);
    
    try {
      const username = ws.username;
      const room = ws.room;
      
      if (room) {
        try { this.roomClients.get(room)?.delete(ws); } catch(e) {}
      }
      
      try {
        const activeData = this.wsActiveMulti.get(ws);
        if (activeData?.room) {
          this.roomClients.get(activeData.room)?.delete(ws);
        }
        this.wsActiveMulti.delete(ws);
      } catch(e) {}
      
      if (username) {
        try {
          const connections = this.userConnections.get(username);
          if (connections) {
            connections.delete(ws);
            if (connections.size === 0) {
              this.userConnections.delete(username);
            }
          }
        } catch(e) {}
      }
      
      try { this.wsSet.delete(ws); } catch(e) {}
    } catch(e) {} finally {
      ws._cleaning = false;
      this._cleaningUp.delete(ws);
      try { if (ws && ws.readyState === 1) ws.close(1000, "Cleanup"); } catch(e) {}
    }
  }

  // ============================================================
  // ✅ HANDLE EVENT INTERNAL
  // ============================================================
  
  async _handleEventInternal(ws, data) {
    try {
      if (!ws || !data || !data[0]) return;
      const [evt, ...args] = data;
      
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
          if (!multiUsername || !multiRoomname) break;
          
          const existing = await this._isUserInAnyRoom(multiUsername);
          if (existing) {
            await this._removeUserFromRoom(multiUsername, existing.room);
          }
          
          let roomData = await this._getRoomData(multiRoomname);
          if (!roomData) {
            roomData = { seats: {}, points: {}, muted: false, number: 1 };
          }
          
          let seat = null;
          const seatCount = Object.keys(roomData.seats).length;
          if (seatCount >= C.MAX_SEATS) break;
          
          for (let s = 1; s <= C.MAX_SEATS; s++) {
            if (!roomData.seats[s]) {
              seat = s;
              break;
            }
          }
          
          if (!seat) break;
          
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
          
          const seatInfo = { room: multiRoomname, seat, isMulti: true };
          await this._updateUserSeat(multiUsername, (data) => {
            Object.assign(data, seatInfo);
          });
          
          let connections = this.userConnections.get(multiUsername);
          if (!connections) connections = new Set();
          if (!connections.has(ws)) connections.add(ws);
          this.userConnections.set(multiUsername, connections);
          
          ws.serializeAttachment({
            username: multiUsername,
            seatInfo: seatInfo
          });
          
          this.wsActiveMulti.set(ws, { username: multiUsername, room: multiRoomname });
          
          for (const [otherRoom, clients] of this.roomClients) {
            if (otherRoom !== multiRoomname && clients) {
              clients.delete(ws);
            }
          }
          const roomClients = this.roomClients.get(multiRoomname);
          if (roomClients && !roomClients.has(ws)) roomClients.add(ws);
          
          this.safeSend(ws, ["rooMasukMulti", seat, multiRoomname]);
          this.broadcast(multiRoomname, ["roomUserCount", multiRoomname, Object.keys(roomData.seats).length]);
          
          break;
        }
        
        case "exitMulti": {
          const targetUsername = args[0];
          if (!targetUsername) break;
          
          try {
            let userSeat = await this._getUserSeat(targetUsername);
            
            if (!userSeat) {
              const storage = await this._loadFromStorage();
              const roomsData = storage.roomsData || {};
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
              await this._deleteUserSeat(targetUsername);
              this.safeSend(ws, ["exitMultiSuccess", targetUsername, null, null]);
              break;
            }
            
            const roomName = userSeat.room;
            const seatNumber = userSeat.seat;
            
            await this._removeUserFromRoom(targetUsername, roomName);
            await this._deleteUserSeat(targetUsername);
            
            const connections = this.userConnections.get(targetUsername);
            if (connections) {
              const toRemove = Array.from(connections);
              for (const conn of toRemove) {
                if (conn.room) {
                  const rc = this.roomClients.get(conn.room);
                  if (rc) rc.delete(conn);
                }
                if (roomName) {
                  const rc = this.roomClients.get(roomName);
                  if (rc) rc.delete(conn);
                }
                
                this.wsActiveMulti.delete(conn);
                
                try {
                  conn.serializeAttachment({});
                  conn.username = null;
                  conn.room = null;
                  conn.roomname = null;
                  conn.idtarget = null;
                } catch(e) {}
                
                try {
                  if (conn.readyState === 1) {
                    this.safeSend(conn, ["exitMultiForce", "You have been exited"]);
                  }
                } catch(e) {}
                
                this.wsSet.delete(conn);
              }
              
              this.userConnections.delete(targetUsername);
            }
            
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
                } catch(e) {}
                try {
                  if (wsKey.readyState === 1) {
                    this.safeSend(wsKey, ["exitMultiForce", "You have been exited"]);
                  }
                } catch(e) {}
              }
            }
            for (const wsKey of toDelete) {
              this.wsActiveMulti.delete(wsKey);
              this.wsSet.delete(wsKey);
            }
            
            this.broadcast(roomName, ["removeKursi", roomName, seatNumber]);
            this.broadcast(roomName, ["userOffline", targetUsername, seatNumber]);
            await this.updateRoomCount(roomName);
            await this._deleteRoomIfEmpty(roomName);
            
            this.safeSend(ws, ["exitMultiSuccess", targetUsername, roomName, seatNumber]);
            
          } catch(e) {
            console.error('[exitMulti] Error:', e.message);
            this.safeSend(ws, ["exitMultiError", e.message]);
          }
          break;
        }
        
        case "setActiveMulti": {
          const targetUsername = args[0];
          
          const userSeat = await this._getUserSeat(targetUsername);
          if (!userSeat) {
            this.safeSend(ws, ["setActiveMultiError", "User not found"]);
            break;
          }
          
          const roomName = userSeat.room;
          const seatNumber = userSeat.seat;
          
          let existingWs = null;
          for (const [wsKey, data] of this.wsActiveMulti) {
            if (data && data.username === targetUsername) {
              existingWs = wsKey;
              break;
            }
          }
          
          if (existingWs && existingWs !== ws) {
            const oldRoom = this.wsActiveMulti.get(existingWs)?.room;
            if (oldRoom) {
              const rc = this.roomClients.get(oldRoom);
              if (rc) rc.delete(existingWs);
            }
            
            const conns = this.userConnections.get(targetUsername);
            if (conns) {
              conns.delete(existingWs);
              if (conns.size === 0) {
                this.userConnections.delete(targetUsername);
              }
            }
            
            try {
              existingWs.serializeAttachment({});
              existingWs.username = null;
              existingWs.room = null;
              existingWs.roomname = null;
              existingWs.idtarget = null;
            } catch(e) {}
            
            this.wsSet.delete(existingWs);
            this.wsActiveMulti.delete(existingWs);
            
            try {
              if (existingWs.readyState === 1) {
                existingWs.send(JSON.stringify(["activeMultiReplaced", "New connection detected"]));
                existingWs.close(1000, "Replaced by new connection");
              }
            } catch(e) {}
          }
          
          this.wsActiveMulti.set(ws, { username: targetUsername, room: roomName });
          
          for (const [otherRoom, clients] of this.roomClients) {
            if (otherRoom !== roomName && clients) {
              clients.delete(ws);
            }
          }
          const roomClients = this.roomClients.get(roomName);
          if (roomClients && !roomClients.has(ws)) roomClients.add(ws);
          
          ws.username = targetUsername;
          ws.idtarget = targetUsername;
          ws.room = roomName;
          ws.roomname = roomName;
          
          ws.serializeAttachment({
            username: targetUsername,
            seatInfo: userSeat
          });
          
          let connections = this.userConnections.get(targetUsername);
          if (!connections) {
            connections = new Set();
            this.userConnections.set(targetUsername, connections);
          }
          if (!connections.has(ws)) connections.add(ws);
          if (!this.wsSet.has(ws)) this.wsSet.add(ws);
          
          this.safeSend(ws, ["activeChangedMulti", targetUsername, seatNumber, roomName]);
          this.broadcast(roomName, ["userActiveChanged", targetUsername, seatNumber]);
          this.broadcast(roomName, ["userOnline", targetUsername, seatNumber]);
          
          break;
        }
        
        case "updateKursi": {
          const [kursiRoom, kursiSeat, kursiNoimg, kursiName, kursiColor, kursiBawah, kursiAtas, kursiVip, kursiVt] = args;
          
          if (!kursiRoom || typeof kursiSeat !== 'number' || kursiSeat < 1 || kursiSeat > C.MAX_SEATS) {
            this.safeSend(ws, ["updateKursiError", "Invalid room or seat number"]);
            break;
          }
          
          if (!ROOMS_SET.has(kursiRoom)) {
            this.safeSend(ws, ["updateKursiError", "Room not found"]);
            break;
          }
          
          if (!kursiName || typeof kursiName !== 'string' || kursiName.trim().length === 0) {
            this.safeSend(ws, ["updateKursiError", "Username is required"]);
            break;
          }
          
          const userSeat = await this._getUserSeat(kursiName);
          if (!userSeat || userSeat.seat !== kursiSeat || userSeat.room !== kursiRoom) {
            this.safeSend(ws, ["updateKursiError", "You do not own this seat"]);
            break;
          }
          
          const lockKey = `kursi_${kursiRoom}_${kursiSeat}`;
          if (this._kursiLocks.has(lockKey)) {
            this.safeSend(ws, ["updateKursiError", "Update in progress, please wait"]);
            break;
          }
          this._kursiLocks.set(lockKey, Date.now());
          
          try {
            const updateData = {
              noimageUrl: String(kursiNoimg || ""),
              namauser: String(kursiName || ""),
              color: String(kursiColor || ""),
              itembawah: typeof kursiBawah === 'number' ? kursiBawah : (parseInt(kursiBawah) || 0),
              itematas: typeof kursiAtas === 'number' ? kursiAtas : (parseInt(kursiAtas) || 0),
              vip: typeof kursiVip === 'number' ? kursiVip : (parseInt(kursiVip) || 0),
              viptanda: typeof kursiVt === 'number' ? kursiVt : (parseInt(kursiVt) || 0)
            };
            
            const result = await this._updateKursi(kursiRoom, kursiSeat, updateData);
            
            if (result.success) {
              this.safeSend(ws, ["updateKursiSuccess", kursiRoom, kursiSeat]);
              const roomData = await this._getRoomData(kursiRoom);
              const updatedSeat = roomData?.seats?.[kursiSeat];
              if (updatedSeat) {
                this.broadcast(kursiRoom, ["kursiBatchUpdate", kursiRoom, [[kursiSeat, updatedSeat]]]);
              }
            } else {
              this.safeSend(ws, ["updateKursiError", result.error || "Update failed"]);
            }
            
          } catch(e) {
            console.error('[updateKursi] Error:', e.message);
            this.safeSend(ws, ["updateKursiError", e.message || "Internal error"]);
          } finally {
            this._kursiLocks.delete(lockKey);
          }
          break;
        }
        
        case "chat": {
          // Chat sudah dihandle di fast path
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
          if (privTarget && privMsg) {
            const targetConns = this.userConnections.get(privTarget);
            if (targetConns) {
              for (const targetWs of targetConns) {
                if (targetWs?.readyState === 1) {
                  this.safeSend(targetWs, ["private", privTarget, privNoimg, privMsg, Date.now(), privSender]);
                  break;
                }
              }
            }
            this.safeSend(ws, ["private", privTarget, privNoimg, privMsg, Date.now(), privSender]);
          }
          break;
        }
        
        case "gift": {
          const [giftRoom, giftSender, giftReceiver, giftGiftName] = args;
          if (giftRoom && ROOMS_SET.has(giftRoom)) {
            const receiverSeat = await this._getUserSeat(giftReceiver);
            if (!receiverSeat || receiverSeat.room !== giftRoom) break;
            this._broadcastToRoom(giftRoom, JSON.stringify(["gift", giftRoom, giftSender, giftReceiver, giftGiftName, Date.now()]));
          }
          break;
        }
        
        case "rollangak": {
          const [rollRoom, rollUser, rollAngka] = args;
          if (rollRoom && ROOMS_SET.has(rollRoom)) {
            const userSeat = await this._getUserSeat(rollUser);
            if (!userSeat || userSeat.room !== rollRoom) break;
            this._broadcastToRoom(rollRoom, JSON.stringify(["rollangakBroadcast", rollRoom, rollUser, rollAngka]));
          }
          break;
        }
        
        case "sendnotif": {
          try {
            const [notifTarget, notifNoimg, notifUser, notifMsg] = args;
            if (notifTarget && notifMsg) {
              const targetConns = this.userConnections.get(notifTarget);
              if (targetConns) {
                for (const c of targetConns) {
                  if (c?.readyState === 1) {
                    this.safeSend(c, ["notif", notifNoimg, notifUser, notifMsg, Date.now()]);
                    break;
                  }
                }
              }
            }
          } catch(e) {
            console.error('[notif] Error:', e.message);
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
                if (conn?.readyState === 1) { isOnline = true; break; }
              }
            }
          }
          this.safeSend(ws, ["userOnlineStatus", onlineTarget, isOnline, onlineCallback || ""]);
          break;
        }
        
        case "getOnlineUsers": {
          const users = [];
          const storage = await this._loadFromStorage();
          const userSeatData = storage.userSeatData || {};
          
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
          const storage = await this._loadFromStorage();
          const counts = {};
          for (const room of ROOMS) {
            const roomData = storage.roomsData[room];
            counts[room] = roomData?.seats ? Object.keys(roomData.seats).length : 0;
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
          this.safeSend(ws, ["error", `Unknown event: ${evt}`]);
          break;
      }
    } catch(e) {
      console.error('[HANDLE EVENT] Error:', e.message);
    }
  }

  // ============================================================
  // ✅ CLEANUP STORAGE
  // ============================================================
  
  async _cleanupStorage() {
    try {
      const storage = await this._loadFromStorage(true);
      const roomsData = storage.roomsData || {};
      const userSeatData = storage.userSeatData || {};
      
      let changed = false;
      
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
        if (roomsData !== undefined) {
          this._batchWriter.addWrite("roomsData", roomsData);
        }
        if (userSeatData !== undefined) {
          this._batchWriter.addWrite("userSeatData", userSeatData);
        }
      }
      
    } catch(e) {
      console.error('[CLEANUP STORAGE] Error:', e.message);
    }
  }

  // ============================================================
  // ✅ SAVE ALL STATE
  // ============================================================
  
  async _saveAllState() {
    try {
      const storage = await this._loadFromStorage(true);
      this._batchWriter.addWrite("roomsData", storage.roomsData);
      this._batchWriter.addWrite("userSeatData", storage.userSeatData);
      this._batchWriter.addWrite("currentNumber", this.currentNumber);
      await this._batchWriter.forceFlush();
    } catch(e) {
      console.error('[SAVE ALL] Error:', e.message);
    }
  }

  // ============================================================
  // ✅ ALARM - SATU-SATUNYA LOOP
  // ============================================================
  
  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    console.log('[ALARM] Running cleanup...');
    
    // Update number
    await this._updateNumber();
    
    // Cleanup connections
    this._cleanupDeadConnections();
    this._cleanupStaleLocks();
    
    // Cleanup storage
    await this._cleanupStorage();
    await this._saveAllState();
    
    // Force flush batch writes
    await this._batchWriter.forceFlush();
    
    // Cleanup cache
    this._cache.cleanup();
    
    // Cleanup rate limiter
    this._rateLimiter.cleanup();
    
    // Log stats
    console.log('[ALARM STATS]', {
      cache: this._cache.getStats(),
      batch: this._batchWriter.getStats(),
      connections: this.wsSet.size,
      users: this.userConnections.size,
      rateLimits: this._rateLimiter._limits.size
    });
    
    // Set next alarm
    this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
  }

  async _updateNumber() {
    if (this._isNumberUpdating || this.closing || this.isDestroyed) return;
    this._isNumberUpdating = true;
    try {
      this.currentNumber = this.currentNumber < C.MAX_NUMBER ? this.currentNumber + 1 : 1;
      this._batchWriter.addWrite("currentNumber", this.currentNumber);
      
      const storage = await this._loadFromStorage(true);
      const roomsData = storage.roomsData || {};
      let changed = false;
      
      for (const [roomName, roomData] of Object.entries(roomsData)) {
        if (roomData) {
          roomData.number = this.currentNumber;
          changed = true;
          this._cache.delete(`room_${roomName}`);
        }
      }
      
      if (changed) {
        this._batchWriter.addWrite("roomsData", roomsData);
      }
      
      const numberMsg = JSON.stringify(["currentNumber", this.currentNumber]);
      for (const [room, clients] of this.roomClients) {
        if (clients && clients.size > 0) {
          this._broadcastToRoom(room, numberMsg);
        }
      }
      
    } catch(e) {} finally {
      this._isNumberUpdating = false;
    }
  }

  _cleanupDeadConnections() {
    try {
      const toRemove = [];
      for (const ws of this.wsSet) {
        if (!ws || ws.readyState !== 1 || ws._closing) {
          toRemove.push(ws);
        }
      }
      for (const ws of toRemove) {
        this.cleanup(ws);
      }
    } catch(e) {}
  }

  _cleanupStaleLocks() {
    try {
      const now = Date.now();
      for (const [key, time] of this._joinLocks) {
        if (now - time > C.LOCK_TIMEOUT) this._joinLocks.delete(key);
      }
      for (const [key, time] of this._kursiLocks) {
        if (now - time > C.LOCK_TIMEOUT) this._kursiLocks.delete(key);
      }
      for (const [key, time] of this._userJoinLock) {
        if (now - time > C.USER_JOIN_LOCK_TIMEOUT) this._userJoinLock.delete(key);
      }
    } catch(e) {}
  }

  // ============================================================
  // ✅ RESTORE ALL STATE
  // ============================================================
  
  async _restoreAllState() {
    try {
      const storage = await this._loadFromStorage(true);
      const { roomsData, userSeatData, currentNumber } = storage;
      
      if (currentNumber !== undefined) {
        this.currentNumber = currentNumber;
      }
      
      // Pre-warm cache
      for (const [roomName, roomData] of Object.entries(roomsData)) {
        if (roomData) {
          this._cache.set(`room_${roomName}`, roomData, C.CACHE_TTL.ROOM_DATA);
          const count = roomData.seats ? Object.keys(roomData.seats).length : 0;
          this._cache.set(`room_count_${roomName}`, count, C.CACHE_TTL.ROOM_COUNT);
        }
      }
      
      for (const [username, seatInfo] of Object.entries(userSeatData)) {
        if (seatInfo && seatInfo.room) {
          const roomData = roomsData[seatInfo.room];
          if (roomData && roomData.seats && roomData.seats[seatInfo.seat]) {
            this._cache.set(`user_${username}`, seatInfo, C.CACHE_TTL.USER_SEAT);
            this._cache.set(`user_room_${username}`, { room: seatInfo.room, seat: seatInfo.seat }, C.CACHE_TTL.USER_SEAT);
          }
        }
      }
      
      // Restore websocket connections
      const webSockets = this.ctx.getWebSockets();
      for (const ws of webSockets) {
        try {
          const attachment = ws.deserializeAttachment();
          if (attachment && attachment.username) {
            const userSeat = userSeatData[attachment.username];
            if (userSeat) {
              attachment.seatInfo = userSeat;
              ws.serializeAttachment(attachment);
              
              ws.username = attachment.username;
              ws.room = userSeat.room;
              ws.roomname = userSeat.room;
              ws.idtarget = attachment.username;
              ws._closing = false;
              
              const roomClients = this.roomClients.get(userSeat.room);
              if (roomClients) roomClients.add(ws);
              
              let conns = this.userConnections.get(attachment.username);
              if (!conns) conns = new Set();
              conns.add(ws);
              this.userConnections.set(attachment.username, conns);
              
              this.wsSet.add(ws);
            }
          }
        } catch(e) {}
      }
      
      this._cache.set('full_storage', storage, C.CACHE_TTL.ROOM_LIST);
      
      if (!this.closing && !this.isDestroyed) {
        this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      }
      
    } catch(e) {
      console.error('[RESTORE] Error:', e.message);
    }
  }

  // ============================================================
  // ✅ GET STATS
  // ============================================================
  
  getStats() {
    return {
      cache: this._cache.getStats(),
      batch: this._batchWriter.getStats(),
      connections: this.wsSet.size,
      users: this.userConnections.size,
      rooms: this.roomClients.size,
      queue: this._eventQueue.length,
      rateLimits: this._rateLimiter._limits.size
    };
  }

  // ============================================================
  // ✅ FETCH
  // ============================================================
  
  async fetch(req) {
    if (this.closing || this.isDestroyed) {
      return new Response("Shutting down", { status: 503 });
    }
    
    try {
      const upgrade = req.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        return new Response("Chat Server", { 
          status: 200,
          headers: { "Cache-Control": "no-cache" }
        });
      }
      
      if (this.wsSet.size >= C.MAX_GLOBAL_CONNECTIONS) {
        return new Response("Server full", { status: 503 });
      }
      
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      
      try { this.ctx.acceptWebSocket(server); } 
      catch(e) { return new Response("WebSocket acceptance failed", { status: 500 }); }
      
      server.username = null;
      server.room = null;
      server.roomname = null;
      server.idtarget = null;
      server._closing = false;
      server._wsId = Date.now() + Math.random();
      
      server.serializeAttachment({});
      
      if (!this.wsSet.has(server)) this.wsSet.add(server);
      
      return new Response(null, { status: 101, webSocket: client });
    } catch(e) {
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // ============================================================
  // ✅ DESTROY
  // ============================================================
  
  async destroy() {
    if (this.isDestroyed) return;
    this.closing = true;
    this.isDestroyed = true;
    
    this._cache.destroy();
    await this._batchWriter.forceFlush();
    this._batchWriter.destroy();
    this._rateLimiter.destroy();
    
    await this._cleanupStorage();
    await this._saveAllState();
    
    this._joinLocks.clear();
    this._kursiLocks.clear();
    this._userJoinLock.clear();
    
    for (const timeout of this._pendingTimeouts) {
      clearTimeout(timeout);
    }
    this._pendingTimeouts.clear();
    
    const wsCopy = Array.from(this.wsSet);
    for (const ws of wsCopy) {
      if (ws?.readyState === 1) {
        try { ws.send(JSON.stringify(["serverShutdown", "Server shutting down"])); } catch(e) {}
        try { ws.close(1000, "Shutdown"); } catch(e) {}
      }
      try { this.cleanup(ws); } catch(e) {}
    }
    
    this.wsSet.clear();
    this.userConnections.clear();
    this.roomClients.clear();
    this.wsActiveMulti.clear();
    this._processingMessages.clear();
    this._cleaningUp.clear();
    this._eventQueue.clear();
    
    console.log('[SERVER] Destroyed successfully');
  }
}

// ==================== EXPORT ====================
export default ChatServer;
