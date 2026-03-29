const { createApp } = require('./app.js');
const { AccountRefreshScheduler } = require('./utils/accountRefreshScheduler.js');
const liveLogger = require('./utils/liveLogger.js');
const fileLogger = require('./utils/fileLogger.js');
const config = require('./config.js');

const PORT = config.port;
const HOST = config.host;

const app = createApp();
const qwenAPI = app._qwenAPI;
const accountRefreshScheduler = new AccountRefreshScheduler(qwenAPI);

process.on('SIGINT', async () => {
  liveLogger.shutdown('SIGINT received');
  try {
    accountRefreshScheduler.stopScheduler();
    liveLogger.accountRemoved('refresh-scheduler');
  } catch (error) {
    console.error('Failed to stop scheduler:', error.message);
  }

  try {
    await qwenAPI.saveRequestCounts();
  } catch (error) {
    console.error('Failed to save request counts:', error.message);
  }

  process.exit(0);
});

process.on('SIGTERM', async () => {
  liveLogger.shutdown('SIGTERM received');
  try {
    accountRefreshScheduler.stopScheduler();
    liveLogger.accountRemoved('refresh-scheduler');
  } catch (error) {
    console.error('Failed to stop scheduler:', error.message);
  }

  try {
    await qwenAPI.saveRequestCounts();
  } catch (error) {
    console.error('Failed to save request counts:', error.message);
  }

  process.exit(0);
});

async function printProxyRoutingSummary() {
  await qwenAPI.refreshAccountProxyBindings();

  const lines = qwenAPI.proxyManager.getStartupSummary();

  console.log('\x1b[36mRouting summary:\x1b[0m');
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

app.listen(PORT, HOST, async () => {
  liveLogger.serverStarted(HOST, PORT);

  qwenAPI.authManager.init(qwenAPI);
  fileLogger.startCleanupJob();

  try {
    await qwenAPI.authManager.loadAllAccounts();
    const accountIds = qwenAPI.authManager.getAccountIds();

    const defaultAccount = config.defaultAccount;
    if (defaultAccount) {
      console.log(`\x1b[36mDefault account: ${defaultAccount}\x1b[0m`);
    }

    if (accountIds.length > 0) {
      console.log('\x1b[36mAccounts:\x1b[0m');
      for (const accountId of accountIds) {
        const credentials = qwenAPI.authManager.getAccountCredentials(accountId);
        const isValid = credentials && qwenAPI.authManager.isTokenValid(credentials);
        const status = isValid ? '\x1b[32mvalid\x1b[0m' : '\x1b[31minvalid\x1b[0m';
        const isDefault = accountId === defaultAccount ? ' (default)' : '';
        console.log(`  ${accountId}${isDefault}: ${status}`);
      }
    } else {
      const defaultCredentials = await qwenAPI.authManager.loadCredentials();
      if (defaultCredentials) {
        const isValid = qwenAPI.authManager.isTokenValid(defaultCredentials);
        const status = isValid ? '\x1b[32mvalid\x1b[0m' : '\x1b[31minvalid\x1b[0m';
        console.log(`\x1b[36mDefault account: ${status}\x1b[0m`);
      } else {
        console.log('\x1b[33mNo accounts configured\x1b[0m');
      }
    }
  } catch (error) {
    console.log('\x1b[33mWarning: Could not load accounts\x1b[0m');
  }

  await printProxyRoutingSummary();

  try {
    await accountRefreshScheduler.initialize();
  } catch (error) {
    console.log(`\x1b[31mScheduler init failed: ${error.message}\x1b[0m`);
  }
});
