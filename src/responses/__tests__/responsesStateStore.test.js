const path = require('path');
const os = require('os');
const fs = require('fs');

describe('ResponsesStateStore', () => {
  const testDir = path.join(os.tmpdir(), 'qwen-test-responses-' + Date.now());
  
  beforeAll(() => {
    // Clean up test directory before tests
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });
  
  afterAll(() => {
    // Clean up test directory after tests
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('should initialize directories lazily', async () => {
    const { ResponsesStateStore } = require('../responsesStateStore');
    const store = new ResponsesStateStore({ basePath: testDir });
    
    expect(fs.existsSync(testDir)).toBe(false);
    await store.ensureReady();
    
    expect(fs.existsSync(testDir)).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'responses'))).toBe(true);
  });

  it('should save and load response by id', async () => {
    const { ResponsesStateStore } = require('../responsesStateStore');
    const store = new ResponsesStateStore({ basePath: testDir });
    await store.ensureReady();
    
    const record = {
      id: 'resp_test123',
      created_at: Date.now(),
      model: 'qwen3-coder-plus',
      previous_response_id: null,
      store: true,
      metadata: {},
      request: { input: 'Hello' },
      normalized_input_items: [{ role: 'user', content: 'Hello' }],
      synthetic_instructions: null,
      carryover_items: [],
      upstream_request: {},
      upstream_response: {},
      response_object: { id: 'resp_test123', output: [] }
    };
    
    await store.save(record);
    
    const loaded = await store.load('resp_test123');
    
    expect(loaded).toBeDefined();
    expect(loaded.id).toBe('resp_test123');
    expect(loaded.model).toBe('qwen3-coder-plus');
  });

  it('should return null for missing response id', async () => {
    const { ResponsesStateStore } = require('../responsesStateStore');
    const store = new ResponsesStateStore({ basePath: testDir });
    await store.ensureReady();
    
    const loaded = await store.load('nonexistent_id');
    
    expect(loaded).toBeNull();
  });

  it('should check if response exists', async () => {
    const { ResponsesStateStore } = require('../responsesStateStore');
    const store = new ResponsesStateStore({ basePath: testDir });
    await store.ensureReady();
    
    const record = {
      id: 'resp_exists_test',
      created_at: Date.now(),
      model: 'qwen3-coder-plus',
      previous_response_id: null,
      store: true,
      metadata: {},
      request: {},
      normalized_input_items: [],
      synthetic_instructions: null,
      carryover_items: [],
      upstream_request: {},
      upstream_response: {},
      response_object: {}
    };
    
    await store.save(record);
    
    const exists = await store.exists('resp_exists_test');
    const notExists = await store.exists('nonexistent');
    
    expect(exists).toBe(true);
    expect(notExists).toBe(false);
  });

  it('should preserve required top-level keys in stored record', async () => {
    const { ResponsesStateStore } = require('../responsesStateStore');
    const store = new ResponsesStateStore({ basePath: testDir });
    await store.ensureReady();
    
    const record = {
      id: 'resp_keys_test',
      created_at: 1770000000000,
      model: 'qwen3-coder-plus',
      previous_response_id: 'resp_previous',
      store: false,
      metadata: { user_data: 'test' },
      request: { input: 'Hello' },
      normalized_input_items: [{ role: 'user', content: 'Hello' }],
      synthetic_instructions: [{ role: 'system', content: 'Be terse' }],
      carryover_items: [{ role: 'user', content: 'Hi' }],
      upstream_request: { messages: [] },
      upstream_response: { id: 'chatcmpl-123' },
      response_object: { id: 'resp_keys_test', output: [] }
    };
    
    await store.save(record);
    const loaded = await store.load('resp_keys_test');
    
    expect(Object.keys(loaded)).toContain('id');
    expect(Object.keys(loaded)).toContain('created_at');
    expect(Object.keys(loaded)).toContain('model');
    expect(Object.keys(loaded)).toContain('previous_response_id');
    expect(Object.keys(loaded)).toContain('store');
    expect(Object.keys(loaded)).toContain('metadata');
    expect(Object.keys(loaded)).toContain('request');
    expect(Object.keys(loaded)).toContain('normalized_input_items');
    expect(Object.keys(loaded)).toContain('synthetic_instructions');
    expect(Object.keys(loaded)).toContain('carryover_items');
    expect(Object.keys(loaded)).toContain('upstream_request');
    expect(Object.keys(loaded)).toContain('upstream_response');
    expect(Object.keys(loaded)).toContain('response_object');
    
    expect(loaded.previous_response_id).toBe('resp_previous');
    expect(loaded.store).toBe(false);
    expect(loaded.synthetic_instructions).toEqual([{ role: 'system', content: 'Be terse' }]);
    expect(loaded.carryover_items).toEqual([{ role: 'user', content: 'Hi' }]);
  });
});
