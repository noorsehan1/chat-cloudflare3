_deleteGame(room, game) {
  // ... cleanup code ...
  
  // ✅ Hapus clientRooms untuk semua user di room ini
  const wsIdsToRemove = [];
  for (const [wsId, clientRoom] of this.clientRooms) {
    if (clientRoom === room) {
      wsIdsToRemove.push(wsId);
    }
  }
  for (const wsId of wsIdsToRemove) {
    this.clientRooms.delete(wsId);
  }
  
  // ✅ Reset ws.room dan kirim notifikasi ke client
  const wsToNotify = [];
  for (const [wsId, ws] of this.wsMap) {
    if (ws && ws.room === room) {
      ws.room = null;
      ws.username = null;
      wsToNotify.push(ws);
    }
  }
  
  // Kirim notifikasi agar client tahu room sudah reset
  for (const ws of wsToNotify) {
    this._safeSend(ws, ["gameRoomReset", room]);
    this._safeSend(ws, ["gameLowCardStatus", {
      room: room,
      running: false,
      phase: 'idle',
      round: 0,
      betAmount: 0,
      registrationOpen: false,
      players: [],
      eliminated: [],
      numbers: [],
      totalPlayers: 0,
      activePlayers: 0
    }]);
  }
  
  this._broadcastToRoom(room, ["gameLowCardEnd", []]);
}
