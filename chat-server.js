// ==================== CHAT-SERVER-STORAGE-ONLY-OPTIMIZED.js ====================
// VERSION: 4.0.0 - FINAL: STORAGE ONLY, NO CACHE, NO serverVersion
// AUTO RESTORE AFTER HIBERNATE

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
    this._restoreComplete = false;
    
    this._version = SERVER_VERSION;
    this._deployInfo = DEPLOY_VERSION;
    this._deployTime = DEPLOY_VERSION.deployDate;
    
    this.roomClients = new Map();
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    this.currentNumber = 1;
    this._isNumberUpdating = false;
    
    this._initFromStorage().then(() => {
      this._restoreComplete = true;
      this._restoreAfterHibernate();
    });
    
    this._autoResetOnDeploy().then(() => {});
  }

  // ============================================================
  // STORAGE HELPERS
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

  async _getMuteState(room) {
    try {
      const roomsData = await this._getRoomsData();
      const roomData = roomsData[room];
      return roomData ? (roomData.muted || false) : false;
    } catch(e) {
      return false;
    }
  }

  async _setMuteState(room, muted) {
    try {
      const roomsData = await this._getRoomsData();
      if (!roomsData[room]) {
        roomsData[room] = { seats: {}, points: {}, muted: muted, number: 1 };
      } else {
        roomsData[room].muted = muted;
      }
      await this.ctx.storage.put("roomsData", roomsData);
      return true;
    } catch(e) {
      return false;
    }
  }

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
      
      if (Object.keys(updates).length > 0) {
        await this.ctx.storage.put(updates);
      }
      
      return {
        roomsData: roomsData || await this._getRoomsData(),
        userSeatData: userSeatData || await this._getUserSeatData(),
        currentNumber: this.currentNumber,
      };
      
    } catch(e) {
      throw e;
    }
  }

  // ============================================================
  // GET ROOM COUNT
  // ============================================================
  
  async _getRoomCount(room) {
    const roomsData = await this._getRoomsData();
    const roomData = roomsData[room];
    return roomData?.seats ? Object.keys(roomData.seats).length : 0;
  }

  async _getAllRoomCounts() {
    const roomsData = await this._getRoomsData();
    const counts = {};
    for (const room of ROOMS) {
      const roomData = roomsData[room];
      counts[room] = roomData?.seats ? Object.keys(roomData.seats).length : 0;
    }
    return counts;
  }

  async _getOnlineUsers() {
    const userSeatData = await this._getUserSeatData();
    return Object.keys(userSeatData);
  }

  // ============================================================
  // RESTORE AFTER HIBERNATE
  // ============================================================
  
  async _restoreAfterHibernate() {
    try {
      this.currentNumber = await this._getCurrentNumber();
      await this._restoreAllWebSockets();
      this._refreshRoomClients(true);
      
      const restoreMessage = JSON.stringify(["serverRestored", {
        timestamp: Date.now()
      }]);
      
      const webSockets = this._getActiveWebSockets();
      for (const ws of webSockets) {
        try {
          if (ws.readyState === 1) {
            ws.send(restoreMessage);
            await this._sendCurrentStateToWS(ws);
          }
        } catch(e) {}
      }
      
    } catch(e) {}
  }

  // ============================================================
  // RESTORE ALL WEBSOCKETS
  // ============================================================
  
  async _restoreAllWebSockets() {
    try {
      const webSockets = this._getActiveWebSockets();
      const userSeatData = await this._getUserSeatData();
      const muteStates = {};
      
      for (const room of ROOMS) {
        muteStates[room] = await this._getMuteState(room);
      }
      
      for (const ws of webSockets) {
        try {
          let attachment = null;
          try {
            attachment = ws.deserializeAttachment();
          } catch(e) {}
          
          let username = null;
          let room = null;
          let seat = null;
          let isMulti = false;
          let multiRoom = null;
          let multiSeat = null;
          
          if (attachment && attachment.username) {
            username = attachment.username;
          } else if (ws._cachedUsername) {
            username = ws._cachedUsername;
          } else if (ws.username) {
            username = ws.username;
          }
          
          if (username) {
            const seatInfo = userSeatData[username];
            
            if (seatInfo) {
              room = seatInfo.room;
              seat = seatInfo.seat;
              isMulti = seatInfo.isMulti || false;
              multiRoom = seatInfo.isMulti ? seatInfo.room : null;
              multiSeat = seatInfo.isMulti ? seatInfo.seat : null;
              
              ws.username = username;
              ws._cachedUsername = username;
              ws.idtarget = username;
              ws.room = room;
              ws.roomname = room;
              ws._cachedRoom = room;
              ws._isMulti = isMulti;
              ws._multiRoom = multiRoom;
              ws._multiSeat = multiSeat;
              ws._closing = false;
              
              ws.serializeAttachment({
                username: username,
                room: room,
                seat: seat,
                isMulti: isMulti,
                multiRoom: multiRoom,
                multiSeat: multiSeat,
                seatInfo: seatInfo,
                muteStates: muteStates
              });
              
              const roomClients = this.roomClients.get(room);
              if (roomClients && !roomClients.has(ws)) {
                roomClients.add(ws);
              }
              
              continue;
            }
          }
          
          if (!username) {
            try {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify(["sessionExpired", "Silakan reconnect"]));
                ws.close(1000, "Session expired");
              }
            } catch(e) {}
            continue;
          }
          
        } catch(e) {}
      }
      
    } catch(e) {}
  }

  // ============================================================
  // SEND CURRENT STATE TO WS
  // ============================================================
  
  async _sendCurrentStateToWS(ws) {
    try {
      if (!ws || ws.readyState !== 1) return;
      
      this.safeSend(ws, ["currentNumber", this.currentNumber]);
      
      for (const room of ROOMS) {
        const muted = await this._getMuteState(room);
        this.safeSend(ws, ["muteTypeResponse", muted, room]);
      }
      
      const username = ws._cachedUsername || ws.username;
      if (username) {
        const userSeatData = await this._getUserSeatData();
        const seatInfo = userSeatData[username];
        
        if (seatInfo && seatInfo.room) {
          await this.sendAllStateTo(ws, seatInfo.room, true);
          this.safeSend(ws, ["numberKursiSaya", seatInfo.seat]);
          this.safeSend(ws, ["rooMasuk", seatInfo.seat, seatInfo.room]);
          const count = await this._getRoomCount(seatInfo.room);
          this.safeSend(ws, ["roomUserCount", seatInfo.room, count]);
        }
      }
      
    } catch(e) {}
  }

  // ============================================================
  // TRY RESTORE WS FROM STORAGE
  // ============================================================
  
  async _tryRestoreWSFromStorage(ws) {
    try {
      if (!ws) return false;
      
      let username = ws._cachedUsername || ws.username || ws.idtarget;
      
      if (!username) {
        try {
          const attachment = ws.deserializeAttachment();
          if (attachment && attachment.username) {
            username = attachment.username;
          }
        } catch(e) {}
      }
      
      if (!username) {
        return false;
      }
      
      if (username) {
        const userSeatData = await this._getUserSeatData();
        const seatInfo = userSeatData[username];
        
        if (seatInfo) {
          ws.username = username;
          ws._cachedUsername = username;
          ws.idtarget = username;
          ws.room = seatInfo.room;
          ws.roomname = seatInfo.room;
          ws._cachedRoom = seatInfo.room;
          ws._isMulti = seatInfo.isMulti || false;
          ws._multiRoom = seatInfo.isMulti ? seatInfo.room : null;
          ws._multiSeat = seatInfo.isMulti ? seatInfo.seat : null;
          ws._closing = false;
          
          const muteStates = {};
          for (const room of ROOMS) {
            muteStates[room] = await this._getMuteState(room);
          }
          
          ws.serializeAttachment({
            username: username,
            room: seatInfo.room,
            seat: seatInfo.seat,
            isMulti: seatInfo.isMulti || false,
            multiRoom: seatInfo.isMulti ? seatInfo.room : null,
            multiSeat: seatInfo.isMulti ? seatInfo.seat : null,
            seatInfo: seatInfo,
            muteStates: muteStates
          });
          
          const roomClients = this.roomClients.get(seatInfo.room);
          if (roomClients && !roomClients.has(ws)) {
            roomClients.add(ws);
          }
          
          await this._sendCurrentStateToWS(ws);
          
          return true;
        }
      }
      
      return false;
    } catch(e) {
      return false;
    }
  }

  // ============================================================
  // AUTO RESET ON DEPLOY
  // ============================================================
  
  async _autoResetOnDeploy() {
    try {
      const storedVersion = await this.ctx.storage.get("lastDeployVersion");
      
      if (storedVersion !== this._version) {
        await this.ctx.storage.delete("roomsData");
        await this.ctx.storage.delete("userSeatData");
        await this.ctx.storage.delete("currentNumber");
        await this.ctx.storage.delete("lastReset");
        
        this.currentNumber = 1;
        for (const room of ROOMS) {
          this.roomClients.set(room, new Set());
        }
        
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
      }
      
    } catch(e) {}
  }

  // ============================================================
  // INITIALIZE FROM STORAGE
  // ============================================================
  
  async _initFromStorage() {
    try {
      const currentNumber = await this.ctx.storage.get("currentNumber") || 1;
      this.currentNumber = currentNumber;
      
      await this._restoreAllWebSockets();
      this._refreshRoomClients(true);
      
      if (!this.closing && !this.isDestroyed) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        if (!existingAlarm) {
          this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
        }
      }
      
      this._restoreComplete = true;
      
    } catch(e) {
      this._restoreComplete = true;
    }
  }

  // ============================================================
  // WEBSOCKET HELPERS
  // ============================================================
  
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
    let restoredCount = 0;
    
    for (const ws of webSockets) {
      try {
        let room = ws._cachedRoom || ws.room || ws.roomname;
        let username = ws._cachedUsername || ws.username || ws.idtarget;
        
        if (!room || !username) {
          try {
            const attachment = ws.deserializeAttachment();
            if (attachment) {
              if (!room && attachment.room) {
                room = attachment.room;
                ws._cachedRoom = attachment.room;
                ws.room = attachment.room;
                ws.roomname = attachment.room;
              }
              if (!username && attachment.username) {
                username = attachment.username;
                ws._cachedUsername = attachment.username;
                ws.username = attachment.username;
                ws.idtarget = attachment.username;
              }
            }
          } catch(e) {}
        }
        
        if (room && username) {
          const roomClients = this.roomClients.get(room);
          if (roomClients) {
            if (ws.readyState === 1 && !ws._closing) {
              roomClients.add(ws);
              restoredCount++;
            }
          }
        }
      } catch(e) {}
    }
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

  broadcast(room, msg) {
    if (this.closing || this.isDestroyed || !room || !msg) return;
    try { this._broadcastToRoom(room, JSON.stringify(msg)); } catch(e) {}
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

  // ============================================================
  // UPDATE ROOM COUNT
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
  // SEND ALL STATE
  // ============================================================
  
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
      this.safeSend(ws, ["currentNumber", this.currentNumber]);
      
      const muteState = await this._getMuteState(room);
      this.safeSend(ws, ["muteTypeResponse", muteState, room]);
      
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
  // CHECK DUPLICATE USERNAME
  // ============================================================
  
  async _isUsernameInRoom(roomsData, roomName, username, excludeSeat = null) {
    const roomData = roomsData[roomName];
    if (!roomData || !roomData.seats) return false;
    
    for (const [seat, data] of Object.entries(roomData.seats)) {
      if (excludeSeat !== null && parseInt(seat) === excludeSeat) continue;
      if (data && data.namauser === username) {
        return true;
      }
    }
    return false;
  }

  async _findUserInAllRooms(roomsData, username) {
    for (const [roomName, roomData] of Object.entries(roomsData)) {
      if (!roomData || !roomData.seats) continue;
      for (const [seat, data] of Object.entries(roomData.seats)) {
        if (data && data.namauser === username) {
          return { room: roomName, seat: parseInt(seat) };
        }
      }
    }
    return null;
  }

  // ============================================================
  // REMOVE USER FROM ALL ROOMS
  // ============================================================
  
  async _removeUserFromAllRooms(username) {
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return false;
    }
    
    username = username.trim();
    let removed = false;
    let roomsData = await this._getRoomsData();
    let userSeatData = await this._getUserSeatData();
    
    const roomsToUpdate = [];
    
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
        
        const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
        const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
        if (!hasSeats && !hasPoints) {
          delete roomsData[roomName];
        }
        
        removed = true;
        roomsToUpdate.push(roomName);
        this.broadcast(roomName, ["removeKursi", roomName, seatToRemove]);
      }
    }
    
    if (userSeatData[username]) {
      delete userSeatData[username];
      removed = true;
    }
    
    if (removed) {
      await this.ctx.storage.put("roomsData", roomsData);
      await this.ctx.storage.put("userSeatData", userSeatData);
      
      for (const roomName of roomsToUpdate) {
        await this.updateRoomCount(roomName);
      }
    }
    
    return removed;
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
    
    if (await this._isUsernameInRoom(roomsData, roomName, username)) {
      this.safeSend(ws, ["joinError", `Username "${username}" sudah ada di room ini!`]);
      return false;
    }
    
    const existingUser = await this._findUserInAllRooms(roomsData, username);
    if (existingUser) {
      const oldRoom = existingUser.room;
      const oldSeat = existingUser.seat;
      
      const oldRoomData = roomsData[oldRoom];
      if (oldRoomData && oldRoomData.seats) {
        delete oldRoomData.seats[oldSeat];
        if (oldRoomData.points) {
          delete oldRoomData.points[oldSeat];
        }
        
        const hasSeats = oldRoomData.seats && Object.keys(oldRoomData.seats).length > 0;
        const hasPoints = oldRoomData.points && Object.keys(oldRoomData.points).length > 0;
        if (!hasSeats && !hasPoints) {
          delete roomsData[oldRoom];
        }
      }
      
      if (userSeatData[username]) {
        delete userSeatData[username];
      }
      
      this.broadcast(oldRoom, ["removeKursi", oldRoom, oldSeat]);
      
      for (const [room, clients] of this.roomClients) {
        if (clients.has(ws)) {
          clients.delete(ws);
        }
      }
      
      await this.ctx.storage.put("roomsData", roomsData);
      await this.ctx.storage.put("userSeatData", userSeatData);
    }
    
    roomsData = await this._getRoomsData();
    userSeatData = await this._getUserSeatData();
    
    if (await this._isUsernameInRoom(roomsData, roomName, username)) {
      this.safeSend(ws, ["joinError", `Username "${username}" sudah ada di room ini!`]);
      return false;
    }
    
    let newRoomData = roomsData[roomName];
    if (!newRoomData) {
      const muted = await this._getMuteState(roomName);
      newRoomData = { seats: {}, points: {}, muted: muted, number: 1 };
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
    
    const seatInfo = userSeatData[username];
    const isMulti = seatInfo ? (seatInfo.isMulti || false) : false;
    
    newRoomData.seats[newSeat] = {};
    
    userSeatData[username] = {
      room: roomName,
      seat: newSeat,
      isMulti: isMulti,
      multiRoom: isMulti ? roomName : null,
      multiSeat: isMulti ? newSeat : null
    };
    
    await this.ctx.storage.put("roomsData", roomsData);
    await this.ctx.storage.put("userSeatData", userSeatData);
    await this.ctx.storage.put("currentNumber", this.currentNumber);
    
    const muteStates = {};
    for (const room of ROOMS) {
      muteStates[room] = await this._getMuteState(room);
    }
    
    ws.serializeAttachment({
      username: username,
      room: roomName,
      seat: newSeat,
      isMulti: isMulti,
      multiRoom: isMulti ? roomName : null,
      multiSeat: isMulti ? newSeat : null,
      seatInfo: userSeatData[username],
      muteStates: muteStates
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
    
    const muteState = await this._getMuteState(roomName);
    this.safeSend(ws, ["muteTypeResponse", muteState, roomName]);
    this.safeSend(ws, ["currentNumber", this.currentNumber]);
    
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
    
    const username = data.namauser;
    
    if (username) {
      for (const [s, seatData] of Object.entries(roomData.seats)) {
        if (parseInt(s) !== seat && seatData && seatData.namauser === username) {
          return false;
        }
      }
    }
    
    roomData.seats[seat] = {
      noimageUrl: data.noimageUrl || "",
      namauser: data.namauser || "",
      color: data.color || "",
      itembawah: data.itembawah || 0,
      itematas: data.itematas || 0,
      vip: data.vip || 0,
      viptanda: data.viptanda || 0
    };
    
    await this.ctx.storage.put("roomsData", roomsData);
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
    
    await this.ctx.storage.put("roomsData", roomsData);
    return true;
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
        await this.ctx.storage.put("roomsData", roomsData);
      }
      await this.ctx.storage.put("currentNumber", newNumber);
      
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
  // WEBSOCKET MESSAGE
  // ============================================================
  
  async webSocketMessage(ws, message) {
    if (!ws || ws._closing || this.closing || this.isDestroyed) return;
    
    try {
      let attachment = null;
      try {
        attachment = ws.deserializeAttachment();
      } catch(e) {}
      
      if (!attachment || !attachment.username) {
        const restored = await this._tryRestoreWSFromStorage(ws);
        if (restored) {
          try {
            attachment = ws.deserializeAttachment();
          } catch(e) {}
        }
      }
      
      if (attachment) {
        if (attachment.username && !ws._cachedUsername) {
          ws.username = attachment.username;
          ws._cachedUsername = attachment.username;
          ws.idtarget = attachment.username;
        }
        
        if (attachment.room && !ws._cachedRoom) {
          ws.room = attachment.room;
          ws.roomname = attachment.room;
          ws._cachedRoom = attachment.room;
        }
        
        if (attachment.isMulti !== undefined) {
          ws._isMulti = attachment.isMulti;
          ws._multiRoom = attachment.multiRoom || null;
          ws._multiSeat = attachment.multiSeat || null;
        }
        
        if (ws._cachedRoom && ws._cachedUsername) {
          const roomClients = this.roomClients.get(ws._cachedRoom);
          if (roomClients && !roomClients.has(ws)) {
            roomClients.add(ws);
          }
        }
      }
      
      await this.handleMessage(ws, message);
    } catch(e) {}
  }

  // ============================================================
  // WEBSOCKET CLOSE
  // ============================================================
  
  async webSocketClose(ws, code, reason, wasClean) {
    if (!ws) return;
    try {
      let attachment = null;
      try {
        attachment = ws.deserializeAttachment();
      } catch(e) {}
      
      let username = ws._cachedUsername || ws.username;
      let room = ws._cachedRoom || ws.room || ws.roomname;
      
      if (!username && attachment && attachment.username) {
        username = attachment.username;
        ws._cachedUsername = username;
        ws.username = username;
      }
      
      if (!room && attachment && attachment.room) {
        room = attachment.room;
        ws._cachedRoom = room;
        ws.room = room;
        ws.roomname = room;
      }
      
      const userSeatData = await this._getUserSeatData();
      const seatInfo = username ? userSeatData[username] : null;
      
      const isMulti = ws._isMulti || (seatInfo ? seatInfo.isMulti : false) || false;
      
      if (isMulti) {
        for (const [roomKey, clients] of this.roomClients) {
          if (clients.has(ws)) {
            clients.delete(ws);
          }
        }
        
        if (username) {
          const muteStates = {};
          for (const room of ROOMS) {
            muteStates[room] = await this._getMuteState(room);
          }
          
          try {
            ws.serializeAttachment({
              username: username,
              room: room || seatInfo?.room || null,
              seat: seatInfo?.seat || null,
              isMulti: true,
              multiRoom: room || seatInfo?.room || null,
              multiSeat: seatInfo?.seat || null,
              seatInfo: seatInfo || null,
              muteStates: muteStates
            });
          } catch(e) {}
        }
        
        this._refreshRoomClients(true);
        return;
      }
      
      if (username) {
        await this._removeUserFromAllRooms(username);
      }
      
      for (const [roomKey, clients] of this.roomClients) {
        if (clients.has(ws)) {
          clients.delete(ws);
        }
      }
      
      try {
        ws.serializeAttachment({});
      } catch(e) {}
      
      this._refreshRoomClients(true);
    } catch(e) {}
  }

  // ============================================================
  // WEBSOCKET ERROR
  // ============================================================
  
  async webSocketError(ws, error) {
    if (!ws) return;
    try {
      let attachment = null;
      try {
        attachment = ws.deserializeAttachment();
      } catch(e) {}
      
      let username = ws._cachedUsername || ws.username;
      let room = ws._cachedRoom || ws.room || ws.roomname;
      
      if (!username && attachment && attachment.username) {
        username = attachment.username;
        ws._cachedUsername = username;
        ws.username = username;
      }
      
      if (!room && attachment && attachment.room) {
        room = attachment.room;
        ws._cachedRoom = room;
        ws.room = room;
        ws.roomname = room;
      }
      
      const userSeatData = await this._getUserSeatData();
      const seatInfo = username ? userSeatData[username] : null;
      
      const isMulti = ws._isMulti || (seatInfo ? seatInfo.isMulti : false) || false;
      
      if (isMulti) {
        for (const [roomKey, clients] of this.roomClients) {
          if (clients.has(ws)) {
            clients.delete(ws);
          }
        }
        this._refreshRoomClients(true);
        return;
      }
      
      if (username) {
        await this._removeUserFromAllRooms(username);
      }
      
      for (const [roomKey, clients] of this.roomClients) {
        if (clients.has(ws)) {
          clients.delete(ws);
        }
      }
      
      try {
        ws.serializeAttachment({});
      } catch(e) {}
      
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
    
    const muteStates = {};
    for (const room of ROOMS) {
      muteStates[room] = await this._getMuteState(room);
    }
    
    ws.serializeAttachment({ 
      username: username,
      muteStates: muteStates
    });
    
    if (isNewUser) { 
      this.safeSend(ws, ["joinroomawal"]); 
      this.safeSend(ws, ["currentNumber", this.currentNumber]);
    } else { 
      this.safeSend(ws, ["needJoinRoom"]); 
      this.safeSend(ws, ["currentNumber", this.currentNumber]);
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

  // ============================================================
  // HANDLE EVENT INTERNAL
  // ============================================================
  
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
              
              const muteStates = {};
              for (const room of ROOMS) {
                muteStates[room] = await this._getMuteState(room);
              }
              
              ws.serializeAttachment({
                username: username,
                room: seatInfo.room,
                seat: seatInfo.seat,
                isMulti: true,
                multiRoom: seatInfo.room,
                multiSeat: seatInfo.seat,
                seatInfo: seatInfo,
                muteStates: muteStates
              });
              
              const roomClients = this.roomClients.get(seatInfo.room);
              if (roomClients) {
                roomClients.add(ws);
              }
              
              this.safeSend(ws, ["currentNumber", this.currentNumber]);
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
          
          let roomsData = await this._getRoomsData();
          if (await this._isUsernameInRoom(roomsData, multiRoomname, multiUsername)) {
            this.safeSend(ws, ["multiJoinError", `Username "${multiUsername}" sudah ada di room ini!`]);
            break;
          }
          
          await this._removeUserFromAllRooms(multiUsername);
          
          roomsData = await this._getRoomsData();
          let roomData = roomsData[multiRoomname];
          if (!roomData) {
            const muted = await this._getMuteState(multiRoomname);
            roomData = { seats: {}, points: {}, muted: muted, number: 1 };
            roomsData[multiRoomname] = roomData;
            await this.ctx.storage.put("roomsData", roomsData);
          }
          
          if (await this._isUsernameInRoom(roomsData, multiRoomname, multiUsername)) {
            this.safeSend(ws, ["multiJoinError", `Username "${multiUsername}" sudah ada di room ini!`]);
            break;
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
          
          await this.ctx.storage.put("roomsData", roomsData);
          
          let userSeatData = await this._getUserSeatData();
          const seatInfo = { 
            room: multiRoomname, 
            seat: seat, 
            isMulti: true,
            multiRoom: multiRoomname,
            multiSeat: seat
          };
          userSeatData[multiUsername] = seatInfo;
          await this.ctx.storage.put("userSeatData", userSeatData);
          
          const muteStates = {};
          for (const room of ROOMS) {
            muteStates[room] = await this._getMuteState(room);
          }
          
          ws.serializeAttachment({
            username: multiUsername,
            room: multiRoomname,
            seat: seat,
            isMulti: true,
            multiRoom: multiRoomname,
            multiSeat: seat,
            seatInfo: seatInfo,
            muteStates: muteStates
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
                  muteStates: muteStates
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
          this.safeSend(ws, ["currentNumber", this.currentNumber]);
          
          const count = Object.keys(roomData.seats).length;
          this.broadcast(multiRoomname, ["roomUserCount", multiRoomname, count]);
          
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
          await this.ctx.storage.put("userSeatData", userSeatData);
          
          const muteStates = {};
          for (const room of ROOMS) {
            muteStates[room] = await this._getMuteState(room);
          }
          
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
                  muteStates: muteStates
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
                this.safeSend(wsKey, ["currentNumber", this.currentNumber]);
                
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
                
                const hasSeats = roomData.seats && Object.keys(roomData.seats).length > 0;
                const hasPoints = roomData.points && Object.keys(roomData.points).length > 0;
                if (!hasSeats && !hasPoints) {
                  delete roomsData[roomName];
                }
                
                this.broadcast(roomName, ["removeKursi", roomName, seatToRemove]);
                await this.updateRoomCount(roomName);
              }
            }
            
            if (userSeatData[targetUsername]) {
              delete userSeatData[targetUsername];
            }
            
            await this.ctx.storage.put("roomsData", roomsData);
            await this.ctx.storage.put("userSeatData", userSeatData);
            
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
          } else {
            this.safeSend(ws, ["updateKursiError", "Username sudah digunakan di kursi lain!"]);
          }
          break;
        }
        
        case "chat": {
          const [chatRoom, chatNoimg, chatUser, chatMsg, chatColor, chatTextColor] = args;
          if (!chatMsg || !ROOMS_SET.has(chatRoom)) break;
          
          const isMuted = await this._getMuteState(chatRoom);
          if (isMuted) {
            this.safeSend(ws, ["chatError", "Room sedang di-mute, tidak bisa mengirim pesan"]);
            break;
          }
          
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
          const counts = await this._getAllRoomCounts();
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
          
          await this._setMuteState(muteRoom, !!muteVal);
          
          this.broadcast(muteRoom, ["muteStatusChanged", !!muteVal, muteRoom]);
          this.safeSend(ws, ["muteTypeSet", !!muteVal, true, muteRoom]);
          
          const webSockets = this._getActiveWebSockets();
          const muteStates = {};
          for (const room of ROOMS) {
            muteStates[room] = await this._getMuteState(room);
          }
          
          for (const wsKey of webSockets) {
            try {
              const attachment = wsKey.deserializeAttachment() || {};
              attachment.muteStates = muteStates;
              wsKey.serializeAttachment(attachment);
            } catch(e) {}
          }
          
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
            const muteState = await this._getMuteState(getMuteRoom);
            this.safeSend(ws, ["muteTypeResponse", muteState, getMuteRoom]);
          }
          break;
        }
        
        case "clearCacheTotal": {
          await this.ctx.storage.delete("roomsData");
          await this.ctx.storage.delete("userSeatData");
          await this.ctx.storage.delete("currentNumber");
          await this.ctx.storage.delete("lastReset");
          await this.ctx.storage.delete("lastDeployVersion");
          await this.ctx.storage.delete("lastDeployTime");
          
          this.currentNumber = 1;
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
    
    // ✅ Update number
    await this._updateNumber();
    
    // ✅ Cleanup storage dari data stale
    await this._cleanupStorage();
    
    // ✅ Set alarm berikutnya
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
          let uname = ws._cachedUsername || ws.username;
          if (!uname) {
            try {
              const attachment = ws.deserializeAttachment();
              if (attachment && attachment.username) {
                uname = attachment.username;
              }
            } catch(e) {}
          }
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
        await this.ctx.storage.put("roomsData", roomsData);
        await this.ctx.storage.put("userSeatData", userSeatData);
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
      await this.ctx.storage.delete("lastReset");
      await this.ctx.storage.delete("lastDeployVersion");
      await this.ctx.storage.delete("lastDeployTime");
      
      this.currentNumber = 1;
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
        await this.ctx.storage.delete("lastReset");
        await this.ctx.storage.delete("lastDeployVersion");
        await this.ctx.storage.delete("lastDeployTime");
        
        this.currentNumber = 1;
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
        const onlineUsers = await this._getOnlineUsers();
        
        const muteStates = {};
        for (const room of ROOMS) {
          muteStates[room] = await this._getMuteState(room);
        }
        
        const status = {
          activeConnections: webSockets.length,
          rooms: await this._getAllRoomCounts(),
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
          userSeatDataKeys: Object.keys(userSeatData),
          muteStates: muteStates,
          restoreComplete: this._restoreComplete
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
      
      const muteStates = {};
      for (const room of ROOMS) {
        muteStates[room] = await this._getMuteState(room);
      }
      
      server.serializeAttachment({
        muteStates: muteStates
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
        try { ws.send(JSON.stringify(["serverShutdown", "Server shutting down"])); } catch(e) {}
        try { ws.close(1000, "Shutdown"); } catch(e) {}
      }
    }
    
    this.roomClients.clear();
    
    try {
      await this.ctx.storage.deleteAlarm();
    } catch(e) {}
  }
}

export default ChatServer;
