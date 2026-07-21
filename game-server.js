// ==================== GAME-SERVER.JS (QUIZ MALAM 18:00-23:00 WIB) ====================

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
  TRANSLATE_LIMIT: 999999,
  QUIZ_BREAK_MS: 2000,
  QUIZ_START_DELAY_MS: 5000,
  MAX_RETRY_INIT_QUIZ: 2,
  MAX_BROADCAST_BATCH: 3,
  MAX_SHUTDOWN_WAIT_MS: 5000,
  MAX_WS_CLIENTS: 50,
  MAX_ARRAY_SIZE: 50,
  CIRCUIT_BREAKER_THRESHOLD: 5,
  CIRCUIT_BREAKER_TIMEOUT_MS: 60000,
  QUIZ_SWITCH_DELAY_MS: 5000,
  QUIZ_POINT_KEY: 'quiz_points',
  QUIZ_WEEK_KEY: 'quiz_current_week',
  QUIZ_LAST_WEEK_WINNER: 'quiz_last_week_winner',
  SCHEDULER_INTERVAL_MS: 60000,
  QUIZ_BATCH_SIZE: 100,
  QUIZ_BATCH_THRESHOLD: 20,
  MAX_QUESTIONS: 10000,
  GAME_SCHEDULE: {
    START_HOUR: 0,
    END_HOUR: 23,
  },
  DEEPLX_API_URLS: [
    'https://api.deeplx.org/translate',
    'https://deeplx.vercel.app/translate',
    'https://deeplx.deno.dev/translate',
    'https://deeplx.mingming.dev/translate',
    'https://deeplx.azurewebsites.net/translate',
  ],
  DEEPLX_TIMEOUT_MS: 5000,
  DEEPLX_DELAY_MS: 200,
  DEEPLX_BATCH_SIZE: 5,
  DEEPLX_BATCH_DELAY_MS: 1000,
  DEEPLX_MAX_RETRIES: 3,
  CF_SUBREQUEST_LIMIT: 50,
  CF_CPU_TIME_LIMIT_MS: 9000,
  CF_MEMORY_LIMIT_MB: 128,
  MAX_PARALLEL_TRANSLATE: 10,
  TRANSLATE_TIMEOUT_MS: 3000,
  CACHE_TTL_MS: 3600000,
  MAX_CACHE_SIZE: 10000,
};

// ==================== QUIZ SCHEDULE - MALAM (18:00 - 23:00 WIB) ====================
// WIB = UTC+7, jadi:
// 18:00 WIB = 11:00 UTC
// 23:00 WIB = 16:00 UTC

const QUIZ_SCHEDULE = {
  EVENING: { start: 11, end: 16 }, // 11:00 - 16:00 UTC
};

const QUIZ_ROOM = "Quiz";

// ==================== TRANSLATION MANAGER CLASS ====================

class TranslationManager {
  constructor(gameServer) {
    this.gameServer = gameServer;
    this.cache = new Map();
    this.pendingRequests = new Map();
    this.MAX_CACHE_SIZE = CONSTANTS.MAX_CACHE_SIZE;
    this.CACHE_TTL = CONSTANTS.CACHE_TTL_MS;
    this.MAX_PARALLEL = CONSTANTS.MAX_PARALLEL_TRANSLATE;
    this.TRANSLATE_TIMEOUT = CONSTANTS.TRANSLATE_TIMEOUT_MS;
    this.translateCount = 0;
    this.translateDate = new Date().toUTCString();
    this.translateLimitReached = false;
    
    this._translationCircuitBreaker = {
      failures: 0,
      lastFailureTime: 0,
      isOpen: false,
      resetTimer: null
    };
  }

  async translateForUsers(question, options, usersByLang) {
    const startTime = Date.now();
    const results = new Map();
    
    console.log(`🌍 Translating for ${usersByLang.size} languages...`);
    
    const cacheHits = new Map();
    const needTranslate = [];
    
    for (const [lang, users] of usersByLang) {
      if (lang === 'en') {
        results.set(lang, { question, options, users, isFallback: false });
        continue;
      }
      
      const cacheKey = this._getCacheKey(question, options, lang);
      const cached = this._getCache(cacheKey);
      
      if (cached) {
        cacheHits.set(lang, { ...cached, users });
        results.set(lang, { ...cached, users, isFallback: false });
      } else {
        needTranslate.push({ lang, users });
      }
    }
    
    console.log(`📊 Cache: ${cacheHits.size} hit, ${needTranslate.length} miss`);
    
    if (needTranslate.length === 0) {
      this._sendResults(results);
      console.log(`✅ All cached! ${Date.now() - startTime}ms`);
      return;
    }
    
    const translatePromises = needTranslate.map(({ lang, users }) => 
      this._translateWithTimeout(question, options, lang, users)
    );
    
    const translatedResults = await this._executeWithConcurrencyLimit(
      translatePromises,
      this.MAX_PARALLEL
    );
    
    for (const result of translatedResults) {
      if (result.success) {
        const { lang, translatedQuestion, translatedOptions, users } = result;
        
        const cacheKey = this._getCacheKey(question, options, lang);
        this._setCache(cacheKey, {
          question: translatedQuestion,
          options: translatedOptions
        });
        
        results.set(lang, {
          question: translatedQuestion,
          options: translatedOptions,
          users,
          isFallback: false
        });
      } else {
        const { lang, users } = result;
        results.set(lang, {
          question: question,
          options: options,
          users,
          isFallback: true
        });
        console.log(`⚠️ Fallback to English for ${lang}`);
      }
    }
    
    this._sendResults(results);
    console.log(`✅ All done! ${Date.now() - startTime}ms`);
  }
  
  async _executeWithConcurrencyLimit(promiseFactories, limit) {
    const results = [];
    const executing = [];
    
    for (const promiseFactory of promiseFactories) {
      const p = promiseFactory().then(result => {
        executing.splice(executing.indexOf(p), 1);
        return result;
      });
      executing.push(p);
      results.push(p);
      
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
    
    return Promise.all(results);
  }
  
  async _translateWithTimeout(question, options, lang, users) {
    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Translate timeout')), this.TRANSLATE_TIMEOUT);
      });
      
      const translatePromise = (async () => {
        const [translatedQuestion, translatedOptions] = await Promise.all([
          this._translateText(question, lang),
          this._translateOptions(options, lang)
        ]);
        
        return {
          success: true,
          lang,
          users,
          translatedQuestion,
          translatedOptions
        };
      })();
      
