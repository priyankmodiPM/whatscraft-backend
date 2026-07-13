const TEMPLATE_LAYERS = {
  tpl_diwali: ['discount_text', 'headline', 'background_color'],
  tpl_summer: ['headline', 'font_color'],
  tpl_croma_earbuds: ['Price', 'Address', 'Product Image', 'Partner Logo'],
};

function getTemplateInfo(templateId) {
  return {
    templateId,
    unlockedLayers: TEMPLATE_LAYERS[templateId] || [],
  };
}

let renderRevision = 0;

function applyEdit(templateId, currentEdits, newEdits) {
  const mergedEdits = { ...currentEdits, ...newEdits };
  renderRevision += 1;
  return {
    mergedEdits,
    renderedImageUrl: `https://mock-express.local/render/${templateId}?rev=${renderRevision}`,
  };
}

module.exports = { getTemplateInfo, applyEdit };
