/**
 * @file Id + slug helpers. Item / candidate-group ids are DETERMINISTIC
 * functions of (slot date, platform, candidate index) so planning is
 * idempotent and reproducible; run ids are time-stamped + salted.
 */

import { randomBytes } from 'node:crypto';
import { compact } from './time.mjs';

/** instagram → "ig", tiktok → "tt". @param {string} platform */
export function platformSlug(platform) {
  if (platform === 'instagram') return 'ig';
  if (platform === 'tiktok') return 'tt';
  throw new Error(`unknown platform "${platform}"`);
}

/**
 * Deterministic candidate id, e.g. ("2026-07-14","instagram",1) → "ci_20260714_ig_1".
 * @param {string} slotDate `YYYY-MM-DD` @param {string} platform @param {number} k 1-based
 */
export function itemId(slotDate, platform, k) {
  return `ci_${compact(slotDate)}_${platformSlug(platform)}_${k}`;
}

/**
 * Deterministic candidate-group id shared by a slot's candidates,
 * e.g. ("2026-07-14","instagram") → "cg_20260714_ig".
 * @param {string} slotDate @param {string} platform
 */
export function candidateGroupId(slotDate, platform) {
  return `cg_${compact(slotDate)}_${platformSlug(platform)}`;
}

/** Time-stamped, salted run id, e.g. "run_20260713T053012_generate_a1b2c3". */
export function runId(stage, now = new Date()) {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', 'T');
  return `run_${ts}_${stage}_${randomBytes(3).toString('hex')}`;
}

/** Salted approval id. */
export function approvalId(now = new Date()) {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `ap_${ts}_${randomBytes(3).toString('hex')}`;
}
