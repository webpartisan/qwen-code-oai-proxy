const { PassThrough } = require('stream');

function collectSsePayloads(chunks) {
  const text = chunks.join('');
  const rawEvents = text.split(/\n\n/).filter(Boolean);
  const parsed = [];

  for (const rawEvent of rawEvents) {
    const lines = rawEvent.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event: '));
    const dataLine = lines.find((line) => line.startsWith('data: '));

    if (!eventLine || !dataLine) continue;

    parsed.push({
      event: eventLine.slice('event: '.length),
      data: JSON.parse(dataLine.slice('data: '.length))
    });
  }

  return parsed;
}

describe('streamChatToResponsesSse', () => {
  function createMockRes() {
    const chunks = [];
    return {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      _headers: {},
      _chunks: chunks,
      setHeader(key, value) {
        this._headers[key] = value;
      },
      flushHeaders: jest.fn(),
      flush: jest.fn(),
      write: jest.fn((data) => {
        chunks.push(String(data));
        this.headersSent = true;
        return true;
      }),
      end: jest.fn(function end() {
        this.writableEnded = true;
      })
    };
  }

  function normalizedRequest() {
    return {
      model: 'qwen3-coder-plus',
      instructions: null,
      maxOutputTokens: null,
      reasoning: null,
      store: true,
      temperature: null,
      toolChoice: null,
      tools: [],
      topP: null,
      metadata: null,
      parallelToolCalls: null,
      text: { format: { type: 'text' } }
    };
  }

  it('emits canonical Responses SSE event shapes and closes after response.completed', (done) => {
    jest.resetModules();
    const { streamChatToResponsesSse } = require('../streamChatToResponsesSse');

    const upstream = new PassThrough();
    const res = createMockRes();

    streamChatToResponsesSse({
      upstreamStream: upstream,
      res,
      normalizedRequest: normalizedRequest(),
      previousResponseId: null
    });

    upstream.write('data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n');
    upstream.write('data: {"choices":[{"delta":{"content":" world"},"index":0,"finish_reason":"stop"}]}\n\n');

    setTimeout(() => {
      const events = collectSsePayloads(res._chunks);
      const names = events.map((e) => e.event);

      expect(names).toEqual([
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.delta',
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.completed'
      ]);

      for (let i = 0; i < events.length; i += 1) {
        expect(events[i].data.type).toBe(events[i].event);
        expect(events[i].data.sequence_number).toBe(i + 1);
      }

      const outputItemAdded = events.find((e) => e.event === 'response.output_item.added');
      expect(outputItemAdded.data.output_index).toBe(0);
      expect(outputItemAdded.data.item.id).toMatch(/^msg_/);
      expect(outputItemAdded.data.item.type).toBe('message');
      expect(outputItemAdded.data.item.role).toBe('assistant');

      const firstDelta = events.find((e) => e.event === 'response.output_text.delta');
      expect(firstDelta.data.item_id).toBe(outputItemAdded.data.item.id);
      expect(firstDelta.data.output_index).toBe(0);
      expect(firstDelta.data.content_index).toBe(0);

      const completed = events.find((e) => e.event === 'response.completed');
      expect(completed.data.response.status).toBe('completed');
      expect(completed.data.response.output[0].content[0].text).toBe('Hello world');

      expect(res.end).toHaveBeenCalledTimes(1);
      done();
    }, 30);
  });

  it('does not emit duplicate terminal events when finish_reason=stop is followed by upstream end', (done) => {
    jest.resetModules();
    const { streamChatToResponsesSse } = require('../streamChatToResponsesSse');

    const upstream = new PassThrough();
    const res = createMockRes();

    streamChatToResponsesSse({
      upstreamStream: upstream,
      res,
      normalizedRequest: normalizedRequest(),
      previousResponseId: null
    });

    upstream.end('data: {"choices":[{"delta":{"content":"Hi"},"index":0,"finish_reason":"stop"}]}\n\n');

    setTimeout(() => {
      const events = collectSsePayloads(res._chunks);
      const completedEvents = events.filter((e) => e.event === 'response.completed');
      expect(completedEvents).toHaveLength(1);
      expect(res.end).toHaveBeenCalledTimes(1);
      done();
    }, 30);
  });

  it('emits response.completed even if the upstream stream ends without [DONE]', (done) => {
    jest.resetModules();
    const { streamChatToResponsesSse } = require('../streamChatToResponsesSse');

    const upstream = new PassThrough();
    const res = createMockRes();

    streamChatToResponsesSse({
      upstreamStream: upstream,
      res,
      normalizedRequest: normalizedRequest(),
      previousResponseId: null
    });

    upstream.write('data: {"choices":[{"delta":{"content":"Plain text"},"index":0}]}\n\n');
    upstream.end();

    setTimeout(() => {
      const events = collectSsePayloads(res._chunks);
      const names = events.map((e) => e.event);
      expect(names).toContain('response.completed');
      expect(res.end).toHaveBeenCalledTimes(1);
      done();
    }, 30);
  });

  it('extracts terminal text from choice.message.content when delta.content is absent', (done) => {
    jest.resetModules();
    const { streamChatToResponsesSse } = require('../streamChatToResponsesSse');

    const upstream = new PassThrough();
    const res = createMockRes();

    streamChatToResponsesSse({
      upstreamStream: upstream,
      res,
      normalizedRequest: normalizedRequest(),
      previousResponseId: null
    });

    upstream.end('data: {"choices":[{"message":{"content":"pong"},"finish_reason":"stop"}]}\n\n');

    setTimeout(() => {
      const events = collectSsePayloads(res._chunks);
      const completed = events.find((e) => e.event === 'response.completed');

      expect(completed).toBeDefined();
      expect(completed.data.response.output_text).toBe('pong');
      expect(completed.data.response.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'message',
            role: 'assistant',
            status: 'completed'
          })
        ])
      );
      done();
    }, 30);
  });

  it('emits response.failed and closes on upstream error', (done) => {
    jest.resetModules();
    const { streamChatToResponsesSse } = require('../streamChatToResponsesSse');

    const upstream = new PassThrough();
    const res = createMockRes();

    streamChatToResponsesSse({
      upstreamStream: upstream,
      res,
      normalizedRequest: normalizedRequest(),
      previousResponseId: null
    });

    upstream.emit('error', new Error('boom'));

    setTimeout(() => {
      const events = collectSsePayloads(res._chunks);
      const failed = events.find((e) => e.event === 'response.failed');
      expect(failed).toBeDefined();
      expect(failed.data.type).toBe('response.failed');
      expect(failed.data.response.status).toBe('failed');
      expect(res.end).toHaveBeenCalledTimes(1);
      done();
    }, 30);
  });

  it('emits function_call output items when upstream streams tool calls', (done) => {
    jest.resetModules();
    const { streamChatToResponsesSse } = require('../streamChatToResponsesSse');

    const upstream = new PassThrough();
    const res = createMockRes();

    streamChatToResponsesSse({
      upstreamStream: upstream,
      res,
      normalizedRequest: normalizedRequest(),
      previousResponseId: null
    });

    upstream.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"shell","arguments":"{\\"command\\":\\""}}]}}]}\n\n');
    upstream.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"dir\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');

    setTimeout(() => {
      const events = collectSsePayloads(res._chunks);
      const outputItemEvents = events.filter((e) => e.event === 'response.output_item.done');
      const argumentDeltaEvent = events.find((e) => e.event === 'response.function_call_arguments.delta');
      const argumentDoneEvent = events.find((e) => e.event === 'response.function_call_arguments.done');
      const completed = events.find((e) => e.event === 'response.completed');
      const functionCallItem = outputItemEvents.find((e) => e.data.item.type === 'function_call');

      expect(argumentDeltaEvent).toBeDefined();
      expect(argumentDeltaEvent.data.delta).toContain('"command"');
      expect(argumentDoneEvent).toBeDefined();
      expect(argumentDoneEvent.data.name).toBe('shell');
      expect(argumentDoneEvent.data.arguments).toBe('{"command":"dir"}');
      expect(functionCallItem).toBeDefined();
      expect(functionCallItem.data.item.call_id).toBe('call_abc');
      expect(functionCallItem.data.item.name).toBe('shell');
      expect(functionCallItem.data.item.arguments).toBe('{"command":"dir"}');
      expect(completed.data.response.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call',
            call_id: 'call_abc',
            name: 'shell',
            arguments: '{"command":"dir"}'
          })
        ])
      );
      expect(res._chunks.join('')).toContain('data: [DONE]');
      expect(res.end).toHaveBeenCalledTimes(1);
      done();
    }, 30);
  });

  it('extracts terminal tool calls from choice.message.tool_calls', (done) => {
    jest.resetModules();
    const { streamChatToResponsesSse } = require('../streamChatToResponsesSse');

    const upstream = new PassThrough();
    const res = createMockRes();

    streamChatToResponsesSse({
      upstreamStream: upstream,
      res,
      normalizedRequest: normalizedRequest(),
      previousResponseId: null
    });

    upstream.end('data: {"choices":[{"message":{"tool_calls":[{"id":"call_terminal","type":"function","function":{"name":"shell","arguments":"{\\"command\\":\\"dir\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');

    setTimeout(() => {
      const events = collectSsePayloads(res._chunks);
      const completed = events.find((e) => e.event === 'response.completed');

      expect(completed).toBeDefined();
      expect(completed.data.response.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call',
            call_id: 'call_terminal',
            name: 'shell',
            arguments: '{"command":"dir"}',
            status: 'completed'
          })
        ])
      );
      done();
    }, 30);
  });
});
