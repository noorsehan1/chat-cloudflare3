// ============================================================
// GAME-SERVER-D1-FINAL-COMPLETE.js
// VERSION: 12.6.0 - ALL FIXES INCLUDED
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
  MAX_BOT_DRAWS_PER_ROUND: 4,
  EVALUATION_TIMEOUT_MS: 30000,
  MAX_PLAYERS_PER_GAME: 45,
  MAX_WS_CLIENTS: 150,
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
  
  GAME_STATE: {
    IDLE: 'idle',
    REGISTRATION: 'registration',
    DRAW: 'draw',
    EVALUATING: 'evaluating',
    ENDED: 'ended'
  },
  
  GAME_TIMEOUT: {
    REGISTRATION: 20000,
    DRAW: 20000,
    EVALUATION: 30000,
    SAFETY: 35000,
    STALE_GAME: 120000
  }
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
    this._initPromise = null;
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    
    this._initPromise = (async () => {
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
        console.error('DB Init error:', e);
        return false;
      }
    })();
    
    return this._initPromise;
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
    
    this._cacheLoading = true;
    try {
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
      console.error('Load data error:', e);
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
    }
  }

  async _ensureCacheInitialized(timeoutMs = 5000) {
    if (this._cacheInitialized && this._cache) {
      return this._cache;
    }
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Cache initialization timeout')), timeoutMs);
    });
    
    try {
      await Promise.race([
        this.loadAllData(),
        timeoutPromise
      ]);
    } catch(e) {
      console.error('Cache init timeout, using empty cache');
      this._cache = {
        recordingStatusMap: {},
        winnersMap: {},
        dicePoints: {},
        lastWeekWinner: null,
        lastResetWeek: null,
        scheduled_alarms: {}
      };
      this._cacheInitialized = true;
    }
    
    return this._cache;
  }

  async _save(key, value) {
    try {
      const cleanValue = value === undefined ? null : value;
      await this.db
        .prepare(`INSERT OR REPLACE INTO ${TABLE_NAME} (key, value) VALUES (?, ?)`)
        .bind(key, JSON.stringify(cleanValue))
        .run();
      
      this._cache[key] = cleanValue;
      
    } catch(e) {
      console.error(`Save error for key ${key}:`, e);
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

  async getAllRecordingStatus() {
    await this._ensureCacheInitialized();
    return this._cache.recordingStatusMap;
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
    const winners = await this.getWinners(room);
    let count = parseInt(String(winners[username] || "0").replace("x", "")) || 0;
    winners[username] = (count + 1) + "x";
    await this.setWinners(room, winners);
    return true;
  }

  async deleteAllWinners(room) {
    await this._ensureCacheInitialized();
    delete this._cache.winnersMap[room];
    await this._save('winnersMap', this._cache.winnersMap);
    return true;
  }

  async getAllWinners() {
    await this._ensureCacheInitialized();
    return this._cache.winnersMap;
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
        if (numericScore > 0) {
          cleanPoints[username] = numericScore;
        }
      }
    }
    this._cache.dicePoints = cleanPoints;
    await this._save('dicePoints', this._cache.dicePoints);
    return true;
  }

  async addDicePoint(username) {
    await this._ensureCacheInitialized();
    const points = await this.getDicePoints();
    points[username] = (points[username] || 0) + 1;
    await this.setDicePoints(points);
    return points;
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
    
    const safeLimit = Math.min(
      Math.max(limit, CONSTANTS.MIN_LEADERBOARD_LIMIT),
      CONSTANTS.MAX_LEADERBOARD_LIMIT
    );
    
    const sorted = Object.entries(points)
      .filter(([username, score]) => username && score > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, safeLimit);
    
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

  async clearAllData() {
    await this._ensureCacheInitialized();
    this._cache = {
      recordingStatusMap: {},
      winnersMap: {},
      dicePoints: {},
      lastWeekWinner: null,
      lastResetWeek: null,
      scheduled_alarms: {}
    };
    await this.db.prepare(`DELETE FROM ${TABLE_NAME}`).run();
    this._cacheInitialized = true;
    return true;
  }

  async getStorageSize() {
    try {
      const result = await this.db
        .prepare(`SELECT COUNT(*) as count, SUM(LENGTH(value)) as size FROM ${TABLE_NAME}`)
        .first();
      return {
        keyCount: result?.count || 0,
        totalSizeBytes: result?.size || 0,
        totalSizeKB: ((result?.size || 0) / 1024).toFixed(2)
      };
    } catch(e) {
      return { error: e.message };
    }
  }

  isRestored() {
    return this._restored;
  }
}

// ============================================================
// ALARM SCHEDULER
// ============================================================

class AlarmScheduler {
  constructor(db, ctx) {
    this.db = db;
    this.ctx = ctx;
    this.dataManager = new DataManager(db);
    this._alarms = new Map();
  }

  async scheduleAlarms() {
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
        if (endDelay > 0) {
          await this._scheduleAlarm('dice_session_end', endDelay);
        }
      }
      
      return true;
    } catch(e) { 
      console.error('Schedule alarms error:', e);
      return false; 
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
      if (daysUntilReset === 0 && (currentHour > 0 || currentMinutes > 0 || currentSeconds > 0)) {
        daysUntilReset = 7;
      }
      
      const resetTime = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + daysUntilReset,
        0, 0, 0, 0
      ));
      
      const delayMs = resetTime.getTime() - now.getTime();
      
      if (delayMs > 0) {
        await this._scheduleAlarm(CONSTANTS.WEEKLY_RESET_ALARM, delayMs);
      }
      
      return true;
    } catch(e) {
      return false;
    }
  }

  async _scheduleAlarm(name, delayMs) {
    try {
      if (delayMs < 1000) delayMs = 1000;
      
      const scheduledAt = Date.now() + delayMs;
      const alarm = { 
        name, 
        scheduledAt,
        delayMs,
        timestamp: Date.now()
      };
      
      this._alarms.set(name, alarm);
      await this.dataManager.setAlarms(Object.fromEntries(this._alarms));
      await this._scheduleNearestAlarm();
      
      return true;
    } catch(e) { 
      return false; 
    }
  }

  async _scheduleNearestAlarm() {
    try {
      let nearestTime = Infinity;
      for (const [name, alarm] of this._alarms) {
        const time = alarm.scheduledAt || alarm.timestamp + alarm.delayMs;
        if (time < nearestTime && time > Date.now()) {
          nearestTime = time;
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
    try {
      this._alarms.clear();
      await this.dataManager.deleteAlarms();
      await this.ctx.storage.deleteAlarm();
    } catch(e) {}
  }

  async getPendingAlarms() {
    try {
      await this.restoreAlarms();
      
      const pending = [];
      const now = Date.now();
      const expired = [];
      
      for (const [name, alarm] of this._alarms) {
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
    }
  }

  async processAlarm(name) {
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
    } catch(e) {
      return null;
    }
  }

  async restoreAlarms() {
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
    } catch(e) { return false; }
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
      if (currentTotal >= startTotal && currentTotal < endTotal) {
        return true;
      }
    }
    return false;
  }

  async cleanup() {
    await this._clearAllAlarms();
  }
}

// ============================================================
// GAME SERVER - FINAL COMPLETE VERSION
// ============================================================

export class GameServer {
  constructor(state, env) {
    try {
      this.state = state;
      this.env = env;
      this.ctx = state;
      this.closing = false;
      this.isDestroyed = false;
      this._initialized = false;
      this._startTime = Date.now();
      this._wsIdCounter = 0;
      this._restored = false;
      
      this.db = env.DB;
      this.dataManager = new DataManager(this.db);
      this.alarmScheduler = new AlarmScheduler(this.db, this.ctx);
      
      // ===== GAME STORAGE =====
      this.activeGames = new Map();
      this.wsMap = new Map();
      this.wsClients = new Map();
      this.clientRooms = new Map();
      this.userConnections = new Map();
      
      // ===== LOCKS SYSTEM =====
      this._gameLocks = new Map();
      this._evalLocks = new Map();
      this._drawLocks = new Map();
      this._submitLocks = new Map();
      this._switchLocks = new Map();
      
      // ===== TIMERS SYSTEM =====
      this._allTimers = new Set();
      this._staleCheckInterval = null;
      
      // ===== DICE STATE =====
      this.currentDiceRoll = null;
      this._diceLocks = {};
      this._diceLockTimestamps = {};
      this.diceAnswered = new Set();
      this._playerAnswers = new Map();
      this._canSubmitDiceAnswer = false;
      this._diceRound = 0;
      this._diceSessionActive = false;
      this._diceSessionEnded = false;
      this._diceStartedByUser = false;
      this._diceTimeUpCooldown = false;
      this._isShowingDice = false;
      this._diceStartTime = null;
      this._diceQuestionStartTime = null;
      this._diceTimeout = null;
      this._diceCooldownTimer = null;
      this._diceTimeUpCooldownTimer = null;
      this._diceNotificationTimeouts = [];
      this.diceHasWinner = false;
      this.diceWinner = null;
      this.diceEndNotified = false;
      this._lastNotificationKey = "";
      this._lastNotificationTime = 0;
      this._lastSentRemaining = -1;
      this._diceNotifiedFlags = { 20: false, 10: false, 5: false, timeup: false };
      
      // ===== TIE BREAKER =====
      this._tieActive = false;
      this._tiePlayers = [];
      this._tieAnswers = new Map();
      this._tieRound = 0;
      this._tieTimer = null;
      this._tieInterval = null;
      this._tieLock = false;
      this._tieBreakers = new Map();
      this._tieNotificationTimeouts = [];
      this._tieTimeLimit = 20;
      this._tieCooldown = 15000;
      
      // ===== REQUEST TRACKING =====
      this._requestCount = 0;
      this._lastResetTime = Date.now();
      this._circuitOpen = false;
      this._errorCount = 0;
      this._lastErrorReset = Date.now();
      this._lastWinnerRequestTime = new Map();
      this._lastNotifTime = {};
      
      // ===== CONSTANTS =====
      this.DICE_ROOM = CONSTANTS.DICE_ROOM;
      this.GAME_STATE = CONSTANTS.GAME_STATE;
      
      // ===== RESTORE =====
      this._restoreAllState().then(() => {
        this._restored = true;
        this._startStaleGameChecker();
      }).catch(() => {
        this._restored = true;
        this._startStaleGameChecker();
      });
      
    } catch(e) {
      console.error('Constructor error:', e);
      this._restored = true;
    }
  }

  // ============================================================
  // STALE GAME CHECKER
  // ============================================================
  
  _startStaleGameChecker() {
    if (this._staleCheckInterval) return;
    
    this._staleCheckInterval = setInterval(() => {
      if (this.closing || this.isDestroyed) {
        if (this._staleCheckInterval) {
          clearInterval(this._staleCheckInterval);
          this._staleCheckInterval = null;
        }
        return;
      }
      
      this._checkStaleGames();
      this._cleanupStaleTimers();
    }, 30000);
    
    this._allTimers.add(this._staleCheckInterval);
  }
  
  _checkStaleGames() {
    try {
      const now = Date.now();
      const staleThreshold = CONSTANTS.GAME_TIMEOUT.STALE_GAME || 120000;
      
      for (const [room, game] of this.activeGames) {
        if (!game || !game._isActive || game._gameEnded) continue;
        
        const startedAt = game._startedAt || game._createdAt || now;
        const elapsed = now - startedAt;
        
        if (elapsed > staleThreshold) {
          console.warn(`[${room}] Stale game detected, force cleanup (${elapsed}ms)`);
          this._broadcastToRoom(room, ["gameLowCardError", "Game restarted due to timeout"]);
          this._forceCleanupGame(room, game);
          continue;
        }
        
        if (game._state === 'draw' && game._drawStartTime) {
          const drawElapsed = now - game._drawStartTime;
          if (drawElapsed > CONSTANTS.GAME_TIMEOUT.DRAW + 10000) {
            console.warn(`[${room}] Draw phase stuck, forcing close (${drawElapsed}ms)`);
            this._broadcastToRoom(room, ["gameLowCardTimeLeft", "TIME UP"]);
            this._closeDrawPhase(room, game);
          }
        }
        
        if (game._state === 'evaluating' && game._evalStartTime) {
          const evalElapsed = now - game._evalStartTime;
          if (evalElapsed > CONSTANTS.GAME_TIMEOUT.EVALUATION + 5000) {
            console.warn(`[${room}] Evaluation stuck, forcing continue (${evalElapsed}ms)`);
            game._isEvaluating = false;
            game.evaluationLocked = false;
            this._releaseLock(this._evalLocks, `eval_${room}`);
            this._continueGame(room, game);
          }
        }
      }
    } catch(e) {
      console.error('Stale game check error:', e);
    }
  }
  
