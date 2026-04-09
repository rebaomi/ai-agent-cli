import { looksLikeToolErrorText } from '../../utils/docx-validation.js';
import { detectRequestedExportFormat } from '../export-intent.js';
import { WorkflowBase } from './workflow-base.js';

export interface LarkWorkflowResult {
  handled: boolean;
  title?: string;
  output?: string;
  isError?: boolean;
}

export interface DirectActionWorkflowRuntime {
  executeBuiltInTool: (name: string, args: Record<string, unknown>, title: string) => Promise<LarkWorkflowResult>;
  executeSkillTool: (name: string, args: Record<string, unknown>, title: string) => Promise<LarkWorkflowResult>;
  hasBuiltInTool: (name: string) => boolean;
  resolveDocumentExportTool: (format: 'docx' | 'pptx') => string | null;
  extractRequestedFileName: (input: string) => string | null;
  inferConversionOutputPath: (input: string, fileBaseName: string, format: 'docx' | 'pptx') => string;
  resolveOutputArtifactPath: (outputPath: string) => string;
  verifyDocumentExportResult: (result: LarkWorkflowResult, outputPath: string, format: 'docx' | 'pptx', expectedText?: string, expectedTitle?: string) => Promise<LarkWorkflowResult>;
  extractInlineContent: (input: string) => string;
  referencesRecentArtifact: (input: string) => boolean;
  getLatestAssistantText: () => string;
}

interface NewsWorkflowRequest {
  newsType: 'hot' | 'search' | 'morning' | 'evening';
  chatId?: string;
  keyword?: string;
  limit?: number;
  title?: string;
}

interface XiaohongshuWorkflowRequest {
  keyword: string;
  chatId?: string;
  maxPosts: number;
}

interface WorkflowContentSource {
  text: string;
  source: 'inline' | 'recent' | 'news';
}

export class LarkDeliveryWorkflow extends WorkflowBase<LarkWorkflowResult> {
  constructor(private readonly runtime: DirectActionWorkflowRuntime) {
    super();
  }

  protected matches(input: string): boolean {
    return /(飞书|lark)/i.test(input) && /(发送|发(?:到|给|我)?|推送|send)/i.test(input);
  }

  protected async handleMatched(input: string): Promise<LarkWorkflowResult | null> {
    const textWorkflow = await this.tryTextToLarkWorkflow(input);
    if (textWorkflow) {
      return textWorkflow;
    }

    const xiaohongshuWorkflow = await this.tryXiaohongshuToLarkWorkflow(input);
    if (xiaohongshuWorkflow) {
      return xiaohongshuWorkflow;
    }

    const documentWorkflow = await this.tryDocumentToLarkWorkflow(input);
    if (documentWorkflow) {
      return documentWorkflow;
    }

    return this.tryNewsToLarkWorkflow(input);
  }

  private async tryTextToLarkWorkflow(input: string): Promise<LarkWorkflowResult | null> {
    if (this.detectAttachmentDeliveryFormat(input)) {
      return null;
    }

    if (this.requiresUpstreamContentResolution(input)) {
      return null;
    }

    const textSource = await this.resolveWorkflowSource(input, { allowNewsErrorText: false });
    if (!textSource) {
      return null;
    }

    const sourceError = this.buildSourceErrorResult(
      textSource.text,
      '[Deterministic text->lark workflow]',
      '正文来源是上游错误文本，已停止飞书发送。请先修复上一步结果。',
    );
    if (sourceError) {
      return sourceError;
    }

    const sendArgs = this.withRequestedChatId(input, {
      text: textSource.text,
    });

    return this.sendToLark(sendArgs, '[Deterministic text->lark workflow]');
  }

