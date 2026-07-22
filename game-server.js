// ==================== GAME-SERVER.JS (FULL COMPLETE - FIXED) ====================

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
  MAX_ARRAY_SIZE: 10000,
  QUIZ_SWITCH_DELAY_MS: 5000,
  QUIZ_POINT_KEY: 'quiz_points',
  QUIZ_WEEK_KEY: 'quiz_current_week',
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
};

const QUIZ_SCHEDULE = {
  START_HOUR: 13,
  END_HOUR: 24,
  TIMEZONE_OFFSET: 7,
};

const QUIZ_ROOM = "Quiz";

// ==================== CPU PROTECTION MIXIN ====================

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
  }

  async _cpuYield() {
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

  async _processEventQueue() {
    if (this._isProcessingQueue || this._eventQueue.length === 0) return;
    this._isProcessingQueue = true;
    this._startCPUTimer();
    try {
      const batchSize = CONSTANTS.MAX_EVENTS_PER_TICK;
      const batch = this._eventQueue.splice(0, batchSize);
      for (const item of batch) {
        try {
          await this._processEventItem(item.ws, item.data);
        } catch(e) {}
        if (this._checkCPULimit()) {
          await this._cpuYield();
          this._startCPUTimer();
        }
      }
      if (this._eventQueue.length > 0) {
        setTimeout(() => this._processEventQueue(), CONSTANTS.CPU_YIELD_DELAY_MS);
      }
    } finally {
      this._isProcessingQueue = false;
    }
  }

  async _processEventItem(ws, data) {
    if (this.isDestroyed || !ws || !data || !data[0]) return;
    const evt = data[0];
    const wsId = this._getWsId(ws);
    if (wsId && this._isRateLimited(wsId, evt)) {
      this._safeSend(ws, ["gameLowCardError", "Too many requests"]);
      return;
    }
    await this._safeExecute(async () => {
      await this._handleEventInternal(ws, data);
    });
  }
}

// ==================== TRANSLATION MANAGER ====================

class TranslationManager extends CPUProtection {
  constructor(gameServer) {
    super();
    this.gameServer = gameServer;
    this.questionCache = new Map();
    this.TRANSLATE_TIMEOUT = CONSTANTS.TRANSLATE_TIMEOUT_MS;
    this.translateCount = 0;
    this.translateDate = new Date().toUTCString();
    this.translateLimitReached = false;
    this._translateResetInterval = null;
    this._pendingTranslations = new Map();
    this._translationCache = new Map();
  }

  resetQuestionCache() {
    if (this.questionCache.size > 0) this.questionCache.clear();
    this.translateCount = 0;
    this.translateLimitReached = false;
  }

  async translateForUsersSync(question, options, usersByLang) {
    const results = new Map();
    const cacheKey = this._getCacheKey(question, options);
    const needTranslate = [];

    for (const [lang, users] of usersByLang) {
      if (lang === 'en') {
        results.set(lang, { question, options, users, isFallback: false, fromCache: true });
        continue;
      }

      const langCacheKey = `${cacheKey}_${lang}`;
      const cached = this._translationCache.get(langCacheKey);

      if (cached) {
        results.set(lang, {
          question: cached.question,
          options: cached.options,
          users,
          isFallback: false,
          fromCache: true
        });
      } else {
        needTranslate.push({ lang, users });
      }
    }

    if (needTranslate.length > 0) {
      const translatePromises = needTranslate.map(async ({ lang, users }) => {
        try {
          const [translatedQuestion, translatedOptions] = await Promise.all([
            this._translateText(question, lang),
            this._translateOptions(options, lang)
          ]);

          const result = {
            question: translatedQuestion || question,
            options: translatedOptions || options
          };

          const langCacheKey = `${cacheKey}_${lang}`;
          this._translationCache.set(langCacheKey, result);

          return { lang, users, result, isFallback: false };
        } catch(e) {
          return {
            lang,
            users,
            result: { question, options },
            isFallback: true
          };
        }
      });

      const translatedResults = await Promise.all(translatePromises);

      for (const { lang, users, result, isFallback } of translatedResults) {
        results.set(lang, {
          question: result.question,
          options: result.options,
          users,
          isFallback,
          fromCache: false
        });
      }
    }

    this._sendResults(results);
  }

  async _translateText(text, targetLang, retryCount = 0) {
    if (targetLang === 'en' || !text || typeof text !== 'string') return text;

    const cacheKey = `${text}_${targetLang}`;
    if (this._translationCache.has(cacheKey)) {
      return this._translationCache.get(cacheKey);
    }

    try {
      const result = await this._safeExecute(async () => await this._callTranslateAPI(text, targetLang));
      this.translateCount++;
      this._translationCache.set(cacheKey, result);
      return result;
    } catch(e) {
      if (retryCount < 5) {
        await this._sleep(1000 * (retryCount + 1));
        return this._translateText(text, targetLang, retryCount + 1);
      }
      throw e;
    }
  }

  async _translateOptions(options, targetLang) {
    if (targetLang === 'en' || !options) return options;
    const keys = ['A', 'B', 'C', 'D'];
    const texts = keys.map(k => options[k]).filter(t => t && typeof t === 'string');
    if (texts.length === 0) return options;

    const translatedTexts = await this._safeExecute(async () => {
      return await Promise.all(texts.map(text => this._translateText(text, targetLang)));
    });

    const result = { ...options };
    let idx = 0;
    for (const key of keys) {
      if (options[key] && typeof options[key] === 'string') {
        result[key] = translatedTexts[idx++] || options[key];
      }
    }
    return result;
  }

  _getCacheKey(question, options) {
    return `${question}|${Object.values(options).join('|')}`;
  }

  _sendResults(results) {
    for (const [lang, data] of results) {
      const { question, options, users, isFallback, fromCache } = data;
      const message = ["quizQuestion", {
        question: question || '',
        options: options || { A: '', B: '', C: '', D: '' },
        isFallback: isFallback || false
      }];
      const msgStr = JSON.stringify(message);

      for (const ws of users) {
        if (ws && ws.readyState === 1) {
          try { ws.send(msgStr); } catch(e) {}
        }
      }
    }
  }

  async _callTranslateAPI(text, targetLang) {
    const apiUrls = [
      'https://deeplx.1stg.me/translate',
      'https://deeplx.pages.dev/translate',
      'https://api.deeplx.org/translate',
    ];
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
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const translated = data.data || data.text || data.result || data.translations?.[0]?.text;
        if (translated) return translated;
        throw new Error('Invalid response');
      } catch(e) { lastError = e; }
    }
    try {
      const googleResult = await this._callGoogleTranslate(text, targetLang);
      if (googleResult) return googleResult;
    } catch(e) { lastError = e; }
    try {
      const libreResult = await this._callLibreTranslate(text, targetLang);
      if (libreResult) return libreResult;
    } catch(e) { lastError = e; }
    try {
      const myMemoryResult = await this._callMyMemory(text, targetLang);
      if (myMemoryResult) return myMemoryResult;
    } catch(e) { lastError = e; }
    throw lastError || new Error('All translation APIs failed');
  }

  async _callGoogleTranslate(text, targetLang) {
    const langMap = { 'id': 'id', 'th': 'th', 'vi': 'vi', 'zh': 'zh-CN', 'ja': 'ja', 'ko': 'ko',
      'ar': 'ar', 'es': 'es', 'fr': 'fr', 'de': 'de', 'pt': 'pt', 'ru': 'ru', 'hi': 'hi', 'it': 'it',
      'nl': 'nl', 'pl': 'pl', 'tr': 'tr', 'uk': 'uk', 'sv': 'sv', 'no': 'no', 'da': 'da', 'fi': 'fi',
      'el': 'el', 'cs': 'cs', 'hu': 'hu', 'ro': 'ro', 'bg': 'bg', 'hr': 'hr', 'sk': 'sk', 'sl': 'sl' };
    const target = langMap[targetLang] || 'en';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data && data[0] && data[0][0] && data[0][0][0]) return data[0][0][0];
    throw new Error('Invalid response');
  }

  async _callLibreTranslate(text, targetLang) {
    const instances = ['https://libretranslate.com/translate', 'https://translate.argonauta.dev/translate'];
    let lastError = null;
    for (const instance of instances) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(instance, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: text, source: 'en', target: targetLang, format: 'text' }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data && data.translatedText) return data.translatedText;
        throw new Error('Invalid response');
      } catch(e) { lastError = e; }
    }
    throw lastError || new Error('All LibreTranslate instances failed');
  }

  async _callMyMemory(text, targetLang) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data && data.responseData && data.responseData.translatedText) return data.responseData.translatedText;
    throw new Error('Invalid response');
  }

  resetDailyCounter() {
    const now = new Date().toUTCString();
    if (now !== this.translateDate) {
      this.translateDate = now;
      this.translateCount = 0;
      this.translateLimitReached = false;
    }
  }

  _startTranslateReset() {
    if (this._translateResetInterval) clearInterval(this._translateResetInterval);
    this._translateResetInterval = setInterval(() => {
      if (this.gameServer?.closing || this.gameServer?.isDestroyed) {
        clearInterval(this._translateResetInterval);
        this._translateResetInterval = null;
        return;
      }
      this.resetDailyCounter();
    }, 60000);
  }
}

// ==================== GAME SERVER CLASS ====================

export class GameServer extends CPUProtection {
  constructor(state, env) {
    super();
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
    this._isSwitchingToQuiz = false;
    this._switchQuizTimeout = null;
    this._timeLeftSentCount = new Map();

    this._quizState = {
      isEvaluating: false,
      isEvaluated: false,
      evaluationStartTime: null,
      evaluationLock: null,
      lastEvaluationResult: null
    };

    this._usedQuestionIndices = new Set();

    this.translationManager = new TranslationManager(this);

    this._initAsync();
    setTimeout(() => this.forceStartQuiz(), 3000);
    this._startCPUMonitor();
  }

  _resetQuizState() {
    this._quizState.isEvaluating = false;
    this._quizState.isEvaluated = false;
    this._quizState.evaluationStartTime = null;
    this._quizState.lastEvaluationResult = null;
    if (this._quizState.evaluationLock) {
      this._quizState.evaluationLock = null;
    }
    this.quizHasWinner = false;
    this.quizWinner = null;
    this.quizAnswered = new Set();
  }

  async _initAsync() {
    if (this._initialized) return;
    this._initialized = true;
    await this._initQuiz();
    this._startQuizScheduler();
    await this._checkAndResetWeeklyPoints();
    setTimeout(() => this.ensureQuizRunning(), 2000);
  }

  _incrementSubRequest() {
    this._subRequestCount++;
    this._requestCount++;
  }

