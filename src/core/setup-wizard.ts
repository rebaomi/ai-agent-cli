import inquirer from 'inquirer';
import type { AgentConfig, OutputConfig, WorkflowCheckpointConfig } from '../types/index.js';

export type SetupWizardOutputMode = 'quiet' | 'normal' | 'verbose';
export type SetupWizardAgentCatMode = 'terminal' | 'desktop' | 'off';
export type SetupWizardCheckpointLevel = 'minimal' | 'balanced' | 'paranoid';

export interface SetupWizardSelections {
  outputMode: SetupWizardOutputMode;
  agentcatMode: SetupWizardAgentCatMode;
  checkpointLevel: SetupWizardCheckpointLevel;
}

export interface SetupWizardState extends SetupWizardSelections {
  completed: boolean;
  completedAt: string;
}

export interface SetupWizardConfigPatch {
  output: OutputConfig;
  checkpoints: WorkflowCheckpointConfig;
  setupWizard: SetupWizardState;
}

export async function runSetupWizard(): Promise<SetupWizardSelections> {
  return inquirer.prompt<SetupWizardSelections>([
    {
      type: 'list',
      name: 'outputMode',
      message: '输出模式？',
      choices: [
        { name: 'quiet: 尽量安静，只保留关键提示', value: 'quiet' },
        { name: 'normal: 平衡模式', value: 'normal' },
        { name: 'verbose: 输出更详细的过程信息', value: 'verbose' },
      ],
      default: 'normal',
    },
    {
      type: 'list',
      name: 'agentcatMode',
      message: 'AgentCat 提醒方式？',
      choices: [
        { name: 'terminal: 在终端提醒', value: 'terminal' },
        { name: 'desktop: 使用桌面通知', value: 'desktop' },
        { name: 'off: 关闭提醒展示', value: 'off' },
      ],
      default: 'desktop',
    },
    {
      type: 'list',
      name: 'checkpointLevel',
      message: '检查点级别？',
      choices: [
        { name: 'minimal: 仅必要检查点', value: 'minimal' },
        { name: 'balanced: 默认平衡', value: 'balanced' },
        { name: 'paranoid: 更严格的人为确认', value: 'paranoid' },
      ],
      default: 'balanced',
    },
  ]);
}

export function buildSetupWizardConfigPatch(
  selections: SetupWizardSelections,
  currentConfig: AgentConfig = {} as AgentConfig,
): SetupWizardConfigPatch {
  return {
    output: buildOutputConfigFromWizard(selections, currentConfig.output),
    checkpoints: buildCheckpointConfigFromWizard(selections.checkpointLevel, currentConfig.checkpoints),
    setupWizard: {
      ...selections,
      completed: true,
      completedAt: new Date().toISOString(),
    },
  };
}

export function buildOutputConfigFromWizard(
  selections: Pick<SetupWizardSelections, 'outputMode' | 'agentcatMode'>,
  currentOutput: OutputConfig = {},
): OutputConfig {
  const next: OutputConfig = {
    ...currentOutput,
    verbosity: selections.outputMode,
    process: {
      ...currentOutput.process,
      enabled: true,
      minLevel: selections.outputMode === 'quiet' ? 'warning' : 'info',
    },
    notification: {
      ...currentOutput.notification,
      enabled: selections.outputMode !== 'quiet',
      minLevel: selections.outputMode === 'verbose' ? 'info' : 'warning',
    },
    permission: {
      ...currentOutput.permission,
      enabled: true,
      minLevel: 'info',
    },
    agentcat: {
      ...currentOutput.agentcat,
      mode: selections.agentcatMode,
      displayInTerminal: selections.agentcatMode === 'terminal',
      useDesktopNotification: selections.agentcatMode === 'desktop',
    },
  };

  return next;
}

export function buildCheckpointConfigFromWizard(
  checkpointLevel: SetupWizardCheckpointLevel,
  currentCheckpoints: WorkflowCheckpointConfig = {},
): WorkflowCheckpointConfig {
  const base: WorkflowCheckpointConfig = {
    ...currentCheckpoints,
    level: checkpointLevel,
    enabled: true,
  };

  if (checkpointLevel === 'minimal') {
    return {
      ...base,
      planApproval: false,
      continuationApproval: false,
      outboundApproval: true,
      riskyDirectActionApproval: true,
      riskyStepApproval: false,
      stepExecutionApproval: false,
      stepResultApproval: false,
    };
  }

  if (checkpointLevel === 'paranoid') {
    return {
      ...base,
      planApproval: true,
      continuationApproval: true,
      outboundApproval: true,
      riskyDirectActionApproval: true,
      riskyStepApproval: true,
      stepExecutionApproval: true,
      stepResultApproval: true,
    };
  }

  return {
    ...base,
    planApproval: true,
    continuationApproval: true,
    outboundApproval: true,
    riskyDirectActionApproval: true,
    riskyStepApproval: true,
    stepExecutionApproval: true,
    stepResultApproval: false,
  };
}