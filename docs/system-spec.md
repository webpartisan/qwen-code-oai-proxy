# System Specification: Qwen-to-OpenAI API Proxy

## 1. Executive Summary

This document specifies the **Qwen-to-OpenAI API Proxy**, a single-process HTTP server that translates OpenAI-compatible API requests into calls to an upstream OAuth-authenticated language model API. The system enables any OpenAI-compatible client (coding agents, chat interfaces, automation tools) to interact with the upstream provider's models without modification.

Key capabilities include multi-account OAuth authentication with automatic rotation, OAuth 2.0 Device Flow with PKCE, streaming server-sent event (SSE) responses, a Responses API implementation with conversation carryover, an MCP server for web search, and a three-tier logging system. The system is deployed via containerization with file-based persistence.

**Confidence level**: High. All claims are grounded in direct code inspection across 10 milestone phases covering all source files, test files, CLI tools, and infrastructure artifacts.

---

## 2. System Purpose and Scope

### Purpose

Bridge the gap between an upstream provider's proprietary OAuth-authenticated API and the widely adopted OpenAI API standard, enabling the existing OpenAI ecosystem (SDKs, clients, agents) to use the upstream provider's models transparently.

### Scope

- **In scope**: HTTP proxy translation, multi-account OAuth management, account rotation with health tracking, streaming responses, Responses API emulation, MCP web search tool, containerized deployment, CLI account management.
- **Out of scope**: The upstream CLI tool's source code (separate repository, excluded from version control), cloud function deployment variants (referenced in documentation but not present in this repository), upstream API internals.

### Primary Data Flow

```
Client → OpenAI-compatible endpoint → Proxy handler → Account selection → Upstream API → Response transformation → Client
```

---

## 3. Repository and System Overview

### Module Decomposition

The system comprises four logical subsystems:

| Subsystem | Responsibility |
|---|---|
| **HTTP Gateway** | Receives client requests, applies authentication gates, routes to appropriate handler |
| **Translation Pipeline** | Converts between OpenAI and upstream API formats (request lowering, response lifting) |
| **Account Management** | OAuth credential lifecycle, multi-account rotation, health tracking, proxy binding |
| **Infrastructure Services** | Logging, configuration, scheduling, MCP protocol server, CLI tools |

### Physical Artifacts

The repository contains application source modules organized into subdirectories by subsystem, root-level CLI executables, test suites, container build definitions, and service composition manifests.

[evidence: docs/reverse-spec/REPO-MAP.md, docs/reverse-spec/milestone-M1.md]

---

## 4. Architecture Overview

### Top-Level Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Client (OpenAI SDK)               │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP (OpenAI format)
                       ▼
┌─────────────────────────────────────────────────────┐
│              Proxy Server                             │
│  ┌─────────────────────────────────────────────┐    │
│  │           HTTP Gateway                        │    │
│  │  ┌───────────┐ ┌───────────┐ ┌───────────┐  │    │
│  │  │  Chat     │ │ Responses │ │  Web      │  │    │
│  │  │ Handler   │ │  Handler  │ │  Search   │  │    │
│  │  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘  │    │
│  │        │             │             │          │    │
│  │  ┌─────┴─────────────┴─────────────┴──────┐  │    │
│  │  │         Request Handler                 │  │    │
│  │  │  (account selection, transform, log)   │  │    │
│  │  └──────────────────┬─────────────────────┘  │    │
│  │                     │                         │    │
│  │  ┌──────────────────┴─────────────────────┐  │    │
│  │  │            Upstream Client              │  │    │
│  │  │  (rotation, retry, rate limit, stream)  │  │    │
│  │  └──┬──────────┬──────────────┬───────────┘  │    │
│  │     │          │              │               │    │
│  │  ┌──┴──┐  ┌───┴────┐  ┌──────┴──────┐       │    │
│  │  │Auth │  │Health  │  │  Proxy      │       │    │
│  │  │Mgr  │  │Mgr     │  │  Router     │       │    │
│  │  └─────┘  └────────┘  └─────────────┘       │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │
│  │  MCP Server │  │ 3-Tier      │  │  Refresh   │  │
│  │  (SSE+RPC)  │  │ Logging     │  │ Scheduler  │  │
│  └─────────────┘  └─────────────┘  └────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP (upstream format)
                       ▼
