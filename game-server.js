// ==================== GAME-SERVER.JS - FIXED PRODUCTION CODE ====================

const CONSTANTS = {
  MAX_LOWCARD_GAMES: 10,
  REGISTRATION_TIME_MS: 20000,
  DRAW_TIME_MS: 20000,
  EVALUATION_DELAY_MS: 2000,
  MAX_BOTS_PER_GAME: 4,
  MAX_BET: 100000,
  BOT_DRAW_MIN_SECONDS: 2,
  BOT_DRAW_MAX_SECONDS: 15,
  MAX_BOT_DRAWS_PER_ROUND: 4,
  EVALUATION_TIMEOUT_MS: 30000,
  START_LOCK_DURATION_MS: 3000,
  MAX_PLAYERS_PER_GAME: 45,
  GAME_CLEANUP_DELAY_MS: 5000,
  BATCH_SIZE: 2,
  CLEANUP_TIK: 90,
  STALE_GAME_TIMEOUT_MS: 600000,
  STUCK_DRAW_TIMEOUT_MS: 60000,
  STUCK_REGISTRATION_TIMEOUT_MS: 30000,
  MAX_RETRY_INIT_QUIZ: 2,
  MAX_SHUTDOWN_WAIT_MS: 5000,
  MAX_WS_CLIENTS: 50,
  MAX_ARRAY_SIZE: 50,
  QUIZ_SWITCH_DELAY_MS: 5000,
  SCHEDULER_INTERVAL_MS: 60000,
  QUIZ_BATCH_SIZE: 100,
  MAX_QUESTIONS: 10000,
  CF_SUBREQUEST_LIMIT: 50,
  DEEPLX_TIMEOUT_MS: 8000,
  DEEPLX_MAX_RETRIES: 5,
  TRANSLATE_TIMEOUT_MS: 10000,
  QUIZ_KEEP_ALIVE_INTERVAL_MS: 5000,
  QUIZ_NEXT_QUESTION_DELAY_MS: 5000,
  CPU_TIME_LIMIT_MS: 10,
  CPU_YIELD_DELAY_MS: 1,
  CPU_CHECK_INTERVAL_MS: 100,
  MAX_EVENTS_PER_TICK: 5,
  BROADCAST_BATCH_SIZE: 5,
  MAX_RESTART_ATTEMPTS: 3,
  RESTART_COOLDOWN_MS: 30000,
  HEALTH_CHECK_INTERVAL_MS: 10000,
  MAX_IDLE_TIME_MS: 300000,
  RECONNECT_DELAY_MS: 2000,
  MAX_EVENT_QUEUE_SIZE: 1000,
  ERROR_RECOVERY_DELAY_MS: 5000,
  MAX_UNHANDLED_ERRORS: 5,
  ERROR_RESET_INTERVAL_MS: 60000,
  LOWCARD_WINNER_KEY: 'lowcard_winner_',
  LOWCARD_RECORDING_KEY: 'lowcard_recording_status_',
  SCHEDULER_LOOP_INTERVAL_MS: 50,
  
  MAX_DICE_GAMES: 10,
  DICE_ROLL_TIME_MS: 0,
  DICE_READING_TIME_MS: 0,
  DICE_ANSWER_TIME_MS: 20000,
  DICE_TOTAL_TIME_MS: 20000,
  DICE_BREAK_MS: 15000,
  DICE_AFTER_TIMEOUT_BREAK_MS: 15000,
  MAX_DICE_VALUE: 6,
  DICE_ROOM: "Quiz",
  DICE_POINT_KEY: 'dice_points',
  DICE_LAST_WEEK_WINNER: 'dice_last_week_winner',
  DICE_WINNER_KEY: 'dice_winner_',
  DICE_RECORDING_KEY: 'dice_recording_status_',
  QUIZ_START_DELAY_MS: 5000,
  
  DICE_AUTO_START_DELAY_MS: 3000,
  DICE_MIN_PLAYERS_TO_AUTO_START: 1,
  DICE_CHECK_INTERVAL_MS: 5000,
  
  DICE_LAST_RESET_WEEK: 'dice_last_reset_week',
  WEEKLY_RESET_CHECK_INTERVAL_MS: 300000,
  
  // TIE BREAKER CONSTANTS
  TIE_BREAKER_ROUND_TIME_MS: 20000,
  TIE_BREAKER_POST_DELAY_MS: 3000,
  TIE_BREAKER_COOLDOWN_MS: 15000,
  MAX_TIE_ROUNDS: 10,
};

const QUIZ_SCHEDULE = {
  SESSIONS: [
    { start: 3, end: 6 },
    { start: 14, end: 15 },
    { start: 22, end: 23 }
  ],
  TIMEZONE_OFFSET: 8,
};

const DICE_ROOM = "Quiz";

// ==================== DICE STATE MACHINE ====================
const DICE_STATE = {
  IDLE: 'idle',
  WAITING: 'waiting',
  ROLLING: 'rolling',
  ANSWERING: 'answering',
  TIE_BREAKER: 'tie_breaker',
  COOLDOWN: 'cooldown',
  ENDED: 'ended'
};

// ==================== KV CACHE CLASS ====================
class KVCache {
  constructor() {
    this.cache = new Map();
    this.ttl = 30000;
    this._cleanupInterval = null;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, customTtl = null) {
    const ttl = customTtl || this.ttl;
    this.cache.set(key, {
      value: value,
      timestamp: Date.now(),
      ttl: ttl
    });
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  startCleanup() {
    if (this._cleanupInterval) return;
    this._cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (now - entry.timestamp > entry.ttl) {
          this.cache.delete(key);
        }
      }
    }, 60000);
  }

  stopCleanup() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }
}

// ==================== CPU PROTECTION CLASS ====================
class CPUProtection {
  constructor() {
    this._cpuStartTime = 0;
    this._cpuTotalTime = 0;
    this._cpuCheckCount = 0;
    this._isThrottled = false;
    this._pendingOperations = [];
    this._isProcessingPending = false;
    this._cpuHistory = [];
    this._cpuAverage = 0;
    this._eventQueue = [];
    this._isProcessingQueue = false;
    this._rateLimitMap = new Map();
    this._cpuMonitorInterval = null;
  }

  _startCPUTimer() {
    this._cpuStartTime = performance.now ? performance.now() : Date.now();
    return this._cpuStartTime;
  }

  _checkCPULimit() {
    try {
      const now = performance.now ? performance.now() : Date.now();
      const elapsed = now - this._cpuStartTime;
      if (elapsed >= CONSTANTS.CPU_TIME_LIMIT_MS) {
        this._cpuTotalTime += elapsed;
        this._cpuCheckCount++;
        this._cpuHistory.push(elapsed);
        if (this._cpuHistory.length > 10) this._cpuHistory.shift();
        const sum = this._cpuHistory.reduce((a, b) => a + b, 0);
        this._cpuAverage = sum / this._cpuHistory.length;
        return true;
      }
      return false;
    } catch(e) { return false; }
  }

  async _cpuYield() {
    try {
      if (this._isThrottled) {
        await this._sleep(CONSTANTS.CPU_YIELD_DELAY_MS * 2);
        return;
      }
      if (this._cpuAverage > CONSTANTS.CPU_TIME_LIMIT_MS * 0.8) {
        await this._sleep(CONSTANTS.CPU_YIELD_DELAY_MS * 3);
        this._isThrottled = true;
        setTimeout(() => { this._isThrottled = false; }, 100);
      } else {
        await this._sleep(CONSTANTS.CPU_YIELD_DELAY_MS);
      }
    } catch(e) {}
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async _safeExecute(fn, ...args) {
    this._startCPUTimer();
    try {
      const result = await fn(...args);
      if (this._checkCPULimit()) await this._cpuYield();
      return result;
    } catch(e) {
      if (this._checkCPULimit()) await this._cpuYield();
      throw e;
    }
  }

  _isRateLimited(wsId, eventType) {
    try {
      const now = Date.now();
      const key = `${wsId}_${eventType}`;
      const data = this._rateLimitMap.get(key);
      if (!data) {
        this._rateLimitMap.set(key, { count: 1, resetTime: now + 1000 });
        return false;
      }
      if (now > data.resetTime) {
        data.count = 1;
        data.resetTime = now + 1000;
        return false;
      }
      data.count++;
      return data.count > 10;
    } catch(e) { return false; }
  }

  _cpuMonitorTask() {
    try {
      const now = Date.now();
      for (const [key, data] of this._rateLimitMap) {
        if (now - data.resetTime > 1000) this._rateLimitMap.delete(key);
      }
      if (this._cpuHistory.length > 0) {
        const avg = this._cpuHistory.reduce((a, b) => a + b, 0) / this._cpuHistory.length;
        if (avg > CONSTANTS.CPU_TIME_LIMIT_MS * 0.9) {
          this._isThrottled = true;
          setTimeout(() => { this._isThrottled = false; }, 500);
        }
      }
    } catch(e) {}
  }
}

// ==================== DICE GAME SYSTEM ====================
class DiceGameSystem {
  constructor(gameServer) {
    this.gameServer = gameServer;
    this.env = gameServer.env;
    this.userScores = new Map();
    this._isLoaded = false;
    this._loading = false;
    this._usedDiceValues = new Set();
    this._lastLoadTime = 0;
    this._cacheTTL = 5000;
  }

  async loadScores() {
    try {
      const now = Date.now();
      if (this._isLoaded && (now - this._lastLoadTime) < this._cacheTTL) {
        return true;
      }
      
      if (this._loading) return this._isLoaded;
      this._loading = true;
      
      const env = this.env;
      if (!env?.QUESTIONS) {
        this._loading = false;
        return false;
      }
      
      const points = await env.QUESTIONS.get(CONSTANTS.DICE_POINT_KEY, 'json') || {};
      this.userScores.clear();
      for (const [username, score] of Object.entries(points)) {
        this.userScores.set(username, score);
      }
      
      this._isLoaded = true;
      this._loading = false;
      this._lastLoadTime = Date.now();
      return true;
    } catch(e) {
      this._loading = false;
      return false;
    }
  }

  async getPoints() {
    try {
      if (!this.env?.QUESTIONS) return {};
      const cacheKey = 'dice_points';
      const cached = this.gameServer._kvCache?.get(cacheKey);
      if (cached !== null) return cached;
      
      const points = await this.env.QUESTIONS.get(CONSTANTS.DICE_POINT_KEY, 'json') || {};
      if (this.gameServer._kvCache) {
        this.gameServer._kvCache.set(cacheKey, points, 5000);
      }
      this.userScores.clear();
      for (const [username, score] of Object.entries(points)) {
        this.userScores.set(username, score);
      }
      return points;
    } catch(e) {
      return {};
    }
  }

  async setPoints(points) {
    try {
      if (!this.env?.QUESTIONS) return false;
      await this.env.QUESTIONS.put(CONSTANTS.DICE_POINT_KEY, JSON.stringify(points));
      if (this.gameServer._kvCache) {
        this.gameServer._kvCache.set('dice_points', points, 5000);
      }
      this.userScores.clear();
      for (const [username, score] of Object.entries(points)) {
        this.userScores.set(username, score);
      }
      return true;
    } catch(e) {
      return false;
    }
  }

  async getLastWeekWinner() {
    try {
      if (!this.env?.QUESTIONS) return null;
      const cached = this.gameServer._kvCache?.get('dice_last_week_winner');
      if (cached !== null) return cached;
      const winnerData = await this.env.QUESTIONS.get(CONSTANTS.DICE_LAST_WEEK_WINNER, 'json');
      if (winnerData && this.gameServer._kvCache) {
        this.gameServer._kvCache.set('dice_last_week_winner', winnerData, 60000);
      }
      return winnerData;
    } catch(e) {
      return null;
    }
  }

  async setLastWeekWinner(winner) {
    try {
      if (!this.env?.QUESTIONS) return false;
      await this.env.QUESTIONS.put(CONSTANTS.DICE_LAST_WEEK_WINNER, JSON.stringify(winner));
      if (this.gameServer._kvCache) {
        this.gameServer._kvCache.set('dice_last_week_winner', winner, 60000);
      }
      return true;
    } catch(e) {
      return false;
    }
  }

  async deleteLastWeekWinner() {
    try {
      if (!this.env?.QUESTIONS) return false;
      await this.env.QUESTIONS.delete(CONSTANTS.DICE_LAST_WEEK_WINNER);
      this.gameServer._kvCache?.delete('dice_last_week_winner');
      return true;
    } catch(e) {
      return false;
    }
  }

  generateCurrentWeek() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const startOfYear = new Date(year, 0, 1);
    const diff = now - startOfYear;
    const week = Math.ceil((diff / 86400000 + startOfYear.getUTCDay() + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  rollDice() {
    return Math.floor(Math.random() * 6) + 1;
  }

  clearCache() {
    this.userScores.clear();
    this._usedDiceValues.clear();
  }
}

// ==================== CENTRALIZED SCHEDULER ====================
class CentralizedScheduler {
  constructor() {
    this.tasks = [];
    this.isRunning = false;
    this._lastRun = Date.now();
    this._taskQueue = [];
    this._loopInterval = null;
  }

  registerTask(name, interval, fn, options = {}) {
    this.tasks.push({
      name,
      interval,
      fn,
      lastRun: 0,
      options,
      isRunning: false,
      errorCount: 0
    });
  }

  async run() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const now = Date.now();
      
      const dueTasks = this.tasks.filter(task => {
        if (task.isRunning) return false;
        const elapsed = now - task.lastRun;
        return elapsed >= task.interval;
      });

      for (const task of dueTasks) {
        task.isRunning = true;
        task.lastRun = now;
        
        try {
          if (this._shouldYieldCPU()) {
            await this._yield();
          }
          
          await task.fn();
          task.errorCount = 0;
          
        } catch(e) {
          task.errorCount++;
          if (task.errorCount > 5) {
            task.interval = task.interval * 2;
            task.errorCount = 0;
          }
        } finally {
          task.isRunning = false;
        }
        
        await this._yield();
      }

    } finally {
      this.isRunning = false;
    }
  }

  _shouldYieldCPU() {
    const elapsed = Date.now() - this._lastRun;
    return elapsed > 8;
  }

  async _yield() {
    return new Promise(resolve => setTimeout(resolve, 1));
  }

  start(intervalMs = 50) {
    if (this._loopInterval) {
      clearInterval(this._loopInterval);
    }
    this._loopInterval = setInterval(() => {
      this.run();
    }, intervalMs);
  }

