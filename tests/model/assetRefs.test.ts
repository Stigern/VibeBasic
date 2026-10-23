import { expect, test } from 'vitest';
import { assetRefCount, assetUsedElsewhere, controlAssetIds } from '../../src/model/assetRefs';
import { newControl, newProject } from '../../src/model/controls';

test('asset references: ListImages lines of every ImageList and picture properties count; the project icon does not', () => {
  const p = newProject();
  const f = p.forms[0];
  const il1 = newControl(f, 'ImageList', { left: 0, top: 0 }, null);
  const il2 = newControl(f, 'ImageList', { left: 0, top: 0 }, null);
  const img = newControl(f, 'Image', { left: 0, top: 0 }, null);
  il1.props.ListImages = ['open|asset-a|', '|asset-b'];
  il2.props.ListImages = ['open|asset-a|tag'];   // a pasted copy shares the asset
  img.props.Picture = { asset: 'asset-c' };
  f.props.Icon = { asset: 'asset-a' };
  f.controls.push(il1, il2, img);
  p.iconAsset = 'asset-d';
  expect(assetRefCount(p, 'asset-a')).toBe(3);
  expect(assetRefCount(p, 'asset-b')).toBe(1);
  expect(assetRefCount(p, 'asset-c')).toBe(1);
  expect(assetRefCount(p, 'asset-d')).toBe(0);
  expect(assetUsedElsewhere(p, 'asset-b', 1)).toBe(false);   // only ImageList1's own line
  expect(assetUsedElsewhere(p, 'asset-a', 1)).toBe(true);    // ImageList2 and the form icon still use it
  expect(assetUsedElsewhere(p, 'asset-d')).toBe(false);
});

test('asset references: the pictures of the 0.8 controls count (SSCommand Picture, SSRibbon PictureUp / PictureDn); ImageCombo images go through its ImageList', () => {
  const p = newProject();
  const f = p.forms[0];
  const cmd = newControl(f, 'SSCommand', { left: 0, top: 0 }, null);
  const rib = newControl(f, 'SSRibbon', { left: 0, top: 0 }, null);
  const il = newControl(f, 'ImageList', { left: 0, top: 0 }, null);
  const ic = newControl(f, 'ImageCombo', { left: 0, top: 0 }, null);
  for (const [c, prop] of [[cmd, 'Picture'], [rib, 'PictureUp'], [rib, 'PictureDn']] as const) expect(prop in c.props).toBe(true);
  cmd.props.Picture = { asset: 'asset-a' };
  rib.props.PictureUp = { asset: 'asset-a' };
  rib.props.PictureDn = { asset: 'asset-b' };
  il.props.ListImages = ['one|asset-c|'];
  ic.props.ImageList = il.name;
  f.controls.push(cmd, rib, il, ic);
  expect(assetRefCount(p, 'asset-a')).toBe(2);
  expect(assetRefCount(p, 'asset-b')).toBe(1);
  expect(assetRefCount(p, 'asset-c')).toBe(1);
  expect(controlAssetIds(rib).sort()).toEqual(['asset-a', 'asset-b']);
});
