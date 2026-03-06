import multer from 'multer';
import { AppError } from '../lib/app-error.js';

const ALLOWED_IMAGE_MIMETYPES = ['image/png', 'image/jpeg', 'image/webp'];
const ALLOWED_VIDEO_MIMETYPES = ['video/mp4', 'video/quicktime'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB

const storage = multer.memoryStorage();

const imageUpload = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('UNSUPPORTED_FORMAT', 400, 'Supported: PNG, JPG, WebP') as unknown as Error);
    }
  },
});

const videoUpload = multer({
  storage,
  limits: { fileSize: MAX_VIDEO_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_VIDEO_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('UNSUPPORTED_FORMAT', 400, 'Supported: MP4, MOV') as unknown as Error);
    }
  },
});

export const uploadSingle = imageUpload.single('image');
export const uploadMultiple = imageUpload.array('images', 5);
export const uploadSingleVideo = videoUpload.single('image');
