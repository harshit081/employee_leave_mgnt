import { Request, Response } from 'express';
import * as employeeService from '../services/employee.service';
import * as balanceService from '../services/balance.service';

export async function getAllEmployees(req: Request, res: Response) {
  const employees = await employeeService.getAllEmployees();
  res.json({ success: true, data: employees });
}

export async function getEmployee(req: Request, res: Response) {
  const id = parseInt(req.params.id as string);
  const employee = await employeeService.getEmployeeById(id);
  if (!employee) {
    res.status(404).json({ success: false, message: 'Employee not found' });
    return;
  }
  res.json({ success: true, data: employee });
}

export async function getDirectReports(req: Request, res: Response) {
  const id = parseInt(req.params.id as string);
  const reports = await employeeService.getDirectReports(id);
  res.json({ success: true, data: reports });
}

export async function getEmployeeBalances(req: Request, res: Response) {
  const id = parseInt(req.params.id as string);
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const balances = await balanceService.getAllBalances(id, year);
  res.json({ success: true, data: balances });
}