  stop() {
    if (this._loopInterval) {
      clearInterval(this._loopInterval);
      this._loopInterval = null;
    }
  }
}

// ==================== GAME SERVER CLASS ====================
export class GameServer extends CPUProtection {
  constructor(state, env) {
    try {
      super();
      this.state = state;
      this.env = env;
      this.closing = false;
      this.isDestroyed = false;
      this._initialized = false;
      this._initializing = false;

      this._restartCount = 0;
      this._lastRestartTime = 0;
      this._healthCheckInterval = null;
      this._isRestarting = false;
      this._startTime = Date.now();
      this._lastHeartbeat = Date.now();
      this._errorCount = 0;
      this._lastErrorReset = Date.now();
      this._isRecovering = false;
      this._recoveryAttempts = 0;
      this._maxRecoveryAttempts = 3;
      this._lastRecoveryTime = 0;

      this._winnerProcessed = false;

      this.activeGames = new Map();
      this._maxGames = CONSTANTS.MAX_LOWCARD_GAMES;
      this._gameLocks = new Map();
      this._joinLocks = new Map();
      this._switchLocks = new Map();
      this._switchRetries = new Map();

      this._wsIdCounter = 0;
      this.wsClients = new Map();
      this.clientRooms = new Map();
      this.wsMap = new Map();
      this.roomViewers = new Map();
      this.userConnections = new Map();
      this._cleanupTimers = new Map();
      this._roomBroadcastCount = new Map();
      this._roomBroadcastReset = new Map();
      this._tikCounter = 0;
      this._gameStartFlags = new Map();

      // ============ DICE STATE MANAGEMENT ============
      this._diceState = {
        state: DICE_STATE.IDLE,
        round: 0,
        tieRound: 0,
        tiePlayers: [],
        tieAnswers: new Map(),
        isTieActive: false,
        isTieProcessing: false,
        tieId: null,
        tieRounds: 0,
        maxTieRounds: CONSTANTS.MAX_TIE_ROUNDS || 10,
        isLocked: false,
        rollLock: false
      };

      this.diceAnswered = new Set();
      this.diceHasWinner = false;
      this.diceWinner = null;
      this.diceTimer = null;
      this.currentDiceRoll = null;
      this._diceStartTime = null;
      this._diceTimeout = null;
      this._diceBreakTimeout = null;
      this._diceStartTimeout = null;
      this.diceAutoEnabled = false;
      this.diceAutoTimer = null;
      this._diceKeepAliveInterval = null;
      this._lastActivityTime = Date.now();
      this._isDiceIdle = false;
      this._isShowingDice = false;
      this._diceInitAttempts = 0;
      this._maxDiceInitAttempts = 3;

      this.diceEndedToday = false;
      this.diceEndMessageShown = false;
      this.diceEndNotified = false;

      this._diceTimeLeftNotified = new Map();
      this._nextDiceNotified = new Map();
      this._diceJoinedNotified = new Map();
      this._diceTimeLeftBroadcastCooldown = 1000;
      this._lastDiceTimeLeftBroadcast = 0;

      this._diceQuestionStartTime = null;
      this._canSubmitDiceAnswer = false;

      this._recordingEnabled = new Map();

      this._weeklyResetTimer = null;
      this._lastResetWeek = null;
      this._lastResetCheck = null;

      this._diceTimerInterval = null;
      this._diceNotified20 = false;
      this._diceNotified10 = false;
      this._diceNotified5 = false;
      this._diceNotified3 = false;

      this._diceAutoCheckInterval = null;

      this._diceOutOfTimeShown = false;
      this._diceRemainingShown = false;
      this._diceTimeUpShown = false;

      this._lastSentRemaining = -1;
      this._lastNotificationKey = "";
      this._lastNotificationTime = 0;
      
      this._diceTimeUpCooldown = false;
      this._diceTimeUpCooldownTimer = null;
      
      this._diceNotifiedFlags = {
        20: false,
        10: false,
        5: false,
        timeup: false
      };

      this._kvCache = new KVCache();
      this._kvCache.startCleanup();

      this.diceGameSystem = new DiceGameSystem(this);

      this._scheduler = new CentralizedScheduler();
      this._setupScheduler();

      // TIE BREAKER - Simplified and integrated
      this._tieBreakers = new Map();
      this._tieActive = false;
      this._tiePlayers = [];
      this._tieAnswers = new Map();
      this._tieTimer = null;
      this._tieInterval = null;
      this._playerAnswers = new Map();
      this._processingTieResults = false;
      this._tieRound = 0;
      this._tieId = null;
      this._lastTieLog = '';

      this._cachedResetWeek = null;
      this._cachedResetWeekTimestamp = 0;

      this._initAsync();

      setTimeout(async () => {
        try {
          if (!this.closing && !this.isDestroyed) {
            await this._initResetWeek();
          }
        } catch(e) {}
      }, 1000);

      setTimeout(async () => {
        try {
          if (!this.closing && !this.isDestroyed) {
            await this.diceGameSystem.loadScores();
          }
        } catch(e) {}
      }, 5000);

      setTimeout(() => {
        if (!this.closing && !this.isDestroyed && !this._isShowingDice) {
          this.forceStartDice();
        }
      }, 8000);

      this._startDiceAutoChecker();

    } catch(e) {}
  }

  // ==================== DICE STATE HELPERS ====================
  
  _isTieActive() {
    return this._diceState.isTieActive || this._tieActive;
  }

  _getDiceState() {
    return this._diceState.state;
  }

  _setDiceState(newState) {
    const oldState = this._diceState.state;
    this._diceState.state = newState;
    if (oldState !== newState) {
      console.log(`[Dice] State changed: ${oldState} -> ${newState}`);
    }
  }

  _isDiceRollLocked() {
    return this._diceState.rollLock || this._diceState.isLocked;
  }

  _lockDiceRoll() {
    this._diceState.rollLock = true;
    setTimeout(() => {
      this._diceState.rollLock = false;
    }, 1000);
  }

  _canProcessDiceRoll() {
    // CEK: Tidak ada tie active, tidak ada roll lock, state tidak di tie breaker
    if (this._isTieActive()) {
      console.log('[Dice] Cannot roll - tie breaker active');
      return false;
    }
    if (this._isDiceRollLocked()) {
      console.log('[Dice] Cannot roll - roll locked');
      return false;
    }
    if (this._diceState.state === DICE_STATE.TIE_BREAKER) {
      console.log('[Dice] Cannot roll - in tie breaker state');
      return false;
    }
    return true;
  }

  // ==================== INIT METHODS ====================

  async _initResetWeek() {
    try {
      if (!this.env?.QUESTIONS) return;

      const existingResetWeek = await this.env.QUESTIONS.get(CONSTANTS.DICE_LAST_RESET_WEEK);
      const currentWeek = this._generateCurrentWeek(new Date());

      if (!existingResetWeek) {
        await this.env.QUESTIONS.put(CONSTANTS.DICE_LAST_RESET_WEEK, currentWeek);
        await this._updateCachedResetWeek(currentWeek);
        return;
      }

      await this._updateCachedResetWeek(existingResetWeek);

    } catch(e) {}
  }

  async _getCachedResetWeek() {
    try {
      if (this._cachedResetWeek !== null) {
        return this._cachedResetWeek;
      }
      
      if (this.env?.QUESTIONS) {
        const lastResetWeek = await this.env.QUESTIONS.get(CONSTANTS.DICE_LAST_RESET_WEEK);
        if (lastResetWeek) {
          this._cachedResetWeek = lastResetWeek;
          this._cachedResetWeekTimestamp = Date.now();
          return lastResetWeek;
        }
      }
      
      return null;
    } catch(e) {
      return null;
    }
  }

  async _updateCachedResetWeek(week) {
    this._cachedResetWeek = week;
    this._cachedResetWeekTimestamp = Date.now();
  }

  _isWeekGreater(weekA, weekB) {
    try {
      const numA = parseInt(weekA.split('-W')[1]);
      const numB = parseInt(weekB.split('-W')[1]);
      return numA > numB;
    } catch(e) {
      return false;
    }
  }

  _setupScheduler() {
    this._scheduler.registerTask('cpuMonitor', 100, () => {
      this._cpuMonitorTask();
    });

    this._scheduler.registerTask('healthCheck', 10000, () => {
      this._healthCheckTask();
    });

    this._scheduler.registerTask('weeklyReset', CONSTANTS.WEEKLY_RESET_CHECK_INTERVAL_MS, async () => {
      await this._checkAndResetWeeklyDice();
    });

    this._scheduler.registerTask('diceKeepAlive', 1000, () => {
      this._diceKeepAliveTask();
    });

    this._scheduler.registerTask('diceAuto', 60000, async () => {
      await this._diceAutoTask();
    });

    this._scheduler.registerTask('diceTimer', 30000, () => {
      this._diceTimerTask();
    });

    this._scheduler.registerTask('stuckGamesCheck', 15000, () => {
      this._checkStuckGames();
    });

    this._scheduler.registerTask('staleGamesCleanup', 60000, () => {
      this._cleanupStaleGames();
    });

    this._scheduler.registerTask('deadConnectionsCleanup', 30000, () => {
      this._cleanupDeadConnections();
    });

    this._scheduler.start(CONSTANTS.SCHEDULER_LOOP_INTERVAL_MS || 50);
  }

  async _checkAndResetWeeklyDice() {
    try {
      if (!this.env?.QUESTIONS) return false;
      
      const now = new Date();
      const currentWeek = this._generateCurrentWeek(now);
      
      let lastResetWeek = await this._getCachedResetWeek();
      
      if (!lastResetWeek) {
        await this._updateCachedResetWeek(currentWeek);
        await this.env.QUESTIONS.put(CONSTANTS.DICE_LAST_RESET_WEEK, currentWeek);
        return false;
      }
      
      const weekChanged = lastResetWeek !== currentWeek;
      
      if (!weekChanged) {
        return false;
      }
      
      const dayOfWeek = now.getUTCDay();
      const hours = now.getUTCHours();
      const minutes = now.getUTCMinutes();
      
      const isMonday = dayOfWeek === 1;
      const isResetTime = hours === 0 && minutes === 0;
      
      if (weekChanged && isMonday && isResetTime) {
        const points = await this.env.QUESTIONS.get(CONSTANTS.DICE_POINT_KEY, 'json') || {};
        
        let winner = null;
        let highestScore = 0;
        
        for (const [username, score] of Object.entries(points)) {
          const numericScore = typeof score === 'number' ? score : parseInt(score, 10) || 0;
          if (numericScore > highestScore) {
            highestScore = numericScore;
            winner = username;
          }
        }
        
        if (winner && highestScore > 0) {
          const winnerData = {
            username: winner,
            score: highestScore,
            week: lastResetWeek,
            timestamp: Date.now()
          };
          
          await this.env.QUESTIONS.put(
            CONSTANTS.DICE_LAST_WEEK_WINNER,
            JSON.stringify(winnerData)
          );
        } else {
          await this.env.QUESTIONS.delete(CONSTANTS.DICE_LAST_WEEK_WINNER);
          this._kvCache.delete('dice_last_week_winner');
        }
        
        await this.env.QUESTIONS.put(CONSTANTS.DICE_POINT_KEY, JSON.stringify({}));
        
        await this._updateCachedResetWeek(currentWeek);
        await this.env.QUESTIONS.put(CONSTANTS.DICE_LAST_RESET_WEEK, currentWeek);
        
        this._kvCache.delete('dice_points');
        this._kvCache.delete('dice_last_week_winner');
        this.diceGameSystem.userScores.clear();
        
        return true;
      }
      
      return false;
      
    } catch(e) {
      return false;
    }
  }

  _generateCurrentWeek(date) {
    try {
      const now = date || new Date();
      const year = now.getUTCFullYear();
      const startOfYear = new Date(Date.UTC(year, 0, 1));
      const diff = now - startOfYear;
      const week = Math.ceil((diff / 86400000 + startOfYear.getUTCDay() + 1) / 7);
      return `${year}-W${String(week).padStart(2, '0')}`;
    } catch(e) {
      return '2026-W01';
    }
  }

  // ==================== HEALTH & KEEP ALIVE ====================

  _healthCheckTask() {
    try {
      this._performHealthCheck();
    } catch(e) {}
  }

  _diceKeepAliveTask() {
    try {
      // CEK TIE ACTIVE - JANGAN kirim notifikasi tie
      if (this._isTieActive()) {
        return;
      }
      
      this._lastHeartbeat = Date.now();
      
      if (!this._isDiceTime()) {
        if (!this._diceOutOfTimeShown) {
          const timeLeft = this._getTimeLeftUntilNextDice();
          this._broadcastDiceNotification("diceError", {
            message: `Next dice game in: ${timeLeft.text}`,
            timeLeft: timeLeft.text,
            hours: timeLeft.hours,
            minutes: timeLeft.minutes,
            remaining: -1,
            isDiceTime: false,
            isActive: false
          });
          this._diceOutOfTimeShown = true;
        }
        return;
      }
      
      if (this._diceOutOfTimeShown) {
        this._diceOutOfTimeShown = false;
        this._diceRemainingShown = false;
        this._diceTimeUpShown = false;
      }
      
    } catch(e) {}
  }

  async _diceAutoTask() {
    try {
      // CEK TIE ACTIVE - JANGAN auto start saat tie
      if (this._isTieActive()) {
        return;
      }
      
      await this._checkDiceAutoStatus();
      await this._checkAndRestartDice();
      
      const isDiceTime = this._isDiceTime();
      const clients = this.wsClients.get(DICE_ROOM);
      const hasPlayers = clients && clients.size > 0;
      
      if (isDiceTime) {
        this._diceOutOfTimeShown = false;
        this._diceRemainingShown = false;
        this._diceTimeUpShown = false;
        this._diceJoinedNotified.clear();
        
        this.diceEndedToday = false;
        this.diceEndMessageShown = false;
        this.diceEndNotified = false;
        this._nextDiceNotified.clear();
        
        if (hasPlayers && !this.currentDiceRoll && !this._diceTimeout && 
            !this._diceStartTimeout && !this._isShowingDice && !this._diceTimeUpCooldown) {
          
          // CEK kembali apakah tie masih active sebelum start
          if (!this._isTieActive()) {
            if (!this.diceAutoEnabled) {
              this.diceAutoEnabled = true;
              await this.startDiceWithDelay(CONSTANTS.DICE_AUTO_START_DELAY_MS || 3000);
            }
            
            setTimeout(() => {
              if (!this.closing && !this.isDestroyed && 
                  !this.currentDiceRoll && !this._diceTimeout && 
                  !this._isShowingDice && !this._diceTimeUpCooldown &&
                  !this._isTieActive()) { // CEK TIE ACTIVE
                this.forceStartDice();
              }
            }, CONSTANTS.DICE_AUTO_START_DELAY_MS || 3000);
          }
        }
        
      } else {
        if (this.diceAutoEnabled && !this.diceEndNotified) {
          this.diceAutoEnabled = false;
          this.diceEndedToday = true;
          this.diceEndMessageShown = false;
          await this.resetDice();
          this._clearDiceData();
          this._diceTimeLeftNotified.clear();
          this._nextDiceNotified.clear();
          this._diceJoinedNotified.clear();
          this._sendDiceEndNotificationOnce();
        }
      }
      
    } catch(e) {}
  }

  _diceTimerTask() {
    try {
      // CEK TIE ACTIVE - JANGAN jalankan timer saat tie
      if (this._isTieActive()) {
        return;
      }
      
      if (this._isDiceTime()) {
        if (!this.currentDiceRoll && !this._diceTimeout && 
            !this._isShowingDice && !this._diceTimeUpCooldown) {
          const clients = this.wsClients.get(DICE_ROOM);
          if (clients?.size > 0) {
            this._showDiceQuestion();
          }
        }
      }
    } catch(e) {}
  }

  _startDiceAutoChecker() {
    try {
      if (this._diceAutoCheckInterval) {
        clearInterval(this._diceAutoCheckInterval);
      }
      
      this._diceAutoCheckInterval = setInterval(() => {
        try {
          if (this.closing || this.isDestroyed) {
            clearInterval(this._diceAutoCheckInterval);
            this._diceAutoCheckInterval = null;
            return;
          }
          
          // CEK TIE ACTIVE - SKIP auto check
          if (this._isTieActive()) {
            return;
          }
          
          if (this._isDiceTime()) {
            const clients = this.wsClients.get(DICE_ROOM);
            const hasPlayers = clients && clients.size > 0;
            
            if (hasPlayers && !this.currentDiceRoll && !this._diceTimeout && 
                !this._diceStartTimeout && !this._isShowingDice && !this._diceTimeUpCooldown) {
              
              if (!this.diceAutoEnabled) {
                this.diceAutoEnabled = true;
              }
              
              setTimeout(() => {
                if (!this.closing && !this.isDestroyed && 
                    !this.currentDiceRoll && !this._diceTimeout && 
                    !this._isShowingDice && !this._diceTimeUpCooldown &&
                    !this._isTieActive()) { // CEK TIE ACTIVE
                  this.forceStartDice();
                }
              }, CONSTANTS.DICE_AUTO_START_DELAY_MS || 3000);
            }
          }
        } catch(e) {}
      }, CONSTANTS.DICE_CHECK_INTERVAL_MS || 5000);
      
    } catch(e) {}
  }

  // ==================== DICE TIME HELPERS ====================

  _isDiceTime() {
    try {
      const witaTime = this._getCurrentWITATime();
      const currentTotal = witaTime.totalMinutes;
      for (const session of QUIZ_SCHEDULE.SESSIONS) {
        const startTotal = session.start * 60;
        const endTotal = session.end * 60;
        if (currentTotal >= startTotal && currentTotal < endTotal) {
          return true;
        }
      }
      return false;
    } catch(e) { 
      return false; 
    }
  }

  _getCurrentWITATime() {
    try {
      const now = new Date();
      const hours = (now.getUTCHours() + QUIZ_SCHEDULE.TIMEZONE_OFFSET) % 24;
      const minutes = now.getUTCMinutes();
      return {
        hours,
        minutes,
        totalMinutes: (hours * 60) + minutes,
        formatted: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
      };
    } catch(e) {
      return { hours: 0, minutes: 0, totalMinutes: 0, formatted: '00:00' };
    }
  }

  _getTimeLeftUntilNextDice() {
    try {
      const witaTime = this._getCurrentWITATime();
      const currentTotal = witaTime.totalMinutes;
      let minDiff = Infinity;
      for (const session of QUIZ_SCHEDULE.SESSIONS) {
        let startTotal = session.start * 60;
        let diff = startTotal - currentTotal;
        if (diff < 0) diff += 24 * 60;
        if (diff < minDiff) {
          minDiff = diff;
        }
      }
      const hours = Math.floor(minDiff / 60);
      const minutes = Math.floor(minDiff % 60);
      const isRunning = this._isDiceTime();
      return { 
        hours, 
        minutes, 
        totalMs: minDiff * 60 * 1000,
        text: `${hours}h ${minutes}m`,
        isRunning: isRunning
      };
    } catch(e) {
      return { hours: 0, minutes: 0, totalMs: 0, text: '0h 0m', isRunning: false };
    }
  }

