import chalk from 'chalk';
import type { Message } from '../types/index.js';
import type { LLMProviderInterface, LLMResponse } from '../llm/types.js';

export interface ModelComparisonResult {
  model: string;
  provider: string;
  response: string;
  duration: number;
  tokens?: number;
  score?: number;
}

export interface ComparisonConfig {
  models: Array<{ provider: string; model: string }>;
  prompt: string;
  systemPrompt?: string;
  parallel: boolean;
  scoringCriteria?: string[];
}

export class MultiModelComparator {
  private clients: Map<string, LLMProviderInterface> = new Map();

  registerClient(key: string, client: LLMProviderInterface): void {
    this.clients.set(key, client);
  }

  async compare(config: ComparisonConfig): Promise<ModelComparisonResult[]> {
    const results: ModelComparisonResult[] = [];

    const tasks = config.models.map(async ({ provider, model }) => {
      const key = `${provider}:${model}`;
      const client = this.clients.get(key);

      if (!client) {
        return {
          model,
          provider,
          response: `Client not found: ${key}`,
          duration: 0,
          score: 0,
        } as ModelComparisonResult;
      }

      const startTime = Date.now();
      try {
        const messages: Message[] = [];
        if (config.systemPrompt) {
          messages.push({ role: 'system', content: config.systemPrompt });
        }
        messages.push({ role: 'user', content: config.prompt });

        const response = await client.chat(messages);
        const duration = Date.now() - startTime;

        return {
          model,
          provider,
          response: response.content,
          duration,
          tokens: response.usage?.totalTokens,
          score: undefined,
        } as ModelComparisonResult;
      } catch (error) {
        return {
          model,
          provider,
          response: `Error: ${error instanceof Error ? error.message : String(error)}`,
          duration: Date.now() - startTime,
          score: 0,
        } as ModelComparisonResult;
      }
    });

    const allResults = await Promise.all(tasks);

    for (const result of allResults) {
      results.push(result);
    }

    if (config.scoringCriteria && config.scoringCriteria.length > 0) {
      this.scoreResults(results, config.scoringCriteria);
    }

    return results.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  private scoreResults(results: ModelComparisonResult[], criteria: string[]): void {
    for (const result of results) {
      let totalScore = 0;
      let criteriaCount = 0;

      for (const criterion of criteria) {
        const criterionLower = criterion.toLowerCase();
        
        if (criterionLower.includes('长度') || criterionLower.includes('length')) {
          const words = result.response.split(/\s+/).length;
          totalScore += Math.min(words / 100, 1) * 10;
          criteriaCount++;
        }
        
        if (criterionLower.includes('详细') || criterionLower.includes('detail')) {
          const hasStructure = result.response.includes('\n') || result.response.includes('：');
          totalScore += hasStructure ? 5 : 2;
          criteriaCount++;
        }
        
        if (criterionLower.includes('专业') || criterionLower.includes('expert')) {
          const techTerms = ['系统', '架构', '设计', '原理', '方法', '技术', 'algorithm', 'design'];
          const hasTech = techTerms.some(t => result.response.includes(t));
          totalScore += hasTech ? 5 : 2;
          criteriaCount++;
        }

        if (criterionLower.includes('创意') || criterionLower.includes('creative')) {
          const uniqueWords = new Set(result.response.split(/\s+/));
          const ratio = uniqueWords.size / result.response.split(/\s+/).length;
          totalScore += ratio * 5;
          criteriaCount++;
        }
      }

      result.score = criteriaCount > 0 ? totalScore / criteriaCount : 5;
    }
  }

  printComparisonResults(results: ModelComparisonResult[]): void {
    console.log(chalk.bold('\n📊 模型对比结果\n'));

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result) continue;
      
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `  ${i + 1}.`;
      
      console.log(chalk.cyan(`${medal} ${result.model}`) + chalk.gray(` (${result.provider})`));
      console.log(chalk.gray(`   耗时: ${result.duration}ms` + (result.tokens ? ` | Token: ${result.tokens}` : '')));
      
      if (result.score !== undefined) {
        const scoreColor = result.score >= 7 ? chalk.green : result.score >= 4 ? chalk.yellow : chalk.red;
        console.log(chalk.gray(`   评分: `) + scoreColor(`${result.score.toFixed(1)}/10`));
      }
      
      console.log(chalk.gray('   响应: '));
      const preview = result.response.slice(0, 200);
      console.log(chalk.gray(`   ${preview}${result.response.length > 200 ? '...' : ''}`));
      console.log();
    }
  }

  async askDifferentModels(
    prompt: string,
    models: Array<{ provider: string; model: string }>,
    aggregatorStrategy: 'vote' | 'synthesize' | 'best'
  ): Promise<{ finalResponse: string; responses: ModelComparisonResult[]; strategy: string }> {
    const results = await this.compare({
      models,
      prompt,
      parallel: true,
    });

    let finalResponse: string = '';

    switch (aggregatorStrategy) {
      case 'vote': {
        const sorted = [...results].sort((a, b) => b.response.length - a.response.length);
        finalResponse = sorted[0]?.response || '';
        break;
      }

      case 'best': {
        const best = results[0];
        if (best) {
          finalResponse = `综合评分最高的回答 (${best.model}):\n\n${best.response}`;
        }
        break;
      }

      case 'synthesize': {
        const synthesis = `根据 ${results.length} 个模型的回答综合分析:\n\n`;
        const summary = results.map((r, i) => 
          `${i + 1}. [${r.model}]: ${r.response.slice(0, 100)}...`
        ).join('\n');
        finalResponse = synthesis + summary;
        break;
      }

      default: {
        finalResponse = results[0]?.response || '';
      }
    }

    return {
      finalResponse,
      responses: results,
      strategy: aggregatorStrategy,
    };
  }
}

export const multiModelComparator = new MultiModelComparator();
