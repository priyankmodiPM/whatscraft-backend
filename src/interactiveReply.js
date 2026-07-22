// Edit option button/list-row ids are `edit:${imageId}:${fieldName}` (see
// expressApi.buildEditOptions). Parse that back out so a tap can tell GPT exactly
// which image and field the user picked, instead of only the truncated button title.
function parseEditOptionId(id) {
  if (typeof id !== 'string' || !id.startsWith('edit:')) return null;
  const rest = id.slice('edit:'.length);
  const separatorIndex = rest.indexOf(':');
  if (separatorIndex === -1) return null;
  return { imageId: rest.slice(0, separatorIndex), fieldName: rest.slice(separatorIndex + 1) };
}

function messageTextForInteractiveReply(reply) {
  const parsed = parseEditOptionId(reply.id);
  if (!parsed) return reply.title;
  return `I'd like to change "${parsed.fieldName}" on image ${parsed.imageId}.`;
}

module.exports = { parseEditOptionId, messageTextForInteractiveReply };
