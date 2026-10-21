import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const scenario of ['spike', 'soak']) {
  test(`${scenario} qualification uses the approved aggregate error rate`, async () => {
    const source = await readFile(
      new URL(`../scenarios/${scenario}.js`, import.meta.url),
      'utf8',
    );
    assert.match(source, /unexpected_error_rate:\s*abortingThreshold/);
    assert.doesNotMatch(source, /checks:\s*\['rate==1'\]/);
    assert.doesNotMatch(source, /unexpected_error:\s*\['count==0'\]/);
    assert.doesNotMatch(source, /timeout:\s*\['count==0'\]/);
  });
}
