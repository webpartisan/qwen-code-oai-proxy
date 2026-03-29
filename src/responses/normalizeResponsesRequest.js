const config = require('../config.js');
const {
  validationError,
  unsupportedFieldError,
  unsupportedInputTypeError,
  unsupportedToolTypeError,
  missingFieldError,
  conflictingFieldsError
} = require('./responsesErrors.js');

// Fields that are accepted and preserved in canonical form
const ACCEPTED_TOP_LEVEL_FIELDS = [
  'model',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'stream',
  'store',
  'previous_response_id',
  'metadata',
  'temperature',
  'max_output_tokens',
  'top_p',
  'reasoning',
  // Codex compatibility fields - accept but may not pass to upstream
  'parallel_tool_calls',
  'include',
  'prompt_cache_key',
  'text'
];

// Fields that cause rejection (truly unsupported)
const REJECTED_TOP_LEVEL_FIELDS = [
  'conversation',
  'background',
  'include_obfuscation',
  'prompt',
  'audio',
  'truncation',
  'max_tool_calls',
  'service_tier',
  'safety_identifier',
  'previous_item_id',
  'user'
];

const SUPPORTED_ROLES = ['user', 'assistant', 'system', 'developer'];

// Web search tool types that are rejected by policy
const REJECTED_TOOL_TYPES = [
  'web_search',
  'web_search_preview',
  'web_search_2025_08_26'
];

/**
 * Main entry point - normalize incoming /v1/responses request
 */
function normalizeResponsesRequest(request) {
  if (!request || typeof request !== 'object') {
    throw validationError('Request body must be an object');
  }

  // Check for conflicting fields
  if (request.conversation && request.previous_response_id) {
    throw conflictingFieldsError('conversation', 'previous_response_id');
  }

  // Reject truly unsupported fields
  for (const field of REJECTED_TOP_LEVEL_FIELDS) {
    if (field in request && request[field] !== undefined) {
      throw unsupportedFieldError(field);
    }
  }

  // Build canonical request
  const canonical = {
    model: request.model || config.defaultModel,
    inputItems: normalizeInput(request.input ?? []),
    instructions: request.instructions ?? null,
    tools: request.tools ? normalizeTools(request.tools) : null,
    toolChoice: request.tool_choice !== undefined ? normalizeToolChoice(request.tool_choice) : null,
    stream: Boolean(request.stream),
    store: request.store !== undefined ? Boolean(request.store) : true,
    previousResponseId: request.previous_response_id ?? null,
    metadata: request.metadata ?? null,
    temperature: request.temperature ?? null,
    maxOutputTokens: request.max_output_tokens ?? null,
    topP: request.top_p ?? null,
    reasoning: request.reasoning ?? null,
    // Codex compatibility fields - preserved but may not be used
    parallelToolCalls: request.parallel_tool_calls ?? null,
    include: request.include ?? null,
    promptCacheKey: request.prompt_cache_key ?? null,
    text: request.text ? normalizeTextConfig(request.text) : null,
    // Keep raw for debugging
    raw: request
  };

  // Validate required field
  if (!request.input) {
    throw missingFieldError('input');
  }

  return canonical;
}

/**
 * Normalize input - can be string, array of items, or mixed
 */
function normalizeInput(input) {
  // String input - convert to single message
  if (typeof input === 'string') {
    return [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: input }]
    }];
  }

  if (!Array.isArray(input)) {
    throw validationError('`input` must be a string or an array of input items');
  }

  return input.map(normalizeInputItem).filter(Boolean);
}

/**
 * Normalize a single input item
 */
function normalizeInputItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const itemType = item.type;

  // Handle explicit message type
  if (itemType === 'message') {
    const role = item.role || 'user';
    if (!SUPPORTED_ROLES.includes(role)) {
      return null;
    }
    return {
      type: 'message',
      role: role,
      content: normalizeMessageContent(item.content)
    };
  }

  // Handle function_call item
  if (itemType === 'function_call') {
    return {
      type: 'function_call',
      call_id: item.call_id ?? item.id ?? null,
      name: item.name ?? '',
      arguments: typeof item.arguments === 'string' 
        ? item.arguments 
        : JSON.stringify(item.arguments ?? {}),
      status: item.status ?? null
    };
  }

  // Handle function_call_output item
  if (itemType === 'function_call_output') {
    return {
      type: 'function_call_output',
      call_id: item.call_id ?? '',
      output: typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output ?? null),
      status: item.status ?? null
    };
  }

  // Handle reasoning item
  if (itemType === 'reasoning') {
    return {
      type: 'reasoning',
      content: normalizeReasoningContent(item.content),
      summary: normalizeReasoningSummary(item.summary)
    };
  }

  // Backward compatibility: item with role but no explicit type
  if (item.role && SUPPORTED_ROLES.includes(item.role)) {
    return {
      type: 'message',
      role: item.role,
      content: normalizeMessageContent(item.content)
    };
  }

  // Unknown item type - skip silently for compatibility
  return null;
}

/**
 * Normalize message content - handles string, object, or array
 */
function normalizeMessageContent(content) {
  // String content
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }];
  }

  // Single object content - wrap in array
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return [normalizeContentPart(content)];
  }

  // Array of content parts
  if (Array.isArray(content)) {
    return content.map(normalizeContentPart).filter(Boolean);
  }

  // Null/undefined - empty array
  if (content == null) {
    return [];
  }

  throw validationError('`message.content` must be a string, object, or array');
}

