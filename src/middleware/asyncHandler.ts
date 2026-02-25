import { Request, Response, NextFunction } from 'express';

/**
 * Wrap async route handlers so thrown errors reach the error handler middleware.
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
