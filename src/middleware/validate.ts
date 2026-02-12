import type { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { AppError } from '../lib/app-error.js';

function createValidator(source: 'body' | 'query' | 'params') {
  return (schema: ZodSchema) => {
    return (req: Request, _res: Response, next: NextFunction) => {
      try {
        req[source] = schema.parse(req[source]);
        next();
      } catch (err) {
        if (err instanceof ZodError) {
          throw new AppError('VALIDATION_ERROR', 400, 'Validation failed', {
            errors: err.issues,
          });
        }
        throw err;
      }
    };
  };
}

export const validateBody = createValidator('body');
export const validateQuery = createValidator('query');
export const validateParams = createValidator('params');
