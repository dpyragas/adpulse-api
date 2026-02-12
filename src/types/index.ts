// Custom application types
// Generated types are in ./generated/api.d.ts — NEVER hand-edit

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name: string;
        emailVerified: boolean;
        image?: string | null;
        role: string;
        createdAt: Date;
        updatedAt: Date;
      };
      session?: {
        id: string;
        expiresAt: Date;
        token: string;
        userId: string;
        ipAddress?: string | null;
        userAgent?: string | null;
      };
    }
  }
}

export interface SuccessResponse<T> {
  data: T;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
}