┌─────────────────────────────────────────────────────┐
│              Upstream Provider API                    │
│  (OAuth-authenticated model inference)               │
└─────────────────────────────────────────────────────┘
```

### Design Principles

- **Single-process**: No horizontal scaling; in-memory state is not shared across instances.
- **File-based persistence**: All durable state stored in a user-local directory (OAuth credentials, request counts, health data, response records).
- **Protocol conformance**: Responses conform to OpenAI API shapes; clients require no modification.
- **Automatic rotation**: Multi-account failover with progressive strike system and proxy health monitoring.

---

## 5. Execution Model

### Server Startup Sequence

1. Configuration loading from environment variables
2. HTTP gateway creation with middleware registration and route binding
3. Upstream client instantiation with references to authentication and health managers
4. Refresh scheduler instantiation with upstream client reference
5. Operating system signal handler registration (SIGINT, SIGTERM)
6. Network listener activation on configured host and port
7. Post-listen initialization: authentication manager bootstrap, log cleanup job startup, account loading, proxy routing summary output, refresh scheduler activation

[evidence: src/index.js:1-106]

### Graceful Shutdown

Both interrupt and termination signals handled identically:
1. Shutdown notification emitted to live logger
2. Account refresh scheduler stopped
3. Request counts persisted to disk
4. Process exits with code 0

**Limitation**: No HTTP connection drain — active requests terminated immediately. Up to 60 seconds of request count data may be lost on crash due to debounced persistence.

[evidence: src/index.js:14-48, src/qwen/api.js:445-459]

### CLI Tools

| Command | Description |
|---|---|
| `npm run auth` | Authenticate default account via device flow |
| `npm run auth:list` | List all accounts with validity status |
| `npm run auth:add <id>` | Add new account with QR code and browser open |
| `npm run auth:remove <id>` | Remove existing account |
| `npm run auth:counts` | Check request counts for all accounts |
| `npm run usage` | Display daily usage statistics table |
| `npm run health` | Display account health report (strikes, blocks) |

[evidence: authenticate.js:290-325, package.json:12-17]

---

## 6. Major Components and Responsibilities

### Core Request Processing

| Component | Responsibility |
|---|---|
| **Request Handler** | Central handler for all API endpoints: chat completions (regular and streaming), web search, models listing, authentication initiate/poll, Responses API (regular and streaming) |
| **Upstream Client** | API client with account rotation, retry logic, rate limiting, streaming support, token tracking, request counting |
| **Authentication Manager** | OAuth 2.0 Device Flow with PKCE, multi-account credential management, automatic token refresh before expiry |

### Infrastructure Services

| Component | Responsibility |
|---|---|
| **Configuration Loader** | Centralized environment variable loading, exports single configuration object |
| **MCP Server** | Model Context Protocol server with SSE transport — exposes `web_search` tool via JSON-RPC |
| **Proxy Router** | Proxy list management, 1:1 account-to-proxy binding, IP rate limiting, proxy health/cooldown/recovery |
| **Account Health Manager** | Progressive strike system (1-minute to 4-hour blocks), per-account per-minute rate limiting |
| **Refresh Scheduler** | Periodic (5-minute) token expiration check and refresh for all loaded accounts |

### Transformation Utilities

| Component | Responsibility |
|---|---|
| **System Prompt Transformer** | System prompt injection with prepend/append mode, model filtering, cache_control support |
| **Token Counter** | Token counting with fallback to character-count estimation |
| **Error Formatter** | OpenAI-compatible error response formatting |

### Responses API Subsystem

| Component | Responsibility |
|---|---|
| **Normalizer** | Validates and canonicalizes incoming requests — 17 accepted fields, 11 rejected |
| **Lowering** | Transforms Responses format to Chat Completions format with carryover and agent mode detection |
| **Lifting** | Transforms Chat Completions responses to Responses format with cryptographic ID generation |
| **SSE Adapter** | Adapts upstream Chat SSE to Responses SSE events (11-event sequence) |
| **State Store** | File-based persistent storage for `previous_response_id` chaining |
| **Error Types** | Custom error class with 7 factory functions for Responses-specific errors |

[evidence: docs/reverse-spec/REPO-MAP.md, docs/reverse-spec/milestone-M1.md through M8.md]

---

## 7. Data and State Model

### State Persistence Categories

| Category | Components | Persistence Strategy |
|---|---|---|
| **Immediate-persistent** | OAuth credentials, strike/block state, response records | Written to disk immediately on change |
| **Debounced-persistent** | Request counts, token usage | Batched writes with 60-second minimum interval |
| **Ephemeral** | Proxy health state, rate limit counters, account locks, MCP sessions | In-memory only — lost on restart |

### File-Backed Stores

| File Pattern | Content | Write Strategy |
|---|---|---|
| `oauth_creds.json` | Default account OAuth credentials | Immediate |
| `oauth_creds_<email>.json` | Named account OAuth credentials | Immediate |
| `request_counts.json` | Daily request/token counters per account | Debounced (60s minimum) |
| `account_health.json` | Strike/block state per account | Immediate on strike/reset |
| `openai-responses/index.json` | Index of stored response IDs | Immediate |
| `openai-responses/responses/<id>.json` | Individual response records | Immediate |

### Race Condition Mitigation

| Concern | Strategy |
|---|---|
| Concurrent requests to same account | Boolean lock flag per account |
| Concurrent token refreshes | Promise deduplication |
| Concurrent disk writes | Pending-save flag with 60-second debounce |
| OAuth refresh during active request | Account lock acquired before refresh |

### Data Loss Risks

| Data | Risk Window |
|---|---|
| Request counts / token usage | Up to 60 seconds (debounced saves) |
| Account locks, MCP sessions, rate limit counters, proxy health | All lost on restart |
| Account rotation index | Resets to 0 on restart |

[evidence: docs/reverse-spec/NOTES.md (M3), docs/reverse-spec/milestone-M3.md]

---

## 8. External and Internal Interfaces

### HTTP Route Registry

| Method | Path | Capability | Auth |
|---|---|---|---|
| POST | `/v1/chat/completions` | Chat completion translator | API key (if configured) |
| POST | `/v1/responses` | Responses API translator | API key (if configured) |
| POST | `/v1/web/search` | Web search translator | API key (if configured) |
| GET | `/v1/models` | Model listing (static) | API key (if configured) |
| POST | `/auth/initiate` | Authentication initiation | API key (if configured) |
| POST | `/auth/poll` | Authentication polling | API key (if configured) |
| GET | `/mcp` | MCP session establishment (SSE) | None |
| POST | `/mcp` | MCP request processing | Internal API key check |
| GET | `/health` | Health status report | None |

[evidence: src/app.js:78-114]

### Upstream API Endpoints

| Endpoint | Purpose |
|---|---|
| `.../oauth2/device/code` | OAuth device code initiation |
| `.../oauth2/token` | Token polling and refresh |
| `.../compatible-mode/v1/chat/completions` | Chat completions |
| `.../api/v1/indices/plugin/web_search` | Web search |

[evidence: src/qwen/auth.js:15-17, src/qwen/api.js:34]

### MCP JSON-RPC Methods

| Method | Description |
|---|---|
| `initialize` | MCP handshake — protocol version `2024-11-05` |
| `tools/list` | Exposes single `web_search` tool |
| `tools/call` | Invokes `web_search` via loopback HTTP to `/v1/web/search` |

[evidence: src/mcp.js:78-189]

---

## 9. Core Workflows

### Chat Completion (Non-Streaming)

1. **Ingress**: Extract account identifier (header > query > body > default), detect streaming flag
2. **Transform**: System prompt injection (prepend/append, model-filtered)
3. **Account Selection**: Upstream client triggers rotation engine
4. **Upstream Call**: Execute with account rotation — candidate pool selection, lock acquisition, POST to upstream API
5. **Post-processing**: Extract metadata (actual account, proxy), log
6. **Return**: JSON response

### Chat Completion (Streaming)

1. **Ingress**: Same as regular, streaming flag branches to streaming handler
2. **Transform**: Same system prompt transformation
3. **Upstream Call**: Streaming method on upstream client — creates streaming pipe, pipes upstream response
4. **Stream Piping**: Upstream SSE piped directly to client — minimal transformation
5. **Token Extraction**: Wrapped stream intercepts terminal chunk for usage metadata
6. **Client Disconnect**: Request close event destroys upstream stream
7. **Return**: SSE stream with appropriate headers

### Responses API (Regular)

Six-stage pipeline:
1. **Normalize**: Validate input, reject unsupported fields, canonicalize
2. **Load Previous**: State store lookup for `previous_response_id`
3. **Lower**: Transform to Chat format — instruction messages, carryover, current input
4. **Upstream Call**: Same rotation as chat endpoint
5. **Lift**: Generate response IDs, map choices to output items
6. **Persist**: Build carryover items, save record if `store=true`

### Responses API (Streaming)

Same normalize and lower stages, but upstream call returns a streaming pipe adapted by the SSE adapter which emits an 11-event Responses-format SSE sequence.

### Account Rotation Execution Flow

```
attemptsUsed = 0
while attemptsUsed < maxAttempts (default 5):
    candidates = getCandidatePool()  // 3-tier fallback
    for candidate in candidates:
        attemptsUsed += 1
        try:
            result = executeOperationWithAccount(candidate)
            onSuccess()  // increment counts, reset strikes
            return result
        catch:
            if locked: attemptsUsed -= 1; continue
            if rate_limit: break  // next candidate pool
            if no_proxy_route: break
            if proxy_network_error: break  // triggers rebind
            if quota_exceeded: addStrike(); break
            break  // generic: no strike
