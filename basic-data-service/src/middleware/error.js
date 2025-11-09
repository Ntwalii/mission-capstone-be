const logger = require('../logger');
module.exports = (err, _req, res, _next) => {
  logger.error('Unhandled error', err);
  res.status(err.status || 500).json({ error: err.name || 'Error', message: err.message || 'Unexpected error' });
};
