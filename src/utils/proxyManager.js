/**
 * ProxyManager - Manages proxy configuration and IP-based rate limiting
 * 
 * Features:
 * - Manages list of configured proxies
 * - Falls back to virtual local proxy (127.0.0.1-default) if no proxies configured
 * - Binds accounts to proxies in 1-to-1 fashion
 * - Tracks IP-based rate limits per proxy
 * - Tracks proxy health and disables bad proxies after consecutive network errors
 * - Rebinds accounts to replacement proxies when their assigned proxy fails
 */

const http = require('http');
const https = require('https');
const { ProxyAgent } = require('proxy-agent');

class ProxyManager {
  constructor(config) {
    this.availableProxies = [];
    this.proxyUrls = new Map();
    this.accountProxyMapping = new Map();
    this.ipRateLimits = new Map();

    this.hasConfiguredProxyList = false;
    this.useDefaultWithList = false;
    this.skippedAccounts = [];

    this.boundAccountIds = [];
    this.allAccountIds = [];
    this.bindingInitialized = false;
   
    this.proxyConsecutiveNetworkErrors = new Map();
    this.proxyDisabledUntil = new Map();
    this.proxyCooldownMs = config.badProxyCooldownMs || 10 * 60 * 1000;
    this.proxyConsecutiveNetworkErrorsThreshold = config.proxyConsecutiveNetworkErrors || 3;
   
    this.directHttpAgent = new http.Agent({ keepAlive: true });
    this.directHttpsAgent = new https.Agent({ keepAlive: true });
    this.proxyAgents = new Map();
   
    this.rateLimitWindow = 60000;
    this.rateLimitMax = config.maxRequestsPerMinutePerIp || 60;
   
    this.recoveryCheckInterval = null;
    this.recoveryCheckIntervalMs = config.proxyRecoveryCheckIntervalMs || 60000;
   
    this.initialize(config);
   }
  
  /**
   * Initialize proxy manager with configuration
   * @param {Object} config - Configuration object
   */
  initialize(config) {
    const proxyListStr = config.proxyList || '';
    const useDefaultWithList = config.useDefaultProxyWithList === true;

    const configuredProxies = this.parseProxyList(proxyListStr);
    this.hasConfiguredProxyList = configuredProxies.length > 0;
    this.useDefaultWithList = useDefaultWithList;

    if (configuredProxies.length === 0) {
      this.addProxy('127.0.0.1-default', null);
      console.log('\x1b[36mProxyManager:\x1b[0m Initialized in local-only mode with virtual proxy 127.0.0.1-default');
    } else {
      configuredProxies.forEach((url, index) => {
        const proxyId = `proxy-${index}`;
        this.addProxy(proxyId, url);
      });

      if (useDefaultWithList) {
        this.addProxy('127.0.0.1-default', null);
        console.log(`\x1b[36mProxyManager:\x1b[0m Initialized with ${configuredProxies.length} configured proxies plus local routing`);
      } else {
        console.log(`\x1b[36mProxyManager:\x1b[0m Initialized with ${configuredProxies.length} configured proxies`);
      }
    }

    this.availableProxies.forEach(proxyId => {
      this.ipRateLimits.set(proxyId, {
        count: 0,
        resetTime: Date.now() + this.rateLimitWindow
      });
    });
  }
  
  /**
   * Parse proxy list from comma-separated string
   * @param {string} proxyListStr - Comma-separated proxy URLs
   * @returns {Array<string>} Array of proxy URLs
   */
  parseProxyList(proxyListStr) {
    if (!proxyListStr || proxyListStr.trim() === '') return [];
    return proxyListStr.split(',').map(p => p.trim()).filter(p => p);
  }
  
  /**
   * Add a proxy to the available list
   * @param {string} proxyId - Unique identifier for the proxy
   * @param {string|null} url - Proxy URL (null for virtual proxy)
   */
  addProxy(proxyId, url) {
    this.availableProxies.push(proxyId);
    if (url) {
      this.proxyUrls.set(proxyId, url);
    }
  }
  
  /**
   * Check if a proxy is a virtual proxy (no actual URL)
   * @param {string} proxyId - The proxy ID
   * @returns {boolean} True if virtual proxy
   */
  isVirtualProxy(proxyId) {
    return !this.proxyUrls.has(proxyId);
  }

