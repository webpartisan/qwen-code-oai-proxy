const { createResponseId, createMessageId, createFunctionCallId } = require('./responseId.js');

function streamChatToResponsesSse({
  upstreamStream,
  res,
  normalizedRequest,
  previousResponseId,
  idFactory = {},
  onCompleted,
  onFailed
}) {
  const responseId = idFactory.responseId || createResponseId();
  const messageId = idFactory.messageId || createMessageId();
  const createdAt = Math.floor(Date.now() / 1000);
  const outputIndex = 0;
  const contentIndex = 0;

  let outputText = '';
  let sequenceNumber = 0;
  let upstreamBuffer = '';
  let finished = false;
  let messageStarted = false;
  const toolCalls = [];

  const responseBase = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    error: null,
    incomplete_details: null,
    instructions: normalizedRequest.instructions ?? null,
    max_output_tokens: normalizedRequest.maxOutputTokens ?? null,
    model: normalizedRequest.model,
    previous_response_id: previousResponseId || null,
    reasoning: normalizedRequest.reasoning ?? null,
    store: normalizedRequest.store !== false,
    temperature: normalizedRequest.temperature ?? null,
    text: normalizedRequest.text || { format: { type: 'text' } },
    tool_choice: normalizedRequest.toolChoice ?? 'auto',
    tools: normalizedRequest.tools || [],
    top_p: normalizedRequest.topP ?? null,
    metadata: normalizedRequest.metadata || {},
    parallel_tool_calls: Boolean(normalizedRequest.parallelToolCalls),
    usage: null,
    user: null
  };

  function nextSeq() {
    sequenceNumber += 1;
    return sequenceNumber;
  }

  function writeSse(eventName, payload) {
    if (res.writableEnded || res.destroyed) {
      return false;
    }

    const body = {
      type: eventName,
      ...payload,
      sequence_number: nextSeq()
    };

    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(body)}\n\n`);

    if (typeof res.flush === 'function') {
      res.flush();
    }

    return true;
  }

  function writeDone() {
    if (res.writableEnded || res.destroyed) {
      return false;
    }

    res.write('data: [DONE]\n\n');

    if (typeof res.flush === 'function') {
      res.flush();
    }

    return true;
  }

  function messageInProgress() {
    return {
      id: messageId,
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: []
    };
  }

  function messageCompleted() {
    return {
      id: messageId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: outputText,
          annotations: []
        }
      ]
    };
  }

  function emitInitialEvents() {
    writeSse('response.created', {
      response: {
        ...responseBase,
        status: 'in_progress',
        completed_at: null,
        output: []
      }
    });

    writeSse('response.in_progress', {
      response: {
        ...responseBase,
        status: 'in_progress',
        completed_at: null,
        output: []
      }
    });
  }

  function emitTextDelta(delta) {
    if (!delta) return;

    if (!messageStarted) {
      messageStarted = true;
      writeSse('response.output_item.added', {
        output_index: outputIndex,
        item: messageInProgress()
      });

      writeSse('response.content_part.added', {
        item_id: messageId,
        output_index: outputIndex,
        content_index: contentIndex,
        part: {
          type: 'output_text',
          text: '',
          annotations: []
        }
      });
    }

    outputText += delta;
    writeSse('response.output_text.delta', {
      item_id: messageId,
      output_index: outputIndex,
      content_index: contentIndex,
      delta
    });
  }

  function buildCompletedResponseObject() {
    const output = [];
    if (outputText) {
      output.push(messageCompleted());
    }
    output.push(...toolCalls.map((toolCall) => toolCall.item));

    return {
      ...responseBase,
      status: 'completed',
      completed_at: Math.floor(Date.now() / 1000),
      output,
      output_text: outputText
    };
  }

  function emitTerminalEventsAndClose() {
    if (finished) return;
    finished = true;

    if (messageStarted) {
      writeSse('response.output_text.done', {
        item_id: messageId,
        output_index: outputIndex,
        content_index: contentIndex,
        text: outputText
      });

      writeSse('response.content_part.done', {
        item_id: messageId,
        output_index: outputIndex,
        content_index: contentIndex,
        part: {
          type: 'output_text',
          text: outputText,
          annotations: []
        }
      });

      writeSse('response.output_item.done', {
        output_index: outputIndex,
        item: messageCompleted()
      });
    }

    toolCalls.forEach((toolCall, index) => {
      const toolOutputIndex = messageStarted ? index + 1 : index;
      if (!toolCall.added) {
        writeSse('response.output_item.added', {
          output_index: toolOutputIndex,
          item: toolCall.itemInProgress
        });
      }
      writeSse('response.function_call_arguments.done', {
        item_id: toolCall.item.id,
        output_index: toolOutputIndex,
        arguments: toolCall.item.arguments,
        name: toolCall.item.name
      });
      writeSse('response.output_item.done', {
        output_index: toolOutputIndex,
        item: toolCall.item
      });
    });

    const responseObject = buildCompletedResponseObject();

    writeSse('response.completed', {
      response: responseObject
    });

    if (typeof res.flush === 'function') {
      res.flush();
    }

    if (typeof onCompleted === 'function') {
      onCompleted(responseObject);
    }

    writeDone();
    res.end();
  }

  function emitFailureAndClose(error) {
    if (finished) return;
    finished = true;

    const failedResponse = {
      ...responseBase,
      status: 'failed',
      completed_at: null,
      output: [],
      error: {
        code: 'server_error',
        message: error?.message || 'Streaming failed'
      }
    };

    writeSse('response.failed', {
      response: failedResponse
    });

    if (typeof res.flush === 'function') {
      res.flush();
    }

    if (typeof onFailed === 'function') {
      onFailed(error);
    }

    res.end();
  }

  function extractTextContent(content) {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (!part || typeof part !== 'object') return '';
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
          return '';
        })
        .join('');
    }

    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') return content.text;
      if (typeof content.content === 'string') return content.content;
    }

    return '';
  }

  function extractDeltaText(json) {
    const choice = json?.choices?.[0];
    return (
      extractTextContent(choice?.delta?.content) ||
      extractTextContent(choice?.message?.content)
    );
  }

  function mergeToolCalls(json) {
    const choice = json?.choices?.[0];
    const deltaToolCalls = choice?.delta?.tool_calls;
    const messageToolCalls = choice?.message?.tool_calls;
    const toolCallChunks = Array.isArray(deltaToolCalls)
      ? deltaToolCalls
      : Array.isArray(messageToolCalls)
        ? messageToolCalls
        : null;

    if (!Array.isArray(toolCallChunks)) {
      return;
    }

    for (const deltaToolCall of toolCallChunks) {
      const index = Number.isInteger(deltaToolCall?.index) ? deltaToolCall.index : 0;
      if (!toolCalls[index]) {
        const callId = deltaToolCall?.id || `call_${index}`;
        const itemId = createFunctionCallId();
        toolCalls[index] = {
          added: false,
          itemInProgress: {
            id: itemId,
            type: 'function_call',
            call_id: callId,
            name: '',
            arguments: '',
            status: 'in_progress'
          },
          item: {
            id: itemId,
            type: 'function_call',
            call_id: callId,
            name: '',
            arguments: '',
            status: 'completed'
          }
        };
      }

      const target = toolCalls[index];
      if (deltaToolCall.id) {
        target.item.call_id = deltaToolCall.id;
        target.itemInProgress.call_id = deltaToolCall.id;
      }
      if (deltaToolCall.function?.name) {
        target.item.name += deltaToolCall.function.name;
        target.itemInProgress.name = target.item.name;
      }
      if (!target.added) {
        target.added = true;
        const toolOutputIndex = messageStarted ? index + 1 : index;
        writeSse('response.output_item.added', {
          output_index: toolOutputIndex,
          item: target.itemInProgress
        });
      }
      if (deltaToolCall.function?.arguments) {
        target.item.arguments += deltaToolCall.function.arguments;
        target.itemInProgress.arguments = target.item.arguments;
        const toolOutputIndex = messageStarted ? index + 1 : index;
        writeSse('response.function_call_arguments.delta', {
          item_id: target.item.id,
          output_index: toolOutputIndex,
          delta: deltaToolCall.function.arguments
        });
      }
    }
  }

  function handleUpstreamSseEvent(rawEvent) {
    const lines = rawEvent.split(/\r?\n/);
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) {
      return;
    }

    const data = dataLines.join('\n');

    if (data === '[DONE]') {
      emitTerminalEventsAndClose();
      return;
    }

    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }

    const deltaText = extractDeltaText(json);
    if (deltaText) {
      emitTextDelta(deltaText);
    }

    mergeToolCalls(json);

    const finishReason = json?.choices?.[0]?.finish_reason;
    if (finishReason === 'stop' || finishReason === 'tool_calls') {
      emitTerminalEventsAndClose();
    }
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  emitInitialEvents();

  upstreamStream.on('data', (chunk) => {
    if (finished) return;

    upstreamBuffer += chunk.toString('utf8');

    while (true) {
      const match = upstreamBuffer.match(/\r?\n\r?\n/);
      if (!match || match.index == null) {
        break;
      }

      const boundaryIndex = match.index;
      const boundaryLength = match[0].length;
      const rawEvent = upstreamBuffer.slice(0, boundaryIndex);
      upstreamBuffer = upstreamBuffer.slice(boundaryIndex + boundaryLength);

      if (rawEvent.trim()) {
        handleUpstreamSseEvent(rawEvent);
      }
    }
  });

  upstreamStream.on('end', () => {
    emitTerminalEventsAndClose();
  });

  upstreamStream.on('error', (error) => {
    emitFailureAndClose(error);
  });
}

module.exports = {
  streamChatToResponsesSse
};
