import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import * as ctrl from '../controllers/blackout.controller';

const router = Router();

router.get('/', asyncHandler(ctrl.getBlackoutPeriods));
router.post('/', asyncHandler(ctrl.createBlackoutPeriod));
router.delete('/:id', asyncHandler(ctrl.deleteBlackoutPeriod));

export default router;
