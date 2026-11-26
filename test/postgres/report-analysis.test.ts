import test from 'node:test';
import { reportAnalysisCase } from '../helpers/report-analysis-case.js';

test(
  'REPORTS-1 s2: North ages invoices, groups by a linked Site, counts lines and distinct parents, trials a measure, and never sees South',
  { timeout: 1_800_000 },
  reportAnalysisCase(false),
);