  _getTimeLeftUntilNextDiceEvent() {
    try {
      const witaTime = this._getCurrentWITATime();
      const currentTotal = witaTime.totalMinutes;
      for (const session of QUIZ_SCHEDULE.SESSIONS) {
        const startTotal = session.start * 60;
        const endTotal = session.end * 60;
        if (currentTotal >= startTotal && currentTotal < endTotal) {
          const remaining = endTotal - currentTotal;
          const hours = Math.floor(remaining / 60);
          const minutes = Math.floor(remaining % 60);
          return {
            minutes: remaining,
            seconds: 0,
            isRunning: true,
            hours: hours,
            totalMinutes: remaining,
            status: 'running',
            remainingText: `${hours}h ${minutes}m`
          };
        }
      }
      let minDiff = Infinity;
      for (const session of QUIZ_SCHEDULE.SESSIONS) {
        let startTotal = session.start * 60;
        let diff = startTotal - currentTotal;
        if (diff < 0) diff += 24 * 60;
        if (diff < minDiff) {
          minDiff = diff;
        }
      }
      const hours = Math.floor(minDiff / 60);
      const minutes = Math.floor(minDiff % 60);
      return {
        hours: hours,
        minutes: minutes,
        seconds: 0,
        totalMinutes: minDiff,
        totalSeconds: minDiff * 60,
        isRunning: false,
        status: 'waiting',
        remainingText: `${hours}h ${minutes}m`
      };
    } catch(e) {
      return { hours: 0, minutes: 0, isRunning: false, status: 'unknown' };
    }
  }

  // ==================== RECORDING METHODS ====================

  async _getRecordingStatusFromKV(roomName) {
    try {
      if (!roomName) return false;
      
      const memCached = this._recordingEnabled.get(roomName);
      if (memCached !== undefined) {
        return memCached;
      }
      
      const cacheKey = `recording_${roomName}`;
      const cached = this._kvCache.get(cacheKey);
      if (cached !== null) {
        this._recordingEnabled.set(roomName, cached);
        return cached;
      }
      
      if (this.env?.QUESTIONS) {
        const kvValue = await this.env.QUESTIONS.get(
          CONSTANTS.LOWCARD_RECORDING_KEY + roomName
        );
        const isRecording = kvValue === 'true';
        this._recordingEnabled.set(roomName, isRecording);
        this._kvCache.set(cacheKey, isRecording, 300000);
        return isRecording;
      }
      
      return false;
    } catch(e) {
      return false;
    }
  }

  async _startRecordingWinners(roomName) {
    try {
      if (!roomName) return false;
      
      const currentStatus = await this._getRecordingStatusFromKV(roomName);
      if (currentStatus) {
        this._broadcastToRoom(roomName, ["recordingStatus", true]);
        return true;
      }
      
      this._recordingEnabled.set(roomName, true);
      this._kvCache.delete(`recording_${roomName}`);
      this._kvCache.delete(`winners_${roomName}`);
      
      if (this.env?.QUESTIONS) {
        await this.env.QUESTIONS.put(
          CONSTANTS.LOWCARD_RECORDING_KEY + roomName, 
          'true'
        );
      }
      
      this._broadcastToRoom(roomName, ["recordingStatus", true]);
      
      return true;
    } catch(e) {
      return false;
    }
  }

  async _stopRecordingWinners(roomName) {
    try {
      if (!roomName) return false;
      
      const room = roomName.trim();
      
      const currentStatus = await this._getRecordingStatusFromKV(room);
      if (!currentStatus) {
        this._broadcastToRoom(room, ["recordingStatus", false]);
        return true;
      }
      
      this._recordingEnabled.set(room, false);
      this._kvCache.delete(`recording_${room}`);
      this._kvCache.delete(`winners_${room}`);
      
      if (this.env?.QUESTIONS) {
        const statusKey = CONSTANTS.LOWCARD_RECORDING_KEY + room;
        const winnerKey = CONSTANTS.LOWCARD_WINNER_KEY + room;
        
        await this.env.QUESTIONS.delete(statusKey);
        await this.env.QUESTIONS.delete(winnerKey);
        
        const prefixes = [
          CONSTANTS.LOWCARD_WINNER_KEY,
          CONSTANTS.LOWCARD_RECORDING_KEY
        ];
        
        for (const prefix of prefixes) {
          try {
            const list = await this.env.QUESTIONS.list({ prefix: prefix });
            for (const key of list.keys) {
              if (key.name === prefix + room || key.name.includes(room)) {
                await this.env.QUESTIONS.delete(key.name);
              }
            }
          } catch(e) {}
        }
      }
      
      this._broadcastToRoom(room, ["recordingStatus", false]);
      
      return true;
    } catch(e) {
      return false;
    }
  }

  async _sendWinnersToRoom(room) {
    try {
      if (!room) return;
      
      const isRecordingEnabled = await this._getRecordingStatusFromKV(room);
      const winners = await this._getLowCardWinners(room);
      
      this._broadcastToRoom(room, ["lowCardWinnerUpdate", {
        winners: winners,
        room: room,
        recording: isRecordingEnabled
      }]);
      
    } catch(e) {}
  }

  async _getLowCardWinners(room) {
    try {
      if (!room) return {};
      if (!this.env?.QUESTIONS) return {};
      
      const isRecording = await this._getRecordingStatusFromKV(room);
      if (!isRecording) {
        return {};
      }
      
      const cacheKey = `winners_${room}`;
      const cached = this._kvCache.get(cacheKey);
      if (cached !== null) return cached;
      
      const key = CONSTANTS.LOWCARD_WINNER_KEY + room;
      const winners = await this.env.QUESTIONS.get(key, 'json');
      
      if (winners && typeof winners === 'object' && Object.keys(winners).length > 0) {
        this._kvCache.set(cacheKey, winners, 60000);
        return winners;
      }
      
      const empty = {};
      this._kvCache.set(cacheKey, empty, 30000);
      return empty;
    } catch(e) {
      return {};
    }
  }

  async _broadcastLowCardWinners(room) {
    try {
      if (!room) return;
      
      const isRecordingEnabled = await this._getRecordingStatusFromKV(room);
      if (!isRecordingEnabled) {
        return;
      }
      
      const winners = await this._getLowCardWinners(room);
      
      if (Object.keys(winners).length === 0) {
        this._broadcastToRoom(room, ["lowCardWinnerUpdate", {
          winners: {},
          room: room,
          recording: true,
          message: "No winners yet"
        }]);
      } else {
        this._broadcastToRoom(room, ["lowCardWinnerUpdate", {
          winners: winners,
          room: room,
          recording: true
        }]);
      }
      
    } catch(e) {}
  }

  async _addLowCardWinner(room, username) {
    try {
      if (!room || !username) return false;
      
      const isRecordingEnabled = await this._getRecordingStatusFromKV(room);
      if (!isRecordingEnabled) {
        return false;
      }
      
      if (room === DICE_ROOM) {
        return false;
      }
      
      if (!this.env?.QUESTIONS) return false;
      
      const key = CONSTANTS.LOWCARD_WINNER_KEY + room;
      
      let roomWinners = await this.env.QUESTIONS.get(key, 'json') || {};
      
      let currentCount = 0;
      if (roomWinners[username]) {
        const valStr = String(roomWinners[username]);
        currentCount = parseInt(valStr.replace("x", "").replace("X", "")) || 0;
      }
      const newCount = currentCount + 1;
      
      roomWinners[username] = newCount + "x";
      
      await this.env.QUESTIONS.put(key, JSON.stringify(roomWinners));
      
      this._kvCache.delete(`winners_${room}`);
      
      return true;
    } catch(e) {
      return false;
    }
  }

  // ==================== DICE WINNER HANDLING ====================

  async _handleDiceWinner(username, diceValue) {
    try {
      if (this._winnerProcessed) return;
      if (this._isTieActive()) return; // CEK TIE ACTIVE
      
      if (!this.currentDiceRoll || !this._canSubmitDiceAnswer) {
        return;
      }
      
      this._winnerProcessed = true;
      
      const points = await this.diceGameSystem.getPoints();
      points[username] = (points[username] || 0) + 1;
      await this.diceGameSystem.setPoints(points);
      
      this._kvCache.delete('dice_points');
      
      this._broadcastToRoom(DICE_ROOM, ["diceWinner", {
        username: username,
        totalPoints: points[username] || 0,
        diceValue: diceValue,
        round: this._diceRound || 1
      }]);
      
      this._broadcastDiceNotification("diceError", {
        username: username,
        totalPoints: points[username] || 0,
        diceValue: diceValue,
        round: this._diceRound || 1,
        remaining: -1,
        message: `${username} won with value ${diceValue}`
      });
      
      setTimeout(() => {
        this._winnerProcessed = false;
      }, 1000);
      
    } catch(e) {}
  }

  // ==================== DICE NOTIFICATIONS ====================

  _sendDiceEndNotificationOnce() {
    try {
      if (this.diceEndNotified) return;
      const timeLeft = this._getTimeLeftUntilNextDice();
      this._broadcastToRoom(DICE_ROOM, ["diceEnded", { 
        timeLeft: timeLeft.text, 
        status: "ended"
      }]);
      this._broadcastDiceNotification("diceError", { 
        timeLeft: timeLeft.text,
        remaining: -1,
        message: `Dice game ended. Next session in: ${timeLeft.text}`
      });
      this.diceEndNotified = true;
    } catch(e) {}
  }

  _sendDiceNotification(ws, type, data) {
    try {
      if (!ws || ws.readyState !== 1) return;
      const message = data.message || "";
      this._safeSend(ws, ["diceNotification", message]);
    } catch(e) {}
  }

  _broadcastDiceNotification(type, data) {
    try {
      // CEK TIE ACTIVE - JANGAN kirim notifikasi dice saat tie
      if (this._isTieActive() && !data?.isTieBreaker) {
        return;
      }
      
      const wsIds = this.wsClients.get(DICE_ROOM);
      if (!wsIds?.size) return;
      
      const now = Date.now();
      const message = data.message || "";
      const remaining = data.remaining !== undefined ? data.remaining : -1;
      
      let key = `dice_${remaining}`;
      if (remaining === -1) {
        key = `dice_msg_${message.substring(0, 30)}`;
      }
      
      if (message === "TIME UP") {
        key = "dice_timeup";
      }
      
      if (data.cooldown) {
        key = `cooldown_${remaining}`;
      }
      
      if (message !== "TIME UP") {
        if (this._lastNotificationKey === key && (now - this._lastNotificationTime) < 3000) {
          return;
        }
        
        if (remaining > 0 && this._lastSentRemaining === remaining && !data.cooldown) {
          return;
        }
      }
      
      this._lastNotificationKey = key;
      this._lastNotificationTime = now;
      if (remaining > 0) {
        this._lastSentRemaining = remaining;
      }
      
      this._broadcastToRoom(DICE_ROOM, ["diceNotification", message]);
      
    } catch(e) {}
  }

  // ==================== DICE INITIALIZATION ====================

  async _initAsync() {
    try {
      if (this._initializing) return;
      if (this._initialized && !this._isRecovering) return;
      this._initializing = true;
      
      await this.diceGameSystem.loadScores();
      await this._initDice();
      
      this._startWeeklyResetChecker();
      this._startDiceAutoChecker();
      
      setTimeout(() => {
        if (!this.closing && !this.isDestroyed) {
          if (this._isDiceTime()) {
            const clients = this.wsClients.get(DICE_ROOM);
            if (clients && clients.size > 0) {
              this.diceAutoEnabled = true;
              this._broadcastDiceNotification("diceError", {
                message: "Dice game is starting now",
                isDiceTime: true,
                remaining: -1,
                timestamp: Date.now()
              });
              
              setTimeout(() => {
                if (!this.closing && !this.isDestroyed && !this._isTieActive()) {
                  this.forceStartDice();
                }
              }, CONSTANTS.DICE_AUTO_START_DELAY_MS || 3000);
            }
          }
        }
      }, 2000);
      
      this._initialized = true;
      this._initializing = false;
      this._errorCount = 0;
      this._isRecovering = false;
      this._diceInitAttempts = 0;
    } catch(e) {
      this._initializing = false;
      this._handleError('initAsync', e);
      if (this._diceInitAttempts < this._maxDiceInitAttempts && !this.closing && !this.isDestroyed) {
        this._diceInitAttempts++;
        setTimeout(() => {
          if (!this.closing && !this.isDestroyed) {
            this._initAsync();
          }
        }, 5000 * this._diceInitAttempts);
      }
    }
  }

  async _checkDiceAutoStatus() {
    try {
      // CEK TIE ACTIVE
      if (this._isTieActive()) {
        return true;
      }
      
      const isDiceTime = this._isDiceTime();
      if (isDiceTime) {
        this._diceOutOfTimeShown = false;
        this._diceRemainingShown = false;
        this._diceTimeUpShown = false;
        this._diceJoinedNotified.clear();
        
        this.diceEndedToday = false;
        this.diceEndMessageShown = false;
        this.diceEndNotified = false;
        this._nextDiceNotified.clear();
        
        if (!this.diceAutoEnabled) {
          this.diceAutoEnabled = true;
          const wsIds = this.wsClients.get(DICE_ROOM);
          if (wsIds?.size > 0) {
            let hasUnnotified = false;
            for (const wsId of wsIds) {
              if (!this._diceTimeLeftNotified.has(wsId) && !this._nextDiceNotified.has(wsId)) {
                hasUnnotified = true;
                break;
              }
            }
            if (hasUnnotified) {
              this._broadcastDiceTimeLeft();
            }
          }
          await this.startDiceWithDelay(CONSTANTS.QUIZ_START_DELAY_MS);
          if (!this._diceStartTimeout && !this._isShowingDice && !this._diceTimeUpCooldown && !this._isTieActive()) {
            this.forceStartDice();
          }
        } else if (!this.currentDiceRoll && !this._diceTimeout && !this._diceStartTimeout && !this._isShowingDice && !this._diceTimeUpCooldown) {
          const clients = this.wsClients.get(DICE_ROOM);
          if (clients?.size > 0 && !this._isTieActive()) {
            await this._showDiceQuestion();
          }
        }
        return false;
      } else {
        if (this.diceAutoEnabled && !this.diceEndNotified) {
          this.diceAutoEnabled = false;
          this.diceEndedToday = true;
          this.diceEndMessageShown = false;
          await this.resetDice();
          this._clearDiceData();
          this._diceTimeLeftNotified.clear();
          this._nextDiceNotified.clear();
          this._diceJoinedNotified.clear();
          this._sendDiceEndNotificationOnce();
        }
        return true;
      }
    } catch(e) { return true; }
  }

  forceStartDice() {
    try {
      // CEK TIE ACTIVE
      if (this._isTieActive()) {
        console.log('[Dice] Cannot force start - tie breaker active');
        return false;
      }
      
      if (this._isShowingDice) return false;
      if (this._diceTimeUpCooldown) return false;
      if (!this._isDiceTime() || this.currentDiceRoll || this._diceTimeout || this._diceStartTimeout) {
        return false;
      }
      this.diceAutoEnabled = true;
      this._showDiceQuestion();
      return true;
    } catch(e) { return false; }
  }

  _checkAndRestartDice() {
    try {
      // CEK TIE ACTIVE
      if (this._isTieActive()) return;
      
      if (!this._isDiceTime()) return;
      if (this._diceTimeUpCooldown) return;
      if (!this.currentDiceRoll && !this._diceTimeout && !this._diceBreakTimeout && !this._isShowingDice) {
        const clients = this.wsClients.get(DICE_ROOM);
        if (clients?.size > 0) {
          this.diceAutoEnabled = true;
          this._showDiceQuestion();
        }
      }
    } catch(e) {}
  }

  ensureDiceRunning() {
    try {
      // CEK TIE ACTIVE
      if (this._isTieActive()) return;
      
      if (this._isShowingDice) return;
      if (this._diceTimeUpCooldown) return;
      this._forceStartDiceIfTime();
      if (!this.currentDiceRoll && !this._diceTimeout && !this._diceStartTimeout && !this._isShowingDice) {
        this.forceStartDice();
      }
      if (!this._diceKeepAliveInterval) {
        this._startDiceKeepAlive();
      }
    } catch(e) {}
  }

  _forceStartDiceIfTime() {
    try {
      // CEK TIE ACTIVE
      if (this._isTieActive()) return;
      
      if (this._isShowingDice) return;
      if (this._diceTimeUpCooldown) return;
      if (!this._isDiceTime() || this.currentDiceRoll || this._diceTimeout || this._diceStartTimeout) {
        return;
      }
      this.diceAutoEnabled = true;
      this._showDiceQuestion();
    } catch(e) {}
  }

  // ==================== DICE TIMER NOTIFICATIONS ====================

