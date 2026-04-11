import type { AgentGraphCheckpoint, FunctionRoutingConfig } from '../types/index.js';
import type { SessionTaskBinding } from './session-task-stack-manager.js';

export interface ChatRouterAgentView {
  getConfirmationStatus(): { pending: boolean; type?: string; prompt?: string };
  detectComplexTask(input: string): Promise<boolean>;
}

export interface ChatRouterDecision {
  target: 'chat' | 'task';
  reason: 'pending_interaction' | 'checkpoint_resume' | 'follow_up_task' | 'direct_action_request' | 'workflow_request' | 'complex_task' | 'knowledge_chat' | 'social_chat';
  intent: 'resume_task' | 'follow_up_task' | 'direct_action' | 'workflow_task' | 'knowledge_chat' | 'social_chat';
}

export interface ChatRouterRouteInput {
  input: string;
  taskBinding: SessionTaskBinding;
  checkpoint?: AgentGraphCheckpoint;
  agent: ChatRouterAgentView;
  policy?: FunctionRoutingConfig;
}

export class ChatRouter {
  async route(input: ChatRouterRouteInput): Promise<ChatRouterDecision> {
    const policy = this.getPolicy(input.policy);

    if (input.agent.getConfirmationStatus().pending) {
      return { target: 'task', reason: 'pending_interaction', intent: 'resume_task' };
    }

    if (input.checkpoint) {
      return { target: 'task', reason: 'checkpoint_resume', intent: 'resume_task' };
    }

    if (input.taskBinding.isFollowUp) {
      return { target: 'task', reason: 'follow_up_task', intent: 'follow_up_task' };
    }

    const effectiveInput = input.taskBinding.effectiveInput || input.input;
    const conversationalReason = this.classifyConversationalIntent(effectiveInput, policy);
    if (conversationalReason) {
      return {
        target: 'chat',
        reason: conversationalReason,
        intent: conversationalReason === 'social_chat' ? 'social_chat' : 'knowledge_chat',
      };
    }

    if (this.isLikelyWorkflowRequest(effectiveInput, policy)) {
      return { target: 'task', reason: 'workflow_request', intent: 'workflow_task' };
    }

    if (this.isLikelyDirectActionRequest(effectiveInput, policy)) {
      return { target: 'task', reason: 'direct_action_request', intent: 'direct_action' };
    }

    if (await input.agent.detectComplexTask(effectiveInput)) {
      return { target: 'task', reason: 'complex_task', intent: 'workflow_task' };
    }

    if (policy.preferWorkflow) {
      return { target: 'task', reason: 'workflow_request', intent: 'workflow_task' };
    }

    return { target: 'chat', reason: 'knowledge_chat', intent: 'knowledge_chat' };
  }

  private classifyConversationalIntent(input: string, policy: Required<FunctionRoutingConfig>): 'knowledge_chat' | 'social_chat' | null {
    const trimmed = input.trim();
    if (!trimmed) {
      return 'social_chat';
    }

    if (/^(hi|hello|hey|你好|您好|在吗|在不在|早上好|晚上好|嗨)[!！。. ]*$/i.test(trimmed)) {
      return 'social_chat';
    }

    if (this.matchesKeyword(trimmed, policy.socialChatKeywords)) {
      return 'social_chat';
    }

    if (/(你是谁|介绍一下你自己|聊聊|陪我聊|讲讲|你觉得|怎么看|为什么|为啥|啥意思|什么意思|解释一下|介绍一下|是什么|what is|who are you|why|how do you think|explain)/i.test(trimmed)
      && !this.isLikelyDirectActionRequest(trimmed, policy)
      && !this.isLikelyWorkflowRequest(trimmed, policy)) {
      return 'knowledge_chat';
    }

    if (this.matchesKeyword(trimmed, policy.knowledgeChatKeywords)
      && !this.isLikelyDirectActionRequest(trimmed, policy)
      && !this.isLikelyWorkflowRequest(trimmed, policy)) {
      return 'knowledge_chat';
    }

    return null;
  }

