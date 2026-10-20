// `npm run pages:deploy`: builds the site into dist-pages/, mirrors it into a persistent clone of the gh-pages branch kept in the shared cache
// (~/.zelda-oot-js/pages-repo), and commits and pushes only what changed (no force), then turns GitHub Pages on for that branch.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { syncSite } from './sync.ts';

// Children inherit this, so the build, git and compression all run at below-normal priority.
os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);

const root = resolve(import.meta.dirname, '../..');
const site = join(root, 'dist-pages');
const pagesRepo = process.env.OOT_PAGES_REPO || join(os.homedir(), '.zelda-oot-js', 'pages-repo');
const run = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' });
const out = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
// The GitHub CLI's login owns the repository; a cached git credential may belong to another account.
const auth = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
const identity = ['-c', 'user.name=pages-deploy', '-c', 'user.email=pages-deploy@localhost'];

// Always run: a cache hit takes seconds, and a miss rebuilds the game after a runtime or recompiler change.
run('npm', ['run', 'port']);
run('npm', ['run', 'pages:build']);

const remote = out('git', ['remote', 'get-url', 'origin']);
const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(remote)?.[1];
if (!repo) throw new Error(`origin is not a GitHub repository: ${remote}`);

if (!existsSync(join(pagesRepo, '.git'))) {
  mkdirSync(dirname(pagesRepo), { recursive: true });
  try {
    run('git', [...auth, 'clone', '-q', '--branch', 'gh-pages', '--single-branch', remote, pagesRepo]);
  } catch {
    run('git', ['init', '-q', '-b', 'gh-pages', pagesRepo]);
    run('git', ['remote', 'add', 'origin', remote], pagesRepo);
  }
} else {
  run('git', ['remote', 'set-url', 'origin', remote], pagesRepo);
  try {
    run('git', [...auth, 'fetch', '-q', 'origin', 'gh-pages'], pagesRepo);
    run('git', ['reset', '-q', '--hard', 'FETCH_HEAD'], pagesRepo);
  } catch {
    // No gh-pages branch on the remote yet: the copy keeps its own state.
  }
}

writeFileSync(join(site, '.nojekyll'), '');
const result = await syncSite(site, pagesRepo);
run('git', ['add', '-A'], pagesRepo);
if (out('git', ['status', '--porcelain'], pagesRepo)) {
  run('git', [...identity, 'commit', '-q', '-m', 'Deploy'], pagesRepo);
  run('git', [...auth, 'push', 'origin', 'gh-pages'], pagesRepo);
  console.log(`Pushed ${result.written.length} changed and ${result.deleted.length} deleted files, ${(result.bytes / 1e6).toFixed(1)} MB of changed content.`);
} else {
  console.log('Nothing changed: 0 files, 0 bytes pushed.');
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
