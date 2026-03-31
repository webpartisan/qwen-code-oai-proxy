# Request-Scoped Account Tracking Design

## Problem

The current implementation uses instance-scoped variables `_lastUsedAccountId` and `_lastUsedProxyId` which creates a race condition in multi-threaded environments:

```javascript
// In api.js - PROBLEMATIC
this._lastUsedAccountId = null;  // Shared across all requests!

// Request A sets this to Account1
// Request B sets this to Account2 (overwrites!)
// Request A reads this and gets Account2 (WRONG!)
```

## Solution: Return Account Info with Response

Instead of storing account info in instance variables, return it as part of the response metadata.

### Architecture Changes

#### 1. Wrap Response with Metadata

Create a wrapper object that includes both the response and metadata:

```javascript
// New response structure
{
  response: <actual API response>,
  metadata: {
    accountId: 'abc123...',
    proxyId: 'proxy-1',
    inputTokens: 100,
    outputTokens: 50
  }
}
```

#### 2. Modify `executeWithAccountRotation`

The method should return both the result and the account info:

```javascript
// In api.js
async executeWithAccountRotation(accountIds, executeAttempt, onSuccess) {
  // ... existing logic ...
  
  const result = await this.executeOperationWithAccount(candidate, executeAttempt);
  await onSuccess(candidate.accountId, result);
  
  // Return both result AND account info
  return {
    response: result,
    metadata: {
      accountId: candidate.accountId,
      proxyId: this.proxyManager.getProxyForAccount(candidate.accountId)
    }
  };
}
```

#### 3. Modify `chatCompletions` and `streamChatCompletions`

These methods should return the wrapped response:

```javascript
async chatCompletions(request) {
  // ... existing logic ...
  
  return await this.executeWithAccountRotation(
    configuredAccounts,
    async (accountInfo) => {
      await this.waitForAccountAndIpRateLimit(accountInfo.accountId);
      return this.processRequestWithAccount(request, accountInfo);
    },
    async (accountId, response) => {
      // ... existing success handling ...
    }
  );
  // Now returns { response, metadata }
}
```

#### 4. Update `proxy.js` to Use Metadata

```javascript
// In proxy.js - handleRegularChatCompletion
const result = await this.qwenAPI.chatCompletions({
  model: req.body.model || this.config.defaultModel,
  messages: transformedMessages,
  // ... other params ...
});

// Extract response and metadata
const response = result.response;
const metadata = result.metadata;
const actualAccountId = metadata?.accountId;
const actualProxyId = metadata?.proxyId;
```

### Implementation Steps

#### Step 1: Create Response Wrapper Type

```javascript
// In api.js - add at top
/**
 * @typedef {Object} RequestResult
 * @property {*} response - The actual API response
 * @property {Object} metadata - Request metadata
 * @property {string} metadata.accountId - Account used
 * @property {string} [metadata.proxyId] - Proxy used
 * @property {number} [metadata.inputTokens] - Input tokens used
 * @property {number} [metadata.outputTokens] - Output tokens used
 */
```

#### Step 2: Modify `executeWithAccountRotation`

