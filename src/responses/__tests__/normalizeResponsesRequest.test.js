const { 
  normalizeResponsesRequest, 
  normalizeMessageContent,
  normalizeTools,
  normalizeToolChoice
} = require('../normalizeResponsesRequest');

describe('normalizeResponsesRequest', () => {
  describe('input validation', () => {
    it('should accept string input', () => {
      const request = { input: 'Hello' };
      const result = normalizeResponsesRequest(request);
      
      expect(result).toBeDefined();
      expect(result.inputItems).toEqual([{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }]
      }]);
    });

    it('should accept array input', () => {
      const request = {
        input: [
          { type: 'message', role: 'user', content: 'Hello' }
        ]
      };
      const result = normalizeResponsesRequest(request);
      
      expect(result).toBeDefined();
      expect(result.inputItems).toHaveLength(1);
    });

    it('should reject missing input', () => {
      const request = {};
      expect(() => normalizeResponsesRequest(request)).toThrow();
    });
  });

  describe('Codex compatibility fields', () => {
    it('should accept parallel_tool_calls field', () => {
      const request = {
        input: 'Hello',
        parallel_tool_calls: true
      };
      const result = normalizeResponsesRequest(request);
      expect(result.parallelToolCalls).toBe(true);
    });

    it('should accept include field', () => {
      const request = {
        input: 'Hello',
        include: ['content']
      };
      const result = normalizeResponsesRequest(request);
      expect(result.include).toEqual(['content']);
    });

    it('should accept prompt_cache_key field', () => {
      const request = {
        input: 'Hello',
        prompt_cache_key: 'my-key'
      };
      const result = normalizeResponsesRequest(request);
      expect(result.promptCacheKey).toBe('my-key');
    });

    it('should accept metadata field', () => {
      const request = {
        input: 'Hello',
        metadata: { key: 'value' }
      };
      const result = normalizeResponsesRequest(request);
      expect(result.metadata).toEqual({ key: 'value' });
    });

    it('should accept store field', () => {
      const request = {
        input: 'Hello',
        store: false
      };
      const result = normalizeResponsesRequest(request);
      expect(result.store).toBe(false);
    });

    it('should accept reasoning field', () => {
      const request = {
        input: 'Hello',
        reasoning: { effort: 'high' }
      };
      const result = normalizeResponsesRequest(request);
      expect(result.reasoning).toEqual({ effort: 'high' });
    });
  });

  describe('content normalization', () => {
    it('should accept content as string', () => {
      const content = 'Hello';
      const result = normalizeMessageContent(content);
      expect(result).toEqual([{ type: 'input_text', text: 'Hello' }]);
    });

    it('should accept content as array', () => {
      const content = [{ type: 'input_text', text: 'Hello' }];
      const result = normalizeMessageContent(content);
      expect(result).toEqual([{ type: 'input_text', text: 'Hello' }]);
    });

    it('should accept content as single object', () => {
      const content = { type: 'input_text', text: 'Hello' };
      const result = normalizeMessageContent(content);
      expect(result).toEqual([{ type: 'input_text', text: 'Hello' }]);
    });
  });

  describe('input item types', () => {
    it('should accept message item with explicit type', () => {
      const request = {
        input: [{
          type: 'message',
          role: 'user',
          content: 'Hello'
        }]
      };
      const result = normalizeResponsesRequest(request);
      expect(result.inputItems[0].type).toBe('message');
    });

    it('should accept function_call item', () => {
      const request = {
        input: [{
          type: 'function_call',
          call_id: 'call_123',
          name: 'shell',
          arguments: '{"command": "ls"}'
        }]
      };
      const result = normalizeResponsesRequest(request);
      expect(result.inputItems[0].type).toBe('function_call');
      expect(result.inputItems[0].name).toBe('shell');
    });

    it('should accept function_call_output item', () => {
      const request = {
        input: [{
          type: 'function_call_output',
          call_id: 'call_123',
          output: 'file.txt'
        }]
      };
      const result = normalizeResponsesRequest(request);
      expect(result.inputItems[0].type).toBe('function_call_output');
    });

    it('should serialize object output to JSON string', () => {
      const request = {
        input: [{
          type: 'function_call_output',
          call_id: 'call_123',
          output: { result: 'success' }
        }]
      };
      const result = normalizeResponsesRequest(request);
      expect(typeof result.inputItems[0].output).toBe('string');
      expect(JSON.parse(result.inputItems[0].output)).toEqual({ result: 'success' });
    });

    it('should accept reasoning item', () => {
      const request = {
        input: [{
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'Thinking...' }]
        }]
      };
      const result = normalizeResponsesRequest(request);
      expect(result.inputItems[0].type).toBe('reasoning');
    });
  });

  describe('tool_choice', () => {
    it('should accept string tool_choice', () => {
      const request = {
        input: 'Hello',
        tool_choice: 'auto'
      };
      const result = normalizeResponsesRequest(request);
      expect(result.toolChoice).toBe('auto');
    });

    it('should accept object tool_choice for function', () => {
      const request = {
        input: 'Hello',
        tool_choice: { type: 'function', name: 'shell' }
      };
      const result = normalizeResponsesRequest(request);
      expect(result.toolChoice).toEqual({ type: 'function', name: 'shell' });
    });

    it('should accept allowed_tools object', () => {
      const request = {
        input: 'Hello',
        tool_choice: {
          type: 'allowed_tools',
          mode: 'auto',
          tools: [{ type: 'function', name: 'shell' }]
        }
      };
      const result = normalizeResponsesRequest(request);
      expect(result.toolChoice.type).toBe('allowed_tools');
    });
  });

  describe('tools', () => {
    it('should accept function tools', () => {
      const request = {
        input: 'Hello',
        tools: [{
          type: 'function',
          name: 'test',
          parameters: { type: 'object' }
        }]
      };
      const result = normalizeResponsesRequest(request);
      expect(result.tools).toBeDefined();
      expect(result.tools[0].type).toBe('function');
    });

    it('should accept shell tool', () => {
      const request = {
        input: 'Hello',
        tools: [{
          type: 'shell',
          environment: 'windows'
        }]
      };
      const result = normalizeResponsesRequest(request);
      expect(result.tools).toBeDefined();
      expect(result.tools[0].type).toBe('shell');
    });

    it('should accept tools with strict: false', () => {
      const request = {
        input: 'Hello',
        tools: [{
          type: 'function',
          name: 'test',
          strict: false,
          parameters: { type: 'object' }
        }]
      };
      const result = normalizeResponsesRequest(request);
      expect(result.tools[0].strict).toBe(false);
    });

    it('should accept tools with additionalProperties: false', () => {
      const request = {
        input: 'Hello',
        tools: [{
          type: 'function',
          name: 'test',
          parameters: {
            type: 'object',
            additionalProperties: false
          }
        }]
      };
      const result = normalizeResponsesRequest(request);
      expect(result.tools[0].parameters.additionalProperties).toBe(false);
    });

    it('should silently skip web_search tool (not pass to upstream)', () => {
      const request = {
        input: 'Hello',
        tools: [
          { type: 'web_search' },
          { type: 'function', name: 'test', parameters: { type: 'object' } }
        ]
      };
      const result = normalizeResponsesRequest(request);
      // web_search is skipped, only function tool remains
      expect(result.tools).toBeDefined();
      expect(result.tools.length).toBe(1);
      expect(result.tools[0].type).toBe('function');
    });

    it('should silently skip web_search_preview tool', () => {
      const request = {
        input: 'Hello',
        tools: [{ type: 'web_search_preview' }]
      };
      const result = normalizeResponsesRequest(request);
      // web_search_preview is skipped, no tools remain
      expect(result.tools).toBeNull();
    });
  });

  describe('text.format structured output', () => {
    it('should accept text.format with json_schema', () => {
      const request = {
        input: 'Hello',
        text: {
          format: {
            type: 'json_schema',
            name: 'test',
            schema: { type: 'object' },
            strict: false
          }
        }
      };
      const result = normalizeResponsesRequest(request);
      expect(result.text).toBeDefined();
      expect(result.text.format.type).toBe('json_schema');
    });

    it('should preserve json_schema name and schema', () => {
      const request = {
        input: 'Hello',
        text: {
          format: {
            type: 'json_schema',
            name: 'MySchema',
            schema: { type: 'object', properties: { name: { type: 'string' } } }
          }
        }
      };
      const result = normalizeResponsesRequest(request);
      expect(result.text.format.name).toBe('MySchema');
      expect(result.text.format.schema).toBeDefined();
    });
  });

  describe('rejected fields', () => {
    it('should reject conversation field', () => {
      const request = {
        input: 'Hello',
        conversation: {}
      };
      expect(() => normalizeResponsesRequest(request)).toThrow();
    });

    it('should reject user field', () => {
      const request = {
        input: 'Hello',
        user: 'user_123'
      };
      expect(() => normalizeResponsesRequest(request)).toThrow();
    });
  });
});
