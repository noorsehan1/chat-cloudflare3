// ==================== GAME-SERVER.JS (FULL CLASS WITH AUTO TRANSLATE TO NEW KV) ====================

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
  MAX_RESTART_ATTEMPTS: 3,
  RESTART_COOLDOWN_MS: 30000,
  HEALTH_CHECK_INTERVAL_MS: 10000,
  MAX_IDLE_TIME_MS: 300000,
  RECONNECT_DELAY_MS: 2000,
  MAX_EVENT_QUEUE_SIZE: 1000,
  ERROR_RECOVERY_DELAY_MS: 5000,
  MAX_UNHANDLED_ERRORS: 5,
  ERROR_RESET_INTERVAL_MS: 60000,
  AUTO_TRANSLATE_ON_START: true,
  TRANSLATION_CHECK_INTERVAL_MS: 60000,
};

const QUIZ_SCHEDULE = {
  START_HOUR: 23,
  END_HOUR: 4,
  TIMEZONE_OFFSET: 7,
};

const QUIZ_ROOM = "Quiz";
const TRANSLATION_KV_KEY = 'quiz_translations';

const COUNTRY_LANGUAGE_MAP = {
  'ID': { lang: 'id', name: 'Indonesia', flag: '🇮🇩' },
  'MY': { lang: 'id', name: 'Malaysia', flag: '🇲🇾' },
  'SG': { lang: 'id', name: 'Singapore', flag: '🇸🇬' },
  'BN': { lang: 'id', name: 'Brunei', flag: '🇧🇳' },
  'PH': { lang: 'fil', name: 'Philippines', flag: '🇵🇭' },
  'IN': { lang: 'hi', name: 'India', flag: '🇮🇳' },
  'NP': { lang: 'hi', name: 'Nepal', flag: '🇳🇵' },
  'LK': { lang: 'hi', name: 'Sri Lanka', flag: '🇱🇰' },
  'BD': { lang: 'hi', name: 'Bangladesh', flag: '🇧🇩' },
  'PK': { lang: 'hi', name: 'Pakistan', flag: '🇵🇰' },
  'SA': { lang: 'ar', name: 'Saudi Arabia', flag: '🇸🇦' },
  'AE': { lang: 'ar', name: 'UAE', flag: '🇦🇪' },
  'QA': { lang: 'ar', name: 'Qatar', flag: '🇶🇦' },
  'KW': { lang: 'ar', name: 'Kuwait', flag: '🇰🇼' },
  'BH': { lang: 'ar', name: 'Bahrain', flag: '🇧🇭' },
  'OM': { lang: 'ar', name: 'Oman', flag: '🇴🇲' },
  'YE': { lang: 'ar', name: 'Yemen', flag: '🇾🇪' },
  'SY': { lang: 'ar', name: 'Syria', flag: '🇸🇾' },
  'LB': { lang: 'ar', name: 'Lebanon', flag: '🇱🇧' },
  'JO': { lang: 'ar', name: 'Jordan', flag: '🇯🇴' },
  'IQ': { lang: 'ar', name: 'Iraq', flag: '🇮🇶' },
  'EG': { lang: 'ar', name: 'Egypt', flag: '🇪🇬' },
  'DZ': { lang: 'ar', name: 'Algeria', flag: '🇩🇿' },
  'MA': { lang: 'ar', name: 'Morocco', flag: '🇲🇦' },
  'TN': { lang: 'ar', name: 'Tunisia', flag: '🇹🇳' },
  'LY': { lang: 'ar', name: 'Libya', flag: '🇱🇾' },
  'SD': { lang: 'ar', name: 'Sudan', flag: '🇸🇩' },
  'MR': { lang: 'ar', name: 'Mauritania', flag: '🇲🇷' },
  'SO': { lang: 'ar', name: 'Somalia', flag: '🇸🇴' },
  'PS': { lang: 'ar', name: 'Palestine', flag: '🇵🇸' },
};

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
    this.countryLanguageMap = COUNTRY_LANGUAGE_MAP;
    this.defaultLanguage = 'en';
    this.userLanguageCache = new Map();
    this.translatedQuestionsCache = new Map();
  }

  resetQuestionCache() {
    try {
      if (this.questionCache.size > 0) this.questionCache.clear();
      this.translateCount = 0;
      this.translateLimitReached = false;
    } catch(e) {}
  }

  getLanguageForCountry(countryCode) {
    try {
      if (!countryCode) return this.defaultLanguage;
      const countryData = this.countryLanguageMap[countryCode.toUpperCase()];
      if (countryData) return countryData.lang;
      return this.defaultLanguage;
    } catch(e) { return this.defaultLanguage; }
  }

  getCountryInfo(countryCode) {
    try {
      if (!countryCode) {
        return { lang: this.defaultLanguage, name: 'Unknown', flag: '🌍' };
      }
      const info = this.countryLanguageMap[countryCode.toUpperCase()];
      if (info) return { ...info };
      return { lang: this.defaultLanguage, name: countryCode, flag: '🌍' };
    } catch(e) {
      return { lang: this.defaultLanguage, name: 'Unknown', flag: '🌍' };
    }
  }

  getUserLanguage(wsId) {
    try {
      if (this.userLanguageCache.has(wsId)) {
        return this.userLanguageCache.get(wsId);
      }
      const lang = this.gameServer.userLanguage.get(wsId) || this.defaultLanguage;
      this.userLanguageCache.set(wsId, lang);
      return lang;
    } catch(e) { return this.defaultLanguage; }
  }

  setUserLanguage(wsId, lang) {
    try {
      this.userLanguageCache.set(wsId, lang);
      if (this.gameServer) {
        this.gameServer.userLanguage.set(wsId, lang);
      }
    } catch(e) {}
  }

  detectAndSetLanguage(wsId, countryCode) {
    try {
      const lang = this.getLanguageForCountry(countryCode);
      this.setUserLanguage(wsId, lang);
      return lang;
    } catch(e) { return this.defaultLanguage; }
  }

  async translateForUsers(question, options, usersByLang) {
    try {
      const results = new Map();

      for (const [lang, users] of usersByLang) {
        if (lang === 'en') {
          results.set(lang, { question, options, users, isFallback: false, fromCache: false });
          continue;
        }

        // Try to get from translated questions in NEW KV
        const translated = await this.gameServer.getQuestionByIdFromNewKV(
          Date.now() + Math.random(),
          lang
        );
        
        if (translated) {
          results.set(lang, {
            question: translated.question,
            options: translated.options,
            users,
            isFallback: false,
            fromCache: true
          });
        } else {
          results.set(lang, {
            question: question,
            options: options,
            users,
            isFallback: true,
            fromCache: false
          });
        }
      }
      this._sendResults(results);
    } catch(e) {}
  }

  _sendResults(results) {
    try {
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
    } catch(e) {}
  }

  resetDailyCounter() {
    try {
      const now = new Date().toUTCString();
      if (now !== this.translateDate) {
        this.translateDate = now;
        this.translateCount = 0;
        this.translateLimitReached = false;
      }
    } catch(e) {}
  }

  _startTranslateReset() {
    if (this._translateResetInterval) clearInterval(this._translateResetInterval);
    this._translateResetInterval = setInterval(() => {
      try {
        if (this.gameServer?.closing || this.gameServer?.isDestroyed) {
          clearInterval(this._translateResetInterval);
          this._translateResetInterval = null;
          return;
        }
        this.resetDailyCounter();
      } catch(e) {}
    }, 60000);
  }

  clearCaches() {
    try {
      this.userLanguageCache.clear();
      this.translatedQuestionsCache.clear();
      this.questionCache.clear();
    } catch(e) {}
  }

  getSupportedLanguages() {
    try {
      const languages = {};
      for (const [code, data] of Object.entries(this.countryLanguageMap)) {
        if (!languages[data.lang]) {
          languages[data.lang] = {
            code: data.lang,
            name: this.getLanguageName(data.lang),
            countries: []
          };
        }
        languages[data.lang].countries.push({
          code: code,
          name: data.name,
          flag: data.flag
        });
      }
      return languages;
    } catch(e) { return {}; }
  }

  getLanguageName(langCode) {
    try {
      const names = {
        'id': 'Bahasa Indonesia',
        'fil': 'Filipino',
        'hi': 'Hindi (India)',
        'ar': 'العربية (Arab)',
        'en': 'English'
      };
      return names[langCode] || langCode;
    } catch(e) { return 'English'; }
  }

  getCountriesByLanguage(langCode) {
    try {
      const countries = [];
      for (const [code, data] of Object.entries(this.countryLanguageMap)) {
        if (data.lang === langCode) {
          countries.push({
            code: code,
            name: data.name,
            flag: data.flag
          });
        }
      }
      return countries;
    } catch(e) { return []; }
  }

  async _translateText(text, targetLang, retryCount = 0) {
    try {
      if (targetLang === 'en' || !text || typeof text !== 'string') return text;
      const result = await this._callTranslateAPI(text, targetLang);
      this.translateCount++;
      return result;
    } catch(e) {
      if (retryCount < 5) {
        await this._sleep(1000 * (retryCount + 1));
        return this._translateText(text, targetLang, retryCount + 1);
      }
      throw e;
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

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ==================== BULK TRANSLATION NEW KV ====================

class BulkTranslationNewKV {
  constructor(gameServer) {
    this.gameServer = gameServer;
    this.isTranslating = false;
    this.translationProgress = 0;
    this.totalQuestions = 0;
    this.countries = [
      { code: 'ID', lang: 'id', name: 'Indonesia' },
      { code: 'PH', lang: 'fil', name: 'Philippines' },
      { code: 'IN', lang: 'hi', name: 'India' },
      { code: 'SA', lang: 'ar', name: 'Arab' },
    ];
    this.defaultLang = 'en';
    this.translationStarted = false;
  }

  async translateAllQuestionsToNewKV() {
    try {
      if (this.isTranslating) {
        return { success: false, message: "Translation already in progress" };
      }

      this.isTranslating = true;
      this.translationProgress = 0;
      this.translationStarted = true;

      // Load original questions from KV
      const existingData = await this.loadQuestionsFromKV();
      if (!existingData?.questions || existingData.questions.length === 0) {
        this.isTranslating = false;
        return { success: false, message: "No questions found in KV" };
      }

      const originalQuestions = existingData.questions;
      this.totalQuestions = originalQuestions.length;

      // Check if translations already exist in new KV
      const existingTranslations = await this.loadTranslationsFromKV();
      if (existingTranslations && existingTranslations.languages && Object.keys(existingTranslations.languages).length > 1) {
        this.isTranslating = false;
        return { 
          success: true, 
          message: "Translations already exist in quiz_translations",
          languages: Object.keys(existingTranslations.languages),
          totalQuestions: this.totalQuestions
        };
      }

      // Create new translation data
      const translatedData = {
        total: originalQuestions.length,
        source: existingData.source || "OpenTDB",
        fetchedAt: existingData.fetchedAt || new Date().toISOString(),
        languages: {
          en: {
            name: "English",
            questions: originalQuestions.map(q => ({
              id: q.id,
              question: q.question,
              options: q.options,
              correct: q.correct,
              category: q.category,
              difficulty: q.difficulty
            }))
          }
        },
        countries: {},
        translated_at: new Date().toISOString(),
        version: "1.0"
      };

      const totalCountries = this.countries.length;
      let completed = 0;

      for (const country of this.countries) {
        const translated = await this.translateQuestionsBatch(originalQuestions, country);
        translatedData.languages[country.lang] = {
          name: country.name,
          questions: translated
        };
        translatedData.countries[country.code] = {
          lang: country.lang,
          name: country.name
        };
        
        completed++;
        this.translationProgress = Math.round((completed / totalCountries) * 100);
        
        // Save progress after each country to new KV
        await this.saveToKV(translatedData);
        
        // Broadcast progress
        this.gameServer._broadcastToRoom(QUIZ_ROOM, ["translationProgress", {
          country: country.name,
          completed: completed,
          total: totalCountries,
          progress: this.translationProgress
        }]);
      }

      this.isTranslating = false;
      this.translationProgress = 100;

      // Broadcast completion
      this.gameServer._broadcastToRoom(QUIZ_ROOM, ["translationComplete", {
        success: true,
        message: `Successfully translated ${originalQuestions.length} questions to ${this.countries.length} languages`,
        totalQuestions: originalQuestions.length,
        languages: this.countries.map(c => ({ code: c.lang, name: c.name })),
        countries: this.countries.map(c => ({ code: c.code, name: c.name })),
        kvKey: TRANSLATION_KV_KEY
      }]);

      return {
        success: true,
        message: `Successfully translated ${originalQuestions.length} questions to ${this.countries.length} languages`,
        totalQuestions: originalQuestions.length,
        languages: this.countries.map(c => ({ code: c.lang, name: c.name })),
        countries: this.countries.map(c => ({ code: c.code, name: c.name })),
        kvKey: TRANSLATION_KV_KEY
      };

    } catch (error) {
      this.isTranslating = false;
      return {
        success: false,
        message: `Translation failed: ${error.message}`
      };
    }
  }

  async loadQuestionsFromKV() {
    try {
      const env = this.gameServer.env;
      if (!env?.QUESTIONS) return null;
      const cached = await env.QUESTIONS.get('quiz_questions', 'json');
      if (cached?.questions?.length > 0) {
        return cached;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  async loadTranslationsFromKV() {
    try {
      const env = this.gameServer.env;
      if (!env?.QUESTIONS) return null;
      const cached = await env.QUESTIONS.get(TRANSLATION_KV_KEY, 'json');
      return cached || null;
    } catch (error) {
      return null;
    }
  }

  async translateQuestionsBatch(questions, country) {
    const translatedQuestions = [];
    const batchSize = 3;
    const totalBatches = Math.ceil(questions.length / batchSize);

    for (let i = 0; i < questions.length; i += batchSize) {
      const batch = questions.slice(i, i + batchSize);
      const translatedBatch = await this.translateBatchForCountry(batch, country);
      translatedQuestions.push(...translatedBatch);
      
      const progress = Math.round(((i + batch.length) / questions.length) * 100);
      const countryProgress = Math.round(progress / this.countries.length);
      this.translationProgress = Math.min(100, countryProgress + 
        (this.countries.indexOf(country) / this.countries.length * 100));

      if (i + batchSize < questions.length) {
        await this.sleep(500);
      }
    }

    return translatedQuestions;
  }

  async translateBatchForCountry(questions, country) {
    const translatedBatch = [];

    for (const question of questions) {
      try {
        const translated = await this.translateSingleQuestion(question, country);
        translatedBatch.push(translated);
      } catch (error) {
        translatedBatch.push({
          id: question.id,
          question: question.question,
          options: question.options,
          correct: question.correct,
          category: question.category,
          difficulty: question.difficulty,
          isFallback: true
        });
      }
    }

    return translatedBatch;
  }

  async translateSingleQuestion(originalQuestion, country) {
    const { id, question, options, correct, category, difficulty } = originalQuestion;

    const translatedQuestion = await this.translateText(question, country.lang);
    const translatedOptions = await this.translateOptions(options, country.lang);

    return {
      id: id,
      question: translatedQuestion || question,
      options: translatedOptions || options,
      correct: correct,
      category: category,
      difficulty: difficulty,
      original_question: question,
      isFallback: false
    };
  }

  async translateText(text, targetLang) {
    try {
      const langMap = {
        'id': 'id',
        'fil': 'tl',
        'hi': 'hi',
        'ar': 'ar'
      };
      const target = langMap[targetLang] || 'en';
      const result = await this.gameServer.translationManager._translateText(text, target);
      return result;
    } catch (error) {
      return text;
    }
  }

  async translateOptions(options, targetLang) {
    try {
      if (!options) return options;
      const keys = ['A', 'B', 'C', 'D'];
      const translatedOptions = { ...options };
      for (const key of keys) {
        if (options[key]) {
          try {
            const translated = await this.translateText(options[key], targetLang);
            translatedOptions[key] = translated || options[key];
          } catch (error) {
            translatedOptions[key] = options[key];
          }
        }
      }
      return translatedOptions;
    } catch (error) {
      return options;
    }
  }

  async saveToKV(data) {
    try {
      const env = this.gameServer.env;
      if (!env?.QUESTIONS) return;
      await env.QUESTIONS.put(TRANSLATION_KV_KEY, JSON.stringify(data));
    } catch (error) {
      throw error;
    }
  }

  async getQuestionsByLanguage(lang = 'en') {
    try {
      const env = this.gameServer.env;
      if (!env?.QUESTIONS) return null;
      const data = await env.QUESTIONS.get(TRANSLATION_KV_KEY, 'json');
      if (!data) return null;

      if (lang === 'en' || !data.languages || !data.languages[lang]) {
        return data.languages?.en?.questions || null;
      }

      return data.languages[lang].questions || null;
    } catch (error) {
      return null;
    }
  }

  async getQuestionById(id, lang = 'en') {
    try {
      const questions = await this.getQuestionsByLanguage(lang);
      if (!questions) return null;
      return questions.find(q => q.id === id) || null;
    } catch (error) {
      return null;
    }
  }

  async getAllLanguages() {
    try {
      const env = this.gameServer.env;
      if (!env?.QUESTIONS) return null;
      const data = await env.QUESTIONS.get(TRANSLATION_KV_KEY, 'json');
      if (!data?.languages) return null;
      
      const languages = {};
      for (const [key, value] of Object.entries(data.languages)) {
        languages[key] = {
          name: value.name,
          total: value.questions?.length || 0
        };
      }
      return languages;
    } catch (error) {
      return null;
    }
  }

  async getTranslationStatus() {
    return {
      isTranslating: this.isTranslating,
      progress: this.translationProgress,
      totalQuestions: this.totalQuestions,
      countries: this.countries,
      kvKey: TRANSLATION_KV_KEY,
      translationStarted: this.translationStarted
    };
  }

  async checkTranslationExists() {
    try {
      const env = this.gameServer.env;
      if (!env?.QUESTIONS) return false;
      const data = await env.QUESTIONS.get(TRANSLATION_KV_KEY, 'json');
      return data && data.languages && Object.keys(data.languages).length > 1;
    } catch (error) {
      return false;
    }
  }

  async autoTranslateOnStart() {
    try {
      // Check if translation already exists
      const exists = await this.checkTranslationExists();
      if (exists) {
        console.log('[AutoTranslate] Translation already exists in KV');
        return { success: true, message: "Translation already exists", exists: true };
      }

      // Check if questions exist
      const questions = await this.loadQuestionsFromKV();
      if (!questions || questions.questions.length === 0) {
        console.log('[AutoTranslate] No questions found in KV');
        return { success: false, message: "No questions found" };
      }

      console.log(`[AutoTranslate] Starting auto translation for ${questions.questions.length} questions...`);
      
      // Start translation
      const result = await this.translateAllQuestionsToNewKV();
      
      if (result.success) {
        console.log(`[AutoTranslate] Successfully translated ${result.totalQuestions} questions`);
      } else {
        console.log(`[AutoTranslate] Translation failed: ${result.message}`);
      }
      
      return result;
    } catch (error) {
      console.log(`[AutoTranslate] Error: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

      this._restartCount = 0;
      this._lastRestartTime = 0;
      this._healthCheckInterval = null;
      this._isRestarting = false;
      this._startTime = Date.now();
      this._lastHeartbeat = Date.now();
      this._errorCount = 0;
      this._lastErrorReset = Date.now();
      this._isRecovering = false;

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

      this.quizEndedToday = false;
      this.quizEndMessageShown = false;
      this.quizEndNotified = false;

      this.translationManager = new TranslationManager(this);
      this.bulkTranslationNewKV = new BulkTranslationNewKV(this);

      this._initAsync();
      setTimeout(() => this.forceStartQuiz(), 3000);
      this._startCPUMonitor();
      this._startHealthCheck();
      this._startAutoTranslateCheck();

    } catch(e) {
      setTimeout(() => this._forceRecovery(), 1000);
    }
  }

  // ==================== AUTO TRANSLATE ON START ====================

  _startAutoTranslateCheck() {
    // Check if auto translate is enabled
    if (!CONSTANTS.AUTO_TRANSLATE_ON_START) return;

    // Check after 5 seconds to allow server to initialize
    setTimeout(async () => {
      try {
        if (this.closing || this.isDestroyed) return;
        
        console.log('[AutoTranslate] Checking if translation needed...');
        const exists = await this.bulkTranslationNewKV.checkTranslationExists();
        
        if (!exists) {
          console.log('[AutoTranslate] No translation found. Starting auto translation...');
          const result = await this.bulkTranslationNewKV.autoTranslateOnStart();
          if (result.success) {
            console.log('[AutoTranslate] Auto translation completed successfully');
          } else {
            console.log('[AutoTranslate] Auto translation failed, will retry later');
            // Retry after 5 minutes
            setTimeout(() => {
              if (!this.closing && !this.isDestroyed) {
                this._retryAutoTranslate();
              }
            }, 300000);
          }
        } else {
          console.log('[AutoTranslate] Translation already exists, skipping auto translation');
        }
      } catch (error) {
        console.log(`[AutoTranslate] Error: ${error.message}`);
      }
    }, 5000);
  }

  async _retryAutoTranslate() {
    try {
      if (this.closing || this.isDestroyed) return;
      
      const exists = await this.bulkTranslationNewKV.checkTranslationExists();
      if (!exists) {
        console.log('[AutoTranslate] Retrying auto translation...');
        await this.bulkTranslationNewKV.autoTranslateOnStart();
      }
    } catch (error) {
      console.log(`[AutoTranslate] Retry failed: ${error.message}`);
    }
  }

  // ==================== HEALTH CHECK ====================

  _startHealthCheck() {
    if (this._healthCheckInterval) clearInterval(this._healthCheckInterval);
    this._healthCheckInterval = setInterval(() => {
      try {
        if (this.closing || this.isDestroyed) {
          clearInterval(this._healthCheckInterval);
          this._healthCheckInterval = null;
          return;
        }
        this._performHealthCheck();
      } catch(e) {}
    }, CONSTANTS.HEALTH_CHECK_INTERVAL_MS);
  }

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

      if (this._isQuizTime() && this.currentQuestion && this._quizStartTime) {
        const elapsed = (now - this._quizStartTime) / 1000;
        if (elapsed > (CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000) + 30) {
          this.currentQuestion = null;
          this._quizTimeout = null;
          if (!this.closing && !this.isDestroyed) {
            this._showQuestion();
          }
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
      this.currentQuestion = null;
      this.isQuizWaiting = false;
      this.quizHasWinner = false;
      this.quizWinner = null;
      this.quizAnswered = new Set();
      this._quizStartTime = null;
      if (this._eventQueue) {
        this._eventQueue = [];
      }
      if (this._rateLimitMap) {
        this._rateLimitMap.clear();
      }
      this._cleanupResources();
      if (!this._initialized) {
        this._initAsync();
      }
      if (this._isQuizTime()) {
        this.quizAutoEnabled = true;
        setTimeout(() => {
          if (!this.closing && !this.isDestroyed) {
            this.forceStartQuiz();
          }
        }, 2000);
      }
    } catch(e) {}
  }

  _cleanupResources() {
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
      if (this.quizTimer) {
        clearInterval(this.quizTimer);
        this.quizTimer = null;
      }
      if (this.quizAutoTimer) {
        clearInterval(this.quizAutoTimer);
        this.quizAutoTimer = null;
      }
      if (this._quizKeepAliveInterval) {
        clearInterval(this._quizKeepAliveInterval);
        this._quizKeepAliveInterval = null;
      }
    } catch(e) {}
  }

  // ==================== QUIZ NOTIFICATION ====================

  _getQuestionRemainingTime() {
    try {
      if (!this.currentQuestion || !this._quizStartTime) return 0;
      const elapsed = (Date.now() - this._quizStartTime) / 1000;
      return Math.max(0, Math.round((CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000) - elapsed));
    } catch(e) { return 0; }
  }

  _getTimeLeftUntilNextQuiz() {
    try {
      const now = new Date();
      let targetDate = new Date(now);
      targetDate.setUTCHours(QUIZ_SCHEDULE.START_HOUR - QUIZ_SCHEDULE.TIMEZONE_OFFSET, 0, 0, 0);
      
      const isOvernight = QUIZ_SCHEDULE.START_HOUR > QUIZ_SCHEDULE.END_HOUR;
      const wibHour = this._getCurrentWIBHour();
      const isQuizTime = isOvernight ? 
        (wibHour >= QUIZ_SCHEDULE.START_HOUR || wibHour < QUIZ_SCHEDULE.END_HOUR) : 
        (wibHour >= QUIZ_SCHEDULE.START_HOUR && wibHour < QUIZ_SCHEDULE.END_HOUR);
      
      if (isQuizTime) {
        targetDate.setDate(targetDate.getDate() + 1);
      } else if (wibHour >= QUIZ_SCHEDULE.END_HOUR && wibHour < QUIZ_SCHEDULE.START_HOUR) {
        if (wibHour < QUIZ_SCHEDULE.START_HOUR) {
        } else {
          targetDate.setDate(targetDate.getDate() + 1);
        }
      } else {
        targetDate.setDate(targetDate.getDate() + 1);
      }
      
      const diffMs = targetDate - now;
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      const diffSeconds = Math.floor((diffMs % (1000 * 60)) / 1000);
      
      let text = "";
      if (diffHours > 0) {
        text = `${diffHours}h ${diffMinutes}m ${diffSeconds}s`;
      } else if (diffMinutes > 0) {
        text = `${diffMinutes}m ${diffSeconds}s`;
      } else {
        text = `${diffSeconds}s`;
      }
      
      return { hours: diffHours, minutes: diffMinutes, seconds: diffSeconds, text: text, totalMs: diffMs };
    } catch(e) {
      return { hours: 0, minutes: 0, seconds: 0, text: '0s', totalMs: 0 };
    }
  }

  _sendQuizEndNotificationOnce() {
    try {
      if (this.quizEndNotified) return;
      const timeLeft = this._getTimeLeftUntilNextQuiz();
      const message = `⏱️ ${timeLeft.text}`;
      this._broadcastToRoom(QUIZ_ROOM, ["quizEnded", { timeLeft: timeLeft.text, status: "ended" }]);
      this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", message, true]);
      this._broadcastQuizNotification("quizEnded", { timeLeft: timeLeft.text });
      this.quizEndNotified = true;
    } catch(e) {}
  }

  _broadcastQuizNotification(type, data) {
    try {
      const wsIds = this.wsClients.get(QUIZ_ROOM);
      if (!wsIds?.size) return;
      const remaining = this._getQuestionRemainingTime();
      const remainingText = `${remaining}s remaining`;
      const notification = {
        type: type,
        timestamp: Date.now(),
        remainingTime: remainingText,
        correctAnswer: this.currentQuestion?.correct || null,
        data: data || {}
      };
      const msgStr = JSON.stringify(["quizNotification", notification]);
      const wsIdArray = Array.from(wsIds);
      const batchSize = CONSTANTS.BROADCAST_BATCH_SIZE;
      for (let i = 0; i < wsIdArray.length; i += batchSize) {
        const batch = wsIdArray.slice(i, i + batchSize);
        for (const wsId of batch) {
          try {
            const ws = this.wsMap.get(wsId);
            if (ws && ws.readyState === 1) {
              ws.send(msgStr);
            }
          } catch(e) {}
        }
      }
    } catch(e) {}
  }

  // ==================== INIT ====================

  async _initAsync() {
    try {
      if (this._initialized && !this._isRecovering) return;
      this._initialized = true;
      await this._initQuiz();
      this._startQuizScheduler();
      await this._checkAndResetWeeklyPoints();
      setTimeout(() => {
        if (!this.closing && !this.isDestroyed) {
          this.ensureQuizRunning();
        }
      }, 2000);
      this._errorCount = 0;
      this._isRecovering = false;
    } catch(e) {
      setTimeout(() => {
        if (!this.closing && !this.isDestroyed) {
          this._initAsync();
        }
      }, 5000);
    }
  }

  _incrementSubRequest() {
    try {
      this._subRequestCount++;
      this._requestCount++;
    } catch(e) {}
  }

  // ==================== TIME UTILITIES ====================

  _getCurrentWIBHour() {
    try {
      return (new Date().getUTCHours() + QUIZ_SCHEDULE.TIMEZONE_OFFSET) % 24;
    } catch(e) { return 0; }
  }

  _getCurrentWIBMinutes() {
    try {
      return new Date().getUTCMinutes();
    } catch(e) { return 0; }
  }

  _getCurrentWIBTime() {
    try {
      const now = new Date();
      const hours = (now.getUTCHours() + QUIZ_SCHEDULE.TIMEZONE_OFFSET) % 24;
      return {
        hours,
        minutes: now.getUTCMinutes(),
        totalMinutes: (hours * 60) + now.getUTCMinutes(),
        formatted: `${String(hours).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} WIB`
      };
    } catch(e) {
      return { hours: 0, minutes: 0, totalMinutes: 0, formatted: '00:00 WIB' };
    }
  }

  _formatWIBTime(hours, minutes) {
    try {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} WIB`;
    } catch(e) { return '00:00 WIB'; }
  }

  _isQuizTime() {
    try {
      const wibHour = this._getCurrentWIBHour();
      const currentTotal = (wibHour * 60) + this._getCurrentWIBMinutes();
      const startTotal = QUIZ_SCHEDULE.START_HOUR * 60;
      const endTotal = QUIZ_SCHEDULE.END_HOUR * 60;
      const isOvernight = startTotal > endTotal;
      if (isOvernight) {
        return currentTotal >= startTotal || currentTotal < endTotal;
      } else {
        return currentTotal >= startTotal && currentTotal < endTotal;
      }
    } catch(e) { return false; }
  }

  _getTimeLeftUntilNextEvent() {
    try {
      const wibTime = this._getCurrentWIBTime();
      const currentTotal = wibTime.totalMinutes;
      const startTotal = QUIZ_SCHEDULE.START_HOUR * 60;
      const endTotal = QUIZ_SCHEDULE.END_HOUR * 60;
      const isOvernight = startTotal > endTotal;
      const isQuizTime = isOvernight ? 
        (currentTotal >= startTotal || currentTotal < endTotal) : 
        (currentTotal >= startTotal && currentTotal < endTotal);

      if (isQuizTime) {
        let remainingMinutes;
        if (currentTotal >= startTotal) {
          remainingMinutes = (24 * 60) - currentTotal + endTotal;
        } else {
          remainingMinutes = endTotal - currentTotal;
        }
        const hours = Math.floor(remainingMinutes / 60);
        const minutes = Math.floor(remainingMinutes % 60);
        return {
          minutes: remainingMinutes,
          seconds: 0,
          isRunning: true,
          hours: hours,
          totalMinutes: remainingMinutes,
          status: 'running',
          currentTime: wibTime.formatted,
          startTime: this._formatWIBTime(QUIZ_SCHEDULE.START_HOUR, 0),
          endTime: this._formatWIBTime(QUIZ_SCHEDULE.END_HOUR, 0),
          startHour: QUIZ_SCHEDULE.START_HOUR,
          endHour: QUIZ_SCHEDULE.END_HOUR,
          remainingText: `${hours}h ${minutes}m`,
          isOvernight: isOvernight
        };
      }

      let targetTotal, status, dayText = "";
      if (isOvernight) {
        if (currentTotal < startTotal) {
          targetTotal = startTotal;
          status = 'before';
          dayText = "today";
        } else {
          targetTotal = startTotal + (24 * 60);
          status = 'after';
          dayText = "tomorrow";
        }
      } else {
        if (currentTotal < startTotal) {
          targetTotal = startTotal;
          status = 'before';
          dayText = "today";
        } else {
          targetTotal = startTotal + (24 * 60);
          status = 'after';
          dayText = "tomorrow";
        }
      }

      const diffMinutes = targetTotal - currentTotal;
      const hours = Math.floor(diffMinutes / 60);
      const minutes = Math.floor(diffMinutes % 60);
      return {
        hours: hours,
        minutes: minutes,
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
        dayText,
        remainingText: `${hours}h ${minutes}m`,
        isOvernight: isOvernight
      };
    } catch(e) {
      return { hours: 0, minutes: 0, isRunning: false, status: 'unknown', currentTime: '00:00 WIB' };
    }
  }

  _getCurrentWeek() {
    try {
      const now = new Date();
      const year = now.getUTCFullYear();
      const startOfYear = new Date(year, 0, 1);
      const diff = now - startOfYear;
      const week = Math.ceil((diff / 86400000 + startOfYear.getUTCDay() + 1) / 7);
      return `${year}-W${String(week).padStart(2, '0')}`;
    } catch(e) { return '2026-W01'; }
  }

  // ==================== KV HELPERS ====================

  async _getQuizPoints() {
    try {
      if (!this.env?.QUESTIONS) return {};
      const points = await this.env.QUESTIONS.get(CONSTANTS.QUIZ_POINT_KEY, 'json');
      return points || {};
    } catch(e) { return {}; }
  }

  async _getLastWeekWinner() {
    try {
      if (!this.env?.QUESTIONS) return null;
      const winner = await this.env.QUESTIONS.get(CONSTANTS.QUIZ_LAST_WEEK_WINNER, 'json');
      return winner || null;
    } catch(e) { return null; }
  }

  async _checkAndResetWeeklyPoints() {
    try {
      if (!this.env?.QUESTIONS) return false;
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

  // ==================== QUIZ SCHEDULER ====================

  _startQuizScheduler() {
    try {
      if (this.quizAutoTimer) clearInterval(this.quizAutoTimer);
      this.quizAutoTimer = setInterval(() => {
        try {
          if (this.closing || this.isDestroyed) {
            clearInterval(this.quizAutoTimer);
            this.quizAutoTimer = null;
            return;
          }
          this.translationManager.resetDailyCounter();
          this._checkQuizAutoStatus();
          this._checkAndRestartQuiz();
          const timeInfo = this._getTimeLeftUntilNextEvent();
          if (!timeInfo.isRunning) {
            if (!this.quizEndNotified) {
              this._sendQuizEndNotificationOnce();
            }
            this._broadcastQuizTimeLeft();
          }
        } catch(e) {}
      }, CONSTANTS.SCHEDULER_INTERVAL_MS);
    } catch(e) {}
  }

  async _checkQuizAutoStatus() {
    try {
      const isQuizTime = this._isQuizTime();
      if (isQuizTime) {
        this.quizEndedToday = false;
        this.quizEndMessageShown = false;
        this.quizEndNotified = false;
        if (!this.quizAutoEnabled) {
          this.quizAutoEnabled = true;
          this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", "Quiz will start soon!", false]);
          await this.startQuizWithDelay(CONSTANTS.QUIZ_START_DELAY_MS);
          if (!this._quizStartTimeout) this.forceStartQuiz();
        } else if (!this.currentQuestion && !this._quizTimeout && !this.isQuizWaiting && !this._quizStartTimeout) {
          await this._showQuestion();
        }
        return false;
      } else {
        if (this.quizAutoEnabled && !this.quizEndNotified) {
          this.quizAutoEnabled = false;
          this.quizEndedToday = true;
          this.quizEndMessageShown = false;
          await this.resetQuiz();
          this._clearQuizData();
          this._sendQuizEndNotificationOnce();
        }
        return true;
      }
    } catch(e) { return true; }
  }

  forceStartQuiz() {
    try {
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
    } catch(e) { return false; }
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
    try {
      if (!this._isQuizTime() || this.currentQuestion || this._quizTimeout || this.isQuizWaiting || this._quizStartTimeout) return;
      this.quizAutoEnabled = true;
      this._showQuestion();
    } catch(e) {}
  }

  // ==================== QUIZ CORE ====================

  async _loadAllQuestionsFromKV() {
    try {
      if (!this.env?.QUESTIONS) return false;
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
        this._isAllQuestionsLoaded = true;
        this._currentBatchStart = 0;
        this._currentBatchEnd = 0;
        this._questionPointer = 0;
        this._totalQuestionsAnswered = 0;
        this._currentBatchIndex = 0;
        this._loadNextBatch();
        return true;
      }
      return false;
    } catch(e) { return false; }
  }

  _loadNextBatch() {
    try {
      if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) return false;
      const totalQuestions = this._allQuestions.length;
      let startIndex = this._currentBatchEnd;
      if (startIndex >= totalQuestions) {
        startIndex = 0;
        this._currentBatchStart = 0;
        this._currentBatchEnd = 0;
        this._questionPointer = 0;
        this._totalQuestionsAnswered = 0;
        this._currentBatchIndex = 0;
      }
      const endIndex = Math.min(startIndex + CONSTANTS.QUIZ_BATCH_SIZE, totalQuestions);
      this.quizQuestionCache['en'] = this._allQuestions.slice(startIndex, endIndex);
      this._currentQuestions = this.quizQuestionCache['en'];
      this._currentBatchStart = startIndex;
      this._currentBatchEnd = endIndex;
      this._currentBatchIndex = Math.floor(startIndex / CONSTANTS.QUIZ_BATCH_SIZE);
      this._lastLoadedBatch = this._currentBatchIndex;
      return true;
    } catch(e) { return false; }
  }

  _checkAndLoadNextBatch() {
    try {
      const questions = this.quizQuestionCache['en'] || [];
      if (this._questionPointer >= questions.length) {
        this._loadNextBatch();
        const newQuestions = this.quizQuestionCache['en'] || [];
        if (this._currentBatchStart === 0 && newQuestions.length > 0) this._questionPointer = 0;
        return true;
      }
      return false;
    } catch(e) { return false; }
  }

  // ==================== TRANSLATION METHODS FOR NEW KV ====================

  async translateAllQuestionsToNewKV() {
    try {
      if (this.isDestroyed || this.closing) {
        return { success: false, message: "Server is shutting down" };
      }
      
      const result = await this.bulkTranslationNewKV.translateAllQuestionsToNewKV();
      
      if (result.success) {
        this._broadcastToRoom(QUIZ_ROOM, ["translationNewKVComplete", result]);
        
        const languages = await this.bulkTranslationNewKV.getAllLanguages();
        if (languages) {
          this._broadcastToRoom(QUIZ_ROOM, ["translationLanguagesInfo", {
            kvKey: TRANSLATION_KV_KEY,
            languages: languages
          }]);
        }
      }
      
      return result;
    } catch (error) {
      return {
        success: false,
        message: `Translation failed: ${error.message}`
      };
    }
  }

  async getQuestionsByLanguageFromNewKV(lang = 'en') {
    try {
      if (this.isDestroyed || this.closing) return null;
      return await this.bulkTranslationNewKV.getQuestionsByLanguage(lang);
    } catch (error) {
      return null;
    }
  }

  async getQuestionByIdFromNewKV(id, lang = 'en') {
    try {
      if (this.isDestroyed || this.closing) return null;
      return await this.bulkTranslationNewKV.getQuestionById(id, lang);
    } catch (error) {
      return null;
    }
  }

  async getAllLanguagesFromNewKV() {
    try {
      if (this.isDestroyed || this.closing) return null;
      return await this.bulkTranslationNewKV.getAllLanguages();
    } catch (error) {
      return null;
    }
  }

  async getTranslationNewKVStatus() {
    try {
      if (this.isDestroyed || this.closing) {
        return { isTranslating: false, error: "Server is shutting down" };
      }
      return await this.bulkTranslationNewKV.getTranslationStatus();
    } catch (error) {
      return { isTranslating: false, error: error.message };
    }
  }

  async checkTranslationExists() {
    try {
      if (this.isDestroyed || this.closing) return false;
      return await this.bulkTranslationNewKV.checkTranslationExists();
    } catch (error) {
      return false;
    }
  }

  // ==================== UPDATE SHOW QUESTION ====================

  async _showQuestion() {
    try {
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

      const wsIds = this.wsClients.get(QUIZ_ROOM);
      if (wsIds?.size > 0) {
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

        // Load English questions from original KV
        const enQuestions = await this._loadAllQuestionsFromKV();
        if (!enQuestions || enQuestions.length === 0) {
          this._broadcastToRoom(QUIZ_ROOM, ["quizError", "No questions available!"]);
          return;
        }

        // Use cached questions
        if (!this.quizQuestionCache['en']) {
          this.quizQuestionCache['en'] = enQuestions;
        }

        const questions = this.quizQuestionCache['en'];
        if (this._questionPointer >= questions.length) {
          this._questionPointer = 0;
        }

        const q = questions[this._questionPointer];
        if (!q?.options) { this._questionPointer++; this._showQuestion(); return; }

        const shuffled = this._shuffleQuestionOptions(q);
        this.currentQuestion = { ...q, options: shuffled.options, correct: shuffled.correct };
        this._quizStartTime = Date.now();
        this.quizAnswered = new Set();
        this.quizHasWinner = false;
        this.quizWinner = null;
        this._questionPointer++;
        this._totalQuestionsAnswered++;

        // Send to each language group using NEW KV (quiz_translations)
        for (const [lang, users] of usersByLang) {
          if (lang === 'en') {
            this._sendQuestionToUsers(users, this.currentQuestion);
          } else {
            // Try to get translated question from NEW KV
            const translated = await this.getQuestionByIdFromNewKV(
              this.currentQuestion.id || this._questionPointer,
              lang
            );
            if (translated && !translated.isFallback) {
              this._sendQuestionToUsers(users, {
                question: translated.question,
                options: translated.options,
                correct: translated.correct
              });
            } else {
              // Fallback to English
              this._sendQuestionToUsers(users, this.currentQuestion);
            }
          }
        }

        const remainingTime = CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000;
        this._broadcastQuizNotification("quizUpdate", {
          questionNumber: this._questionPointer,
          totalQuestions: this._allQuestions.length,
          hasWinner: false,
          remainingTime: `${remainingTime}s remaining`
        });

        this._broadcastToRoom(QUIZ_ROOM, [
          "quizTimeLeft",
          `Question ${this._questionPointer}/${this._allQuestions.length} - ${remainingTime}s remaining`,
          false
        ]);

        if (this._quizTimeout) clearTimeout(this._quizTimeout);
        if (this._quizBreakTimeout) clearTimeout(this._quizBreakTimeout);

        this._quizTimeout = setTimeout(async () => {
          try {
            if (this.closing || this.isDestroyed) { this._quizTimeout = null; return; }
            const currentClients = this.wsClients.get(QUIZ_ROOM);
            if (!currentClients?.size) { this._quizTimeout = null; this.currentQuestion = null; return; }

            const correctAnswer = this.currentQuestion.correct;
            const question = this.currentQuestion.question;
            const options = this.currentQuestion.options;

            this._broadcastQuizResult("quizCorrectAnswer", { question, options, correctAnswer });

            if (this.quizHasWinner && this.quizWinner) {
              const points = await this._getQuizPoints();
              points[this.quizWinner] = (points[this.quizWinner] || 0) + 1;
              if (this.env?.QUESTIONS) {
                this._incrementSubRequest();
                await this.env.QUESTIONS.put(CONSTANTS.QUIZ_POINT_KEY, JSON.stringify(points));
              }
              this._broadcastQuizNotification("quizWinner", {
                username: this.quizWinner,
                totalPoints: points[this.quizWinner] || 0
              });
              this._broadcastQuizResult("quizWinner", {
                username: this.quizWinner,
                totalPoints: points[this.quizWinner] || 0,
                correctAnswer
              });
            } else {
              this._broadcastQuizNotification("quizTimeout", { noWinner: true });
              this._broadcastQuizResult("quizNoWinner", { message: "⏰ Time is up!", correctAnswer });
            }

            this._quizTimeout = null;
            this.isQuizWaiting = true;

            this._quizBreakTimeout = setTimeout(() => {
              if (this.closing || this.isDestroyed) { this._quizBreakTimeout = null; return; }
              this.isQuizWaiting = false;
              this._quizBreakTimeout = null;
              this.currentQuestion = null;
              this._broadcastToRoom(QUIZ_ROOM, ["quizNextQuestionIn", "5"]);
              setTimeout(() => this._broadcastToRoom(QUIZ_ROOM, ["quizNextQuestionIn", "3"]), 2000);
              setTimeout(() => this._broadcastToRoom(QUIZ_ROOM, ["quizNextQuestionIn", "1"]), 4000);
              if (!this.closing && !this.isDestroyed) this.ensureQuizRunning();
            }, CONSTANTS.QUIZ_BREAK_MS);
          } catch(e) {
            this._quizTimeout = null;
            this.currentQuestion = null;
            this.isQuizWaiting = false;
          }
        }, CONSTANTS.QUIZ_TIME_LIMIT_MS);
      }
    } catch(e) {
      this.currentQuestion = null;
      this.isQuizWaiting = false;
      this._quizTimeout = null;
    }
  }

  _sendQuestionToUsers(users, question) {
    try {
      if (!users || users.length === 0 || !question) return;
      const message = ["quizQuestion", {
        question: question.question || '',
        options: question.options || { A: '', B: '', C: '', D: '' },
        isFallback: false
      }];
      const msgStr = JSON.stringify(message);
      for (const ws of users) {
        if (ws && ws.readyState === 1) {
          try { ws.send(msgStr); } catch(e) {}
        }
      }
    } catch(e) {}
  }

  async _broadcastQuizResult(type, data) {
    try {
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
    } catch(e) {}
  }

  async _forceEvaluateQuiz() {
    try {
      if (!this.currentQuestion || this._quizTimeout) return;
      const currentClients = this.wsClients.get(QUIZ_ROOM);
      if (!currentClients?.size) { this.currentQuestion = null; return; }

      const correctAnswer = this.currentQuestion.correct;
      const question = this.currentQuestion.question;
      const options = this.currentQuestion.options;

      this._broadcastQuizResult("quizCorrectAnswer", { question, options, correctAnswer });

      if (this.quizHasWinner && this.quizWinner) {
        const points = await this._getQuizPoints();
        points[this.quizWinner] = (points[this.quizWinner] || 0) + 1;
        if (this.env?.QUESTIONS) {
          this._incrementSubRequest();
          await this.env.QUESTIONS.put(CONSTANTS.QUIZ_POINT_KEY, JSON.stringify(points));
        }
        this._broadcastQuizNotification("quizWinner", {
          username: this.quizWinner,
          totalPoints: points[this.quizWinner] || 0
        });
        this._broadcastQuizResult("quizWinner", {
          username: this.quizWinner,
          totalPoints: points[this.quizWinner] || 0,
          correctAnswer
        });
      } else {
        this._broadcastQuizNotification("quizTimeout", { noWinner: true });
        this._broadcastQuizResult("quizNoWinner", { message: "⏰ Time is up!", correctAnswer });
      }

      this.currentQuestion = null;
      this.isQuizWaiting = true;

      this._quizBreakTimeout = setTimeout(() => {
        if (this.closing || this.isDestroyed) { this._quizBreakTimeout = null; return; }
        this.isQuizWaiting = false;
        this._quizBreakTimeout = null;
        if (!this.closing && !this.isDestroyed) this.ensureQuizRunning();
      }, CONSTANTS.QUIZ_BREAK_MS);
    } catch(e) {
      this.currentQuestion = null;
      this.isQuizWaiting = false;
    }
  }

  async submitQuizAnswer(ws, username, answer) {
    try {
      if (!ws || !username) { this._sendQuizErrorWithTime(ws, "ERROR", "Invalid request"); return; }
      const room = this._ensureRoomConsistency(ws);
      if (room !== QUIZ_ROOM) { this._safeSend(ws, ["quizError", "Quiz only available in Quiz room"]); return; }
      if (!this._isQuizTime()) { this._sendQuizErrorWithTime(ws, "NOT_QUIZ_TIME"); return; }
      if (!this.quizAutoEnabled) { this._sendQuizErrorWithTime(ws, "QUIZ_DISABLED"); return; }

      const clients = this.wsClients.get(QUIZ_ROOM);
      if (!clients?.size) { this._sendQuizErrorWithTime(ws, "ERROR", "Quiz is paused"); return; }

      if (!this.currentQuestion) {
        this._startQuizIfNeeded();
        if (!this.currentQuestion) { this._sendQuizErrorWithTime(ws, "QUIZ_NOT_STARTED"); return; }
      }

      if (this.quizHasWinner) { this._safeSend(ws, ["quizError", "Someone already answered correctly!"]); return; }
      if (this.quizAnswered.has(username)) { this._safeSend(ws, ["quizError", "You already answered!"]); return; }

      const answerKey = answer ? answer.toUpperCase().trim() : '';
      const isValidAnswer = ['A', 'B', 'C', 'D'].includes(answerKey);
      const isCorrect = isValidAnswer && (answerKey === this.currentQuestion.correct);

      const remaining = this._getQuestionRemainingTime();
      const remainingText = `${remaining}s remaining`;

      this._broadcastQuizNotification("quizAnswer", {
        username: username,
        answer: isValidAnswer ? answerKey : "?",
        isCorrect: isCorrect,
        remainingTime: remainingText
      });

      this._broadcastQuizResult("quizAnswerResult", {
        username,
        answer: isValidAnswer ? answerKey : "?",
        isCorrect,
        correctAnswer: this.currentQuestion.correct,
        remainingTime: remainingText
      });
      
      this.quizAnswered.add(username);

      if (isCorrect && !this.quizHasWinner) {
        this.quizHasWinner = true;
        this.quizWinner = username;
      }
    } catch(e) {
      this._safeSend(ws, ["quizError", e.message]);
    }
  }

  _startQuizLoop() {
    try {
      if (this.quizTimer) clearInterval(this.quizTimer);
      this.quizTimer = setInterval(() => {
        try {
          if (this.closing || this.isDestroyed) { 
            clearInterval(this.quizTimer); 
            this.quizTimer = null; 
            return; 
          }
          if (this._isRecovering) return;
          
          if (this._isQuizTime()) {
            this.quizEndedToday = false;
            this.quizEndMessageShown = false;
            this.quizEndNotified = false;
            if (!this.quizAutoEnabled) {
              this.quizAutoEnabled = true;
              this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", "Quiz will start soon!", true]);
            }
            if (!this.currentQuestion && !this._quizTimeout && !this.isQuizWaiting && !this._quizStartTimeout) {
              this._showQuestion();
            }
          } else {
            if (this.quizAutoEnabled && !this.quizEndNotified) {
              this.quizAutoEnabled = false;
              this.quizEndedToday = true;
              this.quizEndMessageShown = false;
              this.resetQuiz();
              this._clearQuizData();
              this._sendQuizEndNotificationOnce();
            }
          }
        } catch(e) {}
      }, CONSTANTS.QUIZ_INTERVAL_MS);
    } catch(e) {}
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
      this.quizEndNotified = false;
      this._startQuizKeepAlive();
    } catch(e) {}
  }

  async startQuizWithDelay(delayMs) {
    try {
      if (this._quizStartTimeout) return;
      this._quizStartTimeout = setTimeout(() => {
        try {
          if (this.closing || this.isDestroyed) { this._quizStartTimeout = null; return; }
          this._quizStartTimeout = null;
          if (!this.currentQuestion && this.quizAutoEnabled) this.forceStartQuiz();
        } catch(e) {}
      }, delayMs);
    } catch(e) {}
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
    try {
      if (this._quizKeepAliveInterval) clearInterval(this._quizKeepAliveInterval);
      this._quizKeepAliveInterval = setInterval(() => {
        try {
          if (this.closing || this.isDestroyed) { 
            clearInterval(this._quizKeepAliveInterval); 
            this._quizKeepAliveInterval = null; 
            return; 
          }
          this._lastHeartbeat = Date.now();
          
          if (this._isQuizTime()) {
            const now = Date.now();
            if (!this.currentQuestion && !this._quizTimeout && !this.isQuizWaiting && !this._quizStartTimeout) {
              if (this.quizAutoEnabled) this._showQuestion();
              else { this.quizAutoEnabled = true; this._showQuestion(); }
            }
            if (this.currentQuestion && this._quizStartTime) {
              const elapsed = (now - this._quizStartTime) / 1000;
              if (elapsed > (CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000) - 2 && !this._quizTimeout) {
                this._forceEvaluateQuiz();
              }
              if (elapsed > (CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000) + 10) {
                this.currentQuestion = null;
                this._quizTimeout = null;
                this._showQuestion();
              }
            }
          } else {
            if (!this.quizEndNotified && this.quizAutoEnabled) {
              this._sendQuizEndNotificationOnce();
            }
          }
        } catch(e) {}
      }, CONSTANTS.QUIZ_KEEP_ALIVE_INTERVAL_MS);
    } catch(e) {}
  }

  _clearQuizData() {
    try {
      this.currentQuestion = null;
      this._quizStartTime = null;
      this.quizAnswered = new Set();
      this.quizHasWinner = false;
      this.quizWinner = null;
      this.isQuizWaiting = false;
      
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

  // ==================== QUIZ BROADCAST HELPERS ====================

  _sendQuizTimeLeftToUser(ws) {
    try {
      if (!ws || ws.readyState !== 1) return false;
      const timeInfo = this._getTimeLeftUntilNextEvent();
      const timeLeft = this._getTimeLeftUntilNextQuiz();
      let message = "", canType = true, isQuizTime = timeInfo.isRunning;
      
      if (isQuizTime) {
        if (this.currentQuestion && this._quizStartTime) {
          const elapsed = (Date.now() - this._quizStartTime) / 1000;
          const left = Math.max(0, (CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000) - elapsed);
          const minutes = Math.floor(left / 60), seconds = Math.floor(left % 60);
          message = minutes > 0 ? `Quiz running! ${minutes}m ${seconds}s left` : `Quiz running! ${seconds}s left`;
          canType = false;
        } else {
          message = `Quiz will start soon! (${timeInfo.currentTime})`;
          canType = true;
        }
        this._safeSend(ws, ["quizTimeLeft", message, canType, isQuizTime]);
        return false;
      } else {
        message = `⏱️ ${timeLeft.text}`;
        canType = true;
        this._safeSend(ws, ["quizTimeLeft", message, canType, isQuizTime]);
        return true;
      }
    } catch(e) { return true; }
  }

  _broadcastQuizTimeLeft() {
    try {
      const wsIds = this.wsClients.get(QUIZ_ROOM);
      if (!wsIds?.size) return;
      const timeInfo = this._getTimeLeftUntilNextEvent();
      const timeLeft = this._getTimeLeftUntilNextQuiz();
      let message = "", canType = true, isQuizTime = timeInfo.isRunning;
      
      if (isQuizTime) {
        if (this.currentQuestion && this._quizStartTime) {
          const elapsed = (Date.now() - this._quizStartTime) / 1000;
          const left = Math.max(0, (CONSTANTS.QUIZ_TIME_LIMIT_MS / 1000) - elapsed);
          const minutes = Math.floor(left / 60), seconds = Math.floor(left % 60);
          message = minutes > 0 ? `Quiz running! ${minutes}m ${seconds}s left` : `Quiz running! ${seconds}s left`;
          canType = false;
        } else {
          message = `Quiz will start soon! (${timeInfo.currentTime})`;
          canType = true;
        }
      } else {
        message = `⏱️ ${timeLeft.text}`;
        canType = true;
      }
      this._broadcastToRoom(QUIZ_ROOM, ["quizTimeLeft", message, canType, isQuizTime]);
    } catch(e) {}
  }

  _sendQuizErrorWithTime(ws, errorType, customMessage = null) {
    try {
      if (!ws || ws.readyState !== 1) return false;
      const timeLeft = this._getTimeLeftUntilNextQuiz();
      let message = "";
      switch(errorType) {
        case "NOT_QUIZ_TIME":
          message = `⏱️ ${timeLeft.text}`;
          break;
        case "QUIZ_DISABLED": 
          message = `⏱️ ${timeLeft.text}`; 
          break;
        case "QUIZ_ENDED":
          message = `⏱️ ${timeLeft.text}`;
          break;
        case "QUIZ_NOT_STARTED": 
          message = `⏱️ ${timeLeft.text}`; 
          break;
        default: 
          message = customMessage || `⏱️ ${timeLeft.text}`;
      }
      this._safeSend(ws, ["quizError", message]);
      return true;
    } catch(e) { return false; }
  }

  // ==================== WEB SOCKET CORE ====================

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
      let room = this.clientRooms.get(wsId);
      if (!room) room = ws.room || ws.roomname || null;
      if (!room) {
        if (ws.username) {
          const conn = this.userConnections.get(ws.username);
          if (conn) room = conn.room;
        }
      }
      if (!room) return null;
      ws.room = room;
      ws.roomname = room;
      if (!this.wsClients.has(room)) this.wsClients.set(room, new Set());
      if (!this.wsClients.get(room).has(wsId)) {
        this.wsClients.get(room).add(wsId);
        this.clientRooms.set(wsId, room);
        this.wsMap.set(wsId, ws);
      }
      return room;
    } catch(e) { return null; }
  }

  _addClient(room, ws, username = null, isNewConnection = false) {
    try {
      if (!ws) return;
      const wsId = this._getWsId(ws);
      if (!wsId) { this._safeSend(ws, ["gameLowCardError", "Connection error"]); return; }

      if (this.clientRooms.has(wsId)) {
        const oldRoom = this.clientRooms.get(wsId);
        if (oldRoom && oldRoom !== room) this._removeClientFromRoom(oldRoom, wsId);
      }

      if (username && isNewConnection) {
        this.userConnections.set(username, { wsId, ws, room, timestamp: Date.now() });
      } else if (username) {
        const conn = this.userConnections.get(username);
        if (conn) { conn.room = room; conn.timestamp = Date.now(); conn.ws = ws; }
        else { this.userConnections.set(username, { wsId, ws, room, timestamp: Date.now() }); }
      }

      if (this.clientRooms.has(wsId)) {
        const oldRoom = this.clientRooms.get(wsId);
        if (oldRoom !== room) this._removeClientFromRoom(oldRoom, wsId);
      }

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
    } catch(e) {}
  }

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

  _removeClient(room, ws) {
    try {
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

  _setUserLanguage(ws, countryCode) {
    try {
      if (!ws) return 'en';
      const wsId = this._getWsId(ws);
      if (!wsId) return 'en';
      const lang = this.translationManager.detectAndSetLanguage(wsId, countryCode);
      this.userLanguage.set(wsId, lang);
      this.userCountry.set(wsId, countryCode);
      return lang;
    } catch(e) { return 'en'; }
  }

  _countryToLanguage(countryCode) {
    try {
      if (!countryCode) return 'en';
      return this.translationManager.getLanguageForCountry(countryCode);
    } catch(e) { return 'en'; }
  }

  // ==================== SWITCH ROOM ====================

  async switchRoom(ws, room, username = null) {
    try {
      if (this.isDestroyed) { this._safeSend(ws, ["gameLowCardError", "Server is shutting down"]); return; }
      if (!room || room.trim() === "") { this._safeSend(ws, ["gameLowCardError", "Invalid room name"]); return; }

      const roomName = room.trim();
      const wsId = this._getWsId(ws);
      if (!wsId) { this._safeSend(ws, ["gameLowCardError", "Connection error"]); return; }

      const lockKey = `switch_${wsId}`;
      if (this._switchLocks.has(lockKey)) { this._safeSend(ws, ["gameLowCardError", "Switch in progress"]); return; }
      this._switchLocks.set(lockKey, Date.now());

      try {
        const oldRoom = this.clientRooms.get(wsId);

        if (oldRoom === roomName) {
          ws.room = roomName;
          ws.roomname = roomName;
          if (roomName === QUIZ_ROOM) {
            if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) await this._initQuiz();
            if (this._isQuizTime() && !this.quizAutoEnabled) { this.quizAutoEnabled = true; this.forceStartQuiz(); }
            setTimeout(() => { if (!this.closing && !this.isDestroyed) this._sendQuizTimeLeftToUser(ws); }, CONSTANTS.QUIZ_SWITCH_DELAY_MS);
          }
          this._safeSend(ws, ["switchRoomSuccess", roomName]);
          return;
        }

        if (oldRoom) this._removeClientFromRoom(oldRoom, wsId);
        this._addClient(roomName, ws, username, false);
        ws.room = roomName;
        ws.roomname = roomName;
        ws.username = username;

        if (username) {
          let conn = this.userConnections.get(username);
          if (conn) { conn.room = roomName; conn.wsId = wsId; conn.ws = ws; conn.timestamp = Date.now(); }
          else { this.userConnections.set(username, { wsId, ws, room: roomName, timestamp: Date.now() }); }
        }

        this._safeSend(ws, ["switchRoomSuccess", roomName]);

        if (roomName === QUIZ_ROOM) {
          let country = this.userCountry.get(wsId);
          if (!country) { const cf = ws._cf || {}; country = cf.country || 'US'; this.userCountry.set(wsId, country); }
          this._setUserLanguage(ws, country);
          if (!this._isAllQuestionsLoaded || this._allQuestions.length === 0) await this._initQuiz();
          if (this._isQuizTime()) { if (!this.quizAutoEnabled) this.quizAutoEnabled = true; this.forceStartQuiz(); }
          setTimeout(() => { if (!this.closing && !this.isDestroyed) this._sendQuizTimeLeftToUser(ws); }, CONSTANTS.QUIZ_SWITCH_DELAY_MS);
          
          const remaining = this._getQuestionRemainingTime();
          const remainingText = `${remaining}s remaining`;
          this._sendQuizNotification(ws, "quizStatus", {
            isQuizTime: this._isQuizTime(),
            isActive: !!this.currentQuestion,
            remainingTime: remainingText,
            hasWinner: this.quizHasWinner,
            winner: this.quizWinner,
            correctAnswer: this.currentQuestion?.correct || null,
            questionNumber: this._questionPointer,
            totalQuestions: this._allQuestions.length
          });
        }

        this._broadcastToRoom(roomName, ["userJoinedRoom", username, roomName]);
        if (oldRoom) this._broadcastToRoom(oldRoom, ["userLeftRoom", username, oldRoom]);
      } finally {
        this._switchLocks.delete(lockKey);
      }
    } catch(e) {
      this._safeSend(ws, ["gameLowCardError", "Switch failed"]);
    }
  }

  _sendQuizNotification(ws, type, data) {
    try {
      if (!ws || ws.readyState !== 1) return;
      const remaining = this._getQuestionRemainingTime();
      const remainingText = `${remaining}s remaining`;
      const notification = {
        type: type,
        timestamp: Date.now(),
        remainingTime: remainingText,
        correctAnswer: this.currentQuestion?.correct || null,
        data: data || {}
      };
      this._safeSend(ws, ["quizNotification", notification]);
    } catch(e) {}
  }

  // ==================== BROADCAST ====================

  async _broadcastToRoom(room, message) {
    try {
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
    } catch(e) {}
  }

  _safeSend(ws, message) {
    try {
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(message));
      return true;
    } catch(e) { return false; }
  }

  // ==================== GAME LOWCARD HELPERS ====================

  _isGameActuallyRunning(game) { try { return game?._isActive === true && !game?._gameEnded; } catch(e) { return false; } }

  _isGameValid(game) { try { return game?._isActive === true && !game?._gameEnded && game?.players?.size > 0; } catch(e) { return false; } }

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
      if (!game?._isActive || game?._gameEnded || !game?.players) return [];
      return Array.from(game.players.keys()).filter(id => !game.eliminated?.has(id));
    } catch(e) { return []; }
  }

  _getRandomCardTanda() { try { return ["C1", "C2", "C3", "C4"][Math.floor(Math.random() * 4)]; } catch(e) { return "C1"; } }

  _getRandomDrawDelay() { try { return (Math.floor(Math.random() * 14) + 2) * 1000; } catch(e) { return 5000; } }

  _getBotNumberByRound(round) {
    try {
      if (round <= 2) return Math.floor(Math.random() * 12) + 1;
      return Math.random() < 0.6 ?
        [8, 9, 10, 11, 12][Math.floor(Math.random() * 5)] :
        [1, 2, 3, 4, 5, 6, 7][Math.floor(Math.random() * 7)];
    } catch(e) { return 5; }
  }

  _safeGetGame(room) {
    try {
      if (this.isDestroyed || !room) return null;
      const game = this.activeGames.get(room);
      if (game?._isActive && !game?._gameEnded && game?.players) return game;
      return null;
    } catch(e) { return null; }
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
          if (currentGame?._isActive && !currentGame._gameEnded) { this._cleanupTimers.delete(room); return; }
          this._cleanupTimers.delete(room);
          const gameToDelete = this.activeGames.get(room);
          if (gameToDelete) this._deleteGame(room, gameToDelete);
        } catch(e) {}
      }, CONSTANTS.GAME_CLEANUP_DELAY_MS);
      this._cleanupTimers.set(room, timer);
    } catch(e) {}
  }

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
    try {
      if (!username) return [];
      const result = [];
      for (const [room, game] of this.activeGames) {
        if (game?._isActive && !game._gameEnded && game.players?.has(username)) {
          result.push({ game, room });
        }
      }
      return result;
    } catch(e) { return []; }
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
    try {
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
    } catch(e) {}
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
    try {
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
    } catch(e) {}
  }

  _closeDrawPhase(room, game) {
    try {
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
    } catch(e) {}
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

  // ==================== GAME PUBLIC METHODS ====================

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

  // ==================== SHUFFLE ====================

  _shuffleQuestionOptions(question) {
    try {
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
    } catch(e) {
      return { options: question?.options || { A: '', B: '', C: '', D: '' }, correct: 'A' };
    }
  }

  _shuffleArray(array) {
    try {
      if (!array?.length) return array || [];
      const arr = array.length > CONSTANTS.MAX_ARRAY_SIZE ? array.slice(0, CONSTANTS.MAX_ARRAY_SIZE) : [...array];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    } catch(e) { return array || []; }
  }

  // ==================== EVENT HANDLER ====================

  async handleEvent(ws, data) {
    try {
      if (this.isDestroyed || !ws || !data?.[0]) return;
      this._eventQueue.push({ ws, data });
      if (!this._isProcessingQueue) {
        await this._safeExecute(async () => {
          await this._processEventQueue();
        });
      }
    } catch(e) {
      this._safeSend(ws, ["gameLowCardError", "Server is recovering, please try again"]);
    }
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
        } catch(e) {}
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
    } catch(e) {} finally {
      this._isProcessingQueue = false;
    }
  }

  async _processEventItem(ws, data) {
    try {
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

      if (evt === "translateAllQuestionsToNewKV") {
        const result = await this.translateAllQuestionsToNewKV();
        this._safeSend(ws, ["translationNewKVStatus", result]);
        return;
      }

      if (evt === "getQuestionsByLanguageFromNewKV") {
        const lang = data[1] || 'en';
        const questions = await this.getQuestionsByLanguageFromNewKV(lang);
        this._safeSend(ws, ["questionsByLanguageNewKV", { 
          language: lang, 
          questions: questions,
          total: questions?.length || 0,
          kvKey: TRANSLATION_KV_KEY
        }]);
        return;
      }

      if (evt === "getAllLanguagesFromNewKV") {
        const languages = await this.getAllLanguagesFromNewKV();
        this._safeSend(ws, ["allLanguagesNewKV", {
          kvKey: TRANSLATION_KV_KEY,
          languages: languages
        }]);
        return;
      }

      if (evt === "getTranslationNewKVStatus") {
        const status = await this.getTranslationNewKVStatus();
        this._safeSend(ws, ["translationNewKVStatus", status]);
        return;
      }

      if (evt === "checkTranslationExists") {
        const exists = await this.checkTranslationExists();
        this._safeSend(ws, ["translationExists", {
          exists: exists,
          kvKey: TRANSLATION_KV_KEY
        }]);
        return;
      }

      if (evt === "getSupportedLanguages") {
        const languages = this.translationManager.getSupportedLanguages();
        this._safeSend(ws, ["supportedLanguages", languages]);
        return;
      }

      if (evt === "getCountriesByLanguage") {
        const lang = data[1] || 'en';
        const countries = this.translationManager.getCountriesByLanguage(lang);
        this._safeSend(ws, ["countriesByLanguage", { lang, countries }]);
        return;
      }

      if (evt === "getUserLanguage") {
        const wsId = this._getWsId(ws);
        const lang = this.translationManager.getUserLanguage(wsId);
        const countryInfo = this.translationManager.getCountryInfo(this.userCountry.get(wsId));
        this._safeSend(ws, ["userLanguage", { 
          language: lang, 
          languageName: this.translationManager.getLanguageName(lang),
          country: countryInfo
        }]);
        return;
      }

      if (evt === "getQuizNotification") {
        const remaining = this._getQuestionRemainingTime();
        const remainingText = `${remaining}s remaining`;
        const timeLeft = this._getTimeLeftUntilNextQuiz();
        const notification = {
          type: "quizStatus",
          timestamp: Date.now(),
          remainingTime: remainingText,
          correctAnswer: this.currentQuestion?.correct || null,
          data: {
            isQuizTime: this._isQuizTime(),
            isActive: !!this.currentQuestion,
            hasWinner: this.quizHasWinner,
            winner: this.quizWinner,
            questionNumber: this._questionPointer,
            totalQuestions: this._allQuestions.length,
            timeLeft: timeLeft.text
          }
        };
        this._safeSend(ws, ["quizNotification", notification]);
        return;
      }

      if (evt === "getQuizStatus") {
        const isQuizTime = this._isQuizTime();
        const timeLeft = this._getTimeLeftUntilNextQuiz();
        let status = {
          isQuizTime: isQuizTime,
          isActive: !!this.currentQuestion,
          hasEnded: this.quizEndedToday || !isQuizTime,
          timeLeft: timeLeft.text
        };
        this._safeSend(ws, ["quizStatus", status]);
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
    } catch(e) {
      this._safeSend(ws, ["gameLowCardError", "Error processing event"]);
    }
  }

  // ==================== CLEANUP ====================

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
          for (const [username, conn] of this.userConnections) {
            if (conn?.wsId === wsId) { this.userConnections.delete(username); break; }
          }
        }
      }
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
            quizActive: !!this.currentQuestion,
            gamesRunning: this.activeGames.size,
            wsConnections: this.wsMap.size,
            eventQueueSize: this._eventQueue?.length || 0,
            errorCount: this._errorCount,
            timestamp: Date.now()
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