throw "No available accounts"
```

### Per-Operation Error Classification

| Layer | Error Type | Action |
|---|---|---|
| Immediate rethrow | Account locked, no proxy route, proxy network error, quota exceeded | Rethrow to rotation loop |
| Exponential backoff | Rate limit 429 (non-quota) | Retry same account: 2s × 2^n + jitter, up to 5 retries |
| Credential refresh | Auth errors (401/403) | Refresh token, retry once |

### Web Search

1. Validate query (required), page (positive integer), rows (1-100)
2. Account selection via same rotation pattern
3. POST to web search endpoint with query parameters
4. Custom 429 response for quota exceeded (2000 requests/day limit)

### Models Listing

Static response — no upstream call. Returns hardcoded model list.

### Auth Initiate/Poll

- **Initiate**: Generate PKCE pair → POST to device code endpoint → return verification URI, user code, device code, code verifier
- **Poll**: Validate codes → POST to token endpoint → handle OAuth errors → return access token and message

[evidence: docs/reverse-spec/NOTES.md (M4), docs/reverse-spec/milestone-M4.md]

---

## 10. Configuration and Environment Model

### Environment Variable Reference

#### Server
| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `localhost` | HTTP listen address |

#### OAuth / Upstream
| Variable | Default | Description |
|---|---|---|
| `QWEN_CLIENT_ID` | `f0304373b74a44d2b584a3fb70ca9e56` | OAuth client ID |
| `QWEN_CLIENT_SECRET` | `''` | OAuth client secret (unused) |
| `QWEN_BASE_URL` | `https://chat.qwen.ai` | Upstream API base URL |
| `QWEN_DEVICE_CODE_ENDPOINT` | `.../device/code` | Device code endpoint |
| `QWEN_TOKEN_ENDPOINT` | `.../token` | Token endpoint |
| `QWEN_SCOPE` | `openid profile email model.completion` | OAuth scopes |
| `QWEN_CODE_AUTH_USE` | `true` | Use default credential file |

