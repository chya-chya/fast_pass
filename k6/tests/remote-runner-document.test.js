import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const documentUrl = new URL(
  '../../infra/load-test/remote-runner.tf',
  import.meta.url,
);
const userDataUrl = new URL(
  '../../infra/load-test/templates/load-generator-user-data.sh.tftpl',
  import.meta.url,
);
const iamUrl = new URL('../../infra/load-test/iam.tf', import.meta.url);

test('remote runner serializes host execution and names its container', async () => {
  const document = await readFile(documentUrl, 'utf8');
  assert.match(document, /flock -n 9/);
  assert.match(document, /docker inspect fast-pass-remote-runner/);
  assert.match(document, /--name fast-pass-remote-runner/);
  assert.match(document, /RECOVERY_HOST_LOCK_PROOF=exclusive-v1/);
  assert.match(await readFile(userDataUrl, 'utf8'), /util-linux/);
});

test('load generator can distinguish a missing recovery intent from access denied', async () => {
  const policy = await readFile(iamUrl, 'utf8');
  assert.match(policy, /"runs\/recovery\/\*"/);
});
