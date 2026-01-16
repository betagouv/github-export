import pRetry from "p-retry";

export interface MigrateOptions {
  issues?: boolean;
  pullRequests?: boolean;
  labels?: boolean;
  milestones?: boolean;
  releases?: boolean;
  wiki?: boolean;
}

export interface MigrateRepoParams {
  repoName: string;
  cloneUrl: string;
  description?: string;
  isPrivate?: boolean;
  githubToken: string;
  options?: MigrateOptions;
}

export interface CodebergRepo {
  id: number;
  name: string;
  fullName: string;
  cloneUrl: string;
  sshUrl: string;
  htmlUrl: string;
}

export interface CodebergClientOptions {
  token: string;
  org: string;
  baseUrl?: string;
}

export class CodebergClient {
  private token: string;
  private org: string;
  private baseUrl: string;

  constructor(options: CodebergClientOptions) {
    this.token = options.token;
    this.org = options.org;
    this.baseUrl = options.baseUrl ?? "https://codeberg.org/api/v1";
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `token ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(
        `Codeberg API error: ${response.status} ${response.statusText} - ${errorText}`
      );
      (error as any).status = response.status;
      (error as any).response = errorText;
      throw error;
    }

    const text = await response.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  async repoExists(repoName: string): Promise<boolean> {
    try {
      await this.request("GET", `/repos/${this.org}/${repoName}`);
      return true;
    } catch (error: any) {
      if (error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  async getRepo(repoName: string): Promise<CodebergRepo | null> {
    try {
      return await this.request<CodebergRepo>(
        "GET",
        `/repos/${this.org}/${repoName}`
      );
    } catch (error: any) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async migrateRepo(params: MigrateRepoParams): Promise<CodebergRepo> {
    const {
      repoName,
      cloneUrl,
      description,
      isPrivate = false,
      githubToken,
      options = {},
    } = params;

    console.log(`Starting migration of ${repoName} via Gitea API...`);

    // Use the Gitea migrate API with service: "github" for full migration
    // This is CRITICAL - using "github" service enables issue/PR migration
    const migratePayload = {
      clone_addr: cloneUrl,
      repo_name: repoName,
      repo_owner: this.org,
      service: "github", // MUST be "github" for issue migration, not "git"
      auth_token: githubToken,
      mirror: false,
      private: isPrivate,
      description: description ?? "",
      issues: options.issues ?? true,
      pull_requests: options.pullRequests ?? true,
      labels: options.labels ?? true,
      milestones: options.milestones ?? true,
      releases: options.releases ?? true,
      wiki: options.wiki ?? true,
    };

    return await pRetry(
      async () => {
        return await this.request<CodebergRepo>(
          "POST",
          "/repos/migrate",
          migratePayload
        );
      },
      {
        retries: 3,
        onFailedAttempt: (error) => {
          console.warn(
            `Migration attempt ${error.attemptNumber} failed for ${repoName}: ${error.message}`
          );
          console.warn(`${error.retriesLeft} retries left`);
        },
      }
    );
  }

  async deleteRepo(repoName: string): Promise<void> {
    console.log(`Deleting repo ${this.org}/${repoName}...`);
    await this.request("DELETE", `/repos/${this.org}/${repoName}`);
  }

  async updateRepo(
    repoName: string,
    updates: { description?: string; private?: boolean }
  ): Promise<CodebergRepo> {
    return await this.request<CodebergRepo>(
      "PATCH",
      `/repos/${this.org}/${repoName}`,
      updates
    );
  }

  getCloneUrlWithAuth(repoName: string): string {
    return `https://${this.token}@codeberg.org/${this.org}/${repoName}.git`;
  }
}
