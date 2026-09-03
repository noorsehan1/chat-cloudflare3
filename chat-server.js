// ==================== CHAT-SERVER-STORAGE-ONLY-OPTIMIZED.js ====================
// VERSION: 5.0.0 - ANTI CRASH AFTER HIBERNATE

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
    this._isRestoring = false;
    
    this._version = SERVER_VERSION;
    this._deployInfo = DEPLOY_VERSION;
    this._deployTime = DEPLOY_VERSION.deployDate;
    
    this.roomClients = new Map();
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    this.currentNumber = 1;
    this._isNumberUpdating = false;
    
    // ✅ Safe init dengan error handling
    this._initFromStorage().then(() => {
      this._restoreComplete = true;
      this._restoreAfterHibernate();
    }).catch(e => {
      console.error('Init error:', e);
      this._restoreComplete = true;
    });
    
    this._autoResetOnDeploy().then(() => {});
  }

  // ============================================================
  // STORAGE HELPERS
  // ============================================================
  
  async _getRoomsData() {
    try {
      return await this.ctx.storage.get("roomsData") || {};
    } catch(e) {
      return {};
    }
  }

  async _getUserSeatData() {
    try {
      return await this.ctx.storage.get("userSeatData") || {};
    } catch(e) {
      return {};
    }
  }

  async _getCurrentNumber() {
    try {
      return await this.ctx.storage.get("currentNumber") || 1;
    } catch(e) {
      return 1;
    }
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
      return {
        roomsData: {},
        userSeatData: {},
        currentNumber: this.currentNumber,
      };
    }
  }

  // ============================================================
  // GET ROOM COUNT
  // ============================================================
  
  async _getRoomCount(room) {
    try {
      const roomsData = await this._getRoomsData();
      const roomData = roomsData[room];
      return roomData?.seats ? Object.keys(roomData.seats).length : 0;
    } catch(e) {
      return 0;
    }
  }

  async _getAllRoomCounts() {
    try {
      const roomsData = await this._getRoomsData();
      const counts = {};
      for (const room of ROOMS) {
        const roomData = roomsData[room];
        counts[room] = roomData?.seats ? Object.keys(roomData.seats).length : 0;
      }
      return counts;
    } catch(e) {
      const counts = {};
      for (const room of ROOMS) {
        counts[room] = 0;
      }
      return counts;
    }
  }

  async _getOnlineUsers() {
    try {
      const userSeatData = await this._getUserSeatData();
      return Object.keys(userSeatData);
    } catch(e) {
      return [];
    }
  }

  // ============================================================
  // ✅ ANTI CRASH: RESTORE AFTER HIBERNATE
  // ============================================================
  
  async _restoreAfterHibernate() {
    // ✅ Cegah double restore
    if (this._isRestoring) return;
    this._isRestoring = true;
    
    try {
      // ✅ Safe get current number
      this.currentNumber = await this._getCurrentNumber();
      
      // ✅ Safe restore semua WebSocket
      await this._safeRestoreAllWebSockets();
      
      // ✅ Safe rebuild room clients
      this._safeRefreshRoomClients();
      
      // ✅ Safe kirim notifikasi
      try {
        const restoreMessage = JSON.stringify(["serverRestored", {
          timestamp: Date.now()
        }]);
        
        const webSockets = this._safeGetActiveWebSockets();
        for (const ws of webSockets) {
          try {
            if (ws && ws.readyState === 1) {
              ws.send(restoreMessage);
              await this._safeSendCurrentStateToWS(ws);
            }
          } catch(e) {
            // ✅ Ignore error per WS
          }
        }
      } catch(e) {}
      
    } catch(e) {
      // ✅ JANGAN CRASH! Tetap jalan
      console.error('Restore after hibernate error:', e);
    } finally {
      this._isRestoring = false;
    }
  }

  // ============================================================
  // ✅ ANTI CRASH: SAFE RESTORE ALL WEBSOCKETS
  // ============================================================
  
  async _safeRestoreAllWebSockets() {
    try {
      const webSockets = this._safeGetActiveWebSockets();
      if (!webSockets || webSockets.length === 0) return;
      
      const userSeatData = await this._getUserSeatData();
      const muteStates = {};
      
      for (const room of ROOMS) {
        try {
          muteStates[room] = await this._getMuteState(room);
        } catch(e) {
          muteStates[room] = false;
        }
      }
      
      for (const ws of webSockets) {
        try {
          if (!ws) continue;
          if (ws.readyState !== 1) continue;
          if (ws._closing) continue;
          
          // ✅ Safe ambil attachment
          let attachment = null;
          try {
            attachment = ws.deserializeAttachment();
          } catch(e) {
            // ✅ Attachment corrupt, buat baru
            attachment = null;
          }
          
          // ✅ Safe cari username
          let username = null;
          try {
            if (attachment && attachment.username) {
              username = attachment.username;
            } else if (ws._cachedUsername) {
              username = ws._cachedUsername;
            } else if (ws.username) {
              username = ws.username;
            }
          } catch(e) {
            username = null;
          }
          
          // ✅ Jika tidak ada username, skip (jangan matikan)
          if (!username) continue;
          
          // ✅ Cari di storage
          let seatInfo = null;
          try {
            seatInfo = userSeatData[username];
          } catch(e) {
            seatInfo = null;
          }
          
          if (seatInfo) {
            try {
              // ✅ Safe restore properties
              const room = seatInfo.room || null;
              const seat = seatInfo.seat || null;
              const isMulti = seatInfo.isMulti || false;
              const multiRoom = seatInfo.isMulti ? seatInfo.room : null;
              const multiSeat = seatInfo.isMulti ? seatInfo.seat : null;
              
              if (room) {
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
                
                // ✅ Safe update attachment
                try {
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
                } catch(e) {}
                
                // ✅ Safe tambahkan ke room clients
                try {
                  const roomClients = this.roomClients.get(room);
                  if (roomClients && !roomClients.has(ws)) {
                    roomClients.add(ws);
                  }
                } catch(e) {}
              }
            } catch(e) {
              // ✅ Error per WS, lanjut ke WS berikutnya
              continue;
            }
          }
        } catch(e) {
          // ✅ Error per WS, lanjut ke WS berikutnya
          continue;
        }
      }
    } catch(e) {
      // ✅ Error total, jangan crash
      console.error('Restore all WebSockets error:', e);
    }
  }

  // ============================================================
  // ✅ ANTI CRASH: SAFE SEND CURRENT STATE
  // ============================================================
  
  async _safeSendCurrentStateToWS(ws) {
    try {
      if (!ws) return;
      if (ws.readyState !== 1) return;
      if (ws._closing) return;
      
      // ✅ Safe send current number
      try {
        this.safeSend(ws, ["currentNumber", this.currentNumber]);
      } catch(e) {}
      
      // ✅ Safe send mute states
      for (const room of ROOMS) {
        try {
          const muted = await this._getMuteState(room);
          this.safeSend(ws, ["muteTypeResponse", muted, room]);
        } catch(e) {}
      }
      
      // ✅ Safe send room state
      let username = null;
      try {
        username = ws._cachedUsername || ws.username;
      } catch(e) {
        username = null;
      }
      
      if (username) {
        try {
          const userSeatData = await this._getUserSeatData();
          const seatInfo = userSeatData[username];
          
          if (seatInfo && seatInfo.room) {
            await this.sendAllStateTo(ws, seatInfo.room, true);
            this.safeSend(ws, ["numberKursiSaya", seatInfo.seat]);
            this.safeSend(ws, ["rooMasuk", seatInfo.seat, seatInfo.room]);
            const count = await this._getRoomCount(seatInfo.room);
            this.safeSend(ws, ["roomUserCount", seatInfo.room, count]);
          }
        } catch(e) {}
      }
    } catch(e) {
      // ✅ Error, jangan crash
    }
  }

  // ============================================================
  // ✅ ANTI CRASH: SAFE TRY RESTORE WS FROM STORAGE
  // ============================================================
  
  async _safeTryRestoreWSFromStorage(ws) {
    try {
      if (!ws) return false;
      if (ws.readyState !== 1) return false;
      
      // ✅ Cegah infinite loop dengan retry counter
      if (!ws._restoreRetry) ws._restoreRetry = 0;
      if (ws._restoreRetry > 3) {
        ws._restoreRetry = 0;
        return false;
      }
      ws._restoreRetry++;
      
      let username = null;
      try {
        username = ws._cachedUsername || ws.username || ws.idtarget;
      } catch(e) {
        username = null;
      }
      
      if (!username) {
        try {
          const attachment = ws.deserializeAttachment();
          if (attachment && attachment.username) {
            username = attachment.username;
          }
        } catch(e) {
          username = null;
        }
      }
      
      if (!username) return false;
      
      const userSeatData = await this._getUserSeatData();
      const seatInfo = userSeatData[username];
      
      if (!seatInfo) return false;
      
      // ✅ Safe restore
      ws.username = username;
      ws._cachedUsername = username;
      ws.idtarget = username;
      ws.room = seatInfo.room || null;
      ws.roomname = seatInfo.room || null;
      ws._cachedRoom = seatInfo.room || null;
      ws._isMulti = seatInfo.isMulti || false;
      ws._multiRoom = seatInfo.isMulti ? seatInfo.room : null;
      ws._multiSeat = seatInfo.isMulti ? seatInfo.seat : null;
      ws._closing = false;
      
      const muteStates = {};
      for (const room of ROOMS) {
        try {
          muteStates[room] = await this._getMuteState(room);
        } catch(e) {
          muteStates[room] = false;
        }
      }
      
      try {
        ws.serializeAttachment({
          username: username,
          room: seatInfo.room || null,
          seat: seatInfo.seat || null,
          isMulti: seatInfo.isMulti || false,
          multiRoom: seatInfo.isMulti ? seatInfo.room : null,
          multiSeat: seatInfo.isMulti ? seatInfo.seat : null,
          seatInfo: seatInfo,
          muteStates: muteStates
        });
      } catch(e) {}
      
      try {
        const roomClients = this.roomClients.get(seatInfo.room);
        if (roomClients && !roomClients.has(ws)) {
          roomClients.add(ws);
        }
      } catch(e) {}
      
      await this._safeSendCurrentStateToWS(ws);
      
      ws._restoreRetry = 0;
      return true;
      
    } catch(e) {
      return false;
    }
  }

  // ============================================================
  // ✅ ANTI CRASH: SAFE GET ACTIVE WEBSOCKETS
  // ============================================================
  
  _safeGetActiveWebSockets() {
    try {
      return this.ctx.getWebSockets() || [];
    } catch(e) {
      return [];
    }
  }

  // ============================================================
  // ✅ ANTI CRASH: SAFE REFRESH ROOM CLIENTS
  // ============================================================
  
  _safeRefreshRoomClients() {
    try {
      for (const room of ROOMS) {
        try {
          this.roomClients.set(room, new Set());
        } catch(e) {}
      }
      
      const webSockets = this._safeGetActiveWebSockets();
      if (!webSockets || webSockets.length === 0) return;
      
      let restoredCount = 0;
      
      for (const ws of webSockets) {
        try {
          if (!ws) continue;
          if (ws.readyState !== 1) continue;
          if (ws._closing) continue;
          
          let room = null;
          let username = null;
          
          try {
            room = ws._cachedRoom || ws.room || ws.roomname;
            username = ws._cachedUsername || ws.username || ws.idtarget;
          } catch(e) {}
          
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
            try {
              const roomClients = this.roomClients.get(room);
              if (roomClients && !roomClients.has(ws)) {
                roomClients.add(ws);
                restoredCount++;
              }
            } catch(e) {}
          }
        } catch(e) {}
      }
    } catch(e) {}
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
        const webSockets = this._safeGetActiveWebSockets();
        for (const ws of webSockets) {
          try {
            if (ws.readyState === 1) {
              ws.send(resetMessage);
              ws.close(1000, "Server reset - deploy baru");
            }
          } catch(e) {}
        }
        
        this._safeRefreshRoomClients();
      }
      
    } catch(e) {}
  }

  // ============================================================
  // INITIALIZE FROM STORAGE
  // ============================================================
  
  async _initFromStorage() {
    try {
      const currentNumber = await this._getCurrentNumber();
      this.currentNumber = currentNumber;
      
      await this._safeRestoreAllWebSockets();
      this._safeRefreshRoomClients();
      
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
    return this._safeGetActiveWebSockets();
  }

  _refreshRoomClients(force = false) {
    this._safeRefreshRoomClients();
  }

  safeSend(ws, msg) {
    try {
      if (!ws) return false;
      if (ws.readyState !== 1) return false;
      if (ws._closing) return false;
      if (this.closing || this.isDestroyed) return false;
      
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
    
    this._safeRefreshRoomClients();
    
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
    try {
      if (!ws || !ws.username) return;
      if (ws.readyState !== 1 || ws._closing) return;
    } catch(e) { return; }
    
    try {
      const roomsData = await this._getRoomsData();
      const roomData = roomsData[room];
      if (!roomData) return;
      
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
    try {
      const roomData = roomsData[roomName];
      if (!roomData || !roomData.seats) return false;
      
      for (const [seat, data] of Object.entries(roomData.seats)) {
        if (excludeSeat !== null && parseInt(seat) === excludeSeat) continue;
        if (data && data.namauser === username) {
          return true;
        }
      }
      return false;
    } catch(e) {
      return false;
    }
  }

  async _findUserInAllRooms(roomsData, username) {
    try {
      for (const [roomName, roomData] of Object.entries(roomsData)) {
        if (!roomData || !roomData.seats) continue;
        for (const [seat, data] of Object.entries(roomData.seats)) {
          if (data && data.namauser === username) {
            return { room: roomName, seat: parseInt(seat) };
          }
        }
      }
      return null;
    } catch(e) {
      return null;
    }
  }

  // ============================================================
  // REMOVE USER FROM ALL ROOMS
  // ============================================================
  
  async _removeUserFromAllRooms(username) {
    try {
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
    } catch(e) {
      return false;
    }
  }

  // ============================================================
  // HANDLE JOIN (dengan safe)
  // ============================================================
  
  async _handleJoin(ws, roomName) {
    try {
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
      
      try {
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
      } catch(e) {}
      
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
      
      this._safeRefreshRoomClients();
      
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
    } catch(e) {
      return false;
    }
  }

  // ============================================================
  // UPDATE KURSI
  // ============================================================
  
  async _updateKursi(roomName, seat, data) {
    try {
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
    } catch(e) {
      return false;
    }
  }

  // ============================================================
  // UPDATE POINT
  // ============================================================
  
  async _updatePoint(roomName, seat, x, y, fast) {
    try {
      const roomsData = await this._getRoomsData();
      const roomData = roomsData[roomName];
      if (!roomData || !roomData.seats || !roomData.seats[seat]) return false;
      
      if (!roomData.points) roomData.points = {};
      roomData.points[seat] = { x: x || 0, y: y || 0, fast: !!fast };
      
      await this.ctx.storage.put("roomsData", roomsData);
      return true;
    } catch(e) {
      return false;
    }
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
      
      this._safeRefreshRoomClients();
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
  // ✅ ANTI CRASH: WEBSOCKET MESSAGE
  // ============================================================
  
  async webSocketMessage(ws, message) {
    try {
      if (!ws) return;
      if (ws._closing) return;
      if (this.closing || this.isDestroyed) return;
      if (ws.readyState !== 1) return;
      
      // ✅ Safe ambil attachment
      let attachment = null;
      try {
        attachment = ws.deserializeAttachment();
      } catch(e) {
        attachment = null;
      }
      
      // ✅ Safe restore jika perlu
      if (!attachment || !attachment.username) {
        const restored = await this._safeTryRestoreWSFromStorage(ws);
        if (restored) {
          try {
            attachment = ws.deserializeAttachment();
          } catch(e) {
            attachment = null;
          }
        }
      }
      
      // ✅ Safe restore properties
      if (attachment) {
        try {
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
        } catch(e) {}
      }
      
      await this.handleMessage(ws, message);
    } catch(e) {
      // ✅ JANGAN CRASH!
    }
  }

  // ============================================================
  // WEBSOCKET CLOSE
  // ============================================================
  
  async webSocketClose(ws, code, reason, wasClean) {
    try {
      if (!ws) return;
      
      let attachment = null;
      try {
        attachment = ws.deserializeAttachment();
      } catch(e) {
        attachment = null;
      }
      
      let username = null;
      let room = null;
      
      try {
        username = ws._cachedUsername || ws.username;
        room = ws._cachedRoom || ws.room || ws.roomname;
      } catch(e) {}
      
      if (!username && attachment && attachment.username) {
        username = attachment.username;
        try {
          ws._cachedUsername = username;
          ws.username = username;
        } catch(e) {}
      }
      
      if (!room && attachment && attachment.room) {
        room = attachment.room;
        try {
          ws._cachedRoom = room;
          ws.room = room;
          ws.roomname = room;
        } catch(e) {}
      }
      
      // ✅ Safe get userSeatData
      let userSeatData = {};
      try {
        userSeatData = await this._getUserSeatData();
      } catch(e) {}
      
      const seatInfo = username ? userSeatData[username] : null;
      
      const isMulti = (ws._isMulti || (seatInfo ? seatInfo.isMulti : false) || false);
      
      if (isMulti) {
        for (const [roomKey, clients] of this.roomClients) {
          if (clients.has(ws)) {
            try { clients.delete(ws); } catch(e) {}
          }
        }
        
        if (username) {
          try {
            const muteStates = {};
            for (const room of ROOMS) {
              try {
                muteStates[room] = await this._getMuteState(room);
              } catch(e) {
                muteStates[room] = false;
              }
            }
            
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
        
        this._safeRefreshRoomClients();
        return;
      }
      
      if (username) {
        await this._removeUserFromAllRooms(username);
      }
      
      for (const [roomKey, clients] of this.roomClients) {
        if (clients.has(ws)) {
          try { clients.delete(ws); } catch(e) {}
        }
      }
      
      try {
        ws.serializeAttachment({});
      } catch(e) {}
      
      this._safeRefreshRoomClients();
    } catch(e) {}
  }

  // ============================================================
  // WEBSOCKET ERROR
  // ============================================================
  
  async webSocketError(ws, error) {
    try {
      if (!ws) return;
      
      let attachment = null;
      try {
        attachment = ws.deserializeAttachment();
      } catch(e) {
        attachment = null;
      }
      
      let username = null;
      let room = null;
      
      try {
        username = ws._cachedUsername || ws.username;
        room = ws._cachedRoom || ws.room || ws.roomname;
      } catch(e) {}
      
      if (!username && attachment && attachment.username) {
        username = attachment.username;
        try {
          ws._cachedUsername = username;
          ws.username = username;
        } catch(e) {}
      }
      
      if (!room && attachment && attachment.room) {
        room = attachment.room;
        try {
          ws._cachedRoom = room;
          ws.room = room;
          ws.roomname = room;
        } catch(e) {}
      }
      
      let userSeatData = {};
      try {
        userSeatData = await this._getUserSeatData();
      } catch(e) {}
      
      const seatInfo = username ? userSeatData[username] : null;
      
      const isMulti = (ws._isMulti || (seatInfo ? seatInfo.isMulti : false) || false);
      
      if (isMulti) {
        for (const [roomKey, clients] of this.roomClients) {
          if (clients.has(ws)) {
            try { clients.delete(ws); } catch(e) {}
          }
        }
        this._safeRefreshRoomClients();
        return;
      }
      
      if (username) {
        await this._removeUserFromAllRooms(username);
      }
      
      for (const [roomKey, clients] of this.roomClients) {
        if (clients.has(ws)) {
          try { clients.delete(ws); } catch(e) {}
        }
      }
      
      try {
        ws.serializeAttachment({});
      } catch(e) {}
      
      this._safeRefreshRoomClients();
    } catch(e) {}
  }

  // ============================================================
  // HANDLE SET ID
  // ============================================================
  
  async _handleSetId(ws, username, isNewUser) {
    try {
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
        try {
          muteStates[room] = await this._getMuteState(room);
        } catch(e) {
          muteStates[room] = false;
        }
      }
      
      try {
        ws.serializeAttachment({ 
          username: username,
          muteStates: muteStates
        });
      } catch(e) {}
      
      if (isNewUser) { 
        this.safeSend(ws, ["joinroomawal"]); 
        this.safeSend(ws, ["currentNumber", this.currentNumber]);
      } else { 
        this.safeSend(ws, ["needJoinRoom"]); 
        this.safeSend(ws, ["currentNumber", this.currentNumber]);
      }
    } catch(e) {}
  }

  // ============================================================
  // HANDLE MESSAGE
  // ============================================================
  
  async handleMessage(ws, raw) {
    try {
      if (!ws) return;
      if (ws.readyState !== 1 || ws._closing || this.closing || this.isDestroyed) {
        return;
      }
      
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
  // HANDLE EVENT INTERNAL - HANYA YANG PENTING
  // ============================================================
  
  async _handleEventInternal(ws, data) {
    try {
      if (!ws || !data || !data[0]) return;
      const [evt, ...args] = data;
      
      switch(evt) {
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
                try {
                  muteStates[room] = await this._getMuteState(room);
                } catch(e) {
                  muteStates[room] = false;
                }
              }
              
              try {
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
              } catch(e) {}
              
              const roomClients = this.roomClients.get(seatInfo.room);
              if (roomClients) {
                roomClients.add(ws);
              }
              
              this.safeSend(ws, ["currentNumber", this.currentNumber]);
              this._safeRefreshRoomClients();
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
          
          const webSockets = this._safeGetActiveWebSockets();
          const muteStates = {};
          for (const room of ROOMS) {
            try {
              muteStates[room] = await this._getMuteState(room);
            } catch(e) {
              muteStates[room] = false;
            }
          }
          
          for (const wsKey of webSockets) {
            try {
              if (wsKey && wsKey.readyState === 1) {
                const attachment = wsKey.deserializeAttachment() || {};
                attachment.muteStates = muteStates;
                wsKey.serializeAttachment(attachment);
              }
            } catch(e) {}
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
        
        case "getOnlineUsers": {
          const users = await this._getOnlineUsers();
          this.safeSend(ws, ["allOnlineUsers", users]);
          break;
        }
        
        default:
          break;
      }
    } catch(e) {}
  }

  // ============================================================
  // ALARM
  // ============================================================
  
  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    try {
      await this._updateNumber();
      await this._cleanupStorage();
    } catch(e) {}
    
    if (!this.closing && !this.isDestroyed) {
      try {
        this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      } catch(e) {}
    }
  }

  async _cleanupStorage() {
    try {
      const roomsData = await this._getRoomsData();
      const userSeatData = await this._getUserSeatData();
      
      let changed = false;
      
      const connectedUsers = new Set();
      const webSockets = this._safeGetActiveWebSockets();
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
  // FETCH
  // ============================================================
  
  async fetch(req) {
    try {
      if (this.closing || this.isDestroyed) {
        return new Response("Shutting down", { status: 503 });
      }
      
      const url = new URL(req.url);
      
      if (url.pathname === "/status") {
        const webSockets = this._safeGetActiveWebSockets();
        const roomsData = await this._getRoomsData();
        const userSeatData = await this._getUserSeatData();
        const onlineUsers = await this._getOnlineUsers();
        
        const muteStates = {};
        for (const room of ROOMS) {
          try {
            muteStates[room] = await this._getMuteState(room);
          } catch(e) {
            muteStates[room] = false;
          }
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
      
      const upgrade = req.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        return new Response("Chat Server", { 
          status: 200,
          headers: { "Cache-Control": "no-cache" }
        });
      }
      
      const currentConnections = this._safeGetActiveWebSockets().length;
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
      server._restoreRetry = 0;
      
      try {
        const muteStates = {};
        for (const room of ROOMS) {
          try {
            muteStates[room] = await this._getMuteState(room);
          } catch(e) {
            muteStates[room] = false;
          }
        }
        
        server.serializeAttachment({
          muteStates: muteStates
        });
      } catch(e) {}
      
      this._safeRefreshRoomClients();
      
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
    
    try {
      await this._cleanupStorage();
    } catch(e) {}
    
    const webSockets = this._safeGetActiveWebSockets();
    for (const ws of webSockets) {
      try {
        if (ws?.readyState === 1) {
          ws.send(JSON.stringify(["serverShutdown", "Server shutting down"]));
          ws.close(1000, "Shutdown");
        }
      } catch(e) {}
    }
    
    this.roomClients.clear();
    
    try {
      await this.ctx.storage.deleteAlarm();
    } catch(e) {}
  }
}

export default ChatServer;
