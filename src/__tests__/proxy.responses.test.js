const { PassThrough } = require('stream');

function createMockRes() {
  return {
    headersSent: false,
    writableEnded: false,
    headers: {},
    writes: [],
    statusCode: 200,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    write(data) {
      this.headersSent = true;
      this.writes.push(String(data));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.jsonPayload = payload;
      this.writableEnded = true;
      return this;
    }
  };
}

describe('QwenOpenAIProxy /v1/responses', () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    process.env.LOG_LEVEL = 'off';
  });

  afterEach(() => {
    process.env.LOG_LEVEL = originalLogLevel;
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock('../responses/streamChatToResponsesSse.js');
  });

  it('returns SSE error when previous_response_id is missing for an SSE request', async () => {
    const { QwenOpenAIProxy } = require('../proxy.js');
    const proxy = new QwenOpenAIProxy({
      qwenAPI: {},
      authManager: {},
      config: {}
    });

    const req = {
      headers: { accept: 'text/event-stream' },
      query: {},
      body: {
        model: 'qwen3-coder-plus',
        input: 'hello',
        previous_response_id: 'resp_missing'
      }
    };
    const res = createMockRes();
    const responsesStateStore = {
      load: jest.fn().mockResolvedValue(null)
    };

    await proxy.handleResponses(req, res, { responsesStateStore });

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload).toBeUndefined();
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.writes.join('')).toContain('event: error');
    expect(res.writes.join('')).toContain('previous_response_not_found');
  });

  it('persists full non-stream carryover including previous context, current input, and assistant output', async () => {
    const { QwenOpenAIProxy } = require('../proxy.js');
    const qwenAPI = {
      chatCompletions: jest.fn().mockResolvedValue({
        model: 'qwen3-coder-plus',
        choices: [
          {
            message: { content: 'New assistant answer' },
            finish_reason: 'stop'
          }
        ],
        usage: {}
      })
    };
    const proxy = new QwenOpenAIProxy({
      qwenAPI,
      authManager: {},
      config: {}
    });

    const req = {
      headers: {},
      query: {},
      body: {
        model: 'qwen3-coder-plus',
        input: 'Current question',
        previous_response_id: 'resp_prev'
      }
    };
    const res = createMockRes();
    const responsesStateStore = {
      load: jest.fn().mockResolvedValue({
        carryover_items: [
          { role: 'user', content: 'Earlier question' },
          { role: 'assistant', content: 'Earlier answer' }
        ]
      }),
      save: jest.fn().mockResolvedValue()
    };

    await proxy.handleResponses(req, res, { responsesStateStore });

    expect(responsesStateStore.save).toHaveBeenCalledTimes(1);
    expect(responsesStateStore.save.mock.calls[0][0].carryover_items).toEqual([
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Current question' },
      { role: 'assistant', content: 'New assistant answer' }
    ]);
  });

  it('persists full streaming carryover including previous context, tool output capable input, and assistant output', async () => {
    jest.doMock('../responses/streamChatToResponsesSse.js', () => ({
      streamChatToResponsesSse: jest.fn(async ({ onCompleted }) => {
        await onCompleted({
          id: 'resp_stream',
          created_at: 1,
          model: 'qwen3-coder-plus',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Streamed answer' }]
            }
          ]
        });
      })
    }));

    const { QwenOpenAIProxy } = require('../proxy.js');
    const qwenAPI = {
      streamChatCompletions: jest.fn().mockResolvedValue(new PassThrough())
    };
    const proxy = new QwenOpenAIProxy({
      qwenAPI,
      authManager: {},
      config: {}
    });

    const req = {
      headers: { accept: 'text/event-stream' },
      query: {},
      on: jest.fn(),
      body: {
        model: 'qwen3-coder-plus',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_123',
            output: 'tool result'
          }
        ],
        stream: true,
        previous_response_id: 'resp_prev'
      }
    };
    const res = createMockRes();
    const responsesStateStore = {
      load: jest.fn().mockResolvedValue({
        carryover_items: [
          { role: 'user', content: 'Earlier question' },
          { role: 'assistant', content: 'Earlier answer' }
        ]
      }),
      save: jest.fn().mockResolvedValue()
    };

    await proxy.handleResponses(req, res, { responsesStateStore });

    expect(responsesStateStore.save).toHaveBeenCalledTimes(1);
    expect(responsesStateStore.save.mock.calls[0][0].carryover_items).toEqual([
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'tool', tool_call_id: 'call_123', content: 'tool result' },
      { role: 'assistant', content: 'Streamed answer' }
    ]);
  });
});
