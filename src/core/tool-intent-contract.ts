import type { ToolCall } from '../types/index.js';
import { detectRequestedExportFormat, type ExportFormat } from './export-intent.js';

export type IntentActionKind = 'document_export' | 'file_read' | 'file_search' | 'file_write' | 'command_execute' | 'message_send' | 'generic';

export interface IntentContract {
  action: IntentActionKind;
  summary: string;
  targetFormat?: ExportFormat;
  sourceHint?: string;
  confidence?: number;
}

export const TOOL_INTENT_CONTRACT_PROMPT = [
  '你是 tool intent contract parser。',
  '你的任务是根据用户请求和 assistant 准备调用的工具，提炼一个极简结构化 action contract。',
  '只返回 JSON，不要返回解释。',
  '{',
  '  "action": "document_export|file_read|file_search|file_write|command_execute|message_send|generic",',
  '  "summary": "一句话概括真实意图",',
  '  "targetFormat": "pdf|docx|pptx|md|txt|xlsx，可选",',
  '  "sourceHint": "源文件或来源提示，可选",',
  '  "confidence": 0.0',
  '}',
  '规则：',
  '- 如果用户目标是把内容导出/转换成某种文档格式，action=document_export，targetFormat 必填。',
  '- 如果用户只是读取/查看文件，action=file_read。',
  '- 如果用户是在搜索文件或内容，action=file_search。',
  '- 如果用户是在写入/编辑/保存普通文本文件，action=file_write。',
  '- 如果用户明确要求运行命令，action=command_execute。',
  '- 如果用户要求发送飞书/Lark/IM/聊天消息，action=message_send。',
  '- 不确定时返回 generic。',
].join('\n');

