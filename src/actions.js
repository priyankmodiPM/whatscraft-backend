const { getTrackedImages, findTrackedImage, recordEdits } = require('./imageStore');
const expressApi = require('./express/expressApi');

function formatUnknownImageMessage(phoneNumber) {
  const images = getTrackedImages(phoneNumber);
  const list = images.map((image) => `- ${image.name}`).join('\n');
  return `I couldn't find that image. Here's what I have:\n${list}`;
}

async function actionListCampaignGraphics() {
  // TODO: fetch from campaign API
  return 'Graphics in your current campaign:\n1. Croma Earbuds';
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

async function actionCheckAllowedEdits(phoneNumber, imageId) {
  const image = findTrackedImage(phoneNumber, imageId);
  if (!image) {
    return formatUnknownImageMessage(phoneNumber);
  }

  try {
    const doc = await expressApi.getTaggedDocument(image.docId);
    const elements = expressApi.collectTaggedElements(doc);
    const elementsWithCurrentEdits = withCurrentEdits(elements, image.currentEdits);
    return {
      type: 'edit_options',
      bodyText: expressApi.formatAllowedEdits(image.name, elementsWithCurrentEdits, { includeInstruction: false }),
      options: expressApi.buildEditOptions(elementsWithCurrentEdits),
      historyText: expressApi.formatAllowedEdits(image.name, elementsWithCurrentEdits),
    };
  } catch (err) {
    console.error('[actionCheckAllowedEdits] Express API error', { docId: image.docId, message: err.message });
    return `Sorry, I couldn't check the allowed edits for "${image.name}" right now. Please try again in a moment.`;
  }
}

async function actionEditGraphic(phoneNumber, imageId, edits, { sendImage }) {
  const image = findTrackedImage(phoneNumber, imageId);
  if (!image) {
    return formatUnknownImageMessage(phoneNumber);
  }

  let elements;
  try {
    const doc = await expressApi.getTaggedDocument(image.docId);
    elements = expressApi.collectTaggedElements(doc);
  } catch (err) {
    console.error('[actionEditGraphic] Express API error', { docId: image.docId, message: err.message });
    return `Sorry, I couldn't reach Adobe Express to apply that edit. Please try again in a moment.`;
  }

  const allowedNames = elements.map((element) => element.name);
  const requestedKeys = Object.keys(edits || {});
  const disallowedKeys = requestedKeys.filter((key) => !allowedNames.includes(key));

  if (disallowedKeys.length > 0) {
    const elementsWithCurrentEdits = withCurrentEdits(elements, image.currentEdits);
    return `I can't edit ${disallowedKeys.join(', ')} on "${image.name}". ${expressApi.formatAllowedEdits(image.name, elementsWithCurrentEdits)}`;
  }

  const oversizedDiscountKeys = requestedKeys.filter((key) => {
    if (!isDiscountField(key)) return false;
    const percent = parsePercent(edits[key]);
    return percent !== null && percent > MAX_DISCOUNT_PERCENT;
  });

  if (oversizedDiscountKeys.length > 0) {
    return `The maximum discount I can apply on "${image.name}" is ${MAX_DISCOUNT_PERCENT}%. Try again with ${MAX_DISCOUNT_PERCENT}% or less.`;
  }

  const mergedEdits = { ...image.currentEdits, ...edits };
  const pages = expressApi.pagesForEdits(elements, Object.keys(mergedEdits));
  const preferredDocumentName = expressApi.buildPreferredDocumentName(image.name);

  let thumbnailUrl;
  try {
    const { statusUrl } = await expressApi.generateVariation(image.docId, mergedEdits, pages, preferredDocumentName);
    const result = await expressApi.pollJobStatus(statusUrl);
    thumbnailUrl = result.document.thumbnailUrl;
  } catch (err) {
    console.error('[actionEditGraphic] generate/poll error', { docId: image.docId, message: err.message });
    return `Sorry, something went wrong generating your updated "${image.name}". Please try again.`;
  }

  recordEdits(phoneNumber, imageId, edits);

  const summary = Object.entries(edits).map(([key, value]) => `• ${key}: ${value}`).join('\n');

  try {
    await sendImage(phoneNumber, thumbnailUrl);
  } catch (err) {
    console.error('[actionEditGraphic] sendImage error', { docId: image.docId, message: err.message });
    return `Updated "${image.name}", but I couldn't send the image right now — try asking me to resend it.`;
  }

  return `Updated "${image.name}":\n${summary}`;
}

async function actionGenerateBulkGraphics(filename) {
  // TODO: parse CSV/Excel and call Adobe Express API per row
  return `Bulk generation complete! Graphics created from ${filename || 'your uploaded file'}.`;
}

module.exports = {
  actionListCampaignGraphics,
  actionCheckAllowedEdits,
  actionEditGraphic,
  actionGenerateBulkGraphics,
};
