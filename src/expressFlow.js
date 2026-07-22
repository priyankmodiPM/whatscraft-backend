// ── Flow 1: Adobe Express-backed catalog designs (image.source === 'express') ─
// Real Adobe Express API: read the tagged document, validate edits against the
// live tagged elements, generate a variation, poll, and hand back a structured
// outcome for the caller (app.js) to phrase, deliver, and follow up on.
//
// Self-contained: this module must NOT depend on the local/canned flow. It is
// reached only via the router in actions.js for images whose source is 'express'.

const { recordEdits } = require('./imageStore');
const expressApi = require('./express/expressApi');
const { buildValueEditId } = require('./interactiveReply');
const { formatAllowedEdits } = require('./editOptions');

// A "change the product to a TV" request offers 3 fixed models as quick replies.
//
// Must be a pre-signed URL on a domain Adobe's generate-variation API accepts for
// image tagMappings — AWS S3, Dropbox, or Azure (windows.net) only (see
// VariationDetails.tagMappings in the Express API spec). A Scene7 CDN URL was used
// here previously and Adobe rejected it, since scene7.com isn't an allowed domain.
// This S3 URL is itself pre-signed and expires (~12h from generation on 2026-07-22)
// — it will need to be regenerated/replaced before then to keep working.
const TV_PLACEHOLDER_IMAGE_URL = 'https://pmodi2.s3.us-west-1.amazonaws.com/SonyTv.png?response-content-disposition=inline&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Security-Token=IQoJb3JpZ2luX2VjEBUaCXVzLXdlc3QtMSJHMEUCIAR%2BhaDDo11C4l%2BTaARgAfjNmrzEI4Odss6xvwmkN7pSAiEA8WvY0XqBgrvf97l8oq2vXo9wzPcVOTB%2FmhhOljmHp%2FgqhQQI3v%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FARAAGgw3ODU4OTAyNjg3MjQiDAa0WPLo6XDtvyGwYSrZA%2F91LMmqkGuC97Gp1YGw35bNLB1ci0qtqw8DOy%2BNsRyehXLhxaN3H5uifrQunTBrfC9jYEt5IGonDgnatWKi3rSOO2%2BPioo7FamZyIbroeniI%2BMy8mdV9wYCHQweXb3w6YD2eGxAXvDUxGLMnDL60ZAZ4DrcL5o%2BmtMOMvQi6brBdODM5k8YxRDMhnBb1gT4h%2FVuBO67na7LdNwDnx%2BY7Q4Dl4xbYHbrieEl9FRXHk%2Fd4v4rVWCVynJPgmL7m%2B4qwmKJjfX4aeHFt8criBiJzqcaTJdL1UzZsIeqf3icwvHIabvlmCigoHBBLykfuRm6HLkY1onUoh1z0YC5otVgQmss0nz73L4jHwaKIQSLgQDm%2B%2BUwfljiYfz1A8Pfbf5OObziWY%2F4L11qqJzrE0QPanFPaUGdZHbsxBz88JhHtUos61sZ4CPWMrpgLYElxupxegfzE45MXTWqWzIHoqPQlok%2B5137knQLH1VzLoTlS%2BeWg5jADKIWARAbOz2SeaXQ9GoIyZvFVK0%2FJSk1FeWdLRnrabUY%2Bp%2Ba0df6n%2BaS1fQdW2baqPbE%2FzSXOYplregbzUNrPimfWVyb%2BFLt3q5D2qFpAql4BVyZQdH6cT6PNMytziUIkkCZSO6yMOLLhNMGOrcCOM8ML%2FbFF6E9GCVwCIDLfS89AoYr56a9l%2B9FaySJurH%2Fp9hwJ9TvlbLMxZObFZ8LenJhGuk77S%2FlJ2XIl3kpnDkLvmLCP%2BY3ivrmiQxnJigA4k4PiA0cosefbL%2BrzkxiPzUz%2FEh5owO84yCDpGwHlcyz6FggHY8DZY8CNcHnOPG9WWLwl54vxUfsrQ336hzyFQu5Qv1JvXi8MXWexWXziP%2BUemQY5HIUpw2IzrD%2Fl5FDR2KV5TwNhx8RhFJd1YOoi9eJwSyIh2486KVNxLyvkpWLsELNbYfWKo%2Fk7kmWGsTVHzK6I2FWEjRUvwRC2hzilUmMfb08QFdcBAohTW6fc%2BiEzRr1abFFLFKXCxxPnDXEhNltBC3FBYyu%2BXrIK6bqglLBgftc7LbSa1w1HnsLd7iEOqgaRL8%3D&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIA3N6VV2Y2GFNDGC7T%2F20260722%2Fus-west-1%2Fs3%2Faws4_request&X-Amz-Date=20260722T202201Z&X-Amz-Expires=43200&X-Amz-SignedHeaders=host&X-Amz-Signature=95c3bb1f62907709e9d559fb3c6dd6ab1467f85044c74671a9d071a7cf31e199';
const TV_MODEL_TITLES = ['Sony Bravia K-75', 'LG UA82 AI', 'Samsung UA4'];

