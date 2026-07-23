// ==================== GAME-SERVER.JS ====================

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
  QUIZ_INTERVAL_MS: 30000,
  QUIZ_TIME_LIMIT_MS: 15000,
  QUIZ_BREAK_MS: 2000,
  QUIZ_START_DELAY_MS: 5000,
  MAX_RETRY_INIT_QUIZ: 2,
  MAX_SHUTDOWN_WAIT_MS: 5000,
  MAX_WS_CLIENTS: 50,
  MAX_ARRAY_SIZE: 50,
  QUIZ_SWITCH_DELAY_MS: 5000,
  QUIZ_POINT_KEY: 'quiz_points',
  QUIZ_LAST_WEEK_WINNER: 'quiz_last_week_winner',
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
};

const QUIZ_SCHEDULE = {
  SESSIONS: [
    { start: 11, end: 12 },
    { start: 21, end: 22 },
    { start: 0, end: 1 },
    { start: 3, end: 5 },
  ],
  TIMEZONE_OFFSET: 8,
};

const QUIZ_ROOM = "Quiz";

const COUNTRY_LANGUAGE_MAP = {
  'ID': { lang: 'id', name: 'Indonesia', kvKey: 'trivia_id' },
  'MY': { lang: 'id', name: 'Malaysia', kvKey: 'trivia_id' },
  'SG': { lang: 'id', name: 'Singapore', kvKey: 'trivia_id' },
  'BN': { lang: 'id', name: 'Brunei', kvKey: 'trivia_id' },
  'PH': { lang: 'fil', name: 'Philippines', kvKey: 'trivia_fil' },
  'IN': { lang: 'hi', name: 'India', kvKey: 'trivia_hi' },
  'NP': { lang: 'hi', name: 'Nepal', kvKey: 'trivia_hi' },
  'LK': { lang: 'hi', name: 'Sri Lanka', kvKey: 'trivia_hi' },
  'BD': { lang: 'hi', name: 'Bangladesh', kvKey: 'trivia_hi' },
  'PK': { lang: 'hi', name: 'Pakistan', kvKey: 'trivia_hi' },
};

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

  _startCPUMonitor() {
    if (this._cpuMonitorInterval) clearInterval(this._cpuMonitorInterval);
    this._cpuMonitorInterval = setInterval(() => {
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
    }, CONSTANTS.CPU_CHECK_INTERVAL_MS);
  }
}

class CountryBasedQuizSystem {
  constructor(gameServer) {
    this.gameServer = gameServer;
    this.env = gameServer.env;
    this.countryLanguageMap = COUNTRY_LANGUAGE_MAP;
    this.supportedLanguages = ['id', 'fil', 'hi', 'ar'];
    this.userCountryCache = new Map();
    this.questionCache = new Map();
    this.countryQuestionCache = new Map();
    this.questionsByLanguage = new Map();
    this._isLoaded = false;
    this._usedQuestions = new Set();
    this._loading = false;
    this._loadAttempts = 0;
    this._maxLoadAttempts = 3;
  }

  getQuestionsByLanguage(langCode) {
    if (this.gameServer._questionsCache?.loaded) {
      const questions = this.gameServer._questionsCache[langCode];
      if (questions && questions.length > 0) {
        return questions;
      }
    }
    const data = this.questionsByLanguage.get(langCode);
    return data?.questions || null;
  }

  async loadAllQuestions() {
    try {
      if (this._loading) return this._isLoaded;
      if (this.gameServer._questionsCache?.loaded) {
        this._isLoaded = true;
        const languages = ['en', 'id', 'fil', 'hi', 'ar'];
        for (const lang of languages) {
          const questions = this.gameServer._questionsCache[lang];
          if (questions && questions.length > 0) {
            this.questionsByLanguage.set(lang, {
              questions: questions,
              total: questions.length,
              language: lang,
              languageName: this.getLanguageName(lang),
              fetchedAt: new Date().toISOString()
            });
          }
        }
        return true;
      }
      this._loading = true;
      this._loadAttempts++;
      const env = this.env;
      if (!env?.QUESTIONS) {
        this._loading = false;
        return false;
      }
      const languages = [
        { code: 'id', key: 'trivia_id', name: 'Indonesia' },
        { code: 'en', key: 'trivia_en', name: 'English' },
        { code: 'fil', key: 'trivia_fil', name: 'Filipino' },
        { code: 'hi', key: 'trivia_hi', name: 'Hindi' },
        { code: 'ar', key: 'trivia_ar', name: 'Arab' }
      ];
      for (const lang of languages) {
        try {
          const data = await env.QUESTIONS.get(lang.key, 'json');
          if (data?.questions?.length > 0) {
            const shuffledQuestions = this._shuffleArray([...data.questions]);
            this.questionsByLanguage.set(lang.code, {
              questions: shuffledQuestions,
              total: data.total || shuffledQuestions.length,
              language: lang.code,
              languageName: lang.name,
              fetchedAt: data.fetchedAt || new Date().toISOString()
            });
          }
        } catch(e) {}
      }
      this._isLoaded = this.questionsByLanguage.size > 0;
      this._loading = false;
      return this._isLoaded;
    } catch(e) {
      this._loading = false;
      return false;
    }
  }

