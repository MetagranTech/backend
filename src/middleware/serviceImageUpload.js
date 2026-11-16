const multer = require('multer');

// Strict Binary Magic Byte Validation Helper for JPEG, PNG, WEBP
function detectAndValidateRasterImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A
  ) {
    return 'png';
  }
  // WEBP: RIFF....WEBP (52 49 46 46 .... 57 45 42 50)
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

const storage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB maximum
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mime)) {
      const err = new Error('Invalid file type: Only authentic JPEG, PNG, and WebP images are permitted.');
      err.code = 'INVALID_MIME_TYPE';
      return cb(err, false);
    }
    cb(null, true);
  },
});

/**
 * Express middleware that handles single service image upload
 * and performs strict binary magic byte verification on the buffer.
 */
function handleServiceImageUpload(fieldName = 'image') {
  const uploadSingle = upload.single(fieldName);

  return (req, res, next) => {
    uploadSingle(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
              error: 'Image file size exceeds the 5 MB maximum limit.',
              code: 'LIMIT_FILE_SIZE',
            });
          }
          return res.status(400).json({
            error: `Upload error: ${err.message}`,
            code: err.code,
          });
        }
        return res.status(400).json({
          error: err.message || 'Image upload validation failed.',
          code: err.code || 'UPLOAD_VALIDATION_ERROR',
        });
      }

      // If a file was uploaded, verify its magic bytes
      if (req.file) {
        const verifiedExt = detectAndValidateRasterImage(req.file.buffer);
        if (!verifiedExt) {
          return res.status(400).json({
            error: 'Corrupted or spoofed image: File content does not match genuine JPEG, PNG, or WebP binary headers.',
            code: 'INVALID_MAGIC_BYTES',
          });
        }
        req.file.verifiedFormat = verifiedExt;
      }

      next();
    });
  };
}

module.exports = {
  detectAndValidateRasterImage,
  handleServiceImageUpload,
};