  private async tryDocumentToLarkWorkflow(input: string): Promise<LarkWorkflowResult | null> {
    const targetFormat = this.detectAttachmentDeliveryFormat(input);
    if (!targetFormat) {
      return null;
    }

    const contentSource = await this.resolveWorkflowSource(input, { allowNewsErrorText: true });
    if (!contentSource) {
      return null;
    }

    const sourceError = this.buildSourceErrorResult(
      contentSource.text,
      '[Deterministic docx->lark workflow]',
      '正文来源是上游错误文本，已停止文档导出和飞书发送。请先修复上一步结果。',
    );
    if (sourceError) {
      return sourceError;
    }

    const requestedTitle = this.extractRequestedDocumentTitle(input);
    const fileBaseName = this.runtime.extractRequestedFileName(input) || requestedTitle || 'exported-document';
    const title = requestedTitle || fileBaseName.replace(/[-_]+/g, ' ').trim() || 'exported document';
    const outputPath = this.runtime.inferConversionOutputPath(input, fileBaseName, targetFormat);
    const exportTool = this.runtime.resolveDocumentExportTool(targetFormat);
    if (!exportTool) {
      return {
        handled: true,
        title: `[Deterministic ${targetFormat}->lark workflow]`,
        output: targetFormat === 'pptx'
          ? '未找到可用的 PPT/PPTX 导出工具，无法继续发送到飞书。'
          : '未找到可用的 Word 导出工具，无法继续发送到飞书。',
        isError: true,
      };
    }

    const exportArgs = { output: outputPath, text: contentSource.text, title };
    const exportResult = this.runtime.hasBuiltInTool(exportTool)
      ? await this.runtime.executeBuiltInTool(exportTool, exportArgs, `[Deterministic ${targetFormat} export]`)
      : await this.runtime.executeSkillTool(exportTool, exportArgs, `[Deterministic ${targetFormat} export]`);

    const verifiedExport = await this.runtime.verifyDocumentExportResult(exportResult, outputPath, targetFormat, contentSource.text, title);
    if (verifiedExport.isError) {
      return verifiedExport;
    }

    const resolvedOutputPath = this.runtime.resolveOutputArtifactPath(outputPath);
    const sendResult = await this.sendToLark(
      this.withRequestedChatId(input, { file: resolvedOutputPath }),
      '[Deterministic lark send]',
    );
    if (sendResult.isError) {
      return sendResult;
    }

    return this.buildWorkflowSuccessResult(
      `[Deterministic ${targetFormat}->lark workflow]`,
      `${targetFormat === 'pptx' ? '演示文稿' : '文档'}已创建: ${resolvedOutputPath}`,
      sendResult.output || '已发送到飞书。',
    );
  }

  private async tryNewsToLarkWorkflow(input: string): Promise<LarkWorkflowResult | null> {
    const newsRequest = this.parseNewsWorkflowRequest(input);
    if (!newsRequest || this.detectAttachmentDeliveryFormat(input)) {
      return null;
    }

    const args: Record<string, unknown> = { newsType: newsRequest.newsType };
    if (newsRequest.chatId) {
      args.chatId = newsRequest.chatId;
    }
    if (newsRequest.keyword) {
      args.keyword = newsRequest.keyword;
    }
    if (newsRequest.limit) {
      args.limit = newsRequest.limit;
    }
    if (newsRequest.title) {
      args.title = newsRequest.title;
    }

    return this.runtime.executeBuiltInTool('push_news_to_lark', args, '[Deterministic news->lark workflow]');
  }