  /**
   * Get the proxy URL for a given proxy ID
   * @param {string} proxyId - The proxy ID
   * @returns {string|null} The proxy URL or null if virtual
   */
  getProxyUrl(proxyId) {
    return this.proxyUrls.get(proxyId) || null;
  }

  /**
   * Get or create a ProxyAgent for a given proxy ID
   * @param {string} proxyId - The proxy ID
   * @returns {ProxyAgent|null} The ProxyAgent or null if virtual proxy
   */
  getProxyAgent(proxyId) {
    const proxyUrl = this.getProxyUrl(proxyId);
    if (!proxyUrl) return null;

    if (!this.proxyAgents.has(proxyId)) {
      this.proxyAgents.set(proxyId, new ProxyAgent(proxyUrl));
    }

    return this.proxyAgents.get(proxyId);
  }

  /**
   * Get axios network configuration for a given proxy ID
   * @param {string} proxyId - The proxy ID
   * @param {Object} options - Options object
   * @param {boolean} options.stream - Whether this is a streaming request
   * @returns {Object} Axios configuration object
   */
  getAxiosNetworkConfig(proxyId, { stream = false } = {}) {
    const proxyUrl = this.getProxyUrl(proxyId);
    const config = proxyUrl
      ? {
          httpAgent: this.getProxyAgent(proxyId),
          httpsAgent: this.getProxyAgent(proxyId),
          proxy: false,
        }
      : {
          httpAgent: this.directHttpAgent,
          httpsAgent: this.directHttpsAgent,
          proxy: false,
        };

    if (stream) {
      config.responseType = 'stream';
    }

    return config;
  }

  /**
   * Check if a proxy is currently usable (not in cooldown)
   * @param {string} proxyId - The proxy ID
   * @returns {boolean} True if usable
   */
  isProxyUsable(proxyId) {
    if (!proxyId) return false;
    if (this.isVirtualProxy(proxyId)) return true;

    const disabledUntil = this.proxyDisabledUntil.get(proxyId);
    if (!disabledUntil) return true;

    if (Date.now() >= disabledUntil) {
      this.proxyDisabledUntil.delete(proxyId);
      this.proxyConsecutiveNetworkErrors.set(proxyId, 0);
      return true;
    }

    return false;
  }

  /**
   * Record a successful request through a proxy (resets error counter)
   * @param {string} proxyId - The proxy ID
   */
  recordProxySuccess(proxyId) {
    if (!proxyId || this.isVirtualProxy(proxyId)) return;
    this.proxyConsecutiveNetworkErrors.set(proxyId, 0);
  }

  /**
   * Record a network/proxy error for a proxy
   * @param {string} proxyId - The proxy ID
   * @returns {boolean} True if proxy became bad and was disabled
   */
  recordProxyNetworkError(proxyId) {
    if (!proxyId || this.isVirtualProxy(proxyId)) return false;

    const nextCount = (this.proxyConsecutiveNetworkErrors.get(proxyId) || 0) + 1;
    this.proxyConsecutiveNetworkErrors.set(proxyId, nextCount);

    if (nextCount < this.proxyConsecutiveNetworkErrorsThreshold) {
      console.warn(`\x1b[33mProxyManager:\x1b[0m Proxy '${proxyId}' network error streak ${nextCount}/${this.proxyConsecutiveNetworkErrorsThreshold}`);
      return false;
    }

    const disabledUntil = Date.now() + this.proxyCooldownMs;
    this.proxyDisabledUntil.set(proxyId, disabledUntil);
    this.proxyConsecutiveNetworkErrors.set(proxyId, 0);

    console.warn(`\x1b[31mProxyManager:\x1b[0m Proxy '${proxyId}' disabled for ${Math.round(this.proxyCooldownMs / 60000)} minutes due to repeated network/proxy errors`);
    return true;
  }

  /**
   * Check if a proxy is assigned to another account (excluding the given account)
   * @param {string} proxyId - The proxy ID to check
   * @param {string|null} excludeAccountId - Account ID to exclude from check
   * @returns {boolean} True if proxy is assigned to another account
   */
  isProxyAssignedToAnotherAccount(proxyId, excludeAccountId = null) {
    for (const [accountId, assignedProxyId] of this.accountProxyMapping.entries()) {
      if (accountId === excludeAccountId) continue;
      if (assignedProxyId === proxyId) return true;
    }
    return false;
  }