  _cleanupStaleTimers() {
    try {
      const now = Date.now();
      const staleThreshold = 300000;
      
      const toRemove = [];
      for (const timer of this._allTimers) {
        if (timer._createdAt && (now - timer._createdAt) > staleThreshold) {
          toRemove.push(timer);
        }
      }
      
      for (const timer of toRemove) {
        this._clearTimer(timer);
      }
      
      if (toRemove.length > 0) {
        console.log(`Cleaned up ${toRemove.length} stale timers`);
      }
    } catch(e) {}
  }

  // ============================================================
  // STATE MACHINE
  // ============================================================
  
  _getValidTransitions() {
    return {
      [this.GAME_STATE.IDLE]: [this.GAME_STATE.REGISTRATION],
      [this.GAME_STATE.REGISTRATION]: [this.GAME_STATE.DRAW, this.GAME_STATE.ENDED],
      [this.GAME_STATE.DRAW]: [this.GAME_STATE.EVALUATING, this.GAME_STATE.ENDED],
      [this.GAME_STATE.EVALUATING]: [this.GAME_STATE.DRAW, this.GAME_STATE.ENDED],
      [this.GAME_STATE.ENDED]: []
    };
  }
  
  _changeGameState(game, newState) {
    if (!game) return false;
    
    const transitions = this._getValidTransitions();
    const allowed = transitions[game._state] || [];
    
    if (!allowed.includes(newState)) {
      console.warn(`[${game.room}] Invalid state transition: ${game._state} -> ${newState}`);
      return false;
    }
    
    const oldState = game._state;
    game._state = newState;
    game._stateChangedAt = Date.now();
    
    console.log(`[${game.room}] State: ${oldState} -> ${newState}`);
    return true;
  }

  // ============================================================
  // TIMER MANAGEMENT
  // ============================================================
  
  _trackTimer(timer) {
    if (timer) {
      timer._createdAt = Date.now();
      this._allTimers.add(timer);
    }
    return timer;
  }

  _clearTimer(timer) {
    if (timer) {
      try { clearTimeout(timer); } catch(e) {}
      try { clearInterval(timer); } catch(e) {}
      this._allTimers.delete(timer);
    }
  }

  _clearAllGameTimers(game) {
    if (!game) return;
    
    const timers = [
      game._regTimer, game._drawTimer, game._evalTimer,
      game._safetyTimer, game._startTimer
    ];
    
    for (const timer of timers) {
      this._clearTimer(timer);
    }
    
    if (game._notifTimers) {
      for (const timer of game._notifTimers) {
        this._clearTimer(timer);
      }
      game._notifTimers = [];
    }
    
    if (game._drawNotifTimers) {
      for (const timer of game._drawNotifTimers) {
        this._clearTimer(timer);
      }
      game._drawNotifTimers = [];
    }
    
    if (game._botTimers) {
      for (const timer of game._botTimers) {
        this._clearTimer(timer);
      }
      game._botTimers = new Set();
    }
    
    game._regTimer = null;
    game._drawTimer = null;
    game._evalTimer = null;
    game._safetyTimer = null;
    game._startTimer = null;
  }

  // ============================================================
  // LOCK MANAGEMENT
  // ============================================================
  
  _acquireLock(lockMap, key, timeoutMs = 5000) {
    if (!lockMap || !key) return false;
    if (lockMap.has(key)) return false;
    
    lockMap.set(key, Date.now());
    
    const timer = setTimeout(() => {
      if (lockMap.has(key)) {
        lockMap.delete(key);
      }
    }, timeoutMs);
    this._trackTimer(timer);
    
    return true;
  }

  _releaseLock(lockMap, key) {
    if (!lockMap || !key) return false;
    return lockMap.delete(key);
  }

  _isLocked(lockMap, key) {
    if (!lockMap || !key) return false;
    return lockMap.has(key);
  }

  // ============================================================
  // GET ROOM - HELPER FIXED
  // ============================================================
  
  _getClientRoom(ws) {
    try {
      if (!ws) return null;
      
      // 1. Check ws properties
      let room = ws.room || ws.roomname;
      if (room) return room;
      
      // 2. Check clientRooms map
      const wsId = ws._wsId;
      if (wsId) {
        room = this.clientRooms.get(wsId);
        if (room) return room;
      }
      
      // 3. Check WebSocket attachment
      try {
        const attachment = ws.deserializeAttachment();
        if (attachment && attachment.room) {
          return attachment.room;
        }
      } catch(e) {}
      
      // 4. Check userConnections
      if (ws.username) {
        const conn = this.userConnections.get(ws.username);
        if (conn && conn.room) {
          return conn.room;
        }
      }
      
      return null;
    } catch(e) {
      return null;
    }
  }
  
  _ensureClientInRoom(ws, room, username = null) {
    try {
      if (!ws || !room) return false;
      
      const wsId = ws._wsId;
      if (!wsId) return false;
      
      // Create room if not exists
      if (!this.wsClients.has(room)) {
        this.wsClients.set(room, new Set());
      }
      
      // Add client to room
      const clients = this.wsClients.get(room);
      if (!clients.has(wsId)) {
        clients.add(wsId);
        this.clientRooms.set(wsId, room);
        this.wsMap.set(wsId, ws);
      }
      
      // Update ws properties
      ws.room = room;
      ws.roomname = room;
      if (username) {
        ws.username = username;
      }
      
      // Update attachment
      try {
        ws.serializeAttachment({
          wsId: wsId,
          username: ws.username || null,
          room: room,
          roomname: room,
          createdAt: ws._createdAt || Date.now()
        });
      } catch(e) {}
      
      // Update user connections
      if (ws.username) {
        let conn = this.userConnections.get(ws.username);
        if (conn) {
          conn.wsId = wsId;
          conn.ws = ws;
          conn.room = room;
          conn.timestamp = Date.now();
        } else {
          this.userConnections.set(ws.username, {
            wsId: wsId,
            ws: ws,
            room: room,
            timestamp: Date.now()
          });
        }
      }
      
      return true;
    } catch(e) {
      console.error('Ensure client in room error:', e);
      return false;
    }
  }

  // ============================================================
  // BROADCAST
  // ============================================================
  
  _broadcastToRoom(room, message) {
    try {
      if (this.closing || this.isDestroyed || !room) return 0;
      
      const clients = this.wsClients.get(room);
      if (!clients || clients.size === 0) return 0;
      
      const msgStr = JSON.stringify(message);
      let sent = 0;
      const toRemove = [];
      
      for (const wsId of clients) {
        const ws = this.wsMap.get(wsId);
        if (ws && ws.readyState === 1 && !ws._closing) {
          try {
            ws.send(msgStr);
            sent++;
          } catch(e) {
            toRemove.push(wsId);
          }
        } else {
          toRemove.push(wsId);
        }
      }
      
      for (const wsId of toRemove) {
        clients.delete(wsId);
        this.wsMap.delete(wsId);
        this.clientRooms.delete(wsId);
        for (const [username, conn] of this.userConnections) {
          if (conn.wsId === wsId) {
            this.userConnections.delete(username);
            break;
          }
        }
      }
      
      if (clients.size === 0) {
        this.wsClients.delete(room);
      }
      
      return sent;
    } catch(e) {
      return 0;
    }
  }

  _safeSend(ws, message) {
    try {
      if (!ws || ws.readyState !== 1 || ws._closing) return false;
      ws.send(JSON.stringify(message));
      return true;
    } catch(e) { return false; }
  }

  _getRoomUsers(room) {
    try {
      if (!room) return [];
      
      const users = [];
      const clients = this.wsClients.get(room);
      if (!clients) return users;
      
      for (const wsId of clients) {
        const ws = this.wsMap.get(wsId);
        if (ws && ws.readyState === 1 && !ws._closing) {
          users.push({
            wsId: wsId,
            ws: ws,
            username: ws.username || 'Anonymous'
          });
        }
      }
      return users;
    } catch(e) { return []; }
  }

  // ============================================================
  // CLIENT MANAGEMENT
  // ============================================================
  
  _addClient(room, ws, username = null) {
    try {
      if (!room || !ws) return;
      
      const wsId = ws._wsId;
      if (!wsId) {
        this._safeSend(ws, ["gameLowCardError", "Connection error"]);
        return;
      }
      
      // Create room if not exists
      if (!this.wsClients.has(room)) {
        this.wsClients.set(room, new Set());
      }
      
      // Remove from old room
      const oldRoom = this.clientRooms.get(wsId);
      if (oldRoom && oldRoom !== room) {
        const oldClients = this.wsClients.get(oldRoom);
        if (oldClients) {
          oldClients.delete(wsId);
          if (oldClients.size === 0) {
            this.wsClients.delete(oldRoom);
          }
        }
      }
      
      // Update ws data
      ws.room = room;
      ws.roomname = room;
      if (username) {
        ws.username = username;
      }
      
      // Serialize attachment
      ws.serializeAttachment({
        wsId: wsId,
        username: ws.username || null,
        room: room,
        roomname: room,
        createdAt: ws._createdAt || Date.now()
      });
      
      // Update user connections
      if (ws.username) {
        let conn = this.userConnections.get(ws.username);
        if (conn) {
          conn.wsId = wsId;
          conn.ws = ws;
          conn.room = room;
          conn.timestamp = Date.now();
        } else {
          this.userConnections.set(ws.username, {
            wsId: wsId,
            ws: ws,
            room: room,
            timestamp: Date.now()
          });
        }
      }
      
      // Add to room
      const clients = this.wsClients.get(room);
      clients.add(wsId);
      this.clientRooms.set(wsId, room);
      this.wsMap.set(wsId, ws);
      
    } catch(e) {
      console.error('Add client error:', e);
    }
  }

  _removeClientFromRoom(room, wsId) {
    try {
      if (!room || !wsId) return;
      const clients = this.wsClients.get(room);
      if (clients) {
        clients.delete(wsId);
        if (clients.size === 0) {
          this.wsClients.delete(room);
        }
      }
    } catch(e) {}
  }

  // ============================================================
  // GAME HELPERS
  // ============================================================
  
  _isGameActuallyRunning(game) {
    return game && 
           game._isActive === true && 
           !game._gameEnded && 
           game.players && 
           game.players.size > 0 &&
           game._state !== this.GAME_STATE.ENDED &&
           game._state !== this.GAME_STATE.IDLE;
  }

  _getActivePlayers(game) {
    try {
      if (!game || !game._isActive || game._gameEnded || !game.players) return [];
      return Array.from(game.players.entries())
        .filter(([id]) => !game.eliminated?.has(id))
        .map(([, p]) => p);
    } catch(e) { return []; }
  }

  _getActivePlayerIds(game) {
    try {
      if (!game || !game._isActive || game._gameEnded || !game.players) return [];
      return Array.from(game.players.keys())
        .filter(id => !game.eliminated?.has(id));
    } catch(e) { return []; }
  }

  _getBotNumber(round) {
    if (round <= 2) {
      return Math.floor(Math.random() * 12) + 1;
    }
    return Math.random() < 0.6 
      ? [8, 9, 10, 11, 12][Math.floor(Math.random() * 5)]
      : [1, 2, 3, 4, 5, 6, 7][Math.floor(Math.random() * 7)];
  }

  _getCardTanda() {
    return ["C1", "C2", "C3", "C4"][Math.floor(Math.random() * 4)];
  }

  _getRandomDrawDelay() {
    return (Math.floor(Math.random() * 14) + 2) * 1000;
  }

  // ============================================================
  // GAME: START - FIXED
  // ============================================================
  
