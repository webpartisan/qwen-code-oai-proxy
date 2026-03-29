const { liftChatToResponses } = require('../liftChatToResponses');

describe('liftChatToResponses', () => {
  describe('text response mapping', () => {
    it('should map assistant text to message output item', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Hello' }],
        instructions: null,
        tools: null,
        toolChoice: null,
        stream: false,
        store: true,
        previousResponseId: null,
        metadata: null,
        temperature: null,
        maxOutputTokens: null,
        topP: null,
        reasoning: null
      };

      const upstreamResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1770000000,
        model: 'qwen3-coder-plus',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello!'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12
        }
      };

      const result = liftChatToResponses({ normalizedRequest, previousResponseId: null, upstreamResponse });

      expect(result.responseObject).toBeDefined();
      expect(result.responseObject.output).toHaveLength(1);
      expect(result.responseObject.output[0].type).toBe('message');
      expect(result.responseObject.output[0].role).toBe('assistant');
      expect(result.responseObject.output[0].content[0].type).toBe('output_text');
      expect(result.responseObject.output[0].content[0].text).toBe('Hello!');
    });

    it('should populate output_text helper', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Hello' }],
        instructions: null,
        tools: null,
        toolChoice: null,
        stream: false,
        store: true,
        previousResponseId: null,
        metadata: null,
        temperature: null,
        maxOutputTokens: null,
        topP: null,
        reasoning: null
      };

      const upstreamResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1770000000,
        model: 'qwen3-coder-plus',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello World!'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          total_tokens: 13
        }
      };

      const result = liftChatToResponses({ normalizedRequest, previousResponseId: null, upstreamResponse });

      expect(result.outputText).toBe('Hello World!');
      expect(result.responseObject.output_text).toBe('Hello World!');
    });
  });

  describe('function call mapping', () => {
    it('should map function calls to function_call items', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Get weather' }],
        instructions: null,
        tools: [{ type: 'function', name: 'get_weather', parameters: {} }],
        toolChoice: null,
        stream: false,
        store: true,
        previousResponseId: null,
        metadata: null,
        temperature: null,
        maxOutputTokens: null,
        topP: null,
        reasoning: null
      };

      const upstreamResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1770000000,
        model: 'qwen3-coder-plus',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc123',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location": "Tokyo"}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      };

      const result = liftChatToResponses({ normalizedRequest, previousResponseId: null, upstreamResponse });

      expect(result.responseObject.output).toHaveLength(1);
      expect(result.responseObject.output[0].type).toBe('function_call');
      expect(result.responseObject.output[0].name).toBe('get_weather');
      expect(result.responseObject.output[0].arguments).toBe('{"location": "Tokyo"}');
    });
  });

  describe('usage mapping', () => {
    it('should map usage fields correctly', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Hello' }],
        instructions: null,
        tools: null,
        toolChoice: null,
        stream: false,
        store: true,
        previousResponseId: null,
        metadata: null,
        temperature: null,
        maxOutputTokens: null,
        topP: null,
        reasoning: null
      };

      const upstreamResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1770000000,
        model: 'qwen3-coder-plus',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hi'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12
        }
      };

      const result = liftChatToResponses({ normalizedRequest, previousResponseId: null, upstreamResponse });

      expect(result.responseObject.usage.input_tokens).toBe(10);
      expect(result.responseObject.usage.output_tokens).toBe(2);
      expect(result.responseObject.usage.total_tokens).toBe(12);
    });
  });

  describe('local ID generation', () => {
    it('should use local resp_* prefix for response id', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Hello' }],
        instructions: null,
        tools: null,
        toolChoice: null,
        stream: false,
        store: true,
        previousResponseId: null,
        metadata: null,
        temperature: null,
        maxOutputTokens: null,
        topP: null,
        reasoning: null
      };

      const upstreamResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1770000000,
        model: 'qwen3-coder-plus',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hi'
            },
            finish_reason: 'stop'
          }
        ]
      };

      const result = liftChatToResponses({ normalizedRequest, previousResponseId: null, upstreamResponse });

      expect(result.responseObject.id).toMatch(/^resp_/);
      expect(result.responseObject.id).not.toBe('chatcmpl-123');
    });

    it('should use local msg_* prefix for message ids', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Hello' }],
        instructions: null,
        tools: null,
        toolChoice: null,
        stream: false,
        store: true,
        previousResponseId: null,
        metadata: null,
        temperature: null,
        maxOutputTokens: null,
        topP: null,
        reasoning: null
      };

      const upstreamResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1770000000,
        model: 'qwen3-coder-plus',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hi'
            },
            finish_reason: 'stop'
          }
        ]
      };

      const result = liftChatToResponses({ normalizedRequest, previousResponseId: null, upstreamResponse });

      expect(result.responseObject.output[0].id).toMatch(/^msg_/);
    });

    it('should pass through previous_response_id when provided', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Hello' }],
        instructions: null,
        tools: null,
        toolChoice: null,
        stream: false,
        store: true,
        previousResponseId: null,
        metadata: null,
        temperature: null,
        maxOutputTokens: null,
        topP: null,
        reasoning: null
      };

      const upstreamResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1770000000,
        model: 'qwen3-coder-plus',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hi'
            },
            finish_reason: 'stop'
          }
        ]
      };

      const result = liftChatToResponses({ normalizedRequest, previousResponseId: 'resp_previous', upstreamResponse });

      expect(result.responseObject.previous_response_id).toBe('resp_previous');
    });
  });
});
