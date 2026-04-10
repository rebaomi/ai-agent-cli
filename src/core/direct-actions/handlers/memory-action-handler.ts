import type { DirectActionResult } from '../../direct-action-router.js';
import type { DirectActionHandler } from '../request-handler.js';
import type { MemoryActionRuntime } from '../runtime-context.js';

interface ParsedMemoryProfile {
  job?: string;
  interests: string[];
  summary: string;
}

export class MemoryActionHandler implements DirectActionHandler {
  readonly name = 'memory-action';

  constructor(private readonly runtime: MemoryActionRuntime) {}

  canHandle(input: string): boolean {
    return /(长期记忆|写入记忆|写进记忆|存入记忆|存到记忆|记住|记下来)/i.test(input)
      && /(我是|我喜欢|爱好|兴趣|偏好|习惯)/.test(input);
  }

  async handle(input: string): Promise<DirectActionResult | null> {
    const profile = this.parseProfile(input);
    if (!profile) {
      return null;
    }

    if (profile.job) {
      await this.runtime.storeMemory({
        kind: 'preference',
        title: 'job',
        key: 'job',
        content: profile.job,
      });
    }

    if (profile.interests.length > 0) {
      await this.runtime.storeMemory({
        kind: 'preference',
        title: 'interests',
        key: 'interests',
        content: profile.interests.join('、'),
        metadata: { interests: profile.interests },
      });
    }

    await this.runtime.storeMemory({
      kind: 'knowledge',
      title: 'user_profile_summary',
      content: profile.summary,
      metadata: {
        source: 'memory_direct_action',
        job: profile.job,
        interests: profile.interests,
      },
    });

    return {
      handled: true,
      title: '[Direct memory write]',
      output: [
        '已写入长期记忆。',
        profile.job ? `职业: ${profile.job}` : undefined,
        profile.interests.length > 0 ? `兴趣/爱好: ${profile.interests.join('、')}` : undefined,
      ].filter(Boolean).join('\n'),
    };
  }

  private parseProfile(input: string): ParsedMemoryProfile | null {
    const normalized = input
      .replace(/请帮我|帮我|写入长期记忆|写进长期记忆|写入记忆|写进记忆|存入长期记忆|存到长期记忆|存入记忆|存到记忆|记到长期记忆|记住|记下来/gi, ' ')
      .replace(/[。！？!?,，；;]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const job = normalized.match(/我是([^，,。；;\s]+)/)?.[1]?.trim();
    const interestChunks = [
      normalized.match(/(?:我喜欢|喜欢)([^。；;]+)/)?.[1],
      normalized.match(/(?:爱好|兴趣)([^。；;]+)/)?.[1],
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    const interests = Array.from(new Set(interestChunks
      .flatMap(chunk => chunk.split(/[、,，和及\s]+/))
      .map(item => item.trim())
      .filter(item => item.length > 0 && item !== '我' && item !== '是')));

    if (!job && interests.length === 0) {
      return null;
    }

    return {
      job,
      interests,
      summary: [
        job ? `用户是${job}` : undefined,
        interests.length > 0 ? `喜欢/爱好${interests.join('、')}` : undefined,
      ].filter(Boolean).join('，'),
    };
  }
}