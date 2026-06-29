// Client tetap pakai event yang sama, TANPA case baru

// 1. Setelah game selesai (winner)
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data[0] === "gameLowCardWinner") {
    // Tunggu 3-4 detik
    setTimeout(() => {
      // Cek status
      ws.send(JSON.stringify(["checkGameRunning", room]));
    }, 3500);
  }
  
  if (data[0] === "gameStatus" && !data[1].running) {
    // Start game baru
    ws.send(JSON.stringify(["gameLowCardStart", 1000, username]));
  }
  
  if (data[0] === "gameLowCardEnd") {
    // Game sudah di-cleanup, siap start baru
    ws.send(JSON.stringify(["gameLowCardStart", 1000, username]));
  }
};

// 2. Atau langsung start setelah gameLowCardEnd
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data[0] === "gameLowCardEnd") {
    // Langsung start game baru
    ws.send(JSON.stringify(["gameLowCardStart", 1000, username]));
  }
};
