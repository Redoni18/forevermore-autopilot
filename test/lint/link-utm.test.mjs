import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinkUtm } from '../../src/lint/rules/link-utm.mjs';

test('link-utm: no domain mention at all produces no violations', () => {
  assert.deepEqual(checkLinkUtm({ platform: 'tiktok', caption: 'give them a whole world' }, {}), []);
});

test('link-utm: matching utm_source in an embedded query string passes silently', () => {
  const item = {
    platform: 'tiktok',
    caption: 'link: getforevermore.co?utm_source=tiktok&utm_medium=organic',
  };
  assert.deepEqual(checkLinkUtm(item, {}), []);
});

test('link-utm: mismatched utm_source warns (never blocks)', () => {
  const item = {
    platform: 'tiktok',
    caption: 'link: getforevermore.co?utm_source=instagram&utm_medium=organic',
  };
  const violations = checkLinkUtm(item, {});
  assert.ok(violations.some((v) => v.rule === 'link-utm:utm-source-mismatch'));
  assert.ok(violations.every((v) => v.severity === 'warn'));
});

test('link-utm: query string with no utm_source warns', () => {
  const item = { platform: 'tiktok', caption: 'link: getforevermore.co?ref=abc' };
  const violations = checkLinkUtm(item, {});
  assert.ok(violations.some((v) => v.rule === 'link-utm:missing-utm-source'));
});

test('link-utm: bare domain mention with a valid link_utm field passes', () => {
  const item = {
    platform: 'tiktok',
    caption: 'link in bio: getforevermore.co',
    link_utm: 'https://getforevermore.co/?utm_source=tiktok&utm_medium=organic&utm_campaign=p4&utm_content=ci1',
  };
  assert.deepEqual(checkLinkUtm(item, {}), []);
});

test('link-utm: bare domain mention with no link_utm field warns', () => {
  const item = { platform: 'tiktok', caption: 'link in bio: getforevermore.co' };
  const violations = checkLinkUtm(item, {});
  assert.ok(violations.some((v) => v.rule === 'link-utm:missing-link-utm-field'));
});

test('link-utm: bare domain mention with a link_utm field whose utm_source mismatches warns', () => {
  const item = {
    platform: 'tiktok',
    caption: 'link in bio: getforevermore.co',
    link_utm: 'https://getforevermore.co/?utm_source=instagram',
  };
  const violations = checkLinkUtm(item, {});
  assert.ok(violations.some((v) => v.rule === 'link-utm:link-field-utm-source-mismatch'));
});

test('link-utm: bare domain mention with a link_utm field missing utm_source warns', () => {
  const item = {
    platform: 'tiktok',
    caption: 'link in bio: getforevermore.co',
    link_utm: 'https://getforevermore.co/?ref=abc',
  };
  const violations = checkLinkUtm(item, {});
  assert.ok(violations.some((v) => v.rule === 'link-utm:link-field-missing-utm-source'));
});
