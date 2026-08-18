import * as migration_20260818_091135 from './20260818_091135';

export const migrations = [
  {
    up: migration_20260818_091135.up,
    down: migration_20260818_091135.down,
    name: '20260818_091135'
  },
];
