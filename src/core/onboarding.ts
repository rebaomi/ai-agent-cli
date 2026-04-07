export interface ParsedOnboardingData {
  job?: string;
  purpose?: string;
  preferredStyle?: string;
}

const JOB_PATTERN = /(程序员|开发|产品经理|设计师|运营|学生|老师|工程师|测试|架构师)/;
const PURPOSE_PATTERN = /(主要用|用来|想用来|用于|帮我)/;
const STYLE_PATTERN = /(专业|友好|幽默|温柔|活力)/;
const SELF_DESCRIPTION_PATTERN = /(我是|我是一名|我是个|职业|做.*开发)/;

export function parseOnboardingInput(input: string): ParsedOnboardingData | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const hasSelfDescription = SELF_DESCRIPTION_PATTERN.test(trimmed);
  const hasPurpose = /(用来|主要用|想用来|用于|帮我写|帮我做|编程|写代码|写文章|数据处理|学习)/.test(trimmed);
  const hasStyle = /(专业|友好|幽默|温柔|活力|简洁|详细)/.test(trimmed);

  if (!hasSelfDescription && !hasPurpose && !hasStyle) {
    return undefined;
  }

  const data: ParsedOnboardingData = {};
  const clauses = trimmed.split(/[，,。；;]/).map(part => part.trim()).filter(Boolean);

  for (const clause of clauses) {
    if (!data.job && JOB_PATTERN.test(clause)) {
      data.job = clause.replace(/^(我是|我是一名|我是个)/, '').trim();
    }

    if (!data.purpose && PURPOSE_PATTERN.test(clause)) {
      data.purpose = clause.replace(/^(主要)?用来|^想用来|^用于/, '').trim();
    }

    if (!data.preferredStyle && STYLE_PATTERN.test(clause)) {
      data.preferredStyle = clause;
    }
  }

  return Object.keys(data).length > 0 ? data : undefined;
}