**Note**: OAuth constants in the authentication module are hardcoded and NOT overridden by these environment variables [evidence: src/qwen/auth.js:15-21 vs src/config.js:13-20].

#### Request Defaults
| Variable | Default | Description |
|---|---|---|
| `DEFAULT_MODEL` | `qwen3-coder-plus` | Default model |
| `DEFAULT_TEMPERATURE` | `0.7` | Default temperature |
| `DEFAULT_MAX_TOKENS` | `65536` | Default max output tokens |
| `DEFAULT_TOP_P` | `0.8` | Default top_p |
| `DEFAULT_TOP_K` | `20` | Default top_k |
| `DEFAULT_REPETITION_PENALTY` | `1.05` | Default repetition penalty |
| `DEFAULT_ACCOUNT` | `''` | Default account identifier |
| `TOKEN_REFRESH_BUFFER` | `30000` | Milliseconds before expiry to refresh |
| `STREAM` | `false` | Enable streaming by default |

#### Logging
| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `error` | `off`, `error`, `error-debug`, `debug` |
| `ERROR_LOG_MAX_MB` | `10` | Error log rotation threshold |
| `ERROR_LOG_MAX_DAYS` | `30` | Archived error log retention |
| `MAX_DEBUG_LOGS` | `20` | Max debug directories |

#### Rate Limiting and Proxy
| Variable | Default | Description |
|---|---|---|
| `MAX_REQUESTS_PER_MINUTE` | `60` | Account-level rate limit |
| `MAX_REQUESTS_PER_MINUTE_PER_IP` | `60` | Proxy-level rate limit |
| `RATE_LIMIT_RETRY_DELAY_MS` | `2000` | Base backoff delay |
| `RATE_LIMIT_MAX_RETRIES` | `5` | Max rate limit retries |
| `PROXY_LIST` | `''` | Comma-separated proxy URLs |
| `USE_DEFAULT_PROXY_WITH_LIST` | `false` | Include virtual proxy |
| `PROXY_CONSECUTIVE_NETWORK_ERRORS` | `3` | Errors before proxy disabled |
| `BAD_PROXY_COOLDOWN_MS` | `600000` | Cooldown (10 minutes) |
| `PROXY_RECOVERY_CHECK_INTERVAL_MS` | `60000` | Recovery check (60 seconds) |

#### Security and System Prompt
| Variable | Default | Description |
|---|---|---|
| `API_KEY` | `null` | Comma-separated API keys |
| `SYSTEM_PROMPT_ENABLED` | `true` (when unset) | Master toggle (`!== 'false'`) |
| `SYSTEM_PROMPT_FILE` | `null` | Custom prompt file path |
| `SYSTEM_PROMPT_MODE` | `prepend` | `prepend` or `append` |
| `SYSTEM_PROMPT_MODELS` | `null` | Model filter (null = all) |

[evidence: src/config.js:1-85, docs/reverse-spec/milestone-M9.md]

