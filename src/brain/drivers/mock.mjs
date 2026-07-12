/**
 * @file mock driver — deterministic, offline, schema-valid fixtures.
 *
 * Used by AP-201's pipeline tests and by golden-path CI (no network, no CLI, no
 * cost). Fixtures live in `autopilot/fixtures/brain/mock/<schema>.json`, keyed
 * by the request's schema key (`.` → `-` in the filename, e.g.
 * `artdirector.judge` → `artdirector-judge.json`).
 *
 * The copywriter fixture is an ARRAY of candidates; the mock returns
 * `candidates[req.inputs.variant % N]` so a 3-call fan-out yields 3 distinct
 * candidates. Every fixture is validated against its schema before being
 * returned, so a malformed fixture fails loudly here rather than downstream.
 *
 * The mock still assembles the real prompt (to log a genuine `promptSha`) when
 * given enough inputs; if assembly can't run (minimal test requests), it falls
 * back to a deterministic hash of the request.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assemblePrompt, sha256 } from '../assemble.mjs';
import { getSchema, validate } from '../schema.mjs';

const DRIVER = 'mock';
const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/brain/mock/', import.meta.url));

export class MockDriver {
  /**
   * @param {object} [config]
   * @param {string} [config.fixturesDir]
   */
  constructor(config = {}) {
    this.name = DRIVER;
    this.config = config;
    this.fixturesDir = config.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  }

  /**
   * @param {import('../schema.mjs').StageRequest} req
   * @returns {Promise<import('../schema.mjs').StageResult>}
   */
  async complete(req) {
    const schema = getSchema(req.schema);
    const promptSha = this._promptSha(req);

    let fixture;
    try {
      fixture = this._loadFixture(req.schema);
    } catch (err) {
      return {
        ok: false,
        data: null,
        raw: '',
        tokensIn: null,
        tokensOut: null,
        model: DRIVER,
        promptSha,
        costUsd: 0,
        error: `mock fixture error: ${err.message}`,
        attempts: 0,
        driver: DRIVER,
      };
    }

    // The copywriter fan-out: pick a candidate by variant index.
    const data = Array.isArray(fixture)
      ? fixture[(req.inputs?.variant ?? 0) % fixture.length]
      : fixture;

    const check = validate(schema, data);
    if (!check.ok) {
      // A bad fixture is a developer error — surface it, don't paper over it.
      return {
        ok: false,
        data: null,
        raw: JSON.stringify(data),
        tokensIn: null,
        tokensOut: null,
        model: DRIVER,
        promptSha,
        costUsd: 0,
        error: `mock fixture for '${req.schema}' is not schema-valid: ${check.errors.join('; ')}`,
        attempts: 1,
        driver: DRIVER,
      };
    }

    return {
      ok: true,
      data,
      raw: JSON.stringify(data, null, 2),
      tokensIn: null,
      tokensOut: null,
      model: DRIVER,
      promptSha,
      costUsd: 0,
      error: null,
      attempts: 1,
      driver: DRIVER,
    };
  }

  _loadFixture(schemaKey) {
    const file = `${this.fixturesDir}${schemaKey.replace(/\./g, '-')}.json`;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`no fixture for schema '${schemaKey}' at ${file}: ${err.message}`);
    }
    return JSON.parse(text);
  }

  /** Real promptSha when assembly is possible; deterministic fallback otherwise. */
  _promptSha(req) {
    try {
      return assemblePrompt(req, this.config).promptSha;
    } catch {
      return sha256(`mock:${req.stage}:${req.schema}:${req.inputs?.variant ?? 0}`);
    }
  }
}