// The real S3 URL above is ~1700 chars — WhatsApp interactive list rows cap `id` at
// 200 chars (#131009 "Row id is too long"), and buildValueEditId round-trips the
// full edits object through both the row id and (via GPT) the synthetic message
// text. So the *encoded* edits carry this short token instead of the real URL; it's
// expanded back to TV_PLACEHOLDER_IMAGE_URL in editGraphic before anything is sent
// to the Express API.
const TV_PLACEHOLDER_IMAGE_TOKEN = 'tv-model-image-placeholder';
const TV_MODEL_EDITS = { productImage: TV_PLACEHOLDER_IMAGE_TOKEN, oldPrice: 33999, price: 27199 };

function expandPlaceholderEdits(edits) {
  if (edits && edits.productImage === TV_PLACEHOLDER_IMAGE_TOKEN) {
    return { ...edits, productImage: TV_PLACEHOLDER_IMAGE_URL };
  }
  return edits;
}

function formatINR(amount) {
  return Number(amount).toLocaleString('en-IN');
}

// The success caption for img_1 (Croma Diwali offer) — a fixed festive template
// rather than a GPT-phrased one-liner, so the banner's own promo copy carries
// through into the message text. Falls back to the TV_MODEL_EDITS constants for
// price/oldPrice when an edit (e.g. a lone "change price" request) hasn't gone
// through selectTvModel, so both are always populated.
function buildDiwaliOfferCaption({ price, oldPrice } = {}) {
  const displayPrice = formatINR(price ?? TV_MODEL_EDITS.price);
  const displayOldPrice = formatINR(oldPrice ?? TV_MODEL_EDITS.oldPrice);

  return `🪔✨ DIWALI DHAMAKA OFFER! ✨🪔

🎉 Upgrade your viewing experience this festive season with an amazing deal on the Sony Bravia K-75!

💥 Special Festive Price: ₹${displayPrice}
Regular Price: ₹${displayOldPrice}

✅ Trusted Sony Quality
✅ Limited Period Diwali Offer
✅ Great Savings for Your Family

📞 Contact us today or visit our store before the offer ends!

🎁 Hurry! Stocks are limited. Grab this festive deal now! 🛍️✨`;
}

const MAX_DISCOUNT_PERCENT = 40;
const ROUNDING_TOLERANCE_PERCENT = 0.5;

// Express-catalog graphics always show this fixed 3-option menu rather than a
// per-document field list; tapping one produces a bare "product"/"discount"/
// "price" field id via the existing interactive-reply scheme (interactiveReply.js).
const TOP_LEVEL_EDIT_FIELDS = [
  { fieldName: 'product', title: '🛍️ Edit Product' },
  { fieldName: 'discount', title: '🏷️ Edit Discount' },
  { fieldName: 'price', title: '💰 Edit Price' },
];

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