      return await Promise.race([translatePromise, timeoutPromise]);
      
    } catch(e) {
      return {
        success: false,
        lang,
        users,
        error: e.message
      };
    }
  }
  
  async _translateText(text, targetLang, retryCount = 0) {
    if (targetLang === 'en') return text;
    if (!text || typeof text !== 'string') return text;
    if (this.translateLimitReached) return text;
    
    try {
      const pendingKey = `${text}|${targetLang}`;
      if (this.pendingRequests.has(pendingKey)) {
        return await this.pendingRequests.get(pendingKey);
      }
      
      const translatePromise = this._callTranslateAPI(text, targetLang);
      this.pendingRequests.set(pendingKey, translatePromise);
      
      const result = await translatePromise;
      this.pendingRequests.delete(pendingKey);
      this.translateCount++;
      
      return result;
      
    } catch(e) {
      if (retryCount < CONSTANTS.DEEPLX_MAX_RETRIES) {
        await this._delay(500 * (retryCount + 1));
        return this._translateText(text, targetLang, retryCount + 1);
      }
      return text;
    }
  }
  
  async _callTranslateAPI(text, targetLang) {
    if (this._translationCircuitBreaker.isOpen) {
      const now = Date.now();
      if (now - this._translationCircuitBreaker.lastFailureTime > CONSTANTS.CIRCUIT_BREAKER_TIMEOUT_MS) {
        this._translationCircuitBreaker.isOpen = false;
        this._translationCircuitBreaker.failures = 0;
      } else {
        throw new Error('Circuit breaker is open');
      }
    }
    
    const apiUrls = CONSTANTS.DEEPLX_API_URLS;
    let lastError = null;
    
    for (const apiUrl of apiUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONSTANTS.DEEPLX_TIMEOUT_MS);
        
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text,
            source_lang: 'EN',
            target_lang: targetLang.toUpperCase()
          }),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        const translated = data.data || data.text || data.result || data.translations?.[0]?.text;
        
        if (translated) {
          this._translationCircuitBreaker.failures = 0;
          return translated;
        }
        
        throw new Error('Invalid response');
        
      } catch(e) {
        lastError = e;
      }
    }
    
    this._translationCircuitBreaker.failures++;
    this._translationCircuitBreaker.lastFailureTime = Date.now();
    
    if (this._translationCircuitBreaker.failures >= CONSTANTS.CIRCUIT_BREAKER_THRESHOLD) {
      this._translationCircuitBreaker.isOpen = true;
      
      if (this._translationCircuitBreaker.resetTimer) {
        clearTimeout(this._translationCircuitBreaker.resetTimer);
      }
      this._translationCircuitBreaker.resetTimer = setTimeout(() => {
        this._translationCircuitBreaker.isOpen = false;
        this._translationCircuitBreaker.failures = 0;
        this._translationCircuitBreaker.resetTimer = null;
      }, CONSTANTS.CIRCUIT_BREAKER_TIMEOUT_MS);
    }
    
    throw lastError || new Error('All APIs failed');
  }
  
  async _translateOptions(options, targetLang) {
    if (targetLang === 'en' || !options) return options;
    
    const keys = ['A', 'B', 'C', 'D'];
    const texts = keys.map(k => options[k]).filter(t => t && typeof t === 'string');
    
    if (texts.length === 0) return options;
    
    const translatedTexts = await Promise.all(
      texts.map(text => this._translateText(text, targetLang))
    );
    
    const result = { ...options };
    let idx = 0;
    for (const key of keys) {
      if (options[key] && typeof options[key] === 'string') {
        result[key] = translatedTexts[idx++] || options[key];
      }
    }
    
    return result;
  }
  
  _getCacheKey(question, options, lang) {
    const optionStr = Object.values(options).join('|');
    return `${question}|${optionStr}|${lang}`;
  }
  
  _getCache(key) {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < this.CACHE_TTL) {
      return entry.value;
    }
    return null;
  }
  
  _setCache(key, value) {
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    
    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }
  
  _sendResults(results) {
    for (const [lang, data] of results) {
      const { question, options, users, isFallback } = data;
      
      const message = [
        "quizQuestion",
        {
          question: question || '',
          options: options || { A: '', B: '', C: '', D: '' },
          isFallback: isFallback || false
        }
      ];
      
      const msgStr = JSON.stringify(message);
      
      for (const ws of users) {
        if (ws && ws.readyState === 1) {
          try {
            ws.send(msgStr);
          } catch(e) {
            // Ignore
          }
        }
      }
    }
  }
  
  resetDailyCounter() {
    const now = new Date().toUTCString();
    if (now !== this.translateDate) {
      this.translateDate = now;
      this.translateCount = 0;
      this.translateLimitReached = false;
      
      this._translationCircuitBreaker.isOpen = false;
      this._translationCircuitBreaker.failures = 0;
      if (this._translationCircuitBreaker.resetTimer) {
        clearTimeout(this._translationCircuitBreaker.resetTimer);
        this._translationCircuitBreaker.resetTimer = null;
      }
    }
  }
  
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ==================== GAME SERVER CLASS ====================

