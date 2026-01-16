import { readFile, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { StateManager, MigrationStateSchema } from "../state/state-manager.js";

async function main() {
  const sourceOrg = process.env.GITHUB_SOURCE_ORG;
  const targetOrg = process.env.CODEBERG_TARGET_ORG;
  const statePath = process.env.STATE_PATH ?? "./state/migration-state.json";
  const batchStatesDir = process.env.BATCH_STATES_DIR ?? "./state/batch-states";

  if (!sourceOrg || !targetOrg) {
    console.error("Missing required environment variables:");
    console.error("  GITHUB_SOURCE_ORG, CODEBERG_TARGET_ORG");
    process.exit(1);
  }

  console.log("Merging batch states into main state...");

  // Load main state
  const stateManager = new StateManager(statePath, sourceOrg, targetOrg);
  await stateManager.load();

  // Find all batch state files
  if (!existsSync(batchStatesDir)) {
    console.log("No batch states directory found, nothing to merge");
    return;
  }

  const files = await readdir(batchStatesDir);
  const stateFiles = files.filter(
    (f) => f.endsWith(".json") && f.startsWith("batch-")
  );

  console.log(`Found ${stateFiles.length} batch state files`);

  // Merge each batch state
  for (const file of stateFiles) {
    const filePath = join(batchStatesDir, file);
    console.log(`Merging ${file}...`);

    try {
      const content = await readFile(filePath, "utf-8");
      const batchState = MigrationStateSchema.parse(JSON.parse(content));

      // Merge repo states
      for (const [repoName, repoState] of Object.entries(batchState.repos)) {
        const existingState = stateManager.getRepoState(repoName);

        // Only update if batch state is newer or more complete
        if (
          !existingState ||
          repoState.status === "completed" ||
          (repoState.lastAttempt &&
            (!existingState.lastAttempt ||
              new Date(repoState.lastAttempt) >
                new Date(existingState.lastAttempt)))
        ) {
          stateManager.setRepoState(repoName, repoState);
        }
      }
    } catch (error) {
      console.error(`Failed to merge ${file}:`, error);
    }
  }

  // Save merged state
  await stateManager.save();

  // Print summary
  const stats = stateManager.getStats();
  console.log("\n--- Merged State Summary ---");
  console.log(`Total repos: ${stats.total}`);
  console.log(`Pending: ${stats.pending}`);
  console.log(`In Progress: ${stats.inProgress}`);
  console.log(`Completed: ${stats.completed}`);
  console.log(`Failed: ${stats.failed}`);

  // Set output for GitHub Actions
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const { appendFile } = await import("fs/promises");
    await appendFile(ghOutput, `total=${stats.total}\n`);
    await appendFile(ghOutput, `completed=${stats.completed}\n`);
    await appendFile(ghOutput, `failed=${stats.failed}\n`);
    await appendFile(ghOutput, `pending=${stats.pending}\n`);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
