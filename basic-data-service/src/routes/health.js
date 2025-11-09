const { Router } = require('express');
const router = Router();

router.get('/health', (_req, res) => res.json({ status: 'ok' }));

module.exports = router;
