import type { MemoryProvider } from './memory-provider.js';
import type { Message } from '../types/index.js';
import type { BuiltInTools } from '../tools/builtin.js';
import type { SkillManager } from './skills.js';
import type { PermissionManager } from './permission-manager.js';
import type { DirectActionResult } from './direct-action-router.js';
import { LarkDeliveryWorkflow, type DirectActionWorkflowRuntime } from './workflows/lark-delivery.js';
import type { DirectActionHandler } from './direct-actions/request-handler.js';
import type { DocumentActionRuntime, ExternalSearchRuntime, FileActionRuntime, LarkWorkflowRuntime } from './direct-actions/runtime-context.js';
import { LarkWorkflowHandler } from './direct-actions/handlers/lark-workflow-handler.js';
import { ExternalSearchHandler } from './direct-actions/handlers/external-search-handler.js';
import { FileActionHandler } from './direct-actions/handlers/file-action-handler.js';
import { DocumentActionHandler } from './direct-actions/handlers/document-action-handler.js';
import { DirectActionArtifactSupport } from './direct-actions/artifact-support.js';
import { DirectActionExportSupport } from './direct-actions/export-support.js';
import { DirectActionKnownGapSupport } from './direct-actions/known-gap-support.js';
import { DirectActionDocumentExportVerifier } from './direct-actions/document-export-verifier.js';
import { DirectActionRoutingSupport } from './direct-actions/routing-support.js';
import { isUnavailableDocxSkillResult } from './skill-execution-error.js';
import { DirectActionToolSupport } from './direct-actions/tool-support.js';

export interface DirectActionRuntimeFactoryOptions {
  builtInTools: BuiltInTools;
  skillManager: SkillManager;
  permissionManager: PermissionManager;
  workspace: string;
  config?: unknown;
  getConversationMessages?: () => Message[];
  memoryProvider?: MemoryProvider;
  handleLarkWorkflow: (input: string) => Promise<DirectActionResult | null>;
}

export interface DirectActionRuntimeComponents {
  toolSupport: DirectActionToolSupport;
  larkDeliveryWorkflow: LarkDeliveryWorkflow;
  handlers: DirectActionHandler[];
}

interface SharedToolExecutionRuntime {
  executeBuiltInTool: (name: string, args: Record<string, unknown>, title: string) => Promise<DirectActionResult>;
  executeSkillTool: (name: string, args: Record<string, unknown>, title: string) => Promise<DirectActionResult>;
  hasBuiltInTool: (name: string) => boolean;
  resolveDocumentExportTool: (format: 'docx' | 'pdf' | 'xlsx' | 'pptx' | 'md' | 'txt') => string | null;
}

interface DirectActionSupportBundle {
  artifactSupport: DirectActionArtifactSupport;
  routingSupport: DirectActionRoutingSupport;
  exportSupport: DirectActionExportSupport;
  knownGapSupport: DirectActionKnownGapSupport;
  toolSupport: DirectActionToolSupport;
  documentExportVerifier: DirectActionDocumentExportVerifier;
}

interface DirectActionHandlerRuntimeBundle {
  larkDeliveryWorkflow: LarkDeliveryWorkflow;
  larkWorkflowRuntime: LarkWorkflowRuntime;
  externalSearchRuntime: ExternalSearchRuntime;
  fileActionRuntime: FileActionRuntime;
  documentActionRuntime: DocumentActionRuntime;
}

export function createDirectActionRuntimeComponents(options: DirectActionRuntimeFactoryOptions): DirectActionRuntimeComponents {
  const supportBundle = createDirectActionSupportBundle(options);
  const runtimeBundle = createDirectActionHandlerRuntimeBundle(options, supportBundle);
  const handlers: DirectActionHandler[] = [
    new LarkWorkflowHandler(runtimeBundle.larkWorkflowRuntime),
    new ExternalSearchHandler(runtimeBundle.externalSearchRuntime),
    new FileActionHandler(runtimeBundle.fileActionRuntime),
    new DocumentActionHandler(runtimeBundle.documentActionRuntime),
  ];

  return {
    toolSupport: supportBundle.toolSupport,
    larkDeliveryWorkflow: runtimeBundle.larkDeliveryWorkflow,
    handlers,
  };
}