  _startDiceTimerNotifications() {
    try {
      if (this._diceTimerInterval) {
        clearInterval(this._diceTimerInterval);
      }
      
      this._diceNotified20 = false;
      this._diceNotified10 = false;
      this._diceNotified5 = false;
      this._diceNotified3 = false;
      this._diceTimeUpShown = false;
      this._diceRemainingShown = false;
      this._lastSentRemaining = -1;
      this._lastNotificationKey = "";
      this._lastNotificationTime = 0;
      this._diceNotifiedFlags = {
        20: false,
        10: false,
        5: false,
        timeup: false
      };
      
      this._diceTimerInterval = setInterval(() => {
        try {
          // CEK TIE ACTIVE - STOP TIMER JIKA TIE ACTIVE
          if (this._isTieActive()) {
            this._stopDiceTimerNotifications();
            return;
          }
          
          if (!this.currentDiceRoll || !this._diceQuestionStartTime) {
            this._stopDiceTimerNotifications();
            return;
          }
          
          const elapsed = (Date.now() - this._diceQuestionStartTime) / 1000;
          const remaining = Math.max(0, CONSTANTS.DICE_ANSWER_TIME_MS / 1000 - elapsed);
          const remainingInt = Math.floor(remaining);
          
          let shouldSend = false;
          let message = "";
          
          if (remainingInt === 20 && !this._diceNotifiedFlags[20]) {
            this._diceNotifiedFlags[20] = true;
            shouldSend = true;
            message = "20s remaining";
          } else if (remainingInt === 10 && !this._diceNotifiedFlags[10]) {
            this._diceNotifiedFlags[10] = true;
            shouldSend = true;
            message = "10s remaining";
          } else if (remainingInt === 5 && !this._diceNotifiedFlags[5]) {
            this._diceNotifiedFlags[5] = true;
            shouldSend = true;
            message = "5s remaining";
          } else if (remainingInt <= 0 && !this._diceNotifiedFlags.timeup) {
            this._diceNotifiedFlags.timeup = true;
            shouldSend = true;
            message = "TIME UP";
            this._stopDiceTimerNotifications();
            this._startTimeUpCooldown();
          }
          
          if (shouldSend) {
            this._broadcastDiceNotification("diceError", {
              remaining: remainingInt,
              message: message,
              round: this._diceRound || 1,
              isDiceTime: true,
              isActive: true
            });
          }
          
        } catch(e) {}
      }, 1000);
      
    } catch(e) {}
  }

  _startTimeUpCooldown() {
    if (this._diceTimeUpCooldown) return;
    
    this._diceTimeUpCooldown = true;
    
    this._broadcastDiceNotification("diceError", {
      message: "wait 15s",
      remaining: 15,
      isDiceTime: true,
      isActive: false,
      cooldown: true
    });
    
    this._diceTimeUpCooldownTimer = setTimeout(() => {
      this._diceTimeUpCooldownTimer = null;
      this._diceTimeUpCooldown = false;
      
      this._diceNotifiedFlags = {
        20: false,
        10: false,
        5: false,
        timeup: false
      };
      this._lastSentRemaining = -1;
      this._lastNotificationKey = "";
      this._lastNotificationTime = 0;
      
      // CEK TIE ACTIVE sebelum show dice question
      if (!this._isTieActive()) {
        this._showDiceQuestionSilent();
      }
    }, 15000);
  }

  // ==================== DICE QUESTION DISPLAY ====================

  async _showDiceQuestionSilent() {
    try {
      // CEK TIE ACTIVE - JANGAN show dice question
      if (this._isTieActive()) {
        console.log('[Dice] Cannot show question - tie breaker active');
        return;
      }
      
      if (this._isShowingDice) return;
      if (this._diceTimeUpCooldown) return;
      this._lastActivityTime = Date.now();
      this._isDiceIdle = false;
      
      this._diceRemainingShown = false;
      this._diceTimeUpShown = false;
      this._diceOutOfTimeShown = false;
      
      if (!this._isDiceTime()) {
        const clients = this.wsClients.get(DICE_ROOM);
        if (clients?.size > 0) {
          if (!this.diceEndNotified) {
            this._sendDiceEndNotificationOnce();
          }
        }
        return;
      }
      
      if (!this.diceAutoEnabled) {
        this.diceAutoEnabled = true;
        const clients = this.wsClients.get(DICE_ROOM);
        if (clients?.size > 0) {
          this._broadcastDiceNotification("diceError", {
            message: "Dice game is starting soon",
            isDiceTime: true,
            isActive: false,
            remaining: -1
          });
        }
        return;
      }
      
      if (this.isDestroyed || this._diceStartTimeout || this.currentDiceRoll) return;
      
      this._isShowingDice = true;
      
      try {
        this._diceRound = (this._diceRound || 0) + 1;
        
        const diceValue = this.diceGameSystem.rollDice();
        
        this.currentDiceRoll = {
          value: diceValue,
          timestamp: Date.now(),
          round: this._diceRound
        };
        this._diceStartTime = Date.now();
        this._diceQuestionStartTime = Date.now();
        
        this._canSubmitDiceAnswer = true;
        
        this.diceAnswered = new Set();
        this.diceHasWinner = false;
        this.diceWinner = null;
        this._winnerProcessed = false;
        this._diceRemainingShown = false;
        this._diceTimeUpShown = false;
        
        this._diceNotified20 = false;
        this._diceNotified10 = false;
        this._diceNotified5 = false;
        this._diceNotified3 = false;
        this._lastSentRemaining = -1;
        this._diceNotifiedFlags = {
          20: false,
          10: false,
          5: false,
          timeup: false
        };
        
        await this._broadcastDiceRoll(diceValue);
        
        this._broadcastDiceNotification("diceError", {
          answerTime: CONSTANTS.DICE_ANSWER_TIME_MS / 1000,
          remaining: 20,
          message: "Go Cheers Catch draw",
          round: this._diceRound
        });
        
        this._startDiceTimerNotifications();
        
        if (this._diceTimeout) clearTimeout(this._diceTimeout);
        if (this._diceBreakTimeout) clearTimeout(this._diceBreakTimeout);
        
        this._diceTimeout = setTimeout(async () => {
          try {
            if (this.closing || this.isDestroyed) { 
              this._diceTimeout = null; 
              this._isShowingDice = false;
              this._canSubmitDiceAnswer = false;
              this._stopDiceTimerNotifications();
              return; 
            }
            
            // CEK TIE ACTIVE - JIKA TIE ACTIVE, JANGAN proses timeout
            if (this._isTieActive()) {
              console.log('[Dice] Timeout skipped - tie breaker active');
              this._diceTimeout = null;
              return;
            }
            
            const currentClients = this.wsClients.get(DICE_ROOM);
            if (!currentClients?.size) { 
              this._diceTimeout = null; 
              this.currentDiceRoll = null;
              this._isShowingDice = false;
              this._canSubmitDiceAnswer = false;
              this._stopDiceTimerNotifications();
              return; 
            }
            
            const diceValue = this.currentDiceRoll?.value;
            const roundNumber = this._diceRound || 1;
            
            this._stopDiceTimerNotifications();
            
            if (this.diceHasWinner && this.diceWinner) {
              const correctPlayers = [];
              for (const player of this.diceAnswered) {
                const answer = this._playerAnswers.get(player);
                if (answer === this.currentDiceRoll?.value) {
                  correctPlayers.push(player);
                }
              }
              
              // CEK TIE diantara pemain yang benar
              if (correctPlayers.length > 1 && !this._isTieActive()) {
                this._diceTimeout = null;
                this.currentDiceRoll = null;
                this._isShowingDice = false;
                this._canSubmitDiceAnswer = false;
                this._stopDiceTimerNotifications();
                
                // START TIE BREAKER
                await this._startTieBreaker(DICE_ROOM, correctPlayers);
                return;
              }
              
              const points = await this._getDicePoints();
              this._broadcastToRoom(DICE_ROOM, ["diceWinner", {
                username: this.diceWinner,
                totalPoints: points[this.diceWinner] || 0,
                diceValue: diceValue,
                round: roundNumber
              }]);
              
              this._broadcastDiceNotification("diceError", {
                username: this.diceWinner,
                totalPoints: points[this.diceWinner] || 0,
                diceValue: diceValue,
                round: roundNumber,
                remaining: -1,
                message: `${this.diceWinner} won with value ${diceValue}`
              });
            } else {
              this._broadcastToRoom(DICE_ROOM, ["diceNoWinner", {
                message: `No winner - value was ${diceValue}`,
                value: diceValue,
                round: roundNumber
              }]);
            }
            
            this._diceTimeout = null;
            this.currentDiceRoll = null;
            this._isShowingDice = false;
            this._canSubmitDiceAnswer = false;
            
            this._startTimeUpCooldown();
            
          } catch(e) {}
        }, CONSTANTS.DICE_TOTAL_TIME_MS);
        
      } catch(e) {
        this._isShowingDice = false;
        this.currentDiceRoll = null;
        this._canSubmitDiceAnswer = false;
        this._stopDiceTimerNotifications();
      }
    } catch(e) {}
  }

  async _showDiceQuestion() {
    try {
      // ============ KRITIKAL FIX: CEK TIE ACTIVE ============
      if (this._isTieActive()) {
        console.log('[Dice] Cannot show question - tie breaker active');
        return;
      }
      
      if (this._isShowingDice) return;
      if (this._diceTimeUpCooldown) return;
      this._lastActivityTime = Date.now();
      this._isDiceIdle = false;
      
      this._diceRemainingShown = false;
      this._diceTimeUpShown = false;
      this._diceOutOfTimeShown = false;
      
      if (!this._isDiceTime()) {
        const clients = this.wsClients.get(DICE_ROOM);
        if (clients?.size > 0) {
          if (!this.diceEndNotified) {
            this._sendDiceEndNotificationOnce();
          }
        }
        return;
      }
      
      if (!this.diceAutoEnabled) {
        this.diceAutoEnabled = true;
        const clients = this.wsClients.get(DICE_ROOM);
        if (clients?.size > 0) {
          this._broadcastDiceNotification("diceError", {
            message: "Dice game is starting soon",
            isDiceTime: true,
            isActive: false,
            remaining: -1
          });
        }
        return;
      }
      
      if (this.isDestroyed || this._diceStartTimeout || this.currentDiceRoll) return;
      
      this._isShowingDice = true;
      
      try {
        this._diceRound = (this._diceRound || 0) + 1;
        
        const diceValue = this.diceGameSystem.rollDice();
        
        this.currentDiceRoll = {
          value: diceValue,
          timestamp: Date.now(),
          round: this._diceRound
        };
        this._diceStartTime = Date.now();
        this._diceQuestionStartTime = Date.now();
        
        this._canSubmitDiceAnswer = true;
        
        this.diceAnswered = new Set();
        this.diceHasWinner = false;
        this.diceWinner = null;
        this._winnerProcessed = false;
        this._diceRemainingShown = false;
        this._diceTimeUpShown = false;
        
        this._diceNotified20 = false;
        this._diceNotified10 = false;
        this._diceNotified5 = false;
        this._diceNotified3 = false;
        this._lastSentRemaining = -1;
        this._diceNotifiedFlags = {
          20: false,
          10: false,
          5: false,
          timeup: false
        };
        
        await this._broadcastDiceRoll(diceValue);
        
        this._broadcastDiceNotification("diceError", {
          answerTime: CONSTANTS.DICE_ANSWER_TIME_MS / 1000,
          remainingTime: "20s remaining",
          remaining: 20,
          message: "Go Cheers Catch draw",
          round: this._diceRound
        });
        
        this._startDiceTimerNotifications();
        
        if (this._diceTimeout) clearTimeout(this._diceTimeout);
        if (this._diceBreakTimeout) clearTimeout(this._diceBreakTimeout);
        
        this._diceTimeout = setTimeout(async () => {
          try {
            if (this.closing || this.isDestroyed) { 
              this._diceTimeout = null; 
              this._isShowingDice = false;
              this._canSubmitDiceAnswer = false;
              this._stopDiceTimerNotifications();
              return; 
            }
            
            // CEK TIE ACTIVE
            if (this._isTieActive()) {
              console.log('[Dice] Timeout skipped - tie breaker active');
              this._diceTimeout = null;
              return;
            }
            
            const currentClients = this.wsClients.get(DICE_ROOM);
            if (!currentClients?.size) { 
              this._diceTimeout = null; 
              this.currentDiceRoll = null;
              this._isShowingDice = false;
              this._canSubmitDiceAnswer = false;
              this._stopDiceTimerNotifications();
              return; 
            }
            
            const diceValue = this.currentDiceRoll?.value;
            const roundNumber = this._diceRound || 1;
            
            this._stopDiceTimerNotifications();
            
            if (this.diceHasWinner && this.diceWinner) {
              const correctPlayers = [];
              for (const player of this.diceAnswered) {
                const answer = this._playerAnswers.get(player);
                if (answer === this.currentDiceRoll?.value) {
                  correctPlayers.push(player);
                }
              }
              
              if (correctPlayers.length > 1 && !this._isTieActive()) {
                this._diceTimeout = null;
                this.currentDiceRoll = null;
                this._isShowingDice = false;
                this._canSubmitDiceAnswer = false;
                this._stopDiceTimerNotifications();
                
                await this._startTieBreaker(DICE_ROOM, correctPlayers);
                return;
              }
              
              const points = await this._getDicePoints();
              this._broadcastToRoom(DICE_ROOM, ["diceWinner", {
                username: this.diceWinner,
                totalPoints: points[this.diceWinner] || 0,
                diceValue: diceValue,
                round: roundNumber
              }]);
              
              this._broadcastDiceNotification("diceError", {
                username: this.diceWinner,
                totalPoints: points[this.diceWinner] || 0,
                diceValue: diceValue,
                round: roundNumber,
                remaining: -1,
                message: `${this.diceWinner} won with value ${diceValue}`
              });
            } else {
              this._broadcastToRoom(DICE_ROOM, ["diceNoWinner", {
                message: `No winner - value was ${diceValue}`,
                value: diceValue,
                round: roundNumber
              }]);
            }
            
            this._diceTimeout = null;
            this.currentDiceRoll = null;
            this._isShowingDice = false;
            this._canSubmitDiceAnswer = false;
            
            this._startTimeUpCooldown();
            
          } catch(e) {}
        }, CONSTANTS.DICE_TOTAL_TIME_MS);
        
      } catch(e) {
        this._isShowingDice = false;
        this.currentDiceRoll = null;
        this._canSubmitDiceAnswer = false;
        this._stopDiceTimerNotifications();
      }
    } catch(e) {}
  }

  // ==================== DICE ANSWER SUBMISSION ====================

  async submitDiceAnswer(ws, username, guess) {
    try {
      if (!ws || !username) return;
      
      const room = this._ensureRoomConsistency(ws);
      if (room !== DICE_ROOM) return;
      if (!this._isDiceTime()) return;
      
      const guessValue = parseInt(guess, 10);
      if (isNaN(guessValue) || guessValue < 1 || guessValue > 6) {
        this._safeSend(ws, ["diceError", "invalid guess 1-6"]);
        return;
      }
      
      // ============ KRITIKAL FIX: CEK TIE ACTIVE ============
      const isTie = this._isTieActive();
      
      if (isTie) {
        // HANYA handle tie answer
        if (this._tieAnswers.has(username)) {
          this._safeSend(ws, ["diceError", "Already answered in tie breaker"]);
          return;
        }
        
        if (!this._canSubmitDiceAnswer) {
          this._safeSend(ws, ["diceError", "Cannot answer now"]);
          return;
        }
        
        if (!this._tiePlayers.includes(username)) {
          this._safeSend(ws, ["diceError", "Not in tie breaker"]);
          return;
        }
        
        // Validasi guess untuk tie
        if (isNaN(guessValue) || guessValue < 1 || guessValue > 6) {
          this._safeSend(ws, ["diceError", "Invalid number 1-6"]);
          return;
        }
        
        this._tieAnswers.set(username, guessValue);
        this.diceAnswered.add(username);
        this._playerAnswers.set(username, guessValue);
        
        this._broadcastToRoom(DICE_ROOM, ["diceAnswer", {
          username: username,
          guess: guessValue,
          isTieBreaker: true,
          tieBreakerRound: this._tieRound,
          answered: this._tieAnswers.size,
          total: this._tiePlayers.length
        }]);
        
        // CEK apakah semua sudah jawab
        if (this._tieAnswers.size === this._tiePlayers.length) {
          // STOP timer
          if (this._tieTimer) {
            clearTimeout(this._tieTimer);
            this._tieTimer = null;
          }
          if (this._tieInterval) {
            clearInterval(this._tieInterval);
            this._tieInterval = null;
          }
          this._canSubmitDiceAnswer = false;
          this._isShowingDice = false;
          
          const tieId = this._tieId;
          if (tieId) {
            setTimeout(async () => {
              await this._processTieResults(DICE_ROOM, tieId, this._tiePlayers);
            }, 500);
          }
        }
        return; // LANGSUNG STOP - JANGAN lanjut ke dice normal
      }
      
      // ============ LOGIKA DICE NORMAL ============
      if (this.diceAnswered.has(username)) {
        this._safeSend(ws, ["diceError", "Already answered"]);
        return;
      }
      
      const diceValue = this.currentDiceRoll?.value;
      const remaining = this._getDiceAnswerRemainingTime();
      if (remaining <= 0) {
        this.diceAnswered.add(username);
        this._safeSend(ws, ["diceError", "Time expired"]);
        return;
      }
      
      const isCorrect = guessValue === diceValue;
      this._playerAnswers.set(username, guessValue);
      this.diceAnswered.add(username);
      
      this._broadcastToRoom(DICE_ROOM, ["diceAnswer", {
        username: username,
        guess: guessValue,
        round: this._diceRound || 1
      }]);
      
      if (isCorrect && !this.diceHasWinner) {
        this.diceHasWinner = true;
        this.diceWinner = username;
        
        const points = await this._getDicePoints();
        points[username] = (points[username] || 0) + 1;
        await this.diceGameSystem.setPoints(points);
        this._kvCache.delete('dice_points');
      }
      
    } catch(e) {
      console.error('[Dice] Submit error:', e);
    }
  }

