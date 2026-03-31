const { QwenAPI } = require('./qwen/api.js');
const { QwenAuthManager } = require('./qwen/auth.js');
const { DebugLogger } = require('./utils/logger.js');
const { countTokens } = require('./utils/tokenCounter.js');
const { ErrorFormatter } = require('./utils/errorFormatter.js');
const { systemPromptTransformer } = require('./utils/systemPromptTransformer.js');
const { ResponsesError } = require('./responses/responsesErrors.js');
const liveLogger = require('./utils/liveLogger.js');
const fileLogger = require('./utils/fileLogger.js');
const config = require('./config.js');
const { buildCurrentInputMessages } = require('./responses/lowerResponsesToChat.js');

function buildCarryoverItems({
  previousCarryoverItems = [],
  outputItems,
  normalizedInputItems
}) {
  const carryoverItems = Array.isArray(previousCarryoverItems)
    ? [...previousCarryoverItems]
    : [];

  carryoverItems.push(...buildCurrentInputMessages(normalizedInputItems));

  if (!outputItems || !Array.isArray(outputItems)) {
    return carryoverItems;
  }

  // Then add the assistant's output
  for (const item of outputItems) {
    if (item.type === 'message') {
      const content = extractTextFromContent(item.content);
      if (content) {
        carryoverItems.push({
          role: item.role || 'assistant',
          content: content
        });
      }
    } else if (item.type === 'function_call') {
      carryoverItems.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: {
            name: item.name,
            arguments: item.arguments
          }
        }]
      });
    }
  }

  return carryoverItems;
}

function extractTextFromContent(content) {
  if (!content || !Array.isArray(content)) {
    return null;
  }
  
  let text = '';
  for (const part of content) {
    if (part.type === 'output_text' && part.text) {
      text += part.text;
    }
  }
  return text || null;
}

function maskSensitiveHeadersForLog(headers) {
  if (!headers) return {};
  const sensitiveHeaders = ['authorization', 'x-api-key', 'api-key', 'cookie'];
  const masked = {};
  
  for (const [key, value] of Object.entries(headers)) {
    if (sensitiveHeaders.includes(key.toLowerCase()) && value) {
      if (String(value).startsWith('Bearer ')) {
        const token = String(value).substring(7);
        masked[key] = `Bearer ${token.substring(0, 10)}...${token.substring(token.length - 4)}`;
      } else {
        const valString = String(value);
        masked[key] = valString.length > 14 ? `${valString.substring(0, 10)}...${valString.substring(valString.length - 4)}` : valString;
      }
    } else {
      masked[key] = value;
    }
  }
  
  return masked;
}

function sanitizeRequestBodyForLog(body) {
  if (!body || typeof body !== 'object') return body;
  const sanitized = { ...body };
  
  if (sanitized.input && typeof sanitized.input === 'string' && sanitized.input.length > 500) {
    sanitized.input = sanitized.input.substring(0, 500) + '... (truncated)';
  }
  
  if (sanitized.instructions && sanitized.instructions.length > 200) {
    sanitized.instructions = sanitized.instructions.substring(0, 200) + '... (truncated)';
  }
  
  return sanitized;
}

class QwenOpenAIProxy {
  constructor(options = {}) {
    this.qwenAPI = options.qwenAPI || new QwenAPI();
    this.authManager = options.authManager || new QwenAuthManager();
    this.debugLogger = options.debugLogger || new DebugLogger();
    this.config = options.config || config;
    
    if (options.authManager) {
      this.qwenAPI.authManager = options.authManager;
    }
  }