  /**
   * Find a replacement proxy for a failed proxy (only free spare slots)
   * @param {string} currentProxyId - The current (failed) proxy ID
   * @param {string|null} excludeAccountId - Account ID to exclude from slot occupancy check
   * @returns {string|null} A replacement proxy ID or null if none available
   */
  findReplacementProxyId(currentProxyId, excludeAccountId = null) {
  	const candidates = [];
  	
  	for (const proxyId of this.availableProxies) {
  		if (proxyId === currentProxyId) {
  			candidates.push({ proxyId, status: 'skipped', reason: 'current proxy' });
  			continue;
  		}
  		if (!this.isProxyUsable(proxyId)) {
  			candidates.push({ proxyId, status: 'skipped', reason: 'not usable (disabled or rate limited)' });
  			continue;
  		}
  		if (this.isProxyAssignedToAnotherAccount(proxyId, excludeAccountId)) {
  			candidates.push({ proxyId, status: 'skipped', reason: 'assigned to another account' });
  			continue;
  		}
  		candidates.push({ proxyId, status: 'available' });
  		return proxyId;
  	}
  	
  	// Log why no replacement was found
  	console.log(`\x1b[33m[ProxyManager] No replacement found for proxy '${currentProxyId}':\x1b[0m`);
  	candidates.forEach(c => {
  		console.log(`\x1b[33m  - ${c.proxyId}: ${c.status} (${c.reason})\x1b[0m`);
  	});
  	
  	return null;
  }
  
  /**
   * Rebind an account from a bad proxy to a replacement (only free spare slots)
   * @param {string} accountId - The account ID
   * @returns {string|null} The new proxy ID or null if no replacement
   */
  rebindAccountFromBadProxy(accountId) {
  	const currentProxyId = this.accountProxyMapping.get(accountId);
  	const replacementProxyId = this.findReplacementProxyId(currentProxyId, accountId);
  
  	if (!replacementProxyId) {
  		console.warn(`\x1b[33m[ProxyManager] Account '${accountId}' has no replacement proxy, will wait for recovery\x1b[0m`);
  		return null;
  	}
  
  	this.accountProxyMapping.set(accountId, replacementProxyId);
  	console.warn(`\x1b[36m[ProxyManager] Account '${accountId}' re-bound from '${currentProxyId}' to '${replacementProxyId}'\x1b[0m`);
  	return replacementProxyId;
  }

  /**
   * Ensure an account has a usable proxy, rebinding if necessary
   * @param {string} accountId - The account ID
   * @returns {string|null} The proxy ID to use or null if none available
   */
  ensureUsableProxyForAccount(accountId) {
    const currentProxyId = this.accountProxyMapping.get(accountId);
    if (!currentProxyId) return null;
    if (this.isProxyUsable(currentProxyId)) return currentProxyId;
    return this.rebindAccountFromBadProxy(accountId);
  }

  /**
   * Initialize persistent bindings from the full account list
   * Called once at startup or when account list changes
   * @param {Array<string>} accountIds - List of all account IDs
   * @returns {Array<string>} List of bound (usable) account IDs
   */
  initializeBindings(accountIds) {
    this.accountProxyMapping.clear();
    this.skippedAccounts = [];
    this.boundAccountIds = [];
    this.allAccountIds = [...accountIds];

    if (!this.hasConfiguredProxyList) {
      const localProxyId = '127.0.0.1-default';
      for (const accountId of accountIds) {
        this.accountProxyMapping.set(accountId, localProxyId);
        this.boundAccountIds.push(accountId);
      }
      this.bindingInitialized = true;
      return this.boundAccountIds;
    }

    const maxAccounts = this.availableProxies.length;
    const usableAccounts = accountIds.slice(0, maxAccounts);
    const skippedAccounts = accountIds.slice(maxAccounts);

    this.skippedAccounts = skippedAccounts;
    this.boundAccountIds = usableAccounts;

    usableAccounts.forEach((accountId, index) => {
      const proxyId = this.availableProxies[index];
      this.accountProxyMapping.set(accountId, proxyId);
    });

    this.bindingInitialized = true;
    return this.boundAccountIds;
  }

  /**
   * Check if bindings have been initialized
   * @returns {boolean} True if bindings are initialized
   */
  hasBindings() {
    return this.bindingInitialized;
  }

  /**
   * Get the list of bound (usable) account IDs
   * @returns {Array<string>} Copy of bound account IDs
   */
  getBoundAccountIds() {
    return [...this.boundAccountIds];
  }