  // ==================== TIE BREAKER SYSTEM ====================

  async _startTieBreaker(room, players) {
    try {
      // CEK apakah sudah ada tie active
      if (this._isTieActive()) {
        console.log('[Tie] Tie breaker already active, skipping');
        return;
      }
      
      if (!players || players.length < 2) {
        console.log('[Tie] Not enough players for tie breaker');
        return;
      }
      
      // RESET state tie sebelumnya
      this._resetTieBreakerState(null);
      
      // SET state tie
      this._tieActive = true;
      this._tieRound = 0;
      this._tiePlayers = [...players];
      this._tieAnswers = new Map();
      this._tieId = `tie_${Date.now()}`;
      this._processingTieResults = false;
      this._diceState.isTieActive = true;
      this._diceState.tiePlayers = [...players];
      this._diceState.tieAnswers = new Map();
      this._diceState.tieId = this._tieId;
      this._diceState.state = DICE_STATE.TIE_BREAKER;
      
      // Simpan ke tieBreakers map
      this._tieBreakers.set(this._tieId, {
        players: players,
        round: 0,
        winner: null,
        status: 'waiting',
        startedAt: Date.now()
      });
      
      console.log(`[Tie] Starting tie breaker with ${players.length} players: ${players.join(', ')}`);
      
      // RUN round pertama
      await this._runTieRound(room, this._tieId, players);
      
    } catch(e) {
      console.error('[Tie] Error starting tie breaker:', e);
      this._resetTieBreakerState(null);
    }
  }

  async _runTieRound(room, id, players) {
    try {
      const data = this._tieBreakers.get(id);
      if (!data) {
        console.log('[Tie] Tie breaker data not found');
        return;
      }
      
      // CEK apakah tie masih active
      if (!this._tieActive) {
        console.log('[Tie] Tie breaker no longer active');
        return;
      }
      
      // CEK max rounds
      if (this._tieRound >= CONSTANTS.MAX_TIE_ROUNDS) {
        console.log('[Tie] Max tie rounds reached');
        this._broadcastDiceNotification("diceError", {
          message: `Tie breaker reached max rounds (${CONSTANTS.MAX_TIE_ROUNDS})`,
          remaining: -1,
          isTieBreaker: true
        });
        this._resetTieBreakerState(id);
        this._startCooldownAfterTieBreaker();
        return;
      }
      
      // CLEANUP timers sebelumnya
      if (this._tieTimer) {
        clearTimeout(this._tieTimer);
        this._tieTimer = null;
      }
      if (this._tieInterval) {
        clearInterval(this._tieInterval);
        this._tieInterval = null;
      }
      
      // INCREMENT round
      this._tieRound++;
      this._tiePlayers = [...players];
      this._tieAnswers = new Map();
      data.round = this._tieRound;
      data.status = 'running';
      data.players = players;
      
      this._diceState.tieRound = this._tieRound;
      this._diceState.tiePlayers = [...players];
      this._diceState.tieAnswers = new Map();
      
      const playerNames = players.join(', ');
      
      console.log(`[Tie] Round ${this._tieRound}: ${playerNames}`);
      
      // BROADCAST notifikasi
      this._broadcastDiceNotification("diceError", {
        message: `Round ${this._tieRound}: ${playerNames}`,
        remaining: 20,
        isTieBreaker: true,
        round: this._tieRound
      });
      
      // BROADCAST ke room
      this._broadcastToRoom(room, [
        'tieBreakerRound',
        {
          round: this._tieRound,
          players: players,
          message: `Round ${this._tieRound}: ${playerNames}`,
          timeLimit: 20,
          status: 'waiting_for_answers'
        }
      ]);
      
      // SET state untuk menerima jawaban
      this._canSubmitDiceAnswer = true;
      this._diceQuestionStartTime = Date.now();
      this.diceAnswered = new Set();
      this._isShowingDice = true;
      this._processingTieResults = false;
      
      // START timer
      this._startTieTimer(room, id, players);
      
    } catch(e) {
      console.error('[Tie] Error running tie round:', e);
      this._resetTieBreakerState(id);
    }
  }

  _startTieTimer(room, id, players) {
    try {
      if (this._tieTimer) {
        clearTimeout(this._tieTimer);
        this._tieTimer = null;
      }
      if (this._tieInterval) {
        clearInterval(this._tieInterval);
        this._tieInterval = null;
      }
      
      let timeLeft = 20;
      let notified10 = false;
      let notified5 = false;
      let isProcessed = false;
      
      // INTERVAL untuk notifikasi
      this._tieInterval = setInterval(() => {
        timeLeft--;
        
        if (timeLeft === 10 && !notified10) {
          notified10 = true;
          this._broadcastDiceNotification("diceError", {
            message: "10s remaining",
            remaining: 10,
            isTieBreaker: true
          });
        }
        
        if (timeLeft === 5 && !notified5) {
          notified5 = true;
          this._broadcastDiceNotification("diceError", {
            message: "5s remaining",
            remaining: 5,
            isTieBreaker: true
          });
        }
        
        if (timeLeft <= 0 && !isProcessed) {
          isProcessed = true;
          clearInterval(this._tieInterval);
          this._tieInterval = null;
          
          this._canSubmitDiceAnswer = false;
          this._isShowingDice = false;
          
          this._broadcastDiceNotification("diceError", {
            message: "Time up",
            remaining: -1,
            isTieBreaker: true
          });
          
          if (this._tieId) {
            this._processTieResults(room, this._tieId, this._tiePlayers);
          } else {
            this._resetTieBreakerState(null);
            this._startCooldownAfterTieBreaker();
          }
        }
      }, 1000);
      
      // TIMEOUT utama
      this._tieTimer = setTimeout(() => {
        if (!isProcessed) {
          isProcessed = true;
          if (this._tieInterval) {
            clearInterval(this._tieInterval);
            this._tieInterval = null;
          }
          
          this._canSubmitDiceAnswer = false;
          this._isShowingDice = false;
          
          this._broadcastDiceNotification("diceError", {
            message: "Time up",
            remaining: -1,
            isTieBreaker: true
          });
          
          if (this._tieId) {
            this._processTieResults(room, this._tieId, this._tiePlayers);
          } else {
            this._resetTieBreakerState(null);
            this._startCooldownAfterTieBreaker();
          }
        }
      }, 22000);
      
    } catch(e) {
      console.error('[Tie] Error starting tie timer:', e);
    }
  }

  async _processTieResults(room, id, players) {
    try {
      // CEK apakah tie masih valid
      if (!this._tieBreakers.has(id)) {
        console.log('[Tie] Tie breaker not found, skipping');
        return;
      }
      
      // CEK nested tie
      if (this._tiePlayers.length !== players.length) {
        console.log('[Tie] Nested tie detected, cleaning up');
        this._resetTieBreakerState(id);
        this._startCooldownAfterTieBreaker();
        return;
      }
      
      if (this._processingTieResults) {
        console.log('[Tie] Already processing results, skipping');
        return;
      }
      
      this._processingTieResults = true;
      
      const data = this._tieBreakers.get(id);
      
      // Kumpulkan hasil
      const results = [];
      let highest = 0;
      let highestPlayers = [];
      let allAnswers = [];
      let answeredPlayers = [];
      
      for (const player of players) {
        const answer = this._tieAnswers.get(player);
        if (answer !== undefined && answer >= 1 && answer <= 6) {
          results.push({ player, answer });
          allAnswers.push(answer);
          answeredPlayers.push(player);
          if (answer > highest) {
            highest = answer;
            highestPlayers = [player];
          } else if (answer === highest) {
            highestPlayers.push(player);
          }
        } else {
          // Player tidak menjawab - dieliminasi
          results.push({ player, answer: 0 });
        }
      }
      
      // CEK apakah ada yang menjawab
      if (answeredPlayers.length === 0) {
        this._broadcastDiceNotification("diceError", {
          message: "No one answered. Tie breaker cancelled.",
          remaining: -1,
          isTieBreaker: true
        });
        this._resetTieBreakerState(id);
        this._startCooldownAfterTieBreaker();
        return;
      }
      
      // CEK apakah ada pemenang
      const highestCount = allAnswers.filter(a => a === highest).length;
      const hasTieAtHighest = highestCount > 1;
      
      if (!hasTieAtHighest) {
        // ADA PEMENANG
        const winner = highestPlayers[0];
        
        // AWARD POINT
        const points = await this._getDicePoints();
        points[winner] = (points[winner] || 0) + 1;
        await this.diceGameSystem.setPoints(points);
        this._kvCache.delete('dice_points');
        
        // BROADCAST WINNER
        const resultStrings = results.map(r => r.player + ': ' + r.answer);
        
        this._broadcastToRoom(DICE_ROOM, ["tieBreakerResults", {
          round: this._tieRound,
          results: resultStrings,
          highest: highest,
          winner: winner,
          winnerAnswer: highest,
          eliminated: players.filter(p => !highestPlayers.includes(p)),
          status: 'has_winner'
        }]);
        
        this._broadcastToRoom(DICE_ROOM, ["diceWinner", {
          username: winner,
          totalPoints: points[winner] || 0,
          diceValue: highest,
          round: this._diceRound || 1,
          isTieBreaker: true,
          tieBreakerRound: this._tieRound
        }]);
        
        this._broadcastDiceNotification("diceError", {
          message: `🏆 ${winner} wins tie breaker with ${highest}`,
          winner: winner,
          guess: highest,
          remaining: -1,
          isTieBreaker: true,
          isTieBreakerWinner: true
        });
        
        // RESET tie state
        this._resetTieBreakerState(id);
        this._startCooldownAfterTieBreaker();
        return;
      }
      
      // MASIH TIE - LANJUTKAN ROUND
      if (hasTieAtHighest) {
        // UPDATE players untuk next round
        this._tiePlayers = highestPlayers;
        this._tieAnswers = new Map();
        data.players = highestPlayers;
        data.round = this._tieRound;
        data.status = 'waiting';
        data.tieValue = highest;
        
        this._diceState.tiePlayers = highestPlayers;
        this._diceState.tieAnswers = new Map();
        
        // CLEANUP timer
        if (this._tieTimer) {
          clearTimeout(this._tieTimer);
          this._tieTimer = null;
        }
        if (this._tieInterval) {
          clearInterval(this._tieInterval);
          this._tieInterval = null;
        }
        
        // BROADCAST tie continues
        const resultStrings = results.map(r => r.player + ': ' + r.answer);
        
        this._broadcastToRoom(DICE_ROOM, ["tieBreakerResults", {
          round: this._tieRound,
          results: resultStrings,
          highest: highest,
          highestPlayers: highestPlayers,
          eliminated: players.filter(p => !highestPlayers.includes(p)),
          status: 'tie_continues',
          message: `Tie at ${highest}. Continuing with ${highestPlayers.length} player(s)`
        }]);
        
        this._broadcastDiceNotification("diceError", {
          message: `⚖️ Tie at ${highest}. Next round: ${highestPlayers.join(', ')}`,
          highest: highest,
          players: highestPlayers,
          remaining: -1,
          isTieBreaker: true,
          isTieContinues: true
        });
        
        // DELAY sebelum next round
        setTimeout(() => {
          // CEK apakah tie masih active
          if (this._tieActive && this._tiePlayers.length > 1) {
            // RUN next round
            this._runTieRound(room, id, this._tiePlayers);
          } else if (this._tiePlayers.length === 1) {
            // Hanya 1 player - auto winner
            const winner = this._tiePlayers[0];
            this._processSingleWinner(room, id, winner);
          } else {
            this._resetTieBreakerState(id);
            this._startCooldownAfterTieBreaker();
          }
        }, CONSTANTS.TIE_BREAKER_POST_DELAY_MS || 3000);
        
        return;
      }
      
      // FALLBACK - reset
      this._resetTieBreakerState(id);
      this._startCooldownAfterTieBreaker();
      
    } catch(e) {
      console.error('[Tie] Error processing tie results:', e);
      this._resetTieBreakerState(id);
      this._startCooldownAfterTieBreaker();
    } finally {
      this._processingTieResults = false;
    }
  }

  async _processSingleWinner(room, id, winner) {
    try {
      const points = await this._getDicePoints();
      points[winner] = (points[winner] || 0) + 1;
      await this.diceGameSystem.setPoints(points);
      this._kvCache.delete('dice_points');
      
      this._broadcastToRoom(DICE_ROOM, ["diceWinner", {
        username: winner,
        totalPoints: points[winner] || 0,
        diceValue: 'auto',
        round: this._diceRound || 1,
        isTieBreaker: true,
        tieBreakerRound: this._tieRound
      }]);
      
      this._broadcastDiceNotification("diceError", {
        message: `🏆 ${winner} wins tie breaker`,
        winner: winner,
        remaining: -1,
        isTieBreaker: true,
        isTieBreakerWinner: true
      });
      
      this._resetTieBreakerState(id);
      this._startCooldownAfterTieBreaker();
      
    } catch(e) {
      console.error('[Tie] Error processing single winner:', e);
      this._resetTieBreakerState(id);
      this._startCooldownAfterTieBreaker();
    }
  }

  _startCooldownAfterTieBreaker() {
    try {
      // CEK apakah tie sudah di-reset
      if (!this._tieActive && !this._diceState.isTieActive) {
        console.log('[Tie] Already reset, skipping cooldown');
        return;
      }
      
      this._broadcastDiceNotification("diceError", {
        message: "wait 15s",
        remaining: 15,
        isDiceTime: true,
        isActive: false,
        cooldown: true
      });
      
      this._diceTimeUpCooldown = true;
      
      if (this._diceTimeUpCooldownTimer) {
        clearTimeout(this._diceTimeUpCooldownTimer);
        this._diceTimeUpCooldownTimer = null;
      }
      
      this._diceTimeUpCooldownTimer = setTimeout(() => {
        this._diceTimeUpCooldownTimer = null;
        this._diceTimeUpCooldown = false;
        
        this._diceNotifiedFlags = {
          20: false,
          10: false,
          5: false,
          timeup: false
        };
        this._lastSentRemaining = -1;
        this._lastNotificationKey = "";
        this._lastNotificationTime = 0;
        
        // CEK TIE ACTIVE sebelum show dice question
        if (!this._isTieActive()) {
          this._showDiceQuestionSilent();
        }
      }, CONSTANTS.TIE_BREAKER_COOLDOWN_MS || 15000);
      
    } catch(e) {
      console.error('[Tie] Error starting cooldown:', e);
    }
  }

  _resetTieBreakerState(id) {
    try {
      // CLEANUP timers
      if (this._tieTimer) {
        clearTimeout(this._tieTimer);
        this._tieTimer = null;
      }
      if (this._tieInterval) {
        clearInterval(this._tieInterval);
        this._tieInterval = null;
      }
      
      // DELETE dari map
      if (id) {
        this._tieBreakers.delete(id);
      }
      
      // RESET state
      this._tieActive = false;
      this._tiePlayers = [];
      this._tieAnswers = new Map();
      this._tieRound = 0;
      this._tieId = null;
      this._processingTieResults = false;
      this._canSubmitDiceAnswer = false;
      this._isShowingDice = false;
      
      // RESET dice state
      this._diceState.isTieActive = false;
      this._diceState.tiePlayers = [];
      this._diceState.tieAnswers = new Map();
      this._diceState.tieId = null;
      this._diceState.tieRound = 0;
      
      if (this._diceState.state === DICE_STATE.TIE_BREAKER) {
        this._diceState.state = DICE_STATE.IDLE;
      }
      
      console.log('[Tie] Tie breaker state reset');
      
    } catch(e) {
      console.error('[Tie] Error resetting tie state:', e);
    }
  }

