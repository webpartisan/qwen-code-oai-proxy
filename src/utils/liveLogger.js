const winston = require('winston');

const colors = {
  red: (t) => `\x1b[31m${t}\x1b[0m`,
  green: (t) => `\x1b[32m${t}\x1b[0m`,
  blue: (t) => `\x1b[34m${t}\x1b[0m`,
  yellow: (t) => `\x1b[33m${t}\x1b[0m`,
  cyan: (t) => `\x1b[36m${t}\x1b[0m`,
  magenta: (t) => `\x1b[35m${t}\x1b[0m`,
  gray: (t) => `\x1b[90m${t}\x1b[0m`,
  white: (t) => `\x1b[37m${t}\x1b[0m`
};

const accountColors = new Map();
const availableColors = ['blue', 'green', 'yellow', 'magenta', 'cyan', 'white'];
let colorIndex = 0;

function getAccountColor(accountId) {
  if (!accountId) return 'white';
  const id = accountId.substring(0, 8);
  if (!accountColors.has(id)) {
    accountColors.set(id, availableColors[colorIndex % availableColors.length]);
    colorIndex++;
  }
  return accountColors.get(id);
}

function formatAccountTag(accountId) {
  if (!accountId) return colors.cyan('[default]');
  // Extract username part before @ for cleaner display
  const username = accountId.includes('@') ? accountId.split('@')[0] : accountId;
  const id = username.length > 8 ? username.substring(0, 8) : username;
  const color = getAccountColor(accountId);
  return colors[color](`[${id}]`);
}

function formatProxyTag(proxyId) {
  if (!proxyId) return colors.gray('[direct]');
  // Shorten proxy ID for display
  const shortId = proxyId.length > 12 ? proxyId.substring(0, 12) : proxyId;
  return colors.gray(`[${shortId}]`);
}

function formatAccountAndProxy(accountId, proxyId) {
  return `${formatAccountTag(accountId)} ${formatProxyTag(proxyId)}`;
}

const customFormat = winston.format.printf(({ timestamp, level, message }) => {
  return `${timestamp} ${message}`;
});

const logger = winston.createLogger({
  level: 'info',
  format: customFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        customFormat
      )
    })
  ]
});

function log(message) {
  logger.info(message);
}

function maskApiKey(key) {
  const s = String(key || '');
  return s.length > 13 ? s.substring(0, 13) + '...' : s;
}

function maskAccountId(accountId) {
  if (!accountId) return 'none';
  return accountId.length > 8 ? accountId.substring(0, 8) : accountId;
}

