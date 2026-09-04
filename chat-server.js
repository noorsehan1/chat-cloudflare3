// ==================== CHAT-SERVER.JS ====================
// VERSION: 7.0.1 - STORAGE-ONLY ARCHITECTURE (NO TTL CACHE)
// SEMUA DATA LANGSUNG BACA/TULIS KE STORAGE
// TIDAK PAKAI MEMORY UNTUK DATA (userSeat, userRoom, rooms)

const C = {
  MAX_SEATS: 45,
  MAX_GLOBAL_CONNECTIONS: 150,
  MAX_MESSAGE_SIZE: 5000,
  NUMBER_INTERVAL_MS: 900000, // 15 MENIT
  MAX_NUMBER: 6,
  BATCH_SIZE: 20,
  LOCK_TIMEOUT: 5000,
  MAX_EVENT_QUEUE: 100,
  MAX_PROCESS_TIME_MS: 500,
  USER_JOIN_LOCK_TIMEOUT: 10000,
  // STORAGE_CACHE_TTL: 2000, // ← HAPUS
};

const ROOMS = [
  "LowCard", "Quiz", "Gacor", "General", "LOVE BIRDS", "Birthday Party",
  "Sweet Memories", "Lounge Talk", "Noxxeliverothcifsa", "BESTIES",
  "Happy Vibes", "The Chatter Room"
];

const ROOMS_SET = new Set(ROOMS);

// ==================== CHAT SERVER ====================
export class ChatServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ctx = state;
    this.closing = false;
    this.isDestroyed = false;
    this._startTime = Date.now();
    this._restored = false;
    
    // ========== WEBSOCKET (HANYA INI DI MEMORY) ==========
    this.wsSet = new Set();
    this.userConnections = new Map();
    this.roomClients = new Map();
    this.wsActiveMulti = new Map();
    
    // ========== PROCESSING ==========
    this._processingMessages = new Set();
    this._cleaningUp = new Set();
    this._eventQueue = [];
    this._isProcessingQueue = false;
    this._pendingTimeouts = new Set();
    
    // ========== LOCKS ==========
    this._joinLocks = new Map();
    this._kursiLocks = new Map();
    this._userJoinLock = new Map();
    
    // ========== NUMBER ==========
    this.currentNumber = 1;
    this._isNumberUpdating = false;
    
    // ========== STORAGE CACHE (HANYA UNTUK PERFORMANCE) ==========
    this._storageCache = null;
    this._storageCacheTime = 0;
    // this._storageCacheTTL = C.STORAGE_CACHE_TTL; // ← HAPUS
    
    // ========== INIT ROOMS ==========
    for (const room of ROOMS) {
      this.roomClients.set(room, new Set());
    }
    
    // ========== RESTORE STATE ==========
    this._restoreAllState().then(() => {
      this._restored = true;
    }).catch(() => {
      this._restored = true;
    });
  }

  // ============================================================
  // ✅ STORAGE OPERATIONS (SEMUA LANGSUNG KE STORAGE)
  // ============================================================

  // 1. LOAD DARI STORAGE (TANPA CACHE TTL)
  async _loadFromStorage() {
    // LANGSUNG LOAD DARI STORAGE, TANPA CACHE
    try {
      const roomsData = await this.ctx.storage.get("roomsData") || {};
      const userSeatData = await this.ctx.storage.get("userSeatData") || {};
      const currentNumber = await this.ctx.storage.get("currentNumber") || 1;
      
      this._storageCache = { roomsData, userSeatData, currentNumber };
      this._storageCacheTime = Date.now();
      
      return this._storageCache;
    } catch(e) {
      return { roomsData: {}, userSeatData: {}, currentNumber: 1 };
    }
  }

  // 2. SAVE KE STORAGE
  async _saveToStorage(roomsData, userSeatData, currentNumber) {
    try {
      if (roomsData !== undefined) {
        await this.ctx.storage.put("roomsData", roomsData);
      }
      if (userSeatData !== undefined) {
        await this.ctx.storage.put("userSeatData", userSeatData);
      }
      if (currentNumber !== undefined) {
        await this.ctx.storage.put("currentNumber", currentNumber);
      }
      
      this._storageCache = { roomsData, userSeatData, currentNumber };
      this._storageCacheTime = Date.now();
      
    } catch(e) {
      console.error('[SAVE] Error:', e.message);
    }
  }

  // ... (SISANYA SAMA, TIDAK BERUBAH)
}