  _getActiveTieBreakerId() {
    for (const [id, data] of this._tieBreakers) {
      if (data.status === 'waiting' || data.status === 'running') {
        return id;
      }
    }
    return null;
  }

  // ==================== DICE RESET ====================

  async resetDice() {
    try {
      // RESET tie breaker juga
      this._resetTieBreakerState(null);
      
      if (this._diceTimeout) clearTimeout(this._diceTimeout);
      if (this._diceBreakTimeout) clearTimeout(this._diceBreakTimeout);
      if (this._diceStartTimeout) clearTimeout(this._diceStartTimeout);
      if (this._diceKeepAliveInterval) clearInterval(this._diceKeepAliveInterval);
      if (this._diceAutoCheckInterval) {
        clearInterval(this._diceAutoCheckInterval);
        this._diceAutoCheckInterval = null;
      }
      
      if (this._diceTimeUpCooldownTimer) {
        clearTimeout(this._diceTimeUpCooldownTimer);
        this._diceTimeUpCooldownTimer = null;
      }
      
      this._stopDiceTimerNotifications();
      
      this.currentDiceRoll = null;
      this.diceHasWinner = false;
      this.diceWinner = null;
      this.diceAnswered = new Set();
      this._diceStartTime = null;
      this.diceEndNotified = false;
      this._isShowingDice = false;
      this._winnerProcessed = false;
      this._canSubmitDiceAnswer = false;
      this._diceQuestionStartTime = null;
      this._diceOutOfTimeShown = false;
      this._diceRemainingShown = false;
      this._diceTimeUpShown = false;
      this._lastSentRemaining = -1;
      this._diceTimeUpCooldown = false;
      this._diceNotifiedFlags = {
        20: false,
        10: false,
        5: false,
        timeup: false
      };
      
      this._diceTimeLeftNotified.clear();
      this._nextDiceNotified.clear();
      this._diceJoinedNotified.clear();
      
      this._playerAnswers = new Map();
      
      // RESET dice state
      this._diceState.state = DICE_STATE.IDLE;
      this._diceState.isLocked = false;
      this._diceState.rollLock = false;
      
      console.log('[Dice] Reset complete');
      
    } catch(e) {
      console.error('[Dice] Error resetting:', e);
    }
  }

  async startDiceWithDelay(delayMs) {
    try {
      if (this._diceStartTimeout) return;
      this._diceStartTimeout = setTimeout(() => {
        try {
          if (this.closing || this.isDestroyed) { 
            this._diceStartTimeout = null; 
            return; 
          }
          this._diceStartTimeout = null;
          // CEK TIE ACTIVE sebelum start
          if (!this._isTieActive() && !this.currentDiceRoll && this.diceAutoEnabled && !this._isShowingDice && !this._diceTimeUpCooldown) {
            this.forceStartDice();
          }
        } catch(e) {}
      }, delayMs);
    } catch(e) {}
  }

  async _initDice(retryCount = 0) {
    try {
      await this.diceGameSystem.loadScores();
      return true;
    } catch(e) {
      if (retryCount < CONSTANTS.MAX_RETRY_INIT_QUIZ && !this.closing && !this.isDestroyed) {
        setTimeout(() => this._initDice(retryCount + 1), 5000);
      }
      return false;
    }
  }

  _startDiceKeepAlive() {}

  _clearDiceData() {
    try {
      // RESET tie juga
      this._resetTieBreakerState(null);
      
      if (this._diceTimeUpCooldownTimer) {
        clearTimeout(this._diceTimeUpCooldownTimer);
        this._diceTimeUpCooldownTimer = null;
      }
      
      this.currentDiceRoll = null;
      this._diceStartTime = null;
      this.diceAnswered = new Set();
      this.diceHasWinner = false;
      this.diceWinner = null;
      this._isShowingDice = false;
      this._winnerProcessed = false;
      this._canSubmitDiceAnswer = false;
      this._diceQuestionStartTime = null;
      this._diceOutOfTimeShown = false;
      this._diceRemainingShown = false;
      this._diceTimeUpShown = false;
      this._lastSentRemaining = -1;
      this._diceTimeUpCooldown = false;
      this._diceNotifiedFlags = {
        20: false,
        10: false,
        5: false,
        timeup: false
      };
      
      this._stopDiceTimerNotifications();
      
      if (this._diceTimeout) {
        clearTimeout(this._diceTimeout);
        this._diceTimeout = null;
      }
      if (this._diceBreakTimeout) {
        clearTimeout(this._diceBreakTimeout);
        this._diceBreakTimeout = null;
      }
      if (this._diceStartTimeout) {
        clearTimeout(this._diceStartTimeout);
        this._diceStartTimeout = null;
      }
      
      this._playerAnswers = new Map();
      
      this._diceState.state = DICE_STATE.IDLE;
      
      this._broadcastDiceNotification("diceError", {
        message: "Dice game has ended",
        remaining: -1,
        clearUI: true
      });
      
    } catch(e) {}
  }

  // ==================== DICE BROADCAST ====================

  async _broadcastDiceResult(type, data) {
    try {
      const wsIds = this.wsClients.get(DICE_ROOM);
      if (!wsIds || wsIds.size === 0) return;
      
      const msgStr = JSON.stringify([type, data]);
      const wsIdArray = Array.from(wsIds);
      const BATCH_SIZE = CONSTANTS.BROADCAST_BATCH_SIZE || 5;
      let startTime = Date.now();
      
      for (let i = 0; i < wsIdArray.length; i += BATCH_SIZE) {
        const batch = wsIdArray.slice(i, i + BATCH_SIZE);
        
        for (const wsId of batch) {
          const ws = this.wsMap.get(wsId);
          if (ws && ws.readyState === 1) {
            try { 
              ws.send(msgStr); 
            } catch(e) {}
          }
        }
        
        if (Date.now() - startTime > 8) {
          await this._cpuYield();
          startTime = Date.now();
        }
      }
      
    } catch(e) {}
  }

  _broadcastDiceTimeLeft() {
    try {
      // CEK TIE ACTIVE
      if (this._isTieActive()) return;
      
      const wsIds = this.wsClients.get(DICE_ROOM);
      if (!wsIds?.size) return;
      const now = Date.now();
      if (now - this._lastDiceTimeLeftBroadcast < this._diceTimeLeftBroadcastCooldown) {
        return;
      }
      
      if (this.currentDiceRoll && this._diceStartTime) {
        const elapsed = (Date.now() - this._diceStartTime) / 1000;
        const totalTime = CONSTANTS.DICE_TOTAL_TIME_MS / 1000;
        const remaining = Math.max(0, totalTime - elapsed);
        const remainingInt = Math.floor(remaining);
        
        if (remainingInt > 0) {
          const minutes = Math.floor(remainingInt / 60);
          const seconds = remainingInt % 60;
          const message = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
          
          this._broadcastDiceNotification("diceError", {
            message: message,
            remaining: remainingInt,
            isDiceTime: true,
            isActive: true,
            round: this._diceRound || 1
          });
          this._lastDiceTimeLeftBroadcast = now;
          return;
        }
      }
      
      const timeLeft = this._getTimeLeftUntilNextDice();
      this._broadcastDiceNotification("diceError", {
        message: `Next dice game in: ${timeLeft.text}`,
        timeLeft: timeLeft.text,
        hours: timeLeft.hours,
        minutes: timeLeft.minutes,
        remaining: -1,
        isDiceTime: this._isDiceTime(),
        isActive: false
      });
      this._lastDiceTimeLeftBroadcast = now;
      
    } catch(e) {}
  }

  _sendDiceTimeLeftToUser(ws) {
    try {
      if (!ws || ws.readyState !== 1) return false;
      const wsId = this._getWsId(ws);
      if (!wsId) return false;
      
      if (this._diceTimeLeftNotified.has(wsId)) {
        return false;
      }
      
      if (this.currentDiceRoll && this._diceStartTime) {
        const elapsed = (Date.now() - this._diceStartTime) / 1000;
        const totalTime = CONSTANTS.DICE_TOTAL_TIME_MS / 1000;
        const remaining = Math.max(0, totalTime - elapsed);
        const remainingInt = Math.floor(remaining);
        
        if (remainingInt > 0) {
          const minutes = Math.floor(remainingInt / 60);
          const seconds = remainingInt % 60;
          const timeText = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
          
          let displayTime = "";
          if (remainingInt >= 20) {
            displayTime = "20s remaining";
          } else if (remainingInt >= 10) {
            displayTime = "10s remaining";
          } else if (remainingInt > 0) {
            displayTime = `${timeText} remaining`;
          }
          
          if (displayTime) {
            this._sendDiceNotification(ws, "diceError", {
              message: displayTime,
              remaining: remainingInt,
              isDiceTime: true,
              isActive: true,
              round: this._diceRound || 1
            });
            this._diceTimeLeftNotified.set(wsId, Date.now());
            return true;
          }
        }
      }
      
      const timeLeft = this._getTimeLeftUntilNextDice();
      this._sendDiceNotification(ws, "diceError", {
        message: `Next dice game in: ${timeLeft.text}`,
        timeLeft: timeLeft.text,
        hours: timeLeft.hours,
        minutes: timeLeft.minutes,
        remaining: -1,
        isDiceTime: this._isDiceTime(),
        isActive: false
      });
      this._diceTimeLeftNotified.set(wsId, Date.now());
      return true;
      
    } catch(e) { return false; }
  }

  _sendDiceErrorWithTime(ws, errorType, customMessage = null) {
    try {
      if (!ws || ws.readyState !== 1) return false;
      const timeLeft = this._getTimeLeftUntilNextDice();
      let message = "";
      
      switch(errorType) {
        case "NOT_DICE_TIME":
          message = `Dice game will start in ${timeLeft.text}`;
          break;
        case "DICE_DISABLED": 
          message = `Dice game is disabled. Next session: ${timeLeft.text}`; 
          break;
        case "DICE_ENDED":
          message = `Dice game ended. Next session: ${timeLeft.text}`;
          break;
        case "DICE_NOT_STARTED": 
          message = `Dice game not started. Next session: ${timeLeft.text}`; 
          break;
        default: 
          message = customMessage || `Next dice game: ${timeLeft.text}`;
      }
      
      this._sendDiceNotification(ws, "diceError", {
        message: message,
        timeLeft: timeLeft.text,
        remaining: -1,
        errorType: errorType,
        isDiceTime: this._isDiceTime()
      });
      
      return true;
    } catch(e) { return false; }
  }

  _getDiceQuestionRemainingTime() {
    try {
      if (!this.currentDiceRoll || !this._diceStartTime) return 0;
      const elapsed = (Date.now() - this._diceStartTime) / 1000;
      return Math.max(0, Math.round((CONSTANTS.DICE_TOTAL_TIME_MS / 1000) - elapsed));
    } catch(e) { return 0; }
  }

  _getDiceAnswerRemainingTime() {
    try {
      if (!this.currentDiceRoll || !this._diceQuestionStartTime) return 0;
      const elapsed = (Date.now() - this._diceQuestionStartTime) / 1000;
      return Math.max(0, Math.round((CONSTANTS.DICE_ANSWER_TIME_MS / 1000) - elapsed));
    } catch(e) { return 0; }
  }

  async _broadcastDiceRoll(diceValue) {
    try {
      // CEK TIE ACTIVE - JANGAN broadcast dice roll
      if (this._isTieActive()) {
        console.log('[Dice] Cannot broadcast dice roll - tie breaker active');
        return;
      }
      
      const wsIds = this.wsClients.get(DICE_ROOM);
      if (!wsIds?.size) return;

      const msgData = {
        value: diceValue,
        timestamp: Date.now(),
        answerTime: CONSTANTS.DICE_ANSWER_TIME_MS / 1000,
        canAnswerNow: true,
        message: "Go Cheers Catch draw",
        round: this._diceRound || 1,
        timerNotifications: [20, 10, 5]
      };
      
      const msgStr = JSON.stringify(["diceRoll", msgData]);
      const wsIdArray = Array.from(wsIds);
      const BATCH_SIZE = CONSTANTS.BROADCAST_BATCH_SIZE || 5;
      let startTime = Date.now();
      
      for (let i = 0; i < wsIdArray.length; i += BATCH_SIZE) {
        const batch = wsIdArray.slice(i, i + BATCH_SIZE);
        
        for (const wsId of batch) {
          const ws = this.wsMap.get(wsId);
          if (ws && ws.readyState === 1) {
            try { ws.send(msgStr); } catch(e) {}
          }
        }
        
        if (Date.now() - startTime > 8) {
          await this._cpuYield();
          startTime = Date.now();
        }
      }
      
    } catch(e) {}
  }

  // ==================== LOW CARD GAME METHODS ====================

  // ... (Low Card Game methods - same as original, unchanged)
  // ... (WebSocket management methods - same as original, unchanged)

  // ==================== EVENT HANDLING ====================

  async handleEvent(ws, data) {
    try {
      if (this.isDestroyed || !ws || !data?.[0]) return;
      this._eventQueue.push({ ws, data });
      if (!this._isProcessingQueue) {
        await this._safeExecute(async () => {
          await this._processEventQueue();
        });
      }
    } catch(e) {}
  }

  async _processEventQueue() {
    try {
      if (this._isProcessingQueue || this._eventQueue.length === 0) return;
      if (this._eventQueue.length > CONSTANTS.MAX_EVENT_QUEUE_SIZE) {
        this._eventQueue.splice(0, this._eventQueue.length - CONSTANTS.MAX_EVENT_QUEUE_SIZE);
      }
      this._isProcessingQueue = true;
      this._startCPUTimer();
      const batchSize = CONSTANTS.MAX_EVENTS_PER_TICK;
      const batch = this._eventQueue.splice(0, batchSize);
      for (const item of batch) {
        try {
          await this._processEventItem(item.ws, item.data);
        } catch(e) {
          this._handleError('processEvent', e);
        }
        if (this._checkCPULimit()) {
          await this._cpuYield();
          this._startCPUTimer();
        }
      }
      if (this._eventQueue.length > 0) {
        setTimeout(() => {
          if (!this.closing && !this.isDestroyed) {
            this._processEventQueue();
          }
        }, CONSTANTS.CPU_YIELD_DELAY_MS);
      }
    } catch(e) {
      this._handleError('processQueue', e);
    } finally {
      this._isProcessingQueue = false;
    }
  }

  async _processEventItem(ws, data) {
    try {
      if (this.isDestroyed || !ws || !data || !data[0]) return;
      const evt = data[0];
      const wsId = ws._wsId;
      if (wsId && this._isRateLimited(wsId, evt)) {
        this._safeSend(ws, ["gameLowCardError", "Too many requests"]);
        return;
      }
      await this._safeExecute(async () => {
        await this._handleEventInternal(ws, data);
      });
    } catch(e) {}
  }

  async _handleEventInternal(ws, data) {
    try {
      if (this.isDestroyed || !ws || !data || !data[0]) return;
      const evt = data[0];

      if (evt === "switchRoom") {
        const [_, room, username] = data;
        await this.switchRoom(ws, room, username);
        return;
      }

      if (evt === "submitDiceAnswer") {
        const [_, username, guess] = data;
        await this.submitDiceAnswer(ws, username, guess);
        return;
      }

      if (evt === "submitTieBreakerAnswer") {
        const [_, username, guess] = data;
        const result = this._submitTieAnswer(username, parseInt(guess, 10));
        if (result.success) {
          this._broadcastToRoom(DICE_ROOM, ["tieBreakerAnswer", { 
            username: username, 
            answered: this._tieAnswers.size 
          }]);
        } else {
          this._safeSend(ws, ["tieBreakerError", result.message]);
        }
        return;
      }

      if (evt === "getTieBreakerStatus") {
        const status = {
          active: this._tieActive,
          round: this._tieRound,
          players: this._tiePlayers,
          answers: this._tieAnswers.size,
          totalPlayers: this._tiePlayers.length,
          status: this._tieActive ? 'running' : 'idle',
          id: this._tieId
        };
        this._safeSend(ws, ["tieBreakerStatus", status]);
        return;
      }

      if (evt === "getDiceLastWeekWinner") {
        try {
          const winner = await this.env.QUESTIONS.get(CONSTANTS.DICE_LAST_WEEK_WINNER, 'json');
          if (winner && winner.username) {
            this._safeSend(ws, ["diceLastWeekWinner", winner.username, winner.score || 0, winner.week || ""]);
          } else {
            this._safeSend(ws, ["diceLastWeekWinner", "", 0, ""]);
          }
        } catch(e) {
          this._safeSend(ws, ["diceLastWeekWinner", "", 0, ""]);
        }
        return;
      }

      if (evt === "getDiceLeaderboard") {
        try {
          let limit = data.length > 1 && typeof data[1] === 'number' ? Math.min(data[1], 30) : 10;
          const points = await this.env.QUESTIONS.get(CONSTANTS.DICE_POINT_KEY, 'json') || {};
          const sorted = Object.entries(points)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit);
          const result = sorted.map(([username, score]) => `${username}|${score}`);
          this._safeSend(ws, ["diceLeaderboard", result]);
        } catch(e) {
          this._safeSend(ws, ["diceLeaderboard", []]);
        }
        return;
      }

      // ... (other event handlers - same as original)

      // Default: Low Card game events
      const room = ws.room || ws.roomname || this.clientRooms.get(ws._wsId);
      
      if (!room) {
        this._safeSend(ws, ["gameLowCardError", "Please switch to a room first"]);
        return;
      }
      
      if (room === DICE_ROOM) {
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
        case "gameLowCardLeave":
          await this.leaveGame(ws, data[1]);
          break;
        case "checkGameRunning":
          await this.checkGameRunning(ws, data[1]);
          break;
        case "getGameState":
          const targetRoom = data[1] || room;
          this._sendGameStateToClient(ws, targetRoom);
          break;
        default:
          break;
      }
      
    } catch(e) {}
  }

