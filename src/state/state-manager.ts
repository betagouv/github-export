import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { z } from "zod";

export const RepoStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "skipped",
]);

export const ErrorTypeSchema = z.enum([
  "transient", // Network issues, rate limits - auto-retry
  "recoverable", // Repo exists, partial migration - can continue
  "permanent", // Invalid repo, permissions - skip
]);

export const RepoStateSchema = z.object({
  name: z.string(),
  status: RepoStatusSchema,
  lastAttempt: z.string().optional(),
  completedAt: z.string().optional(),
  lastSyncedAt: z.string().optional(),
  githubPushedAt: z.string().optional(),
  error: z.string().optional(),
  errorType: ErrorTypeSchema.optional(),
  attemptCount: z.number().default(0),
  phases: z.object({
    apiMigration: z.boolean().default(false),
    branchSync: z.boolean().default(false),
  }).default({ apiMigration: false, branchSync: false }),
});

export const MigrationStateSchema = z.object({
  version: z.number().default(1),
  sourceOrg: z.string(),
  targetOrg: z.string(),
  lastDiscovery: z.string().optional(),
  totalRepos: z.number().default(0),
  repos: z.record(z.string(), RepoStateSchema),
});

export type RepoStatus = z.infer<typeof RepoStatusSchema>;
export type ErrorType = z.infer<typeof ErrorTypeSchema>;
export type RepoState = z.infer<typeof RepoStateSchema>;
export type MigrationState = z.infer<typeof MigrationStateSchema>;

export class StateManager {
  private statePath: string;
  private state: MigrationState;

  constructor(statePath: string, sourceOrg: string, targetOrg: string) {
    this.statePath = statePath;
    this.state = {
      version: 1,
      sourceOrg,
      targetOrg,
      totalRepos: 0,
      repos: {},
    };
  }

  async load(): Promise<MigrationState> {
    try {
      if (existsSync(this.statePath)) {
        const content = await readFile(this.statePath, "utf-8");
        const parsed = JSON.parse(content);
        this.state = MigrationStateSchema.parse(parsed);
        console.log(`Loaded state with ${Object.keys(this.state.repos).length} repos`);
      } else {
        console.log("No existing state file, starting fresh");
      }
    } catch (error) {
      console.warn("Failed to load state file, starting fresh:", error);
    }
    return this.state;
  }

