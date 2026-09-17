import { describe, expect, it } from 'vitest';
import { canonicalGithubUrl, findGithubRefIn, parseGithubUrl, shortGithubLabel } from '../../../../src/main/github/url';

describe('parseGithubUrl', () => {
  const accepted: Array<[string, { owner: string; repo: string; type: 'issue' | 'pull'; number: number; host?: string }]> = [
    ['https://github.com/vercel/next.js/issues/1234', { owner: 'vercel', repo: 'next.js', type: 'issue', number: 1234 }],
    ['https://github.com/vercel/next.js/pull/1234', { owner: 'vercel', repo: 'next.js', type: 'pull', number: 1234 }],
    ['https://github.com/o/r/pulls/7', { owner: 'o', repo: 'r', type: 'pull', number: 7 }],
    ['https://www.github.com/o/r/issues/7', { owner: 'o', repo: 'r', type: 'issue', number: 7 }],
    ['http://github.com/o/r/issues/7', { owner: 'o', repo: 'r', type: 'issue', number: 7 }],
    ['https://github.com/o/r/pull/42/files', { owner: 'o', repo: 'r', type: 'pull', number: 42 }],
    ['https://github.com/o/r/pull/42/commits/abc123', { owner: 'o', repo: 'r', type: 'pull', number: 42 }],
    ['https://github.com/o/r/issues/42#issuecomment-99', { owner: 'o', repo: 'r', type: 'issue', number: 42 }],
    ['https://github.com/o/r/issues/42?foo=bar', { owner: 'o', repo: 'r', type: 'issue', number: 42 }],
    ['  https://github.com/o/r/issues/42  ', { owner: 'o', repo: 'r', type: 'issue', number: 42 }],
    ['o/r#42', { owner: 'o', repo: 'r', type: 'issue', number: 42 }],
    ['my-org/my_repo.js#7', { owner: 'my-org', repo: 'my_repo.js', type: 'issue', number: 7 }],
  ];
  it.each(accepted)('accepts %s', (input, expected) => {
    expect(parseGithubUrl(input)).toEqual({ host: expected.host ?? 'github.com', owner: expected.owner, repo: expected.repo, type: expected.type, number: expected.number });
  });

  const rejected = [
    '',
    'not a url',
    'https://github.com/o/r',
    'https://github.com/o/r/',
    'https://github.com/o/r/commit/abc123def',
    'https://github.com/o/r/blob/main/README.md',
    'https://github.com/o/r/discussions/12',
    'https://github.com/orgs/o/projects/3',
    'https://gitlab.com/o/r/issues/7',
    'https://githubbb.com/o/r/issues/7',
    'https://evil.com/github.com/o/r/issues/7',
    'https://github.enterprise.dev/o/r/issues/7',
    'javascript:alert(1)//github.com/o/r/issues/1',
    'https://github.com/o/r/issues/0',
    'https://github.com/o/r/issues/abc',
    'o/r#0',
    'o/r',
  ];
  it.each(rejected)('rejects %s', (input) => {
    expect(parseGithubUrl(input)).toBeNull();
  });

  it('accepts a GitHub Enterprise host only when one is supplied', () => {
    const url = 'https://github.acme.dev/team/svc/pull/9';
    expect(parseGithubUrl(url)).toBeNull();
    expect(parseGithubUrl(url, { host: 'github.acme.dev' })).toEqual({ host: 'github.acme.dev', owner: 'team', repo: 'svc', type: 'pull', number: 9 });
    expect(parseGithubUrl(url, { host: 'github.other.dev' })).toBeNull();
    // github.com keeps working alongside an enterprise host.
    expect(parseGithubUrl('https://github.com/o/r/issues/1', { host: 'github.acme.dev' })?.host).toBe('github.com');
  });

  it('uses the enterprise host for the shorthand form', () => {
    expect(parseGithubUrl('o/r#3', { host: 'github.acme.dev' })?.host).toBe('github.acme.dev');
  });

  it('rejects absurdly long input without scanning it', () => {
    expect(parseGithubUrl(`https://github.com/o/r/issues/1${'?x=1'.repeat(1000)}`)).toBeNull();
  });
});

describe('canonicalGithubUrl / shortGithubLabel', () => {
  it('normalizes www and the pulls alias', () => {
    const ref = parseGithubUrl('https://www.github.com/o/r/pulls/12')!;
    expect(canonicalGithubUrl(ref)).toBe('https://github.com/o/r/pull/12');
    expect(shortGithubLabel(ref)).toBe('o/r#12');
  });
  it('round-trips an issue', () => {
    const ref = parseGithubUrl('o/r#5')!;
    expect(canonicalGithubUrl(ref)).toBe('https://github.com/o/r/issues/5');
  });
});

describe('findGithubRefIn', () => {
  it('finds a url inside pasted prose and strips trailing punctuation', () => {
    const found = findGithubRefIn('please look at https://github.com/o/r/pull/8, thanks');
    expect(found?.raw).toBe('https://github.com/o/r/pull/8');
    expect(found?.ref.number).toBe(8);
  });
  it('finds the shorthand form', () => {
    expect(findGithubRefIn('fixes o/r#31 today')?.ref).toMatchObject({ owner: 'o', repo: 'r', number: 31 });
  });
  it('ignores non-github links', () => {
    expect(findGithubRefIn('see https://example.com/o/r/issues/1')).toBeNull();
  });
  it('returns null for plain text', () => {
    expect(findGithubRefIn('just a note')).toBeNull();
  });
});
