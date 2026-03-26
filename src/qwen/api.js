const axios = require('axios');
const http = require('http');
const https = require('https');
const { QwenAuthManager } = require('./auth.js');
const { PassThrough } = require('stream');
const path = require('path');
const { promises: fs } = require('fs');
const crypto = require('crypto');
const { AccountHealthManager } = require('../utils/accountHealthManager.js');
const { isRateLimitError } = require('../utils/errorFormatter.js');
const { ProxyManager } = require('../utils/proxyManager.js');
const config = require('../config.js');

// Create HTTP agents with connection pooling
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  freeSocketTimeout: 30000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  freeSocketTimeout: 30000
});

// Default Qwen configuration
const DEFAULT_QWEN_API_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3-coder-plus';
const QWEN_CODE_VERSION = '0.12.0';

// Model aliases - maps client-facing model names to actual Qwen model names
const MODEL_ALIASES = {
  'qwen3.5-plus': 'coder-model'
};

function resolveModelAlias(model) {
  return MODEL_ALIASES[model] || model;
}

/**
 * Generate User-Agent header matching qwen-code CLI format
 * @returns {string} User-Agent string
 */
function generateUserAgent() {
  const platform = process.platform;
  const arch = process.arch;
  return `QwenCode/${QWEN_CODE_VERSION} (${platform}; ${arch})`;
}

/**
 * Generate unique request ID for tracing
 * @returns {string} UUID v4
 */
function generateRequestId() {
  return crypto.randomUUID();
}

/**
 * Build standard headers for DashScope API requests
 * @param {string} accessToken - The OAuth access token
 * @param {boolean} isStreaming - Whether this is a streaming request
 * @returns {Object} Headers object
 */