---

## 11. Dependencies and Integrations

### Dependency Categories

| Category | Capability |
|---|---|
| HTTP Server Framework | Request routing, middleware pipeline, CORS support |
| HTTP Client Library | Upstream API communication with proxy support |
| Authentication Utilities | QR code generation, browser launching |
| Token Counting Library | Approximate token counting with fallback estimation |
| Logging Framework | Structured logging with file rotation |
| CLI Utilities | Table formatting, environment variable loading |
| Proxy Support Library | HTTP/HTTPS proxy agent creation |
| Test Framework | Unit and integration test execution |

### Upstream Integrations

- **OAuth Provider**: Device code flow, token polling, refresh
- **Model Inference API**: Chat completions, web search
- **Token Counting Library**: Approximate token counting using a standard encoding — not native to the upstream provider's models

[evidence: package.json, docs/reverse-spec/REPO-MAP.md]

---

## 12. Security and Trust Boundaries

### Authentication Layers

1. **OAuth 2.0 Device Flow with PKCE (upstream)**: Authenticates the proxy to the upstream provider's API. Uses `code_verifier`/`code_challenge` (SHA-256, S256 method). Tokens refreshed automatically before expiry.

2. **API Key Gate (downstream)**: Optional protection for API and authentication routes. Accepts `x-api-key` header or `Authorization: Bearer <key>`. Supports multiple comma-separated keys. MCP endpoint performs its own internal check.

3. **Credential File Protection**: OAuth credentials stored in a user-local directory — shared with the upstream provider's CLI tool. File permissions rely on OS-level user isolation.

### Trust Boundaries

```
[Untrusted Client] ←── API Key Gate ──→ [Proxy (trusted)] ←── OAuth ──→ [Upstream API (trusted)]
                                                │
                                         File-backed state
                                         (OS user isolation)
```

### Sensitive Data Handling

| Subsystem | Masking Strategy |
|---|---|
| Live Logger | API keys: first 13 chars + ellipsis; Account IDs: first 8 chars |
| File Logger | Headers (authorization, x-api-key, cookie): first 10 + ellipsis + last 4 |
| Debug Logger | Authorization headers and tokens fully redacted |

### Known Security Risks

| Risk | Severity | Description |
|---|---|---|
| Environment file in container image | High | Container ignore list does not exclude environment file — secrets baked into image layers |
| Token refresh conflict | Medium | Concurrent refreshes (server and CLI) can invalidate each other's tokens when default and named credential files coexist |
| No TLS termination | Medium | Proxy runs HTTP only; TLS must be handled externally |
| Hardcoded OAuth constants | Low | Client ID and endpoints hardcoded in authentication module — not configurable |

[evidence: .dockerignore:1-46, src/qwen/auth.js:151-156, src/app.js:44-75, src/mcp.js:35-44]

---

## 13. Reliability, Error Handling, and Observability

### Error Response Formats

**Standard format** (most endpoints):
```json
{"error": {"message": "...", "type": "...", "code": <numeric>}}
```

**Responses API format**:
```json
{"error": {"message": "...", "type": "...", "code": "<string identifier>"}}
```

### Error Propagation Matrix

| Error Type | HTTP Status | Chat | Responses (JSON) | Responses (SSE) | Web Search |
|---|---|---|---|---|---|
| Validation | 400 | Standard formatter | Custom error class | SSE error event | Standard formatter |
| Authentication | 401 | Standard formatter | Standard formatter | SSE error event | Standard formatter |
| Rate Limit | 429 | Standard formatter | Standard formatter | SSE error event | Custom 429 |
| Proxy Routing | 503 | Custom 503 | Custom error class | SSE error event | Custom 503 |
| Generic API | 500 | Standard formatter | Custom error class | SSE error event | Standard formatter |

**Streaming handlers** check whether headers have been sent before writing error responses. Responses API streaming errors always use SSE format.

### Three-Tier Logging

| Tier | Output | Gating | Purpose |
|---|---|---|---|
| **Live Logger** | Standard output | Always active | Real-time per-account monitoring |
| **File Logger** | Log directory | Environment variable | Request/response archival with rotation |
| **Debug Logger** | Debug directory | Configuration flag | Detailed API call dumps for troubleshooting |

### Health Endpoint

`GET /health` — no API key required. Reloads all accounts, computes per-account status (`healthy`, `blocked`, `expiring_soon`, `expired`, `unknown`), aggregates token usage, reports server info (uptime, memory, runtime version).

[evidence: src/app.js:92-219, docs/reverse-spec/NOTES.md (M2)]

---

## 14. Build, Test, and Delivery Model

### Build Characteristics

- **Package manager**: npm with lock file
- **Production install**: Clean install from lock file in container build
- **No compilation step**: Pure interpreted code, no transpilation

