const express = require('express');
const cors = require('cors');
const { QwenOpenAIProxy } = require('./proxy.js');
const { QwenAPI } = require('./qwen/api.js');
const { QwenAuthManager } = require('./qwen/auth.js');
const { AccountRefreshScheduler } = require('./utils/accountRefreshScheduler.js');
const { systemPromptTransformer } = require('./utils/systemPromptTransformer.js');
const liveLogger = require('./utils/liveLogger.js');
const fileLogger = require('./utils/fileLogger.js');
const { mcpGetHandler, mcpPostHandler } = require('./mcp.js');
const { ResponsesStateStore } = require('./responses/responsesStateStore.js');

function createApp(dependencies = {}) {
  const {
    qwenAPI: injectedQwenAPI,
    authManager: injectedAuthManager,
    responsesStateStore: injectedResponsesStateStore,
    configOverride: injectedConfig
  } = dependencies;

  const config = injectedConfig || require('./config.js');
  
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));
  app.use(cors());

  const authManager = injectedAuthManager || new QwenAuthManager();
  const qwenAPI = injectedQwenAPI || new QwenAPI();
  
  if (injectedAuthManager) {
    qwenAPI.authManager = injectedAuthManager;
  }

  const responsesStateStore = injectedResponsesStateStore || new ResponsesStateStore();

  const proxy = new QwenOpenAIProxy({
    qwenAPI: qwenAPI,
    authManager: authManager,
    config: config,
    responsesStateStore
  });

  const validateApiKey = (req, res, next) => {
    if (!config.apiKey) {
      return next();
    }

    const apiKey = req.headers["x-api-key"] || req.headers["authorization"];

    let cleanApiKey = null;
    if (apiKey && typeof apiKey === "string") {
      if (apiKey.startsWith("Bearer ")) {
        cleanApiKey = apiKey.substring(7).trim();
      } else {
        cleanApiKey = apiKey.trim();
      }
    }

    if (!cleanApiKey || !config.apiKey?.includes(cleanApiKey)) {
      console.error("\x1b[31m%s\x1b[0m", "Unauthorized request - Invalid or missing API key");
      return res.status(401).json({
        error: {
          message: "Invalid or missing API key",
          type: "authentication_error",
        },
      });
    }

    next();
  };

  // Apply API key middleware to all routes
  app.use("/v1/", validateApiKey);
  app.use("/auth/", validateApiKey);

  // Routes
  app.post('/v1/chat/completions', (req, res) => proxy.handleChatCompletion(req, res));
  app.post('/v1/web/search', (req, res) => proxy.handleWebSearch(req, res));
  app.get('/v1/models', (req, res) => proxy.handleModels(req, res));
  app.post('/v1/responses', (req, res) => proxy.handleResponses(req, res, { responsesStateStore }));

  // Authentication routes
  app.post('/auth/initiate', (req, res) => proxy.handleAuthInitiate(req, res));
  app.post('/auth/poll', (req, res) => proxy.handleAuthPoll(req, res));

  // MCP endpoints
  app.get('/mcp', mcpGetHandler);
  app.post('/mcp', mcpPostHandler);

  // Health check endpoint
  app.get('/health', async (req, res) => {
    try {
      await qwenAPI.authManager.loadAllAccounts();
      await qwenAPI.healthManager.ready;
      const defaultCredentials = await qwenAPI.authManager.loadCredentials();
      const accountIds = qwenAPI.authManager.getAccountIds();

      const accounts = [];
      let totalRequestsToday = 0;

      if (defaultCredentials) {
        const minutesLeft = (defaultCredentials.expiry_date - Date.now()) / 60000;
        const status = minutesLeft < 0 ? 'expired' : 'healthy';
        const expiresIn = Math.max(0, minutesLeft);
        const requestCount = qwenAPI.getRequestCount('default');
        const webSearchCount = qwenAPI.getWebSearchRequestCount('default');
        totalRequestsToday += requestCount;

        accounts.push({
          id: 'default',
          status,
          expiresIn: expiresIn ? `${expiresIn.toFixed(1)} minutes` : null,
          requestCount: requestCount,
          webSearchCount: webSearchCount
        });
      }

      const healthStatus = qwenAPI.healthManager.getStatus();

      for (const accountId of accountIds) {
        const credentials = qwenAPI.authManager.getAccountCredentials(accountId);
        let status = 'unknown';
        let expiresIn = null;

        if (credentials) {
          const minutesLeft = (credentials.expiry_date - Date.now()) / 60000;
          const isBlocked = qwenAPI.healthManager.isBlocked(accountId);
          
          if (isBlocked) {
            status = 'blocked';
          } else if (minutesLeft < 0) {
            status = 'expired';
          } else if (minutesLeft < 30) {
            status = 'expiring_soon';
          } else {
            status = 'healthy';
          }
          expiresIn = Math.max(0, minutesLeft);
        }

        const requestCount = qwenAPI.getRequestCount(accountId);
        const webSearchCount = qwenAPI.getWebSearchRequestCount(accountId);
        const strikes = qwenAPI.healthManager.getStrikes(accountId);
        totalRequestsToday += requestCount;

        accounts.push({
          id: accountId.substring(0, 5),
          status,
          expiresIn: expiresIn ? `${expiresIn.toFixed(1)} minutes` : null,
          requestCount: requestCount,
          webSearchCount: webSearchCount,
          strikes: strikes
        });
      }

      const healthyCount = accounts.filter(a => a.status === 'healthy').length;
      const blockedCount = accounts.filter(a => a.status === 'blocked').length;
      const expiringSoonCount = accounts.filter(a => a.status === 'expiring_soon').length;
      const expiredCount = accounts.filter(a => a.status === 'expired').length;

      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      const today = new Date().toISOString().split('T')[0];
      for (const [accountId, usageData] of qwenAPI.tokenUsage.entries()) {
        const todayUsage = usageData.find(entry => entry.date === today);
        if (todayUsage) {
          totalInputTokens += todayUsage.inputTokens;
          totalOutputTokens += todayUsage.outputTokens;
        }
      }

      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        summary: {
          total: accounts.length,
          healthy: healthyCount,
          blocked: blockedCount,
          expiring_soon: expiringSoonCount,
          expired: expiredCount,
          total_requests_today: totalRequestsToday,
          lastReset: qwenAPI.lastResetDate
        },
        token_usage: {
          input_tokens_today: totalInputTokens,
          output_tokens_today: totalOutputTokens,
          total_tokens_today: totalInputTokens + totalOutputTokens
        },
        accounts,
        health: healthStatus,
        server_info: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          node_version: process.version,
          platform: process.platform,
          arch: process.arch
        },
        endpoints: {
          openai: `${req.protocol}://${req.get('host')}/v1`,
          health: `${req.protocol}://${req.get('host')}/health`
        }
      });
    } catch (error) {
      console.error('Health check error:', error.message);
      res.status(500).json({
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error.message,
        server_info: {
          uptime: process.uptime(),
          node_version: process.version,
          platform: process.platform,
          arch: process.arch
        }
      });
    }
  });

  // Attach dependencies for testing
  app._proxy = proxy;
  app._qwenAPI = qwenAPI;
  app._authManager = authManager;
  app._config = config;
  app._responsesStateStore = responsesStateStore;

  return app;
}

module.exports = { createApp };
