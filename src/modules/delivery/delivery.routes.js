import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import * as c from './delivery.controller.js';
import * as v from './delivery.validator.js';

const router = express.Router();
router.use(protect);
// Controlled operations endpoint: configures an existing account, never public signup.
router.put('/operations/partners/:id', validate(v.provision), c.configure);
router.get('/partners', validate(v.list), c.partners);
router.post('/fulfilments/:id/assignment', validate(v.assign), c.assign);
router.get('/assignments', validate(v.list), c.queue);
router.get('/assignments/:id', validate(v.id), c.detail);
router.post('/assignments/:id/accept', validate(v.action), c.accept);
router.post('/assignments/:id/reject', validate(v.reject), c.reject);
router.post('/assignments/:id/status', validate(v.transition), c.transition);
router.post('/assignments/:id/locations', validate(v.location), c.location);
router.get('/orders/:id/tracking', validate(v.id), c.tracking);
router.use(c.errorHandler);
export default router;