  private async tryXiaohongshuToLarkWorkflow(input: string): Promise<LarkWorkflowResult | null> {
    const request = this.parseXiaohongshuWorkflowRequest(input);
    if (!request) {
      return null;
    }

    const outputDir = this.runtime.resolveOutputArtifactPath(`xiaohongshu/${this.sanitizeArtifactName(request.keyword)}`);
    const command = [
      'node',
      this.quoteShellArg('scripts/xiaohongshu-extract.mjs'),
      this.quoteShellArg(request.keyword),
      String(request.maxPosts),
      this.quoteShellArg(outputDir),
    ].join(' ');

    const execution = await this.runtime.executeBuiltInTool('execute_command', {
      command,
      timeout: 0,
    }, '[Deterministic xiaohongshu fetch]');

    if (execution.isError || !execution.output) {
      return {
        handled: true,
        title: '[Deterministic xiaohongshu->lark workflow]',
        output: execution.output || '小红书抓取失败。',
        isError: true,
      };
    }

    const reportPath = this.extractCommandOutputValue(execution.output, 'REPORT_PATH');
    if (!reportPath) {
      return {
        handled: true,
        title: '[Deterministic xiaohongshu->lark workflow]',
        output: '小红书抓取已执行，但未返回 REPORT_PATH，无法继续做摘要发送。',
        isError: true,
      };
    }

    const reportResult = await this.runtime.executeBuiltInTool('read_file', { path: reportPath }, '[Deterministic xiaohongshu report read]');
    if (reportResult.isError || !reportResult.output) {
      return {
        handled: true,
        title: '[Deterministic xiaohongshu->lark workflow]',
        output: reportResult.output || '读取小红书原始报告失败。',
        isError: true,
      };
    }

    const summaryMarkdown = this.buildXiaohongshuSummaryMarkdown(request.keyword, reportResult.output, reportPath);
    const sendResult = await this.sendToLark(
      this.withRequestedChatId(input, { markdown: summaryMarkdown }),
      '[Deterministic xiaohongshu->lark send]',
    );
    if (sendResult.isError) {
      return sendResult;
    }

    return this.buildWorkflowSuccessResult(
      '[Deterministic xiaohongshu->lark workflow]',
      `小红书原始报告已生成: ${reportPath}`,
      sendResult.output || '已发送到飞书。',
    );
  }

  private async resolveWorkflowSource(input: string, options: { allowNewsErrorText: boolean }): Promise<WorkflowContentSource | null> {
    const inlineContent = this.runtime.extractInlineContent(input);
    if (inlineContent) {
      return { text: this.cleanWorkflowInlineContent(inlineContent), source: 'inline' };
    }

    if (this.runtime.referencesRecentArtifact(input)) {
      const recentText = this.runtime.getLatestAssistantText();
      if (recentText) {
        return { text: recentText, source: 'recent' };
      }
    }

    const newsRequest = this.parseNewsWorkflowRequest(input);
    if (newsRequest) {
      const result = await this.fetchNewsForWorkflow(newsRequest);
      if (result.isError || !result.output) {
        return options.allowNewsErrorText && result.isError ? { text: result.output || '', source: 'news' } : null;
      }
      return { text: result.output, source: 'news' };
    }

    return null;
  }

  private detectAttachmentDeliveryFormat(input: string): 'docx' | 'pptx' | null {
    const requestedFormat = detectRequestedExportFormat(input, ['docx', 'pptx']);
    if (requestedFormat === 'docx' || requestedFormat === 'pptx') {
      return requestedFormat;
    }

    if (/(word|docx|word文档)/i.test(input)) {
      return 'docx';
    }

    if (/(ppt|pptx|powerpoint|演示文稿|幻灯片)/i.test(input)) {
      return 'pptx';
    }

    return null;
  }

  private buildSourceErrorResult(text: string, title: string, message: string): LarkWorkflowResult | null {
    if (!looksLikeToolErrorText(text)) {
      return null;
    }

    return {
      handled: true,
      title,
      output: message,
      isError: true,
    };
  }

  private withRequestedChatId(input: string, args: Record<string, unknown>): Record<string, unknown> {
    const chatId = this.extractRequestedChatId(input);
    if (!chatId) {
      return args;
    }

    return {
      ...args,
      chatId,
    };
  }

  private sendToLark(args: Record<string, unknown>, title: string): Promise<LarkWorkflowResult> {
    return this.runtime.executeBuiltInTool('send_lark_message', args, title);
  }

  private buildWorkflowSuccessResult(title: string, ...messages: string[]): LarkWorkflowResult {
    return {
      handled: true,
      title,
      output: messages.filter(Boolean).join('\n'),
    };
  }

