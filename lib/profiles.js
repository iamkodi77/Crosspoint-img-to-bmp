/**
 * Device profiles for Xteink e-readers running CrossPoint firmware.
 *
 * The panel geometry below is what the firmware's image decoder expects.
 * CrossPoint never scales an image: a BMP that is not exactly the panel size
 * is shown with white borders (or cropped), so every export is written at the
 * exact pixel dimensions listed here.
 *
 *   X3      : 3.7" E Ink, 528 x 792, 259 ppi  (portrait)
 *   X4      : 4.3" E Ink, 480 x 800, 220 ppi  (portrait)
 *   X4 Pro  : 4.3" E Ink, 480 x 800, 219 ppi  (portrait)
 *
 * Native orientation is portrait on all three, which is how CrossPoint draws
 * sleep screens and the image viewer.
 */

/** @typedef {{id:string,name:string,short:string,width:number,height:number,ppi:number,size:string,note:string,grays:number}} Profile */

/** @type {Profile[]} */
export const PROFILES = [
  {
    id: 'x3',
    name: 'Xteink X3',
    short: 'X3',
    width: 528,
    height: 792,
    ppi: 259,
    size: '3.7"',
    grays: 4,
    note: 'Smallest panel — 528 × 792. Never reuse an X4 file here.',
  },
  {
    id: 'x4',
    name: 'Xteink X4',
    short: 'X4',
    width: 480,
    height: 800,
    ppi: 220,
    size: '4.3"',
    grays: 4,
    note: 'X4 and X4 Classic share the same 480 × 800 panel.',
  },
  {
    id: 'x4pro',
    name: 'Xteink X4 Pro',
    short: 'X4 Pro',
    width: 480,
    height: 800,
    ppi: 219,
    size: '4.3"',
    grays: 4,
    note: 'Touch + front light. Same 480 × 800 output as the X4.',
  },
];

export const DEFAULT_PROFILE_ID = 'x4';

/**
 * Look up a profile by id. Unknown ids fall back to the X4 so a stale saved
 * setting can never break an export.
 * @param {string} id
 * @returns {Profile}
 */
export function getProfile(id) {
  return PROFILES.find((p) => p.id === id) || PROFILES.find((p) => p.id === DEFAULT_PROFILE_ID);
}

/**
 * Map the `device` field of CrossPoint's `GET /api/status` response to a
 * profile. The firmware reports "X3" or "X4" hardware detection; the X4 Pro
 * reports as X4 because the panel is identical.
 * @param {string} device
 * @returns {Profile}
 */
export function profileFromDeviceField(device) {
  const value = String(device || '').trim().toUpperCase();
  if (value.startsWith('X3')) return getProfile('x3');
  if (value.startsWith('X4PRO') || value.startsWith('X4 PRO')) return getProfile('x4pro');
  if (value.startsWith('X4')) return getProfile('x4');
  return getProfile(DEFAULT_PROFILE_ID);
}

/**
 * Size in bytes of the encoded file for a profile and format, without
 * encoding it. Handy for the "what will this weigh" readout.
 * @param {number} width
 * @param {number} height
 * @param {'bmp24'|'bmp2'|'bmp1'} format
 */
export function encodedSize(width, height, format) {
  const rowBytes = (bitsPerPixel) => {
    const raw = Math.ceil((width * bitsPerPixel) / 8);
    return (raw + 3) & ~3;
  };
  if (format === 'bmp1') return 14 + 40 + 2 * 4 + rowBytes(1) * height;
  if (format === 'bmp2') return 14 + 40 + 4 * 4 + rowBytes(2) * height;
  return 14 + 40 + rowBytes(24) * height;
}