  _submitTieAnswer(username, guess) {
    try {
      if (!this._tieActive) {
        return { success: false, message: 'No active tie breaker' };
      }
      
      if (this._tieAnswers.has(username)) {
        return { success: false, message: 'Already answered' };
      }
      
      if (!this._tiePlayers.includes(username)) {
        return { success: false, message: 'Not in tie breaker' };
      }
      
      if (isNaN(guess) || guess < 1 || guess > 6) {
        return { success: false, message: 'Invalid guess 1-6' };
      }

      this._tieAnswers.set(username, guess);
      this.diceAnswered.add(username);
      this._playerAnswers.set(username, guess);
      
      // CEK apakah semua sudah jawab
      if (this._tieAnswers.size === this._tiePlayers.length) {
        // Stop timer
        if (this._tieTimer) {
          clearTimeout(this._tieTimer);
          this._tieTimer = null;
        }
        if (this._tieInterval) {
          clearInterval(this._tieInterval);
          this._tieInterval = null;
        }
        this._canSubmitDiceAnswer = false;
        this._isShowingDice = false;
        
        setTimeout(async () => {
          if (this._tieId) {
            await this._processTieResults(DICE_ROOM, this._tieId, this._tiePlayers);
          }
        }, 500);
      }
      
      return { success: true, message: 'Answer submitted' };
    } catch(e) {
      return { success: false, message: 'Error submitting answer' };
    }
  }

  // ==================== WS HELPER METHODS ====================

  _getWsId(ws) { return ws?._wsId || null; }

  _getRoomForWs(ws) {
    if (!ws) return null;
    return ws.room || ws.roomname || null;
  }

  _ensureRoomConsistency(ws) {
    try {
      if (!ws) return null;
      const wsId = this._getWsId(ws);
      if (!wsId) return null;
      
      let room = ws.room || ws.roomname || null;
      
      if (!room) {
        room = this.clientRooms.get(wsId) || null;
      }
      
      if (!room && ws.username) {
        const conn = this.userConnections.get(ws.username);
        if (conn) room = conn.room || null;
      }
      
      if (room) {
        ws.room = room;
        ws.roomname = room;
        
        if (!this.wsClients.has(room)) {
          this.wsClients.set(room, new Set());
        }
        
        if (!this.wsClients.get(room).has(wsId)) {
          this.wsClients.get(room).add(wsId);
          this.clientRooms.set(wsId, room);
          this.wsMap.set(wsId, ws);
        }
        
        return room;
      }
      
      return null;
    } catch(e) { 
      return null; 
    }
  }

