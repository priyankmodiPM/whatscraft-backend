const fs = require('node:fs');
const path = require('node:path');
const { getTrackedImages, findTrackedImage, recordEdits, createDesign } = require('./imageStore');
const expressApi = require('./express/expressApi');
const { buildValueEditId } = require('./interactiveReply');

const TV_PLACEHOLDER_IMAGE_URL = 'https://s7ap1.scene7.com/is/image/healthmonitor/SonyTv?wid=1000';
const TV_MODEL_TITLES = ['Sony Bravia K-75', 'LG UA82 AI', 'Samsung UA4'];
const TV_MODEL_EDITS = { productImage: TV_PLACEHOLDER_IMAGE_URL, oldPrice: 33999, price: 27199 };

function loadOnamDesign() {
  const filePath = process.env.ONAM_DESIGN_FILE || path.join(__dirname, '..', 'data', 'onam-design.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function formatUnknownImageMessage(phoneNumber) {
  const images = getTrackedImages(phoneNumber);
  const list = images.map((image) => `- ${image.name}`).join('\n');
  return `I couldn't find that image. Here's what I have:\n${list}`;
}

async function actionListCampaignGraphics() {
  console.log('[action:list_campaign_graphics]');
  // TODO: fetch from campaign API
  return 'Graphics in your current campaign:\n1. Croma Earbuds';
}

// Create a brand-new creative from a text description (Flow 2.2 — Onam).
// Unlike the catalog designs, this has no Adobe Express document; it is a
// `source: 'local'` design that resolves to canned images (see data/onam-design.json).
async function actionCreateDesign(phoneNumber, { occasion, products, offer } = {}, { sendImage }) {
  const design = loadOnamDesign();
  const productList = Array.isArray(products) && products.length ? products.join(' + ') : (products || 'your products');
  const name = [occasion || 'Festive', productList, 'offer'].filter(Boolean).join(' ');
  console.log('[action:create_design]', { phoneNumber, occasion, products, offer, image: design.images.base });
  createDesign(phoneNumber, { name, design });

  try {
    await sendImage(phoneNumber, design.images.base);
  } catch (err) {
    console.error('[actionCreateDesign] sendImage error', { message: err.message });
    return `I built your ${occasion || 'festive'} design, but couldn't send the image right now — try asking me to resend it.`;
  }

  return `Here you go 🌼 Built with Croma's logo, approved festive colours and the ${productList} images. Want to tweak anything?`;
}

function withCurrentEdits(elements, currentEdits) {
  return elements.map((element) =>
    element.name in currentEdits ? { ...element, value: currentEdits[element.name] } : element
  );
}

const MAX_DISCOUNT_PERCENT = 40;

function isDiscountField(name) {
  return /discount/i.test(name);
}

function parsePercent(value) {
  const match = String(value).match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

const ROUNDING_TOLERANCE_PERCENT = 0.5;

function findOldPriceKey(keys) {
  return keys.find((key) => /^old.?price$/i.test(key));
}

function findNewPriceKey(keys, oldPriceKey) {
  return keys.find((key) => key !== oldPriceKey && /(^|_)price$/i.test(key));
}

// Covers both "discount ko 50% kar do" (GPT computes a price from oldPrice) and a
// direct "set price to X" request — either way, a price drop of more than the cap
// (plus rounding slack for whole-rupee prices) is rejected.
function impliesExcessiveDiscount(mergedEdits, requestedKeys) {
  const keys = Object.keys(mergedEdits);
  const oldPriceKey = findOldPriceKey(keys);
  const newPriceKey = findNewPriceKey(keys, oldPriceKey);
  if (!oldPriceKey || !newPriceKey || !requestedKeys.includes(newPriceKey)) return false;

  const oldPrice = Number(mergedEdits[oldPriceKey]);
  const newPrice = Number(mergedEdits[newPriceKey]);
  if (!Number.isFinite(oldPrice) || oldPrice <= 0 || !Number.isFinite(newPrice)) return false;

  const impliedDiscountPercent = ((oldPrice - newPrice) / oldPrice) * 100;
  return impliedDiscountPercent > MAX_DISCOUNT_PERCENT + ROUNDING_TOLERANCE_PERCENT;
}

// ── Local (canned-image) design helpers — Flow 2.2 ───────────────────────────

function normalizeKey(key) {
  return String(key).toLowerCase().trim().replace(/\s+/g, '_');
}

// Map GPT's free-form edit keys onto the design's canonical slot names via
// aliases, so "background_color" / "colour" / "heading" all resolve correctly.
function canonicalizeEdits(editableSlots, edits) {
  const canonical = {};
  const unknown = [];
  for (const [rawKey, value] of Object.entries(edits || {})) {
    const key = normalizeKey(rawKey);
    const slot = editableSlots.find(
      (s) => normalizeKey(s.name) === key || (s.aliases || []).some((a) => normalizeKey(a) === key)
    );
    if (slot) canonical[slot.name] = value;
    else unknown.push(rawKey);
  }
  return { canonical, unknown };
}

function isPaletteColor(design, value) {
  const v = String(value).trim().toLowerCase();
  return (design.palette || []).some((c) => c.name.toLowerCase() === v || c.hex.toLowerCase() === v);
}

function hasMalayalam(value) {
  return /[ഀ-ൿ]/.test(String(value));
}

// Pick the canned image for the current accumulated edit state.
function resolveLocalImage(design, currentEdits) {
  const values = Object.values(currentEdits);
  if (values.some(hasMalayalam)) return design.images.malayalam;
  if (currentEdits.background || currentEdits.address) return design.images.final;
  return design.images.base;
}

function localEditElements(image) {
  return image.design.slots.editable.map((slot) => ({
    name: slot.name,
    type: slot.type || 'text',
    value: image.currentEdits[slot.name] ?? '',
  }));
}

async function editLocalDesign(phoneNumber, image, rawEdits, { sendImage }) {
  const design = image.design;
  const editableSlots = design.slots.editable;
  const { canonical: edits, unknown } = canonicalizeEdits(editableSlots, rawEdits);

  if (unknown.length > 0) {
    const editableNames = editableSlots.map((s) => s.name).join(', ');
    return `I can't edit ${unknown.join(', ')} on "${image.name}" — those are locked by HQ. You can change: ${editableNames}.`;
  }

  if ('background' in edits && !isPaletteColor(design, edits.background)) {
    const options = design.palette.map((c) => c.name).join(' · ');
    return `"${edits.background}" isn't in the approved palette 🙂 Here are the festive accents you can pick from: ${options}`;
  }

  recordEdits(phoneNumber, image.id, edits);
  const currentEdits = { ...image.currentEdits, ...edits };
  const imageUrl = resolveLocalImage(design, currentEdits);
  console.log('[edit:local] resolved image', { imageId: image.id, currentEdits, imageUrl });

  const summary = Object.entries(edits).map(([key, value]) => `• ${key}: ${value}`).join('\n');

  try {
    await sendImage(phoneNumber, imageUrl);
  } catch (err) {
    console.error('[editLocalDesign] sendImage error', { imageId: image.id, message: err.message });
    return `Updated "${image.name}", but I couldn't send the image right now — try asking me to resend it.`;
  }

  return `Updated "${image.name}":\n${summary}`;
}

async function actionCheckAllowedEdits(phoneNumber, imageId) {
  const image = findTrackedImage(phoneNumber, imageId);
  console.log('[action:check_allowed_edits]', { phoneNumber, imageId, source: image?.source ?? 'not_found' });
  if (!image) {
    return formatUnknownImageMessage(phoneNumber);
  }

  if (image.source === 'local') {
    const elements = localEditElements(image);
    return {
      type: 'edit_options',
      bodyText: 'What would you like to change?',
      options: expressApi.buildEditOptions(elements, imageId),
      historyText: expressApi.formatAllowedEdits(image.name, elements),
    };
  }

  try {
    const doc = await expressApi.getTaggedDocument(image.docId);
    const elements = expressApi.collectTaggedElements(doc);
    const elementsWithCurrentEdits = withCurrentEdits(elements, image.currentEdits);
    return {
      type: 'edit_options',
      bodyText: 'What would you like to change?',
      options: expressApi.buildEditOptions(elementsWithCurrentEdits, imageId),
      historyText: expressApi.formatAllowedEdits(image.name, elementsWithCurrentEdits),
    };
  } catch (err) {
    console.error('[actionCheckAllowedEdits] Express API error', { docId: image.docId, message: err.message });
    return `Sorry, I couldn't check the allowed edits for "${image.name}" right now. Please try again in a moment.`;
  }
}

function actionSelectTvModel(imageId) {
  return {
    type: 'edit_options',
    bodyText: 'Which model would you like to use?',
    options: TV_MODEL_TITLES.map((title) => ({
      id: buildValueEditId(imageId, TV_MODEL_EDITS),
      title,
    })),
  };
}

// Routes to the right edit path based on where the design came from:
//   source: 'local'   → canned-image design (Flow 2.2), no Express calls
//   source: 'express' → real Adobe Express-backed catalog design (Flow 2.1)
async function actionEditGraphic(phoneNumber, imageId, edits, { sendImage }) {
  const image = findTrackedImage(phoneNumber, imageId);
  console.log('[action:edit_graphic]', { phoneNumber, imageId, source: image?.source ?? 'not_found', edits });
  if (!image) {
    return formatUnknownImageMessage(phoneNumber);
  }

  if (image.source === 'local') {
    return editLocalDesign(phoneNumber, image, edits, { sendImage });
  }
  return editExpressDesign(phoneNumber, image, edits, { sendImage });
}

async function editExpressDesign(phoneNumber, image, edits, { sendImage }) {
  let elements;
  try {
    const doc = await expressApi.getTaggedDocument(image.docId);
    elements = expressApi.collectTaggedElements(doc);
  } catch (err) {
    console.error('[editExpressDesign] Express API error', { docId: image.docId, message: err.message });
    return { status: 'api_error', productName: image.name, reason: 'lookup_failed' };
  }

  const allowedNames = elements.map((element) => element.name);
  const requestedKeys = Object.keys(edits || {});
  const disallowedKeys = requestedKeys.filter((key) => !allowedNames.includes(key));

  if (disallowedKeys.length > 0) {
    const elementsWithCurrentEdits = withCurrentEdits(elements, image.currentEdits);
    return {
      status: 'disallowed_fields',
      productName: image.name,
      disallowedKeys,
      allowedSummary: expressApi.formatAllowedEdits(image.name, elementsWithCurrentEdits),
    };
  }

  const oversizedDiscountKeys = requestedKeys.filter((key) => {
    if (!isDiscountField(key)) return false;
    const percent = parsePercent(edits[key]);
    return percent !== null && percent > MAX_DISCOUNT_PERCENT;
  });

  const mergedEdits = { ...image.currentEdits, ...edits };

  if (oversizedDiscountKeys.length > 0 || impliesExcessiveDiscount(mergedEdits, requestedKeys)) {
    return { status: 'discount_capped', productName: image.name, maxPercent: MAX_DISCOUNT_PERCENT };
  }

  const pages = expressApi.pagesForEdits(elements, Object.keys(mergedEdits));
  const preferredDocumentName = expressApi.buildPreferredDocumentName(image.name);

  let thumbnailUrl;
  try {
    const { statusUrl } = await expressApi.generateVariation(image.docId, mergedEdits, pages, preferredDocumentName);
    const result = await expressApi.pollJobStatus(statusUrl);
    thumbnailUrl = result.document.thumbnailUrl;
    console.log('[edit:express] resolved image', { imageId: image.id, docId: image.docId, thumbnailUrl });
  } catch (err) {
    console.error('[editExpressDesign] generate/poll error', { docId: image.docId, message: err.message });
    return { status: 'api_error', productName: image.name, reason: 'generate_failed' };
  }

  recordEdits(phoneNumber, image.id, edits);

  try {
    await sendImage(phoneNumber, thumbnailUrl);
  } catch (err) {
    console.error('[editExpressDesign] sendImage error', { docId: image.docId, message: err.message });
    return { status: 'delivery_failed', productName: image.name, changes: edits };
  }

  return { status: 'success', productName: image.name, changes: edits };
}

async function actionGenerateBulkGraphics(filename) {
  console.log('[action:generate_bulk_graphics]', { filename });
  // TODO: parse CSV/Excel and call Adobe Express API per row
  return `Bulk generation complete! Graphics created from ${filename || 'your uploaded file'}.`;
}

module.exports = {
  actionListCampaignGraphics,
  actionCreateDesign,
  actionCheckAllowedEdits,
  actionEditGraphic,
  actionGenerateBulkGraphics,
  actionSelectTvModel,
};