  private async fetchNewsForWorkflow(input: { newsType: 'hot' | 'search' | 'morning' | 'evening'; keyword?: string; limit?: number }): Promise<LarkWorkflowResult> {
    switch (input.newsType) {
      case 'morning':
        return this.runtime.executeBuiltInTool('tencent_morning_news', {}, '[Deterministic news fetch]');
      case 'evening':
        return this.runtime.executeBuiltInTool('tencent_evening_news', {}, '[Deterministic news fetch]');
      case 'search':
        return this.runtime.executeBuiltInTool('tencent_search_news', { keyword: input.keyword || '', limit: input.limit || 10 }, '[Deterministic news fetch]');
      case 'hot':
      default:
        return this.runtime.executeBuiltInTool('tencent_hot_news', { limit: input.limit || 10 }, '[Deterministic news fetch]');
    }
  }

  private parseNewsWorkflowRequest(input: string): NewsWorkflowRequest | null {
    if (!/(新闻|热点|热榜|早报|晚报|morning news|evening news|hot news)/i.test(input)) {
      return null;
    }

    let newsType: NewsWorkflowRequest['newsType'] = 'hot';
    if (/(早报|morning)/i.test(input)) {
      newsType = 'morning';
    } else if (/(晚报|evening)/i.test(input)) {
      newsType = 'evening';
    } else if (/(搜索|查找|search).*(新闻|news)|(新闻|news).*(搜索|查找|search)/i.test(input)) {
      newsType = 'search';
    }

    const searchKeywordMatch = input.match(/(?:搜索|查找)\s*([^，。,\n]+?)\s*(?:新闻|news)/i)
      || input.match(/(?:关键词|keyword)\s*[:：]?\s*([^，。,\n]+)/i);
    const keyword = searchKeywordMatch?.[1]?.trim();
    if (newsType === 'search' && !keyword) {
      return null;
    }

    const limitMatch = input.match(/(?:前|top|limit)\s*(\d{1,2})\s*(?:条|个)?/i);
    const parsedLimit = limitMatch ? Number.parseInt(limitMatch[1] || '', 10) : Number.NaN;

    return {
      newsType,
      chatId: this.extractRequestedChatId(input) || undefined,
      keyword,
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined,
      title: this.extractRequestedDocumentTitle(input) || undefined,
    };
  }

  private extractRequestedChatId(input: string): string {
    const match = input.match(/(?:chat[_\-\s]?id|群id|群聊id)\s*(?:是|为|:|：)?\s*(oc_[a-z0-9]+)/i);
    return match?.[1]?.trim() || '';
  }

