import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

const ARTIFACT_EXTENSIONS = new Set([
  '.txt', '.md', '.rtf', '.doc', '.docx', '.pdf', '.xlsx', '.xlsm', '.csv', '.tsv', '.ppt', '.pptx',
]);
const ARTIFACT_DIRECTORY_ALIASES = new Set(['artifacts', 'outputs']);

export interface PathResolutionOptions {
  workspace?: string;
  appBaseDir?: string;
  artifactOutputDir?: string;
  documentOutputDir?: string;
  homeDir?: string;
}

function getHomeDir(options?: PathResolutionOptions): string {
  return options?.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir() || process.cwd();
}

function getAppBaseDir(options?: PathResolutionOptions): string {
  return options?.appBaseDir || path.join(getHomeDir(options), '.ai-agent-cli');
}

export function stripWrappingQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

export function getDesktopPath(options?: PathResolutionOptions): string {
  const homeDir = getHomeDir(options);
  const candidates = [
    path.join(homeDir, 'OneDrive', 'Desktop'),
    path.join(homeDir, 'OneDrive', '桌面'),
    path.join(homeDir, 'Desktop'),
    path.join(homeDir, '桌面'),
  ];

  return candidates.find(candidate => existsSync(candidate)) || candidates[1] || candidates[0] || path.join(homeDir, 'Desktop');
}

function isAbsoluteLike(inputPath: string): boolean {
  return path.isAbsolute(inputPath) || /^[a-zA-Z]:[\\/]/.test(inputPath);
}

function isDesktopAlias(inputPath: string): boolean {
  const normalized = inputPath.replace(/\\/g, '/');
  return normalized === 'Desktop'
    || normalized === '桌面'
    || normalized.startsWith('Desktop/')
    || normalized.startsWith('桌面/');
}

function resolveDesktopAlias(inputPath: string, options?: PathResolutionOptions): string {
  const desktopPath = getDesktopPath(options);
  const normalized = inputPath.replace(/\\/g, '/');
  const suffix = normalized === 'Desktop' || normalized === '桌面'
    ? ''
    : normalized.replace(/^(Desktop|桌面)\/?/, '');
  return suffix ? path.join(desktopPath, suffix) : desktopPath;
}

export function resolveUserPath(inputPath: string, options?: PathResolutionOptions): string {
  const normalized = stripWrappingQuotes(inputPath);
  const homeDir = getHomeDir(options);

  if (!normalized) {
    return normalized;
  }

  if (isDesktopAlias(normalized)) {
    return resolveDesktopAlias(normalized, options);
  }

  if (normalized === '~') {
    return homeDir;
  }

  if (normalized.startsWith('~/') || normalized.startsWith('~\\')) {
    return path.join(homeDir, normalized.slice(2));
  }

  if (isAbsoluteLike(normalized)) {
    return path.resolve(normalized);
  }

  return path.resolve(options?.workspace || process.cwd(), normalized);
}

export function getArtifactOutputDir(options?: PathResolutionOptions): string {
  const configured = options?.artifactOutputDir || options?.documentOutputDir;
  if (configured) {
    return resolveUserPath(configured, options);
  }

  return path.join(getAppBaseDir(options), 'outputs');
}

function shouldRouteRelativePathToArtifacts(inputPath: string): boolean {
  if (!inputPath || inputPath.startsWith('../') || inputPath.startsWith('..\\')) {
    return false;
  }

  const extension = path.extname(inputPath).toLowerCase();
  return ARTIFACT_EXTENSIONS.has(extension);
}

function normalizeRelativeOutputPath(inputPath: string): string {
  return inputPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

function isArtifactDirectoryAliasPath(inputPath: string): boolean {
  const normalized = normalizeRelativeOutputPath(inputPath);
  if (!normalized || normalized.startsWith('../')) {
    return false;
  }

  const [firstSegment] = normalized.split('/');
  return typeof firstSegment === 'string' && ARTIFACT_DIRECTORY_ALIASES.has(firstSegment.toLowerCase());
}

function resolveArtifactDirectoryAliasPath(inputPath: string, options?: PathResolutionOptions): string {
  const normalized = normalizeRelativeOutputPath(inputPath);
  const suffix = normalized.replace(/^(artifacts|outputs)\/?/i, '');
  return suffix
    ? path.resolve(getArtifactOutputDir(options), suffix)
    : getArtifactOutputDir(options);
}

export function resolveOutputPath(inputPath: string, options?: PathResolutionOptions): string {
  const normalized = stripWrappingQuotes(inputPath);
  if (!normalized) {
    return normalized;
  }

  if (isDesktopAlias(normalized) || normalized === '~' || normalized.startsWith('~/') || normalized.startsWith('~\\') || isAbsoluteLike(normalized)) {
    return resolveUserPath(normalized, options);
  }

  if (isArtifactDirectoryAliasPath(normalized)) {
    return resolveArtifactDirectoryAliasPath(normalized, options);
  }

  if (shouldRouteRelativePathToArtifacts(normalized)) {
    return path.resolve(getArtifactOutputDir(options), normalized);
  }

  return path.resolve(options?.workspace || process.cwd(), normalized);
}