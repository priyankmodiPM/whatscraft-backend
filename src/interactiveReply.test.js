const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEditOptionId, messageTextForInteractiveReply } = require('./interactiveReply');

test('parseEditOptionId parses a bare field-only id', () => {
  const parsed = parseEditOptionId('edit:img_1:heading');
  assert.deepEqual(parsed, { imageId: 'img_1', fieldName: 'heading' });
});

test('parseEditOptionId returns null for an id with no edit: prefix', () => {
  assert.equal(parseEditOptionId('something_else'), null);
});

test('parseEditOptionId returns null for an id missing the field separator', () => {
  assert.equal(parseEditOptionId('edit:img_1'), null);
});

test('parseEditOptionId returns null for a non-string id', () => {
  assert.equal(parseEditOptionId(undefined), null);
});

test('messageTextForInteractiveReply builds a change-field message for a bare field id', () => {
  const text = messageTextForInteractiveReply({ id: 'edit:img_1:heading', title: 'Change heading' });
  assert.equal(text, 'I\'d like to change "heading" on image img_1.');
});

test('messageTextForInteractiveReply falls back to the title when the id is unparseable', () => {
  const text = messageTextForInteractiveReply({ id: 'not-an-edit-id', title: 'Some Title' });
  assert.equal(text, 'Some Title');
});
