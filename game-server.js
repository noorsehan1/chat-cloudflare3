// ============================================================
// GAME-SERVER-D1-JAVA-COMPATIBLE-FINAL.js
// VERSION: 14.0.0 - RACE CONDITION & TIMER FIXED
// ============================================================

// ============================================================
// CONSTANTS
// ============================================================

const CONSTANTS = {
  MAX_LOWCARD_GAMES: 10,
  REGISTRATION_TIME_MS: 20000,
  DRAW_TIME_MS: 20000,
  EVALUATION_DELAY_MS: 2000,
  MAX_BOTS_PER_GAME: 4,
  MAX_BET: 100000,
  EVALUATION_TIMEOUT_MS: 30000,
  MAX_PLAYERS_PER_GAME: 45,
  MAX_WS_CLIENTS: 150,
  MAX_EVENT_QUEUE_SIZE: 50,
  ERROR_RESET_INTERVAL_MS: 60000,
  
  DICE_ANSWER_TIME_MS: 20000,
  DICE_TOTAL_TIME_MS: 20000,
  MAX_DICE_VALUE: 6,
  DICE_ROOM: "Quiz",
  
  DICE_AUTO_START_DELAY_MS: 3000,
  TIE_BREAKER_TIME_LIMIT: 20,
  TIE_BREAKER_COOLDOWN: 15000,
  
  BROADCAST_BATCH_SIZE: 10,
  CPU_YIELD_MS: 1,
  MAX_PROCESS_TIME_MS: 500,
  MAX_QUEUE_SIZE: 50,
  RATE_LIMIT_MAX: 100,
  RATE_LIMIT_WINDOW_MS: 60000,
  MAX_BOT_TIMEOUTS: 5,
  
  WEEKLY_RESET_DAY: 1,
  WEEKLY_RESET_HOUR: 0,
  WEEKLY_RESET_ALARM: 'weekly_reset',
  
  MAX_LEADERBOARD_LIMIT: 30,
  MIN_LEADERBOARD_LIMIT: 1,
  DEFAULT_LEADERBOARD_LIMIT: 10,
  
  PROCESS_BATCH_SIZE: 50,
  PROCESS_MAX_TIME_MS: 100,
  
  DICE_SESSION_CHECK_INTERVAL_MS: 5000,
  DICE_BROADCAST_DELAY_MS: 5000,
};

const QUIZ_SCHEDULE = {
  SESSIONS: [
    { start: "01:00", end: "02:00" },
    { start: "13:00", end: "14:00" },
    { start: "22:00", end: "23:00" }
  ],
  TIMEZONE_OFFSET: 8,
};

const TABLE_NAME = 'game_data';

function parseTime(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

// ============================================================
// TIMER MANAGER - FIX RACE CONDITION
// ============================================================

class TimerManager {
  constructor() {
    this._timers = new Map();
    this._id = 0;
    this._isCleaningUp = false;
  }

  setTimeout(callback, delay, context = null) {
    if (this._isCleaningUp) return null;
    
    const id = ++this._id;
    const timer = setTimeout(() => {
      this._timers.delete(id);
      try {
        if (context && context._isDestroyed) return;
        if (context && context.closing) return;
        callback();
      } catch(e) {
        // Silent error handling
      }
    }, delay);
    
    this._timers.set(id, timer);
    return id;
  }

  setInterval(callback, delay, context = null) {
    if (this._isCleaningUp) return null;
    
    const id = ++this._id;
    const interval = setInterval(() => {
      try {
        if (context && context._isDestroyed) return;
        if (context && context.closing) return;
        callback();
      } catch(e) {
        // Silent error handling
      }
    }, delay);
    
    this._timers.set(id, interval);
    return id;
  }

  clearTimeout(id) {
    if (id === null || id === undefined) return false;
    const timer = this._timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this._timers.delete(id);
      return true;
    }
    return false;
  }

  clearInterval(id) {
    if (id === null || id === undefined) return false;
    const timer = this._timers.get(id);
    if (timer) {
      clearInterval(timer);
      this._timers.delete(id);
      return true;
    }
    return false;
  }

  clearAll() {
    this._isCleaningUp = true;
    for (const [id, timer] of this._timers) {
      try {
        clearTimeout(timer);
        clearInterval(timer);
      } catch(e) {}
    }
    this._timers.clear();
    this._isCleaningUp = false;
  }

  get size() {
    return this._timers.size;
  }

  has(id) {
    return this._timers.has(id);
  }
}

// ============================================================
// ATOMIC LOCK - FIX RACE CONDITION
// ============================================================

class AtomicLock {
  constructor() {
    this._locks = new Map();
    this._cleanupInterval = null;
  }

  acquire(key, timeoutMs = 5000) {
    if (this._locks.has(key)) return false;
    this._locks.set(key, Date.now());
    
    // Auto cleanup
    const timer = setTimeout(() => {
      if (this._locks.has(key)) {
        this._locks.delete(key);
      }
    }, timeoutMs);
    
    // Store timer reference for cleanup
    this._locks.set(`${key}_timer`, timer);
    return true;
  }

  release(key) {
    if (this._locks.has(key)) {
      const timerKey = `${key}_timer`;
      if (this._locks.has(timerKey)) {
        clearTimeout(this._locks.get(timerKey));
        this._locks.delete(timerKey);
      }
      this._locks.delete(key);
      return true;
    }
    return false;
  }

  isLocked(key) {
    return this._locks.has(key);
  }

  clearAll() {
    for (const [key, value] of this._locks) {
      if (key.endsWith('_timer')) {
        clearTimeout(value);
      }
    }
    this._locks.clear();
  }
}

// ============================================================
// VERSIONED TIMER - FIX RACE CONDITION
// ============================================================

class VersionedTimer {
  constructor() {
    this._version = Date.now();
    this._timers = new Set();
    this._isActive = true;
  }

  setTimeout(callback, delay) {
    if (!this._isActive) return null;
    
    const version = this._version;
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      if (this._version !== version) return;
      if (!this._isActive) return;
      try {
        callback();
      } catch(e) {}
    }, delay);
    
    this._timers.add(timer);
    return timer;
  }

  invalidate() {
    this._isActive = false;
    this._version = Date.now();
    for (const timer of this._timers) {
      try {
        clearTimeout(timer);
      } catch(e) {}
    }
    this._timers.clear();
  }

  clear() {
    for (const timer of this._timers) {
      try {
        clearTimeout(timer);
      } catch(e) {}
    }
    this._timers.clear();
  }

  isActive() {
    return this._isActive;
  }
}

// ============================================================
// DATA MANAGER
// ============================================================

class DataManager {
  constructor(db) {
    this.db = db;
    this._cache = {
      recordingStatusMap: {},
      winnersMap: {},
      dicePoints: {},
      lastWeekWinner: null,
      lastResetWeek: null,
      scheduled_alarms: {}
    };
    this._cacheInitialized = false;
    this._cacheLoading = false;
    this._restored = false;
    this._lock = new AtomicLock();
  }

  async init() {
    try {
      await this.db.prepare(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      return true;
    } catch(e) {
      return false;
    }
  }

  async loadAllData() {
    if (this._cacheLoading) {
      let waitCount = 0;
      while (this._cacheLoading && waitCount < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
      }
      return this._cache;
    }
    
    const lockKey = 'loadAllData';
    if (!this._lock.acquire(lockKey, 10000)) {
      return this._cache;
    }
    
    try {
      this._cacheLoading = true;
      const result = await this.db
        .prepare(`SELECT key, value FROM ${TABLE_NAME}`)
        .all();

      const cache = {
        recordingStatusMap: {},
        winnersMap: {},
        dicePoints: {},
        lastWeekWinner: null,
        lastResetWeek: null,
        scheduled_alarms: {}
      };

      const results = result.results || [];
      for (const row of results) {
        const key = row.key;
        let value;
        try {
          value = JSON.parse(row.value);
        } catch(e) {
          continue;
        }

        switch(key) {
          case 'recordingStatusMap':
            cache.recordingStatusMap = value || {};
            break;
          case 'winnersMap':
            cache.winnersMap = value || {};
            break;
          case 'dicePoints':
            cache.dicePoints = value || {};
            break;
          case 'lastWeekWinner':
            cache.lastWeekWinner = value || null;
            break;
          case 'lastResetWeek':
            cache.lastResetWeek = value || null;
            break;
          case 'scheduled_alarms':
            cache.scheduled_alarms = value || {};
            break;
        }
      }

      this._cache = cache;
      this._cacheInitialized = true;
      this._restored = true;
      return this._cache;

    } catch(e) {
      this._cache = {
        recordingStatusMap: {},
        winnersMap: {},
        dicePoints: {},
        lastWeekWinner: null,
        lastResetWeek: null,
        scheduled_alarms: {}
      };
      this._cacheInitialized = true;
      this._restored = true;
      return this._cache;
    } finally {
      this._cacheLoading = false;
      this._lock.release(lockKey);
    }
  }

  async _ensureCacheInitialized() {
    if (this._cacheInitialized && this._cache) {
      return this._cache;
    }
    return await this.loadAllData();
  }

  async _save(key, value) {
    const lockKey = `save_${key}`;
    if (!this._lock.acquire(lockKey, 5000)) return;
    
    try {
      if (value === null || value === undefined || 
          (typeof value === 'object' && Object.keys(value).length === 0) ||
          (Array.isArray(value) && value.length === 0)) {
        await this.db
          .prepare(`DELETE FROM ${TABLE_NAME} WHERE key = ?`)
          .bind(key)
          .run();
        return;
      }
      
      await this.db
        .prepare(`INSERT OR REPLACE INTO ${TABLE_NAME} (key, value) VALUES (?, ?)`)
        .bind(key, JSON.stringify(value))
        .run();
    } catch(e) {
      // Silent
    } finally {
      this._lock.release(lockKey);
    }
  }

  async getRecordingStatus(room) {
    await this._ensureCacheInitialized();
    return this._cache.recordingStatusMap[room] === true;
  }

  async setRecordingStatus(room, enabled) {
    await this._ensureCacheInitialized();
    if (enabled) {
      this._cache.recordingStatusMap[room] = true;
    } else {
      delete this._cache.recordingStatusMap[room];
    }
    await this._save('recordingStatusMap', this._cache.recordingStatusMap);
    return true;
  }

  async getWinners(room) {
    await this._ensureCacheInitialized();
    return this._cache.winnersMap[room] || {};
  }

  async setWinners(room, winners) {
    await this._ensureCacheInitialized();
    if (winners && Object.keys(winners).length > 0) {
      this._cache.winnersMap[room] = winners;
    } else {
      delete this._cache.winnersMap[room];
    }
    await this._save('winnersMap', this._cache.winnersMap);
    return true;
  }

  async addWinner(room, username) {
    await this._ensureCacheInitialized();
    const lockKey = `winner_${room}_${username}`;
    if (!this._lock.acquire(lockKey, 5000)) return false;
    
    try {
      const winners = await this.getWinners(room);
      let count = parseInt(String(winners[username] || "0").replace("x", "")) || 0;
      winners[username] = (count + 1) + "x";
      await this.setWinners(room, winners);
      return true;
    } finally {
      this._lock.release(lockKey);
    }
  }

  async deleteAllWinners(room) {
    await this._ensureCacheInitialized();
    delete this._cache.winnersMap[room];
    await this._save('winnersMap', this._cache.winnersMap);
    return true;
  }

  async getDicePoints() {
    await this._ensureCacheInitialized();
    return this._cache.dicePoints;
  }

  async setDicePoints(points) {
    await this._ensureCacheInitialized();
    const cleanPoints = {};
    for (const [username, score] of Object.entries(points || {})) {
      if (username && typeof username === 'string') {
        const numericScore = typeof score === 'number' ? score : parseInt(score, 10) || 0;
        if (numericScore > 0) cleanPoints[username] = numericScore;
      }
    }
    this._cache.dicePoints = cleanPoints;
    await this._save('dicePoints', this._cache.dicePoints);
    return true;
  }

  async addDicePoint(username) {
    await this._ensureCacheInitialized();
    const lockKey = `dicepoint_${username}`;
    if (!this._lock.acquire(lockKey, 5000)) return null;
    
    try {
      const points = await this.getDicePoints();
      points[username] = (points[username] || 0) + 1;
      await this.setDicePoints(points);
      return points;
    } finally {
      this._lock.release(lockKey);
    }
  }

  async resetDicePoints() {
    await this._ensureCacheInitialized();
    this._cache.dicePoints = {};
    await this._save('dicePoints', this._cache.dicePoints);
    return true;
  }

  async getLeaderboard(limit = 10) {
    await this._ensureCacheInitialized();
    const points = this._cache.dicePoints;
    if (!points || Object.keys(points).length === 0) return [];
    const safeLimit = Math.min(Math.max(limit, CONSTANTS.MIN_LEADERBOARD_LIMIT), CONSTANTS.MAX_LEADERBOARD_LIMIT);
    const sorted = Object.entries(points).filter(([username, score]) => username && score > 0).sort((a, b) => b[1] - a[1]).slice(0, safeLimit);
    return sorted.map(([u, s]) => `${u}|${s}`);
  }

  async getLastWeekWinner() {
    await this._ensureCacheInitialized();
    return this._cache.lastWeekWinner;
  }

  async setLastWeekWinner(winnerData) {
    await this._ensureCacheInitialized();
    this._cache.lastWeekWinner = winnerData;
    await this._save('lastWeekWinner', this._cache.lastWeekWinner);
    return true;
  }

  async deleteLastWeekWinner() {
    await this._ensureCacheInitialized();
    this._cache.lastWeekWinner = null;
    await this._save('lastWeekWinner', this._cache.lastWeekWinner);
    return true;
  }

  async getLastResetWeek() {
    await this._ensureCacheInitialized();
    return this._cache.lastResetWeek;
  }

  async setLastResetWeek(week) {
    await this._ensureCacheInitialized();
    this._cache.lastResetWeek = week;
    await this._save('lastResetWeek', this._cache.lastResetWeek);
    return true;
  }

  async getAlarms() {
    await this._ensureCacheInitialized();
    return this._cache.scheduled_alarms;
  }

  async setAlarms(alarms) {
    await this._ensureCacheInitialized();
    this._cache.scheduled_alarms = alarms;
    await this._save('scheduled_alarms', this._cache.scheduled_alarms);
    return true;
  }

  async deleteAlarms() {
    await this._ensureCacheInitialized();
    this._cache.scheduled_alarms = {};
    await this._save('scheduled_alarms', this._cache.scheduled_alarms);
    return true;
  }

  getCurrentWeek() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const startOfYear = new Date(Date.UTC(year, 0, 1));
    const diff = now - startOfYear;
    const week = Math.ceil((diff / 86400000 + startOfYear.getUTCDay() + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  isRestored() {
    return this._restored;
  }
}

// ============================================================
// ALARM SCHEDULER - FIX RACE CONDITION
// ============================================================

class AlarmScheduler {
  constructor(db, ctx) {
    this.db = db;
    this.ctx = ctx;
    this.dataManager = new DataManager(db);
    this._alarms = new Map();
    this._lock = new AtomicLock();
    this._timerManager = new TimerManager();
    this._isProcessing = false;
    this._version = Date.now();
  }

  async scheduleAlarms() {
    const lockKey = 'scheduleAlarms';
    if (!this._lock.acquire(lockKey, 10000)) return false;
    
    try {
      const now = new Date();
      const witaNow = this._toWITA(now);
      const currentTotal = witaNow.getHours() * 60 + witaNow.getMinutes();
      
      await this._clearAllAlarms();
      await this._scheduleWeeklyResetUTC();
      
      let currentSession = null;
      for (const session of QUIZ_SCHEDULE.SESSIONS) {
        const startTotal = parseTime(session.start);
        const endTotal = parseTime(session.end);
        if (currentTotal >= startTotal && currentTotal < endTotal) {
          currentSession = { ...session, startTotal, endTotal, status: 'active' };
          break;
        }
      }
      
      if (currentSession) {
        const endDelay = (currentSession.endTotal - currentTotal) * 60 * 1000;
        if (endDelay > 0) {
          await this._scheduleAlarm('dice_session_end', endDelay);
        }
        await this._scheduleAlarm('dice_session_start_immediate', 1000);
        return true;
      }
      
      let nextSession = null;
      let minDiff = Infinity;
      for (const session of QUIZ_SCHEDULE.SESSIONS) {
        const startTotal = parseTime(session.start);
        let diff = startTotal - currentTotal;
        if (diff < 0) diff += 24 * 60;
        if (diff < minDiff) {
          minDiff = diff;
          nextSession = { ...session, startTotal, status: 'upcoming' };
        }
      }
      
      if (nextSession) {
        let startDelay = minDiff * 60 * 1000;
        if (startDelay < 0) startDelay = 0;
        await this._scheduleAlarm('dice_session_start', startDelay);
        const endTotal = parseTime(nextSession.end);
        const endDelay = (endTotal - currentTotal) * 60 * 1000;
        if (endDelay > 0) await this._scheduleAlarm('dice_session_end', endDelay);
      }
      return true;
    } catch(e) {
      return false;
    } finally {
      this._lock.release(lockKey);
    }
  }

  async _scheduleWeeklyResetUTC() {
    try {
      const now = new Date();
      const currentDay = now.getUTCDay();
      const currentHour = now.getUTCHours();
      const currentMinutes = now.getUTCMinutes();
      const currentSeconds = now.getUTCSeconds();
      let daysUntilReset = CONSTANTS.WEEKLY_RESET_DAY - currentDay;
      if (daysUntilReset < 0) daysUntilReset += 7;
      if (daysUntilReset === 0 && (currentHour > 0 || currentMinutes > 0 || currentSeconds > 0)) daysUntilReset = 7;
      const resetTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilReset, 0, 0, 0, 0));
      const delayMs = resetTime.getTime() - now.getTime();
      if (delayMs > 0) await this._scheduleAlarm(CONSTANTS.WEEKLY_RESET_ALARM, delayMs);
      return true;
    } catch(e) {
      return false;
    }
  }

  async _scheduleAlarm(name, delayMs) {
    const lockKey = `alarm_${name}`;
    if (!this._lock.acquire(lockKey, 5000)) return false;
    
    try {
      if (delayMs < 1000) delayMs = 1000;
      const scheduledAt = Date.now() + delayMs;
      const alarm = { name, scheduledAt, delayMs, timestamp: Date.now(), version: this._version };
      this._alarms.set(name, alarm);
      await this.dataManager.setAlarms(Object.fromEntries(this._alarms));
      await this._scheduleNearestAlarm();
      return true;
    } finally {
      this._lock.release(lockKey);
    }
  }

  async _scheduleNearestAlarm() {
    try {
      let nearestTime = Infinity;
      let nearestName = null;
      for (const [name, alarm] of this._alarms) {
        const time = alarm.scheduledAt || alarm.timestamp + alarm.delayMs;
        if (time < nearestTime && time > Date.now()) {
          nearestTime = time;
          nearestName = name;
        }
      }
      if (nearestTime < Infinity) {
        const delay = nearestTime - Date.now();
        if (delay > 0) {
          await this.ctx.storage.setAlarm(Date.now() + delay);
        }
      }
    } catch(e) {}
  }

  async _clearAllAlarms() {
    const lockKey = 'clearAllAlarms';
    if (!this._lock.acquire(lockKey, 5000)) return;
    
    try {
      this._alarms.clear();
      await this.dataManager.deleteAlarms();
      await this.ctx.storage.deleteAlarm();
    } finally {
      this._lock.release(lockKey);
    }
  }

  async getPendingAlarms() {
    if (this._isProcessing) return [];
    this._isProcessing = true;
    
    try {
      await this.restoreAlarms();
      const pending = [];
      const now = Date.now();
      const expired = [];
      const currentVersion = this._version;
      
      for (const [name, alarm] of this._alarms) {
        if (alarm.version !== currentVersion) {
          expired.push(name);
          continue;
        }
        const scheduledTime = alarm.scheduledAt || alarm.timestamp + alarm.delayMs;
        if (scheduledTime <= now) {
          pending.push({ ...alarm, name });
          expired.push(name);
        }
      }
      
      for (const name of expired) {
        this._alarms.delete(name);
      }
      
      if (expired.length > 0) {
        await this.dataManager.setAlarms(Object.fromEntries(this._alarms));
      }
      return pending;
    } catch(e) {
      return [];
    } finally {
      this._isProcessing = false;
    }
  }

  async processAlarm(name) {
    const lockKey = `process_${name}`;
    if (!this._lock.acquire(lockKey, 5000)) return null;
    
    try {
      const alarm = this._alarms.get(name);
      if (!alarm) {
        await this.restoreAlarms();
        const restored = this._alarms.get(name);
        if (!restored) return null;
      }
      this._alarms.delete(name);
      await this.dataManager.setAlarms(Object.fromEntries(this._alarms));
      await this._scheduleNearestAlarm();
      return alarm || this._alarms.get(name);
    } finally {
      this._lock.release(lockKey);
    }
  }

  async restoreAlarms() {
    const lockKey = 'restoreAlarms';
    if (!this._lock.acquire(lockKey, 5000)) return false;
    
    try {
      const stored = await this.dataManager.getAlarms();
      if (stored && typeof stored === 'object') {
        this._alarms.clear();
        for (const [name, data] of Object.entries(stored)) {
          this._alarms.set(name, data);
        }
        await this._scheduleNearestAlarm();
        return true;
      }
      return false;
    } catch(e) {
      return false;
    } finally {
      this._lock.release(lockKey);
    }
  }

  _toWITA(date) {
    const wita = new Date(date);
    wita.setHours(wita.getHours() + QUIZ_SCHEDULE.TIMEZONE_OFFSET);
    return wita;
  }

  isDiceTime(date) {
    const wita = this._toWITA(date || new Date());
    const currentTotal = wita.getHours() * 60 + wita.getMinutes();
    for (const session of QUIZ_SCHEDULE.SESSIONS) {
      const startTotal = parseTime(session.start);
      const endTotal = parseTime(session.end);
      if (currentTotal >= startTotal && currentTotal < endTotal) return true;
    }
    return false;
  }

  getNextSessionInfo() {
    const wita = this._toWITA(new Date());
    const currentTotal = wita.getHours() * 60 + wita.getMinutes();
    let minDiff = Infinity;
    let nextSession = null;
    
    for (const session of QUIZ_SCHEDULE.SESSIONS) {
      const startTotal = parseTime(session.start);
      let diff = startTotal - currentTotal;
      if (diff < 0) diff += 24 * 60;
      if (diff < minDiff) {
        minDiff = diff;
        nextSession = { ...session, diff: minDiff };
      }
    }
    
    return nextSession;
  }

  async cleanup() {
    this._version = Date.now();
    this._timerManager.clearAll();
    await this._clearAllAlarms();
    this._lock.clearAll();
  }
}

// ============================================================
// GAME SERVER - FULL CLASS (ALL RACE CONDITIONS FIXED)
// ============================================================

export class GameServer {
  constructor(state, env) {
    try {
      this.state = state;
      this.env = env;
      this.ctx = state;
      this.closing = false;
      this.isDestroyed = false;
      this._wsIdCounter = 0;
      this._restored = false;
      this._initialized = false;
      
      // ===== TIMER MANAGERS =====
      this._mainTimerManager = new TimerManager();
      this._diceTimerManager = new TimerManager();
      this._gameTimerManager = new TimerManager();
      this._tieTimerManager = new TimerManager();
      this._alarmTimerManager = new TimerManager();
      
      // ===== ATOMIC LOCKS =====
      this._diceLock = new AtomicLock();
      this._tieLock = new AtomicLock();
      this._gameLock = new AtomicLock();
      this._evaluationLock = new AtomicLock();
      this._drawLock = new AtomicLock();
      this._registrationLock = new AtomicLock();
      this._wsLock = new AtomicLock();
      this._stateLock = new AtomicLock();
      
      // ===== VERSIONED TIMERS =====
      this._diceVersionedTimer = new VersionedTimer();
      this._tieVersionedTimer = new VersionedTimer();
      this._gameVersionedTimer = new VersionedTimer();
      
      // ===== DB & DATA =====
      this.db = env.DB;
      this.dataManager = new DataManager(this.db);
      this.alarmScheduler = new AlarmScheduler(this.db, this.ctx);
      this.alarmScheduler.ctx = this;
      
      // ===== GAME STATE =====
      this.activeGames = new Map();
      this.wsMap = new Map();
      this.wsClients = new Map();
      this.clientRooms = new Map();
      this.userConnections = new Map();
      this._eventQueue = [];
      this._lastNotifTime = {};
      this._lastWinnerRequestTime = new Map();
      
      // ===== DICE STATE =====
      this.currentDiceRoll = null;
      this._diceRound = 0;
      this._diceSessionActive = false;
      this._diceSessionEnded = false;
      this._diceGameStarted = false;
      this._diceStartedByUser = false;
      this._diceLocked = false;
      this._isShowingDice = false;
      this._diceTimeUpCooldown = false;
      this._diceQuestionStartTime = null;
      this._diceStartTime = null;
      this._canSubmitDiceAnswer = false;
      this.diceAnswered = new Set();
      this._playerAnswers = new Map();
      this.diceHasWinner = false;
      this.diceWinner = null;
      this.diceEndNotified = false;
      this._diceNotifiedFlags = { 20: false, 10: false, 5: false, timeup: false };
      this._lastNotificationKey = "";
      this._lastNotificationTime = 0;
      this._lastSentRemaining = -1;
      this._diceOutOfTimeShown = false;
      this._diceTaskRunning = false;
      this._diceLoopCounter = 0;
      this._maxDiceLoops = 10;
      this._pendingDiceStart = false;
      this._diceRoundActive = false;
      this._diceVersion = 0;
      
      // ===== TIE BREAKER STATE =====
      this._tieBreakers = new Map();
      this._tieRound = 0;
      this._tiePlayers = [];
      this._tieAnswers = new Map();
      this._tieActive = false;
      this._tieLocked = false;
      this._tieVersion = 0;
      this._activeTieRoundId = null;
      this._tieProcessing = false;
      
      // ===== BROADCAST STATE =====
      this._broadcastedCountdown = new Map();
      
      // ===== RATE LIMITING =====
      this._requestCount = 0;
      this._lastResetTime = Date.now();
      this._circuitOpen = false;
      this._errorCount = 0;
      this._lastErrorReset = Date.now();
      this._reconnectAttempts = new Map();
      
      // ===== PROCESSING =====
      this._processingQueue = false;
      
      // ===== CONSTANTS =====
      this.DICE_ROOM = CONSTANTS.DICE_ROOM;
      
      // ===== RESTORE =====
      this._restoreAllState().then(() => {
        this._restored = true;
        this._initialized = true;
      }).catch(() => {
        this._restored = true;
        this._initialized = true;
      });
      
    } catch(e) {
      this._restored = true;
      this._initialized = true;
    }
  }