  /**
   * Get the list of all account IDs
   * @returns {Array<string>} Copy of all account IDs
   */
  getAllAccountIds() {
    return [...this.allAccountIds];
  }

  /**
   * Check if an account is usable (has a binding)
   * @param {string} accountId - The account ID
   * @returns {boolean} True if account is usable
   */
  isAccountUsable(accountId) {
    return this.accountProxyMapping.has(accountId);
  }

  /**
   * Get account IDs that currently have a usable proxy route
   * @returns {Array<string>} List of routable account IDs
   */
  getRoutableAccountIds() {
    return this.boundAccountIds.filter(accountId => {
      return !!this.ensureUsableProxyForAccount(accountId);
    });
  }

  /**
   * Resolve account IDs for a request based on binding state
   * @param {string|null} requestedAccountId - The requested account ID (optional)
   * @returns {Array<string>} List of account IDs to use for this request
   */
  resolveRequestAccountIds(requestedAccountId) {
    if (!this.bindingInitialized) {
      throw new Error('Proxy bindings are not initialized');
    }

    if (requestedAccountId) {
      if (!this.isAccountUsable(requestedAccountId)) {
        const error = new Error(`Requested account ${requestedAccountId} is not usable in the current proxy mode`);
        error.code = 'ACCOUNT_NOT_USABLE_IN_PROXY_MODE';
        throw error;
      }

      const proxyId = this.ensureUsableProxyForAccount(requestedAccountId);
      if (!proxyId) {
        const error = new Error(`No usable proxy route is currently available for account ${requestedAccountId}`);
        error.code = 'NO_USABLE_PROXY_ROUTE';
        throw error;
      }

      return [requestedAccountId];
    }

    const routableAccountIds = this.getRoutableAccountIds();
    if (routableAccountIds.length === 0) {
      const error = new Error('No usable account/proxy route is currently available');
      error.code = 'NO_USABLE_PROXY_ROUTE';
      throw error;
    }

    return routableAccountIds;
  }
  
  /**
   * Get the proxy ID assigned to an account
   * @param {string} accountId - The account ID
   * @returns {string} The proxy ID or undefined if not bound
   */
  getProxyForAccount(accountId) {
    return this.accountProxyMapping.get(accountId);
  }
  
  /**
   * Get all available proxy IDs
   * @returns {Array<string>} List of available proxy IDs
   */
  getAvailableProxies() {
    return this.availableProxies;
  }
  
  /**
   * Check if a proxy is rate limited
   * @param {string} proxyId - The proxy ID
   * @returns {boolean} True if rate limited
   */
  isIpRateLimited(proxyId) {
    const now = Date.now();
    const limitData = this.ipRateLimits.get(proxyId);
    
    if (!limitData) return false;
    
    let count = limitData.count || 0;
    let resetTime = limitData.resetTime || now + this.rateLimitWindow;
    
    // Reset if window has passed
    if (now >= resetTime) {
      count = 0;
      resetTime = now + this.rateLimitWindow;
      this.ipRateLimits.set(proxyId, { count, resetTime });
    }
    
    if (count >= this.rateLimitMax) {
      const remainingSecs = Math.round((resetTime - now) / 1000);
      console.log(`\x1b[33mIP rate limit hit for ${proxyId} (${count}/${this.rateLimitMax} requests/min, ${remainingSecs}s remaining)\x1b[0m`);
      return true;
    }
    
    return false;
  }
  
  /**
   * Get the remaining time until IP rate limit window resets
   * @param {string} proxyId - The proxy ID
   * @returns {number} Remaining time in milliseconds (0 if not rate limited)
   */
  getIpRateLimitRemainingTime(proxyId) {
    const now = Date.now();
    const limitData = this.ipRateLimits.get(proxyId);
    
    if (!limitData) return 0;
    
    let resetTime = limitData.resetTime || now;
    
    if (now >= resetTime) {
      return 0;
    }
    
    return resetTime - now;
  }
  
  /**
   * Wait for IP rate limit window to reset if necessary
   * @param {string} proxyId - The proxy ID
   * @returns {Promise<void>}
   */
  async waitForIpRateLimit(proxyId) {
    const remainingTime = this.getIpRateLimitRemainingTime(proxyId);
    
    if (remainingTime > 0) {
      console.log(`\x1b[36mProxyManager:\x1b[0m Waiting ${Math.round(remainingTime)}ms for IP rate limit window to reset (${proxyId})`);
      await this.sleep(remainingTime);
    }
  }
  
