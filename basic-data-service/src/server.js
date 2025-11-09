const { createApp } = require('./app');
const env = require('./env');
const logger = require('./logger');

const app = createApp();
app.listen(env.port, () => {
  logger.info(`${env.serviceName} listening on http://localhost:${env.port}`);
});