const liveLogger = {
  proxyRequest(requestId, model, accountId, tokenCount, requestNum, isStreaming, proxyId) {
    const reqNumStr = requestNum ? colors.gray(`#${requestNum}`) : '';
    const streamStr = isStreaming ? colors.cyan('{streaming}') : '';
    // Show "inbound" for requests since account/proxy not yet determined
    // Only show account if it's a real account (not 'default' or null)
    const hasRealAccount = accountId && accountId !== 'default';
    const accountInfo = hasRealAccount ? formatAccountTag(accountId) : colors.gray('[inbound]');
    const proxyInfo = proxyId ? formatProxyTag(proxyId) : '';
    const msg = `${colors.blue('→')} ${accountInfo}${proxyInfo} ${colors.gray(requestId.substring(0, 8))} | ${colors.yellow(model)} ${streamStr} | ${colors.gray(`${tokenCount} tokens`)} ${reqNumStr}`;
    log(msg);
  },

  proxyResponse(requestId, statusCode, accountId, latency, inputTokens, outputTokens, qwenId, proxyId) {
    const statusColor = statusCode === 200 ? colors.green : colors.red;
    const tokenInfo = inputTokens && outputTokens
      ? ` | ${colors.cyan(`${inputTokens}+${outputTokens} tok`)}`
      : '';
    const shortId = requestId.length > 12 ? requestId.substring(0, 8) : requestId;
    const qwenInfo = qwenId ? ` | ${colors.magenta(`qwen: ${qwenId}`)}` : '';
    const msg = `${colors.blue('←')} ${formatAccountAndProxy(accountId, proxyId)} ${colors.gray(shortId)} ${statusColor(statusCode)} | ${colors.gray(`${latency}ms`)}${tokenInfo}${qwenInfo}`;
    log(msg);
  },

  proxyError(requestId, statusCode, accountId, errorMessage, proxyId) {
    const msg = `${colors.red('✗')} ${formatAccountAndProxy(accountId, proxyId)} ${colors.red(statusCode)} | ${colors.gray(errorMessage.substring(0, 50))}`;
    log(msg);
  },

  authInitiated(deviceCode, proxyId) {
    const msg = `${colors.green('✓')} Auth ${formatProxyTag(proxyId)} | ${colors.gray(`code: ${deviceCode}`)}`;
    log(msg);
  },

  authCompleted(accountId, proxyId) {
    const msg = `${colors.green('✓')} Auth done ${formatAccountAndProxy(accountId, proxyId)}`;
    log(msg);
  },

  accountRefreshed(accountId, status, proxyId) {
    const statusMsg = status === 'healthy' ? colors.green('ok') : colors.red('fail');
    const msg = `${colors.blue('↻')} Refresh ${formatAccountAndProxy(accountId, proxyId)} | ${statusMsg}`;
    log(msg);
  },

  accountAdded(accountId, proxyId) {
    const msg = `${colors.green('+')} Account ${formatAccountAndProxy(accountId, proxyId)}`;
    log(msg);
  },

  accountRemoved(accountId) {
    const msg = `${colors.red('-')} Account | ${colors.cyan(maskAccountId(accountId))}`;
    log(msg);
  },

  // Token refresh specific logging
  tokenRefreshStart(accountId, proxyId) {
    const msg = `${colors.yellow('⟳')} Token refresh ${formatAccountAndProxy(accountId, proxyId)} | ${colors.yellow('starting...')}`;
    log(msg);
  },

  tokenRefreshSuccess(accountId, proxyId, latency) {
    const msg = `${colors.green('✓')} Token refresh ${formatAccountAndProxy(accountId, proxyId)} | ${colors.green('success')} ${colors.gray(`${latency}ms`)}`;
    log(msg);
  },

  tokenRefreshError(accountId, proxyId, errorMessage) {
    const msg = `${colors.red('✗')} Token refresh ${formatAccountAndProxy(accountId, proxyId)} | ${colors.red('failed')} ${colors.gray(errorMessage.substring(0, 50))}`;
    log(msg);
  },

  // OAuth device flow logging
  oauthDeviceCodeRequest(proxyId) {
    const msg = `${colors.blue('→')} OAuth ${formatProxyTag(proxyId)} | ${colors.gray('requesting device code...')}`;
    log(msg);
  },

  oauthDeviceCodeSuccess(proxyId, deviceCode) {
    const msg = `${colors.green('✓')} OAuth ${formatProxyTag(proxyId)} | ${colors.gray(`device code: ${deviceCode.substring(0, 8)}...`)}`;
    log(msg);
  },

  oauthTokenPoll(proxyId, attempt, maxAttempts) {
    const msg = `${colors.yellow('⟳')} OAuth ${formatProxyTag(proxyId)} | ${colors.gray(`polling ${attempt}/${maxAttempts}...`)}`;
    log(msg);
  },

  serverStarted(host, port) {
    const msg = `${colors.green('●')} Server | ${colors.cyan(`http://${host}:${port}`)}`;
    log(msg);
  },

  shutdown(reason) {
    const msg = `${colors.yellow('■')} Shutdown | ${colors.gray(reason)}`;
    log(msg);
  }
};

module.exports = liveLogger;