function createDirectActionSupportBundle(options: DirectActionRuntimeFactoryOptions): DirectActionSupportBundle {
  const config = options.config && typeof options.config === 'object' ? options.config as Record<string, unknown> : {};
  const artifactSupport = new DirectActionArtifactSupport({
    workspace: options.workspace,
    config,
    getConversationMessages: options.getConversationMessages,
    memoryProvider: options.memoryProvider,
  });
  const routingSupport = new DirectActionRoutingSupport();
  const exportSupport = new DirectActionExportSupport();
  const knownGapSupport = new DirectActionKnownGapSupport(options.skillManager);
  const toolSupport = new DirectActionToolSupport({
    builtInTools: options.builtInTools,
    skillManager: options.skillManager,
    permissionManager: options.permissionManager,
    workspace: options.workspace,
    config,
    artifactSupport,
    exportSupport,
  });
  const documentExportVerifier = new DirectActionDocumentExportVerifier({
    resolveOutputArtifactPath: (outputPath) => artifactSupport.resolveOutputArtifactPath(outputPath),
  });

  return {
    artifactSupport,
    routingSupport,
    exportSupport,
    knownGapSupport,
    toolSupport,
    documentExportVerifier,
  };
}

function createDirectActionHandlerRuntimeBundle(
  options: DirectActionRuntimeFactoryOptions,
  supportBundle: DirectActionSupportBundle,
): DirectActionHandlerRuntimeBundle {
  const sharedToolRuntime = createSharedToolExecutionRuntime(supportBundle.toolSupport);
  const workflowRuntime = createLarkDeliveryWorkflowRuntime({
    sharedToolRuntime,
    artifactSupport: supportBundle.artifactSupport,
    documentExportVerifier: supportBundle.documentExportVerifier,
  });

  return {
    larkDeliveryWorkflow: new LarkDeliveryWorkflow(workflowRuntime),
    larkWorkflowRuntime: createLarkWorkflowRuntime(options),
    externalSearchRuntime: createExternalSearchRuntime({
      executeBuiltInTool: sharedToolRuntime.executeBuiltInTool,
      artifactSupport: supportBundle.artifactSupport,
    }),
    fileActionRuntime: createFileActionRuntime({
      workspace: options.workspace,
      executeBuiltInTool: sharedToolRuntime.executeBuiltInTool,
      routingSupport: supportBundle.routingSupport,
      exportSupport: supportBundle.exportSupport,
      artifactSupport: supportBundle.artifactSupport,
    }),
    documentActionRuntime: createDocumentActionRuntime({
      sharedToolRuntime,
      exportSupport: supportBundle.exportSupport,
      artifactSupport: supportBundle.artifactSupport,
      knownGapSupport: supportBundle.knownGapSupport,
      documentExportVerifier: supportBundle.documentExportVerifier,
    }),
  };
}

function createSharedToolExecutionRuntime(toolSupport: DirectActionToolSupport): SharedToolExecutionRuntime {
  return {
    executeBuiltInTool: (name, args, title) => toolSupport.executeBuiltInTool(name, args, title),
    executeSkillTool: (name, args, title) => toolSupport.executeSkillTool(name, args, title),
    hasBuiltInTool: (name) => toolSupport.hasBuiltInTool(name),
    resolveDocumentExportTool: (format) => toolSupport.resolveDocumentExportTool(format),
  };
}

function createLarkDeliveryWorkflowRuntime(input: {
  sharedToolRuntime: SharedToolExecutionRuntime;
  artifactSupport: DirectActionArtifactSupport;
  documentExportVerifier: DirectActionDocumentExportVerifier;
}): DirectActionWorkflowRuntime {
  return {
    executeBuiltInTool: input.sharedToolRuntime.executeBuiltInTool,
    executeSkillTool: input.sharedToolRuntime.executeSkillTool,
    hasBuiltInTool: input.sharedToolRuntime.hasBuiltInTool,
    resolveDocumentExportTool: (format) => input.sharedToolRuntime.resolveDocumentExportTool(format),
    extractRequestedFileName: (sourceInput) => input.artifactSupport.extractRequestedFileName(sourceInput),
    inferConversionOutputPath: (sourceInput, fileBaseName, format) => input.artifactSupport.inferConversionOutputPath(sourceInput, fileBaseName, format),
    resolveOutputArtifactPath: (outputPath) => input.artifactSupport.resolveOutputArtifactPath(outputPath),
    verifyDocumentExportResult: (result, outputPath, format, expectedText, expectedTitle) => input.documentExportVerifier.verifyDocumentExportResult(result, outputPath, format, expectedText, expectedTitle),
    extractInlineContent: (sourceInput) => input.artifactSupport.extractInlineContent(sourceInput),
    referencesRecentArtifact: (sourceInput) => input.artifactSupport.referencesRecentArtifact(sourceInput),
    getLatestAssistantText: () => input.artifactSupport.getLatestAssistantText(),
  };
}

