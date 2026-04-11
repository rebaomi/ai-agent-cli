import type { DirectActionResult } from '../../direct-action-router.js';
import type { DirectActionHandler } from '../request-handler.js';
import type { VisionActionRuntime } from '../runtime-context.js';

export class VisionActionHandler implements DirectActionHandler {
  readonly name = 'vision-action';

  constructor(private readonly runtime: VisionActionRuntime) {}

  canHandle(input: string): boolean {
    if (!/(分析|识别|理解|看看|检查|总结|描述)/i.test(input)) {
      return false;
    }

    if (!/(图片|截图|照片|image|images|screenshot|screenshots|photo)/i.test(input)) {
      return false;
    }

    return this.runtime.extractPathCandidates(input).length > 0;
  }

  async handle(input: string): Promise<DirectActionResult | null> {
    const targets = this.runtime.extractPathCandidates(input);
    if (targets.length === 0) {
      return null;
    }

    const prompt = this.buildPrompt(input);
    const maxImages = this.extractLimit(input);

    try {
      const result = await this.runtime.analyzeTargets({
        targets,
        prompt,
        maxImages,
      });

      return {
        handled: true,
        title: '[Direct image analysis]',
        output: [
          `已分析 ${result.imageCount} 张图片`,
          `目标: ${result.resolvedTargets.join(', ')}`,
          `模型: ${result.model}`,
          '',
          result.response,
        ].join('\n'),
        category: 'vision-action',
      };
    } catch (error) {
      return {
        handled: true,
        title: '[Direct image analysis]',
        output: error instanceof Error ? error.message : String(error),
        isError: true,
        category: 'vision-action',
      };
    }
  }

  private buildPrompt(input: string): string {
    const trimmed = input.trim();
    const strippedPaths = this.runtime.extractPathCandidates(trimmed).reduce(
      (current, candidate) => current.replace(candidate, ' '),
      trimmed,
    );
    const withoutLeadingVerb = strippedPaths
      .replace(/^(?:请)?(?:帮我)?(?:分析|识别|理解|看看|检查|总结|描述)/i, '')
      .replace(/(?:里|中|目录下)?的?(?:图片|截图|照片|image|images|screenshot|screenshots|photo)/gi, '')
      .replace(/(?:路径|目录|文件夹|文件)/gi, '')
      .trim();

    return withoutLeadingVerb.length > 0
      ? `请基于这些图片完成以下分析要求：${withoutLeadingVerb}`
      : '请逐张识别这些图片的主要内容，并给出整体总结、异常点和建议。';
  }

  private extractLimit(input: string): number | undefined {
    const match = input.match(/(?:前|最多|limit)\s*(\d{1,2})\s*张?/i);
    if (!match?.[1]) {
      return undefined;
    }

    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
}