  async startGame(ws, bet, username) {
    try {
      if (this.isDestroyed || this.closing) {
        this._safeSend(ws, ["gameLowCardError", "Server shutting down"]);
        return;
      }
      
      if (!username || typeof username !== 'string' || !username.trim()) {
        this._safeSend(ws, ["gameLowCardError", "Username required"]);
        return;
      }
      
      const usernameClean = username.trim();
      
      // ✅ FIX: Get room using helper
      let room = this._getClientRoom(ws);
      
      if (!room) {
        this._safeSend(ws, ["gameLowCardError", "Please switch to a room first. Use: switchRoom 'RoomName' 'Username'"]);
        return;
      }
      
      if (room === this.DICE_ROOM) {
        this._safeSend(ws, ["gameLowCardError", "Cannot start game in Quiz room"]);
        return;
      }
      
      // ✅ Ensure client is properly registered in room
      this._ensureClientInRoom(ws, room, usernameClean);
      
      // Check if recording is enabled
      const isRecordingEnabled = await this.dataManager.getRecordingStatus(room);
      if (isRecordingEnabled) {
        this._safeSend(ws, ["gameLowCardError", "Recording is ACTIVE. Users cannot start games."]);
        return;
      }
      
      // Acquire lock
      const lockKey = `start_${room}`;
      if (!this._acquireLock(this._gameLocks, lockKey, 10000)) {
        this._safeSend(ws, ["gameLowCardError", "Game is starting..."]);
        return;
      }
      
      try {
        // Check existing game
        const existing = this.activeGames.get(room);
        if (existing && existing._isActive && !existing._gameEnded) {
          this._safeSend(ws, ["gameLowCardError", "Game already running"]);
          return;
        }
        
        // Cleanup existing if any
        if (existing) {
          this._forceCleanupGame(room, existing);
        }
        
        // Validate bet
        const betAmount = parseInt(bet, 10) || 0;
        if (betAmount < 0 || (betAmount > 0 && betAmount < 100) || betAmount > CONSTANTS.MAX_BET) {
          this._safeSend(ws, ["gameLowCardError", "Invalid bet (0 or 100-" + CONSTANTS.MAX_BET + ")"]);
          return;
        }
        
        // Check max games
        if (this.activeGames.size >= CONSTANTS.MAX_LOWCARD_GAMES) {
          this._safeSend(ws, ["gameLowCardError", "Server is busy"]);
          return;
        }
        
        const wsId = ws._wsId;
        
        // Create game
        const game = {
          room: room,
          players: new Map(),
          botPlayers: new Map(),
          betAmount: betAmount,
          round: 1,
          numbers: new Map(),
          tanda: new Map(),
          eliminated: new Set(),
          host: usernameClean,
          
          // State
          _isActive: true,
          _gameEnded: false,
          _state: this.GAME_STATE.REGISTRATION,
          _stateChangedAt: Date.now(),
          
          // Timers
          _regTimer: null,
          _drawTimer: null,
          _evalTimer: null,
          _safetyTimer: null,
          _startTimer: null,
          _notifTimers: [],
          _drawNotifTimers: [],
          _botTimers: new Set(),
          
          // Tracking
          _startedAt: Date.now(),
          _drawStartTime: null,
          _evalStartTime: null,
          _botsAdded: false,
          _startedBy: 'user',
          _startedByRecording: false,
          
          // Locks
          evaluationLocked: false,
          _isEvaluating: false,
          drawTimeExpired: false,
          registrationOpen: true,
          useBots: false,
          _cleanupStarted: false,
          
          // Player tracking
          playerWsId: new Map()
        };
        
        // Add host
        game.players.set(usernameClean, { id: usernameClean, name: usernameClean });
        if (wsId) {
          game.playerWsId.set(usernameClean, wsId);
        }
        this.activeGames.set(room, game);
        
        // Add client
        this._addClient(room, ws, usernameClean);
        
        // Broadcast
        this._broadcastToRoom(room, ["gameLowCardStart", betAmount]);
        this._broadcastToRoom(room, ["gameLowCardStartSuccess", usernameClean, betAmount]);
        
        // Start registration
        this._startRegistration(room, game);
        
      } finally {
        this._releaseLock(this._gameLocks, lockKey);
      }
      
    } catch(e) {
      console.error('Start game error:', e);
      this._safeSend(ws, ["gameLowCardError", "Failed to start game: " + e.message]);
    }
  }

  // ============================================================
  // GAME: REGISTRATION
  // ============================================================
  
