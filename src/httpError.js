class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function publicError(err) {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: {
        success: false,
        code: err.code,
        message: err.message,
        error: err.message,
      },
    };
  }
  return {
    status: 500,
    body: {
      success: false,
      code: 'SERVER_UNAVAILABLE',
      message: 'Something went wrong.',
      error: 'Something went wrong.',
    },
  };
}

module.exports = { HttpError, publicError };
