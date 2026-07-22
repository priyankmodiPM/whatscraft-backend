const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const expressFlow = require('./expressFlow');
const expressApi = require('./express/expressApi');
const { findTrackedImage, recordEdits } = require('./imageStore');
const { parseEditOptionId } = require('./interactiveReply');

function writeFixtureCatalog(entries) {
  const fixturePath = path.join(os.tmpdir(), `express-templates-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify(entries));
  process.env.EXPRESS_TEMPLATES_FILE = fixturePath;
}

const SAMPLE_ELEMENTS_DOC = {
  documentPages: [
    {
      pageNumber: 1,
      taggedElements: [
        { name: 'heading', type: 'text', value: 'The X-Phone Pro is here!' },
        { name: 'cta', type: 'text', value: 'Available at our store starting 15 Aug 20XX.' },
      ],
    },
  ],
};

// A catalog (source: 'express') image resolved through imageStore.
function catalogImage(phone) {
  writeFixtureCatalog([{ id: 'img_1', name: 'Croma Earbuds', docId: 'urn:doc:1' }]);
  return findTrackedImage(phone, 'img_1');
}

test('checkAllowedEdits lists the tagged elements for a known image', async () => {
  expressApi.getTaggedDocument = async (docId) => {
    assert.equal(docId, 'urn:doc:1');
    return SAMPLE_ELEMENTS_DOC;
  };
  const image = catalogImage('phone-1');

  const reply = await expressFlow.checkAllowedEdits(image);

  assert.match(reply.historyText, /Croma Earbuds/);
  assert.match(reply.historyText, /heading: currently "The X-Phone Pro is here!"/);
  assert.match(reply.historyText, /cta: currently/);
});

test('checkAllowedEdits shows the latest edited value instead of the stale document value', async () => {
  expressApi.getTaggedDocument = async () => SAMPLE_ELEMENTS_DOC;
  writeFixtureCatalog([{ id: 'img_1', name: 'Croma Earbuds', docId: 'urn:doc:1' }]);
  recordEdits('phone-1b', 'img_1', { cta: '20% off' });
  const image = findTrackedImage('phone-1b', 'img_1');

  const reply = await expressFlow.checkAllowedEdits(image);

  assert.match(reply.historyText, /cta: currently "20% off"/);
  assert.doesNotMatch(reply.historyText, /Available at our store starting 15 Aug 20XX\./);
  assert.match(reply.historyText, /heading: currently "The X-Phone Pro is here!"/);
});

test('checkAllowedEdits returns a friendly message when the Express API call fails', async () => {
  expressApi.getTaggedDocument = async () => {
    throw new Error('getTaggedDocument failed 500: boom');
  };
  const image = catalogImage('phone-3');

  const reply = await expressFlow.checkAllowedEdits(image);

  assert.match(reply, /couldn't check the allowed edits/);
});

test('editGraphic rejects edits outside the tagged elements and makes no generate call', async () => {
  expressApi.getTaggedDocument = async () => SAMPLE_ELEMENTS_DOC;
  expressApi.generateVariation = async () => {
    throw new Error('should not be called');
  };
  let sendImageCalled = false;
  const sendImage = async () => { sendImageCalled = true; };
  const image = catalogImage('phone-4');

  const reply = await expressFlow.editGraphic('phone-4', image, { background_color: 'red' }, { sendImage });

  assert.match(reply, /can't edit background_color/);
  assert.equal(sendImageCalled, false);
});

test('editGraphic applies an allowed edit end-to-end: generates, polls, sends the thumbnail, and records the edit', async () => {
  expressApi.getTaggedDocument = async () => SAMPLE_ELEMENTS_DOC;
  expressApi.generateVariation = async (docId, tagMappings, pages, preferredDocumentName) => {
    assert.equal(docId, 'urn:doc:1');
    assert.deepEqual(tagMappings, { cta: '20% off' });
    assert.equal(pages, '1');
    assert.match(preferredDocumentName, /^Croma Earbuds-edit-\d+$/);
    return { jobId: 'job-1', statusUrl: 'https://express-api.adobe.io/status/job-1' };
  };
  expressApi.pollJobStatus = async (statusUrl) => {
    assert.equal(statusUrl, 'https://express-api.adobe.io/status/job-1');
    return { status: 'succeeded', document: { thumbnailUrl: 'https://example.com/thumb.png' } };
  };

  const sentCalls = [];
  const sendImage = async (to, link) => { sentCalls.push({ to, link }); };
  const image = catalogImage('phone-5');

  const reply = await expressFlow.editGraphic('phone-5', image, { cta: '20% off' }, { sendImage });

  assert.match(reply.historyText, /Updated "Croma Earbuds"/);
  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].to, 'phone-5');
  assert.equal(sentCalls[0].link, 'https://example.com/thumb.png');

  const updated = findTrackedImage('phone-5', 'img_1');
  assert.deepEqual(updated.currentEdits, { cta: '20% off' });
});

test('editGraphic returns a friendly message and does not record the edit when generation fails', async () => {
  expressApi.getTaggedDocument = async () => SAMPLE_ELEMENTS_DOC;
  expressApi.generateVariation = async () => { throw new Error('generateVariation failed 500: boom'); };

  let sendImageCalled = false;
  const sendImage = async () => { sendImageCalled = true; };
  const image = catalogImage('phone-6');

  const reply = await expressFlow.editGraphic('phone-6', image, { cta: '20% off' }, { sendImage });

  assert.match(reply, /something went wrong generating/);
  assert.equal(sendImageCalled, false);

  const updated = findTrackedImage('phone-6', 'img_1');
  assert.deepEqual(updated.currentEdits, {});
});

test('editGraphic tells the user delivery failed but keeps the recorded edit when sendImage throws', async () => {
  expressApi.getTaggedDocument = async () => SAMPLE_ELEMENTS_DOC;
  expressApi.generateVariation = async () => ({ jobId: 'job-1', statusUrl: 'https://express-api.adobe.io/status/job-1' });
  expressApi.pollJobStatus = async () => ({ status: 'succeeded', document: { thumbnailUrl: 'https://example.com/thumb.png' } });

  const sendImage = async () => { throw new Error('WhatsApp could not fetch the link'); };
  const image = catalogImage('phone-7');

  const reply = await expressFlow.editGraphic('phone-7', image, { cta: '20% off' }, { sendImage });

  assert.match(reply, /couldn't send the image right now/);
  assert.doesNotMatch(reply, /something went wrong generating/);

  const updated = findTrackedImage('phone-7', 'img_1');
  assert.deepEqual(updated.currentEdits, { cta: '20% off' });
});

test('selectTvModel returns the 3 fixed TV model options with the question body text', () => {
  const result = expressFlow.selectTvModel('img_1');

  assert.equal(result.type, 'edit_options');
  assert.equal(result.bodyText, 'Which model would you like to use?');
  assert.equal(result.options.length, 3);
  assert.deepEqual(
    result.options.map((option) => option.title),
    ['Sony Bravia K-75', 'LG UA82 AI', 'Samsung UA4']
  );
});

test('selectTvModel encodes the same fixed productImage/oldPrice/price edits into every option id', () => {
  const result = expressFlow.selectTvModel('img_1');

  for (const option of result.options) {
    const parsed = parseEditOptionId(option.id);
    assert.deepEqual(parsed, {
      imageId: 'img_1',
      edits: {
        productImage: 'https://s7ap1.scene7.com/is/image/healthmonitor/SonyTv?wid=1000',
        oldPrice: 33999,
        price: 27199,
      },
    });
  }
});