function createLarkWorkflowRuntime(options: DirectActionRuntimeFactoryOptions): LarkWorkflowRuntime {
  return {
    handleLarkWorkflow: (input) => options.handleLarkWorkflow(input),
  };
}

function createExternalSearchRuntime(input: {
  executeBuiltInTool: SharedToolExecutionRuntime['executeBuiltInTool'];
  artifactSupport: DirectActionArtifactSupport;
}): ExternalSearchRuntime {
  return {
    executeBuiltInTool: input.executeBuiltInTool,
    resolveOutputArtifactPath: (outputPath) => input.artifactSupport.resolveOutputArtifactPath(outputPath),
  };
}

function createFileActionRuntime(input: {
  workspace: string;
  executeBuiltInTool: SharedToolExecutionRuntime['executeBuiltInTool'];
  routingSupport: DirectActionRoutingSupport;
  exportSupport: DirectActionExportSupport;
  artifactSupport: DirectActionArtifactSupport;
}): FileActionRuntime {
  return {
    workspace: input.workspace,
    executeBuiltInTool: input.executeBuiltInTool,
    normalizePath: (value) => input.routingSupport.normalizePath(value),
    splitExplicitPaths: (rawInput) => input.routingSupport.splitExplicitPaths(rawInput),
    stripDirectorySuffix: (value) => input.routingSupport.stripDirectorySuffix(value),
    normalizeSearchQuery: (value) => input.routingSupport.normalizeSearchQuery(value),
    normalizeGlobPattern: (value) => input.routingSupport.normalizeGlobPattern(value),
    detectTextFormat: (rawInput) => input.exportSupport.detectTextFormat(rawInput),
    resolveDirectSourceText: (rawInput) => input.artifactSupport.resolveDirectSourceText(rawInput),
    extractRequestedFileName: (rawInput) => input.artifactSupport.extractRequestedFileName(rawInput),
    inferTextOutputPath: (rawInput, fileBaseName, extension) => input.artifactSupport.inferTextOutputPath(rawInput, fileBaseName, extension),
  };
}

function createDocumentActionRuntime(input: {
  sharedToolRuntime: SharedToolExecutionRuntime;
  exportSupport: DirectActionExportSupport;
  artifactSupport: DirectActionArtifactSupport;
  knownGapSupport: DirectActionKnownGapSupport;
  documentExportVerifier: DirectActionDocumentExportVerifier;
}): DocumentActionRuntime {
  return {
    executeBuiltInTool: input.sharedToolRuntime.executeBuiltInTool,
    executeSkillTool: input.sharedToolRuntime.executeSkillTool,
    detectConvertibleFormat: (sourceInput) => input.exportSupport.detectConvertibleFormat(sourceInput),
    findConvertibleSourceFilePath: (sourceInput, targetFormat) => input.artifactSupport.findConvertibleSourceFilePath(sourceInput, targetFormat),
    resolveDirectSourceText: (sourceInput) => input.artifactSupport.resolveDirectSourceText(sourceInput),
    extractRequestedFileName: (sourceInput) => input.artifactSupport.extractRequestedFileName(sourceInput),
    inferConversionOutputPath: (sourceInput, fileBaseName, format) => input.artifactSupport.inferConversionOutputPath(sourceInput, fileBaseName, format),
    resolveDocumentExportTool: (format) => input.sharedToolRuntime.resolveDocumentExportTool(format),
    hasBuiltInTool: input.sharedToolRuntime.hasBuiltInTool,
    detectFormatFromPath: (value) => input.exportSupport.detectFormatFromPath(value),
    formatLabel: (format) => input.exportSupport.formatLabel(format),
    isUnavailableDocxSkillResult: (format, output) => isUnavailableDocxSkillResult(format, output),
    buildKnownGapResult: (sourceInput, detail, fallbacks) => input.knownGapSupport.buildKnownGapResult(sourceInput, detail, fallbacks),
    verifyDocumentExportResult: (result, outputPath, format, expectedText, expectedTitle) => input.documentExportVerifier.verifyDocumentExportResult(result, outputPath, format, expectedText, expectedTitle),
  };
}