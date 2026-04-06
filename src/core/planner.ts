import type { Message } from '../types/index.js';
import { OllamaClient } from '../ollama/client.js';

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

export interface Plan {
  id: string;
  originalTask: string;
  steps: PlanStep[];
  currentStepIndex: number;
  status: 'planning' | 'executing' | 'completed' | 'failed';
}

export interface PlannerOptions {
  ollama: OllamaClient;
  maxSteps?: number;
}

const PLANNER_PROMPT = `你是一个任务规划专家。当用户提出复杂任务时，你需要：

1. 分析任务需求
2. 将任务拆分成清晰的步骤
3. 确定每个步骤需要的工具或操作

请用 JSON 格式返回任务规划：
{
  "task": "原任务描述",
  "steps": [
    {
      "id": "step_1",
      "description": "步骤1描述",
      "tool": "需要的工具名（如不需要填 null）",
      "args": { "工具参数（如不需要填 {}）" }
    }
  ]
}

规则：
- 步骤数量控制在 3-8 个之间
- 每个步骤描述要清晰具体
- 只返回 JSON，不要其他内容`;

export class Planner {
  private ollama: OllamaClient;
  private maxSteps: number;
  private currentPlan?: Plan;

  constructor(options: PlannerOptions) {
    this.ollama = options.ollama;
    this.maxSteps = options.maxSteps ?? 10;
  }

  async createPlan(task: string): Promise<Plan> {
    const planId = `plan_${Date.now()}`;
    
    this.currentPlan = {
      id: planId,
      originalTask: task,
      steps: [],
      currentStepIndex: 0,
      status: 'planning',
    };

    try {
      const response = await this.ollama.generate([
        { role: 'system', content: PLANNER_PROMPT },
        { role: 'user', content: `请规划这个任务：${task}` }
      ]);

      const planData = this.parsePlanResponse(response);
      
      if (planData && planData.steps) {
        this.currentPlan.steps = planData.steps.map((step: { id?: string; description?: string; tool?: string; args?: Record<string, unknown> }, index: number) => ({
          id: step.id || `step_${index + 1}`,
          description: step.description || '',
          status: 'pending' as const,
          toolCalls: step.tool ? [{ name: step.tool, args: step.args || {} }] : undefined,
        }));
      }

      return this.currentPlan;
    } catch (error) {
      this.currentPlan.status = 'failed';
      throw error;
    }
  }

  private parsePlanResponse(response: string): { task?: string; steps: Array<{ id?: string; description?: string; tool?: string; args?: Record<string, unknown> }> } | null {
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```|(\{[\s\S]*\})/);
    if (jsonMatch) {
      try {
        const jsonStr = jsonMatch[1] ?? jsonMatch[2] ?? '';
        if (!jsonStr) return this.parseSimplePlan(response);
        return JSON.parse(jsonStr);
      } catch {
        return this.parseSimplePlan(response);
      }
    }
    return this.parseSimplePlan(response);
  }

  private parseSimplePlan(response: string): { steps: Array<{ id: string; description: string; tool?: string; args?: Record<string, unknown> }> } {
    const lines = response.split('\n').filter((line: string) => line.trim());
    const steps: Array<{ id: string; description: string; tool?: string; args?: Record<string, unknown> }> = [];
    
    let stepCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-') || trimmed.match(/^\d+[\.\)]/)) {
        stepCount++;
        const desc = trimmed.replace(/^-\s*|^\d+[\.\)]\s*/, '');
        steps.push({
          id: `step_${stepCount}`,
          description: desc,
        });
      }
    }

    if (steps.length === 0) {
      steps.push({
        id: 'step_1',
        description: response.slice(0, 200),
      });
    }

    return { steps };
  }

  getCurrentPlan(): Plan | undefined {
    return this.currentPlan;
  }

  getNextStep(): PlanStep | null {
    if (!this.currentPlan) return null;
    
    const nextStep = this.currentPlan.steps.find(s => s.status === 'pending');
    if (nextStep) {
      nextStep.status = 'in_progress';
      this.currentPlan.status = 'executing';
    }
    return nextStep || null;
  }

  completeStep(stepId: string, result: string): void {
    if (!this.currentPlan) return;
    
    const step = this.currentPlan.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'completed';
      step.result = result;
    }

    const pendingSteps = this.currentPlan.steps.filter(s => s.status === 'pending');
    if (pendingSteps.length === 0) {
      this.currentPlan.status = 'completed';
    }
  }

  failStep(stepId: string, error: string): void {
    if (!this.currentPlan) return;
    
    const step = this.currentPlan.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'failed';
      step.result = error;
    }
    this.currentPlan.status = 'failed';
  }

  getProgress(): { current: number; total: number; percentage: number } {
    if (!this.currentPlan) {
      return { current: 0, total: 0, percentage: 0 };
    }
    
    const completed = this.currentPlan.steps.filter(s => s.status === 'completed').length;
    const total = this.currentPlan.steps.length;
    
    return {
      current: completed,
      total,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }

  formatPlanSummary(): string {
    if (!this.currentPlan) return '';
    
    let summary = `\n📋 **任务规划**\n`;
    summary += `**原任务**: ${this.currentPlan.originalTask}\n\n`;
    
    for (const step of this.currentPlan.steps) {
      const icon = step.status === 'completed' ? '✅' : 
                   step.status === 'in_progress' ? '🔄' : 
                   step.status === 'failed' ? '❌' : '⬜';
      summary += `${icon} ${step.description}`;
      if (step.result && step.status === 'completed') {
        const resultPreview = step.result.slice(0, 100);
        summary += `\n   └─ ${resultPreview}${step.result.length > 100 ? '...' : ''}`;
      }
      summary += '\n';
    }
    
    const progress = this.getProgress();
    summary += `\n进度: ${progress.current}/${progress.total} (${progress.percentage}%)`;
    
    return summary;
  }
}

export function createPlanner(options: PlannerOptions): Planner {
  return new Planner(options);
}