  // ============================================================
  // RESTORE ALL STATE
  // ============================================================
  
  async _restoreAllState() {
    const lockKey = 'restoreAllState';
    if (!this._stateLock.acquire(lockKey, 30000)) return;
    
    try {
      await this.dataManager.init();
      await this.dataManager.loadAllData();
      await this.alarmScheduler.restoreAlarms();
      await this.alarmScheduler.scheduleAlarms();
      await this._checkAndForceResetIfMondayUTC();
      await this._restoreWebSockets();
      this._initialized = true;
      this._syncAllRooms();
      
      const isDiceTime = this.alarmScheduler.isDiceTime();
      if (isDiceTime) {
        this._diceSessionActive = true;
        this._diceSessionEnded = false;
        this._diceGameStarted = false;
        const clients = this.wsClients?.get(CONSTANTS.DICE_ROOM);
        if (clients && clients.size > 0) {
          this._startDiceGameIfNotStarted();
        }
      } else {
        this._diceSessionActive = false;
        this._diceSessionEnded = true;
        this._diceGameStarted = false;
      }
      
      if (!this.closing && !this.isDestroyed) {
        this.ctx.storage.setAlarm(Date.now() + 60000);
      }
    } catch(e) {
      throw e;
    } finally {
      this._stateLock.release(lockKey);
    }
  }

  async _restoreWebSockets() {
    const lockKey = 'restoreWebSockets';
    if (!this._wsLock.acquire(lockKey, 10000)) return;
    
    try {
      const webSockets = this.ctx.getWebSockets();
      for (const ws of webSockets) {
        try {
          const attachment = ws.deserializeAttachment();
          if (attachment && attachment.username && attachment.room) {
            ws.username = attachment.username;
            ws.room = attachment.room;
            ws.roomname = attachment.room;
            ws._wsId = attachment.wsId || ++this._wsIdCounter;
            ws._closing = false;
            const roomClients = this.wsClients.get(attachment.room);
            if (roomClients) {
              roomClients.add(ws._wsId);
            } else {
              this.wsClients.set(attachment.room, new Set([ws._wsId]));
            }
            this.wsMap.set(ws._wsId, ws);
            this.clientRooms.set(ws._wsId, attachment.room);
            let conn = this.userConnections.get(attachment.username);
            if (!conn) {
              conn = { wsId: ws._wsId, ws: ws, room: attachment.room, timestamp: Date.now() };
              this.userConnections.set(attachment.username, conn);
            }
            
            if (attachment.room === CONSTANTS.DICE_ROOM) {
              this._sendDiceRoomState(ws);
            }
          }
        } catch(e) {}
      }
    } finally {
      this._wsLock.release(lockKey);
    }
  }

  _syncAllRooms() {
    const lockKey = 'syncAllRooms';
    if (!this._wsLock.acquire(lockKey, 5000)) return;
    
    try {
      const roomMap = new Map();
      const clientRoomMap = new Map();
      for (const [wsId, ws] of this.wsMap) {
        if (ws && ws.room && ws.readyState === 1 && !ws._closing) {
          const room = ws.room;
          if (!roomMap.has(room)) roomMap.set(room, new Set());
          roomMap.get(room).add(wsId);
          clientRoomMap.set(wsId, room);
        }
      }
      this.wsClients.clear();
      for (const [room, wsIds] of roomMap) {
        this.wsClients.set(room, wsIds);
      }
      this.clientRooms.clear();
      for (const [wsId, room] of clientRoomMap) {
        this.clientRooms.set(wsId, room);
      }
    } finally {
      this._wsLock.release(lockKey);
    }
  }

  // ============================================================
  // DICE ROOM STATE
  // ============================================================
  
  _sendDiceRoomState(ws) {
    try {
      if (!ws || ws.readyState !== 1) return;
      
      const wsId = ws._wsId;
      if (!wsId) return;
      
      const isDiceTime = this.alarmScheduler.isDiceTime();
      
      if (isDiceTime) {
        const isGameRunning = this.currentDiceRoll && this._canSubmitDiceAnswer;
        this._safeSend(ws, ["diceSessionStatus", {
          sessionActive: true,
          isDiceTime: true,
          gameRunning: !!isGameRunning,
          round: this._diceRound || 0
        }]);
        
        if (!this._diceGameStarted && !this.currentDiceRoll && !this._diceLocked) {
          this._startDiceGameIfNotStarted();
        }
        
        if (isGameRunning) {
          this._safeSend(ws, ["diceRoll", {
            value: this.currentDiceRoll.value,
            timestamp: this.currentDiceRoll.timestamp,
            answerTime: 20,
            canAnswerNow: true,
            round: this._diceRound
          }]);
        }
      } else {
        const nextSession = this.alarmScheduler.getNextSessionInfo();
        if (nextSession) {
          const hours = Math.floor(nextSession.diff / 60);
          const minutes = Math.floor(nextSession.diff % 60);
          let timeText = "";
          if (hours > 0 && minutes > 0) timeText = hours + "h " + minutes + "m";
          else if (hours > 0) timeText = hours + "h";
          else if (minutes > 0) timeText = minutes + "m";
          else timeText = "less than a minute";
          
          this._safeSend(ws, ["diceSessionStatus", {
            sessionActive: false,
            isDiceTime: false,
            nextSessionIn: nextSession.diff,
            nextSessionText: timeText
          }]);
          
          const broadcastKey = `countdown_${wsId}`;
          const lastBroadcast = this._broadcastedCountdown.get(broadcastKey) || 0;
          const now = Date.now();
          
          if (now - lastBroadcast > 30000) {
            this._broadcastedCountdown.set(broadcastKey, now);
            
            this._mainTimerManager.setTimeout(() => {
              if (ws && ws.readyState === 1 && !ws._closing) {
                const currentRoom = ws.room || ws.roomname || this.clientRooms.get(wsId);
                if (currentRoom === CONSTANTS.DICE_ROOM) {
                  this._safeSend(ws, ["diceNotification", "Next dice game in: " + timeText]);
                }
              }
            }, CONSTANTS.DICE_BROADCAST_DELAY_MS || 5000, this);
          }
        }
      }
    } catch(e) {}
  }

  // ============================================================
  // START DICE GAME - FIXED RACE CONDITION
  // ============================================================
  
  _startDiceGameIfNotStarted() {
    // Gunakan lock untuk mencegah multiple calls
    if (!this._diceLock.acquire('diceStart', 5000)) {
      // Jika lock tidak bisa diacquire, tandai sebagai pending
      this._pendingDiceStart = true;
      return;
    }
    
    try {
      // Double check setelah lock
      if (this._diceGameStarted) {
        return;
      }
      
      if (!this.alarmScheduler.isDiceTime()) {
        return;
      }
      
      if (this.currentDiceRoll || this._isShowingDice || this._diceLocked) {
        return;
      }
      
      if (this._diceTimeUpCooldown) {
        this._pendingDiceStart = true;
        return;
      }
      
      const clients = this.wsClients?.get(CONSTANTS.DICE_ROOM);
      if (!clients || clients.size === 0) {
        return;
      }
      
      // Increment version untuk invalidate timer lama
      this._diceVersion++;
      this._diceGameStarted = true;
      this._diceSessionActive = true;
      this._diceSessionEnded = false;
      this._diceStartedByUser = true;
      this._diceRoundActive = true;
      
      this._startDiceFast();
      
    } finally {
      this._diceLock.release('diceStart');
    }
  }

  // ============================================================
  // START DICE FAST - FIXED RACE CONDITION
  // ============================================================
  
  _startDiceFast() {
    // Gunakan lock untuk mencegah overlap
    if (!this._diceLock.acquire('diceFast', 10000)) {
      return;
    }
    
    try {
      // Double check
      if (this._diceLocked || this.currentDiceRoll || this._isShowingDice) {
        return;
      }
      
      if (this._diceTimeUpCooldown) {
        return;
      }
      
      const clients = this.wsClients?.get(CONSTANTS.DICE_ROOM);
      if (!clients || clients.size === 0) {
        this._diceLocked = false;
        this._isShowingDice = false;
        this._diceGameStarted = false;
        return;
      }
      
      if (!this._diceSessionActive || this._diceSessionEnded) {
        this._diceLocked = false;
        this._isShowingDice = false;
        this._diceGameStarted = false;
        return;
      }
      
      // Increment loop counter
      this._diceLoopCounter = (this._diceLoopCounter || 0) + 1;
      if (this._diceLoopCounter > this._maxDiceLoops) {
        this._diceLoopCounter = 0;
        this._diceLocked = false;
        this._isShowingDice = false;
        return;
      }
      
      // Set state
      this._diceLocked = true;
      this._isShowingDice = true;
      this._diceGameStarted = true;
      this._diceRoundActive = true;
      
      // Generate dice value
      const value = Math.floor(Math.random() * 6) + 1;
      this._diceRound = (this._diceRound || 0) + 1;
      this.currentDiceRoll = { 
        value, 
        timestamp: Date.now(), 
        round: this._diceRound,
        version: this._diceVersion
      };
      this._diceStartTime = Date.now();
      this._diceQuestionStartTime = Date.now();
      this._canSubmitDiceAnswer = true;
      this.diceAnswered = new Set();
      this._playerAnswers = new Map();
      this.diceHasWinner = false;
      this.diceWinner = null;
      this.diceEndNotified = false;
      this._diceOutOfTimeShown = false;
      
      // Broadcast
      this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceRoll", { 
        value, timestamp: Date.now(), answerTime: 20, canAnswerNow: true, round: this._diceRound
      }]);
      this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", "clik draw"]);
      
