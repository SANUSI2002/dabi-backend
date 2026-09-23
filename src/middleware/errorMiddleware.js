export const notFound = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};

export const errorHandler = (err, req, res, next) => {
  // Default to 500 if the status code isn't already set to an error code
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;

  res.status(statusCode).json({
    status: 'error',
    message: err.message,
    // Only show the stack trace in development, keep it hidden in production
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
};
