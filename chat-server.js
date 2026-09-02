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
  
  // HAPUS DATA LAMA (TERMASUK MULTI)
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
  
  // UPDATE ATTACHMENT UNTUK SEMUA WEBSOCKET YANG TERKAIT
  const webSockets = this._getActiveWebSockets();
  for (const wsKey of webSockets) {
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
        
        // KIRIM KONFIRMASI PINDAH ROOM
        this.safeSend(wsKey, ["multiRoomChanged", multiRoomname, seat]);
        this.safeSend(wsKey, ["serverVersion", this._version, this._deployTime]);
      }
    } catch(e) {}
  }
  
  this._refreshRoomClients(true);
  
  this.safeSend(ws, ["rooMasukMulti", seat, multiRoomname]);
  this.safeSend(ws, ["serverVersion", this._version, this._deployTime]);
  this.broadcast(multiRoomname, ["roomUserCount", multiRoomname, Object.keys(roomData.seats).length]);
  
  break;
}
