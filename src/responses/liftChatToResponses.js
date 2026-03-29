const { createResponseId, createMessageId, createFunctionCallId, createCallId } = require('./responseId.js');

function liftChatToResponses({
  normalizedRequest,
  previousResponseId,
  upstreamResponse,
  generatedIds = {}
}) {
  const responseId = generatedIds.responseId || createResponseId();
  const createdAt = Math.floor(Date.now() / 1000);
  
  const outputItems = [];
  let outputText = '';
  
  const choices = upstreamResponse.choices || [];
  
  for (const choice of choices) {
    const message = choice.message;
    
    if (!message) continue;
    
    if (message.content) {
      const messageId = createMessageId();
      
      outputItems.push({
        id: messageId,
        type: 'message',
        role: 'assistant',
        status: choice.finish_reason === 'stop' ? 'completed' : 'incomplete',
        content: [
          {
            type: 'output_text',
            text: message.content,
            annotations: []
          }
        ]
      });
      
      outputText += message.content;
    }
    
    if (message.tool_calls && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const functionCallId = createFunctionCallId();
        const callId = createCallId();
        
        outputItems.push({
          id: functionCallId,
          type: 'function_call',
          call_id: callId,
          name: toolCall.function?.name || '',
          arguments: toolCall.function?.arguments || '',
          status: 'completed'
        });
      }
    }
  }
  
  const usage = upstreamResponse.usage || {};
  
  const responseObject = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: outputItems.length > 0 ? 'completed' : 'incomplete',
    error: null,
    incomplete_details: null,
    instructions: normalizedRequest.instructions,
    max_output_tokens: normalizedRequest.maxOutputTokens,
    model: upstreamResponse.model || normalizedRequest.model,
    output: outputItems,
    parallel_tool_calls: false,
    previous_response_id: previousResponseId || null,
    reasoning: normalizedRequest.reasoning,
    store: normalizedRequest.store !== false,
    temperature: normalizedRequest.temperature,
    text: {
      format: {
        type: 'text'
      }
    },
    tool_choice: normalizedRequest.toolChoice,
    tools: normalizedRequest.tools || [],
    top_p: normalizedRequest.topP,
    metadata: normalizedRequest.metadata || null,
    usage: {
      input_tokens: usage.prompt_tokens || null,
      input_tokens_details: null,
      output_tokens: usage.completion_tokens || null,
      output_tokens_details: null,
      total_tokens: usage.total_tokens || null
    },
    user: null,
    output_text: outputText
  };
  
  return {
    responseObject,
    outputItems,
    outputText
  };
}

module.exports = {
  liftChatToResponses
};
