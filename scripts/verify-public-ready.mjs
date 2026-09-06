import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const required = [
  'docs/getting-started.md', 'docs/install-macos.md', 'docs/troubleshooting.md',
  'docs/privacy-model.md', 'docs/app-distribution.md', 'SECURITY.md',
  'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md',
  '.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/feature.yml',
  '.github/pull_request_template.md',
];

for (const file of required) {
  if (!fs.existsSync(file)) throw new Error(`Missing public-ready file: ${file}`);
}

const tracked = spawnSync('git', ['ls-files'], { encoding: 'utf8' });
if (tracked.status !== 0) throw new Error('Unable to inspect tracked files');
const unsafe = tracked.stdout.split('\n').filter((file) => /(^|\/)(?:\.env(?:\.local)?|service-account[^/]*\.json|credentials?\.json|firebase-adminsdk[^/]*\.json)$|\.(?:p12|pfx)$/i.test(file));
if (unsafe.length) throw new Error(`Credential-shaped tracked files: ${unsafe.join(', ')}`);

const commands = [
  ['npm', ['run', 'lint']], ['npm', ['run', 'typecheck']], ['npm', ['test']],
  ['npm', ['run', 'test:rules']], ['npm', ['run', 'test:acceptance']],
  ['npm', ['run', 'build']], ['npm', ['run', 'test:e2e']],
  ['npm', ['run', 'scan:secrets']], ['npm', ['audit', '--omit=dev', '--audit-level=high']],
];
for (const [command, args] of commands) {
  const label = `${command} ${args.join(' ')}`;
  console.log(`RUN ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`PASS ${label}`);
}
console.log('PUBLIC_READY_GATE=PASS');
