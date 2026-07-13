// Remotion CLI config. Kept minimal on purpose: the autopilot video adapter
// (src/adapters/video.mjs) concatenates comp renders with `-c copy`, which is
// only valid while every comp renders with IDENTICAL codec settings — change
// nothing here without re-checking that invariant.
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
