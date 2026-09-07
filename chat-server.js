// ==================== CHAT-SERVER.JS ====================
// VERSION: 12.2.0 - ALL ERROR RESPONSES REMOVED
// NO activeMultiReplaced, NO exitMultiError

const C = {
  MAX_SEATS: 45,
  MAX_GLOBAL_CONNECTIONS: 150,
  MAX_MESSAGE_SIZE: 5000,
  NUMBER_INTERVAL_MS: 900000,
  MAX_NUMBER: 6,
  LOCK_TIMEOUT: 5000,
  USER_JOIN_LOCK_TIMEOUT: 10000,
};

const ROOMS = [
  "LowCard", "Quiz", "Gacor", "General", "LOVE BIRDS", "Birthday Party",
  "Sweet Memories", "Lounge Talk", "Noxxeliverothcifsa", "BESTIES",
  "Happy Vibes", "The Chatter Room"
];

const ROOMS_SET = new Set(ROOMS);
const TABLE_NAME = 'chat_data';

// ============ ATOMIC LOCK ============
class AtomicLock {
  constructor() {
    this.locks = new Map();
  }
  
  async acquire(key, timeout = 5000) {
    const start = Date.now();
    while (this.locks.has(key)) {
      if (Date.now() - start > timeout) {
        throw new Error(`Lock timeout for key: ${key}`);
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.locks.set(key, Date.now());
    return true;
  }
  
  release(key) {
    this.locks.delete(key);
  }
  
  isLocked(key) {
    return this.locks.has(key);
  }
}

// ============ MAIN SERVER ============
export class ChatServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ctx = state;
    this.closing = false;
    this.isDestroyed = false;
    this._startTime = Date.now();
    
    this._restored = false;
    this._restoring = false;
    this._restoreAttempted = false;
    this._restoreFailed = false;
    this._lastRestoreTime = 0;
    this._wakeUpPending = false;
    
    this.wsSet = new Set();
    this.userConnections = new Map();
    this.roomClients = new Map();
    this.wsActiveMulti = new Map();
    
    this._atomicLock = new AtomicLock();
    this._joinLocks = new Map();
    this._kursiLocks = new Map();
    this._userJoinLock = new Map();
    
    this.currentNumber = 1;
    this._isNumberUpdating = false;
    
    this.db = env.DB;
    
    this._storageCache = {
      roomsData: {},
      currentNumber: 1
    };
    this._cacheInitialized = false;
    this._cacheLoading = false;
    
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    this._initializeServer();
  }

  async _initializeServer() {
    try {
      await this._restoreAllState();
    } catch(e) {
      this._restoreFailed = true;
      this._restored = true;
    }
  }

  async _wakeUpAndRestore() {
    if (this._restored && !this._restoreFailed) {
      return true;
    }
    
    if (this._restoring) {
      await new Promise(resolve => setTimeout(resolve, 100));
      return this._restored;
    }
    
    const now = Date.now();
    if (this._lastRestoreTime > 0 && (now - this._lastRestoreTime) < 5000) {
      return this._restored;
    }
    
    this._wakeUpPending = true;
    this._restoring = true;
    this._lastRestoreTime = now;
    
    try {
      await this._restoreAllState();
      this._restoreFailed = false;
      this._restored = true;
      return true;
    } catch(e) {
      this._restoreFailed = true;
      this._restored = true;
      return false;
    } finally {
      this._restoring = false;
      this._wakeUpPending = false;
    }
  }

