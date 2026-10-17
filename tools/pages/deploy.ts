// `npm run pages:deploy`: builds the site into dist-pages/ and publishes it as the gh-pages branch of origin, then turns
// GitHub Pages on for that branch. The branch holds one commit, replaced on every deploy.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const site = resolve(import.meta.dirname, '../../dist-pages');
const run = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' });
const out = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();

run('npm', ['run', 'pages:build']);

const remote = out('git', ['remote', 'get-url', 'origin']);
const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(remote)?.[1];
if (!repo) throw new Error(`origin is not a GitHub repository: ${remote}`);

const work = mkdtempSync(join(tmpdir(), 'oot-pages-'));
try {
  cpSync(site, work, { recursive: true });
  writeFileSync(join(work, '.nojekyll'), '');
  run('git', ['init', '-q', '-b', 'gh-pages'], work);
  run('git', ['add', '-A'], work);
  run('git', ['-c', 'user.name=pages-deploy', '-c', 'user.email=pages-deploy@localhost', 'commit', '-q', '-m', 'Deploy'], work);
  // The GitHub CLI's login owns the repository; a cached git credential may belong to another account.
  run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '--force', remote, 'gh-pages'], work);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const owner = repo.split('/')[0]!.toLowerCase();
const url = `https://${owner}.github.io/${repo.split('/')[1]}/`;
try {
  execFileSync('gh', ['api', '-X', 'POST', `repos/${repo}/pages`, '--input', '-'], { input: JSON.stringify({ source: { branch: 'gh-pages', path: '/' } }), stdio: ['pipe', 'ignore', 'pipe'] });
} catch (err) {
  // 409: Pages is already on for this repository.
  if (!String((err as { stderr?: unknown }).stderr).includes('already enabled')) {
    console.log(`Pages could not be enabled by the API. If ${url} does not load: Settings > Pages > Source: Deploy from a branch > gh-pages, / (root).`);
  }
}
console.log(`Published: ${url}`);
