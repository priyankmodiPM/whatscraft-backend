// ── Flow 1: Adobe Express-backed catalog designs (image.source === 'express') ─
// Real Adobe Express API: read the tagged document, validate edits against the
// live tagged elements, generate a variation, poll, and send the rendered image.
//
// Self-contained: this module must NOT depend on the local/canned flow. It is
// reached only via the router in actions.js for images whose source is 'express'.

const { recordEdits } = require('./imageStore');
const expressApi = require('./express/expressApi');
const { buildValueEditId } = require('./interactiveReply');
const { buildEditOptions, formatAllowedEdits } = require('./editOptions');

// A "change the product to a TV" request offers 3 fixed models as quick replies.
const TV_PLACEHOLDER_IMAGE_URL = 'https://s7ap1.scene7.com/is/image/healthmonitor/SonyTv?wid=1000';
const TV_MODEL_TITLES = ['Sony Bravia K-75', 'LG UA82 AI', 'Samsung UA4'];
const TV_MODEL_EDITS = { productImage: TV_PLACEHOLDER_IMAGE_URL, oldPrice: 33999, price: 27199 };

const MAX_DISCOUNT_PERCENT = 40;

function withCurrentEdits(elements, currentEdits) {
  return elements.map((element) =>
    element.name in currentEdits ? { ...element, value: currentEdits[element.name] } : element
  );
}

function isDiscountField(name) {
  return /discount/i.test(name);
}

function parsePercent(value) {
  const match = String(value).match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

// TV model picker — each option id encodes the full productImage/price edits so a
// tap tells GPT exactly what to apply (see interactiveReply.buildValueEditId).
function selectTvModel(imageId) {
  return {
    type: 'edit_options',
    bodyText: 'Which model would you like to use?',
    options: TV_MODEL_TITLES.map((title) => ({
      id: buildValueEditId(imageId, TV_MODEL_EDITS),
      title,
    })),
  };
}

// What can be edited? — reads the live tagged document from Adobe Express.
async function checkAllowedEdits(image) {
  try {
    const doc = await expressApi.getTaggedDocument(image.docId);
    const elements = expressApi.collectTaggedElements(doc);
    const elementsWithCurrentEdits = withCurrentEdits(elements, image.currentEdits);
    return {
      type: 'edit_options',
      bodyText: 'What would you like to change?',
      options: buildEditOptions(elementsWithCurrentEdits, image.id),
      historyText: formatAllowedEdits(image.name, elementsWithCurrentEdits),
    };
  } catch (err) {
    console.error('[expressFlow.checkAllowedEdits] Express API error', { docId: image.docId, message: err.message });
    return `Sorry, I couldn't check the allowed edits for "${image.name}" right now. Please try again in a moment.`;
  }
}

// Apply edits via the real Adobe Express generate-variation pipeline.
async function editGraphic(phoneNumber, image, edits, { sendImage, sendText }) {
  let elements;
  try {
    const doc = await expressApi.getTaggedDocument(image.docId);
    elements = expressApi.collectTaggedElements(doc);
  } catch (err) {
    console.error('[expressFlow.editGraphic] Express API error', { docId: image.docId, message: err.message });
    return `Sorry, I couldn't reach Adobe Express to apply that edit. Please try again in a moment.`;
  }

  const allowedNames = elements.map((element) => element.name);
  const requestedKeys = Object.keys(edits || {});
  const disallowedKeys = requestedKeys.filter((key) => !allowedNames.includes(key));

  if (disallowedKeys.length > 0) {
    const elementsWithCurrentEdits = withCurrentEdits(elements, image.currentEdits);
    return `I can't edit ${disallowedKeys.join(', ')} on "${image.name}". ${formatAllowedEdits(image.name, elementsWithCurrentEdits)}`;
  }

  const oversizedDiscountKeys = requestedKeys.filter((key) => {
    if (!isDiscountField(key)) return false;
    const percent = parsePercent(edits[key]);
    return percent !== null && percent > MAX_DISCOUNT_PERCENT;
  });

  if (oversizedDiscountKeys.length > 0) {
    return `The maximum discount I can apply on "${image.name}" is ${MAX_DISCOUNT_PERCENT}%. Try again with ${MAX_DISCOUNT_PERCENT}% or less.`;
  }

  if (typeof sendText === 'function') await sendText(phoneNumber, '⏳ Applying your edit and re-rendering with Adobe Express…');

  const mergedEdits = { ...image.currentEdits, ...edits };
  const pages = expressApi.pagesForEdits(elements, Object.keys(mergedEdits));
  const preferredDocumentName = expressApi.buildPreferredDocumentName(image.name);

  let thumbnailUrl;
  try {
    const { statusUrl } = await expressApi.generateVariation(image.docId, mergedEdits, pages, preferredDocumentName);
    const result = await expressApi.pollJobStatus(statusUrl);
    thumbnailUrl = result.document.thumbnailUrl;
    console.log('[edit:express] resolved image', { imageId: image.id, docId: image.docId, thumbnailUrl });
  } catch (err) {
    console.error('[expressFlow.editGraphic] generate/poll error', { docId: image.docId, message: err.message });
    return `Sorry, something went wrong generating your updated "${image.name}". Please try again.`;
  }

  recordEdits(phoneNumber, image.id, edits);

  const summary = Object.entries(edits).map(([key, value]) => `• ${key}: ${value}`).join('\n');

  try {
    await sendImage(phoneNumber, thumbnailUrl);
  } catch (err) {
    console.error('[expressFlow.editGraphic] sendImage error', { docId: image.docId, message: err.message });
    return `Updated "${image.name}", but I couldn't send the image right now — try asking me to resend it.`;
  }

  return `Updated "${image.name}":\n${summary}`;
}

module.exports = { selectTvModel, checkAllowedEdits, editGraphic, MAX_DISCOUNT_PERCENT };
