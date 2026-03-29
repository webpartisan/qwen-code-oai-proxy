const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class ResponsesStateStore {
  constructor(options = {}) {
    this.basePath = options.basePath || path.join(os.homedir(), '.qwen', 'openai-responses');
    this.responsesDir = path.join(this.basePath, 'responses');
    this.indexPath = path.join(this.basePath, 'index.json');
    this._ready = false;
  }

  async ensureReady() {
    if (this._ready) return;
    
    await fs.mkdir(this.responsesDir, { recursive: true });
    
    try {
      await fs.access(this.indexPath);
    } catch {
      await fs.writeFile(this.indexPath, JSON.stringify({ responses: [] }, null, 2));
    }
    
    this._ready = true;
  }

  async save(record) {
    await this.ensureReady();
    
    if (!record.id) {
      throw new Error('Record must have an id');
    }

    const filePath = path.join(this.responsesDir, `${record.id}.json`);
    const content = JSON.stringify(record, null, 2);
    await fs.writeFile(filePath, content);

    await this._addToIndex(record.id);
  }

  async load(responseId) {
    await this.ensureReady();
    
    const filePath = path.join(this.responsesDir, `${responseId}.json`);
    
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async exists(responseId) {
    const record = await this.load(responseId);
    return record !== null;
  }

  async _addToIndex(responseId) {
    let index = { responses: [] };
    
    try {
      const content = await fs.readFile(this.indexPath, 'utf8');
      if (content && content.trim()) {
        index = JSON.parse(content);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      index = { responses: [] };
    }
    
    if (!index.responses) {
      index.responses = [];
    }
    
    if (!index.responses.includes(responseId)) {
      index.responses.push(responseId);
      await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2));
    }
  }

  async listAll() {
    await this.ensureReady();
    
    const content = await fs.readFile(this.indexPath, 'utf8');
    const index = (content && content.trim()) ? JSON.parse(content) : { responses: [] };
    
    const responses = [];
    for (const responseId of index.responses) {
      const record = await this.load(responseId);
      if (record) {
        responses.push(record);
      }
    }
    
    return responses;
  }

  async delete(responseId) {
    await this.ensureReady();
    
    const filePath = path.join(this.responsesDir, `${responseId}.json`);
    
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await this._removeFromIndex(responseId);
  }

  async _removeFromIndex(responseId) {
    let index = { responses: [] };
    
    try {
      const content = await fs.readFile(this.indexPath, 'utf8');
      if (content && content.trim()) {
        index = JSON.parse(content);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    
    index.responses = index.responses.filter(id => id !== responseId);
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2));
  }
}

module.exports = { ResponsesStateStore };