  async save(): Promise<void> {
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2));
  }

  getState(): MigrationState {
    return this.state;
  }

  getRepoState(repoName: string): RepoState | undefined {
    return this.state.repos[repoName];
  }

  setRepoState(repoName: string, state: Partial<RepoState>): void {
    const existing = this.state.repos[repoName] ?? {
      name: repoName,
      status: "pending" as const,
      attemptCount: 0,
      phases: { apiMigration: false, branchSync: false },
    };
    this.state.repos[repoName] = { ...existing, ...state };
  }

  markInProgress(repoName: string): void {
    this.setRepoState(repoName, {
      status: "in_progress",
      lastAttempt: new Date().toISOString(),
      attemptCount: (this.getRepoState(repoName)?.attemptCount ?? 0) + 1,
    });
  }

  markCompleted(repoName: string): void {
    const now = new Date().toISOString();
    this.setRepoState(repoName, {
      status: "completed",
      completedAt: now,
      lastSyncedAt: now,
      error: undefined,
      errorType: undefined,
      phases: { apiMigration: true, branchSync: true },
    });
  }

  updateLastSynced(repoName: string, githubPushedAt?: string): void {
    const now = new Date().toISOString();
    this.setRepoState(repoName, {
      lastSyncedAt: now,
      ...(githubPushedAt && { githubPushedAt }),
    });
  }

  updateGithubPushedAt(repoName: string, pushedAt: string): void {
    this.setRepoState(repoName, {
      githubPushedAt: pushedAt,
    });
  }

  markFailed(repoName: string, error: string, errorType: ErrorType): void {
    this.setRepoState(repoName, {
      status: "failed",
      error,
      errorType,
    });
  }

  markSkipped(repoName: string, reason: string): void {
    this.setRepoState(repoName, {
      status: "skipped",
      error: reason,
      errorType: undefined,
    });
  }

  markPhaseComplete(repoName: string, phase: "apiMigration" | "branchSync"): void {
    const current = this.getRepoState(repoName);
    if (current) {
      this.setRepoState(repoName, {
        phases: { ...current.phases, [phase]: true },
      });
    }
  }

  addRepos(repoNames: string[]): void {
    for (const name of repoNames) {
      if (!this.state.repos[name]) {
        this.state.repos[name] = {
          name,
          status: "pending",
          attemptCount: 0,
          phases: { apiMigration: false, branchSync: false },
        };
      }
    }
    this.state.totalRepos = Object.keys(this.state.repos).length;
    this.state.lastDiscovery = new Date().toISOString();
  }

  addReposWithPushedAt(repos: Array<{ name: string; pushedAt?: string }>): void {
    for (const { name, pushedAt } of repos) {
      const existing = this.state.repos[name];
      if (!existing) {
        this.state.repos[name] = {
          name,
          status: "pending",
          attemptCount: 0,
          phases: { apiMigration: false, branchSync: false },
          githubPushedAt: pushedAt,
        };
      } else {
        // Update githubPushedAt for existing repos to detect changes
        if (pushedAt) {
          this.state.repos[name].githubPushedAt = pushedAt;
        }
      }
    }
    this.state.totalRepos = Object.keys(this.state.repos).length;
    this.state.lastDiscovery = new Date().toISOString();
  }

  getPendingRepos(): string[] {
    return Object.values(this.state.repos)
      .filter((r) => r.status === "pending")
      .map((r) => r.name);
  }

  getFailedRepos(): string[] {
    return Object.values(this.state.repos)
      .filter((r) => r.status === "failed")
      .map((r) => r.name);
  }

  getRetryableRepos(): string[] {
    return Object.values(this.state.repos)
      .filter(
        (r) =>
          r.status === "failed" &&
          (r.errorType === "transient" || r.errorType === "recoverable")
      )
      .map((r) => r.name);
  }

  getReposNeedingSync(excludeInactiveDays = 0): string[] {
    const cutoffDate = excludeInactiveDays > 0
      ? new Date(Date.now() - excludeInactiveDays * 24 * 60 * 60 * 1000)
      : null;

    return Object.values(this.state.repos)
      .filter((r) => {
        if (r.status !== "completed") return false;

        // Exclude inactive repos if cutoff is set
        if (cutoffDate && r.githubPushedAt) {
          const pushedAt = new Date(r.githubPushedAt);
          if (pushedAt < cutoffDate) return false;
        }

        // If no lastSyncedAt, it's a legacy completed repo that needs tracking
        // But only if it's active (checked above)
        if (!r.lastSyncedAt) {
          // For legacy repos, only include if we have githubPushedAt (meaning it was seen in discovery)
          return !!r.githubPushedAt;
        }

        // If GitHub has newer commits than our last sync
        if (r.githubPushedAt) {
          const pushedAt = new Date(r.githubPushedAt);
          const syncedAt = new Date(r.lastSyncedAt);
          return pushedAt > syncedAt;
        }
        return false;
      })
      .map((r) => r.name);
  }

  getReposToProcess(maxCount: number, includeNeedingSync = false, excludeInactiveDays = 0): string[] {
    // Priority: retryable failed repos first, then pending, then needing sync
    const retryable = this.getRetryableRepos();
    const pending = this.getPendingRepos();
    const needingSync = includeNeedingSync ? this.getReposNeedingSync(excludeInactiveDays) : [];

    const combined = [...retryable, ...pending, ...needingSync];
    return combined.slice(0, maxCount);
  }

  getStats(excludeInactiveDays = 0): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    skipped: number;
    needingSync: number;
  } {
    const repos = Object.values(this.state.repos);
    return {
      total: repos.length,
      pending: repos.filter((r) => r.status === "pending").length,
      inProgress: repos.filter((r) => r.status === "in_progress").length,
      completed: repos.filter((r) => r.status === "completed").length,
      failed: repos.filter((r) => r.status === "failed").length,
      skipped: repos.filter((r) => r.status === "skipped").length,
      needingSync: this.getReposNeedingSync(excludeInactiveDays).length,
    };
  }
}
