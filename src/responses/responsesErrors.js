class ResponsesError extends Error {
  constructor(message, type, code, statusCode = 400) {
    super(message);
    this.name = 'ResponsesError';
    this.type = type;
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validationError(message) {
  return new ResponsesError(message, 'validation_error', 400, 400);
}

function unsupportedFieldError(fieldName) {
  return new ResponsesError(
    `Unsupported field: ${fieldName}`,
    'validation_error',
    'unsupported_field',
    400
  );
}

function unsupportedInputTypeError(type) {
  return new ResponsesError(
    `Unsupported input item type: ${type}`,
    'validation_error',
    'unsupported_input_type',
    400
  );
}

function unsupportedToolTypeError(type) {
  return new ResponsesError(
    `Unsupported tool type: ${type}. Only custom function tools are supported in this phase.`,
    'validation_error',
    'unsupported_tool_type',
    400
  );
}

function missingFieldError(fieldName) {
  return new ResponsesError(
    `Missing required field: ${fieldName}`,
    'validation_error',
    'missing_field',
    400
  );
}

function previousResponseNotFoundError(responseId) {
  return new ResponsesError(
    `previous_response_id '${responseId}' was not found in local response storage`,
    'invalid_request_error',
    'previous_response_not_found',
    404
  );
}

function conflictingFieldsError(field1, field2) {
  return new ResponsesError(
    `Cannot use both '${field1}' and '${field2}' at the same time`,
    'validation_error',
    'conflicting_fields',
    400
  );
}

function formatErrorResponse(error) {
  return {
    error: {
      message: error.message,
      type: error.type,
      code: error.code
    }
  };
}

module.exports = {
  ResponsesError,
  validationError,
  unsupportedFieldError,
  unsupportedInputTypeError,
  unsupportedToolTypeError,
  missingFieldError,
  previousResponseNotFoundError,
  conflictingFieldsError,
  formatErrorResponse
};