export class GameServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.closing = false;
    this.isDestroyed = false;
    this._initialized = false;
    
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
    this.connectionLocks = new Map();
    this._cleanupTimers = new Map();
    this._roomBroadcastCount = new Map();
    this._roomBroadcastReset = new Map();
    this._tikCounter = 0;
    this._gameStartFlags = new Map();
    
    // QUIZ
    this.quizAnswered = new Set();
    this.quizHasWinner = false;
    this.quizWinner = null;
    this.quizTimer = null;
    this.isQuizRunning = false;
    this.currentQuestion = null;
    this.isQuizWaiting = false;
    this._quizStartTime = null;
    
    // ===== SISTEM RANDOM SOAL =====
    this._allQuestions = []; // Semua soal dari KV (1000 soal)
    this._isAllQuestionsLoaded = false;
    this._usedQuestionIndices = []; // Indeks soal yang sudah dipakai
    this._totalQuestionsAnswered = 0;
    this._currentQuestionIndex = -1;
    
    // DEEPLX TRANSLATION
    this.translateCount = 0;
    this.translateDate = new Date().toUTCString();
    this.translateLimitReached = false;
    this.userLanguage = new Map();
    this.userCountry = new Map();
    this._translationQueue = [];
    this._isProcessingQueue = false;
    
    // Translation Manager
    this.translationManager = new TranslationManager(this);
    
    // CF PROTECTION
    this._requestCount = 0;
    this._requestResetTime = Date.now() + 60000;
    this._cpuTimeUsed = 0;
    this._subRequestCount = 0;
    
    // TIMERS
    this._quizTimeout = null;
    this._translateResetInterval = null;
    this._quizBreakTimeout = null;
    this._quizStartTimeout = null;
    
    // CIRCUIT BREAKER
    this._translationCircuitBreaker = {
      failures: 0,
      lastFailureTime: 0,
      isOpen: false,
      resetTimer: null
    };
    
    this.quizAutoEnabled = false;
    this.quizAutoTimer = null;
    
    console.log('🚀 GameServer starting...');
    console.log(`🕐 Current UTC time: ${new Date().toUTCString()}`);
    console.log(`📅 Quiz Schedule: 18:00 - 23:00 WIB (${QUIZ_SCHEDULE.EVENING.start}:00 - ${QUIZ_SCHEDULE.EVENING.end}:00 UTC)`);
    console.log(`🎲 Quiz mode: RANDOM (no batch)`);
    
    this._initAsync();
    
    setTimeout(() => {
      console.log('⏰ Initial quiz check...');
      this.forceStartQuiz();
    }, 3000);
  }
  
  // ==================== ASYNC INIT ====================
  
  async _initAsync() {
    if (this._initialized) return;
    this._initialized = true;
    
    await this._initQuiz();
    this._startQuizScheduler();
    await this._checkAndResetWeeklyPoints();
    
    setTimeout(() => {
      this.ensureQuizRunning();
    }, 2000);
  }
  
  // ==================== CF PROTECTION METHODS ====================
  
  _checkCFLimits() {
    const now = Date.now();
    
    if (now > this._requestResetTime) {
      this._requestCount = 0;
      this._requestResetTime = now + 60000;
      this._subRequestCount = 0;
      this._cpuTimeUsed = 0;
    }
    
    if (this._subRequestCount > CONSTANTS.CF_SUBREQUEST_LIMIT) {
      return false;
    }
    
    return true;
  }
  
  _incrementSubRequest() {
    this._subRequestCount++;
    this._requestCount++;
  }
  
  _canTranslate() {
    if (!this._checkCFLimits()) {
      return false;
    }
    
    if (this.translateLimitReached) {
      return false;
    }
    
    if (this._translationCircuitBreaker.isOpen) {
      const now = Date.now();
      if (now - this._translationCircuitBreaker.lastFailureTime > CONSTANTS.CIRCUIT_BREAKER_TIMEOUT_MS) {
        this._translationCircuitBreaker.isOpen = false;
        this._translationCircuitBreaker.failures = 0;
      } else {
        return false;
      }
    }
    
    return true;
  }
  
  // ==================== UTC TIME HELPERS ====================
  
  _getCurrentUTCTime() {
    return new Date();
  }
  
  _getCurrentUTCHours() {
    return new Date().getUTCHours();
  }
  
  // ==================== GAME TIME CHECK ====================
  
  _isGameTime() {
    const hour = this._getCurrentUTCHours();
    const schedule = CONSTANTS.GAME_SCHEDULE || { START_HOUR: 0, END_HOUR: 23 };
    
    if (schedule.START_HOUR > schedule.END_HOUR) {
      return hour >= schedule.START_HOUR || hour < schedule.END_HOUR;
    }
    
    return hour >= schedule.START_HOUR && hour < schedule.END_HOUR;
  }
  
  _getGameType(room) {
    const isInGameTime = this._isGameTime();
    
    if (!isInGameTime) {
      return true;
    }
    
    return false;
  }
  
  // ==================== WEEKLY HELPERS ====================
  
  _getCurrentWeek() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const startOfYear = new Date(year, 0, 1);
    const diff = now - startOfYear;
    const week = Math.ceil((diff / 86400000 + startOfYear.getUTCDay() + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }
  
  async _getQuizPoints() {
    if (!this.env || !this.env.QUESTIONS) return {};
    try {
      const points = await this.env.QUESTIONS.get(CONSTANTS.QUIZ_POINT_KEY, 'json');
      return points || {};
    } catch(e) {
      return {};
    }
  }
  
  async _getLastWeekWinner() {
    if (!this.env || !this.env.QUESTIONS) return null;
    try {
      const winner = await this.env.QUESTIONS.get(CONSTANTS.QUIZ_LAST_WEEK_WINNER, 'json');
      return winner || null;
    } catch(e) {
      return null;
    }
  }
  
  async _checkAndResetWeeklyPoints() {
    if (!this.env || !this.env.QUESTIONS) return false;
    
    try {
      const currentWeek = this._getCurrentWeek();
      const savedWeek = await this.env.QUESTIONS.get(CONSTANTS.QUIZ_WEEK_KEY);
      
      if (savedWeek !== currentWeek) {
        const points = await this._getQuizPoints();
        
        let winner = null;
        let highestScore = 0;
        
        for (const [username, score] of Object.entries(points)) {
          if (score > highestScore) {
            highestScore = score;
            winner = username;
          }
        }
        
        if (winner) {
          const winnerData = {
            username: winner,
            score: highestScore,
            week: savedWeek || currentWeek
          };
          
          await this.env.QUESTIONS.put(
            CONSTANTS.QUIZ_LAST_WEEK_WINNER,
            JSON.stringify(winnerData)
          );
          
          this._broadcastToRoom(QUIZ_ROOM, [
            "quizLastWeekWinner",
            winner,
            highestScore,
            savedWeek || currentWeek
          ]);
        }
        
        await this.env.QUESTIONS.put(CONSTANTS.QUIZ_POINT_KEY, JSON.stringify({}));
        await this.env.QUESTIONS.put(CONSTANTS.QUIZ_WEEK_KEY, currentWeek);
        
        this._broadcastToRoom(QUIZ_ROOM, [
          "quizWeekReset",
          {
            week: currentWeek,
            message: "New quiz week started! Points reset."
          }
        ]);
        
        return true;
      }
      return false;
    } catch(e) {
      return false;
    }
  }
  
  // ==================== QUIZ SCHEDULE - MALAM (18:00 - 23:00 WIB) ====================
  
  _isQuizTime() {
    const hour = this._getCurrentUTCHours();
    
    const schedules = [
      QUIZ_SCHEDULE.EVENING,
    ];
    
    for (const schedule of schedules) {
      if (hour >= schedule.start && hour < schedule.end) {
        return true;
      }
    }
    return false;
  }
  
  _getNextQuizStartTime() {
    const now = this._getCurrentUTCTime();
    const schedules = [
      QUIZ_SCHEDULE.EVENING,
    ];
    
    for (const schedule of schedules) {
      const startTime = new Date(now);
      startTime.setUTCHours(schedule.start, 0, 0, 0);
      if (startTime > now) {
        return startTime;
      }
    }
    
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(QUIZ_SCHEDULE.EVENING.start, 0, 0, 0);
    return tomorrow;
  }
  
  _getTimeLeftUntilNextEvent() {
    const now = Date.now();
    const nextStart = this._getNextQuizStartTime();
    const timeLeft = nextStart.getTime() - now;
    
    if (timeLeft <= 0) {
      return { minutes: 0, seconds: 0, isRunning: this._isQuizTime() };
    }
    
    const totalSeconds = Math.floor(timeLeft / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    
    return { minutes, seconds, isRunning: false };
  }
  
  // ==================== QUIZ AUTO SCHEDULER ====================
  
  _startQuizScheduler() {
    if (this.quizAutoTimer) {
      clearInterval(this.quizAutoTimer);
      this.quizAutoTimer = null;
    }
    
    this.quizAutoTimer = setInterval(() => {
      if (this.closing || this.isDestroyed) {
        clearInterval(this.quizAutoTimer);
        this.quizAutoTimer = null;
        return;
      }
      
      try {
        this.translationManager.resetDailyCounter();
        this._checkQuizAutoStatus();
        this._checkAndRestartQuiz();
      } catch(e) {
        console.error('❌ Quiz scheduler error:', e);
      }
    }, CONSTANTS.SCHEDULER_INTERVAL_MS);
  }
  
  async _checkQuizAutoStatus() {
    try {
      const isQuizTime = this._isQuizTime();
      const now = new Date();
      const hours = now.getUTCHours();
      const minutes = now.getUTCMinutes();
      
      const hoursWIB = (hours + 7) % 24;
      console.log(`🕐 Quiz check: ${hoursWIB}:${String(minutes).padStart(2, '0')} WIB, isQuizTime=${isQuizTime}`);
      
      if (isQuizTime) {
        if (!this.quizAutoEnabled) {
          console.log('✅ Quiz Malam detected! Enabling quiz...');
          this.quizAutoEnabled = true;
          this._broadcastToRoom(QUIZ_ROOM, [
            "quizTimeLeft",
            "🌙 Quiz Malam (18:00-23:00 WIB) akan segera dimulai!",
            false
          ]);
          
          await this.startQuizWithDelay(CONSTANTS.QUIZ_START_DELAY_MS);
          
          if (!this._quizStartTimeout) {
            this.forceStartQuiz();
          }
        } else if (!this.currentQuestion && !this._quizTimeout && !this.isQuizWaiting && !this._quizStartTimeout) {
          console.log('📝 Showing next question...');
          await this._showQuestion();
        } else {
          console.log(`⏳ Quiz state: question=${!!this.currentQuestion}, timeout=${!!this._quizTimeout}, waiting=${this.isQuizWaiting}`);
        }
      } else {
        if (this.quizAutoEnabled) {
          console.log('⏸️ Quiz Malam selesai, disabling quiz...');
          this.quizAutoEnabled = false;
          await this.resetQuiz();
          this._broadcastToRoom(QUIZ_ROOM, [
            "quizTimeLeft",
            "⏸️ Quiz Malam (18:00-23:00 WIB) telah berakhir. Sampai jumpa besok! 🌙",
            true
          ]);
        }
      }
    } catch(e) {
      console.error('❌ Error checking quiz status:', e);
    }
  }
  
  // ==================== FORCE START QUIZ ====================
  
  forceStartQuiz() {
    console.log('🔍 Force start quiz check...');
    
    if (!this._isQuizTime()) {
      console.log('⏰ Not quiz time yet (18:00-23:00 WIB)');
      return false;
    }
    
    if (this.currentQuestion) {
      console.log('✅ Quiz already running');
      return true;
    }
    
    if (this._quizTimeout || this.isQuizWaiting || this._quizStartTimeout) {
      console.log('⏳ Quiz is in break/timeout');
      return false;
    }
    
    const clients = this.wsClients.get(QUIZ_ROOM);
    console.log(`👥 Users in quiz room: ${clients ? clients.size : 0}`);
    
    if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) {
      console.log('📚 Questions not loaded, loading...');
      this._initQuiz().then(() => {
        this._showQuestion();
      });
      return false;
    }
    
    console.log('🚀 Force starting quiz!');
    this.quizAutoEnabled = true;
    this._showQuestion();
    return true;
  }
  
  // ==================== CHECK AND RESTART QUIZ ====================
  
  _checkAndRestartQuiz() {
    try {
      if (!this._isQuizTime()) {
        return;
      }
      
      const isRunning = this.currentQuestion !== null;
      const isWaiting = this.isQuizWaiting;
      const hasTimeout = this._quizTimeout !== null;
      const hasBreak = this._quizBreakTimeout !== null;
      
      if (!isRunning && !isWaiting && !hasTimeout && !hasBreak) {
        console.log('⚠️ Quiz is not running but should be! Force starting...');
        this.quizAutoEnabled = true;
        this._showQuestion();
      }
    } catch(e) {
      console.error('❌ Error checking quiz:', e);
    }
  }
  
  // ==================== ENSURE QUIZ STARTED ====================
  
  ensureQuizStarted() {
    console.log('🔄 Ensuring quiz started...');
    
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
    
    this.forceStartQuiz();
  }
  
  // ==================== SEND TO USER ====================
  
  _sendQuizTimeLeftToUser(ws) {
    if (!ws || ws.readyState !== 1) return false;
    
    try {
      const isQuizTime = this._isQuizTime();
      const timeLeft = this._getTimeLeftUntilNextEvent();
      const isQuizActive = this.currentQuestion !== null || this._quizTimeout !== null;
      
      const now = new Date();
      const hoursWIB = (now.getUTCHours() + 7) % 24;
      const minutesWIB = now.getUTCMinutes();
      
      let message = "";
      let canType = true;
      
      if (isQuizTime && isQuizActive) {
        let remaining = "";
        if (this._quizStartTime) {
          const elapsed = (Date.now() - this._quizStartTime) / 1000;
          const total = CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000;
          const left = Math.max(0, total - elapsed);
          const minutes = Math.floor(left / 60);
          const seconds = Math.floor(left % 60);
          if (minutes > 0) {
            remaining = `${minutes}m ${seconds}s remaining`;
          } else {
            remaining = `${seconds}s remaining`;
          }
        }
        message = `🌙 Quiz Malam sedang berjalan! ${remaining}`;
        canType = false;
      } else if (isQuizTime && !isQuizActive) {
        message = `⏳ Quiz Malam (18:00-23:00 WIB) akan segera dimulai!`;
        canType = true;
      } else {
        const totalSeconds = timeLeft.minutes * 60 + timeLeft.seconds;
        
        let countdown = "";
        if (totalSeconds <= 0) {
          countdown = "Sekarang!";
        } else {
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);
          const seconds = Math.floor(totalSeconds % 60);
          
          let parts = [];
          if (hours > 0) parts.push(`${hours} jam`);
          if (minutes > 0) parts.push(`${minutes} menit`);
          if (seconds > 0 && parts.length === 0) parts.push(`${seconds} detik`);
          
          countdown = parts.join(" ");
        }
        
        message = `⏸️ Quiz Malam (18:00-23:00 WIB) dimulai dalam ${countdown}`;
        canType = true;
      }
      
      this._safeSend(ws, ["quizTimeLeft", message, canType]);
      return true;
    } catch(e) {
      return false;
    }
  }
  
  _sendQuizErrorWithTime(ws, errorType, customMessage = null) {
    if (!ws || ws.readyState !== 1) return false;
    
    try {
      const timeLeft = this._getTimeLeftUntilNextEvent();
      let message = "";
      
      switch(errorType) {
        case "NOT_QUIZ_TIME":
          message = "Quiz Malam (18:00-23:00 WIB) sedang offline";
          break;
        case "QUIZ_DISABLED":
          message = "Quiz tidak tersedia saat ini";
          break;
        case "QUIZ_ENDED":
          message = "Quiz Malam telah berakhir";
          break;
        case "QUIZ_NOT_STARTED":
          const timeStr = timeLeft.minutes > 0 ? 
            `${timeLeft.minutes}m ${timeLeft.seconds}s` : 
            `${timeLeft.seconds}s`;
          message = `Quiz Malam dimulai dalam: ${timeStr}`;
          break;
        default:
          message = customMessage || "Quiz error occurred";
      }
      
      this._safeSend(ws, ["quizError", message]);
      return true;
    } catch(e) {
      return false;
    }
  }
  
  // ==================== SWITCH ROOM ====================
  
  async switchRoom(ws, room, username = null) {
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
    if (this._switchLocks.has(lockKey)) return;
    this._switchLocks.set(lockKey, Date.now());
    
    try {
      const oldRoom = this.clientRooms.get(wsId);
      
      if (oldRoom === roomName) {
        if (roomName === QUIZ_ROOM) {
          if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) {
            await this._initQuiz();
          }
          
          if (this._isQuizTime()) {
            if (!this.quizAutoEnabled) {
              this.quizAutoEnabled = true;
            }
            this.forceStartQuiz();
          }
          
          setTimeout(() => {
            if (this.closing || this.isDestroyed) return;
            this._sendQuizTimeLeftToUser(ws);
          }, CONSTANTS.QUIZ_SWITCH_DELAY_MS);
        } else {
          const gameType = this._getGameType(roomName);
          this._safeSend(ws, ["gameType", gameType]);
          
          const game = this.activeGames.get(roomName);
          const isRunning = game && game._isActive && !game._gameEnded;
          if (isRunning) {
            this._safeSend(ws, ["gameLowCardInfo", "Game is already running"]);
          }
        }
        return;
      }
      
      if (oldRoom) {
        this._removeClientFromRoom(oldRoom, wsId);
      }
      
      this._addClient(roomName, ws, username, false);
      ws.room = roomName;
      ws.roomname = roomName;
      ws.username = username;
      
      if (username) {
        const conn = this.userConnections.get(username);
        if (conn) conn.room = roomName;
      }
      
      if (roomName === QUIZ_ROOM) {
        if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) {
          await this._initQuiz();
        }
        
        if (this._isQuizTime()) {
          if (!this.quizAutoEnabled) {
            this.quizAutoEnabled = true;
          }
          this.forceStartQuiz();
        }
        
        setTimeout(() => {
          if (this.closing || this.isDestroyed) return;
          this._sendQuizTimeLeftToUser(ws);
        }, CONSTANTS.QUIZ_SWITCH_DELAY_MS);
      } else {
        const gameType = this._getGameType(roomName);
        this._safeSend(ws, ["gameType", gameType]);
        
        const game = this.activeGames.get(roomName);
        const isRunning = game && game._isActive && !game._gameEnded;
        if (isRunning) {
          this._safeSend(ws, ["gameLowCardInfo", "Game is already running"]);
        }
      }
      
    } finally {
      this._switchLocks.delete(lockKey);
    }
  }
  
  // ==================== LOAD SEMUA SOAL DARI KV ====================
  
  async _loadAllQuestionsFromKV() {
    if (!this.env || !this.env.QUESTIONS) return false;
    
    try {
      this._incrementSubRequest();
      const data = await this.env.QUESTIONS.get('quiz_questions', 'json');
      
      // SUPPORT FORMAT JSON DARI KV: { total: 1000, questions: [...] }
      let questions = [];
      
      if (data && data.questions && Array.isArray(data.questions) && data.questions.length > 0) {
        questions = data.questions;
      } else if (data && Array.isArray(data)) {
        questions = data;
      } else {
        return false;
      }
      
      if (questions.length === 0) {
        return false;
      }
      
      // SIMPAN SEMUA SOAL
      this._allQuestions = questions.map((q, index) => ({
        id: q.id || index + 1,
        question: q.question || '',
        options: q.options || { A: '', B: '', C: '', D: '' },
        correct: q.correct || 'A',
        category: q.category || 'General',
        difficulty: q.difficulty || 'medium'
      }));
      
      this._isAllQuestionsLoaded = true;
      this._usedQuestionIndices = []; // Reset indeks yang sudah dipakai
      this._totalQuestionsAnswered = 0;
      
      console.log(`✅ Loaded ${this._allQuestions.length} questions from KV`);
      console.log(`🎲 Random mode: ${this._allQuestions.length} questions available`);
      
      return true;
      
    } catch(e) {
      console.error('❌ Failed to load questions:', e);
      return false;
    }
  }
  
  // ==================== GET RANDOM QUESTION ====================
  
  _getRandomQuestion() {
    if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) {
      console.log('⚠️ No questions loaded');
      return null;
    }
    
    const total = this._allQuestions.length;
    
    // Jika semua soal sudah dipakai, reset
    if (this._usedQuestionIndices.length >= total) {
      console.log(`🔄 All ${total} questions have been used! Resetting...`);
      this._usedQuestionIndices = [];
      this._totalQuestionsAnswered = 0;
      
      this._broadcastToRoom(QUIZ_ROOM, [
        "quizNotification",
        `📢 All ${total} questions have been answered! Starting fresh with random questions again!`,
        "info"
      ]);
    }
    
    // Cari indeks yang belum dipakai
    let availableIndices = [];
    for (let i = 0; i < total; i++) {
      if (!this._usedQuestionIndices.includes(i)) {
        availableIndices.push(i);
      }
    }
    
    if (availableIndices.length === 0) {
      // Semua sudah dipakai, reset
      this._usedQuestionIndices = [];
      availableIndices = Array.from({ length: total }, (_, i) => i);
    }
    
    // Pilih random dari yang tersedia
    const randomIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
    this._usedQuestionIndices.push(randomIndex);
    this._totalQuestionsAnswered++;
    this._currentQuestionIndex = randomIndex;
    
    const question = this._allQuestions[randomIndex];
    console.log(`🎲 Random question ${this._totalQuestionsAnswered}/${total} (ID: ${question.id})`);
    console.log(`📊 Used: ${this._usedQuestionIndices.length}/${total} questions`);
    
    return question;
  }
  
  // ==================== QUIZ CORE ====================
  
  async _showQuestion() {
    try {
      console.log('📝 _showQuestion called');
      
      if (!this._isQuizTime()) {
        console.log('⏰ Not quiz time (18:00-23:00 WIB), skipping');
        const clients = this.wsClients.get(QUIZ_ROOM);
        if (clients && clients.size > 0) {
          this._broadcastToRoom(QUIZ_ROOM, [
            "quizTimeLeft",
            "⏸️ Quiz Malam (18:00-23:00 WIB) sedang offline.",
            true
          ]);
        }
        return;
      }
      
      if (!this.quizAutoEnabled) {
        console.log('⚠️ Quiz auto not enabled, enabling...');
        this.quizAutoEnabled = true;
        const clients = this.wsClients.get(QUIZ_ROOM);
        if (clients && clients.size > 0) {
          this._broadcastToRoom(QUIZ_ROOM, [
            "quizTimeLeft",
            "🌙 Quiz Malam akan segera dimulai!",
            true
          ]);
        }
        return;
      }
      
      if (this.isDestroyed || this.isQuizWaiting || this._quizStartTimeout || this.currentQuestion) {
        console.log(`⚠️ Cannot show question: destroyed=${this.isDestroyed}, waiting=${this.isQuizWaiting}, timeout=${!!this._quizStartTimeout}, hasQuestion=${!!this.currentQuestion}`);
        return;
      }

      const clients = this.wsClients.get(QUIZ_ROOM);
      if (!clients || clients.size === 0) {
        console.log('👤 No users in quiz room, but continuing...');
      }
      
      // AMBIL SOAL RANDOM
      const q = this._getRandomQuestion();
      
      if (!q || !q.options) {
        console.log(`⚠️ Invalid question, retrying...`);
        setTimeout(() => this._showQuestion(), 1000);
        return;
      }

      const shuffled = this._shuffleQuestionOptions(q);
      
      this.currentQuestion = {
        ...q,
        options: shuffled.options,
        correct: shuffled.correct
      };
      
      this._quizStartTime = Date.now();
      this.quizAnswered = new Set();
      this.quizHasWinner = false;
      this.quizWinner = null;
      
      const total = this._allQuestions.length;
      const used = this._usedQuestionIndices.length;
      
      console.log(`📖 Showing random question ${this._totalQuestionsAnswered}/${total} (${used} used)`);

      // ========== BROADCAST KE SEMUA USER DENGAN BAHASA MASING-MASING ==========
      await this._broadcastQuizQuestion(
        this.currentQuestion.question,
        this.currentQuestion.options
      );

      if (this._quizTimeout) clearTimeout(this._quizTimeout);
      if (this._quizBreakTimeout) clearTimeout(this._quizBreakTimeout);

      this._quizTimeout = setTimeout(async () => {
        try {
          if (this.closing || this.isDestroyed) {
            this._quizTimeout = null;
            return;
          }

          console.log('⏰ Question time ended, evaluating...');

          const currentClients = this.wsClients.get(QUIZ_ROOM);
          if (!currentClients || currentClients.size === 0) {
            this._quizTimeout = null;
            this.currentQuestion = null;
            return;
          }

          if (this.quizHasWinner && this.quizWinner) {
            const points = await this._getQuizPoints();
            points[this.quizWinner] = (points[this.quizWinner] || 0) + 1;
            
            if (this.env && this.env.QUESTIONS) {
              this._incrementSubRequest();
              await this.env.QUESTIONS.put(
                CONSTANTS.QUIZ_POINT_KEY,
                JSON.stringify(points)
              );
            }
            
            const totalPoints = points[this.quizWinner] || 0;
            
            this._broadcastToRoom(QUIZ_ROOM, [
              "quizWinner",
              { username: this.quizWinner, totalPoints: totalPoints }
            ]);
          } else {
            this._broadcastToRoom(QUIZ_ROOM, [
              "quizNoWinner",
              { message: "No one answered correctly!" }
            ]);
          }

          this._quizTimeout = null;
          this.isQuizWaiting = true;

          this._quizBreakTimeout = setTimeout(() => {
            if (this.closing || this.isDestroyed) {
              this._quizBreakTimeout = null;
              return;
            }
            this.isQuizWaiting = false;
            this._quizBreakTimeout = null;
            this.currentQuestion = null;
            
            console.log('🔄 Break finished, showing next question...');
            
            if (!this.closing && !this.isDestroyed) {
              this.ensureQuizRunning();
            }
          }, CONSTANTS.QUIZ_BREAK_MS);

        } catch(e) {
          console.error('❌ Error in quiz timeout:', e);
          this._quizTimeout = null;
          this.currentQuestion = null;
          this.isQuizWaiting = false;
        }
      }, CONSTANTS.QUIZ_TIME_LIMIT_MS);

    } catch(e) {
      console.error('❌ Error in _showQuestion:', e);
      this.currentQuestion = null;
      this.isQuizWaiting = false;
      this._quizTimeout = null;
    }
  }
  
  // ==================== BROADCAST QUIZ QUESTION ====================
  
  async _broadcastQuizQuestion(question, options) {
    const wsIds = this.wsClients.get(QUIZ_ROOM);
    if (!wsIds || wsIds.size === 0) {
      console.log('⚠️ No users in quiz room, broadcasting to none');
      return;
    }
    
    console.log(`🌍 Broadcasting same question to ${wsIds.size} users in their languages`);
    
    const usersByLang = new Map();
    
    for (const wsId of wsIds) {
      try {
        const ws = this.wsMap.get(wsId);
        if (!ws || ws.readyState !== 1) continue;
        
        const lang = this._getUserLanguage(ws);
        if (!usersByLang.has(lang)) {
          usersByLang.set(lang, []);
        }
        usersByLang.get(lang).push(ws);
      } catch(e) {
        // Ignore
      }
    }
    
    console.log(`📊 Users by language:`, Array.from(usersByLang.keys()).map(l => `${l}: ${usersByLang.get(l).length}`).join(', '));
    
    if (usersByLang.size === 0) {
      console.log('⚠️ No valid users found');
      return;
    }
    
    const results = new Map();
    
    for (const [lang, users] of usersByLang) {
      if (lang === 'en') {
        results.set(lang, {
          question: question,
          options: options,
          users: users,
          isFallback: false
        });
        continue;
      }
      
      try {
        const translated = await this._translateQuestionForLanguage(question, options, lang);
        if (translated) {
          results.set(lang, {
            question: translated.question,
            options: translated.options,
            users: users,
            isFallback: false
          });
          console.log(`✅ Translated to ${lang}`);
        } else {
          results.set(lang, {
            question: question,
            options: options,
            users: users,
            isFallback: true
          });
          console.log(`⚠️ Fallback to English for ${lang}`);
        }
      } catch(e) {
        results.set(lang, {
          question: question,
          options: options,
          users: users,
          isFallback: true
        });
        console.log(`❌ Error translating ${lang}: ${e.message}, using English`);
      }
    }
    
    this._sendQuizResults(results);
    console.log(`✅ Broadcast complete to ${wsIds.size} users`);
  }
  
  // ==================== TRANSLATE QUESTION FOR SPECIFIC LANGUAGE ====================
  
  async _translateQuestionForLanguage(question, options, targetLang) {
    if (targetLang === 'en') {
      return { question, options };
    }
    
    try {
      const cacheKey = this.translationManager._getCacheKey(question, options, targetLang);
      const cached = this.translationManager._getCache(cacheKey);
      if (cached) {
        return cached;
      }
      
      const translatedQuestion = await this.translationManager._translateText(question, targetLang);
      const translatedOptions = await this._translateOptionsForLanguage(options, targetLang);
      
      const result = {
        question: translatedQuestion || question,
        options: translatedOptions || options
      };
      
      this.translationManager._setCache(cacheKey, result);
      
      return result;
      
    } catch(e) {
      console.error(`❌ Error translating to ${targetLang}:`, e.message);
      return null;
    }
  }
  
  // ==================== TRANSLATE OPTIONS FOR LANGUAGE ====================
  
  async _translateOptionsForLanguage(options, targetLang) {
    if (targetLang === 'en' || !options) return options;
    
    const keys = ['A', 'B', 'C', 'D'];
    const texts = keys.map(k => options[k]).filter(t => t && typeof t === 'string');
    
    if (texts.length === 0) return options;
    
    const translatedTexts = await Promise.all(
      texts.map(text => this.translationManager._translateText(text, targetLang))
    );
    
    const result = { ...options };
    let idx = 0;
    for (const key of keys) {
      if (options[key] && typeof options[key] === 'string') {
        result[key] = translatedTexts[idx++] || options[key];
      }
    }
    
    return result;
  }
  
  // ==================== SEND QUIZ RESULTS TO USERS ====================
  
  _sendQuizResults(results) {
    for (const [lang, data] of results) {
      const { question, options, users, isFallback } = data;
      
      const message = [
        "quizQuestion",
        {
          question: question || '',
          options: options || { A: '', B: '', C: '', D: '' },
          isFallback: isFallback || false
        }
      ];
      
      const msgStr = JSON.stringify(message);
      
      for (const ws of users) {
        if (ws && ws.readyState === 1) {
          try {
            ws.send(msgStr);
          } catch(e) {
            // Ignore
          }
        }
      }
    }
  }
  
  // ==================== SUBMIT QUIZ ANSWER ====================
  
  async submitQuizAnswer(ws, username, answer) {
    try {
      if (!ws || !username) {
        this._sendQuizErrorWithTime(ws, "ERROR", "Invalid request");
        return;
      }
      
      const room = this._ensureRoomConsistency(ws);
      if (room !== QUIZ_ROOM) {
        this._sendQuizErrorWithTime(ws, "ERROR", "Quiz only available in Quiz room");
        return;
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
      if (!clients || clients.size === 0) {
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
      
      const resultObj = {
        username: username,
        answer: isValidAnswer ? answerKey : "?",
        isCorrect: isCorrect,
        correctAnswer: this.currentQuestion.correct
      };
      
      this._broadcastToRoom(QUIZ_ROOM, ["quizAnswerResult", resultObj]);
      this.quizAnswered.add(username);
      
      if (isCorrect && !this.quizHasWinner) {
        this.quizHasWinner = true;
        this.quizWinner = username;
      }
      
    } catch(e) {
      this._sendQuizErrorWithTime(ws, "ERROR", e.message);
    }
  }
  
  _startQuizLoop() {
    if (this.quizTimer) {
      clearInterval(this.quizTimer);
      this.quizTimer = null;
    }
    
    this.quizTimer = setInterval(() => {
      if (this.closing || this.isDestroyed) {
        clearInterval(this.quizTimer);
        this.quizTimer = null;
        return;
      }
      
      if (this._isQuizTime()) {
        if (!this.quizAutoEnabled) {
          this.quizAutoEnabled = true;
          this._broadcastToRoom(QUIZ_ROOM, [
            "quizTimeLeft",
            "🌙 Quiz Malam akan segera dimulai!",
            true
          ]);
        }
        
        if (!this.currentQuestion && !this._quizTimeout && !this.isQuizWaiting && !this._quizStartTimeout) {
          this._showQuestion();
        }
        
      } else {
        if (this.quizAutoEnabled) {
          this.quizAutoEnabled = false;
          this.resetQuiz();
          this._broadcastToRoom(QUIZ_ROOM, [
            "quizTimeLeft",
            "⏸️ Quiz Malam (18:00-23:00 WIB) telah berakhir. Sampai jumpa besok! 🌙",
            true
          ]);
        }
      }
    }, CONSTANTS.QUIZ_INTERVAL_MS);
  }
  
  // ==================== RESET QUIZ ====================
  
  async resetQuiz() {
    try {
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
      
      this.currentQuestion = null;
      this.isQuizWaiting = false;
      this.quizHasWinner = false;
      this.quizWinner = null;
      this.quizAnswered = new Set();
      this._quizStartTime = null;
      
      // RESET USED INDICES SAAT QUIZ RESET
      // TAPI JANGAN RESET TOTAL, BIAR LANJUT
      
      this._broadcastToRoom(QUIZ_ROOM, ["quizReset", "Quiz has been reset"]);
    } catch(e) {
      // Silent
    }
  }
  
  async startQuizWithDelay(delayMs) {
    if (this._quizStartTimeout) {
      console.log('⏳ Quiz start timeout already exists');
      return;
    }
    
    console.log(`⏰ Starting quiz in ${delayMs}ms...`);
    
    this._quizStartTimeout = setTimeout(() => {
      if (this.closing || this.isDestroyed) {
        this._quizStartTimeout = null;
        return;
      }
      this._quizStartTimeout = null;
      
      console.log('🚀 Quiz delay finished, starting quiz...');
      
      if (!this.currentQuestion && this.quizAutoEnabled) {
        this.forceStartQuiz();
      } else {
        console.log(`⚠️ Quiz already running: ${!!this.currentQuestion}`);
      }
    }, delayMs);
  }
  
  // ==================== HANDLE EVENT ====================
  
  async handleEvent(ws, data) {
    if (this.isDestroyed || !ws || !data || !data[0]) return;
    const evt = data[0];
    
    if (evt === "switchRoom") {
      const [_, room, username] = data;
      await this.switchRoom(ws, room, username);
      return;
    }
    
    if (evt === "submitQuizAnswer") {
      const [_, username, answer] = data;
      await this.submitQuizAnswer(ws, username, answer);
      return;
    }
    
    if (evt === "getQuizLastWeekWinner") {
      const winner = await this._getLastWeekWinner();
      if (winner) {
        this._safeSend(ws, ["quizLastWeekWinner", winner.username, winner.score, winner.week]);
      } else {
        this._safeSend(ws, ["quizLastWeekWinner", "", 0, ""]);
      }
      return;
    }
    
    if (evt === "getQuizLeaderboard") {
      let limit = 10;
      if (data.length > 1 && typeof data[1] === 'number') {
        limit = Math.min(data[1], 30);
      }
      
      const points = await this._getQuizPoints();
      
      const sorted = Object.entries(points)
        .map(([username, score]) => ({ username, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      
      const result = sorted.map(item => `${item.username}|${item.score}`);
      this._safeSend(ws, ["quizLeaderboard", result]);
      return;
    }
    
    if (evt === "getQuizUserPoints") {
      let username = "";
      if (data.length > 1 && typeof data[1] === 'string') {
        username = data[1];
      }
      
      const points = await this._getQuizPoints();
      const userPoints = points[username] || 0;
      this._safeSend(ws, ["quizUserPoints", username, userPoints]);
      return;
    }
    
    if (evt === "deleteQuizLastWeekWinner") {
      try {
        if (this.env && this.env.QUESTIONS) {
          this._incrementSubRequest();
          await this.env.QUESTIONS.delete(CONSTANTS.QUIZ_LAST_WEEK_WINNER);
          this._safeSend(ws, ["quizLastWeekWinnerDeleted", true, "Last week winner deleted successfully"]);
        } else {
          this._safeSend(ws, ["quizLastWeekWinnerDeleted", false, "KV not available"]);
        }
      } catch(e) {
        this._safeSend(ws, ["quizLastWeekWinnerDeleted", false, e.message]);
      }
      return;
    }
    
    if (evt === "getQuizStatus") {
      const status = this._getQuizStatus();
      this._safeSend(ws, ["quizStatus", status]);
      return;
    }
    
    if (evt === "getQuizProgress") {
      const progress = this._getQuizProgress();
      this._safeSend(ws, ["quizProgress", progress]);
      return;
    }
    
    if (evt === "forceQuizStart") {
      console.log('🔧 Manual force quiz start requested');
      this.forceStartQuiz();
      this._safeSend(ws, ["quizStatus", { message: "Quiz force started", success: true }]);
      return;
    }
    
    if (evt === "getQuizDebugInfo") {
      const info = {
        isQuizTime: this._isQuizTime(),
        quizAutoEnabled: this.quizAutoEnabled,
        hasQuestion: !!this.currentQuestion,
        hasTimeout: !!this._quizTimeout,
        isWaiting: this.isQuizWaiting,
        hasStartTimeout: !!this._quizStartTimeout,
        questionsLoaded: this._isAllQuestionsLoaded,
        totalQuestions: this._allQuestions.length,
        usedQuestions: this._usedQuestionIndices.length,
        totalAnswered: this._totalQuestionsAnswered,
        currentQuestionIndex: this._currentQuestionIndex,
        usersInRoom: this.wsClients.get(QUIZ_ROOM)?.size || 0,
        currentTimeUTC: new Date().toUTCString(),
        currentTimeWIB: this._getWIBTime(),
        schedule: "18:00 - 23:00 WIB",
        mode: "RANDOM"
      };
      this._safeSend(ws, ["quizDebugInfo", info]);
      return;
    }
    
    // ===== GAME EVENTS =====
    const room = this._ensureRoomConsistency(ws);
    if (!room) {
      this._safeSend(ws, ["gameLowCardError", "Please switch to a room first!"]);
      return;
    }
    
    if (room === QUIZ_ROOM) {
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
      default:
        this._safeSend(ws, ["gameLowCardError", `Unknown event: ${evt}`]);
        break;
    }
  }
  
  // ==================== GET WIB TIME ====================
  
  _getWIBTime() {
    const now = new Date();
    const hours = (now.getUTCHours() + 7) % 24;
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    return `${String(hours).padStart(2, '0')}:${minutes}`;
  }
  
  // ==================== GET QUIZ STATUS ====================
  
  _getQuizStatus() {
    try {
      const total = this._allQuestions.length || 0;
      const used = this._usedQuestionIndices.length || 0;
      const progress = total > 0 ? Math.round((used / total) * 100) : 0;
      
      const isQuizTime = this._isQuizTime();
      const timeLeft = this._getTimeLeftUntilNextEvent();
      const now = new Date();
      const currentHourWIB = (now.getUTCHours() + 7) % 24;
      const currentMinuteWIB = now.getUTCMinutes();
      
      return {
        totalQuestions: total,
        usedQuestions: used,
        remaining: Math.max(0, total - used),
        progress: progress,
        totalAnswered: this._totalQuestionsAnswered,
        isComplete: used >= total,
        mode: "RANDOM",
        schedule: {
          isQuizTime: isQuizTime,
          timeLeftMinutes: timeLeft.minutes,
          timeLeftSeconds: timeLeft.seconds,
          currentTimeWIB: `${String(currentHourWIB).padStart(2, '0')}:${String(currentMinuteWIB).padStart(2, '0')}`,
          scheduleDescription: "🌙 Quiz Malam: 18:00 - 23:00 WIB",
          nextStartTime: this._getNextQuizStartTime().toUTCString(),
          isRunning: isQuizTime && this.currentQuestion !== null
        }
      };
    } catch(e) {
      return { error: e.message };
    }
  }
  
  _getQuizProgress() {
    try {
      const total = this._allQuestions.length || 0;
      const used = this._usedQuestionIndices.length || 0;
      const progress = total > 0 ? Math.round((used / total) * 100) : 0;
      
      return {
        totalQuestions: total,
        usedQuestions: used,
        remaining: Math.max(0, total - used),
        progress: progress,
        totalAnswered: this._totalQuestionsAnswered,
        isComplete: used >= total,
        mode: "RANDOM"
      };
    } catch(e) {
      return { error: e.message };
    }
  }
  
  // ==================== WEBSOCKET HELPERS ====================
  
  _getWsId(ws) {
    return ws ? ws._wsId : null;
  }
  
  _getRoomForWs(ws) {
    if (!ws) return null;
    return ws.room || ws.roomname || null;
  }
  
  _ensureRoomConsistency(ws) {
    if (!ws) return null;
    const wsId = this._getWsId(ws);
    if (!wsId) return null;
    let room = this._getRoomForWs(ws);
    if (!room) return null;
    const clientRoom = this.clientRooms.get(wsId);
    if (clientRoom && clientRoom !== room) {
      room = clientRoom;
      ws.room = room;
      ws.roomname = room;
    }
    if (!this.wsClients.has(room)) {
      this.wsClients.set(room, new Set());
    }
    if (!this.wsClients.get(room).has(wsId)) {
      this.wsClients.get(room).add(wsId);
      this.clientRooms.set(wsId, room);
    }
    return room;
  }
  
  _addClient(room, ws, username = null, isNewConnection = false) {
    if (!ws) return;
    const wsId = this._getWsId(ws);
    if (!wsId) {
      this._safeSend(ws, ["gameLowCardError", "Connection error, please reconnect"]);
      return;
    }
    if (username && isNewConnection) {
      this.userConnections.set(username, {
        wsId: wsId,
        ws: ws,
        room: room,
        timestamp: Date.now()
      });
    }
    if (username && !isNewConnection) {
      const conn = this.userConnections.get(username);
      if (conn) {
        conn.room = room;
        conn.timestamp = Date.now();
      } else {
        this.userConnections.set(username, {
          wsId: wsId,
          ws: ws,
          room: room,
          timestamp: Date.now()
        });
      }
    }
    if (this.clientRooms.has(wsId)) {
      const oldRoom = this.clientRooms.get(wsId);
      if (oldRoom !== room) this._removeClientFromRoom(oldRoom, wsId);
    }
    const clients = this.wsClients.get(room);
    if (clients) clients.delete(wsId);
    if (!this.wsClients.has(room)) this.wsClients.set(room, new Set());
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
  }
  
  _removeClientFromRoom(room, wsId) {
    if (!room || !wsId) return;
    const clients = this.wsClients.get(room);
    if (clients) {
      clients.delete(wsId);
      if (clients.size === 0) this.wsClients.delete(room);
    }
  }
  
  _removeClient(room, ws) {
    if (!ws) return;
    const wsId = this._getWsId(ws);
    if (!wsId) return;
    const username = ws.username;
    this._removeClientFromRoom(room, wsId);
    this.clientRooms.delete(wsId);
    this.wsMap.delete(wsId);
    this.userLanguage.delete(wsId);
    this.userCountry.delete(wsId);
    if (username) {
      const conn = this.userConnections.get(username);
      if (conn && conn.wsId === wsId) this.userConnections.delete(username);
      if (this.roomViewers.has(room)) {
        this.roomViewers.get(room).delete(username);
        if (this.roomViewers.get(room).size === 0) this.roomViewers.delete(room);
      }
    }
    ws.room = null;
    ws.roomname = null;
    ws._wsId = null;
    ws.username = null;
  }
  
  // ==================== LANGUAGE MAPPING ====================
  
  _countryToLanguage(countryCode) {
    if (!countryCode) return 'en';
    
    const map = {
      'ID': 'id', 'MY': 'id', 'SG': 'id', 'PH': 'id',
      'TH': 'th', 'VN': 'vi', 'KH': 'km', 'LA': 'lo',
      'MM': 'my', 'TL': 'pt',
      'CN': 'zh', 'TW': 'zh', 'HK': 'zh', 'MO': 'zh',
      'JP': 'ja', 'KR': 'ko', 'MN': 'mn',
      'IN': 'hi', 'PK': 'ur', 'BD': 'bn', 'LK': 'si',
      'NP': 'ne', 'MV': 'dv', 'AF': 'ps',
      'SA': 'ar', 'AE': 'ar', 'QA': 'ar', 'KW': 'ar',
      'BH': 'ar', 'OM': 'ar', 'YE': 'ar', 'SY': 'ar',
      'LB': 'ar', 'PS': 'ar', 'JO': 'ar', 'IQ': 'ar',
      'EG': 'ar', 'DZ': 'ar', 'MA': 'ar', 'TN': 'ar',
      'LY': 'ar', 'SD': 'ar', 'MR': 'ar', 'SO': 'ar',
      'IR': 'fa', 'IL': 'he', 'TR': 'tr',
      'GB': 'en', 'US': 'en', 'AU': 'en', 'CA': 'en',
      'NZ': 'en', 'ZA': 'en', 'NG': 'en', 'KE': 'en',
      'FR': 'fr', 'BE': 'fr', 'CH': 'fr', 'LU': 'fr',
      'DE': 'de', 'AT': 'de', 'LI': 'de',
      'ES': 'es', 'MX': 'es', 'AR': 'es', 'CO': 'es',
      'CL': 'es', 'PE': 'es', 'VE': 'es', 'EC': 'es',
      'GT': 'es', 'CU': 'es', 'DO': 'es',
      'IT': 'it', 'PT': 'pt', 'BR': 'pt',
      'NL': 'nl', 'RU': 'ru', 'UA': 'ru', 'PL': 'pl',
      'SE': 'sv', 'NO': 'no', 'DK': 'da', 'FI': 'fi',
      'GR': 'el', 'HU': 'hu', 'CS': 'cs', 'SK': 'sk',
      'RO': 'ro', 'BG': 'bg', 'HR': 'hr', 'SI': 'sl',
    };
    
    return map[countryCode.toUpperCase()] || 'en';
  }
  
  // ==================== GET USER LANGUAGE ====================
  
  _getUserLanguage(ws) {
    if (!ws) return 'en';
    
    const wsId = this._getWsId(ws);
    if (!wsId) return 'en';
    
    let lang = this.userLanguage.get(wsId);
    if (lang) return lang;
    
    const country = this.userCountry.get(wsId);
    lang = this._countryToLanguage(country);
    
    this.userLanguage.set(wsId, lang);
    
    return lang;
  }
  
  // ==================== SHUFFLE HELPERS ====================
  
  _shuffleQuestionOptions(question) {
    if (!question || !question.options) {
      return { options: { A: '', B: '', C: '', D: '' }, correct: 'A' };
    }
    const options = question.options;
    const keys = ['A', 'B', 'C', 'D'];
    const entries = keys.map(key => ({
      key: key,
      text: options[key] || '',
      isCorrect: key === question.correct
    }));
    const shuffled = this._shuffleArray(entries);
    const newOptions = {};
    const newKeys = ['A', 'B', 'C', 'D'];
    let newCorrect = '';
    shuffled.forEach((item, index) => {
      const newKey = newKeys[index];
      newOptions[newKey] = item.text;
      if (item.isCorrect) newCorrect = newKey;
    });
    return {
      options: newOptions,
      correct: newCorrect || 'A'
    };
  }
  
  _shuffleArray(array) {
    if (!array || !Array.isArray(array) || array.length === 0) return array || [];
    const arr = array.length > CONSTANTS.MAX_ARRAY_SIZE ? array.slice(0, CONSTANTS.MAX_ARRAY_SIZE) : [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  
  // ==================== BROADCAST ====================
  
  _broadcastToRoom(room, message) {
    if (this.closing || this.isDestroyed || !room || !message) return;
    const wsIds = this.wsClients.get(room);
    if (!wsIds || wsIds.size === 0) return;
    
    const now = Date.now();
    const reset = this._roomBroadcastReset.get(room) || 0;
    const count = this._roomBroadcastCount.get(room) || 0;
    
    if (now > reset) {
      this._roomBroadcastReset.set(room, now + 1000);
      this._roomBroadcastCount.set(room, 1);
    } else {
      if (count > CONSTANTS.MAX_BROADCAST_BATCH) return;
      this._roomBroadcastCount.set(room, count + 1);
    }
    
    const msgStr = JSON.stringify(message);
    const wsIdArray = Array.from(wsIds);
    const batchSize = Math.min(CONSTANTS.BATCH_SIZE, 2);
    const disconnected = [];
    
    for (let i = 0; i < wsIdArray.length && i < 15; i += batchSize) {
      const batch = wsIdArray.slice(i, i + batchSize);
      for (const wsId of batch) {
        const ws = this.wsMap.get(wsId);
        if (ws && ws.readyState === 1) {
          try {
            ws.send(msgStr);
          } catch(e) {
            disconnected.push(wsId);
          }
        } else {
          disconnected.push(wsId);
        }
      }
    }
    
    if (disconnected.length > 0) {
      for (const wsId of disconnected) {
        const ws = this.wsMap.get(wsId);
        if (ws) {
          this._removeClient(room, ws);
        } else {
          this._removeClientFromRoom(room, wsId);
          this.clientRooms.delete(wsId);
        }
      }
    }
  }
  
  _safeSend(ws, message) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch(e) {
      return false;
    }
  }
  
  // ==================== ENSURE SINGLE CONNECTION ====================
  
  _ensureSingleConnection(room, username, newWs, newWsId) {
    try {
      const game = this.activeGames.get(room);
      if (!game) return newWsId;
      
      const existingWsId = game.playerWsId?.get(username);
      if (existingWsId && existingWsId !== newWsId) {
        const oldWs = this.wsMap.get(existingWsId);
        if (oldWs) {
          try {
            oldWs.close(1000, "Duplicate connection");
          } catch(e) {}
          this._removeClient(room, oldWs);
        }
        if (game.playerWsId) {
          game.playerWsId.set(username, newWsId);
        }
      }
      
      return newWsId;
    } catch(e) {
      return newWsId;
    }
  }
  
  // ==================== ENSURE QUIZ RUNNING ====================
  
  ensureQuizRunning() {
    try {
      console.log('🔍 ensureQuizRunning called');
      
      const clients = this.wsClients.get(QUIZ_ROOM);
      console.log(`👥 Users in quiz room: ${clients ? clients.size : 0}`);
      
      this._forceStartQuizIfTime();
      
      if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) {
        console.log('📚 Questions not loaded, initializing...');
        this._initQuiz().then(() => {
          if (!this.closing && !this.isDestroyed) {
            console.log('✅ Questions loaded, starting quiz...');
            this.forceStartQuiz();
          }
        });
        return;
      }
      
      if (!this.currentQuestion && !this._quizTimeout && !this.isQuizWaiting && !this._quizStartTimeout) {
        console.log('🚀 Quiz not running, starting...');
        this.forceStartQuiz();
      } else {
        console.log(`⏳ Quiz state: question=${!!this.currentQuestion}, timeout=${!!this._quizTimeout}, waiting=${this.isQuizWaiting}, startTimeout=${!!this._quizStartTimeout}`);
      }
      
    } catch(e) {
      console.error('❌ Error in ensureQuizRunning:', e);
    }
  }
  
  _startQuizIfNeeded() {
    try {
      const clients = this.wsClients.get(QUIZ_ROOM);
      if (!clients || clients.size === 0) return;
      if (!this.currentQuestion && !this._quizTimeout && !this.isQuizWaiting && !this._quizStartTimeout) {
        if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) {
          this._initQuiz().then(() => {
            if (!this.closing && !this.isDestroyed) {
              this._showQuestion();
            }
          });
          return;
        }
        this._showQuestion();
      }
    } catch(e) {
      // Silent
    }
  }
  
  _forceStartQuizIfTime() {
    console.log('🔍 _forceStartQuizIfTime called');
    
    if (!this._isQuizTime()) {
      console.log('⏰ Not quiz time (18:00-23:00 WIB)');
      return;
    }
    
    if (this.currentQuestion) {
      console.log('✅ Quiz already has question');
      return;
    }
    
    if (this._quizTimeout) {
      console.log('⏳ Quiz is in timeout');
      return;
    }
    
    if (this.isQuizWaiting) {
      console.log('⏳ Quiz is waiting');
      return;
    }
    
    if (this._quizStartTimeout) {
      console.log('⏳ Quiz start timeout active');
      return;
    }
    
    console.log('🚀 Force starting quiz from _forceStartQuizIfTime!');
    this.quizAutoEnabled = true;
    this._showQuestion();
  }
  
  async _initQuiz(retryCount = 0) {
    try {
      const loaded = await this._loadAllQuestionsFromKV();
      if (loaded) {
        this._startQuizLoop();
        this._startTranslateResetCounter();
        return true;
      }
      if (retryCount < CONSTANTS.MAX_RETRY_INIT_QUIZ && !this.closing && !this.isDestroyed) {
        setTimeout(() => this._initQuiz(retryCount + 1), 5000);
      }
      return false;
    } catch(e) {
      if (retryCount < CONSTANTS.MAX_RETRY_INIT_QUIZ && !this.closing && !this.isDestroyed) {
        setTimeout(() => this._initQuiz(retryCount + 1), 5000);
      }
      return false;
    }
  }
  
  // ==================== TRANSLATE RESET COUNTER ====================
  
  _startTranslateResetCounter() {
    if (this._translateResetInterval) {
      clearInterval(this._translateResetInterval);
      this._translateResetInterval = null;
    }
    this._translateResetInterval = setInterval(() => {
      if (this.closing || this.isDestroyed) {
        clearInterval(this._translateResetInterval);
        this._translateResetInterval = null;
        return;
      }
      this.translationManager.resetDailyCounter();
    }, 60000);
  }
}