  _getCurrentWIBHour() {
    return (new Date().getUTCHours() + QUIZ_SCHEDULE.TIMEZONE_OFFSET) % 24;
  }

  _getCurrentWIBMinutes() {
    return new Date().getUTCMinutes();
  }

  _getCurrentWIBTime() {
    const now = new Date();
    const hours = (now.getUTCHours() + QUIZ_SCHEDULE.TIMEZONE_OFFSET) % 24;
    return {
      hours,
      minutes: now.getUTCMinutes(),
      totalMinutes: (hours * 60) + now.getUTCMinutes(),
      formatted: `${String(hours).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} WIB`
    };
  }

  _formatWIBTime(hours, minutes) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} WIB`;
  }

  _isQuizTime() {
    const wibHour = this._getCurrentWIBHour();
    const wibMinutes = this._getCurrentWIBMinutes();
    const currentTotal = (wibHour * 60) + wibMinutes;
    const startTotal = QUIZ_SCHEDULE.START_HOUR * 60;
    const endTotal = QUIZ_SCHEDULE.END_HOUR * 60;
    return currentTotal >= startTotal && currentTotal < endTotal;
  }

  _getTimeLeftUntilNextEvent() {
    const wibTime = this._getCurrentWIBTime();
    const currentTotal = wibTime.totalMinutes;
    const startTotal = QUIZ_SCHEDULE.START_HOUR * 60;
    const endTotal = QUIZ_SCHEDULE.END_HOUR * 60;

    if (currentTotal >= startTotal && currentTotal < endTotal) {
      return {
        minutes: 0, seconds: 0, isRunning: true, hours: 0, totalMinutes: 0,
        status: 'running', currentTime: wibTime.formatted,
        startTime: this._formatWIBTime(QUIZ_SCHEDULE.START_HOUR, 0),
        endTime: this._formatWIBTime(QUIZ_SCHEDULE.END_HOUR, 0),
        startHour: QUIZ_SCHEDULE.START_HOUR, endHour: QUIZ_SCHEDULE.END_HOUR
      };
    }

    let targetTotal, status, dayText = "";
    if (currentTotal < startTotal) {
      targetTotal = startTotal;
      status = 'before';
      dayText = "today";
    } else {
      targetTotal = startTotal + 1440;
      status = 'after';
      dayText = "tomorrow";
    }

    const diffMinutes = targetTotal - currentTotal;
    return {
      hours: Math.floor(diffMinutes / 60),
      minutes: Math.floor(diffMinutes % 60),
      seconds: 0,
      totalMinutes: diffMinutes,
      totalSeconds: diffMinutes * 60,
      isRunning: false,
      status,
      startHour: QUIZ_SCHEDULE.START_HOUR,
      endHour: QUIZ_SCHEDULE.END_HOUR,
      startTime: this._formatWIBTime(QUIZ_SCHEDULE.START_HOUR, 0),
      endTime: this._formatWIBTime(QUIZ_SCHEDULE.END_HOUR, 0),
      currentTime: wibTime.formatted,
      dayText
    };
  }

  _getCurrentWeek() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const startOfYear = new Date(year, 0, 1);
    const diff = now - startOfYear;
    const week = Math.ceil((diff / 86400000 + startOfYear.getUTCDay() + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  async _getQuizPoints() {
    if (!this.env?.QUESTIONS) return {};
    try {
      const points = await this.env.QUESTIONS.get(CONSTANTS.QUIZ_POINT_KEY, 'json');
      return points || {};
    } catch(e) { return {}; }
  }

  async _getLastWeekWinner() {
    if (!this.env?.QUESTIONS) return null;
    try {
      const winner = await this.env.QUESTIONS.get(CONSTANTS.QUIZ_LAST_WEEK_WINNER, 'json');
      return winner || null;
    } catch(e) { return null; }
  }

  async _checkAndResetWeeklyPoints() {
    if (!this.env?.QUESTIONS) return false;
    try {
      const currentWeek = this._getCurrentWeek();
      const savedWeek = await this.env.QUESTIONS.get(CONSTANTS.QUIZ_WEEK_KEY);
      if (savedWeek !== currentWeek) {
        const points = await this._getQuizPoints();
        let winner = null, highestScore = 0;
        for (const [username, score] of Object.entries(points)) {
          if (score > highestScore) { highestScore = score; winner = username; }
        }
        if (winner) {
          await this.env.QUESTIONS.put(CONSTANTS.QUIZ_LAST_WEEK_WINNER,
            JSON.stringify({ username: winner, score: highestScore, week: savedWeek || currentWeek }));
          this._broadcastToRoom(QUIZ_ROOM, ["quizLastWeekWinner", winner, highestScore, savedWeek || currentWeek]);
        }
        await this.env.QUESTIONS.put(CONSTANTS.QUIZ_POINT_KEY, JSON.stringify({}));
        await this.env.QUESTIONS.put(CONSTANTS.QUIZ_WEEK_KEY, currentWeek);
        return true;
      }
      return false;
    } catch(e) { return false; }
  }

  _startQuizScheduler() {
    if (this.quizAutoTimer) clearInterval(this.quizAutoTimer);
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
        const timeInfo = this._getTimeLeftUntilNextEvent();
        if (!timeInfo.isRunning) this._broadcastQuizTimeLeft();
      } catch(e) {}
    }, CONSTANTS.SCHEDULER_INTERVAL_MS);
  }

  async _checkQuizAutoStatus() {
    try {
      const isQuizTime = this._isQuizTime();
      const wibTime = this._getCurrentWIBTime();
      if (isQuizTime) {
        if (!this.quizAutoEnabled) {
          this.quizAutoEnabled = true;
          this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", `⏳ Quiz will start soon!`, false]);
          await this.startQuizWithDelay(CONSTANTS.QUIZ_START_DELAY_MS);
          if (!this._quizStartTimeout) this.forceStartQuiz();
        } else if (!this.currentQuestion && !this._quizTimeout && !this.isQuizWaiting && !this._quizStartTimeout) {
          await this._showQuestion();
        }
        return false;
      } else {
        if (this.quizAutoEnabled) {
          this.quizAutoEnabled = false;
          await this.resetQuiz();
          const timeInfo = this._getTimeLeftUntilNextEvent();
          const { hours, minutes } = timeInfo;
          let timeStr = hours > 0 ? (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`) :
            minutes > 0 ? `${minutes}m` : "less than 1 minute";
          const statusMsg = timeInfo.status === 'before' ?
            `⏳ ${timeStr}` :
            `⏸️ ${timeStr}`;
          this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", statusMsg, true]);
        }
        return true;
      }
    } catch(e) { return true; }
  }

  forceStartQuiz() {
    if (!this._isQuizTime() || this.currentQuestion || this._quizTimeout || this.isQuizWaiting || this._quizStartTimeout) {
      return false;
    }
    if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) {
      this._initQuiz().then(() => this._showQuestion());
      return false;
    }
    this.quizAutoEnabled = true;
    this._showQuestion();
    return true;
  }

  _checkAndRestartQuiz() {
    try {
      if (!this._isQuizTime()) return;
      if (!this.currentQuestion && !this.isQuizWaiting && !this._quizTimeout && !this._quizBreakTimeout) {
        this.quizAutoEnabled = true;
        this._showQuestion();
      }
    } catch(e) {}
  }

  ensureQuizRunning() {
    try {
      this._forceStartQuizIfTime();
      if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) {
        this._initQuiz().then(() => { if (!this.closing && !this.isDestroyed) this.forceStartQuiz(); });
        return;
      }
      if (!this.currentQuestion && !this._quizTimeout && !this.isQuizWaiting && !this._quizStartTimeout) {
        this.forceStartQuiz();
      }
      if (!this._quizKeepAliveInterval) this._startQuizKeepAlive();
    } catch(e) {}
  }

  _forceStartQuizIfTime() {
    if (!this._isQuizTime() || this.currentQuestion || this._quizTimeout || this.isQuizWaiting || this._quizStartTimeout) return;
    this.quizAutoEnabled = true;
    this._showQuestion();
  }

  async _loadAllQuestionsFromKV() {
    if (!this.env?.QUESTIONS) return false;
    try {
      this._incrementSubRequest();
      const cached = await this.env.QUESTIONS.get('quiz_questions', 'json');
      if (cached?.questions?.length > 0) {
        this._allQuestions = cached.questions.map((q, index) => ({
          id: index + 1,
          question: q.question || '',
          options: q.options || { A: '', B: '', C: '', D: '' },
          correct: q.correct || 'A',
          category: q.category || 'General',
          difficulty: q.difficulty || 'medium'
        }));

        this._allQuestions = this._shuffleArray(this._allQuestions);

        this._isAllQuestionsLoaded = true;
        this._currentBatchStart = 0;
        this._currentBatchEnd = 0;
        this._questionPointer = 0;
        this._totalQuestionsAnswered = 0;
        this._currentBatchIndex = 0;
        this._usedQuestionIndices = new Set();
        this._loadNextBatch();
        return true;
      }
      return false;
    } catch(e) { return false; }
  }

  _loadNextBatch() {
    if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) return false;
    const totalQuestions = this._allQuestions.length;

    if (this._usedQuestionIndices.size >= totalQuestions) {
      this._usedQuestionIndices = new Set();
      this._allQuestions = this._shuffleArray(this._allQuestions);
      this._currentBatchStart = 0;
      this._currentBatchEnd = 0;
      this._questionPointer = 0;
      this._totalQuestionsAnswered = 0;
      this._currentBatchIndex = 0;
    }

    let startIndex = this._currentBatchEnd;
    if (startIndex >= totalQuestions) {
      startIndex = 0;
      this._currentBatchStart = 0;
      this._currentBatchEnd = 0;
      this._questionPointer = 0;
    }

    const endIndex = Math.min(startIndex + CONSTANTS.QUIZ_BATCH_SIZE, totalQuestions);
    this.quizQuestionCache['en'] = this._allQuestions.slice(startIndex, endIndex);
    this._currentQuestions = this.quizQuestionCache['en'];
    this._currentBatchStart = startIndex;
    this._currentBatchEnd = endIndex;
    this._currentBatchIndex = Math.floor(startIndex / CONSTANTS.QUIZ_BATCH_SIZE);
    this._lastLoadedBatch = this._currentBatchIndex;
    return true;
  }

  _checkAndLoadNextBatch() {
    const questions = this.quizQuestionCache['en'] || [];
    if (this._questionPointer >= questions.length) {
      this._loadNextBatch();
      const newQuestions = this.quizQuestionCache['en'] || [];
      if (this._currentBatchStart === 0 && newQuestions.length > 0) this._questionPointer = 0;
      return true;
    }
    return false;
  }

  _getRandomQuestion() {
    const questions = this.quizQuestionCache['en'] || [];
    if (questions.length === 0) return null;

    const totalQuestions = this._allQuestions.length;

    if (this._usedQuestionIndices.size >= totalQuestions) {
      this._usedQuestionIndices = new Set();
      this._allQuestions = this._shuffleArray(this._allQuestions);
      this._loadNextBatch();
    }

    const availableIndices = [];
    const batchStart = this._currentBatchStart;
    const batchEnd = this._currentBatchEnd;

    for (let i = batchStart; i < batchEnd && i < totalQuestions; i++) {
      if (!this._usedQuestionIndices.has(i)) {
        availableIndices.push(i);
      }
    }

    if (availableIndices.length === 0) {
      for (let i = 0; i < totalQuestions; i++) {
        if (!this._usedQuestionIndices.has(i)) {
          availableIndices.push(i);
        }
      }
    }

    if (availableIndices.length === 0) {
      this._usedQuestionIndices = new Set();
      this._allQuestions = this._shuffleArray(this._allQuestions);
      this._loadNextBatch();
      return this._getRandomQuestion();
    }

    const randomIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
    this._usedQuestionIndices.add(randomIndex);
    this._questionPointer++;
    this._totalQuestionsAnswered++;

    return this._allQuestions[randomIndex];
  }

  async _showQuestion() {
    try {
      this._lastActivityTime = Date.now();
      this._isQuizIdle = false;

      if (!this._isQuizTime()) {
        const clients = this.wsClients.get(QUIZ_ROOM);
        if (clients?.size > 0) this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", "⏸️ Quiz is offline.", true]);
        return;
      }

      if (!this.quizAutoEnabled) {
        this.quizAutoEnabled = true;
        const clients = this.wsClients.get(QUIZ_ROOM);
        if (clients?.size > 0) this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", "⏳ Quiz will start soon!", true]);
        return;
      }

      if (this.isDestroyed || this.isQuizWaiting || this._quizStartTimeout || this.currentQuestion) return;
      if (this._isSwitchingToQuiz) return;

      this._resetQuizState();

      this._checkAndLoadNextBatch();

      const q = this._getRandomQuestion();
      if (!q || !q.options) {
        this._broadcastToRoom(QUIZ_ROOM, ["quizError", "No questions available!"]);
        return;
      }

      const shuffled = this._shuffleQuestionOptions(q);
      this.currentQuestion = { ...q, options: shuffled.options, correct: shuffled.correct };
      this._quizStartTime = Date.now();

      await this._broadcastQuizQuestion(this.currentQuestion.question, this.currentQuestion.options);
      this._broadcastToRoom(QUIZ_ROOM, [
        "quizTimeLeft",
        `📝 ${CONSTANTS.QUIZ_TIME_LIMIT_MS/1000}s remaining`,
        false
      ]);

      if (this._quizTimeout) clearTimeout(this._quizTimeout);
      if (this._quizBreakTimeout) clearTimeout(this._quizBreakTimeout);

      this._quizTimeout = setTimeout(async () => {
        try {
          if (this.closing || this.isDestroyed) { this._quizTimeout = null; return; }
          await this._evaluateQuizWithLock();
          this._quizTimeout = null;
        } catch(e) {
          this._quizTimeout = null;
          this.currentQuestion = null;
          this.isQuizWaiting = false;
        }
      }, CONSTANTS.QUIZ_TIME_LIMIT_MS);

    } catch(e) {
      this.currentQuestion = null;
      this.isQuizWaiting = false;
      this._quizTimeout = null;
    }
  }

  async _evaluateQuizWithLock() {
    if (this._quizState.isEvaluating || this._quizState.isEvaluated) {
      return null;
    }

    this._quizState.isEvaluating = true;
    this._quizState.evaluationStartTime = Date.now();

    try {
      const result = await this._executeQuizEvaluation();
      this._quizState.isEvaluated = true;
      this._quizState.lastEvaluationResult = result;
      return result;
    } catch(e) {
      throw e;
    } finally {
      this._quizState.isEvaluating = false;
    }
  }

  async _executeQuizEvaluation() {
    if (!this.currentQuestion) return null;
    if (this._quizState.isEvaluated) return null;

    const correctAnswer = this.currentQuestion.correct;
    const question = this.currentQuestion.question;
    const options = this.currentQuestion.options;

    if (this.quizHasWinner && this.quizWinner) {
      const points = await this._getQuizPoints();
      points[this.quizWinner] = (points[this.quizWinner] || 0) + 1;
      if (this.env?.QUESTIONS) {
        this._incrementSubRequest();
        await this.env.QUESTIONS.put(CONSTANTS.QUIZ_POINT_KEY, JSON.stringify(points));
      }
      this._broadcastQuizResult("quizWinner", {
        username: this.quizWinner,
        totalPoints: points[this.quizWinner] || 0,
        correctAnswer
      });
    } else {
      this._broadcastQuizResult("quizNoWinner", {
        message: "No one answered correctly!",
        correctAnswer
      });
    }

    this._broadcastQuizResult("quizCorrectAnswer", { question, options, correctAnswer });
    this.currentQuestion = null;
    this._quizStartTime = null;
    this.isQuizWaiting = true;

    if (this._quizBreakTimeout) clearTimeout(this._quizBreakTimeout);
    this._quizBreakTimeout = setTimeout(() => {
      if (this.closing || this.isDestroyed) { this._quizBreakTimeout = null; return; }
      this.isQuizWaiting = false;
      this._quizBreakTimeout = null;
      this._resetQuizState();
      this._broadcastToRoom(QUIZ_ROOM, ["quizNextQuestionIn", "5"]);
      setTimeout(() => this._broadcastToRoom(QUIZ_ROOM, ["quizNextQuestionIn", "3"]), 2000);
      setTimeout(() => this._broadcastToRoom(QUIZ_ROOM, ["quizNextQuestionIn", "1"]), 4000);
      if (!this.closing && !this.isDestroyed) this.ensureQuizRunning();
    }, CONSTANTS.QUIZ_BREAK_MS);

    return { winner: this.quizWinner, points: this.quizWinner ? points[this.quizWinner] : 0 };
  }

  async _forceEvaluateQuiz() {
    if (this._quizState.isEvaluating || this._quizState.isEvaluated) return;
    if (this._quizTimeout) {
      clearTimeout(this._quizTimeout);
      this._quizTimeout = null;
    }
    await this._evaluateQuizWithLock();
  }

  async submitQuizAnswer(ws, username, answer) {
    try {
      if (!ws || !username) {
        this._sendQuizErrorWithTime(ws, "ERROR", "Invalid request");
        return;
      }

      const room = this._ensureRoomConsistency(ws);
      if (room !== QUIZ_ROOM) {
        this._safeSend(ws, ["quizError", "Quiz only available in Quiz room"]);
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
      if (!clients?.size) {
        this._sendQuizErrorWithTime(ws, "ERROR", "Quiz is paused");
        return;
      }

      if (this._quizState.isEvaluated) {
        this._safeSend(ws, ["quizError", "Question already ended"]);
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

      this._broadcastQuizResult("quizAnswerResult", {
        username,
        answer: isValidAnswer ? answerKey : "?",
        isCorrect,
        correctAnswer: this.currentQuestion.correct
      });
      this.quizAnswered.add(username);

      if (isCorrect && !this.quizHasWinner && !this._quizState.isEvaluated) {
        this.quizHasWinner = true;
        this.quizWinner = username;

        this._broadcastQuizResult("quizWinner", {
          username: username,
          correctAnswer: this.currentQuestion.correct
        });

        if (this._quizTimeout) {
          clearTimeout(this._quizTimeout);
          this._quizTimeout = null;
        }
        await this._evaluateQuizWithLock();
      }

      const totalPlayers = clients.size;
      const answeredCount = this.quizAnswered.size;
      if (!this.quizHasWinner && answeredCount >= totalPlayers) {
        if (this._quizTimeout) {
          clearTimeout(this._quizTimeout);
          this._quizTimeout = null;
        }
        await this._evaluateQuizWithLock();
      }

    } catch(e) {
      this._safeSend(ws, ["quizError", "Error submitting answer"]);
    }
  }

  _startQuizLoop() {
    if (this.quizTimer) clearInterval(this.quizTimer);
    this.quizTimer = setInterval(() => {
      if (this.closing || this.isDestroyed) { clearInterval(this.quizTimer); this.quizTimer = null; return; }
      if (this._isQuizTime()) {
        if (!this.quizAutoEnabled) {
          this.quizAutoEnabled = true;
          this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", "⏳ Quiz will start soon!", true]);
        }
        if (!this.currentQuestion && !this._quizTimeout && !this.isQuizWaiting && !this._quizStartTimeout) {
          this._showQuestion();
        }
      } else {
        if (this.quizAutoEnabled) {
          this.quizAutoEnabled = false;
          this.resetQuiz();
          this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", "⏸️ Quiz has ended. See you tomorrow!", true]);
        }
      }
    }, CONSTANTS.QUIZ_INTERVAL_MS);
  }

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
      this._resetQuizState();
      this._usedQuestionIndices = new Set();
    } catch(e) {}
  }

  async startQuizWithDelay(delayMs) {
    if (this._quizStartTimeout) return;
    this._quizStartTimeout = setTimeout(() => {
      if (this.closing || this.isDestroyed) { this._quizStartTimeout = null; return; }
      this._quizStartTimeout = null;
      if (!this.currentQuestion && this.quizAutoEnabled) this.forceStartQuiz();
    }, delayMs);
  }

  _startQuizIfNeeded() {
    try {
      const clients = this.wsClients.get(QUIZ_ROOM);
      if (!clients?.size) return;
      if (!this.currentQuestion && !this._quizTimeout && !this.isQuizWaiting && !this._quizStartTimeout) {
        if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) {
          this._initQuiz().then(() => { if (!this.closing && !this.isDestroyed) this._showQuestion(); });
          return;
        }
        this._showQuestion();
      }
    } catch(e) {}
  }

  async _initQuiz(retryCount = 0) {
    try {
      const loaded = await this._loadAllQuestionsFromKV();
      if (loaded) {
        this._startQuizLoop();
        this.translationManager._startTranslateReset();
        this._startQuizKeepAlive();
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

  _startQuizKeepAlive() {
    if (this._quizKeepAliveInterval) clearInterval(this._quizKeepAliveInterval);
    this._quizKeepAliveInterval = setInterval(() => {
      if (this.closing || this.isDestroyed) {
        clearInterval(this._quizKeepAliveInterval);
        this._quizKeepAliveInterval = null;
        return;
      }
      if (this._isQuizTime()) {
        const now = Date.now();
        if (this.currentQuestion && this._quizStartTime) {
          const elapsed = (now - this._quizStartTime) / 1000;
          if (elapsed >= (CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000) &&
              !this._quizState.isEvaluated && !this._quizState.isEvaluating) {
            if (this._quizTimeout) {
              clearTimeout(this._quizTimeout);
              this._quizTimeout = null;
            }
            this._forceEvaluateQuiz();
          }
        }
        if (!this.currentQuestion && !this._quizTimeout && !this.isQuizWaiting && !this._quizStartTimeout) {
          if (this.quizAutoEnabled) this._showQuestion();
          else { this.quizAutoEnabled = true; this._showQuestion(); }
        }
      }
    }, CONSTANTS.QUIZ_KEEP_ALIVE_INTERVAL_MS);
  }

  async _broadcastQuizQuestion(question, options) {
    const wsIds = this.wsClients.get(QUIZ_ROOM);
    if (!wsIds?.size) return;

    const usersByLang = new Map();
    for (const wsId of wsIds) {
      try {
        const ws = this.wsMap.get(wsId);
        if (!ws || ws.readyState !== 1) continue;
        const lang = this.userLanguage.get(wsId) || 'en';
        if (!usersByLang.has(lang)) usersByLang.set(lang, []);
        usersByLang.get(lang).push(ws);
      } catch(e) {}
    }

    if (usersByLang.size === 0) return;

    await this.translationManager.translateForUsersSync(question, options, usersByLang);
  }

  async _broadcastQuizResult(type, data) {
    const wsIds = this.wsClients.get(QUIZ_ROOM);
    if (!wsIds?.size) return;
    const msgStr = JSON.stringify([type, data]);
    const wsIdArray = Array.from(wsIds);
    const batchSize = CONSTANTS.BROADCAST_BATCH_SIZE;
    this._startCPUTimer();
    for (let i = 0; i < wsIdArray.length; i += batchSize) {
      const batch = wsIdArray.slice(i, i + batchSize);
      for (const wsId of batch) {
        try {
          const ws = this.wsMap.get(wsId);
          if (ws && ws.readyState === 1) ws.send(msgStr);
        } catch(e) {}
      }
      if (this._checkCPULimit()) { await this._cpuYield(); this._startCPUTimer(); }
    }
  }

  _sendQuizTimeLeftToUser(ws) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      const wsId = this._getWsId(ws);
      if (!wsId) return false;
      
      const timeInfo = this._getTimeLeftUntilNextEvent();
      let message = "", canType = true, isQuizTime = timeInfo.isRunning;
      
      if (isQuizTime) {
        this._timeLeftSentCount.delete(wsId);
        
        if (this.currentQuestion && this._quizStartTime) {
          const elapsed = (Date.now() - this._quizStartTime) / 1000;
          const left = Math.max(0, (CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000) - elapsed);
          const minutes = Math.floor(left / 60), seconds = Math.floor(left % 60);
          message = minutes > 0 ? `📝 ${minutes}m ${seconds}s remaining` : `📝 ${seconds}s remaining`;
          canType = false;
        } else if (this.isQuizWaiting) {
          message = `⏳ Preparing next question...`;
          canType = false;
        } else {
          message = `⏳ Quiz will start soon!`;
          canType = true;
        }
        this._safeSend(ws, ["quizTimeLeft", message, canType, isQuizTime]);
        this._safeSend(ws, ["quizStatus", {
          isRunning: true,
          currentQuestion: !!this.currentQuestion,
          isWaiting: this.isQuizWaiting,
          timeLeft: this.currentQuestion && this._quizStartTime ?
            Math.max(0, (CONSTANTS.QUIZ_TIME_LIMIT_MS - (Date.now() - this._quizStartTime)) / 1000) : 0,
          totalQuestions: this._allQuestions.length || 0,
          answeredQuestions: this._totalQuestionsAnswered || 0
        }]);
        return false;
      } else {
        const sentData = this._timeLeftSentCount.get(wsId) || { count: 0 };
        if (sentData.count >= 2) {
          const { hours, minutes, startTime } = timeInfo;
          this._safeSend(ws, ["quizStatus", {
            isRunning: false,
            currentQuestion: false,
            isWaiting: false,
            timeLeft: 0,
            nextQuizIn: (hours * 3600) + (minutes * 60),
            nextQuizTime: startTime,
            totalQuestions: this._allQuestions.length || 0
          }]);
          return true;
        }
        
        const { hours, minutes } = timeInfo;
        const totalSeconds = (hours * 3600) + (minutes * 60);
        let countdownText = totalSeconds <= 0 ? "Soon!" :
          hours > 0 ? (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`) :
          minutes > 0 ? `${minutes}m` : "Less than 1 minute";
        
        message = timeInfo.status === 'before' ? `⏳ ${countdownText}` : `⏸️ ${countdownText}`;
        
        sentData.count += 1;
        this._timeLeftSentCount.set(wsId, sentData);
        
        canType = true;
        this._safeSend(ws, ["quizTimeLeft", message, canType, isQuizTime]);
        this._safeSend(ws, ["quizStatus", {
          isRunning: false,
          currentQuestion: false,
          isWaiting: false,
          timeLeft: 0,
          nextQuizIn: totalSeconds,
          nextQuizTime: timeInfo.startTime,
          totalQuestions: this._allQuestions.length || 0
        }]);
        return true;
      }
    } catch(e) { return true; }
  }

  _sendCurrentQuestionToUser(ws) {
    if (!ws || ws.readyState !== 1) return;
    if (!this.currentQuestion) return;
    if (this._isSwitchingToQuiz) return;

    try {
      const wsId = this._getWsId(ws);
      if (!wsId) return;
      const lang = this.userLanguage.get(wsId) || 'en';
      const question = this.currentQuestion.question;
      const options = this.currentQuestion.options;

      if (lang === 'en') {
        this._safeSend(ws, ["quizQuestion", { question, options, isFallback: false }]);
      } else {
        this.translationManager._translateText(question, lang).then(translatedQ => {
          this.translationManager._translateOptions(options, lang).then(translatedOpts => {
            this._safeSend(ws, ["quizQuestion", {
              question: translatedQ || question,
              options: translatedOpts || options,
              isFallback: false
            }]);
          });
        }).catch(() => {
          this._safeSend(ws, ["quizQuestion", { question, options, isFallback: true }]);
        });
      }

      if (this._quizStartTime) {
        const elapsed = (Date.now() - this._quizStartTime) / 1000;
        const left = Math.max(0, (CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000) - elapsed);
        const minutes = Math.floor(left / 60);
        const seconds = Math.floor(left % 60);
        const timeMsg = minutes > 0 ? `⏱️ ${minutes}m ${seconds}s remaining` : `⏱️ ${seconds}s remaining`;
        this._safeSend(ws, ["quizTimeLeft", timeMsg, false, true]);
      }
    } catch(e) {}
  }

  _broadcastQuizTimeLeft() {
    const wsIds = this.wsClients.get(QUIZ_ROOM);
    if (!wsIds?.size) return;
    const timeInfo = this._getTimeLeftUntilNextEvent();
    let message = "", canType = true, isQuizTime = timeInfo.isRunning;
    if (isQuizTime) {
      if (this.currentQuestion && this._quizStartTime) {
        const elapsed = (Date.now() - this._quizStartTime) / 1000;
        const left = Math.max(0, (CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000) - elapsed);
        const minutes = Math.floor(left / 60), seconds = Math.floor(left % 60);
        message = minutes > 0 ? `📝 ${minutes}m ${seconds}s remaining` : `📝 ${seconds}s remaining`;
        canType = false;
      } else if (this.isQuizWaiting) {
        message = `⏳ Preparing next question...`;
        canType = false;
      } else {
        message = `⏳ Quiz will start soon!`;
        canType = true;
      }
    } else {
      for (const wsId of wsIds) {
        const sentData = this._timeLeftSentCount.get(wsId) || { count: 0 };
        if (sentData.count < 2) {
          const ws = this.wsMap.get(wsId);
          if (ws && ws.readyState === 1) {
            this._sendQuizTimeLeftToUser(ws);
          }
        }
      }
      return;
    }
    this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", message, canType, isQuizTime]);
  }

  _sendQuizErrorWithTime(ws, errorType, customMessage = null) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      const timeInfo = this._getTimeLeftUntilNextEvent();
      let message = "";
      switch(errorType) {
        case "NOT_QUIZ_TIME":
          if (timeInfo.status === 'before') {
            const { hours, minutes } = timeInfo;
            let timeStr = hours > 0 ? (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`) :
              minutes > 0 ? `${minutes}m` : "less than 1 minute";
            message = `⏳ ${timeStr}`;
          } else {
            const { hours, minutes } = timeInfo;
            let timeStr = hours > 0 ? (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`) :
              minutes > 0 ? `${minutes}m` : "less than 1 minute";
            message = `⏸️ ${timeStr}`;
          }
          break;
        case "QUIZ_DISABLED": 
          message = "❌ Quiz is currently unavailable"; 
          break;
        case "QUIZ_ENDED":
          const { hours, minutes } = timeInfo;
          let timeStr = hours > 0 ? (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`) :
            minutes > 0 ? `${minutes}m` : "less than 1 minute";
          message = `⏸️ ${timeStr}`;
          break;
        case "QUIZ_NOT_STARTED": 
          message = `⏳ Quiz will start soon`; 
          break;
        default: 
          message = customMessage || "❌ An error occurred in the Quiz";
      }
      this._safeSend(ws, ["quizError", message]);
      return true;
    } catch(e) { 
      this._safeSend(ws, ["quizError", "❌ Quiz error"]);
      return false; 
    }
  }

  _getWsId(ws) { return ws?._wsId || null; }

  _getRoomForWs(ws) {
    if (!ws) return null;
    return ws.room || ws.roomname || null;
  }

  _ensureRoomConsistency(ws) {
    if (!ws) return null;
    if (ws.room || ws.roomname) {
      const room = ws.room || ws.roomname;
      const wsId = this._getWsId(ws);
      if (wsId) {
        const mappedRoom = this.clientRooms.get(wsId);
        if (mappedRoom && mappedRoom !== room) {
          this._removeClientFromRoom(mappedRoom, wsId);
          this._addClient(room, ws, ws.username, false);
        } else if (!mappedRoom) {
          this._addClient(room, ws, ws.username, false);
        }
        return room;
      }
      return room;
    }
    const wsId = this._getWsId(ws);
    if (!wsId) return null;
    let room = this.clientRooms.get(wsId);
    if (!room) {
      if (ws.username) {
        const conn = this.userConnections.get(ws.username);
        if (conn) room = conn.room;
      }
    }
    if (room) {
      ws.room = room;
      ws.roomname = room;
    }
    return room || null;
  }

  _addClient(room, ws, username = null, isNewConnection = false) {
    if (!ws) return;
    const wsId = this._getWsId(ws);
    if (!wsId) { this._safeSend(ws, ["gameLowCardError", "Connection error"]); return; }

    ws.room = room;
    ws.roomname = room;
    ws.username = username;

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
      if (conn) { conn.room = room; conn.timestamp = Date.now(); conn.ws = ws; conn.wsId = wsId; }
      else { this.userConnections.set(username, { wsId, ws, room, timestamp: Date.now() }); }
    }

    if (!this.wsClients.has(room)) this.wsClients.set(room, new Set());
    this.wsClients.get(room).add(wsId);
    this.clientRooms.set(wsId, room);
    this.wsMap.set(wsId, ws);

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
    this._timeLeftSentCount.delete(wsId);
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
  }

  _setUserLanguage(ws, countryCode) {
    if (!ws) return 'en';
    const wsId = this._getWsId(ws);
    if (!wsId) return 'en';
    this.userCountry.set(wsId, countryCode);
    const lang = this._countryToLanguage(countryCode);
    this.userLanguage.set(wsId, lang);
    return lang;
  }

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

  async switchRoom(ws, room, username = null) {
    if (this.isDestroyed) { this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]); return; }
    if (!room || room.trim() === "") { this._safeSend(ws, ["gameLowCardError", "Invalid room name"]); return; }

    const roomName = room.trim();
    const wsId = this._getWsId(ws);
    if (!wsId) { this._safeSend(ws, ["gameLowCardError", "Connection error"]); return; }

    this._timeLeftSentCount.delete(wsId);

    const lockKey = `switch_${wsId}`;
    if (this._switchLocks.has(lockKey)) { this._safeSend(ws, ["gameLowCardError", "Switch in progress"]); return; }
    this._switchLocks.set(lockKey, Date.now());

    try {
      const oldRoom = this.clientRooms.get(wsId);

      ws.room = roomName;
      ws.roomname = roomName;
      ws.username = username;

      if (oldRoom) {
        this._removeClientFromRoom(oldRoom, wsId);
      }

      this._addClient(roomName, ws, username, false);

      if (username) {
        let conn = this.userConnections.get(username);
        if (conn) { conn.room = roomName; conn.wsId = wsId; conn.ws = ws; conn.timestamp = Date.now(); }
        else { this.userConnections.set(username, { wsId, ws, room: roomName, timestamp: Date.now() }); }
      }

      this._safeSend(ws, ["switchRoomSuccess", roomName]);

      if (roomName === QUIZ_ROOM) {
        this._isSwitchingToQuiz = true;

        if (this._switchQuizTimeout) {
          clearTimeout(this._switchQuizTimeout);
          this._switchQuizTimeout = null;
        }

        let country = this.userCountry.get(wsId);
        if (!country) { const cf = ws._cf || {}; country = cf.country || 'US'; this.userCountry.set(wsId, country); }
        const lang = this._setUserLanguage(ws, country);
        this._safeSend(ws, ["userLanguage", lang]);

        if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) {
          await this._initQuiz();
        }

        this._sendQuizTimeLeftToUser(ws);

        this._switchQuizTimeout = setTimeout(() => {
          this._isSwitchingToQuiz = false;
          this._switchQuizTimeout = null;

          if (!this.closing && !this.isDestroyed) {
            if (this.currentQuestion) {
              this._sendCurrentQuestionToUser(ws);
            }
            this._sendQuizTimeLeftToUser(ws);
          }
        }, 1000);

        this._getLastWeekWinner().then(winner => {
          if (winner) {
            this._safeSend(ws, ["quizLastWeekWinner", winner.username, winner.score, winner.week]);
          }
        });

        this._getQuizPoints().then(points => {
          const sorted = Object.entries(points)
            .map(([username, score]) => ({ username, score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);
          const result = sorted.map(item => `${item.username}|${item.score}`);
          this._safeSend(ws, ["quizLeaderboard", result]);
        });
      }

      this._broadcastToRoom(roomName, ["userJoinedRoom", username, roomName]);
      if (oldRoom) this._broadcastToRoom(oldRoom, ["userLeftRoom", username, oldRoom]);

    } finally {
      this._switchLocks.delete(lockKey);
    }
  }

  async _broadcastToRoom(room, message) {
    if (this.closing || this.isDestroyed || !room || !message) return;
    const wsIds = this.wsClients.get(room);
    if (!wsIds?.size) return;

    const msgStr = JSON.stringify(message);
    const wsIdArray = Array.from(wsIds);
    const batchSize = CONSTANTS.BROADCAST_BATCH_SIZE;
    this._startCPUTimer();

    for (let i = 0; i < wsIdArray.length; i += batchSize) {
      const batch = wsIdArray.slice(i, i + batchSize);
      for (const wsId of batch) {
        const ws = this.wsMap.get(wsId);
        if (ws && ws.readyState === 1) {
          try { ws.send(msgStr); } catch(e) {}
        }
      }
      if (this._checkCPULimit()) { await this._cpuYield(); this._startCPUTimer(); }
    }
  }

  _safeSend(ws, message) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(message)); return true; } catch(e) { return false; }
  }

  _isGameActuallyRunning(game) { return game?._isActive === true && !game?._gameEnded; }

  _isGameValid(game) { return game?._isActive === true && !game?._gameEnded && game?.players?.size > 0; }

  _getActivePlayers(game) {
    if (!game?._isActive || game?._gameEnded || !game?.players) return [];
    return Array.from(game.players.entries())
      .filter(([id]) => !game.eliminated?.has(id))
      .map(([, p]) => p);
  }

  _getActivePlayerIds(game) {
    if (!game?._isActive || game?._gameEnded || !game?.players) return [];
    return Array.from(game.players.keys()).filter(id => !game.eliminated?.has(id));
  }

  _getRandomCardTanda() { return ["C1", "C2", "C3", "C4"][Math.floor(Math.random() * 4)]; }

  _getRandomDrawDelay() { return (Math.floor(Math.random() * 14) + 2) * 1000; }

  _getBotNumberByRound(round) {
    if (round <= 2) return Math.floor(Math.random() * 12) + 1;
    return Math.random() < 0.6 ?
      [8, 9, 10, 11, 12][Math.floor(Math.random() * 5)] :
      [1, 2, 3, 4, 5, 6, 7][Math.floor(Math.random() * 7)];
  }

  _safeGetGame(room) {
    if (this.isDestroyed || !room) return null;
    const game = this.activeGames.get(room);
    if (game?._isActive && !game?._gameEnded && game?.players) return game;
    return null;
  }

  _scheduleGameCleanup(room, game) {
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
        if (currentGame?._isActive && !currentGame._gameEnded) { this._cleanupTimers.delete(room); return; }
        this._cleanupTimers.delete(room);
        const gameToDelete = this.activeGames.get(room);
        if (gameToDelete) this._deleteGame(room, gameToDelete);
      } catch(e) {}
    }, CONSTANTS.GAME_CLEANUP_DELAY_MS);
    this._cleanupTimers.set(room, timer);
  }

  _cleanupGame(game) {
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
  }

  _deleteGame(room, game) {
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
  }

  _removePlayerFromGame(username, room) {
    try {
      const game = this.activeGames.get(room);
      if (!game || !game.players?.has(username) || !game._isActive || game._gameEnded || game._isEvaluating || game.evaluationLocked) return false;
      if (!game.eliminated) game.eliminated = new Set();
      game.eliminated.add(username);
      game.numbers?.delete(username);
      game.tanda?.delete(username);
      this._broadcastToRoom(room, ["gameLowCardError", `${username} has been eliminated`]);
      setTimeout(() => {
        try {
          const currentGame = this.activeGames.get(room);
          if (currentGame && currentGame === game && !game._gameEnded) this._checkGameCanContinue(room, game);
        } catch(e) {}
      }, 1000);
      return true;
    } catch(e) { return false; }
  }

  _checkGameCanContinue(room, game) {
    try {
      if (!game?._isActive || game._gameEnded || !game.players || game._isEvaluating || game.evaluationLocked || game.registrationOpen) return;
      const activePlayers = this._getActivePlayers(game);
      if (activePlayers.length === 0) {
        const allPlayers = Array.from(game.players.keys());
        const submitted = Array.from(game.numbers?.keys() || []);
        const notSubmitted = allPlayers.filter(id => !submitted.includes(id) && !game.eliminated?.has(id));
        if (notSubmitted.length > 0) return;
        game._gameEnded = true;
        game._isActive = false;
        game._endTime = Date.now();
        this._broadcastToRoom(room, ["gameLowCardEnd", []]);
        this._scheduleGameCleanup(room, game);
        return;
      }
      if (activePlayers.length === 1 && !game._gameEnded) {
        const activeIds = this._getActivePlayerIds(game);
        const submittedIds = Array.from(game.numbers?.keys() || []);
        const notSubmitted = activeIds.filter(id => !submittedIds.includes(id));
        if (notSubmitted.length > 0) { this._broadcastToRoom(room, ["gameLowCardTimeLeft", `Waiting for ${notSubmitted.length} player(s)`]); return; }
        const winner = activePlayers[0]?.name || "Unknown";
        const totalCoin = (game.betAmount || 0) * (game.players?.size || 0);
        game._gameEnded = true;
        game._isActive = false;
        game._endTime = Date.now();
        this._broadcastToRoom(room, ["gameLowCardWinner", winner, totalCoin]);
        this._scheduleGameCleanup(room, game);
      }
    } catch(e) {}
  }

  _findAllGamesByUsername(username) {
    if (!username) return [];
    const result = [];
    for (const [room, game] of this.activeGames) {
      if (game?._isActive && !game._gameEnded && game.players?.has(username)) {
        result.push({ game, room });
      }
    }
    return result;
  }

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

  _startBotDraws(room, game) {
    try {
      if (!this._isGameActuallyRunning(game) || !game.botPlayers) return;
      if (!game._botTimeouts) game._botTimeouts = new Set();
      const notDrawn = Array.from(game.botPlayers.keys())
        .filter(id => !game.eliminated?.has(id) && !game.numbers?.has(id))
        .slice(0, CONSTANTS.MAX_BOT_DRAWS_PER_ROUND);
      for (const botId of notDrawn) {
        const delay = this._getRandomDrawDelay();
        const timeout = setTimeout(() => {
          try {
            const currentGame = this.activeGames.get(room);
            if (this._isGameActuallyRunning(currentGame) && !currentGame.drawTimeExpired &&
                !currentGame.evaluationLocked && !currentGame.numbers?.has(botId) && !currentGame.eliminated?.has(botId)) {
              this._handleBotDraw(room, botId, currentGame);
            }
            currentGame?._botTimeouts?.delete(timeout);
          } catch(e) {}
        }, delay);
        game._botTimeouts.add(timeout);
      }
    } catch(e) {}
  }

  _handleBotDraw(room, botId, game) {
    try {
      if (!this._isGameActuallyRunning(game) || game.numbers?.has(botId) || game.drawTimeExpired || game.evaluationLocked) return;
      if (game.eliminated?.has(botId)) return;
      const number = this._getBotNumberByRound(game.round);
      const tanda = this._getRandomCardTanda();
      game.numbers.set(botId, number);
      game.tanda.set(botId, tanda);
      const botName = game.players.get(botId)?.name || botId;
      this._broadcastToRoom(room, ["gameLowCardPlayerDraw", botName, number, tanda]);
      const activeIds = this._getActivePlayerIds(game);
      if (game.numbers.size === activeIds.length && !game.evaluationLocked && !game.drawTimeExpired && this._isGameActuallyRunning(game)) {
        game.evaluationLocked = true;
        this._broadcastToRoom(room, ["gameLowCardWait", "Please wait for results..."]);
        game._evalTimer = setTimeout(() => { try { this._evaluateRound(room, game); } catch(e) {} }, CONSTANTS.EVALUATION_DELAY_MS);
      }
    } catch(e) {}
  }

  _forceBotDraw(room, botId, game) {
    try {
      if (!this._isGameActuallyRunning(game) || game.numbers?.has(botId)) return;
      if (game.eliminated?.has(botId)) return;
      const number = this._getBotNumberByRound(game.round);
      const tanda = this._getRandomCardTanda();
      game.numbers.set(botId, number);
      game.tanda.set(botId, tanda);
      const botName = game.players.get(botId)?.name || botId;
      this._broadcastToRoom(room, ["gameLowCardPlayerDraw", botName, number, tanda]);
    } catch(e) {}
  }

  _startRegistration(room, game) {
    if (!this._isGameActuallyRunning(game) || !game.registrationOpen) return;
    if (game._registrationTimer) { clearInterval(game._registrationTimer); game._registrationTimer = null; }
    let timeLeft = 20;
    const timer = setInterval(() => {
      try {
        if (!this._isGameActuallyRunning(game) || !game.registrationOpen || timeLeft < 0) {
          clearInterval(timer);
          if (game._registrationTimer === timer) game._registrationTimer = null;
          return;
        }
        if (timeLeft === 15 || timeLeft === 10 || timeLeft === 5) {
          this._broadcastToRoom(room, ["gameLowCardTimeLeft", `${timeLeft}s`]);
        }
        if (timeLeft === 0) {
          clearInterval(timer);
          game._registrationTimer = null;
          this._broadcastToRoom(room, ["gameLowCardTimeLeft", "TIME UP!"]);
          this._closeRegistration(room, game);
        }
        timeLeft--;
      } catch(e) { clearInterval(timer); if (game._registrationTimer === timer) game._registrationTimer = null; }
    }, 1000);
    game._registrationTimer = timer;
  }

  _closeRegistration(room, game) {
    try {
      if (!this._isGameActuallyRunning(game) || !game.registrationOpen) return;
      game.registrationOpen = false;
      if (game._registrationTimer) { clearInterval(game._registrationTimer); game._registrationTimer = null; }
      const humanPlayers = Array.from(game.players.keys()).filter(id => !id.startsWith('BOT_'));
      const humanCount = humanPlayers.length;
      if (!game._botsAdded) {
        if (humanCount === 1 || humanCount === 0) { this._addBots(room, 4); game._botsAdded = true; }
        else if (game.players.size < 2) {
          const needed = Math.min(4 - game.players.size, CONSTANTS.MAX_BOTS_PER_GAME);
          if (needed > 0) { this._addBots(room, needed); game._botsAdded = true; }
        }
      }
      if (this._isGameActuallyRunning(game) && game.players.size >= 2) {
        this._startDrawPhase(room, game);
      } else {
        game._gameEnded = true;
        game._isActive = false;
        game._endTime = Date.now();
        this._broadcastToRoom(room, ["gameLowCardError", "Not enough players"]);
        this._scheduleGameCleanup(room, game);
      }
    } catch(e) {}
  }

  _startDrawPhase(room, game) {
    try {
      if (!this._isGameActuallyRunning(game)) return;
      if (game._drawTimer) { clearInterval(game._drawTimer); game._drawTimer = null; }
      if (game._evalTimer) { clearTimeout(game._evalTimer); game._evalTimer = null; }
      if (game._botTimeouts) { for (const id of game._botTimeouts) clearTimeout(id); game._botTimeouts.clear(); }

      const activePlayers = this._getActivePlayers(game);
      if (activePlayers.length < 2) {
        if (!game._botsAdded) {
          const needed = Math.min(4 - activePlayers.length, CONSTANTS.MAX_BOTS_PER_GAME);
          if (needed > 0) { this._addBots(room, needed); game._botsAdded = true; }
        }
        const newActive = this._getActivePlayers(game);
        if (newActive.length < 2) {
          if (newActive.length === 1 && !game._gameEnded) {
            const winner = newActive[0]?.name || "Unknown";
            const totalCoin = (game.betAmount || 0) * (game.players?.size || 0);
            game._gameEnded = true;
            game._isActive = false;
            game._endTime = Date.now();
            this._broadcastToRoom(room, ["gameLowCardWinner", winner, totalCoin]);
            this._scheduleGameCleanup(room, game);
          } else {
            game._gameEnded = true;
            game._isActive = false;
            game._endTime = Date.now();
            this._broadcastToRoom(room, ["gameLowCardError", "Not enough players"]);
            this._scheduleGameCleanup(room, game);
          }
          return;
        }
      }

      game._phase = 'draw';
      game.drawTimeExpired = false;
      game.evaluationLocked = false;
      game._drawPhaseStart = Date.now();
      if (!game._botTimeouts) game._botTimeouts = new Set();
      const playersList = this._getActivePlayers(game).map(p => p.name);
      this._broadcastToRoom(room, ["gameLowCardClosed", playersList]);
      this._broadcastToRoom(room, ["gameLowCardNextRound", game.round]);
      this._startDrawCountdown(room, game);
      if (game.botPlayers?.size > 0 && this._isGameActuallyRunning(game)) this._startBotDraws(room, game);
    } catch(e) {}
  }

  _startDrawCountdown(room, game) {
    if (!this._isGameActuallyRunning(game)) return;
    if (game._drawTimer) { clearInterval(game._drawTimer); game._drawTimer = null; }
    let timeLeft = 20;
    const timer = setInterval(() => {
      try {
        if (!this._isGameActuallyRunning(game) || game.drawTimeExpired || timeLeft < 0) {
          clearInterval(timer);
          if (game._drawTimer === timer) game._drawTimer = null;
          return;
        }
        if (timeLeft === 15 || timeLeft === 10 || timeLeft === 5) {
          this._broadcastToRoom(room, ["gameLowCardTimeLeft", `${timeLeft}s`]);
        }
        if (timeLeft === 0) {
          clearInterval(timer);
          game._drawTimer = null;
          this._broadcastToRoom(room, ["gameLowCardTimeLeft", "TIME UP!"]);
          this._closeDrawPhase(room, game);
        }
        timeLeft--;
      } catch(e) { clearInterval(timer); if (game._drawTimer === timer) game._drawTimer = null; }
    }, 1000);
    game._drawTimer = timer;
  }

  _closeDrawPhase(room, game) {
    if (!this._isGameActuallyRunning(game) || game.drawTimeExpired || game.evaluationLocked) return;
    game.drawTimeExpired = true;
    game.evaluationLocked = true;
    if (game._drawTimer) { clearInterval(game._drawTimer); game._drawTimer = null; }
    if (game.botPlayers?.size > 0 && this._isGameActuallyRunning(game)) {
      const activeBotIds = Array.from(game.botPlayers.keys())
        .filter(id => !game.eliminated?.has(id) && !game.numbers?.has(id));
      for (const botId of activeBotIds) this._forceBotDraw(room, botId, game);
    }
    this._broadcastToRoom(room, ["gameLowCardWait", "Please wait for results..."]);
    if (game._evalTimer) { clearTimeout(game._evalTimer); game._evalTimer = null; }
    game._evalTimer = setTimeout(() => {
      try {
        const currentGame = this.activeGames.get(room);
        if (currentGame && currentGame === game && currentGame._isActive && !currentGame._gameEnded) {
          this._evaluateRound(room, game);
        }
      } catch(e) {}
    }, CONSTANTS.EVALUATION_DELAY_MS);
  }

  _evaluateRound(room, game) {
    try {
      if (this.isDestroyed || !game?._isActive || game._gameEnded || game._isEvaluating || !game.players) return;
      const currentGame = this.activeGames.get(room);
      if (currentGame !== game) return;

      game._isEvaluating = true;
      game._safetyTimer = setTimeout(() => {
        try { if (game?._isEvaluating) { game._isEvaluating = false; this._scheduleGameCleanup(room, game); } } catch(e) {}
      }, CONSTANTS.EVALUATION_TIMEOUT_MS);

      if (game._evalTimer) { clearTimeout(game._evalTimer); game._evalTimer = null; }
      if (game._botTimeouts) { for (const id of game._botTimeouts) clearTimeout(id); game._botTimeouts.clear(); }

      const numbers = game.numbers || new Map();
      const players = game.players || new Map();
      const eliminated = game.eliminated || new Set();
      const tanda = game.tanda || new Map();
      const entries = Array.from(numbers.entries());
      const submittedIds = new Set(numbers.keys());
      const activeIds = this._getActivePlayerIds(game);

      for (const id of activeIds) {
        if (!submittedIds.has(id)) eliminated.add(id);
      }

      if (entries.length === 0) {
        game._isEvaluating = false;
        if (game._safetyTimer) { clearTimeout(game._safetyTimer); game._safetyTimer = null; }
        this._broadcastToRoom(room, ["gameLowCardError", "No numbers drawn this round"]);
        game._gameEnded = true;
        game._isActive = false;
        game._endTime = Date.now();
        this._scheduleGameCleanup(room, game);
        return;
      }

      if (entries.length === 1 && eliminated.size === activeIds.length - 1) {
        const winnerId = entries[0][0];
        const winnerName = players.get(winnerId)?.name || winnerId;
        const totalCoin = (game.betAmount || 0) * players.size;
        game._gameEnded = true;
        game._isActive = false;
        game._endTime = Date.now();
        game._isEvaluating = false;
        if (game._safetyTimer) { clearTimeout(game._safetyTimer); game._safetyTimer = null; }
        this._broadcastToRoom(room, ["gameLowCardWinner", winnerName, totalCoin]);
        this._scheduleGameCleanup(room, game);
        return;
      }

      const values = entries.map(([, n]) => n);
      const allSame = values.every(v => v === values[0]);
      let losers = [];
      if (!allSame && values.length > 0) {
        const lowest = Math.min(...values);
        losers = entries.filter(([, n]) => n === lowest).map(([id]) => id);
        for (const id of losers) eliminated.add(id);
      }

      const remaining = Array.from(players.keys()).filter(id => !eliminated.has(id));

      if (allSame && remaining.length >= 2) {
        game._isEvaluating = false;
        if (game._safetyTimer) { clearTimeout(game._safetyTimer); game._safetyTimer = null; }
        numbers.clear();
        tanda.clear();
        game.round++;
        game.evaluationLocked = false;
        game.drawTimeExpired = false;
        game._phase = 'draw';
        game.numbers = new Map();
        game.tanda = new Map();
        game._botTimeouts = new Set();
        const remainingNames = remaining.map(id => players.get(id)?.name || id);
        this._broadcastToRoom(room, ["gameLowCardRoundResult", game.round - 1,
          entries.map(([id, n]) => `${players.get(id)?.name || id}:${n}${tanda.get(id) ? `(${tanda.get(id)})` : ''}`),
          [], remainingNames, true
        ]);
        if (this._isGameActuallyRunning(game) && !game._gameEnded) this._startDrawPhase(room, game);
        return;
      }

      if (remaining.length === 1 && !game._gameEnded) {
        const winnerId = remaining[0];
        const winnerName = players.get(winnerId)?.name || winnerId;
        const totalCoin = (game.betAmount || 0) * players.size;
        game._gameEnded = true;
        game._isActive = false;
        game._endTime = Date.now();
        game._isEvaluating = false;
        if (game._safetyTimer) { clearTimeout(game._safetyTimer); game._safetyTimer = null; }
        this._broadcastToRoom(room, ["gameLowCardWinner", winnerName, totalCoin]);
        this._scheduleGameCleanup(room, game);
        return;
      }

      if (remaining.length === 0) {
        game._isEvaluating = false;
        if (game._safetyTimer) { clearTimeout(game._safetyTimer); game._safetyTimer = null; }
        game._gameEnded = true;
        game._isActive = false;
        game._endTime = Date.now();
        this._broadcastToRoom(room, ["gameLowCardError", "All players eliminated"]);
        this._scheduleGameCleanup(room, game);
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
      game.numbers = new Map();
      game.tanda = new Map();
      game._botTimeouts = new Set();
      game._isEvaluating = false;
      if (game._safetyTimer) { clearTimeout(game._safetyTimer); game._safetyTimer = null; }
      if (this._isGameActuallyRunning(game) && !game._gameEnded) this._startDrawPhase(room, game);

    } catch(e) {
      if (game) { game._isEvaluating = false; if (game._safetyTimer) { clearTimeout(game._safetyTimer); game._safetyTimer = null; } }
      this._scheduleGameCleanup(room, game);
    }
  }

  async startGame(ws, bet, username) {
    try {
      if (this.isDestroyed) { this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]); return; }
      if (!username?.trim()) { this._safeSend(ws, ["gameLowCardError", "Username is required"]); return; }

      const usernameClean = username.trim();
      const room = this._ensureRoomConsistency(ws);
      if (!room) { this._safeSend(ws, ["gameLowCardError", "Please switch to a room first!"]); return; }
      if (room === QUIZ_ROOM) { this._safeSend(ws, ["gameLowCardError", "Cannot start game in Quiz room"]); return; }

      const startKey = `start_${room}`;
      if (this._gameStartFlags.has(startKey)) { this._safeSend(ws, ["gameLowCardError", "Game is already starting..."]); return; }

      const existingGame = this.activeGames.get(room);
      if (existingGame?._isActive && !existingGame._gameEnded) {
        this._safeSend(ws, ["gameLowCardError", "Game is already running"]);
        return;
      }

      this._gameStartFlags.set(startKey, Date.now());
      if (existingGame) await this._forceCleanupGame(room, existingGame);

      const now = Date.now();
      const lockTime = this._gameLocks.get(room);
      if (lockTime && (now - lockTime) < CONSTANTS.START_LOCK_DURATION_MS) {
        this._safeSend(ws, ["gameLowCardError", "Game is starting, please wait"]);
        this._gameStartFlags.delete(startKey);
        return;
      }
      this._gameLocks.set(room, now);

      try {
        if (this.activeGames.size >= this._maxGames) {
          this._safeSend(ws, ["gameLowCardError", "Server is busy"]);
          this._gameLocks.delete(room);
          this._gameStartFlags.delete(startKey);
          return;
        }

        const betAmount = parseInt(bet, 10) || 0;
        if (betAmount < 0 || (betAmount !== 0 && betAmount < 100) || betAmount > CONSTANTS.MAX_BET) {
          this._safeSend(ws, ["gameLowCardError", `Invalid bet (0 or 100-${CONSTANTS.MAX_BET})`]);
          this._gameLocks.delete(room);
          this._gameStartFlags.delete(startKey);
          return;
        }

        const wsId = this._getWsId(ws);
        const game = {
          room, players: new Map(), botPlayers: new Map(), registrationOpen: true,
          round: 1, numbers: new Map(), tanda: new Map(), eliminated: new Set(),
          betAmount, hostId: usernameClean, hostName: usernameClean, useBots: false,
          evaluationLocked: false, drawTimeExpired: false,
          _isActive: true, _gameEnded: false, _phase: 'registration',
          _botTimeouts: new Set(), _botsAdded: false,
          _registrationTimer: null, _drawTimer: null, _evalTimer: null, _safetyTimer: null,
          _isEvaluating: false, _createdAt: Date.now(), _drawPhaseStart: null, _endTime: null,
          playerWsId: new Map()
        };

        game.players.set(usernameClean, { id: usernameClean, name: usernameClean });
        game.playerWsId.set(usernameClean, wsId);
        this.activeGames.set(room, game);
        this._addClient(room, ws, usernameClean, false);

        this._broadcastToRoom(room, ["gameLowCardStart", betAmount]);
        this._broadcastToRoom(room, ["gameLowCardStartSuccess", usernameClean, betAmount]);
        this._startRegistration(room, game);

        setTimeout(() => {
          try {
            this._gameStartFlags.delete(startKey);
            if (this._gameLocks.get(room) === now) this._gameLocks.delete(room);
          } catch(e) {}
        }, CONSTANTS.START_LOCK_DURATION_MS + 1000);

      } catch(e) {
        this._deleteGame(room, this.activeGames.get(room));
        this._safeSend(ws, ["gameLowCardError", "Failed to start game"]);
        this._gameLocks.delete(room);
        this._gameStartFlags.delete(startKey);
      }
    } catch(e) {
      this._safeSend(ws, ["gameLowCardError", "Failed to start game"]);
    }
  }

  async _forceCleanupGame(room, game) {
    if (!game) return;
    try {
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

  async joinGame(ws, username) {
    try {
      if (this.isDestroyed) { this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]); return; }
      if (!username?.trim()) { this._safeSend(ws, ["gameLowCardError", "Username is required"]); return; }

      const usernameClean = username.trim();
      const wsId = this._getWsId(ws);
      const room = this._ensureRoomConsistency(ws);
      if (!room) { this._safeSend(ws, ["gameLowCardError", "Please switch to a room first!"]); return; }

      const lockKey = `join_${room}_${usernameClean}`;
      if (this._joinLocks.has(lockKey)) { this._safeSend(ws, ["gameLowCardError", "Join in progress, please wait"]); return; }
      this._joinLocks.set(lockKey, Date.now());

      try {
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
          const finalWsId = this._ensureSingleConnection(room, usernameClean, ws, wsId);
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
        this._addClient(room, ws, usernameClean, false);
        game.playerWsId.set(usernameClean, wsId);
        this._broadcastToRoom(room, ["gameLowCardJoin", usernameClean, game.betAmount]);

      } finally {
        this._joinLocks.delete(lockKey);
      }
    } catch(e) {
      this._safeSend(ws, ["gameLowCardError", "Failed to join game"]);
    }
  }

  async submitNumber(ws, number, tanda, username) {
    try {
      if (this.isDestroyed) { this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]); return; }
      if (!username?.trim()) { this._safeSend(ws, ["gameLowCardError", "Username is required"]); return; }

      const usernameClean = username.trim();
      const wsId = this._getWsId(ws);
      const room = this._ensureRoomConsistency(ws);
      if (!room) { this._safeSend(ws, ["gameLowCardError", "Please switch to a room first!"]); return; }

      const game = this.activeGames.get(room);
      if (!game?._isActive || game._gameEnded || !game.players) {
        this._safeSend(ws, ["gameLowCardError", "No active game"]);
        return;
      }

      if (game.players.has(usernameClean)) {
        if (game.eliminated?.has(usernameClean)) {
          this._safeSend(ws, ["gameLowCardError", "You have been eliminated from this game"]);
          return;
        }
        const existingWsId = game.playerWsId.get(usernameClean);
        if (existingWsId && existingWsId !== wsId) this._ensureSingleConnection(room, usernameClean, ws, wsId);
      }

      if (game.registrationOpen || game.evaluationLocked || game.drawTimeExpired || game._phase !== 'draw') {
        this._safeSend(ws, ["gameLowCardError", "Cannot submit now"]);
        return;
      }

      if (!game.players.has(usernameClean)) {
        this._safeSend(ws, ["gameLowCardError", "You are not in this game"]);
        return;
      }

      if (game.eliminated.has(usernameClean)) {
        this._safeSend(ws, ["gameLowCardError", "You have been eliminated"]);
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
          this._isGameActuallyRunning(game) && game._isActive && !game._gameEnded) {
        game.evaluationLocked = true;
        if (game._evalTimer) { clearTimeout(game._evalTimer); game._evalTimer = null; }
        this._broadcastToRoom(room, ["gameLowCardWait", "Please wait for results..."]);
        game._evalTimer = setTimeout(() => {
          try {
            const currentGame = this.activeGames.get(room);
            if (currentGame && currentGame === game && currentGame._isActive && !currentGame._gameEnded) {
              this._evaluateRound(room, game);
            }
          } catch(e) {}
        }, CONSTANTS.EVALUATION_DELAY_MS);
      }

    } catch(e) {
      this._safeSend(ws, ["gameLowCardError", "Failed to submit number"]);
    }
  }

  async leaveGame(ws, username) {
    try {
      if (this.isDestroyed) { this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]); return; }
      if (!username?.trim()) { this._safeSend(ws, ["gameLowCardError", "Username is required"]); return; }

      const usernameClean = username.trim();
      const room = this._ensureRoomConsistency(ws);
      if (!room) { this._safeSend(ws, ["gameLowCardError", "Please switch to a room first!"]); return; }

      const game = this.activeGames.get(room);
      if (!game?._isActive || game._gameEnded || !game.players) {
        this._safeSend(ws, ["gameLowCardError", "No active game in this room"]);
        return;
      }

      if (!game.players.has(usernameClean)) {
        this._safeSend(ws, ["gameLowCardError", "You are not in this game"]);
        return;
      }

      this._removePlayerFromGame(usernameClean, room);

    } catch(e) {
      this._safeSend(ws, ["gameLowCardError", "Failed to leave game"]);
    }
  }

  async checkGameRunning(ws, roomname) {
    try {
      if (this.isDestroyed) { this._safeSend(ws, ["gameStatus", { running: "false" }]); return; }
      let room = roomname;
      if (!room) room = this._ensureRoomConsistency(ws);
      if (!room) { this._safeSend(ws, ["gameStatus", { running: "false" }]); return; }

      const game = this.activeGames.get(room);
      const isRunning = game?._isActive && !game._gameEnded && game.players?.size > 0;
      this._safeSend(ws, ["gameStatus", { running: isRunning ? "true" : "false" }]);

    } catch(e) {
      this._safeSend(ws, ["gameStatus", { running: "false" }]);
    }
  }

  getGame(room) { return this.activeGames.get(room); }

  isGameRunning(room) {
    try {
      if (this.isDestroyed || !room) return { running: false, message: this.isDestroyed ? "System destroyed" : "Invalid room" };
      const game = this.activeGames.get(room);
      if (!game?.players) return { running: false, message: "No game in this room" };
      return { running: game._isActive && !game._gameEnded, message: "Game is " + (game._isActive && !game._gameEnded ? "running" : "not active") };
    } catch(e) {
      return { running: false, message: "Error checking game" };
    }
  }

  _ensureSingleConnection(room, username, newWs, newWsId) {
    try {
      const game = this.activeGames.get(room);
      if (!game) return newWsId;
      const existingWsId = game.playerWsId?.get(username);
      if (existingWsId && existingWsId !== newWsId) {
        const oldWs = this.wsMap.get(existingWsId);
        if (oldWs) {
          try { oldWs.close(1000, "Duplicate connection"); } catch(e) {}
          this._removeClient(room, oldWs);
        }
        if (game.playerWsId) game.playerWsId.set(username, newWsId);
      }
      return newWsId;
    } catch(e) { return newWsId; }
  }

  _shuffleQuestionOptions(question) {
    if (!question?.options) return { options: { A: '', B: '', C: '', D: '' }, correct: 'A' };
    const options = question.options;
    const keys = ['A', 'B', 'C', 'D'];
    const entries = keys.map(key => ({ key, text: options[key] || '', isCorrect: key === question.correct }));
    const shuffled = this._shuffleArray(entries);
    const newOptions = {};
    const newKeys = ['A', 'B', 'C', 'D'];
    let newCorrect = '';
    shuffled.forEach((item, index) => {
      const newKey = newKeys[index];
      newOptions[newKey] = item.text;
      if (item.isCorrect) newCorrect = newKey;
    });
    return { options: newOptions, correct: newCorrect || 'A' };
  }

  _shuffleArray(array) {
    if (!array?.length) return array || [];
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async handleEvent(ws, data) {
    if (this.isDestroyed || !ws || !data?.[0]) return;
    this._eventQueue.push({ ws, data });
    if (!this._isProcessingQueue) this._processEventQueue();
  }

  async _handleEventInternal(ws, data) {
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
      if (winner) this._safeSend(ws, ["quizLastWeekWinner", winner.username, winner.score, winner.week]);
      else this._safeSend(ws, ["quizLastWeekWinner", "", 0, ""]);
      return;
    }

    if (evt === "getQuizLeaderboard") {
      let limit = data.length > 1 && typeof data[1] === 'number' ? Math.min(data[1], 30) : 10;
      const points = await this._getQuizPoints();
      const sorted = Object.entries(points).map(([username, score]) => ({ username, score }))
        .sort((a, b) => b.score - a.score).slice(0, limit);
      const result = sorted.map(item => `${item.username}|${item.score}`);
      this._safeSend(ws, ["quizLeaderboard", result]);
      return;
    }

    if (evt === "deleteQuizLastWeekWinner") {
      try {
        if (this.env?.QUESTIONS) {
          this._incrementSubRequest();
          await this.env.QUESTIONS.delete(CONSTANTS.QUIZ_LAST_WEEK_WINNER);
          this._safeSend(ws, ["quizLastWeekWinnerDeleted", true, "Deleted successfully"]);
        } else {
          this._safeSend(ws, ["quizLastWeekWinnerDeleted", false, "KV not available"]);
        }
      } catch(e) {
        this._safeSend(ws, ["quizLastWeekWinnerDeleted", false, e.message]);
      }
      return;
    }

    if (evt === "getQuizStatus") {
      const wsId = this._getWsId(ws);
      if (wsId) {
        this._sendQuizTimeLeftToUser(ws);
        if (this.currentQuestion && !this._isSwitchingToQuiz) {
          this._sendCurrentQuestionToUser(ws);
        }
        this._getQuizPoints().then(points => {
          const sorted = Object.entries(points)
            .map(([username, score]) => ({ username, score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);
          const result = sorted.map(item => `${item.username}|${item.score}`);
          this._safeSend(ws, ["quizLeaderboard", result]);
        });
        this._getLastWeekWinner().then(winner => {
          if (winner) {
            this._safeSend(ws, ["quizLastWeekWinner", winner.username, winner.score, winner.week]);
          }
        });
      }
      return;
    }

    if (evt === "resetQuizState") {
      this._resetQuizState();
      this._safeSend(ws, ["quizStateReset", true]);
      return;
    }

    const room = this._ensureRoomConsistency(ws);
    if (!room) { this._safeSend(ws, ["gameLowCardError", "Please switch to a room first!"]); return; }
    if (room === QUIZ_ROOM) { this._safeSend(ws, ["gameLowCardError", "Cannot start game in Quiz room"]); return; }

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

  _checkStuckGames() {
    try {
      const now = Date.now();
      for (const [room, game] of this.activeGames) {
        if (!game?._isActive || game._gameEnded) continue;
        if (game._phase === 'draw' && game._drawPhaseStart &&
            (now - game._drawPhaseStart) > CONSTANTS.STUCK_DRAW_TIMEOUT_MS) {
          this._broadcastToRoom(room, ["gameLowCardError", "Game stuck, forcing evaluation..."]);
          this._closeDrawPhase(room, game);
        }
        if (game._phase === 'registration' && game.registrationOpen &&
            game._createdAt && (now - game._createdAt) > CONSTANTS.STUCK_REGISTRATION_TIMEOUT_MS) {
          this._broadcastToRoom(room, ["gameLowCardError", "Registration timeout"]);
          this._closeRegistration(room, game);
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
          this.userLanguage.delete(wsId);
          this.userCountry.delete(wsId);
          this._timeLeftSentCount.delete(wsId);
          for (const [username, conn] of this.userConnections) {
            if (conn?.wsId === wsId) { this.userConnections.delete(username); break; }
          }
        }
      }
    } catch(e) {}
  }

  async fetch(req) {
    if (this.closing || this.isDestroyed) return new Response("Shutting down", { status: 503 });
    try {
      const url = new URL(req.url);
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
          server.room = null;
          server.roomname = null;
          server._createdAt = Date.now();
          server.username = null;

          const cf = req.cf || {};
          const country = cf?.country || 'US';
          this.userCountry.set(wsId, country);
          const lang = this._countryToLanguage(country);
          this.userLanguage.set(wsId, lang);
          server._cf = cf;
          server._country = country;
          server._language = lang;

          try { this.state.acceptWebSocket(server); } catch(e) { return new Response("WebSocket acceptance failed", { status: 500 }); }

          server.addEventListener("message", async (event) => {
            try {
              const data = JSON.parse(event.data);
              if (Array.isArray(data) && data.length > 0) await this.handleEvent(server, data);
            } catch(e) { this._safeSend(server, ["gameLowCardError", e.message || "Error"]); }
          });

          server.addEventListener("close", () => {
            try {
              if (server.room || server.roomname) {
                const room = server.room || server.roomname;
                const wsId = this._getWsId(server);
                const username = server.username;
                this._removeClient(room, server);
                this.userLanguage.delete(wsId);
                this.userCountry.delete(wsId);
                if (username) {
                  const conn = this.userConnections.get(username);
                  if (conn?.wsId === wsId) this.userConnections.delete(username);
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
                const wsId = this._getWsId(server);
                const username = server.username;
                this._removeClient(room, server);
                this.userLanguage.delete(wsId);
                this.userCountry.delete(wsId);
                if (username) {
                  const conn = this.userConnections.get(username);
                  if (conn?.wsId === wsId) this.userConnections.delete(username);
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
      return new Response("Internal Server Error: " + e.message, { status: 500 });
    }
  }

  async webSocketMessage(ws, msg) {
    try {
      if (!ws || ws._closing || this.closing || this.isDestroyed || !ws._wsId) return;
      const data = JSON.parse(msg);
      if (Array.isArray(data) && data.length > 0) await this.handleEvent(ws, data);
    } catch(e) { this._safeSend(ws, ["gameLowCardError", e.message || "Error"]); }
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
      this._timeLeftSentCount.delete(wsId);
      if (username) {
        const conn = this.userConnections.get(username);
        if (conn?.wsId === wsId) this.userConnections.delete(username);
      }
      if (wsId) { this.clientRooms.delete(wsId); this.wsMap.delete(wsId); }
      ws.room = null;
      ws.roomname = null;
      ws._wsId = null;
      ws.username = null;
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
      this._timeLeftSentCount.delete(wsId);
      if (username) {
        const conn = this.userConnections.get(username);
        if (conn?.wsId === wsId) this.userConnections.delete(username);
      }
      if (wsId) { this.clientRooms.delete(wsId); this.wsMap.delete(wsId); }
      ws.room = null;
      ws.roomname = null;
      ws._wsId = null;
      ws.username = null;
    } catch(e) {}
  }
}
