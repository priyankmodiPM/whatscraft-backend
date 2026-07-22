const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const localFlow = require('./localFlow');
const { findTrackedImage } = require('./imageStore');

const FIXTURE = {
  images: {
    base: 'https://cdn.test/onam-base.png',
    final: 'https://cdn.test/onam-final.png',
    malayalam: 'https://cdn.test/onam-malayalam.png',
  },
  palette: [
    { name: 'Marigold', hex: '#F4A300' },
    { name: 'Maroon', hex: '#800020' },
    { name: 'Deep Green', hex: '#1B5E20' },
  ],
  slots: {
    editable: [
      { name: 'headline', type: 'text', aliases: ['heading', 'title'] },
      { name: 'background', type: 'color', aliases: ['background_color', 'colour', 'color'] },
      { name: 'address', type: 'text', aliases: ['store_address'] },
    ],
    locked: ['logo', 'product'],
  },
};

function useFixture() {
  const p = path.join(os.tmpdir(), `onam-design-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(FIXTURE));
  process.env.ONAM_DESIGN_FILE = p;
}

function captureSendImage() {
  const sent = [];
  return { sendImage: async (_to, link) => sent.push(link), sent };
}

// Create a design for a phone (base image sent) and return its tracked image object.
async function setup(phone, args = { occasion: 'Onam' }) {
  useFixture();
  const { sendImage, sent } = captureSendImage();
  await localFlow.createDesign(phone, args, { sendImage });
  return { image: findTrackedImage(phone, 'local_1'), sendImage, sent };
}

test('createDesign registers a local design and sends the base image', async () => {
  useFixture();
  const { sendImage, sent } = captureSendImage();

  const reply = await localFlow.createDesign(
    'onam-phone-1',
    { occasion: 'Onam', products: ['LG washing machine', 'dishwasher'], offer: '20% off' },
    { sendImage }
  );

  assert.equal(sent[0], FIXTURE.images.base);
  assert.match(reply, /Built with Croma's logo/);
});

test('checkAllowedEdits lists the editable slots from the static schema', async () => {
  const { image } = await setup('onam-phone-check');

  const result = localFlow.checkAllowedEdits(image);

  assert.equal(result.type, 'edit_options');
  assert.deepEqual(result.options.map((o) => o.title), ['Change headline', 'Change background', 'Change address']);
  assert.match(result.historyText, /headline/);
});

test('editing to an off-palette background is rejected with the approved options', async () => {
  const { image, sent } = await setup('onam-phone-2');

  const reply = await localFlow.editGraphic('onam-phone-2', image, { background: 'Pink' }, { sendImage: async (_t, l) => sent.push(l) });

  assert.match(reply, /isn't in the approved palette/);
  assert.match(reply, /Marigold · Maroon · Deep Green/);
  assert.equal(sent.length, 1); // only the create image; no new image on a rejected edit
});

test('an approved-palette background + address resolves to the final image', async () => {
  const { image, sent } = await setup('onam-phone-3');

  await localFlow.editGraphic('onam-phone-3', image, { background: 'Marigold', address: 'MG Road, Kochi' }, { sendImage: async (_t, l) => sent.push(l) });

  assert.equal(sent.at(-1), FIXTURE.images.final);
});

test('a Malayalam headline resolves to the Malayalam image', async () => {
  const { image, sent } = await setup('onam-phone-4');

  await localFlow.editGraphic('onam-phone-4', image, { headline: 'ഓണം ആശംസകൾ' }, { sendImage: async (_t, l) => sent.push(l) });

  assert.equal(sent.at(-1), FIXTURE.images.malayalam);
});

test('adding only a store address resolves to the final image (demo msg 2)', async () => {
  const { image, sent } = await setup('onam-phone-a');

  await localFlow.editGraphic('onam-phone-a', image, { address: 'Princess Street, Kochi' }, { sendImage: async (_t, l) => sent.push(l) });

  assert.equal(sent.at(-1), FIXTURE.images.final);
});

test('a translate request under an unrecognized key still resolves to Malayalam (demo msg 3)', async () => {
  const { image, sent } = await setup('onam-phone-b');

  const reply = await localFlow.editGraphic('onam-phone-b', image, { language: 'Malayalam' }, { sendImage: async (_t, l) => sent.push(l) });

  assert.equal(sent.at(-1), FIXTURE.images.malayalam);
  assert.doesNotMatch(reply, /locked by HQ/);
});

test('a Malayalam value under any key resolves to Malayalam', async () => {
  const { image, sent } = await setup('onam-phone-c');

  await localFlow.editGraphic('onam-phone-c', image, { banner: 'ഓണം ആശംസകൾ' }, { sendImage: async (_t, l) => sent.push(l) });

  assert.equal(sent.at(-1), FIXTURE.images.malayalam);
});

test('a Malayalam value landing on the background key translates, not palette-rejected (regression)', async () => {
  const { image, sent } = await setup('onam-phone-d');

  const reply = await localFlow.editGraphic('onam-phone-d', image, { background: 'ഓണം' }, { sendImage: async (_t, l) => sent.push(l) });

  assert.equal(sent.at(-1), FIXTURE.images.malayalam);
  assert.doesNotMatch(reply, /approved palette/);
});

test('editing a locked element is refused', async () => {
  const { image } = await setup('onam-phone-5');

  const reply = await localFlow.editGraphic('onam-phone-5', image, { logo: 'brighter' }, { sendImage: async () => {} });

  assert.match(reply, /locked by HQ/);
});

test('edit-key aliases map onto canonical slot names (colour -> background)', async () => {
  const { image, sent } = await setup('onam-phone-6');

  await localFlow.editGraphic('onam-phone-6', image, { colour: 'Deep Green' }, { sendImage: async (_t, l) => sent.push(l) });

  assert.equal(sent.at(-1), FIXTURE.images.final);
});
