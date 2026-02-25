import { Request, Response } from 'express';
import * as blackoutService from '../services/blackout.service';

export async function getBlackoutPeriods(req: Request, res: Response) {
  const department = req.query.department as string;
  if (!department) {
    res.status(400).json({ success: false, message: 'department query param is required' });
    return;
  }
  const periods = await blackoutService.getBlackoutPeriods(department);
  res.json({ success: true, data: periods });
}

export async function createBlackoutPeriod(req: Request, res: Response) {
  const { department, name, start_date, end_date, reason } = req.body;
  if (!department || !name || !start_date || !end_date) {
    res.status(400).json({ success: false, message: 'department, name, start_date, end_date are required' });
    return;
  }

  try {
    const period = await blackoutService.createBlackoutPeriod(department, name, start_date, end_date, reason);
    res.status(201).json({ success: true, data: period });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

export async function deleteBlackoutPeriod(req: Request, res: Response) {
  const id = parseInt(req.params.id as string);
  const deleted = await blackoutService.deleteBlackoutPeriod(id);
  if (!deleted) {
    res.status(404).json({ success: false, message: 'Blackout period not found' });
    return;
  }
  res.json({ success: true, message: 'Blackout period deleted' });
}
