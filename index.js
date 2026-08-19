// ==================== INDEX.JS - PURE WORKER ====================
import { ChatServer } from "./chat-server.js";
import { GameServer } from "./game-server.js";

// ========== GLOBAL STATE (Shared across all requests) ==========
const globalState = {
  chatServer: null,
  gameServer: null,
  initialized: false,
  initPromise: null,
};

// ========== CACHE UNTUK PERSISTENSI ==========
const CACHE_NAME = 'game_state_cache';
const STATE_KEY = 'game_server_state';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      
      // ========== INIT SERVER (ONCE) ==========
      if (!globalState.initialized) {
        if (!globalState.initPromise) {
          globalState.initPromise = (async () => {
            try {
              // Load state dari Cache API
              const cache = await caches.open(CACHE_NAME);
              const cachedResponse = await cache.match(STATE_KEY);
              
              let savedState = null;
              if (cachedResponse) {
                savedState = await cachedResponse.json();
              }
              
              // Init Chat Server
              globalState.chatServer = new ChatServer({
                storage: {
                  get: async (key) => {
                    const cache = await caches.open(CACHE_NAME);
                    const resp = await cache.match(key);
                    if (resp) {
                      const data = await resp.json();
                      return data.value;
                    }
                    return null;
                  },
                  put: async (key, value) => {
                    const cache = await caches.open(CACHE_NAME);
                    const response = new Response(JSON.stringify({ value }), {
                      headers: { 'Content-Type': 'application/json' }
                    });
                    await cache.put(key, response);
                  },
                  delete: async (key) => {
                    const cache = await caches.open(CACHE_NAME);
                    await cache.delete(key);
                  },
                  setAlarm: async (ms) => {
                    // No-op untuk pure worker
                  }
                },
                env: env,
                ctx: {
                  acceptWebSocket: (ws) => {
                    try { ws.accept(); } catch(e) {}
                  }
                }
              });
              
              // Init Game Server dengan state yang disimpan
              const gameState = savedState?.gameState || {};
              globalState.gameServer = new GameServer(env, gameState);
              
              // Restore game state if exists
              if (savedState?.gameState) {
                globalState.gameServer.restoreState(savedState.gameState);
              }
              
              globalState.initialized = true;
              
              // Auto-save setiap 30 detik
              setInterval(async () => {
                try {
                  await globalState.gameServer.saveState();
                } catch(e) {}
              }, 30000);
              
              return true;
            } catch(e) {
              globalState.initialized = false;
              globalState.initPromise = null;
              throw e;
            }
          })();
        }
        await globalState.initPromise;
      }
      
      // ========== CHAT SERVER ==========
      if (pathname === "/ws" || pathname === "/chat" || pathname === "/") {
        return globalState.chatServer.fetch(request);
      }
      
      // ========== GAME SERVER ==========
      if (pathname === "/game/ws") {
        return globalState.gameServer.handleWebSocket(request);
      }
      
      if (pathname === "/game/health") {
        return globalState.gameServer.handleHealth();
      }
      
      if (pathname === "/game") {
        return new Response(JSON.stringify({
          status: "running",
          version: "4.0.0-pure",
          mode: "pure-worker",
          connections: globalState.gameServer?.wsMap?.size || 0,
          games: globalState.gameServer?.activeGames?.size || 0,
          timestamp: Date.now(),
          endpoints: {
            websocket: "/game/ws?room={room_name}",
            health: "/game/health"
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response("Server running", { status: 200 });
      
    } catch(e) {
      console.error("Fetch error:", e);
      return new Response(JSON.stringify({
        error: "Internal Server Error",
        message: e.message || "Unknown error"
      }), { 
        status: 500,
        headers: { 
          'Retry-After': '30',
          'Content-Type': 'application/json'
        }
      });
    }
  }
};