  _shuffleArray(array) {
    if (!array || array.length === 0) return array;
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async getQuestionsForCountry(countryCode) {
    try {
      if (!countryCode) return null;
      const cacheKey = `country_${countryCode}`;
      if (this.countryQuestionCache.has(cacheKey)) {
        return this.countryQuestionCache.get(cacheKey);
      }
      const info = this.countryLanguageMap[countryCode];
      if (!info) return null;
      const lang = info.lang;
      const questions = this.getQuestionsByLanguage(lang);
      if (questions) {
        const result = {
          country: countryCode,
          countryName: info.name,
          language: lang,
          languageName: this.getLanguageName(lang),
          questions: questions,
          total_questions: questions.length
        };
        this.countryQuestionCache.set(cacheKey, result);
        return result;
      }
      const env = this.env;
      if (!env?.QUESTIONS) return null;
      const kvKey = `trivia_${lang}`;
      const data = await env.QUESTIONS.get(kvKey, 'json');
      if (data?.questions) {
        const result = {
          country: countryCode,
          countryName: info.name,
          language: lang,
          languageName: this.getLanguageName(lang),
          questions: data.questions,
          total_questions: data.questions.length
        };
        this.countryQuestionCache.set(cacheKey, result);
        return result;
      }
      return null;
    } catch(e) {
      return null;
    }
  }

  getQuestionByIndex(langCode, index) {
    try {
      const questions = this.getQuestionsByLanguage(langCode);
      if (!questions || questions.length === 0) return null;
      const safeIndex = index % questions.length;
      return questions[safeIndex] || null;
    } catch(e) {
      return null;
    }
  }

  getRandomQuestion(langCode) {
    try {
      const questions = this.getQuestionsByLanguage(langCode);
      if (!questions || questions.length === 0) return null;
      const availableQuestions = questions.filter((_, index) => 
        !this._usedQuestions.has(`${langCode}_${index}`)
      );
      if (availableQuestions.length === 0) {
        this._usedQuestions.clear();
        const randomIndex = Math.floor(Math.random() * questions.length);
        this._usedQuestions.add(`${langCode}_${randomIndex}`);
        return { question: questions[randomIndex], index: randomIndex };
      }
      const randomIndex = Math.floor(Math.random() * availableQuestions.length);
      const originalIndex = questions.indexOf(availableQuestions[randomIndex]);
      this._usedQuestions.add(`${langCode}_${originalIndex}`);
      return { question: availableQuestions[randomIndex], index: originalIndex };
    } catch(e) {
      return null;
    }
  }

  getLanguageName(langCode) {
    const names = {
      'id': 'Bahasa Indonesia',
      'fil': 'Filipino',
      'hi': 'Hindi (India)',
      'ar': 'العربية (Arab)',
      'en': 'English'
    };
    return names[langCode] || langCode || 'English';
  }

  getUserCountryInfo(wsId) {
    const countryCode = this.gameServer.userCountry.get(wsId) || 'US';
    const info = this.countryLanguageMap[countryCode];
    return {
      countryCode: countryCode,
      countryName: info?.name || 'Unknown',
      language: info?.lang || 'en',
      hasTranslations: this.questionsByLanguage.has(info?.lang || 'en')
    };
  }

  clearCaches() {
    this.userCountryCache.clear();
    this.questionCache.clear();
    this.countryQuestionCache.clear();
    this._usedQuestions.clear();
  }

  getTranslationStatus() {
    const status = {};
    for (const [lang, data] of this.questionsByLanguage) {
      status[lang] = {
        language: lang,
        languageName: data.languageName,
        totalQuestions: data.total,
        loaded: true
      };
    }
    return {
      loaded: this._isLoaded,
      languages: status,
      totalLanguages: this.questionsByLanguage.size
    };
  }
}

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

      // Flag to prevent duplicate winner processing
      this._winnerProcessed = false;

      this._questionsCache = {
        en: [],
        id: [],
        fil: [],
        hi: [],
        ar: [],
        loaded: false,
        loading: false,
        loadTime: null,
        loadError: null
      };

      this.activeGames = new Map();
      this._maxGames = CONSTANTS.MAX_LOWCARD_GAMES;
      this._gameLocks = new Map();
      this._joinLocks = new Map();
      this._switchLocks = new Map();

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

      this.quizAnswered = new Set();
      this.quizHasWinner = false;
      this.quizWinner = null;
      this.quizTimer = null;
      this.isQuizRunning = false;
      this.currentQuestion = null;
      this.isQuizWaiting = false;
      this.quizQuestionCache = {};
      this._quizStartTime = null;
      this._allQuestions = [];
      this._currentQuestions = [];
      this._currentBatchStart = 0;
      this._currentBatchEnd = 0;
      this._isAllQuestionsLoaded = false;
      this._questionPointer = 0;
      this._totalQuestionsAnswered = 0;
      this._currentBatchIndex = 0;
      this._lastLoadedBatch = 0;
      this.userLanguage = new Map();
      this.userCountry = new Map();
      this._requestCount = 0;
      this._requestResetTime = Date.now() + 60000;
      this._subRequestCount = 0;
      this._quizTimeout = null;
      this._quizBreakTimeout = null;
      this._quizStartTimeout = null;
      this.quizAutoEnabled = false;
      this.quizAutoTimer = null;
      this._quizKeepAliveInterval = null;
      this._lastActivityTime = Date.now();
      this._isQuizIdle = false;
      this._isShowingQuestion = false;
      this._quizInitAttempts = 0;
      this._maxQuizInitAttempts = 3;

      this.quizEndedToday = false;
      this.quizEndMessageShown = false;
      this.quizEndNotified = false;

      this._globalQuestionIndex = 0;

      this._quizTimeLeftNotified = new Map();
      this._nextQuizNotified = new Map();
      this._quizTimeLeftBroadcastCooldown = 30000;
      this._lastQuizTimeLeftBroadcast = 0;

      this.countryQuizSystem = new CountryBasedQuizSystem(this);

      this._loadAllQuestionsToMemory();

      this._initAsync();
      this._startCPUMonitor();
      this._startHealthCheck();
      this._startRoomVerification();

      setTimeout(async () => {
        try {
          if (!this.closing && !this.isDestroyed) {
            await this.countryQuizSystem.loadAllQuestions();
          }
        } catch(e) {}
      }, 5000);