  async handleChatCompletion(req, res) {
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const accountId = req.headers['x-qwen-account'] || req.query.account || req.body.account;
    const model = req.body.model || this.config.defaultModel;
    const startTime = Date.now();
    const displayAccount = accountId ? accountId.substring(0, 8) : 'default';
    const requestNum = this.qwenAPI.getRequestCount(accountId || 'default');
    const isStreaming = req.body.stream === true;

    try {
      const tokenCount = countTokens(req.body.messages);

      liveLogger.proxyRequest(requestId, model, accountId, tokenCount, requestNum, isStreaming);
      
      if (isStreaming) {
        await this.handleStreamingChatCompletion(req, res, requestId, accountId, model, startTime);
      } else {
        await this.handleRegularChatCompletion(req, res, requestId, accountId, model, startTime);
      }
    } catch (error) {
      if (error.message.includes('Validation error')) {
      	liveLogger.proxyError(requestId, 400, displayAccount, error.message, null);
      	const validationError = ErrorFormatter.openAIValidationError(error.message);
      	return res.status(validationError.status).json(validationError.body);
      }
    
      if (error?.code === 'ACCOUNT_NOT_USABLE_IN_PROXY_MODE') {
      	fileLogger.logError(requestId, displayAccount, 400, error.message);
      	return res.status(400).json({
      		error: {
      			message: error.message,
      			type: 'invalid_request_error',
      			code: 'account_not_usable_in_proxy_mode'
      		}
      	});
      }
    
      if (error?.code === 'NO_USABLE_PROXY_ROUTE') {
      	fileLogger.logError(requestId, displayAccount, 503, error.message);
      	return res.status(503).json({
      		error: {
      			message: error.message,
      			type: 'proxy_routing_error',
      			code: 'no_usable_proxy_route'
      		}
      	});
      }
    
      fileLogger.logError(requestId, displayAccount, 500, error.message);
      liveLogger.proxyError(requestId, 500, displayAccount, error.message, null);
      
      if (error.message.includes('Not authenticated') || error.message.includes('access token')) {
        const authError = ErrorFormatter.openAIAuthError();
        return res.status(authError.status).json(authError.body);
      }
      
      const apiError = ErrorFormatter.openAIApiError(error.message);
      res.status(apiError.status).json(apiError.body);
    }
  }
  
  async handleRegularChatCompletion(req, res, requestId, accountId, model, startTime) {
  	const displayAccount = accountId ? accountId.substring(0, 8) : 'default';
 
  	try {
  		const transformedMessages = systemPromptTransformer.transform(
  			req.body.messages,
  			req.body.model || this.config.defaultModel
  		);
 
  		// Destructure response and metadata (request-scoped, no race condition)
  		const { response, metadata } = await this.qwenAPI.chatCompletions({
  			model: req.body.model || this.config.defaultModel,
  			messages: transformedMessages,
  			tools: req.body.tools,
  			tool_choice: req.body.tool_choice,
  			temperature: req.body.temperature || this.config.defaultTemperature,
  			max_tokens: req.body.max_tokens || this.config.defaultMaxTokens,
  			top_p: req.body.top_p || this.config.defaultTopP,
  			top_k: req.body.top_k || this.config.defaultTopK,
  			repetition_penalty: req.body.repetition_penalty || this.config.defaultRepetitionPenalty,
  			reasoning: req.body.reasoning,
  			accountId: accountId
  		});
 
  		// Get actual account and proxy from metadata (request-scoped)
  		const actualAccountId = metadata?.accountId || accountId;
  		const actualProxyId = metadata?.proxyId;
  		const actualDisplayAccount = actualAccountId ? actualAccountId.substring(0, 8) : displayAccount;
 
  		const latency = Date.now() - startTime;
  		const inputTokens = response?.usage?.prompt_tokens || 0;
  		const outputTokens = response?.usage?.completion_tokens || 0;
  		const qwenId = response?.id ? response.id.replace('chatcmpl-', '').substring(0, 8) : null;
 
  		if (fileLogger.isDebugLogging) {
  			const logContent = fileLogger.formatLogContent(requestId, req, { model, messages: transformedMessages }, 200, latency, response);
  			fileLogger.logToFile(requestId, logContent, 200);
  		}
 
  		liveLogger.proxyResponse(requestId, 200, actualDisplayAccount, latency, inputTokens, outputTokens, qwenId, actualProxyId);
 
  		res.json(response);
  	} catch (error) {
  		const latency = Date.now() - startTime;
  		const statusCode = error.response?.status || 500;
 
  		fileLogger.logError(requestId, displayAccount, statusCode, error.message);
 
  		liveLogger.proxyError(requestId, statusCode, displayAccount, error.message, null);
 
  		if (error.message.includes('Not authenticated') || error.message.includes('access token')) {
  			const authError = ErrorFormatter.openAIAuthError();
  			return res.status(authError.status).json(authError.body);
  		}
 
  		throw error;
  	}
  }
  
