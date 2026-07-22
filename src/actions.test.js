const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { actionCheckAllowedEdits, actionEditGraphic, actionSelectTvModel } = require('./actions');
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

test('actionCheckAllowedEdits lists the tagged elements for a known image', async () => {
  writeFixtureCatalog([{ id: 'img_1', name: 'Croma Earbuds', docId: 'urn:doc:1' }]);
  expressApi.getTaggedDocument = async (docId) => {
    assert.equal(docId, 'urn:doc:1');
    return SAMPLE_ELEMENTS_DOC;
  };

  const reply = await actionCheckAllowedEdits('phone-1', 'img_1');

  assert.match(reply.historyText, /Croma Earbuds/);
  assert.match(reply.historyText, /heading: currently "The X-Phone Pro is here!"/);
  assert.match(reply.historyText, /cta: currently/);
});

test('actionCheckAllowedEdits shows the latest edited value instead of the stale original document value', async () => {
  writeFixtureCatalog([{ id: 'img_1', name: 'Croma Earbuds', docId: 'urn:doc:1' }]);
  expressApi.getTaggedDocument = async () => SAMPLE_ELEMENTS_DOC;
  recordEdits('phone-1b', 'img_1', { cta: '20% off' });

  const reply = await actionCheckAllowedEdits('phone-1b', 'img_1');

  assert.match(reply.historyText, /cta: currently "20% off"/);
  assert.doesNotMatch(reply.historyText, /Available at our store starting 15 Aug 20XX\./);
  assert.match(reply.historyText, /heading: currently "The X-Phone Pro is here!"/);
});

test('actionCheckAllowedEdits reports unknown images without throwing', async () => {
  writeFixtureCatalog([{ id: 'img_1', name: 'Croma Earbuds', docId: 'urn:doc:1' }]);

  const reply = await actionCheckAllowedEdits('phone-2', 'img_nope');

  assert.match(reply, /couldn't find that image/);
});

test('actionCheckAllowedEdits returns a friendly message when the Express API call fails', async () => {
  writeFixtureCatalog([{ id: 'img_1', name: 'Croma Earbuds', docId: 'urn:doc:1' }]);
  expressApi.getTaggedDocument = async () => {
    throw new Error('getTaggedDocument failed 500: boom');
  };

  const reply = await actionCheckAllowedEdits('phone-3', 'img_1');

  assert.match(reply, /couldn't check the allowed edits/);
});

test('actionEditGraphic returns a disallowed_fields status and makes no generate call for a field outside the tagged elements', async () => {
  writeFixtureCatalog([{ id: 'img_1', name: 'Croma Earbuds', docId: 'urn:doc:1' }]);
  expressApi.getTaggedDocument = async () => SAMPLE_ELEMENTS_DOC;
  expressApi.generateVariation = async () => {
    throw new Error('should not be called');
  };
  let sendImageCalled = false;
  const sendImage = async () => { sendImageCalled = true; };

  const result = await actionEditGraphic('phone-4', 'img_1', { background_color: 'red' }, { sendImage });

  assert.equal(result.status, 'disallowed_fields');
  assert.equal(result.productName, 'Croma Earbuds');
  assert.deepEqual(result.disallowedKeys, ['background_color']);
  assert.match(result.allowedSummary, /Edits allowed on "Croma Earbuds"/);
  assert.equal(sendImageCalled, false);
});

test('actionEditGraphic applies an allowed edit end-to-end: generates, polls, sends the thumbnail, and records the edit', async () => {
  writeFixtureCatalog([{ id: 'img_1', name: 'Croma Earbuds', docId: 'urn:doc:1' }]);
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

  const result = await actionEditGraphic('phone-5', 'img_1', { cta: '20% off' }, { sendImage });

  assert.deepEqual(result, { status: 'success', productName: 'Croma Earbuds', changes: { cta: '20% off' } });
  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].to, 'phone-5');
  assert.equal(sentCalls[0].link, 'https://example.com/thumb.png');

  const image = findTrackedImage('phone-5', 'img_1');
  assert.deepEqual(image.currentEdits, { cta: '20% off' });
});

test('actionEditGraphic returns a friendly message and does not record the edit when generation fails', async () => {
  writeFixtureCatalog([{ id: 'img_1', name: 'Croma Earbuds', docId: 'urn:doc:1' }]);
  expressApi.getTaggedDocument = async () => SAMPLE_ELEMENTS_DOC;
  expressApi.generateVariation = async () => { throw new Error('generateVariation failed 500: boom'); };

  let sendImageCalled = false;
  const sendImage = async () => { sendImageCalled = true; };

  const result = await actionEditGraphic('phone-6', 'img_1', { cta: '20% off' }, { sendImage });

  assert.equal(result.status, 'api_error');
  assert.equal(result.reason, 'generate_failed');
  assert.equal(sendImageCalled, false);

  const image = findTrackedImage('phone-6', 'img_1');
  assert.deepEqual(image.currentEdits, {});
});

