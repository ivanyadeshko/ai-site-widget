import * as migration_20260818_091135 from './20260818_091135';
import * as migration_20260818_092337 from './20260818_092337';

export const migrations = [
  {
    up: migration_20260818_091135.up,
    down: migration_20260818_091135.down,
    name: '20260818_091135',
  },
  {
    up: migration_20260818_092337.up,
    down: migration_20260818_092337.down,
    name: '20260818_092337'
  },
];