  private isLikelyWorkflowRequest(input: string, policy: Required<FunctionRoutingConfig>): boolean {
    const trimmed = input.trim();
    if (!trimmed) {
      return false;
    }

    if (/(先.+再|然后|接着|之后|同时|并且|并把|再把|整理后|分析后|完成后|first.+then|and then|after that)/i.test(trimmed)) {
      return true;
    }

    if (/(帮我|请|麻烦).*(分析|整理|总结|规划|拆解|生成).*(并|再|然后|导出|发送|保存|同步|汇总)/i.test(trimmed)) {
      return true;
    }

    if (/(分析|整理|总结|生成|导出|发送|保存).*(报告|文档|pdf|word|docx|ppt|pptx|xlsx|excel|飞书|lark)/i.test(trimmed)
      && /(并|再|然后|之后|完成后)/i.test(trimmed)) {
      return true;
    }

    return this.matchesKeyword(trimmed, policy.workflowKeywords);
  }

  private isLikelyDirectActionRequest(input: string, policy: Required<FunctionRoutingConfig>): boolean {
    const trimmed = input.trim();
    if (!trimmed) {
      return false;
    }

    if (/^(继续|继续一下|继续执行|接着来|恢复|再来|按刚才|照刚才|改成|改为|换成|换为)/i.test(trimmed)) {
      return true;
    }

    if (/(帮我|请|麻烦).*(打开|读取|查看|搜索|查找|列出|生成|导出|发送|保存|转换|创建|修复|修改|重构|排查|执行|运行)/i.test(trimmed)) {
      return true;
    }

    if (/(打开|读取|查看|搜索|查找|列出|生成|导出|发送|保存|转换|创建|修复|修改|重构|排查|执行|运行).*(文件|目录|文档|报告|网页|网站|代码|仓库|飞书|lark|pdf|word|docx|ppt|pptx|xlsx|excel|markdown|md|日志|命令)/i.test(trimmed)) {
      return true;
    }

    if (/^(read_file|list_directory|search_files|glob|read_multiple_files|execute_command)\b/i.test(trimmed)) {
      return true;
    }

    return /(飞书|lark|pdf|word|docx|ppt|pptx|xlsx|excel|markdown|md|目录|文件|网页|网站|github|gitlab|google|谷歌|百度|buff|命令|脚本)/i.test(trimmed)
      || this.matchesKeyword(trimmed, policy.directActionKeywords);
  }

  private matchesKeyword(input: string, keywords: string[]): boolean {
    const normalized = input.trim().toLowerCase();
    return keywords.some(keyword => normalized.includes(keyword.trim().toLowerCase()));
  }

  private getPolicy(policy?: FunctionRoutingConfig): Required<FunctionRoutingConfig> {
    return {
      preferWorkflow: policy?.preferWorkflow ?? true,
      allowAutoSwitchFromChatToWorkflow: policy?.allowAutoSwitchFromChatToWorkflow ?? true,
      announceRouteDecisions: policy?.announceRouteDecisions ?? true,
      socialChatKeywords: policy?.socialChatKeywords ?? ['你好', '您好', 'hi', 'hello', 'hey', '在吗', '嗨'],
      knowledgeChatKeywords: policy?.knowledgeChatKeywords ?? ['你是谁', '介绍一下', '解释一下', '为什么', '怎么看', '是什么', 'explain', 'what is', 'who are you'],
      directActionKeywords: policy?.directActionKeywords ?? ['读取', '查看', '打开', '搜索', '查找', '列出', '导出', '发送', '保存', '转换', '运行', '执行', '文件', '目录', '飞书', 'lark', '命令'],
      workflowKeywords: policy?.workflowKeywords ?? ['先', '然后', '接着', '之后', '并且', '并把', '整理', '分析', '总结', '规划', '拆解', '周报', 'workflow'],
      workflowSwitchKeywords: policy?.workflowSwitchKeywords ?? ['switch workflow', '切换workflow', '切到workflow', '切换到workflow', '切换到工作流', '切到工作流', '进入workflow', '进入工作流', '用workflow'],
      chatSwitchKeywords: policy?.chatSwitchKeywords ?? ['switch chat', '切换chat', '切到chat', '切换到chat', '切换到聊天', '切到聊天', '进入chat'],
    };
  }
}