  _addClient(room, ws, username = null, isNewConnection = false) {
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
      
      if (username) {
        let conn = this.userConnections.get(username);
        if (conn) { 
          conn.room = room; 
          conn.timestamp = Date.now(); 
          conn.ws = ws; 
          conn.wsId = wsId;
        } else { 
          this.userConnections.set(username, { 
            wsId, 
            ws, 
            room, 
            timestamp: Date.now() 
          }); 
        }
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
      
      if (username) {
        if (!this.roomViewers.has(room)) {
          this.roomViewers.set(room, new Set());
        }
        this.roomViewers.get(room).add(username);
      }
      
    } catch(e) {}
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

  _removeClient(room, ws) {
    try {
      if (!ws) return;
      const wsId = this._getWsId(ws);
      if (!wsId) return;
      const username = ws.username;
      this._diceTimeLeftNotified.delete(wsId);
      this._nextDiceNotified.delete(wsId);
      this._diceJoinedNotified.delete(wsId);
      this._removeClientFromRoom(room, wsId);
      this.clientRooms.delete(wsId);
      this.wsMap.delete(wsId);
      if (username) {
        const conn = this.userConnections.get(username);
        if (conn?.wsId === wsId) this.userConnections.delete(username);
        if (this.roomViewers.has(room)) {
          this.roomViewers.get(room).delete(username);
          if (this.roomViewers.get(room).size === 0) this.roomViewers.delete(room);
        }
      }
      ws.room = null;
      ws.roomname = null;
      ws._wsId = null;
      ws.username = null;
    } catch(e) {}
  }

  async switchRoom(ws, room, username = null) {
    try {
      if (this.isDestroyed) { 
        this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]); 
        return; 
      }
      
      if (!room || room.trim() === "") { 
        this._safeSend(ws, ["gameLowCardError", "Invalid room name"]); 
        return; 
      }
      
      const roomName = room.trim();
      const wsId = this._getWsId(ws);
      if (!wsId) { 
        this._safeSend(ws, ["gameLowCardError", "Connection error"]); 
        return; 
      }
      
      const currentRoom = ws.room || ws.roomname || this.clientRooms.get(wsId);
      if (currentRoom === roomName) {
        this._safeSend(ws, ["switchRoomSuccess", roomName]);
        this._sendGameStateToClient(ws, roomName);
        
        if (roomName === DICE_ROOM) {
          this._sendDiceNotificationOnSwitch(ws, wsId);
        }
        
        return;
      }
      
      const lockKey = `switch_${wsId}`;
      if (this._switchLocks.has(lockKey)) {
        const retryCount = this._switchRetries.get(lockKey) || 0;
        if (retryCount > 3) {
          this._switchLocks.delete(lockKey);
          this._switchRetries.delete(lockKey);
          this._safeSend(ws, ["switchRoomError", "Switch timeout"]);
          return;
        }
        this._switchRetries.set(lockKey, retryCount + 1);
        this._safeSend(ws, ["switchRoomSuccess", currentRoom || roomName]);
        return;
      }
      
      this._switchLocks.set(lockKey, Date.now());
      this._switchRetries.set(lockKey, 0);
      
      try {
        if (currentRoom) {
          this._removeClientFromRoom(currentRoom, wsId);
        }
        
        this._addClient(roomName, ws, username, false);
        ws.room = roomName;
        ws.roomname = roomName;
        if (username) ws.username = username;
        
        if (username) {
          let conn = this.userConnections.get(username);
          if (conn) { 
            conn.room = roomName; 
            conn.wsId = wsId; 
            conn.ws = ws; 
            conn.timestamp = Date.now(); 
          } else { 
            this.userConnections.set(username, { 
              wsId, 
              ws, 
              room: roomName, 
              timestamp: Date.now() 
            }); 
          }
        }
        
        this._safeSend(ws, ["switchRoomSuccess", roomName]);
        this._sendGameStateToClient(ws, roomName);
        
        if (roomName === DICE_ROOM) {
          this._sendDiceNotificationOnSwitch(ws, wsId);
        }
        
        this._broadcastToRoom(roomName, ["userJoinedRoom", username, roomName]);
        if (currentRoom && currentRoom !== roomName) {
          this._broadcastToRoom(currentRoom, ["userLeftRoom", username, currentRoom]);
        }
        
      } finally {
        setTimeout(() => {
          this._switchLocks.delete(lockKey);
          this._switchRetries.delete(lockKey);
        }, 2000);
      }
    } catch(e) {}
  }

  _sendGameStateToClient(ws, room) {
    try {
      if (!ws || ws.readyState !== 1 || !room) return;
      
      const game = this.activeGames.get(room);
      if (!game || !game._isActive || game._gameEnded) {
        this._safeSend(ws, ["gameState", {
          room: room,
          hasGame: false,
          gameType: 'lowcard'
        }]);
        return;
      }
      
      const activePlayers = this._getActivePlayers(game);
      const allPlayers = Array.from(game.players.values()).map(p => p.name);
      const eliminated = Array.from(game.eliminated || []);
      const submitted = Array.from(game.numbers?.keys() || []);
      
      const state = {
        room: room,
        hasGame: true,
        gameType: 'lowcard',
        isActive: game._isActive,
        phase: game._phase || 'registration',
        round: game.round || 1,
        bet: game.betAmount || 0,
        host: game.hostName || 'Unknown',
        registrationOpen: game.registrationOpen || false,
        players: allPlayers,
        activePlayers: activePlayers.map(p => p.name),
        eliminated: eliminated,
        submitted: submitted,
        playerCount: game.players.size,
        activeCount: activePlayers.length,
        isEvaluating: game._isEvaluating || false,
        evaluationLocked: game.evaluationLocked || false,
        drawTimeExpired: game.drawTimeExpired || false
      };
      
      this._safeSend(ws, ["gameState", state]);
      
      if (game._phase === 'draw' && ws.username) {
        const userNumber = game.numbers.get(ws.username);
        if (userNumber !== undefined) {
          const userTanda = game.tanda.get(ws.username) || '';
          this._safeSend(ws, ["gameLowCardPlayerDraw", ws.username, userNumber, userTanda]);
        }
      }
      
      this._getRecordingStatusFromKV(room).then(isRecording => {
        if (isRecording !== undefined) {
          this._safeSend(ws, ["recordingStatus", isRecording]);
        }
      }).catch(() => {});
      
    } catch(e) {}
  }

  _sendDiceNotificationOnSwitch(ws, wsId) {
    try {
      this._diceTimeLeftNotified.delete(wsId);
      this._nextDiceNotified.delete(wsId);
      this._diceJoinedNotified.delete(wsId);
      
      // CEK TIE ACTIVE
      if (this._isTieActive()) {
        this._sendDiceNotification(ws, "diceError", {
          message: `Tie breaker in progress: Round ${this._tieRound}`,
          remaining: -1,
          isTieBreaker: true,
          isActive: true
        });
        return;
      }
      
      const isGameActive = this.currentDiceRoll && this._canSubmitDiceAnswer;
      
      if (isGameActive) {
        const elapsed = (Date.now() - this._diceStartTime) / 1000;
        const totalTime = CONSTANTS.DICE_TOTAL_TIME_MS / 1000;
        const remaining = Math.max(0, totalTime - elapsed);
        const remainingInt = Math.floor(remaining);
        
        if (remainingInt > 0) {
          let displayTime = "";
          if (remainingInt >= 20) {
            displayTime = "20s remaining";
          } else if (remainingInt >= 10) {
            displayTime = "10s remaining";
          } else if (remainingInt >= 5) {
            displayTime = "5s remaining";
          } else {
            displayTime = `${remainingInt}s remaining`;
          }
          
          this._sendDiceNotification(ws, "diceError", {
            message: displayTime,
            remaining: remainingInt,
            isDiceTime: true,
            isActive: true
          });
        }
      } else {
        const timeLeft = this._getTimeLeftUntilNextDice();
        
        setTimeout(() => {
          if (!this.closing && !this.isDestroyed && ws && ws.readyState === 1) {
            this._sendDiceNotification(ws, "diceError", {
              message: `Dice game ended. Next session in: ${timeLeft.text}`,
              timeLeft: timeLeft.text,
              hours: timeLeft.hours,
              minutes: timeLeft.minutes,
              remaining: -1,
              isDiceTime: this._isDiceTime(),
              isActive: false
            });
          }
        }, 5000);
        
        this._diceJoinedNotified.set(wsId, true);
      }
      
      if (this.currentDiceRoll && this._canSubmitDiceAnswer && !this._isTieActive()) {
        this._safeSend(ws, ["diceRoll", {
          value: this.currentDiceRoll.value,
          timestamp: this.currentDiceRoll.timestamp,
          answerTime: CONSTANTS.DICE_ANSWER_TIME_MS / 1000,
          canAnswerNow: true,
          round: this._diceRound || 1
        }]);
      }
    } catch(e) {}
  }

  async _broadcastToRoom(room, message) {
    try {
      if (this.closing || this.isDestroyed || !room || !message) return;
      const wsIds = this.wsClients.get(room);
      if (!wsIds?.size) return;
      
      const msgStr = JSON.stringify(message);
      const wsIdArray = Array.from(wsIds);
      const BATCH_SIZE = CONSTANTS.BROADCAST_BATCH_SIZE || 5;
      let startTime = Date.now();
      
      for (let i = 0; i < wsIdArray.length; i += BATCH_SIZE) {
        const batch = wsIdArray.slice(i, i + BATCH_SIZE);
        
        for (const wsId of batch) {
          const ws = this.wsMap.get(wsId);
          if (ws && ws.readyState === 1) {
            try { ws.send(msgStr); } catch(e) {}
          }
        }
        
        if (Date.now() - startTime > 8) {
          await this._cpuYield();
          startTime = Date.now();
        }
      }
      
    } catch(e) {}
  }

  _safeSend(ws, message) {
    try {
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(message));
      return true;
    } catch(e) { return false; }
  }

  // ==================== STALE GAME CLEANUP ====================

  _checkStuckGames() {
    try {
      const now = Date.now();
      const toEvaluate = [];
      const toClose = [];
      
      for (const [room, game] of this.activeGames) {
        if (!game?._isActive || game._gameEnded) continue;
        
        if (game._phase === 'draw' && game._drawPhaseStart &&
            (now - game._drawPhaseStart) > CONSTANTS.STUCK_DRAW_TIMEOUT_MS) {
          toEvaluate.push({ room, game });
        }
        
        if (game._phase === 'registration' && game.registrationOpen &&
            game._createdAt && (now - game._createdAt) > CONSTANTS.STUCK_REGISTRATION_TIMEOUT_MS) {
          toClose.push({ room, game });
        }
        
        if (game._phase !== 'registration' && !game.registrationOpen) {
          const activePlayers = this._getActivePlayers(game);
          if (activePlayers.length === 0 && !game._gameEnded) {
            game._gameEnded = true;
            game._isActive = false;
            game._endTime = Date.now();
            this._broadcastToRoom(room, ["gameLowCardEnd", []]);
            this._scheduleGameCleanup(room, game);
          }
        }
      }
      
      for (const item of toEvaluate) {
        this._closeDrawPhase(item.room, item.game);
      }
      
      for (const item of toClose) {
        this._closeRegistration(item.room, item.game);
      }
      
    } catch(e) {}
  }

  _cleanupStaleGames() {
    try {
      const now = Date.now();
      for (const [room, game] of this.activeGames) {
        if (!game) continue;
        if (game._isActive && !game._gameEnded) continue;
        if (game._gameEnded) {
          const endTime = game._endTime || game._createdAt || now;
          if ((now - endTime) > CONSTANTS.STALE_GAME_TIMEOUT_MS) this._scheduleGameCleanup(room, game);
          continue;
        }
        if (!game._isActive && !game._gameEnded && game._createdAt && (now - game._createdAt) > 300000) {
          game._gameEnded = true;
          game._endTime = now;
          this._scheduleGameCleanup(room, game);
        }
      }
    } catch(e) {}
  }

  _cleanupDeadConnections() {
    try {
      const toRemove = [];
      for (const [wsId, ws] of this.wsMap) {
        if (!ws || ws.readyState !== 1 || ws._closing) toRemove.push(wsId);
      }
      for (const wsId of toRemove) {
        const ws = this.wsMap.get(wsId);
        if (ws) {
          const room = this.clientRooms.get(wsId);
          if (room) this._removeClientFromRoom(room, wsId);
          this.clientRooms.delete(wsId);
          this.wsMap.delete(wsId);
          this._diceTimeLeftNotified.delete(wsId);
          this._nextDiceNotified.delete(wsId);
          this._diceJoinedNotified.delete(wsId);
          for (const [username, conn] of this.userConnections) {
            if (conn?.wsId === wsId) { this.userConnections.delete(username); break; }
          }
        }
      }
    } catch(e) {}
  }

  _scheduleGameCleanup(room, game) {
    try {
      if (!room || !game) return;
      if (this._cleanupTimers.has(room)) {
        const oldTimer = this._cleanupTimers.get(room);
        if (oldTimer) clearTimeout(oldTimer);
        this._cleanupTimers.delete(room);
      }
      if (!game._gameEnded) return;
      const timer = setTimeout(() => {
        try {
          const currentGame = this.activeGames.get(room);
          if (currentGame?._isActive && !currentGame._gameEnded) { 
            this._cleanupTimers.delete(room); 
            return; 
          }
          this._cleanupTimers.delete(room);
          const gameToDelete = this.activeGames.get(room);
          if (gameToDelete) this._deleteGame(room, gameToDelete);
        } catch(e) {}
      }, CONSTANTS.GAME_CLEANUP_DELAY_MS);
      this._cleanupTimers.set(room, timer);
    } catch(e) {}
  }

  _deleteGame(room, game) {
    try {
      if (!room || !game) return;
      if (game?._isActive && !game._gameEnded) return;
      if (this._cleanupTimers.has(room)) { 
        clearTimeout(this._cleanupTimers.get(room)); 
        this._cleanupTimers.delete(room); 
      }
      this._roomBroadcastCount.delete(room);
      this._roomBroadcastReset.delete(room);
      if (game) {
        game._gameEnded = true;
        game._isActive = false;
        game.playerWsId = null;
        this._cleanupGame(game);
      }
      this.activeGames.delete(room);
      this._gameLocks.delete(room);
      this._joinLocks.delete(room);
      this._gameStartFlags.delete(room);
      this._broadcastToRoom(room, ["gameLowCardEnd", []]);
    } catch(e) {}
  }

  _cleanupGame(game) {
    try {
      if (!game) return;
      if (game._isActive && !game._gameEnded) return;
      const timers = ['_registrationTimer', '_drawTimer', '_evalTimer', '_safetyTimer'];
      for (const key of timers) {
        if (game[key]) { 
          clearTimeout(game[key]); 
          clearInterval(game[key]); 
          game[key] = null; 
        }
      }
      if (game._botTimeouts) {
        for (const id of game._botTimeouts) clearTimeout(id);
        game._botTimeouts.clear();
        game._botTimeouts = null;
      }
      game.players = null;
      game.botPlayers = null;
      game.numbers = null;
      game.tanda = null;
      game.eliminated = null;
      game._isActive = false;
      game._gameEnded = true;
      game._isEvaluating = false;
    } catch(e) {}
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

  _isGameActuallyRunning(game) { 
    try { 
      return game?._isActive === true && !game?._gameEnded; 
    } catch(e) { 
      return false; 
    } 
  }

  // ==================== ERROR HANDLING & RECOVERY ====================

  _startWeeklyResetChecker() {}

  _setupErrorHandlers() {
    try {
      const self = this;
      if (typeof process !== 'undefined' && process.on) {
        process.on('unhandledRejection', (reason) => {
          self._handleError('unhandledRejection', reason);
        });
        process.on('uncaughtException', (error) => {
          self._handleError('uncaughtException', error);
        });
      }
    } catch(e) {}
  }

  _handleError(type, error) {
    try {
      const now = Date.now();
      if (now - this._lastErrorReset > CONSTANTS.ERROR_RESET_INTERVAL_MS) {
        this._errorCount = 0;
        this._lastErrorReset = now;
      }
      this._errorCount++;
      if (this._errorCount > CONSTANTS.MAX_UNHANDLED_ERRORS && 
          !this._isRecovering && 
          this._recoveryAttempts < this._maxRecoveryAttempts) {
        this._isRecovering = true;
        this._recoveryAttempts++;
        this._lastRecoveryTime = now;
        setTimeout(() => {
          this._forceRecovery();
          this._isRecovering = false;
        }, CONSTANTS.ERROR_RECOVERY_DELAY_MS);
      }
    } catch(e) {}
  }

  _startHealthCheck() {}

  _performHealthCheck() {
    try {
      const now = Date.now();
      this._lastHeartbeat = now;
      if (this._isProcessingQueue && this._eventQueue.length > 0) {
        const queueAge = now - (this._lastHeartbeat || now);
        if (queueAge > 30000) {
          this._isProcessingQueue = false;
          this._eventQueue = [];
        }
      }
      
      // CEK TIE ACTIVE - JANGAN reset dice saat tie
      if (this._isTieActive()) {
        return;
      }
      
      if (this._isDiceTime() && this.currentDiceRoll && this._diceStartTime) {
        const elapsed = (now - this._diceStartTime) / 1000;
        if (elapsed > (CONSTANTS.DICE_TOTAL_TIME_MS / 1000) + 30) {
          this.currentDiceRoll = null;
          this._diceTimeout = null;
          this._isShowingDice = false;
          this._canSubmitDiceAnswer = false;
          this._diceRemainingShown = false;
          this._diceTimeUpShown = false;
          this._stopDiceTimerNotifications();
        }
      }
      const deadConnections = [];
      for (const [wsId, ws] of this.wsMap) {
        if (!ws || ws.readyState !== 1) {
          deadConnections.push(wsId);
        }
      }
      for (const wsId of deadConnections) {
        try {
          const ws = this.wsMap.get(wsId);
          if (ws) {
            const room = this.clientRooms.get(wsId);
            if (room) this._removeClientFromRoom(room, wsId);
            this.clientRooms.delete(wsId);
            this.wsMap.delete(wsId);
          }
        } catch(e) {}
      }
    } catch(e) {}
  }

  _forceRecovery() {
    try {
      if (this.closing || this.isDestroyed) return;
      if (this._recoveryAttempts >= this._maxRecoveryAttempts) return;
      this._resetCriticalState();
      this._cleanupResources();
      
      this._startWeeklyResetChecker();
      
      if (!this._initialized && !this._initializing) {
        this._initAsync();
      }
      if (this._isDiceTime() && !this._isTieActive()) {
        this.diceAutoEnabled = true;
      }
      this._broadcastToRoom(DICE_ROOM, ["diceNotification", "Server has recovered"]);
    } catch(e) {}
  }

  _resetCriticalState() {
    try {
      // RESET tie state
      this._resetTieBreakerState(null);
      
      this.currentDiceRoll = null;
      this.diceHasWinner = false;
      this.diceWinner = null;
      this.diceAnswered = new Set();
      this._diceStartTime = null;
      this._isShowingDice = false;
      this._winnerProcessed = false;
      this._canSubmitDiceAnswer = false;
      this._diceQuestionStartTime = null;
      this._diceOutOfTimeShown = false;
      this._diceRemainingShown = false;
      this._diceTimeUpShown = false;
      this._lastSentRemaining = -1;
      this._diceTimeUpCooldown = false;
      this._diceNotifiedFlags = {
        20: false,
        10: false,
        5: false,
        timeup: false
      };
      this._stopDiceTimerNotifications();
      
      this._playerAnswers = new Map();
      
      this._diceState.state = DICE_STATE.IDLE;
      this._diceState.isLocked = false;
      this._diceState.rollLock = false;
      
      if (this._eventQueue) {
        this._eventQueue = [];
      }
      if (this._rateLimitMap) {
        this._rateLimitMap.clear();
      }
    } catch(e) {}
  }

  _cleanupResources() {
    try {
      if (this._diceTimeout) {
        clearTimeout(this._diceTimeout);
        this._diceTimeout = null;
      }
      if (this._diceBreakTimeout) {
        clearTimeout(this._diceBreakTimeout);
        this._diceBreakTimeout = null;
      }
      if (this._diceStartTimeout) {
        clearTimeout(this._diceStartTimeout);
        this._diceStartTimeout = null;
      }
      if (this.diceTimer) {
        clearInterval(this.diceTimer);
        this.diceTimer = null;
      }
      if (this.diceAutoTimer) {
        clearInterval(this.diceAutoTimer);
        this.diceAutoTimer = null;
      }
      if (this._diceKeepAliveInterval) {
        clearInterval(this._diceKeepAliveInterval);
        this._diceKeepAliveInterval = null;
      }
      if (this._diceAutoCheckInterval) {
        clearInterval(this._diceAutoCheckInterval);
        this._diceAutoCheckInterval = null;
      }
      if (this._diceTimeUpCooldownTimer) {
        clearTimeout(this._diceTimeUpCooldownTimer);
        this._diceTimeUpCooldownTimer = null;
      }
      this._stopDiceTimerNotifications();
      
      if (this._tieTimer) {
        clearTimeout(this._tieTimer);
        this._tieTimer = null;
      }
      if (this._tieInterval) {
        clearInterval(this._tieInterval);
        this._tieInterval = null;
      }
    } catch(e) {}
  }

  // ==================== SHUTDOWN & DESTROY ====================

  async destroy() {
    try {
      if (this.isDestroyed) return;
      this.isDestroyed = true;
      this.closing = true;
      
      // Reset tie first
      this._resetTieBreakerState(null);
      
      if (this._diceAutoCheckInterval) {
        clearInterval(this._diceAutoCheckInterval);
        this._diceAutoCheckInterval = null;
      }
      if (this._diceTimerInterval) {
        clearInterval(this._diceTimerInterval);
        this._diceTimerInterval = null;
      }
      if (this._diceKeepAliveInterval) {
        clearInterval(this._diceKeepAliveInterval);
        this._diceKeepAliveInterval = null;
      }
      if (this._healthCheckInterval) {
        clearInterval(this._healthCheckInterval);
        this._healthCheckInterval = null;
      }
      if (this._diceTimeUpCooldownTimer) {
        clearTimeout(this._diceTimeUpCooldownTimer);
        this._diceTimeUpCooldownTimer = null;
      }
      
      if (this._kvCache) {
        this._kvCache.stopCleanup();
        this._kvCache.clear();
      }
      
      if (this._scheduler) {
        this._scheduler.stop();
      }
      
      for (const [room, game] of this.activeGames) {
        await this._forceCleanupGame(room, game);
      }
      this.activeGames.clear();
      
      await this.resetDice();
      this.diceGameSystem.clearCache();
      
      for (const [wsId, ws] of this.wsMap) {
        try {
          if (ws && ws.readyState === 1) {
            ws.close(1000, "Server shutting down");
          }
        } catch(e) {}
      }
      this.wsMap.clear();
      this.wsClients.clear();
      this.clientRooms.clear();
      
    } catch(e) {}
  }

  // ==================== FETCH ====================

  async fetch(req) {
    try {
      if (this.closing || this.isDestroyed) {
        return new Response("Server is shutting down", { status: 503 });
      }
      
      const url = new URL(req.url);
      
      if (url.pathname === "/health") {
        try {
          const status = {
            status: "ok",
            uptime: Date.now() - this._startTime,
            restartCount: this._restartCount,
            isRestarting: this._isRestarting,
            isRecovering: this._isRecovering,
            diceActive: !!this.currentDiceRoll,
            diceRound: this._diceRound || 0,
            diceCooldown: this._diceTimeUpCooldown,
            tieActive: this._isTieActive(),
            tieRound: this._tieRound,
            tiePlayers: this._tiePlayers.length,
            gamesRunning: this.activeGames.size,
            wsConnections: this.wsMap.size,
            eventQueueSize: this._eventQueue?.length || 0,
            errorCount: this._errorCount,
            timestamp: Date.now(),
            diceSchedule: QUIZ_SCHEDULE.SESSIONS.map(s => `${s.start}:00-${s.end}:00`),
            currentWITATime: this._getCurrentWITATime().formatted,
            lastResetWeek: this._cachedResetWeek || 'unknown',
            currentWeek: this._generateCurrentWeek(new Date()),
            diceState: this._diceState.state,
          };
          return new Response(JSON.stringify(status), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch(e) {
          return new Response(JSON.stringify({ status: "degraded", error: e.message }), {
            status: 500,
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
          return new Response("Server at maximum capacity", { status: 503 });
        }
        
        try {
          const pair = new WebSocketPair();
          const [client, server] = [pair[0], pair[1]];
          const wsId = ++this._wsIdCounter;
          
          server._wsId = wsId;
          server._closing = false;
          server.room = null;
          server.roomname = null;
          server._createdAt = Date.now();
          server.username = null;
          server._cf = req.cf || {};
          server._country = req.cf?.country || 'US';
          server._language = 'en';
          
          try { 
            this.state.acceptWebSocket(server); 
          } catch(e) { 
            return new Response("WebSocket acceptance failed", { status: 500 }); 
          }
          
          server.addEventListener("message", async (event) => {
            try {
              const data = JSON.parse(event.data);
              if (Array.isArray(data) && data.length > 0) {
                await this.handleEvent(server, data);
              }
            } catch(e) { 
              this._safeSend(server, ["gameLowCardError", e.message || "Error"]); 
            }
          });
          
          server.addEventListener("close", () => {
            this.webSocketClose(server);
          });
          
          server.addEventListener("error", () => {
            this.webSocketError(server);
          });
          
          return new Response(null, { status: 101, webSocket: client });
        } catch(e) {
          return new Response("WebSocket creation failed", { status: 500 });
        }
      }
      
      return new Response("Game Server", { status: 200 });
    } catch(e) {
      this._handleError('fetch', e);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  webSocketClose(ws) {
    try {
      if (!ws) return;
      
      ws._closing = true;
      
      const wsId = ws._wsId;
      const username = ws.username;
      const room = ws.room || ws.roomname || this.clientRooms.get(wsId);
      
      // Jika user dalam tie, hapus dari tie
      if (this._tieActive && username && this._tiePlayers.includes(username)) {
        this._tiePlayers = this._tiePlayers.filter(p => p !== username);
        this._tieAnswers.delete(username);
        this._diceState.tiePlayers = this._tiePlayers;
        this._diceState.tieAnswers.delete(username);
        
        // Jika tinggal 1 player, proses winner
        if (this._tiePlayers.length === 1 && this._tieActive) {
          const winner = this._tiePlayers[0];
          this._processSingleWinner(DICE_ROOM, this._tieId, winner);
        } else if (this._tiePlayers.length === 0) {
          this._resetTieBreakerState(this._tieId);
        }
      }
      
      if (room) {
        this._removeClientFromRoom(room, wsId);
      }
      
      if (wsId) {
        this.clientRooms.delete(wsId);
        this.wsMap.delete(wsId);
        this._diceTimeLeftNotified.delete(wsId);
        this._nextDiceNotified.delete(wsId);
        this._diceJoinedNotified.delete(wsId);
      }
      
      if (username) {
        const conn = this.userConnections.get(username);
        if (conn?.wsId === wsId) {
          this.userConnections.delete(username);
        }
      }
      
      if (room && username) {
        const viewers = this.roomViewers.get(room);
        if (viewers) {
          viewers.delete(username);
          if (viewers.size === 0) {
            this.roomViewers.delete(room);
          }
        }
      }
      
      ws.room = null;
      ws.roomname = null;
      ws._wsId = null;
      ws.username = null;
      ws._closing = true;
      
      const clients = this.wsClients.get(DICE_ROOM);
      if (clients?.size > 0) {
        this.ensureDiceRunning();
      }
    } catch(e) {}
  }

  async webSocketError(ws) {
    try {
      if (!ws) return;
      
      ws._closing = true;
      
      const wsId = ws._wsId;
      const username = ws.username;
      const room = ws.room || ws.roomname || this.clientRooms.get(wsId);
      
      // Jika user dalam tie, hapus dari tie
      if (this._tieActive && username && this._tiePlayers.includes(username)) {
        this._tiePlayers = this._tiePlayers.filter(p => p !== username);
        this._tieAnswers.delete(username);
        this._diceState.tiePlayers = this._tiePlayers;
        this._diceState.tieAnswers.delete(username);
        
        if (this._tiePlayers.length === 1 && this._tieActive) {
          const winner = this._tiePlayers[0];
          this._processSingleWinner(DICE_ROOM, this._tieId, winner);
        } else if (this._tiePlayers.length === 0) {
          this._resetTieBreakerState(this._tieId);
        }
      }
      
      if (room) {
        this._removeClientFromRoom(room, wsId);
      }
      
      if (wsId) {
        this.clientRooms.delete(wsId);
        this.wsMap.delete(wsId);
        this._diceTimeLeftNotified.delete(wsId);
        this._nextDiceNotified.delete(wsId);
        this._diceJoinedNotified.delete(wsId);
      }
      
      if (username) {
        const conn = this.userConnections.get(username);
        if (conn?.wsId === wsId) {
          this.userConnections.delete(username);
        }
      }
      
      if (room && username) {
        const viewers = this.roomViewers.get(room);
        if (viewers) {
          viewers.delete(username);
          if (viewers.size === 0) {
            this.roomViewers.delete(room);
          }
        }
      }
      
      ws.room = null;
      ws.roomname = null;
      ws._wsId = null;
      ws.username = null;
      ws._closing = true;
    } catch(e) {}
  }

  async webSocketMessage(ws, msg) {
    try {
      if (!ws || ws._closing || this.closing || this.isDestroyed || !ws._wsId) return;
      const data = JSON.parse(msg);
      if (Array.isArray(data) && data.length > 0) {
        await this.handleEvent(ws, data);
      }
    } catch(e) {
      this._handleError('webSocketMessage', e);
      this._safeSend(ws, ["gameLowCardError", "Server is recovering"]);
    }
  }
}
