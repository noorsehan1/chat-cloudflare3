case "getOnlineUsers": {
  const users = [];
  await this._ensureCacheInitialized();
  const userSeatData = this._storageCache.userSeatData || {};
  
  for (const [username, seatInfo] of Object.entries(userSeatData)) {
    if (seatInfo) {
      let isOnline = false;
      
      // ✅ Jika multi user → LANGSUNG ONLINE (tanpa cek apapun)
      if (seatInfo.isMulti === true) {
        isOnline = true;
      } else {
        // User biasa → cek koneksi WebSocket
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
