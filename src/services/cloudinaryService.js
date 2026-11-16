const cloudinary = require('cloudinary').v2;
const streamifier = require('stream');

/**
 * Parse standard CLOUDINARY_URL (e.g. cloudinary://<api_key>:<api_secret>@<cloud_name>)
 */
function parseCloudinaryUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('cloudinary://')) return null;
  try {
    const raw = url.replace('cloudinary://', '');
    const [auth, cloud_name] = raw.split('@');
    if (!auth || !cloud_name) return null;
    const [api_key, api_secret] = auth.split(':');
    return { cloud_name: cloud_name.trim(), api_key: api_key.trim(), api_secret: api_secret.trim() };
  } catch {
    return null;
  }
}

/**
 * Configure Cloudinary with environment variables.
 * Supports BOTH:
 * 1. CLOUDINARY_URL (single connection string: cloudinary://key:secret@cloud_name)
 * 2. Individual variables (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)
 */
function getCloudinaryConfig() {
  const envUrl = (process.env.CLOUDINARY_URL || '').trim();
  if (envUrl) {
    const parsed = parseCloudinaryUrl(envUrl);
    if (parsed && parsed.cloud_name && parsed.api_key && parsed.api_secret) {
      return {
        cloud_name: parsed.cloud_name,
        api_key: parsed.api_key,
        api_secret: parsed.api_secret,
        secure: true,
      };
    }
  }

  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME || '';
  const api_key = process.env.CLOUDINARY_API_KEY || '';
  const api_secret = process.env.CLOUDINARY_API_SECRET || '';

  return {
    cloud_name: cloud_name.trim(),
    api_key: api_key.trim(),
    api_secret: api_secret.trim(),
    secure: true,
  };
}

function initCloudinary() {
  const config = getCloudinaryConfig();
  cloudinary.config(config);
  return cloudinary;
}

/**
 * Check if Cloudinary credentials are fully configured in the environment
 */
function isCloudinaryConfigured() {
  const config = getCloudinaryConfig();
  return Boolean(
    config.cloud_name &&
    config.api_key &&
    config.api_secret &&
    !config.cloud_name.includes('placeholder') &&
    !config.api_key.includes('placeholder')
  );
}

/**
 * Upload a service or category image buffer to Cloudinary
 * Stored specifically in folder 'homestepin/services'
 *
 * @param {Buffer} buffer - Image file buffer
 * @param {Object} options - Additional upload options (tags, public_id, etc.)
 * @returns {Promise<{ secure_url: string, public_id: string, format: string, width: number, height: number, bytes: number }>}
 */
async function uploadServiceImage(buffer, options = {}) {
  if (!isCloudinaryConfigured()) {
    throw new Error(
      'Cloudinary is not configured. Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in backend/.env'
    );
  }

  initCloudinary();

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'homestepin/services',
        resource_type: 'image',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        transformation: [
          { quality: 'auto:good' },
          { fetch_format: 'auto' }
        ],
        ...options,
      },
      (error, result) => {
        if (error) {
          return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        }
        if (!result) {
          return reject(new Error('Cloudinary upload returned empty result'));
        }
        return resolve({
          secure_url: result.secure_url,
          public_id: result.public_id,
          format: result.format,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
        });
      }
    );

    uploadStream.end(buffer);
  });
}

/**
 * Delete a service image from Cloudinary by its public ID
 *
 * @param {string} publicId - Cloudinary public_id (e.g., 'homestepin/services/xyz123')
 * @returns {Promise<{ result: string }>}
 */
async function deleteServiceImage(publicId) {
  if (!publicId) return { result: 'not_found' };

  if (!isCloudinaryConfigured()) {
    console.warn(`[Cloudinary Warning] Cannot delete image "${publicId}": Cloudinary credentials not configured.`);
    return { result: 'skipped_not_configured' };
  }

  initCloudinary();

  try {
    const res = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image',
      invalidate: true,
    });
    return res;
  } catch (err) {
    console.error(`[Cloudinary Error] Failed to delete image ${publicId}:`, err.message);
    throw new Error(`Failed to delete service image from Cloudinary: ${err.message}`);
  }
}

/**
 * Replace an existing service image:
 * 1. Upload the new image to Cloudinary
 * 2. On success, destroy the old image if oldPublicId exists
 *
 * @param {string|null} oldPublicId - Previous Cloudinary public ID
 * @param {Buffer} newBuffer - New image file buffer
 * @param {Object} options - Additional options
 */
async function replaceServiceImage(oldPublicId, newBuffer, options = {}) {
  const uploadResult = await uploadServiceImage(newBuffer, options);

  if (oldPublicId && oldPublicId !== uploadResult.public_id) {
    try {
      await deleteServiceImage(oldPublicId);
    } catch (err) {
      console.warn(`[Cloudinary Warning] Upload succeeded but failed to delete previous image ${oldPublicId}: ${err.message}`);
    }
  }

  return uploadResult;
}

module.exports = {
  cloudinary,
  isCloudinaryConfigured,
  uploadServiceImage,
  deleteServiceImage,
  replaceServiceImage,
};