      setTimeout(() => {
        if (!this.closing && !this.isDestroyed && !this._isShowingQuestion) {
          this.forceStartQuiz();
        }
      }, 8000);

    } catch(e) {}
  }

  // ===== FIXED: Centralized winner handler =====
  async _handleQuizWinner(username, correctAnswer) {
    try {
      if (this._winnerProcessed) {
        console.log(`[QUIZ] Winner ${username} already processed, skipping duplicate`);
        return;
      }
      
      this._winnerProcessed = true;
      
      const points = await this._getQuizPoints();
      points[username] = (points[username] || 0) + 1;
      await this._setQuizPoints(points);
      
      this._broadcastQuizNotification("quizWinner", {
        username: username,
        totalPoints: points[username] || 0
      });
      
      this._broadcastQuizResult("quizWinner", {
        username: username,
        totalPoints: points[username] || 0,
        correctAnswer: correctAnswer
      });
      
      setTimeout(() => {
        this._winnerProcessed = false;
      }, 5000);
      
    } catch(e) {
      console.error('[QUIZ] Error handling winner:', e);
      this._winnerProcessed = false;
    }
  }

  // ===== NEW: Room verification method =====
  _startRoomVerification() {
    setInterval(() => {
      try {
        if (this.closing || this.isDestroyed) return;
        
        for (const [wsId, ws] of this.wsMap) {
          if (!ws || ws.readyState !== 1) continue;
          
          const clientRoom = this.clientRooms.get(wsId);
          const wsRoom = ws.room || ws.roomname;
          const username = ws.username;
          const connRoom = username ? this.userConnections.get(username)?.room : null;
          
          if (clientRoom !== wsRoom || (connRoom && clientRoom !== connRoom)) {
            console.log(`[VERIFY] Fixing inconsistency for ${wsId}:`);
            console.log(`  clientRooms: ${clientRoom}, ws.room: ${wsRoom}, conn.room: ${connRoom}`);
            
            if (clientRoom) {
              ws.room = clientRoom;
              ws.roomname = clientRoom;
              if (username) {
                const conn = this.userConnections.get(username);
                if (conn) conn.room = clientRoom;
              }
              if (!this.wsClients.has(clientRoom)) this.wsClients.set(clientRoom, new Set());
              if (!this.wsClients.get(clientRoom).has(wsId)) {
                this.wsClients.get(clientRoom).add(wsId);
              }
            }
          }
        }
      } catch(e) {
        console.error('[VERIFY] Error:', e);
      }
    }, 30000);
  }

  // ===== FIXED: ensureRoomConsistency with full sync =====
  _ensureRoomConsistency(ws) {
    try {
      if (!ws) return null;
      const wsId = this._getWsId(ws);
      if (!wsId) return null;
      
      let room = this.clientRooms.get(wsId);
      if (!room) room = ws.room || ws.roomname || null;
      if (!room && ws.username) {
        const conn = this.userConnections.get(ws.username);
        if (conn) room = conn.room;
      }
      if (!room) return null;
      
      ws.room = room;
      ws.roomname = room;
      
      if (!this.clientRooms.has(wsId) || this.clientRooms.get(wsId) !== room) {
        this.clientRooms.set(wsId, room);
      }
      
      if (!this.wsClients.has(room)) this.wsClients.set(room, new Set());
      if (!this.wsClients.get(room).has(wsId)) {
        this.wsClients.get(room).add(wsId);
        this.wsMap.set(wsId, ws);
      }
      
      if (ws.username) {
        const conn = this.userConnections.get(ws.username);
        if (conn && conn.room !== room) {
          conn.room = room;
          conn.wsId = wsId;
          conn.ws = ws;
          this.userConnections.set(ws.username, conn);
        } else if (!conn) {
          this.userConnections.set(ws.username, { wsId, ws, room, timestamp: Date.now() });
        }
      }
      
      this._verifyRoomConsistency(wsId, room);
      return room;
    } catch(e) { 
      console.error('_ensureRoomConsistency error:', e);
      return null; 
    }
  }

  // ===== NEW: Verify room consistency =====
  _verifyRoomConsistency(wsId, expectedRoom) {
    try {
      const room1 = this.clientRooms.get(wsId);
      const ws = this.wsMap.get(wsId);
      const room2 = ws?.room || ws?.roomname;
      const conn = ws?.username ? this.userConnections.get(ws.username) : null;
      const room3 = conn?.room;
      
      if (room1 !== expectedRoom || room2 !== expectedRoom || room3 !== expectedRoom) {
        console.warn(`[VERIFY] Inconsistency detected for ${wsId}:`);
        console.warn(`  clientRooms: ${room1}, expected: ${expectedRoom}`);
        console.warn(`  ws.room: ${room2}, expected: ${expectedRoom}`);
        console.warn(`  userConnections: ${room3}, expected: ${expectedRoom}`);
        
        this.clientRooms.set(wsId, expectedRoom);
        if (ws) { ws.room = expectedRoom; ws.roomname = expectedRoom; }
        if (conn) conn.room = expectedRoom;
      }
    } catch(e) {}
  }

  // ===== FIXED: Atomic switchRoom =====
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
      
      const lockKey = `switch_${wsId}`;
      if (this._switchLocks.has(lockKey)) { 
        this._safeSend(ws, ["gameLowCardError", "Switch in progress"]); 
        return; 
      }
      
      this._switchLocks.set(lockKey, Date.now());
      
      try {
        ws._switching = true;
        const oldRoom = this.clientRooms.get(wsId);
        
        if (oldRoom === roomName) {
          ws.room = roomName;
          ws.roomname = roomName;
          this._ensureRoomConsistency(ws);
          this._safeSend(ws, ["switchRoomSuccess", roomName]);
          
          if (roomName === QUIZ_ROOM) {
            this._handleQuizRoomSwitch(ws, wsId, username);
          }
          return;
        }
        
        // ATOMIC SWITCH: Add to new room first, then remove from old
        this._addClient(roomName, ws, username, false);
        
        ws.room = roomName;
        ws.roomname = roomName;
        ws.username = username;
        this.clientRooms.set(wsId, roomName);
        
        if (username) {
          let conn = this.userConnections.get(username);
          if (conn) {
            conn.room = roomName;
            conn.wsId = wsId;
            conn.ws = ws;
            conn.timestamp = Date.now();
          } else {
            this.userConnections.set(username, { wsId, ws, room: roomName, timestamp: Date.now() });
          }
        }
        
        if (oldRoom && oldRoom !== roomName) {
          this._removeClientFromRoom(oldRoom, wsId);
        }
        
        this._verifyRoomConsistency(wsId, roomName);
        
        this._safeSend(ws, ["switchRoomSuccess", roomName]);
        
        if (roomName === QUIZ_ROOM) {
          this._handleQuizRoomSwitch(ws, wsId, username);
        }
        
        this._broadcastToRoom(roomName, ["userJoinedRoom", username, roomName]);
        
        if (oldRoom && oldRoom !== roomName) {
          this._broadcastToRoom(oldRoom, ["userLeftRoom", username, oldRoom]);
        }
        
      } finally {
        setTimeout(() => {
          ws._switching = false;
          this._switchLocks.delete(lockKey);
        }, 100);
      }
    } catch(e) {
      console.error('[SWITCH] Error:', e);
      this._safeSend(ws, ["gameLowCardError", "Switch failed"]);
      const wsId = this._getWsId(ws);
      if (wsId) this._switchLocks.delete(`switch_${wsId}`);
    }
  }

  // ===== NEW: Handle quiz room switch =====
  _handleQuizRoomSwitch(ws, wsId, username) {
    try {
      this._quizTimeLeftNotified.delete(wsId);
      this._nextQuizNotified.delete(wsId);
      
      let country = this.userCountry.get(wsId);
      if (!country) { 
        const cf = ws._cf || {}; 
        country = cf.country || 'US'; 
        this.userCountry.set(wsId, country); 
      }
      this._setUserLanguage(ws, country);
      
      if (!this._questionsCache.loaded) {
        this._loadAllQuestionsToMemory();
      }
      
      if (this._isQuizTime()) { 
        if (!this.quizAutoEnabled) this.quizAutoEnabled = true; 
        this.forceStartQuiz(); 
      }
      
      setTimeout(() => { 
        if (!this.closing && !this.isDestroyed) {
          const currentRoom = this.clientRooms.get(wsId);
          if (currentRoom === QUIZ_ROOM) {
            this._sendQuizTimeLeftToUser(ws);
            this._sendQuizNotification(ws, "quizStatus", {
              isQuizTime: this._isQuizTime(),
              isActive: !!this.currentQuestion,
              remainingTime: `${this._getQuestionRemainingTime()}s remaining`,
              hasWinner: this.quizHasWinner,
              winner: this.quizWinner,
              correctAnswer: this.currentQuestion?.correct || null,
              questionNumber: this._questionPointer,
              totalQuestions: this._allQuestions.length
            });
          }
        }
      }, CONSTANTS.QUIZ_SWITCH_DELAY_MS);
    } catch(e) {
      console.error('[QUIZ SWITCH] Error:', e);
    }
  }

  // ===== FIXED: submitQuizAnswer with auto-fix =====
  async submitQuizAnswer(ws, username, answer) {
    try {
      if (!ws || !username) {
        this._sendQuizErrorWithTime(ws, "ERROR", "Invalid request");
        return;
      }
      
      const wsId = this._getWsId(ws);
      
      let room = this._ensureRoomConsistency(ws);
      
      // AUTO-FIX: If user should be in Quiz room but isn't, fix it
      if (room !== QUIZ_ROOM) {
        if (ws.username) {
          const conn = this.userConnections.get(ws.username);
          if (conn && conn.room === QUIZ_ROOM) {
            this.clientRooms.set(wsId, QUIZ_ROOM);
            ws.room = QUIZ_ROOM;
            ws.roomname = QUIZ_ROOM;
            if (!this.wsClients.has(QUIZ_ROOM)) this.wsClients.set(QUIZ_ROOM, new Set());
            this.wsClients.get(QUIZ_ROOM).add(wsId);
            room = QUIZ_ROOM;
            console.log(`[QUIZ] Auto-fixed room for ${username} to Quiz`);
          } else {
            this._safeSend(ws, ["quizError", "Quiz only available in Quiz room"]);
            return;
          }
        } else {
          this._safeSend(ws, ["quizError", "Quiz only available in Quiz room"]);
          return;
        }
      }
      
      if (!this._isQuizTime()) {
        this._sendQuizErrorWithTime(ws, "NOT_QUIZ_TIME");
        return;
      }
      
      if (!this.quizAutoEnabled) {
        this._sendQuizErrorWithTime(ws, "QUIZ_DISABLED");
        return;
      }
      
      const clients = this.wsClients.get(QUIZ_ROOM);
      if (!clients?.size) {
        this._sendQuizErrorWithTime(ws, "ERROR", "Quiz is paused");
        return;
      }
      
      if (!this.currentQuestion) {
        this._startQuizIfNeeded();
        if (!this.currentQuestion) {
          this._sendQuizErrorWithTime(ws, "QUIZ_NOT_STARTED");
          return;
        }
      }
      
      const remaining = this._getQuestionRemainingTime();
      if (remaining <= 0) {
        if (this.quizHasWinner && this.quizWinner) {
          this._safeSend(ws, ["quizError", "Time is up! Winner: " + this.quizWinner]);
        } else {
          this._safeSend(ws, ["quizError", "Time is up!"]);
        }
        return;
      }
      
      if (this.quizHasWinner) {
        this._safeSend(ws, ["quizError", "Someone already answered correctly!"]);
        return;
      }
      
      if (this.quizAnswered.has(username)) {
        this._safeSend(ws, ["quizError", "You already answered!"]);
        return;
      }
      
      const answerKey = answer ? answer.toUpperCase().trim() : '';
      const isValidAnswer = ['A', 'B', 'C', 'D'].includes(answerKey);
      const isCorrect = isValidAnswer && (answerKey === this.currentQuestion.correct);
      const remainingText = `${remaining}s remaining`;
      const wsId2 = this._getWsId(ws);
      const countryInfo = this.countryQuizSystem.getUserCountryInfo(wsId2);
      
      this._broadcastQuizNotification("quizAnswer", {
        username: username,
        answer: isValidAnswer ? answerKey : "?",
        isCorrect: isCorrect,
        remainingTime: remainingText,
        country: countryInfo.countryCode,
        countryName: countryInfo.countryName
      });
      
      this._broadcastQuizResult("quizAnswerResult", {
        username,
        answer: isValidAnswer ? answerKey : "?",
        isCorrect,
        correctAnswer: this.currentQuestion.correct,
        remainingTime: remainingText,
        country: countryInfo.countryCode,
        countryName: countryInfo.countryName
      });
      
      this.quizAnswered.add(username);
      
      if (isCorrect && !this.quizHasWinner) {
        this.quizHasWinner = true;
        this.quizWinner = username;
        this._broadcastQuizNotification("quizWinnerWithCountry", {
          username: username,
          country: countryInfo.countryCode,
          countryName: countryInfo.countryName
        });
      }
      
    } catch(e) {
      this._safeSend(ws, ["quizError", e.message]);
    }
  }

  // ===== FIXED: _addClient with full sync =====
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
      
      if (username && isNewConnection) {
        this.userConnections.set(username, { wsId, ws, room, timestamp: Date.now() });
      } else if (username) {
        const conn = this.userConnections.get(username);
        if (conn) {
          conn.room = room;
          conn.wsId = wsId;
          conn.ws = ws;
          conn.timestamp = Date.now();
        } else {
          this.userConnections.set(username, { wsId, ws, room, timestamp: Date.now() });
        }
      }
      
      if (!this.wsClients.has(room)) {
        this.wsClients.set(room, new Set());
      }
      this.wsClients.get(room).add(wsId);
      this.clientRooms.set(wsId, room);
      this.wsMap.set(wsId, ws);
      
      ws.room = room;
      ws.roomname = room;
      ws.username = username;
      
      if (username) {
        if (!this.roomViewers.has(room)) this.roomViewers.set(room, new Set());
        this.roomViewers.get(room).add(username);
      }
      
      this._verifyRoomConsistency(wsId, room);
      
    } catch(e) {
      console.error('[ADD CLIENT] Error:', e);
    }
  }

  // ===== FIXED: _removeClient with cleanup =====
  _removeClient(room, ws) {
    try {
      if (!ws) return;
      const wsId = this._getWsId(ws);
      if (!wsId) return;
      
      const username = ws.username;
      
      this._quizTimeLeftNotified.delete(wsId);
      this._nextQuizNotified.delete(wsId);
      
      this._removeClientFromRoom(room, wsId);
      this.clientRooms.delete(wsId);
      this.wsMap.delete(wsId);
      this.userLanguage.delete(wsId);
      this.userCountry.delete(wsId);
      
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
      ws._switching = false;
    } catch(e) {}
  }

  // ===== FIXED: _removeClientFromRoom =====
  _removeClientFromRoom(room, wsId) {
    try {
      if (!room || !wsId) return;
      const clients = this.wsClients.get(room);
      if (clients) {
        clients.delete(wsId);
        if (clients.size === 0) this.wsClients.delete(room);
      }
    } catch(e) {}
  }

  // ===== FIXED: _cleanupDeadConnections with switching protection =====
  _cleanupDeadConnections() {
    try {
      const toRemove = [];
      for (const [wsId, ws] of this.wsMap) {
        if (ws && ws._switching) continue;
        if (!ws || ws.readyState !== 1 || ws._closing) toRemove.push(wsId);
      }
      for (const wsId of toRemove) {
        const ws = this.wsMap.get(wsId);
        if (ws) {
          const room = this.clientRooms.get(wsId);
          if (room) this._removeClientFromRoom(room, wsId);
          this.clientRooms.delete(wsId);
          this.wsMap.delete(wsId);
          this.userLanguage.delete(wsId);
          this.userCountry.delete(wsId);
          this._quizTimeLeftNotified.delete(wsId);
          this._nextQuizNotified.delete(wsId);
          for (const [username, conn] of this.userConnections) {
            if (conn?.wsId === wsId) { this.userConnections.delete(username); break; }
          }
        }
      }
    } catch(e) {}
  }

  // ===== FIXED: _showQuestion with winner flag reset =====
  async _showQuestion() {
    try {
      if (this._isShowingQuestion) return;
      this._lastActivityTime = Date.now();
      this._isQuizIdle = false;
      
      if (!this._isQuizTime()) {
        const clients = this.wsClients.get(QUIZ_ROOM);
        if (clients?.size > 0) {
          if (!this.quizEndNotified) {
            this._sendQuizEndNotificationOnce();
          }
        }
        return;
      }
      
      if (!this.quizAutoEnabled) {
        this.quizAutoEnabled = true;
        const clients = this.wsClients.get(QUIZ_ROOM);
        if (clients?.size > 0) this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", "Quiz will start soon!", true]);
        return;
      }
      
      if (this.isDestroyed || this.isQuizWaiting || this._quizStartTimeout || this.currentQuestion) return;
      
      this._isShowingQuestion = true;
      
      try {
        const enQuestions = this._getQuestionsFromMemory('en');
        if (!enQuestions || enQuestions.length === 0) {
          await this._loadAllQuestionsToMemory();
          const retryQuestions = this._getQuestionsFromMemory('en');
          if (!retryQuestions || retryQuestions.length === 0) {
            this._broadcastToRoom(QUIZ_ROOM, ["quizError", "No questions available!"]);
            this._isShowingQuestion = false;
            return;
          }
        }
        
        const questions = this._getQuestionsFromMemory('en');
        const randomIndex = Math.floor(Math.random() * questions.length);
        const q = questions[randomIndex];
        
        if (!q) {
          this._isShowingQuestion = false;
          setTimeout(() => {
            if (!this.closing && !this.isDestroyed) {
              this._showQuestion();
            }
          }, 1000);
          return;
        }
        
        this._globalQuestionIndex = randomIndex;
        this._questionPointer = randomIndex + 1;
        const shuffled = this._shuffleQuestionOptions(q);
        this.currentQuestion = { ...q, options: shuffled.options, correct: shuffled.correct };
        this._quizStartTime = Date.now();
        this.quizAnswered = new Set();
        this.quizHasWinner = false;
        this.quizWinner = null;
        this._winnerProcessed = false;
        
        this._totalQuestionsAnswered++;
        
        await this._broadcastQuizQuestion(this.currentQuestion.question, this.currentQuestion.options);
        
        const remainingTime = CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000;
        this._broadcastQuizNotification("quizUpdate", {
          questionNumber: this._questionPointer,
          totalQuestions: this._allQuestions.length,
          hasWinner: false,
          remainingTime: `${remainingTime}s remaining`
        });
        
        this._broadcastToRoom(QUIZ_ROOM, [
          "quizTimeLeft",
          `${remainingTime}s remaining`,
          false
        ]);
        
        if (this._quizTimeout) clearTimeout(this._quizTimeout);
        if (this._quizBreakTimeout) clearTimeout(this._quizBreakTimeout);
        
        this._quizTimeout = setTimeout(async () => {
          try {
            if (this.closing || this.isDestroyed) { 
              this._quizTimeout = null; 
              this._isShowingQuestion = false;
              return; 
            }
            
            const currentClients = this.wsClients.get(QUIZ_ROOM);
            if (!currentClients?.size) { 
              this._quizTimeout = null; 
              this.currentQuestion = null;
              this._isShowingQuestion = false;
              return; 
            }
            
            const correctAnswer = this.currentQuestion.correct;
            
            if (this.quizHasWinner && this.quizWinner) {
              await this._handleQuizWinner(this.quizWinner, correctAnswer);
            }
            
            this._quizTimeout = null;
            this.isQuizWaiting = true;
            this._isShowingQuestion = false;
            
            this._quizBreakTimeout = setTimeout(() => {
              if (this.closing || this.isDestroyed) { 
                this._quizBreakTimeout = null; 
                return; 
              }
              this.isQuizWaiting = false;
              this._quizBreakTimeout = null;
              this.currentQuestion = null;
            }, CONSTANTS.QUIZ_BREAK_MS);
            
          } catch(e) {
            this._quizTimeout = null;
            this.currentQuestion = null;
            this.isQuizWaiting = false;
            this._isShowingQuestion = false;
          }
        }, CONSTANTS.QUIZ_TIME_LIMIT_MS);
        
      } catch(e) {
        this._isShowingQuestion = false;
        this.currentQuestion = null;
        this.isQuizWaiting = false;
        this._quizTimeout = null;
      }
    } catch(e) {
      this._isShowingQuestion = false;
      this.currentQuestion = null;
      this.isQuizWaiting = false;
      this._quizTimeout = null;
    }
  }

  // ===== FIXED: _forceEvaluateQuiz =====
  async _forceEvaluateQuiz() {
    try {
      if (!this.currentQuestion || this._quizTimeout) return;
      
      const currentClients = this.wsClients.get(QUIZ_ROOM);
      if (!currentClients?.size) { 
        this.currentQuestion = null;
        this._isShowingQuestion = false;
        return; 
      }
      
      const correctAnswer = this.currentQuestion.correct;
      
      if (this.quizHasWinner && this.quizWinner) {
        await this._handleQuizWinner(this.quizWinner, correctAnswer);
      }
      
      this.currentQuestion = null;
      this.isQuizWaiting = true;
      this._isShowingQuestion = false;
      
      this._quizBreakTimeout = setTimeout(() => {
        if (this.closing || this.isDestroyed) { 
          this._quizBreakTimeout = null; 
          return; 
        }
        this.isQuizWaiting = false;
        this._quizBreakTimeout = null;
      }, CONSTANTS.QUIZ_BREAK_MS);
      
    } catch(e) {
      this.currentQuestion = null;
      this.isQuizWaiting = false;
      this._isShowingQuestion = false;
    }
  }

  // ===== FIXED: resetQuiz =====
  async resetQuiz() {
    try {
      if (this._quizTimeout) clearTimeout(this._quizTimeout);
      if (this._quizBreakTimeout) clearTimeout(this._quizBreakTimeout);
      if (this._quizStartTimeout) clearTimeout(this._quizStartTimeout);
      if (this._quizKeepAliveInterval) clearInterval(this._quizKeepAliveInterval);
      this.currentQuestion = null;
      this.isQuizWaiting = false;
      this.quizHasWinner = false;
      this.quizWinner = null;
      this.quizAnswered = new Set();
      this._quizStartTime = null;
      this.quizEndNotified = false;
      this._isShowingQuestion = false;
      this._winnerProcessed = false;
      
      this._quizTimeLeftNotified.clear();
      this._nextQuizNotified.clear();
      this._startQuizKeepAlive();
    } catch(e) {}
  }

  // ===== FIXED: _clearQuizData =====
  _clearQuizData() {
    try {
      this.currentQuestion = null;
      this._quizStartTime = null;
      this.quizAnswered = new Set();
      this.quizHasWinner = false;
      this.quizWinner = null;
      this.isQuizWaiting = false;
      this._isShowingQuestion = false;
      this._winnerProcessed = false;
      
      if (this._quizTimeout) {
        clearTimeout(this._quizTimeout);
        this._quizTimeout = null;
      }
      if (this._quizBreakTimeout) {
        clearTimeout(this._quizBreakTimeout);
        this._quizBreakTimeout = null;
      }
      if (this._quizStartTimeout) {
        clearTimeout(this._quizStartTimeout);
        this._quizStartTimeout = null;
      }
      this.quizQuestionCache = {};
      this._questionPointer = 0;
      this._totalQuestionsAnswered = 0;
      this._broadcastToRoom(QUIZ_ROOM, ["quizClear", {
        message: "Quiz has ended. Come back tomorrow!",
        timestamp: Date.now()
      }]);
      this._broadcastQuizNotification("quizCleared", {
        message: "Quiz has ended. Come back tomorrow!",
        clearUI: true
      });
    } catch(e) {}
  }

  // ===== FIXED: _sendQuizEndNotificationOnce with English =====
  _sendQuizEndNotificationOnce() {
    try {
      if (this.quizEndNotified) return;
      const timeLeft = this._getTimeLeftUntilNextQuiz();
      const message = `${timeLeft.text}`;
      this._broadcastToRoom(QUIZ_ROOM, ["quizEnded", { 
        timeLeft: timeLeft.text, 
        status: "ended"
      }]);
      this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", message, true]);
      this._broadcastQuizNotification("quizEnded", { 
        timeLeft: timeLeft.text
      });
      this.quizEndNotified = true;
    } catch(e) {}
  }

  // ===== FIXED: _sendQuizErrorWithTime with English =====
  _sendQuizErrorWithTime(ws, errorType, customMessage = null) {
    try {
      if (!ws || ws.readyState !== 1) return false;
      const timeLeft = this._getTimeLeftUntilNextQuiz();
      let message = "";
      switch(errorType) {
        case "NOT_QUIZ_TIME":
          message = `Next quiz in ${timeLeft.text}`;
          break;
        case "QUIZ_DISABLED": 
          message = `Next quiz in ${timeLeft.text}`; 
          break;
        case "QUIZ_ENDED":
          message = `Next quiz in ${timeLeft.text}`;
          break;
        case "QUIZ_NOT_STARTED": 
          message = `Next quiz in ${timeLeft.text}`; 
          break;
        default: 
          message = customMessage || `Next quiz in ${timeLeft.text}`;
      }
      this._safeSend(ws, ["quizError", message]);
      return true;
    } catch(e) { return false; }
  }

  // ===== FIXED: _sendQuizTimeLeftToUser with English =====
  _sendQuizTimeLeftToUser(ws) {
    try {
      if (!ws || ws.readyState !== 1) return false;
      const wsId = this._getWsId(ws);
      if (!wsId) return false;
      if (this._quizTimeLeftNotified.has(wsId)) {
        return false;
      }
      if (this._nextQuizNotified.has(wsId)) {
        return false;
      }
      const timeInfo = this._getTimeLeftUntilNextEvent();
      const timeLeft = this._getTimeLeftUntilNextQuiz();
      let message = "", canType = true, isQuizTime = timeInfo.isRunning;
      if (isQuizTime) {
        if (this.currentQuestion && this._quizStartTime) {
          const elapsed = (Date.now() - this._quizStartTime) / 1000;
          const left = Math.max(0, (CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000) - elapsed);
          const minutes = Math.floor(left / 60), seconds = Math.floor(left % 60);
          message = minutes > 0 ? `${minutes}m ${seconds}s remaining` : `${seconds}s remaining`;
          canType = false;
        } else {
          message = `Quiz will start soon!`;
          canType = true;
        }
      } else {
        message = `Next quiz in ${timeLeft.text}`;
        canType = true;
      }
      this._safeSend(ws, ["quizTimeLeft", message, canType, isQuizTime]);
      this._quizTimeLeftNotified.set(wsId, Date.now());
      return true;
    } catch(e) { return false; }
  }

  // ===== FIXED: _broadcastQuizTimeLeft with English =====
  _broadcastQuizTimeLeft() {
    try {
      const wsIds = this.wsClients.get(QUIZ_ROOM);
      if (!wsIds?.size) return;
      const now = Date.now();
      if (now - this._lastQuizTimeLeftBroadcast < this._quizTimeLeftBroadcastCooldown) {
        return;
      }
      const timeInfo = this._getTimeLeftUntilNextEvent();
      const timeLeft = this._getTimeLeftUntilNextQuiz();
      let message = "", canType = true, isQuizTime = timeInfo.isRunning;
      if (isQuizTime) {
        if (this.currentQuestion && this._quizStartTime) {
          const elapsed = (Date.now() - this._quizStartTime) / 1000;
          const left = Math.max(0, (CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000) - elapsed);
          const minutes = Math.floor(left / 60), seconds = Math.floor(left % 60);
          message = minutes > 0 ? `${minutes}m ${seconds}s remaining` : `${seconds}s remaining`;
          canType = false;
        } else {
          message = `Quiz will start soon!`;
          canType = true;
        }
      } else {
        message = `Next quiz in ${timeLeft.text}`;
        canType = true;
      }
      const wsIdArray = Array.from(wsIds);
      let hasUnnotified = false;
      for (const wsId of wsIdArray) {
        if (!this._quizTimeLeftNotified.has(wsId) && !this._nextQuizNotified.has(wsId)) {
          hasUnnotified = true;
          break;
        }
      }
      if (!hasUnnotified) return;
      const msgStr = JSON.stringify(["quizTimeLeft", message, canType, isQuizTime]);
      for (const wsId of wsIdArray) {
        if (!this._quizTimeLeftNotified.has(wsId) && !this._nextQuizNotified.has(wsId)) {
          try {
            const ws = this.wsMap.get(wsId);
            if (ws && ws.readyState === 1) {
              ws.send(msgStr);
              this._quizTimeLeftNotified.set(wsId, now);
              if (!isQuizTime) {
                this._nextQuizNotified.set(wsId, now);
              }
            }
          } catch(e) {}
        }
      }
      this._lastQuizTimeLeftBroadcast = now;
    } catch(e) {}
  }

  // ===== FIXED: checkGameRunning =====
  async checkGameRunning(ws, roomname) {
    try {
      if (this.isDestroyed) { 
        this._safeSend(ws, ["gameStatus", { running: "false" }]); 
        return; 
      }
      let room = roomname;
      if (!room) room = this._ensureRoomConsistency(ws);
      if (!room) { 
        this._safeSend(ws, ["gameStatus", { running: "false" }]); 
        return; 
      }
      const game = this.activeGames.get(room);
      const isRunning = game?._isActive && !game._gameEnded && game.players?.size > 0;
      this._safeSend(ws, ["gameStatus", { running: isRunning ? "true" : "false" }]);
    } catch(e) {
      this._safeSend(ws, ["gameStatus", { running: "false" }]);
    }
  }

  // ===== NEW: getWsId method =====
  _getWsId(ws) { 
    return ws?._wsId || null; 
  }

  // ===== NEW: getRoomForWs method =====
  _getRoomForWs(ws) {
    if (!ws) return null;
    return ws.room || ws.roomname || null;
  }

  // ===== FIXED: _forceCleanupGame =====
  async _forceCleanupGame(room, game) {
    try {
      if (!game) return;
      const timers = ['_registrationTimer', '_drawTimer', '_evalTimer', '_safetyTimer'];
      for (const key of timers) {
        if (game[key]) { clearTimeout(game[key]); clearInterval(game[key]); game[key] = null; }
      }
      if (game._botTimeouts) { for (const id of game._botTimeouts) clearTimeout(id); game._botTimeouts.clear(); }
      game._gameEnded = true;
      game._isActive = false;
      game._endTime = Date.now();
      this._broadcastToRoom(room, ["gameLowCardEnd", []]);
      this.activeGames.delete(room);
      if (this._cleanupTimers.has(room)) { clearTimeout(this._cleanupTimers.get(room)); this._cleanupTimers.delete(room); }
      this._gameLocks.delete(room);
      this._joinLocks.delete(room);
      this._gameStartFlags.delete(`start_${room}`);
    } catch(e) {}
  }

  // ===== FIXED: _deleteGame =====
  _deleteGame(room, game) {
    try {
      if (!room || !game) return;
      if (game?._isActive && !game._gameEnded) return;
      if (this._cleanupTimers.has(room)) { clearTimeout(this._cleanupTimers.get(room)); this._cleanupTimers.delete(room); }
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

  // ===== FIXED: _cleanupGame =====
  _cleanupGame(game) {
    try {
      if (!game) return;
      if (game._isActive && !game._gameEnded) return;
      const timers = ['_registrationTimer', '_drawTimer', '_evalTimer', '_safetyTimer'];
      for (const key of timers) {
        if (game[key]) { clearTimeout(game[key]); clearInterval(game[key]); game[key] = null; }
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

  // ===== FIXED: _scheduleGameCleanup =====
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

  // ===== All other game methods remain the same =====
  // ... (keep all other methods from original file)

  // ===== FETCH HANDLER =====
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
            quizActive: !!this.currentQuestion,
            gamesRunning: this.activeGames.size,
            wsConnections: this.wsMap.size,
            eventQueueSize: this._eventQueue?.length || 0,
            errorCount: this._errorCount,
            timestamp: Date.now(),
            quizSchedule: QUIZ_SCHEDULE.SESSIONS.map(s => `${s.start}:00-${s.end}:00`),
            currentWITATime: this._getCurrentWITATime().formatted,
            questionsLoaded: this._questionsCache.loaded,
            questionsCount: {
              en: this._questionsCache.en?.length || 0,
              id: this._questionsCache.id?.length || 0,
              fil: this._questionsCache.fil?.length || 0,
              hi: this._questionsCache.hi?.length || 0,
              ar: this._questionsCache.ar?.length || 0
            }
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
        if (upgrade !== "websocket") return new Response("WebSocket only", { status: 400 });
        if (this.wsMap.size >= CONSTANTS.MAX_WS_CLIENTS) return new Response("Server at maximum capacity", { status: 503 });
        try {
          const pair = new WebSocketPair();
          const [client, server] = [pair[0], pair[1]];
          const wsId = ++this._wsIdCounter;
          server._wsId = wsId;
          server._closing = false;
          server._switching = false;
          server.room = null;
          server.roomname = null;
          server._createdAt = Date.now();
          server.username = null;
          const cf = req.cf || {};
          const country = cf?.country || 'US';
          const info = COUNTRY_LANGUAGE_MAP[country];
          const lang = info?.lang || 'en';
          this.userCountry.set(wsId, country);
          this.userLanguage.set(wsId, lang);
          this.countryQuizSystem.userCountryCache.set(wsId, country);
          server._cf = cf;
          server._country = country;
          server._language = lang;
          
          try { this.state.acceptWebSocket(server); } catch(e) { 
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
            try {
              if (server.room || server.roomname) {
                const room = server.room || server.roomname;
                const wsId2 = this._getWsId(server);
                const username = server.username;
                this._removeClient(room, server);
                this.userLanguage.delete(wsId2);
                this.userCountry.delete(wsId2);
                this.countryQuizSystem.userCountryCache.delete(wsId2);
                this._quizTimeLeftNotified.delete(wsId2);
                this._nextQuizNotified.delete(wsId2);
                if (username) {
                  const conn = this.userConnections.get(username);
                  if (conn?.wsId === wsId2) this.userConnections.delete(username);
                }
              }
              const clients = this.wsClients.get(QUIZ_ROOM);
              if (clients?.size > 0) this.ensureQuizRunning();
            } catch(e) {}
          });
          
          server.addEventListener("error", () => {
            try {
              if (server.room || server.roomname) {
                const room = server.room || server.roomname;
                const wsId2 = this._getWsId(server);
                const username = server.username;
                this._removeClient(room, server);
                this.userLanguage.delete(wsId2);
                this.userCountry.delete(wsId2);
                this.countryQuizSystem.userCountryCache.delete(wsId2);
                this._quizTimeLeftNotified.delete(wsId2);
                this._nextQuizNotified.delete(wsId2);
                if (username) {
                  const conn = this.userConnections.get(username);
                  if (conn?.wsId === wsId2) this.userConnections.delete(username);
                }
              }
            } catch(e) {}
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

  async webSocketClose(ws) {
    try {
      if (!ws) return;
      const wsId = this._getWsId(ws);
      const username = ws.username;
      if (ws.room || ws.roomname) {
        const room = ws.room || ws.roomname;
        this._removeClient(room, ws);
      }
      this.userLanguage.delete(wsId);
      this.userCountry.delete(wsId);
      this.countryQuizSystem.userCountryCache.delete(wsId);
      this._quizTimeLeftNotified.delete(wsId);
      this._nextQuizNotified.delete(wsId);
      if (username) {
        const conn = this.userConnections.get(username);
        if (conn?.wsId === wsId) this.userConnections.delete(username);
      }
      if (wsId) { this.clientRooms.delete(wsId); this.wsMap.delete(wsId); }
      ws.room = null;
      ws.roomname = null;
      ws._wsId = null;
      ws.username = null;
      ws._switching = false;
      const clients = this.wsClients.get(QUIZ_ROOM);
      if (clients?.size > 0) this.ensureQuizRunning();
    } catch(e) {}
  }

  async webSocketError(ws) {
    try {
      if (!ws) return;
      const wsId = this._getWsId(ws);
      const username = ws.username;
      if (ws.room || ws.roomname) {
        const room = ws.room || ws.roomname;
        this._removeClient(room, ws);
      }
      this.userLanguage.delete(wsId);
      this.userCountry.delete(wsId);
      this.countryQuizSystem.userCountryCache.delete(wsId);
      this._quizTimeLeftNotified.delete(wsId);
      this._nextQuizNotified.delete(wsId);
      if (username) {
        const conn = this.userConnections.get(username);
        if (conn?.wsId === wsId) this.userConnections.delete(username);
      }
      if (wsId) { this.clientRooms.delete(wsId); this.wsMap.delete(wsId); }
      ws.room = null;
      ws.roomname = null;
      ws._wsId = null;
      ws.username = null;
      ws._switching = false;
    } catch(e) {}
  }
}