### Test Characteristics

- **Framework**: Jest
- **Coverage**: 8 test files (6 Responses API unit tests, 1 integration test, 1 file logger unit test)
- **Major gaps**: No tests for account rotation, OAuth flow, proxy binding, strike system, MCP server, CLI tools

### Deployment

- **Container**: Runtime version 20 Alpine base image, port 8080, health check every 30 seconds
- **Service composition**: Single service with volume mount for credential persistence, extensive environment variable configuration, restart policy
- **Runtime**: Environment file loaded at startup

### Operational Procedures

- **Add account**: CLI command → QR code → browser approval → instant availability
- **Check usage**: CLI command → tabular daily report
- **Check health**: CLI command or HTTP endpoint
- **Monitor**: Live logger output, container health check, file logger rotation

[evidence: Dockerfile, docker-compose.yml, docs/reverse-spec/milestone-M9.md]

---

## 15. Constraints, Technical Debt, and Risks

### Confirmed Technical Debt

| Item | Impact |
|---|---|
| Declared but unused queue structure | Minor memory overhead |
| Unused HTTP agent declarations | Minor memory overhead |
| Duplicate model entry in listing response | Cosmetic — duplicate in model listing response |
| Unused declared dependencies | Increased bundle size |
| Streaming record data loss | Debug/troubleshooting gap — upstream request messages and response data not captured in streaming mode |
| Streaming re-lowering redundancy | Minor inefficiency — recomputes transformation already done in non-streaming path |
| MCP bearer prefix handling divergence | Edge case authentication inconsistency between gateway middleware and MCP internal check |

### Architectural Limitations

| Limitation | Description |
|---|---|
| Single-process | No horizontal scaling; in-memory state not shared |
| File-based persistence | Requires shared volume for multi-instance deployments |
| No HTTP drain on shutdown | Active requests terminated immediately on interrupt/termination |
| No TLS termination | HTTP only; requires reverse proxy for HTTPS |
| Approximate token counting | Uses a standard encoding, not native to the upstream provider's models |
| No Responses API state cleanup | Response records accumulate indefinitely — no time-to-live |

### Operational Risks

| Risk | Likelihood | Impact |
|---|---|---|
| Token refresh conflict (dual credential files) | Medium | Authentication failures when server and CLI refresh same account |
| Refresh failure during active requests | Medium | Account may retain expired token for up to 5 minutes |
| Proxy URL validation absent | Low | Misconfigured proxies consume attempt slots before failing |
| OAuth constants not configurable | Low | Cannot customize for self-hosted instances |
| System prompt enabled default mismatch | Low | Documentation suggests disabled, code defaults to enabled |

[evidence: docs/reverse-spec/OPEN-QUESTIONS.md, docs/reverse-spec/NOTES.md]

---

## 16. Unknowns and Open Questions

### High Priority

| ID | Question | Status |
|---|---|---|
| Q1 | Exact upstream API request/response schema | Unknown — inferred from code observation |
| Q2 | Token refresh conflict behavior with dual credential files | Observed — concurrent refreshes can invalidate each other; no programmatic prevention |
| Q17 | Why OAuth constants hardcoded in authentication module when configuration module defines equivalents | Observed — authentication module never imports configuration values for OAuth constants |
| Q18 | Scheduled refresh failure during active requests | Observed — throws immediately if account lock held; no retry |

### Medium Priority

| ID | Question | Status |
|---|---|---|
| Q4 | Responses API field coverage completeness | Updated — 17 accepted fields, 11 rejected; external comparison needed |
| Q6 | Mid-stream error recovery robustness | Resolved — handles 3 formats but edge cases remain with multi-chunk errors |
| Q13 | Streaming re-lowering inconsistency | Resolved — confirmed redundant but practically negligible |
| Q14 | Streaming record messages lost | Resolved — confirmed intentional design limitation |
| Q15 | Duplicate model entry | Observed — copy-paste error or outdated config |
| Q16 | Agent mode detection sufficiency | Inferred — heuristic may miss other patterns |
| Q19 | Proxy URL validation absent | Observed — no validation; errors surface at connection time |
| Q20 | Account ordering interaction (binding vs rotation) | Inferred — alphabetical binding plus round-robin index produces unintuitive patterns |

### Low Priority

| ID | Question | Status |
|---|---|---|
| Q8 | Cloud function deployment variant | Unknown — external repo not present |
| Q10 | Test coverage gaps | Resolved — 8 test files; major gaps in rotation/auth/proxy/MCP |
| Q11 | Unused declared dependencies | Observed — zero imports confirmed |
| Q12 | MCP bearer prefix edge case | Observed — behavioral divergence on nested bearer prefix |
| Q21 | Declared but unused queue structure | Observed — declaration only, never referenced |
| Q22 | System prompt enabled default mismatch | Observed — documentation says disabled, code defaults to enabled |
| Q23 | Environment file included in container image | Observed — not in container ignore list |

