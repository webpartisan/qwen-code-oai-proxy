const { 
  ResponsesError, 
  formatErrorResponse,
  validationError,
  unsupportedFieldError,
  unsupportedInputTypeError,
  unsupportedToolTypeError,
  missingFieldError,
  conflictingFieldsError
} = require('../responsesErrors.js');

describe('responsesErrors', () => {
  describe('ResponsesError', () => {
    it('should create error with correct properties', () => {
      const error = new ResponsesError('Test error', 'validation_error', 'test_code', 400);
      
      expect(error.message).toBe('Test error');
      expect(error.type).toBe('validation_error');
      expect(error.code).toBe('test_code');
      expect(error.statusCode).toBe(400);
    });

    it('should have default status code 400 for validation errors', () => {
      const error = new ResponsesError('Test error');
      expect(error.statusCode).toBe(400);
    });

    it('should allow custom status code', () => {
      const error = new ResponsesError('Server error', 'server_error', 'internal', 500);
      expect(error.statusCode).toBe(500);
    });
  });

  describe('formatErrorResponse', () => {
    it('should format error with correct structure', () => {
      const error = new ResponsesError('Something went wrong', 'validation_error', 'invalid_field', 400);
      const formatted = formatErrorResponse(error);
      
      expect(formatted.error).toBeDefined();
      expect(formatted.error.message).toBe('Something went wrong');
      expect(formatted.error.type).toBe('validation_error');
      expect(formatted.error.code).toBe('invalid_field');
    });
  });

  describe('validationError', () => {
    it('should create validation error', () => {
      const error = validationError('Invalid input');
      
      expect(error).toBeInstanceOf(ResponsesError);
      expect(error.message).toBe('Invalid input');
      expect(error.type).toBe('validation_error');
      expect(error.statusCode).toBe(400);
    });
  });

  describe('unsupportedFieldError', () => {
    it('should create unsupported field error', () => {
      const error = unsupportedFieldError('conversation');
      
      expect(error.message).toContain('Unsupported field: conversation');
      expect(error.statusCode).toBe(400);
    });
  });

  describe('unsupportedInputTypeError', () => {
    it('should create unsupported input type error', () => {
      const error = unsupportedInputTypeError('image_url');
      
      expect(error.message).toContain('image_url');
      expect(error.statusCode).toBe(400);
    });
  });

  describe('unsupportedToolTypeError', () => {
    it('should create unsupported tool type error', () => {
      const error = unsupportedToolTypeError('web_search');
      
      expect(error.message).toContain('web_search');
      expect(error.statusCode).toBe(400);
    });
  });

  describe('missingFieldError', () => {
    it('should create missing field error', () => {
      const error = missingFieldError('input');
      
      expect(error.message).toBe('Missing required field: input');
      expect(error.statusCode).toBe(400);
    });
  });

  describe('conflictingFieldsError', () => {
    it('should create conflicting fields error', () => {
      const error = conflictingFieldsError('conversation', 'previous_response_id');
      
      expect(error.message).toContain('conversation');
      expect(error.message).toContain('previous_response_id');
      expect(error.statusCode).toBe(400);
    });
  });
});
