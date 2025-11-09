const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');
const swagger = require('../swagger.json');
const errorHandler = require('./middleware/error');
const health = require('./routes/health');
const items = require('./routes/items');

function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());

  app.get('/', (_req, res) => res.json({ service: 'backend-service-1' }));

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swagger));

  app.use('/v1', health);
  app.use('/v1/items', items);

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
