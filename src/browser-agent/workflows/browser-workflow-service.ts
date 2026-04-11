import { promises as fs } from 'fs';
import * as path from 'path';
import type { BrowserAgentTask, BrowserWorkflow, BrowserWorkflowLintResult, BrowserWorkflowLintSummary, BrowserWorkflowResolution, BrowserWorkflowTemplateResult } from '../domain/types.js';
import { MarkdownWorkflowRegistry, type MarkdownWorkflowRegistryOptions } from './markdown-workflow-registry.js';

export interface BrowserWorkflowServiceOptions extends MarkdownWorkflowRegistryOptions {}

export class BrowserWorkflowService {
  private readonly registry: MarkdownWorkflowRegistry;

  constructor(private readonly options: BrowserWorkflowServiceOptions = {}) {
    this.registry = new MarkdownWorkflowRegistry(options);
  }

  getWorkflowDir(): string {
    return this.registry.getWorkflowDir();
  }

  listWorkflows(): Promise<BrowserWorkflowResolution> {
    return this.registry.listWorkflows();
  }

  inspectWorkflow(inputPath: string): Promise<BrowserWorkflow> {
    return this.registry.inspectWorkflow(inputPath);
  }

  lintWorkflows(): Promise<BrowserWorkflowLintSummary> {
    return this.registry.lintWorkflows();
  }

  lintWorkflow(inputPath: string): Promise<BrowserWorkflowLintResult> {
    return this.registry.lintWorkflow(inputPath);
  }

  resolveTask(task: BrowserAgentTask): Promise<{ task: BrowserAgentTask; resolution: BrowserWorkflowResolution }> {
    return this.registry.resolve(task);
  }

  async createWorkflowTemplate(name: string, input: { description?: string; startUrl?: string; match?: string[] } = {}): Promise<BrowserWorkflowTemplateResult> {
    const workflowDir = this.getWorkflowDir();
    await fs.mkdir(workflowDir, { recursive: true });

    const normalizedName = sanitizeWorkflowName(name);
    const filePath = path.join(workflowDir, `${normalizedName}.md`);

    try {
      await fs.access(filePath);
      throw new Error(`Workflow already exists: ${filePath}`);
    } catch (error) {
      if (error instanceof Error && !/ENOENT/i.test(error.message)) {
        throw error;
      }
    }

    await fs.writeFile(filePath, buildWorkflowTemplate(normalizedName, input), 'utf8');
    return { name: normalizedName, filePath };
  }
}

function sanitizeWorkflowName(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9-_\s]+/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'browser-workflow';
}

function buildWorkflowTemplate(name: string, input: { description?: string; startUrl?: string; match?: string[] }): string {
  const description = input.description?.trim() || `Describe the browser workflow for ${name}`;
  const match = input.match && input.match.length > 0 ? input.match : ['example.com'];

  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    input.startUrl ? `startUrl: ${input.startUrl}` : undefined,
    'match:',
    ...match.map(item => `  - ${item}`),
    'priority: 100',
    'selectorSlots:',
    '  searchBox:',
    '    - input[type="search"]',
    '    - input[name="q"]',
    '  submitButton:',
    '    - button[type="submit"]',
    '    - input[type="submit"]',
    'preferredSelectors:',
    '  fill:',
    '    - $searchBox',
    '  click:',
    '    - $submitButton',
    'fallbackActions:',
    '  click:',
    '    - press:Enter',
    '    - wait:800',
    'scripts:',
    '  userscriptPaths:',
    '    - ./browser-scripts/example-helper.user.js',
    '  userscriptMode: on',
    '  userscriptRunAt: document-end',
    'scriptApis:',
    '  - name: UserscriptBridge.collectResults',
    '    description: Collect visible search results through the bound userscript helper.',
    '    args:',
    '      - query',
    '    returns:',
    '      type: array',
    '      shape: { title: string; url: string }',
    '      description: Ordered visible result cards',
    'doneConditions:',
    '  - urlIncludes:success',
    'maxRetries: 2',
    '---',
    '',
    `# ${name}`,
    '',
    '## When to Use',
    'Describe when this workflow should be applied.',
    '',
    '## Steps',
    '1. Describe the first browser step.',
    '2. Describe the second browser step.',
    '3. Describe the expected output.',
    '',
    '## Hints',
    '- Mention important page-specific tips.',
    '- Mention what to avoid or retry.',
    '',
    '## Selector Slots',
    '- searchBox: input[type="search"]',
    '- submitButton: button[type="submit"]',
    '',
    '## Preferred Selectors',
    '- fill: $searchBox',
    '- click: $submitButton',
    '',
    '## Phase Steps',
    '### search-input',
    '1. Fill the search box with the requested query.',
    '2. Submit the search.',
    '',
    '### search-results',
    '1. Scan result cards and open the most relevant one.',
    '2. Extract the visible details needed by the user.',
    '',
    '## Phase Preferred Selectors',
    '### search-input',
    '- fill: $searchBox',
    '- click: $submitButton',
    '',
    '### search-results',
    '- click: a[href]',
    '- extract: body',
    '',
    '## Fallback Actions',
    '- click: press:Enter',
    '- click: wait:800',
    '',
    '## Script Notes',
    '- Put site-specific helper scripts under browser-scripts/ and bind them through frontmatter scripts/scriptApis.',
    '- If your userscript exposes window.UserscriptBridge.*, the planner can prefer call_userscript_api over brittle selector chains.',
    '',
    '## Phase Done Conditions',
    '### detail',
    '- textIncludes:详情',
    '- textIncludes:岗位描述',
    '',
    '## Done Conditions',
    '- urlIncludes:success',
    '',
    '## Success',
    '- Define what counts as a completed workflow.',
  ].filter((line): line is string => typeof line === 'string').join('\n');
}