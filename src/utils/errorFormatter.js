/**
 * Unified error response formatting utility
 */

class ErrorFormatter {
  /**
   * Standardize OpenAI format error response
   * @param {string} message - Error message
   * @param {string} type - Error type
   * @param {number} code - HTTP status code
   * @returns {object} Standardized error response object
   */
  static openAIApiError(message, type = 'api_error', code = 500) {
    return {
      status: code,
      body: {
        error: {
          message: message,
          type: type,
          code: code
        }
      }
    };
  }

  /**
   * Standardize validation error response (OpenAI format)
   * @param {string} message - Error message
   * @returns {object} Standardized error response object
   */
  static openAIValidationError(message) {
    return this.openAIApiError(message, 'validation_error', 400);
  }

  /**
   * Standardize authentication error response (OpenAI format)
   * @param {string} message - Error message
   * @returns {object} Standardized error response object
   */
  static openAIAuthError(message = 'Not authenticated with Qwen. Please authenticate first.') {
    return this.openAIApiError(message, 'authentication_error', 401);
  }

  /**
   * Standardize rate limit error response (OpenAI format)
   * @param {string} message - Error message
   * @returns {object} Standardized error response object
   */
  static openAIRateLimitError(message = 'Rate limit exceeded') {
    return this.openAIApiError(message, 'rate_limit_exceeded', 429);
  }

}

/**
 * Check if an error is a rate limit error (HTTP 429)
 * @param {Error|Object} error - Error object or response error
 * @returns {boolean} True if the error is a rate limit error
 */
function isRateLimitError(error) {
  if (!error) return false;
  
  const errorCode = error?.response?.status || error?.code;
  const errorMessage = (error instanceof Error ? error.message : String(error)).toLowerCase();
  
  return (
    errorCode === 429 ||
    errorMessage.includes('too many requests') ||
    errorMessage.includes('rate limit')
  );
}

module.exports = { ErrorFormatter, isRateLimitError };