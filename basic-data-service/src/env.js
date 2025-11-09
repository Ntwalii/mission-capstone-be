require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '4001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  serviceName: process.env.SERVICE_NAME || 'backend-service-1',
  databaseUrl: process.env.DATABASE_URL,
  authValidateUrl: process.env.AUTH_VALIDATE_URL || 'http://localhost:3000/auth/validate'
};
