import { ChatServer } from "./chat-server.js";
import { GameServer } from "./game-server.js";

export { ChatServer, GameServer };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 🔥 CEK WEBSOCKET DULU
    const upgrade = request.headers.get("Upgrade");
    if (upgrade === "websocket") {
      // CEK APAKAH WEBSOCKET UNTUK GAME?
      // WSS: wss://domain.com/game/ws
      if (path === "/game/ws") {
        const id = env.GAME_SERVER.idFromName("main");
        const obj = env.GAME_SERVER.get(id);
        return obj.fetch(request);
      }
      
      // SELAIN ITU KE CHAT SERVER
      // WS: wss://domain.com/ (default)
      const id = env.CHAT_SERVER.idFromName("main");
      const obj = env.CHAT_SERVER.get(id);
      return obj.fetch(request);
    }
    
    // 🔥 GAME SERVER HTTP - untuk /game/*
    // Contoh: https://domain.com/game/health
    if (path.startsWith("/game")) {
      const id = env.GAME_SERVER.idFromName("main");
      const obj = env.GAME_SERVER.get(id);
      return obj.fetch(request);
    }
    
    // 🔥 CHAT SERVER - handle SEMUA yang lain
    // Contoh: https://domain.com/ (default)
    const id = env.CHAT_SERVER.idFromName("main");
    const obj = env.CHAT_SERVER.get(id);
    return obj.fetch(request);
  }
};
