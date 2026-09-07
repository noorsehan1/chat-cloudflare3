// ==================== CHAT-SERVER-REALTIME.JS ====================
// VERSION: 10.0.1 - REALTIME OPTIMIZED

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
    
    this._locks = new Map();
    
    this.currentNumber = 1;
    this._isNumberUpdating = false;
    
    this._data = null;
    this._dataLoaded = false;
    
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    this._restoreAllState().then(() => {
      this._restored = true;
    }).catch(() => {
      this._restored = true;
    });
  }

  // ==================== D1 METHODS ====================
  
  async _query(sql, params = []) {
    let stmt = this.env.DB.prepare(sql);
    for (const p of params) stmt = stmt.bind(p);
    return await stmt.all();
  }

  async _run(sql, params = []) {
    let stmt = this.env.DB.prepare(sql);
    for (const p of params) stmt = stmt.bind(p);
    return await stmt.run();
  }

  // ==================== DATA ACCESS ====================
  
  async _getData() {
    if (this._dataLoaded && this._data) {
      return this._data;
    }
    
    const result = await this._query('SELECT key, value FROM chat_data');
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
    
    this._data = data;
    this._dataLoaded = true;
    return data;
  }

  async _saveData(roomsData, userSeatData, currentNumber) {
    this._data = { roomsData, userSeatData, currentNumber };
    this._dataLoaded = true;
    
    await Promise.all([
      this._run(
        `INSERT INTO chat_data (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        ['roomsData', JSON.stringify(roomsData)]
      ),
      this._run(
        `INSERT INTO chat_data (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        ['userSeatData', JSON.stringify(userSeatData)]
      ),
      this._run(
        `INSERT INTO chat_data (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        ['currentNumber', JSON.stringify(currentNumber)]
      )
    ]);
  }

  async _getRoomData(room) {
    const data = await this._getData();
    return data.roomsData[room] || null;
  }

  async _getUserSeat(username) {
    const data = await this._getData();
    return data.userSeatData[username] || null;
  }

  async _updateRoomData(room, fn) {
    const data = await this._getData();
    if (!data.roomsData[room]) {
      data.roomsData[room] = { seats: {}, points: {}, muted: false, number: 1 };
    }
    fn(data.roomsData[room]);
    await this._saveData(data.roomsData, data.userSeatData, this.currentNumber);
  }

  async _updateUserSeat(username, fn) {
    const data = await this._getData();
    if (!data.userSeatData[username]) data.userSeatData[username] = {};
    fn(data.userSeatData[username]);
    if (Object.keys(data.userSeatData[username]).length === 0) {
      delete data.userSeatData[username];
    }
    await this._saveData(data.roomsData, data.userSeatData, this.currentNumber);
  }

  // ==================== RESTORE ====================
  
  async _restoreAllState() {
    try {
      const data = await this._getData();
      this.currentNumber = data.currentNumber;
      
      for (const ws of this.ctx.getWebSockets()) {
        try {
          const att = ws.deserializeAttachment();
          if (att?.username) {
            const seat = data.userSeatData[att.username];
            if (seat) {
              ws.username = att.username;
              ws.room = seat.room;
              ws.roomname = seat.room;
              ws.idtarget = att.username;
              ws._closing = false;
              
              const rc = this.roomClients.get(seat.room);
              if (rc) rc.add(ws);
              
              let conns = this.userConnections.get(att.username);
              if (!conns) conns = new Set();
              conns.add(ws);
              this.userConnections.set(att.username, conns);
              this.wsSet.add(ws);
            }
          }
        } catch(e) {}
      }
      
      if (!this.closing && !this.isDestroyed) {
        this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
      }
    } catch(e) {
      this._data = { roomsData: {}, userSeatData: {}, currentNumber: 1 };
      this._dataLoaded = true;
    }
  }

  // ==================== CORE METHODS ====================
  
  async _removeUserFromRoom(username, room) {
    if (!username || !room) return false;
    
    const data = await this._getData();
    const roomData = data.roomsData[room];
    if (!roomData?.seats) return false;
    
    let seat = null;
    for (const [s, d] of Object.entries(roomData.seats)) {
      if (d?.namauser === username) {
        seat = parseInt(s);
        break;
      }
    }
    if (!seat) return false;
    
    delete roomData.seats[seat];
    if (roomData.points) delete roomData.points[seat];
    delete data.userSeatData[username];
    
    await this._saveData(data.roomsData, data.userSeatData, this.currentNumber);
    
    this.broadcast(room, ["removeKursi", room, seat]);
    await this.updateRoomCount(room);
    
    const hasSeats = Object.keys(roomData.seats || {}).length > 0;
    const hasPoints = Object.keys(roomData.points || {}).length > 0;
    if (!hasSeats && !hasPoints) {
      delete data.roomsData[room];
      await this._saveData(data.roomsData, data.userSeatData, this.currentNumber);
    }
    
    return true;
  }

  async _handleJoin(ws, room) {
    if (!ws?.username || !room || !ROOMS_SET.has(room) || this.closing) return false;
    
    const username = ws.username;
    const lockKey = `join_${username}`;
    if (this._locks.has(lockKey)) {
      if (Date.now() - this._locks.get(lockKey) < 10000) {
        this.safeSend(ws, ["joinInProgress", "Please wait..."]);
        return false;
      }
      this._locks.delete(lockKey);
    }
    this._locks.set(lockKey, Date.now());
    
    try {
      return await this._joinInternal(ws, room, username);
    } finally {
      this._locks.delete(lockKey);
    }
  }

  async _joinInternal(ws, room, username) {
    const data = await this._getData();
    const existing = data.userSeatData[username];
    if (existing && existing.room !== room) {
      await this._removeUserFromRoom(username, existing.room);
    }
    
    let roomData = data.roomsData[room];
    if (!roomData) {
      roomData = { seats: {}, points: {}, muted: false, number: 1 };
    }
    
    let seat = null;
    for (const [s, d] of Object.entries(roomData.seats)) {
      if (d?.namauser === username) {
        seat = parseInt(s);
        break;
      }
    }
    
    if (!seat) {
      if (Object.keys(roomData.seats).length >= C.MAX_SEATS) {
        this.safeSend(ws, ["roomFull", room]);
        return false;
      }
      for (let s = 1; s <= C.MAX_SEATS; s++) {
        if (!roomData.seats[s]) {
          seat = s;
          break;
        }
      }
      if (!seat) {
        this.safeSend(ws, ["roomFull", room]);
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
    }
    
    data.userSeatData[username] = { room, seat, isMulti: false };
    await this._saveData(data.roomsData, data.userSeatData, this.currentNumber);
    
    ws.room = room;
    ws.roomname = room;
    ws.idtarget = username;
    ws.serializeAttachment({ username, seatInfo: { room, seat, isMulti: false } });
    
    for (const [r, clients] of this.roomClients) {
      if (r !== room) clients.delete(ws);
    }
    const rc = this.roomClients.get(room);
    if (rc && !rc.has(ws)) rc.add(ws);
    this.wsActiveMulti.delete(ws);
    
    this.safeSend(ws, ["rooMasuk", seat, room]);
    this.safeSend(ws, ["numberKursiSaya", seat]);
    this.safeSend(ws, ["muteTypeResponse", roomData.muted || false, room]);
    
    const count = Object.keys(roomData.seats).length;
    this.safeSend(ws, ["roomUserCount", room, count]);
    this.broadcast(room, ["roomUserCount", room, count]);
    
    setTimeout(() => {
      if (ws?.readyState === 1) this.sendAllStateTo(ws, room, true);
    }, 1000);
    
    return true;
  }

  // ==================== CLEANUP - SINGLE METHOD ====================
  
  async _handleDisconnect(ws) {
    if (!ws) return;
    
    // Cegah race condition
    if (ws._disconnecting) return;
    ws._disconnecting = true;
    
    try {
      const username = ws.username;
      const room = ws.room || ws.roomname;
      
      if (!username) {
        this._cleanupWebSocket(ws);
        return;
      }
      
      const isMulti = this.wsActiveMulti.has(ws);
      
      if (isMulti) {
        const conns = this.userConnections.get(username);
        if (conns) conns.delete(ws);
        if (room) {
          const rc = this.roomClients.get(room);
          if (rc) rc.delete(ws);
        }
        this.wsActiveMulti.delete(ws);
        this.wsSet.delete(ws);
        this._cleanupWebSocket(ws);
        return;
      }
      
      // User biasa - hapus dari room
      if (room) {
        await this._removeUserFromRoom(username, room);
      } else {
        const seat = await this._getUserSeat(username);
        if (seat?.room) {
          await this._removeUserFromRoom(username, seat.room);
        } else {
          await this._updateUserSeat(username, (d) => {});
        }
      }
      
      const conns = this.userConnections.get(username);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) this.userConnections.delete(username);
      }
      
      const targetRoom = room || (await this._getUserSeat(username))?.room;
      if (targetRoom) {
        const rc = this.roomClients.get(targetRoom);
        if (rc) rc.delete(ws);
      }
      
      this.wsActiveMulti.delete(ws);
      this.wsSet.delete(ws);
      this._cleanupWebSocket(ws);
      
    } catch(e) {
      // Cleanup tetap jalan meskipun error
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
      // Hapus dari semua collection
      const username = ws.username;
      const room = ws.room || ws.roomname;
      
      if (room) {
        try { this.roomClients.get(room)?.delete(ws); } catch(e) {}
      }
      
      try { this.wsActiveMulti.delete(ws); } catch(e) {}
      
      if (username) {
        try {
          const conns = this.userConnections.get(username);
          if (conns) {
            conns.delete(ws);
            if (conns.size === 0) this.userConnections.delete(username);
          }
        } catch(e) {}
      }
      
      try { this.wsSet.delete(ws); } catch(e) {}
      
      // Reset properties
      try {
        ws.username = null;
        ws.room = null;
        ws.roomname = null;
        ws.idtarget = null;
        ws.serializeAttachment({});
      } catch(e) {}
      
    } catch(e) {} finally {
      ws._cleaning = false;
      // Tutup koneksi jika masih terbuka
      try { 
        if (ws && ws.readyState === 1) {
          ws.close(1000, "Cleanup");
        }
      } catch(e) {}
    }
  }

  // ==================== BROADCAST ====================
  
  broadcast(room, msg) {
    if (this.closing || !room || !msg) return;
    const clients = this.roomClients.get(room);
    if (!clients?.size) return;
    
    const str = JSON.stringify(msg);
    const toRemove = [];
    
    for (const ws of clients) {
      try {
        if (ws?.readyState === 1 && !ws._closing) {
          ws.send(str);
        } else {
          toRemove.push(ws);
        }
      } catch(e) {
        toRemove.push(ws);
      }
    }
    
    for (const ws of toRemove) {
      clients.delete(ws);
      if (ws) this._cleanupWebSocket(ws);
    }
  }

  safeSend(ws, msg) {
    if (!ws) return false;
    try {
      if (ws.readyState !== 1 || ws._closing || this.closing) return false;
      ws.send(JSON.stringify(msg));
      return true;
    } catch(e) {
      this._cleanupWebSocket(ws);
      return false;
    }
  }

  // ==================== WEBSOCKET EVENTS ====================
  
  async webSocketMessage(ws, msg) {
    if (!ws || ws._closing || this.closing || this.isDestroyed) return;
    try {
      if (ws.readyState !== 1) return;
      let str = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      if (str.length > C.MAX_MESSAGE_SIZE) return;
      
      let data;
      try { data = JSON.parse(str); } catch(e) { return; }
      if (!Array.isArray(data) || !data.length) return;
      
      const [evt, ...args] = data;
      await this._handleEvent(ws, evt, args);
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

  // ==================== EVENT HANDLERS ====================
  
  async handleMessage(ws, raw) {
    if (!ws || ws._closing || this.closing) return;
    try {
      if (ws.readyState !== 1) return;
      let str = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      if (str.length > C.MAX_MESSAGE_SIZE) return;
      
      let data;
      try { data = JSON.parse(str); } catch(e) { return; }
      if (!Array.isArray(data) || !data.length) return;
      
      const [evt, ...args] = data;
      await this._handleEvent(ws, evt, args);
    } catch(e) {}
  }

  async _handleEvent(ws, evt, args) {
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
        const [username, room] = args;
        if (!username || !room) break;
        
        const existing = await this._getUserSeat(username);
        if (existing?.room) {
          await this._removeUserFromRoom(username, existing.room);
        }
        
        const data = await this._getData();
        let roomData = data.roomsData[room];
        if (!roomData) roomData = { seats: {}, points: {}, muted: false, number: 1 };
        
        if (Object.keys(roomData.seats).length >= C.MAX_SEATS) break;
        
        let seat = null;
        for (let s = 1; s <= C.MAX_SEATS; s++) {
          if (!roomData.seats[s]) { seat = s; break; }
        }
        if (!seat) break;
        
        roomData.seats[seat] = {
          noimageUrl: "", namauser: username, color: "",
          itembawah: 0, itematas: 0, vip: 0, viptanda: 0
        };
        
        data.userSeatData[username] = { room, seat, isMulti: true };
        await this._saveData(data.roomsData, data.userSeatData, this.currentNumber);
        
        ws.serializeAttachment({ username, seatInfo: { room, seat, isMulti: true } });
        this.wsActiveMulti.set(ws, { username, room });
        
        for (const [r, clients] of this.roomClients) {
          if (r !== room) clients.delete(ws);
        }
        const rc = this.roomClients.get(room);
        if (rc && !rc.has(ws)) rc.add(ws);
        
        this.safeSend(ws, ["rooMasukMulti", seat, room]);
        this.broadcast(room, ["roomUserCount", room, Object.keys(roomData.seats).length]);
        break;
      }
      
      case "exitMulti": {
        const username = args[0];
        if (!username) break;
        
        const seat = await this._getUserSeat(username);
        if (!seat) break;
        
        await this._removeUserFromRoom(username, seat.room);
        
        const conns = this.userConnections.get(username);
        if (conns) {
          for (const c of conns) {
            if (c?.readyState === 1) {
              this.safeSend(c, ["exitMultiForce", "Exited"]);
              c.close(1000, "Exited");
            }
          }
          this.userConnections.delete(username);
        }
        
        const toDelete = [];
        for (const [wsKey, d] of this.wsActiveMulti) {
          if (d?.username === username) toDelete.push(wsKey);
        }
        for (const wsKey of toDelete) {
          this.wsActiveMulti.delete(wsKey);
          this.wsSet.delete(wsKey);
        }
        
        this.safeSend(ws, ["exitMultiSuccess", username, seat.room, seat.seat]);
        break;
      }
      
      case "setActiveMulti": {
        const username = args[0];
        const seat = await this._getUserSeat(username);
        if (!seat) {
          this.safeSend(ws, ["setActiveMultiError", "User not found"]);
          break;
        }
        
        for (const [wsKey, d] of this.wsActiveMulti) {
          if (d?.username === username && wsKey !== ws) {
            const rc = this.roomClients.get(d.room);
            if (rc) rc.delete(wsKey);
            this.wsActiveMulti.delete(wsKey);
            this.wsSet.delete(wsKey);
            try { wsKey.close(1000, "Replaced"); } catch(e) {}
          }
        }
        
        this.wsActiveMulti.set(ws, { username, room: seat.room });
        ws.username = username;
        ws.room = seat.room;
        ws.roomname = seat.room;
        ws.idtarget = username;
        ws.serializeAttachment({ username, seatInfo: seat });
        
        const rc = this.roomClients.get(seat.room);
        if (rc && !rc.has(ws)) rc.add(ws);
        
        let conns = this.userConnections.get(username);
        if (!conns) conns = new Set();
        if (!conns.has(ws)) conns.add(ws);
        this.userConnections.set(username, conns);
        if (!this.wsSet.has(ws)) this.wsSet.add(ws);
        
        this.safeSend(ws, ["activeChangedMulti", username, seat.seat, seat.room]);
        this.broadcast(seat.room, ["userActiveChanged", username, seat.seat]);
        this.broadcast(seat.room, ["userOnline", username, seat.seat]);
        break;
      }
      
      case "updateKursi": {
        const [room, seat, noimg, name, color, bawah, atas, vip, vt] = args;
        if (!room || typeof seat !== 'number' || seat < 1 || seat > C.MAX_SEATS) {
          this.safeSend(ws, ["updateKursiError", "Invalid"]);
          break;
        }
        if (!ROOMS_SET.has(room)) {
          this.safeSend(ws, ["updateKursiError", "Room not found"]);
          break;
        }
        
        const userSeat = await this._getUserSeat(name);
        if (!userSeat || userSeat.seat !== seat || userSeat.room !== room) {
          this.safeSend(ws, ["updateKursiError", "Not your seat"]);
          break;
        }
        
        const lockKey = `kursi_${room}_${seat}`;
        if (this._locks.has(lockKey)) {
          this.safeSend(ws, ["updateKursiError", "Please wait"]);
          break;
        }
        this._locks.set(lockKey, Date.now());
        
        try {
          const data = await this._getData();
          const roomData = data.roomsData[room];
          if (!roomData?.seats?.[seat]) {
            this.safeSend(ws, ["updateKursiError", "Seat not found"]);
            break;
          }
          
          const curr = roomData.seats[seat];
          if (curr.namauser !== name) {
            this.safeSend(ws, ["updateKursiError", "Not your seat"]);
            break;
          }
          
          roomData.seats[seat] = {
            noimageUrl: noimg || curr.noimageUrl || "",
            namauser: name || curr.namauser || "",
            color: color || curr.color || "",
            itembawah: parseInt(bawah) || 0,
            itematas: parseInt(atas) || 0,
            vip: parseInt(vip) || 0,
            viptanda: parseInt(vt) || 0
          };
          
          await this._saveData(data.roomsData, data.userSeatData, this.currentNumber);
          this.safeSend(ws, ["updateKursiSuccess", room, seat]);
          this.broadcast(room, ["kursiBatchUpdate", room, [[seat, roomData.seats[seat]]]]);
        } finally {
          this._locks.delete(lockKey);
        }
        break;
      }
      
      case "chat": {
        const [room, noimg, user, msg, color, textColor] = args;
        if (!msg || !ROOMS_SET.has(room)) break;
        const seat = await this._getUserSeat(user);
        if (!seat || seat.room !== room) break;
        if ((ws.room || ws.roomname) !== room) break;
        this.broadcast(room, ["chat", room, noimg, user, msg, color, textColor]);
        break;
      }
      
      case "updatePoint": {
        const [room, seat, x, y, fast] = args;
        if (!room || typeof seat !== 'number') break;
        const userSeat = await this._getUserSeat(ws.username);
        if (!userSeat || userSeat.room !== room || userSeat.seat !== seat) break;
        
        const data = await this._getData();
        const roomData = data.roomsData[room];
        if (roomData?.seats?.[seat]) {
          if (!roomData.points) roomData.points = {};
          roomData.points[seat] = { x: x || 0, y: y || 0, fast: !!fast };
          await this._saveData(data.roomsData, data.userSeatData, this.currentNumber);
          this.broadcast(room, ["pointUpdated", room, seat, x, y, fast]);
        }
        break;
      }
      
      case "gift": {
        const [room, sender, receiver, gift] = args;
        if (room && ROOMS_SET.has(room)) {
          const s = await this._getUserSeat(sender);
          const r = await this._getUserSeat(receiver);
          if (s?.room === room && r?.room === room && (ws.room || ws.roomname) === room) {
            this.broadcast(room, ["gift", room, sender, receiver, gift, Date.now()]);
          }
        }
        break;
      }
      
      case "rollangak": {
        const [room, user, angka] = args;
        if (room && ROOMS_SET.has(room)) {
          const seat = await this._getUserSeat(user);
          if (seat?.room === room && (ws.room || ws.roomname) === room) {
            this.broadcast(room, ["rollangakBroadcast", room, user, angka]);
          }
        }
        break;
      }
      
      case "removeKursiAndPoint": {
        const [room, seat] = args;
        const userSeat = await this._getUserSeat(ws.username);
        if (!userSeat || userSeat.room !== room) break;
        
        const data = await this._getData();
        const roomData = data.roomsData[room];
        const username = roomData?.seats?.[seat]?.namauser;
        if (username) {
          await this._removeUserFromRoom(username, room);
        }
        break;
      }
      
      case "setMuteType": {
        const [muteVal, muteRoom] = args;
        if (!muteRoom || !ROOMS_SET.has(muteRoom)) break;
        const userSeat = await this._getUserSeat(ws.username);
        if (!userSeat || userSeat.room !== muteRoom) break;
        
        await this._updateRoomData(muteRoom, (d) => { d.muted = !!muteVal; });
        this.broadcast(muteRoom, ["muteStatusChanged", !!muteVal, muteRoom]);
        this.safeSend(ws, ["muteTypeSet", !!muteVal, true, muteRoom]);
        break;
      }
      
      case "modwarning": {
        const room = args[0];
        if (room && ROOMS_SET.has(room)) {
          const userSeat = await this._getUserSeat(ws.username);
          if (userSeat?.room === room) {
            this.broadcast(room, ["modwarning", room]);
          }
        }
        break;
      }
      
      case "private": {
        const [target, noimg, msg, sender] = args;
        if (target && msg) {
          const conns = this.userConnections.get(target);
          if (conns) {
            for (const c of conns) {
              if (c?.readyState === 1) {
                this.safeSend(c, ["private", target, noimg, msg, Date.now(), sender]);
                break;
              }
            }
          }
          this.safeSend(ws, ["private", target, noimg, msg, Date.now(), sender]);
        }
        break;
      }
      
      case "sendnotif": {
        try {
          const [target, noimg, user, msg] = args;
          if (target && msg) {
            const conns = this.userConnections.get(target);
            if (conns) {
              for (const c of conns) {
                if (c?.readyState === 1) {
                  this.safeSend(c, ["notif", noimg, user, msg, Date.now()]);
                  break;
                }
              }
            }
          }
        } catch(e) {}
        break;
      }
      
      case "isUserOnline": {
        const [target, cb] = args;
        let online = false;
        const seat = await this._getUserSeat(target);
        if (seat) {
          if (seat.isMulti) {
            online = true;
          } else {
            const conns = this.userConnections.get(target);
            if (conns) {
              for (const c of conns) {
                if (c?.readyState === 1) { online = true; break; }
              }
            }
          }
        }
        this.safeSend(ws, ["userOnlineStatus", target, online, cb || ""]);
        break;
      }
      
      case "getOnlineUsers": {
        const data = await this._getData();
        const users = [];
        for (const [username, seat] of Object.entries(data.userSeatData)) {
          if (seat) {
            let online = false;
            if (seat.isMulti) {
              online = true;
            } else {
              const conns = this.userConnections.get(username);
              if (conns) {
                for (const c of conns) {
                  if (c?.readyState === 1) { online = true; break; }
                }
              }
            }
            if (online) users.push(username);
          }
        }
        this.safeSend(ws, ["allOnlineUsers", users]);
        break;
      }
      
      case "getAllRoomsUserCount": {
        const data = await this._getData();
        const counts = {};
        for (const room of ROOMS) {
          counts[room] = Object.keys(data.roomsData[room]?.seats || {}).length;
        }
        this.safeSend(ws, ["allRoomsUserCount", Object.entries(counts)]);
        break;
      }
      
      case "getRoomUserCount": {
        const room = args[0];
        if (room && ROOMS_SET.has(room)) {
          const data = await this._getData();
          const count = Object.keys(data.roomsData[room]?.seats || {}).length;
          this.safeSend(ws, ["roomUserCount", room, count]);
        }
        break;
      }
      
      case "getMuteType": {
        const room = args[0];
        if (room && ROOMS_SET.has(room)) {
          const data = await this._getData();
          this.safeSend(ws, ["muteTypeResponse", data.roomsData[room]?.muted || false, room]);
        }
        break;
      }
      
      case "onDestroy":
        // SAMA dengan webSocketClose dan webSocketError
        await this._handleDisconnect(ws);
        break;
      
      default:
        this.safeSend(ws, ["error", `Unknown: ${evt}`]);
    }
  }

  // ==================== HELPER METHODS ====================
  
  async _handleSetId(ws, username, isNewUser) {
    if (!username || typeof username !== 'string' || username.length === 0 || this.closing) {
      try { if (ws?.readyState === 1) ws.close(1000, "Invalid"); } catch(e) {}
      return;
    }
    
    const userSeat = await this._getUserSeat(username);
    const isMulti = userSeat?.isMulti === true;
    
    if (isMulti && !isNewUser) return;
    if (isMulti && isNewUser) {
      await this._removeUserFromRoom(username, userSeat.room);
      await this._updateUserSeat(username, (d) => {});
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
    ws.serializeAttachment({ username });
    
    let conns = this.userConnections.get(username);
    if (!conns) { conns = new Set(); this.userConnections.set(username, conns); }
    if (!conns.has(ws)) conns.add(ws);
    if (!this.wsSet.has(ws)) this.wsSet.add(ws);
    this.wsActiveMulti.delete(ws);
    
    this.safeSend(ws, isNewUser ? ["joinroomawal"] : ["needJoinRoom"]);
  }

  async updateRoomCount(room) {
    if (this.closing || !room) return 0;
    try {
      const data = await this._getData();
      const count = Object.keys(data.roomsData[room]?.seats || {}).length;
      this.broadcast(room, ["roomUserCount", room, count]);
      return count;
    } catch(e) { return 0; }
  }

  async sendAllStateTo(ws, room, excludeSelf = false) {
    if (!ws?.username) return;
    try { if (ws.readyState !== 1) return; } catch(e) { return; }
    
    const data = await this._getData();
    const roomData = data.roomsData[room];
    if (!roomData) return;
    
    const userSeat = data.userSeatData[ws.username];
    const selfSeat = userSeat?.seat;
    const seats = roomData.seats || {};
    const points = roomData.points || {};
    
    this.safeSend(ws, ["roomUserCount", room, Object.keys(seats).length]);
    
    if (Object.keys(seats).length > 0) {
      if (excludeSelf && selfSeat && seats[selfSeat]) {
        const filtered = { ...seats };
        delete filtered[selfSeat];
        if (Object.keys(filtered).length > 0) {
          this.safeSend(ws, ["allUpdateKursiList", room, filtered]);
        }
      } else {
        this.safeSend(ws, ["allUpdateKursiList", room, seats]);
      }
    }
    
    if (Object.keys(points).length > 0) {
      let list = Object.entries(points).map(([s, p]) => ({
        seat: parseInt(s), x: p.x, y: p.y, fast: p.fast ? 1 : 0
      }));
      if (excludeSelf && selfSeat) {
        list = list.filter(p => p.seat !== selfSeat);
      }
      if (list.length > 0) {
        this.safeSend(ws, ["allPointsList", room, list]);
      }
    }
  }

  async alarm() {
    if (this.closing || this.isDestroyed) return;
    await this._updateNumber();
    this._cleanupDeadConnections();
    this._cleanupStaleLocks();
    this.ctx.storage.setAlarm(Date.now() + C.NUMBER_INTERVAL_MS);
  }

  async _updateNumber() {
    if (this._isNumberUpdating || this.closing) return;
    this._isNumberUpdating = true;
    try {
      this.currentNumber = this.currentNumber < C.MAX_NUMBER ? this.currentNumber + 1 : 1;
      const data = await this._getData();
      for (const d of Object.values(data.roomsData)) {
        if (d) d.number = this.currentNumber;
      }
      await this._saveData(data.roomsData, data.userSeatData, this.currentNumber);
      for (const [room, clients] of this.roomClients) {
        if (clients?.size) this.broadcast(room, ["currentNumber", this.currentNumber]);
      }
    } catch(e) {} finally {
      this._isNumberUpdating = false;
    }
  }

  _cleanupDeadConnections() {
    try {
      const toRemove = [];
      for (const ws of this.wsSet) {
        if (!ws || ws.readyState !== 1 || ws._closing) toRemove.push(ws);
      }
      for (const ws of toRemove) {
        this._cleanupWebSocket(ws);
      }
    } catch(e) {}
  }

  _cleanupStaleLocks() {
    try {
      const now = Date.now();
      for (const [k, t] of this._locks) {
        if (now - t > C.LOCK_TIMEOUT) this._locks.delete(k);
      }
    } catch(e) {}
  }

  // ==================== FETCH ====================
  
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
      catch(e) { return new Response("Failed", { status: 500 }); }
      
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
      return new Response("Error", { status: 500 });
    }
  }

  // ==================== DESTROY ====================
  
  async destroy() {
    if (this.isDestroyed) return;
    this.closing = true;
    this.isDestroyed = true;
    
    this._locks.clear();
    
    const wsCopy = Array.from(this.wsSet);
    for (const ws of wsCopy) {
      const isMulti = this.wsActiveMulti.has(ws);
      
      if (ws?.readyState === 1) {
        try { ws.send(JSON.stringify(["serverShutdown", "Shutdown"])); } catch(e) {}
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
        try { this._cleanupWebSocket(ws); } catch(e) {}
      }
    }
    
    for (const [username, conns] of this.userConnections) {
      const toRemove = [];
      for (const conn of conns) {
        if (!conn || conn.readyState !== 1) toRemove.push(conn);
      }
      for (const conn of toRemove) conns.delete(conn);
      if (conns.size === 0) {
        let isMulti = false;
        for (const [wsKey] of this.wsActiveMulti) {
          if (wsKey?.username === username) { isMulti = true; break; }
        }
        if (!isMulti) this.userConnections.delete(username);
      }
    }
  }
}

export default ChatServer;