[evidence: docs/reverse-spec/OPEN-QUESTIONS.md]

---

## 17. Glossary

| Term | Definition |
|---|---|
| **Upstream Provider API** | The external API platform providing model inference endpoints |
| **Device Flow** | OAuth 2.0 Device Authorization Grant (RFC 8628) — user approves on separate device |
| **PKCE** | Proof Key for Code Exchange — prevents authorization code interception attacks |
| **Account Rotation** | Automatic failover across multiple OAuth accounts when one is rate-limited or blocked |
| **Strike** | Progressive penalty applied to an account for quota-exceeded errors; accumulates to longer blocks |
| **Proxy Binding** | 1:1 mapping of accounts to HTTP proxies for IP-based rate limit distribution |
| **Lowering** | Transforming Responses API format to Chat Completions format for upstream calls |
| **Lifting** | Transforming Chat Completions responses back to Responses API format |
| **Carryover** | Accumulated conversation items passed between chained Responses API requests |
| **MCP** | Model Context Protocol — JSON-RPC over SSE for tool exposure |
| **Streaming Pipe** | A pass-through data channel that forwards data without transformation, used for SSE piping |
| **Delayed Batched Persistence** | Deferred file write that batches multiple updates within a time window (60 seconds) |

---

## 18. Implementation Anchors

This section maps the abstract architecture above to concrete implementation artifacts.

### Module-to-Component Mapping

| Abstract Component | Concrete Implementation |
|---|---|
| HTTP Gateway | `src/app.js` — Express.js app factory with middleware pipeline |
| Request Handler | `src/proxy.js` — `QwenOpenAIProxy` class |
| Upstream Client | `src/qwen/api.js` — `QwenAPI` class |
| Authentication Manager | `src/qwen/auth.js` — `QwenAuthManager` class |
| Configuration Loader | `src/config.js` — dotenv-based environment loader |
| MCP Server | `src/mcp.js` — SSE+JSON-RPC handler |
| Proxy Router | `src/utils/proxyManager.js` — `ProxyManager` class |
| Account Health Manager | `src/utils/accountHealthManager.js` — `AccountHealthManager` class |
| Refresh Scheduler | `src/utils/accountRefreshScheduler.js` — `AccountRefreshScheduler` class |
| System Prompt Transformer | `src/utils/systemPromptTransformer.js` |
| Token Counter | `src/utils/tokenCounter.js` — tiktoken integration |
| Error Formatter | `src/utils/errorFormatter.js` |
| Responses Normalizer | `src/responses/normalizeResponsesRequest.js` |
| Responses Lowering | `src/responses/lowerResponsesToChat.js` |
| Responses Lifting | `src/responses/liftChatToResponses.js` |
| SSE Adapter | `src/responses/streamChatToResponsesSse.js` |
| State Store | `src/responses/responsesStateStore.js` |
| Response ID Generator | `src/responses/responseId.js` |
| Error Types | `src/responses/responsesErrors.js` |
| Server Bootstrap | `src/index.js` |
| Live Logger | `src/utils/liveLogger.js` — Winston-based |
| File Logger | `src/utils/fileLogger.js` |
| Debug Logger | `src/utils/logger.js` — `DebugLogger` class |

### CLI Tools

| Command | Implementation |
|---|---|
| `npm run auth` | `authenticate.js` — default account authentication |
| `npm run auth:list` | `authenticate.js` — account listing |
| `npm run auth:add <id>` | `authenticate.js` — add account with QR code |
| `npm run auth:remove <id>` | `authenticate.js` — remove account |
| `npm run auth:counts` | `authenticate.js` — request counts |
| `npm run usage` | `usage.js` — daily usage report |
| `npm run health` | `health.js` — health report |

### npm Dependencies

| Package | Usage |
|---|---|
| express | HTTP server and routing |
| cors | Cross-origin resource sharing |
| axios | HTTP client for upstream API calls |
| qrcode-terminal | QR code generation for OAuth flow |
| open | Browser launching for OAuth |
| tiktoken | Token counting (cl100k_base encoding) |
| winston | Structured logging |
| cli-table3 | CLI table formatting |
| dotenv | Environment variable loading |
| proxy-agent | HTTP/HTTPS proxy support |
| jest | Test framework (dev) |
| nodemon | Development hot-reload (dev) |
| openai | Listed but unused |
| undici | Listed but unused |

### File Persistence Paths

All file-backed state stored under `~/.qwen/`:

