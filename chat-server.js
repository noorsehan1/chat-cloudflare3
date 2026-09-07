// ==================== CHAT-SERVER-D1-OPTIMIZED.JS ====================
// VERSION: 9.0.2 - OPTIMIZED PARTIAL UPDATE

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

export class ChatServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ctx = state;
    this.closing = false;
    this.isDestroyed = false;
    
    this.wsSet = new Set();
    this.userConnections = new Map();
    this.roomClients = new Map();
    this.wsActiveMulti = new Map();
    
    this._joinLocks = new Map();
    this._kursiLocks = new Map();
    this._userJoinLock = new Map();
    
    this.currentNumber = 1;
    this._isNumberUpdating = false;
    
    this.db = env.DB;
    
    // Cache memory - selalu fresh
    this._cache = {
      roomsData: {},
      userSeatData: {},
      currentNumber: 1
    };
    this._cacheInitialized = false;
    this._cacheLoading = false;
    this._alarmScheduled = false;
    
    // Queue untuk batch update
    this._updateQueue = [];
    this._isProcessingQueue = false;
    this._batchSize = 10;
    this._batchInterval = 100; // ms
    
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    this._initialize().then(() => {
      this._restored = true;
    }).catch(() => {
      this._restored = true;
    });
  }

  // ==================== INISIALISASI ====================

  async _initialize() {
    try {
      await this._loadFromD1();
      this._cacheInitialized = true;
      
      const webSockets = this.ctx.getWebSockets ? this.ctx.getWebSockets() : [];
      for (const ws of webSockets) {
        try {
          const attachment = ws.deserializeAttachment();
          if (attachment && attachment.username) {
            const userSeat = this._cache.userSeatData[attachment.username];
            if (userSeat) {
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
      
      if (!this.closing && !this.isDestroyed && !this._alarmScheduled) {
        this._alarmScheduled = true;
        setTimeout(() => this._alarm(), C.NUMBER_INTERVAL_MS);
      }
      
    } catch(error) {}
  }

  // ==================== LOAD DATA - 1 QUERY ====================

  async _loadFromD1() {
    try {
      // ✅ 1 QUERY UNTUK SEMUA DATA
      const result = await this.db
        .prepare('SELECT key, value FROM chat_data')
        .all();
      
      const data = { roomsData: {}, userSeatData: {}, currentNumber: 1 };
      
      for (const row of result.results || []) {
        try {
          const val = JSON.parse(row.value);
          switch(row.key) {
            case 'roomsData': data.roomsData = val; break;
            case 'userSeatData': data.userSeatData = val; break;
            case 'currentNumber': data.currentNumber = val; break;
          }
        } catch(e) {}
      }
      
      this._cache.roomsData = data.roomsData;
      this._cache.userSeatData = data.userSeatData;
      this._cache.currentNumber = data.currentNumber;
      this.currentNumber = data.currentNumber;
      this._cacheInitialized = true;
      
    } catch(error) {
      throw error;
    }
  }

  // ==================== SAVE DATA - OPTIMIZED ====================

  async _saveToD1(key, value) {
    // Simpan ke D1 dengan INSERT OR REPLACE
    await this.db
      .prepare(`
        INSERT INTO chat_data (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
      `)
      .bind(key, JSON.stringify(value))
      .run();
  }

  // ==================== PARTIAL UPDATE - HANYA YANG BERUBAH ====================

  async _updateSeatPartial(roomName, seatNumber, seatData) {
    // 1. Update memory cache
    if (!this._cache.roomsData[roomName]) {
      this._cache.roomsData[roomName] = { seats: {}, points: {}, muted: false, number: 1 };
    }
    
    this._cache.roomsData[roomName].seats[seatNumber] = seatData;
    
    // 2. Save ke D1 - HANYA 1 KEY
    await this._saveToD1('roomsData', this._cache.roomsData);
    
    return true;
  }

  async _updatePointPartial(roomName, seatNumber, pointData) {
    // 1. Update memory cache
    if (!this._cache.roomsData[roomName]) {
      this._cache.roomsData[roomName] = { seats: {}, points: {}, muted: false, number: 1 };
    }
    
    if (!this._cache.roomsData[roomName].points) {
      this._cache.roomsData[roomName].points = {};
    }
    
    this._cache.roomsData[roomName].points[seatNumber] = pointData;
    
    // 2. Save ke D1 - HANYA 1 KEY
    await this._saveToD1('roomsData', this._cache.roomsData);
    
    return true;
  }

  async _updateUserSeatPartial(username, seatInfo) {
    // 1. Update memory cache
    if (!seatInfo || !seatInfo.room || !seatInfo.seat) {
      delete this._cache.userSeatData[username];
    } else {
      this._cache.userSeatData[username] = seatInfo;
    }
    
    // 2. Save ke D1 - HANYA 1 KEY
    await this._saveToD1('userSeatData', this._cache.userSeatData);
    
    return true;
  }

  // ==================== BATCH UPDATE (UNTUK BANYAK PERUBAHAN) ====================

  async _queueUpdate(type, data) {
    this._updateQueue.push({ type, data, timestamp: Date.now() });
    
    if (!this._isProcessingQueue) {
      this._processQueue();
    }
  }

  async _processQueue() {
    if (this._isProcessingQueue || this._updateQueue.length === 0) return;
    
    this._isProcessingQueue = true;
    
    try {
      // Tunggu sebentar untuk kumpulkan lebih banyak update
      await new Promise(resolve => setTimeout(resolve, this._batchInterval));
      
      // Ambil batch
      const batch = this._updateQueue.splice(0, this._batchSize);
      
      // Proses batch
      const roomsToSave = {};
      const userSeatsToSave = {};
      
      for (const item of batch) {
        if (item.type === 'seat') {
          const { roomName, seatNumber, seatData } = item.data;
          if (!roomsToSave[roomName]) {
            roomsToSave[roomName] = this._cache.roomsData[roomName] || { seats: {}, points: {}, muted: false, number: 1 };
          }
          roomsToSave[roomName].seats[seatNumber] = seatData;
        } else if (item.type === 'point') {
          const { roomName, seatNumber, pointData } = item.data;
          if (!roomsToSave[roomName]) {
            roomsToSave[roomName] = this._cache.roomsData[roomName] || { seats: {}, points: {}, muted: false, number: 1 };
          }
          if (!roomsToSave[roomName].points) {
            roomsToSave[roomName].points = {};
          }
          roomsToSave[roomName].points[seatNumber] = pointData;
        } else if (item.type === 'userSeat') {
          const { username, seatInfo } = item.data;
          if (!seatInfo || !seatInfo.room || !seatInfo.seat) {
            delete userSeatsToSave[username];
          } else {
            userSeatsToSave[username] = seatInfo;
          }
        }
      }
      
      // Merge dengan cache
      for (const [roomName, roomData] of Object.entries(roomsToSave)) {
        this._cache.roomsData[roomName] = roomData;
      }
      
      for (const [username, seatInfo] of Object.entries(userSeatsToSave)) {
        this._cache.userSeatData[username] = seatInfo;
      }
      
      // Simpan ke D1 - HANYA KEY YANG BERUBAH
      if (Object.keys(roomsToSave).length > 0) {
        await this._saveToD1('roomsData', this._cache.roomsData);
      }
      
      if (Object.keys(userSeatsToSave).length > 0) {
        await this._saveToD1('userSeatData', this._cache.userSeatData);
      }
      
    } catch(e) {} finally {
      this._isProcessingQueue = false;
      
      // Proses sisa queue
      if (this._updateQueue.length > 0) {
        this._processQueue();
      }
    }
  }

  // ==================== CACHE MANAGEMENT ====================

  async _ensureCacheInitialized() {
    if (this._cacheInitialized && this._cache.roomsData && 
        Object.keys(this._cache.roomsData).length > 0) {
      return this._cache;
    }
    
    if (this._cacheLoading) {
      let waitCount = 0;
      while (this._cacheLoading && waitCount < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
      }
      return this._cache;
    }
    
    this._cacheLoading = true;
    try {
      await this._loadFromD1();
      this._cacheInitialized = true;
    } catch(e) {
      // Silent
    } finally {
      this._cacheLoading = false;
    }
    
    return this._cache;
  }

  async _getRoomData(roomName) {
    await this._ensureCacheInitialized();
    return this._cache.roomsData[roomName] || null;
  }

  async _getUserSeat(username) {
    await this._ensureCacheInitialized();
    return this._cache.userSeatData[username] || null;
  }

  // ==================== UPDATE METHODS (YANG DIPAKAI) ====================

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
    
    await this._ensureCacheInitialized();
    
    const roomData = this._cache.roomsData[roomName];
    if (!roomData || !roomData.seats || !roomData.seats[seat]) {
      return { success: false, error: 'Seat not found' };
    }
    
    const currentSeatData = roomData.seats[seat];
    if (currentSeatData.namauser !== data.namauser) {
      return { success: false, error: 'You do not own this seat' };
    }
    
    const updateData = {
      noimageUrl: data.noimageUrl || currentSeatData.noimageUrl || "",
      namauser: data.namauser || currentSeatData.namauser || "",
      color: data.color || currentSeatData.color || "",
      itembawah: typeof data.itembawah === 'number' ? data.itembawah : (parseInt(data.itembawah) || 0),
      itematas: typeof data.itematas === 'number' ? data.itematas : (parseInt(data.itematas) || 0),
      vip: typeof data.vip === 'number' ? data.vip : (parseInt(data.vip) || 0),
      viptanda: typeof data.viptanda === 'number' ? data.viptanda : (parseInt(data.viptanda) || 0)
    };
    
    // ✅ UPDATE LANGSUNG - HANYA 1 QUERY
    await this._updateSeatPartial(roomName, seat, updateData);
    
    return { success: true, data: updateData };
  }

  async _updatePoint(roomName, seat, x, y, fast) {
    await this._ensureCacheInitialized();
    
    const roomData = this._cache.roomsData[roomName];
    if (!roomData || !roomData.seats || !roomData.seats[seat]) return false;
    
    const pointData = { x: x || 0, y: y || 0, fast: !!fast };
    
    // ✅ UPDATE LANGSUNG - HANYA 1 QUERY
    await this._updatePointPartial(roomName, seat, pointData);
    
    return true;
  }

  async _removeUserFromRoom(username, roomName) {
    if (!username || !roomName) return false;
    
    await this._ensureCacheInitialized();
    
    const roomData = this._cache.roomsData[roomName];
    if (!roomData || !roomData.seats) return false;
    
    let seat = null;
    for (const [s, data] of Object.entries(roomData.seats)) {
      if (data && data.namauser === username) {
        seat = parseInt(s);
        break;
      }
    }
    
    if (!seat) return false;
    
    // ✅ DELETE DARI MEMORY
    delete roomData.seats[seat];
    if (roomData.points) {
      delete roomData.points[seat];
    }
    delete this._cache.userSeatData[username];
    
    // ✅ SAVE KE D1 - HANYA 1 QUERY
    await this._saveToD1('roomsData', this._cache.roomsData);
    await this._saveToD1('userSeatData', this._cache.userSeatData);
    
    // Hapus room jika kosong
    const hasSeats = Object.values(roomData.seats).some(s => s && s.namauser);
    const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
    if (!hasSeats && !hasPoints) {
      delete this._cache.roomsData[roomName];
      await this._saveToD1('roomsData', this._cache.roomsData);
    }
    
    this.broadcast(roomName, ["removeKursi", roomName, seat]);
    await this.updateRoomCount(roomName);
    
    return true;
  }

  // ==================== JOIN HANDLING ====================

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
    const existing = await this._getUserSeat(username);
    if (existing && existing.room !== roomName) {
      await this._removeUserFromRoom(username, existing.room);
    }
    
    await this._ensureCacheInitialized();
    
    let roomData = this._cache.roomsData[roomName];
    if (!roomData) {
      roomData = { seats: {}, points: {}, muted: false, number: 1 };
      this._cache.roomsData[roomName] = roomData;
    }
    
    let seat = null;
    for (const [s, data] of Object.entries(roomData.seats)) {
      if (data && data.namauser === username) {
        seat = parseInt(s);
        break;
      }
    }
    
    if (!seat) {
      const seatCount = Object.values(roomData.seats).filter(s => s && s.namauser).length;
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
      
      // ✅ SAVE KE D1 - HANYA 1 QUERY
      await this._saveToD1('roomsData', this._cache.roomsData);
    }
    
    const seatInfo = { room: roomName, seat, isMulti: false };
    this._cache.userSeatData[username] = seatInfo;
    await this._saveToD1('userSeatData', this._cache.userSeatData);
    
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
    
    await this.updateRoomCount(roomName);
    
    setTimeout(() => {
      try {
        if (ws && ws.readyState === 1) {
          this.sendAllStateTo(ws, roomName, true);
        }
      } catch(e) {}
    }, 1000);
    
    return true;
  }

  // ==================== DISCONNECT HANDLER ====================

  async _handleDisconnect(ws) {
    if (!ws) return;
    if (ws._disconnecting) return;
    ws._disconnecting = true;
    
    try {
      const username = ws.username;
      const roomName = ws.room || ws.roomname;
      
      if (!username) {
        this._cleanupWebSocket(ws);
        return;
      }
      
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
        }
        
        this.wsActiveMulti.delete(ws);
        this.wsSet.delete(ws);
        this._cleanupWebSocket(ws);
        return;
      }
      
      if (roomName) {
        await this._removeUserFromRoom(username, roomName);
      } else {
        const userSeat = await this._getUserSeat(username);
        if (userSeat && userSeat.room) {
          await this._removeUserFromRoom(username, userSeat.room);
        } else {
          await this._ensureCacheInitialized();
          const roomsData = this._cache.roomsData || {};
          let found = false;
          for (const [room, roomData] of Object.entries(roomsData)) {
            if (!roomData || !roomData.seats) continue;
            for (const [seat, data] of Object.entries(roomData.seats)) {
              if (data && data.namauser === username) {
                await this._removeUserFromRoom(username, room);
                found = true;
                break;
              }
            }
            if (found) break;
          }
          if (!found) {
            delete this._cache.userSeatData[username];
            await this._saveToD1('userSeatData', this._cache.userSeatData);
          }
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
      
      this.wsSet.delete(ws);
      this.wsActiveMulti.delete(ws);
      
      if (targetRoom && username) {
        this.broadcast(targetRoom, ["userOffline", username]);
      }
      
      this._cleanupWebSocket(ws);
      
    } catch(e) {
      this._cleanupWebSocket(ws);
    } finally {
      ws._disconnecting = false;
    }
  }

  _cleanupWebSocket(ws) {
    if (!ws) return;
    if (ws._cleaning) return;
    ws._cleaning = true;
    
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
      
      try {
        ws.username = null;
        ws.room = null;
        ws.roomname = null;
        ws.idtarget = null;
        ws.serializeAttachment({});
      } catch(e) {}
      
    } catch(e) {} finally {
      ws._cleaning = false;
      try { if (ws && ws.readyState === 1) ws.close(1000, "Cleanup"); } catch(e) {}
    }
  }

  // ==================== WEBSOCKET EVENTS ====================

  async webSocketMessage(ws, msg) {
    if (!ws || ws._closing || this.closing || this.isDestroyed) return;
    try { 
      await this.handleMessage(ws, msg); 
    } catch(e) {}
  }

  async webSocketClose(ws) { 
    if (!ws) return;
    try {
      await this._handleDisconnect(ws);
    } catch(e) {}
  }

  async webSocketError(ws) { 
    if (!ws) return;
    try {
      await this._handleDisconnect(ws);
    } catch(e) {}
  }

  // ==================== BROADCAST ====================

  broadcast(room, msg) {
    if (this.closing || this.isDestroyed || !room || !msg) return;
    
    try {
      const msgStr = JSON.stringify(msg);
      const clients = this.roomClients.get(room);
      if (!clients || clients.size === 0) return;
      
      const toRemove = new Set();
      
      for (const ws of clients) {
        if (!ws) { toRemove.add(ws); continue; }
        
        const wsRoom = ws.room || ws.roomname;
        if (wsRoom !== room) {
          toRemove.add(ws);
          continue;
        }
        
        try {
          if (ws.readyState === 1 && !ws._closing) {
            ws.send(msgStr);
          } else {
            toRemove.add(ws);
          }
        } catch(e) { toRemove.add(ws); }
      }
      
      if (toRemove.size > 0) {
        for (const ws of toRemove) {
          try {
            clients.delete(ws);
            if (ws) this._cleanupWebSocket(ws);
          } catch(e) {}
        }
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
      this._cleanupWebSocket(ws);
      return false;
    }
  }

  async updateRoomCount(room) {
    if (this.closing || this.isDestroyed || !room) return 0;
    try {
      await this._ensureCacheInitialized();
      
      const roomData = this._cache.roomsData[room];
      if (!roomData || !roomData.seats) {
        this.broadcast(room, ["roomUserCount", room, 0]);
        return 0;
      }
      
      let count = 0;
      for (const seat in roomData.seats) {
        if (roomData.seats[seat] && roomData.seats[seat].namauser) {
          count++;
        }
      }
      
      this.broadcast(room, ["roomUserCount", room, count]);
      return count;
    } catch(e) { 
      return 0; 
    }
  }

  async sendAllStateTo(ws, room, excludeSelf = false) {
    if (!ws || !ws.username) return;
    try {
      if (ws.readyState !== 1 || ws._closing) return;
    } catch(e) { return; }
    
    await this._ensureCacheInitialized();
    
    const roomData = this._cache.roomsData[room];
    if (!roomData) return;
    
    try {
      const allSeats = roomData.seats || {};
      const allPoints = roomData.points || {};
      
      const userSeat = await this._getUserSeat(ws.username);
      const selfSeat = userSeat?.seat;
      
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

  // ==================== ALARM / NUMBER UPDATE ====================

  async _alarm() {
    if (this.closing || this.isDestroyed) return;
    
    await this._updateNumber();
    this._cleanupDeadConnections();
    this._cleanupStaleLocks();
    
    if (!this.closing && !this.isDestroyed) {
      setTimeout(() => this._alarm(), C.NUMBER_INTERVAL_MS);
    }
  }

  async _updateNumber() {
    if (this._isNumberUpdating || this.closing || this.isDestroyed) return;
    this._isNumberUpdating = true;
    try {
      this.currentNumber = this.currentNumber < C.MAX_NUMBER ? this.currentNumber + 1 : 1;
      
      // Update memory cache
      for (const [roomName, roomData] of Object.entries(this._cache.roomsData)) {
        if (roomData) {
          roomData.number = this.currentNumber;
        }
      }
      
      // ✅ SAVE KE D1 - HANYA 1 QUERY
      await this._saveToD1('roomsData', this._cache.roomsData);
      await this._saveToD1('currentNumber', this.currentNumber);
      
      for (const [room, clients] of this.roomClients) {
        if (clients && clients.size > 0) {
          this.broadcast(room, ["currentNumber", this.currentNumber]);
        }
      }
      
    } catch(e) {} finally {
      this._isNumberUpdating = false;
    }
  }

  // ==================== CLEANUP ====================

  _cleanupDeadConnections() {
    try {
      const toRemove = [];
      for (const ws of this.wsSet) {
        if (!ws || ws.readyState !== 1 || ws._closing) {
          toRemove.push(ws);
        }
      }
      for (const ws of toRemove) {
        this._cleanupWebSocket(ws);
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

  // ==================== MESSAGE HANDLING ====================

  async _handleSetId(ws, username, isNewUser) {
    if (!ws || !username || typeof username !== 'string' || username.length === 0 || this.closing || this.isDestroyed) {
      try { if (ws?.readyState === 1) ws.close(1000, "Invalid username"); } catch(e) {}
      return;
    }
    
    const userSeat = await this._getUserSeat(username);
    const isMultiUser = userSeat !== null && userSeat !== undefined && userSeat.isMulti === true;
    
    if (isMultiUser && isNewUser === false) {
      return;
    }
    
    if (isMultiUser && isNewUser === true) {
      await this._removeUserFromRoom(username, userSeat.room);
      delete this._cache.userSeatData[username];
      await this._saveToD1('userSeatData', this._cache.userSeatData);
    }
    
    const existing = await this._getUserSeat(username);
    if (existing?.room) {
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
          
          const existing = await this._getUserSeat(multiUsername);
          if (existing?.room) {
            await this._removeUserFromRoom(multiUsername, existing.room);
          }
          
          await this._ensureCacheInitialized();
          
          let roomData = this._cache.roomsData[multiRoomname];
          if (!roomData) {
            roomData = { seats: {}, points: {}, muted: false, number: 1 };
            this._cache.roomsData[multiRoomname] = roomData;
          }
          
          let seat = null;
          const seatCount = Object.values(roomData.seats).filter(s => s && s.namauser).length;
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
          
          await this._saveToD1('roomsData', this._cache.roomsData);
          
          const seatInfo = { room: multiRoomname, seat, isMulti: true };
          this._cache.userSeatData[multiUsername] = seatInfo;
          await this._saveToD1('userSeatData', this._cache.userSeatData);
          
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
          await this.updateRoomCount(multiRoomname);
          
          break;
        }
        
        case "exitMulti": {
          const targetUsername = args[0];
          if (!targetUsername) break;
          
          try {
            let userSeat = await this._getUserSeat(targetUsername);
            
            if (!userSeat) {
              await this._ensureCacheInitialized();
              const roomsData = this._cache.roomsData;
              for (const [roomName, roomData] of Object.entries(roomsData)) {
                if (!roomData || !roomData.seats) continue;
                for (const [seat, data] of Object.entries(roomData.seats)) {
                  if (data && data.namauser === targetUsername) {
                    userSeat = { room: roomName, seat: parseInt(seat), isMulti: true };
                    break;
                  }
                }
                if (userSeat) break;
              }
            }
            
            const roomName = userSeat?.room;
            const seatNumber = userSeat?.seat;
            
            if (roomName && seatNumber) {
              await this._removeUserFromRoom(targetUsername, roomName);
            }
            
            delete this._cache.userSeatData[targetUsername];
            await this._saveToD1('userSeatData', this._cache.userSeatData);
            
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
              this.broadcast(roomName, ["removeKursi", roomName, seatNumber]);
              this.broadcast(roomName, ["userOffline", targetUsername, seatNumber]);
              await this.updateRoomCount(roomName);
            }
            
            this.safeSend(ws, ["exitMultiSuccess", targetUsername, roomName, seatNumber]);
            
          } catch(e) {
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
            this.safeSend(ws, ["updateKursiError", e.message || "Internal error"]);
          } finally {
            this._kursiLocks.delete(lockKey);
          }
          break;
        }
        
        case "chat": {
          const [chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor] = args;
          if (!chatMsg || !ROOMS_SET.has(chatRoom)) break;
          
          const userSeat = await this._getUserSeat(chatUser);
          if (!userSeat || userSeat.room !== chatRoom) {
            break;
          }
          
          const wsRoom = ws.room || ws.roomname;
          if (wsRoom !== chatRoom) {
            break;
          }
          
          this.broadcast(chatRoom, ["chat", chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor]);
          break;
        }
        
        case "updatePoint": {
          const [pointRoom, pointSeat, pointX, pointY, pointFast] = args;
          if (!pointRoom || typeof pointSeat !== 'number') break;
          
          const userSeat = await this._getUserSeat(ws.username);
          if (!userSeat || userSeat.room !== pointRoom || userSeat.seat !== pointSeat) {
            break;
          }
          
          const updated = await this._updatePoint(pointRoom, pointSeat, pointX, pointY, pointFast === 1);
          if (updated) {
            this.broadcast(pointRoom, ["pointUpdated", pointRoom, pointSeat, pointX, pointY, pointFast]);
          }
          break;
        }
        
        case "gift": {
          const [giftRoom, giftSender, giftReceiver, giftGiftName] = args;
          if (giftRoom && ROOMS_SET.has(giftRoom)) {
            const senderSeat = await this._getUserSeat(giftSender);
            const receiverSeat = await this._getUserSeat(giftReceiver);
            
            if (!senderSeat || senderSeat.room !== giftRoom) break;
            if (!receiverSeat || receiverSeat.room !== giftRoom) break;
            
            if ((ws.room || ws.roomname) !== giftRoom) break;
            
            this.broadcast(giftRoom, ["gift", giftRoom, giftSender, giftReceiver, giftGiftName, Date.now()]);
          }
          break;
        }
        
        case "rollangak": {
          const [rollRoom, rollUser, rollAngka] = args;
          if (rollRoom && ROOMS_SET.has(rollRoom)) {
            const userSeat = await this._getUserSeat(rollUser);
            if (!userSeat || userSeat.room !== rollRoom) break;
            
            if ((ws.room || ws.roomname) !== rollRoom) break;
            
            this.broadcast(rollRoom, ["rollangakBroadcast", rollRoom, rollUser, rollAngka]);
          }
          break;
        }
        
        case "removeKursiAndPoint": {
          const [removeRoom, removeSeat] = args;
          
          const userSeat = await this._getUserSeat(ws.username);
          if (!userSeat || userSeat.room !== removeRoom) break;
          
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
        
        case "setMuteType": {
          const [muteVal, muteRoom] = args;
          if (!muteRoom || !ROOMS_SET.has(muteRoom)) break;
          
          const userSeat = await this._getUserSeat(ws.username);
          if (!userSeat || userSeat.room !== muteRoom) break;
          
          // Update memory cache
          const roomData = this._cache.roomsData[muteRoom];
          if (roomData) {
            roomData.muted = !!muteVal;
            await this._saveToD1('roomsData', this._cache.roomsData);
          }
          
          this.broadcast(muteRoom, ["muteStatusChanged", !!muteVal, muteRoom]);
          this.safeSend(ws, ["muteTypeSet", !!muteVal, true, muteRoom]);
          break;
        }
        
        case "modwarning": {
          const modRoom = args[0];
          if (modRoom && ROOMS_SET.has(modRoom)) {
            const userSeat = await this._getUserSeat(ws.username);
            if (!userSeat || userSeat.room !== modRoom) break;
            
            this.broadcast(modRoom, ["modwarning", modRoom]);
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
          } catch(e) {}
          break;
        }
        
        case "isUserOnline": {
          const [onlineTarget, onlineCallback] = args;
          let isOnline = false;
          
          const userSeat = await this._getUserSeat(onlineTarget);
          if (userSeat) {
            if (userSeat.isMulti === true) {
              isOnline = true;
            } else {
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
          }
          
          this.safeSend(ws, ["userOnlineStatus", onlineTarget, isOnline, onlineCallback || ""]);
          break;
        }
        
        case "getOnlineUsers": {
          const users = [];
          await this._ensureCacheInitialized();
          const userSeatData = this._cache.userSeatData || {};
          
          for (const [username, seatInfo] of Object.entries(userSeatData)) {
            if (seatInfo) {
              let isOnline = false;
              
              if (seatInfo.isMulti === true) {
                isOnline = true;
              } else {
                const connections = this.userConnections.get(username);
                if (connections) {
                  for (const conn of connections) {
                    if (conn?.readyState === 1) {
                      isOnline = true;
                      break;
                    }
                  }
                }
              }
              
              if (isOnline) {
                users.push(username);
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
            const roomData = this._cache.roomsData[room];
            counts[room] = roomData?.seats ? Object.values(roomData.seats).filter(s => s && s.namauser).length : 0;
          }
          this.safeSend(ws, ["allRoomsUserCount", Object.entries(counts)]);
          break;
        }
        
        case "getRoomUserCount": {
          const roomName = args[0];
          if (roomName && ROOMS_SET.has(roomName)) {
            await this._ensureCacheInitialized();
            const roomData = this._cache.roomsData[roomName];
            const count = roomData?.seats ? Object.values(roomData.seats).filter(s => s && s.namauser).length : 0;
            this.safeSend(ws, ["roomUserCount", roomName, count]);
          }
          break;
        }
        
        case "getMuteType": {
          const getMuteRoom = args[0];
          if (getMuteRoom && ROOMS_SET.has(getMuteRoom)) {
            await this._ensureCacheInitialized();
            const roomData = this._cache.roomsData[getMuteRoom];
            this.safeSend(ws, ["muteTypeResponse", roomData?.muted || false, getMuteRoom]);
          }
          break;
        }
        
        case "onDestroy":
          await this._handleDisconnect(ws);
          break;
        
        default:
          this.safeSend(ws, ["error", `Unknown event: ${evt}`]);
          break;
      }
    } catch(e) {}
  }

  // ==================== FETCH ====================

  async fetch(req) {
    if (this.closing || this.isDestroyed) {
      return new Response("Shutting down", { status: 503 });
    }
    
    await this._ensureCacheInitialized();
    
    try {
      const upgrade = req.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        return new Response("Chat Server Running", { 
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

  // ==================== DESTROY ====================

  async destroy() {
    if (this.isDestroyed) return;
    this.closing = true;
    this.isDestroyed = true;
    
    this._joinLocks.clear();
    this._kursiLocks.clear();
    this._userJoinLock.clear();
    
    const wsCopy = Array.from(this.wsSet);
    for (const ws of wsCopy) {
      const isMulti = this.wsActiveMulti.has(ws);
      
      if (ws?.readyState === 1) {
        try { ws.send(JSON.stringify(["serverShutdown", "Server shutting down"])); } catch(e) {}
        try { ws.close(1000, "Shutdown"); } catch(e) {}
      }
      
      if (isMulti) {
        this.wsSet.delete(ws);
        this.wsActiveMulti.delete(ws);
        const room = ws.room || ws.roomname;
        if (room) {
          const rc = this.roomClients.get(room);
          if (rc) rc.delete(ws);
        }
      } else {
        try { 
          const username = ws.username;
          const roomName = ws.room || ws.roomname;
          if (username && roomName) {
            await this._removeUserFromRoom(username, roomName);
          } else if (username) {
            delete this._cache.userSeatData[username];
            await this._saveToD1('userSeatData', this._cache.userSeatData);
          }
          this._cleanupWebSocket(ws); 
        } catch(e) {}
      }
    }
    
    for (const [username, conns] of this.userConnections) {
      const toRemove = [];
      for (const conn of conns) {
        if (!conn || conn.readyState !== 1) {
          toRemove.push(conn);
        }
      }
      for (const conn of toRemove) {
        conns.delete(conn);
      }
      if (conns.size === 0) {
        let isMultiUser = false;
        for (const [wsKey, data] of this.wsActiveMulti) {
          if (data && data.username === username) {
            isMultiUser = true;
            break;
          }
        }
        if (!isMultiUser) {
          delete this._cache.userSeatData[username];
          await this._saveToD1('userSeatData', this._cache.userSeatData);
          this.userConnections.delete(username);
        }
      }
    }
  }
}

export default ChatServer;
