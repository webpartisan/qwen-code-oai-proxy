const { systemPromptTransformer } = require('../utils/systemPromptTransformer.js');
const config = require('../config.js');

/**
 * Detect Codex-like requests based on observed request shape signals.
 * 
 * Signals used (in priority order):
 * 1. Presence of agent-style tools (shell, local_shell, function tools with shell-like names)
 * 2. Presence of function_call or function_call_output items
 * 3. Presence of developer-role messages
 * 4. Presence of instructions field (common in Codex)
 * 5. Explicit Codex markers in instructions (weak signal)
 * 
 * @param {object} normalizedRequest - The normalized responses request
 * @returns {boolean} - True if this appears to be a Codex-like request
 */
function isCodexLikeRequest(normalizedRequest) {
  if (!normalizedRequest) return false;
  
  // Signal 1: Check for agent-style tools
  if (normalizedRequest.tools && Array.isArray(normalizedRequest.tools)) {
    const agentToolTypes = ['shell', 'local_shell', 'custom'];
    const hasAgentTool = normalizedRequest.tools.some(t => 
      agentToolTypes.includes(t.type) ||
      (t.type === 'function' && t.name && ['shell', 'bash', 'execute'].includes(t.name.toLowerCase()))
    );
    if (hasAgentTool) return true;
  }
  
  // Signal 2: Check for function_call / function_call_output items
  if (normalizedRequest.inputItems && Array.isArray(normalizedRequest.inputItems)) {
    const hasFunctionLoop = normalizedRequest.inputItems.some(item =>
      item.type === 'function_call' || item.type === 'function_call_output'
    );
    if (hasFunctionLoop) return true;
  }
  
  // Signal 3: Check for developer-role messages
  if (normalizedRequest.inputItems && Array.isArray(normalizedRequest.inputItems)) {
    const hasDeveloperMessage = normalizedRequest.inputItems.some(item =>
      item.type === 'message' && item.role === 'developer'
    );
    if (hasDeveloperMessage) return true;
  }
  
  // Signal 4: Presence of instructions field (common but not definitive)
  // Combined with other weak signals
  if (normalizedRequest.instructions) {
    // Signal 5: Weak Codex markers in instructions
    const codexMarkers = [
      'Codex CLI',
      'coding agent',
      'terminal-based coding assistant',
      'sandbox',
      'escalation',
      'prefix_rule',
      'writable_roots'
    ];
    const hasCodexMarker = codexMarkers.some(marker => 
      normalizedRequest.instructions.includes(marker)
    );
    if (hasCodexMarker) return true;
  }
  
  return false;
}

// Map common model aliases to actual Qwen models
function resolveModel(requestedModel) {
  if (!requestedModel) {
    return config.defaultModel || 'qwen3-coder-plus';
  }
  
  const model = requestedModel.toLowerCase();
  
  // Codex aliases
  if (model === 'qwen-coder' || model === 'coder') {
    return 'qwen3-coder-plus';
  }
  
  // Pass through unknown models - let upstream handle
  return requestedModel;
}

function lowerToolsForChat(tools) {
  if (!Array.isArray(tools)) {
    return tools;
  }

  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') {
      return tool;
    }

    if (tool.type === 'function') {
      return {
        type: 'function',
        function: {
          name: tool.name || '',
          ...(tool.description != null && { description: tool.description }),
          ...(tool.parameters != null && { parameters: tool.parameters }),
          ...(tool.strict != null && { strict: tool.strict })
        }
      };
    }

    return tool;
  });
}

