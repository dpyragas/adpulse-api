import multer from 'multer';
import { AppError } from '../lib/app-error.js';

const ALLOWED_MIMETYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('UNSUPPORTED_FORMAT', 400, 'Supported: PNG, JPG, WebP') as unknown as Error);
    }
  },
});

export const uploadSingle = upload.single('image');
