const ServiceArea = require('../models/ServiceArea');
const OutOfAreaAttempt = require('../models/OutOfAreaAttempt');

const OUT_OF_AREA_MESSAGE =
  'Sorry! HomeStepIn currently provides services only within our Trichy service area. Your selected location is outside our service coverage.';

// Default Authentic Tiruchirappalli (Trichy) Urban Service Polygon (standard [lng, lat] GeoJSON)
const DEFAULT_TRICHY_COORDINATES = [
  [78.6400, 10.8700], // Srirangam North / Kollidam River
  [78.7100, 10.8750], // Thiruvanaikoil / Kallanai Road
  [78.7650, 10.8300], // Ariyamangalam / Kattur East
  [78.7850, 10.7950], // Tiruverumbur / BHEL Township
  [78.7600, 10.7450], // Airport / Mathur / Gundur
  [78.7100, 10.7250], // Panjappur / Madurai Road
  [78.6500, 10.7450], // Karumandapam / Dindigul Road
  [78.6150, 10.8000], // Vayalur Road / Somarasampettai
  [78.6250, 10.8450], // Woraiyur West
  [78.6400, 10.8700], // Close loop
];

const DEFAULT_APPROVED_PINCODES = [
  '620001', '620002', '620003', '620004', '620005',
  '620006', '620007', '620008', '620009', '620010',
  '620011', '620012', '620013', '620014', '620015',
  '620016', '620017', '620018', '620019', '620020',
  '620021', '620022', '620023', '620024', '620025',
  '620026', '620027',
];

const DEFAULT_APPROVED_LOCALITIES = [
  'Thillai Nagar', 'Cantonment', 'Srirangam', 'Chatram',
  'KK Nagar', 'K.K. Nagar', 'TVS Tollgate', 'Khaja Nagar', 'Puthur',
  'Palakkarai', 'Ponmalai', 'Golden Rock', 'Airport Area',
  'Woraiyur', 'Karumandapam', 'Crawford', 'Ariyamangalam',
  'Kattur', 'Tiruverumbur', 'BHEL Township', 'Vayalur Road',
  'Edamalaipatti Pudur', 'Subramaniyapuram', 'Melur', 'Kallukuzhi',
  'Beemanagar', 'Ramji Nagar', 'Pirattiyur', 'Thiruvanaikoil',
];

/**
 * Standard Ray-Casting algorithm for point-in-polygon verification.
 * point: { lat: number, lng: number }
 * polygonCoordinates: array of [lng, lat] pairs
 */