/**
 * Normalize a single content part
 */
function normalizeContentPart(part) {
  if (!part || typeof part !== 'object') {
    return null;
  }

  const partType = part.type;

  // Text types
  if (partType === 'text' || partType === 'input_text') {
    return {
      type: 'input_text',
      text: part.text ?? ''
    };
  }

  // Image types - preserve for compatibility
  if (partType === 'image_url' || partType === 'input_image') {
    return {
      type: 'input_image',
      image_url: part.image_url ?? part.url ?? null,
      file_id: part.file_id ?? null,
      detail: part.detail ?? null
    };
  }

  // File types
  if (partType === 'input_file') {
    return {
      type: 'input_file',
      file_id: part.file_id ?? null,
      file_url: part.file_url ?? null,
      file_data: part.file_data ?? null,
      filename: part.filename ?? null
    };
  }

  // Reasoning text within content
  if (partType === 'reasoning_text') {
    return {
      type: 'input_text',
      text: part.text ?? ''
    };
  }

  // Unknown content type - return as-is for compatibility
  return { ...part };
}

/**
 * Normalize reasoning content array
 */
function normalizeReasoningContent(content) {
  if (!content || !Array.isArray(content)) {
    return null;
  }
  
  return content.map(part => {
    if (part.type === 'reasoning_text') {
      return { type: 'reasoning_text', text: part.text ?? '' };
    }
    return { ...part };
  });
}

/**
 * Normalize reasoning summary array
 */
function normalizeReasoningSummary(summary) {
  if (!summary || !Array.isArray(summary)) {
    return null;
  }
  
  return summary.map(part => {
    if (part.type === 'summary_text') {
      return { type: 'summary_text', text: part.text ?? '' };
    }
    return { ...part };
  });
}

/**
 * Normalize tools array - permissive for Codex compatibility
 */
function normalizeTools(tools) {
  if (!Array.isArray(tools)) {
    return null;
  }

  const normalized = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }

    const toolType = tool.type;

    // Skip web_search tools silently (don't break Codex)
    if (REJECTED_TOOL_TYPES.includes(toolType)) {
      // Silently skip - don't pass to upstream, don't error
      continue;
    }

    // Function tool
    if (toolType === 'function') {
      normalized.push({
        type: 'function',
        name: tool.name ?? '',
        description: tool.description ?? null,
        parameters: tool.parameters ?? null,
        strict: tool.strict ?? null
      });
      continue;
    }

    // Shell tool
    if (toolType === 'shell') {
      normalized.push({
        type: 'shell',
        ...tool
      });
      continue;
    }

    // Local shell tool
    if (toolType === 'local_shell') {
      normalized.push({
        type: 'local_shell',
        ...tool
      });
      continue;
    }

    // Custom tool
    if (toolType === 'custom') {
      normalized.push({
        type: 'custom',
        name: tool.name ?? '',
        ...tool
      });
      continue;
    }

    // MCP tool
    if (toolType === 'mcp') {
      normalized.push({
        type: 'mcp',
        server_label: tool.server_label ?? '',
        ...tool
      });
      continue;
    }

    // Unknown tool type - preserve for compatibility
    normalized.push({ ...tool });
  }

  return normalized.length > 0 ? normalized : null;
}

/**
 * Normalize tool_choice - supports string and object forms
 */
function normalizeToolChoice(toolChoice) {
  if (toolChoice == null) {
    return null;
  }

  // String form: 'auto', 'none', 'required'
  if (typeof toolChoice === 'string') {
    return toolChoice;
  }

  // Object form
  if (typeof toolChoice === 'object') {
    const type = toolChoice.type;

    // Specific function
    if (type === 'function') {
      return {
        type: 'function',
        name: toolChoice.name ?? ''
      };
    }

    // Custom tool
    if (type === 'custom') {
      return {
        type: 'custom',
        name: toolChoice.name ?? ''
      };
    }

    // MCP tool
    if (type === 'mcp') {
      return {
        type: 'mcp',
        server_label: toolChoice.server_label ?? '',
        name: toolChoice.name ?? null
      };
    }

    // Allowed tools constraint
    if (type === 'allowed_tools') {
      return {
        type: 'allowed_tools',
        mode: toolChoice.mode ?? 'auto',
        tools: Array.isArray(toolChoice.tools) 
          ? toolChoice.tools.map(t => ({
              type: t.type ?? 'function',
              name: t.name ?? null,
              server_label: t.server_label ?? null
            }))
          : []
      };
    }

    // Unknown object form - preserve
    return { ...toolChoice };
  }

  return null;
}

/**
 * Normalize text.format config for structured outputs
 */
function normalizeTextConfig(text) {
  if (!text || typeof text !== 'object') {
    return null;
  }

  const result = { ...text };

  if (text.format && typeof text.format === 'object') {
    result.format = { ...text.format };
  }

  return result;
}

module.exports = {
  normalizeResponsesRequest,
  normalizeInput,
  normalizeInputItem,
  normalizeMessageContent,
  normalizeContentPart,
  normalizeTools,
  normalizeToolChoice,
  normalizeTextConfig,
  normalizeReasoningContent,
  normalizeReasoningSummary,
  ACCEPTED_TOP_LEVEL_FIELDS,
  REJECTED_TOP_LEVEL_FIELDS,
  SUPPORTED_ROLES,
  REJECTED_TOOL_TYPES
};
