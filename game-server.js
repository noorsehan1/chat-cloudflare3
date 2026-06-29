_deleteGame(room, game) {
  // ... cleanup code ...
  
  this.activeGames.delete(room);
  this._gameLocks.delete(room);
  this._joinLocks.delete(room);
  
  // ✅ Hapus data room
  this.wsClients.delete(room);
  this.roomViewers.delete(room);
  
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
  
  // ✅ Reset ws.room untuk semua WebSocket yang masih terhubung
  for (const [wsId, ws] of this.wsMap) {
    if (ws && ws.room === room) {
      ws.room = null;
      ws.username = null;
    }
  }
  
  this._broadcastToRoom(room, ["gameLowCardEnd", []]);
}
