import { readFile, writeFile } from "fs/promises";
import { GitHubClient } from "../api/github-client.js";
import { StateManager } from "../state/state-manager.js";

interface MigrationConfig {
  batchSize: number;
  maxParallelRepos: number;
  maxBatchesPerRun: number;
  excludeRepos: string[];
  includeOnlyRepos: string[];
}

interface Batch {
  batchNumber: number;
  repos: string[];
}

async function loadConfig(configPath: string): Promise<MigrationConfig> {
  const content = await readFile(configPath, "utf-8");
  return JSON.parse(content);
}

async function discoverRepos(
  githubClient: GitHubClient,
  stateManager: StateManager,
  config: MigrationConfig
): Promise<string[]> {
  console.log("Discovering repos from GitHub...");

  const repos = await githubClient.listPublicRepos();
  const repoNames = repos.map((r) => r.name);

  // Apply filters
  let filteredRepos = repoNames;

  if (config.includeOnlyRepos && config.includeOnlyRepos.length > 0) {
    filteredRepos = filteredRepos.filter((name) =>
      config.includeOnlyRepos.includes(name)
    );
    console.log(`Filtered to ${filteredRepos.length} repos (include list)`);
  }

  if (config.excludeRepos && config.excludeRepos.length > 0) {
    filteredRepos = filteredRepos.filter(
      (name) => !config.excludeRepos.includes(name)
    );
    console.log(`Filtered to ${filteredRepos.length} repos (exclude list)`);
  }

  // Add to state
  stateManager.addRepos(filteredRepos);
  await stateManager.save();

  return filteredRepos;
}

function createBatches(repos: string[], batchSize: number): Batch[] {
  const batches: Batch[] = [];

  for (let i = 0; i < repos.length; i += batchSize) {
    batches.push({
      batchNumber: Math.floor(i / batchSize) + 1,
      repos: repos.slice(i, i + batchSize),
    });
  }

  return batches;
}

async function main() {
  const githubToken = process.env.GH_SOURCE_TOKEN;
  const sourceOrg = process.env.GH_SOURCE_ORG;
  const targetOrg = process.env.CODEBERG_TARGET_ORG;
  const configPath = process.env.CONFIG_PATH ?? "./config/migration-config.json";
  const statePath = process.env.STATE_PATH ?? "./state/migration-state.json";
  const outputPath = process.env.OUTPUT_PATH ?? "./state/batches.json";
  const maxBatches = parseInt(process.env.MAX_BATCHES ?? "5", 10);

  if (!githubToken || !sourceOrg || !targetOrg) {
    console.error("Missing required environment variables:");
    console.error("  GH_SOURCE_TOKEN, GH_SOURCE_ORG, CODEBERG_TARGET_ORG");
    process.exit(1);
  }

  const config = await loadConfig(configPath);
  const githubClient = new GitHubClient({ token: githubToken, org: sourceOrg });
  const stateManager = new StateManager(statePath, sourceOrg, targetOrg);

  await stateManager.load();

  // Discover and update state
  await discoverRepos(githubClient, stateManager, config);

  // Get repos to process (failed retryable + pending)
  const reposToProcess = stateManager.getReposToProcess(
    maxBatches * config.batchSize
  );

  console.log(`\nRepos to process this run: ${reposToProcess.length}`);

  // Create batches
  const batches = createBatches(reposToProcess, config.batchSize);
  const batchesToRun = batches.slice(0, maxBatches);

  console.log(`Created ${batches.length} total batches`);
  console.log(`Will run ${batchesToRun.length} batches this execution`);

  // Output batch info
  const output = {
    timestamp: new Date().toISOString(),
    totalRepos: reposToProcess.length,
    totalBatches: batches.length,
    batchesToRun: batchesToRun.length,
    batches: batchesToRun,
    stats: stateManager.getStats(),
  };

  await writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nBatch info written to ${outputPath}`);

  // Output for GitHub Actions
  const batchMatrix = batchesToRun.map((b) => ({
    batch_number: b.batchNumber,
    repos: b.repos.join(","),
  }));

  // Set output for GitHub Actions
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const { appendFile } = await import("fs/promises");
    await appendFile(ghOutput, `batch_count=${batchesToRun.length}\n`);
    await appendFile(ghOutput, `batch_matrix=${JSON.stringify(batchMatrix)}\n`);
    await appendFile(ghOutput, `total_repos=${reposToProcess.length}\n`);
  }

  // Print summary
  const stats = stateManager.getStats();
  console.log("\n--- Migration State Summary ---");
  console.log(`Total repos tracked: ${stats.total}`);
  console.log(`Pending: ${stats.pending}`);
  console.log(`In Progress: ${stats.inProgress}`);
  console.log(`Completed: ${stats.completed}`);
  console.log(`Failed: ${stats.failed}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