| File | Content |
|---|---|
| `oauth_creds.json` | Default account OAuth credentials |
| `oauth_creds_<email>.json` | Named account OAuth credentials |
| `request_counts.json` | Daily request/token counters |
| `account_health.json` | Strike/block state |
| `openai-responses/index.json` | Response ID index |
| `openai-responses/responses/<id>.json` | Individual response records |

### Container Build

- **Base image**: `node:20-alpine`
- **Install**: `npm ci --only=production`
- **Runtime**: `node --env-file=.env src/index.js`
- **Health check**: HTTP GET `/health` every 30 seconds
- **Volume**: `./.qwen:/root/.qwen` for credential persistence

### Verification Commands Used

- `grep -r "require(...)" src/` — dependency graph validation
- `grep -r "app\.\(get\|post\|use\)" src/app.js` — route enumeration
- `grep -r "process\.env\." src/` — environment variable discovery
- `grep -r "accountQueues" src/` — dead code confirmation
- `grep -r "require.*openai\|require.*undici" src/ *.js` — unused dependency confirmation

---

## 19. Evidence Map

This specification was derived from direct code inspection across 10 milestone phases. Every important claim is backed by inline citations in the format `[evidence: path:lines]`. The following table summarizes the primary evidence sources:

| Specification Section | Primary Evidence Sources |
|---|---|
| System Overview | `AGENTS.md`, `docs/README.md`, `src/index.js` |
| Repository Overview | `docs/reverse-spec/REPO-MAP.md`, `docs/reverse-spec/milestone-M1.md` |
| Architecture | `src/app.js`, `src/proxy.js`, `src/qwen/api.js`, dependency graph |
| Entry Points | `src/index.js:1-106`, `authenticate.js:290-325` |
| Components | `docs/reverse-spec/milestone-M1.md` through `M8.md` |
| Data Model | `docs/reverse-spec/NOTES.md` (M3), `docs/reverse-spec/milestone-M3.md` |
| External Interfaces | `src/app.js:78-114`, `src/mcp.js`, `src/qwen/auth.js:15-17` |
| Core Workflows | `docs/reverse-spec/NOTES.md` (M4), `docs/reverse-spec/milestone-M4.md` |
| Configuration | `src/config.js:1-85`, `docs/reverse-spec/milestone-M9.md` |
| Dependencies | `package.json`, `docs/reverse-spec/REPO-MAP.md` |
| Security | `src/app.js:44-75`, `src/mcp.js:35-44`, `.dockerignore` |
| Error Handling | `src/utils/errorFormatter.js`, `src/responses/responsesErrors.js`, `src/proxy.js` |
| Build/Test/Deploy | `Dockerfile`, `docker-compose.yml`, `docs/reverse-spec/milestone-M9.md` |
| Technical Debt | `docs/reverse-spec/NOTES.md`, `docs/reverse-spec/OPEN-QUESTIONS.md` |
| Open Questions | `docs/reverse-spec/OPEN-QUESTIONS.md` |

---

## 20. Coverage and Abstraction Audit

### Specification Completeness

All 20 required sections are present. The specification covers the system at two levels of abstraction:

1. **Main body (Sections 1-17)**: Programming-language-agnostic architecture description using neutral terms (component, subsystem, handler, adapter, store, scheduler, gateway, pipeline).
2. **Implementation Anchors (Section 18)**: Concrete mapping from abstract components to specific files, classes, packages, and build artifacts.

### Claim Confidence Distribution

| Confidence Level | Approximate Share | Description |
|---|---|---|
| **Observed** | Majority (~85%) | Directly verified in source code with line citations |
| **Inferred** | Small fraction (~12%) | Reasonable conclusions from code patterns, explicitly marked |
| **Unknown** | Minimal (~3%) | Cannot be determined from code alone (Q1, Q8) |

### Abstraction Approach

The main narrative avoids dependence on any specific programming language, framework, file layout, or naming convention. Implementation-specific details (file paths, class names, package names, build commands) are confined to Section 18 (Implementation Anchors), enabling readers to understand the architecture independently of the technology stack while still being able to trace claims back to concrete code.

### Milestone-to-Spec Mapping

| Milestone | Spec Sections Covered |
|---|---|
| M1 (Repository Map) | Sections 3, 4, 6, 11, 18 |
| M2 (Interface Surface) | Sections 8, 13 |
| M3 (Data and State) | Section 7 |
| M4 (Core Workflows) | Section 9 |
| M5 (Authentication) | Sections 10, 12 |
| M6 (Proxy Rotation) | Sections 9, 10 |
| M7 (Responses API) | Sections 6, 8, 9 |
| M8 (MCP and Utilities) | Sections 6, 8, 11, 13, 14 |
| M9 (Operations) | Sections 5, 10, 14 |
| M10 (Synthesis) | All sections |