  /**
   * Increment the IP rate limit counter for a proxy
   * @param {string} proxyId - The proxy ID
   */
  incrementIpRateLimit(proxyId) {
    const now = Date.now();
    const limitData = this.ipRateLimits.get(proxyId);
    
    if (!limitData) {
      // Initialize if not exists
      this.ipRateLimits.set(proxyId, {
        count: 1,
        resetTime: now + this.rateLimitWindow
      });
      return;
    }
    
    let count = limitData.count || 0;
    let resetTime = limitData.resetTime || now + this.rateLimitWindow;
    
    // Reset if window has passed
    if (now >= resetTime) {
      count = 0;
      resetTime = now + this.rateLimitWindow;
    }
    
    this.ipRateLimits.set(proxyId, {
      count: count + 1,
      resetTime
    });
  }
  
  /**
   * Get current IP rate limit count for a proxy
   * @param {string} proxyId - The proxy ID
   * @returns {number} Current request count in the window
   */
  getIpRateLimitCount(proxyId) {
    const now = Date.now();
    const limitData = this.ipRateLimits.get(proxyId);
    
    if (!limitData) return 0;
    
    let count = limitData.count || 0;
    let resetTime = limitData.resetTime || now + this.rateLimitWindow;
    
    if (now >= resetTime) {
      return 0;
    }
    
    return count;
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
   * Get a startup summary describing the proxy routing configuration (read-only)
   * @returns {Array<string>} Lines of the summary
   */
  getStartupSummary() {
    const totalAccountIds = this.getAllAccountIds();
    const usableAccountIds = this.getBoundAccountIds();
    const skippedAccounts = [...this.skippedAccounts];
    const lines = [];

    if (!this.hasConfiguredProxyList) {
      lines.push('Proxy mode: local-only virtual proxy');
      lines.push('Local routing allowed: yes (this is the only route)');
    } else {
      lines.push('Proxy mode: dedicated account-to-proxy binding');
      lines.push(`Local routing allowed with proxy list: ${this.useDefaultWithList ? 'yes' : 'no'}`);
    }

    lines.push(`Total accounts found: ${totalAccountIds.length}`);
    lines.push(`Usable accounts in current mode: ${usableAccountIds.length}`);

    for (const accountId of usableAccountIds) {
      const proxyId = this.accountProxyMapping.get(accountId);
      const proxyUrl = this.getProxyUrl(proxyId);
      const proxyDisplay = proxyUrl ? `${proxyId} (${proxyUrl})` : proxyId;
      lines.push(`${accountId} -> ${proxyDisplay}`);
    }

    if (skippedAccounts.length > 0) {
      lines.push(`Skipped accounts: ${skippedAccounts.join(', ')}`);
    }

    return lines;
   }
   
   /**
    * Get binding information for all accounts
    * @returns {Object} Mapping of account IDs to proxy IDs
    */
   getAccountBindings() {
    return Object.fromEntries(this.accountProxyMapping);
   }
   
   /**
    * Get rate limit status for all proxies
    * @returns {Object} Status information for each proxy
    */
   getRateLimitStatus() {
    const status = {};
   
    for (const proxyId of this.availableProxies) {
    	const count = this.getIpRateLimitCount(proxyId);
    	const remainingTime = this.getIpRateLimitRemainingTime(proxyId);
   
    	status[proxyId] = {
    		count,
    		limit: this.rateLimitMax,
    		remainingTimeMs: remainingTime,
    		isLimited: count >= this.rateLimitMax
    	};
    }
   
    return status;
   }
   
   /**
    * Activate a skipped account with an available proxy
    * @param {string} availableProxyId - The proxy ID to assign
    * @returns {string|null} The activated account ID or null if no skipped accounts
    */
   activateSkippedAccount(availableProxyId) {
    if (this.skippedAccounts.length === 0) {
    	return null;
    }
   
    const accountId = this.skippedAccounts.shift();
    this.accountProxyMapping.set(accountId, availableProxyId);
    this.boundAccountIds.push(accountId);
   
    console.log(`\x1b[32m[ProxyManager] Activated skipped account '${accountId}' with proxy '${availableProxyId}'\x1b[0m`);
    return accountId;
   }
   
   /**
    * Activate skipped accounts when all bound accounts are blocked
    * This is a fallback mechanism to ensure service continuity
    * @param {string[]} blockedAccountIds - Array of currently blocked account IDs
    * @returns {string[]} Array of newly activated account IDs
    */
   activateSkippedAccountsForBlockedAccounts(blockedAccountIds) {
    if (this.skippedAccounts.length === 0) {
    	return [];
    }
   
    const activatedAccounts = [];
    const blockedSet = new Set(blockedAccountIds);
   
    // Find bound accounts that are in the blocked list
    const blockedBoundAccounts = this.boundAccountIds.filter(id => blockedSet.has(id));
   
    if (blockedBoundAccounts.length === 0) {
    	return [];
    }
   
    // For each blocked bound account, try to activate a skipped account with its proxy
    for (const blockedAccountId of blockedBoundAccounts) {
    	if (this.skippedAccounts.length === 0) {
    		break;
    	}
   
    	const proxyId = this.accountProxyMapping.get(blockedAccountId);
    	if (!proxyId || !this.isProxyUsable(proxyId)) {
    		continue;
    	}
   
    	// Activate a skipped account with the same proxy
    	// Note: This creates a many-to-one mapping (multiple accounts -> same proxy)
    	const skippedAccountId = this.skippedAccounts.shift();
    	this.accountProxyMapping.set(skippedAccountId, proxyId);
    	this.boundAccountIds.push(skippedAccountId);
    	activatedAccounts.push(skippedAccountId);
   
    	console.log(`\x1b[32m[ProxyManager] Activated skipped account '${skippedAccountId}' as fallback for blocked account '${blockedAccountId}' with proxy '${proxyId}'\x1b[0m`);
    }
   
    return activatedAccounts;
   }
   
   /**
    * Find an account that currently has no usable proxy
    * @returns {string|null} The account ID or null if all accounts have usable proxies
    */
   findAccountWithoutUsableProxy() {
    for (const [accountId, proxyId] of this.accountProxyMapping.entries()) {
    	if (!this.isProxyUsable(proxyId)) {
    		return accountId;
    	}
    }
    return null;
   }
   
   /**
    * Check and recover proxies that have finished their cooldown period
    * Also rebinds accounts that were waiting for proxy recovery
    */
   checkAndRecoverProxies() {
    const now = Date.now();
    const recoveredProxies = [];
   
    for (const [proxyId, disabledUntil] of this.proxyDisabledUntil.entries()) {
    	if (now >= disabledUntil) {
    		this.proxyDisabledUntil.delete(proxyId);
    		this.proxyConsecutiveNetworkErrors.delete(proxyId);
    		recoveredProxies.push(proxyId);
    		console.log(`\x1b[32m[ProxyManager] Proxy '${proxyId}' recovered and available again\x1b[0m`);
    	}
    }
   
    // For each recovered proxy, try to rebind accounts
    for (const proxyId of recoveredProxies) {
    	// First priority: accounts that have no usable proxy
    	const accountWithoutProxy = this.findAccountWithoutUsableProxy();
    	if (accountWithoutProxy) {
    		this.accountProxyMapping.set(accountWithoutProxy, proxyId);
    		console.log(`\x1b[36m[ProxyManager] Re-bound account '${accountWithoutProxy}' to recovered proxy '${proxyId}'\x1b[0m`);
    		continue;
    	}
   
    	// Second priority: activate skipped accounts
    	if (this.skippedAccounts.length > 0) {
    		this.activateSkippedAccount(proxyId);
    	}
    }
   }
   
   /**
    * Start periodic proxy recovery check
    * @param {number} intervalMs - Interval in milliseconds (default: 60000)
    */
   startProxyRecoveryCheck(intervalMs) {
    if (this.recoveryCheckInterval) {
    	clearInterval(this.recoveryCheckInterval);
    }
   
    const interval = intervalMs || this.recoveryCheckIntervalMs;
    this.recoveryCheckInterval = setInterval(() => {
    	this.checkAndRecoverProxies();
    }, interval);
   
    console.log(`\x1b[36m[ProxyManager] Started proxy recovery check (every ${interval / 1000}s)\x1b[0m`);
   }
   
   /**
    * Stop periodic proxy recovery check
    */
   stopProxyRecoveryCheck() {
    if (this.recoveryCheckInterval) {
    	clearInterval(this.recoveryCheckInterval);
    	this.recoveryCheckInterval = null;
    	console.log(`\x1b[36m[ProxyManager] Stopped proxy recovery check\x1b[0m`);
    }
   }
   }
   
   module.exports = { ProxyManager };