```javascript
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

        const proxyId = this.proxyManager.getProxyForAccount(candidate.accountId);
        const proxyUrl = proxyId ? this.proxyManager.getProxyUrl(proxyId) : null;
        const proxyInfo = proxyUrl ? `${proxyId} → ${proxyUrl}` : (proxyId || 'local');
        console.log(`\x1b[36mSelected account for request attempt: ${candidate.accountId} (proxy: ${proxyInfo})\x1b[0m`);
        
        const result = await this.executeOperationWithAccount(candidate, executeAttempt);
        attemptedRequest = true;
        await onSuccess(candidate.accountId, result);
        this.healthManager.resetStrikes(candidate.accountId);
        console.log(`\x1b[32m[ACCOUNT ${candidate.accountId}] Request successful (proxy: ${proxyInfo})\x1b[0m`);
        
        // CHANGED: Return wrapped response with metadata
        return {
          response: result,
          metadata: {
            accountId: candidate.accountId,
            proxyId: proxyId
          }
        };
      } catch (outcome) {
        // ... existing error handling ...
      }
    }
    // ... rest of existing logic ...
  }
  // ... existing error handling ...
}
```

#### Step 3: Update `chatCompletions`

```javascript
async chatCompletions(request) {
  await this.refreshAccountProxyBindings();
  const configuredAccounts = this.buildAccountList(request);

  // REMOVED: No more instance variable reset
  // this._lastUsedAccountId = null;
  // this._lastUsedProxyId = null;

  return await this.executeWithAccountRotation(
    configuredAccounts,
    async (accountInfo) => {
      await this.waitForAccountAndIpRateLimit(accountInfo.accountId);
      return this.processRequestWithAccount(request, accountInfo);
    },
    async (accountId, response) => {
      // REMOVED: No more instance variable storage
      // this._lastUsedAccountId = accountId;
      // this._lastUsedProxyId = ...

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
  // Now returns { response, metadata }
}
```

#### Step 4: Update `streamChatCompletions`

For streaming, we need a different approach since the stream itself is returned:

```javascript
async streamChatCompletions(request) {
  await this.refreshAccountProxyBindings();
  const configuredAccounts = this.buildAccountList(request);

  // REMOVED: No more instance variable reset

  return await this.executeWithAccountRotation(
    configuredAccounts,
    async (accountInfo) => {
      await this.waitForAccountAndIpRateLimit(accountInfo.accountId);
      const originalStream = await this.processStreamingRequestWithAccount(request, accountInfo);

      // Wrap stream to include metadata
      const { PassThrough } = require('stream');
      const wrappedStream = new PassThrough();
      
      // Attach metadata to the stream object
      wrappedStream.metadata = {
        accountId: accountInfo.accountId,
        proxyId: this.proxyManager.getProxyForAccount(accountInfo.accountId)
      };

      // Pipe data through
      originalStream.pipe(wrappedStream);
      
      return wrappedStream;
    },
    async (accountId, stream) => {
      await this.incrementRequestCount(accountId);
      this.healthManager.incrementAccountRateLimit(accountId);
      this.handleSuccessfulProxyUsage(accountId);
    }
  );
}
```

#### Step 5: Update `proxy.js`

```javascript
// In handleRegularChatCompletion
async handleRegularChatCompletion(req, res, requestId, accountId, model, startTime) {
  const displayAccount = accountId ? accountId.substring(0, 8) : 'default';

  try {
    const transformedMessages = systemPromptTransformer.transform(
      req.body.messages,
      req.body.model || this.config.defaultModel
    );

    // CHANGED: Destructure response and metadata
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

    // CHANGED: Get account/proxy from metadata (request-scoped!)
    const actualAccountId = metadata?.accountId || accountId;
    const actualProxyId = metadata?.proxyId;
    const actualDisplayAccount = actualAccountId ? actualAccountId.substring(0, 8) : displayAccount;

    const latency = Date.now() - startTime;
    const inputTokens = response?.usage?.prompt_tokens || 0;
    const outputTokens = response?.usage?.completion_tokens || 0;
    const qwenId = response?.id ? response.id.replace('chatcmpl-', '').substring(0, 8) : null;

    liveLogger.proxyResponse(requestId, 200, actualDisplayAccount, latency, inputTokens, outputTokens, qwenId, actualProxyId);

    res.json(response);  // Return only the response, not metadata
  } catch (error) {
    // ... existing error handling ...
  }
}
```

```javascript
// In handleStreamingChatCompletion
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

    // CHANGED: Destructure stream and metadata
    const { response: stream, metadata } = await this.qwenAPI.streamChatCompletions({
      model: req.body.model || this.config.defaultModel,
      messages: transformedMessages,
      // ... other params ...
      accountId: accountId
    });

    // CHANGED: Get account/proxy from metadata (request-scoped!)
    const actualAccountId = metadata?.accountId || accountId;
    const actualProxyId = metadata?.proxyId;
    const actualDisplayAccount = actualAccountId ? actualAccountId.substring(0, 8) : displayAccount;

    // ... rest of streaming logic ...
  }
}
```

#### Step 6: Remove Old Methods

Remove these methods from `QwenAPI` class:
- `getLastUsedAccountId()`
- `getLastUsedProxyId()`
- `getLastUsedInputTokens()`
- `getLastUsedOutputTokens()`
- `clearLastUsedTokens()`

### Benefits

1. **Thread Safety**: Each request carries its own metadata, no shared state
2. **Clearer Data Flow**: Account info flows explicitly through return values
3. **Easier Debugging**: Metadata is always attached to the response
4. **No Race Conditions**: Impossible for one request to overwrite another's info

### Migration Path

1. Keep old methods temporarily but mark as deprecated
2. Add new wrapped return format
3. Update `proxy.js` to use new format
4. Remove old methods after verification

### Testing

Add tests to verify:
1. Multiple concurrent requests log correct accounts
2. Error cases still report correct account
3. Streaming requests maintain correct metadata
4. Token usage is correctly attributed
