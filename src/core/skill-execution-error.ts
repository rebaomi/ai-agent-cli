export function normalizeSkillExecutionError(toolName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (isUnavailableDocxSkill(toolName, message)) {
    return [
      '无可用 docx skill。',
      '当前命中的 docx skill 不可用，原因是缺少可运行的依赖环境。',
      '可先降级为 PDF、Markdown 或 TXT 导出，或在安装 .NET SDK 后再试 DOCX。',
    ].join('\n');
  }

  if (isUnavailablePdfSkill(toolName, message)) {
    return [
      '无可用 pdf skill。',
      '当前命中的 pdf skill 不可用，原因是缺少 Playwright/Chromium 运行环境。',
      '可先执行 npm install -g playwright，并运行 npx playwright install chromium；或者先降级为 Markdown、TXT、DOCX。',
    ].join('\n');
  }

  return `Skill tool error: ${message}`;
}

export function isUnavailableDocxSkill(toolName: string, message: string): boolean {
  if (!/docx/i.test(toolName)) {
    return false;
  }

  return /docx 当前不可用|缺少 .*\.net sdk|No \.NET SDKs were found|application 'run' does not exist|dotnet run/i.test(message);
}

export function isUnavailablePdfSkill(toolName: string, message: string): boolean {
  if (!/pdf/i.test(toolName)) {
    return false;
  }

  return /playwright not found|npx playwright install chromium|chromium/i.test(message);
}

export function isUnavailableDocxSkillResult(format: string, output: string): boolean {
  return format === 'docx' && /无可用 docx skill/i.test(output);
}