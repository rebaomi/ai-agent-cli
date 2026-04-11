import type { BrowserWorkflowLintIssue, BrowserWorkflowLintResult, BrowserWorkflowQuickFixDraft } from '../domain/types.js';

type LintLikeResult = Pick<BrowserWorkflowLintResult, 'filePath' | 'issues'>;

interface QuickFixAccumulator {
  draft: BrowserWorkflowQuickFixDraft;
  fileSet: Set<string>;
}

export function buildBrowserWorkflowQuickFixDrafts(results: LintLikeResult[]): BrowserWorkflowQuickFixDraft[] {
  const grouped = new Map<string, QuickFixAccumulator>();

  for (const result of results) {
    for (const issue of result.issues) {
      if (!issue.suggestion?.summary) {
        continue;
      }

      const key = buildDraftKey(issue);
      const existing = grouped.get(key);
      if (existing) {
        existing.draft.count += 1;
        existing.fileSet.add(result.filePath);
        continue;
      }

      grouped.set(key, {
        draft: {
          code: issue.code,
          severity: issue.severity,
          summary: issue.suggestion.summary,
          example: issue.suggestion.example,
          count: 1,
          files: [],
          phase: issue.phase,
          heading: issue.heading,
        },
        fileSet: new Set([result.filePath]),
      });
    }
  }

  return Array.from(grouped.values())
    .map(({ draft, fileSet }) => ({
      ...draft,
      files: Array.from(fileSet).sort((left, right) => left.localeCompare(right)),
    }))
    .sort(compareDrafts);
}

function buildDraftKey(issue: BrowserWorkflowLintIssue): string {
  return [
    issue.severity,
    issue.code,
    issue.suggestion?.summary || '',
    issue.suggestion?.example || '',
  ].join('::');
}

function compareDrafts(left: BrowserWorkflowQuickFixDraft, right: BrowserWorkflowQuickFixDraft): number {
  const severityDelta = severityRank(left.severity) - severityRank(right.severity);
  if (severityDelta !== 0) {
    return severityDelta;
  }

  const countDelta = right.count - left.count;
  if (countDelta !== 0) {
    return countDelta;
  }

  return left.code.localeCompare(right.code);
}

function severityRank(severity: BrowserWorkflowQuickFixDraft['severity']): number {
  return severity === 'error' ? 0 : 1;
}