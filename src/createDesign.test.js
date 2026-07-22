const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { actionCreateDesign, actionEditGraphic } = require('./actions');

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

test('actionCreateDesign registers a local design and sends the base image', async () => {
  useFixture();
  const { sendImage, sent } = captureSendImage();

  const reply = await actionCreateDesign(
    'onam-phone-1',
    { occasion: 'Onam', products: ['LG washing machine', 'dishwasher'], offer: '20% off' },
    { sendImage }
  );

  assert.equal(sent[0], FIXTURE.images.base);
  assert.match(reply, /Built with Croma's logo/);
});

test('editing a created design to an off-palette background is rejected with approved options', async () => {
  useFixture();
  const { sendImage, sent } = captureSendImage();
  await actionCreateDesign('onam-phone-2', { occasion: 'Onam' }, { sendImage });

  const reply = await actionEditGraphic('onam-phone-2', 'local_1', { background: 'Pink' }, { sendImage });

  assert.match(reply, /isn't in the approved palette/);
  assert.match(reply, /Marigold · Maroon · Deep Green/);
  assert.equal(sent.length, 1); // only the create image; no new image on a rejected edit
});

test('an approved-palette background + address resolves to the final image', async () => {
  useFixture();
  const { sendImage, sent } = captureSendImage();
  await actionCreateDesign('onam-phone-3', { occasion: 'Onam' }, { sendImage });

  await actionEditGraphic('onam-phone-3', 'local_1', { background: 'Marigold', address: 'MG Road, Kochi' }, { sendImage });

  assert.equal(sent.at(-1), FIXTURE.images.final);
});

test('a Malayalam headline resolves to the Malayalam image', async () => {
  useFixture();
  const { sendImage, sent } = captureSendImage();
  await actionCreateDesign('onam-phone-4', { occasion: 'Onam' }, { sendImage });

  await actionEditGraphic('onam-phone-4', 'local_1', { headline: 'ഓണം ആശംസകൾ' }, { sendImage });

  assert.equal(sent.at(-1), FIXTURE.images.malayalam);
});

test('adding only a store address resolves to the final image (demo msg 2)', async () => {
  useFixture();
  const { sendImage, sent } = captureSendImage();
  await actionCreateDesign('onam-phone-a', { occasion: 'Onam' }, { sendImage });

  await actionEditGraphic('onam-phone-a', 'local_1', { address: 'Princess Street, Kochi' }, { sendImage });

  assert.equal(sent.at(-1), FIXTURE.images.final);
});

test('a translate request under an unrecognized key still resolves to Malayalam (demo msg 3)', async () => {
  useFixture();
  const { sendImage, sent } = captureSendImage();
  await actionCreateDesign('onam-phone-b', { occasion: 'Onam' }, { sendImage });

  // model phrases it as a language change rather than a headline edit
  const reply = await actionEditGraphic('onam-phone-b', 'local_1', { language: 'Malayalam' }, { sendImage });

  assert.equal(sent.at(-1), FIXTURE.images.malayalam);
  assert.doesNotMatch(reply, /locked by HQ/);
});

test('a Malayalam value under any key resolves to Malayalam', async () => {
  useFixture();
  const { sendImage, sent } = captureSendImage();
  await actionCreateDesign('onam-phone-c', { occasion: 'Onam' }, { sendImage });

  await actionEditGraphic('onam-phone-c', 'local_1', { banner: 'ഓണം ആശംസകൾ' }, { sendImage });

  assert.equal(sent.at(-1), FIXTURE.images.malayalam);
});

test('a Malayalam value landing on the background key translates, not palette-rejected (regression)', async () => {
  useFixture();
  const { sendImage, sent } = captureSendImage();
  await actionCreateDesign('onam-phone-d', { occasion: 'Onam' }, { sendImage });

  // model mistakenly puts the translated word on a "background"-like key
  const reply = await actionEditGraphic('onam-phone-d', 'local_1', { background: 'ഓണം' }, { sendImage });

  assert.equal(sent.at(-1), FIXTURE.images.malayalam);
  assert.doesNotMatch(reply, /approved palette/);
});

test('editing a locked element on a created design is refused', async () => {
  useFixture();
  const { sendImage } = captureSendImage();
  await actionCreateDesign('onam-phone-5', { occasion: 'Onam' }, { sendImage });

  const reply = await actionEditGraphic('onam-phone-5', 'local_1', { logo: 'brighter' }, { sendImage });

  assert.match(reply, /locked by HQ/);
});

test('edit-key aliases map onto canonical slot names (colour -> background)', async () => {
  useFixture();
  const { sendImage, sent } = captureSendImage();
  await actionCreateDesign('onam-phone-6', { occasion: 'Onam' }, { sendImage });

  await actionEditGraphic('onam-phone-6', 'local_1', { colour: 'Deep Green' }, { sendImage });

  assert.equal(sent.at(-1), FIXTURE.images.final);
});