export function parseIntentContractResponse(response: string): IntentContract | null {
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```|(\{[\s\S]*\})/);
  const raw = jsonMatch?.[1] ?? jsonMatch?.[2] ?? response;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const action = typeof parsed.action === 'string' ? parsed.action.trim() as IntentActionKind : 'generic';
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const targetFormat = typeof parsed.targetFormat === 'string' ? parsed.targetFormat.trim() as ExportFormat : undefined;
    const sourceHint = typeof parsed.sourceHint === 'string' ? parsed.sourceHint.trim() : undefined;
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : undefined;

    if (!summary) {
      return null;
    }

    return { action, summary, targetFormat, sourceHint, confidence };
  } catch {
    return null;
  }
}

export function buildFallbackIntentContract(userInput: string, toolCalls: ToolCall[]): IntentContract {
  const toolKinds = classifyPlannedToolKinds(toolCalls);

  if (isCompositeLarkDeliveryTask(userInput)) {
    return {
      action: 'generic',
      summary: 'Resolve requested content first, then send it to chat',
      sourceHint: extractSourceHint(userInput),
      confidence: 0.78,
    };
  }

  if (/(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|改成|变成).*(?:pptx|ppt|powerpoint|幻灯片|演示文稿)/i.test(userInput)) {
    return {
      action: 'document_export',
      summary: 'Export content to PPTX',
      targetFormat: 'pptx',
      sourceHint: extractSourceHint(userInput),
      confidence: 0.74,
    };
  }

  const exportFormat = detectRequestedExportFormat(userInput, ['docx', 'pdf', 'md', 'txt', 'xlsx', 'pptx']);
  if (exportFormat) {
    return {
      action: 'document_export',
      summary: `Export content to ${exportFormat.toUpperCase()}`,
      targetFormat: exportFormat,
      sourceHint: extractSourceHint(userInput),
      confidence: 0.72,
    };
  }

  if (/^(?:请)?(?:帮我)?(?:读取|查看|打开)(?:\s|$)|\b(read|open|inspect)\b/i.test(userInput)) {
    return { action: 'file_read', summary: 'Read file content', sourceHint: extractSourceHint(userInput), confidence: 0.68 };
  }

  if (/(分析|整理|总结|归纳|提炼|确定).*(搜索结果|查找结果)|(搜索结果|查找结果).*(分析|整理|总结|归纳|提炼|确定|保存|写入)/i.test(userInput)) {
    return {
      action: 'file_write',
      summary: 'Write analyzed search results',
      sourceHint: extractSourceHint(userInput),
      confidence: 0.66,
    };
  }

  if (/(搜索|查找)|\b(grep|find)\b/i.test(userInput)) {
    return { action: 'file_search', summary: 'Search files or content', sourceHint: extractSourceHint(userInput), confidence: 0.68 };
  }

  if (/((飞书|lark|im|群聊|chat).*(消息|通知|文本|markdown|附件|文件))|((飞书|lark|im|群聊|chat).*(发送|发|推送))|((发送|发|推送).*(飞书|lark|群聊|chat).*(消息|通知|文本|markdown|附件|文件)?)/i.test(userInput)) {
    return {
      action: 'message_send',
      summary: 'Send a chat message',
      sourceHint: extractSourceHint(userInput),
      confidence: 0.72,
    };
  }

  if (/(保存|写入|编辑|修改)|\b(save|write|edit)\b/i.test(userInput)) {
    return { action: 'file_write', summary: 'Write or edit files', sourceHint: extractSourceHint(userInput), confidence: 0.64 };
  }

  if (/(执行命令|运行命令)|\b(execute command|run command|npm|node|python|powershell|cmd)\b/i.test(userInput)) {
    if (toolKinds.has('command') && toolKinds.size > 1) {
      return {
        action: 'generic',
        summary: 'Command workflow with supporting file operations',
        sourceHint: extractSourceHint(userInput),
        confidence: 0.62,
      };
    }

    return { action: 'command_execute', summary: 'Execute a command', sourceHint: extractSourceHint(userInput), confidence: 0.66 };
  }

  const firstTool = toolCalls[0]?.function.name || 'tool';
  return {
    action: 'generic',
    summary: `General tool usage around ${firstTool}`,
    sourceHint: extractSourceHint(userInput),
    confidence: 0.45,
  };
}

function extractSourceHint(input: string): string | undefined {
  const match = input.match(/([a-zA-Z]:[\\/][^\s,'"]+|(?:\.{1,2}[\\/]|[\\/])[^\s,'"]+|[^\s,'"]+\.(?:md|markdown|txt|docx|pdf|xlsx))/i);
  return match?.[1]?.trim();
}

function classifyPlannedToolKinds(toolCalls: ToolCall[]): Set<'read' | 'search' | 'write' | 'command' | 'export' | 'other'> {
  const kinds = new Set<'read' | 'search' | 'write' | 'command' | 'export' | 'other'>();

  for (const toolCall of toolCalls) {
    const name = toolCall.function.name;
    if (/^(read_file|read_multiple_files|list_directory|file_info)$/i.test(name)) {
      kinds.add('read');
      continue;
    }

    if (/^(search_files|grep|glob)$/i.test(name)) {
      kinds.add('search');
      continue;
    }

    if (/^(write_file|edit_file|delete_file|copy_file|move_file|create_directory)$/i.test(name)) {
      kinds.add('write');
      continue;
    }

    if (/^(execute_command|repl)$/i.test(name)) {
      kinds.add('command');
      continue;
    }

    if (/docx_create_from_text|pdf_create_from_text|xlsx_create_from_text|pptx_create_from_text|txt_to_docx|minimax_docx_create_from_text|txt_to_pdf|minimax_pdf_text_to_pdf|txt_to_xlsx|txt_to_pptx/i.test(name)) {
      kinds.add('export');
      continue;
    }

    kinds.add('other');
  }

  return kinds;
}

function isCompositeLarkDeliveryTask(userInput: string): boolean {
  if (!/(飞书|lark)/i.test(userInput) || !/(发送|发(?:到|给|我)?|推送|send)/i.test(userInput)) {
    return false;
  }

  if (/(?:内容是|内容为|正文是|正文为|文本是|文本为|markdown是|markdown为)\s*[：:]/i.test(userInput)) {
    return false;
  }

  if (/(新闻|热点|热榜|早报|晚报|小红书|redbook|xiaohongshu)/i.test(userInput)) {
    return false;
  }

  return /(?:内容|全文|原文|诗|诗词|文章|歌词|台词|简介|介绍|定义|意思|含义).{0,24}(?:是(?:什么|啥)|是什么)|(?:什么是|谁是).{0,24}(?:诗|诗词|文章|歌词|台词|简介|介绍|定义|意思|含义)|这首(?:诗|词|歌).{0,12}(?:内容|全文|原文).{0,8}(?:是(?:什么|啥)|是什么)/i.test(userInput);
}