  _startRegistration(room, game) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._state !== this.GAME_STATE.REGISTRATION) return;
      
      this._clearAllGameTimers(game);
      
      const notifications = [
        { delay: 5000, msg: "15s" },
        { delay: 10000, msg: "10s" },
        { delay: 15000, msg: "5s" }
      ];
      
      for (const n of notifications) {
        const timer = setTimeout(() => {
          if (this._isGameActuallyRunning(game) && 
              game._state === this.GAME_STATE.REGISTRATION) {
            this._broadcastToRoom(room, ["gameLowCardTimeLeft", n.msg]);
          }
        }, n.delay);
        this._trackTimer(timer);
        game._notifTimers.push(timer);
      }
      
      const timer = setTimeout(() => {
        if (this._isGameActuallyRunning(game) && 
            game._state === this.GAME_STATE.REGISTRATION) {
          this._broadcastToRoom(room, ["gameLowCardTimeLeft", "TIME UP"]);
          this._closeRegistration(room, game);
        }
      }, CONSTANTS.REGISTRATION_TIME_MS);
      this._trackTimer(timer);
      game._regTimer = timer;
      
    } catch(e) {
      console.error('Registration error:', e);
    }
  }

  // ============================================================
  // GAME: CLOSE REGISTRATION
  // ============================================================
  
  _closeRegistration(room, game) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._state !== this.GAME_STATE.REGISTRATION) return;
      
      // Check for human players
      const humanPlayers = Array.from(game.players.keys())
        .filter(id => !id.startsWith('BOT_'));
      
      if (humanPlayers.length === 0) {
        game._gameEnded = true;
        game._isActive = false;
        this._changeGameState(game, this.GAME_STATE.ENDED);
        this._broadcastToRoom(room, ["gameLowCardError", "No human players"]);
        this._forceCleanupGame(room, game);
        return;
      }
      
      if (!this._changeGameState(game, this.GAME_STATE.DRAW)) {
        console.warn(`[${room}] Cannot transition to DRAW`);
        this._forceCleanupGame(room, game);
        return;
      }
      
      this._clearAllGameTimers(game);
      game.registrationOpen = false;
      
      if (!game._botsAdded) {
        const humanCount = humanPlayers.length;
        
        if (humanCount < 2) {
          this._addBots(game, 4);
        } else if (game.players.size < 2) {
          const needed = Math.min(4 - game.players.size, CONSTANTS.MAX_BOTS_PER_GAME);
          if (needed > 0) this._addBots(game, needed);
        }
        game._botsAdded = true;
      }
      
      const activePlayers = this._getActivePlayers(game);
      if (activePlayers.length < 2) {
        if (activePlayers.length === 1) {
          const winner = activePlayers[0].name;
          const totalCoin = game.betAmount * game.players.size;
          game._gameEnded = true;
          game._isActive = false;
          this._changeGameState(game, this.GAME_STATE.ENDED);
          this._broadcastToRoom(room, ["gameLowCardWinner", winner, totalCoin]);
          this._forceCleanupGame(room, game);
          return;
        } else {
          game._gameEnded = true;
          game._isActive = false;
          this._changeGameState(game, this.GAME_STATE.ENDED);
          this._broadcastToRoom(room, ["gameLowCardError", "Not enough players"]);
          this._forceCleanupGame(room, game);
          return;
        }
      }
      
      const playersList = activePlayers.map(p => p.name);
      this._broadcastToRoom(room, ["gameLowCardClosed", playersList]);
      this._broadcastToRoom(room, ["gameLowCardNextRound", game.round]);
      
      this._startDrawPhase(room, game);
      
    } catch(e) {
      console.error('Close registration error:', e);
      this._forceCleanupGame(room, game);
    }
  }

  // ============================================================
  // GAME: ADD BOTS
  // ============================================================
  
  _addBots(game, count) {
    try {
      if (!game) return;
      
      const botNames = ["moz1", "moz2", "moz3", "moz4"];
      const existingBots = Array.from(game.players.keys())
        .filter(id => id.startsWith('BOT_'));
      const existingCount = existingBots.length;
      const maxToAdd = Math.min(count, CONSTANTS.MAX_BOTS_PER_GAME - existingCount);
      
      for (let i = 0; i < maxToAdd; i++) {
        const botId = `BOT_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`;
        const botName = botNames[(existingCount + i) % botNames.length];
        if (!game.players.has(botId)) {
          game.players.set(botId, { id: botId, name: botName });
          game.botPlayers.set(botId, botName);
        }
      }
      
      game.useBots = game.botPlayers.size > 0;
    } catch(e) {
      console.error('Add bots error:', e);
    }
  }

  // ============================================================
  // GAME: DRAW PHASE
  // ============================================================
  
  _startDrawPhase(room, game) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._state !== this.GAME_STATE.DRAW) return;
      
      game.numbers = new Map();
      game.tanda = new Map();
      game.drawTimeExpired = false;
      game.evaluationLocked = false;
      game._isEvaluating = false;
      game._drawStartTime = Date.now();
      
      this._clearAllGameTimers(game);
      
      const notifications = [
        { delay: 5000, msg: "15s" },
        { delay: 10000, msg: "10s" },
        { delay: 15000, msg: "5s" }
      ];
      
      for (const n of notifications) {
        const timer = setTimeout(() => {
          if (this._isGameActuallyRunning(game) && 
              game._state === this.GAME_STATE.DRAW &&
              !game.drawTimeExpired) {
            this._broadcastToRoom(room, ["gameLowCardTimeLeft", n.msg]);
          }
        }, n.delay);
        this._trackTimer(timer);
        game._drawNotifTimers.push(timer);
      }
      
      this._startBotDraws(room, game);
      
      const timer = setTimeout(() => {
        if (this._isGameActuallyRunning(game) && 
            game._state === this.GAME_STATE.DRAW &&
            !game.drawTimeExpired) {
          this._broadcastToRoom(room, ["gameLowCardTimeLeft", "TIME UP"]);
          this._closeDrawPhase(room, game);
        }
      }, CONSTANTS.DRAW_TIME_MS);
      this._trackTimer(timer);
      game._drawTimer = timer;
      
    } catch(e) {
      console.error('Draw phase error:', e);
      this._forceCleanupGame(room, game);
    }
  }

  // ============================================================
  // GAME: BOT DRAWS
  // ============================================================
  
  _startBotDraws(room, game) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game.botPlayers.size === 0) return;
      if (game._state !== this.GAME_STATE.DRAW) return;
      if (game.evaluationLocked || game._isEvaluating) return;
      
      const activeBotIds = Array.from(game.botPlayers.keys())
        .filter(id => !game.eliminated.has(id) && !game.numbers.has(id));
      
      const maxDraws = Math.min(activeBotIds.length, CONSTANTS.MAX_BOT_DRAWS_PER_ROUND);
      
      for (let i = 0; i < maxDraws; i++) {
        const botId = activeBotIds[i];
        const delay = this._getRandomDrawDelay();
        
        const timer = setTimeout(() => {
          if (!this._isGameActuallyRunning(game)) return;
          if (game._state !== this.GAME_STATE.DRAW) return;
          if (game.evaluationLocked || game._isEvaluating) return;
          if (game.eliminated.has(botId) || game.numbers.has(botId)) return;
          
          this._handleBotDraw(room, botId, game);
          game._botTimers.delete(timer);
        }, delay);
        
        this._trackTimer(timer);
        game._botTimers.add(timer);
      }
      
    } catch(e) {
      console.error('Start bot draws error:', e);
    }
  }

  _handleBotDraw(room, botId, game) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._state !== this.GAME_STATE.DRAW) return;
      if (game.evaluationLocked || game._isEvaluating) return;
      if (game.eliminated.has(botId) || game.numbers.has(botId)) return;
      
      const number = this._getBotNumber(game.round);
      const tanda = this._getCardTanda();
      
      game.numbers.set(botId, number);
      game.tanda.set(botId, tanda);
      
      const botName = game.players.get(botId)?.name || botId;
      this._broadcastToRoom(room, ["gameLowCardPlayerDraw", botName, number, tanda]);
      
      // Delay before check all drawn to avoid race condition
      setTimeout(() => {
        if (!game.evaluationLocked && !game._isEvaluating && 
            game._state === this.GAME_STATE.DRAW) {
          this._checkAllDrawn(room, game);
        }
      }, 100);
      
    } catch(e) {
      console.error('Handle bot draw error:', e);
    }
  }

  _forceBotDraw(room, botId, game) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game.eliminated.has(botId) || game.numbers.has(botId)) return;
      
      const number = this._getBotNumber(game.round);
      const tanda = this._getCardTanda();
      
      game.numbers.set(botId, number);
      game.tanda.set(botId, tanda);
      
      const botName = game.players.get(botId)?.name || botId;
      this._broadcastToRoom(room, ["gameLowCardPlayerDraw", botName, number, tanda]);
      
    } catch(e) {
      console.error('Force bot draw error:', e);
    }
  }

  // ============================================================
  // GAME: CHECK ALL DRAWN
  // ============================================================
  
  _checkAllDrawn(room, game) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._state !== this.GAME_STATE.DRAW) return;
      if (game.evaluationLocked || game._isEvaluating) return;
      if (game.drawTimeExpired) return;
      
      const activeIds = this._getActivePlayerIds(game);
      const drawnCount = game.numbers.size;
      
      // Handle 1 player
      if (activeIds.length === 1) {
        const winnerId = activeIds[0];
        const winnerName = game.players.get(winnerId)?.name || winnerId;
        const totalCoin = game.betAmount * game.players.size;
        
        game._gameEnded = true;
        game._isActive = false;
        this._changeGameState(game, this.GAME_STATE.ENDED);
        this._broadcastToRoom(room, ["gameLowCardWinner", winnerName, totalCoin]);
        this._forceCleanupGame(room, game);
        return;
      }
      
      if (drawnCount === activeIds.length && activeIds.length > 1) {
        game.evaluationLocked = true;
        this._broadcastToRoom(room, ["gameLowCardWait", "wait results"]);
        
        if (game._drawTimer) {
          this._clearTimer(game._drawTimer);
          game._drawTimer = null;
        }
        
        const evalTimer = setTimeout(() => {
          if (this._isGameActuallyRunning(game) && 
              !game._gameEnded &&
              game._state === this.GAME_STATE.DRAW) {
            this._evaluateRound(room, game);
          }
        }, CONSTANTS.EVALUATION_DELAY_MS);
        this._trackTimer(evalTimer);
        game._evalTimer = evalTimer;
      }
      
    } catch(e) {
      console.error('Check all drawn error:', e);
    }
  }

  // ============================================================
  // GAME: CLOSE DRAW PHASE
  // ============================================================
  
  async _closeDrawPhase(room, game) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._state !== this.GAME_STATE.DRAW) return;
      if (game.evaluationLocked || game._isEvaluating) return;
      if (game.drawTimeExpired) return;
      
      game.drawTimeExpired = true;
      game.evaluationLocked = true;
      
      this._clearAllGameTimers(game);
      
      const activeBotIds = Array.from(game.botPlayers.keys())
        .filter(id => !game.eliminated.has(id) && !game.numbers.has(id));
      
      for (const botId of activeBotIds) {
        this._forceBotDraw(room, botId, game);
      }
      
      const activeIds = this._getActivePlayerIds(game);
      const playersWithNumbers = new Set(game.numbers.keys());
      
      for (const id of activeIds) {
        if (!playersWithNumbers.has(id) && !id.startsWith('BOT_')) {
          game.eliminated.add(id);
        }
      }
      
      const remaining = Array.from(game.players.keys())
        .filter(id => !game.eliminated.has(id));
      
      if (remaining.length === 1) {
        const winnerId = remaining[0];
        const winnerName = game.players.get(winnerId)?.name || winnerId;
        const totalCoin = game.betAmount * game.players.size;
        
        if (game._startedByRecording) {
          await this._addLowCardWinner(room, winnerName);
          await this._broadcastLowCardWinners(room);
        }
        
        game._gameEnded = true;
        game._isActive = false;
        this._changeGameState(game, this.GAME_STATE.ENDED);
        this._broadcastToRoom(room, ["gameLowCardWinner", winnerName, totalCoin]);
        this._forceCleanupGame(room, game);
        return;
      }
      
      if (remaining.length < 1) {
        game._gameEnded = true;
        game._isActive = false;
        this._changeGameState(game, this.GAME_STATE.ENDED);
        this._broadcastToRoom(room, ["gameLowCardError", "All players eliminated"]);
        this._forceCleanupGame(room, game);
        return;
      }
      
      this._broadcastToRoom(room, ["gameLowCardWait", "wait results"]);
      
      const evalTimer = setTimeout(() => {
        if (this._isGameActuallyRunning(game) && 
            !game._gameEnded &&
            game._state === this.GAME_STATE.DRAW) {
          this._evaluateRound(room, game);
        }
      }, CONSTANTS.EVALUATION_DELAY_MS);
      this._trackTimer(evalTimer);
      game._evalTimer = evalTimer;
      
    } catch(e) {
      console.error('Close draw phase error:', e);
      this._forceCleanupGame(room, game);
    }
  }

  // ============================================================
  // GAME: EVALUATE ROUND
  // ============================================================
  
  async _evaluateRound(room, game) {
    const lockKey = `eval_${room}`;
    if (!this._acquireLock(this._evalLocks, lockKey, CONSTANTS.EVALUATION_TIMEOUT_MS)) {
      console.warn(`[${room}] Evaluation locked, skipping`);
      return;
    }
    
    try {
      if (!this._isGameActuallyRunning(game)) {
        console.warn(`[${room}] Game not running, skipping evaluation`);
        this._releaseLock(this._evalLocks, lockKey);
        return;
      }
      
      if (game._gameEnded) {
        console.warn(`[${room}] Game already ended, skipping evaluation`);
        this._releaseLock(this._evalLocks, lockKey);
        return;
      }
      
      if (game._isEvaluating) {
        console.warn(`[${room}] Already evaluating, skipping`);
        this._releaseLock(this._evalLocks, lockKey);
        return;
      }
      
      if (!this._changeGameState(game, this.GAME_STATE.EVALUATING)) {
        console.warn(`[${room}] Cannot transition to EVALUATING`);
        this._releaseLock(this._evalLocks, lockKey);
        this._forceCleanupGame(room, game);
        return;
      }
      
      game._isEvaluating = true;
      game.evaluationLocked = true;
      game._evalStartTime = Date.now();
      
      this._clearAllGameTimers(game);
      
      const safetyTimer = setTimeout(() => {
        if (game && game._isEvaluating) {
          console.warn(`[${room}] Evaluation timeout, forcing continue`);
          game._isEvaluating = false;
          game.evaluationLocked = false;
          this._releaseLock(this._evalLocks, lockKey);
          if (this._isGameActuallyRunning(game) && !game._gameEnded) {
            this._continueGame(room, game);
          } else {
            this._forceCleanupGame(room, game);
          }
        }
      }, CONSTANTS.EVALUATION_TIMEOUT_MS);
      this._trackTimer(safetyTimer);
      game._safetyTimer = safetyTimer;
      
      const numbers = game.numbers || new Map();
      const players = game.players || new Map();
      const eliminated = game.eliminated || new Set();
      const tanda = game.tanda || new Map();
      
      const entries = Array.from(numbers.entries());
      
      if (entries.length === 0) {
        game._isEvaluating = false;
        game.evaluationLocked = false;
        this._releaseLock(this._evalLocks, lockKey);
        this._changeGameState(game, this.GAME_STATE.ENDED);
        game._gameEnded = true;
        game._isActive = false;
        this._broadcastToRoom(room, ["gameLowCardError", "No numbers drawn"]);
        this._forceCleanupGame(room, game);
        return;
      }
      
      const values = entries.map(([, n]) => n);
      const allSame = values.every(v => v === values[0]);
      let losers = [];
      
      if (!allSame) {
        const lowest = Math.min(...values);
        losers = entries.filter(([, n]) => n === lowest).map(([id]) => id);
        for (const id of losers) {
          eliminated.add(id);
        }
      }
      
      const remaining = Array.from(players.keys())
        .filter(id => !eliminated.has(id));
      
      if (remaining.length === 0) {
        game._isEvaluating = false;
        game.evaluationLocked = false;
        this._releaseLock(this._evalLocks, lockKey);
        if (game._safetyTimer) {
          this._clearTimer(game._safetyTimer);
          game._safetyTimer = null;
        }
        
        game._gameEnded = true;
        game._isActive = false;
        this._changeGameState(game, this.GAME_STATE.ENDED);
        this._broadcastToRoom(room, ["gameLowCardError", "All players eliminated"]);
        this._forceCleanupGame(room, game);
        return;
      }
      
      const numbersArr = entries.map(([id, n]) => 
        `${players.get(id)?.name || id}:${n}${tanda.get(id) ? `(${tanda.get(id)})` : ''}`
      );
      const loserNames = losers.map(id => players.get(id)?.name || id);
      const remainingNames = remaining.map(id => players.get(id)?.name || id);
      
      if (allSame && remaining.length >= 2) {
        game._isEvaluating = false;
        game.evaluationLocked = false;
        this._releaseLock(this._evalLocks, lockKey);
        if (game._safetyTimer) {
          this._clearTimer(game._safetyTimer);
          game._safetyTimer = null;
        }
        
        this._broadcastToRoom(room, ["gameLowCardRoundResult", game.round, numbersArr, [], remainingNames, true]);
        this._continueGame(room, game);
        return;
      }
      
      if (remaining.length === 1) {
        const winnerId = remaining[0];
        const winnerName = players.get(winnerId)?.name || winnerId;
        const totalCoin = game.betAmount * game.players.size;
        
        if (game._startedByRecording) {
          await this._addLowCardWinner(room, winnerName);
          await this._broadcastLowCardWinners(room);
        }
        
        game._isEvaluating = false;
        game.evaluationLocked = false;
        this._releaseLock(this._evalLocks, lockKey);
        if (game._safetyTimer) {
          this._clearTimer(game._safetyTimer);
          game._safetyTimer = null;
        }
        
        game._gameEnded = true;
        game._isActive = false;
        this._changeGameState(game, this.GAME_STATE.ENDED);
        this._broadcastToRoom(room, ["gameLowCardWinner", winnerName, totalCoin]);
        this._forceCleanupGame(room, game);
        return;
      }
      
      this._broadcastToRoom(room, ["gameLowCardRoundResult", game.round, numbersArr, loserNames, remainingNames]);
      
      game._isEvaluating = false;
      game.evaluationLocked = false;
      this._releaseLock(this._evalLocks, lockKey);
      if (game._safetyTimer) {
        this._clearTimer(game._safetyTimer);
        game._safetyTimer = null;
      }
      
      this._continueGame(room, game);
      
    } catch(e) {
      console.error(`[${room}] Evaluation error:`, e);
      game._isEvaluating = false;
      game.evaluationLocked = false;
      this._releaseLock(this._evalLocks, lockKey);
      
      if (this._isGameActuallyRunning(game) && !game._gameEnded) {
        this._continueGame(room, game);
      } else {
        this._forceCleanupGame(room, game);
      }
    }
  }

  // ============================================================
  // GAME: CONTINUE
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
      
      if (!this._changeGameState(game, this.GAME_STATE.DRAW)) {
        console.warn(`[${room}] Cannot transition to DRAW from ${game._state}`);
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
      game._drawStartTime = Date.now();
      
      this._clearAllGameTimers(game);
      
      if (game._botTimers) {
        for (const timer of game._botTimers) {
          this._clearTimer(timer);
        }
        game._botTimers = new Set();
      }
      
      this._releaseLock(this._evalLocks, `eval_${room}`);
      this._releaseLock(this._drawLocks, `draw_${room}`);
      
      this._startDrawPhase(room, game);
      
    } catch(e) {
      console.error(`[${room}] Continue game error:`, e);
      this._forceCleanupGame(room, game);
    }
  }

  // ============================================================
  // GAME: JOIN - FIXED
  // ============================================================
  
  async joinGame(ws, username) {
    try {
      if (this.isDestroyed || this.closing) {
        this._safeSend(ws, ["gameLowCardError", "Server shutting down"]);
        return;
      }
      
      if (!username || typeof username !== 'string' || !username.trim()) {
        this._safeSend(ws, ["gameLowCardError", "Username required"]);
        return;
      }
      
      const usernameClean = username.trim();
      
      // ✅ FIX: Get room using helper
      let room = this._getClientRoom(ws);
      
      if (!room) {
        this._safeSend(ws, ["gameLowCardError", "Please switch to a room first"]);
        return;
      }
      
      if (room === this.DICE_ROOM) {
        this._safeSend(ws, ["gameLowCardError", "Cannot join game in Quiz room"]);
        return;
      }
      
      const game = this.activeGames.get(room);
      if (!game || !game._isActive || game._gameEnded) {
        this._safeSend(ws, ["gameLowCardError", "No active game in this room"]);
        return;
      }
      
      if (game._state !== this.GAME_STATE.REGISTRATION) {
        this._safeSend(ws, ["gameLowCardError", "Registration closed"]);
        return;
      }
      
      if (game.players.has(usernameClean)) {
        if (game.eliminated.has(usernameClean)) {
          this._safeSend(ws, ["gameLowCardError", "You have been eliminated"]);
          return;
        }
        this._safeSend(ws, ["gameLowCardError", "Already joined"]);
        return;
      }
      
      if (game.players.size >= CONSTANTS.MAX_PLAYERS_PER_GAME) {
        this._safeSend(ws, ["gameLowCardError", "Game full"]);
        return;
      }
      
      // Add player
      const wsId = ws._wsId;
      game.players.set(usernameClean, { id: usernameClean, name: usernameClean });
      if (wsId) {
        game.playerWsId.set(usernameClean, wsId);
      }
      this._addClient(room, ws, usernameClean);
      
      this._broadcastToRoom(room, ["gameLowCardJoin", usernameClean, game.betAmount]);
      
    } catch(e) {
      console.error('Join game error:', e);
      this._safeSend(ws, ["gameLowCardError", "Failed to join game"]);
    }
  }

  // ============================================================
  // GAME: SUBMIT NUMBER - FIXED
  // ============================================================
  
  async submitNumber(ws, number, tanda, username) {
    try {
      if (this.isDestroyed || this.closing) {
        this._safeSend(ws, ["gameLowCardError", "Server shutting down"]);
        return;
      }
      
      if (!username || typeof username !== 'string' || !username.trim()) {
        this._safeSend(ws, ["gameLowCardError", "Username required"]);
        return;
      }
      
      const usernameClean = username.trim();
      
      // ✅ FIX: Get room using helper
      let room = this._getClientRoom(ws);
      
      if (!room) {
        this._safeSend(ws, ["gameLowCardError", "No room found"]);
        return;
      }
      
      if (room === this.DICE_ROOM) {
        this._safeSend(ws, ["gameLowCardError", "Cannot submit in Quiz room"]);
        return;
      }
      
      const game = this.activeGames.get(room);
      if (!game || !game._isActive || game._gameEnded) {
        this._safeSend(ws, ["gameLowCardError", "No active game"]);
        return;
      }
      
      if (game._state !== this.GAME_STATE.DRAW) {
        this._safeSend(ws, ["gameLowCardError", "Not draw phase"]);
        return;
      }
      
      if (game.evaluationLocked || game._isEvaluating) {
        this._safeSend(ws, ["gameLowCardError", "Round is ending, please wait"]);
        return;
      }
      
      if (game.drawTimeExpired) {
        this._safeSend(ws, ["gameLowCardError", "Time expired"]);
        return;
      }
      
      if (game.eliminated.has(usernameClean)) {
        this._safeSend(ws, ["gameLowCardError", "You are eliminated"]);
        return;
      }
      
      if (game.numbers.has(usernameClean)) {
        this._safeSend(ws, ["gameLowCardError", "Already submitted"]);
        return;
      }
      
      const submitLockKey = `submit_${room}_${usernameClean}`;
      if (!this._acquireLock(this._submitLocks, submitLockKey, 3000)) {
        this._safeSend(ws, ["gameLowCardError", "Please wait"]);
        return;
      }
      
      try {
        if (game.numbers.has(usernameClean)) {
          this._safeSend(ws, ["gameLowCardError", "Already submitted"]);
          return;
        }
        
        const n = parseInt(number, 10);
        if (isNaN(n) || n < 1 || n > 12) {
          this._safeSend(ws, ["gameLowCardError", "Number must be 1-12"]);
          return;
        }
        
        const validTandas = ["C1", "C2", "C3", "C4", ""];
        const t = validTandas.includes(tanda) ? tanda : "";
        
        game.numbers.set(usernameClean, n);
        game.tanda.set(usernameClean, t);
        
        this._broadcastToRoom(room, ["gameLowCardPlayerDraw", usernameClean, n, t]);
        
        if (!game.evaluationLocked && !game._isEvaluating) {
          this._checkAllDrawn(room, game);
        }
        
      } finally {
        this._releaseLock(this._submitLocks, submitLockKey);
      }
      
    } catch(e) {
      console.error('Submit number error:', e);
      this._safeSend(ws, ["gameLowCardError", "Failed to submit"]);
    }
  }

  // ============================================================
  // GAME: START WITH RECORDING
  // ============================================================
  
  async _startGameWithRecording(ws, room, bet, username) {
    try {
      if (!room || !username) {
        this._safeSend(ws, ["gameLowCardError", "Room and username required"]);
        return;
      }
      
      const isRecordingEnabled = await this.dataManager.getRecordingStatus(room);
      if (!isRecordingEnabled) {
        this._safeSend(ws, ["gameLowCardError", "Recording not enabled"]);
        return;
      }
      
      const game = this.activeGames.get(room);
      if (game && game._isActive && !game._gameEnded) {
        this._safeSend(ws, ["gameLowCardError", "Game already running"]);
        return;
      }
      
      try {
        await this.startGame(ws, bet, username);
      } catch(startError) {
        this._safeSend(ws, ["gameLowCardError", startError.message || "Failed to start game"]);
        return;
      }
      
      const newGame = this.activeGames.get(room);
      if (newGame) {
        newGame._startedByRecording = true;
        newGame._startedBy = 'recording';
        this._safeSend(ws, ["gameLowCardStartSuccess", username, newGame.betAmount]);
      }
      
    } catch(e) {
      console.error('Start with recording error:', e);
      this._safeSend(ws, ["gameLowCardError", "Failed to start recording game"]);
    }
  }

  // ============================================================
  // GAME: FORCE CLEANUP
  // ============================================================
  
  _forceCleanupGame(room, game) {
    try {
      if (!game) {
        if (room) this.activeGames.delete(room);
        return;
      }
      
      if (game._cleanupStarted) return;
      game._cleanupStarted = true;
      
      this._changeGameState(game, this.GAME_STATE.ENDED);
      
      game._gameEnded = true;
      game._isActive = false;
      game._isEvaluating = false;
      game.evaluationLocked = false;
      game.registrationOpen = false;
      game.drawTimeExpired = false;
      
      this._clearAllGameTimers(game);
      
      if (game._botTimers) {
        for (const timer of game._botTimers) {
          this._clearTimer(timer);
        }
        game._botTimers = new Set();
      }
      
      if (game._notifTimers) {
        for (const timer of game._notifTimers) {
          this._clearTimer(timer);
        }
        game._notifTimers = [];
      }
      
      if (game._drawNotifTimers) {
        for (const timer of game._drawNotifTimers) {
          this._clearTimer(timer);
        }
        game._drawNotifTimers = [];
      }
      
      this._releaseLock(this._evalLocks, `eval_${room}`);
      this._releaseLock(this._gameLocks, `start_${room}`);
      this._releaseLock(this._drawLocks, `draw_${room}`);
      this._releaseLock(this._evalLocks, `eval_${room}`);
      
      game.players = null;
      game.botPlayers = null;
      game.numbers = null;
      game.tanda = null;
      game.eliminated = null;
      game.playerWsId = null;
      
      this.activeGames.delete(room);
      
      this._broadcastToRoom(room, ["gameLowCardEnd", []]);
      
      console.log(`[${room}] Game cleaned up`);
      
    } catch(e) {
      console.error('Force cleanup error:', e);
      if (room) this.activeGames.delete(room);
    }
  }

  // ============================================================
  // SWITCH ROOM - FIXED
  // ============================================================
  
  async switchRoom(ws, room, username = null) {
    try {
      const wsId = ws._wsId;
      if (!wsId) {
        this._safeSend(ws, ["switchRoomError", "Connection error"]);
        return;
      }
      
      const roomName = room?.trim();
      if (!roomName) {
        this._safeSend(ws, ["switchRoomError", "Invalid room name"]);
        return;
      }
      
      if (roomName === "undefined" || roomName === "null" || roomName === "") {
        this._safeSend(ws, ["switchRoomError", "Invalid room name"]);
        return;
      }
      
      const lockKey = `switch_${wsId}`;
      if (!this._acquireLock(this._switchLocks, lockKey, 5000)) {
        this._safeSend(ws, ["switchRoomError", "Please wait"]);
        return;
      }
      
      try {
        const user = username || ws.username;
        
        // Remove from old room
        const oldRoom = this.clientRooms.get(wsId);
        if (oldRoom) {
          const oldClients = this.wsClients.get(oldRoom);
          if (oldClients) {
            oldClients.delete(wsId);
            if (oldClients.size === 0) {
              this.wsClients.delete(oldRoom);
            }
          }
          
          // Remove from old game
          const oldGame = this.activeGames.get(oldRoom);
          if (oldGame && oldGame.playerWsId && user) {
            for (const [player, playerWsId] of oldGame.playerWsId) {
              if (playerWsId === wsId) {
                oldGame.playerWsId.delete(player);
                break;
              }
            }
          }
        }
        
        // Ensure new room exists
        if (!this.wsClients.has(roomName)) {
          this.wsClients.set(roomName, new Set());
        }
        
        // Add to new room
        const newClients = this.wsClients.get(roomName);
        newClients.add(wsId);
        this.clientRooms.set(wsId, roomName);
        this.wsMap.set(wsId, ws);
        
        // Update ws properties
        ws.room = roomName;
        ws.roomname = roomName;
        if (user) {
          ws.username = user;
        }
        
        // Update attachment
        try {
          ws.serializeAttachment({
            wsId: wsId,
            username: ws.username || null,
            room: roomName,
            roomname: roomName,
            createdAt: ws._createdAt || Date.now()
          });
        } catch(e) {}
        
        // Update user connections
        if (ws.username) {
          let conn = this.userConnections.get(ws.username);
          if (conn) {
            conn.wsId = wsId;
            conn.ws = ws;
            conn.room = roomName;
            conn.timestamp = Date.now();
          } else {
            this.userConnections.set(ws.username, {
              wsId: wsId,
              ws: ws,
              room: roomName,
              timestamp: Date.now()
            });
          }
        }
        
        // Update game state for new room
        const newGame = this.activeGames.get(roomName);
        if (newGame && newGame._isActive && !newGame._gameEnded && ws.username) {
          if (newGame.players.has(ws.username)) {
            newGame.playerWsId.set(ws.username, wsId);
          }
          
          if (newGame._state === this.GAME_STATE.DRAW && !newGame._gameEnded) {
            const playersList = this._getActivePlayers(newGame).map(p => p.name);
            this._safeSend(ws, ["gameLowCardClosed", playersList]);
            this._safeSend(ws, ["gameLowCardNextRound", newGame.round]);
            
            for (const [id, number] of newGame.numbers) {
              const name = newGame.players.get(id)?.name || id;
              const tanda = newGame.tanda.get(id) || "";
              this._safeSend(ws, ["gameLowCardPlayerDraw", name, number, tanda]);
            }
          } else if (newGame._state === this.GAME_STATE.REGISTRATION) {
            this._safeSend(ws, ["gameLowCardStart", newGame.betAmount]);
            this._safeSend(ws, ["gameLowCardStartSuccess", newGame.host, newGame.betAmount]);
          }
        }
        
        this._safeSend(ws, ["switchRoomSuccess", roomName]);
        
        // Send room state
        const isRecording = await this.dataManager.getRecordingStatus(roomName);
        this._safeSend(ws, ["recordingStatus", isRecording]);
        
        // Send game status
        const game = this.activeGames.get(roomName);
        if (game && game._isActive && !game._gameEnded) {
          this._safeSend(ws, ["gameStatus", "true"]);
        } else {
          this._safeSend(ws, ["gameStatus", "false"]);
        }
        
      } finally {
        this._releaseLock(this._switchLocks, lockKey);
      }
      
    } catch(e) {
      console.error('Switch room error:', e);
      this._safeSend(ws, ["switchRoomError", e.message || "Switch failed"]);
    }
  }

  // ============================================================
  // RECORDING HELPERS
  // ============================================================
  
  async _broadcastLowCardWinners(room) {
    try {
      if (!room) return;
      const isRecording = await this.dataManager.getRecordingStatus(room);
      if (!isRecording) return;
      
      const winners = await this.dataManager.getWinners(room);
      const now = Date.now();
      const key = `broadcast_${room}`;
      
      if (this._lastNotifTime[key] && (now - this._lastNotifTime[key]) < 500) return;
      this._lastNotifTime[key] = now;
      
      this._broadcastToRoom(room, ["lowCardWinnerUpdate", {
        winners: winners || {},
        room: room,
        recording: true
      }]);
    } catch(e) {}
  }

  async _addLowCardWinner(room, username) {
    try {
      if (!room || !username || room === this.DICE_ROOM) return false;
      const isRecording = await this.dataManager.getRecordingStatus(room);
      if (!isRecording) return false;
      return await this.dataManager.addWinner(room, username);
    } catch(e) { return false; }
  }

  // ============================================================
  // DICE GAME - (SAME AS BEFORE, KEEP)
  // ============================================================
  
  _acquireDiceLock(lockName, timeoutMs = 5000) {
    try {
      if (this._diceLocks && this._diceLocks[lockName]) {
        const timestamp = this._diceLockTimestamps?.[lockName] || 0;
        if (Date.now() - timestamp > timeoutMs) {
          this._diceLocks[lockName] = false;
          delete this._diceLockTimestamps[lockName];
        } else {
          return false;
        }
      }
      
      if (!this._diceLocks) this._diceLocks = {};
      if (!this._diceLockTimestamps) this._diceLockTimestamps = {};
      
      this._diceLocks[lockName] = true;
      this._diceLockTimestamps[lockName] = Date.now();
      
      setTimeout(() => {
        if (this._diceLocks && this._diceLocks[lockName]) {
          this._diceLocks[lockName] = false;
          delete this._diceLockTimestamps[lockName];
        }
      }, timeoutMs);
      
      return true;
    } catch(e) { return false; }
  }

  _releaseDiceLock(lockName) {
    try {
      if (this._diceLocks && this._diceLocks[lockName]) {
        this._diceLocks[lockName] = false;
        delete this._diceLockTimestamps[lockName];
        return true;
      }
      return false;
    } catch(e) { return false; }
  }

  _isDiceLocked(lockName) {
    return this._diceLocks && this._diceLocks[lockName] === true;
  }

  _forceReleaseAllLocks() {
    try {
      if (this._diceLocks) {
        for (const lockName in this._diceLocks) {
          if (this._diceLocks[lockName]) {
            const timestamp = this._diceLockTimestamps?.[lockName] || 0;
            if (Date.now() - timestamp > 10000) {
              this._diceLocks[lockName] = false;
              delete this._diceLockTimestamps[lockName];
            }
          }
        }
      }
    } catch(e) {}
  }

  _startDiceFast() {
    try {
      if (!this.alarmScheduler.isDiceTime()) return;
      if (this._diceSessionEnded) return;
      if (this._diceLock || this.currentDiceRoll || this._isShowingDice) return;
      if (this._diceTimeUpCooldown) return;
      
      if (!this._acquireDiceLock('start', 5000)) return;
      
      try {
        if (this._diceTimeout) {
          this._clearTimer(this._diceTimeout);
          this._diceTimeout = null;
        }
        if (this._diceCooldownTimer) {
          this._clearTimer(this._diceCooldownTimer);
          this._diceCooldownTimer = null;
        }
        if (this._diceTimeUpCooldownTimer) {
          this._clearTimer(this._diceTimeUpCooldownTimer);
          this._diceTimeUpCooldownTimer = null;
        }
        for (const timeout of this._diceNotificationTimeouts) {
          this._clearTimer(timeout);
        }
        this._diceNotificationTimeouts = [];
        
        this._diceSessionActive = true;
        this._diceLock = true;
        this._isShowingDice = true;
        this.diceAnswered = new Set();
        this._playerAnswers = new Map();
        this.diceHasWinner = false;
        this.diceWinner = null;
        
        const value = Math.floor(Math.random() * 6) + 1;
        this._diceRound = (this._diceRound || 0) + 1;
        this.currentDiceRoll = { value, timestamp: Date.now(), round: this._diceRound };
        this._diceStartTime = Date.now();
        this._diceQuestionStartTime = Date.now();
        this._canSubmitDiceAnswer = true;
        
        this._broadcastToRoom(this.DICE_ROOM, ["diceRoll", {
          value,
          timestamp: Date.now(),
          answerTime: 20,
          canAnswerNow: true,
          round: this._diceRound
        }]);
        this._broadcastToRoom(this.DICE_ROOM, ["diceNotification", "🎲 Draw your card!"]);
        
        this._diceNotificationTimeouts.push(
          setTimeout(() => {
            this._broadcastToRoom(this.DICE_ROOM, ["diceNotification", "15s remaining"]);
          }, 5000)
        );
        this._diceNotificationTimeouts.push(
          setTimeout(() => {
            this._broadcastToRoom(this.DICE_ROOM, ["diceNotification", "10s remaining"]);
          }, 10000)
        );
        this._diceNotificationTimeouts.push(
          setTimeout(() => {
            this._broadcastToRoom(this.DICE_ROOM, ["diceNotification", "5s remaining"]);
          }, 15000)
        );
        this._diceNotificationTimeouts.push(
          setTimeout(() => {
            this._broadcastToRoom(this.DICE_ROOM, ["diceNotification", "3s remaining"]);
          }, 17000)
        );
        
        this._diceTimeout = setTimeout(() => {
          this._endDiceRound();
        }, 20000);
        this._trackTimer(this._diceTimeout);
        
        this._releaseDiceLock('start');
        
      } catch(e) {
        console.error('Start dice error:', e);
        this._diceLock = false;
        this._isShowingDice = false;
        this._canSubmitDiceAnswer = false;
        this._releaseDiceLock('start');
      }
      
    } catch(e) {
      console.error('Start dice fast error:', e);
    }
  }

  _checkAndStartDice() {
    try {
      if (!this.alarmScheduler.isDiceTime()) return false;
      if (this._diceSessionEnded) return false;
      if (this._diceLock || this.currentDiceRoll || this._isShowingDice) return false;
      if (this._diceTimeUpCooldown) return false;
      
      this._diceSessionActive = true;
      this._diceStartedByUser = true;
      this._startDiceFast();
      this._broadcastToRoom(this.DICE_ROOM, ["diceNotification", "🎲 Quiz Started!"]);
      
      return true;
    } catch(e) { return false; }
  }

  async _endDiceRound() {
    try {
      if (this._diceTimeout) {
        this._clearTimer(this._diceTimeout);
        this._diceTimeout = null;
      }
      for (const timeout of this._diceNotificationTimeouts) {
        this._clearTimer(timeout);
      }
      this._diceNotificationTimeouts = [];
      
      this._canSubmitDiceAnswer = false;
      this._isShowingDice = false;
      
      const diceValue = this.currentDiceRoll?.value;
      const roundNumber = this._diceRound || 1;
      const correctPlayers = [];
      
      for (const player of this.diceAnswered) {
        if (this._playerAnswers.get(player) === diceValue) {
          correctPlayers.push(player);
        }
      }
      
      if (correctPlayers.length === 0) {
        this._broadcastToRoom(this.DICE_ROOM, ["diceNoWinner", {
          message: "No winner", value: diceValue, round: roundNumber
        }]);
      } else if (correctPlayers.length === 1) {
        const winner = correctPlayers[0];
        try {
          const points = await this.dataManager.addDicePoint(winner);
          this._broadcastToRoom(this.DICE_ROOM, ["diceWinner", {
            username: winner,
            totalPoints: points[winner] || 0,
            diceValue: diceValue,
            round: roundNumber
          }]);
        } catch(e) {
          this._broadcastToRoom(this.DICE_ROOM, ["diceWinner", {
            username: winner,
            totalPoints: 0,
            diceValue: diceValue,
            round: roundNumber
          }]);
        }
      } else if (correctPlayers.length > 1 && !this._tieActive) {
        this.currentDiceRoll = null;
        this._diceLock = false;
        this._isShowingDice = false;
        this._canSubmitDiceAnswer = false;
        await this._startTieBreaker(this.DICE_ROOM, correctPlayers);
        return;
      }
      
      this.currentDiceRoll = null;
      this._diceLock = false;
      this._isShowingDice = false;
      this._diceTimeUpCooldown = true;
      
      if (this._diceCooldownTimer) {
        this._clearTimer(this._diceCooldownTimer);
        this._diceCooldownTimer = null;
      }
      
      this._diceCooldownTimer = setTimeout(() => {
        this._diceTimeUpCooldown = false;
        this._diceLock = false;
        this._isShowingDice = false;
        this._canSubmitDiceAnswer = false;
        this.currentDiceRoll = null;
        this.diceAnswered = new Set();
        this._playerAnswers = new Map();
        this.diceHasWinner = false;
        this.diceWinner = null;
        this._diceNotifiedFlags = { 20: false, 10: false, 5: false, timeup: false };
        this._lastSentRemaining = -1;
        
        if (this._diceSessionActive && !this._diceSessionEnded) {
          if (!this.currentDiceRoll && !this._isShowingDice && !this._diceLock) {
            this._startDiceFast();
          }
        }
      }, CONSTANTS.TIE_BREAKER_COOLDOWN || 15000);
      this._trackTimer(this._diceCooldownTimer);
      
    } catch(e) {
      console.error('End dice round error:', e);
      this._diceLock = false;
      this._isShowingDice = false;
      this.currentDiceRoll = null;
      this._canSubmitDiceAnswer = false;
    }
  }

  async submitDiceAnswer(ws, username, guess) {
    try {
      if (!ws || !username) return;
      if (!this._canSubmitDiceAnswer) {
        this._safeSend(ws, ["diceError", "Round ended"]);
        return;
      }
      if (this.diceAnswered.has(username)) {
        this._safeSend(ws, ["diceError", "Already answered"]);
        return;
      }
      
      const guessValue = parseInt(guess, 10);
      if (isNaN(guessValue) || guessValue < 1 || guessValue > 6) {
        this._safeSend(ws, ["diceError", "Guess must be 1-6"]);
        return;
      }
      
      if (this._tieActive) {
        if (!this._tiePlayers.includes(username)) {
          this._safeSend(ws, ["diceError", "Not in tie breaker"]);
          return;
        }
        if (this._tieAnswers.has(username)) {
          this._safeSend(ws, ["diceError", "Already answered"]);
          return;
        }
        
        this._tieAnswers.set(username, guessValue);
        this.diceAnswered.add(username);
        this._broadcastToRoom(this.DICE_ROOM, ["diceAnswer", {
          username, guess: guessValue, isTieBreaker: true, tieRound: this._tieRound
        }]);
        
        if (this._tieAnswers.size === this._tiePlayers.length) {
          this._canSubmitDiceAnswer = false;
          this._isShowingDice = false;
          if (this._tieTimer) {
            this._clearTimer(this._tieTimer);
            this._tieTimer = null;
          }
          if (this._tieInterval) {
            this._clearTimer(this._tieInterval);
            this._tieInterval = null;
          }
          const tieId = this._getActiveTieBreakerId();
          if (tieId) {
            setTimeout(async () => {
              await this._processTieResults(this.DICE_ROOM, tieId, this._tiePlayers);
            }, 500);
          } else {
            this._resetTieBreakerState(null);
            this._startCooldownAfterTieBreaker();
          }
        }
        return;
      }
      
      if (!this.currentDiceRoll) {
        this._safeSend(ws, ["diceError", "No active round"]);
        return;
      }
      
      const diceValue = this.currentDiceRoll.value;
      this._playerAnswers.set(username, guessValue);
      this.diceAnswered.add(username);
      this._broadcastToRoom(this.DICE_ROOM, ["diceAnswer", {
        username, guess: guessValue, round: this._diceRound || 1
      }]);
      
      if (guessValue === diceValue && !this.diceHasWinner) {
        this.diceHasWinner = true;
        this.diceWinner = username;
      }
      
    } catch(e) {
      console.error('Submit dice answer error:', e);
    }
  }

  // ============================================================
  // TIE BREAKER
  // ============================================================
  
  async _startTieBreaker(room, players) {
    if (this._tieLock) return;
    this._tieLock = true;
    
    try {
      if (!players || players.length < 2 || this._tieActive) {
        this._tieLock = false;
        return;
      }
      
      if (this._tieTimer) {
        this._clearTimer(this._tieTimer);
        this._tieTimer = null;
      }
      if (this._tieInterval) {
        this._clearTimer(this._tieInterval);
        this._tieInterval = null;
      }
      for (const timeout of this._tieNotificationTimeouts) {
        this._clearTimer(timeout);
      }
      this._tieNotificationTimeouts = [];
      
      this._tieActive = true;
      this._tieRound = 0;
      this._tiePlayers = [...players];
      this._tieAnswers = new Map();
      
      const id = `tie_${Date.now()}`;
      this._tieBreakers.set(id, {
        players,
        round: 0,
        winner: null,
        status: 'waiting'
      });
      
      await this._runTieRound(room, id, players);
      
    } catch(e) {
      console.error('Start tie breaker error:', e);
    } finally {
      setTimeout(() => { this._tieLock = false; }, 2000);
    }
  }

  async _runTieRound(room, id, players) {
    const data = this._tieBreakers.get(id);
    if (!data) return;
    
    if (this._tieTimer) {
      this._clearTimer(this._tieTimer);
      this._tieTimer = null;
    }
    if (this._tieInterval) {
      this._clearTimer(this._tieInterval);
      this._tieInterval = null;
    }
    for (const timeout of this._tieNotificationTimeouts) {
      this._clearTimer(timeout);
    }
    this._tieNotificationTimeouts = [];
    
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
    
    this._broadcastToRoom(room, ["diceNotification",
      `Tie Round ${this._tieRound}: ${players.join(', ')}`
    ]);
    
    this._broadcastToRoom(room, ["diceTieBreaker", {
      round: this._tieRound,
      players: players
    }]);
    
    const timeLimit = CONSTANTS.TIE_BREAKER_TIME_LIMIT || 20;
    let isProcessed = false;
    
    this._tieNotificationTimeouts.push(
      setTimeout(() => {
        this._broadcastToRoom(room, ["diceNotification", "15s remaining"]);
      }, 5000)
    );
    this._tieNotificationTimeouts.push(
      setTimeout(() => {
        this._broadcastToRoom(room, ["diceNotification", "10s remaining"]);
      }, 10000)
    );
    this._tieNotificationTimeouts.push(
      setTimeout(() => {
        this._broadcastToRoom(room, ["diceNotification", "5s remaining"]);
      }, 15000)
    );
    this._tieNotificationTimeouts.push(
      setTimeout(() => {
        this._broadcastToRoom(room, ["diceNotification", "3s remaining"]);
      }, 17000)
    );
    
    this._tieTimer = setTimeout(() => {
      if (!isProcessed) {
        isProcessed = true;
        this._canSubmitDiceAnswer = false;
        this._isShowingDice = false;
        this._broadcastToRoom(room, ["diceNotification", "TIME UP"]);
        
        for (const timeout of this._tieNotificationTimeouts) {
          this._clearTimer(timeout);
        }
        this._tieNotificationTimeouts = [];
        
        const tieId = this._getActiveTieBreakerId();
        if (tieId) {
          this._processTieResults(room, tieId, players);
        } else {
          this._resetTieBreakerState(null);
          this._startCooldownAfterTieBreaker();
        }
      }
    }, (timeLimit * 1000) + 2000);
    this._trackTimer(this._tieTimer);
  }

  async _processTieResults(room, id, players) {
    const data = this._tieBreakers.get(id);
    if (!data) return;
    
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
    
    if (answeredCount === 0) {
      this._broadcastToRoom(room, ["diceNotification",
        `No one answered in Round ${this._tieRound} - Tie breaker ended`
      ]);
      this._broadcastToRoom(room, ["diceTieAnswer", {
        round: this._tieRound,
        results: [],
        winners: [],
        eliminated: players,
        status: 'no_answers'
      }]);
      this._resetTieBreakerState(id);
      this._startCooldownAfterTieBreaker();
      return;
    }
    
    if (answeredCount === 1) {
      const winner = entries[0].player;
      const answer = entries[0].answer;
      
      this._broadcastToRoom(room, ["diceNotification",
        `${winner} answered with ${answer} - Auto win!`
      ]);
      this._broadcastToRoom(room, ["diceTieAnswer", {
        round: this._tieRound,
        results: entries.map(e => `${e.player}:${e.answer}`),
        winners: [winner],
        eliminated: players.filter(p => p !== winner),
        status: 'single_winner'
      }]);
      
      try {
        const points = await this.dataManager.addDicePoint(winner);
        this._broadcastToRoom(room, ["diceWinner", {
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
        this._broadcastToRoom(room, ["diceWinner", {
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
      return;
    }
    
    const allSame = entries.every(e => e.answer === entries[0].answer);
    
    if (allSame) {
      this._broadcastToRoom(room, ["diceNotification",
        `All answered same value: ${entries[0].answer} - Tie again!`
      ]);
      
      const allPlayers = entries.map(e => e.player);
      this._broadcastToRoom(room, ["diceTieAnswer", {
        round: this._tieRound,
        results: entries.map(e => `${e.player}:${e.answer}`),
        winners: [],
        eliminated: [],
        status: 'all_same',
        allPlayers: allPlayers,
        value: entries[0].answer
      }]);
      
      this._tiePlayers = allPlayers;
      this._tieAnswers = new Map();
      data.players = allPlayers;
      data.status = 'waiting';
      
      const nextTimer = setTimeout(async () => {
        if (this._tieActive && this._tiePlayers.length > 1) {
          await this._runTieRound(room, id, this._tiePlayers);
        } else if (this._tiePlayers.length === 1) {
          await this._processSingleWinner(room, id, this._tiePlayers[0]);
        } else {
          this._broadcastToRoom(room, ["diceNotification", "No players remaining"]);
          this._resetTieBreakerState(id);
          this._startCooldownAfterTieBreaker();
        }
      }, 3000);
      this._trackTimer(nextTimer);
      return;
    }
    
    if (highestPlayers.length === 1) {
      const winner = highestPlayers[0];
      const losers = players.filter(p => p !== winner);
      
      this._broadcastToRoom(room, ["diceNotification",
        `${winner} wins with highest value: ${highest}`
      ]);
      this._broadcastToRoom(room, ["diceTieAnswer", {
        round: this._tieRound,
        results: entries.map(e => `${e.player}:${e.answer}`),
        winners: [winner],
        eliminated: losers,
        status: 'winner_found'
      }]);
      
      try {
        const points = await this.dataManager.addDicePoint(winner);
        this._broadcastToRoom(room, ["diceWinner", {
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
        this._broadcastToRoom(room, ["diceWinner", {
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
      return;
    }
    
    if (highestPlayers.length > 1) {
      this._broadcastToRoom(room, ["diceNotification",
        `Tie again! Round ${this._tieRound + 1} between: ${highestPlayers.join(', ')}`
      ]);
      
      this._broadcastToRoom(room, ["diceTieAnswer", {
        round: this._tieRound,
        results: entries.map(e => `${e.player}:${e.answer}`),
        winners: [],
        eliminated: players.filter(p => !highestPlayers.includes(p)),
        status: 'tie_continue',
        remainingPlayers: highestPlayers,
        nextRound: this._tieRound + 1
      }]);
      
      this._tiePlayers = highestPlayers;
      this._tieAnswers = new Map();
      data.players = highestPlayers;
      data.status = 'waiting';
      
      const nextTimer = setTimeout(async () => {
        if (this._tieActive && this._tiePlayers.length > 1) {
          await this._runTieRound(room, id, this._tiePlayers);
        } else if (this._tiePlayers.length === 1) {
          await this._processSingleWinner(room, id, this._tiePlayers[0]);
        } else {
          this._broadcastToRoom(room, ["diceNotification", "No players remaining"]);
          this._resetTieBreakerState(id);
          this._startCooldownAfterTieBreaker();
        }
      }, 3000);
      this._trackTimer(nextTimer);
      return;
    }
    
    this._resetTieBreakerState(id);
    this._startCooldownAfterTieBreaker();
  }

  async _processSingleWinner(room, id, winner) {
    if (!winner) {
      this._resetTieBreakerState(id);
      this._startCooldownAfterTieBreaker();
      return;
    }
    
    try {
      const points = await this.dataManager.addDicePoint(winner);
      this._broadcastToRoom(room, ["diceWinner", {
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
      this._broadcastToRoom(room, ["diceWinner", {
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
    this._broadcastToRoom(this.DICE_ROOM, ["diceNotification", "wait 15s"]);
    this._diceTimeUpCooldown = true;
    
    if (this._diceTimeUpCooldownTimer) {
      this._clearTimer(this._diceTimeUpCooldownTimer);
      this._diceTimeUpCooldownTimer = null;
    }
    
    this._diceTimeUpCooldownTimer = setTimeout(() => {
      this._diceTimeUpCooldownTimer = null;
      this._diceTimeUpCooldown = false;
      this._diceNotifiedFlags = { 20: false, 10: false, 5: false, timeup: false };
      this._lastSentRemaining = -1;
      this._lastNotificationKey = "";
      this._lastNotificationTime = 0;
      
      this._tieActive = false;
      this._tiePlayers = [];
      this._tieAnswers = new Map();
      this._tieRound = 0;
      
      this._diceLock = false;
      this._isShowingDice = false;
      this._canSubmitDiceAnswer = false;
      
      if (this._diceSessionActive && !this._diceSessionEnded) {
        if (!this.currentDiceRoll && !this._isShowingDice && !this._diceLock) {
          this._startDiceFast();
        }
      }
    }, CONSTANTS.TIE_BREAKER_COOLDOWN || 15000);
    this._trackTimer(this._diceTimeUpCooldownTimer);
  }

  _resetTieBreakerState(id) {
    if (id) {
      this._tieBreakers.delete(id);
    }
    
    if (this._tieTimer) {
      this._clearTimer(this._tieTimer);
      this._tieTimer = null;
    }
    if (this._tieInterval) {
      this._clearTimer(this._tieInterval);
      this._tieInterval = null;
    }
    for (const timeout of this._tieNotificationTimeouts) {
      this._clearTimer(timeout);
    }
    this._tieNotificationTimeouts = [];
    
    this._tieActive = false;
    this._tiePlayers = [];
    this._tieAnswers = new Map();
    this._tieRound = 0;
    this._canSubmitDiceAnswer = false;
    this._isShowingDice = false;
    this.currentDiceRoll = null;
    this._diceLock = false;
    this.diceAnswered = new Set();
    this._playerAnswers = new Map();
    this.diceHasWinner = false;
    this.diceWinner = null;
  }

  _getActiveTieBreakerId() {
    for (const [id, data] of this._tieBreakers) {
      if (data.status === 'waiting' || data.status === 'running') {
        return id;
      }
    }
    return null;
  }

  // ============================================================
  // WEBSOCKET HANDLERS
  // ============================================================
  
  async webSocketMessage(ws, message) {
    try {
      if (!ws || ws._closing || this.closing || this.isDestroyed) return;
      if (!this._restored) {
        let wait = 0;
        while (!this._restored && wait < 30) {
          await new Promise(resolve => setTimeout(resolve, 100));
          wait++;
        }
        if (!this._restored) {
          this._safeSend(ws, ["restoreError", "Server is still restoring"]);
          return;
        }
      }
      
      const data = JSON.parse(message);
      if (!Array.isArray(data) || data.length === 0) return;
      
      await this._handleEventInternal(ws, data);
      
    } catch(e) {
      // Silently ignore parse errors
    }
  }

  async _handleEventInternal(ws, data) {
    try {
      if (this.isDestroyed || !ws || !data || !data[0]) return;
      
      const evt = data[0];
      
      if (evt === "switchRoom") {
        await this.switchRoom(ws, data[1], data[2]);
        return;
      }
      
      if (evt === "checkGameRunning") {
        this._checkGameRunning(ws, data[1]);
        return;
      }
      
      if (evt === "startRecordingWinners") {
        const roomName = data[1]?.trim();
        if (!roomName) {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        await this.dataManager.setRecordingStatus(roomName, true);
        this._broadcastToRoom(roomName, ["recordingStatus", true]);
        this._safeSend(ws, ["startRecordingResult", { success: true }]);
        return;
      }
      
      if (evt === "stopRecordingWinners") {
        const roomName = data[1]?.trim();
        if (!roomName) {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        await this.dataManager.setRecordingStatus(roomName, false);
        await this.dataManager.deleteAllWinners(roomName);
        this._broadcastToRoom(roomName, ["recordingStatus", false]);
        this._safeSend(ws, ["stopRecordingResult", { success: true }]);
        return;
      }
      
      if (evt === "getRecordingStatus") {
        const roomName = data[1]?.trim();
        if (!roomName) {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        const isRecording = await this.dataManager.getRecordingStatus(roomName);
        this._safeSend(ws, ["recordingStatus", isRecording]);
        return;
      }
      
      if (evt === "getRoomWinners") {
        const roomName = data[1]?.trim() || ws.room || this.clientRooms.get(ws._wsId);
        if (!roomName) {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        const isRecording = await this.dataManager.getRecordingStatus(roomName);
        const winners = await this.dataManager.getWinners(roomName);
        this._safeSend(ws, ["roomWinners", {
          winners: winners || {},
          room: roomName,
          recording: isRecording || false
        }]);
        return;
      }
      
      if (evt === "addLowCardWinner") {
        const { room, username } = data[1] || {};
        if (!room || !username) {
          this._safeSend(ws, ["error", "Room and username required"]);
          return;
        }
        await this.dataManager.addWinner(room.trim(), username.trim());
        await this._broadcastLowCardWinners(room.trim());
        this._safeSend(ws, ["addWinnerResult", { success: true }]);
        return;
      }
      
      if (evt === "deleteAllWinners") {
        const roomName = data[1]?.trim();
        if (!roomName) {
          this._safeSend(ws, ["error", "Room required"]);
          return;
        }
        await this.dataManager.deleteAllWinners(roomName);
        this._broadcastToRoom(roomName, ["recordingStatus", false]);
        this._safeSend(ws, ["deleteWinnersResult", { success: true }]);
        return;
      }
      
      if (evt === "sendWinnersToRoom" || evt === "lowCardWinnerUpdate") {
        const roomName = data[1]?.trim() || ws.room || this.clientRooms.get(ws._wsId);
        if (!roomName) {
          this._safeSend(ws, ["recordingError", "Room name required"]);
          return;
        }
        await this._broadcastLowCardWinners(roomName);
        this._safeSend(ws, ["sendWinnersResult", { success: true }]);
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
          if (winner && winner.username) {
            this._safeSend(ws, ["diceLastWeekWinner",
              String(winner.username),
              parseInt(winner.score, 10) || 0,
              String(winner.week || '')
            ]);
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
          this._safeSend(ws, ["diceLastWeekWinnerDeleted", true]);
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
          let notification = "";
          if (isActive) {
            const elapsed = (Date.now() - this._diceStartTime) / 1000;
            const remaining = Math.max(0, 20 - elapsed);
            notification = Math.floor(remaining) + "s remaining";
          } else if (isDiceTime) {
            notification = "Dice game starting soon...";
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
        await this._startGameWithRecording(ws, room, bet, username);
        return;
      }
      
      if (evt === "gameLowCardStart") {
        await this.startGame(ws, data[1], data[2]);
        return;
      }
      
      if (evt === "gameLowCardJoin") {
        await this.joinGame(ws, data[1]);
        return;
      }
      
      if (evt === "gameLowCardNumber") {
        await this.submitNumber(ws, data[1], data[2] || "", data[3]);
        return;
      }
      
    } catch(e) {
      console.error('Handle event error:', e);
    }
  }

  _checkGameRunning(ws, roomname) {
    try {
      const room = roomname || ws.room || this.clientRooms.get(ws._wsId);
      if (!room) {
        this._safeSend(ws, ["gameStatus", "false"]);
        return;
      }
      
      const game = this.activeGames.get(room);
      const isRunning = game && game._isActive && !game._gameEnded;
      this._safeSend(ws, ["gameStatus", isRunning ? "true" : "false"]);
      
    } catch(e) {}
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try {
      if (!ws) return;
      
      const wsId = ws._wsId;
      const username = ws.username;
      const room = this.clientRooms.get(wsId);
      
      if (room && username) {
        const game = this.activeGames.get(room);
        if (game && game._isActive && !game._gameEnded && game.players) {
          if (game.players.has(username)) {
            if (game.host === username && game._state === this.GAME_STATE.REGISTRATION) {
              this._broadcastToRoom(room, ["gameLowCardError", "Host left the game"]);
              game._gameEnded = true;
              game._isActive = false;
              this._forceCleanupGame(room, game);
              this._cleanupWsData(wsId, username, room);
              return;
            }
            
            if (game._state === this.GAME_STATE.REGISTRATION) {
              game.players.delete(username);
              game.playerWsId?.delete(username);
              this._broadcastToRoom(room, ["gameLowCardPlayerLeft", username]);
              
              if (game.host === username) {
                const remaining = Array.from(game.players.keys());
                if (remaining.length > 0) {
                  game.host = remaining[0];
                  this._broadcastToRoom(room, ["gameLowCardNewHost", game.host]);
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
            } else if (game._state === this.GAME_STATE.DRAW || game._state === this.GAME_STATE.EVALUATING) {
              if (!game.eliminated.has(username)) {
                game.eliminated.add(username);
                this._broadcastToRoom(room, ["gameLowCardPlayerLeft", username]);
                
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
                
                if (game._state === this.GAME_STATE.DRAW && !game.evaluationLocked) {
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
      
      this._cleanupWsData(wsId, username, room);
      
    } catch(e) {
      console.error('WebSocket close error:', e);
      if (ws) {
        const wsId = ws._wsId;
        const room = this.clientRooms.get(wsId);
        if (room) {
          const clients = this.wsClients.get(room);
          if (clients) {
            clients.delete(wsId);
            if (clients.size === 0) {
              this.wsClients.delete(room);
            }
          }
        }
        this.wsMap.delete(wsId);
        this.clientRooms.delete(wsId);
        if (ws.username) {
          this.userConnections.delete(ws.username);
        }
      }
    }
  }

  _cleanupWsData(wsId, username, room) {
    try {
      if (wsId) {
        this.wsMap.delete(wsId);
        this.clientRooms.delete(wsId);
        if (username) {
          this.userConnections.delete(username);
        }
        if (room) {
          const clients = this.wsClients.get(room);
          if (clients) {
            clients.delete(wsId);
            if (clients.size === 0) {
              this.wsClients.delete(room);
            }
          }
        }
      }
    } catch(e) {}
  }

  async webSocketError(ws, error) {
    try {
      if (!ws) return;
      const wsId = ws._wsId;
      const username = ws.username;
      const room = this.clientRooms.get(wsId);
      
      if (wsId) {
        this.wsMap.delete(wsId);
        this.clientRooms.delete(wsId);
        if (username) {
          this.userConnections.delete(username);
        }
        if (room) {
          const clients = this.wsClients.get(room);
          if (clients) {
            clients.delete(wsId);
            if (clients.size === 0) {
              this.wsClients.delete(room);
            }
          }
        }
      }
    } catch(e) {}
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
          return new Response("Service temporarily unavailable", {
            status: 503,
            headers: { 'Retry-After': '30', 'Content-Type': 'text/plain' }
          });
        }
      }
      
      this._requestCount++;
      if (this._requestCount > CONSTANTS.RATE_LIMIT_MAX) {
        this._circuitOpen = true;
        this._lastResetTime = Date.now();
        return new Response("Rate limit exceeded", {
          status: 429,
          headers: { 'Retry-After': '60', 'Content-Type': 'text/plain' }
        });
      }
      
      setTimeout(() => {
        this._requestCount = Math.max(0, this._requestCount - 50);
      }, CONSTANTS.RATE_LIMIT_WINDOW_MS);
      
      const url = new URL(req.url);
      
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({
          status: "ok",
          activeGames: this.activeGames.size,
          wsConnections: this.wsMap.size,
          restored: this._restored
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (url.pathname === "/game/dice/status") {
        const clients = this.wsClients?.get(CONSTANTS.DICE_ROOM);
        return new Response(JSON.stringify({
          isDiceTime: this.alarmScheduler.isDiceTime(),
          isActive: this.currentDiceRoll && this._canSubmitDiceAnswer,
          sessionActive: this._diceSessionActive,
          sessionEnded: this._diceSessionEnded,
          isLocked: this._diceLock,
          isCooldown: this._diceTimeUpCooldown,
          isShowing: this._isShowingDice,
          currentRoll: this.currentDiceRoll,
          round: this._diceRound,
          clientsInRoom: clients ? clients.size : 0,
          totalClients: this.wsMap.size
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (url.pathname === "/game/dice/forceStart") {
        const started = this._checkAndStartDice();
        if (started) {
          this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", "🎲 Quiz Forced Start!"]);
          return new Response(JSON.stringify({ success: true, message: "Quiz started" }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        } else {
          return new Response(JSON.stringify({
            success: false,
            message: "Cannot start quiz"
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      if (url.pathname === "/game/ws") {
        const upgrade = req.headers.get("Upgrade");
        if (upgrade !== "websocket") {
          return new Response("WebSocket only", { status: 400 });
        }
        
        if (this.wsMap.size >= CONSTANTS.MAX_WS_CLIENTS) {
          return new Response("Server full", { status: 503 });
        }
        
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        const wsId = ++this._wsIdCounter;
        
        try {
          this.ctx.acceptWebSocket(server);
        } catch(e) {
          try { server.close(1008, "Accept failed"); } catch(err) {}
          return new Response("WebSocket acceptance failed", { status: 500 });
        }
        
        server.serializeAttachment({
          wsId: wsId,
          username: null,
          room: null,
          roomname: null,
          createdAt: Date.now()
        });
        
        server._wsId = wsId;
        server._closing = false;
        server.username = null;
        server.room = null;
        server.roomname = null;
        server._createdAt = Date.now();
        
        this.wsMap.set(wsId, server);
        
        return new Response(null, {
          status: 101,
          webSocket: client
        });
      }
      
      return new Response("Game Server", { status: 200 });
      
    } catch(e) {
      console.error('Fetch error:', e);
      this._handleError('fetch', e);
      return new Response(JSON.stringify({
        error: "Internal Server Error",
        message: e.message || "Unknown error"
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
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

  // ============================================================
  // ALARM
  // ============================================================
  
  async alarm() {
    if (this.closing || this.isDestroyed) return;
    
    try {
      this._forceReleaseAllLocks();
      await this._forceResetIfNeededUTC();
      
      await this.alarmScheduler.restoreAlarms();
      const pendingAlarms = await this.alarmScheduler.getPendingAlarms();
      
      for (const alarm of pendingAlarms) {
        try {
          await this._processAlarm(alarm.name);
          await this.alarmScheduler.processAlarm(alarm.name);
        } catch(e) {
          console.error("Error processing alarm:", e);
        }
      }
      
      await this.alarmScheduler.scheduleAlarms();
      
    } catch(e) {
      console.error("Error in alarm:", e);
    }
  }

  async _processAlarm(name) {
    switch(name) {
      case CONSTANTS.WEEKLY_RESET_ALARM:
        await this._handleWeeklyReset();
        break;
        
      case 'dice_session_start':
        if (this.alarmScheduler.isDiceTime()) {
          this.diceAutoEnabled = true;
          this._diceSessionActive = true;
          this._diceSessionEnded = false;
          
          if (!this.currentDiceRoll && !this._isShowingDice && !this._diceLock && !this._diceTimeUpCooldown) {
            this._diceStartedByUser = true;
            this._startDiceFast();
            this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", "🎲 Quiz Started!"]);
          }
        }
        break;
        
      case 'dice_session_end':
        this.diceAutoEnabled = false;
        this._diceSessionActive = false;
        this._diceSessionEnded = true;
        this._diceStartedByUser = false;
        
        this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceNotification", "⏹️ Quiz session ended"]);
        this._broadcastToRoom(CONSTANTS.DICE_ROOM, ["diceSessionEnded", true]);
        
        if (this._diceTimeout) {
          this._clearTimer(this._diceTimeout);
          this._diceTimeout = null;
        }
        if (this._diceCooldownTimer) {
          this._clearTimer(this._diceCooldownTimer);
          this._diceCooldownTimer = null;
        }
        if (this._diceTimeUpCooldownTimer) {
          this._clearTimer(this._diceTimeUpCooldownTimer);
          this._diceTimeUpCooldownTimer = null;
        }
        for (const timeout of this._diceNotificationTimeouts) {
          this._clearTimer(timeout);
        }
        this._diceNotificationTimeouts = [];
        
        if (this._tieActive) {
          this._resetTieBreakerState(null);
        }
        
        this.currentDiceRoll = null;
        this._diceLock = false;
        this._isShowingDice = false;
        this._canSubmitDiceAnswer = false;
        this.diceAnswered = new Set();
        this._playerAnswers = new Map();
        this.diceHasWinner = false;
        this.diceWinner = null;
        this._diceRound = 0;
        this._diceTimeUpCooldown = false;
        break;
    }
  }

  // ============================================================
  // WEEKLY RESET
  // ============================================================
  
  async _forceResetIfNeededUTC() {
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
    } catch(e) {
      return false;
    }
  }

  async _handleWeeklyReset() {
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
        const winnerData = {
          username: winner,
          score: highestScore,
          week: currentWeek,
          timestamp: Date.now()
        };
        await this.dataManager.setLastWeekWinner(winnerData);
      } else {
        await this.dataManager.deleteLastWeekWinner();
      }
      
      await this.dataManager.resetDicePoints();
      return true;
    } catch(e) {
      const currentWeek = this.dataManager.getCurrentWeek();
      await this.dataManager.setLastResetWeek(currentWeek);
      return false;
    }
  }

  // ============================================================
  // DESTROY
  // ============================================================
  
  async destroy() {
    try {
      if (this.isDestroyed) return;
      this.isDestroyed = true;
      this.closing = true;
      
      if (this._staleCheckInterval) {
        this._clearTimer(this._staleCheckInterval);
        this._staleCheckInterval = null;
      }
      
      for (const timer of this._allTimers) {
        try { clearTimeout(timer); } catch(e) {}
        try { clearInterval(timer); } catch(e) {}
      }
      this._allTimers.clear();
      
      if (this._diceTimeout) {
        this._clearTimer(this._diceTimeout);
        this._diceTimeout = null;
      }
      if (this._diceCooldownTimer) {
        this._clearTimer(this._diceCooldownTimer);
        this._diceCooldownTimer = null;
      }
      if (this._diceTimeUpCooldownTimer) {
        this._clearTimer(this._diceTimeUpCooldownTimer);
        this._diceTimeUpCooldownTimer = null;
      }
      for (const timeout of this._diceNotificationTimeouts) {
        this._clearTimer(timeout);
      }
      this._diceNotificationTimeouts = [];
      
      if (this._tieTimer) {
        this._clearTimer(this._tieTimer);
        this._tieTimer = null;
      }
      if (this._tieInterval) {
        this._clearTimer(this._tieInterval);
        this._tieInterval = null;
      }
      for (const timeout of this._tieNotificationTimeouts) {
        this._clearTimer(timeout);
      }
      this._tieNotificationTimeouts = [];
      
      for (const [room, game] of this.activeGames) {
        this._forceCleanupGame(room, game);
      }
      this.activeGames.clear();
      
      this._gameLocks.clear();
      this._evalLocks.clear();
      this._drawLocks.clear();
      this._submitLocks.clear();
      this._switchLocks.clear();
      this._tieBreakers.clear();
      
      if (this.alarmScheduler) {
        await this.alarmScheduler.cleanup();
      }
      
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
      this.userConnections.clear();
      
      try { await this.ctx.storage.deleteAlarm(); } catch(e) {}
      
    } catch(e) {
      console.error('Destroy error:', e);
    }
  }
}

export default GameServer;