function isPointInPolygon(point, polygonCoordinates) {
  if (!point || typeof point.lat !== 'number' || typeof point.lng !== 'number') return false;
  if (!Array.isArray(polygonCoordinates) || polygonCoordinates.length < 3) return false;

  const x = point.lng;
  const y = point.lat;
  let inside = false;

  for (let i = 0, j = polygonCoordinates.length - 1; i < polygonCoordinates.length; j = i++) {
    const xi = polygonCoordinates[i][0];
    const yi = polygonCoordinates[i][1];
    const xj = polygonCoordinates[j][0];
    const yj = polygonCoordinates[j][1];

    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function calculateHaversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

let cachedActiveAreas = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60000; // 1 minute in-memory cache

async function getActiveServiceAreas(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedActiveAreas && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedActiveAreas;
  }

  let areas = await ServiceArea.find({ status: 'active' }).lean();
  if (!areas || areas.length === 0) {
    // Auto-bootstrap default Trichy zone
    areas = [await bootstrapDefaultTrichyArea()];
  }

  cachedActiveAreas = areas;
  cacheTimestamp = now;
  return areas;
}

function invalidateServiceAreaCache() {
  cachedActiveAreas = null;
  cacheTimestamp = 0;
}

async function bootstrapDefaultTrichyArea() {
  let area = await ServiceArea.findOne({ code: 'TRICHY_CENTRAL' });
  if (!area) {
    area = await ServiceArea.create({
      name: 'Tiruchirappalli (Trichy) Central Service Area',
      code: 'TRICHY_CENTRAL',
      city: 'Tiruchirappalli',
      aliasCities: ['trichy', 'tiruchirappalli', 'tiruchchirappalli'],
      state: 'Tamil Nadu',
      country: 'India',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      status: 'active',
      isDefault: true,
      boundaryType: 'polygon',
      center: { latitude: 10.8050, longitude: 78.6856 },
      radiusKm: 18,
      polygon: {
        type: 'Polygon',
        coordinates: [DEFAULT_TRICHY_COORDINATES],
      },
      approvedPincodes: DEFAULT_APPROVED_PINCODES,
      approvedLocalities: DEFAULT_APPROVED_LOCALITIES,
      description: 'Exclusive HomeStepIn Tiruchirappalli (Trichy) Urban Service Boundary',
    });
    console.log('[ServiceArea] Bootstrapped default Trichy service area:', area.code);
  }
  return area.toObject ? area.toObject() : area;
}

/**
 * Validates whether a given location (coordinates and/or text) falls inside
 * the active, approved Trichy service area.
 *
 * @param {Object} locationInput
 * @param {number} [locationInput.latitude]
 * @param {number} [locationInput.longitude]
 * @param {string} [locationInput.address]
 * @param {string} [locationInput.city]
 * @param {string} [locationInput.state]
 * @param {string} [locationInput.pincode]
 * @returns {Promise<Object>} { isServiceable, serviceAreaCode, message, validationMethod }
 */
async function validateServiceLocation(locationInput = {}) {
  const activeAreas = await getActiveServiceAreas();
  if (!activeAreas || activeAreas.length === 0) {
    return {
      isServiceable: false,
      serviceAreaCode: null,
      message: OUT_OF_AREA_MESSAGE,
      validationMethod: 'NONE',
    };
  }

  const rawLat = locationInput.latitude !== undefined ? Number(locationInput.latitude) : (locationInput.lat !== undefined ? Number(locationInput.lat) : null);
  const rawLng = locationInput.longitude !== undefined ? Number(locationInput.longitude) : (locationInput.lng !== undefined ? Number(locationInput.lng) : null);
  const hasCoordinates = rawLat !== null && rawLng !== null && !isNaN(rawLat) && !isNaN(rawLng) && (rawLat !== 0 || rawLng !== 0);

  const addressText = `${locationInput.address || ''} ${locationInput.formattedAddress || ''} ${locationInput.line1 || ''} ${locationInput.area || ''}`.toLowerCase();
  const extractedPincode = (addressText.match(/\b(6\d{5})\b/) || [])[1];
  const rawPincode = (locationInput.pincode || locationInput.postalCode || extractedPincode || '').toString().trim();
  const isCityMentioned = addressText.includes('trichy') || addressText.includes('tiruchirappalli');
  const cityText = (locationInput.city || (isCityMentioned ? 'tiruchirappalli' : '')).toLowerCase().trim();
  const stateText = (locationInput.state || (addressText.includes('tamil nadu') ? 'tamil nadu' : '')).toLowerCase().trim();

  for (const area of activeAreas) {
    // 1. Polygon point-in-polygon validation (highest precision)
    if (hasCoordinates) {
      const polyCoords = (area.polygon && area.polygon.coordinates && area.polygon.coordinates[0]) || DEFAULT_TRICHY_COORDINATES;
      const inPolygon = isPointInPolygon({ lat: rawLat, lng: rawLng }, polyCoords);
      if (inPolygon) {
        return {
          isServiceable: true,
          serviceAreaCode: area.code,
          serviceAreaName: area.name,
          city: area.city,
          state: area.state,
          country: area.country,
          message: 'Location is inside HomeStepIn Trichy service area.',
          validationMethod: 'POLYGON',
        };
      }

      // Radius boundary buffer check around area center
      if (area.center && typeof area.center.latitude === 'number') {
        const distKm = calculateHaversineKm(rawLat, rawLng, area.center.latitude, area.center.longitude);
        const maxRadiusKm = area.radiusKm || 18;
        if (distKm <= maxRadiusKm) {
          // If within buffer radius AND mentions Trichy/Tamil Nadu or recognized Trichy pincode
          const isTrichyText = (cityText && (cityText.includes('trichy') || cityText.includes('tiruchirappalli'))) ||
            (rawPincode && area.approvedPincodes && area.approvedPincodes.includes(rawPincode)) ||
            (addressText && (addressText.includes('trichy') || addressText.includes('tiruchirappalli') || addressText.includes('srirangam') || addressText.includes('thillai nagar')));
          if (isTrichyText) {
            return {
              isServiceable: true,
              serviceAreaCode: area.code,
              serviceAreaName: area.name,
              city: area.city,
              state: area.state,
              country: area.country,
              message: 'Location is within HomeStepIn Trichy service buffer.',
              validationMethod: 'RADIUS',
            };
          }
        }
      }

      // If coordinates are clearly outside (e.g. Bangalore, Chennai, Madurai)
      // Point-in-polygon failed and radius failed -> Return out of area
      continue;
    }

    // 2. Fallback text/pincode validation (when manual address is provided without GPS coordinates)
    const isPincodeApproved = rawPincode && area.approvedPincodes && area.approvedPincodes.includes(rawPincode);
    const isCityApproved =
      cityText &&
      (cityText === area.city.toLowerCase() ||
        (area.aliasCities && area.aliasCities.includes(cityText)) ||
        cityText.includes('trichy') ||
        cityText.includes('tiruchirappalli'));
    const isLocalityApproved =
      area.approvedLocalities &&
      area.approvedLocalities.some((loc) => addressText.includes(loc.toLowerCase()));

    // Must be either an approved Trichy pincode, or explicitly state Trichy city with an approved locality
    if (isPincodeApproved || (isCityApproved && isLocalityApproved) || (isCityApproved && (!stateText || stateText.includes('tamil')))) {
      return {
        isServiceable: true,
        serviceAreaCode: area.code,
        serviceAreaName: area.name,
        city: area.city,
        state: area.state,
        country: area.country,
        message: 'Address verified within HomeStepIn Trichy service area.',
        validationMethod: 'PINCODE_OR_LOCALITY',
      };
    }
  }

  // Not in any active service area
  return {
    isServiceable: false,
    serviceAreaCode: null,
    message: OUT_OF_AREA_MESSAGE,
    validationMethod: 'NONE',
  };
}

/**
 * Log an out-of-area registration, address creation, or booking attempt
 * for administrative review and demand analysis.
 */
async function logOutOfAreaAttempt(details = {}) {
  try {
    await OutOfAreaAttempt.create({
      type: details.type || 'BOOKING_ATTEMPT',
      userId: details.userId || null,
      userRole: details.userRole || 'customer',
      userEmail: details.userEmail || null,
      userPhone: details.userPhone || null,
      address: details.address || '',
      city: details.city || '',
      state: details.state || '',
      pincode: details.pincode || '',
      latitude: details.latitude !== undefined ? Number(details.latitude) : null,
      longitude: details.longitude !== undefined ? Number(details.longitude) : null,
      detectedDistanceKm: details.detectedDistanceKm || null,
      reason: details.reason || OUT_OF_AREA_MESSAGE,
      ip: details.ip || null,
      source: details.source || 'MOBILE_APP',
    });
  } catch (err) {
    console.warn('[ServiceArea] Failed to log out-of-area attempt:', err.message);
  }
}

/**
 * Validates that a worker is verified for the Trichy service boundary.
 */
function isWorkerServiceAreaValid(worker) {
  if (!worker) return false;
  const area = String(worker.serviceArea || '').toLowerCase().trim();
  if (!area) return false;
  return (
    area.includes('trichy') ||
    area.includes('tiruchirappalli') ||
    area.includes('central') ||
    DEFAULT_APPROVED_LOCALITIES.some((loc) => area.includes(loc.toLowerCase()))
  );
}

module.exports = {
  OUT_OF_AREA_MESSAGE,
  DEFAULT_TRICHY_COORDINATES,
  DEFAULT_APPROVED_PINCODES,
  DEFAULT_APPROVED_LOCALITIES,
  isPointInPolygon,
  getActiveServiceAreas,
  invalidateServiceAreaCache,
  bootstrapDefaultTrichyArea,
  validateServiceLocation,
  logOutOfAreaAttempt,
  isWorkerServiceAreaValid,
};
