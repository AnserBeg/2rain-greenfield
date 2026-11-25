import test from 'node:test';
import { reportAnalysisCase } from '../helpers/report-analysis-case.js';

test(
  'REPORTS-1 s2: the archived 47 reader answers a query, then refuses the recorded v2 report and named measure by name',
  { timeout: 1_800_000 },
  reportAnalysisCase(true),
);
