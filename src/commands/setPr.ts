import { reviewPaths } from '../paths';
import { clearPr, loadPr, nowIso, savePr } from '../store';
import { PrLink, PrProvider } from '../types';

export interface SetPrOptions {
  url?: string;
  clear?: boolean;
  cwd?: string;
}

const GITHUB_PR = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#].*)?$/;
// GitLab (gitlab.com or self-hosted): <host>/<group>[/<subgroup>...]/<project>/-/merge_requests/<n>
const GITLAB_MR = /^https:\/\/[^/]+\/(?:[^/]+\/)+-\/merge_requests\/(\d+)(?:[/?#].*)?$/;

// Provider and number from a PR/MR URL. null = not a URL set-pr accepts.
export function parsePrUrl(url: string): { provider: PrProvider; number: number } | null {
  const gh = GITHUB_PR.exec(url);
  if (gh) return { provider: 'github', number: Number(gh[1]) };
  const gl = GITLAB_MR.exec(url);
  if (gl) return { provider: 'gitlab', number: Number(gl[1]) };
  return null;
}

// Record (or with --clear, remove) the PR/MR opened for the current branch.
export function setPr(opts: SetPrOptions): void {
  const paths = reviewPaths(opts.cwd ?? process.cwd());
  if (opts.clear) {
    if (opts.url !== undefined) {
      console.error('error: --url と --clear は同時に指定できません');
      process.exit(1);
    }
    const had = loadPr(paths.pr) !== null;
    clearPr(paths.pr);
    console.log(JSON.stringify({ status: had ? 'cleared' : 'unchanged', branch: paths.branch }, null, 2));
    return;
  }
  const url = opts.url?.trim();
  if (!url) {
    console.error('error: --url <PR/MR の URL> または --clear を指定してください');
    process.exit(1);
  }
  const parsed = parsePrUrl(url);
  if (!parsed) {
    console.error(
      'error: PR/MR の URL として解釈できません。' +
        'https://github.com/<owner>/<repo>/pull/<番号> か ' +
        'https://<host>/<group>/<project>/-/merge_requests/<番号> の形式で指定してください'
    );
    process.exit(1);
  }
  const pr: PrLink = { url, provider: parsed.provider, number: parsed.number, setAt: nowIso() };
  savePr(paths.pr, pr);
  console.log(JSON.stringify({ status: 'set', branch: paths.branch, pr }, null, 2));
}