// TV model picker — each option id encodes the full productImage/price edits so a
// tap tells GPT exactly what to apply (see interactiveReply.buildValueEditId). All 3
// models share the same placeholder edits, so the title is passed as a discriminator
// to keep the 3 row ids unique — WhatsApp rejects list messages with duplicate row ids.
// Presented as a WhatsApp list (buttonText set) rather than reply buttons.
function selectTvModel(imageId) {
  return {
    type: 'edit_options',
    bodyText: 'Which product do you want?',
    buttonText: 'Choose product',
    options: TV_MODEL_TITLES.map((title) => ({
      id: buildValueEditId(imageId, TV_MODEL_EDITS, title),
      title,
    })),
  };
}

function buildTopLevelEditOptions(imageId) {
  return {
    type: 'edit_options',
    bodyText: 'What would you like to change?',
    options: TOP_LEVEL_EDIT_FIELDS.map(({ fieldName, title }) => ({
      id: `edit:${imageId}:${fieldName}`,
      title,
    })),
    historyText: 'What would you like to change? (Edit Product / Edit Discount / Edit Price)',
  };
}

// What can be edited? — the menu is fixed and doesn't depend on document
// contents, so no Express API call is needed here.
async function checkAllowedEdits(image) {
  return buildTopLevelEditOptions(image.id);
}

// Apply edits via the real Adobe Express generate-variation pipeline. Returns a
// structured outcome — never sends the image itself — so the caller (app.js) can
// phrase the final reply (matching the user's language) and deliver the image
// with that phrasing as its caption in one message.
async function editGraphic(phoneNumber, image, edits, { sendText } = {}) {
  edits = expandPlaceholderEdits(edits);

  let elements;
  try {
    const doc = await expressApi.getTaggedDocument(image.docId);
    elements = expressApi.collectTaggedElements(doc);
  } catch (err) {
    console.error('[expressFlow.editGraphic] Express API error', { docId: image.docId, message: err.message });
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
      allowedSummary: formatAllowedEdits(image.name, elementsWithCurrentEdits),
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

  if (typeof sendText === 'function') await sendText(phoneNumber, '⏳ Applying your edit and re-rendering with Adobe Express…');

  const pages = expressApi.pagesForEdits(elements, Object.keys(mergedEdits));
  const preferredDocumentName = expressApi.buildPreferredDocumentName(image.name);

  // Tagged text elements always hold string values (see getTaggedDocument), and
  // Adobe's generate-variation API rejects a JSON number for a text tag with
  // "Unsupported text value for tag: <name>" (422) — so numeric edits like price/
  // oldPrice must be sent as strings even though they're computed as numbers.
  const tagMappings = Object.fromEntries(
    Object.entries(mergedEdits).map(([key, value]) => [key, String(value)])
  );

  let thumbnailUrl;
  try {
    const { statusUrl } = await expressApi.generateVariation(image.docId, tagMappings, pages, preferredDocumentName);
    const result = await expressApi.pollJobStatus(statusUrl);
    thumbnailUrl = result.document.thumbnailUrl;
    console.log('[edit:express] resolved image', { imageId: image.id, docId: image.docId, thumbnailUrl });
  } catch (err) {
    console.error('[expressFlow.editGraphic] generate/poll error', { docId: image.docId, message: err.message });
    return { status: 'api_error', productName: image.name, reason: 'generate_failed' };
  }

  recordEdits(phoneNumber, image.id, edits);

  const outcome = { status: 'success', productName: image.name, changes: edits, thumbnailUrl };
  if (mergedEdits.price !== undefined) outcome.price = mergedEdits.price;
  if (mergedEdits.oldPrice !== undefined) outcome.oldPrice = mergedEdits.oldPrice;
  return outcome;
}

module.exports = {
  selectTvModel,
  checkAllowedEdits,
  editGraphic,
  buildTopLevelEditOptions,
  buildDiwaliOfferCaption,
  MAX_DISCOUNT_PERCENT,
  TV_PLACEHOLDER_IMAGE_URL,
  TV_PLACEHOLDER_IMAGE_TOKEN,
};