function buildDashScopeHeaders(accessToken, isStreaming = false) {
  const headers = {
    'connection': 'keep-alive',
    'accept': 'application/json',
    'authorization': `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': 'QwenCode/0.11.1 (linux; x64)',
    'x-dashscope-authtype': 'qwen-oauth',
    'x-dashscope-cachecontrol': 'enable',
    'x-dashscope-useragent': 'QwenCode/0.11.1 (linux; x64)',
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'Linux',
    'x-stainless-package-version': '5.11.0',
    'x-stainless-retry-count': '1',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v18.19.1',
    'accept-language': '*',
    'sec-fetch-mode': 'cors',
  };
  
  if (isStreaming) {
    headers['accept'] = 'text/event-stream';
  }
  
  return headers;
}

// Model-specific limits
const MODEL_LIMITS = {
  'vision-model': { maxTokens: 32768 },
  'qwen3-vl-plus': { maxTokens: 32768 },
  'qwen3-vl-max': { maxTokens: 32768 },
};

/**
 * Clamp max_tokens based on model limits
 * @param {string} model - Model name
 * @param {number} maxTokens - Requested max_tokens
 * @returns {number} - Clamped max_tokens
 */
function clampMaxTokens(model, maxTokens) {
  const limit = MODEL_LIMITS[model];
  if (limit && maxTokens > limit.maxTokens) {
    return limit.maxTokens;
  }
  return maxTokens;
}

// List of known Qwen models
const QWEN_MODELS = [
  {
    id: 'qwen3-coder-plus',
    object: 'model',
    created: 1754686206,
    owned_by: 'qwen'
  },
  {
    id: 'qwen3-coder-flash',
    object: 'model',
    created: 1754686206,
    owned_by: 'qwen'
  },
  {
    id: 'qwen3-coder-flash',
    object: 'model',
    created: 1754686206,
    owned_by: 'qwen'
  },
  {
    id: 'coder-model',
    object: 'model',
    created: 1754686206,
    owned_by: 'qwen'
  },
  {
    id: 'vision-model',
    object: 'model',
    created: 1754686206,
    owned_by: 'qwen'
  }
];

/**
 * Process messages to handle image content for vision models
 * @param {Array} messages - Array of messages
 * @param {string} model - Model name
 * @returns {Array} Processed messages
 */
function processMessagesForVision(messages, model) {
  // Only process for vision-model
  if (model !== 'vision-model') {
    return messages;
  }

  return messages.map(message => {
    if (!message.content) {
      return message;
    }

    // If content is already an array, assume it's properly formatted
    if (Array.isArray(message.content)) {
      return message;
    }

    // If content is a string, check if it contains image references
    if (typeof message.content === 'string') {
      // Look for base64 image patterns or URLs
      const imagePatterns = [
        /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g,
        /https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|bmp)/gi
      ];

      let hasImages = false;
      const content = message.content;
      const parts = [{ type: 'text', text: content }];

      // Extract base64 images
      const base64Matches = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g);
      if (base64Matches) {
        hasImages = true;
        base64Matches.forEach(match => {
          const mimeMatch = match.match(/data:image\/([^;]+);base64,/);
          const mimeType = mimeMatch ? mimeMatch[1] : 'png';
          const base64Data = match.split(',')[1];
          
          parts.push({
            type: 'image_url',
            image_url: {
              url: match
            }
          });
        });
      }

      // Extract image URLs
      const urlMatches = content.match(/https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|bmp)/gi);
      if (urlMatches) {
        hasImages = true;
        urlMatches.forEach(url => {
          parts.push({
            type: 'image_url',
            image_url: {
              url: url
            }
          });
        });
      }

      // If no images found, keep as string
      if (!hasImages) {
        return message;
      }

      return {
        ...message,
        content: parts
      };
    }

    return message;
  });
}

/**
 * Check if an error is related to authentication/authorization
 */
function isAuthError(error) {
  if (!error) return false;

  const errorMessage = 
    error instanceof Error 
      ? error.message.toLowerCase() 
      : String(error).toLowerCase();

  // Define a type for errors that might have status or code properties
  const errorWithCode = error;
  const errorCode = errorWithCode?.response?.status || errorWithCode?.code;

  return (
    errorCode === 400 ||
    errorCode === 401 ||
    errorCode === 403 ||
    errorMessage.includes('unauthorized') ||
    errorMessage.includes('forbidden') ||
    errorMessage.includes('invalid api key') ||
    errorMessage.includes('invalid access token') ||
    errorMessage.includes('token expired') ||
    errorMessage.includes('authentication') ||
    errorMessage.includes('access denied') ||
    (errorMessage.includes('token') && errorMessage.includes('expired')) ||
    // Also check for 504 errors which might be related to auth issues
    errorCode === 504 ||
    errorMessage.includes('504') ||
    errorMessage.includes('gateway timeout')
  );
}

/**
 * Check if an error is related to quota limits
 */
function isQuotaExceededError(error) {
  if (!error) return false;

  const errorMessage =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  // Define a type for errors that might have status or code properties
  const errorWithCode = error;
  const errorCode = errorWithCode?.response?.status || errorWithCode?.code;

  return (
    errorMessage.includes('insufficient_quota') ||
    errorMessage.includes('free allocated quota exceeded') ||
    (errorMessage.includes('quota') && errorMessage.includes('exceeded'))
  );
}

/**
 * Check if an error is a network/proxy transport error (not HTTP error)
 * @param {Error} error - The error object
 * @returns {boolean} True if network/proxy error
 */
function isNetworkProxyError(error) {
  if (!error) return false;

  const code = error.code || error.cause?.code || '';
  const message = String(error.message || '').toLowerCase();

  const networkCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ECONNABORTED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'ERR_SOCKET_CLOSED'
  ]);

  if (networkCodes.has(code)) return true;

  return (
    message.includes('socket hang up') ||
    message.includes('tunneling socket') ||
    message.includes('proxy connection') ||
    message.includes('connect econn')
  );
}

class QwenAPI {
  constructor() {
    this.authManager = new QwenAuthManager();
    this.requestCount = new Map();
    this.tokenUsage = new Map();
    this.lastResetDate = new Date().toISOString().split('T')[0];
    this.requestCountFile = path.join(this.authManager.qwenDir, 'request_counts.json');
    
    this.lastSaveTime = 0;
    this.saveInterval = 60000;
    this.pendingSave = false;
    
    this.accountLocks = new Map();
    this.accountQueues = new Map();
    
    this.webSearchRequestCounts = new Map();
    this.webSearchResultCounts = new Map();
    
    this.healthManager = new AccountHealthManager(this.authManager.qwenDir, config.maxRequestsPerMinute);
    this.proxyManager = new ProxyManager(config);
    
    this.lastBindingSignature = null;
    
    this.loadRequestCounts();
  }

  /**
   * Load request counts from disk
   */
  async loadRequestCounts() {
    try {
      const data = await fs.readFile(this.requestCountFile, 'utf8');
      const counts = JSON.parse(data);
      
      // Restore last reset date
      if (counts.lastResetDate) {
        this.lastResetDate = counts.lastResetDate;
      }
      
      // Restore request counts
      if (counts.requests) {
        for (const [accountId, count] of Object.entries(counts.requests)) {
          this.requestCount.set(accountId, count);
        }
      }
      
      // Restore token usage data
      if (counts.tokenUsage) {
        for (const [accountId, usageData] of Object.entries(counts.tokenUsage)) {
          this.tokenUsage.set(accountId, usageData);
        }
      }
      
      // Restore web search request counts
      if (counts.webSearchRequests) {
        for (const [accountId, count] of Object.entries(counts.webSearchRequests)) {
          this.webSearchRequestCounts.set(accountId, count);
        }
      }
      
      // Restore web search result counts (with migration for old data)
      if (counts.webSearchResults) {
        for (const [accountId, count] of Object.entries(counts.webSearchResults)) {
          this.webSearchResultCounts.set(accountId, count);
        }
      } else {
        // Migration: If webSearchResults doesn't exist, initialize with 0
        console.log('Migrating old data structure - adding webSearchResults tracking');
        for (const accountId of this.webSearchRequestCounts.keys()) {
          this.webSearchResultCounts.set(accountId, 0);
        }
      }
      
      // Reset counts if we've crossed into a new UTC day
      this.resetRequestCountsIfNeeded();
    } catch (error) {
      // File doesn't exist or is invalid, start with empty counts
      this.resetRequestCountsIfNeeded();
    }
  }

  /**
   * Save request counts to disk
   */
  async saveRequestCounts() {
    try {
      const counts = {
        lastResetDate: this.lastResetDate,
        requests: Object.fromEntries(this.requestCount),
        webSearchRequests: Object.fromEntries(this.webSearchRequestCounts),
        webSearchResults: Object.fromEntries(this.webSearchResultCounts),
        tokenUsage: Object.fromEntries(this.tokenUsage)
      };
      await fs.writeFile(this.requestCountFile, JSON.stringify(counts, null, 2));
      this.lastSaveTime = Date.now();
      this.pendingSave = false;
    } catch (error) {
      console.warn('Failed to save request counts:', error.message);
      this.pendingSave = false;
    }
  }

  /**
   * Schedule a save operation with debouncing
   */
  scheduleSave() {
    // Don't schedule if save is already pending
    if (this.pendingSave) return;
    
    this.pendingSave = true;
    const now = Date.now();
    
    // If saved recently, wait for interval, otherwise save immediately
    if (now - this.lastSaveTime < this.saveInterval) {
      setTimeout(() => this.saveRequestCounts(), this.saveInterval);
    } else {
      // Save immediately
      this.saveRequestCounts();
    }
  }

  /**
   * Reset request counts if we've crossed into a new UTC day
   */
  resetRequestCountsIfNeeded() {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.lastResetDate) {
      this.requestCount.clear();
      this.webSearchRequestCounts.clear();
      this.webSearchResultCounts.clear();
      this.lastResetDate = today;
      console.log('Request counts reset for new UTC day');
      this.saveRequestCounts();
    }
  }

  /**
   * Increment web search request count for an account
   */
  async incrementWebSearchRequestCount(accountId) {
    const currentCount = this.webSearchRequestCounts.get(accountId) || 0;
    this.webSearchRequestCounts.set(accountId, currentCount + 1);
    this.scheduleSave();
  }

  /**
   * Get web search request count for an account
   */
  getWebSearchRequestCount(accountId) {
    return this.webSearchRequestCounts.get(accountId) || 0;
  }

  /**
   * Increment web search result count for an account
   */
  async incrementWebSearchResultCount(accountId, resultCount) {
    const currentCount = this.webSearchResultCounts.get(accountId) || 0;
    this.webSearchResultCounts.set(accountId, currentCount + resultCount);
    this.scheduleSave();
  }

  /**
   * Get web search result count for an account
   */
  getWebSearchResultCount(accountId) {
    return this.webSearchResultCounts.get(accountId) || 0;
  }

  /**
   * Increment request count for an account
   * @param {string} accountId - The account ID
   */
  async incrementRequestCount(accountId) {
    this.resetRequestCountsIfNeeded();
    const currentCount = this.requestCount.get(accountId) || 0;
    this.requestCount.set(accountId, currentCount + 1);
    
    // Schedule save instead of saving immediately
    this.scheduleSave();
  }

  /**
   * Record token usage for an account
   * @param {string} accountId - The account ID
   * @param {number} inputTokens - Number of input tokens
   * @param {number} outputTokens - Number of output tokens
   */
  async recordTokenUsage(accountId, inputTokens, outputTokens) {
    try {
      // Get current date in YYYY-MM-DD format
      const currentDate = new Date().toISOString().split('T')[0];
      
      // Initialize token usage array for this account if it doesn't exist
      if (!this.tokenUsage.has(accountId)) {
        this.tokenUsage.set(accountId, []);
      }
      
      const accountUsage = this.tokenUsage.get(accountId);
      
      // Find existing entry for today
      let todayEntry = accountUsage.find(entry => entry.date === currentDate);
      
      if (todayEntry) {
        // Update existing entry
        todayEntry.inputTokens += inputTokens;
        todayEntry.outputTokens += outputTokens;
      } else {
        // Create new entry for today
        accountUsage.push({
          date: currentDate,
          inputTokens: inputTokens,
          outputTokens: outputTokens
        });
}
      
      // Schedule save instead of saving immediately
      this.scheduleSave();
    } catch (error) {
      console.warn('Failed to record token usage:', error.message);
    }
  }

  /**
   * Get request count for an account
   * @param {string} accountId - The account ID
   * @returns {number} The request count
   */
  getRequestCount(accountId) {
    this.resetRequestCountsIfNeeded();
    return this.requestCount.get(accountId) || 0;
  }

  normalizeAccountId(accountId) {
    return accountId || 'default';
  }

  async loadCredentialsForAccount(accountId) {
    if (accountId === 'default') {
      return await this.authManager.loadCredentials();
    }

    return this.authManager.getAccountCredentials(accountId);
  }

  async refreshCredentialsForAccount(accountId, credentials) {
    return await this.authManager.performTokenRefresh(
      credentials,
      accountId === 'default' ? null : accountId
    );
  }

  async prepareAccountCandidate(accountId, options = {}) {
    const { ignoreBlocked = false, ignoreRateLimit = false } = options;

    await this.healthManager.ready;

    if (!ignoreBlocked && this.healthManager.isBlocked(accountId)) {
      return null;
    }

    if (!ignoreRateLimit && this.healthManager.isRateLimited(accountId, true)) {
      return null;
    }

    let credentials = await this.loadCredentialsForAccount(accountId);
    if (!credentials) {
      return null;
    }

    if (!this.authManager.isTokenValid(credentials)) {
      console.log(`\x1b[33mAccount ${accountId} expired, refreshing...\x1b[0m`);
      try {
        credentials = await this.refreshCredentialsForAccount(accountId, credentials);
        console.log(`\x1b[32mAccount ${accountId} refreshed successfully\x1b[0m`);
      } catch (refreshError) {
        console.log(`\x1b[31mFailed to refresh ${accountId}: ${refreshError.message}\x1b[0m`);
        return null;
      }
    }

    return {
      accountId,
      credentials,
      strikes: this.healthManager.getStrikes(accountId),
      minutesLeft: (credentials.expiry_date - Date.now()) / 60000,
    };
  }

  async getPreparedAccounts(accountIds, options = {}) {
    const prepared = [];

    for (const accountId of accountIds) {
      const candidate = await this.prepareAccountCandidate(accountId, options);
      if (candidate) {
        prepared.push(candidate);
      }
    }

    return prepared;
  }

  async getCandidatePool(accountIds, attemptsByAccount = new Map()) {
    const untriedIds = accountIds.filter((accountId) => !attemptsByAccount.has(accountId));
    let candidates = await this.getPreparedAccounts(untriedIds);


    if (candidates.length > 0) {
      return candidates;
    }

    const singleAccountFallback = accountIds.length === 1;

    candidates = await this.getPreparedAccounts(accountIds, {
      ignoreBlocked: singleAccountFallback,
      ignoreRateLimit: singleAccountFallback,
    });

    return candidates;
  }

  async executeAttemptWithLock(accountInfo, executeAttempt) {
    const lockAcquired = await this.acquireAccountLock(accountInfo.accountId);
    if (!lockAcquired) {
      const lockError = new Error(`Account ${accountInfo.accountId} is currently in use`);
      lockError.code = 'ACCOUNT_LOCKED';
      throw lockError;
    }

    try {
      return await executeAttempt(accountInfo);
    } finally {
      this.releaseAccountLock(accountInfo.accountId);
    }
  }

  /**
   * Sleep for a given number of milliseconds
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Refresh account proxy bindings from the full account list
   * Called at startup and when account list changes
   */
  async refreshAccountProxyBindings() {
    await this.authManager.loadAllAccounts();

    const allAccountIds = (this.authManager.getAccountIds().length > 0
      ? this.authManager.getAccountIds()
      : ['default'])
      .slice()
      .sort();

    const signature = JSON.stringify(allAccountIds);
    if (this.lastBindingSignature === signature && this.proxyManager.hasBindings()) {
      return;
    }

    this.proxyManager.initializeBindings(allAccountIds);
    this.lastBindingSignature = signature;
  }

  /**
   * Build list of accounts to use for a request
   * @param {Object} request - The request object
   * @returns {Array<string>} List of account IDs
   */
  buildAccountList(request) {
    const accountIds = this.proxyManager.resolveRequestAccountIds(request.accountId);

    if (request.accountId) {
      return accountIds;
    }

    return this.authManager.getRotationOrderedAccountIds(accountIds);
  }

  /**
   * Wait for account and IP rate limits before making a request
   * @param {string} accountId - The account ID
   * @returns {Promise<string>} The proxy ID to use
   */
  async waitForAccountAndIpRateLimit(accountId) {
    while (this.healthManager.isRateLimited(accountId)) {
      const accountRemainingTime = this.healthManager.getRateLimitRemainingTime(accountId);
      if (accountRemainingTime > 0) {
        console.log(`\x1b[36mAccount rate limit hit for ${accountId} (${this.healthManager.getRateLimitCount(accountId)}/${this.healthManager.rateLimitMax} requests/min, ${Math.round(accountRemainingTime / 1000)}s remaining)\x1b[0m`);
        await this.sleep(accountRemainingTime);
      }
    }

    const proxyId = this.proxyManager.ensureUsableProxyForAccount(accountId);
    if (!proxyId) {
      const error = new Error(`No usable proxy route is currently available for account ${accountId}`);
      error.code = 'NO_USABLE_PROXY_ROUTE';
      throw error;
    }

    while (this.proxyManager.isIpRateLimited(proxyId)) {
      const ipRemainingTime = this.proxyManager.getIpRateLimitRemainingTime(proxyId);
      if (ipRemainingTime > 0) {
        console.log(`\x1b[36mIP rate limit hit for ${proxyId} (${this.proxyManager.getIpRateLimitCount(proxyId)}/${this.proxyManager.rateLimitMax} requests/min, ${Math.round(ipRemainingTime / 1000)}s remaining)\x1b[0m`);
        await this.sleep(ipRemainingTime);
      }
    }

    return proxyId;
  }

  /**
   * Get axios configuration for a given account
   * @param {string} accountId - The account ID
   * @param {Object} options - Options object
   * @param {boolean} options.stream - Whether this is a streaming request
   * @returns {Object} Axios configuration object
   */
  getAxiosConfigForAccount(accountId, { stream = false } = {}) {
    const proxyId = this.proxyManager.ensureUsableProxyForAccount(accountId);
    if (!proxyId) {
      const error = new Error(`No usable proxy route is currently available for account ${accountId}`);
      error.code = 'NO_USABLE_PROXY_ROUTE';
      throw error;
    }
    return this.proxyManager.getAxiosNetworkConfig(proxyId, { stream });
  }

  /**
   * Handle successful proxy usage (record success and increment IP rate limit)
   * @param {string} accountId - The account ID
   */
  handleSuccessfulProxyUsage(accountId) {
    const proxyId = this.proxyManager.getProxyForAccount(accountId);
    if (!proxyId) return;
    this.proxyManager.recordProxySuccess(proxyId);
    this.proxyManager.incrementIpRateLimit(proxyId);
  }

  /**
   * Normalize an operation error into a standardized outcome object
   * @param {Object} accountInfo - The account info
   * @param {Error} error - The error that occurred
   * @returns {Object|null} Normalized outcome object or null if auth error needing refresh
   */
  normalizeOperationError(accountInfo, error) {
    if (error?.code === 'ACCOUNT_LOCKED') {
      return { error, countStrike: false, locked: true };
    }

    if (error?.code === 'NO_USABLE_PROXY_ROUTE') {
      return {
        error,
        countStrike: false,
        locked: false,
        isNoUsableProxyRoute: true,
      };
    }

    if (isQuotaExceededError(error)) {
      return {
        error,
        countStrike: false,
        locked: false,
        isQuotaExceeded: true,
      };
    }

    const proxyId = this.proxyManager.getProxyForAccount(accountInfo.accountId);
    if (proxyId && isNetworkProxyError(error)) {
      const becameBad = this.proxyManager.recordProxyNetworkError(proxyId);
      if (becameBad) {
        this.proxyManager.rebindAccountFromBadProxy(accountInfo.accountId);
      }

      return {
        error,
        countStrike: false,
        locked: false,
        isProxyNetworkError: true,
      };
    }

    if (!isAuthError(error)) {
      return {
        error,
        countStrike: false,
        locked: false,
      };
    }

    return null;
  }

  async executeOperationWithAccount(accountInfo, executeAttempt, rateLimitRetryCount = 0) {
    try {
      return await this.executeAttemptWithLock(accountInfo, executeAttempt);
    } catch (error) {
      const normalizedInitialError = this.normalizeOperationError(accountInfo, error);

      if (
        normalizedInitialError?.locked ||
        normalizedInitialError?.isNoUsableProxyRoute ||
        normalizedInitialError?.isProxyNetworkError ||
        normalizedInitialError?.isQuotaExceeded
      ) {
        throw normalizedInitialError;
      }

      // Handle rate limit errors (429) with exponential backoff
      if (isRateLimitError(error)) {
        const errorMessage = error?.response?.data?.message || error?.message || 'Too Many Requests';
        const statusCode = error?.response?.status || 429;
        
        // Get current rate limit counts for debugging
        const accountCount = this.healthManager.getRateLimitCount(accountInfo.accountId);
        const proxyId = this.proxyManager.getProxyForAccount(accountInfo.accountId);
        const ipCount = proxyId ? this.proxyManager.getIpRateLimitCount(proxyId) : 0;
        
        console.log(`\x1b[33mRate limit hit for ${accountInfo.accountId}: ${statusCode} ${errorMessage} (account: ${accountCount}/${this.healthManager.rateLimitMax}, ip: ${ipCount}/${this.proxyManager.rateLimitMax})\x1b[0m`);
        
        // Check if we've exhausted rate limit retries
        if (rateLimitRetryCount >= config.rateLimitMaxRetries) {
          console.log(`\x1b[31mRate limit retries exhausted for ${accountInfo.accountId} after ${rateLimitRetryCount} attempts\x1b[0m`);
          throw {
            error,
            countStrike: false,
            locked: false,
            isRateLimit: true
          };
        }
        
        // Calculate exponential backoff delay: 2s, 4s, 8s, 16s, 32s
        const baseDelay = config.rateLimitRetryDelayMs;
        const exponentialDelay = baseDelay * Math.pow(2, rateLimitRetryCount);
        const jitter = Math.random() * 1000; // Add up to 1s jitter to prevent thundering herd
        const totalDelay = exponentialDelay + jitter;
        
        console.log(`\x1b[36mWaiting ${Math.round(totalDelay)}ms before retry ${rateLimitRetryCount + 1}/${config.rateLimitMaxRetries} for ${accountInfo.accountId}\x1b[0m`);
        await this.sleep(totalDelay);
        
        // Retry with the same account
        try {
          return await this.executeAttemptWithLock(accountInfo, executeAttempt);
        } catch (retryError) {
          if (retryError?.code === 'ACCOUNT_LOCKED') {
            throw { error: retryError, countStrike: false, locked: true };
          }

          if (isRateLimitError(retryError)) {
            return await this.executeOperationWithAccount(accountInfo, executeAttempt, rateLimitRetryCount + 1);
          }

          const normalizedRetryError = this.normalizeOperationError(accountInfo, retryError);
          if (normalizedRetryError) {
            throw normalizedRetryError;
          }

          throw {
            error: retryError,
            countStrike: false,
            locked: false,
          };
        }
      }

      if (normalizedInitialError) {
        throw normalizedInitialError;
      }

      console.log(`\x1b[33mAuth error for ${accountInfo.accountId}, attempting refresh...\x1b[0m`);

      let refreshedCredentials;
      try {
        refreshedCredentials = await this.refreshCredentialsForAccount(accountInfo.accountId, accountInfo.credentials);
      } catch (refreshError) {
        const normalizedAuthRetryError = this.normalizeOperationError(accountInfo, refreshError);
        if (normalizedAuthRetryError) {
          throw normalizedAuthRetryError;
        }
        throw { error: refreshError, countStrike: false, locked: false };
      }

      try {
        return await this.executeAttemptWithLock(
          {
            ...accountInfo,
            credentials: refreshedCredentials,
          },
          executeAttempt
        );
      } catch (retryError) {
        const normalizedAuthRetryError = this.normalizeOperationError(accountInfo, retryError);
        if (normalizedAuthRetryError) {
          throw normalizedAuthRetryError;
        }

        throw { error: retryError, countStrike: false, locked: false };
      }
    }
  }

  async executeWithAccountRotation(accountIds, executeAttempt, onSuccess) {
    await this.healthManager.ready;

    const attemptsByAccount = new Map();
    let attemptsUsed = 0;
    let lastError = null;
    const maxAttempts = this.healthManager.getMaxAttempts();

    while (attemptsUsed < maxAttempts) {
      const candidates = await this.getCandidatePool(accountIds, attemptsByAccount);

      if (candidates.length === 0) {
        break;
      }

      let attemptedRequest = false;

      for (const candidate of candidates) {
        try {
          attemptsUsed += 1;
          attemptsByAccount.set(candidate.accountId, (attemptsByAccount.get(candidate.accountId) || 0) + 1);

          console.log(`\x1b[36mSelected account for request attempt: ${candidate.accountId}\x1b[0m`);
          const result = await this.executeOperationWithAccount(candidate, executeAttempt);
          attemptedRequest = true;
          await onSuccess(candidate.accountId, result);
          this.healthManager.resetStrikes(candidate.accountId);
          return result;
        } catch (outcome) {
          if (outcome.locked) {
            attemptsUsed -= 1;
            const currentAttempts = (attemptsByAccount.get(candidate.accountId) || 1) - 1;
            if (currentAttempts > 0) {
              attemptsByAccount.set(candidate.accountId, currentAttempts);
            } else {
              attemptsByAccount.delete(candidate.accountId);
            }
            continue;
          }

          attemptedRequest = true;
          lastError = outcome.error || outcome;

          // Handle rate limit errors - don't add strikes, just try next account
          if (outcome.isRateLimit) {
            console.log(`\x1b[33mAccount ${candidate.accountId} rate limited, trying next account...\x1b[0m`);
            break;
          }

          // Handle no usable proxy route - don't add strikes, just try next account
          if (outcome.isNoUsableProxyRoute) {
            console.warn(`\x1b[33mAccount ${candidate.accountId} currently has no usable proxy route, trying next account...\x1b[0m`);
            break;
          }

          // Handle proxy/network transport errors - don't add strikes, just try next account
          if (outcome.isProxyNetworkError) {
            console.warn(`\x1b[33mAccount ${candidate.accountId} hit a proxy/network transport error, trying next account...\x1b[0m`);
            break;
          }

          // Handle quota exhaustion - the ONLY case that adds a strike
          if (outcome.isQuotaExceeded) {
            const errorMessage = outcome.error?.response?.data?.message || outcome.error?.message || 'quota exceeded';
            this.healthManager.addStrike(candidate.accountId, `quota exceeded: ${errorMessage}`);
            console.warn(`\x1b[33mAccount ${candidate.accountId} hit quota exhaustion, strike added and trying next account...\x1b[0m`);
            break;
          }

          // Generic non-quota failures - no strike added
          console.warn(`\x1b[33mAccount ${candidate.accountId} failed without quota exhaustion; no strike added.\x1b[0m ${outcome.error}`);
          break;
        }
      }

      if (!attemptedRequest) {
        lastError = lastError || new Error('All candidate accounts are currently in use');
        break;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('No available accounts after exhausting all attempts');
  }

  async getApiEndpoint(credentials) {
    // Check if credentials contain a custom endpoint
    if (credentials && credentials.resource_url) {
      let endpoint = credentials.resource_url;
      // Ensure it has a scheme
      if (!endpoint.startsWith('http')) {
        endpoint = `https://${endpoint}`;
      }
      // Ensure it has the /v1 suffix
      if (!endpoint.endsWith('/v1')) {
        if (endpoint.endsWith('/')) {
          endpoint += 'v1';
        } else {
          endpoint += '/v1';
        }
      }
      return endpoint;
    } else {
      // Use default endpoint
      return DEFAULT_QWEN_API_BASE_URL;
    }
  }

  async chatCompletions(request) {
    await this.refreshAccountProxyBindings();
    const configuredAccounts = this.buildAccountList(request);

    return await this.executeWithAccountRotation(
      configuredAccounts,
      async (accountInfo) => {
        await this.waitForAccountAndIpRateLimit(accountInfo.accountId);
        return this.processRequestWithAccount(request, accountInfo);
      },
      async (accountId, response) => {
        await this.incrementRequestCount(accountId);
        this.healthManager.incrementAccountRateLimit(accountId);
        this.handleSuccessfulProxyUsage(accountId);

        if (response && response.usage) {
          await this.recordTokenUsage(
            accountId,
            response.usage.prompt_tokens || 0,
            response.usage.completion_tokens || 0
          );
        }
      }
    );
  }

  async processRequestWithAccount(request, accountInfo) {
    const { credentials } = accountInfo;
    
    const apiEndpoint = await this.getApiEndpoint(credentials);
    const url = `${apiEndpoint}/chat/completions`;
    const model = resolveModelAlias(request.model) || DEFAULT_MODEL;
    
    const processedMessages = processMessagesForVision(request.messages, model);
    const maxTokens = clampMaxTokens(model, request.max_tokens);
    
    const payload = {
      model: model,
      messages: processedMessages,
      temperature: request.temperature,
      max_tokens: maxTokens,
      top_p: request.top_p,
      top_k: request.top_k,
      repetition_penalty: request.repetition_penalty,
      tools: request.tools,
      tool_choice: request.tool_choice,
      reasoning: request.reasoning,
      stream: false
    };

    const headers = buildDashScopeHeaders(credentials.access_token, false);

    const networkConfig = this.getAxiosConfigForAccount(accountInfo.accountId, { stream: false });

    const response = await axios.post(url, payload, {
      headers,
      timeout: 300000,
      ...networkConfig,
    });

    return response.data;
  }

  async chatCompletionsSingleAccount(request) {
    return await this.chatCompletions({ ...request, accountId: 'default' });
  }

  /**
   * Acquire a lock for an account to prevent concurrent requests
   * @param {string} accountId - The account ID to lock
   * @returns {Promise<boolean>} True if lock was acquired, false otherwise
   */
  async acquireAccountLock(accountId) {
    const normalizedId = this.normalizeAccountId(accountId);

    if (!this.accountLocks.has(normalizedId)) {
      this.accountLocks.set(normalizedId, true);
      return true;
    }

    return false;
  }

  /**
   * Release a lock for an account
   * @param {string} accountId - The account ID to unlock
   */
  releaseAccountLock(accountId) {
    const normalizedId = this.normalizeAccountId(accountId);

    if (this.accountLocks.has(normalizedId)) {
      this.accountLocks.delete(normalizedId);
    }
  }

  async listModels() {
    console.log('Returning mock models list');
    
    return {
      object: 'list',
      data: QWEN_MODELS
    };
  }

  async processStreamingRequestWithAccount(request, accountInfo) {
    const { credentials } = accountInfo;
    const apiEndpoint = await this.getApiEndpoint(credentials);
    const url = `${apiEndpoint}/chat/completions`;
    const model = resolveModelAlias(request.model) || DEFAULT_MODEL;
    const processedMessages = processMessagesForVision(request.messages, model);
    const maxTokens = clampMaxTokens(model, request.max_tokens);
    const payload = {
      model,
      messages: processedMessages,
      temperature: request.temperature,
      max_tokens: maxTokens,
      top_p: request.top_p,
      top_k: request.top_k,
      repetition_penalty: request.repetition_penalty,
      tools: request.tools,
      tool_choice: request.tool_choice,
      reasoning: request.reasoning,
      stream: true,
      stream_options: { include_usage: true }
    };
    const headers = buildDashScopeHeaders(credentials.access_token, true);
    const stream = new PassThrough();

    const networkConfig = this.getAxiosConfigForAccount(accountInfo.accountId, { stream: true });

    const response = await axios.post(url, payload, {
      headers,
      timeout: 300000,
      ...networkConfig,
    });

    response.data.pipe(stream);
    return stream;
  }

  /**
   * Stream chat completions from Qwen API
   * @param {Object} request - The chat completion request
   * @returns {Promise<Stream>} - A stream of SSE events
   */
  async streamChatCompletions(request) {
    await this.refreshAccountProxyBindings();
    const configuredAccounts = this.buildAccountList(request);

    return await this.executeWithAccountRotation(
      configuredAccounts,
      async (accountInfo) => {
        await this.waitForAccountAndIpRateLimit(accountInfo.accountId);
        return this.processStreamingRequestWithAccount(request, accountInfo);
      },
      async (accountId) => {
        await this.incrementRequestCount(accountId);
        this.healthManager.incrementAccountRateLimit(accountId);
        this.handleSuccessfulProxyUsage(accountId);
      }
    );
  }

  /**
   * Perform web search using Qwen's web search API
   * @param {Object} request - The web search request
     * @returns {Promise<Object>} - Web search results
   */
  async webSearch(request) {
    await this.refreshAccountProxyBindings();
    const configuredAccounts = this.buildAccountList(request);

    return await this.executeWithAccountRotation(
      configuredAccounts,
      async (accountInfo) => {
        await this.waitForAccountAndIpRateLimit(accountInfo.accountId);
        return this.processWebSearchWithAccount(request, accountInfo);
      },
      async (accountId, response) => {
        await this.incrementWebSearchRequestCount(accountId);
        this.healthManager.incrementAccountRateLimit(accountId);
        this.handleSuccessfulProxyUsage(accountId);

        const resultCount = response?.data?.docs?.length || 0;
        if (resultCount > 0) {
          await this.incrementWebSearchResultCount(accountId, resultCount);
        }
      }
    );
  }

  /**
   * Get web search API endpoint (different from chat endpoint)
   */
  async getWebSearchEndpoint(credentials) {
    if (credentials && credentials.resource_url) {
      let endpoint = credentials.resource_url;
      if (!endpoint.startsWith('http')) {
        endpoint = `https://${endpoint}`;
      }
      endpoint = endpoint.replace(/\/$/, '');
      return endpoint;
    } else {
      return 'https://dashscope.aliyuncs.com/compatible-mode';
    }
  }

  /**
   * Process web search request with a specific account
   */
  async processWebSearchWithAccount(request, accountInfo) {
    const { accountId, credentials } = accountInfo;
    
    const webSearchBaseUrl = await this.getWebSearchEndpoint(credentials);
    const webSearchUrl = `${webSearchBaseUrl}/api/v1/indices/plugin/web_search`;
    
    const payload = {
      uq: request.query,
      page: request.page || 1,
      rows: request.rows || 10
    };

    const headers = buildDashScopeHeaders(credentials.access_token, false);

    const networkConfig = this.getAxiosConfigForAccount(accountInfo.accountId, { stream: false });

    const response = await axios.post(webSearchUrl, payload, {
      headers,
      timeout: 300000,
      ...networkConfig,
    });

    console.log(`\x1b[32mWeb search completed using ${accountId}. Found ${response.data?.data?.total || 0} results.\x1b[0m`);
    return response.data;
  }

  /**
   * Web search for single account mode
   */
  async webSearchSingleAccount(request) {
    return await this.webSearch({ ...request, accountId: 'default' });
  }
}

module.exports = { QwenAPI };
