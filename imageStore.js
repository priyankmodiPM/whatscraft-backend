const SEED_IMAGES = [
  { id: 'img_1', name: 'Diwali Offer Banner', templateId: 'tpl_diwali' },
  { id: 'img_2', name: 'Summer Sale Flyer', templateId: 'tpl_summer' },
  { id: 'img_3', name: 'New Arrival Poster', templateId: 'tpl_newarrival' },
];

const trackedImages = new Map();

function getTrackedImages(phoneNumber) {
  if (!trackedImages.has(phoneNumber)) {
    trackedImages.set(
      phoneNumber,
      SEED_IMAGES.map((image) => ({ ...image, currentEdits: {} }))
    );
  }
  return trackedImages.get(phoneNumber);
}

function findTrackedImage(phoneNumber, imageId) {
  return getTrackedImages(phoneNumber).find((image) => image.id === imageId);
}

module.exports = { getTrackedImages, findTrackedImage };
