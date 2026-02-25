import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import * as EmployeeController from '../controllers/employee.controller';

const router = Router();

router.get('/', asyncHandler(EmployeeController.getAllEmployees));
router.get('/:id', asyncHandler(EmployeeController.getEmployee));
router.get('/:id/reports', asyncHandler(EmployeeController.getDirectReports));
router.get('/:id/balances', asyncHandler(EmployeeController.getEmployeeBalances));

export default router;