  async _loadFromStorage() {
    try {
      await this.db.prepare(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      const result = await this.db
        .prepare(`
          SELECT key, value FROM ${TABLE_NAME}
        `)
        .all();

      const roomsData = {};
      for (const room of ROOMS) {
        roomsData[room] = { seat: {}, point: {}, mute: false };
      }

      let currentNumber = 1;

      for (const row of result.results || []) {
        const key = row.key;
        const value = JSON.parse(row.value);

        if (key === 'current_number') {
          currentNumber = parseInt(value) || 1;
          continue;
        }

        const parts = key.split('_');
        if (parts.length < 2) continue;
        
        const type = parts[0];
        const roomName = parts[1];

        if (type === 'mute') {
          if (roomsData[roomName]) {
            roomsData[roomName].mute = value;
          }
          continue;
        }

        const seatNumber = parseInt(parts[2]);
        if (isNaN(seatNumber)) continue;
        
        if (!roomsData[roomName]) {
          roomsData[roomName] = { seat: {}, point: {}, mute: false };
        }

        if (type === 'seat') {
          roomsData[roomName].seat[seatNumber] = value;
        } else if (type === 'point') {
          roomsData[roomName].point[seatNumber] = value;
        }
      }

      this._storageCache = { 
        roomsData: roomsData, 
        currentNumber: currentNumber 
      };
      this._cacheInitialized = true;
      this.currentNumber = currentNumber;

      return this._storageCache;

    } catch(e) {
      this._storageCache = {
        roomsData: {},
        currentNumber: 1
      };
      this._cacheInitialized = true;
      this.currentNumber = 1;
      return this._storageCache;
    }
  }

  async _saveSeat(roomName, seatNumber, seatData) {
    const key = `seat_${roomName}_${seatNumber}`;
    
    if (!seatData || !seatData.namauser || seatData.namauser.trim() === '') {
      await this.db
        .prepare(`DELETE FROM ${TABLE_NAME} WHERE key = ?`)
        .bind(key)
        .run();
      return;
    }
    
    await this.db
      .prepare(`INSERT OR REPLACE INTO ${TABLE_NAME} (key, value) VALUES (?, ?)`)
      .bind(key, JSON.stringify(seatData))
      .run();
  }

  async _savePoint(roomName, seatNumber, pointData) {
    const key = `point_${roomName}_${seatNumber}`;
    
    if (!pointData || (pointData.x === 0 && pointData.y === 0 && !pointData.fast)) {
      await this.db
        .prepare(`DELETE FROM ${TABLE_NAME} WHERE key = ?`)
        .bind(key)
        .run();
      return;
    }
    
    await this.db
      .prepare(`INSERT OR REPLACE INTO ${TABLE_NAME} (key, value) VALUES (?, ?)`)
      .bind(key, JSON.stringify(pointData))
      .run();
  }

  async _saveMute(roomName, muted) {
    const key = `mute_${roomName}`;
    
    if (muted === false) {
      await this.db
        .prepare(`DELETE FROM ${TABLE_NAME} WHERE key = ?`)
        .bind(key)
        .run();
      return;
    }
    
    await this.db
      .prepare(`INSERT OR REPLACE INTO ${TABLE_NAME} (key, value) VALUES (?, ?)`)
      .bind(key, JSON.stringify(muted))
      .run();
  }

  async _saveCurrentNumber() {
    await this.db
      .prepare(`INSERT OR REPLACE INTO ${TABLE_NAME} (key, value) VALUES (?, ?)`)
      .bind('current_number', String(this._storageCache.currentNumber))
      .run();
  }

  async _deleteSeatInRoom(roomName, seatNumber) {
    const lockKey = `delete_${roomName}_${seatNumber}`;
    await this._atomicLock.acquire(lockKey);
    
    try {
      const roomBucket = await this._getRoomBucket(roomName);
      delete roomBucket.seat[seatNumber];
      delete roomBucket.point[seatNumber];
      
      const seatKey = `seat_${roomName}_${seatNumber}`;
      await this.db
        .prepare(`DELETE FROM ${TABLE_NAME} WHERE key = ?`)
        .bind(seatKey)
        .run();
      
      const pointKey = `point_${roomName}_${seatNumber}`;
      await this.db
        .prepare(`DELETE FROM ${TABLE_NAME} WHERE key = ?`)
        .bind(pointKey)
        .run();
      
      await this._safeBroadcast(roomName, ["removeKursi", roomName, seatNumber]);
      await this.updateRoomCount(roomName);
      
      return true;
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  async _getRoomBucket(roomName) {
    await this._ensureCacheInitialized();
    if (!this._storageCache.roomsData[roomName]) {
      this._storageCache.roomsData[roomName] = { 
        seat: {}, 
        point: {}, 
        mute: false
      };
    }
    return this._storageCache.roomsData[roomName];
  }

  async _updateSeatInRoom(roomName, seatNumber, seatData) {
    const lockKey = `update_seat_${roomName}_${seatNumber}`;
    await this._atomicLock.acquire(lockKey);
    
    try {
      const roomBucket = await this._getRoomBucket(roomName);
      
      if (!seatData || !seatData.namauser || seatData.namauser.trim() === '') {
        delete roomBucket.seat[seatNumber];
        await this._saveSeat(roomName, seatNumber, null);
        return true;
      }
      
      roomBucket.seat[seatNumber] = seatData;
      await this._saveSeat(roomName, seatNumber, seatData);
      return true;
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  async _updatePointInRoom(roomName, seatNumber, pointData) {
    const lockKey = `update_point_${roomName}_${seatNumber}`;
    await this._atomicLock.acquire(lockKey);
    
    try {
      const roomBucket = await this._getRoomBucket(roomName);
      
      if (!pointData || (pointData.x === 0 && pointData.y === 0 && !pointData.fast)) {
        delete roomBucket.point[seatNumber];
        await this._savePoint(roomName, seatNumber, null);
        return true;
      }
      
      roomBucket.point[seatNumber] = pointData;
      await this._savePoint(roomName, seatNumber, pointData);
      return true;
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  async _updateMuteInRoom(roomName, muted) {
    const lockKey = `update_mute_${roomName}`;
    await this._atomicLock.acquire(lockKey);
    
    try {
      const roomBucket = await this._getRoomBucket(roomName);
      roomBucket.mute = muted;
      await this._saveMute(roomName, muted);
      return true;
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  async _getRoomData(roomName) {
    await this._ensureCacheInitialized();
    return this._storageCache.roomsData[roomName] || null;
  }

  async _getSeatData(roomName, seatNumber) {
    await this._ensureCacheInitialized();
    const roomBucket = this._storageCache.roomsData[roomName];
    if (!roomBucket || !roomBucket.seat) return null;
    return roomBucket.seat[seatNumber] || null;
  }

  async _getRoomCount(roomName) {
    await this._ensureCacheInitialized();
    const roomBucket = this._storageCache.roomsData[roomName];
    if (!roomBucket || !roomBucket.seat) return 0;
    let count = 0;
    for (const seat in roomBucket.seat) {
      if (roomBucket.seat[seat] && roomBucket.seat[seat].namauser) {
        count++;
      }
    }
    return count;
  }

  async _findUserInAnyRoom(username) {
    if (!username) return null;
    await this._ensureCacheInitialized();
    const roomsData = this._storageCache.roomsData || {};
    for (const [roomName, roomBucket] of Object.entries(roomsData)) {
      if (!roomBucket || !roomBucket.seat) continue;
      for (const [seat, data] of Object.entries(roomBucket.seat)) {
        if (data && data.namauser === username) {
          return { room: roomName, seat: parseInt(seat), isMulti: data.isMulti || false };
        }
      }
    }
    return null;
  }

  async _ensureCacheInitialized() {
    if (this._cacheInitialized && this._storageCache && 
        this._storageCache.roomsData && 
        Object.keys(this._storageCache.roomsData).length > 0) {
      return this._storageCache;
    }
    
    if (this._cacheLoading) {
      await new Promise(resolve => setTimeout(resolve, 100));
      return this._storageCache;
    }
    
    this._cacheLoading = true;
    try {
      await this._loadFromStorage();
    } catch(e) {
      // Silent fail
    } finally {
      this._cacheLoading = false;
    }
    
    return this._storageCache;
  }

  async _updateKursi(roomName, seat, data) {
    const lockKey = `kursi_${roomName}_${seat}`;
    
    try {
      await this._atomicLock.acquire(lockKey);
    } catch(e) {
      return { success: false, error: 'Lock timeout' };
    }
    
    try {
      if (!roomName || !ROOMS_SET.has(roomName)) {
        return { success: false, error: 'Invalid room' };
      }
      
      if (typeof seat !== 'number' || seat < 1 || seat > C.MAX_SEATS) {
        return { success: false, error: 'Invalid seat number' };
      }
      
      if (!data || !data.namauser) {
        return { success: false, error: 'Username is required' };
      }
      
      if (this._kursiLocks.has(lockKey)) {
        return { success: false, error: 'Update in progress' };
      }
      this._kursiLocks.set(lockKey, Date.now());
      
      await this._ensureCacheInitialized();
      
      const roomBucket = this._storageCache.roomsData[roomName];
      if (!roomBucket || !roomBucket.seat || !roomBucket.seat[seat]) {
        return { success: false, error: 'Seat not found' };
      }
      
      const currentSeatData = roomBucket.seat[seat];
      if (currentSeatData.namauser !== data.namauser) {
        return { success: false, error: 'You do not own this seat' };
      }
      
      const updatedSeat = {
        noimageUrl: data.noimageUrl || currentSeatData.noimageUrl || "",
        namauser: data.namauser || currentSeatData.namauser || "",
        color: data.color || currentSeatData.color || "",
        itembawah: typeof data.itembawah === 'number' ? data.itembawah : (parseInt(data.itembawah) || 0),
        itematas: typeof data.itematas === 'number' ? data.itematas : (parseInt(data.itematas) || 0),
        vip: typeof data.vip === 'number' ? data.vip : (parseInt(data.vip) || 0),
        viptanda: typeof data.viptanda === 'number' ? data.viptanda : (parseInt(data.viptanda) || 0),
        isMulti: data.isMulti !== undefined ? data.isMulti : (currentSeatData.isMulti || false)
      };
      
      await this._updateSeatInRoom(roomName, seat, updatedSeat);
      
      this._kursiLocks.delete(lockKey);
      return { success: true, data: updatedSeat };
    } catch(e) {
      this._kursiLocks.delete(lockKey);
      return { success: false, error: 'Internal error' };
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  async _updatePointDirect(roomName, seat, x, y, fast) {
    const lockKey = `point_direct_${roomName}_${seat}`;
    await this._atomicLock.acquire(lockKey);
    
    try {
      await this._ensureCacheInitialized();
      
      if (!this._storageCache.roomsData[roomName]) {
        this._storageCache.roomsData[roomName] = { seat: {}, point: {}, mute: false };
      }
      
      const pointData = { x: x || 0, y: y || 0, fast: !!fast };
      this._storageCache.roomsData[roomName].point[seat] = pointData;
      await this._savePoint(roomName, seat, pointData);
      
      return true;
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  async _updatePoint(roomName, seat, x, y, fast) {
    const lockKey = `point_${roomName}_${seat}`;
    await this._atomicLock.acquire(lockKey);
    
    try {
      await this._ensureCacheInitialized();
      const roomBucket = this._storageCache.roomsData[roomName];
      if (!roomBucket || !roomBucket.seat || !roomBucket.seat[seat]) return false;
      const pointData = { x: x || 0, y: y || 0, fast: !!fast };
      await this._updatePointInRoom(roomName, seat, pointData);
      return true;
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  async _removeUserFromRoom(username, roomName) {
    if (!username || !roomName) return false;
    
    const lockKey = `remove_user_${username}_${roomName}`;
    await this._atomicLock.acquire(lockKey);
    
    try {
      await this._ensureCacheInitialized();
      const roomBucket = this._storageCache.roomsData[roomName];
      if (!roomBucket || !roomBucket.seat) return false;
      
      let seat = null;
      for (const [s, data] of Object.entries(roomBucket.seat)) {
        if (data && data.namauser === username) {
          seat = parseInt(s);
          break;
        }
      }
      if (!seat) return false;
      
      await this._deleteSeatInRoom(roomName, seat);
      return true;
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

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
    const lockKey = `join_internal_${roomName}`;
    await this._atomicLock.acquire(lockKey);
    
    try {
      const existing = await this._findUserInAnyRoom(username);
      if (existing && existing.room !== roomName) {
        await this._removeUserFromRoom(username, existing.room);
      }
      
      await this._ensureCacheInitialized();
      
      let roomBucket = this._storageCache.roomsData[roomName];
      if (!roomBucket) {
        roomBucket = { seat: {}, point: {}, mute: false };
        this._storageCache.roomsData[roomName] = roomBucket;
      }
      if (!roomBucket.seat) roomBucket.seat = {};
      if (!roomBucket.point) roomBucket.point = {};
      
      let seat = null;
      for (const [s, data] of Object.entries(roomBucket.seat)) {
        if (data && data.namauser === username) {
          seat = parseInt(s);
          break;
        }
      }
      
      if (!seat) {
        const seatCount = Object.values(roomBucket.seat).filter(s => s && s.namauser).length;
        if (seatCount >= C.MAX_SEATS) {
          this.safeSend(ws, ["roomFull", roomName]);
          return false;
        }
        
        for (let s = 1; s <= C.MAX_SEATS; s++) {
          if (!roomBucket.seat[s]) {
            seat = s;
            break;
          }
        }
        
        if (!seat) {
          this.safeSend(ws, ["roomFull", roomName]);
          return false;
        }
        
        const newSeat = {
          noimageUrl: "",
          namauser: username,
          color: "",
          itembawah: 0,
          itematas: 0,
          vip: 0,
          viptanda: 0,
          isMulti: false
        };
        
        await this._updateSeatInRoom(roomName, seat, newSeat);
      }
      
      ws.room = roomName;
      ws.roomname = roomName;
      ws.idtarget = username;
      
      ws.serializeAttachment({
        username: username,
        seatInfo: { room: roomName, seat: seat }
      });
      
      await this._safeAddToRoom(ws, roomName);
      
      this.wsActiveMulti.delete(ws);
      
      const muteStatus = roomBucket.mute || false;
      
      this.safeSend(ws, ["rooMasuk", seat, roomName]);
      this.safeSend(ws, ["numberKursiSaya", seat]);
      this.safeSend(ws, ["muteTypeResponse", muteStatus, roomName]);
      
      await this.updateRoomCount(roomName);
      
      setTimeout(() => {
        try {
          if (ws && ws.readyState === 1) {
            this.sendAllStateTo(ws, roomName, true);
          }
        } catch(e) {}
      }, 1000);
      
      return true;
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  async _safeAddToRoom(ws, roomName) {
    const lockKey = `add_to_room_${roomName}`;
    await this._atomicLock.acquire(lockKey);
    
    try {
      for (const [otherRoom, clients] of this.roomClients) {
        if (otherRoom !== roomName && clients) {
          clients.delete(ws);
        }
      }
      
      const roomClients = this.roomClients.get(roomName);
      if (roomClients && !roomClients.has(ws)) {
        roomClients.add(ws);
      }
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  async _handleMultiJoin(ws, multiUsername, multiRoomname) {
    if (!multiUsername || !multiRoomname || !ROOMS_SET.has(multiRoomname)) return false;
    
    const lockKey = `multi_join_${multiUsername}`;
    await this._atomicLock.acquire(lockKey);
    
    try {
      await this._ensureCacheInitialized();
      const existing = await this._findUserInAnyRoom(multiUsername);
      if (existing && !existing.isMulti) {
        await this._removeUserFromRoom(multiUsername, existing.room);
      }
      
      let roomBucket = this._storageCache.roomsData[multiRoomname];
      if (!roomBucket) {
        roomBucket = { seat: {}, point: {}, mute: false };
        this._storageCache.roomsData[multiRoomname] = roomBucket;
      }
      if (!roomBucket.seat) roomBucket.seat = {};
      
      let seat = null;
      for (const [s, data] of Object.entries(roomBucket.seat)) {
        if (data && data.namauser === multiUsername && data.isMulti === true) {
          seat = parseInt(s);
          break;
        }
      }
      
      if (!seat) {
        const seatCount = Object.values(roomBucket.seat).filter(s => s && s.namauser).length;
        if (seatCount >= C.MAX_SEATS) return false;
        
        for (let s = 1; s <= C.MAX_SEATS; s++) {
          if (!roomBucket.seat[s]) {
            seat = s;
            break;
          }
        }
        if (!seat) return false;
        
        const newSeat = {
          noimageUrl: "",
          namauser: multiUsername,
          color: "",
          itembawah: 0,
          itematas: 0,
          vip: 0,
          viptanda: 0,
          isMulti: true
        };
        await this._updateSeatInRoom(multiRoomname, seat, newSeat);
      }
      
      return { room: multiRoomname, seat: seat };
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  async _cleanupMultiUser(ws, username, roomName) {
    if (ws._isCleaning) return;
    ws._isCleaning = true;
    
    try {
      if (username) {
        const connections = this.userConnections.get(username);
        if (connections) {
          connections.delete(ws);
          if (connections.size === 0) {
            this.userConnections.delete(username);
          }
        }
      }
      
      if (roomName) {
        const roomClients = this.roomClients.get(roomName);
        if (roomClients) roomClients.delete(ws);
      }
      
      this.wsSet.delete(ws);
      this.wsActiveMulti.delete(ws);
      
      try {
        ws.serializeAttachment({});
        ws.username = null;
        ws.room = null;
        ws.roomname = null;
        ws.idtarget = null;
      } catch(e) {}
    } finally {
      ws._isCleaning = false;
    }
  }

  async _cleanupNormalUser(ws, username, roomName) {
    if (ws._isCleaning) return;
    ws._isCleaning = true;
    
    try {
      if (roomName && username) {
        try {
          await this._removeUserFromRoom(username, roomName);
          this._storageCache.roomsData[roomName] = await this._getRoomBucket(roomName);
          await this.updateRoomCount(roomName);
        } catch(e) {}
      } else if (username) {
        try {
          const found = await this._findUserInAnyRoom(username);
          if (found) {
            await this._removeUserFromRoom(username, found.room);
            this._storageCache.roomsData[found.room] = await this._getRoomBucket(found.room);
            await this.updateRoomCount(found.room);
          }
        } catch(e) {}
      }
      
      if (username) {
        const connections = this.userConnections.get(username);
        if (connections) {
          connections.delete(ws);
          if (connections.size === 0) {
            this.userConnections.delete(username);
          }
        }
      }
      
      if (roomName) {
        const roomClients = this.roomClients.get(roomName);
        if (roomClients) roomClients.delete(ws);
      } else if (username) {
        try {
          const found = await this._findUserInAnyRoom(username);
          if (found) {
            const roomClients = this.roomClients.get(found.room);
            if (roomClients) roomClients.delete(ws);
          }
        } catch(e) {}
      }
      
      this.wsSet.delete(ws);
      this.wsActiveMulti.delete(ws);
      
      try {
        ws.serializeAttachment({});
        ws.username = null;
        ws.room = null;
        ws.roomname = null;
        ws.idtarget = null;
      } catch(e) {}
    } finally {
      ws._isCleaning = false;
    }
  }

  async _cleanupUserCompletely(ws) {
    if (!ws) return;
    if (ws._cleaning || ws._isCleaning) return;
    
    ws._cleaning = true;
    ws._isCleaning = true;
    
    try {
      const username = ws.username;
      const roomName = ws.room || ws.roomname;
      const isMulti = this.wsActiveMulti.has(ws);
      
      try {
        if (ws.readyState === 1) {
          ws.close(1000, "Cleanup");
        }
      } catch(e) {}
      
      ws._closing = true;
      
      if (isMulti) {
        await this._cleanupMultiUser(ws, username, roomName);
      } else {
        await this._cleanupNormalUser(ws, username, roomName);
      }
      
    } catch(e) {} finally {
      ws._cleaning = false;
      ws._isCleaning = false;
    }
  }

  async destroyWebSocket(ws, reason = "Destroyed") {
    if (!ws) return;
    await this._cleanupUserCompletely(ws);
  }

  async destroyWebSockets(wsList, reason = "Batch destroy") {
    if (!wsList || wsList.length === 0) return;
    
    for (const ws of wsList) {
      if (ws) {
        await this.destroyWebSocket(ws, reason);
      }
    }
  }

  async destroyAllWebSockets(reason = "Server shutdown") {
    if (this.isDestroyed) return;
    
    const allWs = Array.from(this.wsSet);
    if (allWs.length === 0) return;
    
    for (const ws of allWs) {
      if (ws) {
        await this.destroyWebSocket(ws, reason);
      }
    }
    
    this.wsSet.clear();
    this.userConnections.clear();
    this.roomClients.clear();
    this.wsActiveMulti.clear();
  }

  async destroyUserWebSockets(username, reason = "User destroyed") {
    if (!username) return;
    
    const connections = this.userConnections.get(username);
    if (!connections || connections.size === 0) return;
    
    const wsList = Array.from(connections);
    
    for (const ws of wsList) {
      if (ws) {
        await this.destroyWebSocket(ws, reason);
      }
    }
    
    this.userConnections.delete(username);
    
    const toRemove = [];
    for (const [ws, data] of this.wsActiveMulti) {
      if (data && data.username === username) {
        toRemove.push(ws);
      }
    }
    for (const ws of toRemove) {
      this.wsActiveMulti.delete(ws);
    }
    
    const found = await this._findUserInAnyRoom(username);
    if (found) {
      await this._removeUserFromRoom(username, found.room);
      await this.updateRoomCount(found.room);
    }
  }

  async destroyRoomWebSockets(roomName, reason = "Room destroyed") {
    if (!roomName || !ROOMS_SET.has(roomName)) return;
    
    const roomClients = this.roomClients.get(roomName);
    if (!roomClients || roomClients.size === 0) return;
    
    const wsList = Array.from(roomClients);
    
    for (const ws of wsList) {
      if (ws) {
        await this.destroyWebSocket(ws, reason);
      }
    }
    
    roomClients.clear();
  }

  async webSocketClose(ws) { 
    if (!ws) return;
    await this._cleanupUserCompletely(ws);
  }

  async webSocketError(ws) { 
    if (!ws) return;
    await this._cleanupUserCompletely(ws);
  }

  async webSocketMessage(ws, msg) {
    if (!ws || ws._closing || this.closing || this.isDestroyed) return;
    if (ws._cleaning || ws._isCleaning) return;
    
    if (!this._restored) {
      await this._wakeUpAndRestore();
    }
    
    try { 
      await this.handleMessage(ws, msg); 
    } catch(e) {}
  }

  async _restoreAllState() {
    if (this._restored) {
      return;
    }
    
    if (this._restoring) {
      return;
    }
    
    this._restoring = true;
    this._restoreAttempted = true;
    
    try {
      await this._loadFromStorage();
      await this._ensureCacheInitialized();
      
      const webSockets = this.ctx.getWebSockets();
      
      const wsByUser = new Map();
      for (const ws of webSockets) {
        try {
          const attachment = ws.deserializeAttachment();
          if (attachment && attachment.username) {
            if (!wsByUser.has(attachment.username)) {
              wsByUser.set(attachment.username, []);
            }
            wsByUser.get(attachment.username).push(ws);
          }
        } catch(e) {}
      }
      
      for (const [username, sockets] of wsByUser) {
        const found = await this._findUserInAnyRoom(username);
        if (!found) continue;
        
        let primaryWs = null;
        for (const ws of sockets) {
          if (ws.readyState === 1) {
            primaryWs = ws;
            break;
          }
        }
        if (!primaryWs) continue;
        
        try {
          primaryWs.username = username;
          primaryWs.room = found.room;
          primaryWs.roomname = found.room;
          primaryWs.idtarget = username;
          primaryWs._closing = false;
          primaryWs._cleaning = false;
          primaryWs._isCleaning = false;
          
          await this._safeAddToRoom(primaryWs, found.room);
          
          let conns = this.userConnections.get(username);
          if (!conns) conns = new Set();
          conns.add(primaryWs);
          this.userConnections.set(username, conns);
          this.wsSet.add(primaryWs);
        } catch(e) {}
      }
      
      if (!this.closing && !this.isDestroyed) {
        try {
          await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        } catch(e) {}
      }
      
      for (const room of ROOMS) {
        try {
          await this.updateRoomCount(room);
        } catch(e) {}
      }
      
      for (const room of ROOMS) {
        try {
          await this._safeBroadcast(room, ["currentNumber", this.currentNumber]);
        } catch(e) {}
      }
      
      this._restored = true;
      this._restoreFailed = false;
      this._lastRestoreTime = Date.now();
      
    } catch(e) {
      this._restoreFailed = true;
      this._restored = true;
    } finally {
      this._restoring = false;
    }
  }

  async _safeBroadcast(room, msg) {
    if (this.closing || this.isDestroyed || !room || !msg) return;
    
    const lockKey = `broadcast_${room}`;
    try {
      await this._atomicLock.acquire(lockKey);
      this.broadcast(room, msg);
    } catch(e) {
      // Silent fail
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  broadcast(room, msg) {
    if (this.closing || this.isDestroyed || !room || !msg) return;
    
    try {
      const msgStr = JSON.stringify(msg);
      const clients = this.roomClients.get(room);
      if (!clients || clients.size === 0) return;
      
      const toRemove = new Set();
      const toSend = [];
      
      for (const ws of clients) {
        if (!ws) { 
          toRemove.add(ws); 
          continue; 
        }
        
        const wsRoom = ws.room || ws.roomname;
        if (wsRoom !== room) {
          toRemove.add(ws);
          continue;
        }
        
        try {
          if (ws.readyState === 1 && !ws._closing && !ws._cleaning && !ws._isCleaning) {
            toSend.push(ws);
          } else {
            toRemove.add(ws);
          }
        } catch(e) { 
          toRemove.add(ws); 
        }
      }
      
      for (const ws of toSend) {
        try {
          ws.send(msgStr);
        } catch(e) {
          toRemove.add(ws);
        }
      }
      
      if (toRemove.size > 0) {
        for (const ws of toRemove) {
          try {
            clients.delete(ws);
            if (ws) {
              this._cleanupUserCompletely(ws).catch(() => {});
            }
          } catch(e) {}
        }
      }
    } catch(e) {}
  }

  safeSend(ws, msg) {
    if (!ws) return false;
    if (ws._closing || ws._cleaning || ws._isCleaning) return false;
    
    try {
      if (ws.readyState !== 1 || this.closing || this.isDestroyed) {
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
    
    const lockKey = `update_count_${room}`;
    try {
      await this._atomicLock.acquire(lockKey);
      
      await this._ensureCacheInitialized();
      const roomBucket = this._storageCache.roomsData[room];
      if (!roomBucket || !roomBucket.seat) {
        await this._safeBroadcast(room, ["roomUserCount", room, 0]);
        return 0;
      }
      
      let count = 0;
      for (const seat in roomBucket.seat) {
        if (roomBucket.seat[seat] && roomBucket.seat[seat].namauser) {
          count++;
        }
      }
      await this._safeBroadcast(room, ["roomUserCount", room, count]);
      return count;
    } catch(e) { 
      return 0; 
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  async sendAllStateTo(ws, room, excludeSelf = false) {
    if (!ws || !ws.username) return;
    
    try {
      if (ws.readyState !== 1 || ws._closing || ws._cleaning || ws._isCleaning) return;
    } catch(e) { return; }
    
    await this._ensureCacheInitialized();
    const roomBucket = this._storageCache.roomsData[room];
    if (!roomBucket) return;
    
    try {
      const allSeats = roomBucket.seat || {};
      const allPoints = roomBucket.point || {};
      
      let selfSeat = null;
      for (const [seat, data] of Object.entries(allSeats)) {
        if (data && data.namauser === ws.username) {
          selfSeat = parseInt(seat);
          break;
        }
      }
      
      const count = Object.values(allSeats).filter(s => s && s.namauser).length;
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

  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    this._restored = false;
    this._restoreAttempted = false;
    this._restoreFailed = false;
    this._restoring = false;
    
    await this._restoreAllState();
    
    await this._updateNumber();
    await this._cleanupDeadConnections();
    this._cleanupStaleLocks();
    await this._cleanupStorage();
    
    try {
      await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
    } catch(e) {}
  }

  async _updateNumber() {
    if (this._isNumberUpdating || this.closing || this.isDestroyed) return;
    if (!this._restored) return;
    
    this._isNumberUpdating = true;
    try {
      this.currentNumber = this.currentNumber < C.MAX_NUMBER ? this.currentNumber + 1 : 1;
      this._storageCache.currentNumber = this.currentNumber;
      await this._saveCurrentNumber();
      
      for (const [room, clients] of this.roomClients) {
        if (clients && clients.size > 0) {
          await this._safeBroadcast(room, ["currentNumber", this.currentNumber]);
        }
      }
    } catch(e) {} finally {
      this._isNumberUpdating = false;
    }
  }

  async _cleanupDeadConnections() {
    try {
      const toRemove = [];
      for (const ws of this.wsSet) {
        if (!ws || ws.readyState !== 1 || ws._closing) {
          toRemove.push(ws);
        }
      }
      
      const batchSize = 10;
      for (let i = 0; i < toRemove.length; i += batchSize) {
        const batch = toRemove.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(ws => this._cleanupUserCompletely(ws))
        );
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

  async _cleanupStorage() {
    try {
      await this._ensureCacheInitialized();
      const roomsData = this._storageCache.roomsData || {};
      
      for (const [roomName, roomBucket] of Object.entries(roomsData)) {
        const hasSeats = roomBucket.seat && Object.values(roomBucket.seat).some(s => s && s.namauser);
        const hasPoints = roomBucket.point && Object.keys(roomBucket.point).length > 0;
        if (!hasSeats && !hasPoints) {
          delete roomsData[roomName];
          await this.db
            .prepare(`DELETE FROM ${TABLE_NAME} WHERE key LIKE ?`)
            .bind(`seat_${roomName}_%`)
            .run();
          await this.db
            .prepare(`DELETE FROM ${TABLE_NAME} WHERE key LIKE ?`)
            .bind(`point_${roomName}_%`)
            .run();
          await this.db
            .prepare(`DELETE FROM ${TABLE_NAME} WHERE key = ?`)
            .bind(`mute_${roomName}`)
            .run();
        }
      }
      
      this._storageCache.roomsData = roomsData;
    } catch(e) {}
  }

  async _flushPendingData() {
    if (this._storageCache && this._storageCache.currentNumber) {
      await this._saveCurrentNumber();
    }
    
    const roomsData = this._storageCache.roomsData || {};
    const savePromises = [];
    
    for (const [roomName, roomBucket] of Object.entries(roomsData)) {
      if (!roomBucket || !roomBucket.seat) continue;
      
      for (const [seatNumber, seatData] of Object.entries(roomBucket.seat)) {
        if (seatData && seatData.namauser) {
          savePromises.push(
            this._saveSeat(roomName, parseInt(seatNumber), seatData)
              .catch(() => {})
          );
        }
      }
      
      if (roomBucket.point) {
        for (const [seatNumber, pointData] of Object.entries(roomBucket.point)) {
          if (pointData && (pointData.x || pointData.y || pointData.fast)) {
            savePromises.push(
              this._savePoint(roomName, parseInt(seatNumber), pointData)
                .catch(() => {})
            );
          }
        }
      }
      
      if (roomBucket.mute !== undefined) {
        savePromises.push(
          this._saveMute(roomName, roomBucket.mute)
            .catch(() => {})
        );
      }
    }
    
    await Promise.race([
      Promise.allSettled(savePromises),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }

  async destroy() {
    if (this.isDestroyed) return;
    
    this.closing = true;
    this.isDestroyed = true;
    
    try {
      await this._flushPendingData();
    } catch(e) {}
    
    this._joinLocks.clear();
    this._kursiLocks.clear();
    this._userJoinLock.clear();
    this._atomicLock.locks.clear();
    
    await this.destroyAllWebSockets("Server shutdown");
    
    this.wsSet.clear();
    this.userConnections.clear();
    this.roomClients.clear();
    this.wsActiveMulti.clear();
    
    this._storageCache = {
      roomsData: {},
      currentNumber: 1
    };
    this._cacheInitialized = false;
  }

  async _handleSetId(ws, username, isNewUser) {
    if (!ws || !username || typeof username !== 'string' || username.length === 0 || this.closing || this.isDestroyed) {
      try { if (ws?.readyState === 1) ws.close(1000, "Invalid username"); } catch(e) {}
      return;
    }
    
    const lockKey = `setid_${username}`;
    await this._atomicLock.acquire(lockKey);
    
    try {
      const found = await this._findUserInAnyRoom(username);
      const isMultiUser = found ? found.isMulti : false;
      
      if (isMultiUser && isNewUser === false) {
        return;
      }
      if (isMultiUser && isNewUser === true) {
        await this._removeUserFromRoom(username, found.room);
      }
      if (!isMultiUser && found) {
        await this._removeUserFromRoom(username, found.room);
      }
      
      ws.username = username;
      ws.idtarget = username;
      ws.room = null;
      ws.roomname = null;
      ws._closing = false;
      ws._cleaning = false;
      ws._isCleaning = false;
      
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
    } finally {
      this._atomicLock.release(lockKey);
    }
  }

  async handleMessage(ws, raw) {
    if (!ws) return;
    if (ws._closing || ws._cleaning || ws._isCleaning) return;
    
    if (!this._restored && !this._restoreFailed) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!this._restored) {
        this._restored = true;
        this._restoreFailed = true;
      }
    }
    
    try {
      if (ws.readyState !== 1 || this.closing || this.isDestroyed) {
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
      if (ws._closing || ws._cleaning || ws._isCleaning) return;
      
      const [evt, ...args] = data;
      await this._ensureCacheInitialized();
      
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
          
          const result = await this._handleMultiJoin(ws, multiUsername, multiRoomname);
          if (!result) break;
          
          const { room, seat } = result;
          
          let connections = this.userConnections.get(multiUsername);
          if (!connections) connections = new Set();
          if (!connections.has(ws)) connections.add(ws);
          this.userConnections.set(multiUsername, connections);
          
          ws.serializeAttachment({
            username: multiUsername,
            seatInfo: { room: room, seat: seat }
          });
          
          this.wsActiveMulti.set(ws, { username: multiUsername, room: room });
          await this._safeAddToRoom(ws, room);
          
          this.safeSend(ws, ["rooMasukMulti", seat, room]);
          await this.updateRoomCount(room);
          break;
        }
        
        case "exitMulti": {
          const targetUsername = args[0];
          if (!targetUsername) break;
          
          const lockKey = `exit_multi_${targetUsername}`;
          await this._atomicLock.acquire(lockKey);
          
          try {
            const found = await this._findUserInAnyRoom(targetUsername);
            const roomName = found?.room;
            const seatNumber = found?.seat;
            
            if (roomName && seatNumber) {
              await this._removeUserFromRoom(targetUsername, roomName);
            }
            
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
                this.wsSet.delete(wsKey);
              }
            }
            for (const wsKey of toDelete) {
              this.wsActiveMulti.delete(wsKey);
            }
            
            if (roomName) {
              await this._safeBroadcast(roomName, ["removeKursi", roomName, seatNumber]);
              await this._safeBroadcast(roomName, ["userOffline", targetUsername, seatNumber]);
              await this.updateRoomCount(roomName);
            }
            
            this.safeSend(ws, ["exitMultiSuccess", targetUsername, roomName, seatNumber]);
          } catch(e) {
            // Silent fail - no exitMultiError
          } finally {
            this._atomicLock.release(lockKey);
          }
          break;
        }
        
        case "setActiveMulti": {
          const targetUsername = args[0];
          const found = await this._findUserInAnyRoom(targetUsername);
          if (!found) {
            return;
          }
          
          const roomName = found.room;
          const seatNumber = found.seat;
          
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
          await this._safeAddToRoom(ws, roomName);
          
          ws.username = targetUsername;
          ws.idtarget = targetUsername;
          ws.room = roomName;
          ws.roomname = roomName;
          ws.serializeAttachment({
            username: targetUsername,
            seatInfo: found
          });
          
          let connections = this.userConnections.get(targetUsername);
          if (!connections) {
            connections = new Set();
            this.userConnections.set(targetUsername, connections);
          }
          if (!connections.has(ws)) connections.add(ws);
          if (!this.wsSet.has(ws)) this.wsSet.add(ws);
          
          this.safeSend(ws, ["activeChangedMulti", targetUsername, seatNumber, roomName]);
          await this._safeBroadcast(roomName, ["userActiveChanged", targetUsername, seatNumber]);
          await this._safeBroadcast(roomName, ["userOnline", targetUsername, seatNumber]);
          break;
        }
        
        case "updateKursi": {
          const [kursiRoom, kursiSeat, kursiNoimg, kursiName, kursiColor, kursiBawah, kursiAtas, kursiVip, kursiVt] = args;
          
          if (!kursiRoom || typeof kursiSeat !== 'number' || kursiSeat < 1 || kursiSeat > C.MAX_SEATS) {
            return;
          }
          if (!ROOMS_SET.has(kursiRoom)) {
            return;
          }
          if (!kursiName || typeof kursiName !== 'string' || kursiName.trim().length === 0) {
            return;
          }
          
          const lockKey = `update_kursi_${kursiRoom}_${kursiSeat}`;
          
          try {
            await this._atomicLock.acquire(lockKey);
          } catch(e) {
            return;
          }
          
          try {
            const seatData = await this._getSeatData(kursiRoom, kursiSeat);
            if (!seatData || seatData.namauser !== kursiName) {
              return;
            }
            
            if (this._kursiLocks.has(lockKey)) {
              return;
            }
            this._kursiLocks.set(lockKey, Date.now());
            
            const updateData = {
              noimageUrl: String(kursiNoimg || ""),
              namauser: String(kursiName || ""),
              color: String(kursiColor || ""),
              itembawah: typeof kursiBawah === 'number' ? kursiBawah : (parseInt(kursiBawah) || 0),
              itematas: typeof kursiAtas === 'number' ? kursiAtas : (parseInt(kursiAtas) || 0),
              vip: typeof kursiVip === 'number' ? kursiVip : (parseInt(kursiVip) || 0),
              viptanda: typeof kursiVt === 'number' ? kursiVt : (parseInt(kursiVt) || 0),
              isMulti: seatData.isMulti || false
            };
            
            const result = await this._updateKursi(kursiRoom, kursiSeat, updateData);
            if (result.success) {
              this.safeSend(ws, ["updateKursiSuccess", kursiRoom, kursiSeat]);
              await this._safeBroadcast(kursiRoom, ["kursiBatchUpdate", kursiRoom, [[kursiSeat, result.data]]]);
            }
          } catch(e) {
            // Silent fail
          } finally {
            this._kursiLocks.delete(lockKey);
            this._atomicLock.release(lockKey);
          }
          break;
        }
        
        case "chat": {
          const [chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor] = args;
          if (!chatMsg || !ROOMS_SET.has(chatRoom)) break;
          
          const found = await this._findUserInAnyRoom(chatUser);
          if (!found || found.room !== chatRoom) break;
          
          const wsRoom = ws.room || ws.roomname;
          if (wsRoom !== chatRoom) break;
          
          await this._safeBroadcast(chatRoom, ["chat", chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor]);
          break;
        }
        
        case "updatePoint": {
          const [pointRoom, pointSeat, pointX, pointY, pointFast] = args;
          if (!pointRoom || typeof pointSeat !== 'number') break;
          
          const updated = await this._updatePointDirect(
            pointRoom, 
            pointSeat, 
            pointX, 
            pointY, 
            pointFast === 1
          );
          
          if (updated) {
            await this._safeBroadcast(pointRoom, ["pointUpdated", pointRoom, pointSeat, pointX, pointY, pointFast]);
            this.safeSend(ws, ["pointUpdateAck", pointRoom, pointSeat, pointX, pointY, pointFast]);
          }
          break;
        }
        
        case "gift": {
          const [giftRoom, giftSender, giftReceiver, giftGiftName] = args;
          if (giftRoom && ROOMS_SET.has(giftRoom)) {
            const roomBucket = await this._getRoomBucket(giftRoom);
            let senderFound = false;
            let receiverFound = false;
            for (const [seat, data] of Object.entries(roomBucket.seat || {})) {
              if (data && data.namauser === giftSender) senderFound = true;
              if (data && data.namauser === giftReceiver) receiverFound = true;
              if (senderFound && receiverFound) break;
            }
            if (!senderFound || !receiverFound) break;
            if ((ws.room || ws.roomname) !== giftRoom) break;
            await this._safeBroadcast(giftRoom, ["gift", giftRoom, giftSender, giftReceiver, giftGiftName, Date.now()]);
          }
          break;
        }
        
        case "rollangak": {
          const [rollRoom, rollUser, rollAngka] = args;
          if (rollRoom && ROOMS_SET.has(rollRoom)) {
            const found = await this._findUserInAnyRoom(rollUser);
            if (!found || found.room !== rollRoom) break;
            if ((ws.room || ws.roomname) !== rollRoom) break;
            await this._safeBroadcast(rollRoom, ["rollangakBroadcast", rollRoom, rollUser, rollAngka]);
          }
          break;
        }
        
        case "removeKursiAndPoint": {
          const [removeRoom, removeSeat] = args;
          const found = await this._findUserInAnyRoom(ws.username);
          if (!found || found.room !== removeRoom) break;
          
          const roomBucket = await this._getRoomData(removeRoom);
          let username = null;
          if (roomBucket && roomBucket.seat && roomBucket.seat[removeSeat]) {
            username = roomBucket.seat[removeSeat].namauser;
          }
          if (username) {
            await this._removeUserFromRoom(username, removeRoom);
          }
          break;
        }
        
        case "setMuteType": {
          const [muteVal, muteRoom] = args;
          if (!muteRoom || !ROOMS_SET.has(muteRoom)) break;
          
          const found = await this._findUserInAnyRoom(ws.username);
          if (!found || found.room !== muteRoom) break;
          
          await this._updateMuteInRoom(muteRoom, !!muteVal);
          await this._safeBroadcast(muteRoom, ["muteStatusChanged", !!muteVal, muteRoom]);
          this.safeSend(ws, ["muteTypeSet", !!muteVal, true, muteRoom]);
          break;
        }
        
        case "modwarning": {
          const modRoom = args[0];
          if (modRoom && ROOMS_SET.has(modRoom)) {
            const found = await this._findUserInAnyRoom(ws.username);
            if (!found || found.room !== modRoom) break;
            await this._safeBroadcast(modRoom, ["modwarning", modRoom]);
          }
          break;
        }
        
        case "private": {
          const [privTarget, privNoimg, privMsg, privSender] = args;
          if (privTarget && privMsg) {
            const targetConns = this.userConnections.get(privTarget);
            if (targetConns) {
              for (const targetWs of targetConns) {
                if (targetWs?.readyState === 1 && !targetWs._closing) {
                  this.safeSend(targetWs, ["private", privTarget, privNoimg, privMsg, Date.now(), privSender]);
                  break;
                }
              }
            }
            this.safeSend(ws, ["private", privTarget, privNoimg, privMsg, Date.now(), privSender]);
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
                  if (c?.readyState === 1 && !c._closing) {
                    this.safeSend(c, ["notif", notifNoimg, notifUser, notifMsg, Date.now()]);
                    break;
                  }
                }
              }
            }
          } catch(e) {}
          break;
        }
        
        case "isUserOnline": {
          const [onlineTarget, onlineCallback] = args;
          let isOnline = false;
          const found = await this._findUserInAnyRoom(onlineTarget);
          if (found) {
            if (found.isMulti === true) {
              isOnline = true;
            } else {
              const connections = this.userConnections.get(onlineTarget);
              if (connections) {
                for (const conn of connections) {
                  if (conn?.readyState === 1 && !conn._closing) {
                    isOnline = true;
                    break;
                  }
                }
              }
            }
          }
          this.safeSend(ws, ["userOnlineStatus", onlineTarget, isOnline, onlineCallback || ""]);
          break;
        }
        
        case "getOnlineUsers": {
          const users = [];
          await this._ensureCacheInitialized();
          const roomsData = this._storageCache.roomsData || {};
          
          for (const [roomName, roomBucket] of Object.entries(roomsData)) {
            if (!roomBucket || !roomBucket.seat) continue;
            for (const [seat, data] of Object.entries(roomBucket.seat)) {
              if (data && data.namauser) {
                const username = data.namauser;
                let isOnline = false;
                if (data.isMulti === true) {
                  isOnline = true;
                } else {
                  const connections = this.userConnections.get(username);
                  if (connections) {
                    for (const conn of connections) {
                      if (conn?.readyState === 1 && !conn._closing) {
                        isOnline = true;
                        break;
                      }
                    }
                  }
                }
                if (isOnline && !users.includes(username)) {
                  users.push(username);
                }
              }
            }
          }
          this.safeSend(ws, ["allOnlineUsers", users]);
          break;
        }
        
        case "getAllRoomsUserCount": {
          await this._ensureCacheInitialized();
          const counts = {};
          for (const room of ROOMS) {
            const roomBucket = this._storageCache.roomsData[room];
            let count = 0;
            if (roomBucket && roomBucket.seat) {
              for (const seat in roomBucket.seat) {
                if (roomBucket.seat[seat] && roomBucket.seat[seat].namauser) {
                  count++;
                }
              }
            }
            counts[room] = count;
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
        
        case "getMuteType": {
          const getMuteRoom = args[0];
          if (getMuteRoom && ROOMS_SET.has(getMuteRoom)) {
            await this._ensureCacheInitialized();
            const roomBucket = this._storageCache.roomsData[getMuteRoom];
            this.safeSend(ws, ["muteTypeResponse", roomBucket?.mute || false, getMuteRoom]);
          }
          break;
        }
        
        case "onDestroy": {
          if (!ws) break;
          await this.destroyWebSocket(ws, "onDestroy event");
          break;
        }
        
        default:
          break;
      }
    } catch(e) {}
  }

  async fetch(req) {
    if (this.closing || this.isDestroyed) {
      return new Response("Shutting down", { status: 503 });
    }
    
    await this._wakeUpAndRestore();
    await this._ensureCacheInitialized();
    
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
      server._cleaning = false;
      server._isCleaning = false;
      server._wsId = Date.now() + Math.random();
      server.serializeAttachment({});
      
      if (!this.wsSet.has(server)) this.wsSet.add(server);
      
      return new Response(null, { status: 101, webSocket: client });
    } catch(e) {
      return new Response("Internal Server Error", { status: 500 });
    }
  }
}

export default ChatServer;