test('actionEditGraphic tells the user delivery failed but keeps the recorded edit when sendImage throws', async () => {
  writeFixtureCatalog([{ id: 'img_1', name: 'Croma Earbuds', docId: 'urn:doc:1' }]);
  expressApi.getTaggedDocument = async () => SAMPLE_ELEMENTS_DOC;
  expressApi.generateVariation = async () => ({ jobId: 'job-1', statusUrl: 'https://express-api.adobe.io/status/job-1' });
  expressApi.pollJobStatus = async () => ({ status: 'succeeded', document: { thumbnailUrl: 'https://example.com/thumb.png' } });

  const sendImage = async () => { throw new Error('WhatsApp could not fetch the link'); };

  const result = await actionEditGraphic('phone-7', 'img_1', { cta: '20% off' }, { sendImage });

  assert.equal(result.status, 'delivery_failed');
  assert.deepEqual(result.changes, { cta: '20% off' });

  const image = findTrackedImage('phone-7', 'img_1');
  assert.deepEqual(image.currentEdits, { cta: '20% off' });
});

test('actionEditGraphic returns an api_error/lookup_failed status when getTaggedDocument fails', async () => {
  writeFixtureCatalog([{ id: 'img_1', name: 'Croma Earbuds', docId: 'urn:doc:1' }]);
  expressApi.getTaggedDocument = async () => { throw new Error('getTaggedDocument failed 500: boom'); };

  const result = await actionEditGraphic('phone-8', 'img_1', { cta: '20% off' }, { sendImage: async () => {} });

  assert.equal(result.status, 'api_error');
  assert.equal(result.reason, 'lookup_failed');
});

const TV_ELEMENTS_DOC = {
  documentPages: [
    {
      pageNumber: 1,
      taggedElements: [
        { name: 'productImage', type: 'image', value: '' },
        { name: 'oldPrice', type: 'text', value: '' },
        { name: 'price', type: 'text', value: '' },
      ],
    },
  ],
};

test('actionEditGraphic rejects a price edit implying more than 40% off and makes no generate call', async () => {
  writeFixtureCatalog([{ id: 'img_2', name: 'TV Product', docId: 'urn:doc:2' }]);
  expressApi.getTaggedDocument = async () => TV_ELEMENTS_DOC;
  expressApi.generateVariation = async () => { throw new Error('should not be called'); };
  recordEdits('phone-9', 'img_2', { productImage: 'https://example.com/tv.png', oldPrice: 33999, price: 27199 });

  const result = await actionEditGraphic('phone-9', 'img_2', { price: 17000 }, { sendImage: async () => {} });

  assert.equal(result.status, 'discount_capped');
  assert.equal(result.maxPercent, 40);
});

test('actionEditGraphic applies a price edit at exactly the 40% cap (within rounding tolerance)', async () => {
  writeFixtureCatalog([{ id: 'img_2', name: 'TV Product', docId: 'urn:doc:2' }]);
  expressApi.getTaggedDocument = async () => TV_ELEMENTS_DOC;
  expressApi.generateVariation = async (docId, tagMappings) => {
    assert.deepEqual(tagMappings, { productImage: 'https://example.com/tv.png', oldPrice: 33999, price: 20399 });
    return { jobId: 'job-2', statusUrl: 'https://express-api.adobe.io/status/job-2' };
  };
  expressApi.pollJobStatus = async () => ({ status: 'succeeded', document: { thumbnailUrl: 'https://example.com/thumb2.png' } });
  recordEdits('phone-10', 'img_2', { productImage: 'https://example.com/tv.png', oldPrice: 33999, price: 27199 });

  const result = await actionEditGraphic('phone-10', 'img_2', { price: 20399 }, { sendImage: async () => {} });

  assert.equal(result.status, 'success');
  assert.deepEqual(result.changes, { price: 20399 });
});

test('actionSelectTvModel returns the 3 fixed TV model options with the question body text', () => {
  const result = actionSelectTvModel('img_1');

  assert.equal(result.type, 'edit_options');
  assert.equal(result.bodyText, 'Which model would you like to use?');
  assert.equal(result.options.length, 3);
  assert.deepEqual(
    result.options.map((option) => option.title),
    ['Sony Bravia K-75', 'LG UA82 AI', 'Samsung UA4']
  );
});

test('actionSelectTvModel encodes the same fixed productImage/oldPrice/price edits into every option id', () => {
  const result = actionSelectTvModel('img_1');

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
