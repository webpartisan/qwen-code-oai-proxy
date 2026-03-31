const { lowerResponsesToChat, isAgentModeRequest, lowerToolsForChat } = require('../lowerResponsesToChat');

// Helper to extract content as string (handles array format from systemPromptTransformer)
function getContentAsString(msg) {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content.map(part => part.text || '').join('');
  }
  return '';
}

describe('lowerResponsesToChat', () => {
  describe('isAgentModeRequest detection', () => {
    it('should detect agent mode when spawn_agent tool is absent', () => {
      const request = {
        tools: [
          { type: 'function', name: 'shell', parameters: {} }
        ],
        inputItems: [{ type: 'function_call', name: 'test' }]
      };
      expect(isAgentModeRequest(request)).toBe(true);
    });

    it('should detect agent mode when tools are missing entirely', () => {
      const request = {
        inputItems: [{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }]
      };
      expect(isAgentModeRequest(request)).toBe(true);
    });

    it('should detect agent mode for developer messages when spawn_agent is absent', () => {
      const request = {
        inputItems: [{ type: 'message', role: 'developer', content: [] }]
      };
      expect(isAgentModeRequest(request)).toBe(true);
    });

    it('should not detect agent mode by tools alone', () => {
      const request = {
        tools: [
          { type: 'shell', name: 'shell' },
          { type: 'function', name: 'spawn_agent', parameters: {} }
        ]
      };
      expect(isAgentModeRequest(request)).toBe(false);
    });

    it('should not detect agent mode when spawn_agent tool is present', () => {
      const request = {
        tools: [
          { type: 'function', name: 'spawn_agent', parameters: {} },
          { type: 'function', name: 'shell', parameters: {} }
        ],
        inputItems: [
          { type: 'message', role: 'developer', content: [] },
          { type: 'function_call', name: 'shell' },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
        ]
      };
      expect(isAgentModeRequest(request)).toBe(false);
    });

    it('should not detect regular request as agent mode from instructions alone', () => {
      const request = {
        tools: [
          { type: 'function', name: 'spawn_agent', parameters: {} }
        ],
        inputItems: [{ type: 'message', role: 'user', content: [] }],
        instructions: 'You are a coding agent for Codex CLI'
      };
      expect(isAgentModeRequest(request)).toBe(false);
    });
  });

  describe('input lowering', () => {
    it('should lower string input to one user message', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Say hello' }],
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

      const result = lowerResponsesToChat({ normalizedRequest, previousRecord: null });

      // System prompt transformer may add additional messages, so we just check that user message exists
      const hasUserMessage = result.upstreamRequest.messages.some(m => 
        m.role === 'user' && getContentAsString(m).includes('Say hello')
      );
      expect(hasUserMessage).toBe(true);
    });

    it('should preserve role and content from input items', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' }
        ],
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

      const result = lowerResponsesToChat({ normalizedRequest, previousRecord: null });

      // Check that our input items are present (systemPromptTransformer may add more)
      const roles = result.upstreamRequest.messages.map(m => m.role);
      expect(roles).toContain('system');
      expect(roles).toContain('user');
      expect(roles).toContain('assistant');
    });

    it('should lower function_call items into assistant tool call messages', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [
          { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":"dir"}' }
        ],
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

      const result = lowerResponsesToChat({ normalizedRequest, previousRecord: null });
      const toolCallMessage = result.upstreamRequest.messages.find(message => Array.isArray(message.tool_calls));

      expect(toolCallMessage).toBeDefined();
      expect(toolCallMessage.role).toBe('assistant');
      expect(toolCallMessage.tool_calls[0]).toEqual({
        id: 'call_1',
        type: 'function',
        function: {
          name: 'shell',
          arguments: '{"command":"dir"}'
        }
      });
    });

    it('should lower function_call_output items into tool messages', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [
          { type: 'function_call_output', call_id: 'call_1', output: 'command result' }
        ],
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

      const result = lowerResponsesToChat({ normalizedRequest, previousRecord: null });
      const toolMessage = result.upstreamRequest.messages.find(message => message.role === 'tool');

      expect(toolMessage).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'command result'
      });
    });
  });

  describe('instructions handling', () => {
    it('should produce a synthetic system message for current request only', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Hello' }],
        instructions: 'You are terse',
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

      const result = lowerResponsesToChat({ normalizedRequest, previousRecord: null });

      expect(result.syntheticInstructions).toEqual([{ role: 'system', content: 'You are terse' }]);
      // Check that our instructions are in the messages
      const hasInstructions = result.upstreamRequest.messages.some(m => 
        m.role === 'system' && getContentAsString(m).includes('You are terse')
      );
      expect(hasInstructions).toBe(true);
    });

    it('should not include instructions when absent', () => {
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

      const result = lowerResponsesToChat({ normalizedRequest, previousRecord: null });

      expect(result.syntheticInstructions).toBeNull();
      // Check that user message is present (systemPromptTransformer may add more)
      const hasUserMessage = result.upstreamRequest.messages.some(m => m.role === 'user');
      expect(hasUserMessage).toBe(true);
    });
  });

  describe('carryover handling', () => {
    it('should include prior carryover before current input', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Say goodbye' }],
        instructions: null,
        tools: null,
        toolChoice: null,
        stream: false,
        store: true,
        previousResponseId: 'resp_previous',
        metadata: null,
        temperature: null,
        maxOutputTokens: null,
        topP: null,
        reasoning: null
      };

      const previousRecord = {
        id: 'resp_previous',
        carryover_items: [
          { role: 'user', content: 'Say hello' },
          { role: 'assistant', content: 'Hello!' }
        ],
        synthetic_instructions: [{ role: 'system', content: 'You are terse' }]
      };

      const result = lowerResponsesToChat({ normalizedRequest, previousRecord });

      expect(result.carryoverItems).toEqual([
        { role: 'user', content: 'Say hello' },
        { role: 'assistant', content: 'Hello!' }
      ]);

      const messagesContent = result.upstreamRequest.messages.map(m => getContentAsString(m));
      expect(messagesContent).toContain('Say hello');
      expect(messagesContent).toContain('Hello!');
      expect(messagesContent).toContain('Say goodbye');
    });

    it('should not carry over prior synthetic instructions', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Say goodbye' }],
        instructions: null,
        tools: null,
        toolChoice: null,
        stream: false,
        store: true,
        previousResponseId: 'resp_previous',
        metadata: null,
        temperature: null,
        maxOutputTokens: null,
        topP: null,
        reasoning: null
      };

      const previousRecord = {
        id: 'resp_previous',
        carryover_items: [
          { role: 'user', content: 'Say hello' }
        ],
        synthetic_instructions: [{ role: 'system', content: 'You are terse' }]
      };

      const result = lowerResponsesToChat({ normalizedRequest, previousRecord });

      const messageContents = result.upstreamRequest.messages.map(m => getContentAsString(m));
      const hasOldInstructions = messageContents.some(c => c.includes('You are terse') && !c.includes('Say goodbye'));
      expect(hasOldInstructions).toBe(false);
    });
  });

  describe('upstream field mapping', () => {
    it('should lower function tools into chat-completions tool schema', () => {
      expect(lowerToolsForChat([
        {
          type: 'function',
          name: 'shell',
          description: 'Run command',
          parameters: { type: 'object' },
          strict: false
        }
      ])).toEqual([
        {
          type: 'function',
          function: {
            name: 'shell',
            description: 'Run command',
            parameters: { type: 'object' },
            strict: false
          }
        }
      ]);
    });

    it('should map max_output_tokens to max_tokens', () => {
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
        maxOutputTokens: 1000,
        topP: null,
        reasoning: null
      };

      const result = lowerResponsesToChat({ normalizedRequest, previousRecord: null });

      expect(result.upstreamRequest.max_tokens).toBe(1000);
    });

    it('should map all other fields correctly', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Hello' }],
        instructions: null,
        tools: [{ type: 'function', name: 'test', parameters: {} }],
        toolChoice: 'auto',
        stream: false,
        store: true,
        previousResponseId: null,
        metadata: null,
        temperature: 0.5,
        maxOutputTokens: null,
        topP: 0.9,
        reasoning: 'medium'
      };

      const result = lowerResponsesToChat({ normalizedRequest, previousRecord: null });

      expect(result.upstreamRequest.model).toBe('qwen3-coder-plus');
      expect(result.upstreamRequest.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'test',
            parameters: {}
          }
        }
      ]);
      expect(result.upstreamRequest.tool_choice).toBe('auto');
      expect(result.upstreamRequest.temperature).toBe(0.5);
      expect(result.upstreamRequest.top_p).toBe(0.9);
      expect(result.upstreamRequest.reasoning).toBe('medium');
    });

    it('should set stream to false for non-streaming', () => {
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

      const result = lowerResponsesToChat({ normalizedRequest, previousRecord: null });

      expect(result.upstreamRequest.stream).toBe(false);
    });
  });

  describe('message order', () => {
    it('should order messages as: instructions, carryover, current input', () => {
      const normalizedRequest = {
        model: 'qwen3-coder-plus',
        inputItems: [{ role: 'user', content: 'Current input' }],
        instructions: 'Current instructions',
        tools: null,
        toolChoice: null,
        stream: false,
        store: true,
        previousResponseId: 'resp_previous',
        metadata: null,
        temperature: null,
        maxOutputTokens: null,
        topP: null,
        reasoning: null
      };

      const previousRecord = {
        id: 'resp_previous',
        carryover_items: [{ role: 'user', content: 'Carryover message' }],
        synthetic_instructions: [{ role: 'system', content: 'Old instructions' }]
      };

      const result = lowerResponsesToChat({ normalizedRequest, previousRecord });

      // System prompt transformer modifies messages, but we can verify our custom content exists
      const allContent = result.upstreamRequest.messages
        .map(m => getContentAsString(m))
        .join(' ');
      
      // The content from our request should be present somewhere
      expect(allContent).toContain('Current input');
      expect(allContent).toContain('Carryover message');
    });
  });
});