  private extractRequestedDocumentTitle(input: string): string {
    const patterns = [
      /(?:文件标题|标题)\s*(?:是|为|叫|:|：)\s*['"“”]?([^'"”，,。\n]+)['"”]?/i,
      /(?:title)\s*(?:is|:)?\s*['"“”]?([^'"”，,。\n]+)['"”]?/i,
    ];

    for (const pattern of patterns) {
      const match = input.match(pattern);
      const raw = match?.[1]?.trim();
      if (raw) {
        return raw.replace(/[<>:"/\\|?*]+/g, '-').replace(/\.+$/g, '').trim();
      }
    }

    return '';
  }

  private cleanWorkflowInlineContent(content: string): string {
    return content
      .replace(/[，,]\s*(?:chat[_\-\s]?id|群id|群聊id)\s*(?:是|为|:|：)?\s*oc_[a-z0-9]+\s*$/i, '')
      .replace(/[，,]\s*(?:发送|发(?:到|给|我)?|推送).+$/i, '')
      .trim();
  }

  private requiresUpstreamContentResolution(input: string): boolean {
    if (this.runtime.extractInlineContent(input)) {
      return false;
    }

    if (this.runtime.referencesRecentArtifact(input)) {
      return false;
    }

    if (this.parseNewsWorkflowRequest(input)) {
      return false;
    }

    return /(?:内容|全文|原文|诗|诗词|文章|歌词|台词|简介|介绍|定义|意思|含义).{0,24}(?:是(?:什么|啥)|是什么)|(?:什么是|谁是).{0,24}(?:诗|诗词|文章|歌词|台词|简介|介绍|定义|意思|含义)|这首(?:诗|词|歌).{0,12}(?:内容|全文|原文).{0,8}(?:是(?:什么|啥)|是什么)/i.test(input);
  }

  private parseXiaohongshuWorkflowRequest(input: string): XiaohongshuWorkflowRequest | null {
    if (!/(小红书|红书|xiaohongshu|redbook|xhs)/i.test(input)) {
      return null;
    }

    const keyword = input
      .replace(/(?:前|top\s*)?\d{1,2}\s*(?:条|个|篇|帖子|笔记)/gi, ' ')
      .replace(/请|帮我|麻烦|一下|用|通过|给我|我想|需要|把|并|然后|再/gi, ' ')
      .replace(/小红书|红书|xiaohongshu|redbook|xhs|搜索|搜一下|搜|检索|查一下|查|调研|总结|汇总|分析|发送到飞书|发到飞书|发给飞书|发我飞书|推送到飞书|飞书|lark|chatid|群id|群聊id/gi, ' ')
      .replace(/oc_[a-z0-9]+/gi, ' ')
      .replace(/[：:，,。！？!?.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!keyword) {
      return null;
    }

    const limitMatch = input.match(/(?:前|top\s*)?(\d{1,2})\s*(?:条|个|篇|帖子|笔记)/i);
    const maxPosts = limitMatch?.[1] ? Math.max(1, Math.min(50, Number(limitMatch[1]))) : 10;
    return {
      keyword,
      chatId: this.extractRequestedChatId(input) || undefined,
      maxPosts,
    };
  }

  private extractCommandOutputValue(output: string, key: string): string {
    const match = output.match(new RegExp(`${key}=([^\r\n]+)`));
    return match?.[1]?.trim() || '';
  }

  private sanitizeArtifactName(value: string): string {
    return value
      .replace(/[<>:"/\\|?*]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'query';
  }

  private quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private buildXiaohongshuSummaryMarkdown(keyword: string, rawMarkdown: string, reportPath: string): string {
    const sections = rawMarkdown
      .split(/\n##\s+\d+\.\s+/)
      .map((section, index) => index === 0 ? section : `## ${section}`)
      .filter(section => /^##\s+/m.test(section));

    const titles: string[] = [];
    const highlights: string[] = [];
    const comments: string[] = [];

    for (const section of sections.slice(0, 6)) {
      const titleMatch = section.match(/^##\s+(.+)$/m);
      const title = titleMatch?.[1]?.trim();
      if (title) {
        titles.push(title);
      }

      const quoteLines = Array.from(section.matchAll(/^>\s+(.+)$/gm)).map(match => match[1]?.trim()).filter(Boolean);
      if (quoteLines[0]) {
        highlights.push(quoteLines[0]);
      }

      const commentLines = Array.from(section.matchAll(/^-\s+\*\*(.+?)\*\*:\s+(.+)$/gm))
        .map(match => `${match[1]?.trim()}: ${match[2]?.trim()}`)
        .filter(Boolean);
      if (commentLines[0]) {
        comments.push(commentLines[0]);
      }
    }

    return [
      `# 小红书搜索总结：${keyword}`,
      '',
      `- 抓取笔记数：${sections.length}`,
      `- 原始报告：${reportPath}`,
      '',
      '## 重点帖子',
      ...titles.slice(0, 5).map(title => `- ${title}`),
      '',
      '## 核心观点',
      ...highlights.slice(0, 5).map(item => `- ${item}`),
      '',
      '## 代表评论',
      ...comments.slice(0, 5).map(item => `- ${item}`),
    ].filter(Boolean).join('\n');
  }
}
