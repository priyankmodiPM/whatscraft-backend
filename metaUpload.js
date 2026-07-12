const { randomUUID } = require('node:crypto');

async function uploadImageToMeta(renderedImageUrl) {
  return `https://mock-meta-cdn.local/media/${randomUUID()}.png`;
}

module.exports = { uploadImageToMeta };
