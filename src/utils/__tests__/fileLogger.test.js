const fs = require('fs');

describe('fileLogger', () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    process.env.LOG_LEVEL = originalLogLevel;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('writes debug json in error-debug mode', async () => {
    process.env.LOG_LEVEL = 'error-debug';

    const mkdirSpy = jest.spyOn(fs.promises, 'mkdir').mockResolvedValue();
    const writeSpy = jest.spyOn(fs.promises, 'writeFile').mockResolvedValue();
    jest.spyOn(console, 'log').mockImplementation(() => {});

    let fileLogger;
    jest.isolateModules(() => {
      fileLogger = require('../fileLogger.js');
    });

    fileLogger.logDebugJson('req-1', { ok: true }, 'diagnostic');
    await Promise.resolve();
    await Promise.resolve();

    expect(mkdirSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
    expect(writeSpy.mock.calls[0][0]).toContain('diagnostic-');
  });

  it('does not start cleanup job twice', () => {
    process.env.LOG_LEVEL = 'error-debug';

    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    let fileLogger;
    jest.isolateModules(() => {
      fileLogger = require('../fileLogger.js');
    });

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledTimes(1);

    fileLogger.startCleanupJob();
    fileLogger.startCleanupJob();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });
});
