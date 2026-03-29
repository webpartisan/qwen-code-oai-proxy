const crypto = require('crypto');

function createResponseId() {
  return 'resp_' + generateRandomChars(26);
}

function createMessageId() {
  return 'msg_' + generateRandomChars(26);
}

function createFunctionCallId() {
  return 'fc_' + generateRandomChars(26);
}

function createCallId() {
  return 'call_' + generateRandomChars(26);
}

function generateRandomChars(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  const randomBytes = crypto.randomBytes(length);
  
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  
  return result;
}

module.exports = {
  createResponseId,
  createMessageId,
  createFunctionCallId,
  createCallId
};
