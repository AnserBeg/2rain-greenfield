import test from 'node:test';
import { exerciseTemplateLibrary } from '../helpers/record-template-library.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

test(
  'publish and assign company templates for inspections, print tickets and school enrolments',
  { timeout: 1_200_000 },
  async () => {
    await withEphemeralPostgres(
      'record-templates',
      async ({ connection: c, pool }) => {
        await exerciseTemplateLibrary(
          `postgresql://${c.user}@${c.host}:${c.port}/${c.database}`,
          pool,
        );
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
