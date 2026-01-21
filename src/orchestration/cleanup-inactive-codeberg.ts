interface CodebergRepo {
  id: number;
  name: string;
  full_name: string;
  updated_at: string;
  pushed_at: string;
}

interface CommitInfo {
  sha: string;
  created: string;
}

class CodebergCleanupClient {
  private token: string;
  private org: string;
  private baseUrl: string;

  constructor(token: string, org: string) {
    this.token = token;
    this.org = org;
    this.baseUrl = "https://codeberg.org/api/v1";
  }

  private async request<T>(method: string, path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `token ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(
        `Codeberg API error: ${response.status} ${response.statusText} - ${errorText}`
      );
      (error as any).status = response.status;
      throw error;
    }

    const text = await response.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  async listOrgRepos(): Promise<CodebergRepo[]> {
    const allRepos: CodebergRepo[] = [];
    let page = 1;
    const limit = 50;

    while (true) {
      const repos = await this.request<CodebergRepo[]>(
        "GET",
        `/orgs/${this.org}/repos?page=${page}&limit=${limit}`
      );

      if (repos.length === 0) break;
      allRepos.push(...repos);
      page++;
      if (repos.length < limit) break;
    }

    return allRepos;
  }

  async getLastCommitDate(repoName: string): Promise<Date | null> {
    try {
      const commits = await this.request<CommitInfo[]>(
        "GET",
        `/repos/${this.org}/${repoName}/commits?limit=1`
      );

      if (commits.length === 0) return null;
      return new Date(commits[0].created);
    } catch (error: any) {
      // 409 = empty repo, 404 = not found
      if (error.status === 409 || error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async deleteRepo(repoName: string): Promise<void> {
    await this.request<void>("DELETE", `/repos/${this.org}/${repoName}`);
  }
}

async function main() {
  const token = process.env.CODEBERG_TOKEN;
  const org = process.env.CODEBERG_TARGET_ORG;
  const inactiveDays = parseInt(process.env.INACTIVE_DAYS ?? "365", 10);
  const dryRun = process.env.DRY_RUN === "true";

  if (!token || !org) {
    console.error("Missing required environment variables:");
    console.error("  CODEBERG_TOKEN, CODEBERG_TARGET_ORG");
    process.exit(1);
  }

  console.log(`Cleanup inactive Codeberg repos for org: ${org}`);
  console.log(`Inactive threshold: ${inactiveDays} days`);
  console.log(`Dry run: ${dryRun}`);
  console.log("");

  const client = new CodebergCleanupClient(token, org);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - inactiveDays);

  console.log(`Cutoff date: ${cutoffDate.toISOString()}`);
  console.log("");

  // List all repos
  console.log("Fetching all repos from Codeberg...");
  const repos = await client.listOrgRepos();
  console.log(`Found ${repos.length} repos`);
  console.log("");

  const toDelete: string[] = [];
  const active: string[] = [];
  const noCommits: string[] = [];

  // Check each repo
  for (const repo of repos) {
    process.stdout.write(`Checking ${repo.name}... `);

    const lastCommitDate = await client.getLastCommitDate(repo.name);

    if (!lastCommitDate) {
      console.log("no commits (will delete)");
      noCommits.push(repo.name);
      toDelete.push(repo.name);
    } else if (lastCommitDate < cutoffDate) {
      const daysAgo = Math.floor(
        (Date.now() - lastCommitDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      console.log(`inactive (last commit ${daysAgo} days ago, will delete)`);
      toDelete.push(repo.name);
    } else {
      console.log("active");
      active.push(repo.name);
    }
  }

  console.log("");
  console.log("=== Summary ===");
  console.log(`Active repos: ${active.length}`);
  console.log(`Repos to delete: ${toDelete.length}`);
  console.log(`  - No commits: ${noCommits.length}`);
  console.log(`  - Inactive: ${toDelete.length - noCommits.length}`);
  console.log("");

  if (toDelete.length === 0) {
    console.log("No repos to delete.");
    return;
  }

  console.log("Repos to delete:");
  for (const name of toDelete) {
    console.log(`  - ${name}`);
  }
  console.log("");

  if (dryRun) {
    console.log("DRY RUN - no repos were deleted");
    return;
  }

  // Delete repos
  console.log("Deleting repos...");
  let deleted = 0;
  let failed = 0;

  for (const name of toDelete) {
    try {
      process.stdout.write(`Deleting ${name}... `);
      await client.deleteRepo(name);
      console.log("done");
      deleted++;
    } catch (error: any) {
      console.log(`FAILED: ${error.message}`);
      failed++;
    }
  }

  console.log("");
  console.log("=== Deletion Complete ===");
  console.log(`Deleted: ${deleted}`);
  console.log(`Failed: ${failed}`);

  // Set GitHub Actions output
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const { appendFile } = await import("fs/promises");
    await appendFile(ghOutput, `deleted_count=${deleted}\n`);
    await appendFile(ghOutput, `failed_count=${failed}\n`);
    await appendFile(ghOutput, `deleted_repos=${toDelete.join(",")}\n`);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