  async handleStreamingChatCompletion(req, res, requestId, accountId, model, startTime) {
    const displayAccount = accountId ? accountId.substring(0, 8) : 'default';
    
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const transformedMessages = systemPromptTransformer.transform(
        req.body.messages,
        req.body.model || this.config.defaultModel
      );

      // Destructure stream and metadata (request-scoped, no race condition)
      const { response: stream, metadata } = await this.qwenAPI.streamChatCompletions({
      	model: req.body.model || this.config.defaultModel,
      	messages: transformedMessages,
      	tools: req.body.tools,
      	tool_choice: req.body.tool_choice,
      	temperature: req.body.temperature || this.config.defaultTemperature,
      	max_tokens: req.body.max_tokens || this.config.defaultMaxTokens,
      	top_p: req.body.top_p || this.config.defaultTopP,
      	top_k: req.body.top_k || this.config.defaultTopK,
      	repetition_penalty: req.body.repetition_penalty || this.config.defaultRepetitionPenalty,
      	reasoning: req.body.reasoning,
      	accountId: accountId
      });
    
      // Get actual account and proxy from metadata (request-scoped)
      const actualAccountId = metadata?.accountId || accountId;
      const actualProxyId = metadata?.proxyId;
      const actualDisplayAccount = actualAccountId ? actualAccountId.substring(0, 8) : displayAccount;
    
      if (fileLogger.isDebugLogging) {
      	const logContent = fileLogger.formatLogContent(requestId, req, { model, messages: transformedMessages }, 200, 0, { streaming: true });
      	fileLogger.logToFile(requestId, logContent, 200);
      }
    
      let qwenId = null;
      let buffer = '';
    
      stream.on('data', (chunk) => {
      	buffer += chunk.toString();
      	const lines = buffer.split('\n');
      	buffer = lines.pop() || '';
    
      	for (const line of lines) {
      		if (line.startsWith('data: ') && !qwenId) {
      			const data = line.slice(6);
      			if (data !== '[DONE]') {
      				try {
      					const json = JSON.parse(data);
      					if (json.id) {
      						qwenId = json.id.replace('chatcmpl-', '');
      					}
      				} catch (e) {}
      			}
      		}
      	}
    
      	res.write(chunk);
      });
    
      stream.on('end', () => {
      	const latency = Date.now() - startTime;
      	const qwenIdShort = qwenId ? qwenId.substring(0, 8) : null;
      	// Get tokens from stream metadata (request-scoped)
      	const streamInputTokens = stream?.metadata?.inputTokens || 0;
      	const streamOutputTokens = stream?.metadata?.outputTokens || 0;
      	liveLogger.proxyResponse(requestId, 200, actualDisplayAccount, latency, streamInputTokens, streamOutputTokens, qwenIdShort, actualProxyId, true);
      	res.end();
      });
    
      stream.on('error', (error) => {
      	liveLogger.proxyError(requestId, 500, actualDisplayAccount, error.message, actualProxyId);
      	if (!res.headersSent) {
      		const apiError = ErrorFormatter.openAIApiError(error.message, 'streaming_error');
      		res.status(apiError.status).json(apiError.body);
      	}
      	res.end();
      });
      
      req.on('close', () => {
        stream.destroy();
      });
      
    } catch (error) {
    	const latency = Date.now() - startTime;
    	const statusCode = error.response?.status || 500;
   
    	fileLogger.logError(requestId, displayAccount, statusCode, error.message);
   
    	liveLogger.proxyError(requestId, statusCode, displayAccount, error.message, null);
      
      if (error?.code === 'ACCOUNT_NOT_USABLE_IN_PROXY_MODE') {
        if (!res.headersSent) {
          fileLogger.logError(requestId, displayAccount, 400, error.message);
          liveLogger.proxyError(requestId, 400, displayAccount, error.message);
          return res.status(400).json({
            error: {
              message: error.message,
              type: 'invalid_request_error',
              code: 'account_not_usable_in_proxy_mode'
            }
          });
        }
        return;
      }

      if (error?.code === 'NO_USABLE_PROXY_ROUTE') {
        if (!res.headersSent) {
          fileLogger.logError(requestId, displayAccount, 503, error.message);
          liveLogger.proxyError(requestId, 503, displayAccount, error.message);
          return res.status(503).json({
            error: {
              message: error.message,
              type: 'proxy_routing_error',
              code: 'no_usable_proxy_route'
            }
          });
        }
        return;
      }

      if (error.message.includes('Not authenticated') || error.message.includes('access token')) {
        const authError = ErrorFormatter.openAIAuthError();
        if (!res.headersSent) {
          res.status(authError.status).json(authError.body);
          res.end();
        }
        return;
      }
      
      const apiError = ErrorFormatter.openAIApiError(error.message);
      if (!res.headersSent) {
        res.status(apiError.status).json(apiError.body);
        res.end();
      }
    }
  }
  
  async handleModels(req, res) {
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const startTime = Date.now();
    
    try {
      const models = await this.qwenAPI.listModels();
      
      const latency = Date.now() - startTime;
      liveLogger.proxyResponse(requestId, 200, 'system', latency, 0, 0);
      
      res.json(models);
    } catch (error) {
      const latency = Date.now() - startTime;
      liveLogger.proxyError(requestId, 500, 'system', error.message);
      
      fileLogger.logError(requestId, 'system', 500, error.message);
      
      if (error.message.includes('Not authenticated') || error.message.includes('access token')) {
        return res.status(401).json({
          error: {
            message: 'Not authenticated with Qwen. Please authenticate first.',
            type: 'authentication_error'
          }
        });
      }
      
      res.status(500).json({
        error: {
          message: error.message,
          type: 'internal_server_error'
        }
      });
    }
  }
  
  async handleAuthInitiate(req, res) {
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    
    try {
      const deviceFlow = await this.authManager.initiateDeviceFlow();
      
      liveLogger.authInitiated(deviceFlow.device_code.substring(0, 8));
      
      const response = {
        verification_uri: deviceFlow.verification_uri,
        user_code: deviceFlow.user_code,
        device_code: deviceFlow.device_code,
        code_verifier: deviceFlow.code_verifier
      };
      
      res.json(response);
    } catch (error) {
      fileLogger.logError(requestId, 'auth', 500, error.message);
      liveLogger.proxyError(requestId, 500, 'auth', error.message);
      
      res.status(500).json({
        error: {
          message: error.message,
          type: 'authentication_error'
        }
      });
    }
  }
  
  async handleAuthPoll(req, res) {
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    
    try {
      const { device_code, code_verifier } = req.body;
      
      if (!device_code || !code_verifier) {
        const errorResponse = {
          error: {
            message: 'Missing device_code or code_verifier',
            type: 'invalid_request'
          }
        };
        fileLogger.logError(requestId, 'auth', 400, 'Missing device_code or code_verifier');
        liveLogger.proxyError(requestId, 400, 'auth', 'Missing device_code or code_verifier');
        return res.status(400).json(errorResponse);
      }
      
      const token = await this.authManager.pollForToken(device_code, code_verifier);
      
      liveLogger.authCompleted(device_code.substring(0, 8));
      
      const response = {
        access_token: token,
        message: 'Authentication successful'
      };
      
      res.json(response);
    } catch (error) {
      if (error.message.includes('Validation error')) {
        liveLogger.proxyError(requestId, 400, 'auth', error.message);
        const validationError = ErrorFormatter.openAIValidationError(error.message);
        return res.status(validationError.status).json(validationError.body);
      }
      
      fileLogger.logError(requestId, 'auth', 500, error.message);
      liveLogger.proxyError(requestId, 500, 'auth', error.message);
      
      const apiError = ErrorFormatter.openAIApiError(error.message, 'authentication_error');
      res.status(apiError.status).json(apiError.body);
    }
  }

  async handleWebSearch(req, res) {
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const startTime = Date.now();
    
    try {
      const { query, page, rows } = req.body;
      
      if (!query || typeof query !== 'string') {
        liveLogger.proxyError(requestId, 400, 'web', 'Query parameter required');
        const validationError = ErrorFormatter.openAIValidationError('Query parameter is required and must be a string');
        return res.status(validationError.status).json(validationError.body);
      }

      if (page && (typeof page !== 'number' || page < 1)) {
        liveLogger.proxyError(requestId, 400, 'web', 'Page must be positive integer');
        const validationError = ErrorFormatter.openAIValidationError('Page must be a positive integer');
        return res.status(validationError.status).json(validationError.body);
      }

      if (rows && (typeof rows !== 'number' || rows < 1 || rows > 100)) {
        liveLogger.proxyError(requestId, 400, 'web', 'Rows must be 1-100');
        const validationError = ErrorFormatter.openAIValidationError('Rows must be a number between 1 and 100');
        return res.status(validationError.status).json(validationError.body);
      }

      const accountId = req.headers['x-qwen-account'] || req.query.account || req.body.account;
      const displayAccount = accountId ? accountId.substring(0, 8) : 'default';
      
      liveLogger.proxyRequest(requestId, 'web-search', accountId, 0);
      
      // Destructure response and metadata (request-scoped, no race condition)
      const { response, metadata } = await this.qwenAPI.webSearch({
      	query: query,
      	page: page || 1,
      	rows: rows || 10,
      	accountId: accountId
      });
    
      const latency = Date.now() - startTime;
      const actualProxyId = metadata?.proxyId;
    
      liveLogger.proxyResponse(requestId, 200, displayAccount, latency, 0, 0, null, actualProxyId);
    
      res.json(response);
    } catch (error) {
      const latency = Date.now() - startTime;
      
      if (error.message.includes('Validation error')) {
        liveLogger.proxyError(requestId, 400, 'web', error.message);
        const validationError = ErrorFormatter.openAIValidationError(error.message);
        return res.status(validationError.status).json(validationError.body);
      }

      if (error?.code === 'ACCOUNT_NOT_USABLE_IN_PROXY_MODE') {
        fileLogger.logError(requestId, 'web', 400, error.message);
        liveLogger.proxyError(requestId, 400, 'web', error.message);
        return res.status(400).json({
          error: {
            message: error.message,
            type: 'invalid_request_error',
            code: 'account_not_usable_in_proxy_mode'
          }
        });
      }

      if (error?.code === 'NO_USABLE_PROXY_ROUTE') {
        fileLogger.logError(requestId, 'web', 503, error.message);
        liveLogger.proxyError(requestId, 503, 'web', error.message);
        return res.status(503).json({
          error: {
            message: error.message,
            type: 'proxy_routing_error',
            code: 'no_usable_proxy_route'
          }
        });
      }

      fileLogger.logError(requestId, 'web', 500, error.message);
      liveLogger.proxyError(requestId, 500, 'web', error.message);
      
      if (error.message.includes('Not authenticated') || error.message.includes('access token')) {
        const authError = ErrorFormatter.openAIAuthError();
        return res.status(authError.status).json(authError.body);
      }
      
      if (error.message.includes('quota') || error.message.includes('exceeded')) {
        const quotaError = {
          error: {
            message: "Web search quota exceeded. Free accounts have 2000 requests per day.",
            type: "quota_exceeded",
            code: "quota_exceeded"
          }
        };
        return res.status(429).json(quotaError);
      }
      
      const apiError = ErrorFormatter.openAIApiError(error.message);
      res.status(apiError.status).json(apiError.body);
    }
  }

  async handleResponses(req, res, options = {}) {
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const accountId = req.headers['x-qwen-account'] || req.query.account || req.body.account;
    const startTime = Date.now();
    const displayAccount = accountId ? accountId.substring(0, 8) : 'default';

    const responsesStateStore = options.responsesStateStore;

    const { normalizeResponsesRequest } = require('./responses/normalizeResponsesRequest.js');
    const { lowerResponsesToChat } = require('./responses/lowerResponsesToChat.js');
    const { liftChatToResponses } = require('./responses/liftChatToResponses.js');
    const { ResponsesError, formatErrorResponse } = require('./responses/responsesErrors.js');

    try {
      // Log incoming request from Codex (error or debug mode)
      if (fileLogger.isDebugLogging || fileLogger.isErrorLogging) {
        // Calculate payload size diagnostics
        const requestBodySize = JSON.stringify(req.body).length;
        const instructionsSize = req.body.instructions ? req.body.instructions.length : 0;
        const inputItemsCount = Array.isArray(req.body.input) ? req.body.input.length : (req.body.input ? 1 : 0);
        const toolsCount = Array.isArray(req.body.tools) ? req.body.tools.length : 0;
        
        const codexRequestLog = {
          endpoint: '/v1/responses',
          method: req.method,
          requestId,
          timestamp: new Date().toISOString(),
          headers: maskSensitiveHeadersForLog(req.headers),
          body: sanitizeRequestBodyForLog(req.body),
          // Payload size diagnostics
          diagnostics: {
            requestByteSize: requestBodySize,
            instructionsSize: instructionsSize,
            inputItemsCount: inputItemsCount,
            toolsCount: toolsCount,
            isCodexLike: req.body.instructions && (
              req.body.instructions.includes('Codex CLI') ||
              req.body.instructions.includes('coding agent') ||
              req.body.instructions.includes('sandbox')
            )
          }
        };
        fileLogger.logDebugJson(requestId, codexRequestLog, 'codex-request');
      }

      const normalizedRequest = normalizeResponsesRequest(req.body);

      let previousRecord = null;
      if (normalizedRequest.previousResponseId && responsesStateStore) {
        previousRecord = await responsesStateStore.load(normalizedRequest.previousResponseId);
        if (!previousRecord) {
          const error = new ResponsesError(
            `previous_response_id '${normalizedRequest.previousResponseId}' was not found in local response storage`,
            'invalid_request_error',
            'previous_response_not_found',
            404
          );
          const acceptsSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');
          if (acceptsSSE) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.write(`event: error\ndata: ${JSON.stringify(formatErrorResponse(error))}\n\n`);
            res.end();
            return;
          }
          return res.status(404).json(formatErrorResponse(error));
        }
      }

      const { upstreamRequest, normalizedInputItems, syntheticInstructions, carryoverItems } = 
        lowerResponsesToChat({ normalizedRequest, previousRecord });

      // Log upstream request that will be sent to Qwen (debug mode only)
      if (fileLogger.isDebugLogging) {
        const upstreamRequestLog = {
          endpoint: '/v1/chat/completions',
          requestId,
          timestamp: new Date().toISOString(),
          model: upstreamRequest.model,
          messages: upstreamRequest.messages,
          stream: upstreamRequest.stream,
          temperature: upstreamRequest.temperature,
          max_tokens: upstreamRequest.max_tokens,
          top_p: upstreamRequest.top_p,
          tools: upstreamRequest.tools ? JSON.stringify(upstreamRequest.tools).substring(0, 200) : null
        };
        fileLogger.logDebugJson(requestId, upstreamRequestLog, 'qwen-request');
      }

      const requestTokenCount = countTokens(upstreamRequest.messages);
      liveLogger.proxyRequest(requestId, normalizedRequest.model, accountId, requestTokenCount, 0, normalizedRequest.stream, null, 'responses');

      if (normalizedRequest.stream) {
      	return this.handleStreamingResponses(req, res, {
      		upstreamRequest,
      		normalizedRequest,
      		previousResponseId: normalizedRequest.previousResponseId,
      		responsesStateStore,
      		displayAccount,
      		startTime,
      		requestId
      	});
      }
    
      // Destructure response and metadata (request-scoped, no race condition)
      const { response: upstreamResponse, metadata } = await this.qwenAPI.chatCompletions({
      	...upstreamRequest,
      	accountId
      });
    
      // Log Qwen response (debug mode only)
      if (fileLogger.isDebugLogging) {
      	const qwenResponseLog = {
      		requestId,
      		timestamp: new Date().toISOString(),
      		model: upstreamResponse.model,
      		id: upstreamResponse.id,
      		choices: upstreamResponse.choices ? upstreamResponse.choices.map(c => ({
      			message: c.message,
      			finish_reason: c.finish_reason
      		})) : null,
      		usage: upstreamResponse.usage,
      		error: null
      	};
      	fileLogger.logDebugJson(requestId, qwenResponseLog, 'qwen-response');
      }
    
      const { responseObject, outputItems } = liftChatToResponses({
      	normalizedRequest,
      	previousResponseId: normalizedRequest.previousResponseId,
      	upstreamResponse
      });
    
      // Build carryover items from current response output for the next request
      const newCarryoverItems = buildCarryoverItems({
      	previousCarryoverItems: carryoverItems,
      	outputItems,
      	normalizedInputItems
      });
    
      if (normalizedRequest.store && responsesStateStore) {
      	const record = {
      		id: responseObject.id,
      		created_at: responseObject.created_at,
      		model: responseObject.model,
      		previous_response_id: normalizedRequest.previousResponseId,
      		store: normalizedRequest.store,
      		metadata: normalizedRequest.metadata,
      		request: req.body,
      		normalized_input_items: normalizedInputItems,
      		synthetic_instructions: syntheticInstructions,
      		carryover_items: newCarryoverItems,
      		upstream_request: upstreamRequest,
      		upstream_response: upstreamResponse,
      		response_object: responseObject
      	};
      	await responsesStateStore.save(record);
      }
    
      // Get actual account and proxy from metadata (request-scoped)
      const actualAccountId = metadata?.accountId || accountId;
      const actualProxyId = metadata?.proxyId;
      const actualDisplayAccount = actualAccountId ? actualAccountId.substring(0, 8) : displayAccount;
    
      const latency = Date.now() - startTime;
      liveLogger.proxyResponse(requestId, 200, actualDisplayAccount, latency, 0, 0, null, actualProxyId, false);
    
      res.json(responseObject);
     } catch (error) {
      const errorMessage = error?.message || String(error);
    
      // Log error with full details (error or debug mode)
      if (fileLogger.isDebugLogging || fileLogger.isErrorLogging) {
      	const errorLog = {
      		requestId,
      		timestamp: new Date().toISOString(),
      		error: {
      			message: errorMessage,
      			stack: error.stack,
      			code: error.code,
      			response: error.response ? {
      				status: error.response.status,
      				data: error.response.data
      			} : null
      		}
      	};
      	fileLogger.logDebugJson(requestId, errorLog, 'error');
      }
    
      console.error('Responses error:', error);
      const latency = Date.now() - startTime;
      liveLogger.proxyError(requestId, 500, displayAccount, errorMessage, null);
      fileLogger.logError(requestId, displayAccount, 500, errorMessage);

      // For streaming requests (Accept: text/event-stream), send error as SSE event
      const acceptsSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');
      
      if (error instanceof ResponsesError) {
        if (acceptsSSE) {
          // Send SSE error event
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
          }
          const sseError = `event: error\ndata: ${JSON.stringify(formatErrorResponse(error))}\n\n`;
          res.write(sseError);
          res.end();
        } else {
          res.status(error.statusCode).json(formatErrorResponse(error));
        }
        return;
      }

      if (errorMessage && errorMessage.includes('Validation error')) {
        const validationError = ErrorFormatter.openAIValidationError(errorMessage);
        if (acceptsSSE) {
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
          }
          res.write(`event: error\ndata: ${JSON.stringify(validationError.body)}\n\n`);
          res.end();
        } else {
          res.status(validationError.status).json(validationError.body);
        }
        return;
      }

      if (errorMessage && (errorMessage.includes('Not authenticated') || errorMessage.includes('access token'))) {
        const authError = ErrorFormatter.openAIAuthError();
        if (acceptsSSE) {
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
          }
          res.write(`event: error\ndata: ${JSON.stringify(authError.body)}\n\n`);
          res.end();
        } else {
          res.status(authError.status).json(authError.body);
        }
        return;
      }

      const apiError = ErrorFormatter.openAIApiError(errorMessage);
      if (acceptsSSE) {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
        }
        res.write(`event: error\ndata: ${JSON.stringify(apiError.body)}\n\n`);
        res.end();
      } else {
        res.status(apiError.status).json(apiError.body);
      }
    }
  }

  async handleStreamingResponses(req, res, context) {
    const { 
      upstreamRequest, 
      normalizedRequest, 
      previousResponseId, 
      responsesStateStore, 
      displayAccount, 
      startTime,
      requestId 
    } = context;

    const { ResponsesError, formatErrorResponse } = require('./responses/responsesErrors.js');

    // Log incoming streaming request from Codex (error or debug mode)
    if (fileLogger.isDebugLogging || fileLogger.isErrorLogging) {
      const codexRequestLog = {
        endpoint: '/v1/responses',
        method: 'POST',
        requestId,
        stream: true,
        timestamp: new Date().toISOString(),
        headers: maskSensitiveHeadersForLog(req.headers),
        body: sanitizeRequestBodyForLog(req.body)
      };
      fileLogger.logDebugJson(requestId, codexRequestLog, 'codex-request-stream');
    }

    try {
      // Log upstream streaming request (debug mode only)
      if (fileLogger.isDebugLogging) {
        const upstreamRequestLog = {
          endpoint: '/v1/chat/completions',
          requestId,
          stream: true,
          timestamp: new Date().toISOString(),
          model: upstreamRequest.model,
          messages: upstreamRequest.messages,
          temperature: upstreamRequest.temperature,
          max_tokens: upstreamRequest.max_tokens
        };
        fileLogger.logDebugJson(requestId, upstreamRequestLog, 'qwen-request-stream');
      }

      const { streamChatToResponsesSse } = require('./responses/streamChatToResponsesSse.js');
      const { lowerResponsesToChat } = require('./responses/lowerResponsesToChat.js');

      let previousRecord = null;
      if (previousResponseId && responsesStateStore) {
        previousRecord = await responsesStateStore.load(previousResponseId);
      }

      const { normalizedInputItems, syntheticInstructions, carryoverItems } = 
        lowerResponsesToChat({ normalizedRequest, previousRecord });

      const accountId = req.headers['x-qwen-account'] || req.query.account || req.body.account;

      // Destructure stream and metadata (request-scoped, no race condition)
      const { response: stream, metadata } = await this.qwenAPI.streamChatCompletions({
      	...upstreamRequest,
      	accountId
      });
    
      await streamChatToResponsesSse({
      	upstreamStream: stream,
      	res,
      	normalizedRequest,
      	previousResponseId,
      	onCompleted: async (responseObject) => {
      		// Log streaming completion (debug mode only)
      		if (fileLogger.isDebugLogging) {
      			const streamCompletionLog = {
      				requestId,
      				timestamp: new Date().toISOString(),
      				output_text: responseObject.output_text ? responseObject.output_text.substring(0, 500) : null,
      				status: 'completed'
      			};
      			fileLogger.logDebugJson(requestId, streamCompletionLog, 'qwen-stream-completed');
      		}
    
      		if (normalizedRequest.store && responsesStateStore) {
      			const upstreamRequest = {
      				model: normalizedRequest.model,
      				messages: [],
      				stream: true
      			};
      			const record = {
      				id: responseObject.id,
      				created_at: responseObject.created_at,
      				model: responseObject.model,
      				previous_response_id: previousResponseId,
      				store: normalizedRequest.store,
      				metadata: normalizedRequest.metadata,
      				request: req.body,
      				normalized_input_items: normalizedInputItems,
      				synthetic_instructions: syntheticInstructions,
      				carryover_items: buildCarryoverItems({
      					previousCarryoverItems: carryoverItems,
      					outputItems: responseObject.output,
      					normalizedInputItems
      				}),
      				upstream_request: upstreamRequest,
      				upstream_response: {},
      				response_object: responseObject
      			};
      			await responsesStateStore.save(record);
      		}
    
      		// Get actual account and proxy from metadata (request-scoped)
      		const actualAccountId = metadata?.accountId || accountId;
      		const actualProxyId = metadata?.proxyId;
      		const actualDisplayAccount = actualAccountId ? actualAccountId.substring(0, 8) : displayAccount;
      		// Get tokens from stream metadata (request-scoped)
      		const streamInputTokens = stream?.metadata?.inputTokens || 0;
      		const streamOutputTokens = stream?.metadata?.outputTokens || 0;
    
      		const latency = Date.now() - startTime;
      		liveLogger.proxyResponse(requestId, 200, actualDisplayAccount, latency, streamInputTokens, streamOutputTokens, null, actualProxyId, true);
      	}
      });
     } catch (error) {
      const latency = Date.now() - startTime;
    
      // Log streaming error with full details (error or debug mode)
      if (fileLogger.isDebugLogging || fileLogger.isErrorLogging) {
      	const streamErrorLog = {
      		requestId,
      		timestamp: new Date().toISOString(),
      		error: {
      			message: error.message,
      			stack: error.stack,
      			code: error.code
      		}
      	};
      	fileLogger.logDebugJson(requestId, streamErrorLog, 'stream-error');
      }
    
      liveLogger.proxyError(requestId, 500, displayAccount, error.message, null);
      fileLogger.logError(requestId, displayAccount, 500, error.message);

      // Send error as SSE event (this is always a streaming context)
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
      }

      // Handle ResponsesError (validation errors from normalizeResponsesRequest)
      if (error instanceof ResponsesError) {
        const sseError = `event: error\ndata: ${JSON.stringify(formatErrorResponse(error))}\n\n`;
        res.write(sseError);
        res.end();
        return;
      }

      if (error.message.includes('Not authenticated') || error.message.includes('access token')) {
        const authError = ErrorFormatter.openAIAuthError();
        res.write(`event: error\ndata: ${JSON.stringify(authError.body)}\n\n`);
        res.end();
        return;
      }

      const apiError = ErrorFormatter.openAIApiError(error.message);
      res.write(`event: error\ndata: ${JSON.stringify(apiError.body)}\n\n`);
      res.end();
    }
  }
}

module.exports = { QwenOpenAIProxy };
