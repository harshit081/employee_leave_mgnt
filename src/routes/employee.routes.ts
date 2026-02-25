import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import * as ctrl from '../controllers/employee.controller';

const router = Router();

router.get('/', asyncHandler(ctrl.getAllEmployees));
router.get('/:id', asyncHandler(ctrl.getEmployee));
router.get('/:id/reports', asyncHandler(ctrl.getDirectReports));
router.get('/:id/balances', asyncHandler(ctrl.getEmployeeBalances));

export default router;
