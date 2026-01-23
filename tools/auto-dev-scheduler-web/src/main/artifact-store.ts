/**
 * Artifact Store - File-based artifact storage for task output passing
 *
 * Directory structure:
 *   .autodev/runs/<runId>/tasks/<taskId>/artifacts/
 *   ├── manifest.json     # List of all artifacts for this task
 *   ├── <artifactId>.data # Artifact content
 *   └── <artifactId>.meta # Artifact metadata
 *
 * Design decisions (from Phase 3 design.md):
 * - File system priority + optional memory cache
 * - Artifacts are immutable (append-only)
 * - Size limits to prevent prompt bloat
 * - Use ArtifactRef for indirect reference (avoid path coupling)
 * - Atomic writes (temp + rename)
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ArtifactDraft, ArtifactKind, ArtifactRef } from '../shared/types';

// ============================================================================
// Constants
// ============================================================================

const AUTODEV_DIR = '.autodev';
const RUNS_DIR = 'runs';
const TASKS_DIR = 'tasks';
const ARTIFACTS_DIR = 'artifacts';
const MANIFEST_FILE = 'manifest.json';

const DEFAULT_MEDIA_TYPES: Record<ArtifactKind, string> = {
  diff: 'text/x-diff',
  files: 'application/octet-stream',
  spec: 'text/markdown',
  report: 'text/markdown',
  log: 'text/plain'
};

const MAX_ARTIFACT_SIZE_BYTES = 1024 * 1024; // 1MB default limit

// ============================================================================
// Types
// ============================================================================

interface ArtifactManifest {
  version: 1;
  taskId: string;
  runId: string;
  artifacts: ArtifactRef[];
  updatedAt: string;
}

export interface ArtifactStoreConfig {
  projectRoot: string;
  maxArtifactSizeBytes?: number;
}

// ============================================================================
// ArtifactStore Interface
// ============================================================================

export interface IArtifactStore {
  put(runId: string, taskId: string, draft: ArtifactDraft): Promise<ArtifactRef>;
  getBytes(ref: ArtifactRef): Promise<Uint8Array>;
  getText(ref: ArtifactRef): Promise<string>;
  listByTask(runId: string, taskId: string): Promise<ArtifactRef[]>;
  listByDependencies(runId: string, dependencyTaskIds: string[]): Promise<ArtifactRef[]>;
}

// ============================================================================
// FileArtifactStore Implementation
// ============================================================================

export class FileArtifactStore implements IArtifactStore {
  private readonly projectRoot: string;
  private readonly maxSizeBytes: number;

  constructor(config: ArtifactStoreConfig) {
    this.projectRoot = config.projectRoot;
    this.maxSizeBytes = config.maxArtifactSizeBytes ?? MAX_ARTIFACT_SIZE_BYTES;
  }

  /**
   * Store a new artifact for a task
   */
  async put(runId: string, taskId: string, draft: ArtifactDraft): Promise<ArtifactRef> {
    // Convert content to bytes
    const content = typeof draft.content === 'string'
      ? Buffer.from(draft.content, 'utf8')
      : draft.content;

    // Validate size
    if (content.length > this.maxSizeBytes) {
      throw new Error(
        `Artifact "${draft.name}" exceeds size limit: ${content.length} > ${this.maxSizeBytes} bytes`
      );
    }

    // Generate artifact ID and compute hash
    const id = randomUUID();
    const sha256 = createHash('sha256').update(content).digest('hex');
    const mediaType = draft.mediaType ?? DEFAULT_MEDIA_TYPES[draft.kind];

    // Ensure directory exists
    const artifactsDir = this.getArtifactsDir(runId, taskId);
    await mkdir(artifactsDir, { recursive: true });

    // Atomic write: temp file + rename
    const dataPath = path.join(artifactsDir, `${id}.data`);
    const tempPath = `${dataPath}.tmp`;
    await writeFile(tempPath, content);
    await rename(tempPath, dataPath);

    // Build artifact reference
    const ref: ArtifactRef = {
      id,
      runId,
      taskId,
      name: draft.name,
      kind: draft.kind,
      mediaType,
      sha256,
      sizeBytes: content.length,
      uri: pathToFileURL(dataPath).href,
      createdAt: new Date().toISOString(),
      meta: draft.meta
    };

    // Update manifest
    await this.updateManifest(runId, taskId, ref);

    return ref;
  }

  /**
   * Get artifact content as bytes
   */
  async getBytes(ref: ArtifactRef): Promise<Uint8Array> {
    const dataPath = this.getDataPath(ref.runId, ref.taskId, ref.id);
    const content = await readFile(dataPath);

    // Verify integrity
    const actualHash = createHash('sha256').update(content).digest('hex');
    if (actualHash !== ref.sha256) {
      throw new Error(`Artifact integrity check failed: expected ${ref.sha256}, got ${actualHash}`);
    }

    return content;
  }

  /**
   * Get artifact content as text
   */
  async getText(ref: ArtifactRef): Promise<string> {
    const bytes = await this.getBytes(ref);
    return Buffer.from(bytes).toString('utf8');
  }

  /**
   * List all artifacts for a task
   */
  async listByTask(runId: string, taskId: string): Promise<ArtifactRef[]> {
    const manifest = await this.loadManifest(runId, taskId);
    return manifest?.artifacts ?? [];
  }

  /**
   * List artifacts from multiple dependency tasks
   */
  async listByDependencies(runId: string, dependencyTaskIds: string[]): Promise<ArtifactRef[]> {
    const results: ArtifactRef[] = [];
    for (const taskId of dependencyTaskIds) {
      const artifacts = await this.listByTask(runId, taskId);
      results.push(...artifacts);
    }
    return results;
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private getArtifactsDir(runId: string, taskId: string): string {
    return path.join(
      this.projectRoot,
      AUTODEV_DIR,
      RUNS_DIR,
      runId,
      TASKS_DIR,
      taskId,
      ARTIFACTS_DIR
    );
  }

  private getDataPath(runId: string, taskId: string, artifactId: string): string {
    return path.join(this.getArtifactsDir(runId, taskId), `${artifactId}.data`);
  }

  private getManifestPath(runId: string, taskId: string): string {
    return path.join(this.getArtifactsDir(runId, taskId), MANIFEST_FILE);
  }

  private async loadManifest(runId: string, taskId: string): Promise<ArtifactManifest | null> {
    const manifestPath = this.getManifestPath(runId, taskId);
    try {
      const content = await readFile(manifestPath, 'utf8');
      return JSON.parse(content) as ArtifactManifest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  private async updateManifest(runId: string, taskId: string, newRef: ArtifactRef): Promise<void> {
    const manifestPath = this.getManifestPath(runId, taskId);
    let manifest = await this.loadManifest(runId, taskId);

    if (!manifest) {
      manifest = {
        version: 1,
        taskId,
        runId,
        artifacts: [],
        updatedAt: new Date().toISOString()
      };
    }

    manifest.artifacts.push(newRef);
    manifest.updatedAt = new Date().toISOString();

    // Atomic write
    const tempPath = `${manifestPath}.tmp`;
    await writeFile(tempPath, JSON.stringify(manifest, null, 2));
    await rename(tempPath, manifestPath);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create an artifact store for a project
 */
export function createArtifactStore(projectRoot: string): IArtifactStore {
  return new FileArtifactStore({ projectRoot });
}

/**
 * Format artifact for injection into prompt (with size budget)
 */
export function formatArtifactForPrompt(
  ref: ArtifactRef,
  content: string,
  maxChars = 50000
): string {
  const truncated = content.length > maxChars
    ? `${content.slice(0, maxChars)}\n... [truncated, ${content.length - maxChars} chars omitted]`
    : content;

  return [
    `<artifact id="${ref.id}" name="${ref.name}" kind="${ref.kind}" from="${ref.taskId}">`,
    truncated,
    '</artifact>'
  ].join('\n');
}
