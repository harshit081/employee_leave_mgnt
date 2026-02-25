import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import * as BlackOutController from '../controllers/blackout.controller';

const router = Router();

router.get('/', asyncHandler(BlackOutController.getBlackoutPeriods));
router.post('/', asyncHandler(BlackOutController.createBlackoutPeriod));
router.delete('/:id', asyncHandler(BlackOutController.deleteBlackoutPeriod));

export default router;