function lowerResponsesToChat({ normalizedRequest, previousRecord }) {
  const model = resolveModel(normalizedRequest.model);
  
  // Detect Codex-like requests to apply appropriate prompt policy
  const isCodexLike = isCodexLikeRequest(normalizedRequest);
  
  const instructionMessages = buildInstructionMessages(normalizedRequest.instructions);
  const carryoverMessages = buildCarryoverMessages(previousRecord);
  const currentInputMessages = buildCurrentInputMessages(normalizedRequest.inputItems);

  let allMessages = [
    ...instructionMessages,
    ...carryoverMessages,
    ...currentInputMessages
  ];

  // Apply system prompt transformer ONLY for non-Codex requests
  // Codex sends its own comprehensive instructions via 'instructions' and developer messages
  if (!isCodexLike) {
    allMessages = systemPromptTransformer.transform(
      allMessages,
      model
    );
  }

  // Convert message content from array format back to simple string for Chat Completions
  // Also convert 'developer' role to 'system' (Qwen API doesn't support 'developer')
  allMessages = allMessages.map(msg => {
    if (msg.content && Array.isArray(msg.content)) {
      const textContent = msg.content
        .filter(part => part.type === 'text' || part.type === 'input_text')
        .map(part => part.text)
        .join('');
      return { ...msg, content: textContent, role: msg.role === 'developer' ? 'system' : msg.role };
    }
    return { ...msg, role: msg.role === 'developer' ? 'system' : msg.role };
  });

  const upstreamRequest = {
    model: model,
    messages: allMessages,
    // Only include tools if they exist
    ...(normalizedRequest.tools && { tools: lowerToolsForChat(normalizedRequest.tools) }),
    // Don't pass tool_choice object to upstream - Qwen API doesn't support it
    // Only pass string values: 'auto', 'none', 'required'
    ...(typeof normalizedRequest.toolChoice === 'string' && { tool_choice: normalizedRequest.toolChoice }),
    ...(normalizedRequest.temperature !== null && { temperature: normalizedRequest.temperature }),
    ...(normalizedRequest.maxOutputTokens !== null && { max_tokens: normalizedRequest.maxOutputTokens }),
    ...(normalizedRequest.topP !== null && { top_p: normalizedRequest.topP || normalizedRequest.top_p }),
    ...(normalizedRequest.reasoning && { reasoning: normalizedRequest.reasoning }),
    // Always include stream (false by default)
    stream: normalizedRequest.stream || false
  };

  // Remove null/undefined fields
  Object.keys(upstreamRequest).forEach(key => {
    if (upstreamRequest[key] === null || upstreamRequest[key] === undefined) {
      delete upstreamRequest[key];
    }
  });

  return {
    upstreamRequest,
    normalizedInputItems: normalizedRequest.inputItems,
    syntheticInstructions: normalizedRequest.instructions 
      ? [{ role: 'system', content: normalizedRequest.instructions }]
      : null,
    carryoverItems: carryoverMessages
  };
}

function buildToolCallFromFunctionItem(item, fallbackIndex = 0) {
  return {
    id: item.call_id || item.id || `call_${fallbackIndex}`,
    type: 'function',
    function: {
      name: item.name || '',
      arguments: item.arguments || '{}'
    }
  };
}

function buildInstructionMessages(instructions) {
  if (!instructions) {
    return [];
  }
  return [{ role: 'system', content: instructions }];
}

function buildCarryoverMessages(previousRecord) {
  if (!previousRecord || !previousRecord.carryover_items) {
    return [];
  }
  return previousRecord.carryover_items;
}

function buildCurrentInputMessages(inputItems) {
  if (!inputItems || !Array.isArray(inputItems)) {
    return [];
  }
  
  const messages = [];
  
  for (const item of inputItems) {
    // Handle message items
    if (item.type === 'message') {
      const content = normalizeItemContent(item.content);
      messages.push({
        role: item.role,
        content: content
      });
      continue;
    }

    // Preserve tool loop state for agent-style Responses clients.
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [buildToolCallFromFunctionItem(item, messages.length)]
      });
      continue;
    }

    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || '',
        content: item.output || ''
      });
      continue;
    }

    if (item.type === 'reasoning') {
      continue;
    }
    
    // Backward compatibility: item with role but no explicit type
    if (item.role && ['user', 'assistant', 'system', 'developer'].includes(item.role)) {
      const content = normalizeItemContent(item.content);
      messages.push({
        role: item.role,
        content: content
      });
    }
  }
  
  return messages;
}

function normalizeItemContent(content) {
  if (!content) {
    return '';
  }
  
  // String content
  if (typeof content === 'string') {
    return content;
  }
  
  // Array of content parts
  if (Array.isArray(content)) {
    const textParts = content
      .filter(part => part && (part.type === 'text' || part.type === 'input_text'))
      .map(part => part.text || '');
    return textParts.join('');
  }
  
  // Object content
  if (typeof content === 'object') {
    return content.text || '';
  }
  
  return '';
}

module.exports = {
  lowerResponsesToChat,
  isCodexLikeRequest,
  buildInstructionMessages,
  buildCarryoverMessages,
  buildCurrentInputMessages,
  lowerToolsForChat
};