      this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceSessionStatus", {
        sessionActive: true,
        isDiceTime: true,
        gameRunning: true,
        round: this._diceRound
      }]);
      
      // ===== CLEAR OLD NOTIFICATION TIMERS =====
      this._diceTimerManager.clearAll();
      
      // ===== SETUP NOTIFICATION TIMERS WITH VERSION CHECK =====
      const currentVersion = this._diceVersion;
      const notifications = [
        { delay: 5000, message: "15s remaining" },
        { delay: 10000, message: "10s remaining" },
        { delay: 15000, message: "5s remaining" },
        { delay: 17000, message: "3s remaining" }
      ];
      
      for (const notif of notifications) {
        this._diceTimerManager.setTimeout(() => {
          // Cek versi untuk memastikan timer masih valid
          if (this._diceVersion !== currentVersion) return;
          if (!this._diceRoundActive) return;
          if (this.isDestroyed || this.closing) return;
          this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", notif.message]);
        }, notif.delay, this);
      }
      
      // ===== MAIN TIMER =====
      this._diceTimerManager.setTimeout(() => {
        // Cek versi
        if (this._diceVersion !== currentVersion) return;
        if (!this._diceRoundActive) return;
        this._endDiceRound();
      }, 20000, this);
      
    } catch(e) {
      this._diceLocked = false;
      this._isShowingDice = false;
      this._diceGameStarted = false;
      this._diceRoundActive = false;
    } finally {
      this._diceLock.release('diceFast');
    }
  }

  // ============================================================
  // END DICE ROUND - FIXED RACE CONDITION
  // ============================================================
  
  async _endDiceRound() {
    // Gunakan lock untuk mencegah multiple calls
    if (!this._diceLock.acquire('endDice', 10000)) {
      return;
    }
    
    try {
      // Double check
      if (!this._diceRoundActive) return;
      if (this.isDestroyed || this.closing) return;
      
      // Mark as inactive
      this._diceRoundActive = false;
      this._canSubmitDiceAnswer = false;
      this._isShowingDice = false;
      
      // Clear all dice timers
      this._diceTimerManager.clearAll();
      
      // Get current state
      const diceValue = this.currentDiceRoll?.value;
      const roundNumber = this._diceRound || 1;
      
      // Find correct players
      const correctPlayers = [];
      for (const player of this.diceAnswered) {
        if (this._playerAnswers.get(player) === diceValue) {
          correctPlayers.push(player);
        }
      }
      
      // Process results
      if (correctPlayers.length === 0) {
        this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNoWinner", {
          message: "No winner", value: diceValue, round: roundNumber
        }]);
      } else if (correctPlayers.length === 1) {
        const winner = correctPlayers[0];
        try {
          const points = await this.dataManager.addDicePoint(winner);
          this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceWinner", {
            username: winner, totalPoints: points[winner] || 0, diceValue: diceValue, round: roundNumber
          }]);
        } catch(e) {
          this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceWinner", {
            username: winner, totalPoints: 0, diceValue: diceValue, round: roundNumber
          }]);
        }
      } else if (correctPlayers.length > 1 && !this._tieActive) {
        // Start tie breaker
        this.currentDiceRoll = null;
        this._diceLocked = false;
        this._isShowingDice = false;
        await this._startTieBreaker(CONSTANTS.DICE_ROOM, correctPlayers);
        this._diceGameStarted = false;
        return;
      }
      
      // Reset state
      this.currentDiceRoll = null;
      this._diceLocked = false;
      this._diceGameStarted = false;
      this._diceTimeUpCooldown = true;
      
      this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceSessionStatus", {
        sessionActive: this._diceSessionActive,
        isDiceTime: this.alarmScheduler.isDiceTime(),
        gameRunning: false,
        round: this._diceRound
      }]);
      
      // Start cooldown
      this._diceTimerManager.setTimeout(() => {
        this._diceTimeUpCooldown = false;
        this._diceNotifiedFlags = { 20: false, 10: false, 5: false, timeup: false };
        this._lastSentRemaining = -1;
        this._diceLoopCounter = 0;
        this._diceGameStarted = false;
        
        // Check if should start next round
        if (this._diceSessionActive && !this._diceSessionEnded) {
          const clients = this.wsClients?.get(CONSTANTS.DICE_ROOM);
          if (clients && clients.size > 0) {
            if (!this.currentDiceRoll && !this._isShowingDice && !this._diceLocked) {
              this._startDiceGameIfNotStarted();
            }
          }
        }
        
        // Process pending start
        if (this._pendingDiceStart) {
          this._pendingDiceStart = false;
          this._startDiceGameIfNotStarted();
        }
      }, 15000, this);
      
    } catch(e) {
      this._diceLocked = false;
      this._isShowingDice = false;
      this._diceGameStarted = false;
      this._diceRoundActive = false;
    } finally {
      this._diceLock.release('endDice');
    }
  }

  // ============================================================
  // TIE BREAKER - FIXED RACE CONDITION
  // ============================================================

  async _startTieBreaker(room, players) {
    // Gunakan lock untuk mencegah multiple tie breaker
    if (!this._tieLock.acquire('tieStart', 10000)) {
      return;
    }
    
    try {
      if (!players || players.length < 2 || this._tieActive) {
        return;
      }
      
      this._tieActive = true;
      this._tieLocked = true;
      this._tieRound = 0;
      this._tiePlayers = [...players];
      this._tieAnswers = new Map();
      this._tieVersion++;
      
      const id = `tie_${Date.now()}_${this._tieVersion}`;
      this._tieBreakers.set(id, { 
        players, 
        round: 0, 
        winner: null, 
        status: 'waiting',
        version: this._tieVersion
      });
      
      await this._runTieRound(room, id, players);
    } finally {
      this._tieLock.release('tieStart');
    }
  }

  async _runTieRound(room, id, players) {
    const data = this._tieBreakers.get(id);
    if (!data) return;
    if (data.version !== this._tieVersion) return;
    
    // Gunakan lock per round
    const roundLockKey = `tieRound_${id}`;
    if (!this._tieLock.acquire(roundLockKey, 15000)) {
      return;
    }
    
    try {
      // Clear old timers
      this._tieTimerManager.clearAll();
      this._tieVersionedTimer.clear();
      
      this._tieRound++;
      data.round = this._tieRound;
      data.status = 'running';
      data.players = players;
      this._tiePlayers = [...players];
      this._tieAnswers = new Map();
      this._diceQuestionStartTime = Date.now();
      this._canSubmitDiceAnswer = true;
      this.diceAnswered = new Set();
      this._playerAnswers = new Map();
      this._isShowingDice = true;
      this.diceHasWinner = false;
      this.diceWinner = null;
      
      this._activeTieRoundId = `tie_round_${this._tieRound}_${Date.now()}`;
      
      this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", 
        `Tie Round ${this._tieRound}: ${players.join(', ')}`
      ]);
      
      const timeLimit = CONSTANTS.TIE_BREAKER_TIME_LIMIT || 20;
      let isProcessed = false;
      
      // Notification timers
      const notifications = [
        { delay: 5000, message: "15s remaining" },
        { delay: 10000, message: "10s remaining" },
        { delay: 15000, message: "5s remaining" },
        { delay: 17000, message: "3s remaining" }
      ];
      
      for (const notif of notifications) {
        this._tieTimerManager.setTimeout(() => {
          if (this._activeTieRoundId !== `tie_round_${this._tieRound}_${data.version}`) return;
          if (isProcessed) return;
          this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", notif.message]);
        }, notif.delay, this);
      }
      
      // Main timer
      this._tieTimerManager.setTimeout(() => {
        if (isProcessed) return;
        if (this._activeTieRoundId !== `tie_round_${this._tieRound}_${data.version}`) return;
        
        isProcessed = true;
        this._canSubmitDiceAnswer = false;
        this._isShowingDice = false;
        this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", "TIME UP"]);
        this._tieTimerManager.clearAll();
        
        const tieId = this._getActiveTieBreakerId();
        if (tieId) {
          this._processTieResults(room, tieId, players);
        } else {
          this._resetTieBreakerState(null);
          this._startCooldownAfterTieBreaker();
        }
      }, (timeLimit * 1000) + 2000, this);
      
    } finally {
      this._tieLock.release(roundLockKey);
    }
  }

  async _processTieResults(room, id, players) {
    // Prevent multiple processing
    if (this._tieProcessing) return;
    this._tieProcessing = true;
    
    const lockKey = `processTie_${id}`;
    if (!this._tieLock.acquire(lockKey, 10000)) {
      this._tieProcessing = false;
      return;
    }
    
    try {
      const data = this._tieBreakers.get(id);
      if (!data) {
        this._tieProcessing = false;
        return;
      }
      
      // Check version
      if (data.version !== this._tieVersion) {
        this._tieProcessing = false;
        return;
      }
      
      // Collect answers
      const entries = [];
      let answeredCount = 0;
      let highest = 0;
      let highestPlayers = [];
      
      for (const player of players) {
        const answer = this._tieAnswers.get(player);
        if (answer !== undefined && answer >= 1 && answer <= 6) {
          answeredCount++;
          entries.push({ player, answer });
          if (answer > highest) { 
            highest = answer; 
            highestPlayers = [player]; 
          } else if (answer === highest) { 
            highestPlayers.push(player); 
          }
        }
      }
      
      // No one answered
      if (answeredCount === 0) {
        this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", 
          `No one answered in Round ${this._tieRound} - Tie breaker ended`
        ]);
        this._resetTieBreakerState(id);
        this._startCooldownAfterTieBreaker();
        this._tieProcessing = false;
        return;
      }
      
      // Only one answered
      if (answeredCount === 1) {
        const winner = entries[0].player;
        const answer = entries[0].answer;
        
        this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", 
          `${winner} answered with ${answer} - Auto win!`
        ]);
        
        try {
          const points = await this.dataManager.addDicePoint(winner);
          this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceWinner", {
            username: winner,
            totalPoints: points[winner] || 0,
            diceValue: answer,
            round: this._diceRound || 1,
            isTieBreaker: true,
            tieBreakerRound: this._tieRound,
            finalWinner: true,
            totalTieRounds: this._tieRound
          }]);
        } catch(e) {
          this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceWinner", {
            username: winner,
            totalPoints: 0,
            diceValue: answer,
            round: this._diceRound || 1,
            isTieBreaker: true,
            tieBreakerRound: this._tieRound,
            finalWinner: true,
            totalTieRounds: this._tieRound
          }]);
        }
        this._resetTieBreakerState(id);
        this._startCooldownAfterTieBreaker();
        this._tieProcessing = false;
        return;
      }
      
      // All answered same
      const allSame = entries.every(e => e.answer === entries[0].answer);
      if (allSame) {
        this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", 
          `All answered same value: ${entries[0].answer} - Tie again!`
        ]);
        const allPlayers = entries.map(e => e.player);
        this._tiePlayers = allPlayers;
        this._tieAnswers = new Map();
        data.players = allPlayers;
        data.status = 'waiting';
        
        this._tieVersionedTimer.setTimeout(async () => {
          if (this._tieActive && this._tiePlayers.length > 1) {
            await this._runTieRound(room, id, this._tiePlayers);
          } else if (this._tiePlayers.length === 1) {
            await this._processSingleWinner(room, id, this._tiePlayers[0]);
          } else {
            this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", "No players remaining"]);
            this._resetTieBreakerState(id);
            this._startCooldownAfterTieBreaker();
          }
        }, 3000);
        this._tieProcessing = false;
        return;
      }
      
      // One player has highest
      if (highestPlayers.length === 1) {
        const winner = highestPlayers[0];
        
        this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", 
          `${winner} wins with highest value: ${highest}`
        ]);
        
        try {
          const points = await this.dataManager.addDicePoint(winner);
          this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceWinner", {
            username: winner,
            totalPoints: points[winner] || 0,
            diceValue: highest,
            round: this._diceRound || 1,
            isTieBreaker: true,
            tieBreakerRound: this._tieRound,
            finalWinner: true,
            totalTieRounds: this._tieRound
          }]);
        } catch(e) {
          this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceWinner", {
            username: winner,
            totalPoints: 0,
            diceValue: highest,
            round: this._diceRound || 1,
            isTieBreaker: true,
            tieBreakerRound: this._tieRound,
            finalWinner: true,
            totalTieRounds: this._tieRound
          }]);
        }
        this._resetTieBreakerState(id);
        this._startCooldownAfterTieBreaker();
        this._tieProcessing = false;
        return;
      }
      
      // Multiple players with same highest
      if (highestPlayers.length > 1) {
        this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", 
          `Tie again! Round ${this._tieRound + 1} between: ${highestPlayers.join(', ')}`
        ]);
        this._tiePlayers = highestPlayers;
        this._tieAnswers = new Map();
        data.players = highestPlayers;
        data.status = 'waiting';
        
        this._tieVersionedTimer.setTimeout(async () => {
          if (this._tieActive && this._tiePlayers.length > 1) {
            await this._runTieRound(room, id, this._tiePlayers);
          } else if (this._tiePlayers.length === 1) {
            await this._processSingleWinner(room, id, this._tiePlayers[0]);
          } else {
            this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", "No players remaining"]);
            this._resetTieBreakerState(id);
            this._startCooldownAfterTieBreaker();
          }
        }, 3000);
        this._tieProcessing = false;
        return;
      }
      
      this._resetTieBreakerState(id);
      this._startCooldownAfterTieBreaker();
      this._tieProcessing = false;
      
    } catch(e) {
      this._tieProcessing = false;
    } finally {
      this._tieLock.release(lockKey);
    }
  }

  async _processSingleWinner(room, id, winner) {
    if (!winner) { 
      this._resetTieBreakerState(id); 
      this._startCooldownAfterTieBreaker(); 
      return; 
    }
    
    try {
      const points = await this.dataManager.addDicePoint(winner);
      this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceWinner", {
        username: winner,
        totalPoints: points[winner] || 0,
        diceValue: 'auto',
        round: this._diceRound || 1,
        isTieBreaker: true,
        tieBreakerRound: this._tieRound,
        finalWinner: true,
        totalTieRounds: this._tieRound
      }]);
    } catch(e) {
      this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceWinner", {
        username: winner,
        totalPoints: 0,
        diceValue: 'auto',
        round: this._diceRound || 1,
        isTieBreaker: true,
        tieBreakerRound: this._tieRound,
        finalWinner: true,
        totalTieRounds: this._tieRound
      }]);
    }
    this._resetTieBreakerState(id);
    this._startCooldownAfterTieBreaker();
  }

  _startCooldownAfterTieBreaker() {
    this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", "wait 15s"]);
    this._diceTimeUpCooldown = true;
    
    this._diceTimerManager.setTimeout(() => {
      this._diceTimeUpCooldown = false;
      this._diceNotifiedFlags = { 20: false, 10: false, 5: false, timeup: false };
      this._lastSentRemaining = -1;
      this._lastNotificationKey = "";
      this._lastNotificationTime = 0;
      this._tieActive = false;
      this._tieLocked = false;
      this._tiePlayers = [];
      this._tieAnswers = new Map();
      this._tieRound = 0;
      this._diceLoopCounter = 0;
      this._diceGameStarted = false;
      this._tieProcessing = false;
      
      if (this._diceSessionActive && !this._diceSessionEnded) {
        const clients = this.wsClients?.get(CONSTANTS.DICE_ROOM);
        if (clients && clients.size > 0) {
          if (!this.currentDiceRoll && !this._isShowingDice && !this._diceLocked) {
            this._startDiceGameIfNotStarted();
          }
        }
      }
    }, CONSTANTS.TIE_BREAKER_COOLDOWN || 15000, this);
  }

  _resetTieBreakerState(id) {
    if (id) this._tieBreakers.delete(id);
    this._tieActive = false;
    this._tieLocked = false;
    this._tiePlayers = [];
    this._tieAnswers = new Map();
    this._tieRound = 0;
    this._canSubmitDiceAnswer = false;
    this._isShowingDice = false;
    this.currentDiceRoll = null;
    this.diceAnswered = new Set();
    this._playerAnswers = new Map();
    this.diceHasWinner = false;
    this.diceWinner = null;
    this._tieProcessing = false;
    this._activeTieRoundId = null;
    this._tieTimerManager.clearAll();
    this._tieVersionedTimer.clear();
  }

  _getActiveTieBreakerId() {
    for (const [id, data] of this._tieBreakers) {
      if (data.status === 'waiting' || data.status === 'running') {
        if (data.version === this._tieVersion) return id;
      }
    }
    return null;
  }

  // ============================================================
  // SUBMIT DICE ANSWER - FIXED RACE CONDITION
  // ============================================================
  
  async submitDiceAnswer(ws, username, guess) {
    try {
      if (!ws || !username) return;
      if (!this._canSubmitDiceAnswer) { 
        this._safeSend(ws, ["diceError", "Round ended"]); 
        return; 
      }
      
      // Check version
      if (!this.currentDiceRoll || this.currentDiceRoll.version !== this._diceVersion) {
        this._safeSend(ws, ["diceError", "Round expired"]);
        return;
      }
      
      if (this.diceAnswered.has(username)) { 
        this._safeSend(ws, ["diceError", "Already answered"]); 
        return; 
      }
      
      const guessValue = parseInt(guess, 10);
      if (isNaN(guessValue) || guessValue < 1 || guessValue > 6) {
        this._safeSend(ws, ["diceError", "invalid guess 1-6"]);
        return;
      }
      
      // ===== TIE BREAKER HANDLING =====
      if (this._tieActive) {
        if (!this._tiePlayers.includes(username)) {
          this._safeSend(ws, ["diceError", "You are not in tie breaker"]);
          return;
        }
        if (this._tieAnswers.has(username)) {
          this._safeSend(ws, ["diceError", "You already answered"]);
          return;
        }
        
        // Atomic add answer
        const tieLockKey = `tieAnswer_${username}`;
        if (!this._tieLock.acquire(tieLockKey, 5000)) {
          this._safeSend(ws, ["diceError", "Processing, please wait"]);
          return;
        }
        
        try {
          if (this._tieAnswers.has(username)) {
            this._safeSend(ws, ["diceError", "You already answered"]);
            return;
          }
          this._tieAnswers.set(username, guessValue);
          this.diceAnswered.add(username);
          this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceAnswer", {
            username, guess: guessValue, isTieBreaker: true, tieRound: this._tieRound
          }]);
          
          // Check if all answered
          if (this._tieAnswers.size === this._tiePlayers.length) {
            this._canSubmitDiceAnswer = false;
            this._isShowingDice = false;
            this._tieTimerManager.clearAll();
            const tieId = this._getActiveTieBreakerId();
            if (tieId) {
              this._tieVersionedTimer.setTimeout(async () => {
                await this._processTieResults(CONSTANTS.DICE_ROOM, tieId, this._tiePlayers);
              }, 500);
            } else {
              this._resetTieBreakerState(null);
              this._startCooldownAfterTieBreaker();
            }
          }
        } finally {
          this._tieLock.release(tieLockKey);
        }
        return;
      }
      
      // ===== NORMAL DICE =====
      if (!this.currentDiceRoll) { 
        this._safeSend(ws, ["diceError", "No active round"]); 
        return; 
      }
      
      const diceValue = this.currentDiceRoll.value;
      this._playerAnswers.set(username, guessValue);
      this.diceAnswered.add(username);
      this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceAnswer", {
        username, guess: guessValue, round: this._diceRound || 1
      }]);
      
      if (guessValue === diceValue && !this.diceHasWinner) {
        this.diceHasWinner = true;
        this.diceWinner = username;
      }
    } catch(e) {}
  }

  // ============================================================
  // GET ROOM USERS
  // ============================================================
  
  _getRoomUsers(room) {
    try {
      if (!room) return [];
      const users = [];
      let wsIds = this.wsClients.get(room);
      if (!wsIds || wsIds.size === 0) {
        wsIds = new Set();
        for (const [wsId, clientRoom] of this.clientRooms) {
          if (clientRoom === room) wsIds.add(wsId);
        }
        if (wsIds.size > 0) this.wsClients.set(room, wsIds);
      }
      if (wsIds && wsIds.size > 0) {
        const toRemove = [];
        for (const wsId of wsIds) {
          const ws = this.wsMap.get(wsId);
          if (ws && ws.readyState === 1 && !ws._closing) {
            users.push({ wsId, ws, username: ws.username || 'Anonymous' });
          } else {
            toRemove.push(wsId);
          }
        }
        for (const wsId of toRemove) {
          wsIds.delete(wsId);
          this.clientRooms.delete(wsId);
          this.wsMap.delete(wsId);
          for (const [username, conn] of this.userConnections) {
            if (conn.wsId === wsId) {
              this.userConnections.delete(username);
              break;
            }
          }
        }
        if (wsIds.size === 0) {
          this.wsClients.delete(room);
        } else {
          this.wsClients.set(room, wsIds);
        }
      }
      return users;
    } catch(e) { return []; }
  }

  // ============================================================
  // BROADCAST
  // ============================================================
  
  _broadcastToRoom(room, message) {
    try {
      if (this.closing || this.isDestroyed || !room || !message) return 0;
      const users = this._getRoomUsers(room);
      if (!users || users.length === 0) return 0;
      const msgStr = JSON.stringify(message);
      let sentCount = 0;
      const toRemove = [];
      for (const user of users) {
        const ws = user.ws;
        if (ws && ws.readyState === 1 && !ws._closing) {
          try {
            ws.send(msgStr);
            sentCount++;
          } catch(e) {
            toRemove.push(user.wsId);
          }
        } else {
          toRemove.push(user.wsId);
        }
      }
      if (toRemove.length > 0) {
        const clients = this.wsClients.get(room);
        if (clients) {
          for (const wsId of toRemove) {
            clients.delete(wsId);
            this.clientRooms.delete(wsId);
            this.wsMap.delete(wsId);
            for (const [username, conn] of this.userConnections) {
              if (conn.wsId === wsId) {
                this.userConnections.delete(username);
                break;
              }
            }
          }
          if (clients.size === 0) this.wsClients.delete(room);
        }
      }
      return sentCount;
    } catch(e) { return 0; }
  }

  _sendToUser(ws, message) {
    try {
      if (!ws || ws.readyState !== 1 || ws._closing) return false;
      ws.send(JSON.stringify(message));
      return true;
    } catch(e) { return false; }
  }

  // ============================================================
  // SEND CURRENT GAME STATE (LOWCARD)
  // ============================================================
  
  _sendCurrentGameState(ws, room) {
    try {
      if (!ws || !room) return;
      
      const game = this.activeGames.get(room);
      if (!game || !game._isActive || game._gameEnded) {
        this._sendToUser(ws, ["gameStatus", "false"]);
        return;
      }
      
      if (game._phase === 'registration' || game._state === 'registration') {
        this._sendToUser(ws, ["gameLowCardStart", game.betAmount]);
        this._sendToUser(ws, ["gameLowCardStartSuccess", game.hostName || game.hostId, game.betAmount]);
        
        const players = Array.from(game.players.keys()).filter(id => !id.startsWith('BOT_'));
        for (const player of players) {
          this._sendToUser(ws, ["gameLowCardJoin", player, game.betAmount]);
        }
        return;
      }
      
      if (game._phase === 'draw' || game._state === 'draw' || game._phase === 'evaluating' || game._state === 'evaluating') {
        const activePlayers = this._getActivePlayers(game);
        const playersList = activePlayers.map(p => p.name);
        this._sendToUser(ws, ["gameLowCardClosed", playersList]);
        this._sendToUser(ws, ["gameLowCardNextRound", game.round]);
        
        for (const [id, number] of game.numbers) {
          const name = game.players.get(id)?.name || id;
          const tanda = game.tanda.get(id) || "";
          this._sendToUser(ws, ["gameLowCardPlayerDraw", name, number, tanda]);
        }
        
        const elapsed = Date.now() - game._drawPhaseStart;
        const remaining = Math.max(0, 20000 - elapsed);
        if (remaining > 0) {
          const seconds = Math.ceil(remaining / 1000);
          this._sendToUser(ws, ["gameLowCardTimeLeft", seconds + "s"]);
        }
        
        if (game._isEvaluating || game.evaluationLocked) {
          this._sendToUser(ws, ["gameLowCardWait", "wait results"]);
        }
      }
    } catch(e) {}
  }

  _sendRoomStateToUser(ws, room) {
    try {
      if (!ws || ws.readyState !== 1) return;
      this.dataManager.getRecordingStatus(room).then(isRecording => {
        this._sendToUser(ws, ["recordingStatus", isRecording]);
      });
    } catch(e) {}
  }

  // ============================================================
  // WEEKLY RESET
  // ============================================================
  
  async _checkAndForceResetIfMondayUTC() {
    const lockKey = 'weeklyReset';
    if (!this._stateLock.acquire(lockKey, 10000)) return;
    
    try {
      const now = new Date();
      const currentDay = now.getUTCDay();
      const currentWeek = this.dataManager.getCurrentWeek();
      let lastResetWeek = await this.dataManager.getLastResetWeek();
      if (!lastResetWeek) {
        await this.dataManager.setLastResetWeek(currentWeek);
        return true;
      }
      if (lastResetWeek === currentWeek) return true;
      if (currentDay === CONSTANTS.WEEKLY_RESET_DAY) {
        await this._handleWeeklyReset();
        await this.dataManager.setLastResetWeek(currentWeek);
      }
      return true;
    } catch(e) {
      const currentWeek = this.dataManager.getCurrentWeek();
      await this.dataManager.setLastResetWeek(currentWeek);
      return false;
    } finally {
      this._stateLock.release(lockKey);
    }
  }

  async _forceResetIfNeededUTC() {
    const lockKey = 'forceReset';
    if (!this._stateLock.acquire(lockKey, 10000)) return;
    
    try {
      const now = new Date();
      const currentDay = now.getUTCDay();
      const currentWeek = this.dataManager.getCurrentWeek();
      const lastResetWeek = await this.dataManager.getLastResetWeek();
      if (currentDay === CONSTANTS.WEEKLY_RESET_DAY && lastResetWeek !== currentWeek) {
        await this._handleWeeklyReset();
        await this.dataManager.setLastResetWeek(currentWeek);
        return true;
      }
      return false;
    } finally {
      this._stateLock.release(lockKey);
    }
  }

  async _handleWeeklyReset() {
    const lockKey = 'handleReset';
    if (!this._stateLock.acquire(lockKey, 15000)) return;
    
    try {
      const points = await this.dataManager.getDicePoints();
      let winner = null;
      let highestScore = 0;
      for (const [username, score] of Object.entries(points)) {
        if (username && typeof username === 'string') {
          const numericScore = typeof score === 'number' ? score : parseInt(score, 10) || 0;
          if (numericScore > highestScore) {
            highestScore = numericScore;
            winner = username;
          }
        }
      }
      const currentWeek = this.dataManager.getCurrentWeek();
      if (winner && highestScore > 0) {
        await this.dataManager.setLastWeekWinner({ username: winner, score: highestScore, week: currentWeek, timestamp: Date.now() });
      } else {
        await this.dataManager.deleteLastWeekWinner();
      }
      await this.dataManager.resetDicePoints();
    } finally {
      this._stateLock.release(lockKey);
    }
  }

  // ============================================================
  // ALARM
  // ============================================================
  
  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    try {
      await this._forceResetIfNeededUTC();
      await this.alarmScheduler.restoreAlarms();
      const pendingAlarms = await this.alarmScheduler.getPendingAlarms();
      for (const alarm of pendingAlarms) {
        try {
          await this._processAlarm(alarm.name);
          await this.alarmScheduler.processAlarm(alarm.name);
        } catch(e) {}
      }
      await this.alarmScheduler.scheduleAlarms();
    } catch(e) {}
  }

  async _processAlarm(name) {
    switch(name) {
      case CONSTANTS.WEEKLY_RESET_ALARM:
        await this._handleWeeklyReset();
        break;
        
      case 'dice_session_start':
      case 'dice_session_start_immediate':
        if (this.alarmScheduler.isDiceTime()) {
          this.diceAutoEnabled = true;
          this._diceSessionActive = true;
          this._diceSessionEnded = false;
          this._diceGameStarted = false;
          
          this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceSessionStatus", {
            sessionActive: true,
            isDiceTime: true,
            gameRunning: false,
            round: 0
          }]);
          this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", "Dice session started!"]);
          
          const clients = this.wsClients?.get(CONSTANTS.DICE_ROOM);
          if (clients && clients.size > 0) {
            if (!this.currentDiceRoll && !this._isShowingDice && !this._diceLocked && !this._diceTimeUpCooldown) {
              this._diceStartedByUser = true;
              this._startDiceGameIfNotStarted();
            }
          } else {
            this._diceStartedByUser = false;
            this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", "Waiting for players..."]);
          }
        }
        break;
        
      case 'dice_session_end':
        this.diceAutoEnabled = false;
        this._diceSessionActive = false;
        this._diceSessionEnded = true;
        this._diceStartedByUser = false;
        this._diceGameStarted = false;
        this._diceRoundActive = false;
        
        this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceSessionStatus", {
          sessionActive: false,
          isDiceTime: false,
          nextSessionIn: 0,
          nextSessionText: "Session ended"
        }]);
        this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", "Dice session ended"]);
        this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceSessionEnded", true]);
        
        if (this.currentDiceRoll || this._isShowingDice) {
          this._endDiceRound();
        }
        
        this.currentDiceRoll = null;
        this._diceLocked = false;
        this._isShowingDice = false;
        this._canSubmitDiceAnswer = false;
        this.diceAnswered = new Set();
        this._playerAnswers = new Map();
        this.diceHasWinner = false;
        this.diceWinner = null;
        this._diceRound = 0;
        this._pendingDiceStart = false;
        
        this._diceTimerManager.clearAll();
        this._tieTimerManager.clearAll();
        
        if (this._tieActive) this._resetTieBreakerState(null);
        break;
    }
  }

  // ============================================================
  // FETCH
  // ============================================================
  
  async fetch(req) {
    try {
      if (this._circuitOpen) {
        const now = Date.now();
        if (now - this._lastResetTime > 60000) {
          this._circuitOpen = false;
          this._requestCount = 0;
          this._lastResetTime = now;
        } else {
          return new Response("Service temporarily unavailable", { status: 503, headers: { 'Retry-After': '30', 'Content-Type': 'text/plain' } });
        }
      }
      this._requestCount++;
      if (this._requestCount > CONSTANTS.RATE_LIMIT_MAX) {
        this._circuitOpen = true;
        this._lastResetTime = Date.now();
        return new Response("Rate limit exceeded", { status: 429, headers: { 'Retry-After': '60', 'Content-Type': 'text/plain' } });
      }
      this._mainTimerManager.setTimeout(() => {
        this._requestCount = Math.max(0, this._requestCount - 50);
      }, CONSTANTS.RATE_LIMIT_WINDOW_MS, this);
      
      const url = new URL(req.url);
      if (url.pathname === "/game/ws") {
        const upgrade = req.headers.get("Upgrade");
        if (upgrade !== "websocket") return new Response("WebSocket only", { status: 400 });
        if (this.wsMap.size >= CONSTANTS.MAX_WS_CLIENTS) return new Response("Server full", { status: 503 });
        if (this._eventQueue?.length > 500) return new Response("Server busy", { status: 503 });
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        const wsId = ++this._wsIdCounter;
        try {
          this.ctx.acceptWebSocket(server);
        } catch(e) {
          try { server.close(1008, "Accept failed"); } catch(err) {}
          return new Response("WebSocket acceptance failed", { status: 500 });
        }
        server.serializeAttachment({ wsId, username: null, room: null, roomname: null, createdAt: Date.now() });
        server._wsId = wsId;
        server._closing = false;
        server.username = null;
        server.room = null;
        server.roomname = null;
        server._createdAt = Date.now();
        this.wsMap.set(wsId, server);
        return new Response(null, { status: 101, webSocket: client });
      }
      return new Response("Game Server", { status: 200 });
    } catch(e) {
      this._handleError('fetch', e);
      return new Response(JSON.stringify({ error: "Internal Server Error", message: e.message || "Unknown error" }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // ============================================================
  // WEBSOCKET HANDLERS
  // ============================================================
  
  async webSocketMessage(ws, message) {
    if (!ws || ws._closing || this.closing || this.isDestroyed) return;
    if (!this._restored) {
      let wait = 0;
      while (!this._restored && wait < 30) {
        await new Promise(resolve => setTimeout(resolve, 100));
        wait++;
      }
      if (!this._restored) {
        try { ws.send(JSON.stringify(["restoreError", "Server is still restoring"])); } catch(e) {}
        return;
      }
    }
    try {
      let attachment = null;
      try { attachment = ws.deserializeAttachment(); } catch(e) {}
      if (attachment && attachment.wsId) {
        ws._wsId = attachment.wsId;
        ws.username = attachment.username || null;
        ws.room = attachment.room || null;
        ws.roomname = attachment.roomname || null;
        ws._createdAt = attachment.createdAt || Date.now();
        if (attachment.username && attachment.room) {
          let conn = this.userConnections.get(attachment.username);
          if (!conn) {
            conn = { wsId: attachment.wsId, ws, room: attachment.room, timestamp: Date.now() };
            this.userConnections.set(attachment.username, conn);
          } else {
            conn.wsId = attachment.wsId;
            conn.ws = ws;
            conn.room = attachment.room;
            conn.timestamp = Date.now();
          }
        }
      }
      const data = JSON.parse(message);
      if (Array.isArray(data) && data.length > 0) {
        await this._processWithTimeout(ws, data);
      }
    } catch(e) {}
  }

  async webSocketClose(ws, code, reason, wasClean) {
    if (!ws) return;
    try {
      const attachment = ws.deserializeAttachment();
      const username = attachment?.username;
      const room = attachment?.room;
      const wsId = attachment?.wsId;
      
      if (wsId) {
        this._broadcastedCountdown.delete(`countdown_${wsId}`);
      }
      
      if (username) this.userConnections.delete(username);
      if (room && wsId) {
        const clients = this.wsClients.get(room);
        if (clients) {
          clients.delete(wsId);
          if (clients.size === 0) this.wsClients.delete(room);
        }
      }
      if (wsId) {
        this.wsMap.delete(wsId);
        this.clientRooms.delete(wsId);
      }
      for (const [r, clients] of this.wsClients) {
        if (clients.has(wsId)) {
          clients.delete(wsId);
          if (clients.size === 0) this.wsClients.delete(r);
        }
      }
      
      if (room && username) {
        const game = this.activeGames.get(room);
        if (game && game._isActive && !game._gameEnded && game.players) {
          if (game.players.has(username)) {
            if (game.hostId === username && game._phase === 'registration') {
              this._broadcastToRoom(room, ["gameLowCardError", "Host left the game"]);
              game._gameEnded = true;
              game._isActive = false;
              this._forceCleanupGame(room, game);
              this._cleanupWsData(wsId, username, room);
              return;
            }
            
            if (game._phase === 'registration') {
              game.players.delete(username);
              game.playerWsId?.delete(username);
              this._broadcastToRoom(room, ["gameLowCardError", "Player left the game"]);
              
              if (game.hostId === username) {
                const remaining = Array.from(game.players.keys());
                if (remaining.length > 0) {
                  game.hostId = remaining[0];
                  this._broadcastToRoom(room, ["gameLowCardError", "New host: " + game.hostId]);
                } else {
                  game._gameEnded = true;
                  game._isActive = false;
                  this._forceCleanupGame(room, game);
                  this._cleanupWsData(wsId, username, room);
                  return;
                }
              }
              
              if (game.players.size === 0) {
                game._gameEnded = true;
                game._isActive = false;
                this._forceCleanupGame(room, game);
              }
              this._cleanupWsData(wsId, username, room);
              return;
            }
            
            if (game._phase === 'draw' || game._phase === 'evaluating') {
              if (!game.eliminated.has(username)) {
                game.eliminated.add(username);
                this._broadcastToRoom(room, ["gameLowCardError", "Player left the game"]);
                
                const active = this._getActivePlayers(game);
                if (active.length <= 1) {
                  if (active.length === 1) {
                    const winner = active[0].name;
                    const totalCoin = game.betAmount * game.players.size;
                    this._broadcastToRoom(room, ["gameLowCardWinner", winner, totalCoin]);
                  } else {
                    this._broadcastToRoom(room, ["gameLowCardError", "All players disconnected"]);
                  }
                  game._gameEnded = true;
                  game._isActive = false;
                  this._forceCleanupGame(room, game);
                  this._cleanupWsData(wsId, username, room);
                  return;
                }
                
                if (game._phase === 'draw' && !game.evaluationLocked) {
                  const activeIds = this._getActivePlayerIds(game);
                  const hasDrawn = activeIds.every(id => game.numbers.has(id) || game.eliminated.has(id));
                  if (hasDrawn && !game._isEvaluating) {
                    this._checkAllDrawn(room, game);
                  }
                }
              }
            }
          }
        }
      }
      
      try {
        ws.serializeAttachment({ wsId, username: null, room: null, roomname: null, createdAt: Date.now() });
      } catch(e) {}
    } catch(e) {}
  }

  _cleanupWsData(wsId, username, room) {
    try {
      if (wsId) {
        this.wsMap.delete(wsId);
        this.clientRooms.delete(wsId);
        if (username) this.userConnections.delete(username);
        if (room) {
          const clients = this.wsClients.get(room);
          if (clients) {
            clients.delete(wsId);
            if (clients.size === 0) this.wsClients.delete(room);
          }
        }
      }
    } catch(e) {}
  }

  // ============================================================
  // EVENT PROCESSING
  // ============================================================
  
  async _processWithTimeout(ws, data, timeoutMs = 500) {
    try {
      const timeoutPromise = new Promise((_, reject) => {
        const timer = this._mainTimerManager.setTimeout(() => {
          reject(new Error('Processing timeout'));
        }, timeoutMs, this);
        if (timer) {
          // Store timer for cleanup
        }
      });
      await Promise.race([this.handleEvent(ws, data), timeoutPromise]);
    } catch(e) {}
  }

  async handleEvent(ws, data) {
    try {
      if (this.isDestroyed || !ws || !data?.[0]) return;
      if (this._eventQueue.length > CONSTANTS.MAX_EVENT_QUEUE_SIZE) {
        this._safeSend(ws, ["gameLowCardError", "Server busy"]);
        return;
      }
      this._eventQueue.push({ ws, data });
      if (!this._processingQueue) this._processEventQueue();
    } catch(e) {}
  }

  async _processEventQueue() {
    if (this._processingQueue || this._eventQueue.length === 0) return;
    this._processingQueue = true;
    try {
      const startTime = Date.now();
      let processed = 0;
      const MAX_BATCH = CONSTANTS.PROCESS_BATCH_SIZE || 50;
      const MAX_TIME = CONSTANTS.PROCESS_MAX_TIME_MS || 100;
      while (this._eventQueue.length > 0 && processed < MAX_BATCH) {
        if (Date.now() - startTime > MAX_TIME) break;
        const item = this._eventQueue.shift();
        try { await this._processEventItem(item.ws, item.data); } catch(e) {}
        processed++;
      }
      if (this._eventQueue.length > 0 && !this.closing && !this.isDestroyed) {
        this._mainTimerManager.setTimeout(() => this._processEventQueue(), 10, this);
      }
    } catch(e) {
      this._handleError('processQueue', e);
    } finally {
      this._processingQueue = false;
    }
  }

  async _processEventItem(ws, data) {
    try {
      if (this.isDestroyed || !ws || !data || !data[0]) return;
      await this._handleEventInternal(ws, data);
    } catch(e) {}
  }

  // ============================================================
  // HANDLE EVENT INTERNAL
  // ============================================================
  
  async _handleEventInternal(ws, data) {
    try {
      if (this.isDestroyed || !ws || !data || !data[0]) return;
      const evt = data[0];

      if (evt === "switchRoom") {
        await this.switchRoom(ws, data[1], data[2]);
        return;
      }

      if (evt === "startRecordingWinners") {
        const roomName = data[1];
        if (!roomName || typeof roomName !== 'string' || roomName.trim() === '') {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        const room = roomName.trim();
        await this.dataManager.setRecordingStatus(room, true);
        this._broadcastToRoom(room, ["recordingStatus", true]);
        this._safeSend(ws, ["startRecordingResult", { success: true, message: "Recording enabled" }]);
        return;
      }

      if (evt === "stopRecordingWinners") {
        const roomName = data[1];
        if (!roomName || typeof roomName !== 'string' || roomName.trim() === '') {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        const room = roomName.trim();
        await this.dataManager.setRecordingStatus(room, false);
        await this.dataManager.deleteAllWinners(room);
        this._broadcastToRoom(room, ["recordingStatus", false]);
        this._safeSend(ws, ["stopRecordingResult", { success: true, message: "Recording stopped and winners deleted" }]);
        return;
      }

      if (evt === "getRecordingStatus") {
        const roomName = data[1];
        if (!roomName || typeof roomName !== 'string' || roomName.trim() === '') {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        const room = roomName.trim();
        const isRecording = await this.dataManager.getRecordingStatus(room);
        this._safeSend(ws, ["recordingStatus", isRecording]);
        return;
      }

      if (evt === "addLowCardWinner") {
        const { room, username } = data[1] || {};
        if (!room || !username || typeof room !== 'string' || typeof username !== 'string') {
          this._safeSend(ws, ["error", "Room and username required"]);
          return;
        }
        const roomKey = room.trim();
        const userKey = username.trim();
        const winners = await this.dataManager.getWinners(roomKey);
        let count = parseInt(String(winners[userKey] || "0").replace("x", "")) || 0;
        winners[userKey] = (count + 1) + "x";
        await this.dataManager.setWinners(roomKey, winners);
        this._broadcastLowCardWinners(roomKey);
        this._safeSend(ws, ["addWinnerResult", { success: true }]);
        return;
      }

      if (evt === "deleteAllWinners") {
        const room = data[1];
        if (!room || typeof room !== 'string' || room.trim() === '') {
          this._safeSend(ws, ["error", "Room required"]);
          return;
        }
        const roomKey = room.trim();
        await this.dataManager.deleteAllWinners(roomKey);
        this._broadcastToRoom(roomKey, ["recordingStatus", false]);
        this._safeSend(ws, ["deleteWinnersResult", { success: true }]);
        return;
      }

      if (evt === "getRoomWinners") {
        let room = data[1] || ws.room || this.clientRooms.get(ws._wsId);
        if (!room || typeof room !== 'string' || room.trim() === '') {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        const roomKey = room.trim();
        const isRecording = await this.dataManager.getRecordingStatus(roomKey);
        const winners = await this.dataManager.getWinners(roomKey);
        this._safeSend(ws, ["roomWinners", { winners: winners || {}, room: roomKey, recording: isRecording || false }]);
        return;
      }

      if (evt === "sendWinnersToRoom" || evt === "lowCardWinnerUpdate") {
        let room = data[1] || ws.room || this.clientRooms.get(ws._wsId);
        if (!room || typeof room !== 'string' || room.trim() === '') {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        const roomKey = room.trim();
        await this._broadcastLowCardWinners(roomKey);
        this._safeSend(ws, ["sendWinnersResult", { success: true, message: "Winners refreshed" }]);
        return;
      }

      if (evt === "submitDiceAnswer") {
        await this.submitDiceAnswer(ws, data[1], data[2]);
        return;
      }

      if (evt === "getDiceLastWeekWinner") {
        try {
          const wsId = ws._wsId;
          const now = Date.now();
          if (!this._lastWinnerRequestTime) this._lastWinnerRequestTime = new Map();
          const lastReq = this._lastWinnerRequestTime.get(wsId) || 0;
          if (now - lastReq < 5000) return;
          this._lastWinnerRequestTime.set(wsId, now);
          const winner = await this.dataManager.getLastWeekWinner();
          if (winner && typeof winner === 'object' && winner.username) {
            this._safeSend(ws, ["diceLastWeekWinner", String(winner.username), parseInt(winner.score, 10) || 0, String(winner.week || '')]);
          } else {
            this._safeSend(ws, ["diceLastWeekWinner", "", 0, ""]);
          }
        } catch(e) {
          this._safeSend(ws, ["diceLastWeekWinner", "", 0, ""]);
        }
        return;
      }

      if (evt === "deleteDiceLastWeekWinner") {
        try {
          await this.dataManager.deleteLastWeekWinner();
          this._safeSend(ws, ["diceLastWeekWinnerDeleted", true, "Deleted"]);
        } catch(e) { 
          this._safeSend(ws, ["diceLastWeekWinnerDeleted", false, e.message]); 
        }
        return;
      }

      if (evt === "getDiceLeaderboard") {
        try {
          let limit = CONSTANTS.DEFAULT_LEADERBOARD_LIMIT;
          if (data.length > 1 && typeof data[1] === 'number') {
            limit = Math.min(Math.max(data[1], CONSTANTS.MIN_LEADERBOARD_LIMIT), CONSTANTS.MAX_LEADERBOARD_LIMIT);
          }
          const leaderboard = await this.dataManager.getLeaderboard(limit);
          this._safeSend(ws, ["diceLeaderboard", leaderboard]);
        } catch(e) { 
          this._safeSend(ws, ["diceLeaderboard", []]);
        }
        return;
      }

      if (evt === "getDicePoints") {
        try {
          const points = await this.dataManager.getDicePoints();
          this._safeSend(ws, ["dicePoints", points]);
        } catch(e) { 
          this._safeSend(ws, ["dicePoints", {}]);
        }
        return;
      }

      if (evt === "getDiceStatus") {
        const isActive = !!this.currentDiceRoll && this._canSubmitDiceAnswer;
        this._safeSend(ws, ["diceStatus", isActive, this._diceRound || 1]);
        return;
      }

      if (evt === "getDiceNotification") {
        try {
          const isDiceTime = this.alarmScheduler.isDiceTime();
          const isActive = this.currentDiceRoll && this._canSubmitDiceAnswer;
          const timeLeft = this._getTimeLeftUntilNextDice();
          let notification = "";
          if (isActive) {
            const elapsed = (Date.now() - this._diceStartTime) / 1000;
            const totalTime = CONSTANTS.DICE_TOTAL_TIME_MS / 1000;
            const remaining = Math.max(0, totalTime - elapsed);
            notification = Math.floor(remaining) + "s remaining";
          } else if (isDiceTime) {
            notification = "Dice game starting soon...";
          } else if (timeLeft && timeLeft.text) {
            notification = "Next dice game in: " + timeLeft.text;
          } else {
            notification = "Waiting...";
          }
          this._safeSend(ws, ["diceNotification", notification]);
        } catch(e) {
          this._safeSend(ws, ["diceNotification", "Waiting..."]);
        }
        return;
      }

      if (evt === "startGameWithRecording") {
        const [_, room, bet, username] = data;
        if (!room || !username || typeof room !== 'string' || typeof username !== 'string') {
          this._safeSend(ws, ["gameLowCardError", "Room and username required"]);
          return;
        }
        await this._startGameWithRecording(ws, room.trim(), bet, username.trim());
        return;
      }

      if (evt === "checkGameRunning") {
        await this.checkGameRunning(ws, data[1]);
        return;
      }

      const room = ws.room || ws.roomname || this.clientRooms.get(ws._wsId);
      if (!room || typeof room !== 'string' || room.trim() === '') {
        this._safeSend(ws, ["gameLowCardError", "Please switch to a room first"]);
        return;
      }
      if (room === CONSTANTS.DICE_ROOM) {
        this._safeSend(ws, ["gameLowCardError", "Cannot start game in Quiz room"]);
        return;
      }

      switch (evt) {
        case "gameLowCardStart": 
          await this.startGame(ws, data[1], data[2]); 
          break;
        case "gameLowCardJoin": 
          await this.joinGame(ws, data[1]); 
          break;
        case "gameLowCardNumber": 
          await this.submitNumber(ws, data[1], data[2] || "", data[3]); 
          break;
        default: 
          break;
      }
    } catch(e) {}
  }

  // ============================================================
  // SWITCH ROOM - FIXED RACE CONDITION
  // ============================================================
  
  async switchRoom(ws, room, username = null) {
    const lockKey = `switch_${ws._wsId}`;
    if (!this._wsLock.acquire(lockKey, 5000)) {
      this._safeSend(ws, ["gameLowCardError", "Switch in progress"]);
      return;
    }
    
    try {
      if (this.isDestroyed) {
        this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]);
        return;
      }
      if (!room || typeof room !== 'string' || room.trim() === "") {
        this._safeSend(ws, ["gameLowCardError", "Invalid room name"]);
        return;
      }
      
      const roomName = room.trim();
      const wsId = ws._wsId;
      if (!wsId) {
        this._safeSend(ws, ["gameLowCardError", "Connection error"]);
        return;
      }
      if (ws.readyState !== 1 || ws._closing) {
        this._safeSend(ws, ["gameLowCardError", "Connection closed"]);
        return;
      }
      
      const currentRoom = ws.room || ws.roomname || this.clientRooms.get(wsId);
      if (currentRoom === roomName) {
        this._safeSend(ws, ["switchRoomSuccess", roomName]);
        if (roomName === CONSTANTS.DICE_ROOM) {
          this._sendDiceRoomState(ws);
        }
        return;
      }
      
      if (currentRoom) {
        const clients = this.wsClients.get(currentRoom);
        if (clients) {
          clients.delete(wsId);
          if (clients.size === 0) this.wsClients.delete(currentRoom);
        }
      }
      
      if (!this.wsClients.has(roomName)) {
        this.wsClients.set(roomName, new Set());
      }
      this.wsClients.get(roomName).add(wsId);
      this.clientRooms.set(wsId, roomName);
      
      ws.room = roomName;
      ws.roomname = roomName;
      if (username) ws.username = username;
      
      ws.serializeAttachment({
        wsId: wsId,
        username: username || ws.username || null,
        room: roomName,
        roomname: roomName,
        createdAt: ws._createdAt || Date.now()
      });
      
      const finalUsername = username || ws.username;
      if (finalUsername) {
        let conn = this.userConnections.get(finalUsername);
        if (conn) { 
          conn.room = roomName; 
          conn.wsId = wsId; 
          conn.ws = ws; 
          conn.timestamp = Date.now(); 
        } else { 
          this.userConnections.set(finalUsername, { wsId, ws, room: roomName, timestamp: Date.now() }); 
        }
      }
      
      this._safeSend(ws, ["switchRoomSuccess", roomName]);
      
      if (roomName === CONSTANTS.DICE_ROOM) {
        this._sendDiceRoomState(ws);
        if (this.alarmScheduler.isDiceTime() && !this._diceGameStarted && !this.currentDiceRoll) {
          this._startDiceGameIfNotStarted();
        }
      }
      
    } catch(e) {
      this._safeSend(ws, ["gameLowCardError", e.message || "Switch failed"]);
    } finally {
      this._wsLock.release(lockKey);
    }
  }

  // ============================================================
  // CHECK GAME RUNNING (LOWCARD)
  // ============================================================
  
  async checkGameRunning(ws, roomname) {
    try {
      if (this.isDestroyed) {
        this._safeSend(ws, ["gameStatus", "false"]);
        return;
      }
      let room = roomname || ws.room || ws.roomname || this.clientRooms.get(ws._wsId);
      if (!room || typeof room !== 'string' || room.trim() === '') {
        this._safeSend(ws, ["gameStatus", "false"]);
        return;
      }
      
      if (room === CONSTANTS.DICE_ROOM) {
        this._sendDiceRoomState(ws);
        return;
      }
      
      const game = this.activeGames.get(room);
      const isRunning = game?._isActive && !game._gameEnded && game.players?.size > 0;
      
      this._safeSend(ws, ["gameStatus", isRunning ? "true" : "false"]);
      
      if (isRunning) {
        this._sendCurrentGameState(ws, room);
      }
    } catch(e) {}
  }

  // ============================================================
  // GAME HELPERS (LOWCARD)
  // ============================================================
  
  _getClientRoom(ws) {
    try {
      if (!ws) return null;
      let room = ws.room || ws.roomname;
      if (room) return room;
      const wsId = ws._wsId;
      if (wsId) {
        room = this.clientRooms.get(wsId);
        if (room) return room;
      }
      try {
        const attachment = ws.deserializeAttachment();
        if (attachment && attachment.room) return attachment.room;
      } catch(e) {}
      if (ws.username) {
        const conn = this.userConnections.get(ws.username);
        if (conn && conn.room) return conn.room;
      }
      return null;
    } catch(e) { return null; }
  }

  _getClientUsername(ws) {
    try {
      if (!ws) return null;
      if (ws.username) return ws.username;
      try {
        const attachment = ws.deserializeAttachment();
        if (attachment && attachment.username) return attachment.username;
      } catch(e) {}
      const wsId = ws._wsId;
      if (wsId) {
        for (const [username, conn] of this.userConnections) {
          if (conn.wsId === wsId) return username;
        }
      }
      return null;
    } catch(e) { return null; }
  }

  _ensureClientInRoom(ws, room, username = null) {
    try {
      if (!ws || !room) return false;
      const wsId = ws._wsId;
      if (!wsId) return false;
      if (!this.wsClients.has(room)) this.wsClients.set(room, new Set());
      const clients = this.wsClients.get(room);
      if (!clients.has(wsId)) {
        clients.add(wsId);
        this.clientRooms.set(wsId, room);
        this.wsMap.set(wsId, ws);
      }
      ws.room = room;
      ws.roomname = room;
      if (username) ws.username = username;
      try {
        ws.serializeAttachment({
          wsId: wsId,
          username: ws.username || null,
          room: room,
          roomname: room,
          createdAt: ws._createdAt || Date.now()
        });
      } catch(e) {}
      if (ws.username) {
        let conn = this.userConnections.get(ws.username);
        if (conn) {
          conn.wsId = wsId;
          conn.ws = ws;
          conn.room = room;
          conn.timestamp = Date.now();
        } else {
          this.userConnections.set(ws.username, { wsId, ws, room, timestamp: Date.now() });
        }
      }
      return true;
    } catch(e) { return false; }
  }

  _isGameActuallyRunning(game) { 
    return game?._isActive === true && !game?._gameEnded && game?.players?.size > 0; 
  }

  _getActivePlayers(game) {
    try {
      if (!game?._isActive || game?._gameEnded || !game?.players) return [];
      return Array.from(game.players.entries())
        .filter(([id]) => !game.eliminated?.has(id))
        .map(([, p]) => p);
    } catch(e) { return []; }
  }

  _getActivePlayerIds(game) {
    try {
      if (!game?._isActive || game._gameEnded || !game?.players) return [];
      return Array.from(game.players.keys()).filter(id => !game.eliminated?.has(id));
    } catch(e) { return []; }
  }

  _getBotNumberByRound(round) {
    if (round <= 2) return Math.floor(Math.random() * 12) + 1;
    return Math.random() < 0.6 ? 
      [8, 9, 10, 11, 12][Math.floor(Math.random() * 5)] : 
      [1, 2, 3, 4, 5, 6, 7][Math.floor(Math.random() * 7)];
  }

  _getRandomCardTanda() { 
    return ["C1", "C2", "C3", "C4"][Math.floor(Math.random() * 4)]; 
  }

  _getRandomDrawDelay() { 
    return (Math.floor(Math.random() * 14) + 2) * 1000; 
  }

  // ============================================================
  // GAME: START (LOWCARD) - FIXED RACE CONDITION
  // ============================================================
  
  async startGame(ws, bet, username) {
    const lockKey = `game_start_${ws.room || ws.roomname || ws._wsId}`;
    if (!this._gameLock.acquire(lockKey, 10000)) {
      this._safeSend(ws, ["gameLowCardError", "Game is starting, please wait"]);
      return;
    }
    
    try {
      if (this.isDestroyed) {
        this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]);
        return;
      }
      if (!username || typeof username !== 'string' || !username.trim()) {
        this._safeSend(ws, ["gameLowCardError", "Username is required"]);
        return;
      }
      const usernameClean = username.trim();
      const room = ws.room || ws.roomname || this.clientRooms.get(ws._wsId);
      if (!room || typeof room !== 'string' || room.trim() === '') {
        this._safeSend(ws, ["gameLowCardError", "Please switch to a room first"]);
        return;
      }
      if (room === CONSTANTS.DICE_ROOM) {
        this._safeSend(ws, ["gameLowCardError", "Cannot start game in Quiz room"]);
        return;
      }
      
      const isRecordingEnabled = await this.dataManager.getRecordingStatus(room);
      if (isRecordingEnabled) {
        this._safeSend(ws, ["gameLowCardError", "Recording is ACTIVE in this room. Users cannot start games."]);
        return;
      }
      const existingGame = this.activeGames.get(room);
      if (existingGame?._isActive && !existingGame._gameEnded) {
        this._safeSend(ws, ["gameLowCardError", "Game is already running"]);
        return;
      }
      if (existingGame) await this._forceCleanupGame(room, existingGame);
      
      const betAmount = parseInt(bet, 10) || 0;
      if (betAmount < 0 || (betAmount !== 0 && betAmount < 100) || betAmount > CONSTANTS.MAX_BET) {
        this._safeSend(ws, ["gameLowCardError", "Invalid bet (0 or 100-" + CONSTANTS.MAX_BET + ")"]);
        return;
      }
      if (this.activeGames.size >= CONSTANTS.MAX_LOWCARD_GAMES) {
        this._safeSend(ws, ["gameLowCardError", "Server is busy"]);
        return;
      }
      
      const wsId = ws._wsId;
      const game = {
        room,
        players: new Map(),
        botPlayers: new Map(),
        registrationOpen: true,
        round: 1,
        numbers: new Map(),
        tanda: new Map(),
        eliminated: new Set(),
        betAmount: betAmount,
        hostId: usernameClean,
        hostName: usernameClean,
        useBots: false,
        evaluationLocked: false,
        drawTimeExpired: false,
        _isActive: true,
        _gameEnded: false,
        _phase: 'registration',
        _state: 'registration',
        _botTimeouts: new Set(),
        _botTimers: new Set(),
        _botsAdded: false,
        _registrationTimer: null,
        _drawTimer: null,
        _evalTimer: null,
        _safetyTimer: null,
        _isEvaluating: false,
        _evalStartTime: null,
        _createdAt: Date.now(),
        _drawPhaseStart: null,
        _endTime: null,
        playerWsId: new Map(),
        _startedByRecording: false,
        _startedBy: 'user',
        _notificationTimers: [],
        _drawNotificationTimers: [],
        _cleanupStarted: false,
        _evalLocks: new Map(),
        _gameVersion: Date.now(),
        _isCleaningUp: false,
        _registrationVersion: Date.now()
      };
      
      game.players.set(usernameClean, { id: usernameClean, name: usernameClean });
      game.playerWsId.set(usernameClean, wsId);
      this.activeGames.set(room, game);
      this._addClient(room, ws, usernameClean);
      
      this._broadcastToRoom(room, ["gameLowCardStart", betAmount]);
      this._broadcastToRoom(room, ["gameLowCardStartSuccess", usernameClean, betAmount]);
      
      this._startRegistration(room, game);
      
    } finally {
      this._gameLock.release(lockKey);
    }
  }

  // ============================================================
  // GAME: REGISTRATION (LOWCARD) - FIXED RACE CONDITION
  // ============================================================
  
  _startRegistration(room, game) {
    const lockKey = `registration_${room}`;
    if (!this._registrationLock.acquire(lockKey, 10000)) return;
    
    try {
      if (!this._isGameActuallyRunning(game) || !game.registrationOpen) return;
      
      const gameVersion = game._gameVersion || Date.now();
      game._registrationVersion = Date.now();
      
      if (game._registrationTimer) { 
        this._gameTimerManager.clearTimeout(game._registrationTimer);
        game._registrationTimer = null; 
      }
      
      if (game._notificationTimers) {
        for (const timer of game._notificationTimers) {
          this._gameTimerManager.clearTimeout(timer);
        }
        game._notificationTimers = [];
      }
      
      const notifications = [
        { delay: 5000, message: "15s" },
        { delay: 10000, message: "10s" },
        { delay: 15000, message: "5s" }
      ];
      
      for (const notif of notifications) {
        const timer = this._gameTimerManager.setTimeout(() => {
          const currentGame = this.activeGames.get(room);
          if (currentGame !== game) return;
          if (game._gameVersion !== gameVersion) return;
          if (this._isGameActuallyRunning(game) && game.registrationOpen) {
            this._broadcastToRoom(room, ["gameLowCardTimeLeft", notif.message]);
          }
        }, notif.delay, this);
        if (timer) game._notificationTimers.push(timer);
      }
      
      const timer = this._gameTimerManager.setTimeout(() => {
        const currentGame = this.activeGames.get(room);
        if (currentGame !== game) return;
        if (game._gameVersion !== gameVersion) return;
        if (this._isGameActuallyRunning(game) && game.registrationOpen) {
          this._broadcastToRoom(room, ["gameLowCardTimeLeft", "TIME UP"]);
          this._closeRegistration(room, game);
        }
      }, CONSTANTS.REGISTRATION_TIME_MS || 20000, this);
      game._registrationTimer = timer;
      
    } finally {
      this._registrationLock.release(lockKey);
    }
  }

  // ============================================================
  // GAME: CLOSE REGISTRATION (LOWCARD) - FIXED RACE CONDITION
  // ============================================================
  
  _closeRegistration(room, game) {
    const lockKey = `closeReg_${room}`;
    if (!this._registrationLock.acquire(lockKey, 10000)) return;
    
    try {
      if (!this._isGameActuallyRunning(game) || !game.registrationOpen) return;
      if (game._isCleaningUp) return;
      
      this._cleanupGameTimers(game);
      game.registrationOpen = false;
      
      const humanPlayers = Array.from(game.players.keys()).filter(id => !id.startsWith('BOT_'));
      const humanCount = humanPlayers.length;
      
      if (!game._botsAdded) {
        if (humanCount === 1 || humanCount === 0) {
          this._addBots(room, 4);
          game._botsAdded = true;
        } else if (game.players.size < 2) {
          const needed = Math.min(4 - game.players.size, CONSTANTS.MAX_BOTS_PER_GAME);
          if (needed > 0) { 
            this._addBots(room, needed); 
            game._botsAdded = true; 
          }
        }
      }
      
      if (this._isGameActuallyRunning(game) && game.players.size >= 2) {
        this._startDrawPhase(room, game);
      } else {
        this._broadcastToRoom(room, ["gameLowCardError", "Not enough players"]);
        this._forceCleanupGame(room, game);
      }
    } finally {
      this._registrationLock.release(lockKey);
    }
  }

  // ============================================================
  // GAME: ADD BOTS (LOWCARD)
  // ============================================================
  
  _addBots(room, count) {
    try {
      const game = this.activeGames.get(room);
      if (!this._isGameActuallyRunning(game)) return;
      
      const botNames = ["moz1", "moz2", "moz3", "moz4"];
      const existingBots = Array.from(game.players.keys()).filter(id => id.startsWith('BOT_'));
      const existingBotCount = existingBots.length;
      const maxBotsToAdd = Math.min(count, CONSTANTS.MAX_BOTS_PER_GAME - existingBotCount);
      
      if (maxBotsToAdd <= 0) return;
      
      for (let i = 0; i < maxBotsToAdd; i++) {
        const botId = `BOT_${room}_${i}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const botName = botNames[(existingBotCount + i) % botNames.length];
        if (!game.players.has(botId)) {
          game.players.set(botId, { id: botId, name: botName });
          if (!game.botPlayers) game.botPlayers = new Map();
          game.botPlayers.set(botId, botName);
        }
      }
      game._botsAdded = true;
      game.useBots = true;
    } catch(e) {}
  }

  // ============================================================
  // GAME: DRAW PHASE (LOWCARD) - FIXED RACE CONDITION
  // ============================================================
  
  async _startDrawPhase(room, game) {
    const lockKey = `startDraw_${room}`;
    if (!this._drawLock.acquire(lockKey, 10000)) return;
    
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._isCleaningUp) return;
      
      game._isEvaluating = false;
      game._evalStartTime = null;
      game.evaluationLocked = false;
      
      this._cleanupGameTimers(game);
      
      const activePlayers = this._getActivePlayers(game);
      
      if (activePlayers.length < 2) {
        if (!game._botsAdded) {
          const needed = Math.min(4 - activePlayers.length, CONSTANTS.MAX_BOTS_PER_GAME);
          if (needed > 0) { 
            this._addBots(room, needed); 
            game._botsAdded = true; 
          }
        }
        const newActive = this._getActivePlayers(game);
        if (newActive.length < 2) {
          if (newActive.length === 1 && !game._gameEnded) {
            const winner = newActive[0]?.name || "Unknown";
            const totalCoin = (game.betAmount || 0) * (game.players?.size || 0);
            if (game._startedByRecording) {
              await this._addLowCardWinner(room, winner);
              await this._broadcastLowCardWinners(room);
            }
            game._gameEnded = true;
            game._isActive = false;
            this._broadcastToRoom(room, ["gameLowCardWinner", winner, totalCoin]);
            this._forceCleanupGame(room, game);
            return;
          } else {
            game._gameEnded = true;
            game._isActive = false;
            this._broadcastToRoom(room, ["gameLowCardError", "Not enough players"]);
            this._forceCleanupGame(room, game);
            return;
          }
        }
      }
      
      const gameVersion = game._gameVersion || Date.now();
      
      game._phase = 'draw';
      game._state = 'draw';
      game.drawTimeExpired = false;
      game.evaluationLocked = false;
      game._drawPhaseStart = Date.now();
      
      if (!game._botTimers) game._botTimers = new Set();
      if (!game._botTimeouts) game._botTimeouts = new Set();
      
      const playersList = this._getActivePlayers(game).map(p => p.name);
      this._broadcastToRoom(room, ["gameLowCardClosed", playersList]);
      this._broadcastToRoom(room, ["gameLowCardNextRound", game.round]);
      
      this._startDrawCountdown(room, game, gameVersion);
      
      if (game.botPlayers?.size > 0 && this._isGameActuallyRunning(game)) {
        this._startBotDraws(room, game, gameVersion);
      }
      
    } catch(e) {
      // Silent
    } finally {
      this._drawLock.release(lockKey);
    }
  }

  // ============================================================
  // GAME: DRAW COUNTDOWN (LOWCARD) - FIXED RACE CONDITION
  // ============================================================
  
  _startDrawCountdown(room, game, gameVersion) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._gameVersion !== gameVersion) return;
      
      if (game._drawTimer) { 
        this._gameTimerManager.clearTimeout(game._drawTimer);
        game._drawTimer = null; 
      }
      
      if (game._drawNotificationTimers) {
        for (const timer of game._drawNotificationTimers) {
          this._gameTimerManager.clearTimeout(timer);
        }
        game._drawNotificationTimers = [];
      }
      
      const notifications = [
        { delay: 5000, message: "15s" },
        { delay: 10000, message: "10s" },
        { delay: 15000, message: "5s" }
      ];
      
      for (const notif of notifications) {
        const timer = this._gameTimerManager.setTimeout(() => {
          const currentGame = this.activeGames.get(room);
          if (currentGame !== game) return;
          if (game._gameVersion !== gameVersion) return;
          if (this._isGameActuallyRunning(game) && !game.drawTimeExpired && !game.evaluationLocked) {
            this._broadcastToRoom(room, ["gameLowCardTimeLeft", notif.message]);
          }
        }, notif.delay, this);
        if (timer) game._drawNotificationTimers.push(timer);
      }
      
      const timer = this._gameTimerManager.setTimeout(() => {
        const currentGame = this.activeGames.get(room);
        if (currentGame !== game) return;
        if (game._gameVersion !== gameVersion) return;
        if (this._isGameActuallyRunning(game) && !game.drawTimeExpired && !game.evaluationLocked) {
          this._broadcastToRoom(room, ["gameLowCardTimeLeft", "TIME UP"]);
          this._closeDrawPhase(room, game);
        }
      }, CONSTANTS.DRAW_TIME_MS || 20000, this);
      game._drawTimer = timer;
      
    } catch(e) {}
  }

  // ============================================================
  // GAME: BOT DRAWS (LOWCARD) - FIXED RACE CONDITION
  // ============================================================
  
  _startBotDraws(room, game, gameVersion) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._gameVersion !== gameVersion) return;
      if (game.botPlayers.size === 0) return;
      if (game._state !== 'draw') return;
      if (game.evaluationLocked || game._isEvaluating) return;
      if (game.drawTimeExpired) return;
      if (game._isCleaningUp) return;
      
      const activeBotIds = Array.from(game.botPlayers.keys())
        .filter(id => !game.eliminated.has(id) && !game.numbers.has(id));
      
      if (activeBotIds.length === 0) return;
      
      const maxPerBatch = Math.min(CONSTANTS.MAX_BOT_TIMEOUTS || 5, activeBotIds.length);
      const botsToDraw = activeBotIds.slice(0, maxPerBatch);
      
      for (const botId of botsToDraw) {
        if (game.evaluationLocked || game._isEvaluating) break;
        if (game.drawTimeExpired) break;
        if (game.eliminated.has(botId) || game.numbers.has(botId)) continue;
        if (game._isCleaningUp) break;
        
        const delay = this._getRandomDrawDelay();
        const timer = this._gameTimerManager.setTimeout(() => {
          const currentGame = this.activeGames.get(room);
          if (currentGame !== game) return;
          if (game._gameVersion !== gameVersion) return;
          if (!this._isGameActuallyRunning(game)) return;
          if (game._state !== 'draw') return;
          if (game.evaluationLocked || game._isEvaluating) return;
          if (game.eliminated.has(botId) || game.numbers.has(botId)) return;
          if (game.drawTimeExpired) return;
          if (game._isCleaningUp) return;
          
          this._handleBotDraw(room, botId, game);
          if (game._botTimers) game._botTimers.delete(timer);
        }, delay, this);
        
        if (timer) game._botTimers.add(timer);
      }
      
    } catch(e) {}
  }

  // ============================================================
  // GAME: HANDLE BOT DRAW (LOWCARD)
  // ============================================================
  
  _handleBotDraw(room, botId, game) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._state !== 'draw') return;
      if (game.evaluationLocked || game._isEvaluating) return;
      if (game.eliminated.has(botId) || game.numbers.has(botId)) return;
      if (game.drawTimeExpired) return;
      if (game._isCleaningUp) return;
      
      const number = this._getBotNumberByRound(game.round);
      const tanda = this._getRandomCardTanda();
      
      game.numbers.set(botId, number);
      game.tanda.set(botId, tanda);
      
      const botName = game.players.get(botId)?.name || botId;
      this._broadcastToRoom(room, ["gameLowCardPlayerDraw", botName, number, tanda]);
      
      if (!game.evaluationLocked && !game._isEvaluating && game._state === 'draw' && !game.drawTimeExpired && !game._isCleaningUp) {
        this._gameTimerManager.setTimeout(() => {
          const currentGame = this.activeGames.get(room);
          if (currentGame !== game) return;
          if (!game.evaluationLocked && !game._isEvaluating && game._state === 'draw' && !game.drawTimeExpired && !game._isCleaningUp) {
            this._checkAllDrawn(room, game);
          }
        }, 100, this);
      }
      
    } catch(e) {}
  }

  // ============================================================
  // GAME: FORCE BOT DRAW (LOWCARD)
  // ============================================================
  
  _forceBotDraw(room, botId, game) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game.eliminated.has(botId) || game.numbers.has(botId)) return;
      if (game._isCleaningUp) return;
      
      const number = this._getBotNumberByRound(game.round);
      const tanda = this._getRandomCardTanda();
      
      game.numbers.set(botId, number);
      game.tanda.set(botId, tanda);
      
      const botName = game.players.get(botId)?.name || botId;
      this._broadcastToRoom(room, ["gameLowCardPlayerDraw", botName, number, tanda]);
      
    } catch(e) {}
  }

  // ============================================================
  // GAME: CHECK ALL DRAWN (LOWCARD) - FIXED RACE CONDITION
  // ============================================================
  
  _checkAllDrawn(room, game) {
    const lockKey = `checkDrawn_${room}`;
    if (!this._drawLock.acquire(lockKey, 5000)) return;
    
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._state !== 'draw') return;
      if (game.evaluationLocked || game._isEvaluating) return;
      if (game.drawTimeExpired) return;
      if (game._isCleaningUp) return;
      
      const activeIds = this._getActivePlayerIds(game);
      const drawnCount = game.numbers.size;
      
      if (activeIds.length === 1) {
        const winnerId = activeIds[0];
        const winnerName = game.players.get(winnerId)?.name || winnerId;
        const totalCoin = game.betAmount * game.players.size;
        
        if (game._startedByRecording) {
          this._addLowCardWinner(room, winnerName);
          this._broadcastLowCardWinners(room);
        }
        
        game._gameEnded = true;
        game._isActive = false;
        this._broadcastToRoom(room, ["gameLowCardWinner", winnerName, totalCoin]);
        this._forceCleanupGame(room, game);
        return;
      }
      
      if (drawnCount === activeIds.length && activeIds.length > 1) {
        game.evaluationLocked = true;
        this._broadcastToRoom(room, ["gameLowCardWait", "wait results"]);
        
        if (game._drawTimer) { 
          this._gameTimerManager.clearTimeout(game._drawTimer);
          game._drawTimer = null; 
        }
        
        const evalTimer = this._gameTimerManager.setTimeout(() => {
          const currentGame = this.activeGames.get(room);
          if (currentGame !== game) return;
          if (this._isGameActuallyRunning(game) && !game._gameEnded && game._state === 'draw' && !game._isCleaningUp) {
            this._evaluateRound(room, game);
          }
        }, CONSTANTS.EVALUATION_DELAY_MS, this);
        game._evalTimer = evalTimer;
      }
      
    } finally {
      this._drawLock.release(lockKey);
    }
  }

  // ============================================================
  // GAME: CLOSE DRAW PHASE (LOWCARD) - FIXED RACE CONDITION
  // ============================================================
  
  async _closeDrawPhase(room, game) {
    const drawLockKey = `draw_${room}`;
    if (!this._drawLock.acquire(drawLockKey, 10000)) return;
    
    try {
      if (!this._isGameActuallyRunning(game) || game.drawTimeExpired || game.evaluationLocked || game._isEvaluating) {
        return;
      }
      if (game._isCleaningUp) return;
      
      this._cleanupGameTimers(game);
      game.drawTimeExpired = true;
      game.evaluationLocked = true;
      
      if (game.botPlayers?.size > 0 && this._isGameActuallyRunning(game)) {
        const activeBotIds = Array.from(game.botPlayers.keys())
          .filter(id => !game.eliminated?.has(id) && !game.numbers?.has(id));
        for (const botId of activeBotIds) {
          this._forceBotDraw(room, botId, game);
        }
      }
      
      const activeIds = this._getActivePlayerIds(game);
      const submittedIds = new Set(game.numbers?.keys() || []);
      const notSubmitted = activeIds.filter(id => !submittedIds.has(id) && !game.eliminated?.has(id));
      
      if (notSubmitted.length > 0 && submittedIds.size === 0) {
        this._broadcastToRoom(room, ["gameLowCardError", "No one submitted numbers"]);
        this._forceCleanupGame(room, game);
        return;
      }
      
      for (const id of notSubmitted) {
        if (!game.eliminated) game.eliminated = new Set();
        game.eliminated.add(id);
        game.numbers?.delete(id);
        game.tanda?.delete(id);
      }
      
      const remaining = Array.from(game.players.keys()).filter(id => !game.eliminated?.has(id));
      
      if (remaining.length === 1 && !game._gameEnded) {
        const winnerId = remaining[0];
        const winnerName = game.players.get(winnerId)?.name || winnerId;
        const totalCoin = (game.betAmount || 0) * (game.players?.size || 0);
        
        if (game._startedByRecording) {
          await this._addLowCardWinner(room, winnerName);
          await this._broadcastLowCardWinners(room);
        }
        
        this._broadcastToRoom(room, ["gameLowCardWinner", winnerName, totalCoin]);
        this._forceCleanupGame(room, game);
        return;
      }
      
      if (remaining.length === 0) {
        this._broadcastToRoom(room, ["gameLowCardError", "All players eliminated"]);
        this._forceCleanupGame(room, game);
        return;
      }
      
      this._broadcastToRoom(room, ["gameLowCardWait", "wait results"]);
      
      const evalTimer = this._gameTimerManager.setTimeout(() => {
        try {
          const currentGame = this.activeGames.get(room);
          if (currentGame && currentGame === game && currentGame._isActive && !currentGame._gameEnded && !currentGame._isCleaningUp) {
            this._evaluateRound(room, game);
          }
        } catch(e) {}
      }, CONSTANTS.EVALUATION_DELAY_MS || 2000, this);
      game._evalTimer = evalTimer;
      
    } finally {
      this._drawLock.release(drawLockKey);
    }
  }

  // ============================================================
  // GAME: EVALUATE ROUND (LOWCARD) - FIXED RACE CONDITION
  // ============================================================
  
  async _evaluateRound(room, game) {
    const evalLockKey = `eval_${room}`;
    if (!this._evaluationLock.acquire(evalLockKey, 15000)) return;
    
    try {
      if (this.isDestroyed || !game || game._isEvaluating || !game._isActive || game._gameEnded) {
        return;
      }
      if (game._isCleaningUp) return;
      
      const currentGame = this.activeGames.get(room);
      if (currentGame !== game) return;
      
      this._cleanupGameTimers(game);
      game._isEvaluating = true;
      game._evalStartTime = Date.now();
      game._phase = 'evaluating';
      game._state = 'evaluating';
      
      let isEvaluationComplete = false;
      
      const safetyTimer = this._gameTimerManager.setTimeout(() => {
        if (isEvaluationComplete) return;
        if (game?._isEvaluating && !game._isCleaningUp) {
          game._isEvaluating = false;
          game.evaluationLocked = false;
          this._broadcastToRoom(room, ["gameLowCardError", "Timeout, melanjutkan..."]);
          if (this._isGameActuallyRunning(game) && !game._gameEnded && !game._isCleaningUp) {
            this._startDrawPhase(room, game);
          } else if (game && !game._isActive) {
            this._forceCleanupGame(room, game);
          }
        }
      }, CONSTANTS.EVALUATION_TIMEOUT_MS || 30000, this);
      game._safetyTimer = safetyTimer;
      
      try {
        const numbers = game.numbers || new Map();
        const players = game.players || new Map();
        const eliminated = game.eliminated || new Set();
        const tanda = game.tanda || new Map();
        const entries = Array.from(numbers.entries());
        const submittedIds = new Set(numbers.keys());
        const activeIds = this._getActivePlayerIds(game);
        
        for (const id of activeIds) {
          if (!submittedIds.has(id) && !game.eliminated?.has(id)) {
            game.eliminated.add(id);
          }
        }
        
        if (entries.length === 0) {
          game._isEvaluating = false;
          isEvaluationComplete = true;
          if (game._safetyTimer) { 
            this._gameTimerManager.clearTimeout(game._safetyTimer);
            game._safetyTimer = null; 
          }
          
          const remaining = Array.from(players.keys()).filter(id => !eliminated.has(id));
          
          if (remaining.length === 1) {
            const winnerId = remaining[0];
            const winnerName = players.get(winnerId)?.name || winnerId;
            const totalCoin = (game.betAmount || 0) * players.size;
            
            if (game._startedByRecording) {
              await this._addLowCardWinner(room, winnerName);
              await this._broadcastLowCardWinners(room);
            }
            
            this._broadcastToRoom(room, ["gameLowCardWinner", winnerName, totalCoin]);
            game._gameEnded = true;
            game._isActive = false;
            game._isEvaluating = false;
            this._forceCleanupGame(room, game);
            return;
          }
          
          this._broadcastToRoom(room, ["gameLowCardError", "No numbers drawn this round"]);
          game._gameEnded = true;
          game._isActive = false;
          game._isEvaluating = false;
          this._forceCleanupGame(room, game);
          return;
        }
        
        const values = entries.map(([, n]) => n);
        const allSame = values.every(v => v === values[0]);
        let losers = [];
        
        if (!allSame && values.length > 0) {
          const lowest = Math.min(...values);
          losers = entries.filter(([, n]) => n === lowest).map(([id]) => id);
          for (const id of losers) {
            eliminated.add(id);
          }
        }
        
        const remaining = Array.from(players.keys()).filter(id => !eliminated.has(id));
        
        if (!this._isGameActuallyRunning(game) || game._gameEnded) {
          game._isEvaluating = false;
          isEvaluationComplete = true;
          this._forceCleanupGame(room, game);
          return;
        }
        
        if (allSame && remaining.length >= 2) {
          game._isEvaluating = false;
          isEvaluationComplete = true;
          if (game._safetyTimer) { 
            this._gameTimerManager.clearTimeout(game._safetyTimer);
            game._safetyTimer = null; 
          }
          
          numbers.clear();
          tanda.clear();
          game.round++;
          game.evaluationLocked = false;
          game.drawTimeExpired = false;
          game._phase = 'draw';
          game._state = 'draw';
          game.numbers = new Map();
          game.tanda = new Map();
          game._botTimeouts = new Set();
          game._botTimers = new Set();
          
          const remainingNames = remaining.map(id => players.get(id)?.name || id);
          this._broadcastToRoom(room, ["gameLowCardRoundResult", 
            game.round - 1,
            entries.map(([id, n]) => `${players.get(id)?.name || id}:${n}${tanda.get(id) ? `(${tanda.get(id)})` : ''}`),
            [], 
            remainingNames, 
            true
          ]);
          
          if (this._isGameActuallyRunning(game) && !game._gameEnded && !game._isCleaningUp) {
            this._startDrawPhase(room, game);
          } else {
            this._forceCleanupGame(room, game);
          }
          return;
        }
        
        if (remaining.length === 1 && !game._gameEnded) {
          const winnerId = remaining[0];
          const winnerName = players.get(winnerId)?.name || winnerId;
          const totalCoin = (game.betAmount || 0) * players.size;
          
          if (game._startedByRecording) {
            await this._addLowCardWinner(room, winnerName);
            await this._broadcastLowCardWinners(room);
          }
          
          this._broadcastToRoom(room, ["gameLowCardWinner", winnerName, totalCoin]);
          game._gameEnded = true;
          game._isActive = false;
          game._isEvaluating = false;
          isEvaluationComplete = true;
          if (game._safetyTimer) { 
            this._gameTimerManager.clearTimeout(game._safetyTimer);
            game._safetyTimer = null; 
          }
          this._forceCleanupGame(room, game);
          return;
        }
        
        if (remaining.length === 0) {
          game._isEvaluating = false;
          isEvaluationComplete = true;
          if (game._safetyTimer) { 
            this._gameTimerManager.clearTimeout(game._safetyTimer);
            game._safetyTimer = null; 
          }
          game._gameEnded = true;
          game._isActive = false;
          this._broadcastToRoom(room, ["gameLowCardError", "All players eliminated"]);
          this._forceCleanupGame(room, game);
          return;
        }
        
        const numbersArr = entries.map(([id, n]) => `${players.get(id)?.name || id}:${n}${tanda.get(id) ? `(${tanda.get(id)})` : ''}`);
        const loserNames = [...losers].map(id => players.get(id)?.name || id);
        const remainingNames = remaining.map(id => players.get(id)?.name || id);
        
        this._broadcastToRoom(room, ["gameLowCardRoundResult", game.round, numbersArr, loserNames, remainingNames]);
        
        numbers.clear();
        tanda.clear();
        game.round++;
        game.evaluationLocked = false;
        game.drawTimeExpired = false;
        game._phase = 'draw';
        game._state = 'draw';
        game.numbers = new Map();
        game.tanda = new Map();
        game._botTimeouts = new Set();
        game._botTimers = new Set();
        game._isEvaluating = false;
        game._evalStartTime = null;
        isEvaluationComplete = true;
        
        if (game._safetyTimer) { 
          this._gameTimerManager.clearTimeout(game._safetyTimer);
          game._safetyTimer = null; 
        }
        
        if (this._isGameActuallyRunning(game) && !game._gameEnded && !game._isCleaningUp) {
          const activePlayers = this._getActivePlayers(game);
          if (activePlayers.length >= 2) {
            this._gameTimerManager.setTimeout(() => {
              if (this._isGameActuallyRunning(game) && !game._gameEnded && !game._isCleaningUp) {
                this._startDrawPhase(room, game);
              } else {
                this._forceCleanupGame(room, game);
              }
            }, 500, this);
          } else if (activePlayers.length === 1) {
            const winner = activePlayers[0].name;
            const totalCoin = game.betAmount * game.players.size;
            game._gameEnded = true;
            game._isActive = false;
            this._broadcastToRoom(room, ["gameLowCardWinner", winner, totalCoin]);
            this._forceCleanupGame(room, game);
          } else {
            this._forceCleanupGame(room, game);
          }
        } else {
          this._forceCleanupGame(room, game);
        }
        
      } catch(e) {
        if (game) {
          game._isEvaluating = false;
          game._evalStartTime = null;
          isEvaluationComplete = true;
          
          if (this._isGameActuallyRunning(game) && !game._gameEnded && !game._isCleaningUp) {
            this._broadcastToRoom(room, ["gameLowCardError", "Error, restarting round"]);
            this._gameTimerManager.setTimeout(() => {
              if (this._isGameActuallyRunning(game) && !game._gameEnded && !game._isCleaningUp) {
                this._startDrawPhase(room, game);
              } else {
                this._forceCleanupGame(room, game);
              }
            }, 1000, this);
          } else {
            this._forceCleanupGame(room, game);
          }
        }
      }
      
    } finally {
      this._evaluationLock.release(evalLockKey);
    }
  }

  // ============================================================
  // GAME: CONTINUE (LOWCARD)
  // ============================================================
  
  _continueGame(room, game) {
    try {
      if (!this._isGameActuallyRunning(game)) { 
        this._forceCleanupGame(room, game); 
        return; 
      }
      if (game._gameEnded) { 
        this._forceCleanupGame(room, game); 
        return; 
      }
      
      game.numbers = new Map();
      game.tanda = new Map();
      game.round++;
      game.evaluationLocked = false;
      game._isEvaluating = false;
      game._evalStartTime = null;
      game.drawTimeExpired = false;
      game._drawPhaseStart = Date.now();
      
      this._clearAllGameTimers(game);
      
      if (game._botTimers) {
        for (const timer of game._botTimers) {
          this._gameTimerManager.clearTimeout(timer);
        }
        game._botTimers = new Set();
      }
      
      this._evaluationLock.release(`eval_${room}`);
      this._drawLock.release(`draw_${room}`);
      
      this._startDrawPhase(room, game);
      
    } catch(e) {
      this._forceCleanupGame(room, game);
    }
  }

  // ============================================================
  // GAME: JOIN (LOWCARD) - FIXED RACE CONDITION
  // ============================================================
  
  async joinGame(ws, username) {
    const lockKey = `join_${username}`;
    if (!this._gameLock.acquire(lockKey, 5000)) {
      this._safeSend(ws, ["gameLowCardError", "Please wait"]);
      return;
    }
    
    try {
      if (this.isDestroyed) {
        this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]);
        return;
      }
      if (!username || typeof username !== 'string' || !username.trim()) {
        this._safeSend(ws, ["gameLowCardError", "Username is required"]);
        return;
      }
      
      const usernameClean = username.trim();
      const wsId = ws._wsId;
      const room = ws.room || ws.roomname || this.clientRooms.get(wsId);
      
      if (!room || typeof room !== 'string' || room.trim() === '') {
        this._safeSend(ws, ["gameLowCardError", "Please switch to a room first"]);
        return;
      }
      
      const game = this.activeGames.get(room);
      if (!game?._isActive || game._gameEnded || !game.players) {
        this._safeSend(ws, ["gameLowCardError", "No active game in this room"]);
        return;
      }
      
      if (game.players.has(usernameClean)) {
        if (game.eliminated?.has(usernameClean)) {
          this._safeSend(ws, ["gameLowCardError", "You have been eliminated"]);
          return;
        }
        if (game.numbers.has(usernameClean)) {
          this._safeSend(ws, ["gameLowCardPlayerDraw", usernameClean, game.numbers.get(usernameClean), game.tanda.get(usernameClean) || ""]);
        }
        return;
      }
      
      if (!game.registrationOpen) {
        this._safeSend(ws, ["gameLowCardNoJoin", usernameClean, game.betAmount]);
        this._safeSend(ws, ["gameLowCardError", "Registration is closed"]);
        return;
      }
      
      if (game.players.size >= CONSTANTS.MAX_PLAYERS_PER_GAME) {
        this._safeSend(ws, ["gameLowCardError", "Game is full"]);
        return;
      }
      
      game.players.set(usernameClean, { id: usernameClean, name: usernameClean });
      this._addClient(room, ws, usernameClean);
      game.playerWsId.set(usernameClean, wsId);
      
      this._broadcastToRoom(room, ["gameLowCardJoin", usernameClean, game.betAmount]);
      
    } finally {
      this._gameLock.release(lockKey);
    }
  }

  // ============================================================
  // GAME: SUBMIT NUMBER (LOWCARD) - FIXED RACE CONDITION
  // ============================================================
  
  async submitNumber(ws, number, tanda, username) {
    const lockKey = `submit_${username}`;
    if (!this._gameLock.acquire(lockKey, 5000)) {
      this._safeSend(ws, ["gameLowCardError", "Please wait"]);
      return;
    }
    
    try {
      if (this.isDestroyed) {
        this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]);
        return;
      }
      if (!username || typeof username !== 'string' || !username.trim()) {
        this._safeSend(ws, ["gameLowCardError", "Username is required"]);
        return;
      }
      
      const usernameClean = username.trim();
      const wsId = ws._wsId;
      const room = ws.room || ws.roomname || this.clientRooms.get(wsId);
      
      if (!room || typeof room !== 'string' || room.trim() === '') {
        this._safeSend(ws, ["gameLowCardError", "Please switch to a room first"]);
        return;
      }
      
      const game = this.activeGames.get(room);
      if (!game?._isActive || game._gameEnded || !game.players) {
        this._safeSend(ws, ["gameLowCardError", "No active game"]);
        return;
      }
      
      if (game.players.has(usernameClean) && game.eliminated?.has(usernameClean)) {
        this._safeSend(ws, ["gameLowCardError", "You have been eliminated"]);
        return;
      }
      
      if (game.registrationOpen || game.evaluationLocked || game.drawTimeExpired || game._phase !== 'draw' || game._isEvaluating) {
        this._safeSend(ws, ["gameLowCardError", "Cannot submit now"]);
        return;
      }
      
      if (!game.players.has(usernameClean)) {
        this._safeSend(ws, ["gameLowCardError", "You are not in this game"]);
        return;
      }
      
      if (game.numbers.has(usernameClean)) {
        this._safeSend(ws, ["gameLowCardError", "You have already submitted"]);
        return;
      }
      
      const n = parseInt(number, 10);
      if (isNaN(n) || n < 1 || n > 12) {
        this._safeSend(ws, ["gameLowCardError", "Invalid number (1-12)"]);
        return;
      }
      
      const validTandas = ["C1", "C2", "C3", "C4", ""];
      if (!validTandas.includes(tanda)) tanda = "";
      
      game.numbers.set(usernameClean, n);
      game.tanda.set(usernameClean, tanda);
      
      this._broadcastToRoom(room, ["gameLowCardPlayerDraw", usernameClean, n, tanda]);
      
      const activeIds = this._getActivePlayerIds(game);
      if (game.numbers.size === activeIds.length && !game.evaluationLocked && !game.drawTimeExpired && 
          this._isGameActuallyRunning(game) && game._isActive && !game._gameEnded && !game._isCleaningUp) {
        
        game.evaluationLocked = true;
        if (game._evalTimer) { 
          this._gameTimerManager.clearTimeout(game._evalTimer);
          game._evalTimer = null; 
        }
        
        this._broadcastToRoom(room, ["gameLowCardWait", "wait results"]);
        
        const evalTimer = this._gameTimerManager.setTimeout(() => {
          try {
            const currentGame = this.activeGames.get(room);
            if (currentGame && currentGame === game && currentGame._isActive && !currentGame._gameEnded && !currentGame._isCleaningUp) {
              this._evaluateRound(room, game);
            }
          } catch(e) {}
        }, CONSTANTS.EVALUATION_DELAY_MS, this);
        game._evalTimer = evalTimer;
      }
      
    } finally {
      this._gameLock.release(lockKey);
    }
  }

  // ============================================================
  // GAME: START WITH RECORDING (LOWCARD)
  // ============================================================
  
  async _startGameWithRecording(ws, room, bet, username) {
    const lockKey = `startRec_${room}`;
    if (!this._gameLock.acquire(lockKey, 10000)) {
      this._safeSend(ws, ["gameLowCardError", "Game is starting, please wait"]);
      return;
    }
    
    try {
      if (!room || !username || typeof room !== 'string' || typeof username !== 'string') {
        this._safeSend(ws, ["gameLowCardError", "Room and username required"]);
        return;
      }
      
      const isRecordingEnabled = await this.dataManager.getRecordingStatus(room);
      if (!isRecordingEnabled) {
        this._safeSend(ws, ["gameLowCardError", "Recording is not enabled in this room"]);
        return;
      }
      
      const existingGame = this.activeGames.get(room);
      if (existingGame?._isActive && !existingGame._gameEnded) {
        this._safeSend(ws, ["gameLowCardError", "Game is already running"]);
        return;
      }
      if (existingGame) await this._forceCleanupGame(room, existingGame);
      
      const betAmount = parseInt(bet, 10) || 0;
      if (betAmount < 0 || (betAmount !== 0 && betAmount < 100) || betAmount > CONSTANTS.MAX_BET) {
        this._safeSend(ws, ["gameLowCardError", "Invalid bet (0 or 100-100000)"]);
        return;
      }
      
      if (this.activeGames.size >= CONSTANTS.MAX_LOWCARD_GAMES) {
        this._safeSend(ws, ["gameLowCardError", "Server is busy"]);
        return;
      }
      
      const wsId = ws._wsId;
      const game = {
        room,
        players: new Map(),
        botPlayers: new Map(),
        registrationOpen: true,
        round: 1,
        numbers: new Map(),
        tanda: new Map(),
        eliminated: new Set(),
        betAmount: betAmount,
        hostId: username,
        hostName: username,
        useBots: false,
        evaluationLocked: false,
        drawTimeExpired: false,
        _isActive: true,
        _gameEnded: false,
        _phase: 'registration',
        _state: 'registration',
        _botTimeouts: new Set(),
        _botTimers: new Set(),
        _botsAdded: false,
        _registrationTimer: null,
        _drawTimer: null,
        _evalTimer: null,
        _safetyTimer: null,
        _isEvaluating: false,
        _evalStartTime: null,
        _createdAt: Date.now(),
        _drawPhaseStart: null,
        _endTime: null,
        playerWsId: new Map(),
        _startedByRecording: true,
        _startedBy: 'recording',
        _notificationTimers: [],
        _drawNotificationTimers: [],
        _cleanupStarted: false,
        _evalLocks: new Map(),
        _gameVersion: Date.now(),
        _isCleaningUp: false,
        _registrationVersion: Date.now()
      };
      
      game.players.set(username, { id: username, name: username });
      game.playerWsId.set(username, wsId);
      this.activeGames.set(room, game);
      this._addClient(room, ws, username);
      
      this._broadcastToRoom(room, ["gameLowCardStart", betAmount]);
      this._broadcastToRoom(room, ["gameLowCardStartSuccess", username, betAmount]);
      
      this._startRegistration(room, game);
      
    } catch(e) {
      this._safeSend(ws, ["gameLowCardError", "Failed to start game"]);
    } finally {
      this._gameLock.release(lockKey);
    }
  }

  // ============================================================
  // RECORDING HELPERS
  // ============================================================
  
  async _broadcastLowCardWinners(room) {
    try {
      if (!room || typeof room !== 'string' || room.trim() === '') return;
      const roomKey = room.trim();
      const isRecording = await this.dataManager.getRecordingStatus(roomKey);
      if (!isRecording) return;
      const winners = await this.dataManager.getWinners(roomKey);
      const now = Date.now();
      const key = `broadcast_${roomKey}`;
      if (!this._lastNotifTime) this._lastNotifTime = {};
      if (this._lastNotifTime[key] && (now - this._lastNotifTime[key]) < 500) return;
      this._lastNotifTime[key] = now;
      this._broadcastToRoom(roomKey, ["lowCardWinnerUpdate", {
        winners: winners || {}, 
        room: roomKey, 
        recording: true
      }]);
    } catch(e) {}
  }

  async _addLowCardWinner(room, username) {
    try {
      if (!room || !username || room === CONSTANTS.DICE_ROOM) return false;
      const isRecording = await this.dataManager.getRecordingStatus(room);
      if (!isRecording) return false;
      return await this.dataManager.addWinner(room, username);
    } catch(e) { return false; }
  }

  // ============================================================
  // TIMER MANAGEMENT - FIXED RACE CONDITION
  // ============================================================
  
  _trackTimer(timer) {
    // Deprecated - use TimerManager instead
    return timer;
  }

  _clearTimer(timer) {
    // Deprecated - use TimerManager instead
    if (timer) {
      try { clearTimeout(timer); } catch(e) {}
      try { clearInterval(timer); } catch(e) {}
    }
  }

  _cleanupGameTimers(game) {
    if (!game) return;
    if (game._isCleaningUp) return;
    
    game._isCleaningUp = true;
    
    if (game._registrationTimer) { 
      this._gameTimerManager.clearTimeout(game._registrationTimer);
      game._registrationTimer = null; 
    }
    
    if (game._drawTimer) { 
      this._gameTimerManager.clearTimeout(game._drawTimer);
      game._drawTimer = null; 
    }
    
    if (game._evalTimer) { 
      this._gameTimerManager.clearTimeout(game._evalTimer);
      game._evalTimer = null; 
    }
    
    if (game._safetyTimer) { 
      this._gameTimerManager.clearTimeout(game._safetyTimer);
      game._safetyTimer = null; 
    }
    
    if (game._notificationTimers) {
      for (const timer of game._notificationTimers) {
        this._gameTimerManager.clearTimeout(timer);
      }
      game._notificationTimers = [];
    }
    
    if (game._drawNotificationTimers) {
      for (const timer of game._drawNotificationTimers) {
        this._gameTimerManager.clearTimeout(timer);
      }
      game._drawNotificationTimers = [];
    }
    
    if (game._botTimeouts) {
      for (const timeout of game._botTimeouts) {
        this._gameTimerManager.clearTimeout(timeout);
      }
      game._botTimeouts.clear();
    }
    
    if (game._botTimers) {
      for (const timer of game._botTimers) {
        this._gameTimerManager.clearTimeout(timer);
      }
      game._botTimers.clear();
    }
    
    game._isEvaluating = false;
    game._evalStartTime = null;
    game.evaluationLocked = false;
    game.drawTimeExpired = false;
    game.registrationOpen = false;
  }

  _clearAllGameTimers(game) {
    this._cleanupGameTimers(game);
  }

  // ============================================================
  // CLIENT MANAGEMENT
  // ============================================================
  
  _addClient(room, ws, username = null) {
    const lockKey = `addClient_${ws._wsId}`;
    if (!this._wsLock.acquire(lockKey, 5000)) {
      this._safeSend(ws, ["gameLowCardError", "Connection error"]);
      return;
    }
    
    try {
      if (!ws) return;
      const wsId = this._getWsId(ws);
      if (!wsId) { 
        this._safeSend(ws, ["gameLowCardError", "Connection error"]); 
        return; 
      }
      
      if (this.clientRooms.has(wsId)) {
        const oldRoom = this.clientRooms.get(wsId);
        if (oldRoom && oldRoom !== room) {
          this._removeClientFromRoom(oldRoom, wsId);
        }
      }
      
      ws.serializeAttachment({
        wsId: wsId,
        username: username,
        room: room,
        roomname: room,
        createdAt: ws._createdAt || Date.now()
      });
      
      if (username) {
        let conn = this.userConnections.get(username);
        if (conn) { 
          conn.room = room; 
          conn.timestamp = Date.now(); 
          conn.ws = ws; 
          conn.wsId = wsId; 
        } else { 
          this.userConnections.set(username, { wsId, ws, room, timestamp: Date.now() }); 
        }
        this._reconnectAttempts.delete(username);
      }
      
      let clients = this.wsClients.get(room);
      if (!clients) { 
        clients = new Set(); 
        this.wsClients.set(room, clients); 
      }
      clients.add(wsId);
      this.clientRooms.set(wsId, room);
      this.wsMap.set(wsId, ws);
      
      ws.room = room;
      ws.roomname = room;
      if (username) ws.username = username;
      
    } catch(e) {
      // Silent
    } finally {
      this._wsLock.release(lockKey);
    }
  }

  _removeClientFromRoom(room, wsId) {
    const lockKey = `removeClient_${wsId}`;
    if (!this._wsLock.acquire(lockKey, 3000)) return;
    
    try {
      if (!room || !wsId) return;
      const clients = this.wsClients.get(room);
      if (clients) { 
        clients.delete(wsId); 
        if (clients.size === 0) {
          this.wsClients.delete(room);
        }
      }
    } finally {
      this._wsLock.release(lockKey);
    }
  }

  _getWsId(ws) { return ws?._wsId || null; }

  // ============================================================
  // LOCK HELPERS
  // ============================================================
  
  _acquireLock(lockMap, key, timeoutMs = 5000) {
    // Deprecated - use AtomicLock instead
    if (lockMap.has(key)) return false;
    lockMap.set(key, Date.now());
    this._mainTimerManager.setTimeout(() => {
      if (lockMap.has(key)) lockMap.delete(key);
    }, timeoutMs, this);
    return true;
  }

  _releaseLock(lockMap, key) {
    // Deprecated - use AtomicLock instead
    if (lockMap.has(key)) { lockMap.delete(key); return true; }
    return false;
  }

  // ============================================================
  // UTILITY
  // ============================================================
  
  _safeSend(ws, message) {
    try {
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(message));
      return true;
    } catch(e) { return false; }
  }

  _handleError(type, error) {
    try {
      const now = Date.now();
      if (now - this._lastErrorReset > CONSTANTS.ERROR_RESET_INTERVAL_MS) {
        this._errorCount = 0;
        this._lastErrorReset = now;
      }
      this._errorCount++;
      if (this._errorCount > 20) { 
        this._circuitOpen = true; 
        this._lastResetTime = now; 
      }
    } catch(e) {}
  }

  _getTimeLeftUntilNextDice() {
    try {
      const witaTime = this._getCurrentWITATime();
      const currentTotal = witaTime.totalMinutes;
      let minDiff = Infinity;
      for (const session of QUIZ_SCHEDULE.SESSIONS) {
        const startTotal = parseTime(session.start);
        let diff = startTotal - currentTotal;
        if (diff < 0) diff += 24 * 60;
        if (diff < minDiff) minDiff = diff;
      }
      const hours = Math.floor(minDiff / 60);
      const minutes = Math.floor(minDiff % 60);
      const isRunning = this.alarmScheduler.isDiceTime();
      return { 
        hours, minutes, totalMs: minDiff * 60 * 1000,
        text: hours + "h " + minutes + "m", 
        isRunning 
      };
    } catch(e) {
      return { hours: 0, minutes: 0, totalMs: 0, text: '0h 0m', isRunning: false };
    }
  }

  _getCurrentWITATime() {
    try {
      const now = new Date();
      const hours = (now.getUTCHours() + QUIZ_SCHEDULE.TIMEZONE_OFFSET) % 24;
      const minutes = now.getUTCMinutes();
      return { hours, minutes, totalMinutes: (hours * 60) + minutes };
    } catch(e) { 
      return { hours: 0, minutes: 0, totalMinutes: 0 }; 
    }
  }

  // ============================================================
  // GAME: FORCE CLEANUP (LOWCARD) - FIXED RACE CONDITION
  // ============================================================
  
  async _forceCleanupGame(room, game) {
    const lockKey = `cleanup_${room}`;
    if (!this._gameLock.acquire(lockKey, 10000)) return;
    
    try {
      if (!game) return;
      if (game._isCleaningUp) return;
      
      game._isCleaningUp = true;
      game._gameEnded = true;
      game._isActive = false;
      
      this._cleanupGameTimers(game);
      
      this._broadcastToRoom(room, ["gameLowCardEnd", []]);
      
      // Clear game data
      game.players = null;
      game.botPlayers = null;
      game.numbers = null;
      game.tanda = null;
      game.eliminated = null;
      game.playerWsId = null;
      game._isActive = false;
      game._gameEnded = true;
      game._isEvaluating = false;
      game._evalStartTime = null;
      game.registrationOpen = false;
      game.evaluationLocked = false;
      game.drawTimeExpired = false;
      game._phase = null;
      game._state = null;
      game.round = 0;
      game.betAmount = 0;
      game.hostId = null;
      game.hostName = null;
      game.useBots = false;
      game._botsAdded = false;
      game._createdAt = null;
      game._drawPhaseStart = null;
      game._endTime = Date.now();
      game._startedByRecording = false;
      game._startedBy = null;
      game._notificationTimers = [];
      game._drawNotificationTimers = [];
      game._botTimeouts = null;
      game._botTimers = null;
      game._cleanupStarted = false;
      game._evalLocks = null;
      
      this.activeGames.delete(room);
      
      this._gameLock.release(`game_start_${room}`);
      this._gameLock.release(`join_${room}`);
      this._gameLock.release(`cleanup_${room}`);
      this._evaluationLock.release(`eval_${room}`);
      this._drawLock.release(`draw_${room}`);
      this._drawLock.release(`startDraw_${room}`);
      this._registrationLock.release(`registration_${room}`);
      this._registrationLock.release(`closeReg_${room}`);
      
    } catch(e) {
      // Silent
    } finally {
      this._gameLock.release(lockKey);
    }
  }

  // ============================================================
  // DESTROY - FIXED RACE CONDITION
  // ============================================================
  
  async destroy() {
    try {
      if (this.isDestroyed) return;
      this.isDestroyed = true;
      this.closing = true;
      
      // Clear all timers
      this._mainTimerManager.clearAll();
      this._diceTimerManager.clearAll();
      this._gameTimerManager.clearAll();
      this._tieTimerManager.clearAll();
      this._alarmTimerManager.clearAll();
      
      // Clear versioned timers
      this._diceVersionedTimer.invalidate();
      this._tieVersionedTimer.invalidate();
      this._gameVersionedTimer.invalidate();
      
      // Clear locks
      this._diceLock.clearAll();
      this._tieLock.clearAll();
      this._gameLock.clearAll();
      this._evaluationLock.clearAll();
      this._drawLock.clearAll();
      this._registrationLock.clearAll();
      this._wsLock.clearAll();
      this._stateLock.clearAll();
      
      // Clear all games
      for (const [room, game] of this.activeGames) {
        if (game._isActive && !game._gameEnded) {
          game._gameEnded = true;
          game._isActive = false;
          game._isCleaningUp = true;
          this._broadcastToRoom(room, ["gameLowCardEnd", ["Server shutting down"]]);
        }
        this._cleanupGameTimers(game);
        await this._forceCleanupGame(room, game);
      }
      this.activeGames.clear();
      
      // Clear queues and maps
      this._eventQueue = [];
      this._processingQueue = false;
      this.userConnections.clear();
      this._tieBreakers.clear();
      this._reconnectAttempts.clear();
      
      if (this.alarmScheduler) { 
        await this.alarmScheduler.cleanup(); 
      }
      
      // Close all WebSockets
      for (const [wsId, ws] of this.wsMap) {
        try { 
          if (ws && ws.readyState === 1) {
            ws.removeAllListeners();
            ws.close(1000, "Server shutting down"); 
          }
        } catch(e) {}
      }
      this.wsMap.clear();
      this.wsClients.clear();
      this.clientRooms.clear();
      
      try { await this.ctx.storage.deleteAlarm(); } catch(e) {}
      
    } catch(e) {
      // Silent
    }
  }
}

export default GameServer;
