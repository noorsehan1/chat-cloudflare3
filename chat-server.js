// ==================== CHAT-SERVER-REAL-TIME-STORAGE.JS ====================
// VERSION: Auto-generated with timestamp
// DEPLOY: Auto-generated
// SUPPORTS CLOUDFLARE HIBERNATION (AUTOMATIC)

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
    
    this.currentNumber = 1;
    this._onlineUsers = new Set();
    this._userCounts = {};
    for (const room of ROOMS) {
      this._userCounts[room] = 0;
    }
    
    this._isNumberUpdating = false;
    this._isRestoring = false;
    this._lastRefreshTime = 0;
    
    this._initFromStorage().then(() => {});
    this._autoResetOnDeploy().then(() => {});
  }

  // ============================================================
  // AUTO RESET ON DEPLOY
  // ============================================================
  async _autoResetOnDeploy() {
    try {
      const storedVersion = await this.ctx.storage.get("lastDeployVersion");
      
      if (storedVersion !== this._version) {
        // HAPUS SEMUA DATA DI STORAGE
        await this.ctx.storage.delete("roomsData");
        await this.ctx.storage.delete("userSeatData");
        await this.ctx.storage.delete("currentNumber");
        await this.ctx.storage.delete("userCounts");
        await this.ctx.storage.delete("onlineUsers");
        await this.ctx.storage.delete("lastReset");
        
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
      
    } catch(e) {}
  }

  // ============================================================
  // INITIALIZE FROM STORAGE
  // ============================================================
  async _initFromStorage() {
    try {
      const roomsData = await this.ctx.storage.get("roomsData") || {};
      const userSeatData = await this.ctx.storage.get("userSeatData") || {};
      const currentNumber = await this.ctx.storage.get("currentNumber") || 1;
      const userCounts = await this.ctx.storage.get("userCounts") || {};
      const onlineUsers = await this.ctx.storage.get("onlineUsers") || [];
      
      this.currentNumber = currentNumber;
      this._userCounts = userCounts;
      this._onlineUsers = new Set(onlineUsers);
      
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
      
    } catch(e) {}
  }

  // ============================================================
  // GET DATA FROM STORAGE
  // ============================================================
  async _getRoomsData() {
    return await this.ctx.storage.get("roomsData") || {};
  }

  async _getUserSeatData() {
    return await this.ctx.storage.get("userSeatData") || {};
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
    try {
      const updates = {};
      
      if (roomsData !== undefined) {
        updates.roomsData = roomsData;
      }
      
      if (userSeatData !== undefined) {
        updates.userSeatData = userSeatData;
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
  // HANDLE JOIN
  // ============================================================
  async _handleJoin(ws, roomName) {
    if (!ws || !ws.username || !roomName || !ROOMS_SET.has(roomName) || this.closing || this.isDestroyed) {
      return false;
    }
    
    const username = ws.username;
    
    let roomsData = await this._getRoomsData();
    let userSeatData = await this._getUserSeatData();
    const currentNumber = await this._getCurrentNumber();
    this.currentNumber = currentNumber;
    
    const seatInfo = userSeatData[username];
    const isMulti = seatInfo ? (seatInfo.isMulti || false) : false;
    
    let oldRoom = null;
    let oldSeat = null;
    
    if (seatInfo && seatInfo.room) {
      oldRoom = seatInfo.room;
      oldSeat = seatInfo.seat;
    }
    
    if (!oldRoom) {
      if (ws._isMulti && ws._multiRoom && ws._multiSeat) {
        oldRoom = ws._multiRoom;
        oldSeat = ws._multiSeat;
      }
    }
    
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
    
    if (oldRoom && oldSeat !== null && roomsData[oldRoom]) {
      const roomData = roomsData[oldRoom];
      
      delete roomData.seats[oldSeat];
      if (roomData.points) {
        delete roomData.points[oldSeat];
      }
      
      if (userSeatData[username]) {
        delete userSeatData[username];
      }
      
      if (this._onlineUsers.has(username)) {
        this._onlineUsers.delete(username);
      }
      
      const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
      const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
      if (!hasSeats && !hasPoints) {
        delete roomsData[oldRoom];
      }
      
      this.broadcast(oldRoom, ["removeKursi", oldRoom, oldSeat]);
      await this.updateRoomCount(oldRoom);
      
      for (const [room, clients] of this.roomClients) {
        if (clients.has(ws)) {
          clients.delete(ws);
        }
      }
    }
    
    await this._saveToStorage(roomsData, userSeatData, this.currentNumber);
    
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
    
    newRoomData.seats[newSeat] = {};
    
    userSeatData[username] = {
      room: roomName,
      seat: newSeat,
      isMulti: isMulti,
      multiRoom: isMulti ? roomName : null,
      multiSeat: isMulti ? newSeat : null
    };
    
    await this._saveToStorage(roomsData, userSeatData, this.currentNumber);
    
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

  // ============================================================
  // UPDATE KURSI
  // ============================================================
  async _updateKursi(roomName, seat, data) {
    const roomsData = await this._getRoomsData();
    const roomData = roomsData[roomName];
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
    
    await this._saveToStorage(roomsData, undefined, undefined);
    return true;
  }

  // ============================================================
  // UPDATE POINT
  // ============================================================
  async _updatePoint(roomName, seat, x, y, fast) {
    const roomsData = await this._getRoomsData();
    const roomData = roomsData[roomName];
    if (!roomData || !roomData.seats || !roomData.seats[seat]) return false;
    
    if (!roomData.points) roomData.points = {};
    roomData.points[seat] = { x: x || 0, y: y || 0, fast: !!fast };
    
    await this._saveToStorage(roomsData, undefined, undefined);
    return true;
  }

  // ============================================================
  // REMOVE USER FROM ALL ROOMS
  // ============================================================
  async _removeUserFromAllRooms(username) {
    if (!username) return false;
    
    let removed = false;
    const roomsData = await this._getRoomsData();
    const userSeatData = await this._getUserSeatData();
    
    for (const [roomName, roomData] of Object.entries(roomsData)) {
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
      }
    }
    
    if (userSeatData[username]) {
      delete userSeatData[username];
      removed = true;
    }
    
    if (this._onlineUsers.has(username)) {
      this._onlineUsers.delete(username);
      removed = true;
    }
    
    if (removed) {
      await this._saveToStorage(roomsData, userSeatData, this.currentNumber);
    }
    
    return removed;
  }

  // ============================================================
  // UPDATE NUMBER
  // ============================================================
  async _updateNumber() {
    if (this._isNumberUpdating || this.closing || this.isDestroyed) return;
    this._isNumberUpdating = true;
    try {
      const currentNumber = await this._getCurrentNumber();
      const newNumber = currentNumber < C.MAX_NUMBER ? currentNumber + 1 : 1;
      this.currentNumber = newNumber;
      
      let roomsData = await this._getRoomsData();
      let changed = false;
      
      for (const [roomName, roomData] of Object.entries(roomsData)) {
        if (roomData) {
          roomData.number = newNumber;
          changed = true;
        }
      }
      
      if (changed) {
        await this._saveToStorage(roomsData, undefined, newNumber);
      } else {
        await this._saveToStorage(undefined, undefined, newNumber);
      }
      
      const numberMsg = JSON.stringify(["currentNumber", newNumber]);
      
      this._refreshRoomClients(true);
      for (const [room, clients] of this.roomClients) {
        if (clients && clients.size > 0) {
          this._broadcastToRoom(room, numberMsg);
        }
      }
      
    } catch(e) {
      const currentNumber = await this._getCurrentNumber();
      this.currentNumber = currentNumber;
    } finally {
      this._isNumberUpdating = false;
    }
  }

  // ============================================================
  // BROADCAST
  // ============================================================
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
      const roomsData = await this._getRoomsData();
      const roomData = roomsData[room];
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
    
    const roomsData = await this._getRoomsData();
    const roomData = roomsData[room];
    if (!roomData) return;
    
    try {
      const allSeats = roomData.seats || {};
      const allPoints = roomData.points || {};
      
      const userSeatData = await this._getUserSeatData();
      const userSeat = userSeatData[ws.username];
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

  // ============================================================
  // WEBSOCKET EVENTS
  // ============================================================
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
          const userSeatData = await this._getUserSeatData();
          userSeatData[attachment.username] = attachment.seatInfo;
          await this._saveToStorage(undefined, userSeatData, undefined);
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
      const userSeatData = await this._getUserSeatData();
      const seatInfo = username ? userSeatData[username] : null;
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
      const userSeatData = await this._getUserSeatData();
      const seatInfo = username ? userSeatData[username] : null;
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
      
      for (const [room, clients] of this.roomClients) {
        if (clients.has(ws)) {
          clients.delete(ws);
        }
      }
      
      this._refreshRoomClients(true);
    } catch(e) {}
  }

  // ============================================================
  // HANDLE SET ID
  // ============================================================
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

  // ============================================================
  // HANDLE MESSAGE
  // ============================================================
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
        
        case "getCurrentNumber": {
          const currentNumber = await this._getCurrentNumber();
          this.safeSend(ws, ["currentNumber", currentNumber]);
          break;
        }
        
        case "getServerVersion":
          this.safeSend(ws, ["serverVersion", this._version, this._deployTime, this._deployInfo]);
          break;
        
        case "setIdTarget2": {
          const username = args[0];
          const isNewUser = args[1];
          
          if (username) {
            const userSeatData = await this._getUserSeatData();
            const seatInfo = userSeatData[username];
            
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
          
          let roomsData = await this._getRoomsData();
          let roomData = roomsData[multiRoomname];
          if (!roomData) {
            roomData = { seats: {}, points: {}, muted: false, number: 1 };
            roomsData[multiRoomname] = roomData;
            await this._saveToStorage(roomsData, undefined, undefined);
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
          
          await this._saveToStorage(roomsData, undefined, undefined);
          
          let userSeatData = await this._getUserSeatData();
          const seatInfo = { 
            room: multiRoomname, 
            seat: seat, 
            isMulti: true,
            multiRoom: multiRoomname,
            multiSeat: seat
          };
          userSeatData[multiUsername] = seatInfo;
          await this._saveToStorage(undefined, userSeatData, undefined);
          
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
          
          let userSeatData = await this._getUserSeatData();
          let userSeat = userSeatData[targetUsername];
          
          if (!userSeat) {
            const roomsData = await this._getRoomsData();
            for (const [roomName, roomData] of Object.entries(roomsData)) {
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
          
          userSeatData[targetUsername] = {
            room: roomName,
            seat: seatNumber,
            isMulti: true,
            multiRoom: roomName,
            multiSeat: seatNumber
          };
          await this._saveToStorage(undefined, userSeatData, undefined);
          
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
            const userSeatData = await this._getUserSeatData();
            const seatInfo = userSeatData[targetUsername];
            const isMulti = seatInfo ? (seatInfo.isMulti || false) : false;
            
            if (!isMulti) {
              this.safeSend(ws, ["exitMultiError", `${targetUsername} bukan user multi`]);
              break;
            }
            
            let roomsData = await this._getRoomsData();
            for (const [roomName, roomData] of Object.entries(roomsData)) {
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
              }
            }
            
            if (userSeatData[targetUsername]) {
              delete userSeatData[targetUsername];
            }
            
            await this._saveToStorage(roomsData, userSeatData, this.currentNumber);
            
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
            const roomsData = await this._getRoomsData();
            const roomData = roomsData[kursiRoom];
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
          
          const userSeatData = await this._getUserSeatData();
          const userSeat = userSeatData[chatUser];
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
          
          const roomsData = await this._getRoomsData();
          const roomData = roomsData[removeRoom];
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
            const userSeatData = await this._getUserSeatData();
            const userSeat = userSeatData[privTarget];
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
            const userSeatData = await this._getUserSeatData();
            const receiverSeat = userSeatData[giftReceiver];
            if (!receiverSeat || receiverSeat.room !== giftRoom) break;
            this._broadcastToRoom(giftRoom, JSON.stringify(["gift", giftRoom, giftSender, giftReceiver, giftGiftName, Date.now()]));
          }
          break;
        }
        
        case "rollangak": {
          const [rollRoom, rollUser, rollAngka] = args;
          if (rollRoom && ROOMS_SET.has(rollRoom)) {
            const userSeatData = await this._getUserSeatData();
            const userSeat = userSeatData[rollUser];
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
            const userSeatData = await this._getUserSeatData();
            const userSeat = userSeatData[onlineTarget];
            
            if (userSeat) {
              if (userSeat.isMulti) {
                const roomsData = await this._getRoomsData();
                const roomData = roomsData[userSeat.room];
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
          const userSeatData = await this._getUserSeatData();
          const users = Object.keys(userSeatData);
          this.safeSend(ws, ["allOnlineUsers", users]);
          break;
        }
        
        case "getAllRoomsUserCount": {
          const roomsData = await this._getRoomsData();
          const counts = {};
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
            const roomsData = await this._getRoomsData();
            const roomData = roomsData[roomName];
            const count = roomData?.seats ? Object.keys(roomData.seats).length : 0;
            this.safeSend(ws, ["roomUserCount", roomName, count]);
          }
          break;
        }
        
        case "setMuteType": {
          const [muteVal, muteRoom] = args;
          if (!muteRoom || !ROOMS_SET.has(muteRoom)) break;
          
          const roomsData = await this._getRoomsData();
          const roomData = roomsData[muteRoom];
          if (roomData) {
            roomData.muted = !!muteVal;
            await this._saveToStorage(roomsData, undefined, undefined);
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
            const roomsData = await this._getRoomsData();
            const roomData = roomsData[getMuteRoom];
            this.safeSend(ws, ["muteTypeResponse", roomData?.muted || false, getMuteRoom]);
          }
          break;
        }
        
        case "clearCacheTotal": {
          await this.ctx.storage.delete("roomsData");
          await this.ctx.storage.delete("userSeatData");
          await this.ctx.storage.delete("currentNumber");
          await this.ctx.storage.delete("userCounts");
          await this.ctx.storage.delete("onlineUsers");
          await this.ctx.storage.delete("lastReset");
          await this.ctx.storage.delete("lastDeployVersion");
          await this.ctx.storage.delete("lastDeployTime");
          
          this.currentNumber = 1;
          this._onlineUsers.clear();
          this._userCounts = {};
          for (const room of ROOMS) {
            this._userCounts[room] = 0;
          }
          for (const room of ROOMS) {
            this.roomClients.set(room, new Set());
          }
          
          const webSockets = this._getActiveWebSockets();
          for (const ws of webSockets) {
            try {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify(["cacheClearedTotal", "Semua cache telah dihapus total"]));
                ws.close(1000, "Cache cleared total");
              }
            } catch(e) {}
          }
          
          this._refreshRoomClients(true);
          
          if (!this.closing && !this.isDestroyed) {
            await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
          }
          
          this.safeSend(ws, ["clearCacheTotalResult", { 
            success: true, 
            message: "Semua cache dan storage berhasil dihapus total",
            timestamp: Date.now()
          }]);
          break;
        }
        
        case "onDestroy":
          break;
        
        default:
          this.safeSend(ws, ["error", `Unknown event: ${evt}`]);
          break;
      }
    } catch(e) {
      this.safeSend(ws, ["error", e.message]);
    }
  }

  // ============================================================
  // ALARM
  // ============================================================
  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    await this._updateNumber();
    await this._cleanupStorage();
    
    if (!this.closing && !this.isDestroyed) {
      this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
    }
  }

  async _cleanupStorage() {
    try {
      const roomsData = await this._getRoomsData();
      const userSeatData = await this._getUserSeatData();
      
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
        await this._saveToStorage(roomsData, userSeatData, this.currentNumber);
      }
      
    } catch(e) {}
  }

  // ============================================================
  // RESET ALL DATA
  // ============================================================
  async resetAllData() {
    const timestamp = Date.now();
    
    try {
      await this.ctx.storage.delete("roomsData");
      await this.ctx.storage.delete("userSeatData");
      await this.ctx.storage.delete("currentNumber");
      await this.ctx.storage.delete("userCounts");
      await this.ctx.storage.delete("onlineUsers");
      await this.ctx.storage.delete("lastReset");
      
      this.currentNumber = 1;
      this._onlineUsers.clear();
      this._userCounts = {};
      for (const room of ROOMS) {
        this._userCounts[room] = 0;
      }
      for (const room of ROOMS) {
        this.roomClients.set(room, new Set());
      }
      
      await this.ctx.storage.put("lastDeployVersion", this._version);
      await this.ctx.storage.put("lastDeployTime", this._deployTime);
      await this.ctx.storage.put("lastReset", timestamp);
      
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
      
      this._refreshRoomClients(true);
      
      if (!this.closing && !this.isDestroyed) {
        await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      }
      
      return {
        success: true,
        message: "Reset data berhasil",
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

  // ============================================================
  // FETCH
  // ============================================================
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
      
      if (url.pathname === "/clear-cache-total" && req.method === "POST") {
        await this.ctx.storage.delete("roomsData");
        await this.ctx.storage.delete("userSeatData");
        await this.ctx.storage.delete("currentNumber");
        await this.ctx.storage.delete("userCounts");
        await this.ctx.storage.delete("onlineUsers");
        await this.ctx.storage.delete("lastReset");
        await this.ctx.storage.delete("lastDeployVersion");
        await this.ctx.storage.delete("lastDeployTime");
        
        this.currentNumber = 1;
        this._onlineUsers.clear();
        this._userCounts = {};
        for (const room of ROOMS) {
          this._userCounts[room] = 0;
        }
        for (const room of ROOMS) {
          this.roomClients.set(room, new Set());
        }
        
        const webSockets = this._getActiveWebSockets();
        for (const ws of webSockets) {
          try {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify(["cacheClearedTotal", "Semua cache telah dihapus total"]));
              ws.close(1000, "Cache cleared total");
            }
          } catch(e) {}
        }
        
        this._refreshRoomClients(true);
        
        if (!this.closing && !this.isDestroyed) {
          await this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        }
        
        return new Response(JSON.stringify({
          success: true,
          message: "Semua cache dan storage berhasil dihapus total",
          timestamp: Date.now()
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      if (url.pathname === "/status") {
        const webSockets = this._getActiveWebSockets();
        const roomsData = await this._getRoomsData();
        const userSeatData = await this._getUserSeatData();
        const userCounts = await this._getUserCounts();
        const onlineUsers = await this._getOnlineUsers();
        
        const status = {
          activeConnections: webSockets.length,
          rooms: userCounts,
          totalUsers: onlineUsers.length,
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
          roomsDataKeys: Object.keys(roomsData),
          userSeatDataKeys: Object.keys(userSeatData)
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

  // ============================================================
  // DESTROY
  // ============================================================
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
